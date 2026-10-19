// The Restore dialog (spec step 9 "Restore", frames 9.1): checks, then the 5a confirmation with the
// exact structure SQL and the INSERT shape (on every Connection, so the SQL is always reviewed), then
// the running view and its end line.
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { errorText, fileName, isCommandError } from "../api/client";
import { confirmRestore, inspectRestore, newJobId, planRestore, restoreStatements, startRestore } from "../api/jobs";
import type {
  CommandError,
  ConnectionConfig,
  Group,
  JobEvent,
  JobId,
  RestoreCheck,
  RestoreMode,
  RestoreOutcome,
  RestorePlan,
  RestoreRequest,
  RestoreStep,
  RestoreTarget,
  ScriptStatement,
  StatementClass,
} from "../api/types";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import GroupBadge, { groupStyle } from "../components/GroupBadge";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import SafetyTag from "../components/SafetyTag";
import SqlBlock, { type SqlMark } from "../components/SqlBlock";
import WarningBanner from "../components/WarningBanner";
import { elapsedLine, timeLeft } from "../jobs/exportText";
import { useJobs } from "../jobs/useJobs";
import ConfirmRun, { foldText } from "../query/ConfirmRun";
import {
  DIALECT_NAME,
  MYSQL_REPLACE_LINE,
  checkLines,
  contentsText,
  fingerprintBanner,
  ofSizeText,
  readOnlyReason,
  replaceBanner,
  restorable,
  restoreCountLine,
  restoreStoppedText,
  runStatements,
  localDate,
  restoreName,
  restoredText,
  shaText,
  sizeText,
  takenText,
} from "./backupText";
import { joinPath, splitPath } from "./BackupDialog";

interface Props {
  connection: ConnectionConfig;
  group: Group | null;
  target: RestoreTarget;
  onClose(): void;
  /** The restore ended: refresh the tree and drop the completion schema cache. */
  onRestored?(database: string): void;
  /** Open in the tree, on the database restored into. */
  onOpenInTree?(database: string): void;
  /** SQLite "Add it as a Connection": a new Connection on the restored file. */
  onAddConnection?(file: string): Promise<void> | void;
  /** A Restore started: the App keeps `run` so a background Restore ends right and can be opened again. */
  onStarted?(id: JobId, run: RestoreRun): void;
  /** Opens on a running Restore again (from the status bar) instead of the checks. */
  attach?: { id: JobId; run: RestoreRun };
}

/** What the running view and the end need of a Restore, kept with its job. */
export interface RestoreRun {
  /** The file's database, for the end line ("Restored freight into ..."). */
  source: string;
  plan: RestorePlan;
  check: RestoreCheck;
  mode: RestoreMode["kind"];
  /** The database restored into (SQLite new database: the file path). */
  into: string;
  /** SQLite "Add it as a Connection" was ticked. */
  addConnection: boolean;
  path: string;
  /** Run as is was ticked, for the "n of m statements ran" count. */
  runAsIs?: boolean;
}

/** The structure lines shown before Show all. */
const FIRST_LINES = 12;

const n = (v: number) => v.toLocaleString("en-US");

type ModeKind = RestoreMode["kind"];
type Progress = Extract<JobEvent, { kind: "progress" }>;
type View = "checks" | "confirm" | "running";
type End = { outcome: RestoreOutcome; elapsedMs: number } | { error: string } | null;

type Step = { step: RestoreStep; label: (plan: RestorePlan, inserts: number) => string };

/** The phase list per Dialect: only PostgreSQL has schemas, enums and sequences to set. */
function stepsFor(dialect: ConnectionConfig["dialect"], mode: ModeKind): Step[] {
  const pg = dialect === "postgres";
  const steps: Step[] = [];
  if (mode === "newDatabase") steps.push({ step: "database", label: () => "Database created" });
  steps.push(
    { step: "structure", label: () => (pg ? "Schema, enum and tables" : "Tables") },
    { step: "rows", label: (plan, inserts) => `Rows (${n(inserts)} of ${n(plan.insertCount)} INSERT statements)` },
    { step: "afterRows", label: () => "Indexes and Foreign Keys" },
  );
  if (pg) steps.push({ step: "sequences", label: () => "Sequences set to the highest id" });
  steps.push({ step: "counts", label: () => "Row counts compared with the file header" });
  return steps;
}

