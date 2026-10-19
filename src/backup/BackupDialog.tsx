// The Backup dialog (spec step 9 "Backup", frame 9.1): what goes in, where the file goes, its
// format, and the running view. Backup only reads, so it never asks for a confirmation.
import { documentDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { errorText, fileName, isCommandError } from "../api/client";
import { newJobId, planBackup, revealInFolder, startBackup } from "../api/jobs";
import {
  type BackupFormat,
  type BackupInclude,
  type BackupPlan,
  type BackupRequest,
  type ConnectionConfig,
  DEFAULT_BACKUP_INCLUDE,
  type Group,
  type JobEvent,
  type JobId,
} from "../api/types";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import GroupBadge, { groupStyle } from "../components/GroupBadge";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import SafetyTag from "../components/SafetyTag";
import Segmented from "../components/Segmented";
import Switch from "../components/Switch";
import { useToast } from "../components/Toast";
import { bytesText, elapsedLine, timeLeft } from "../jobs/exportText";
import { useJobs } from "../jobs/useJobs";
import {
  BACKUP_CANCELLED,
  BACKUP_PRODUCTION_BANNER,
  MYSQL_INDEXES_HINT,
  backedUpText,
  backupFooter,
  countLines,
  estimateLine,
  localDate,
  myisamLine,
  notIncludedText,
  partialHint,
  snapshotLine,
} from "./backupText";

interface Props {
  connection: ConnectionConfig;
  group: Group | null;
  /** MySQL database, SQLite "main", PostgreSQL database. */
  database: string;
  /** PostgreSQL: the schema backed up. */
  schema: string | null;
  onClose(): void;
}

/** The last folder a Backup went to. */
export const BACKUP_FOLDER_KEY = "contura.backupFolder";

const n = (v: number) => v.toLocaleString("en-US");

type Tick = keyof BackupInclude;
const TICKS: { key: Tick; label: string }[] = [
  { key: "tables", label: "Tables, columns and keys" },
  { key: "indexes", label: "Indexes and Foreign Keys" },
  { key: "enums", label: "Enums and sequences" },
  { key: "definitions", label: "Views, functions and triggers" },
  { key: "rows", label: "Rows" },
];
/** What needs the tables: unticking Tables unticks these. */
const NEEDS_TABLES: Tick[] = ["indexes", "definitions", "rows"];

function readFolder(): string | null {
  try {
    return localStorage.getItem(BACKUP_FOLDER_KEY);
  } catch {
    return null;
  }
}

function writeFolder(folder: string) {
  try {
    localStorage.setItem(BACKUP_FOLDER_KEY, folder);
  } catch {
    // Remembering the folder is a convenience only.
  }
}

export function joinPath(folder: string, name: string): string {
  if (folder === "") return name;
  if (/[\\/]$/.test(folder)) return folder + name;
  const sep = folder.includes("/") && !folder.includes("\\") ? "/" : "\\";
  return `${folder}${sep}${name}`;
}

export function splitPath(path: string): { folder: string; name: string } {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return { folder: path.slice(0, Math.max(0, cut)), name: path.slice(cut + 1) };
}

/** The file copy is a database file, so its name ends in .sqlite instead of .sql. */
function nameFor(name: string, format: BackupFormat): string {
  if (format === "fileCopy") return name.replace(/\.sql$/i, ".sqlite");
  return name.replace(/\.sqlite$/i, ".sql");
}

type Progress = Extract<JobEvent, { kind: "progress" }>;

export default function BackupDialog({ connection, group, database, schema, onClose }: Props) {
  const jobs = useJobs();
  const toast = useToast();
  const sqlite = connection.dialect === "sqlite";
  const mysql = connection.dialect === "mysql";
  const postgres = connection.dialect === "postgres";

  const [plan, setPlan] = useState<BackupPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [include, setInclude] = useState<BackupInclude>(DEFAULT_BACKUP_INCLUDE);
  const [format, setFormat] = useState<BackupFormat>("script");
  const [rowsPer, setRowsPer] = useState(500);
  const [dropTables, setDropTables] = useState(false);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(() => readFolder());
  const [jobId, setJobId] = useState<JobId | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (folder !== null) return;
    let live = true;
    documentDir().then(
      (dir) => live && setFolder((f) => f ?? dir),
      () => live && setFolder((f) => f ?? ""),
    );
    return () => {
      live = false;
    };
  }, [folder]);

  const path = folder === null || name === "" ? null : joinPath(folder, name);
  const req: BackupRequest = {
    connectionId: connection.id,
    database,
    schema,
    // R8: on MySQL the indexes come with the tables. R21: on PostgreSQL the enums and sequences do.
    include: mysql
      ? { ...include, indexes: include.tables }
      : postgres
        ? { ...include, enums: include.tables || include.enums }
        : include,
    format,
    rowsPerStatement: rowsPer,
    addDropTables: dropTables,
    path: path ?? "",
    // R25: the default file name uses the user's own date.
    localDate: localDate(new Date()),
  };

  useEffect(() => {
    let live = true;
    planBackup({ ...req, include: DEFAULT_BACKUP_INCLUDE, format: "script", path: "" }).then(
      (p) => {
        if (!live) return;
        setPlan(p);
        setName((current) => current || p.defaultFileName);
      },
      (e) => live && setPlanError(errorText(e, connection.dialect)),
    );
    return () => {
      live = false;
    };
    // Planned once: the counts do not depend on the choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const job = jobId ? jobs.jobs.find((j) => j.id === jobId) : undefined;
  const running = jobId !== null;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (!job?.done) return;
    const done = job.done;
    if (job.background) {
      onClose();
      return;
    }
    jobs.dismiss(job.id);
    setJobId(null);
    setProgress(null);
    if ("report" in done) {
      const file = done.report.file ?? path;
      toast.show({
        kind: "success",
        text: backedUpText(database, file ? fileName(file) : name, done.report.bytes),
        action: file ? { label: "Open folder", run: () => void revealInFolder(file) } : undefined,
      });
      onClose();
    } else if (done.error.kind === "cancelled") {
      toast.show({ kind: "info", text: BACKUP_CANCELLED });
      onClose();
    } else {
      setError(errorText(done.error, connection.dialect));
    }
    // Reacts to the job's end only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.done]);

  async function start(overwrite: boolean) {
    if (path === null || jobId !== null || folder === null) return;
    const id = newJobId();
    const track = jobs.track(id, "backup", `Backing up ${database}`, connection.id, database);
    const onEvent = (e: JobEvent) => {
      if (e.kind === "progress") setProgress(e);
      track(e);
    };
    setJobId(id);
    setError(null);
    try {
      await startBackup(id, req, overwrite, onEvent);
      writeFolder(folder);
    } catch (e) {
      jobs.dismiss(id);
      setJobId(null);
      if (isCommandError(e) && e.kind === "fileExists") setAsking(true);
      else setError(errorText(e, connection.dialect));
    }
  }

  function cancelJob() {
    if (jobId) jobs.cancel(jobId).catch((e) => setError(errorText(e, connection.dialect)));
  }

  function toBackground() {
    if (jobId) jobs.background(jobId);
    onClose();
  }

  async function browse() {
    if (path === null) return;
    const target = await save({ defaultPath: path, filters: [{ name: format === "fileCopy" ? "SQLite database" : "SQL file", extensions: [format === "fileCopy" ? "sqlite" : "sql"] }] });
    if (!target) return;
    const parts = splitPath(target);
    setFolder(parts.folder);
    setName(parts.name);
  }

  function tick(key: Tick, on: boolean) {
    setInclude((inc) => {
      const next = { ...inc, [key]: on };
      if (key === "tables" && !on) for (const k of NEEDS_TABLES) next[k] = false;
      return next;
    });
  }

  function changeFormat(f: BackupFormat) {
    setFormat(f);
    setName((current) => nameFor(current, f));
  }

  function closeDialog() {
    if (asking) setAsking(false);
    else if (running) toBackground();
    else onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!running && !asking && !nothing) void start(false);
    }
  }

  const scope = schema ?? database;
  const lines = plan ? countLines(plan.counts, scope) : null;
  const copy = format === "fileCopy";
  const nothing = !copy && !Object.values(include).some(Boolean);

  const title = asking ? (
    "Replace the file"
  ) : (
    <span className="backup-title">
      Back up <b>{connection.name}</b> · {database}
    </span>
  );

  const badge = asking ? undefined : (
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

  return (
    <Dialog
      title={title}
      lead={asking ? undefined : <DbMark dialect={connection.dialect} open />}
      badge={badge}
      size={asking ? "confirm" : "form"}
      className={["backup-dialog", !asking && !running && "backup-form", connection.production && "prod-wash"].filter(Boolean).join(" ")}
      onClose={closeDialog}
    >
      <div className="backup-keys" style={groupStyle(group?.color)} onKeyDown={onKeyDown}>
        {asking && path !== null ? (
          <>
            <div className="dialog-body">
              <p>{`${fileName(path)} exists. Replace it?`}</p>
            </div>
            <footer className="dialog-footer">
              <button type="button" className="button" onClick={() => setAsking(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  setAsking(false);
                  void start(true);
                }}
              >
                Replace
              </button>
            </footer>
          </>
        ) : running ? (
          <RunningView
            progress={progress}
            startedAt={job?.startedAt ?? now}
            now={now}
            path={path ?? name}
            error={error}
            onBackground={toBackground}
            onCancel={cancelJob}
          />
        ) : (
          <>
            <div className="dialog-body backup-body">
              {connection.production && (
                <div className="backup-banner backup-banner-prod">
                  <Icon name="warning" size={14} />
                  <span>{BACKUP_PRODUCTION_BANNER}</span>
                </div>
              )}
              <div className="backup-grid">
                <section className="backup-section" aria-label="What goes in">
                  <h3 className="backup-head">What goes in</h3>
                  {TICKS.filter((t) => t.key !== "enums" || connection.dialect === "postgres").map((t) => {
                    // R8: MySQL keeps indexes and Foreign Keys inside each SHOW CREATE TABLE.
                    const inTable = mysql && t.key === "indexes";
                    // R21: a PostgreSQL table needs its enums and sequences, so they follow Tables.
                    const withTables = postgres && t.key === "enums" && include.tables;
                    const off = copy || inTable || withTables || (t.key !== "tables" && NEEDS_TABLES.includes(t.key) && !include.tables);
                    return (
                      <label key={t.key} className={off ? "backup-tick backup-tick-off" : "backup-tick"}>
                        <input
                          type="checkbox"
                          checked={copy || withTables || (inTable ? include.tables : include[t.key])}
                          disabled={off}
                          onChange={(e) => tick(t.key, e.target.checked)}
                        />
                        <span className="backup-tick-text">
                          <span>{t.label}</span>
                          {lines && <span className="backup-count">{lines[t.key]}</span>}
                          {inTable && <span className="backup-count">{MYSQL_INDEXES_HINT}</span>}
                        </span>
                      </label>
                    );
                  })}
                </section>
                <div className="backup-side">
                  <section className="backup-section" aria-label="Save to">
                    <h3 className="backup-head">Save to</h3>
                    <div className="backup-file">
                      <input
                        className="input mono"
                        aria-label="File name"
                        value={name}
                        spellCheck={false}
                        onChange={(e) => setName(e.target.value)}
                      />
                      <button type="button" className="button" onClick={() => void browse()}>
                        <Icon name="folder" size={14} />
                        Browse...
                      </button>
                    </div>
                    {folder !== null && folder !== "" && <span className="backup-hint mono">{`in ${folder}`}</span>}
                    {name !== "" && <span className="backup-hint">{partialHint(name)}</span>}
                  </section>
                  <section className="backup-section" aria-label="Format">
                    <h3 className="backup-head">Format</h3>
                    <label className="backup-choice">
                      <input type="radio" className="radio" name="backup-format" checked={!copy} onChange={() => changeFormat("script")} />
                      <span className="backup-tick-text">
                        <span>Contura SQL script</span>
                        <span className="backup-count">Plain SQL that Contura can restore, readable in any editor.</span>
                      </span>
                    </label>
                    {sqlite && (
                      <label className="backup-choice">
                        <input type="radio" className="radio" name="backup-format" checked={copy} onChange={() => changeFormat("fileCopy")} />
                        <span className="backup-tick-text">
                          <span>Exact file copy</span>
                          <span className="backup-count">A copy of the database file, made with VACUUM INTO. Restore it by opening it as a Connection.</span>
                        </span>
                      </label>
                    )}
                  </section>
                  {!copy && (
                    <>
                      <div className="field">
                        <span className="fl">Rows per INSERT</span>
                        <Segmented<"100" | "500" | "1000">
                          label="Rows per INSERT"
                          value={String(rowsPer) as "100" | "500" | "1000"}
                          onChange={(v) => setRowsPer(Number(v))}
                          options={[
                            { value: "100", label: "100" },
                            { value: "500", label: "500" },
                            { value: "1000", label: "1,000" },
                          ]}
                        />
                      </div>
                      <Switch label="Add DROP TABLE before each table" checked={dropTables} onChange={setDropTables} />
                    </>
                  )}
                </div>
              </div>
              {plan && plan.notIncluded.length > 0 && !copy && (
                <div className="backup-banner">
                  <Icon name="info" size={14} />
                  <span>{notIncludedText(plan.notIncluded)}</span>
                </div>
              )}
              <dl className="backup-facts">
                <dt>Consistency</dt>
                <dd>
                  <span>{snapshotLine(database)}</span>
                  {plan && myisamLine(plan.nonSnapshotTables) && <span className="backup-warn">{myisamLine(plan.nonSnapshotTables)}</span>}
                </dd>
                {plan && (
                  <>
                    <dt>Estimated</dt>
                    <dd>{estimateLine(plan.estimateBytes, plan.counts.rows, plan.counts.tables)}</dd>
                  </>
                )}
              </dl>
              {planError && (
                <p className="backup-error" role="alert">
                  {planError}
                </p>
              )}
            </div>
            <footer className="dialog-footer">
              {error ? (
                <p className="backup-error" role="alert">
                  {error}
                </p>
              ) : (
                <span className="backup-hint">{backupFooter(connection.name)}</span>
              )}
              <span className="spacer" />
              <button type="button" className="button" onClick={onClose}>
                Cancel
                <Kbd keys="Esc" />
              </button>
              <button type="button" className="button button-primary" disabled={path === null || nothing} onClick={() => void start(false)}>
                <Icon name="save" size={14} />
                Back up
                <Kbd keys="Ctrl+Enter" />
              </button>
            </footer>
          </>
        )}
      </div>
    </Dialog>
  );
}

