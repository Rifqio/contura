// The Export dialog's words and numbers: option summaries, hints, file names, sizes and times.
import { DIALECT_LABEL } from "../api/client";
import type {
  Cell,
  DialectKind,
  ExportOptions,
  ExportPreview,
  Format,
  JsonLayout,
  KeyPart,
  ObjectPath,
  ResultColumn,
  SortSpec,
} from "../api/types";
import type { JobView } from "./jobStore";

/** What the Export dialog was opened on: a table grid (or tree row), or a query result. */
export type ExportOrigin =
  | {
      kind: "table";
      path: ObjectPath;
      /** Every column of the table, in table order. */
      columns: string[];
      /** The grid's applied filter; null when it has none. */
      filter: string | null;
      sort: SortSpec | null;
      /** The selected rows by key (D7: the selected cell's row). */
      selected: KeyPart[][];
      hasPrimaryKey: boolean;
      /** The tree's row count; null when unknown. */
      rowEstimate: number | null;
      /** True when `rowEstimate` comes from the server's statistics. */
      estimated: boolean;
      /** Columns hidden in the grid: they start off in the column choice. */
      hidden?: string[];
    }
  | {
      kind: "result";
      database: string | null;
      sql: string;
      columns: ResultColumn[];
      rows: Cell[][];
      /** Columns hidden in the result: Rows shown leaves them out. */
      hidden?: string[];
    };

const n = (v: number) => v.toLocaleString("en-US");

const DELIMITER = { comma: "Comma", semicolon: "Semicolon", tab: "Tab" } as const;

/** One line of what More options has set, such as "Comma, header row, NULL as an empty cell". */
export function optionsSummary(format: Format, opts: ExportOptions): string {
  const parts: string[] = [];
  const binary = opts.binary === "base64" ? ["binary as Base64"] : [];
  switch (format) {
    case "csv":
      parts.push(
        DELIMITER[opts.delimiter],
        opts.header ? "header row" : "no header row",
        opts.nullAs === "emptyCell" ? "NULL as an empty cell" : "NULL as the text NULL",
      );
      if (opts.bom) parts.push("a BOM for Excel");
      parts.push(...binary);
      break;
    case "json":
      parts.push(opts.jsonLayout === "lines" ? "JSON Lines" : "Array", ...binary);
      break;
    case "xlsx":
      parts.push("Header row", opts.freezeHeader ? "frozen" : "not frozen", ...binary);
      break;
    case "sql":
      parts.push(
        `${n(opts.rowsPerStatement)} rows per statement`,
        opts.tableName === "asSource" ? "table name as in the source" : "unqualified table name",
      );
      break;
  }
  return parts.join(", ");
}

/** The one-line hint under the format choice. `table` names the Excel sheet; `layout` is JSON's. */
export function formatHint(format: Format, table: string, dialect: DialectKind, layout: JsonLayout = "array"): string {
  switch (format) {
    case "csv":
      return "Plain text. Opens in Excel and in any editor.";
    case "json":
      return layout === "lines" ? "One JSON object per line. Opens in any editor." : "One JSON array of objects. Opens in any editor.";
    case "xlsx":
      return `One sheet named ${table}. bigint and numeric are written as text, so no digits are lost.`;
    case "sql":
      return `INSERT statements for ${DIALECT_LABEL[dialect]}. Restore a whole database with Backup instead.`;
  }
}

/** The extension of each format; JSON depends on its layout. */
export function extensionFor(format: Format, layout: JsonLayout): string {
  // Item 45: JSON Lines is saved as `.jsonl`, the name most data tools use for it (NDJSON is the same format).
  if (format === "json") return layout === "lines" ? "jsonl" : "json";
  return format;
}

export function fileNameFor(base: string, format: Format, layout: JsonLayout): string {
  return `${base}.${extensionFor(format, layout)}`;
}

const KNOWN = /\.(csv|jsonl|ndjson|json|xlsx|sql)$/i;

/** The name without an export extension; other dots stay. */
export function stripExtension(name: string): string {
  return name.replace(KNOWN, "");
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** A file size as Windows Explorer labels it: "450 bytes", "9 KB", "1.5 MB", "148 MB". */
export function bytesText(bytes: number): string {
  const b = Math.max(0, Math.round(bytes));
  if (b < KB) return `${n(b)} bytes`;
  if (b < MB) return `${n(Math.round(b / KB))} KB`;
  if (b < GB) {
    const mb = b / MB;
    return mb < 10 ? `${Number(mb.toFixed(1))} MB` : `${n(Math.round(mb))} MB`;
  }
  return `${Number((b / GB).toFixed(1))} GB`;
}

/** D8: "About 9 KB, 86 rows" with a known count, else "About 450 bytes a row". */
export function sizeLine(preview: ExportPreview, rows: number | null): string {
  if (rows === null) return `About ${bytesText(preview.bytesPerRow)} a row`;
  return `About ${bytesText(preview.bytesPerRow * rows)}, ${n(rows)} ${rows === 1 ? "row" : "rows"}`;
}

/** A duration in compact units, whole seconds: "38s", "1m 20s", "2m", "1h 5m". */
export function timeText(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) {
    const rest = secs % 60;
    return rest === 0 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 60)}m ${rest}s`;
  }
  const mins = Math.floor((secs % 3600) / 60);
  return mins === 0 ? `${Math.floor(secs / 3600)}h` : `${Math.floor(secs / 3600)}h ${mins}m`;
}

/** The time still to go at the pace so far; null without a total or before the first row. */
export function timeLeft(elapsedMs: number, done: number, total: number | null): number | null {
  if (total === null || done <= 0) return null;
  return Math.max(0, (elapsedMs * (total - done)) / done);
}

/** "38s, about 1m 20s left", or only the elapsed time when the rest is unknown. */
export function elapsedLine(ms: number, left: number | null): string {
  return left === null ? timeText(ms) : `${timeText(ms)}, about ${timeText(left)} left`;
}

/** The status bar's words for a job: "Exporting orders, 32 percent", or the bytes written without a total. */
export function statusText(job: JobView): string {
  // Step 8: a transfer's percent counts every table's rows.
  if (job.kind === "transfer") return job.percent !== null ? `Transfer running, ${job.percent} percent` : "Transfer running";
  if (job.percent !== null) return `${job.label}, ${job.percent} percent`;
  if (job.bytesDone > 0) return `${job.label}, ${bytesText(job.bytesDone)}`;
  return job.label;
}

/** "Exported 1,284,339 rows to orders-oct.ndjson", or without the file when it is not known. */
export function exportedText(rows: number, file: string | null): string {
  const what = `Exported ${n(rows)} ${rows === 1 ? "row" : "rows"}`;
  return file ? `${what} to ${file}` : what;
}

/** D14: the end of a cancelled export. */
export const EXPORT_CANCELLED = "Export cancelled. The unfinished file was deleted.";

/**
 * An origin for a running export whose own was not kept (opened again from the status bar after a
 * reload): enough for the dialog's title and its running or ended view, from the job's label alone.
 */
export function originFromJob(label: string): ExportOrigin {
  const name = label.replace(/^Exporting /, "");
  if (name === "the query result") return { kind: "result", database: null, sql: "", columns: [], rows: [] };
  return {
    kind: "table",
    path: { database: "", schema: null, name },
    columns: [],
    filter: null,
    sort: null,
    selected: [],
    hasPrimaryKey: false,
    rowEstimate: null,
    estimated: false,
  };
}
