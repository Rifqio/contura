import { save } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { errorText, writeTextFile } from "../api/client";
import type { Cell, ResultColumn } from "../api/types";
import { hintFor } from "../commands/keymap";
import { useKeymap } from "../commands/useCommandKeys";
import Icon from "../components/Icon";
import Menu from "../components/Menu";
import { useToast } from "../components/Toast";

interface Props {
  columns: ResultColumn[];
  /** The rows to export: those the filter lets through. */
  rows: Cell[][];
  filter: string;
  onFilter(text: string): void;
  hidden: ReadonlySet<string>;
  onToggleColumn(name: string): void;
  connectionName?: string;
  /** Opens the Export dialog; with it, the menu offers Export... in place of Save as CSV.... */
  onExport?(): void;
  /** Opens an Import tab into the grid's table (never given on a query result, Q16). */
  onImport?(): void;
}

export const cellText = (c: Cell): string => (c.t === "null" ? "" : c.t === "bytes" ? c.previewHex : c.value);
const field = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The rows as CSV, a header line first, lines ended with CRLF as RFC 4180 has it. */
export function toCsv(columns: ResultColumn[], rows: Cell[][]): string {
  return [columns.map((c) => field(c.name)).join(","), ...rows.map((r) => r.map((c) => field(cellText(c))).join(","))].join("\r\n");
}

/** How many cells hold only a preview of their value; query results carry no way to fetch the rest. */
export function cutShort(rows: Cell[][]): number {
  let n = 0;
  for (const r of rows) for (const c of r) if ((c.t === "text" || c.t === "bytes") && c.truncated) n++;
  return n;
}

/** A button that opens a small panel under it and closes on an outside press or Escape. */
function Popover({ label, on, icon, children }: { label: string; on?: boolean; icon: "filter" | "columns"; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [open]);
  return (
    <div
      className="menu-root"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={on || open ? "icon-button icon-button-on" : "icon-button"}
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={icon} size={14} />
      </button>
      {open && <div className="menu menu-end result-pop">{children}</div>}
    </div>
  );
}

/** Filter, columns and export for a result's rows, as icon buttons with their popovers. */
export default function ResultTools({
  columns,
  rows,
  filter,
  onFilter,
  hidden,
  onToggleColumn,
  connectionName,
  onExport,
  onImport,
}: Props) {
  const { show } = useToast();
  const exportKey = hintFor(useKeymap().map, "export.open") ?? undefined;
  const shown = columns.filter((c) => !hidden.has(c.name));
  const exported = () => rows.map((r) => r.filter((_, i) => !hidden.has(columns[i].name)));
  const csv = () => toCsv(shown, exported());
  const cut = () => {
    const n = cutShort(exported());
    return n === 0 ? "" : ` ${n.toLocaleString("en-US")} ${n === 1 ? "value was" : "values were"} cut short in the CSV.`;
  };
  const count = `${rows.length.toLocaleString("en-US")} ${rows.length === 1 ? "row" : "rows"}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(csv());
      show({ kind: "success", text: `Copied ${count} as CSV.${cut()}` });
    } catch (e) {
      show({ kind: "error", text: errorText(e) });
    }
  }
  async function saveFile() {
    try {
      const base = (connectionName ?? "result").replace(/[^\w.-]+/g, "_");
      const target = await save({ filters: [{ name: "CSV", extensions: ["csv"] }], defaultPath: `${base}.csv` });
      if (!target) return;
      await writeTextFile(target, csv());
      show({ kind: "success", text: `Saved ${count} as CSV.${cut()}` });
    } catch (e) {
      show({ kind: "error", text: errorText(e) });
    }
  }

  return (
    <div className="result-tools">
      <Popover label="Filter rows" icon="filter" on={filter !== ""}>
        <input
          className="input result-filter"
          type="text"
          aria-label="Filter loaded rows"
          placeholder="Filter loaded rows"
          value={filter}
          autoFocus
          onChange={(e) => onFilter(e.target.value)}
        />
      </Popover>
      <Popover label="Columns" icon="columns" on={hidden.size > 0}>
        <div className="result-columns" role="group" aria-label="Columns">
          {columns.map((c) => {
            const on = !hidden.has(c.name);
            return (
              <label key={c.name} className="result-column">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={on && shown.length === 1}
                  onChange={() => onToggleColumn(c.name)}
                />
                <span>{c.name}</span>
              </label>
            );
          })}
        </div>
      </Popover>
      <Menu
        align="end"
        label="Export"
        items={[
          { key: "copy", label: "Copy as CSV", icon: <Icon name="copy" size={14} />, onSelect: () => void copy() },
          // The Export dialog covers saving a CSV, so Save as CSV... shows only without it.
          onExport
            ? { key: "export", label: "Export...", icon: <Icon name="export" size={14} />, shortcut: exportKey, onSelect: onExport }
            : { key: "save", label: "Save as CSV...", icon: <Icon name="save" size={14} />, onSelect: () => void saveFile() },
          ...(onImport ? [{ key: "import", label: "Import...", icon: <Icon name="import" size={14} />, onSelect: onImport }] : []),
        ]}
        trigger={(p) => (
          <button type="button" className="icon-button" aria-label="Export" title="Export" {...p}>
            <Icon name="export" size={14} />
          </button>
        )}
      />
    </div>
  );
}
