import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { deleteSavedQuery, errorText, savedQueryRuns } from "../api/client";
import type { ConnectionConfig, DialectKind, SavedQuery, SavedQueryRun } from "../api/types";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import SafetyTag from "../components/SafetyTag";
import SqlBlock from "../components/SqlBlock";
import { agoShort, durationText } from "../format/units";
import SaveQueryDialog from "./SaveQueryDialog";

interface Props {
  queries: SavedQuery[];
  /** Every Connection, since a Saved Query can open on one outside the place. */
  connections: ConnectionConfig[];
  onOpen(q: SavedQuery): void;
  /** A Saved Query was renamed or deleted: reload the list. */
  onChanged(): void;
  /** False while the tab is hidden: the list stays mounted, and reads "Last run" again when shown. */
  visible?: boolean;
}

const savedDay = (ms: number) => {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
};
const rowsText = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;
const agoText = (ranAtMs: number) => {
  const ago = agoShort(Date.now() - ranAtMs, new Date());
  return ago === "now" ? "just now" : `${ago} ago`;
};

/** A Visual Query's Dialect, from its model, for the preview's colours when its Connection is gone. */
function modelDialect(q: SavedQuery): DialectKind | null {
  if (q.kind !== "visual" || !q.visualJson) return null;
  try {
    const d = (JSON.parse(q.visualJson) as { dialect?: unknown }).dialect;
    return d === "mysql" || d === "postgres" || d === "sqlite" ? d : null;
  } catch {
    return null;
  }
}

