import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, ExportPreview, ExportRequest, JobEvent, JobReport } from "../api/types";
import { ToastProvider } from "../components/Toast";
import { callsTo, routeInvoke } from "../test/invoke";
import ExportDialog from "./ExportDialog";
import type { ExportOrigin } from "./exportText";
import { JobsProvider, useJobs } from "./useJobs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ documentDir: vi.fn(async () => "C:\\Users\\me\\Documents") }));

const conn: ConnectionConfig = {
  id: "c1",
  name: "kestrel-main",
  dialect: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};

const COLUMNS = ["id", "sku", "name", "category", "price", "is_available"];

const tableOrigin = (over: Partial<Extract<ExportOrigin, { kind: "table" }>> = {}): ExportOrigin => ({
  kind: "table",
  path: { database: "shop", schema: "public", name: "menu_items" },
  columns: COLUMNS,
  filter: null,
  sort: null,
  selected: [[{ column: "id", value: { t: "number", value: "102" } }]],
  hasPrimaryKey: true,
  rowEstimate: 86,
  estimated: false,
  ...over,
});

const resultOrigin: ExportOrigin = {
  kind: "result",
  database: "shop",
  sql: "insert into t values (1) returning *",
  columns: [{ name: "id", typeName: "int4", numeric: true }],
  rows: [[{ t: "number", value: "1" }]],
};

const LINES = [
  "id,sku,name,category,price,is_available",
  "101,KF-0101,Classic burger,Burgers,6.90,true",
  "102,KF-0102,Double smoky burger,Burgers,8.50,true",
  '103,KF-0140,"Crispy wings, 6 pieces",Chicken,5.40,true',
  '104,KF-0141,"Crispy wings, 12 pieces",Chicken,9.80,true',
  "105,KF-0210,Garden wrap,Wraps,5.90,false",
  "106,KF-0230,Spiced fries,Sides,2.60,true",
];

const PREVIEW: ExportPreview = {
  lines: LINES,
  sheet: null,
  encoding: "UTF-8",
  bytesPerRow: 107,
  sampleRows: 20,
  notes: [],
  queryRead: true,
};

const report = (rows: number, file: string): JobReport => ({
  kind: "export",
  rowsRead: rows,
  rowsWritten: rows,
  statements: 0,
  skipped: 0,
  warnings: [],
  elapsedMs: 300,
  file,
  bytes: 9000,
  committed: 0,
  check: null,
});

/** The `events` channel of the last start_export call. */
function lastEvents(): { onmessage: (e: JobEvent) => void } {
  const calls = callsTo("start_export");
  return calls[calls.length - 1].events as { onmessage: (e: JobEvent) => void };
}

let probe: ReturnType<typeof useJobs> | null = null;
function Probe() {
  probe = useJobs();
  return null;
}

function setup(origin: ExportOrigin = tableOrigin(), connection: ConnectionConfig = conn, preview: ExportPreview = PREVIEW) {
  const onClose = vi.fn();
  routeInvoke({
    preview_export: () => preview,
    start_export: () => undefined,
    cancel_job: () => undefined,
    reveal_in_folder: () => undefined,
  });
  render(
    <ToastProvider>
      <JobsProvider>
        <Probe />
        <ExportDialog connection={connection} group={null} origin={origin} onClose={onClose} />
      </JobsProvider>
    </ToastProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: /Export/ });
  return { dialog, onClose };
}

