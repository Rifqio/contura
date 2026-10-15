import { useId, useState } from "react";
import { errorText, saveConnection, testConnection } from "../api/client";
import type {
  ConnectionConfig,
  ConnectionInput,
  Group,
  GroupId,
  PasswordChange,
  SslMode,
  SuggestedConnection,
} from "../api/types";
import Dialog from "./Dialog";

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

const DEFAULT_PORT = 3306;

export default function ConnectionForm({ connection, prefill, groups, defaultGroupId, onSaved, onCancel }: Props) {
  const id = useId();
  const editing = connection !== undefined;
  const [name, setName] = useState(connection?.name ?? prefill?.name ?? "");
  const [host, setHost] = useState(connection?.host ?? prefill?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(connection?.port ?? prefill?.port ?? DEFAULT_PORT));
  const [user, setUser] = useState(connection?.user ?? prefill?.user ?? "root");
  const [password, setPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [removePassword, setRemovePassword] = useState(false);
  const [database, setDatabase] = useState(connection?.database ?? "");
  const [ssl, setSsl] = useState<SslChoice>(connection?.ssl.mode ?? "disable");
  const [caPath, setCaPath] = useState(connection?.ssl.mode === "verifyCa" ? connection.ssl.caPath : "");
  const [groupId, setGroupId] = useState<GroupId | "">((editing ? connection.groupId : defaultGroupId) ?? "");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [portError, setPortError] = useState<string | null>(null);

  function passwordChange(): PasswordChange {
    if (passwordTouched && password !== "") return { t: "set", value: password };
    if (editing) return removePassword ? { t: "clear" } : { t: "keep" };
    return { t: "clear" };
  }

  function input(): ConnectionInput | null {
    const portNumber = Number(port);
    if (!/^\d+$/.test(port.trim()) || portNumber < 1 || portNumber > 65535) {
      setPortError("Enter a port from 1 to 65535. MySQL usually uses 3306.");
      return null;
    }
    setPortError(null);
    const sslMode: SslMode = ssl === "verifyCa" ? { mode: "verifyCa", caPath: caPath.trim() } : { mode: ssl };
    return {
      id: connection?.id ?? null,
      name: name.trim(),
      dialect: "mysql",
      host: host.trim(),
      port: portNumber,
      user,
      database: database.trim() === "" ? null : database.trim(),
      ssl: sslMode,
      password: passwordChange(),
      groupId: groupId === "" ? null : groupId,
    };
  }

  async function onTest() {
    const value = input();
    if (!value) return;
    setBusy("test");
    setResult(null);
    try {
      const version = await testConnection(value);
      setResult({ ok: true, text: `Connected. The server runs MySQL ${version}.` });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
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
      setResult({ ok: false, text: errorText(err) });
      setBusy(null);
    }
  }

  const f = (field: string) => `${id}-${field}`;

  return (
    <Dialog title={editing ? `Edit ${connection.name}` : "New Connection"} onClose={onCancel}>
      <form className="form" onSubmit={onSubmit} noValidate>
        <div className="dialog-body form-grid">
          <label className="field field-wide" htmlFor={f("name")}>
            <span>Name</span>
            <input id={f("name")} className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field" htmlFor={f("host")}>
            <span>Host</span>
            <input id={f("host")} className="input" value={host} onChange={(e) => setHost(e.target.value)} />
          </label>
          <label className="field field-narrow" htmlFor={f("port")}>
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
            <select id={f("ssl")} className="input" value={ssl} onChange={(e) => setSsl(e.target.value as SslChoice)}>
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
            Save
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
