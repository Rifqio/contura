import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  DIALECT_LABEL,
  errorText,
  listDatabases,
  listObjects,
  listSchemas,
  readModelFiles,
  recentItems,
  reverseEngineer,
} from "../api/client";
import type { ConnectionConfig, DialectKind, RecentItem } from "../api/types";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import Icon, { type IconName } from "../components/Icon";
import Kbd from "../components/Kbd";
import SafetyTag from "../components/SafetyTag";
import Segmented from "../components/Segmented";
import Select from "../components/Select";
import Switch from "../components/Switch";
import { recentTime } from "../home/recent";
import { parseDbml } from "../lang/dbml/parse";
import { autoLayout, EMPTY_LAYOUT, parseLayout } from "./layout";
import type { ModelDoc } from "./SchemaBuilder";

const DIALECTS: DialectKind[] = ["mysql", "postgres", "sqlite"];
const ID_TYPE: Record<DialectKind, string> = { mysql: "int", postgres: "integer", sqlite: "INTEGER" };
const SYSTEM_DATABASES = new Set(["information_schema", "performance_schema", "mysql", "sys", "pg_catalog", "template0", "template1"]);
const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

type Way = "connection" | "blank" | "file";
const WAYS: { way: Way; icon: IconName; title: string; text: string }[] = [
  { way: "connection", icon: "database", title: "From a Connection", text: "Read the tables of a database" },
  { way: "blank", icon: "plus", title: "Blank model", text: "Start empty in one Dialect" },
  { way: "file", icon: "fileQuery", title: "Open a .dbml file", text: "Pick up a saved model" },
];
const HINT: Record<Way, string> = {
  connection: "Only reads the database. Nothing is changed.",
  blank: "You can change the Dialect later in the model.",
  file: "Opens the file. It is saved back to the same place.",
};

const DIALECT_OPTIONS = DIALECTS.map((d) => ({
  value: d,
  label: DIALECT_LABEL[d],
  lead: <DbMark dialect={d} open size={14} label={null} />,
}));

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
  /** A file already read that does not say its Dialect, such as one reopened from Recent; starts on the Dialect question. */
  file?: { path: string; dbml: string; layout: string | null };
  onStart: (doc: ModelDoc) => void;
  onCancel: () => void;
}

