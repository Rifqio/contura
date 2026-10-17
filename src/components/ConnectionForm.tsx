import { open, save } from "@tauri-apps/plugin-dialog";
import { useId, useState } from "react";
import {
  createSqliteDatabase,
  DIALECT_DEFAULTS,
  DIALECT_LABEL,
  errorText,
  isCommandError,
  saveConnection,
  testConnection,
} from "../api/client";
import type {
  AiAccess,
  ConnectionConfig,
  ConnectionInput,
  DialectKind,
  Group,
  GroupId,
  PasswordChange,
  SslMode,
  SuggestedConnection,
} from "../api/types";
import { AI_ACCESS_OPTIONS } from "../settings/ai/providers";
import Dialog from "./Dialog";
import Icon from "./Icon";
import Switch from "./Switch";

interface Props {
  /** The Connection being edited; absent for a new one. */
  connection?: ConnectionConfig;
  /** Values for a new Connection, such as a SuggestedConnection. */
  prefill?: SuggestedConnection;
  groups: Group[];
  /** The Group a new Connection goes into; null is Ungrouped. */
  defaultGroupId: GroupId | null;
  onSaved: (saved: ConnectionConfig) => void;
  onCancel: () => void;
}

type SslChoice = SslMode["mode"];
type ServerDialect = keyof typeof DIALECT_DEFAULTS;

const SQLITE_FILTER = { name: "SQLite database", extensions: ["sqlite", "sqlite3", "db", "db3"] };
const ALL_FILES_FILTER = { name: "All files", extensions: ["*"] };

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function isExistingFileRefusal(e: unknown): boolean {
  return isCommandError(e) && e.kind === "invalidInput" && e.message.startsWith("a file already exists");
}

