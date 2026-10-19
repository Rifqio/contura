import { expect, test } from "vitest";
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions, type ExportPreview } from "../api/types";
import {
  bytesText,
  originFromJob,
  elapsedLine,
  fileNameFor,
  formatHint,
  optionsSummary,
  sizeLine,
  statusText,
  stripExtension,
  timeLeft,
  timeText,
} from "./exportText";
import type { JobView } from "./jobStore";

const opts = (over: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...over });

test("csv_summary_names_delimiter_header_and_null", () => {
  expect(optionsSummary("csv", opts())).toBe("Comma, header row, NULL as an empty cell");
  expect(optionsSummary("csv", opts({ delimiter: "semicolon", header: false, nullAs: "nullWord" }))).toBe(
    "Semicolon, no header row, NULL as the text NULL",
  );
  expect(optionsSummary("csv", opts({ delimiter: "tab", bom: true, binary: "base64" }))).toBe(
    "Tab, header row, NULL as an empty cell, a BOM for Excel, binary as Base64",
  );
});

test("json_excel_and_sql_summaries", () => {
  expect(optionsSummary("json", opts())).toBe("One object per line");
  expect(optionsSummary("json", opts({ jsonLayout: "array", binary: "base64" }))).toBe("Array, binary as Base64");
  expect(optionsSummary("xlsx", opts())).toBe("Header row, frozen");
  expect(optionsSummary("xlsx", opts({ freezeHeader: false }))).toBe("Header row, not frozen");
  expect(optionsSummary("sql", opts())).toBe("500 rows per statement, table name as in the source");
  expect(optionsSummary("sql", opts({ rowsPerStatement: 1000, tableName: "unqualified" }))).toBe("1,000 rows per statement, unqualified table name");
});

test("format_hints_are_the_spec_four", () => {
  expect(formatHint("csv", "menu_items", "postgres")).toBe("Plain text. Opens in Excel and in any editor.");
  expect(formatHint("json", "menu_items", "postgres")).toBe("Plain text. Opens in Excel and in any editor.");
  expect(formatHint("xlsx", "menu_items", "postgres")).toBe(
    "One sheet named menu_items. bigint and numeric are written as text, so no digits are lost.",
  );
  expect(formatHint("sql", "menu_items", "mysql")).toBe("INSERT statements for MySQL. Restore a whole database with Backup instead.");
  expect(formatHint("sql", "menu_items", "postgres")).toBe("INSERT statements for PostgreSQL. Restore a whole database with Backup instead.");
});

test("file_names_follow_the_format_and_layout", () => {
  expect(fileNameFor("menu_items", "csv", "lines")).toBe("menu_items.csv");
  expect(fileNameFor("menu_items", "json", "lines")).toBe("menu_items.ndjson");
  expect(fileNameFor("menu_items", "json", "array")).toBe("menu_items.json");
  expect(fileNameFor("menu_items", "xlsx", "lines")).toBe("menu_items.xlsx");
  expect(fileNameFor("menu_items", "sql", "lines")).toBe("menu_items.sql");
  expect(stripExtension("orders-oct.ndjson")).toBe("orders-oct");
  expect(stripExtension("orders.v2.CSV")).toBe("orders.v2");
  expect(stripExtension("orders.v2")).toBe("orders.v2");
});

test("byte_sizes", () => {
  expect(bytesText(450)).toBe("450 bytes");
  expect(bytesText(9202)).toBe("9 KB");
  expect(bytesText(148 * 1024 * 1024)).toBe("148 MB");
  expect(bytesText(1.5 * 1024 * 1024)).toBe("1.5 MB");
  expect(bytesText(2.25 * 1024 * 1024 * 1024)).toBe("2.3 GB");
});

const preview = (bytesPerRow: number): ExportPreview => ({
  lines: [],
  sheet: null,
  encoding: "UTF-8",
  bytesPerRow,
  sampleRows: 20,
  notes: [],
  queryRead: true,
});

test("size_line_with_and_without_a_row_count", () => {
  expect(sizeLine(preview(107), 86)).toBe("About 9 KB, 86 rows");
  expect(sizeLine(preview(107), 1)).toBe("About 107 bytes, 1 row");
  expect(sizeLine(preview(450), null)).toBe("About 450 bytes a row");
  expect(sizeLine(preview(107), 1284339)).toBe("About 131 MB, 1,284,339 rows");
});

test("time_lines_use_compact_units", () => {
  expect(timeText(38_000)).toBe("38s");
  expect(timeText(80_000)).toBe("1m 20s");
  expect(timeText(120_000)).toBe("2m");
  expect(timeText(3_900_000)).toBe("1h 5m");
  expect(elapsedLine(38_000, 80_000)).toBe("38s, about 1m 20s left");
  expect(elapsedLine(38_000, null)).toBe("38s");
  expect(timeLeft(38_000, 412_000, 1_284_339)).toBeCloseTo(80_436, -2);
  expect(timeLeft(38_000, 0, 100)).toBeNull();
  expect(timeLeft(38_000, 10, null)).toBeNull();
});

function job(over: Partial<JobView> = {}): JobView {
  return {
    id: "j1",
    kind: "export",
    label: "Exporting orders",
    connectionId: "c1",
    phase: "writing",
    rowsDone: 0,
    rowsTotal: null,
    bytesDone: 0,
    bytesTotal: null,
    statementsDone: 0,
    percent: null,
    startedAt: 0,
    background: true,
    skipped: [],
    skippedTotal: 0,
    warnings: [],
    done: null,
    ...over,
  };
}

test("status_text_shows_percent_or_written_bytes", () => {
  expect(statusText(job({ percent: 32, rowsDone: 412_000, rowsTotal: 1_284_339 }))).toBe("Exporting orders, 32 percent");
  expect(statusText(job({ bytesDone: 148 * 1024 * 1024 }))).toBe("Exporting orders, 148 MB");
  expect(statusText(job())).toBe("Exporting orders");
});

test("an_origin_from_the_job_alone_names_its_table_or_the_query_result", () => {
  expect(originFromJob("Exporting orders")).toMatchObject({ kind: "table", path: { schema: null, name: "orders" }, columns: [] });
  expect(originFromJob("Exporting the query result")).toMatchObject({ kind: "result", sql: "", rows: [] });
});

test("a transfer's status text counts the whole run", () => {
  expect(statusText(job({ kind: "transfer", label: "Copying 6 tables to analytics", percent: 38 }))).toBe("Transfer running, 38 percent");
  expect(statusText(job({ kind: "transfer", label: "Copying 6 tables to analytics" }))).toBe("Transfer running");
});
