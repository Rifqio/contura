import { useEffect, useId, useState } from "react";
import { clearQueryHistory, errorText, queryHistory } from "../api/client";
import type { ConnectionConfig, HistoryEntry, HistoryFilter } from "../api/types";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import Menu from "../components/Menu";
import Segmented from "../components/Segmented";
import SqlBlock from "../components/SqlBlock";
import { durationText } from "../format/units";

type Only = HistoryFilter["only"];
type Scope = "all" | "connection";

interface Props {
  /** Every Connection, to name each statement's Connection and pick its database mark. */
  connections: ConnectionConfig[];
  /** The Connection of the tab beside the panel; null leaves only the All scope. */
  scopeConnection: ConnectionConfig | null;
  /** Which scope the panel opens on; Home's "Show all history" asks for All. */
  initialScope?: Scope;
  /** Bumped after a run, so the list shows it. */
  refreshKey: number;
  onInsert(sql: string): void;
  /** Runs the statement in the tab beside the panel, through that tab's own runner. */
  onRun(sql: string): void;
  onClose(): void;
}

const fmt = (n: number) => n.toLocaleString("en-US");

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function dayLabel(ms: number, now = new Date()): string {
  const d = new Date(ms);
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return "Yesterday";
  return now.getTime() - ms < 7 * 86_400_000 ? "Earlier this week" : "Earlier";
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

const dateOf = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The time on a row: the clock for today and yesterday, the date for older days. */
function rowTime(ms: number): string {
  const label = dayLabel(ms);
  return label === "Today" || label === "Yesterday" ? clock(ms) : dateOf(ms);
}

/** The preview's time: "Today 10:42", "Oct 14 10:42". */
function whenText(ms: number): string {
  const label = dayLabel(ms);
  return label === "Today" || label === "Yesterday" ? `${label} ${clock(ms)}` : `${dateOf(ms)} ${clock(ms)}`;
}

/** The right side of line 2: `6 rows, 112ms`, `1,284 rows changed, 212ms`, `Failed`. */
function resultText(e: HistoryEntry): string {
  const time = durationText(e.elapsedMs);
  switch (e.outcome) {
    case "error":
      return "Failed";
    case "timedOut":
      return `Timed out, ${time}`;
    case "cancelled":
      return `Cancelled, ${time}`;
    case "ok": {
      const n = e.rows ?? 0;
      return `${fmt(n)} row${n === 1 ? "" : "s"}${e.changed ? " changed" : ""}, ${time}`;
    }
  }
}

const firstLine = (sql: string) => sql.trimStart().split("\n")[0].trimEnd();

/** The statements run on a Connection, or on all of them, newest first. Nothing here runs a query itself. */
export default function HistoryPanel({
  connections,
  scopeConnection,
  initialScope,
  refreshKey,
  onInsert,
  onRun,
  onClose,
}: Props) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<Only>(null);
  const [scopeChoice, setScope] = useState<Scope>(initialScope ?? (scopeConnection ? "connection" : "all"));
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  const [reloads, setReloads] = useState(0);

  const scope: Scope = scopeConnection ? scopeChoice : "all";
  const scopeId = scope === "connection" ? scopeConnection!.id : null;

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let live = true;
    queryHistory(scopeId, { search: query || null, only })
      .then((e) => {
        if (!live) return;
        setEntries(e);
        setError(null);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [scopeId, query, only, refreshKey, reloads]);

  const selected = entries?.find((e) => e.id === selectedId) ?? null;
  const connectionOf = (e: HistoryEntry) => connections.find((c) => c.id === e.connectionId) ?? null;
  const nameOf = (e: HistoryEntry) => connectionOf(e)?.name ?? "Deleted Connection";
  const dialectOf = (e: HistoryEntry) => connectionOf(e)?.dialect ?? scopeConnection?.dialect ?? "postgres";

  async function clear() {
    setAsking(false);
    try {
      await clearQueryHistory(scopeId);
      setSelectedId(null);
      setReloads((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    }
  }

  let lastDay = "";
  const sections: { day: string; items: HistoryEntry[] }[] = [];
  for (const e of entries ?? []) {
    const day = dayLabel(e.ranAtMs);
    if (day !== lastDay) sections.push({ day, items: [] });
    lastDay = day;
    sections[sections.length - 1].items.push(e);
  }

  const runsHere = selected !== null && scopeConnection !== null && selected.connectionId === scopeConnection.id;

  return (
    <aside className="history-panel" aria-label="Query History" data-pane>
      <div className="history-head">
        <h3>Query History</h3>
        <Menu
          label="History options"
          align="end"
          trigger={(p) => (
            <button type="button" className="icon-button" aria-label="History options" {...p}>
              <Icon name="moreHorizontal" />
            </button>
          )}
          items={[
            {
              key: "failed",
              label: "Failed only",
              checked: only === "failed",
              onSelect: () => setOnly(only === "failed" ? null : "failed"),
            },
            {
              key: "changes",
              label: "Changes only",
              checked: only === "changes",
              onSelect: () => setOnly(only === "changes" ? null : "changes"),
            },
            {
              key: "clear",
              label: "Clear Query History...",
              icon: <Icon name="trash" size={14} />,
              danger: true,
              separatorBefore: true,
              onSelect: () => setAsking(true),
            },
          ]}
        />
        <button type="button" className="icon-button" aria-label="Close Query History" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="history-filter">
        <label className="history-search">
          <Icon name="search" size={14} />
          <input
            id={`${id}-search`}
            type="search"
            className="history-search-input"
            placeholder="Filter history"
            aria-label="Filter history"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Segmented<Scope>
          label="Scope"
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "All" },
            ...(scopeConnection ? [{ value: "connection" as const, label: scopeConnection.name }] : []),
          ]}
        />
      </div>
      {error && (
        <p className="error-text history-empty" role="alert">
          {error}
        </p>
      )}
      <div className="history-list">
        {entries?.length === 0 && (
          <p className="history-empty">
            {query || only
              ? query
                ? `Nothing in the history matches "${query}".`
                : "Nothing in the history matches."
              : scope === "all"
                ? "Statements you run appear here."
                : `Statements you run on ${scopeConnection!.name} appear here.`}
          </p>
        )}
        {sections.map(({ day, items }) => (
          <section key={day} className="history-section" aria-label={day}>
            <div className="history-day">{day}</div>
            {items.map((e) => {
              const failed = e.outcome === "error";
              const c = connectionOf(e);
              return (
                <button
                  key={e.id}
                  type="button"
                  className={e.id === selectedId ? "history-row history-row-selected" : "history-row"}
                  aria-pressed={e.id === selectedId}
                  onClick={() => setSelectedId(e.id === selectedId ? null : e.id)}
                >
                  <span className={failed ? "history-row-icon history-row-failed" : "history-row-icon"}>
                    <Icon name={failed ? "alert" : "fileQuery"} />
                  </span>
                  <span className="history-row-sql">{firstLine(e.sql)}</span>
                  <span className="history-row-time">{rowTime(e.ranAtMs)}</span>
                  <span className="history-row-meta">
                    <DbMark dialect={dialectOf(e)} open={!!c} size={14} label={null} />
                    <span className="history-row-name">{nameOf(e)}</span>
                    {c?.production && <span className="history-prod">PROD</span>}
                    <span className={failed ? "history-row-result history-row-failed" : "history-row-result"}>
                      {resultText(e)}
                    </span>
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
      {selected && (
        <section className="history-preview" aria-label="Selected statement">
          <div className="history-preview-head">
            <DbMark dialect={dialectOf(selected)} open={!!connectionOf(selected)} size={14} label={null} />
            <span className="history-row-name">{nameOf(selected)}</span>
            {connectionOf(selected)?.production && <span className="history-prod">PROD</span>}
            <span className="history-preview-when">{`· ${whenText(selected.ranAtMs)}`}</span>
          </div>
          <SqlBlock sql={selected.sql} dialect={dialectOf(selected)} ariaLabel="Statement" />
          {selected.error && <p className="error-text history-preview-error">{selected.error}</p>}
          <div className="history-preview-actions">
            <button
              type="button"
              className="button button-small"
              onClick={() => onInsert(`${selected.sql.trimEnd().replace(/;$/, "")};\n`)}
            >
              <Icon name="format" size={14} />
              Insert into the editor
            </button>
            <button
              type="button"
              className="button button-small"
              disabled={!runsHere}
              title={
                runsHere || !scopeConnection
                  ? undefined
                  : `This tab is on ${scopeConnection.name}. Open a tab on ${nameOf(selected)} to run it.`
              }
              onClick={() => onRun(selected.sql)}
            >
              <Icon name="play" size={14} />
              Run
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="icon-button"
              aria-label="Copy"
              title="Copy"
              onClick={() => void navigator.clipboard?.writeText(selected.sql).catch(() => {})}
            >
              <Icon name="copy" size={14} />
            </button>
          </div>
        </section>
      )}
      {asking && (
        <Dialog title="Clear Query History" size="confirm" onClose={() => setAsking(false)}>
          <div className="dialog-body">
            <p>
              {scope === "all"
                ? "Clear the Query History of every Connection? Saved Queries are kept."
                : `Clear the Query History of ${scopeConnection!.name}? Saved Queries are kept.`}
            </p>
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" data-autofocus onClick={() => setAsking(false)}>
              Keep it
            </button>
            <button type="button" className="button button-danger-fill" onClick={() => void clear()}>
              Clear
            </button>
          </footer>
        </Dialog>
      )}
    </aside>
  );
}