beforeEach(() => {
  localStorage.setItem("contura.exportFolder", "E:\\Exports");
  vi.mocked(invoke).mockReset();
  probe = null;
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

test("the_three_steps_render", async () => {
  const { dialog } = setup();
  expect(within(dialog).getByRole("heading", { name: "Export public.menu_items" })).toBeTruthy();
  expect(within(dialog).getByText("kestrel-main")).toBeTruthy();
  for (const step of ["What to export", "Format", "Save to"]) expect(within(dialog).getByText(step)).toBeTruthy();
  expect(within(dialog).getByText("All 6 columns")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Choose..." })).toBeTruthy();
  expect(within(dialog).getByRole("radio", { name: /All rows/ })).toBeTruthy();
  expect(within(dialog).getByText("86")).toBeTruthy();
  expect(within(dialog).getByText("Plain text. Opens in Excel and in any editor.")).toBeTruthy();
  expect((within(dialog).getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("menu_items.csv");
  expect(within(dialog).getByText("in E:\\Exports")).toBeTruthy();
  expect(within(dialog).getByText("Writes a file only. The database is not changed.")).toBeTruthy();
  await screen.findByText("About 9 KB, 86 rows");
});

test("the_folder_defaults_to_documents", async () => {
  localStorage.clear();
  const { dialog } = setup();
  expect(await within(dialog).findByText("in C:\\Users\\me\\Documents")).toBeTruthy();
});

test("filter_rows_only_with_a_filter_and_selected_rows_need_a_primary_key", async () => {
  const { dialog } = setup(tableOrigin({ hasPrimaryKey: false, estimated: true, rowEstimate: 1200 }));
  expect(within(dialog).queryByRole("radio", { name: /Rows in the current filter/ })).toBeNull();
  expect((within(dialog).getByRole("radio", { name: /Selected rows/ }) as HTMLInputElement).disabled).toBe(true);
  expect(within(dialog).getByText("Needs a primary key")).toBeTruthy();
  expect(within(dialog).getByText("about 1,200")).toBeTruthy();
  await screen.findByText(/About/);
});

test("filter_choice_sends_the_filter_and_selected_sends_the_keys", async () => {
  const { dialog } = setup(tableOrigin({ filter: "price > 5" }));
  await userEvent.click(within(dialog).getByRole("radio", { name: /Rows in the current filter/ }));
  await waitFor(() => {
    const req = callsTo("preview_export").slice(-1)[0].req as ExportRequest;
    expect(req.source).toMatchObject({ kind: "table", filter: "price > 5", keys: [] });
  });
  expect(await screen.findByText("About 107 bytes a row")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("radio", { name: /Selected rows/ }));
  await waitFor(() => {
    const req = callsTo("preview_export").slice(-1)[0].req as ExportRequest;
    expect(req.source).toMatchObject({ kind: "table", filter: null, keys: [[{ column: "id" }]] });
  });
  expect(await screen.findByText("About 107 bytes, 1 row")).toBeTruthy();
});

test("more_options_open_and_close_with_its_summary", async () => {
  const { dialog } = setup();
  const toggle = within(dialog).getByRole("button", { name: /More options/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(within(dialog).getByText("Comma, header row, NULL as an empty cell")).toBeTruthy();
  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(within(dialog).getByRole("radiogroup", { name: "Delimiter" })).toBeTruthy();
  expect(within(dialog).getByRole("switch", { name: "Add a BOM for Excel" })).toBeTruthy();
  expect(within(dialog).queryByText("Comma, header row, NULL as an empty cell")).toBeNull();
  await userEvent.click(within(dialog).getByRole("radio", { name: "Semicolon" }));
  await userEvent.click(toggle);
  expect(within(dialog).getByText("Semicolon, header row, NULL as an empty cell")).toBeTruthy();
  await screen.findByText(/About/);
});

test("the_preview_shows_the_first_six_lines_and_the_size_line", async () => {
  const { dialog } = setup();
  const pre = await within(dialog).findByLabelText("Preview lines");
  expect(pre.textContent).toBe(LINES.slice(0, 6).join("\n"));
  expect(within(dialog).getByText("UTF-8, comma")).toBeTruthy();
  expect(within(dialog).getByText("About 9 KB, 86 rows")).toBeTruthy();
  const req = callsTo("preview_export")[0].req as ExportRequest;
  expect(req).toMatchObject({ connectionId: "c1", format: "csv", path: "E:\\Exports\\menu_items.csv", rowsHint: 86 });
  expect(req.source).toEqual({ kind: "table", path: { database: "shop", schema: "public", name: "menu_items" }, columns: [], filter: null, sort: null, keys: [] });
});

test("an_excel_preview_shows_the_sheet", async () => {
  const { dialog } = setup(tableOrigin(), conn, { ...PREVIEW, lines: [], sheet: [["id", "sku"], ["101", "KF-0101"]] });
  await userEvent.click(within(dialog).getByRole("radio", { name: "Excel" }));
  const sheet = await within(dialog).findByRole("table", { name: "Sheet menu_items" });
  expect(within(sheet).getByText("KF-0101")).toBeTruthy();
  expect(within(dialog).getByText("One sheet named menu_items. bigint and numeric are written as text, so no digits are lost.")).toBeTruthy();
});

test("the_format_switch_changes_the_extension", async () => {
  const { dialog } = setup();
  const name = within(dialog).getByRole("textbox", { name: "File name" }) as HTMLInputElement;
  await userEvent.click(within(dialog).getByRole("radio", { name: "JSON" }));
  // Item 45: JSON is one array by default, with its own hint; JSON Lines is the second layout.
  expect(name.value).toBe("menu_items.json");
  expect(within(dialog).getByText("One JSON array of objects. Opens in any editor.")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: /More options/ }));
  const layouts = within(dialog).getByRole("radiogroup", { name: "Layout" });
  expect(within(layouts).getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? r.textContent)).toEqual(["Array, .json", "JSON Lines, .jsonl"]);
  await userEvent.click(within(layouts).getByRole("radio", { name: "JSON Lines, .jsonl" }));
  expect(name.value).toBe("menu_items.jsonl");
  expect(within(dialog).getByText("One JSON object per line. Opens in any editor.")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("radio", { name: "Excel" }));
  expect(name.value).toBe("menu_items.xlsx");
  await userEvent.click(within(dialog).getByRole("radio", { name: "SQL INSERT" }));
  expect(name.value).toBe("menu_items.sql");
  expect(within(dialog).getByText("INSERT statements for PostgreSQL. Restore a whole database with Backup instead.")).toBeTruthy();
  await userEvent.clear(name);
  await userEvent.type(name, "oct.csv");
  await userEvent.click(within(dialog).getByRole("radio", { name: "CSV" }));
  expect(name.value).toBe("oct.csv");
  await screen.findByText(/About/);
});

test("browse_uses_the_save_dialog", async () => {
  const plugin = await import("@tauri-apps/plugin-dialog");
  vi.mocked(plugin.save).mockResolvedValue("D:\\Out\\menu-oct.csv");
  const { dialog } = setup();
  await userEvent.click(within(dialog).getByRole("button", { name: "Browse..." }));
  expect(vi.mocked(plugin.save)).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "E:\\Exports\\menu_items.csv" }));
  expect((within(dialog).getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("menu-oct.csv");
  expect(within(dialog).getByText("in D:\\Out")).toBeTruthy();
});

test("existing_file_asks_replace", async () => {
  const { dialog } = setup();
  let first = true;
  routeInvoke({
    preview_export: () => PREVIEW,
    start_export: () => {
      if (first) {
        first = false;
        throw { kind: "fileExists", message: "E:\\Exports\\menu_items.csv" };
      }
      return undefined;
    },
  });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  const ask = await screen.findByRole("dialog", { name: "Replace the file" });
  expect(within(ask).getByText("menu_items.csv exists. Replace it?")).toBeTruthy();
  await userEvent.click(within(ask).getByRole("button", { name: "Replace" }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(2));
  const [a, b] = callsTo("start_export");
  expect(a.overwrite).toBe(false);
  expect(b.overwrite).toBe(true);
  expect(b.job).not.toBe(a.job);
});

test("cancel_on_the_replace_question_goes_back_to_the_form", async () => {
  const { dialog } = setup();
  routeInvoke({
    preview_export: () => PREVIEW,
    start_export: () => {
      throw { kind: "fileExists", message: "E:\\Exports\\menu_items.csv" };
    },
  });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  const ask = await screen.findByRole("dialog", { name: "Replace the file" });
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("dialog", { name: /Export public.menu_items/ })).toBeTruthy();
  expect(callsTo("start_export")).toHaveLength(1);
});

test("a_short_job_closes_with_the_toast_and_never_shows_the_running_frame", async () => {
  const { dialog, onClose } = setup();
  await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  const call = callsTo("start_export")[0];
  expect(call.overwrite).toBe(false);
  expect((call.req as ExportRequest).path).toBe("E:\\Exports\\menu_items.csv");
  expect(probe?.jobs.map((j) => j.id)).toEqual([call.job]);
  act(() => lastEvents().onmessage({ kind: "finished", report: report(86, "E:\\Exports\\menu_items.csv") }));
  expect(await screen.findByText("Exported 86 rows to menu_items.csv")).toBeTruthy();
  expect(onClose).toHaveBeenCalled();
  expect(screen.queryByText(/^Writing/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
  expect(callsTo("reveal_in_folder")[0]).toEqual({ path: "E:\\Exports\\menu_items.csv" });
  expect(localStorage.getItem("contura.exportFolder")).toBe("E:\\Exports");
});

test("a_long_job_shows_the_running_frame_after_2s_and_runs_in_the_background", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { dialog, onClose } = setup();
  fireEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  const id = callsTo("start_export")[0].job;
  expect((within(dialog).getByRole("button", { name: /^Export/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/^Writing/)).toBeNull();
  act(() =>
    lastEvents().onmessage({
      kind: "progress",
      phase: "writing",
      table: null,
      rowsDone: 412_000,
      rowsTotal: 1_284_339,
      bytesDone: 148 * 1024 * 1024,
      bytesTotal: null,
      statementsDone: 0,
      fileRow: null,
    }),
  );
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  const run = await screen.findByRole("dialog", { name: /Export public.menu_items/ });
  expect(within(run).getByText("Writing")).toBeTruthy();
  expect(within(run).getByText("E:\\Exports\\menu_items.csv")).toBeTruthy();
  expect(within(run).getByText("32 percent")).toBeTruthy();
  expect(within(run).getByRole("progressbar")).toBeTruthy();
  expect(within(run).getByText("412,000 of 1,284,339")).toBeTruthy();
  expect(within(run).getByText("148 MB")).toBeTruthy();
  expect(within(run).getByText("Reads one consistent snapshot. Rows added while it runs are not in the file.")).toBeTruthy();
  expect(within(run).getByText("Cancel deletes the unfinished file.")).toBeTruthy();
  expect(run.classList.contains("dialog-size-form")).toBe(true);
  fireEvent.click(within(run).getByRole("button", { name: /Run in the background/ }));
  expect(onClose).toHaveBeenCalled();
  const kept = probe?.jobs.find((j) => j.id === id);
  expect(kept?.background).toBe(true);
  expect(kept?.done).toBeNull();
});

test("cancel_in_the_running_frame_calls_cancel_job", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { dialog, onClose } = setup();
  fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "File name" }), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  const id = callsTo("start_export")[0].job;
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  const run = await screen.findByRole("dialog", { name: /Export public.menu_items/ });
  fireEvent.click(within(run).getByRole("button", { name: /^Cancel/ }));
  await waitFor(() => expect(callsTo("cancel_job")).toEqual([{ job: id }]));
  act(() => lastEvents().onmessage({ kind: "failed", error: { kind: "cancelled" } }));
  expect(await screen.findByText("Export cancelled. The unfinished file was deleted.")).toBeTruthy();
  expect(onClose).toHaveBeenCalled();
});

test("esc_while_running_sends_the_export_to_the_background", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { dialog, onClose } = setup();
  fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "File name" }), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  const id = callsTo("start_export")[0].job;
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  const run = await screen.findByRole("dialog", { name: /Export public.menu_items/ });
  fireEvent.keyDown(within(run).getByRole("button", { name: /Run in the background/ }), { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
  expect(callsTo("cancel_job")).toEqual([]);
  expect(probe?.jobs.find((j) => j.id === id)?.background).toBe(true);
});

for (const how of ["escape", "close_button", "scrim"] as const) {
  test(`closing_in_the_first_2s_by_${how}_sends_the_job_to_the_background`, async () => {
    const { dialog, onClose } = setup();
    await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
    await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
    const id = callsTo("start_export")[0].job;
    if (how === "escape") fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "File name" }), { key: "Escape" });
    else if (how === "close_button") fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    else fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalled();
    expect(callsTo("cancel_job")).toEqual([]);
    const kept = probe?.jobs.find((j) => j.id === id);
    expect(kept?.background).toBe(true);
    expect(kept?.done).toBeNull();
  });
}

