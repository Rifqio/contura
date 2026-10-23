import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, FileSummary, ImportPlan, JobEvent, ScriptPlan, ScriptStatement } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import ImportTab from "./ImportTab";
import type { ImportTarget } from "./importModel";
import { JobsProvider, useJobs } from "./useJobs";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
});

const CONN: ConnectionConfig = {
  id: "c1",
  name: "kestrel-main",
  dialect: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
  groupId: null,
};
const PROD: ConnectionConfig = { ...CONN, name: "freight-prod", production: true };
const RO: ConnectionConfig = { ...CONN, name: "kestrel-reporting", readOnly: true };
const OTHER: ConnectionConfig = { ...CONN, id: "c2", name: "kestrel-backup" };
const MYSQL: ConnectionConfig = { ...CONN, id: "c3", name: "orbit", dialect: "mysql" };

const PATH = { database: "shop", schema: "public", name: "menu_items" };
const TABLE: ImportTarget = { kind: "table", path: PATH };

const SUMMARY: FileSummary = {
  format: "csv",
  delimiter: "semicolon",
  encoding: "UTF-8",
  bytes: 212 * 1024,
  header: ["id", "name", "price"],
  rows: [
    ["1", "Tea", "2.50"],
    ["2", "Cake", "n/a"],
  ],
  rowsEstimate: { rows: 1204, exact: true },
  sheets: [],
  conturaBackup: false,
};

const PLAN: ImportPlan = {
  columns: [
    { into: "id", typeSql: "integer", fileColumn: 0, note: null, blocks: null, generated: false },
    { into: "name", typeSql: "text", fileColumn: 1, note: null, blocks: null, generated: false },
    { into: "price", typeSql: "numeric(10,2)", fileColumn: 2, note: "1 row is not a number", blocks: null, generated: false },
    { into: "total", typeSql: "numeric", fileColumn: null, note: null, blocks: null, generated: true },
  ],
  preview: [
    [
      { text: "1", problem: null },
      { text: "Tea", problem: null },
      { text: "2.50", problem: null },
    ],
    [
      { text: "2", problem: null },
      { text: "Cake", problem: null },
      { text: "n/a", problem: "n/a is not a number for price." },
    ],
  ],
  sampleInsert: "INSERT INTO public.menu_items (id, name, price) VALUES\n  (1, 'Tea', '2.50'),\n  (2, 'Cake', 'n/a')",
  extra: [],
  shape: { head: "INSERT INTO public.menu_items (id, name, price) VALUES", firstRows: ["(1, 'Tea', '2.50')"], rowsPerStatement: 500, statements: 3, rows: 1204 },
  warnings: [],
  verdict: { kind: "ok" },
};

const SHA = "4be091c2" + "0".repeat(52) + "7d1f";
const PROD_PLAN: ImportPlan = {
  ...PLAN,
  verdict: { kind: "needsConfirmation", connection: "freight-prod", database: "shop", fingerprint: "f", fileBytes: 212 * 1024, fileSha256: SHA },
};

type Channel = { onmessage: (e: JobEvent) => void };

function routes(over: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const sent: { check: Channel[]; run: Channel[] } = { check: [], run: [] };
  routeInvoke({
    inspect_import_file: () => SUMMARY,
    plan_import: () => PLAN,
    check_import_file: (a) => {
      sent.check.push(a.events as Channel);
      return `chk-${sent.check.length}`;
    },
    cancel_job: () => undefined,
    confirm_import: () => "pass-1",
    start_import: (a) => {
      sent.run.push(a.events as Channel);
      return undefined;
    },
    ...over,
  });
  return sent;
}

function renderTab(over: Partial<Parameters<typeof ImportTab>[0]> = {}) {
  const props = {
    connection: CONN,
    group: null,
    target: TABLE,
    visible: true,
    writable: [CONN, OTHER, MYSQL],
    onRetarget: vi.fn(),
    onTargetChange: vi.fn(),
    onOpenTable: vi.fn(),
    onRunningChange: vi.fn(),
    ...over,
  };
  render(
    <JobsProvider>
      <Probe />
      <ImportTab {...props} />
    </JobsProvider>,
  );
  return props;
}

let probe: ReturnType<typeof useJobs> | null = null;
function Probe() {
  probe = useJobs();
  return null;
}

async function chooseFile(path = "C:\\data\\menu.csv") {
  vi.mocked(open).mockResolvedValueOnce(path);
  fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
  await screen.findByText(/columns, /);
}

