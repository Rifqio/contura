import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useState } from "react";
import { DIALECT_LABEL, errorText, listDatabases, listSchemas, readModelFiles, reverseEngineer } from "../api/client";
import type { ConnectionConfig, DialectKind } from "../api/types";
import Dialog from "../components/Dialog";
import { parseDbml } from "../lang/dbml/parse";
import { autoLayout, EMPTY_LAYOUT, parseLayout } from "./layout";
import type { ModelDoc } from "./SchemaBuilder";

const DIALECTS: DialectKind[] = ["mysql", "postgres", "sqlite"];
const ID_TYPE: Record<DialectKind, string> = { mysql: "int", postgres: "integer", sqlite: "INTEGER" };

export function blankModel(dialect: DialectKind): string {
  return `// Dialect: ${DIALECT_LABEL[dialect]}\n\nTable new_table {\n  id ${ID_TYPE[dialect]} [pk, increment]\n}\n`;
}

/** The Dialect named by a `// Dialect: …` header line, if any. */
export function dialectFromHeader(dbml: string): DialectKind | null {
  const m = /^\/\/ Dialect: (MySQL|PostgreSQL|SQLite)\s*$/m.exec(dbml);
  return m ? (DIALECTS.find((d) => DIALECT_LABEL[d] === m[1]) ?? null) : null;
}

interface Props {
  connections: ConnectionConfig[];
  openIds: ReadonlySet<string>;
  /** Pre-selects "From a Connection", e.g. when started from the object tree. */
  initial?: { connectionId: string; database: string; schema: string | null };
  onStart: (doc: ModelDoc) => void;
  onCancel: () => void;
}

export default function StartModel({ connections, openIds, initial, onStart, onCancel }: Props) {
  const id = useId();
  const [dialect, setDialect] = useState<DialectKind>("mysql");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknownDialect, setUnknownDialect] = useState<{ path: string; dbml: string; layout: string | null } | null>(null);
  const [fileDialect, setFileDialect] = useState<DialectKind>("mysql");
  const open_ = connections.filter((c) => openIds.has(c.id) && c.dialect !== undefined);
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? "");
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [schema, setSchema] = useState(initial?.schema ?? "");
  const connection = open_.find((c) => c.id === connectionId);

  useEffect(() => {
    if (!connectionId) return;
    setDatabases(null);
    listDatabases(connectionId)
      .then(setDatabases)
      .catch((e) => setError(errorText(e, connection?.dialect)));
  }, [connectionId]);

  useEffect(() => {
    if (!connection || connection.dialect !== "postgres" || !database) return;
    setSchemas(null);
    listSchemas(connection.id, database)
      .then((s) => {
        const user = s.filter((x) => !x.isSystem).map((x) => x.name);
        setSchemas(user);
        if (!schema) setSchema(user.includes("public") ? "public" : (user[0] ?? ""));
      })
      .catch((e) => setError(errorText(e, connection.dialect)));
  }, [connectionId, database]);

  function startFile(path: string, dbml: string, layout: string | null, d: DialectKind) {
    onStart({ path, dbml, savedDbml: dbml, layout: layout ? parseLayout(layout) : EMPTY_LAYOUT, dialect: d, source: "file" });
  }

  async function openFile() {
    setError(null);
    const path = await open({ multiple: false, directory: false, filters: [{ name: "DBML", extensions: ["dbml"] }] });
    if (typeof path !== "string") return;
    try {
      const files = await readModelFiles(path);
      const d = dialectFromHeader(files.dbml);
      if (d) startFile(path, files.dbml, files.layout, d);
      else setUnknownDialect({ path, ...files });
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function fromConnection() {
    if (!connection || !database) return;
    setBusy(true);
    setError(null);
    try {
      const s = connection.dialect === "postgres" ? schema || null : null;
      const dbml = await reverseEngineer(connection.id, database, s);
      const model = parseDbml(dbml, connection.dialect).model;
      const layout = model ? await autoLayout(model, EMPTY_LAYOUT) : EMPTY_LAYOUT;
      onStart({ path: null, dbml, savedDbml: "", layout, dialect: connection.dialect, source: "connection" });
    } catch (e) {
      setError(errorText(e, connection.dialect));
    } finally {
      setBusy(false);
    }
  }

  const f = (x: string) => `${id}-${x}`;

  return (
    <Dialog title="New Schema Model" onClose={onCancel} wide>
      <div className="dialog-body start-model">
        <section aria-labelledby={f("blank")}>
          <h3 id={f("blank")} className="section-label">
            Blank model
          </h3>
          <label className="field" htmlFor={f("dialect")}>
            <span>Dialect</span>
            <select id={f("dialect")} className="input" value={dialect} onChange={(e) => setDialect(e.target.value as DialectKind)}>
              {DIALECTS.map((d) => (
                <option key={d} value={d}>
                  {DIALECT_LABEL[d]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button button-primary"
            onClick={() =>
              onStart({ path: null, dbml: blankModel(dialect), savedDbml: "", layout: EMPTY_LAYOUT, dialect, source: "blank" })
            }
          >
            Start blank
          </button>
        </section>

        <section aria-labelledby={f("file")}>
          <h3 id={f("file")} className="section-label">
            Open a .dbml file
          </h3>
          <button type="button" className="button" onClick={() => void openFile()}>
            Open file…
          </button>
          {unknownDialect && (
            <div className="start-model-ask">
              <p>This file doesn't say which Dialect it targets. Choose one.</p>
              <label className="field" htmlFor={f("file-dialect")}>
                <span>Dialect of the file</span>
                <select
                  id={f("file-dialect")}
                  className="input"
                  value={fileDialect}
                  onChange={(e) => setFileDialect(e.target.value as DialectKind)}
                >
                  {DIALECTS.map((d) => (
                    <option key={d} value={d}>
                      {DIALECT_LABEL[d]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button"
                onClick={() => startFile(unknownDialect.path, unknownDialect.dbml, unknownDialect.layout, fileDialect)}
              >
                Continue
              </button>
            </div>
          )}
        </section>

        <section aria-labelledby={f("conn")}>
          <h3 id={f("conn")} className="section-label">
            From a Connection
          </h3>
          {open_.length === 0 ? (
            <p className="muted">Open a Connection to read its schema.</p>
          ) : (
            <>
              <label className="field" htmlFor={f("connection")}>
                <span>Connection</span>
                <select
                  id={f("connection")}
                  className="input"
                  value={connectionId}
                  onChange={(e) => {
                    setConnectionId(e.target.value);
                    setDatabase("");
                    setSchema("");
                  }}
                >
                  <option value="">Choose a Connection</option>
                  {open_.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {connectionId && databases === null && <p className="muted">Loading databases…</p>}
              {databases && (
                <label className="field" htmlFor={f("database")}>
                  <span>Database</span>
                  <select id={f("database")} className="input" value={database} onChange={(e) => setDatabase(e.target.value)}>
                    <option value="">Choose a database</option>
                    {databases.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {connection?.dialect === "postgres" && database && schemas && (
                <label className="field" htmlFor={f("schema")}>
                  <span>Schema</span>
                  <select id={f("schema")} className="input" value={schema} onChange={(e) => setSchema(e.target.value)}>
                    {schemas.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="muted">DB View only reads the database. Nothing is changed.</p>
              <button
                type="button"
                className="button"
                disabled={!database || busy || (connection?.dialect === "postgres" && !schema)}
                onClick={() => void fromConnection()}
              >
                {busy ? "Reading…" : "Read the database"}
              </button>
            </>
          )}
        </section>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="dialog-footer">
        <span className="spacer" />
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </footer>
    </Dialog>
  );
}
