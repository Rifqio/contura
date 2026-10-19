import { type KeyboardEvent, useState } from "react";
import type { TransferCopyKind, TransferIfExists } from "../api/types";
import Icon from "../components/Icon";
import { bytesText } from "../jobs/importModel";
import Segmented from "../components/Segmented";
import Select from "../components/Select";
import Switch from "../components/Switch";
import {
  MAX_BATCH,
  MIN_BATCH,
  moveTable,
  needsNote,
  summaryLine,
  type TableRow,
  tickedLine,
  type TransferState,
} from "./transferModel";

const IF_EXISTS: { value: TransferIfExists; label: string }[] = [
  { value: "stop", label: "Stop" },
  { value: "append", label: "Append" },
  { value: "emptyFirst", label: "Empty it first" },
];

const COPY: { value: TransferCopyKind; label: string }[] = [
  { value: "both", label: "Structure and rows" },
  { value: "structureOnly", label: "Structure only" },
  { value: "rowsOnly", label: "Rows only, into tables that exist" },
];

const n = (v: number) => v.toLocaleString("en-US");

interface Props {
  state: TransferState;
  sourceName: string;
  /** Still reading the source's tables. */
  loading: boolean;
  onChange(next: Partial<TransferState>): void;
}

/** Step 2 (frame 8.1): the table list in load order and the options beside it. */
export default function StepTables({ state, sourceName, loading, onChange }: Props) {
  const rows = state.tables;
  const [dragging, setDragging] = useState<number | null>(null);
  const [batchText, setBatchText] = useState(n(state.batchRows));
  const tables = rows.filter((r) => !r.view);
  const all = tables.length > 0 && tables.every((r) => r.ticked);
  const some = tables.some((r) => r.ticked);
  // The header control shows a value only while every table has the same one.
  const shared = tables.every((r) => r.ifExists === tables[0]?.ifExists) ? (tables[0]?.ifExists ?? "stop") : null;

  const setRows = (tables: TableRow[]) => onChange({ tables });
  const update = (i: number, change: Partial<TableRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  // Views stay below the tables: a table moves among the tables only.
  const lastTable = rows.reduce((last, r, i) => (r.view ? last : i), -1);
  const move = (i: number, delta: number) => {
    const to = Math.max(0, Math.min(lastTable, i + delta));
    if (rows[i]?.view || to === i) return;
    setRows(moveTable(rows, i, to - i));
    // Focus follows the moved row once it renders.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-transfer-row="${to}"]`)?.focus());
  };

  function onRowKey(e: KeyboardEvent<HTMLTableRowElement>, i: number) {
    const r = rows[i];
    if (!r || r.view || e.target !== e.currentTarget) return;
    if (e.key === " ") {
      e.preventDefault();
      update(i, { ticked: !r.ticked });
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      e.stopPropagation();
      move(i, e.key === "ArrowUp" ? -1 : 1);
    } else if (!e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      document.querySelector<HTMLElement>(`[data-transfer-row="${i + (e.key === "ArrowUp" ? -1 : 1)}"]`)?.focus();
    }
  }

  const commitBatch = () => {
    const v = Number(batchText.replace(/[,\s]/g, ""));
    const next = Number.isFinite(v) && v > 0 ? Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round(v))) : state.batchRows;
    onChange({ batchRows: next });
    setBatchText(n(next));
  };

  let order = 0;
  return (
    <div className="transfer-tables">
      <section className="transfer-box transfer-list" aria-label="Tables">
        <header className="transfer-pane-head">
          <span className="transfer-sect">Tables</span>
          <span className="transfer-count">{tickedLine(rows)}</span>
          <span className="transfer-sp" />
          <span className="transfer-hint">Parents first, so Foreign Keys hold. Drag a row to change the order.</span>
        </header>
        <div className="transfer-scroll">
          <table className="transfer-lt">
            <thead>
              <tr>
                <th className="w0" aria-label="Drag" />
                <th className="w0">
                  <input
                    type="checkbox"
                    aria-label="Tick every table"
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = some && !all;
                    }}
                    onChange={() => setRows(rows.map((r) => (r.view ? r : { ...r, ticked: !all })))}
                  />
                </th>
                <th className="w0 r">Order</th>
                <th>Table</th>
                <th className="r">Rows</th>
                <th className="r">Size</th>
                <th>Needs</th>
                <th>If it exists</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="transfer-muted">
                    Reading the tables of {sourceName}...
                  </td>
                </tr>
              )}
              {rows.map((r, i) => {
                const note = needsNote(rows, r);
                if (r.ticked && !r.view) order += 1;
                return (
                  <tr
                    key={r.name}
                    data-transfer-row={i}
                    data-table={r.name}
                    tabIndex={r.view ? -1 : 0}
                    className={[!r.ticked || r.view ? "off" : "", dragging === i ? "dragging" : ""].join(" ").trim() || undefined}
                    aria-disabled={r.view || undefined}
                    draggable={!r.view}
                    onDragStart={(e) => {
                      setDragging(i);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", r.name);
                    }}
                    onDragOver={(e) => {
                      if (dragging !== null && !r.view) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragging !== null && dragging !== i && !r.view) setRows(moveTable(rows, dragging, i - dragging));
                      setDragging(null);
                    }}
                    onDragEnd={() => setDragging(null)}
                    onKeyDown={(e) => onRowKey(e, i)}
                  >
                    <td>{!r.view && <Icon name="grip" size={14} />}</td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={r.view ? `${r.name} is a view` : `Tick ${r.name}`}
                        checked={r.ticked && !r.view}
                        disabled={r.view}
                        tabIndex={-1}
                        onChange={() => update(i, { ticked: !r.ticked })}
                      />
                    </td>
                    <td className="r m">{r.ticked && !r.view ? order : ""}</td>
                    <td>
                      <span className="transfer-name">
                        <Icon name={r.view ? "view" : "table"} size={14} />
                        <span className="m">{r.name}</span>
                      </span>
                    </td>
                    <td className="r">{r.rows === null ? "" : n(r.rows)}</td>
                    <td className="r">{r.bytes === null ? "" : bytesText(r.bytes)}</td>
                    <td className="transfer-needs">
                      {r.view ? (
                        <span className="transfer-note">Views are not copied. Recreate it after.</span>
                      ) : note ? (
                        <span className="transfer-note transfer-note-warn">{note}</span>
                      ) : (
                        <span className="m">{r.needs.join(", ")}</span>
                      )}
                    </td>
                    <td>
                      {!r.view && r.ticked && (
                        <Select
                          label={`If ${r.name} exists`}
                          value={r.ifExists}
                          options={IF_EXISTS}
                          onChange={(v) => update(i, { ifExists: v })}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <aside className="transfer-side">
        <div className="transfer-box transfer-options">
          <fieldset className="transfer-field">
            <legend className="transfer-flab">Copy</legend>
            {COPY.map((c) => (
              <label key={c.value} className="transfer-radio">
                <input type="radio" name="transfer-copy" checked={state.copy === c.value} onChange={() => onChange({ copy: c.value })} />
                {c.label}
              </label>
            ))}
          </fieldset>
          <div className="transfer-field">
            <span className="transfer-flab">If a table already exists</span>
            <Segmented
              label="If a table already exists"
              value={shared ?? ("" as TransferIfExists)}
              options={IF_EXISTS}
              onChange={(v) => setRows(rows.map((r) => (r.view ? r : { ...r, ifExists: v })))}
            />
            <span className="transfer-hint">Stop is the default: nothing on the target is touched.</span>
          </div>
          <label className="transfer-field">
            <span className="transfer-flab">Rows per batch</span>
            <input
              className="input mono transfer-batch"
              inputMode="numeric"
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              onBlur={commitBatch}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                // Ctrl+Enter goes on to the next step with the typed value: commit it before it bubbles.
                commitBatch();
                if (!e.ctrlKey && !e.metaKey) e.preventDefault();
              }}
            />
          </label>
          <Switch label="Compare row counts at the end" checked={state.compareCounts} onChange={(on) => onChange({ compareCounts: on })} />
        </div>
        <p className="transfer-summary">{summaryLine(rows, sourceName)}</p>
      </aside>
    </div>
  );
}