async function toColumns() {
  await chooseFile();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("table", { name: "Columns" });
}

const lastCall = (cmd: string) => callsTo(cmd).slice(-1)[0];
const combo = (name: string) => screen.getByRole("combobox", { name });
const intoValues = () => screen.getAllByRole("combobox", { name: /^Into column for / }).map((b) => b.textContent);
const stepNow = () => document.querySelector(".import-steps [aria-current='step']")?.textContent;
const tab = () => document.querySelector(".import-tab") as HTMLElement;

test("file_step_fills_format_and_delimiter_with_the_hint", async () => {
  routes();
  renderTab();
  await chooseFile();
  expect(vi.mocked(open).mock.calls[0][0]).toMatchObject({
    multiple: false,
    filters: [{ extensions: ["csv", "tsv", "txt", "json", "jsonl", "ndjson", "xlsx", "sql"] }],
  });
  expect(callsTo("inspect_import_file")[0]).toEqual({ path: "C:\\data\\menu.csv", format: null });
  expect(screen.getByText("1,204 rows, 3 columns, 212 KB")).toBeTruthy();
  expect(combo("Format").textContent).toContain("CSV");
  expect(combo("Delimiter").textContent).toContain("Semicolon");
  expect(stepNow()).toContain("File");
});

test("file_hint_says_about_for_an_estimate", async () => {
  routes({ inspect_import_file: () => ({ ...SUMMARY, rowsEstimate: { rows: 4_200_000, exact: false } }) });
  renderTab();
  await chooseFile();
  expect(screen.getByText("about 4.2 million rows, 3 columns, 212 KB")).toBeTruthy();
});

test("mapping_shows_renamed_headers", async () => {
  routes({
    inspect_import_file: () => ({ ...SUMMARY, header: ["Column 1", "name", "name (2)"], rows: [["a", "b", "c"]] }),
    plan_import: () => ({
      ...PLAN,
      columns: [{ into: "name", typeSql: "text", fileColumn: 1, note: null, blocks: null, generated: false }],
      preview: [[{ text: "b", problem: null }]],
    }),
  });
  renderTab();
  await toColumns();
  const rows = within(screen.getByRole("table", { name: "Columns" })).getAllByRole("row").slice(1);
  expect(rows.map((r) => r.querySelector("th, td")!.textContent)).toEqual(["Column 1", "name", "name (2)"]);
  expect(intoValues()).toEqual(["Not imported", "name", "Not imported"]);
  expect(rows[0].textContent).toContain("Not imported");
});

test("ctrl_m_matches_by_name", async () => {
  routes({ plan_import: (a) => ((a.req as { mapping: unknown[] }).mapping.length ? PLAN : { ...PLAN, columns: PLAN.columns.map((c) => ({ ...c, fileColumn: null })) }) });
  renderTab();
  await toColumns();
  // The first plan matched nothing; pick by hand, then Ctrl+M matches by name again.
  await waitFor(() => expect(intoValues()).toEqual(["Not imported", "Not imported", "Not imported"]));
  fireEvent.keyDown(tab(), { key: "m", ctrlKey: true });
  await waitFor(() => expect(intoValues()).toEqual(["id", "name", "price"]));
  const last = lastCall("plan_import")!.req as { mapping: unknown[] };
  expect(last.mapping).toEqual([
    { fileColumn: 0, into: "id", byHand: false },
    { fileColumn: 1, into: "name", byHand: false },
    { fileColumn: 2, into: "price", byHand: false },
  ]);
});

test("f2_focuses_the_into_select_of_the_row", async () => {
  routes();
  renderTab();
  await toColumns();
  fireEvent.keyDown(tab(), { key: "F2" });
  expect(document.activeElement).toBe(combo("Into column for id"));
  const third = combo("Into column for price").closest("tr")!.querySelector("td")!;
  fireEvent.keyDown(third, { key: "F2" });
  expect(document.activeElement).toBe(combo("Into column for price"));
});

test("choosing_an_into_column_by_hand_replans_with_the_mapping", async () => {
  routes();
  renderTab();
  await toColumns();
  await userEvent.click(combo("Into column for id"));
  await userEvent.click(screen.getByRole("option", { name: /Not imported/ }));
  await waitFor(() => expect(intoValues()[0]).toBe("Not imported"));
  const last = lastCall("plan_import")!.req as { mapping: unknown[] };
  expect(last.mapping).toEqual([
    { fileColumn: 0, into: null, byHand: true },
    { fileColumn: 1, into: "name", byHand: false },
    { fileColumn: 2, into: "price", byHand: false },
  ]);
});

