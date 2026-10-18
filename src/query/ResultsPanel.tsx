import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DialectKind } from "../api/types";
import InlineAsk from "../assistant/InlineAsk";
import { type AskContext, type AskSetup, tablesIn } from "../assistant/context";
import { hintFor } from "../commands/keymap";
import { useCommandKeys, useKeymap } from "../commands/useCommandKeys";
import type { ExportOrigin } from "../jobs/exportText";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { MenuList, type MenuItem } from "../components/Menu";
import { durationText } from "../format/units";
import ResultGrid from "../components/ResultGrid";
import PlanView from "./PlanView";
import QueryError from "./QueryError";
import ResultTools, { cellText } from "./ResultTools";
import type { ResultItem, RunnerState } from "./runner";

const fmt = (n: number) => n.toLocaleString("en-US");
const verbOf = (sql: string) => /^\s*(\w+)/.exec(sql.replace(/^(\s*(--[^\n]*|\/\*[\s\S]*?\*\/)\s*)+/, ""))?.[1]?.toUpperCase() ?? "";
const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"]);

interface Props {
  state: RunnerState;
  /** A Production Connection: the pane carries the wash. */
  production?: boolean;
  timeoutSecs: number | null;
  /** The line number of an offset in the editor text. */
  lineAt(offset: number): number;
  /** The column of an offset in the editor text, from 1. */
  columnAt?(offset: number): number;
  dialect?: DialectKind;
  connectionName?: string;
  /** Table and column names in the loaded tree, for the error's "Did you mean". */
  names?: string[];
  /** Table names alone, for a missing table. */
  tableNames?: string[];
  /** Where a missing table was looked for, such as "shop.public". */
  scope?: string | null;
  /** Run the failed statement and those after it again, once the Connection is back. */
  onReconnect?(): void;
  onCopy?(text: string): void;
  onSelect(index: number): void;
  onPin(id: number): void;
  /** Closes one result (its tab's close button, Delete, or its right-click menu). */
  onClose?(id: number): void;
  onCloseUnpinned(): void;
  onFetchMore(id: number): void;
  onCancel(): void;
  onRunAgain(id: number): void;
  onGoTo(from: number, to: number): void;
  /** Ask AI on a failed query; without it, or with `errorAsk` off, the button is absent. */
  ask?: AskSetup;
  /** One more action in a failed statement's error box. */
  errorAction?: ReactNode;
  /** The session's database, for a result export. */
  database?: string | null;
  /** Opens the Export dialog on the shown result (the menu's Export..., and Ctrl+E here). No Import here (Q16). */
  onExport?(origin: ExportOrigin): void;
}

/** After a reconnect ran statement N alone (R43): "Statements 3 and 4 did not run." */
function notRunText(index: number, count: number): string {
  const nums = Array.from({ length: count }, (_, i) => index + 1 + i);
  if (nums.length === 1) return `Statement ${nums[0]} did not run.`;
  return `Statements ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]} did not run.`;
}

function tabLabel(item: ResultItem): string {
  const st = item.state;
  if (st.s === "plan") return "Plan";
  if (st.s === "error") return st.index === undefined ? "Plan" : `Statement ${st.index}`;
  if (st.s === "affected") return verbOf(item.sql) || `Result ${item.id}`;
  return `Result ${item.id}`;
}

/** A result tab carries no status mark (E5); a running one shows the spinner and a failed one a danger icon. */
function StateMark({ item }: { item: ResultItem }) {
  if (item.state.s === "running") return <span className="spinner spinner-small" aria-hidden="true" />;
  if (item.state.s === "error") return <Icon name="error" size={14} className="result-tab-danger" />;
  return null;
}

/** A result tab's right-click menu at a point, kept inside the window. */
function TabMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.height === 0) return;
    setAt({ x: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)) });
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return (
    <div ref={ref} className="tree-menu" style={{ left: at.x, top: at.y }}>
      <MenuList items={items} label="Result" onClose={onClose} compact />
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <span className="result-timer">{durationText(Math.max(0, now - since))}</span>;
}