/** A Restore's own words for the step 7 errors it shares with Import. */
export function restoreErrorText(e: unknown, connection: ConnectionConfig): string {
  if (isCommandError(e)) {
    const err = e as CommandError;
    if (err.kind === "fileChanged") {
      const file = fileName(err.message.file);
      return err.message.confirmed === false
        ? `${file} changed while Contura read it. Nothing was restored.`
        : `${file} changed after you confirmed. Nothing was restored.`;
    }
    if (err.kind === "jobBusy") return `Another job is writing to ${err.message.connection}. Wait for it to end.`;
    if (err.kind === "readOnly") return readOnlyReason(connection.name);
  }
  return errorText(e, connection.dialect);
}

/** SQLite: a new file beside the Connection's, `<name>_restore_<mmdd><ext>`. */
function sqliteNewFile(connection: ConnectionConfig, base: string): string {
  const file = connection.file ?? "";
  const { folder, name } = splitPath(file);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : ".db";
  const stem = dot > 0 ? name.slice(0, dot) : name || base;
  return joinPath(folder, `${restoreName(stem, new Date())}${ext}`);
}

export default function RestoreDialog({ connection, group, target, onClose, onRestored, onOpenInTree, onAddConnection, onStarted, attach }: Props) {
  const jobs = useJobs();
  const sqlite = connection.dialect === "sqlite";
  const readOnly = connection.readOnly;
  const database = target.database;

  const [path, setPath] = useState<string | null>(attach?.run.path ?? null);
  const [checking, setChecking] = useState<Progress | null>(null);
  const [checkJob, setCheckJob] = useState<JobId | null>(null);
  const [check, setCheck] = useState<RestoreCheck | null>(attach?.run.check ?? null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [runAsIs, setRunAsIs] = useState(false);
  const [mode, setMode] = useState<ModeKind>(attach?.run.mode ?? "newDatabase");
  const [newName, setNewName] = useState(attach && attach.run.mode === "newDatabase" ? attach.run.into : "");
  const [backupFirst, setBackupFirst] = useState(true);
  const [addConnection, setAddConnection] = useState(attach?.run.addConnection ?? true);
  const [view, setView] = useState<View>(attach ? "running" : "checks");
  const [plan, setPlan] = useState<RestorePlan | null>(attach?.run.plan ?? null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [jobId, setJobId] = useState<JobId | null>(attach?.id ?? null);
  const [end, setEnd] = useState<End>(null);
  const [now, setNow] = useState(() => Date.now());
  const named = useRef(false);

  // Replace drops the target's tables with the file's names; the header's list is the fallback.
  const tables = check ? check.existingTables.length || (check.header?.rows.length ?? 0) : 0;
  const modeTarget = mode === "newDatabase" ? newName : (database ?? "");

  function modeValue(kind: ModeKind = mode): RestoreMode {
    if (kind === "newDatabase") return { kind, name: newName };
    if (kind === "intoEmpty") return { kind };
    return { kind, backupFirst: connection.dialect === "mysql" ? backupFirst : false };
  }

  const req = (kind: ModeKind = mode): RestoreRequest | null =>
    path === null ? null : { target, path, mode: modeValue(kind), runAsIs, localDate: localDate(new Date()) };

  // ---- the check pass ----

  const checkView = checkJob ? jobs.jobs.find((j) => j.id === checkJob) : undefined;
  useEffect(() => {
    const done = checkView?.done;
    if (!done || !checkJob) return;
    jobs.dismiss(checkJob);
    setCheckJob(null);
    setChecking(null);
    if ("report" in done) {
      const found = done.report.restoreCheck ?? null;
      setCheck(found);
      if (found) arrived(found);
    } else {
      setCheckError(restoreErrorText(done.error, connection));
    }
    // Reacts to the check's end only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkView?.done]);

  /** The defaults that depend on the file and the target. */
  function arrived(found: RestoreCheck) {
    if (!named.current) {
      const base = found.header?.database ?? database ?? "restore";
      setNewName(sqlite ? sqliteNewFile(connection, base) : restoreName(base, new Date()));
    }
    // Production always starts on Into a new database (design decision 6).
    if (!connection.production && database !== null && found.targetEmpty) setMode("intoEmpty");
  }

  async function browse() {
    if (readOnly || checkJob) return;
    const chosen = await open({ multiple: false, directory: false, filters: [{ name: "SQL file", extensions: ["sql"] }] });
    if (typeof chosen !== "string") return;
    setPath(chosen);
    setCheck(null);
    setCheckError(null);
    setPlan(null);
    setPlanError(null);
    const id = newJobId();
    const track = jobs.track(id, "restoreCheck", `Checking ${fileName(chosen)}`, connection.id);
    setCheckJob(id);
    try {
      await inspectRestore(id, target, chosen, (e) => {
        if (e.kind === "progress") setChecking(e);
        track(e);
      });
    } catch (e) {
      jobs.dismiss(id);
      setCheckJob(null);
      setCheckError(restoreErrorText(e, connection));
    }
  }

  // ---- plan and confirm ----

  async function review(kind: ModeKind = mode) {
    const r = req(kind);
    if (!r || !check || !restorable(check) || planning) return;
    setPlanning(true);
    setPlanError(null);
    try {
      const p = await planRestore(r);
      if (p.verdict.kind === "readOnly") setPlanError(readOnlyReason(connection.name));
      else if (p.verdict.kind === "blocked") setPlanError(p.verdict.reasons.join(" "));
      else {
        setPlan(p);
        setView("confirm");
      }
    } catch (e) {
      setPlanError(restoreErrorText(e, connection));
    } finally {
      setPlanning(false);
    }
  }

  async function run() {
    const r = req();
    if (!r || !plan || jobId) return;
    const id = newJobId();
    const label = `Restoring ${modeTarget} on ${connection.name}`;
    const source = check?.header?.database ?? (path ? fileName(path) : "");
    try {
      const pass = plan.verdict.kind === "needsConfirmation" ? await confirmRestore(r) : null;
      const track = jobs.track(id, "restore", label, connection.id, source);
      if (check && path) onStarted?.(id, { source, plan, check, mode, into: modeTarget, addConnection: sqlite && addConnection, path, runAsIs });
      setJobId(id);
      setView("running");
      await startRestore(id, r, plan.fingerprint, pass, track);
    } catch (e) {
      jobs.dismiss(id);
      setJobId(null);
      setEnd({ error: restoreErrorText(e, connection) });
      setView("running");
    }
  }

  const job = jobId ? jobs.jobs.find((j) => j.id === jobId) : undefined;
  useEffect(() => {
    const done = job?.done;
    if (!done || !jobId) return;
    // A Restore once sent to the background (and opened again from the status bar) has its end
    // work, toast and dismissal done by the App; this view only shows the end.
    const mine = !job.background;
    if (mine) jobs.dismiss(jobId);
    setJobId(null);
    if ("report" in done) {
      const outcome = done.report.restore ?? {
        database: modeTarget,
        tables,
        rows: done.report.rowsWritten,
        countsMatch: false,
        newFile: null,
      };
      setEnd({ outcome, elapsedMs: done.report.elapsedMs });
      if (mine) {
        onRestored?.(outcome.database);
        if (sqlite && mode === "newDatabase" && addConnection && outcome.newFile) void onAddConnection?.(outcome.newFile);
      }
    } else if (done.error.kind === "cancelled") {
      setEnd({ error: restoreStoppedText(connection.dialect, mode === "newDatabase" ? (sqlite ? fileName(modeTarget) : modeTarget) : null, job.statementsDone, check ? runStatements(check, runAsIs) : null) });
    } else {
      setEnd({ error: restoreErrorText(done.error, connection) });
    }
    // Reacts to the job's end only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.done]);

  const progress = job?.last ?? null;
  const startedAt = job?.startedAt ?? now;
  useEffect(() => {
    if (view !== "running" || end) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [view, end]);

  function cancelRun() {
    if (jobId) void jobs.cancel(jobId).catch((e) => setEnd({ error: restoreErrorText(e, connection) }));
  }

  function toBackground() {
    if (jobId) jobs.background(jobId);
    onClose();
  }

  const badge = (
    <span className="confirm-badges">
      <SafetyTag connection={connection} />
      {group && (
        <span className="confirm-group">
          <GroupBadge id={group.id} name={group.name} color={group.color} />
          {group.name}
        </span>
      )}
    </span>
  );

  // ---- the confirm view: the 5a dialog with the Restore body ----

  if (view === "confirm" && plan && check) {
    const replace = mode === "replace";
    return (
      <ConfirmRun
        verb="Restore"
        production={connection.production}
        verdict={{ connection: connection.name, database: sqlite && mode === "newDatabase" ? fileName(modeTarget) : modeTarget }}
        dialect={connection.dialect}
        group={group}
        danger={replace}
        banner={
          replace ? (
            <WarningBanner
              className="restore-danger"
              action={
                database !== null && (
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => {
                      setMode("newDatabase");
                      setPlan(null);
                      setView("checks");
                    }}
                  >
                    Restore into a new database instead
                  </button>
                )
              }
            >
              {replaceBanner(tables, database ?? "", plan.replacedRows)}
            </WarningBanner>
          ) : undefined
        }
        warnings={replace && connection.dialect === "mysql" ? [MYSQL_REPLACE_LINE] : []}
        job={{
          title: restoreCountLine(mode === "newDatabase" ? modeTarget : null, plan.creates, plan.insertCount, plan.insertRows),
          shapes: [],
          fingerprintText: fingerprintBanner(check.bytes, check.sha256),
          body: <ConfirmBody plan={plan} req={req()} connection={connection} tables={tables} onError={setPlanError} />,
        }}
        onRun={() => void run()}
        onCancel={() => setView("checks")}
      />
    );
  }

  // ---- the running view and its end ----

  if (view === "running") {
    return (
      <Dialog
        title={
          <span className="restore-title">
            Restoring on <b>{connection.name}</b>
          </span>
        }
        subtitle={`Into ${sqlite && mode === "newDatabase" ? fileName(modeTarget) : modeTarget}`}
        lead={<DbMark dialect={connection.dialect} open />}
        badge={badge}
        size="form"
        className={connection.production ? "restore-dialog prod-wash" : "restore-dialog"}
        onClose={() => (end ? onClose() : cancelRun())}
      >
        {end ? (
          <>
            <div className="dialog-body restore-end">
              {"outcome" in end ? (
                <p className="restore-end-line">
                  <Icon name="check" size={14} />
                  <span>
                    {restoredText(
                      check?.header?.database ?? (path ? fileName(path) : ""),
                      sqlite ? fileName(end.outcome.database) : end.outcome.database,
                      end.outcome.tables,
                      end.outcome.rows,
                      end.elapsedMs,
                      end.outcome.countsMatch,
                    )}
                  </span>
                </p>
              ) : (
                <p className="restore-error" role="alert">
                  {end.error}
                </p>
              )}
            </div>
            <footer className="dialog-footer">
              <span className="spacer" />
              {"outcome" in end && onOpenInTree && (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    onOpenInTree(end.outcome.database);
                    onClose();
                  }}
                >
                  Open in the tree
                </button>
              )}
              <button type="button" className="button button-primary" data-autofocus onClick={onClose}>
                Close
              </button>
            </footer>
          </>
        ) : (
          plan && (
            <RunningBody
              plan={plan}
              mode={mode}
              dialect={connection.dialect}
              progress={progress}
              statements={check ? runStatements(check, runAsIs) : null}
              bytesTotal={check?.bytes ?? null}
              elapsed={Math.max(0, now - startedAt)}
              connection={connection.name}
              onBackground={toBackground}
              onCancel={cancelRun}
            />
          )
        )}
      </Dialog>
    );
  }

  // ---- the checks view ----

  const header = check?.header ?? null;
  const lines = check ? checkLines(check, runAsIs) : [];
  const canRestore = !readOnly && check !== null && restorable(check) && !planning && (mode !== "newDatabase" || newName.trim() !== "") && !(mode === "intoEmpty" && !check.targetEmpty) && !(mode === "replace" && !!check.replaceNote);
  const checkPercent =
    checking && checking.bytesTotal ? Math.min(100, Math.floor((checking.bytesDone / Math.max(1, checking.bytesTotal)) * 100)) : null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (canRestore) void review();
    }
  }

  return (
    <Dialog
      title={
        <span className="restore-title">
          Restore into <b>{connection.name}</b>
        </span>
      }
      lead={<DbMark dialect={connection.dialect} open />}
      badge={badge}
      size="model"
      className={connection.production ? "restore-dialog prod-wash" : "restore-dialog"}
      onClose={() => {
        if (checkJob) void jobs.cancel(checkJob).catch(() => {});
        onClose();
      }}
    >
      <div className="restore-keys" style={groupStyle(group?.color)} onKeyDown={onKeyDown}>
        <div className="dialog-body restore-body">
          {readOnly && (
            <div className="restore-banner" role="alert">
              <Icon name="lock" size={14} />
              <span>{readOnlyReason(connection.name)}</span>
            </div>
          )}
          <section className="restore-section" aria-label="Backup file">
            <h3 className="restore-head">Backup file</h3>
            <div className="restore-file">
              <input className="input mono" aria-label="Backup file" value={path ?? ""} readOnly placeholder="Choose a .sql file" />
              <button type="button" className="button" disabled={readOnly || checkJob !== null} onClick={() => void browse()}>
                <Icon name="folder" size={14} />
                Browse...
              </button>
            </div>
            {checking && (
              <div className="restore-checking">
                <span className="restore-hint">
                  {checking.bytesTotal ? `Reading ${ofSizeText(checking.bytesDone, checking.bytesTotal)}` : "Reading the file"}
                </span>
                {checkPercent !== null && (
                  <div className="backup-bar" role="progressbar" aria-label="Check progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={checkPercent}>
                    <b style={{ width: `${checkPercent}%` }} />
                  </div>
                )}
              </div>
            )}
            {checkError && (
              <p className="restore-error" role="alert">
                {checkError}
              </p>
            )}
          </section>

          {check && (
            <>
              <div className="restore-grid">
                {header ? (
                  <section className="restore-section">
                    <h3 className="restore-head">From the file header</h3>
                    <dl className="restore-kv" role="list" aria-label="From the file header">
                      <KV k="Made by" v={header.madeBy} />
                      <KV k="Dialect" v={`${DIALECT_NAME[header.dialect]} ${header.serverVersion}`} />
                      <KV k="Database" v={header.schema ? `${header.database} · ${header.schema}` : header.database} />
                      <KV k="Taken" v={takenText(header.takenAt)} />
                      <KV k="Contents" v={contentsText(header.rows)} />
                      <KV k="Size" v={sizeText(check.bytes)} />
                      <KV k="SHA-256" v={shaText(check.sha256)} mono />
                    </dl>
                  </section>
                ) : (
                  <section className="restore-section">
                    <h3 className="restore-head">From the file header</h3>
                    <p className="restore-hint">This file has no Contura header. It is read as plain SQL.</p>
                  </section>
                )}
                <section className="restore-section">
                  <h3 className="restore-head">Checks</h3>
                  <ul className="restore-checks" aria-label="Checks">
                    {lines.map((l) => (
                      <li key={l.text} className={l.ok ? "restore-check" : "restore-check restore-check-warn"}>
                        <Icon name={l.ok ? "check" : "warning"} size={14} />
                        <span>{l.text}</span>
                      </li>
                    ))}
                  </ul>
                  <label className="restore-tick">
                    <input type="checkbox" checked={runAsIs} onChange={(e) => setRunAsIs(e.target.checked)} />
                    <span className="restore-tick-text">
                      <span>Run as is</span>
                      <span className="restore-hint">Keeps statements Contura would skip.</span>
                    </span>
                  </label>
                </section>
              </div>

              <section className="restore-section" aria-label="Restore">
                <h3 className="restore-head">Restore</h3>
                <div className="restore-modes" role="radiogroup" aria-label="Restore mode">
                  <div className="restore-mode">
                    <label className="restore-choice">
                      <input type="radio" className="radio" name="restore-mode" checked={mode === "newDatabase"} onChange={() => setMode("newDatabase")} />
                      <span>Into a new database</span>
                    </label>
                    <input
                      className="input mono restore-name"
                      aria-label={sqlite ? "New database file" : "New database name"}
                      value={newName}
                      spellCheck={false}
                      disabled={mode !== "newDatabase"}
                      onChange={(e) => {
                        named.current = true;
                        setNewName(e.target.value);
                      }}
                    />
                    {sqlite && mode === "newDatabase" && (
                      <label className="restore-tick restore-sub">
                        <input type="checkbox" checked={addConnection} onChange={(e) => setAddConnection(e.target.checked)} />
                        <span>Add it as a Connection</span>
                      </label>
                    )}
                  </div>
                  {database !== null && (
                    <>
                      <div className="restore-mode">
                        <label className={check.targetEmpty ? "restore-choice" : "restore-choice restore-choice-off"}>
                          <input
                            type="radio"
                            className="radio"
                            name="restore-mode"
                            checked={mode === "intoEmpty"}
                            disabled={!check.targetEmpty}
                            onChange={() => setMode("intoEmpty")}
                          />
                          <span>{`Into ${database}`}</span>
                        </label>
                        {!check.targetEmpty && <span className="restore-hint">{`${database} is not empty`}</span>}
                      </div>
                      <div className="restore-mode">
                        <label className={check.replaceNote ? "restore-choice restore-choice-off" : "restore-choice"}>
                          <input
                            type="radio"
                            className="radio"
                            name="restore-mode"
                            checked={mode === "replace"}
                            disabled={!!check.replaceNote}
                            onChange={() => setMode("replace")}
                          />
                          <span>{`Replace the ${n(tables)} tables in ${database}`}</span>
                        </label>
                        <span className="restore-hint">{check.replaceNote ?? "Lists every DROP and asks again"}</span>
                        {mode === "replace" && connection.dialect === "mysql" && (
                          <>
                            <span className="restore-warn">{MYSQL_REPLACE_LINE}</span>
                            <label className="restore-tick restore-sub">
                              <input type="checkbox" checked={backupFirst} onChange={(e) => setBackupFirst(e.target.checked)} />
                              <span>{`Back up these ${n(tables)} tables first`}</span>
                            </label>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </section>
            </>
          )}
          {planError && (
            <p className="restore-error" role="alert">
              {planError}
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          <span className="restore-hint">Next you see the exact SQL before anything runs.</span>
          <span className="spacer" />
          <button
            type="button"
            className="button"
            onClick={() => {
              if (checkJob) void jobs.cancel(checkJob).catch(() => {});
              onClose();
            }}
          >
            Cancel
          </button>
          {connection.production ? (
            <button type="button" className="button button-prod" disabled={!canRestore} aria-busy={planning} onClick={() => void review()}>
              Restore on PROD...
              <Kbd keys="Ctrl+Enter" />
            </button>
          ) : (
            <button type="button" className="button button-primary" disabled={!canRestore} aria-busy={planning} onClick={() => void review()}>
              Restore
            </button>
          )}
        </footer>
      </div>
    </Dialog>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="restore-kv-row" role="listitem">
      <dt>{k}</dt>
      <dd className={mono ? "mono" : undefined}>{v}</dd>
    </div>
  );
}

interface BodyProps {
  plan: RestorePlan;
  req: RestoreRequest | null;
  connection: ConnectionConfig;
  tables: number;
  onError(text: string): void;
}

/** The confirm body: the structure SQL exactly (12 lines, then Show all), the INSERT shape, and the cleanup line. */
function ConfirmBody({ plan, req, connection, tables, onError }: BodyProps) {
  const [loaded, setLoaded] = useState<ScriptStatement[]>(plan.structure);
  const [all, setAll] = useState(false);
  const [paging, setPaging] = useState(false);
  const dialect = connection.dialect;
  const band = connection.production ? ("prod" as const) : undefined;

  // Shown in run order (R10): Contura's setup, the drops, the file's statements, then what Contura
  // adds after, which follows only once every file statement is loaded. A skipped statement does not
  // run, so it is not shown unless Run as is keeps it (R11).
  const file = loaded.filter((st) => st.action.kind === "run" || st.runAsIs === true);
  const complete = loaded.length >= plan.structureTotal;
  // R15: CREATE DATABASE runs first, on its own line, before the writer's setup.
  const create = plan.createDatabase ? [plan.createDatabase] : [];
  const items: { text: string; class: StatementClass }[] = [
    ...create,
    ...plan.setup,
    ...plan.drops,
    ...file.map((st) => ({ text: st.text, class: st.class })),
    ...(complete ? plan.after : []),
  ];
  const total = create.length + plan.setup.length + plan.drops.length + plan.structureTotal + plan.after.length;

  // Whole statements while they fit in 12 lines; the first one always shows.
  let shown = items.length;
  if (!all) {
    let used = 0;
    shown = 0;
    for (const it of items) {
      const lines = it.text.split("\n").length;
      if (shown > 0 && used + lines > FIRST_LINES) break;
      used += lines;
      shown++;
    }
  }
  const visible = items.slice(0, shown);
  const hidden = total - shown;

  // Each statement's own label from the Core; the Production band on writes only.
  const marks: SqlMark[] = [];
  let next = 1;
  for (const it of visible) {
    const lines = it.text.split("\n").length;
    const write = it.class === "write";
    marks.push({ firstLine: next, lastLine: next + lines - 1, tag: write ? "writes" : "reads", ...(write && band && { band }) });
    next += lines;
  }

  async function showAll() {
    setAll(true);
    if (!req || loaded.length >= plan.structureTotal || paging) return;
    setPaging(true);
    try {
      const more = await restoreStatements(req, loaded.length);
      setLoaded((l) => [...l, ...more]);
    } catch (e) {
      onError(errorText(e, dialect));
    } finally {
      setPaging(false);
    }
  }

  const shape = plan.insertShape;
  const fold = shape ? foldText(shape) : null;
  const backupFirst = req?.mode.kind === "replace" && req.mode.backupFirst && plan.backupFirstPath;

  return (
    <div className="restore-confirm">
      {backupFirst && (
        <p className="restore-step">
          <Icon name="save" size={14} />
          <span>{`Back up these ${n(tables)} tables first:`}</span>
          <span className="mono">{plan.backupFirstPath}</span>
        </p>
      )}
      <p className="confirm-shape-head">{`Structure, ${n(total)} statements, exact SQL from the file`}</p>
      <div className="confirm-item confirm-exact" aria-label="Structure SQL">
        <SqlBlock sql={visible.map((it) => it.text).join("\n")} dialect={dialect} marks={marks} />
      </div>
      {hidden > 0 && (
        <p className="confirm-fold">
          <span>{`${n(hidden)} more structure ${hidden === 1 ? "statement" : "statements"}`}</span>
          <button type="button" className="button button-small button-ghost" disabled={paging} onClick={() => void showAll()}>
            Show all
          </button>
        </p>
      )}
      {shape && (
        <>
          <p className="confirm-shape-head restore-shape-head">
            <span>{`Rows: INSERT shape, statement 1 of ${n(plan.insertCount)}`}</span>
            <span className="restore-hint">{`${n(shape.rowsPerStatement)} rows each`}</span>
          </p>
          <div className="confirm-item confirm-shape" aria-label="INSERT shape">
            <SqlBlock
              sql={[shape.head, ...shape.firstRows.map((r, j) => `  ${r}${j < shape.firstRows.length - 1 ? "," : ""}`)].join("\n")}
              dialect={dialect}
              marks={[{ firstLine: 1, lastLine: shape.firstRows.length + 1, tag: "writes", ...(band && { band }) }]}
            />
          </div>
          {fold && (
            <p className="confirm-fold">
              <span>{fold}</span>
            </p>
          )}
        </>
      )}
      {plan.cleanup.length > 0 && (
        <p className="restore-cleanup">
          <span>If the restore fails or is cancelled:</span>
          {plan.cleanup.map((c) => (
            <code key={c}>{c}</code>
          ))}
        </p>
      )}
    </div>
  );
}

interface RunningProps {
  plan: RestorePlan;
  mode: ModeKind;
  dialect: ConnectionConfig["dialect"];
  progress: Progress | null;
  statements: number | null;
  bytesTotal: number | null;
  elapsed: number;
  connection: string;
  onBackground(): void;
  onCancel(): void;
}

/** Percent and bar by bytes read, the facts, the phase list and the transaction note. */
function RunningBody({ plan, mode, dialect, progress, statements, bytesTotal, elapsed, connection, onBackground, onCancel }: RunningProps) {
  const bytesDone = progress?.bytesDone ?? 0;
  const total = progress?.bytesTotal ?? bytesTotal;
  const percent = total ? Math.min(100, Math.floor((bytesDone / Math.max(1, total)) * 100)) : null;
  const done = progress?.statementsDone ?? 0;
  const steps = stepsFor(dialect, mode);
  const at = progress?.restoreStep ? steps.findIndex((s) => s.step === progress.restoreStep) : -1;
  return (
    <>
      <div className="dialog-body restore-running">
        {percent !== null && (
          <>
            <div className="backup-running-head">
              <span className="spacer" />
              <span className="backup-running-percent">{`${percent} percent`}</span>
            </div>
            <div className="backup-bar" role="progressbar" aria-label="Restore progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <b style={{ width: `${percent}%` }} />
            </div>
          </>
        )}
        <dl className="backup-facts">
          <dt>Read</dt>
          <dd>{total ? ofSizeText(bytesDone, total) : sizeText(bytesDone)}</dd>
          <dt>Statements</dt>
          <dd>{statements !== null ? `${n(done)} of ${n(statements)}` : n(done)}</dd>
          <dt>Time</dt>
          <dd>{elapsedLine(elapsed, timeLeft(elapsed, bytesDone, total ?? null))}</dd>
          {progress?.now && (
            <>
              <dt>Now</dt>
              <dd className="mono">{progress.now}</dd>
            </>
          )}
        </dl>
        <ol className="restore-phases" aria-label="Phases">
          {steps.map((s, i) => {
            const state = i < at ? "done" : i === at ? "now" : "next";
            return (
              <li key={s.step} className={`restore-phase restore-phase-${state}`} data-state={state}>
                <Icon name={state === "done" ? "check" : state === "now" ? "play" : "minus"} size={14} />
                {s.label(plan, progress?.insertsDone ?? 0)}
              </li>
            );
          })}
        </ol>
        <div className="backup-banner">
          <Icon name="info" size={14} />
          <span>{plan.modeLine}</span>
        </div>
      </div>
      <footer className="dialog-footer">
        <span className="restore-hint">{`Recorded in Query History for ${connection}.`}</span>
        <span className="spacer" />
        <button type="button" className="button" onClick={onBackground}>
          Run in the background
        </button>
        <button type="button" className="button" data-autofocus onClick={onCancel}>
          Cancel and roll back
          <Kbd keys="Esc" />
        </button>
      </footer>
    </>
  );
}
