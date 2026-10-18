import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useRef, useState } from "react";
import {
  createSqliteDatabase,
  DIALECT_DEFAULTS,
  DIALECT_LABEL,
  aiSettings,
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
import { keysFor } from "../commands/keymap";
import { keysFromEvent } from "../commands/keys";
import { useKeymap } from "../commands/useCommandKeys";
import DbMark from "./DbMark";
import Dialog from "./Dialog";
import GroupBadge from "./GroupBadge";
import Icon from "./Icon";
import Kbd from "./Kbd";
import Segmented from "./Segmented";
import Select from "./Select";
import Switch from "./Switch";

interface Props {
  /** The Connection being edited; absent for a new one. */
  connection?: ConnectionConfig;
  /** Values for a new Connection, such as a SuggestedConnection. */
  prefill?: SuggestedConnection;
  /** A new Connection starting from another one's settings, named "<name> copy", without its password (PR23). */
  duplicateOf?: ConnectionConfig;
  groups: Group[];
  /** The Group a new Connection goes into; null is Ungrouped. */
  defaultGroupId: GroupId | null;
  onSaved: (saved: ConnectionConfig) => void;
  onCancel: () => void;
  /** Asked right before an edit is saved (saving closes the session, so jobs on it end); false keeps the form. */
  beforeSave?: () => Promise<boolean>;
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

export default function ConnectionForm({ connection, prefill, duplicateOf, groups, defaultGroupId, onSaved, onCancel, beforeSave }: Props) {
  const id = useId();
  const editing = connection !== undefined;
  /** Where the stored settings come from: the Connection being edited, or the one duplicated. */
  const base = connection ?? duplicateOf;
  const source = connection ?? (duplicateOf ? { ...duplicateOf, name: `${duplicateOf.name} copy` } : prefill);
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
  const [database, setDatabase] = useState(base?.database ?? "");
  const [ssl, setSsl] = useState<SslChoice>(base?.ssl.mode ?? "disable");
  const [caPath, setCaPath] = useState(base?.ssl.mode === "verifyCa" ? base.ssl.caPath : "");
  const [file, setFile] = useState(base?.file ?? "");
  const [groupId, setGroupId] = useState<GroupId | "">((base ? base.groupId : defaultGroupId) ?? "");
  const [aiAccess, setAiAccess] = useState<AiAccess>(base?.aiAccess ?? "schema");
  const [production, setProduction] = useState(base?.production ?? false);
  const [readOnly, setReadOnly] = useState(base?.readOnly ?? false);
  const [busy, setBusy] = useState<"test" | "save" | "create" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [timeout, setTimeoutText] = useState(base?.queryTimeoutSecs ? String(base.queryTimeoutSecs) : "");
  const [timeoutError, setTimeoutError] = useState<string | null>(null);

  const [showPassword, setShowPassword] = useState(false);
  const saveKeys = keysFor(useKeymap().map, "query.save");
  // A new Connection starts at the access the AI settings name, unless you chose one first.
  const aiChosen = useRef(base !== undefined);
  useEffect(() => {
    if (editing) return;
    let live = true;
    Promise.resolve()
      .then(() => aiSettings(defaultGroupId))
      .then((v) => {
        const next = v?.settings?.newConnectionAccess;
        if (live && next && !aiChosen.current) setAiAccess(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // Read once, when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sqlite = dialect === "sqlite";
  const accessDescription = AI_ACCESS_OPTIONS.find((o) => o.value === aiAccess)?.description ?? "";

  // The Core forces AI access to never when Production is saved on, so it stays locked
  // until the first save as Production.
  const productionIsNew = production && !(connection?.production ?? false);

  function changeProduction(next: boolean) {
    aiChosen.current = true;
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

  async function submit() {
    if (busy !== null) return;
    const value = input();
    if (!value) return;
    setBusy("save");
    setResult(null);
    try {
      if (beforeSave && !(await beforeSave())) {
        setBusy(null);
        return;
      }
      onSaved(await saveConnection(value));
    } catch (err) {
      setResult({ ok: false, text: errorText(err, value.dialect) });
      setBusy(null);
    }
  }

  function onFormKeyDown(e: React.KeyboardEvent) {
    const keys = keysFromEvent(e.nativeEvent);
    if (keys && saveKeys.includes(keys)) {
      e.preventDefault();
      void submit();
    }
  }

  const f = (field: string) => `${id}-${field}`;
  const access = productionIsNew ? "never" : aiAccess;
  const groupOptions = [
    { value: "", label: "Ungrouped", lead: <GroupBadge name="" color={null} /> },
    ...groups.map((g) => ({ value: g.id as string, label: g.name, lead: <GroupBadge id={g.id} name={g.name} color={g.color} /> })),
  ];
  const dialectOptions = (["mysql", "postgres", "sqlite"] as const).map((d) => ({
    value: d,
    label: DIALECT_LABEL[d],
    lead: <DbMark dialect={d} open label={null} size={14} />,
  }));
  const productionHint =
    production && readOnly
      ? "Read-only is on, so every write is blocked and Production never needs to ask."
      : "Asks before every write";

  return (
    <Dialog
      title={editing ? "Edit Connection" : "New Connection"}
      icon="plug"
      subtitle={editing ? connection.name : undefined}
      className="connection-dialog"
      onClose={onCancel}
    >
      <form
        className="form connection-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={onFormKeyDown}
        noValidate
      >
        <div className="dialog-body form-grid">
          <div className="field field-wide">
            <span className="fl">Database</span>
            <fieldset className="field-reset" disabled={editing} aria-describedby={editing ? f("dialect-help") : undefined}>
              <Segmented value={dialect} options={dialectOptions} onChange={changeDialect} label="Database" />
            </fieldset>
            {editing && (
              <span id={f("dialect-help")} className="field-help">
                The Dialect can't change after saving.
              </span>
            )}
          </div>
          <div className="field">
            <label className="fl" htmlFor={f("name")}>
              Name
            </label>
            <input id={f("name")} className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <span className="fl">Group</span>
            <Select value={groupId} options={groupOptions} onChange={setGroupId} label="Group" />
          </div>
          {sqlite ? (
            <div className="field field-wide">
              <span className="fl" id={f("file-label")}>
                File
              </span>
              <div className="file-row">
                <input
                  id={f("file")}
                  className="input input-mono"
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
              <div className="form-hostport field-wide">
                <div className="field">
                  <label className="fl" htmlFor={f("host")}>
                    Host
                  </label>
                  <input id={f("host")} className="input input-mono" value={host} onChange={(e) => setHost(e.target.value)} />
                </div>
                <div className="field">
                  <label className="fl" htmlFor={f("port")}>
                    Port
                  </label>
                  <input
                    id={f("port")}
                    className={portError ? "input input-mono input-error" : "input input-mono"}
                    inputMode="numeric"
                    value={port}
                    aria-invalid={portError !== null}
                    aria-describedby={portError ? f("port-error") : undefined}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </div>
                {portError && (
                  <span id={f("port-error")} className="field-error form-hostport-error">
                    {portError}
                  </span>
                )}
              </div>
              <div className="field">
                <label className="fl" htmlFor={f("user")}>
                  User
                </label>
                <input id={f("user")} className="input input-mono" value={user} onChange={(e) => setUser(e.target.value)} />
              </div>
              <div className="field">
                <label className="fl" htmlFor={f("password")}>
                  Password
                </label>
                <div className="input-affix">
                  <input
                    id={f("password")}
                    className="input input-affixed"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    placeholder={editing ? "Saved password unchanged" : ""}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setPasswordTouched(true);
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button input-affix-button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    <Icon name="eye" />
                  </button>
                </div>
              </div>
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
              <div className="field">
                <label className="fl" htmlFor={f("database")}>
                  Database name
                </label>
                <input
                  id={f("database")}
                  className="input input-mono"
                  value={database}
                  placeholder="Optional"
                  onChange={(e) => setDatabase(e.target.value)}
                />
              </div>
              <div className="field">
                <span className="fl">SSL</span>
                <Select
                  value={ssl}
                  label="SSL"
                  onChange={setSsl}
                  options={[
                    { value: "disable", label: "Off" },
                    { value: "require", label: "Required" },
                    { value: "verifyCa", label: "Required, verify the CA" },
                  ]}
                />
              </div>
              {ssl === "verifyCa" && (
                <div className="field field-wide">
                  <label className="fl" htmlFor={f("ca")}>
                    CA certificate file
                  </label>
                  <input
                    id={f("ca")}
                    className="input input-mono"
                    value={caPath}
                    placeholder="C:\certs\ca.pem"
                    onChange={(e) => setCaPath(e.target.value)}
                  />
                </div>
              )}
            </>
          )}
          <div className="field">
            <label className="fl" htmlFor={f("timeout")}>
              Query timeout
            </label>
            <div className="input-affix">
              <input
                id={f("timeout")}
                className={timeoutError ? "input input-affixed input-error" : "input input-affixed"}
                inputMode="numeric"
                value={timeout}
                placeholder="No limit"
                aria-invalid={timeoutError !== null}
                aria-describedby={timeoutError ? f("timeout-error") : undefined}
                onChange={(e) => setTimeoutText(e.target.value)}
              />
              <span className="input-suffix">seconds</span>
            </div>
            {timeoutError && (
              <span id={f("timeout-error")} className="field-error">
                {timeoutError}
              </span>
            )}
          </div>
          <div className="field">
            <span className="fl">AI access</span>
            <Select
              value={access}
              label="AI access"
              describedBy={f("ai-access-help")}
              disabled={productionIsNew}
              onChange={(v) => {
                aiChosen.current = true;
                setAiAccess(v);
              }}
              options={AI_ACCESS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </div>
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
              <span>{`This is a Production Connection: the assistant will see ${lowerFirst(accessDescription)}.`}</span>
            </p>
          )}
          <div className="safety field-wide" role="group" aria-label="Safety">
            <span className="fl">Safety</span>
            <Switch
              checked={production}
              onChange={changeProduction}
              label="Production"
              hint={productionHint}
              disabled={readOnly}
              note={readOnly ? "Overridden by Read-only" : undefined}
            />
            <Switch checked={readOnly} onChange={setReadOnly} label="Read-only" hint="Blocks every write" />
          </div>
          {result && (
            <p className={result.ok ? "form-result field-wide" : "form-result error-text field-wide"} role="status">
              {result.text}
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="button" onClick={onTest} disabled={busy !== null}>
            <Icon name="plug" />
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <span className="spacer" />
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" aria-label="Save" disabled={busy !== null}>
            {busy === "save" ? "Saving…" : "Save"}
            {saveKeys[0] && busy !== "save" && <Kbd keys={saveKeys[0]} />}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
