import { useEffect, useState } from "react";
import { DIALECT_LABEL } from "../api/client";
import type { DialectKind, TransferCopy, TransferMode } from "../api/types";
import Icon, { type IconName } from "../components/Icon";

/** One table of the plan, in load order. */
export type RunTable = Pick<TransferCopy, "table" | "rowsHint">;

/** The latest progress event of the job (one stream for the whole transfer). */
export interface RunProgress {
  /** The table being copied; null before the first table (the structure phase). */
  table: string | null;
  /** Rows copied of `table`. */
  rowsDone: number;
  /** Rows of `table` counted when it started; null when unknown. */
  rowsTotal: number | null;
  /** Tables finished. */
  statementsDone: number;
  /** Rows copied in the whole run. */
  allDone?: number;
  /** Rows of the whole run; null or missing when unknown. */
  allTotal?: number | null;
}

/** How the job ended. */
export type RunOutcome =
  | { kind: "finished"; rowsWritten: number; elapsedMs: number }
  /** `message` is the Core's text with the outcome line; `hint` says what to do next. */
  | { kind: "failed"; message: string; hint: string | null }
  /** `message` is the Core's warning, when it sent one. */
  | { kind: "cancelled"; message: string | null; hint: string | null };

export interface StepRunProps {
  /** The plan's copies in load order. */
  tables: RunTable[];
  /** The target's name, such as "pinecone-analytics". */
  target: string;
  targetDialect: DialectKind;
  mode: TransferMode;
  /** Such as "6 tables, 1 type, 9 indexes created."; empty when nothing is created (rows only). */
  structure: string;
  /** When the job started (epoch ms). */
  startedAt: number;
  progress: RunProgress | null;
  /** null while the job runs. */
  outcome: RunOutcome | null;
  /** The run compared the row counts at the end. */
  countsCompared: boolean;
  onOpenTarget(): void;
  /** The source's name: the running hint says how it is read. */
  source?: string;
  /** A fixed clock for tests; without it the elapsed time ticks every second. */
  now?: number;
}

type RowState = "done" | "copying" | "waiting" | "failed" | "rolledBack" | "notStarted";

const STATE: Record<RowState, { label: string; icon: IconName; tone: string }> = {
  done: { label: "Done", icon: "check", tone: "ok" },
  copying: { label: "Copying", icon: "refresh", tone: "run" },
  waiting: { label: "Waiting", icon: "history", tone: "wait" },
  failed: { label: "Failed", icon: "error", tone: "bad" },
  rolledBack: { label: "Rolled back", icon: "undo", tone: "back" },
  notStarted: { label: "Not started", icon: "history", tone: "wait" },
};

const n = (v: number) => v.toLocaleString("en-US");