export default function StartModel({ connections, openIds, initial, file, onStart, onCancel }: Props) {
  const [way, setWay] = useState<Way>(file ? "file" : "connection");
  const [dialect, setDialect] = useState<DialectKind>("mysql");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknownDialect, setUnknownDialect] = useState<{ path: string; dbml: string; layout: string | null } | null>(file ?? null);
  const [fileDialect, setFileDialect] = useState<DialectKind>("mysql");
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [now] = useState(() => new Date());
  const open_ = connections.filter((c) => openIds.has(c.id));
  const [connectionId, setConnectionId] = useState(initial?.connectionId ?? "");
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [showSystem, setShowSystem] = useState(!!initial && SYSTEM_DATABASES.has(initial.database));
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [schema, setSchema] = useState(initial?.schema ?? "");
  const [tableCount, setTableCount] = useState<number | null>(null);
  const connection = open_.find((c) => c.id === connectionId);
  const cards = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let live = true;
    recentItems()
      .then((items) => live && setRecent(items))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!connectionId) return;
    setDatabases(null);
    listDatabases(connectionId)
      .then(setDatabases)
      .catch((e) => setError(errorText(e, connection?.dialect)));
  }, [connectionId]);

  const visibleDatabases = useMemo(
    () => (databases ?? []).filter((d) => showSystem || !SYSTEM_DATABASES.has(d)),
    [databases, showSystem],
  );

  // Never rest on a hidden database: take the first one shown.
  useEffect(() => {
    if (databases === null) return;
    if (!visibleDatabases.includes(database)) setDatabase(visibleDatabases[0] ?? "");
  }, [databases, visibleDatabases, database]);

  useEffect(() => {
    if (!connection || connection.dialect !== "postgres" || !database) return;
    setSchemas(null);
    listSchemas(connection.id, database)
      .then((s) => {
        const user = s.filter((x) => !x.isSystem).map((x) => x.name);
        setSchemas(user);
        if (!schema || !user.includes(schema)) setSchema(user.includes("public") ? "public" : (user[0] ?? ""));
      })
      .catch((e) => setError(errorText(e, connection.dialect)));
  }, [connectionId, database]);

  useEffect(() => {
    setTableCount(null);
    if (!connection || !database) return;
    const pg = connection.dialect === "postgres";
    if (pg && !schema) return;
    let live = true;
    listObjects(connection.id, database, pg ? schema : null)
      .then((objects) => live && setTableCount(objects.filter((o) => o.kind === "table").length))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [connectionId, database, schema]);

  function startFile(path: string, dbml: string, layout: string | null, d: DialectKind) {
    onStart({ path, dbml, savedDbml: dbml, layout: layout ? parseLayout(layout) : EMPTY_LAYOUT, dialect: d, source: "file", connectionId: null });
  }

  async function openPath(path: string) {
    setError(null);
    try {
      const files = await readModelFiles(path);
      const d = dialectFromHeader(files.dbml);
      if (d) startFile(path, files.dbml, files.layout, d);
      else setUnknownDialect({ path, ...files });
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function openFile() {
    setError(null);
    const path = await open({ multiple: false, directory: false, filters: [{ name: "DBML", extensions: ["dbml"] }] });
    if (typeof path === "string") await openPath(path);
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
      onStart({ path: null, dbml, savedDbml: "", layout, dialect: connection.dialect, source: "connection", connectionId: connection.id });
    } catch (e) {
      setError(errorText(e, connection.dialect));
    } finally {
      setBusy(false);
    }
  }

  const canRun = way === "connection" ? !!database && !busy && !(connection?.dialect === "postgres" && !schema) : true;

  function run() {
    if (!canRun) return;
    if (way === "connection") void fromConnection();
    else if (way === "blank")
      onStart({ path: null, dbml: blankModel(dialect), savedDbml: "", layout: EMPTY_LAYOUT, dialect, source: "blank", connectionId: null });
    else void openFile();
  }

  function onCardKey(e: KeyboardEvent, i: number) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const to = (i + step + WAYS.length) % WAYS.length;
    setWay(WAYS[to].way);
    cards.current[to]?.focus();
  }

  // Enter runs the footer action, except where it already means something (buttons, lists).
  function onBodyKey(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.defaultPrevented) return;
    if ((e.target as HTMLElement).closest("button, [role=option], [role=switch]")) return;
    e.preventDefault();
    run();
  }

  const connectionOptions = [
    { value: "", label: "Choose a Connection", disabled: true },
    ...connections.map((c) => {
      const isOpen = openIds.has(c.id);
      return {
        value: c.id,
        label: c.name,
        lead: <DbMark dialect={c.dialect} open={isOpen} size={14} label={`${DIALECT_LABEL[c.dialect]}, ${isOpen ? "open" : "closed"}`} />,
        trail: <SafetyTag connection={c} small />,
        disabled: !isOpen,
      };
    }),
  ];
  const recentModels = recent.filter((r) => r.target.kind === "schemaModel");

  const primary =
    way === "connection"
      ? { icon: "database" as const, text: busy ? "Reading..." : "Read the database" }
      : way === "blank"
        ? { icon: "plus" as const, text: "Create blank model" }
        : { icon: "folder" as const, text: "Open..." };

  return (
    <Dialog title="New Schema Model" icon="layers" size="model" onClose={onCancel}>
      <div className="dialog-body model-body" onKeyDown={onBodyKey}>
        <div className="model-cards" role="radiogroup" aria-label="Start from">
          {WAYS.map((w, i) => (
            <div
              key={w.way}
              ref={(el) => {
                cards.current[i] = el;
              }}
              role="radio"
              aria-checked={way === w.way}
              tabIndex={way === w.way ? 0 : -1}
              data-autofocus={i === 0 ? "" : undefined}
              className={way === w.way ? "model-card model-card-on" : "model-card"}
              onClick={() => setWay(w.way)}
              onKeyDown={(e) => onCardKey(e, i)}
            >
              <span className="model-card-radio" aria-hidden="true" />
              <Icon name={w.icon} size={20} />
              <b>{w.title}</b>
              <span className="model-card-text">{w.text}</span>
            </div>
          ))}
        </div>

        <div className="model-fields">
          {way === "connection" &&
            (open_.length === 0 ? (
              <p className="muted">Open a Connection to read its schema.</p>
            ) : (
              <>
                <div className="model-row">
                  <span className="model-label">Connection</span>
                  <Select
                    label="Connection"
                    value={connectionId}
                    options={connectionOptions}
                    onChange={(id) => {
                      setConnectionId(id);
                      setDatabase("");
                      setSchema("");
                      setDatabases(null);
                    }}
                  />
                </div>
                {connectionId && databases === null && <p className="muted">Loading databases...</p>}
                {databases && (
                  <>
                    <div className="model-row">
                      <span className="model-label">Database</span>
                      <div className="model-pick">
                        <Select
                          label="Database"
                          mono
                          value={database}
                          options={visibleDatabases.map((d) => ({ value: d, label: d, lead: <Icon name="database" size={14} /> }))}
                          onChange={setDatabase}
                        />
                        {tableCount !== null && <span className="model-count">{`${tableCount} ${tableCount === 1 ? "table" : "tables"}`}</span>}
                      </div>
                    </div>
                    {connection?.dialect === "postgres" && database && schemas && (
                      <div className="model-row">
                        <span className="model-label">Schema</span>
                        <Select label="Schema" mono value={schema} options={schemas.map((s) => ({ value: s, label: s }))} onChange={setSchema} />
                      </div>
                    )}
                    <div className="model-row">
                      <span />
                      <Switch label="Show system databases" checked={showSystem} onChange={setShowSystem} />
                    </div>
                  </>
                )}
              </>
            ))}

          {way === "blank" && (
            <>
              <div className="model-row">
                <span className="model-label">Dialect</span>
                <Segmented label="Dialect" value={dialect} options={DIALECT_OPTIONS} onChange={setDialect} />
              </div>
              <div className="model-row">
                <label className="model-label" htmlFor="model-name">
                  Name
                </label>
                <input id="model-name" className="input mono" value="untitled.dbml" readOnly />
              </div>
            </>
          )}

          {way === "file" && (
            <>
              <div className="model-drop">
                <Icon name="fileQuery" size={20} />
                <span>Drop a .dbml file here</span>
                <button type="button" className="button" onClick={() => void openFile()}>
                  <Icon name="folder" size={14} />
                  Browse...
                </button>
              </div>
              {unknownDialect && (
                <div className="start-model-ask">
                  <p>This file doesn't say which Dialect it targets. Choose one.</p>
                  <div className="model-ask-row">
                    <Segmented label="Dialect of the file" value={fileDialect} options={DIALECT_OPTIONS} onChange={setFileDialect} />
                    <button
                      type="button"
                      className="button"
                      onClick={() => startFile(unknownDialect.path, unknownDialect.dbml, unknownDialect.layout, fileDialect)}
                    >
                      Continue
                    </button>
                  </div>
                </div>
              )}
              {recentModels.length > 0 && (
                <div className="model-recent">
                  <span className="model-label">Recent models</span>
                  {recentModels.map((r) => {
                    const path = r.target.kind === "schemaModel" ? r.target.file : "";
                    return (
                      <button key={`${path}-${r.openedAtMs}`} type="button" className="model-recent-item" onClick={() => void openPath(path)}>
                        <Icon name="fileQuery" size={14} />
                        <span className="mono">{basename(path)}</span>
                        <span className="model-recent-time">{recentTime(r.openedAtMs, now)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="dialog-footer">
        <span className="model-hint">{HINT[way]}</span>
        <span className="spacer" />
        <button type="button" className="button" onClick={onCancel}>
          Cancel
          <Kbd keys="Esc" />
        </button>
        <button type="button" className="button button-primary" disabled={!canRun} onClick={run}>
          <Icon name={primary.icon} size={14} />
          {primary.text}
          <Kbd keys="Enter" />
        </button>
      </footer>
    </Dialog>
  );
}
