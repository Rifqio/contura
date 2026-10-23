import type { ColumnMap, PlannedColumn } from "../api/types";
import Select, { type SelectOption } from "../components/Select";
import { NullMark } from "../prefs/gridDisplay";

interface Props {
  /** The file's column names, as the Core gives them ("Column 1", "name (2)"). */
  header: string[];
  /** The file's first data row. */
  first: (string | null)[];
  mapping: ColumnMap[];
  /** The table's columns from the plan. */
  targets: PlannedColumn[];
  onChange(fileColumn: number, into: string | null): void;
}

const NOT_IMPORTED = "";

/** File column, First value, Into column (F2), Type, Note: one row per file column. */
export default function MappingTable({ header, first, mapping, targets, onChange }: Props) {
  // Generated columns are filled by the database: never offered (spec).
  const options: SelectOption<string>[] = [
    { value: NOT_IMPORTED, label: "Not imported" },
    ...targets.filter((t) => !t.generated).map((t) => ({ value: t.into, label: t.into, hint: t.typeSql })),
  ];
  return (
    <table className="import-mapping" aria-label="Columns">
      <thead>
        <tr>
          <th scope="col">File column</th>
          <th scope="col">First value</th>
          <th scope="col">Into column</th>
          <th scope="col">Type</th>
          <th scope="col">Note</th>
        </tr>
      </thead>
      <tbody>
        {header.map((name, i) => {
          const m = mapping.find((x) => x.fileColumn === i);
          const into = m?.into ?? null;
          const target = into === null ? undefined : targets.find((t) => t.into === into);
          const value = first[i];
          const note = into === null ? "Not imported" : (target?.note ?? (m?.byHand ? "By hand" : ""));
          return (
            <tr key={i} data-file-column={i} className={into === null ? "import-mapping-off" : undefined}>
              <th scope="row" className="import-mapping-file">
                {name}
              </th>
              <td className="import-mapping-first" title={value === null || value === undefined ? "NULL" : undefined}>
                {value === null || value === undefined ? <NullMark className="import-null" /> : value}
              </td>
              <td className="import-mapping-into">
                <Select
                  label={`Into column for ${name}`}
                  value={into ?? NOT_IMPORTED}
                  options={options}
                  mono
                  onChange={(v) => onChange(i, v === NOT_IMPORTED ? null : v)}
                />
              </td>
              <td className="import-mapping-type">{target?.typeSql ?? ""}</td>
              <td className="import-mapping-note">{note}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
