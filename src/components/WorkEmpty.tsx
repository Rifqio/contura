import { useEffect } from "react";
import type { ConnectionConfig } from "../api/types";
import { hintFor } from "../commands/keymap";
import { useKeymap } from "../commands/useCommandKeys";
import Icon from "./Icon";
import Kbd from "./Kbd";

interface Props {
  /** The Connection used last: a new query opens on it, and Enter opens it while none is open. Null when there is none. */
  lastConnection: ConnectionConfig | null;
  /** Some Connection of the place is open. */
  anyOpen: boolean;
  onNewQuery(): void;
  onOpen(connection: ConnectionConfig): void;
}

/** What the work area shows with no tab open: one icon, a title, one line and one action (frame 1). */
export default function WorkEmpty({ lastConnection, anyOpen, onNewQuery, onOpen }: Props) {
  const { map } = useKeymap();
  const newQueryKey = hintFor(map, "query.new");
  const filterKey = hintFor(map, "tree.filter");
  const newConnectionKey = hintFor(map, "connection.new");
  const opening = !anyOpen && lastConnection ? lastConnection : null;

  // Enter opens the Connection used last, only while nothing else has the keys.
  useEffect(() => {
    if (!opening) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      e.preventDefault();
      onOpen(opening);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opening, onOpen]);

  return (
    <div className="work-empty">
      <div className="work-empty-box">
        <Icon name={anyOpen ? "fileQuery" : "plug"} size={20} />
        <h3>{anyOpen ? "No tab open" : "No Connection open"}</h3>
        <p>
          {anyOpen
            ? `Pick a table in the tree to see its rows, or start a new query.${lastConnection ? ` It opens on ${lastConnection.name}, the Connection you used last.` : ""}`
            : "Open a Connection in the tree to browse its tables and run queries."}
        </p>
        {anyOpen ? (
          <button type="button" className="button button-primary" onClick={onNewQuery}>
            <Icon name="plus" size={14} />
            New query {newQueryKey && <Kbd keys={newQueryKey} />}
          </button>
        ) : (
          opening && (
            <button type="button" className="button button-primary" onClick={() => onOpen(opening)}>
              <Icon name="plug" size={14} />
              Open {opening.name} <Kbd keys="Enter" />
            </button>
          )
        )}
        <div className="work-empty-hints">
          {filterKey && (
            <span>
              <Kbd keys={filterKey} />
              Filter the tree
            </span>
          )}
          {newConnectionKey && (
            <span>
              <Kbd keys={newConnectionKey} />
              New Connection
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