/** Compact time: "0.4s" with `fine` under 10 seconds, else "38s", "1m 44s", "2h 5m". */
export function runTime(ms: number, fine = false): string {
  if (fine && ms < 9950) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) {
    const rest = secs % 60;
    return rest === 0 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 60)}m ${rest}s`;
  }
  const mins = Math.floor((secs % 3600) / 60);
  return mins === 0 ? `${Math.floor(secs / 3600)}h` : `${Math.floor(secs / 3600)}h ${mins}m`;
}

const tablesText = (count: number) => (count === 1 ? "1 table" : `${n(count)} tables`);

interface Seen {
  /** Rows of the table counted by the Core. */
  total?: number | null;
  rows?: number;
  start?: number;
  end?: number;
}

/** Step 5 (frame 8.1 Run): the overall progress, one row per table, and how the run ended. */
export default function StepRun(props: StepRunProps) {
  const { tables, target, targetDialect, mode, structure, startedAt, progress, outcome, countsCompared, onOpenTarget } = props;
  const [clock, setClock] = useState(() => Date.now());
  const fixed = props.now;
  const now = fixed ?? clock;
  const running = outcome === null;

  useEffect(() => {
    if (!running || fixed !== undefined) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, fixed]);

  // What each table showed while it ran: its counted rows and when it started and ended.
  const [seen, setSeen] = useState<Record<string, Seen>>({});
  const at = progress ? tables.findIndex((t) => t.table === progress.table) : -1;
  const current = progress === null ? -1 : at >= 0 ? at : progress.table === null ? -1 : progress.statementsDone;
  useEffect(() => {
    const t = fixed ?? Date.now();
    setSeen((prev) => {
      const next = { ...prev };
      tables.forEach((tab, i) => {
        const s = next[tab.table] ?? {};
        if (i < current && s.start !== undefined && s.end === undefined) next[tab.table] = { ...s, end: t };
      });
      if (progress && current >= 0 && current < tables.length) {
        const name = tables[current]!.table;
        const s = next[name] ?? {};
        next[name] = {
          ...s,
          start: s.start ?? t,
          rows: progress.rowsDone,
          total: progress.rowsTotal ?? s.total,
          end: outcome && s.end === undefined ? t : s.end,
        };
      }
      return next;
    });
    // `tables` is the plan's list and does not change during a run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, progress?.rowsDone, progress?.rowsTotal, outcome]);

  const ok = outcome?.kind === "finished";
  const stopped = outcome !== null && !ok;
  const rollsBack = mode === "oneTransaction";

  const rows = tables.map((tab, i) => {
    const s = seen[tab.table] ?? {};
    const isCurrent = i === current;
    const total = (isCurrent ? (progress?.rowsTotal ?? s.total) : s.total) ?? tab.rowsHint;
    let state: RowState;
    if (ok || i < current) state = ok ? "done" : stopped && rollsBack ? "rolledBack" : "done";
    else if (isCurrent) state = stopped ? (outcome.kind === "failed" ? "failed" : "rolledBack") : "copying";
    else state = stopped ? "notStarted" : "waiting";
    const finished = ok || i < current;
    const done = finished ? (total ?? s.rows ?? 0) : isCurrent ? (progress?.rowsDone ?? 0) : 0;
    const shown = finished ? (total ?? done) : total;
    const end = s.end ?? (isCurrent && running ? now : undefined);
    const time = s.start !== undefined && end !== undefined ? runTime(end - s.start, true) : "";
    const percent = shown ? Math.min(100, Math.round((done / shown) * 100)) : finished ? 100 : 0;
    return { name: tab.table, state, done, total: shown, time, percent };
  });

  // The Core's whole-run counts when it sends them; else the sum of the tables.
  const all = progress?.allTotal != null && progress.allTotal > 0 ? { done: progress.allDone ?? 0, total: progress.allTotal } : null;
  const doneRows = ok ? outcome.rowsWritten : all ? all.done : rows.reduce((sum, r) => sum + r.done, 0);
  const known = rows.every((r) => r.total !== null);
  const totalRows = all ? Math.max(all.total, doneRows) : known ? rows.reduce((sum, r) => sum + (r.total ?? 0), 0) : null;
  const overall = ok ? 100 : totalRows ? Math.min(100, Math.round((doneRows / totalRows) * 100)) : 0;
  const elapsed = Math.max(0, now - startedAt);
  const left = running && totalRows !== null && doneRows > 0 ? (elapsed * (totalRows - doneRows)) / doneRows : null;

  let title: string;
  if (ok) title = `Copied ${tablesText(tables.length)}, ${n(outcome.rowsWritten)} rows in ${runTime(outcome.elapsedMs, true)}.${countsCompared ? " Row counts match." : ""}`;
  else if (outcome?.kind === "failed") title = rollsBack ? "Transfer stopped, nothing was written" : "Transfer stopped";
  else if (outcome?.kind === "cancelled") title = "Transfer cancelled";
  else title = `Copying ${tablesText(tables.length)} to ${target}`;

  const timeLine = ok ? null : running ? (left !== null ? `${runTime(elapsed)} elapsed, about ${runTime(left)} left` : `${runTime(elapsed)} elapsed`) : runTime(elapsed);

  const base = structure.trim().replace(/\.$/, "");
  const keys =
    targetDialect === "postgres"
      ? "Foreign Keys are added after the rows."
      : targetDialect === "sqlite"
        ? "Foreign Keys are created with the tables and checked after the rows."
        : "Foreign Keys are created with the tables.";
  const structureLine = base
    ? `Structure: ${base}${stopped && rollsBack && current >= 0 ? ", then rolled back" : ""}. ${keys}`
    : "Structure: none, rows go into tables that exist.";

  const reading = props.source ? ` Reading ${props.source} takes no locks beyond one consistent snapshot.` : "";
  const hint = running
    ? (rollsBack
        ? `${DIALECT_LABEL[targetDialect]} target: everything runs in one transaction. Cancel rolls it all back.`
        : "MySQL creates tables one by one and they stay if a later step fails. Each table's rows are copied in its own transaction.") + reading
    : stopped
      ? outcome.hint
      : null;

  const message = stopped ? outcome.message : null;

  return (
    <div className="transfer-run">
      <section className="transfer-box transfer-run-head" aria-label="Run">
        <div className="transfer-run-line">
          <span className="transfer-sect">{title}</span>
          <span className="transfer-sp" />
          {timeLine && <span className="transfer-run-time">{timeLine}</span>}
          {ok && (
            <button type="button" className="button button-primary" onClick={onOpenTarget}>
              Open in the target tree
            </button>
          )}
        </div>
        <div
          className={`transfer-pb transfer-pb-big${outcome?.kind === "failed" ? " bad" : ok ? " ok" : ""}`}
          role="progressbar"
          aria-label="Transfer progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={overall}
        >
          <b style={{ width: `${overall}%` }} />
        </div>
        <div className="transfer-run-line transfer-run-sub">
          <span>{totalRows !== null ? `${n(doneRows)} of ${n(totalRows)} rows` : `${n(doneRows)} rows`}</span>
          <span className="transfer-sp" />
          <span>{structureLine}</span>
        </div>
      </section>
      {message && outcome?.kind === "failed" && (
        <div className="transfer-ban transfer-ban-bad" role="alert">
          <Icon name="alert" size={14} />
          <span>
            <ErrorText text={message} />
          </span>
          <button type="button" className="button button-small" onClick={() => void navigator.clipboard?.writeText(message)}>
            <Icon name="copy" size={14} />
            Copy error
          </button>
        </div>
      )}
      {message && outcome?.kind === "cancelled" && (
        <div className="transfer-ban transfer-ban-warn" role="status">
          <Icon name="warning" size={14} />
          <span>{message}</span>
        </div>
      )}
      <div className="transfer-box transfer-run-list">
        <table className="transfer-lt" aria-label="Tables">
          <thead>
            <tr>
              <th className="w0" aria-label="State icon" />
              <th>Table</th>
              <th className="transfer-run-pcol">Progress</th>
              <th className="r">Rows</th>
              <th className="r">Time</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = STATE[r.state];
              return (
                <tr key={r.name} data-table={r.name} className={r.state === "failed" ? "err" : undefined}>
                  <td className={`transfer-run-ic ${st.tone}`}>
                    <Icon name={st.icon} size={14} />
                  </td>
                  <td className="m">{r.name}</td>
                  <td>
                    <div className={`transfer-pb${r.state === "done" ? " ok" : r.state === "failed" ? " bad" : ""}`}>
                      <b style={{ width: `${r.percent}%` }} />
                    </div>
                  </td>
                  <td className="r">{r.total !== null ? `${n(r.done)} of ${n(r.total)}` : n(r.done)}</td>
                  <td className="r">{r.time}</td>
                  <td className={`transfer-run-state ${st.tone}`}>{st.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hint && <p className="transfer-hint">{hint}</p>}
    </div>
  );
}

/** The Core's message with its position ("sales_lines, row 2,114,903:") in bold, as on the design. */
function ErrorText({ text }: { text: string }) {
  const cut = text.indexOf(": ");
  if (cut < 0 || cut > 80 || !/, row [\d,]+/.test(text.slice(0, cut))) return <>{text}</>;
  return (
    <>
      <b>{text.slice(0, cut + 1)}</b>
      {text.slice(cut + 1)}
    </>
  );
}