test("an_unmapped_not_null_column_blocks_the_run", async () => {
  routes({ plan_import: () => ({ ...PLAN, verdict: { kind: "blocked", reasons: ["price needs a value: map a file column to it."] } }) });
  renderTab();
  await toColumns();
  expect(await screen.findByText("price needs a value: map a file column to it.")).toBeTruthy();
  expect((screen.getByRole("button", { name: /^Import 1,204 rows/ }) as HTMLButtonElement).disabled).toBe(true);
});

test("generated_columns_are_not_offered", async () => {
  routes();
  renderTab();
  await toColumns();
  await userEvent.click(combo("Into column for id"));
  const names = screen.getAllByRole("option").map((o) => o.textContent);
  expect(names.some((n) => n?.startsWith("price"))).toBe(true);
  expect(names.some((n) => n?.startsWith("total"))).toBe(false);
});

test("preview_marks_problem_cells_in_danger", async () => {
  routes();
  renderTab();
  await toColumns();
  const bad = await waitFor(() => {
    const cell = document.querySelector(".import-preview .import-cell-problem");
    expect(cell).toBeTruthy();
    return cell as HTMLElement;
  });
  expect(bad.textContent).toContain("n/a");
  expect(bad.getAttribute("title")).toBe("n/a is not a number for price.");
});