interface RunningProps {
  progress: Progress | null;
  startedAt: number;
  now: number;
  path: string;
  error: string | null;
  onBackground(): void;
  onCancel(): void;
}

/** Table and row progress, bytes written, time and time left. */
function RunningView({ progress, startedAt, now, path, error, onBackground, onCancel }: RunningProps) {
  const elapsed = Math.max(0, now - startedAt);
  const rowsDone = progress?.rowsDone ?? 0;
  const rowsTotal = progress?.rowsTotal ?? null;
  const percent = rowsTotal !== null ? (rowsTotal <= 0 ? 100 : Math.min(100, Math.floor((rowsDone / rowsTotal) * 100))) : null;
  const tablesDone = progress?.tablesDone ?? null;
  const tablesTotal = progress?.tablesTotal ?? null;
  const tables =
    tablesDone !== null && tablesTotal !== null && tablesTotal !== undefined
      ? `${n(tablesDone)} of ${n(tablesTotal)}${progress?.table ? `, now ${progress.table}` : ""}`
      : (progress?.table ?? "Starting");
  return (
    <>
      <div className="dialog-body backup-running">
        <div className="backup-running-head">
          <span className="backup-running-path">
            Writing <span className="mono">{path}</span>
          </span>
          {percent !== null && <span className="backup-running-percent">{`${percent} percent`}</span>}
        </div>
        {percent !== null && (
          <div className="backup-bar" role="progressbar" aria-label="Backup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <b style={{ width: `${percent}%` }} />
          </div>
        )}
        <dl className="backup-facts">
          <dt>Tables</dt>
          <dd>{tables}</dd>
          <dt>Rows</dt>
          <dd>{rowsTotal !== null ? `${n(rowsDone)} of ${n(rowsTotal)}` : n(rowsDone)}</dd>
          <dt>Written</dt>
          <dd>{bytesText(progress?.bytesDone ?? 0)}</dd>
          <dt>Time</dt>
          <dd>{elapsedLine(elapsed, timeLeft(elapsed, rowsDone, rowsTotal))}</dd>
        </dl>
        {error && (
          <p className="backup-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="dialog-footer">
        <span className="backup-hint">Cancel deletes the unfinished file.</span>
        <span className="spacer" />
        <button type="button" className="button" onClick={onBackground}>
          Run in the background
          <Kbd keys="Esc" />
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </footer>
    </>
  );
}