export default function ResultsPanel({
  state,
  production = false,
  timeoutSecs,
  lineAt,
  columnAt,
  dialect = "postgres",
  connectionName,
  names = [],
  tableNames,
  scope = null,
  onReconnect,
  onCopy,
  onSelect,
  onPin,
  onClose,
  onCloseUnpinned,
  onFetchMore,
  onCancel,
  onRunAgain,
  onGoTo,
  ask,
  errorAction,
  database = null,
  onExport,
}: Props) {
  const { map } = useKeymap();
  const runKey = hintFor(map, "query.run");
  const [askOpen, setAskOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const tabRefs = useRef(new Map<number, HTMLButtonElement>());
  const item = state.items[state.active];
  const [filter, setFilter] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [range, setRange] = useState<{ first: number; last: number } | null>(null);
  useEffect(() => {
    setAskOpen(false);
    setFilter("");
    setHidden(new Set());
    setRange(null);
  }, [item?.id]);
  const rowsState = item?.state.s === "rows" ? item.state : null;
  const needle = filter.trim().toLowerCase();
  const filteredRows = useMemo(
    () => (rowsState && needle ? rowsState.rows.filter((r) => r.some((c) => cellText(c).toLowerCase().includes(needle))) : rowsState?.rows ?? []),
    [rowsState?.rows, needle],
  );
  const sectionRef = useRef<HTMLElement>(null);
  // The statement as it ran, its session's database, and every row this result holds.
  const resultOrigin = (): ExportOrigin | null =>
    item && rowsState
      ? {
          kind: "result",
          database,
          sql: item.sql,
          columns: rowsState.columns,
          rows: rowsState.rows,
          hidden: rowsState.columns.filter((c) => hidden.has(c.name)).map((c) => c.name),
        }
      : null;
  const exportResult = onExport
    ? () => {
        const origin = resultOrigin();
        if (origin) onExport(origin);
      }
    : undefined;
  useCommandKeys(exportResult && rowsState ? { "export.open": exportResult } : {}, { region: sectionRef });
  const copyText = (text: string) => (onCopy ?? ((t: string) => void navigator.clipboard?.writeText(t).catch(() => {})))(text);

  let body;
  let foot = null;
  let summary = null;
  if (!item) {
    body = (
      <div className="result-state result-empty">
        <Icon name="play" size={20} />
        <h3>Run a query to see results</h3>
        <p className="muted">Results and row counts appear here.</p>
        <Kbd keys={runKey ?? "Ctrl+Enter"} />
      </div>
    );
  } else {
    const st = item.state;
    switch (st.s) {
      case "running":
        body = (
          <div className="result-state">
            <h3>
              <span className="spinner" aria-hidden="true" />
              Running <Elapsed since={item.startedAt} />
            </h3>
            <pre className="result-sql">{item.sql}</pre>
            <p className="muted">
              {state.queue.length > 0 &&
                `${fmt(state.queue.length)} more statement${state.queue.length > 1 ? "s" : ""} waiting. `}
              {timeoutSecs ? `Stops on its own after ${fmt(timeoutSecs)}s, the Connection's timeout.` : ""}
            </p>
            <div className="result-actions">
              <button type="button" className="button button-danger-fill" onClick={onCancel}>
                <Icon name="stop" />
                Cancel
              </button>
            </div>
          </div>
        );
        break;
      case "cancelled":
        body = (
          <div className="result-state result-state-warn">
            <h3>
              <Icon name="warning" />
              Cancelled after {durationText(st.ms)}
            </h3>
            <p className="muted">
              {WRITES.has(verbOf(item.sql))
                ? "The server rolled the statement back. No rows changed."
                : "The server stopped the query."}
            </p>
            <pre className="result-sql">{item.sql}</pre>
            <div className="result-actions">
              <button type="button" className="button" onClick={() => onRunAgain(item.id)}>
                Run again
              </button>
            </div>
          </div>
        );
        break;
      case "stopped":
        body = (
          <div className="result-state result-state-warn">
            <h3>
              <Icon name="warning" />
              Stopped after {durationText(st.ms)}
            </h3>
            <p className="muted">{st.why}</p>
            <pre className="result-sql">{item.sql}</pre>
            <div className="result-actions">
              <button type="button" className="button" onClick={() => onRunAgain(item.id)}>
                Run again
              </button>
            </div>
          </div>
        );
        break;
      case "timedOut":
        body = (
          <div className="result-state result-state-warn">
            <h3>
              <Icon name="warning" />
              Stopped after {fmt(st.secs)}s
            </h3>
            <p className="muted">
              The query ran longer than this Connection's timeout, so Contura cancelled it on the server. Raise the
              timeout in the Connection's settings if this query needs longer.
            </p>
            <pre className="result-sql">{item.sql}</pre>
            <div className="result-actions">
              <button type="button" className="button" onClick={() => onRunAgain(item.id)}>
                Run again
              </button>
            </div>
          </div>
        );
        break;
      case "error": {
        const line = lineAt(st.at);
        const ctx =
          ask?.errorAsk &&
          ({
            kind: "error",
            connection: ask.connection,
            sql: item.sql,
            lines: [lineAt(item.from), lineAt(item.to)],
            error: st.message,
            tables: tablesIn(item.sql, ask.schema),
            label: "Failed query",
          } satisfies AskContext);
        if (st.index === undefined) {
          // An Explain that failed: no statement number, just what went wrong.
          body = (
            <div className="result-state result-state-error" role="alert">
              <h3>
                <Icon name="error" />
                {st.message}
              </h3>
              <pre className="result-sql">{item.sql}</pre>
            </div>
          );
          break;
        }
        const earlier = state.items.find((r) => r.state.s !== "plan" && r.index === st.index! - 1);
        // Frame 2: "1 of 3 statements ran in 38ms", over this run's statements up to the failed one.
        const at = state.items.indexOf(item);
        let spent = st.ms ?? 0;
        for (let j = at - 1, want = st.index - 1; j >= 0 && want >= 1; j--, want--) {
          const prev = state.items[j];
          if (prev.index !== want) break;
          if ("ms" in prev.state) spent += prev.state.ms ?? 0;
        }
        const total = st.index + (st.notRun?.length ?? 0);
        summary = (
          <span className="results-summary">
            {total === 1 ? `Failed after ${durationText(spent)}` : `${st.index - 1} of ${total} statements ran in ${durationText(spent)}`}
          </span>
        );
        body = (
          <div className="query-error-wrap">
            <QueryError
              statementIndex={st.index}
              line={line}
              column={columnAt?.(st.at) ?? 1}
              dialect={dialect}
              message={st.message}
              own={st.own}
              note={
                st.refused
                  ? "This Connection opens every session read-only. The statement did not change anything, and statements after it did not run."
                  : undefined
              }
              notRun={st.notRun ?? []}
              names={names}
              tableNames={tableNames}
              scope={scope}
              lineOf={lineAt}
              lost={!!st.lost}
              connectionName={connectionName}
              earlierResult={earlier?.id ?? null}
              onGoTo={() => onGoTo(st.at, st.at)}
              onAsk={ctx ? () => setAskOpen((o) => !o) : undefined}
              onCopy={copyText}
              onReconnect={() => onReconnect?.()}
              extraAction={errorAction}
            />
            {ctx && askOpen && (
              <div className="ask-anchor">
                <InlineAsk
                  context={ctx}
                  schema={ask.schema}
                  groupId={ask.groupId}
                  onOpenInChat={ask.onOpenInChat}
                  onOpenSettings={ask.onOpenSettings}
                  onClose={() => setAskOpen(false)}
                />
              </div>
            )}
          </div>
        );
        break;
      }
      case "plan":
        body = <PlanView plan={st.plan} />;
        summary = <span className="results-summary">Plan in {durationText(st.ms)}</span>;
        foot = <span>Explain asks the server for the plan. The statement does not run.</span>;
        break;
      case "affected":
        body = (
          <div className="result-state result-state-ok">
            <h3>
              <Icon name="check" />
              {verbOf(item.sql) || "Done"} {fmt(st.rows)} row{st.rows === 1 ? "" : "s"}
            </h3>
            <p className="muted">Finished in {durationText(st.ms)}.</p>
            <pre className="result-sql">{item.sql}</pre>
          </div>
        );
        break;
      case "rows": {
        const keep = st.columns.map((c, i) => (hidden.has(c.name) ? -1 : i)).filter((i) => i >= 0);
        const columns = keep.length === st.columns.length ? st.columns : keep.map((i) => st.columns[i]);
        const gridRows = keep.length === st.columns.length ? filteredRows : filteredRows.map((r) => keep.map((i) => r[i]));
        body = (
          <ResultGrid
            columns={columns}
            rows={gridRows}
            resetKey={item.id}
            label={`Result ${item.id}`}
            onRange={(first, last) => setRange({ first, last })}
            onNearEnd={st.hasMore && st.open ? () => onFetchMore(item.id) : undefined}
          >
            {st.rows.length === 0 && <p className="state-panel muted">The query returned no rows.</p>}
            {st.rows.length > 0 && filteredRows.length === 0 && <p className="state-panel muted">No loaded row matches the filter.</p>}
          </ResultGrid>
        );
        // R15: rows and time stay in the result toolbar; the window status bar has the Connection and position.
        summary = (
          <span className="results-summary">
            {st.hasMore ? `First ${fmt(st.rows.length)} rows` : `${fmt(st.rows.length)} row${st.rows.length === 1 ? "" : "s"}`} in{" "}
            {durationText(st.ms)}
          </span>
        );
        const total = filteredRows.length;
        const last = range ? Math.min(total, range.last) : total;
        const first = range ? Math.min(range.first, last) : total === 0 ? 0 : 1;
        foot = (
          <>
            <span className="results-range">
              {first} to {last} of {fmt(total)}
              {st.hasMore && !needle ? "+" : ""}
            </span>
            {st.hasMore &&
              (st.open ? (
                <button type="button" className="button button-small button-ghost" onClick={() => onFetchMore(item.id)}>
                  Fetch next 1,000
                </button>
              ) : (
                <span>Run it again to fetch more</span>
              ))}
            <span className="spacer" />
            <span>
              {production
                ? "Saving runs on Production and asks you to confirm the SQL first."
                : item.pinned
                  ? "Pinned: running again keeps this result"
                  : "Running again replaces this result"}
            </span>
          </>
        );
        break;
      }
    }
  }

  const closeOne = (id: number) => (onClose ? onClose(id) : undefined);
  const menuItems = (r: ResultItem): MenuItem[] => {
    const running = r.state.s === "running";
    return [
      { key: "pin", label: r.pinned ? "Unpin result" : "Pin result", disabled: running, onSelect: () => onPin(r.id) },
      ...(onClose ? [{ key: "close", label: "Close", shortcut: "Delete", disabled: running, onSelect: () => closeOne(r.id) }] : []),
      { key: "closeUnpinned", label: "Close unpinned results", onSelect: onCloseUnpinned },
    ];
  };
  const closeMenu = () => {
    const id = tabMenu?.id;
    setTabMenu(null);
    if (id !== undefined) tabRefs.current.get(id)?.focus();
  };
  const menuItem = tabMenu ? state.items.find((r) => r.id === tabMenu.id) : undefined;
  return (
    <section ref={sectionRef} className={production ? "results prod-wash" : "results"} aria-label="Results">
      {item && (
        <div className="results-tabs">
          {/* PR28: Pin and Close live on the result tab: close on hover, Pin in its right-click menu. */}
          <div role="tablist" aria-label="Result tabs" className="results-tablist">
            {state.items.map((r, i) => {
              const running = r.state.s === "running";
              const label = tabLabel(r);
              return (
                <div
                  key={r.id}
                  className={i === state.active ? "result-tab result-tab-on" : "result-tab"}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTabMenu({ id: r.id, x: e.clientX, y: e.clientY });
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={i === state.active}
                    aria-label={r.pinned ? `${label}, pinned` : undefined}
                    aria-keyshortcuts={running || !onClose ? "Shift+F10" : "Delete Shift+F10"}
                    className="result-tab-button"
                    title={r.sql}
                    ref={(el) => {
                      if (el) tabRefs.current.set(r.id, el);
                      else tabRefs.current.delete(r.id);
                    }}
                    onClick={() => onSelect(i)}
                    onKeyDown={(e) => {
                      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                        e.preventDefault();
                        const box = e.currentTarget.getBoundingClientRect();
                        setTabMenu({ id: r.id, x: box.left, y: box.bottom });
                      } else if (e.key === "Delete" && onClose && !running) {
                        e.preventDefault();
                        closeOne(r.id);
                      }
                    }}
                  >
                    <StateMark item={r} />
                    {label}
                    {r.pinned && <Icon name="pin" size={14} className="result-pin" />}
                  </button>
                  {onClose && !running && (
                    <button
                      type="button"
                      className="icon-button result-tab-close"
                      // Pointer only: Delete and the tab's menu give the same close to keyboards and screen readers.
                      aria-hidden="true"
                      tabIndex={-1}
                      aria-label={`Close ${label}`}
                      title={`Close ${label}`}
                      onClick={() => closeOne(r.id)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {summary}
          <span className="spacer" />
          {rowsState && (
            <ResultTools
              columns={rowsState.columns}
              rows={filteredRows}
              filter={filter}
              onFilter={setFilter}
              hidden={hidden}
              onToggleColumn={(name) =>
                setHidden((h) => {
                  const next = new Set(h);
                  if (!next.delete(name)) next.add(name);
                  return next;
                })
              }
              connectionName={connectionName}
              onExport={exportResult}
            />
          )}
        </div>
      )}
      {tabMenu && menuItem && <TabMenu x={tabMenu.x} y={tabMenu.y} items={menuItems(menuItem)} onClose={closeMenu} />}
      <div className="results-body">{body}</div>
      {/* Frame 2: a failed statement has no footer; the error already names it. */}
      {item && !(item.state.s === "error" && item.state.index !== undefined) && (
        <div className="results-foot">
          {item.after && item.after.length > 0 && item.index !== undefined && item.state.s !== "running" && (
            <span className="results-notrun">{notRunText(item.index, item.after.length)}</span>
          )}
          {foot ?? <span>{item.sql.split("\n")[0]}</span>}
        </div>
      )}
    </section>
  );
}