export default function ConnectionForm({ connection, prefill, groups, defaultGroupId, onSaved, onCancel }: Props) {
  const id = useId();
  const editing = connection !== undefined;
  const source = connection ?? prefill;
  const initialDialect: DialectKind = source?.dialect ?? "mysql";
  const fromServer = source && source.dialect !== "sqlite" ? source : undefined;
  const initialServer: ServerDialect = initialDialect === "sqlite" ? "mysql" : initialDialect;

  const [name, setName] = useState(source?.name ?? "");
  const [dialect, setDialect] = useState<DialectKind>(initialDialect);
  // The server Dialect the port and user were last set for, so a switch can tell defaults from typed values.
  const [lastServer, setLastServer] = useState<ServerDialect>(initialServer);
  const [host, setHost] = useState(fromServer?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(fromServer?.port ?? DIALECT_DEFAULTS[initialServer].port));
  const [user, setUser] = useState(fromServer?.user ?? DIALECT_DEFAULTS[initialServer].user);
  const [password, setPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [removePassword, setRemovePassword] = useState(false);
  const [database, setDatabase] = useState(connection?.database ?? "");
  const [ssl, setSsl] = useState<SslChoice>(connection?.ssl.mode ?? "disable");
  const [caPath, setCaPath] = useState(connection?.ssl.mode === "verifyCa" ? connection.ssl.caPath : "");
  const [file, setFile] = useState(connection?.file ?? "");
  const [groupId, setGroupId] = useState<GroupId | "">((editing ? connection.groupId : defaultGroupId) ?? "");
  const [aiAccess, setAiAccess] = useState<AiAccess>(connection?.aiAccess ?? "schema");
  const [production, setProduction] = useState(connection?.production ?? false);
  const [readOnly, setReadOnly] = useState(connection?.readOnly ?? false);
  const [busy, setBusy] = useState<"test" | "save" | "create" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [timeout, setTimeoutText] = useState(connection?.queryTimeoutSecs ? String(connection.queryTimeoutSecs) : "");
  const [timeoutError, setTimeoutError] = useState<string | null>(null);

  const sqlite = dialect === "sqlite";
  const accessDescription = AI_ACCESS_OPTIONS.find((o) => o.value === aiAccess)?.description ?? "";

  // The Core forces AI access to never when Production is saved on, so it stays locked
  // until the first save as Production.
  const productionIsNew = production && !(connection?.production ?? false);

  function changeProduction(next: boolean) {
    setProduction(next);
    if (next) setAiAccess("never");
  }

  function changeDialect(next: DialectKind) {
    if (next !== "sqlite") {
      const previous = DIALECT_DEFAULTS[lastServer];
      if (port === String(previous.port)) setPort(String(DIALECT_DEFAULTS[next].port));
      if (user === previous.user) setUser(DIALECT_DEFAULTS[next].user);
      setLastServer(next);
    }
    setDialect(next);
    setResult(null);
    setPortError(null);
  }

  function passwordChange(): PasswordChange {
    if (passwordTouched && password !== "") return { t: "set", value: password };
    if (editing) return removePassword ? { t: "clear" } : { t: "keep" };
    return { t: "clear" };
  }

  function input(): ConnectionInput | null {
    const t = timeout.trim();
    if (t !== "" && (!/^\d+$/.test(t) || Number(t) < 1)) {
      setTimeoutError("Enter a whole number of seconds, or leave it empty.");
      return null;
    }
    setTimeoutError(null);
    const common = {
      id: connection?.id ?? null,
      name: name.trim(),
      groupId: groupId === "" ? null : groupId,
      queryTimeoutSecs: t === "" ? null : Number(t),
      aiAccess: productionIsNew ? "never" : aiAccess,
      production,
      readOnly,
    };
    if (dialect === "sqlite") {
      return {
        ...common,
        dialect,
        file: file.trim(),
        host: "",
        port: 0,
        user: "",
        database: null,
        ssl: { mode: "disable" },
        password: { t: "clear" },
      };
    }
    const portNumber = Number(port);
    if (!/^\d+$/.test(port.trim()) || portNumber < 1 || portNumber > 65535) {
      const usual = DIALECT_DEFAULTS[dialect].port;
      setPortError(`Enter a port from 1 to 65535. ${DIALECT_LABEL[dialect]} usually uses ${usual}.`);
      return null;
    }
    setPortError(null);
    const sslMode: SslMode = ssl === "verifyCa" ? { mode: "verifyCa", caPath: caPath.trim() } : { mode: ssl };
    return {
      ...common,
      dialect,
      file: null,
      host: host.trim(),
      port: portNumber,
      user,
      database: database.trim() === "" ? null : database.trim(),
      ssl: sslMode,
      password: passwordChange(),
    };
  }

  async function onTest() {
    const value = input();
    if (!value) return;
    setBusy("test");
    setResult(null);
    try {
      const version = await testConnection(value);
      const text =
        value.dialect === "sqlite"
          ? `Opened. Contura uses SQLite ${version}.`
          : `Connected. The server runs ${DIALECT_LABEL[value.dialect]} ${version}.`;
      setResult({ ok: true, text });
    } catch (e) {
      setResult({ ok: false, text: errorText(e, value.dialect) });
    } finally {
      setBusy(null);
    }
  }

  async function onBrowse() {
    try {
      const chosen = await open({ multiple: false, directory: false, filters: [SQLITE_FILTER, ALL_FILES_FILTER] });
      if (typeof chosen !== "string") return;
      setFile(chosen);
      setResult(null);
    } catch (e) {
      setResult({ ok: false, text: errorText(e, "sqlite") });
    }
  }

  async function onNewFile() {
    let path: string | null;
    try {
      path = await save({ filters: [SQLITE_FILTER], defaultPath: `${name.trim() || "database"}.sqlite` });
    } catch (e) {
      setResult({ ok: false, text: errorText(e, "sqlite") });
      return;
    }
    if (!path) return;
    setBusy("create");
    setResult(null);
    try {
      await createSqliteDatabase(path);
      setFile(path);
      setResult({ ok: true, text: `Created ${fileName(path)}.` });
    } catch (e) {
      const text = isExistingFileRefusal(e)
        ? "Contura never replaces an existing file. Choose a new name."
        : errorText(e, "sqlite");
      setResult({ ok: false, text });
    } finally {
      setBusy(null);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = input();
    if (!value) return;
    setBusy("save");
    setResult(null);
    try {
      onSaved(await saveConnection(value));
    } catch (err) {
      setResult({ ok: false, text: errorText(err, value.dialect) });
      setBusy(null);
    }
  }

  const f = (field: string) => `${id}-${field}`;

  return (
    <Dialog title={editing ? `Edit ${connection.name}` : "New Connection"} onClose={onCancel}>
      <form className="form" onSubmit={onSubmit} noValidate>
        <div className="dialog-body form-grid">
          <label className="field" htmlFor={f("name")}>
            <span>Name</span>
            <input id={f("name")} className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {/* Not a <label>: its text would swallow the help line into the select's name. */}
          <div className="field">
            <span id={f("dialect-label")}>Dialect</span>
            <select
              id={f("dialect")}
              className="input"
              aria-labelledby={f("dialect-label")}
              value={dialect}
              disabled={editing}
              aria-describedby={editing ? f("dialect-help") : undefined}
              onChange={(e) => changeDialect(e.target.value as DialectKind)}
            >
              <option value="mysql">{DIALECT_LABEL.mysql}</option>
              <option value="postgres">{DIALECT_LABEL.postgres}</option>
              <option value="sqlite">{DIALECT_LABEL.sqlite}</option>
            </select>
            {editing && (
              <span id={f("dialect-help")} className="field-help">
                The Dialect can't change after saving.
              </span>
            )}
          </div>
          {sqlite ? (
            <div className="field field-wide">
              <span id={f("file-label")}>File</span>
              <div className="file-row">
                <input
                  id={f("file")}
                  className="input mono"
                  aria-labelledby={f("file-label")}
                  value={file}
                  placeholder="C:\data\shop.db"
                  onChange={(e) => setFile(e.target.value)}
                />
                <button type="button" className="button" onClick={onBrowse} disabled={busy !== null}>
                  Browse…
                </button>
                <button type="button" className="button" onClick={onNewFile} disabled={busy !== null}>
                  {busy === "create" ? "Creating…" : "New file…"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <label className="field" htmlFor={f("host")}>
                <span>Host</span>
                <input id={f("host")} className="input" value={host} onChange={(e) => setHost(e.target.value)} />
              </label>
              <label className="field" htmlFor={f("port")}>
                <span>Port</span>
                <input
                  id={f("port")}
                  className={portError ? "input input-error" : "input"}
                  inputMode="numeric"
                  value={port}
                  aria-invalid={portError !== null}
                  aria-describedby={portError ? f("port-error") : undefined}
                  onChange={(e) => setPort(e.target.value)}
                />
                {portError && (
                  <span id={f("port-error")} className="field-error">
                    {portError}
                  </span>
                )}
              </label>
              <label className="field" htmlFor={f("user")}>
                <span>User</span>
                <input id={f("user")} className="input" value={user} onChange={(e) => setUser(e.target.value)} />
              </label>
              <label className="field" htmlFor={f("password")}>
                <span>Password</span>
                <input
                  id={f("password")}
                  className="input"
                  type="password"
                  value={password}
                  placeholder={editing ? "Saved password unchanged" : ""}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setPasswordTouched(true);
                  }}
                />
              </label>
              {editing && (
                <label className="checkbox field-wide">
                  <input
                    type="checkbox"
                    checked={removePassword}
                    disabled={password !== ""}
                    onChange={(e) => setRemovePassword(e.target.checked)}
                  />
                  Remove the saved password
                </label>
              )}
              <label className="field" htmlFor={f("database")}>
                <span>Default database</span>
                <input
                  id={f("database")}
                  className="input"
                  value={database}
                  placeholder="Optional"
                  onChange={(e) => setDatabase(e.target.value)}
                />
              </label>
              <label className="field" htmlFor={f("ssl")}>
                <span>SSL</span>
                <select
                  id={f("ssl")}
                  className="input"
                  value={ssl}
                  onChange={(e) => setSsl(e.target.value as SslChoice)}
                >
                  <option value="disable">Off</option>
                  <option value="require">Required</option>
                  <option value="verifyCa">Required, verify the CA</option>
                </select>
              </label>
              {ssl === "verifyCa" && (
                <label className="field field-wide" htmlFor={f("ca")}>
                  <span>CA certificate file</span>
                  <input
                    id={f("ca")}
                    className="input"
                    value={caPath}
                    placeholder="C:\certs\ca.pem"
                    onChange={(e) => setCaPath(e.target.value)}
                  />
                </label>
              )}
            </>
          )}
          <div className="field">
            <label htmlFor={f("timeout")}>
              <span>Query timeout (seconds)</span>
            </label>
            <input
              id={f("timeout")}
              className={timeoutError ? "input input-error" : "input"}
              inputMode="numeric"
              value={timeout}
              placeholder="No limit"
              aria-invalid={timeoutError !== null}
              aria-describedby={timeoutError ? f("timeout-error") : f("timeout-hint")}
              onChange={(e) => setTimeoutText(e.target.value)}
            />
            {timeoutError ? (
              <span id={f("timeout-error")} className="field-error">
                {timeoutError}
              </span>
            ) : (
              <span id={f("timeout-hint")} className="field-hint">
                Queries typed in the editor are stopped on the server after this long.
              </span>
            )}
          </div>
          <label className="field field-wide" htmlFor={f("group")}>
            <span>Group</span>
            <select id={f("group")} className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">Ungrouped</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <div className="safety field-wide" role="group" aria-label="Safety">
            <span className="fl">Safety</span>
            <Switch
              checked={production}
              onChange={changeProduction}
              label="Production"
              hint="Asks before every write. Functions called from a SELECT are not checked."
              disabled={readOnly}
              note={readOnly ? "Overridden by Read-only" : undefined}
            />
            <Switch checked={readOnly} onChange={setReadOnly} label="Read-only" hint="Blocks every write" />
          </div>
          <label className="field field-wide" htmlFor={f("ai-access")}>
            <span>AI can see</span>
            <select
              id={f("ai-access")}
              className="input"
              value={productionIsNew ? "never" : aiAccess}
              disabled={productionIsNew}
              aria-describedby={f("ai-access-help")}
              onChange={(e) => setAiAccess(e.target.value as AiAccess)}
            >
              {AI_ACCESS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <span id={f("ai-access-help")} className="field-hint field-wide">
            {productionIsNew
              ? "Production Connections send nothing to the assistant. You can raise this after saving."
              : production && aiAccess === "never"
                ? "Production Connections send nothing to the assistant unless you change this"
                : "What the AI assistant may send to your provider from this Connection."}
          </span>
          {production && !productionIsNew && aiAccess !== "never" && (
            <p className="ai-warn field-wide" role="status">
              <Icon name="warning" />
              <span>
                {`This is a Production Connection: the assistant will see ${lowerFirst(accessDescription)}.`}
              </span>
            </p>
          )}
          {result && (
            <p className={result.ok ? "form-result field-wide" : "form-result error-text field-wide"} role="status">
              {result.text}
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="button" onClick={onTest} disabled={busy !== null}>
            {busy === "test" ? "Testing…" : "Test"}
          </button>
          <span className="spacer" />
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