test("cancel_in_the_first_2s_cancels_the_job", async () => {
  const { dialog, onClose } = setup();
  await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  const id = callsTo("start_export")[0].job;
  await userEvent.click(within(dialog).getByRole("button", { name: /^Cancel/ }));
  await waitFor(() => expect(callsTo("cancel_job")).toEqual([{ job: id }]));
  expect(onClose).not.toHaveBeenCalled();
  act(() => lastEvents().onmessage({ kind: "failed", error: { kind: "cancelled" } }));
  expect(await screen.findByText("Export cancelled. The unfinished file was deleted.")).toBeTruthy();
  expect(onClose).toHaveBeenCalled();
});

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open export
      </button>
      {open && <ExportDialog connection={conn} group={null} origin={tableOrigin()} onClose={() => setOpen(false)} />}
    </>
  );
}

function renderHost() {
  routeInvoke({ preview_export: () => PREVIEW, start_export: () => undefined, cancel_job: () => undefined });
  render(
    <ToastProvider>
      <JobsProvider>
        <Probe />
        <Host />
      </JobsProvider>
    </ToastProvider>,
  );
}

test("focus_returns_to_the_opener_after_the_running_frame", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderHost();
  const opener = screen.getByRole("button", { name: "Open export" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: /Export public.menu_items/ });
  fireEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  fireEvent.click(await screen.findByRole("button", { name: /Run in the background/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
});

test("focus_returns_to_the_opener_after_the_replace_question", async () => {
  renderHost();
  const opener = screen.getByRole("button", { name: "Open export" });
  opener.focus();
  await userEvent.click(opener);
  let first = true;
  routeInvoke({
    preview_export: () => PREVIEW,
    start_export: () => {
      if (first) {
        first = false;
        throw { kind: "fileExists", message: "E:\\Exports\\menu_items.csv" };
      }
      return undefined;
    },
  });
  const dialog = await screen.findByRole("dialog", { name: /Export public.menu_items/ });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  const ask = await screen.findByRole("dialog", { name: "Replace the file" });
  // A destructive question starts on Cancel, so Enter does not overwrite.
  expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Cancel" }));
  await userEvent.click(within(ask).getByRole("button", { name: "Replace" }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(2));
  act(() => lastEvents().onmessage({ kind: "finished", report: report(86, "E:\\Exports\\menu_items.csv") }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
});

test("a_write_result_with_a_slow_preview_never_exports_the_query", async () => {
  const { dialog } = setup(resultOrigin);
  routeInvoke({ preview_export: () => new Promise(() => {}), start_export: () => undefined });
  fireEvent.keyDown(within(dialog).getByRole("radio", { name: /Rows shown/ }), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  expect((callsTo("start_export")[0].req as ExportRequest).source.kind).toBe("rows");
  expect(within(dialog).queryByRole("radio", { name: "The result of this query" })).toBeNull();
});

test("a_failed_preview_keeps_rows_shown", async () => {
  const origin: ExportOrigin = { ...resultOrigin, sql: "select * from t" } as ExportOrigin;
  const { dialog } = setup(origin);
  routeInvoke({
    preview_export: () => {
      throw { kind: "query", message: "boom" };
    },
  });
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  expect(within(dialog).getByRole("radio", { name: /Rows shown/ })).toBeTruthy();
  expect(within(dialog).queryByRole("radio", { name: "The result of this query" })).toBeNull();
});

test("notes_already_shown_in_the_form_are_not_repeated", async () => {
  const origin: ExportOrigin = { ...resultOrigin, sql: "select * from t" } as ExportOrigin;
  const { dialog } = setup(origin, { ...conn, production: true }, {
    ...PREVIEW,
    notes: ["Runs the query again on its own connection.", "The file is plain text and holds Production rows. Keep it somewhere safe.", "Other."],
  });
  await within(dialog).findByText("Other.");
  expect(within(dialog).getAllByText("Runs the query again on its own connection.")).toHaveLength(1);
  expect(within(dialog).getAllByText("The file is plain text and holds Production rows. Keep it somewhere safe.")).toHaveLength(1);
});

test("all_columns_reordered_says_so", async () => {
  const { dialog } = setup();
  await userEvent.click(within(dialog).getByRole("button", { name: "Choose..." }));
  const pop = screen.getByRole("dialog", { name: "Columns" });
  await userEvent.click(within(pop).getByRole("button", { name: "Move price up" }));
  await userEvent.keyboard("{Escape}");
  expect(within(dialog).getByText("All 6 columns, reordered")).toBeTruthy();
});

test("tab_out_of_the_chooser_closes_it", async () => {
  const { dialog } = setup();
  await userEvent.click(within(dialog).getByRole("button", { name: "Choose..." }));
  const pop = screen.getByRole("dialog", { name: "Columns" });
  fireEvent.blur(within(pop).getAllByRole("checkbox")[0], { relatedTarget: within(dialog).getByRole("textbox", { name: "File name" }) });
  expect(screen.queryByRole("dialog", { name: "Columns" })).toBeNull();
});

test("ctrl_enter_exports_and_esc_cancels", async () => {
  const { dialog, onClose } = setup();
  fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "File name" }), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  cleanup();
  const second = setup();
  await userEvent.keyboard("{Escape}");
  expect(second.onClose).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(0);
});

test("a_failed_export_stays_open_with_the_error", async () => {
  const { dialog, onClose } = setup();
  await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  act(() => lastEvents().onmessage({ kind: "failed", error: { kind: "file", message: "cannot write E:\\Exports\\menu_items.csv" } }));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  expect(probe?.jobs).toEqual([]);
});

test("a_read_result_offers_the_result_of_this_query", async () => {
  const origin: ExportOrigin = { ...resultOrigin, sql: "select * from t" } as ExportOrigin;
  const { dialog } = setup(origin);
  // Q26: Rows shown until the preview says the statement reads.
  expect(within(dialog).getByRole("radio", { name: /Rows shown/ })).toBeTruthy();
  expect(await within(dialog).findByRole("radio", { name: "The result of this query" })).toBeTruthy();
  expect(within(dialog).getByText("Runs the query again on its own connection.")).toBeTruthy();
  await screen.findByText("About 107 bytes a row");
  const req = callsTo("preview_export")[0].req as ExportRequest;
  expect(req.source).toEqual({ kind: "query", database: "shop", sql: "select * from t", columns: [] });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  expect((callsTo("start_export")[0].req as ExportRequest).source.kind).toBe("query");
});

test("a_write_result_offers_only_rows_shown", async () => {
  const { dialog } = setup(resultOrigin, conn, { ...PREVIEW, queryRead: false });
  expect(await within(dialog).findByRole("radio", { name: /Rows shown/ })).toBeTruthy();
  expect(within(dialog).queryByRole("radio", { name: "The result of this query" })).toBeNull();
  await waitFor(() => {
    const req = callsTo("preview_export").slice(-1)[0].req as ExportRequest;
    expect(req.source.kind).toBe("rows");
  });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  expect((callsTo("start_export")[0].req as ExportRequest).source.kind).toBe("rows");
});

test("the_production_banner_shows_once", async () => {
  const { dialog } = setup(tableOrigin(), { ...conn, production: true }, { ...PREVIEW, notes: ["Some note."] });
  await screen.findByText("Some note.");
  expect(within(dialog).getAllByText("The file is plain text and holds Production rows. Keep it somewhere safe.")).toHaveLength(1);
});

test("choose_picks_and_orders_columns", async () => {
  const { dialog } = setup();
  await userEvent.click(within(dialog).getByRole("button", { name: "Choose..." }));
  const pop = screen.getByRole("dialog", { name: "Columns" });
  await userEvent.click(within(pop).getByRole("checkbox", { name: "sku" }));
  await userEvent.click(within(pop).getByRole("button", { name: "Move price up" }));
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Columns" })).toBeNull();
  expect(screen.getByRole("dialog", { name: /Export public.menu_items/ })).toBeTruthy();
  expect(within(dialog).getByText("5 of 6 columns")).toBeTruthy();
  await waitFor(() => {
    const req = callsTo("preview_export").slice(-1)[0].req as ExportRequest;
    expect(req.source).toMatchObject({ columns: ["id", "name", "price", "category", "is_available"] });
  });
});

test("columns_hidden_in_the_grid_start_off", async () => {
  const { dialog } = setup(tableOrigin({ hidden: ["sku"] }));
  expect(within(dialog).getByText("5 of 6 columns")).toBeTruthy();
  await waitFor(() => {
    const req = callsTo("preview_export").slice(-1)[0].req as ExportRequest;
    expect((req.source as { columns: string[] }).columns).not.toContain("sku");
  });
});

test("rows_shown_leave_out_the_columns_hidden_in_the_result", async () => {
  const origin: ExportOrigin = {
    ...resultOrigin,
    columns: [
      { name: "id", typeName: "int4", numeric: true },
      { name: "name", typeName: "text", numeric: false },
    ],
    rows: [[{ t: "number", value: "1" }, { t: "text", value: "Tea", truncated: false, totalBytes: 3 }]],
    hidden: ["name"],
  } as ExportOrigin;
  const { dialog } = setup(origin);
  routeInvoke({ preview_export: () => new Promise(() => {}), start_export: () => undefined });
  fireEvent.keyDown(within(dialog).getByRole("radio", { name: /Rows shown/ }), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  expect((callsTo("start_export")[0].req as ExportRequest).source).toEqual({
    kind: "rows",
    columns: [{ name: "id", typeName: "int4", numeric: true }],
    rows: [[{ t: "number", value: "1" }]],
  });
});

test("the_result_of_this_query_sends_only_the_shown_columns", async () => {
  const origin: ExportOrigin = {
    ...resultOrigin,
    sql: "select id, name, price from t",
    columns: [
      { name: "id", typeName: "int4", numeric: true },
      { name: "name", typeName: "text", numeric: false },
      { name: "price", typeName: "numeric", numeric: true },
    ],
    rows: [],
    hidden: ["name"],
  } as ExportOrigin;
  const { dialog } = setup(origin);
  expect(await within(dialog).findByRole("radio", { name: "The result of this query" })).toBeTruthy();
  const query = { kind: "query", database: "shop", sql: "select id, name, price from t", columns: ["id", "price"] };
  expect((callsTo("preview_export")[0].req as ExportRequest).source).toEqual(query);
  await userEvent.click(within(dialog).getByRole("button", { name: /^Export/ }));
  await waitFor(() => expect(callsTo("start_export")).toHaveLength(1));
  expect((callsTo("start_export")[0].req as ExportRequest).source).toEqual(query);
});

test("choose_closes_the_column_chooser_it_opened_m8", async () => {
  const { dialog } = setup();
  const choose = within(dialog).getByRole("button", { name: "Choose..." });
  await userEvent.click(choose);
  const pop = screen.getByRole("dialog", { name: "Columns" });
  // Focus inside the chooser, as after ticking a column.
  within(pop).getAllByRole("checkbox")[0].focus();
  await userEvent.click(choose);
  expect(screen.queryByRole("dialog", { name: "Columns" })).toBeNull();
  expect(choose.getAttribute("aria-expanded")).toBe("false");
});
