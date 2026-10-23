// The Filter and sort tab: WHERE rows, ORDER BY rows, LIMIT and Distinct. Every problem the Core
// gives shows under its own row with the field marked.
import { useId } from "react";
import type { FilterOp, SortTarget, VisualQuery, VqFilter, VqProblem } from "../api/types";
import Icon from "../components/Icon";
import Select from "../components/Select";
import Switch from "../components/Switch";
import { addFilter, addSort, editFilter, editSort, removeFilter, removeSort, setDistinct, setLimit } from "./model";

type Change = (f: (q: VisualQuery) => VisualQuery) => void;

export interface FilterPanelProps {
  model: VisualQuery;
  /** The Core's final output names (D7). */
  outputs: string[];
  problems: VqProblem[];
  /** Each card's columns, by table id. */
  tableColumns: Record<string, string[]>;
  onChange: Change;
  /** The LIMIT as typed, or null for the model's value. */
  limitDraft: string | null;
  onLimitDraft(text: string): void;
  /** The footer's Open in editor; off while there is no SQL. */
  onOpenInEditor?(): void;
}

export const OPERATORS: { value: FilterOp; label: string }[] = [
  { value: "eq", label: "=" },
  { value: "ne", label: "<>" },
  { value: "lt", label: "<" },
  { value: "le", label: "<=" },
  { value: "gt", label: ">" },
  { value: "ge", label: ">=" },
  { value: "like", label: "LIKE" },
  { value: "notLike", label: "NOT LIKE" },
  { value: "in", label: "IN" },
  { value: "notIn", label: "NOT IN" },
  { value: "between", label: "BETWEEN" },
  { value: "isNull", label: "IS NULL" },
  { value: "isNotNull", label: "IS NOT NULL" },
];

const SEP = "\u0000";
const LIMIT_PROBLEM = "Limit takes a whole number, such as 100.";

/** True when the rows after the first mix AND with OR. */
export function mixesAndOr(filters: VqFilter[]): boolean {
  const joiners = new Set(filters.slice(1).map((f) => f.joiner));
  return joiners.has("and") && joiners.has("or");
}

function FilterValues({ filter, n, invalid, describedBy, onValues }: { filter: VqFilter; n: number; invalid: boolean; describedBy?: string; onValues(v: string[]): void }) {
  const at = (i: number) => filter.values[i] ?? "";
  const set = (i: number, v: string) => {
    const next = [...filter.values];
    while (next.length <= i) next.push("");
    next[i] = v;
    onValues(next);
  };
  const field = (i: number, label: string, placeholder?: string) => (
    <input
      key={i}
      className="input input-small vq-mono vq-filter-value"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={at(i)}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => set(i, e.target.value)}
    />
  );
  switch (filter.op) {
    case "isNull":
    case "isNotNull":
      return null;
    case "between":
      return (
        <span className="vq-filter-between">
          {field(0, `First value for filter ${n}`)}
          <span className="vq-filter-and">and</span>
          {field(1, `Second value for filter ${n}`)}
        </span>
      );
    case "in":
    case "notIn":
      return field(0, `Values for filter ${n}`, "a, b, c");
    default:
      return field(0, `Value for filter ${n}`);
  }
}

