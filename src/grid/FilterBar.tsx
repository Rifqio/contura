// Item 2 (frame Table, "Filter and sort"): the table view's filters and sort as chips, built in a small form
// instead of typed SQL. A chip says its filter in words; clicking it edits it, its x removes it. The sort chip
// flips the direction on a click. Clear drops both.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { SortSpec } from "../api/types";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import Select from "../components/Select";
import { useDismiss } from "../components/useDismiss";
import {
  type FilterOp,
  filterProblem,
  filterSentence,
  filterWords,
  OPS,
  quickDays,
  type RowFilter,
  sortWords,
  takesValue,
  type ValueKind,
} from "./rowFilters";

export interface FilterColumn {
  name: string;
  typeName: string;
  kind: ValueKind;
}

interface Props {
  columns: FilterColumn[];
  filters: RowFilter[];
  sort: SortSpec | null;
  onFilters(next: RowFilter[]): void;
  onSort(next: SortSpec | null): void;
  /** No rows to filter (an empty table): adding is off. */
  disabled?: boolean;
}

type Draft = Omit<RowFilter, "id"> & { id: string | null };

let seq = 0;
const newId = () => `f${++seq}`;

/** The Add filter (or edit) form: column, condition, value, the sentence it makes, Cancel and Add. */
function FilterForm({
  columns,
  initial,
  onDone,
  onCancel,
  anchor,
}: {
  columns: FilterColumn[];
  initial: Draft;
  onDone(f: RowFilter): void;
  onCancel(): void;
  anchor: React.RefObject<HTMLElement | null>;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [tried, setTried] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, [box, anchor], onCancel);
  const ids = useId();
  const kind = columns.find((c) => c.name === d.column)?.kind ?? "text";
  const problem = filterProblem(kind, d);
  const done = () => {
    setTried(true);
    if (problem === null) onDone({ ...d, id: d.id ?? newId() });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      done();
    }
  };
  const setColumn = (column: string) => {
    const k = columns.find((c) => c.name === column)?.kind ?? "text";
    // A condition the new column's kind does not have falls back to its first one.
    setD((x) => ({ ...x, column, op: OPS[k].some((o) => o.op === x.op) ? x.op : OPS[k][0].op, value: k === kind ? x.value : "", value2: undefined }));
  };
  const valueLabel = kind === "date" ? "Date" : kind === "number" ? "Number" : "Text";
  return (
    <div ref={box} className="filter-form" role="dialog" aria-label={initial.id ? "Edit filter" : "Add filter"} onKeyDown={onKey}>
      <div className="filter-form-title">Show rows where</div>
      <label className="filter-field">
        <span className="filter-label">Column</span>
        <Select
          label="Column"
          mono
          value={d.column}
          options={columns.map((c) => ({ value: c.name, label: c.name, hint: c.typeName }))}
          onChange={setColumn}
        />
      </label>
      <label className="filter-field">
        <span className="filter-label">Condition</span>
        <Select<FilterOp> label="Condition" value={d.op} options={OPS[kind].map((o) => ({ value: o.op, label: o.label }))} onChange={(op) => setD((x) => ({ ...x, op }))} />
      </label>
      {takesValue(d.op) && (
        <div className="filter-field">
          <label className="filter-label" htmlFor={`${ids}-v`}>
            {d.op === "between" ? `${valueLabel}s` : valueLabel}
          </label>
          <div className="filter-values">
            <input
              id={`${ids}-v`}
              className="input filter-input"
              aria-label={d.op === "between" ? "From" : "Value"}
              aria-invalid={tried && problem !== null}
              value={d.value}
              placeholder={kind === "date" ? "2026-10-01" : kind === "number" ? "500" : ""}
              spellCheck={false}
              autoComplete="off"
              autoFocus
              onChange={(e) => setD((x) => ({ ...x, value: e.target.value }))}
            />
            {d.op === "between" && (
              <>
                <span className="filter-and">and</span>
                <input
                  className="input filter-input"
                  aria-label="To"
                  aria-invalid={tried && problem !== null}
                  value={d.value2 ?? ""}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setD((x) => ({ ...x, value2: e.target.value }))}
                />
              </>
            )}
          </div>
          {kind === "date" && d.op !== "between" && (
            <div className="filter-quick">
              {quickDays(new Date()).map((q) => (
                <button
                  key={q.label}
                  type="button"
                  className={d.value === q.value ? "filter-quick-button is-on" : "filter-quick-button"}
                  aria-pressed={d.value === q.value}
                  onClick={() => setD((x) => ({ ...x, value: q.value }))}
                >
                  {q.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <p className={tried && problem ? "filter-say is-problem" : "filter-say"} role={tried && problem ? "alert" : undefined}>
        {tried && problem ? problem : problem === null ? filterSentence(kind, { ...d, id: "" }) : " "}
      </p>
      <div className="filter-actions">
        <button type="button" className="button button-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-small button-primary" onClick={done}>
          {initial.id ? "Keep filter" : "Add filter"}
          <Kbd keys="Enter" />
        </button>
      </div>
    </div>
  );
}

/** The sort form: a column and its direction in words. */
function SortForm({
  columns,
  sort,
  onDone,
  onCancel,
  anchor,
}: {
  columns: FilterColumn[];
  sort: SortSpec | null;
  onDone(s: SortSpec): void;
  onCancel(): void;
  anchor: React.RefObject<HTMLElement | null>;
}) {
  const [column, setColumn] = useState(sort?.column ?? columns[0]?.name ?? "");
  const [descending, setDescending] = useState(sort?.descending ?? false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, [box, anchor], onCancel);
  const kind = columns.find((c) => c.name === column)?.kind ?? "text";
  return (
    <div
      ref={box}
      className="filter-form"
      role="dialog"
      aria-label="Sort"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          onDone({ column, descending });
        }
      }}
    >
      <div className="filter-form-title">Sort rows by</div>
      <label className="filter-field">
        <span className="filter-label">Column</span>
        <Select label="Sort column" mono value={column} options={columns.map((c) => ({ value: c.name, label: c.name, hint: c.typeName }))} onChange={setColumn} />
      </label>
      <div className="filter-field" role="radiogroup" aria-label="Direction">
        <span className="filter-label">Order</span>
        <div className="filter-quick">
          {[false, true].map((desc) => (
            <button
              key={String(desc)}
              type="button"
              role="radio"
              aria-checked={descending === desc}
              className={descending === desc ? "filter-quick-button is-on" : "filter-quick-button"}
              onClick={() => setDescending(desc)}
            >
              {sortWords(kind, desc)}
            </button>
          ))}
        </div>
      </div>
      <div className="filter-actions">
        <button type="button" className="button button-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-small button-primary" onClick={() => onDone({ column, descending })}>
          Sort
          <Kbd keys="Enter" />
        </button>
      </div>
    </div>
  );
}

export default function FilterBar({ columns, filters, sort, onFilters, onSort, disabled }: Props) {
  const [open, setOpen] = useState<{ kind: "filter"; draft: Draft } | { kind: "sort" } | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const sortRef = useRef<HTMLSpanElement>(null);
  const editAnchor = useRef<HTMLElement | null>(null);
  const kindOf = (c: string) => columns.find((x) => x.name === c)?.kind ?? "text";
  const first = columns[0];
  const sortKind = sort ? kindOf(sort.column) : "text";
  // A closed form gives focus back to what opened it (Add filter, the chip, or Sort), unless a press elsewhere
  // already put it somewhere.
  const back = useRef<(() => HTMLElement | null) | null>(null);
  const closeFilter = () => {
    const el = editAnchor.current;
    back.current = () => (el?.isConnected ? el : addRef.current);
    setOpen(null);
  };
  const closeSort = () => {
    back.current = () => sortRef.current?.querySelector<HTMLElement>("button") ?? null;
    setOpen(null);
  };
  useEffect(() => {
    if (open !== null || !back.current) return;
    const target = back.current();
    back.current = null;
    const now = document.activeElement;
    if (now === null || now === document.body) target?.focus();
  }, [open]);

  const startAdd = () => {
    if (!first) return;
    editAnchor.current = addRef.current;
    setOpen({ kind: "filter", draft: { id: null, column: first.name, op: OPS[first.kind][0].op, value: "" } });
  };

  return (
    <div className="filter-bar" role="toolbar" aria-label="Filter and sort">
      <Icon name="filter" size={14} className="filter-bar-icon" />
      {filters.length === 0 && <span className="filter-all">All rows</span>}
      {filters.map((f) => {
        const w = filterWords(kindOf(f.column), f);
        const say = [w.column, w.condition, w.value].filter(Boolean).join(" ");
        return (
          <span key={f.id} className="filter-chip">
            <button
              type="button"
              className="filter-chip-body"
              aria-label={`Edit filter: ${say}`}
              onClick={(e) => {
                editAnchor.current = e.currentTarget;
                setOpen({ kind: "filter", draft: { ...f } });
              }}
            >
              <span className="filter-chip-code">{w.column}</span>
              <span className="filter-chip-word">{w.condition}</span>
              {w.value && <span className="filter-chip-code">{w.value}</span>}
            </button>
            <button type="button" className="filter-chip-x" aria-label={`Remove filter: ${say}`} onClick={() => onFilters(filters.filter((x) => x.id !== f.id))}>
              <Icon name="close" size={14} />
            </button>
          </span>
        );
      })}
      <span className="filter-anchor">
        <button
          ref={addRef}
          type="button"
          className="button button-small button-quiet"
          aria-haspopup="dialog"
          aria-expanded={open?.kind === "filter"}
          disabled={disabled || !first}
          onClick={() => (open?.kind === "filter" ? setOpen(null) : startAdd())}
        >
          <Icon name="plus" size={14} />
          Add filter
        </button>
        {open?.kind === "filter" && (
          <FilterForm
            columns={columns}
            initial={open.draft}
            anchor={editAnchor}
            onCancel={closeFilter}
            onDone={(f) => {
              closeFilter();
              onFilters(filters.some((x) => x.id === f.id) ? filters.map((x) => (x.id === f.id ? f : x)) : [...filters, f]);
            }}
          />
        )}
      </span>
      <span className="editor-header-divider" aria-hidden="true" />
      <span className="filter-anchor" ref={sortRef}>
        {sort ? (
          <span className="filter-chip">
            <button
              type="button"
              className="filter-chip-body"
              aria-label={`Sort by ${sort.column}, ${sortWords(sortKind, sort.descending)}. Select to reverse.`}
              onClick={() => onSort({ column: sort.column, descending: !sort.descending })}
            >
              <Icon name={sort.descending ? "arrowDown" : "arrowUp"} size={14} />
              <span className="filter-chip-code">{sort.column}</span>
              <span className="filter-chip-word">{sortWords(sortKind, sort.descending)}</span>
            </button>
            <button type="button" className="filter-chip-x" aria-label="Remove sort" onClick={() => onSort(null)}>
              <Icon name="close" size={14} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="button button-small button-quiet"
            aria-haspopup="dialog"
            aria-expanded={open?.kind === "sort"}
            disabled={disabled || !first}
            onClick={() => setOpen(open?.kind === "sort" ? null : { kind: "sort" })}
          >
            <Icon name="plus" size={14} />
            Sort
          </button>
        )}
        {open?.kind === "sort" && (
          <SortForm
            columns={columns}
            sort={sort}
            anchor={sortRef}
            onCancel={closeSort}
            onDone={(s) => {
              closeSort();
              onSort(s);
            }}
          />
        )}
      </span>
      <span className="spacer" />
      {(filters.length > 0 || sort) && (
        <button
          type="button"
          className="button button-small button-quiet"
          onClick={() => {
            onFilters([]);
            onSort(null);
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
