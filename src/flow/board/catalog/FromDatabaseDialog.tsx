import { useEffect, useRef, useState } from "react";
import { DIALECT_LABEL, errorText, listDiagrams, schemaSnapshot } from "../../../api/client";
import type { ConnectionConfig } from "../../../api/types";
import DbMark from "../../../components/DbMark";
import Dialog from "../../../components/Dialog";
import Icon from "../../../components/Icon";
import Kbd from "../../../components/Kbd";
import SafetyTag from "../../../components/SafetyTag";
import Select from "../../../components/Select";
import Switch from "../../../components/Switch";
import { useSchemaSource } from "../../../schema/useSchemaSource";
import { parseFlowLayout, serializeFlowLayout } from "../../layout";
import type { DatabaseAdd } from "../../FlowTab";
import { writeFreeDiagram } from "../../writeFreeDiagram";
import { databaseTitle, modelToErFrame } from "./fromDatabase";

export type FromDatabaseTarget = { kind: "frame"; add: DatabaseAdd } | { kind: "file"; onCreated(name: string): void };

interface Props {
  connections: ConnectionConfig[];
  openIds: ReadonlySet<string>;
  target: FromDatabaseTarget;
  onBack?(): void;
  onClose(): void;
}

/**
 * From my database: one schema's tables read into an ERD frame, or into a new diagram file. It only reads the
 * database. The Connection, Database and Schema pickers are the Schema Builder's start dialog's.
 */
export default function FromDatabaseDialog({ connections, openIds, target, onBack, onClose }: Props) {
  const src = useSchemaSource(connections, openIds);
  const { connection, database, schema } = src;
  const [busy, setBusy] = useState(false);
  /** A read is running: a second press before the first renders does nothing (`busy` lags a render). */
  const running = useRef(false);
  /** False once the dialog is gone (Cancel, Esc): a read still running then adds, writes and says nothing. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const pg = connection?.dialect === "postgres";
  const canRun = !!connection && !!database && !busy && !(pg && !schema);
  const open_ = connections.filter((c) => openIds.has(c.id));

  async function read() {
    if (!canRun || !connection || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const s = pg ? schema || null : null;
      const model = await schemaSnapshot(connection.id, database, s);
      if (!alive.current) return;
      const out = modelToErFrame(model, databaseTitle(connection.dialect, database, s));
      if ("refused" in out) return setError(out.refused);
      if (target.kind === "frame") {
        const why = await target.add.run(out);
        if (!alive.current) return;
        if (why !== null) return setError(why);
      } else {
        const taken = (await listDiagrams()).map((d) => d.name);
        if (!alive.current) return;
        const name = await writeFreeDiagram(out.title, taken, () => out.text, serializeFlowLayout(parseFlowLayout(null, "er")));
        if (!alive.current) return;
        target.onCreated(name);
        return;
      }
      onClose();
    } catch (e) {
      if (alive.current) setError(errorText(e, connection.dialect));
    } finally {
      running.current = false;
      setBusy(false);
    }
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
  const shown = error ?? src.error;

  return (
    <Dialog
      title="From my database"
      subtitle={`Reads one schema's tables into ${target.kind === "frame" ? "an ERD frame" : "a new diagram"}. Nothing in the database changes.`}
      icon="database"
      size="model"
      onClose={onClose}
    >
      <div
        className="dialog-body model-body"
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.defaultPrevented || (e.target as HTMLElement).closest("button, [role=option], [role=switch]")) return;
          e.preventDefault();
          void read();
        }}
      >
        <div className="model-fields">
          {open_.length === 0 ? (
            <p className="muted">Open a Connection to read its schema.</p>
          ) : (
            <>
              <div className="model-row">
                <span className="model-label">Connection</span>
                <Select label="Connection" value={src.connectionId} options={connectionOptions} onChange={src.setConnectionId} />
              </div>
              {src.connectionId && src.databases === null && <p className="muted">Loading databases...</p>}
              {src.databases && (
                <>
                  <div className="model-row">
                    <span className="model-label">Database</span>
                    <div className="model-pick">
                      <Select
                        label="Database"
                        mono
                        value={src.database}
                        options={src.visibleDatabases.map((d) => ({ value: d, label: d, lead: <Icon name="database" size={14} /> }))}
                        onChange={src.setDatabase}
                      />
                      {src.tableCount !== null && <span className="model-count">{`${src.tableCount.toLocaleString("en-US")} ${src.tableCount === 1 ? "table" : "tables"}`}</span>}
                    </div>
                  </div>
                  {pg && src.database && src.schemas && (
                    <div className="model-row">
                      <span className="model-label">Schema</span>
                      <Select label="Schema" mono value={src.schema} options={src.schemas.map((s) => ({ value: s, label: s }))} onChange={src.setSchema} />
                    </div>
                  )}
                  <div className="model-row">
                    <span />
                    <Switch label="Show system databases" checked={src.showSystem} onChange={src.setShowSystem} />
                  </div>
                </>
              )}
            </>
          )}
        </div>
        {shown && (
          <p className="error-text" role="alert">
            {shown}
          </p>
        )}
      </div>
      <footer className="dialog-footer">
        {onBack && (
          <button type="button" className="button" onClick={onBack}>
            Back
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="button" onClick={onClose}>
          Cancel
          <Kbd keys="Esc" />
        </button>
        <button type="button" className="button button-primary" disabled={!canRun} onClick={() => void read()}>
          <Icon name="database" size={14} />
          {busy ? "Reading..." : "Read the database"}
          <Kbd keys="Enter" />
        </button>
      </footer>
    </Dialog>
  );
}
