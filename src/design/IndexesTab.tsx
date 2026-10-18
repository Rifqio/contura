import CellEditor from "../components/CellEditor";
import Icon from "../components/Icon";
import ColumnPicker from "./ColumnPicker";
import { type Draft, type DraftIndex, type IndexPatch, fixedIndex, indexEdited, namesToRefs, refNames } from "./draft";

/** A name being edited in the Indexes or Foreign keys grid. */
export interface NameEdit {
  id: string;
  initial: string;
}

export interface RowGridProps {
  draft: Draft;
  /** Read-only: every control drawn, none usable (D20). */
  readOnly: boolean;
  selected: string | null;
  editing: NameEdit | null;
  onSelect(id: string): void;
  onOpen(id: string): void;
  onCommit(value: string, move: "down" | "right" | "none", blurred?: boolean): void;
  onCancel(): void;
  onInput(value: string): void;
  onSave(value: string): void;
}

interface Props extends RowGridProps {
  onChange(id: string, patch: IndexPatch): void;
}

/**
 * The attributes the Core's `unsupported` note gives an advanced index or key, such as
 * "include columns, descending order" from `index orders_ix (include columns, descending order)`.
 */
export function advancedAttributes(draft: Draft, kind: "index" | "foreign key", name: string | null): string | null {
  if (name === null) return null;
  const head = `${kind} ${name} (`;
  const item = draft.base?.unsupported.find((u) => u.startsWith(head) && u.endsWith(")"));
  return item ? item.slice(head.length, -1) : null;
}

/** The kept columns' names, offered by the column pickers. */
export function columnOptions(draft: Draft): string[] {
  return draft.columns.filter((c) => !draft.removed.includes(c.id) && c.name !== "").map((c) => c.name);
}

/** Whether the Name cell of an index can be edited: not the primary key (it follows the Key toggles). */
export function indexNameEditable(i: DraftIndex, readOnly: boolean): boolean {
  return !readOnly && !i.primary;
}

function note(draft: Draft, i: DraftIndex): string | null {
  const attrs = i.advanced ? advancedAttributes(draft, "index", i.origin) : null;
  if (i.primary) return attrs ? `Not editable here: ${attrs}` : null;
  if (!fixedIndex(i)) return null;
  return attrs ? `Only rename or remove: ${attrs}` : "Only rename or remove";
}

/** The Indexes tab: the primary key first, then one row per index (D17). */
export default function IndexesTab({
  draft,
  readOnly,
  selected,
  editing,
  onSelect,
  onOpen,
  onChange,
  onCommit,
  onCancel,
  onInput,
  onSave,
}: Props) {
  const options = columnOptions(draft);
  return (
    <table className="grid design-grid" role="grid" aria-label={`Indexes of ${draft.path.name || "the new table"}`}>
      <thead>
        <tr>
          <th className="row-number" aria-hidden="true" />
          <th>
            <span className="header-static">Name</span>
          </th>
          <th>
            <span className="header-static">Columns</span>
          </th>
          <th className="design-center">
            <span className="header-static">Unique</span>
          </th>
          <th>
            <span className="header-static">Method</span>
          </th>
          <th>
            <span className="header-static">Where</span>
          </th>
          <th className="design-fill" aria-hidden="true" />
        </tr>
      </thead>
      <tbody>
        {draft.indexes.map((i, n) => {
          const fixed = readOnly || i.primary || fixedIndex(i);
          const edited = indexEdited(draft, i);
          const isSelected = selected === i.id;
          const mark = (on: boolean, ...more: (string | false)[]) =>
            [on && "cell-edited", ...more].filter(Boolean).join(" ") || undefined;
          const text = note(draft, i);
          return (
            <tr key={i.id} className={i.origin === null ? "row-added" : undefined} aria-selected={isSelected}>
              <td className="row-number">{i.origin === null ? "+" : n + 1}</td>
              <td
                data-field="name"
                className={mark(edited.name, isSelected && "cell-selected")}
                onMouseDown={() => onSelect(i.id)}
                onDoubleClick={() => indexNameEditable(i, readOnly) && onOpen(i.id)}
              >
                {editing?.id === i.id ? (
                  <CellEditor
                    initial={editing.initial}
                    multiline={false}
                    onCommit={onCommit}
                    onCancel={onCancel}
                    onInput={onInput}
                    onSave={onSave}
                  />
                ) : (
                  <span className="design-name">
                    {i.primary && <Icon name="key" size={14} className="design-name-key" />}
                    {i.name}
                  </span>
                )}
              </td>
              <td data-field="columns" className={mark(edited.columns, "design-ui")} onMouseDown={() => onSelect(i.id)}>
                <ColumnPicker
                  label={`Columns of ${i.name || "the index"}`}
                  value={refNames(draft, i.columns)}
                  options={options}
                  disabled={fixed}
                  onChange={(names) => onChange(i.id, { columns: namesToRefs(draft, names, i.columns) })}
                />
              </td>
              <td data-field="unique" className={mark(edited.unique, "design-center")} onMouseDown={() => onSelect(i.id)}>
                <input
                  type="checkbox"
                  className="design-check"
                  aria-label={`Unique ${i.name}`.trim()}
                  checked={i.unique}
                  disabled={fixed}
                  onChange={() => onChange(i.id, { unique: !i.unique })}
                />
              </td>
              <td data-field="method" className="design-muted" onMouseDown={() => onSelect(i.id)}>
                {i.method ?? ""}
              </td>
              <td data-field="where" onMouseDown={() => onSelect(i.id)}>
                {i.predicate === null ? "" : <span className="design-code">{i.predicate}</span>}
              </td>
              <td className="design-fill design-row-note" onMouseDown={() => onSelect(i.id)}>
                {text}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
