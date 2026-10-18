import { Handle, type NodeProps, Position } from "@xyflow/react";
import { useState } from "react";
import Icon from "../components/Icon";
import type { DialectKind, SmColumn, SmTable } from "../api/types";
import CardFrame from "../diagram/CardFrame";
import InlineAsk from "../assistant/InlineAsk";
import type { AskContext, AskKit } from "../assistant/context";
import { DIALECT_TYPES } from "../lang/dialectTypes";
import {
  addColumn,
  type ColumnSetting,
  renameColumn,
  renameTable,
  setColumnSetting,
  setColumnType,
} from "../lang/dbml/edits";
import type { Ranges, TextEdit } from "../lang/protocol";

export type MakeEdits = (text: string, ranges: Ranges) => TextEdit[];

export type TableCardData = {
  table: SmTable;
  tableKey: string;
  dialect: DialectKind;
  /** Columns on the many side of a Ref. */
  fkColumns: string[];
  blocked: boolean;
  onEdit: (make: MakeEdits) => void;
  /** Ask AI about this card: the model's DBML and name; absent, the menu has no Ask AI. */
  ask?: { getDbml(): string; label: string; kit: AskKit; connection?: AskContext["connection"]; tables: { schema: string | null; name: string }[] };
};

const SETTINGS: { setting: ColumnSetting; label: string; on: (c: SmColumn) => boolean }[] = [
  { setting: "pk", label: "Primary key", on: (c) => c.pk },
  { setting: "increment", label: "Increment", on: (c) => c.increment },
  { setting: "not null", label: "Not null", on: (c) => c.notNull },
  { setting: "unique", label: "Unique", on: (c) => c.unique },
];

/** A label that becomes an input on double-click or Enter; Enter commits, Esc cancels. */
function Editable({
  value,
  label,
  className,
  disabled,
  onCommit,
}: {
  value: string;
  label: string;
  className: string;
  disabled: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null && !disabled) {
    return (
      <input
        className={`${className} card-input nodrag`}
        aria-label={label}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = draft.trim();
            setDraft(null);
            if (v && v !== value) onCommit(v);
          } else if (e.key === "Escape") setDraft(null);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={`${className} card-text`}
      aria-label={label}
      aria-disabled={disabled || undefined}
      onDoubleClick={() => !disabled && setDraft(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !disabled) {
          e.preventDefault();
          setDraft(value);
        }
      }}
    >
      {value}
    </button>
  );
}

export default function TableCard({ data, selected }: NodeProps & { data: TableCardData }) {
  const { table, tableKey: key, blocked, onEdit, fkColumns, dialect, ask: askData } = data;
  const [menu, setMenu] = useState(false);
  const [ask, setAsk] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const pkIndex = table.indexes.find((i) => i.pk);

  const actions = (
    <>
      <button
        type="button"
        className="icon-button nodrag"
        aria-label="Table actions"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((m) => !m)}
      >
        ⋯
      </button>
      {menu && (
        <div className="menu card-menu nodrag" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenu(false)}>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={blocked}
            onClick={() => {
              setMenu(false);
              const used = new Set(table.columns.map((c) => c.name));
              let name = "new_column";
              for (let n = 2; used.has(name); n++) name = `new_column_${n}`;
              onEdit((t, r) => addColumn(t, r, key, name, DIALECT_TYPES[dialect][0]));
            }}
          >
            Add column
          </button>
          {askData && (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setMenu(false);
                setAsk(true);
              }}
            >
              Ask AI
            </button>
          )}
        </div>
      )}
      {ask && askData && (
        <div className="card-ask nodrag nowheel">
          <InlineAsk
            context={{
              kind: "card",
              connection: askData.connection ?? null,
              dbml: askData.getDbml(),
              tables: askData.tables,
              label: askData.label,
            }}
            schema={null}
            groupId={askData.kit.groupId}
            onOpenInChat={askData.kit.onOpenInChat}
            onOpenSettings={askData.kit.onOpenSettings}
            onClose={() => setAsk(false)}
          />
        </div>
      )}
    </>
  );

  return (
    <CardFrame
      kind="table"
      label={`Table ${table.name}`}
      name={table.name}
      title={
        <>
          <Editable
            value={table.name}
            label={`Table name ${table.name}`}
            className="table-card-name"
            disabled={blocked}
            onCommit={(v) => onEdit((t, r) => renameTable(t, r, key, v))}
          />
          {table.alias && <span className="table-card-alias">as {table.alias}</span>}
        </>
      }
      subtitle={table.schema || undefined}
      count={table.columns.length}
      selected={!!selected}
      actions={actions}
      rows={table.columns.map((c) => {
        const pk = c.pk || !!pkIndex?.columns.includes(c.name);
        return (
          <li key={c.name} className="table-card-column">
            <Handle type="target" id={`${c.name}:t`} position={Position.Left} isConnectable={!blocked} />
            {/* Edge ends only: an edge leaves or enters on the side facing the other card (edgeSides). */}
            <Handle type="source" id={`${c.name}:sl`} position={Position.Left} isConnectable={false} className="edge-anchor" />
            <span className={pk ? "table-card-key table-card-pk" : "table-card-key"}>
              {pk ? <Icon name="key" size={14} /> : fkColumns.includes(c.name) ? <Icon name="link" size={14} /> : null}
            </span>
            <span className="table-card-col-main">
              <Editable
                value={c.name}
                label={`Column ${c.name}`}
                className="table-card-col-name"
                disabled={blocked}
                onCommit={(v) => onEdit((t, r) => renameColumn(t, r, key, c.name, v))}
              />
            </span>
            <span className="table-card-col-end">
              <Editable
                value={c.typeName}
                label={`Type of ${c.name}`}
                className="table-card-col-type"
                disabled={blocked}
                onCommit={(v) => onEdit((t, r) => setColumnType(t, r, key, c.name, v))}
              />
              {!c.notNull && !pk && <span className="table-card-nullable">?</span>}
              <button
                type="button"
                className="icon-button nodrag table-card-settings"
                aria-label={`Settings of ${c.name}`}
                disabled={blocked}
                onClick={() => setSettingsFor((s) => (s === c.name ? null : c.name))}
              >
                ⚙
              </button>
            </span>
            <span aria-hidden="true" />
            {settingsFor === c.name && (
              <div className="card-popover nodrag" role="dialog" aria-label={`Settings of ${c.name}`}>
                {SETTINGS.map((s) => (
                  <label key={s.setting} className="checkbox">
                    <input
                      type="checkbox"
                      checked={s.on(c)}
                      onChange={(e) =>
                        onEdit((t, r) => setColumnSetting(t, r, key, c.name, s.setting, e.target.checked))
                      }
                    />
                    {s.label}
                  </label>
                ))}
              </div>
            )}
            <Handle type="source" id={`${c.name}:s`} position={Position.Right} isConnectable={!blocked} />
            <Handle type="target" id={`${c.name}:tr`} position={Position.Right} isConnectable={false} className="edge-anchor" />
          </li>
        );
      })}
    />
  );
}
