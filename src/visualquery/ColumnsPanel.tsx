// The Columns tab: one row per output column in order, then the GROUP BY (Auto, or by hand).
import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Aggregate, ColumnRef, VisualQuery, VqProblem, VqSort } from "../api/types";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import Select from "../components/Select";
import Switch from "../components/Switch";
import { addSort, autoGroupBy, editSort, moveOutput, removeSort, setAggregate, setGroupBy, setOutputName, toggleColumn } from "./model";

type Change = (f: (q: VisualQuery) => VisualQuery) => void;

export interface ColumnsPanelProps {
  model: VisualQuery;
  /** The Core's final output names (D7), for the Output name placeholders. */
  outputs: string[];
  /** Problems on the Columns and the GROUP BY. */
  problems: VqProblem[];
  /** Each card's columns, by table id, for the GROUP BY list. */
  tableColumns: Record<string, string[]>;
  onChange: Change;
}

const AGGREGATES: { value: Aggregate | "none"; label: string }[] = [
  { value: "none", label: "None" },
  { value: "count", label: "Count" },
  { value: "countDistinct", label: "Count distinct" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Avg" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 21st. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const end = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${end}`;
}

/** Where the output's sort sits in ORDER BY: its output sort, else a sort on its column. */
function sortOf(q: VisualQuery, index: number): number {
  const c = q.columns[index];
  const byOutput = q.orderBy.findIndex((s) => s.target.kind === "output" && s.target.index === index);
  if (byOutput >= 0) return byOutput;
  return q.orderBy.findIndex((s) => s.target.kind === "column" && s.target.table === c.table && s.target.column === c.column && c.aggregate === null);
}

const handPicked = (q: VisualQuery): ColumnRef[] => (q.groupBy.kind === "manual" ? q.groupBy.columns : []);

/** The Output name: mono, the Core's name as the placeholder; kept on Enter or leaving the field. */
function OutputName({ value, placeholder, label, onCommit }: { value: string | null; placeholder: string; label: string; onCommit(v: string | null): void }) {
  const [draft, setDraft] = useState(value ?? "");
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value ?? "");
  }, [value]);
  const commit = () => {
    // Item 32: only a name the user typed is kept; leaving an untouched field never writes one.
    if (!editing.current) return;
    editing.current = false;
    const v = draft.trim();
    if (v !== (value ?? "")) onCommit(v === "" ? null : v);
  };
  return (
    <input
      className="input input-small vq-mono vq-col-name"
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => {
        editing.current = true;
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") {
          editing.current = false;
          setDraft(value ?? "");
        }
      }}
    />
  );
}

