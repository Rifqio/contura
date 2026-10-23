import { open } from "@tauri-apps/plugin-dialog";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { errorText, fileName, isCommandError } from "../api/client";
import {
  cancelJob,
  checkImportFile,
  confirmImport,
  confirmScript,
  inspectImportFile,
  newJobId,
  planImport,
  planScript,
  scriptStatements,
  startImport,
  startScript,
} from "../api/jobs";
import {
  type Cell,
  type CheckReport,
  type ColumnMap,
  type ConnectionConfig,
  type ConnectionId,
  DEFAULT_IMPORT_OPTIONS,
  type FileSummary,
  type Format,
  type Group,
  type ImportOptions,
  type ImportPlan,
  type ImportRequest,
  type JobEvent,
  type JobId,
  type ObjectPath,
  type PassId,
  type ScriptPlan,
  type ScriptRequest,
  type ScriptStatement,
} from "../api/types";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import ResultGrid, { type GridColumn } from "../components/ResultGrid";
import SafetyTag from "../components/SafetyTag";
import Select from "../components/Select";
import SqlBlock from "../components/SqlBlock";
import Switch from "../components/Switch";
import WarningBanner from "../components/WarningBanner";
import ConfirmRun, { type ConfirmJob } from "../query/ConfirmRun";
import ImportOptionsPanel from "./ImportOptionsPanel";
import ImportRunView from "./ImportRunView";
import {
  checkBanner,
  confirmSummary,
  fingerprintText,
  footerText,
  type ImportTarget,
  matchByName,
  oneTransactionOf,
  qualifiedName,
  rowsPhrase,
  runLabel,
  scriptFooter,
  scriptNotes,
  scriptOneTransaction,
  scriptSummary,
} from "./importModel";
import MappingTable from "./MappingTable";
import ScriptStatements from "./ScriptStatements";
import { useJobs } from "./useJobs";

export interface ImportTabProps {
  connection: ConnectionConfig;
  group: Group | null;
  target: ImportTarget;
  visible: boolean;
  /** Every Connection an import may write to, for "Choose Connection..." on a Read-only target. */
  writable: ConnectionConfig[];
  onRetarget(id: ConnectionId): void;
  /** A .sql file chosen in a table tab turns it into a database import. */
  onTargetChange(t: ImportTarget): void;
  onOpenTable(path: ObjectPath): void;
  /** D25: Open in Restore shows only once step 9 supplies it. */
  onOpenInRestore?(): void;
  onRunningChange?(running: boolean): void;
  /**
   * The id of the job a run started, so the App can ask before the tab closes and dismiss the
   * job after. A SQL file's id comes when start_script returns (until Task 9's client id, Q21).
   */
  onJob?(id: JobId): void;
}

type Step = "file" | "columns" | "statements" | "run";

const EXTENSIONS = ["csv", "tsv", "txt", "json", "jsonl", "ndjson", "xlsx", "sql"];
/** The check pass waits this long after the last mapping change. */
const CHECK_DELAY_MS = 300;
const NUMERIC = /int|numeric|decimal|real|double|float|serial|money/i;

type Check = { state: "running" } | { state: "done"; report: CheckReport } | null;

interface Run {
  /** The client-made id, tracked before the start (Q2, Q21). */
  id: JobId;
  fileRow: number | null;
  /** Q27: rows that stay after a stop, from the Failed event. */
  rowsCommitted: number;
  /** Whether a cancel rolls everything back (one transaction). */
  rollsBack: boolean;
}

/**
 * The Import tab (frame 7.2): File, then Columns (Statements for a SQL file), then Run. Plain
 * Connections get no SQL dialog; Production asks once for the described job.
 */