/** The Saved Queries tab: every Saved Query, the Connection it opens on, when it last ran, and a preview (frame 4). */
export default function SavedQueriesList({ queries, connections, onOpen, onChanged, visible = true }: Props) {
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [runs, setRuns] = useState<SavedQueryRun[]>([]);
  const [renaming, setRenaming] = useState<SavedQuery | null>(null);
  const [deleting, setDeleting] = useState<SavedQuery | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    savedQueryRuns()
      .then((r) => live && setRuns(r))
      .catch(() => live && setRuns([]));
    return () => {
      live = false;
    };
  }, [queries, visible]);

  // R12: the newest run of any outcome counts; a query that never ran has none.
  const lastRun = useMemo(() => {
    const newest = new Map<string, SavedQueryRun>();
    for (const r of runs) {
      const seen = newest.get(r.savedId);
      if (!seen || r.ranAtMs > seen.ranAtMs) newest.set(r.savedId, r);
    }
    return newest;
  }, [runs]);

  const shown = useMemo(() => {
    const wanted = filter.trim().toLowerCase();
    return wanted ? queries.filter((q) => q.name.toLowerCase().includes(wanted)) : queries;
  }, [queries, filter]);
  const selected = shown.find((q) => q.id === picked) ?? shown[0] ?? null;
  const connectionOf = (q: SavedQuery) => connections.find((c) => c.id === q.connectionId) ?? null;
  /** A Visual Query always has a Connection, so none means it was removed (D2). */
  const noConnection = (q: SavedQuery) => (q.kind === "visual" ? "Connection removed" : "No Connection");

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!selected) return;
    const at = shown.indexOf(selected);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = shown[Math.max(0, Math.min(shown.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
      setPicked(next.id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      onOpen(selected);
    } else if (e.key === "F2") {
      e.preventDefault();
      setRenaming(selected);
    } else if (e.key === "Delete") {
      e.preventDefault();
      setDeleting(selected);
    }
  }

  function preview(q: SavedQuery) {
    const c = connectionOf(q);
    const run = lastRun.get(q.id);
    const opensOn = c ? `${c.name}${c.database ? ` · ${c.database}` : ""}` : noConnection(q);
    const runText = run
      ? `${agoText(run.ranAtMs)}${run.rows === null ? "" : `, ${rowsText(run.rows)}`} in ${durationText(run.elapsedMs)}`
      : "Not run yet";
    return (
      <section className="saved-preview" aria-label={q.name}>
        <h4>{q.name}</h4>
        <dl className="saved-facts">
          <dt>Opens on</dt>
          <dd>{opensOn}</dd>
          <dt>Last run</dt>
          <dd>{runText}</dd>
          <dt>Saved</dt>
          <dd>{savedDay(q.updatedAtMs)}</dd>
        </dl>
        <SqlBlock sql={q.sql} dialect={c?.dialect ?? modelDialect(q) ?? "postgres"} className="saved-sql" ariaLabel={`SQL of ${q.name}`} />
        <div className="saved-actions">
          <button type="button" className="button button-primary" onClick={() => onOpen(q)}>
            <Icon name="external" size={14} />
            Open <Kbd keys="Enter" />
          </button>
          <button type="button" className="button" onClick={() => setRenaming(q)}>
            <Icon name="edit" size={14} />
            Rename <Kbd keys="F2" />
          </button>
          <span className="spacer" />
          <button type="button" className="button button-quiet saved-delete" onClick={() => setDeleting(q)}>
            <Icon name="trash" size={14} />
            Delete
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="saved-list">
      <header className="saved-head">
        <h2>Saved Queries</h2>
        <span className="saved-count">
          {queries.length} {queries.length === 1 ? "query" : "queries"}, kept for every Connection
        </span>
        <span className="spacer" />
        <input
          className="input input-small saved-filter"
          type="text"
          aria-label="Filter Saved Queries"
          placeholder="Filter Saved Queries"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </header>
      {queries.length === 0 ? (
        <div className="saved-empty">
          <p>No Saved Queries yet. Press Ctrl+S in a query tab to keep one here.</p>
        </div>
      ) : (
        <div className="saved-body">
          {/* The focus stop for the list keys; the preview and the dialogs sit outside it. */}
          <div className="saved-table" tabIndex={0} onKeyDown={onKeyDown} aria-label="Saved Queries list">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Opens on</th>
                  <th scope="col" className="saved-right">
                    Last run
                  </th>
                  <th scope="col" className="saved-right">
                    Saved
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((q) => {
                  const c = connectionOf(q);
                  const run = lastRun.get(q.id);
                  return (
                    <tr
                      key={q.id}
                      className={q.id === selected?.id ? "saved-row saved-row-on" : "saved-row"}
                      aria-selected={q.id === selected?.id}
                      onClick={() => setPicked(q.id)}
                      onDoubleClick={() => onOpen(q)}
                    >
                      <td>
                        <span className="saved-cell">
                          <Icon name={q.kind === "visual" ? "visualQuery" : "fileQuery"} size={14} />
                          {q.name}
                        </span>
                      </td>
                      <td>
                        <span className="saved-cell">
                          {c ? (
                            <>
                              <DbMark dialect={c.dialect} open size={14} label={null} />
                              {c.name}
                              <SafetyTag connection={c} small />
                            </>
                          ) : (
                            noConnection(q)
                          )}
                        </span>
                      </td>
                      <td className="saved-right saved-quiet">{run ? agoText(run.ranAtMs) : "Not run yet"}</td>
                      <td className="saved-right saved-quiet">{savedDay(q.updatedAtMs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 && <p className="saved-none">No Saved Query matches "{filter.trim()}".</p>}
          </div>
          {selected ? preview(selected) : <div className="saved-preview" />}
        </div>
      )}
      {renaming && (
        <SaveQueryDialog
          sql={renaming.sql}
          existing={renaming}
          onCancel={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null);
            onChanged();
          }}
        />
      )}
      {deleting && (
        <Dialog
          title="Delete Saved Query"
          size="confirm"
          onClose={() => {
            setDeleting(null);
            setDeleteError(null);
          }}
        >
          <div className="dialog-body">
            <p>Delete the Saved Query "{deleting.name}"?</p>
            {deleteError && (
              <p className="error-text" role="alert">
                {deleteError}
              </p>
            )}
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button
              type="button"
              className="button"
              data-autofocus
              onClick={() => {
                setDeleting(null);
                setDeleteError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger-fill"
              onClick={() => {
                const q = deleting;
                deleteSavedQuery(q.id)
                  .then(() => {
                    setDeleting(null);
                    setDeleteError(null);
                    onChanged();
                  })
                  .catch((e) => setDeleteError(errorText(e)));
              }}
            >
              Delete
            </button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
