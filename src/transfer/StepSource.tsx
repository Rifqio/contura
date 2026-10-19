import { useEffect, useState } from "react";
import { errorText, listDatabases, listSchemas } from "../api/client";
import type { ConnectionConfig, ConnectionId, Group, TransferSide } from "../api/types";
import DbMark from "../components/DbMark";
import GroupBadge from "../components/GroupBadge";
import Icon from "../components/Icon";
import Select, { type SelectOption } from "../components/Select";
import { targetOptionHint } from "./transferModel";

/** The value of the "New ..." entry in a database or schema list. */
const NEW = "\u0000new";

interface Scopes {
  databases: string[];
  schemas: string[];
  error: string | null;
}

/** The databases of a Connection and, on PostgreSQL, the schemas of the chosen database. */
function useScopes(connection: ConnectionConfig | null, database: string): Scopes {
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const id = connection?.id ?? null;
  const pg = connection?.dialect === "postgres";
  useEffect(() => {
    setDatabases([]);
    setError(null);
    if (!id) return;
    let live = true;
    listDatabases(id).then(
      (list) => live && setDatabases(list),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    setSchemas([]);
    if (!id || !pg || !database) return;
    let live = true;
    listSchemas(id, database).then(
      (list) => live && setSchemas(list.filter((s) => !s.isSystem).map((s) => s.name)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id, pg, database]);
  return { databases, schemas, error };
}

interface EndProps {
  label: "From" | "To";
  connections: ConnectionConfig[];
  groups: Group[];
  side: TransferSide | null;
  hint: string | null;
  /** The target end offers new databases and schemas, and greys out Read-only Connections. */
  target: boolean;
  onChange(side: TransferSide | null): void;
}

function End({ label, connections, groups, side, hint, target, onChange }: EndProps) {
  const connection = connections.find((c) => c.id === side?.connectionId) ?? null;
  const pg = connection?.dialect === "postgres";
  const { databases, schemas, error } = useScopes(connection, side?.database ?? "");
  const [naming, setNaming] = useState<"database" | "schema" | null>(null);
  const [name, setName] = useState("");

  const options: SelectOption<string>[] = [
    { value: "", label: target ? "Pick where the rows go" : "Pick a Connection", disabled: true },
    ...connections.map((c) => {
      const group = groups.find((g) => g.id === c.groupId) ?? null;
      return {
        value: c.id,
        label: c.name,
        lead: <DbMark dialect={c.dialect} open size={14} label={null} />,
        trail: group ? <GroupBadge name={group.name} color={group.color} id={group.id} /> : undefined,
        hint: target ? targetOptionHint(c) : undefined,
        disabled: target && c.readOnly,
      };
    }),
  ];

  const pick = (id: ConnectionId) => {
    const c = connections.find((x) => x.id === id);
    if (!c) return;
    setNaming(null);
    onChange({ connectionId: c.id, database: c.dialect === "sqlite" ? "main" : "", schema: null });
  };

  const listed = (list: string[], current: string | null) => (current && !list.includes(current) ? [...list, current] : list);
  const dbOptions: SelectOption<string>[] = [
    { value: "", label: "Database", disabled: true },
    ...listed(databases, side?.database || null).map((d) => ({ value: d, label: d })),
    ...(target && connection?.dialect === "mysql" ? [{ value: NEW, label: "New database..." }] : []),
  ];
  const schemaOptions: SelectOption<string>[] = [
    { value: "", label: "Schema", disabled: true },
    ...listed(schemas, side?.schema ?? null).map((s) => ({ value: s, label: `schema ${s}` })),
    ...(target ? [{ value: NEW, label: "New schema..." }] : []),
  ];

  const commitName = () => {
    const v = name.trim();
    if (!side || !v || !naming) return;
    onChange(naming === "database" ? { ...side, database: v, schema: null } : { ...side, schema: v });
    setNaming(null);
    setName("");
  };

  return (
    <div className="transfer-end">
      <span className="transfer-end-label">{label}</span>
      <div className="transfer-end-row">
        <Select label={label === "From" ? "Source Connection" : "Target Connection"} value={side?.connectionId ?? ""} options={options} onChange={pick} />
        {connection && connection.dialect !== "sqlite" && (
          <Select
            label={label === "From" ? "Source database" : "Target database"}
            mono
            value={side?.database ?? ""}
            options={dbOptions}
            onChange={(d) => {
              if (!side) return;
              if (d === NEW) setNaming("database");
              else onChange({ ...side, database: d, schema: null });
            }}
          />
        )}
        {connection && pg && side?.database && (
          <Select
            label={label === "From" ? "Source schema" : "Target schema"}
            mono
            value={side.schema ?? ""}
            options={schemaOptions}
            onChange={(s) => {
              if (s === NEW) setNaming("schema");
              else onChange({ ...side, schema: s });
            }}
          />
        )}
      </div>
      {naming && (
        <div className="transfer-end-row">
          <input
            className="input mono"
            aria-label={naming === "database" ? "New database name" : "New schema name"}
            placeholder={naming === "database" ? "New database name" : "New schema name"}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                commitName();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setNaming(null);
              }
            }}
          />
          <button type="button" className="button button-small" onClick={commitName} disabled={!name.trim()}>
            Use
          </button>
        </div>
      )}
      {error ? <span className="transfer-hint transfer-hint-bad">{error}</span> : hint && <span className="transfer-hint">{hint}</span>}
    </div>
  );
}

interface Props {
  connections: ConnectionConfig[];
  groups: Group[];
  source: TransferSide;
  target: TransferSide | null;
  sourceHint: string | null;
  targetHint: string | null;
  /** The same-side refusal, under the ends. */
  error: string | null;
  onSource(side: TransferSide): void;
  onTarget(side: TransferSide | null): void;
}

/** Step 1 (frame 8.1): the source and target ends, also shown above the Tables step. */
export default function StepSource({ connections, groups, source, target, sourceHint, targetHint, error, onSource, onTarget }: Props) {
  return (
    <div className="transfer-ends-wrap">
      <div className="transfer-ends">
        <End label="From" connections={connections} groups={groups} side={source} hint={sourceHint} target={false} onChange={(s) => s && onSource(s)} />
        <span className="transfer-arrow" aria-hidden>
          <Icon name="arrowRight" />
        </span>
        <End label="To" connections={connections} groups={groups} side={target} hint={targetHint} target onChange={onTarget} />
      </div>
      {error && (
        <p className="transfer-hint transfer-hint-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