/** What a LIMIT text sends: a whole number, else nothing. */
export function limitSends(text: string): number | null {
  const t = text.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

export default function FilterPanel({ model, outputs, problems, tableColumns, onChange, limitDraft, onLimitDraft, onOpenInEditor }: FilterPanelProps) {
  const base = useId();
  const alias = (id: string) => model.tables.find((t) => t.id === id)?.alias ?? "?";
  const columnOptions = model.tables.flatMap((t) => (tableColumns[t.id] ?? []).map((c) => ({ value: `${t.id}${SEP}${c}`, label: `${t.alias}.${c}` })));
  const problemOf = (kind: "filter" | "sort", index: number) =>
    problems.find((p) => p.target.kind === kind && "index" in p.target && p.target.index === index)?.message ?? null;

  // ---- LIMIT: the text as typed (kept by the tab, so it outlives this tab of the panel); only a
  // whole number is sent. The text stands while it still says what the model holds. ----
  const shown = model.limit === null ? "" : String(model.limit);
  const limitText = limitDraft !== null && limitSends(limitDraft) === model.limit ? limitDraft : shown;
  const limitBad = limitText.trim() !== "" && !/^\d+$/.test(limitText.trim());
  const onLimit = (text: string) => {
    onLimitDraft(text);
    onChange((q) => setLimit(q, limitSends(text)));
  };

  // ---- ORDER BY targets: the outputs by name, then every column ----
  const sortValue = (t: SortTarget) => (t.kind === "output" ? `o${SEP}${t.index}` : `c${SEP}${t.table}${SEP}${t.column}`);
  const sortOptions = [
    ...model.columns.map((c, i) => ({ value: `o${SEP}${i}`, label: outputs[i] ?? c.alias ?? c.column })),
    ...columnOptions.map((o) => ({ value: `c${SEP}${o.value}`, label: o.label })),
  ];
  const targetOf = (v: string): SortTarget => {
    const [kind, a, b] = v.split(SEP);
    return kind === "o" ? { kind: "output", index: Number(a) } : { kind: "column", table: a, column: b };
  };
  const nextSort = (): SortTarget | null => {
    const taken = new Set(model.orderBy.map((s) => sortValue(s.target)));
    const free = sortOptions.find((o) => !taken.has(o.value));
    return free ? targetOf(free.value) : null;
  };

  return (
    // Item 39 (board B1): bordered sections side by side, Where, Sort, then Limit and Distinct, with no empty
    // middle; the note sits in a footer bar. A section's count is folded into its sentence, never a bare number.
    <div className="vq-filters-wrap">
      <div className="vq-filters">
        <section className="vq-box vq-filters-where" aria-label="Where">
          <div className="vq-box-head">
            <b>Where</b>
            <span className="vq-box-sum">{conditionsLine(model.filters)}</span>
          </div>
          <div className="vq-box-body">
            <div className="vq-filter-list">
              {model.filters.map((f, i) => {
                const n = i + 1;
                const problem = problemOf("filter", i);
                const problemId = `${base}-f${i}`;
                const noColumn = problem !== null && f.column === "";
                return (
                  <div key={i} role="group" aria-label={`Filter ${n}`} className="vq-filter">
                    <div className="vq-filter-row">
                      {i === 0 ? (
                        <span className="vq-filter-where">Where</span>
                      ) : (
                        <Select
                          label={`Joiner for filter ${n}`}
                          value={f.joiner}
                          className="vq-filter-joiner"
                          options={[
                            { value: "and", label: "And" },
                            { value: "or", label: "Or" },
                          ]}
                          onChange={(joiner) => onChange((q) => editFilter(q, i, { joiner }))}
                        />
                      )}
                      <Select
                        label={`Column for filter ${n}`}
                        mono
                        invalid={noColumn}
                        value={f.column ? `${f.table}${SEP}${f.column}` : ""}
                        describedBy={problem ? problemId : undefined}
                        options={[{ value: "", label: "Pick a column", disabled: true }, ...columnOptions]}
                        onChange={(v) => {
                          const [table, column] = v.split(SEP);
                          onChange((q) => editFilter(q, i, { table, column }));
                        }}
                      />
                      <Select
                        label={`Operator for filter ${n}`}
                        mono
                        value={f.op}
                        options={OPERATORS}
                        onChange={(op) => onChange((q) => editFilter(q, i, { op }))}
                      />
                      <FilterValues
                        filter={f}
                        n={n}
                        invalid={problem !== null && !noColumn}
                        describedBy={problem ? problemId : undefined}
                        onValues={(values) => onChange((q) => editFilter(q, i, { values }))}
                      />
                      <button type="button" className="icon-button" aria-label={`Remove filter ${n}`} title="Remove" onClick={() => onChange((q) => removeFilter(q, i))}>
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                    {problem && (
                      <p id={problemId} className="vq-problem">
                        {problem}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="vq-box-add">
              <button type="button" className="button button-small button-quiet" disabled={model.tables.length === 0} onClick={() => onChange((q) => addFilter(q))}>
                <Icon name="plus" size={14} />
                Add condition
              </button>
            </div>
            {mixesAndOr(model.filters) && <p className="vq-panel-hint">And binds before Or. For other groupings, Open in editor.</p>}
          </div>
        </section>

        <section className="vq-box vq-filters-sort" aria-label="Sort">
          <div className="vq-box-head">
            <b>Sort</b>
            <span className="vq-box-sum">{sortLine(model.orderBy.length)}</span>
          </div>
          <div className="vq-box-body">
            <div className="vq-sort-list">
              {model.orderBy.map((s, i) => {
                const n = i + 1;
                const problem = problemOf("sort", i);
                const problemId = `${base}-s${i}`;
                // An output that is gone still shows where it was, so its problem reads against it.
                const value = sortValue(s.target);
                const options = sortOptions.some((o) => o.value === value)
                  ? sortOptions
                  : [...sortOptions, { value, label: s.target.kind === "column" ? `${alias(s.target.table)}.${s.target.column}` : `Output ${s.target.kind === "output" ? s.target.index + 1 : ""}` }];
                return (
                  <div key={i} role="group" aria-label={`Sort ${n}`} className="vq-filter">
                    <div className="vq-filter-row">
                      <Select
                        label={`Sort column ${n}`}
                        mono
                        invalid={problem !== null}
                        value={value}
                        describedBy={problem ? problemId : undefined}
                        options={options}
                        onChange={(v) => onChange((q) => editSort(q, i, { target: targetOf(v) }))}
                      />
                      <Select
                        label={`Direction for sort ${n}`}
                        value={s.dir}
                        options={[
                          { value: "asc", label: "Ascending" },
                          { value: "desc", label: "Descending" },
                        ]}
                        onChange={(dir) => onChange((q) => editSort(q, i, { dir }))}
                      />
                      <button type="button" className="icon-button" aria-label={`Remove sort ${n}`} title="Remove" onClick={() => onChange((q) => removeSort(q, i))}>
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                    {problem && (
                      <p id={problemId} className="vq-problem">
                        {problem}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="vq-box-add">
              <button
                type="button"
                className="button button-small button-quiet"
                disabled={nextSort() === null}
                onClick={() => {
                  const target = nextSort();
                  if (target) onChange((q) => addSort(q, { target, dir: "asc" }));
                }}
              >
                <Icon name="plus" size={14} />
                Add sort
              </button>
            </div>
          </div>
        </section>

        <section className="vq-box vq-filters-limit" aria-label="Limit and Distinct">
          <div className="vq-box-head">
            <b>Limit and Distinct</b>
          </div>
          <div className="vq-box-body vq-limit-body">
            <div className="vq-limit-row">
              <label className="vq-side-label" htmlFor={`${base}-limit`}>
                Limit
              </label>
              <input
                id={`${base}-limit`}
                className="input input-small vq-mono vq-limit"
                value={limitText}
                placeholder="No limit"
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={limitBad || undefined}
                aria-describedby={limitBad ? `${base}-limit-problem` : undefined}
                onChange={(e) => onLimit(e.target.value)}
              />
              <span className="vq-side-note">rows</span>
            </div>
            {limitBad && (
              <p id={`${base}-limit-problem`} className="vq-problem">
                {LIMIT_PROBLEM}
              </p>
            )}
            <div className="vq-limit-row">
              <span className="vq-side-label" aria-hidden="true">
                Distinct
              </span>
              <Switch label="Distinct" checked={model.distinct} onChange={(on) => onChange((q) => setDistinct(q, on))} />
            </div>
            <p className="vq-side-note vq-distinct-note">Drops repeated rows.</p>
          </div>
        </section>
      </div>
      <div className="vq-box vq-filters-foot">
        <div className="vq-box-foot">
          <Icon name="info" size={14} />
          <span>Values are sent as quoted literals. For anything more, Open in editor.</span>
          <span className="spacer" />
          <button type="button" className="button button-small button-quiet" disabled={!onOpenInEditor} onClick={() => onOpenInEditor?.()}>
            <Icon name="external" size={14} />
            Open in editor
          </button>
        </div>
      </div>
    </div>
  );
}

/** The sort section's sentence (board B1). */
export function sortLine(n: number): string {
  if (n === 0) return "In the order the database returns";
  if (n === 1) return "By one column";
  return `By ${n} columns, in this order`;
}

/** The conditions' sentence, with their count folded in (user, 2026-10-19): never a bare number after the title. */
export function conditionsLine(filters: VisualQuery["filters"]): string {
  const n = filters.length;
  if (n === 0) return "None yet: every row is shown";
  if (n === 1) return "Only rows that match this one condition";
  if (filters.slice(1).some((f) => f.joiner === "or")) return `Rows that match the ${n} conditions, joined as shown`;
  return `Only rows that match all ${n} conditions`;
}