export default function ColumnsPanel({ model, outputs, problems, tableColumns, onChange }: ColumnsPanelProps) {
  const alias = (id: string) => model.tables.find((t) => t.id === id)?.alias ?? "?";
  const ref = (c: ColumnRef) => `${alias(c.table)}.${c.column}`;
  const [dragged, setDragged] = useState<number | null>(null);
  const grips = useRef(new Map<number, HTMLButtonElement>());
  const [focusAt, setFocusAt] = useState<number | null>(null);
  useEffect(() => {
    if (focusAt === null) return;
    grips.current.get(focusAt)?.focus();
    setFocusAt(null);
  }, [focusAt, model.columns]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= model.columns.length || from === to) return;
    onChange((q) => moveOutput(q, from, to));
  };
  const onGripKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const to = e.key === "ArrowUp" ? i - 1 : i + 1;
    if (to < 0 || to >= model.columns.length) return;
    move(i, to);
    setFocusAt(to);
  };
  const onDrop = (i: number) => (e: DragEvent) => {
    e.preventDefault();
    if (dragged !== null) move(dragged, i);
    setDragged(null);
  };

  const setSort = (i: number, dir: "none" | VqSort["dir"]) => {
    onChange((q) => {
      const at = sortOf(q, i);
      if (dir === "none") return at >= 0 ? removeSort(q, at) : q;
      return at >= 0 ? editSort(q, at, { dir }) : addSort(q, { target: { kind: "output", index: i }, dir });
    });
  };

  const manual = model.groupBy.kind === "manual" ? model.groupBy.columns : null;
  const auto = autoGroupBy(model);
  const groupChoices = model.tables.flatMap((t) =>
    (tableColumns[t.id] ?? [])
      .filter((c) => !manual?.some((m) => m.table === t.id && m.column === c))
      .map((c) => ({ value: `${t.id}\u0000${c}`, label: `${t.alias}.${c}` })),
  );
  const columnProblems = problems.filter((p) => p.target.kind === "columns");
  // The Core names no GROUP BY row, so its problems are matched by their words: a row with no column
  // is said under that row, the others under the section.
  const isRowProblem = (m: string) => m.startsWith("A GROUP BY row has no column");
  const groupProblems = problems.filter((p) => p.target.kind === "query" && p.message.startsWith("A GROUP BY") && !isRowProblem(p.message));
  const rowProblem = problems.find((p) => p.target.kind === "query" && isRowProblem(p.message))?.message ?? null;

  const groupBy = (model.columns.length > 0 || manual !== null) && (
    // Item 39: Group by and Edit by hand sit in the grid's footer bar.
    <section className="vq-box-foot vq-group" aria-label="Group by section">
      <div className="vq-group-head">
        <span className="vq-panel-label">Group by</span>
        {manual === null && (
          <>
            <span className="chip chip-neutral">Auto</span>
            {auto.length > 0 ? (
              <span className="vq-mono vq-group-auto">{auto.map(ref).join(", ")}</span>
            ) : (
              <span className="vq-group-auto">Nothing to group. No column has an aggregate.</span>
            )}
          </>
        )}
        <span className="spacer" />
        <Switch
          label="Edit by hand"
          checked={manual !== null}
          onChange={(on) => onChange((q) => setGroupBy(q, on ? { kind: "manual", columns: autoGroupBy(q) } : { kind: "auto" }))}
        />
      </div>
      {manual !== null && (
        <div className="vq-group-manual">
          <ul className="vq-group-list" aria-label="Group by">
            {manual.map((g, i) => (
              <li key={`${g.table}.${g.column}.${i}`} className="vq-group-row">
                <span className="vq-mono vq-group-name">{ref(g)}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${ref(g)} from Group by`}
                  title="Remove"
                  onClick={() => onChange((q) => setGroupBy(q, { kind: "manual", columns: handPicked(q).filter((_, k) => k !== i) }))}
                >
                  <Icon name="close" size={14} />
                </button>
                {!g.column && rowProblem && <p className="vq-problem">{rowProblem}</p>}
              </li>
            ))}
          </ul>
          <Select
            label="Add to Group by"
            value=""
            options={[{ value: "", label: "Add a column", disabled: true }, ...groupChoices]}
            onChange={(v) => {
              const [table, column] = v.split("\u0000");
              if (column !== undefined) onChange((q) => setGroupBy(q, { kind: "manual", columns: [...handPicked(q), { table, column }] }));
            }}
          />
        </div>
      )}
      {groupProblems.map((p) => (
        <p key={p.message} className="vq-problem">
          {p.message}
        </p>
      ))}
    </section>
  );

  return (
    <div className={model.columns.length === 0 ? "vq-columns vq-columns-none" : "vq-columns"}>
      {model.columns.length === 0 ? (
        // Item 38: centred in the panel.
        <div className="vq-panel-empty vq-columns-empty">
          <Icon name="check" size={20} className="vq-panel-empty-icon" />
          {/* Item 37: nothing ticked runs every column (SELECT *), as in Navicat. */}
          <p className="vq-panel-empty-title">All columns.</p>
          <p>Tick columns to choose them.</p>
          <p className="vq-panel-empty-keys">
            <Kbd keys="Space" /> ticks the column you are on
          </p>
        </div>
      ) : (
        // Item 39: a bordered grid with a header row and row separators on the panel surface, columns sized to
        // their content, Group by in a footer bar.
        <div className="vq-box vq-columns-box">
          <div className="vq-box-scroll">
            <table className="vq-grid">
              <colgroup>
                <col className="vq-grid-c-grip" />
                <col className="vq-grid-c-check" />
                <col className="vq-grid-c-name" />
                <col className="vq-grid-c-from" />
                <col className="vq-grid-c-agg" />
                <col className="vq-grid-c-sort" />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="Order" />
                  <th aria-label="Included" />
                  <th>Output name</th>
                  <th>From</th>
                  <th>Aggregate</th>
                  <th>Sort</th>
                  <th aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {model.columns.map((c, i) => {
                  const name = ref(c);
                  const at = sortOf(model, i);
                  const dir = at >= 0 ? model.orderBy[at].dir : "none";
                  const pos = at >= 0 ? `, ${ordinal(at + 1)}` : "";
                  return (
                    <tr
                      key={`${c.table}.${c.column}.${i}`}
                      className={dragged === i ? "vq-grid-row vq-grid-row-dragged" : "vq-grid-row"}
                      onDragOver={(e) => {
                        if (dragged === null) return;
                        e.preventDefault();
                        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={onDrop(i)}
                    >
                      <td>
                        <button
                          ref={(el) => {
                            if (el) grips.current.set(i, el);
                            else grips.current.delete(i);
                          }}
                          type="button"
                          className="icon-button vq-grip"
                          aria-label={`Move ${name}`}
                          title="Drag to reorder (Alt+ArrowUp, Alt+ArrowDown)"
                          draggable
                          onDragStart={(e) => {
                            setDragged(i);
                            if (e.dataTransfer) {
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", name);
                            }
                          }}
                          onDragEnd={() => setDragged(null)}
                          onKeyDown={onGripKey(i)}
                        >
                          <Icon name="grip" size={14} />
                        </button>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          className="vq-card-check"
                          aria-label={`Include ${name}`}
                          checked
                          onChange={() => onChange((q) => toggleColumn(q, c.table, c.column))}
                        />
                      </td>
                      <td>
                        <OutputName
                          value={c.alias}
                          placeholder={outputs[i] ?? c.column}
                          label={`Output name for ${name}`}
                          onCommit={(v) => onChange((q) => setOutputName(q, i, v))}
                        />
                      </td>
                      <td className="vq-col-from">{name}</td>
                      <td>
                        <Select
                          label={`Aggregate for ${name}`}
                          value={c.aggregate ?? "none"}
                          options={AGGREGATES}
                          onChange={(v) => onChange((q) => setAggregate(q, i, v === "none" ? null : v))}
                        />
                      </td>
                      <td>
                        <Select
                          label={`Sort for ${name}`}
                          value={dir}
                          options={[
                            { value: "none", label: "None" },
                            { value: "asc", label: `Ascending${dir === "asc" ? pos : ""}` },
                            { value: "desc", label: `Descending${dir === "desc" ? pos : ""}` },
                          ]}
                          onChange={(v) => setSort(i, v)}
                        />
                      </td>
                      <td aria-hidden="true" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {groupBy}
        </div>
      )}
      {model.columns.length === 0 && groupBy && <div className="vq-box">{groupBy}</div>}
      {columnProblems.map((p) => (
        <p key={p.message} className="vq-problem">
          {p.message}
        </p>
      ))}

    </div>
  );
}
