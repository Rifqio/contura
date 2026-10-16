import { useEffect, useState } from "react";
import InlineAsk from "../assistant/InlineAsk";
import { type AskContext, type AskSetup, tablesIn } from "../assistant/context";
import Icon from "../components/Icon";
import ResultGrid from "../components/ResultGrid";
import type { ResultItem, RunnerState } from "./runner";

export const formatMs = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`;

const fmt = (n: number) => n.toLocaleString("en-US");
const verbOf = (sql: string) => /^\s*(\w+)/.exec(sql.replace(/^(\s*(--[^\n]*|\/\*[\s\S]*?\*\/)\s*)+/, ""))?.[1]?.toUpperCase() ?? "";
const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"]);

interface Props {
  state: RunnerState;
  timeoutSecs: number | null;
  /** The line number of an offset in the editor text. */
  lineAt(offset: number): number;
  onSelect(index: number): void;
  onPin(id: number): void;
  onCloseUnpinned(): void;
  onFetchMore(id: number): void;
  onCancel(): void;
  onRunAgain(id: number): void;
  onGoTo(from: number, to: number): void;
  /** Ask AI on a failed query; without it, or with `errorAsk` off, the button is absent. */
  ask?: AskSetup;
}

function tabLabel(item: ResultItem): string {
  if (item.state.s === "affected") return verbOf(item.sql) || `Result ${item.id}`;
  return `Result ${item.id}`;
}

function dotClass(item: ResultItem): string {
  switch (item.state.s) {
    case "running":
      return "result-dot result-dot-running";
    case "error":
      return "result-dot result-dot-error";
    case "cancelled":
    case "timedOut":
      return "result-dot result-dot-warn";
    default:
      return "result-dot";
  }
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <span className="result-timer">{formatMs(Math.max(0, now - since))}</span>;
}

export default function ResultsPanel({
  state,
  timeoutSecs,
  lineAt,
  onSelect,
  onPin,
  onCloseUnpinned,
  onFetchMore,
  onCancel,
  onRunAgain,
  onGoTo,
  ask,
}: Props) {
  const [askOpen, setAskOpen] = useState(false);
  const item = state.items[state.active];
  useEffect(() => setAskOpen(false), [item?.id]);

  let body;
  let foot = null;
  if (!item) {
    body = (
      <div className="result-state">
        <h3>No results yet</h3>
        <p className="muted">
          Run the current statement with <kbd>Ctrl Enter</kbd>, a selection the same way, or every statement with{" "}
          <kbd>Ctrl Shift Enter</kbd>. Each statement gets its own result tab.
        </p>
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
              {timeoutSecs ? `Stops on its own after ${fmt(timeoutSecs)} s, the Connection's timeout.` : ""}
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
              Cancelled after {formatMs(st.ms)}
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
      case "timedOut":
        body = (
          <div className="result-state result-state-warn">
            <h3>
              <Icon name="warning" />
              Stopped after {fmt(st.secs)} s
            </h3>
            <p className="muted">
              The query ran longer than this Connection's timeout, so DB View cancelled it on the server. Raise the
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
        body = (
          <div className="result-state result-state-error" role="alert">
            <h3>
              <Icon name="error" />
              {st.message}
            </h3>
            <p className="muted">Statements after this one did not run.</p>
            <pre className="result-sql">{item.sql}</pre>
            <div className="result-actions">
              <button type="button" className="button" onClick={() => onGoTo(st.at, st.at)}>
                Go to line {line}
              </button>
              {ask?.errorAsk && (
                <button type="button" className="button" aria-expanded={askOpen} onClick={() => setAskOpen((o) => !o)}>
                  <Icon name="sparkle" />
                  Ask AI
                </button>
              )}
              <button
                type="button"
                className="button button-ghost"
                onClick={() => void navigator.clipboard?.writeText(st.message).catch(() => {})}
              >
                Copy error
              </button>
            </div>
            {ask?.errorAsk && askOpen && (
              <div className="ask-anchor">
                <InlineAsk
                  context={
                    {
                      kind: "error",
                      connection: ask.connection,
                      sql: item.sql,
                      lines: [lineAt(item.from), lineAt(item.to)],
                      error: st.message,
                      tables: tablesIn(item.sql, ask.schema),
                      label: "Failed query",
                    } satisfies AskContext
                  }
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
      case "affected":
        body = (
          <div className="result-state result-state-ok">
            <h3>
              <Icon name="check" />
              {verbOf(item.sql) || "Done"} {fmt(st.rows)} row{st.rows === 1 ? "" : "s"}
            </h3>
            <p className="muted">Finished in {formatMs(st.ms)}.</p>
            <pre className="result-sql">{item.sql}</pre>
          </div>
        );
        break;
      case "rows":
        body = (
          <ResultGrid
            columns={st.columns}
            rows={st.rows}
            resetKey={item.id}
            label={`Result ${item.id}`}
            onNearEnd={st.hasMore && st.open ? () => onFetchMore(item.id) : undefined}
          >
            {st.rows.length === 0 && <p className="state-panel muted">The query returned no rows.</p>}
          </ResultGrid>
        );
        foot = (
          <>
            <span>{st.hasMore ? `First ${fmt(st.rows.length)} rows` : `${fmt(st.rows.length)} row${st.rows.length === 1 ? "" : "s"}`}</span>
            <span>{formatMs(st.ms)}</span>
            {st.hasMore &&
              (st.open ? (
                <button type="button" className="button button-small button-ghost" onClick={() => onFetchMore(item.id)}>
                  Fetch next 1,000
                </button>
              ) : (
                <span>Run it again to fetch more</span>
              ))}
            <span className="spacer" />
            <span>{item.pinned ? "Pinned: running again keeps this result" : "Running again replaces this result"}</span>
          </>
        );
        break;
    }
  }

  const canPin = item && item.state.s !== "running";
  return (
    <section className="results" aria-label="Results">
      <div className="results-tabs">
        <div role="tablist" aria-label="Result tabs" className="results-tablist">
          {state.items.map((r, i) => (
            <button
              key={r.id}
              type="button"
              role="tab"
              aria-selected={i === state.active}
              className={i === state.active ? "result-tab result-tab-on" : "result-tab"}
              title={r.sql}
              onClick={() => onSelect(i)}
            >
              <span className={dotClass(r)} aria-hidden="true" />
              {tabLabel(r)}
              {r.pinned && <Icon name="pin" className="result-pin" />}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {canPin && (
          <button
            type="button"
            className={item.pinned ? "icon-button icon-button-on" : "icon-button"}
            aria-label={item.pinned ? "Unpin result" : "Pin result"}
            aria-pressed={item.pinned}
            title={item.pinned ? "Unpin result" : "Pin result"}
            onClick={() => onPin(item.id)}
          >
            <Icon name="pin" />
          </button>
        )}
        {state.items.length > 0 && (
          <button
            type="button"
            className="icon-button"
            aria-label="Close unpinned results"
            title="Close unpinned results"
            onClick={onCloseUnpinned}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="results-body">{body}</div>
      <div className="results-foot">{foot ?? <span>{item ? item.sql.split("\n")[0] : "Results"}</span>}</div>
    </section>
  );
}
