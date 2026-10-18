import { useId } from "react";
import type { DialectKind } from "../api/types";
import CellEditor from "../components/CellEditor";
import Icon from "../components/Icon";
import {
  type ColumnField,
  type Draft,
  type DraftColumn,
  columnMark,
  editedFields,
  foreignKeyColumns,
  primaryColumns,
  primaryFixed,
} from "./draft";
import { typeSuggestions } from "./typeSuggestions";

/** A cell of the Columns grid; `key` is the primary key toggle, not a draft field. */
export type ColumnCell = "name" | "type" | "nullable" | "default" | "increment" | "key" | "comment";

/** The draft field behind each cell that holds one. */
export const CELL_FIELD: Partial<Record<ColumnCell, ColumnField>> = {
  name: "name",
  type: "typeSql",
  nullable: "nullable",
  default: "defaultSql",
  increment: "increment",
  comment: "comment",
};

/** Cells edited as text; the others toggle. */
export const TEXT_CELLS: ColumnCell[] = ["name", "type", "default", "comment"];

const HEADS: Record<ColumnCell, string> = {
  name: "Name",
  type: "Type",
  nullable: "Nullable",
  default: "Default",
  increment: "Auto-increment",
  key: "Key",
  comment: "Comment",
};

/** D16: the order of the Columns grid; SQLite keeps no column comments. */
export function columnCells(dialect: DialectKind): ColumnCell[] {
  const all: ColumnCell[] = ["name", "type", "nullable", "default", "increment", "key", "comment"];
  return dialect === "sqlite" ? all.filter((c) => c !== "comment") : all;
}

const SERIAL_TIP = "Serial column: change its default instead.";
const FK_TIP = "In a Foreign Key. Change it on the Foreign keys tab.";

export interface CellAt {
  id: string;
  cell: ColumnCell;
}

interface Props {
  draft: Draft;
  dialect: DialectKind;
  /** Read-only: every control drawn, none usable (D20). */
  readOnly: boolean;
  selected: CellAt | null;
  editing: (CellAt & { initial: string }) | null;
  onSelect(at: CellAt): void;
  onOpen(at: CellAt): void;
  onToggle(at: CellAt): void;
  onCommit(value: string, move: "down" | "right" | "none", blurred?: boolean): void;
  onCancel(): void;
  onInput(value: string): void;
  onSave(value: string): void;
}

/** Whether a cell of this column can change: not on a removed row; an advanced column only takes a new name. */
export function cellEditable(draft: Draft, c: DraftColumn, cell: ColumnCell, readOnly: boolean): boolean {
  if (readOnly || draft.removed.includes(c.id)) return false;
  const loaded = c.origin === null ? null : draft.base?.columns.find((x) => x.name === c.origin);
  if (loaded?.advanced && cell !== "name") return false;
  if (cell === "increment" && loaded?.increment.kind === "serial") return false;
  if (cell === "key" && (c.name === "" || primaryFixed(draft))) return false;
  return true;
}

/** The Columns tab: one row per column, edited in place like the data grid. */
export default function ColumnsTab({
  draft,
  dialect,
  readOnly,
  selected,
  editing,
  onSelect,
  onOpen,
  onToggle,
  onCommit,
  onCancel,
  onInput,
  onSave,
}: Props) {
  const listId = `${useId()}-types`;
  const cells = columnCells(dialect);
  const pk = primaryColumns(draft);
  const fk = foreignKeyColumns(draft);

  function text(c: DraftColumn, cell: ColumnCell) {
    if (cell === "name") return c.name;
    if (cell === "type") return <span className="design-type">{c.typeSql}</span>;
    if (cell === "default") return c.defaultSql === null ? "" : <span className="design-code">{c.defaultSql}</span>;
    if (cell === "comment") return c.comment ?? "";
    return null;
  }

  function toggle(c: DraftColumn, cell: ColumnCell) {
    const can = cellEditable(draft, c, cell, readOnly);
    const at = { id: c.id, cell };
    if (cell === "key") {
      const on = pk.has(c.id);
      return (
        <span className="design-key">
          <button
            type="button"
            className="design-key-toggle"
            aria-label="Primary key"
            aria-pressed={on}
            title="Primary key"
            disabled={!can}
            onClick={() => onToggle(at)}
          >
            {on && <Icon name="key" size={14} />}
          </button>
          {fk.has(c.id) && (
            <span className="design-fk" role="img" aria-label="In a Foreign Key" title={FK_TIP}>
              <Icon name="link" size={14} />
            </span>
          )}
        </span>
      );
    }
    const checked = cell === "nullable" ? c.nullable : c.increment;
    const serial = cell === "increment" && draft.base?.columns.find((x) => x.name === c.origin)?.increment.kind === "serial";
    return (
      <input
        type="checkbox"
        className="design-check"
        aria-label={`${HEADS[cell]} ${c.name}`.trim()}
        title={serial ? SERIAL_TIP : undefined}
        checked={checked}
        disabled={!can}
        onChange={() => onToggle(at)}
      />
    );
  }

  return (
    <table className="grid design-grid" role="grid" aria-label={`Columns of ${draft.path.name || "the new table"}`}>
      <thead>
        <tr>
          <th className="row-number" aria-hidden="true" />
          {cells.map((cell) => (
            <th key={cell} className={TEXT_CELLS.includes(cell) ? undefined : "design-center"}>
              <span className="header-static">{HEADS[cell]}</span>
            </th>
          ))}
          <th className="design-fill" aria-hidden="true" />
        </tr>
      </thead>
      <tbody>
        {draft.columns.map((c, i) => {
          const mark = columnMark(draft, c.id);
          const edited = new Set(editedFields(draft, c.id));
          return (
            <tr key={c.id} className={mark === "cell-edited" ? undefined : (mark ?? undefined)} aria-selected={selected?.id === c.id}>
              <td className="row-number">{c.origin === null ? "+" : i + 1}</td>
              {cells.map((cell) => {
                const field = CELL_FIELD[cell];
                const isEditing = editing?.id === c.id && editing.cell === cell;
                const isSelected = selected?.id === c.id && selected.cell === cell;
                const className = [
                  field && edited.has(field) && "cell-edited",
                  isSelected && "cell-selected",
                  !TEXT_CELLS.includes(cell) && "design-center",
                  cell === "comment" && "design-ui",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td
                    key={cell}
                    data-field={cell}
                    className={className || undefined}
                    onMouseDown={() => onSelect({ id: c.id, cell })}
                    onDoubleClick={() => TEXT_CELLS.includes(cell) && onOpen({ id: c.id, cell })}
                  >
                    {isEditing && editing ? (
                      <CellEditor
                        initial={editing.initial}
                        multiline={false}
                        onCommit={onCommit}
                        onCancel={onCancel}
                        onInput={onInput}
                        onSave={onSave}
                        suggestions={cell === "type" ? { id: listId, values: typeSuggestions(dialect) } : undefined}
                      />
                    ) : TEXT_CELLS.includes(cell) ? (
                      text(c, cell)
                    ) : (
                      toggle(c, cell)
                    )}
                  </td>
                );
              })}
              <td className="design-fill" />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