export default function ImportTab({
  connection,
  group,
  target,
  visible,
  writable,
  onRetarget,
  onTargetChange,
  onOpenTable,
  onOpenInRestore,
  onRunningChange,
  onJob,
}: ImportTabProps) {
  const jobs = useJobs();
  const root = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>("file");
  const [path, setPath] = useState("");
  const [reading, setReading] = useState(false);
  const [summary, setSummary] = useState<FileSummary | null>(null);
  const [format, setFormat] = useState<Format | null>(null);
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_IMPORT_OPTIONS);
  const [mapping, setMapping] = useState<ColumnMap[] | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [script, setScript] = useState<ScriptPlan | null>(null);
  const [statements, setStatements] = useState<ScriptStatement[]>([]);
  const [paging, setPaging] = useState(false);
  const [runAsIs, setRunAsIs] = useState(false);
  const [check, setCheck] = useState<Check>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sample, setSample] = useState<{ back: boolean } | null>(null);
  const [run, setRun] = useState<Run | null>(null);

  const sql = format === "sql";
  const database = target.kind === "database" ? target.database : target.path.database;
  const table = target.kind === "table" ? target.path : null;
  const production = connection.production;
  const dialect = connection.dialect;

  const req: ImportRequest | null =
    table && path && format && !sql ? { connectionId: connection.id, table, file: path, format, options, mapping: mapping ?? [] } : null;
  const reqKey = req && summary ? JSON.stringify(req) : null;
  const scriptReq: ScriptRequest | null = sql && path ? { connectionId: connection.id, database, path, runAsIs } : null;

  // Plan again whenever the file, the options or the mapping change.
  useEffect(() => {
    if (!req || !reqKey) return;
    let live = true;
    planImport(req).then(
      // A fresh object each time, so the check pass restarts even when the plan reads the same.
      (p) => live && setPlan({ ...p }),
      (e) => live && setError(errorText(e, dialect)),
    );
    return () => {
      live = false;
    };
    // reqKey stands for req.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey]);

  // The check pass: 300 ms after the plan settles, read the whole file in the background. A newer
  // plan cancels the pass that is still running.
  useEffect(() => {
    const verdict = plan?.verdict.kind;
    if (step !== "columns" || !plan || !req || connection.readOnly || verdict === "readOnly" || verdict === "blocked") return;
    let live = true;
    let id: JobId | null = null;
    let ended = false;
    setCheck(null);
    const onEvent = (e: JobEvent) => {
      if (e.kind !== "finished" && e.kind !== "failed") return;
      ended = true;
      if (!live) return;
      setCheck(e.kind === "finished" && e.report.check ? { state: "done", report: e.report.check } : null);
    };
    const timer = window.setTimeout(() => {
      setCheck({ state: "running" });
      checkImportFile(req, onEvent).then(
        (got) => {
          id = got;
          if (!live && !ended) void cancelJob(got).catch(() => {});
        },
        () => live && setCheck(null),
      );
    }, CHECK_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      if (id !== null && !ended) void cancelJob(id).catch(() => {});
    };
    // The pass follows the plan; req is the one the plan was made for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, step]);

  const readOnly = connection.readOnly || plan?.verdict.kind === "readOnly" || script?.verdict.kind === "readOnly";
  const view = run?.id ? (jobs.jobs.find((j) => j.id === run.id) ?? null) : null;
  const ended = run !== null && view?.done != null;

  async function chooseFile() {
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "Data and SQL files", extensions: EXTENSIONS }] });
    if (typeof picked !== "string") return;
    setPath(picked);
    setError(null);
    setSummary(null);
    setPlan(null);
    setScript(null);
    setMapping(null);
    setCheck(null);
    setStep("file");
    if (/\.sql$/i.test(picked)) {
      toScript(picked);
      return;
    }
    await inspect(picked, null);
  }

  async function inspect(file: string, as: Format | null) {
    setReading(true);
    try {
      const s = await inspectImportFile(file, as);
      if (s.format === "sql") {
        toScript(file);
        return;
      }
      setSummary(s);
      setFormat(s.format);
      setOptions((o) => ({ ...o, delimiter: null, sheet: null }));
    } catch (e) {
      setError(errorText(e, dialect));
    } finally {
      setReading(false);
    }
  }

  function toScript(file: string) {
    setFormat("sql");
    if (target.kind === "table") onTargetChange({ kind: "database", database: target.path.database });
    void loadScript(file, runAsIs);
  }

  async function loadScript(file: string, asIs: boolean): Promise<ScriptPlan | null> {
    setReading(true);
    try {
      const p = await planScript({ connectionId: connection.id, database, path: file, runAsIs: asIs });
      setScript(p);
      setStatements(p.first);
      setStep("statements");
      return p;
    } catch (e) {
      setError(errorText(e, dialect));
      return null;
    } finally {
      setReading(false);
    }
  }

  async function moreStatements() {
    setPaging(true);
    try {
      const next = await scriptStatements(connection.id, path, statements.length);
      setStatements((s) => [...s, ...next]);
    } catch (e) {
      setError(errorText(e, dialect));
    } finally {
      setPaging(false);
    }
  }

  function onFormat(f: Format) {
    if (f === format) return;
    setMapping(null);
    setPlan(null);
    if (f === "sql") toScript(path);
    else {
      setFormat(f);
      void inspect(path, f);
    }
  }

  // The mapping as the table shows it: the user's own, else what the Core matched by name.
  const shown: ColumnMap[] = summary
    ? (mapping ?? summary.header.map((_, i) => ({ fileColumn: i, into: plan?.columns.find((c) => c.fileColumn === i)?.into ?? null, byHand: false })))
    : [];

  function mapColumn(fileColumn: number, into: string | null) {
    // Each table column takes one file column.
    setMapping(
      shown.map((m) =>
        m.fileColumn === fileColumn ? { ...m, into, byHand: true } : into !== null && m.into === into ? { ...m, into: null, byHand: true } : m,
      ),
    );
  }

  function matchNow() {
    if (summary && plan) setMapping(matchByName(summary.header, plan.columns));
  }

  const reasons = plan
    ? [...new Set([...(plan.verdict.kind === "blocked" ? plan.verdict.reasons : []), ...plan.columns.flatMap((c) => (c.blocks ? [c.blocks] : []))])]
    : [];
  const scriptReasons = script?.verdict.kind === "blocked" ? script.verdict.reasons : [];
  const rows = check?.state === "done" ? check.report.rows : (summary?.rowsEstimate.rows ?? 0);
  // An estimate reads "about ..." until the check pass counts the rows.
  const exact = check?.state === "done" || (summary?.rowsEstimate.exact ?? true);
  const canRun =
    run === null &&
    !readOnly &&
    (step === "columns" ? plan !== null && reasons.length === 0 : step === "statements" ? script !== null && scriptReasons.length === 0 : false);

  /** A refusal before the job started: say it, and on a changed file ask again with a new plan. */
  async function refused(e: unknown) {
    setError(errorText(e, dialect));
    if (!(isCommandError(e) && e.kind === "fileChanged")) return;
    if (sql) {
      const p = scriptReq && (await loadScript(path, runAsIs));
      if (p?.verdict.kind === "needsConfirmation") setConfirming(true);
      return;
    }
    if (!req) return;
    try {
      const p = await planImport(req);
      setPlan({ ...p });
      if (p.verdict.kind === "needsConfirmation") setConfirming(true);
    } catch (again) {
      setError(errorText(again, dialect));
    }
  }

  function onRunEvent(id: JobId, e: JobEvent) {
    if (e.kind === "progress") setRun((r) => r && { ...r, fileRow: e.fileRow });
    else if (e.kind === "finished") onRunningChange?.(false);
    else if (e.kind === "failed") {
      onRunningChange?.(false);
      setRun((r) => r && { ...r, rowsCommitted: e.rowsCommitted ?? 0 });
      // The file changed before anything was kept: confirm the new file. With rows kept
      // the end stays, with the kept count (Q45).
      if (e.error.kind === "fileChanged" && (e.rowsCommitted ?? 0) === 0) {
        jobs.dismiss(id);
        setRun(null);
        setStep(sql ? "statements" : "columns");
        void refused(e.error);
      }
    }
  }

  async function startTableRun(pass: PassId | null) {
    if (!req || !table) return;
    setError(null);
    // Q2: the id first, then track, then start, so no event is lost.
    const id = newJobId();
    const onEvent = jobs.track(id, "import", `Importing into ${table.name}`, connection.id);
    onJob?.(id);
    setRun({ id, fileRow: null, rowsCommitted: 0, rollsBack: plan ? oneTransactionOf(plan, options) : true });
    setStep("run");
    onRunningChange?.(true);
    try {
      await startImport(id, req, pass, (e) => {
        onEvent(e);
        onRunEvent(id, e);
      });
    } catch (e) {
      jobs.dismiss(id);
      setRun(null);
      setStep("columns");
      onRunningChange?.(false);
      await refused(e);
    }
  }

  async function startScriptRun(pass: PassId | null) {
    if (!scriptReq) return;
    setError(null);
    // Q21: the id first, then track, then start, so no event is lost and leaving can cancel it.
    const id = newJobId();
    const onEvent = jobs.track(id, "scriptImport", `Importing ${fileName(path)}`, connection.id);
    onJob?.(id);
    setRun({ id, fileRow: null, rowsCommitted: 0, rollsBack: script ? scriptOneTransaction(script, dialect) : true });
    setStep("run");
    onRunningChange?.(true);
    try {
      await startScript(id, scriptReq, pass, (e) => {
        onEvent(e);
        onRunEvent(id, e);
      });
    } catch (e) {
      // A start refused after its Checking progress sends no final event: drop the job here.
      jobs.dismiss(id);
      setRun(null);
      setStep("statements");
      onRunningChange?.(false);
      await refused(e);
    }
  }

  async function onRun() {
    if (!canRun) return;
    setError(null);
    if (!production) {
      if (sql) void startScriptRun(null);
      else void startTableRun(null);
      return;
    }
    // Production: plan again, so the dialog describes the file as it is now.
    try {
      if (sql) {
        const p = await loadScript(path, runAsIs);
        if (p?.verdict.kind === "needsConfirmation") setConfirming(true);
        // No longer Production on the Core's side: run as on a plain Connection.
        else if (p?.verdict.kind === "ok") void startScriptRun(null);
      } else if (req) {
        const p = await planImport(req);
        setPlan({ ...p });
        if (p.verdict.kind === "needsConfirmation") setConfirming(true);
        else if (p.verdict.kind === "ok") void startTableRun(null);
      }
    } catch (e) {
      setError(errorText(e, dialect));
    }
  }

  async function onConfirmed() {
    setConfirming(false);
    try {
      if (sql && scriptReq) await startScriptRun(await confirmScript(scriptReq));
      else if (req) await startTableRun(await confirmImport(req));
    } catch (e) {
      await refused(e);
    }
  }

  function back() {
    if (step === "columns" || step === "statements") setStep("file");
    else if (step === "run" && (ended || run === null)) {
      if (run?.id) jobs.dismiss(run.id);
      setRun(null);
      setStep(sql ? "statements" : "columns");
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // I3: a dialog the tab opened (portalled, so its keys bubble here) keeps its keys to itself.
    if (confirming || sample !== null || !(e.target instanceof Node) || !root.current?.contains(e.target)) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void onRun();
    } else if (e.key === "ArrowLeft" && e.altKey) {
      e.preventDefault();
      back();
    } else if (e.key.toLowerCase() === "m" && e.ctrlKey && !e.altKey && !e.shiftKey && step === "columns") {
      e.preventDefault();
      matchNow();
    } else if (e.key === "F2" && step === "columns") {
      e.preventDefault();
      const from = e.target instanceof Element ? e.target.closest("tr[data-file-column]") : null;
      const row = from ?? root.current?.querySelector("tr[data-file-column]");
      row?.querySelector<HTMLElement>("[role=combobox]")?.focus();
    }
  }

  // The confirmation, described once for the whole job.
  let confirm: { connection: string; database: string | null; job: ConfirmJob; warnings: string[] } | null = null;
  if (confirming && !sql && plan?.verdict.kind === "needsConfirmation" && table) {
    const v = plan.verdict;
    const statementsCount = plan.shape.statements + plan.extra.length;
    confirm = {
      connection: v.connection,
      database: v.database,
      // Q28: every plan warning, the MyISAM one among them, before the run.
      warnings: plan.warnings,
      job: {
        title: confirmSummary(qualifiedName(table), plan.shape, options, oneTransactionOf(plan, options)),
        counts: `${statementsCount.toLocaleString("en-US")} ${statementsCount === 1 ? "statement writes" : "statements write"}.`,
        shapes: [{ kind: "shape", line: 1, shape: plan.shape }, ...plan.extra.map((text) => ({ kind: "exact" as const, line: 0, text }))],
        fingerprint: fingerprintText(v.fileBytes, v.fileSha256),
        onShowAll: () => {
          setConfirming(false);
          setSample({ back: true });
        },
      },
    };
  } else if (confirming && sql && script?.verdict.kind === "needsConfirmation") {
    const v = script.verdict;
    const how = script.ownTransactions
      ? ", as the file's own transactions say"
      : scriptOneTransaction(script, dialect)
        ? ", in one transaction"
        : "";
    confirm = {
      connection: v.connection,
      database: v.database,
      // The footer's notes beyond its run line: own transactions, MySQL DDL, statements run apart.
      warnings: scriptNotes(script, dialect),
      job: {
        title: `Runs ${script.statements.toLocaleString("en-US")} ${script.statements === 1 ? "statement" : "statements"} from ${fileName(path)} in ${database}${how}.`,
        counts:
          scriptSummary(script) +
          (script.confirmMore > 0 ? ` ${script.confirmMore.toLocaleString("en-US")} more are not listed here.` : ""),
        shapes: script.confirm,
        fingerprint: fingerprintText(script.bytes, script.sha256),
      },
    };
  }

  const others = writable.filter((c) => c.dialect === dialect && !c.readOnly && c.id !== connection.id);
  const stepNames: { key: Step; label: string }[] = [
    { key: "file", label: "File" },
    sql ? { key: "statements", label: "Statements" } : { key: "columns", label: "Columns" },
    { key: "run", label: "Run" },
  ];
  const sampleRows = plan ? Math.min(plan.shape.rowsPerStatement, plan.shape.rows) : 0;
  const label = sql ? (production ? "Import on PROD..." : `Import ${(script?.statements ?? 0).toLocaleString("en-US")} statements`) : runLabel(connection, rows, exact);

  const previewCols = plan
    ? plan.preview[0] && plan.preview[0].length === plan.columns.length
      ? plan.columns
      : plan.columns.filter((c) => c.fileColumn !== null)
    : [];
  const gridColumns: GridColumn[] = previewCols.map((c) => ({ name: c.into, typeName: c.typeSql, numeric: NUMERIC.test(c.typeSql) }));
  const gridRows: Cell[][] = (plan?.preview ?? []).map((r) =>
    r.map((c) => (c.text === null ? { t: "null" } : { t: "text", value: c.text, truncated: false, totalBytes: c.text.length })),
  );

  return (
    <div ref={root} className={production ? "import-tab prod-wash" : "import-tab"} onKeyDown={onKeyDown}>
      <header className="import-head">
        <span className="import-into">Into</span>
        <DbMark dialect={dialect} open size={14} />
        <b className="import-conn">{connection.name}</b>
        <SafetyTag connection={connection} small />
        <span className="import-target">{table && !sql ? qualifiedName(table) : database}</span>
      </header>
      <ol className="import-steps" aria-label="Steps">
        {stepNames.map((s, i) => (
          <li key={s.key} aria-current={s.key === step ? "step" : undefined} className={s.key === step ? "import-step import-step-now" : "import-step"}>
            <span className="import-step-n">{i + 1}</span>
            {s.label}
          </li>
        ))}
      </ol>

      {readOnly && (
        <WarningBanner
          className="import-readonly"
          action={
            others.length > 0 && (
              <Select
                label="Choose Connection..."
                value=""
                options={[{ value: "", label: "Choose Connection...", disabled: true }, ...others.map((c) => ({ value: c.id, label: c.name }))]}
                onChange={(id) => id && onRetarget(id)}
              />
            )
          }
        >
          {connection.name} is Read-only. Import is not allowed here.
        </WarningBanner>
      )}
      {error && (
        <div className="import-banner import-banner-danger" role="alert">
          <Icon name="error" />
          <p>{error}</p>
        </div>
      )}

      {step === "run" ? (
        <ImportRunView
          view={view}
          fileRow={run?.fileRow ?? null}
          rowsCommitted={run?.rowsCommitted ?? 0}
          rollsBack={run?.rollsBack ?? true}
          into={sql || !table ? database : table.name}
          script={sql}
          dialect={dialect}
          onCancel={() => run?.id && void jobs.cancel(run.id)}
          onBack={back}
          onOpenTable={table && !sql ? () => onOpenTable(table) : undefined}
        />
      ) : (
        <div className="import-body">
          <ImportOptionsPanel
            path={path}
            summary={summary}
            format={format}
            options={options}
            busy={reading}
            onBrowse={() => void chooseFile()}
            onFormat={onFormat}
            onOptions={setOptions}
          />
          <main className="import-main">
            {step === "file" && (
              <div className="import-file">
                {!path && <p className="state-panel muted">Choose a CSV, JSON, Excel or SQL file to import.</p>}
                {summary && visible && (
                  <div className="import-preview import-file-rows">
                    <ResultGrid
                      columns={summary.header.map((h) => ({ name: h, typeName: "", numeric: false }))}
                      rows={summary.rows.map((r) => r.map((v): Cell => (v === null ? { t: "null" } : { t: "text", value: v, truncated: false, totalBytes: v.length })))}
                      resetKey={summary}
                      label="First rows of the file"
                    />
                  </div>
                )}
              </div>
            )}

            {step === "columns" && summary && (
              <>
                {plan?.warnings.map((w, i) => <WarningBanner key={i}>{w}</WarningBanner>)}
                {reasons.length > 0 && (
                  <div className="import-banner import-banner-danger" role="alert">
                    <Icon name="error" />
                    <div>
                      {reasons.map((r) => (
                        <p key={r}>{r}</p>
                      ))}
                    </div>
                  </div>
                )}
                {check?.state === "running" && (
                  <div className="import-banner" role="status">
                    <p>Checking every row of the file...</p>
                  </div>
                )}
                {check?.state === "done" && (
                  <div className={check.report.failing === 0 ? "import-banner import-banner-ok" : "import-banner import-banner-danger"} role="status">
                    <Icon name={check.report.failing === 0 ? "check" : "warning"} />
                    <p>{checkBanner(check.report)}</p>
                  </div>
                )}
                <div className="import-mapping-wrap">
                  <div className="import-section-head">
                    <h3>Columns</h3>
                    <button type="button" className="button button-small" onClick={matchNow} disabled={!plan}>
                      Match by name <Kbd keys="Ctrl+M" />
                    </button>
                  </div>
                  <MappingTable header={summary.header} first={summary.rows[0] ?? []} mapping={shown} targets={plan?.columns ?? []} onChange={mapColumn} />
                </div>
                <div className="import-section-head">
                  <h3>Preview</h3>
                  <span className="field-help">The first {plan?.preview.length ?? 0} rows as they will be written.</span>
                </div>
                {visible && plan && (
                  <div className="import-preview">
                    <ResultGrid
                      columns={gridColumns}
                      rows={gridRows}
                      resetKey={plan}
                      label="Preview"
                      cellClass={(r, c) => (plan.preview[r]?.[c]?.problem ? "import-cell-problem" : undefined)}
                      cellTitle={(r, c) => plan.preview[r]?.[c]?.problem ?? undefined}
                    />
                  </div>
                )}
              </>
            )}

            {step === "statements" && script && (
              <>
                <p className="import-summary">{scriptSummary(script)}</p>
                {script.conturaBackup && (
                  <WarningBanner
                    action={
                      onOpenInRestore && (
                        <button type="button" className="button button-small" onClick={onOpenInRestore}>
                          Open in Restore
                        </button>
                      )
                    }
                  >
                    This file is a Contura Backup. Restore checks it against the database first.
                  </WarningBanner>
                )}
                {scriptReasons.length > 0 && (
                  <div className="import-banner import-banner-danger" role="alert">
                    <Icon name="error" />
                    <div>
                      {scriptReasons.map((r) => (
                        <p key={r}>{r}</p>
                      ))}
                    </div>
                  </div>
                )}
                <Switch
                  label="Run as is"
                  hint="Also runs GRANT, REVOKE, user and role statements, SET GLOBAL and SET PERSIST."
                  checked={runAsIs}
                  onChange={(on) => {
                    setRunAsIs(on);
                    void loadScript(path, on);
                  }}
                />
                <ScriptStatements statements={statements} total={script.statements} dialect={dialect} loading={paging} onMore={() => void moreStatements()} />
              </>
            )}
          </main>
        </div>
      )}

      {step !== "run" && (
        <footer className="import-foot">
          <div className="import-foot-text">
            {step === "columns" && plan && table && (
              <p>
                {footerText(
                  { table: qualifiedName(table), warnings: plan.warnings, oneTransaction: plan.oneTransaction },
                  options,
                  rows,
                  dialect,
                  exact,
                )}
              </p>
            )}
            {step === "statements" && script && scriptFooter(script, dialect, database).map((line) => <p key={line}>{line}</p>)}
          </div>
          {step === "columns" && (
            <button type="button" className="button" onClick={() => setSample({ back: false })} disabled={!plan}>
              Show sample INSERT
            </button>
          )}
          {step === "file" ? (
            <button
              type="button"
              className="button button-primary"
              disabled={!summary || sql}
              onClick={() => setStep("columns")}
            >
              Next
            </button>
          ) : (
            <>
              <button type="button" className="button" onClick={back}>
                Back <Kbd keys="Alt+Left" />
              </button>
              <button
                type="button"
                className={production ? "button button-prod" : "button button-primary"}
                disabled={!canRun}
                onClick={() => void onRun()}
              >
                {label} <Kbd keys="Ctrl+Enter" />
              </button>
            </>
          )}
        </footer>
      )}

      {confirm && (
        <ConfirmRun
          verb="Import"
          verdict={{ connection: confirm.connection, database: confirm.database }}
          job={confirm.job}
          warnings={confirm.warnings}
          dialect={dialect}
          group={group}
          onRun={() => void onConfirmed()}
          onCancel={() => setConfirming(false)}
        />
      )}
      {sample && plan && (
        <Dialog
          title="Sample INSERT"
          size="wide"
          onClose={() => {
            const reopen = sample.back;
            setSample(null);
            if (reopen) setConfirming(true);
          }}
        >
          <div className="dialog-body import-sample-body">
            <p>First statement, {rowsPhrase(sampleRows)}.</p>
            <div className="import-sample" tabIndex={0} data-autofocus aria-label="Sample INSERT, read-only">
              <SqlBlock sql={plan.sampleInsert} dialect={dialect} />
            </div>
          </div>
          <footer className="dialog-footer">
            <button
              type="button"
              className="button"
              onClick={() => {
                const reopen = sample.back;
                setSample(null);
                if (reopen) setConfirming(true);
              }}
            >
              Close
            </button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
