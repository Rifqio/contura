import type { SqlTable } from "../api/types";
import CellEditor from "../components/CellEditor";
import Select from "../components/Select";
import ColumnPicker from "./ColumnPicker";
import { type DraftForeignKey, type ForeignKeyPatch, action, foreignKeyEdited, namesToRefs, refNames, sameTable } from "./draft";
import { type RowGridProps, advancedAttributes, columnOptions } from "./IndexesTab";

interface Props extends RowGridProps {
  /** The database's tables from the schema cache; null while it loads. */
  tables: SqlTable[] | null;
  onChange(id: string, patch: ForeignKeyPatch): void;
}

export const ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"] as const;
const ACTION_OPTIONS = ACTIONS.map((a) => ({ value: a as string, label: a }));

/** The table list's value for a table: schema and name, which no name can fake. */
const tableValue = (schema: string | null, name: string) => JSON.stringify([schema, name]);

export function foreignKeyNameEditable(k: DraftForeignKey, readOnly: boolean): boolean {
  return !readOnly && !k.advanced;
}

/** The Foreign keys tab: one row per key, its References cell a table and its columns (D18). */
export default function ForeignKeysTab({
  draft,
  readOnly,
  tables,
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
  /** "customers", or "sales.customers" for a table in another schema. */
  const tableLabel = (schema: string | null, name: string) =>
    schema !== null && schema !== draft.path.schema ? `${schema}.${name}` : name;

  function references(k: DraftForeignKey, editable: boolean) {
    const targets = refNames(draft, k.targetColumns);
    const label = tableLabel(k.target.schema, k.target.name);
    if (!editable) return k.target.name === "" ? "" : `${label} (${targets.join(", ")})`;
    const self = sameTable(draft.path, k.target);
    const list: { value: string; label: string; disabled?: boolean }[] = (tables ?? []).map((t) => ({
      value: tableValue(t.schema, t.name),
      label: tableLabel(t.schema, t.name),
    }));
    // A target with no schema is in the table's own schema (PostgreSQL "public" as a rule), as the Core reads it.
    const schema = k.target.schema ?? draft.path.schema;
    const current = tableValue(schema, k.target.name);
    if (k.target.name === "") list.unshift({ value: current, label: "Pick a table", disabled: true });
    else if (!list.some((o) => o.value === current)) list.unshift({ value: current, label });
    const known = tables?.find((t) => t.name === k.target.name && t.schema === schema);
    const targetOptions = self ? options : (known?.columns.map((c) => c.name) ?? targets);
    return (
      <span className="design-references">
        <Select
          value={current}
          options={list}
          label={`Referenced table for ${k.name}`}
          mono
          onChange={(v) => {
            const [schema, name] = JSON.parse(v) as [string | null, string];
            onChange(k.id, { target: { database: draft.path.database, schema, name } });
          }}
        />
        <ColumnPicker
          label={`Referenced columns of ${k.name}`}
          value={targets}
          options={targetOptions}
          onChange={(names) => onChange(k.id, { targetColumns: namesToRefs(draft, names, k.targetColumns, self) })}
        />
      </span>
    );
  }

  return (
    <table className="grid design-grid" role="grid" aria-label={`Foreign keys of ${draft.path.name || "the new table"}`}>
      <thead>
        <tr>
          <th className="row-number" aria-hidden="true" />
          {["Name", "Columns", "References", "On delete", "On update"].map((h) => (
            <th key={h}>
              <span className="header-static">{h}</span>
            </th>
          ))}
          <th className="design-fill" aria-hidden="true" />
        </tr>
      </thead>
      <tbody>
        {draft.foreignKeys.map((k, n) => {
          const fixed = readOnly || k.advanced;
          const edited = foreignKeyEdited(draft, k);
          const isSelected = selected === k.id;
          const mark = (on: boolean, ...more: (string | false)[]) =>
            [on && "cell-edited", ...more].filter(Boolean).join(" ") || undefined;
          const attrs = k.advanced ? advancedAttributes(draft, "foreign key", k.origin) : null;
          const pick = () => onSelect(k.id);
          return (
            <tr key={k.id} className={k.origin === null ? "row-added" : undefined} aria-selected={isSelected}>
              <td className="row-number">{k.origin === null ? "+" : n + 1}</td>
              <td
                data-field="name"
                className={mark(edited.name, isSelected && "cell-selected")}
                onMouseDown={pick}
                onDoubleClick={() => foreignKeyNameEditable(k, readOnly) && onOpen(k.id)}
              >
                {editing?.id === k.id ? (
                  <CellEditor
                    initial={editing.initial}
                    multiline={false}
                    onCommit={onCommit}
                    onCancel={onCancel}
                    onInput={onInput}
                    onSave={onSave}
                  />
                ) : (
                  k.name
                )}
              </td>
              <td data-field="columns" className={mark(edited.columns, "design-ui")} onMouseDown={pick}>
                <ColumnPicker
                  label={`Columns of ${k.name || "the foreign key"}`}
                  value={refNames(draft, k.columns)}
                  options={options}
                  disabled={fixed}
                  onChange={(names) => onChange(k.id, { columns: namesToRefs(draft, names, k.columns) })}
                />
              </td>
              <td data-field="references" className={mark(edited.references)} onMouseDown={pick}>
                {references(k, isSelected && !fixed)}
              </td>
              {(["onDelete", "onUpdate"] as const).map((field) => (
                <td key={field} data-field={field} className={mark(edited[field], "design-ui")} onMouseDown={pick}>
                  <Select
                    value={action(k[field])}
                    options={ACTION_OPTIONS}
                    label={`${field === "onDelete" ? "On delete" : "On update"} for ${k.name}`}
                    disabled={fixed}
                    onChange={(v) => onChange(k.id, { [field]: v })}
                  />
                </td>
              ))}
              <td className="design-fill design-row-note" onMouseDown={pick}>
                {k.advanced ? (attrs ? `Only remove: ${attrs}` : "Only remove") : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
