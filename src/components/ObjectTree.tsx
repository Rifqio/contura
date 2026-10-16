import { useEffect, useState } from "react";
import { errorText, isNotOpen, listDatabases, listObjects, listSchemas } from "../api/client";
import type { ConnectionId, DbObject, DialectKind, ObjectKind, ObjectPath, SchemaInfo } from "../api/types";
import Icon, { type IconName } from "./Icon";

interface Props {
  connectionId: ConnectionId;
  /** PostgreSQL adds a schema level between a database and its objects. */
  dialect: DialectKind;
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

/** Where objects live: a database, or a schema in one. NUL cannot occur in a name. */
function scopeKey(database: string, schema: string | null): string {
  return schema === null ? database : `${database}\u0000${schema}`;
}

function sameObject(a: ObjectPath, b: ObjectPath) {
  return a.database === b.database && a.schema === b.schema && a.name === b.name;
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="tree-note" role="alert">
      <p className="error-text">{message}</p>
      <button type="button" className="button button-small" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export default function ObjectTree({ connectionId, dialect, defaultDatabase, selected, onSelect, onNotOpen }: Props) {
  const hasSchemas = dialect === "postgres";
  const [databases, setDatabases] = useState<Load<string[]>>({ s: "loading" });
  const [schemas, setSchemas] = useState<Record<string, Load<SchemaInfo[]>>>({});
  const [objects, setObjects] = useState<Record<string, Load<DbObject[]>>>({});
  const [openDatabases, setOpenDatabases] = useState<ReadonlySet<string>>(new Set());
  const [openSchemas, setOpenSchemas] = useState<ReadonlySet<string>>(new Set());
  const [showSystem, setShowSystem] = useState(false);
  const [attempt, setAttempt] = useState(0);

  function fail(e: unknown): string {
    if (isNotOpen(e)) onNotOpen();
    return errorText(e, dialect);
  }

  function loadObjects(database: string, schema: string | null) {
    const key = scopeKey(database, schema);
    setObjects((all) => ({ ...all, [key]: { s: "loading" } }));
    listObjects(connectionId, database, schema)
      .then((value) => setObjects((all) => ({ ...all, [key]: { s: "loaded", value } })))
      .catch((e) => setObjects((all) => ({ ...all, [key]: { s: "failed", message: fail(e) } })));
  }

  /** `openPublic` also expands the `public` schema when the database has one. */
  function loadSchemas(database: string, openPublic = false) {
    setSchemas((all) => ({ ...all, [database]: { s: "loading" } }));
    listSchemas(connectionId, database)
      .then((value) => {
        setSchemas((all) => ({ ...all, [database]: { s: "loaded", value } }));
        if (openPublic && value.some((s) => s.name === "public")) {
          setOpenSchemas((keys) => new Set(keys).add(scopeKey(database, "public")));
          loadObjects(database, "public");
        }
      })
      .catch((e) => setSchemas((all) => ({ ...all, [database]: { s: "failed", message: fail(e) } })));
  }

  useEffect(() => {
    let live = true;
    setDatabases({ s: "loading" });
    listDatabases(connectionId)
      .then((value) => {
        if (!live) return;
        setDatabases({ s: "loaded", value });
        if (defaultDatabase && value.includes(defaultDatabase)) {
          setOpenDatabases(new Set([defaultDatabase]));
          if (hasSchemas) loadSchemas(defaultDatabase, true);
          else loadObjects(defaultDatabase, null);
        }
      })
      .catch((e) => live && setDatabases({ s: "failed", message: fail(e) }));
    return () => {
      live = false;
    };
    // Reload only when the Connection changes or the user retries.
  }, [connectionId, attempt]);

  function toggleDatabase(database: string) {
    const next = new Set(openDatabases);
    if (next.has(database)) {
      next.delete(database);
    } else {
      next.add(database);
      if (hasSchemas) {
        if (!schemas[database] || schemas[database].s === "failed") loadSchemas(database);
      } else {
        const load = objects[scopeKey(database, null)];
        if (!load || load.s === "failed") loadObjects(database, null);
      }
    }
    setOpenDatabases(next);
  }

  function toggleSchema(database: string, schema: string) {
    const key = scopeKey(database, schema);
    const next = new Set(openSchemas);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
      if (!objects[key] || objects[key].s === "failed") loadObjects(database, schema);
    }
    setOpenSchemas(next);
  }

  function objectsView(database: string, schema: string | null) {
    const load = objects[scopeKey(database, schema)];
    const where = schema === null ? database : `${database}.${schema}`;
    if (!load || load.s === "loading") return <p className="tree-note">Loading objects…</p>;
    if (load.s === "failed") return <Failed message={load.message} onRetry={() => loadObjects(database, schema)} />;
    if (load.value.length === 0)
      return <p className="tree-note">{schema ?? database} has no tables, views or routines.</p>;
    return SECTIONS.map((section) => {
      const items = load.value.filter((o) => o.kind === section.kind);
      if (items.length === 0) return null;
      return (
        <div key={section.kind} className="tree-section">
          <h3 className="tree-section-label">
            {section.label}
            <span className="tree-count">{items.length}</span>
          </h3>
          <ul aria-label={`${section.label} in ${where}`}>
            {items.map((o) => {
              const path: ObjectPath = { database, schema, name: o.name };
              const isSelected = selected !== null && selected.kind === o.kind && sameObject(selected.path, path);
              return (
                <li key={o.name}>
                  <button
                    type="button"
                    className={isSelected ? "tree-row tree-row-selected" : "tree-row"}
                    aria-current={isSelected ? "true" : undefined}
                    title={o.name}
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
    });
  }

  function schemasView(database: string) {
    const load = schemas[database];
    if (!load || load.s === "loading") return <p className="tree-note">Loading schemas…</p>;
    if (load.s === "failed") return <Failed message={load.message} onRetry={() => loadSchemas(database)} />;
    const visible = load.value.filter((s) => showSystem || !s.isSystem);
    if (visible.length === 0) {
      const hidden = load.value.length > 0;
      return (
        <p className="tree-note">
          No schemas you can use in {database}.{hidden ? " Show system schemas to see the rest." : ""}
        </p>
      );
    }
    return (
      <ul aria-label={`Schemas in ${database}`}>
        {visible.map((s) => {
          const isOpen = openSchemas.has(scopeKey(database, s.name));
          return (
            <li key={s.name}>
              <button
                type="button"
                className="tree-row"
                aria-expanded={isOpen}
                onClick={() => toggleSchema(database, s.name)}
              >
                <Icon name={isOpen ? "chevronDown" : "chevronRight"} className="tree-chevron" />
                <Icon name="schema" />
                <span className="tree-name">{s.name}</span>
              </button>
              {isOpen && <div className="tree-children">{objectsView(database, s.name)}</div>}
            </li>
          );
        })}
      </ul>
    );
  }

  if (databases.s === "loading") return <p className="tree-note">Loading databases…</p>;
  if (databases.s === "failed") return <Failed message={databases.message} onRetry={() => setAttempt((n) => n + 1)} />;
  if (databases.value.length === 0)
    return <p className="tree-note">This user cannot see any databases on this server.</p>;

  return (
    <>
      {hasSchemas && (
        <div className="tree-toggle">
          <label className="checkbox">
            <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
            Show system schemas
          </label>
        </div>
      )}
      <ul className="tree" aria-label="Databases">
        {databases.value.map((db) => {
          const isOpen = openDatabases.has(db);
          return (
            <li key={db}>
              <button type="button" className="tree-row" aria-expanded={isOpen} onClick={() => toggleDatabase(db)}>
                <Icon name={isOpen ? "chevronDown" : "chevronRight"} className="tree-chevron" />
                <Icon name="database" />
                <span className="tree-name">{db}</span>
              </button>
              {isOpen && (
                <div className="tree-children">{hasSchemas ? schemasView(db) : objectsView(db, null)}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
