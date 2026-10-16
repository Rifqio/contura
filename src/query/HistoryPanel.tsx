import { useEffect, useId, useState } from "react";
import { errorText, queryHistory } from "../api/client";
import type { ConnectionId, HistoryEntry, HistoryFilter } from "../api/types";
import Icon from "../components/Icon";
import { formatMs } from "./ResultsPanel";

type Only = HistoryFilter["only"];

interface Props {
  connectionId: ConnectionId;
  connectionName: string;
  /** Bumped after a run, so the list shows it. */
  refreshKey: number;
  onInsert(sql: string): void;
  onOpenInNewTab(sql: string): void;
  onClose(): void;
}

const ONLY: { key: Only; label: string }[] = [
  { key: null, label: "All" },
  { key: "failed", label: "Failed" },
  { key: "changes", label: "Changes" },
];

const fmt = (n: number) => n.toLocaleString("en-US");

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-CA");
}

const timeOf = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

function what(e: HistoryEntry): string {
  switch (e.outcome) {
    case "ok":
      return e.changed ? `${fmt(e.rows ?? 0)} changed` : `${fmt(e.rows ?? 0)} row${e.rows === 1 ? "" : "s"}`;
    case "error":
      return "error";
    case "timedOut":
      return "timed out";
    case "cancelled":
      return "cancelled";
  }
}

/** The statements run on one Connection, newest first. Nothing here runs a query. */
export default function HistoryPanel({ connectionId, connectionName, refreshKey, onInsert, onOpenInNewTab, onClose }: Props) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<Only>(null);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let live = true;
    queryHistory(connectionId, { search: query || null, only })
      .then((e) => {
        if (!live) return;
        setEntries(e);
        setError(null);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [connectionId, query, only, refreshKey]);

  const filtered = query !== "" || only !== null;
  let lastDay = "";

  return (
    <aside className="history-panel" aria-label="Query History">
      <div className="history-head">
        <h3>Query History</h3>
        {entries && (
          <span className="muted history-count">
            {filtered ? `${fmt(entries.length)} found` : `${fmt(entries.length)} of 1,000 kept`}
          </span>
        )}
        <button type="button" className="icon-button" aria-label="Close Query History" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="history-search">
        <input
          id={`${id}-search`}
          type="search"
          className="input input-small"
          placeholder={`Search ${connectionName} history`}
          aria-label="Search history"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="history-chips" role="group" aria-label="Show">
          {ONLY.map((o) => (
            <button
              key={o.label}
              type="button"
              className="chip-button"
              aria-pressed={only === o.key}
              onClick={() => setOnly(o.key)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="error-text history-empty" role="alert">
          {error}
        </p>
      )}
      <ul className="history-list">
        {entries?.length === 0 && (
          <li className="history-empty muted">
            {query
              ? `Nothing in this Connection's history matches "${query}".`
              : "Statements you run on this Connection appear here."}
          </li>
        )}
        {entries?.map((e) => {
          const day = dayLabel(e.ranAtMs);
          const header = day !== lastDay;
          lastDay = day;
          const open = openId === e.id;
          const text = `${e.sql};\n`;
          return (
            <li key={e.id}>
              {header && <div className="history-day">{day}</div>}
              <div className={open ? "history-item history-item-open" : "history-item"}>
                <button
                  type="button"
                  className="history-entry"
                  aria-label={e.sql}
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : e.id)}
                >
                  <span className="history-sql">{e.sql}</span>
                  <span className="history-meta">
                    <span className={`result-dot ${e.outcome === "error" ? "result-dot-error" : e.outcome === "ok" ? "" : "result-dot-warn"}`} />
                    {timeOf(e.ranAtMs)}
                    <span>{formatMs(e.elapsedMs)}</span>
                    <span>{what(e)}</span>
                  </span>
                </button>
                {open && (
                  <div className="history-actions">
                    {e.error && <p className="error-text">{e.error}</p>}
                    <button type="button" className="button button-small" onClick={() => onInsert(text)}>
                      Insert into editor
                    </button>
                    <button type="button" className="button button-small" onClick={() => onOpenInNewTab(text)}>
                      Open in new tab
                    </button>
                    <button
                      type="button"
                      className="button button-small button-ghost"
                      onClick={() => void navigator.clipboard?.writeText(e.sql).catch(() => {})}
                    >
                      <Icon name="copy" />
                      Copy
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