test("check_pass_runs_300ms_after_the_mapping_settles_and_a_change_cancels_it", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  const sent = routes();
  renderTab();
  vi.mocked(open).mockResolvedValueOnce("C:\\data\\menu.csv");
  fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
  await act(async () => {
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(299);
  });
  expect(callsTo("check_import_file")).toHaveLength(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(callsTo("check_import_file")).toHaveLength(1);
  // A mapping change cancels the running pass and starts a new one once it settles.
  fireEvent.keyDown(tab(), { key: "m", ctrlKey: true });
  await act(async () => {
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
  });
  expect(callsTo("cancel_job")).toEqual([{ job: "chk-1" }]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(callsTo("check_import_file")).toHaveLength(2);
  act(() =>
    sent.check[1].onmessage({
      kind: "finished",
      report: {
        kind: "check",
        rowsRead: 1204,
        rowsWritten: 0,
        statements: 0,
        skipped: 0,
        warnings: [],
        elapsedMs: 5,
        file: null,
        bytes: 0,
        committed: 0,
        check: { rows: 1204, failing: 2, first: [{ fileRow: 7, column: "price", message: "n/a is not a number for price." }], sha256: SHA },
      },
    }),
  );
  expect(screen.getByText("2 rows will fail. Row 7 of the file: n/a is not a number for price. Fix the file, or choose Skip the row.")).toBeTruthy();
  // The cancelled pass's late end changes nothing.
  act(() => sent.check[0].onmessage({ kind: "failed", error: { kind: "cancelled", message: "" } as never }));
  expect(screen.getByText(/2 rows will fail/)).toBeTruthy();
});

test("footer_text_follows_the_commit_option", async () => {
  routes();
  renderTab();
  await toColumns();
  expect(screen.getByText("Writes 1,204 rows into public.menu_items in one transaction. Cancel rolls everything back.")).toBeTruthy();
  await userEvent.click(combo("Commit"));
  await userEvent.click(screen.getByRole("option", { name: /Every 10,000 rows/ }));
  expect(
    await screen.findByText("Writes 1,204 rows into public.menu_items, committing every 10,000 rows. If the import stops, the rows committed before it stay."),
  ).toBeTruthy();
  const last = lastCall("plan_import")!.req as { options: { commit: unknown } };
  expect(last.options.commit).toEqual({ kind: "every", rows: 10000 });
});

test("show_sample_insert_opens_the_first_statement", async () => {
  routes();
  renderTab();
  await toColumns();
  await userEvent.click(screen.getByRole("button", { name: "Show sample INSERT" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("First statement, 500 rows.");
  expect(dialog.querySelector(".sql-block")!.textContent).toContain("(2, 'Cake', 'n/a')");
});

test("read_only_target_shows_the_reason_and_choose_connection", async () => {
  routes({ plan_import: () => ({ ...PLAN, verdict: { kind: "readOnly", connection: "kestrel-reporting" } }) });
  const props = renderTab({ connection: RO });
  expect(screen.getByText("kestrel-reporting is Read-only. Import is not allowed here.")).toBeTruthy();
  await toColumns();
  expect((screen.getByRole("button", { name: /^Import 1,204 rows/ }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(combo("Choose Connection..."));
  const options = screen.getAllByRole("option").map((o) => o.textContent);
  // Writable Connections of the same Dialect only.
  expect(options.some((o) => o?.includes("kestrel-backup"))).toBe(true);
  expect(options.some((o) => o?.includes("orbit"))).toBe(false);
  await userEvent.click(screen.getByRole("option", { name: /kestrel-backup/ }));
  expect(props.onRetarget).toHaveBeenCalledWith("c2");
  expect(callsTo("start_import")).toHaveLength(0);
});

test("production_confirms_then_starts_with_the_pass", async () => {
  routes({ plan_import: () => PROD_PLAN });
  renderTab({ connection: PROD });
  await toColumns();
  const run = screen.getByRole("button", { name: /^Import on PROD\.\.\./ });
  expect(run.className).toContain("button-prod");
  fireEvent.click(run);
  const dialog = await screen.findByRole("dialog");
  expect(dialog.querySelector("h2")!.textContent).toBe("Import on freight-prod · shop");
  expect(dialog.textContent).toContain("The file is fingerprinted (212 KB, SHA-256 4be0 91c2 ... 7d1f).");
  expect(dialog.textContent).toContain("Inserts 1,204 rows into public.menu_items in 3 statements, in one transaction.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Import on freight-prod" }));
  await waitFor(() => expect(callsTo("start_import")).toHaveLength(1));
  const order = vi.mocked(invoke).mock.calls.map(([c]) => c).filter((c) => c === "confirm_import" || c === "start_import");
  expect(order).toEqual(["confirm_import", "start_import"]);
  const start = callsTo("start_import")[0];
  expect(start.pass).toBe("pass-1");
  expect(typeof start.job).toBe("string");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("file_changed_shows_the_error_and_reopens_the_dialog", async () => {
  routes({
    plan_import: () => PROD_PLAN,
    start_import: () => {
      throw { kind: "fileChanged", message: { file: "menu.csv", confirmed: true } };
    },
  });
  renderTab({ connection: PROD });
  await toColumns();
  fireEvent.click(screen.getByRole("button", { name: /^Import on PROD\.\.\./ }));
  const dialog = await screen.findByRole("dialog");
  const before = callsTo("plan_import").length;
  fireEvent.click(within(dialog).getByRole("button", { name: "Import on freight-prod" }));
  expect(await screen.findByText("menu.csv changed after you confirmed. Nothing was imported.")).toBeTruthy();
  // A new plan, and the dialog again with it.
  await waitFor(() => expect(callsTo("plan_import").length).toBeGreaterThan(before));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(callsTo("confirm_import")).toHaveLength(1);
  expect(callsTo("start_import")).toHaveLength(1);
});

const REPORT = {
  kind: "import" as const,
  rowsRead: 1204,
  rowsWritten: 1203,
  statements: 3,
  skipped: 1,
  warnings: [],
  elapsedMs: 2100,
  file: "C:\\data\\menu.csv",
  bytes: 0,
  committed: 0,
  check: null,
};

test("run_view_skipped_rows_end_text_and_running_change", async () => {
  const sent = routes();
  const props = renderTab();
  await toColumns();
  fireEvent.click(screen.getByRole("button", { name: /^Import 1,204 rows/ }));
  await waitFor(() => expect(sent.run).toHaveLength(1));
  expect(props.onRunningChange).toHaveBeenLastCalledWith(true);
  act(() =>
    sent.run[0].onmessage({
      kind: "progress",
      phase: "writing",
      table: "menu_items",
      rowsDone: 500,
      rowsTotal: 1204,
      bytesDone: 0,
      bytesTotal: null,
      statementsDone: 1,
      fileRow: 501,
    }),
  );
  expect(screen.getByText("500 of 1,204")).toBeTruthy();
  expect(screen.getByText("501")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel and roll back" })).toBeTruthy();
  act(() => sent.run[0].onmessage({ kind: "rowSkipped", fileRow: 7, column: "price", message: "invalid input syntax for type numeric" }));
  const list = screen.getByRole("table", { name: "Rows skipped" });
  expect(list.textContent).toContain("invalid input syntax for type numeric");
  act(() => sent.run[0].onmessage({ kind: "finished", report: REPORT }));
  expect(screen.getByText("Imported 1,203 rows into menu_items in 2s")).toBeTruthy();
  expect(props.onRunningChange).toHaveBeenLastCalledWith(false);
  await userEvent.click(screen.getByRole("button", { name: "Open table" }));
  expect(props.onOpenTable).toHaveBeenCalledWith(PATH);
});

test("a_failed_run_names_the_row_and_the_tab_stays", async () => {
  const sent = routes();
  renderTab();
  await toColumns();
  fireEvent.click(screen.getByRole("button", { name: /^Import 1,204 rows/ }));
  await waitFor(() => expect(sent.run).toHaveLength(1));
  act(() =>
    sent.run[0].onmessage({
      kind: "failed",
      error: { kind: "jobFailed", message: { at: { fileRow: 7, line: null, table: "menu_items", statement: 1 }, message: "Row 7 of the file: invalid input syntax for type numeric" } },
    }),
  );
  expect(screen.getByText("Row 7 of the file: invalid input syntax for type numeric")).toBeTruthy();
  // Back to the columns to fix and run again.
  fireEvent.keyDown(tab(), { key: "ArrowLeft", altKey: true });
  expect(await screen.findByRole("table", { name: "Columns" })).toBeTruthy();
});

test("a_cancelled_run_says_nothing_was_imported", async () => {
  const sent = routes();
  renderTab();
  await toColumns();
  fireEvent.click(screen.getByRole("button", { name: /^Import 1,204 rows/ }));
  await waitFor(() => expect(sent.run).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "Cancel and roll back" }));
  expect(callsTo("cancel_job")).toContainEqual({ job: callsTo("start_import")[0].job });
  act(() => sent.run[0].onmessage({ kind: "failed", error: { kind: "cancelled", message: "" } as never }));
  expect(screen.getByText("Import cancelled. Nothing was imported.")).toBeTruthy();
});

test("alt_left_goes_back_and_ctrl_enter_imports", async () => {
  const sent = routes();
  renderTab();
  await toColumns();
  expect(stepNow()).toContain("Columns");
  fireEvent.keyDown(tab(), { key: "ArrowLeft", altKey: true });
  expect(stepNow()).toContain("File");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("table", { name: "Columns" });
  fireEvent.keyDown(tab(), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(sent.run).toHaveLength(1));
});

test("the_panes_carry_the_production_wash", () => {
  routes();
  renderTab({ connection: PROD });
  expect(tab().className).toContain("prod-wash");
});

function stmt(index: number): ScriptStatement {
  return { index, line: index * 2 + 1, text: `INSERT INTO t VALUES (${index})`, class: "write", kind: "insert", action: { kind: "run" } };
}

const SCRIPT: ScriptPlan = {
  statements: 1503,
  creates: 31,
  inserts: 1472,
  skipped: [{ ...stmt(0), text: "GRANT SELECT ON t TO bob", kind: "other", action: { kind: "skip", reason: "GRANT is skipped" } }, { ...stmt(1), text: "GRANT ALL ON t TO amy", kind: "other", action: { kind: "skip", reason: "GRANT is skipped" } }],
  refused: [],
  ownTransactions: false,
  hasDdl: true,
  conturaBackup: true,
  first: Array.from({ length: 50 }, (_, i) => stmt(i)),
  confirm: [],
  confirmMore: 0,
  bytes: 4096,
  sha256: SHA,
  verdict: { kind: "ok" },
};

test("a_sql_file_turns_the_tab_into_a_database_import_with_statements", async () => {
  routeInvoke({
    plan_script: () => SCRIPT,
    script_statements: (a) => Array.from({ length: 100 }, (_, i) => stmt((a.from as number) + i)),
    cancel_job: () => undefined,
  });
  const props = renderTab();
  vi.mocked(open).mockResolvedValueOnce("C:\\data\\dump.sql");
  fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
  await waitFor(() => expect(props.onTargetChange).toHaveBeenCalledWith({ kind: "database", database: "shop" }));
  expect(await screen.findByText("1,503 statements: 31 create, 1,472 insert. 2 GRANT are skipped.")).toBeTruthy();
  expect(callsTo("plan_script")[0]).toEqual({ req: { connectionId: "c1", database: "shop", path: "C:\\data\\dump.sql", runAsIs: false } });
  expect(stepNow()).toContain("Statements");
  expect(document.querySelectorAll(".script-statement")).toHaveLength(50);
  expect(screen.getByText("This file is a Contura Backup. Restore checks it against the database first.")).toBeTruthy();
  // D25: Open in Restore waits for step 9.
  expect(screen.queryByRole("button", { name: "Open in Restore" })).toBeNull();
  expect(screen.getByText("Runs 1,503 statements in shop in one transaction. Cancel rolls everything back.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Show all" }));
  await waitFor(() => expect(document.querySelectorAll(".script-statement")).toHaveLength(150));
  expect(callsTo("script_statements")[0]).toEqual({ connectionId: "c1", path: "C:\\data\\dump.sql", from: 50 });
  await userEvent.click(screen.getByRole("button", { name: "Show 100 more" }));
  await waitFor(() => expect(callsTo("script_statements")[1]).toEqual({ connectionId: "c1", path: "C:\\data\\dump.sql", from: 150 }));
});

test("run_as_is_plans_the_script_again", async () => {
  routeInvoke({ plan_script: () => SCRIPT, cancel_job: () => undefined });
  renderTab({ target: { kind: "database", database: "shop" } });
  vi.mocked(open).mockResolvedValueOnce("C:\\data\\dump.sql");
  fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
  await screen.findByText(/1,503 statements:/);
  await userEvent.click(screen.getByRole("switch", { name: /Run as is/ }));
  await waitFor(() => expect(lastCall("plan_script")).toEqual({ req: { connectionId: "c1", database: "shop", path: "C:\\data\\dump.sql", runAsIs: true } }));
});

test("the_header_names_into_the_connection_and_the_table", () => {
  routes();
  renderTab({ connection: PROD });
  const head = document.querySelector(".import-head") as HTMLElement;
  expect(head.textContent).toContain("Into");
  expect(head.textContent).toContain("freight-prod");
  expect(head.textContent).toContain("PROD");
  expect(head.textContent).toContain("public.menu_items");
  expect(head.querySelector('[role="img"][aria-label="PostgreSQL"]')).toBeTruthy();
});

// Fix round 1: Q27 (what stayed), Q28 (warnings and the transaction claim), I3 (keys stay in dialogs).

async function startPlainRun(over: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const sent = routes(over);
  const props = renderTab();
  await toColumns();
  fireEvent.click(screen.getByRole("button", { name: /^Import 1,204 rows/ }));
  await waitFor(() => expect(sent.run).toHaveLength(1));
  return { sent, props };
}

test("a_myisam_cancel_says_the_written_rows_stay", async () => {
  const myisam = { ...PLAN, warnings: ["menu_items uses MyISAM: rows written before a failure stay"], oneTransaction: false };
  const { sent } = await startPlainRun({ plan_import: () => myisam });
  // No rollback on MyISAM: the button does not promise one.
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  act(() => sent.run[0].onmessage({ kind: "failed", error: { kind: "cancelled", message: "" } as never, rowsCommitted: 500 }));
  expect(screen.getByText("Import cancelled.")).toBeTruthy();
  expect(screen.getByText("500 rows were written before the stop and stay in menu_items.")).toBeTruthy();
  expect(screen.queryByText(/Nothing was imported/)).toBeNull();
});

test("a_failure_under_commit_every_n_says_the_committed_rows_stay", async () => {
  const { sent } = await startPlainRun();
  act(() =>
    sent.run[0].onmessage({
      kind: "failed",
      error: { kind: "jobFailed", message: { at: { fileRow: 10007, line: null, table: "menu_items", statement: 21 }, message: "Row 10,007 of the file: bad value" } },
      rowsCommitted: 10000,
    }),
  );
  expect(screen.getByText("Row 10,007 of the file: bad value")).toBeTruthy();
  expect(screen.getByText("10,000 rows were written before the stop and stay in menu_items.")).toBeTruthy();
});

test("a_core_end_text_that_says_what_stayed_is_not_repeated", async () => {
  const { sent } = await startPlainRun();
  const text = "menu.csv changed while it was imported. 2,000 rows were written before the stop and stay in menu_items.";
  act(() =>
    sent.run[0].onmessage({
      kind: "failed",
      error: { kind: "jobFailed", message: { at: { fileRow: null, line: null, table: "menu_items", statement: null }, message: text } },
      rowsCommitted: 2000,
    }),
  );
  expect(screen.getByText(text)).toBeTruthy();
  expect(screen.queryByText("2,000 rows were written before the stop and stay in menu_items.")).toBeNull();
});

test("a_file_changed_after_rows_were_kept_shows_the_end_with_the_kept_count_q45", async () => {
  const { sent } = await startPlainRun();
  act(() =>
    sent.run[0].onmessage({
      kind: "failed",
      error: { kind: "fileChanged", message: { file: "menu.csv", confirmed: false } },
      rowsCommitted: 2000,
    }),
  );
  expect(await screen.findByText("menu.csv changed while it was imported.")).toBeTruthy();
  expect(screen.getByText("2,000 rows were written before the stop and stay in menu_items.")).toBeTruthy();
  expect(screen.queryByText(/Nothing was imported/)).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(stepNow()).not.toContain("Columns");
});

test("a_failure_with_nothing_written_says_nothing_was_imported", async () => {
  const { sent } = await startPlainRun();
  act(() =>
    sent.run[0].onmessage({
      kind: "failed",
      error: { kind: "jobFailed", message: { at: { fileRow: 7, line: null, table: "menu_items", statement: 1 }, message: "Row 7 of the file: bad value" } },
    }),
  );
  expect(screen.getByText("Nothing was imported.")).toBeTruthy();
});

test("a_script_with_ddl_that_fails_says_what_stayed_in_the_database", async () => {
  let events: Channel | null = null;
  routeInvoke({
    plan_script: () => ({ ...SCRIPT, conturaBackup: false, oneTransaction: false }),
    start_script: (a) => {
      events = a.events as Channel;
      return undefined;
    },
    cancel_job: () => undefined,
  });
  renderTab({ connection: MYSQL, target: { kind: "database", database: "shop" } });
  vi.mocked(open).mockResolvedValueOnce("C:\data\dump.sql");
  fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
  await screen.findByText(/1,503 statements:/);
  fireEvent.click(screen.getByRole("button", { name: /^Import 1,503 statements/ }));
  await waitFor(() => expect(events).not.toBeNull());
  act(() => events!.onmessage({ kind: "failed", error: { kind: "jobFailed", message: { at: { fileRow: null, line: 812, table: null, statement: 40 }, message: "Line 812: syntax error" } }, rowsCommitted: 3 }));
  expect(screen.getByText("3 rows were written before the stop and stay in shop.")).toBeTruthy();
});

const CHECKING: JobEvent = {
  kind: "progress",
  phase: "checking",
  table: null,
  rowsDone: 0,
  rowsTotal: null,
  bytesDone: 10,
  bytesTotal: 100,
  statementsDone: 0,
  fileRow: null,
};

async function startScript(onStart: (a: Record<string, unknown>) => unknown, onJob = vi.fn()) {
  routeInvoke({ plan_script: () => ({ ...SCRIPT, conturaBackup: false }), start_script: onStart, cancel_job: () => undefined });
  const props = renderTab({ connection: MYSQL, target: { kind: "database", database: "shop" }, onJob });
  vi.mocked(open).mockResolvedValueOnce("C:\\data\\dump.sql");
  fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
  await screen.findByText(/1,503 statements:/);
  fireEvent.click(screen.getByRole("button", { name: /^Import 1,503 statements/ }));
  return props;
}

test("a_script_job_is_tracked_with_its_own_id_before_the_start_q43", async () => {
  const onJob = vi.fn();
  let knownAtStart: unknown[][] = [];
  let events: Channel | null = null;
  await startScript((a) => {
    knownAtStart = [...onJob.mock.calls];
    events = a.events as Channel;
    // An event sent while the start is still running reaches the job at once.
    events.onmessage(CHECKING);
    return undefined;
  }, onJob);
  await waitFor(() => expect(events).not.toBeNull());
  const id = callsTo("start_script")[0].job as string;
  // The tab knew the id (and tracked it) before start_script was sent.
  expect(knownAtStart).toEqual([[id]]);
  await waitFor(() => expect(probe!.jobs.find((j) => j.id === id)?.phase).toBe("checking"));
  // Cancel reaches that id while the run shows.
  await userEvent.click(await screen.findByRole("button", { name: /^Cancel( and roll back)?$/ }));
  expect(callsTo("cancel_job")).toContainEqual({ job: id });
});

test("a_start_refused_after_checking_progress_removes_the_job", async () => {
  await startScript((a) => {
    (a.events as Channel).onmessage(CHECKING);
    throw { kind: "invalidInput", message: "dump.sql holds a statement Contura does not run." };
  });
  expect((await screen.findAllByText(/dump.sql holds a statement Contura does not run/i)).length).toBeGreaterThan(0);
  expect(callsTo("start_script")).toHaveLength(1);
  expect(probe!.jobs).toEqual([]);
});

test("the_production_confirm_shows_the_plan_warnings_and_no_false_transaction_claim", async () => {
  const warning = "menu_items uses MyISAM: rows written before a failure stay";
  routes({ plan_import: () => ({ ...PROD_PLAN, warnings: [warning], oneTransaction: false }) });
  renderTab({ connection: PROD });
  await toColumns();
  fireEvent.click(screen.getByRole("button", { name: /^Import on PROD\.\.\./ }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(warning)).toBeTruthy();
  expect(dialog.textContent).toContain("Inserts 1,204 rows into public.menu_items in 3 statements.");
  expect(dialog.textContent).not.toContain("in one transaction");
});

test("the_production_script_confirm_shows_the_mysql_ddl_line", async () => {
  routeInvoke({
    plan_script: () => ({
      ...SCRIPT,
      oneTransaction: false,
      verdict: { kind: "needsConfirmation", connection: "orbit", database: "shop", fingerprint: "f", fileBytes: 4096, fileSha256: SHA },
    }),
    cancel_job: () => undefined,
  });
  renderTab({ connection: { ...MYSQL, production: true }, target: { kind: "database", database: "shop" } });
  vi.mocked(open).mockResolvedValueOnce("C:\data\dump.sql");
  fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
  await screen.findByText(/1,503 statements:/);
  fireEvent.click(screen.getByRole("button", { name: /^Import on PROD\.\.\./ }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("MySQL commits each CREATE, ALTER and DROP as it runs. If a later statement fails, those stay.")).toBeTruthy();
  expect(dialog.textContent).not.toContain("in one transaction");
});

test("ctrl_m_under_an_open_confirm_changes_nothing", async () => {
  routes({ plan_import: () => PROD_PLAN });
  renderTab({ connection: PROD });
  await toColumns();
  fireEvent.click(screen.getByRole("button", { name: /^Import on PROD\.\.\./ }));
  const dialog = await screen.findByRole("dialog");
  const plans = callsTo("plan_import").length;
  fireEvent.keyDown(within(dialog).getByRole("button", { name: "Import on freight-prod" }), { key: "m", ctrlKey: true });
  fireEvent.keyDown(dialog, { key: "ArrowLeft", altKey: true });
  fireEvent.keyDown(dialog, { key: "F2" });
  await act(async () => {});
  expect(callsTo("plan_import")).toHaveLength(plans);
  expect(stepNow()).toContain("Columns");
  expect(dialog.contains(document.activeElement)).toBe(true);
});

test("ctrl_enter_in_the_sample_dialog_does_not_start_the_import", async () => {
  routes();
  renderTab();
  await toColumns();
  await userEvent.click(screen.getByRole("button", { name: "Show sample INSERT" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
  await act(async () => {});
  expect(callsTo("start_import")).toHaveLength(0);
});

test("a_file_changed_run_event_dismisses_the_job_and_reopens_the_confirm", async () => {
  const sent = routes({ plan_import: () => PROD_PLAN });
  renderTab({ connection: PROD });
  await toColumns();
  fireEvent.click(screen.getByRole("button", { name: /^Import on PROD\.\.\./ }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Import on freight-prod" }));
  await waitFor(() => expect(sent.run).toHaveLength(1));
  act(() => sent.run[0].onmessage({ kind: "failed", error: { kind: "fileChanged", message: { file: "menu.csv", confirmed: true } } }));
  expect(await screen.findByText("menu.csv changed after you confirmed. Nothing was imported.")).toBeTruthy();
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(stepNow()).toContain("Columns");
});

test("an_estimated_row_count_reads_about_until_the_check_ends", async () => {
  routes({ inspect_import_file: () => ({ ...SUMMARY, rowsEstimate: { rows: 4_200_000, exact: false } }) });
  renderTab();
  await toColumns();
  expect(screen.getByText("Writes about 4.2 million rows into public.menu_items in one transaction. Cancel rolls everything back.")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Import about 4\.2 million rows/ })).toBeTruthy();
});

test("the_tab_reports_its_job_id_when_a_run_starts_q43", async () => {
  const sent = routes();
  const onJob = vi.fn();
  renderTab({ onJob });
  await toColumns();
  fireEvent.click(screen.getByRole("button", { name: /^Import 1,204 rows/ }));
  await waitFor(() => expect(sent.run).toHaveLength(1));
  expect(onJob).toHaveBeenCalledWith(callsTo("start_import")[0].job);
});
