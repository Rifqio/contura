import { useEffect, useState } from "react";
import { errorText, isNotOpen, listDatabases, listObjects } from "../api/client";
import type { ConnectionId, DbObject, ObjectKind, ObjectPath } from "../api/types";
import Icon, { type IconName } from "./Icon";

interface Props {
  connectionId: ConnectionId;
  /** Expanded when the databases first load. */
  defaultDatabase: string | null;
  selected: { path: ObjectPath; kind: ObjectKind } | null;
  onSelect: (kind: ObjectKind, path: ObjectPath) => void;
  /** The session is gone (for example the Connection was saved while opening). */
  onNotOpen: () => void;
}

type Load<T> = { s: "loading" } | { s: "loaded"; value: T } | { s: "failed"; message: string };

const SECTIONS: { kind: ObjectKind; label: string; icon: IconName }[] = [
  { kind: "table", label: "Tables", icon: "table" },
  { kind: "view", label: "Views", icon: "view" },
  { kind: "procedure", label: "Procedures", icon: "routine" },
  { kind: "function", label: "Functions", icon: "routine" },
  { kind: "trigger", label: "Triggers", icon: "trigger" },
];

function sameObject(a: ObjectPath, b: ObjectPath) {
  return a.database === b.database && a.schema === b.schema && a.name === b.name;
}

export default function ObjectTree({ connectionId, defaultDatabase, selected, onSelect, onNotOpen }: Props) {
  const [databases, setDatabases] = useState<Load<string[]>>({ s: "loading" });
  const [objects, setObjects] = useState<Record<string, Load<DbObject[]>>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);

  function fail(e: unknown): string {
    if (isNotOpen(e)) onNotOpen();
    return errorText(e);
  }

  function loadObjects(database: string) {
    setObjects((all) => ({ ...all, [database]: { s: "loading" } }));
    listObjects(connectionId, database, null)
      .then((value) => setObjects((all) => ({ ...all, [database]: { s: "loaded", value } })))
      .catch((e) => setObjects((all) => ({ ...all, [database]: { s: "failed", message: fail(e) } })));
  }

  useEffect(() => {
    let live = true;
    setDatabases({ s: "loading" });
    listDatabases(connectionId)
      .then((value) => {
        if (!live) return;
        setDatabases({ s: "loaded", value });
        if (defaultDatabase && value.includes(defaultDatabase)) {
          setExpanded(new Set([defaultDatabase]));
          loadObjects(defaultDatabase);
        }
      })
      .catch((e) => live && setDatabases({ s: "failed", message: fail(e) }));
    return () => {
      live = false;
    };
    // Reload only when the Connection changes or the user retries.
  }, [connectionId, attempt]);

  function toggle(database: string) {
    const next = new Set(expanded);
    if (next.has(database)) {
      next.delete(database);
    } else {
      next.add(database);
      if (!objects[database] || objects[database].s === "failed") loadObjects(database);
    }
    setExpanded(next);
  }

  if (databases.s === "loading") return <p className="tree-note">Loading databases…</p>;
  if (databases.s === "failed")
    return (
      <div className="tree-note" role="alert">
        <p className="error-text">{databases.message}</p>
        <button type="button" className="button button-small" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  if (databases.value.length === 0)
    return <p className="tree-note">This user cannot see any databases on this server.</p>;

  return (
    <ul className="tree" aria-label="Databases">
      {databases.value.map((db) => {
        const isOpen = expanded.has(db);
        const load = objects[db];
        return (
          <li key={db}>
            <button type="button" className="tree-row" aria-expanded={isOpen} onClick={() => toggle(db)}>
              <Icon name={isOpen ? "chevronDown" : "chevronRight"} className="tree-chevron" />
              <Icon name="database" />
              <span className="tree-name">{db}</span>
            </button>
            {isOpen && (
              <div className="tree-children">
                {(!load || load.s === "loading") && <p className="tree-note">Loading objects…</p>}
                {load?.s === "failed" && (
                  <div className="tree-note" role="alert">
                    <p className="error-text">{load.message}</p>
                    <button type="button" className="button button-small" onClick={() => loadObjects(db)}>
                      Try again
                    </button>
                  </div>
                )}
                {load?.s === "loaded" && load.value.length === 0 && (
                  <p className="tree-note">{db} has no tables, views or routines.</p>
                )}
                {load?.s === "loaded" &&
                  SECTIONS.map((section) => {
                    const items = load.value.filter((o) => o.kind === section.kind);
                    if (items.length === 0) return null;
                    return (
                      <div key={section.kind} className="tree-section">
                        <h3 className="tree-section-label">
                          {section.label}
                          <span className="tree-count">{items.length}</span>
                        </h3>
                        <ul aria-label={`${section.label} in ${db}`}>
                          {items.map((o) => {
                            const path: ObjectPath = { database: db, schema: null, name: o.name };
                            const isSelected =
                              selected !== null && selected.kind === o.kind && sameObject(selected.path, path);
                            return (
                              <li key={o.name}>
                                <button
                                  type="button"
                                  className={isSelected ? "tree-row tree-row-selected" : "tree-row"}
                                  aria-current={isSelected ? "true" : undefined}
                                  onClick={() => onSelect(o.kind, path)}
                                >
                                  <Icon name={section.icon} />
                                  <span className="tree-name">{o.name}</span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
