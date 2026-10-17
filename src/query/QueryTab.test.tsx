import { forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { Cell, ConnectionConfig, Execution } from "../api/types";
import { LangClient, type WorkerLike } from "../lang/client";
import { KFC_SCHEMA } from "../lang/sql/fixtures";
import { SchemaCache } from "../lang/sql/schemaCache";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockEditorDom } from "../test/editor";
import { mockReactFlowDom } from "../test/reactFlow";
import QueryTab, { type QueryTabDoc } from "./QueryTab";
import type { SqlEditorApi } from "./SqlEditor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});
beforeEach(() => vi.clearAllMocks());

const conn: ConnectionConfig = {
  id: "c1",
  name: "KFC Postgres",
  dialect: "postgres",
  host: "127.0.0.1",
  port: 5432,
  user: "u",
  database: "kfc_shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};

const doc = (text: string, over: Partial<QueryTabDoc> = {}): QueryTabDoc => ({
  id: "t1",
  name: "Query 1",
  text,
  connectionId: "c1",
  database: "kfc_shop",
  savedId: null,
  savedText: null,
  ...over,
});

const rowsOf = (n: number, from = 1): Cell[][] =>
  Array.from({ length: n }, (_, i) => [{ t: "number", value: String(i + from) }]);
const rowsResult = (n: number, hasMore = false): Execution => ({
  outcome: { t: "rows", columns: [{ name: "n", typeName: "int4", numeric: true }], rows: rowsOf(n), hasMore },
  elapsedMs: 4,
});

function routes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({
    open_query_session: () => "s1",
    close_query_session: () => null,
    list_databases: () => ["kfc_shop"],
    execute_sql: () => rowsResult(1),
    prepare_run: () => ({ kind: "ok" }),
    classify_sql: ({ sql }) => (/^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql as string) ? "write" : "read"),
    ...over,
  });
}

function setup(d: QueryTabDoc, open = true, extra: Partial<Parameters<typeof QueryTab>[0]> = {}) {
  const onChange = vi.fn();
  const onSaved = vi.fn();
  const editorRef = { current: null as SqlEditorApi | null };
  let current = d;
  const view = () => EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
  const ui = (x: QueryTabDoc) => (
    <QueryTab
      tab={x}
      connections={[conn]}
      openIds={new Set(open ? ["c1"] : [])}
      onChange={(next) => {
        current = next;
        onChange(next);
      }}
      onSaved={onSaved}
      historyOpen={false}
      onToggleHistory={() => {}}
      editorRef={editorRef}
      {...extra}
    />
  );
  const utils = render(ui(d));
  return { ...utils, onChange, onSaved, view, rerenderCurrent: () => utils.rerender(ui(current)) };
}

const key = (view: EditorView, k: string, mods: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(view.contentDOM, { key: k, ...mods });

test("run_current_executes_only_the_statement_being_typed", async () => {
  routes();
  const { view } = setup(doc("SELECT 1;\nSELECT 2;"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  key(view(), "Enter", { ctrlKey: true });
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(1));
  expect(callsTo("execute_sql")[0]).toEqual({ session: "s1", sql: "SELECT 1", pass: null });
  expect(await screen.findByText("1 row")).toBeTruthy();
});

test("run_all_runs_in_order_and_stops_at_the_first_error", async () => {
  routes({
    execute_sql: ({ sql }) => {
      if (sql === "SELECT bad") throw { kind: "query", message: "column \"bad\" does not exist (position 8)" };
      return rowsResult(1);
    },
  });
  const { view } = setup(doc("SELECT 1;\nSELECT bad;\nSELECT 3;"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true, shiftKey: true });
  expect(await screen.findByText('column "bad" does not exist')).toBeTruthy();
  expect(callsTo("execute_sql").map((c) => c.sql)).toEqual(["SELECT 1", "SELECT bad"]);
  expect(screen.getByRole("tab", { name: /Result 2/, selected: true })).toBeTruthy();
});

test("update_without_where_asks_first", async () => {
  routes({ execute_sql: () => ({ outcome: { t: "affected", rows: 12 }, elapsedMs: 3 }) });
  const { view } = setup(doc("UPDATE sales.orders SET status = 'x'"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  expect(await screen.findByText(/UPDATE without WHERE changes every row in/)).toBeTruthy();
  expect(screen.getByText("sales.orders")).toBeTruthy();
  expect(callsTo("execute_sql")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText(/UPDATE without WHERE/)).toBeNull();
  expect(callsTo("execute_sql")).toHaveLength(0);

  key(view(), "Enter", { ctrlKey: true });
  await userEvent.click(await screen.findByRole("button", { name: "Add WHERE" }));
  expect(view().state.doc.toString()).toBe("UPDATE sales.orders SET status = 'x'\nWHERE ");
  expect(callsTo("execute_sql")).toHaveLength(0);

  act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: "DELETE FROM t" } }));
  key(view(), "Enter", { ctrlKey: true });
  await userEvent.click(await screen.findByRole("button", { name: "Run DELETE" }));
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(1));
  expect(await screen.findByText("DELETE 12 rows")).toBeTruthy();
});

test("escape_cancels_a_running_query", async () => {
  routes({ execute_sql: () => new Promise(() => {}), cancel_query: () => null });
  const { view } = setup(doc("SELECT pg_sleep(30)"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  expect(await screen.findByText("Running")).toBeTruthy();
  key(view(), "Escape");
  await waitFor(() => expect(callsTo("cancel_query")).toEqual([{ session: "s1" }]));
});

test("fetch_next_appends_rows", async () => {
  routes({
    execute_sql: () => rowsResult(1000, true),
    fetch_more_rows: () => ({ rows: rowsOf(1000, 1001), hasMore: false }),
  });
  const { view } = setup(doc("SELECT * FROM sales.orders"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await userEvent.click(await screen.findByRole("button", { name: "Fetch next 1,000" }));
  expect(await screen.findByText("2,000 rows")).toBeTruthy();
  expect(callsTo("fetch_more_rows")[0]).toEqual({ session: "s1" });
});

test("save_asks_for_a_unique_name_then_saves_in_place", async () => {
  let n = 0;
  routes({
    save_saved_query: ({ input }) => {
      const i = input as { id: string | null; name: string; sql: string };
      if (i.name === "Taken") throw { kind: "invalidInput", message: 'A Saved Query named "Taken" exists. Choose another name.' };
      n++;
      return { id: i.id ?? "q1", name: i.name, sql: i.sql, updatedAtMs: n };
    },
  });
  const { view, onSaved, onChange, rerenderCurrent } = setup(doc("SELECT 1"));
  key(view(), "s", { ctrlKey: true });
  const name = await screen.findByLabelText("Name");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByText("Give the query a name.")).toBeTruthy();
  await userEvent.type(name, "Taken");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText('A Saved Query named "Taken" exists. Choose another name.')).toBeTruthy();
  await userEvent.clear(name);
  await userEvent.type(name, "Weekly sales");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText('Saved "Weekly sales"')).toBeTruthy();
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "q1", name: "Weekly sales" }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Weekly sales", savedId: "q1", savedText: "SELECT 1" }));
  rerenderCurrent();
  key(view(), "s", { ctrlKey: true });
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(3));
  expect(callsTo("save_saved_query")[2].input).toEqual({ id: "q1", name: "Weekly sales", sql: "SELECT 1" });
  expect(screen.queryByLabelText("Name")).toBeNull();
});

test("no_connection_disables_run_and_offers_a_choice", () => {
  routes();
  setup(doc("SELECT 1", { connectionId: null, database: null }));
  expect((screen.getByRole("button", { name: /^Run Ctrl Enter/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Choose a Connection to run this query")).toBeTruthy();
  expect(callsTo("open_query_session")).toHaveLength(0);
});

test("status_bar_shows_tag", () => {
  routes();
  setup(doc("SELECT 1"), true, { connections: [{ ...conn, production: true }] });
  const status = document.querySelector(".query-status") as HTMLElement;
  expect(status.textContent).toContain("Production");
});

test("a_closed_connection_says_to_open_it", () => {
  routes();
  setup(doc("SELECT 1"), false);
  expect(screen.getByText("Open the Connection to run this query.")).toBeTruthy();
  expect(callsTo("open_query_session")).toHaveLength(0);
});

test("the_tab_opens_and_closes_its_session", async () => {
  routes();
  const { unmount } = setup(doc("SELECT 1"));
  await waitFor(() => expect(callsTo("open_query_session")).toEqual([{ id: "c1", database: "kfc_shop" }]));
  unmount();
  await waitFor(() => expect(callsTo("close_query_session")).toEqual([{ session: "s1" }]));
});

test("run_all_reads_the_editor_not_a_stale_prop", async () => {
  routes();
  const { view } = setup(doc("SELECT 1;"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  // The parent has not re-rendered with the new text yet.
  act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: "SELECT 7;\nSELECT 8;" } }));
  key(view(), "Enter", { ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(2));
  expect(callsTo("execute_sql").map((c) => c.sql)).toEqual(["SELECT 7", "SELECT 8"]);
});

test("a_new_session_drops_the_rest_of_a_run_and_pickers_lock_while_running", async () => {
  let release: (v: Execution) => void = () => {};
  let n = 0;
  routes({
    open_query_session: () => `s${++n}`,
    execute_sql: () => new Promise<Execution>((r) => (release = r)),
  });
  const { view, rerender } = setup(doc("SELECT 1;\nSELECT 2;"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(1));
  expect((screen.getByRole("combobox", { name: "Connection" }) as HTMLSelectElement).disabled).toBe(true);
  rerender(
    <QueryTab
      tab={doc("SELECT 1;\nSELECT 2;", { database: "other" })}
      connections={[conn]}
      openIds={new Set(["c1"])}
      onChange={() => {}}
      onSaved={() => {}}
      historyOpen={false}
      onToggleHistory={() => {}}
      editorRef={{ current: null }}
    />,
  );
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(2));
  act(() => release(rowsResult(1)));
  await new Promise((r) => setTimeout(r, 50));
  expect(callsTo("execute_sql")).toHaveLength(1);
});

test("closing_an_open_result_releases_it_on_the_server", async () => {
  routes({ execute_sql: () => rowsResult(1000, true), close_query_result: () => null });
  const { view } = setup(doc("SELECT * FROM sales.orders"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await screen.findByText("First 1,000 rows");
  await userEvent.click(screen.getByRole("button", { name: "Close unpinned results" }));
  await waitFor(() => expect(callsTo("close_query_result")).toEqual([{ session: "s1" }]));
});

// The schema index (step 4b).

function withLang() {
  const client = new LangClient(() => fakeWorker());
  return { client, schemas: new SchemaCache(client) };
}
const lintMessages = (v: EditorView) => {
  const out: string[] = [];
  forEachDiagnostic(v.state, (d) => out.push(d.message));
  return out;
};

test("schema_arrival_refreshes_diagnostics", async () => {
  let release: (s: unknown) => void = () => {};
  routes({ sql_schema: () => new Promise((r) => (release = r)) });
  const lang = withLang();
  const { view } = setup(doc("SELECT * FROM order"), true, { lang });
  await waitFor(() => expect(callsTo("sql_schema")).toEqual([{ id: "c1", database: "kfc_shop" }]));
  expect(await screen.findByText("Loading schema")).toBeTruthy();
  expect(lintMessages(view()).some((m) => m.startsWith("Unknown table"))).toBe(false);
  act(() => release(KFC_SCHEMA));
  await waitFor(() => expect(lintMessages(view())).toContain("Unknown table order. Did you mean orders?"));
  expect(screen.queryByText("Loading schema")).toBeNull();
});

test("ddl_success_reloads_the_schema_for_the_tab", async () => {
  routes({ sql_schema: () => KFC_SCHEMA, execute_sql: () => ({ outcome: { t: "affected", rows: 0 }, elapsedMs: 2 }) });
  const { view } = setup(doc("CREATE TABLE t (id int)"), true, { lang: withLang() });
  await waitFor(() => expect(callsTo("sql_schema")).toHaveLength(1));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await waitFor(() => expect(callsTo("sql_schema")).toHaveLength(2));
});

test("ddl_after_a_comment_still_reloads_the_schema", async () => {
  routes({ sql_schema: () => KFC_SCHEMA, execute_sql: () => ({ outcome: { t: "affected", rows: 0 }, elapsedMs: 2 }) });
  const { view } = setup(doc("-- a new table\n/* for stock */ CREATE TABLE t (id int)"), true, { lang: withLang() });
  await waitFor(() => expect(callsTo("sql_schema")).toHaveLength(1));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(callsTo("sql_schema")).toHaveLength(2));
});

test("an_engine_restart_is_said_in_the_status_line", async () => {
  routes({ sql_schema: () => KFC_SCHEMA });
  const workers: WorkerLike[] = [];
  const client = new LangClient(() => {
    const w = fakeWorker();
    workers.push(w);
    return w;
  });
  setup(doc("SELECT 1"), true, { lang: { client, schemas: new SchemaCache(client) } });
  act(() => workers[0].onerror?.());
  expect(await screen.findByText("Language engine restarted. Typing works as plain text.")).toBeTruthy();
});

test("status_shows_schema_loading_and_not_connected", async () => {
  routes({ sql_schema: () => new Promise(() => {}) });
  const closed = setup(doc("SELECT 1"), false, { lang: withLang() });
  expect(screen.getByText("Not connected")).toBeTruthy();
  expect(callsTo("sql_schema")).toHaveLength(0);
  closed.unmount();
  setup(doc("SELECT 1"), true, { lang: withLang() });
  expect(await screen.findByText("Loading schema")).toBeTruthy();
});

test("f12_on_a_table_reveals_it_in_the_tree", async () => {
  routes({ sql_schema: () => KFC_SCHEMA });
  const onShowInTree = vi.fn();
  const text = "SELECT * FROM orders";
  const { view } = setup(doc(text), true, { lang: withLang(), onShowInTree });
  await waitFor(() => expect(callsTo("sql_schema")).toHaveLength(1));
  await waitFor(() => expect(screen.queryByText("Loading schema")).toBeNull());
  act(() => view().dispatch({ selection: { anchor: text.indexOf("orders") + 1 } }));
  key(view(), "F12");
  await waitFor(() =>
    expect(onShowInTree).toHaveBeenCalledWith({ connectionId: "c1", database: "kfc_shop", schema: "sales", name: "orders" }),
  );
});

// Production: the Core decides; this mock says a statement writes when it starts with a write verb.
const prod: ConnectionConfig = { ...conn, production: true };
const WRITE = /^\s*(UPDATE|INSERT|DELETE)\b/i;
const productionRoutes = (over: Record<string, (a: Record<string, unknown>) => unknown> = {}) =>
  routes({
    prepare_run: ({ statements }) => {
      const list = statements as string[];
      const planned = list.map((text) => ({ text, class: WRITE.test(text) ? "write" : "read" }));
      const writes = planned.filter((p) => p.class === "write").length;
      return writes === 0
        ? { kind: "ok" }
        : { kind: "needsConfirmation", connection: "KFC Postgres", database: "kfc_shop", statements: planned, writes };
    },
    confirm_run: () => "p1",
    execute_sql: () => ({ outcome: { t: "affected", rows: 1 }, elapsedMs: 2 }),
    ...over,
  });
const setupProd = (text: string) => setup(doc(text), true, { connections: [prod] });

test("run_button_confirms_then_runs_all_with_the_pass", async () => {
  productionRoutes();
  const { view } = setupProd("SELECT 1;\nSELECT 2;\nUPDATE t SET a = 1 WHERE id = 1;");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true, shiftKey: true });
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("1 of 3 statements writes.");
  expect(Array.from(dialog.querySelectorAll(".confirm-tag")).map((t) => t.textContent)).toEqual(["reads", "reads", "writes"]);
  // The reads before the write wait for the dialog too.
  expect(callsTo("execute_sql")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Run on KFC Postgres" }));
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(3));
  expect(callsTo("confirm_run")).toEqual([
    { session: "s1", statements: ["SELECT 1", "SELECT 2", "UPDATE t SET a = 1 WHERE id = 1"] },
  ]);
  expect(callsTo("execute_sql").map((c) => [c.sql, c.pass])).toEqual([
    ["SELECT 1", "p1"],
    ["SELECT 2", "p1"],
    ["UPDATE t SET a = 1 WHERE id = 1", "p1"],
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("escape_cancels_and_runs_nothing", async () => {
  productionRoutes();
  const { view } = setupProd("UPDATE t SET a = 1 WHERE id = 1");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await screen.findByRole("dialog");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await new Promise((r) => setTimeout(r, 20));
  expect(callsTo("confirm_run")).toHaveLength(0);
  expect(callsTo("execute_sql")).toHaveLength(0);
});

test("no_where_on_production_is_one_dialog_with_add_where", async () => {
  productionRoutes();
  const { view } = setupProd("UPDATE sales.orders SET status = 'x'");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await screen.findByRole("dialog");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("UPDATE without WHERE changes every row in sales.orders.");
  await userEvent.click(screen.getByRole("button", { name: "Add WHERE" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const text = "UPDATE sales.orders SET status = 'x'\nWHERE ";
  expect(view().state.doc.toString()).toBe(text);
  expect(view().state.selection.main.head).toBe(text.length);
  expect(callsTo("confirm_run")).toHaveLength(0);
  expect(callsTo("execute_sql")).toHaveLength(0);
});

test("confirming_a_no_where_write_on_production_runs_it_without_a_second_ask", async () => {
  productionRoutes();
  const { view } = setupProd("UPDATE sales.orders SET status = 'x'");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await userEvent.click(await screen.findByRole("button", { name: "Run on KFC Postgres" }));
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(1));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(callsTo("execute_sql")[0]).toEqual({ session: "s1", sql: "UPDATE sales.orders SET status = 'x'", pass: "p1" });
});

test("non_production_keeps_the_old_no_where_confirm", async () => {
  routes({ execute_sql: () => ({ outcome: { t: "affected", rows: 12 }, elapsedMs: 3 }) });
  const { view } = setup(doc("UPDATE sales.orders SET status = 'x'"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  expect(await screen.findByRole("alertdialog", { name: "Confirm UPDATE without WHERE" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("prepare_run")).toEqual([{ session: "s1", statements: ["UPDATE sales.orders SET status = 'x'"] }]);
});

test("reads_on_production_run_without_dialog", async () => {
  productionRoutes({ execute_sql: () => rowsResult(1) });
  const { view } = setupProd("SELECT 1");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(1));
  expect(callsTo("execute_sql")[0]).toEqual({ session: "s1", sql: "SELECT 1", pass: null });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("confirm_run")).toHaveLength(0);
});

test("edited_sql_asks_again", async () => {
  productionRoutes();
  const { view } = setupProd("UPDATE t SET a = 1 WHERE id = 1");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await userEvent.click(await screen.findByRole("button", { name: "Run on KFC Postgres" }));
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(1));
  act(() => view().dispatch({ changes: { from: view().state.doc.length - 1, to: view().state.doc.length, insert: "2" } }));
  key(view(), "Enter", { ctrlKey: true });
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("UPDATE t SET a = 1 WHERE id = 2");
  expect(callsTo("prepare_run")).toHaveLength(2);
  expect(callsTo("execute_sql")).toHaveLength(1);
});

test("an_expired_pass_stops_the_run_and_asks_again_for_the_rest", async () => {
  let refused = false;
  productionRoutes({
    execute_sql: ({ sql }) => {
      if (sql === "UPDATE t SET a = 2 WHERE id = 2" && !refused) {
        refused = true;
        throw { kind: "needsConfirmation" };
      }
      return { outcome: { t: "affected", rows: 1 }, elapsedMs: 2 };
    },
  });
  const { view } = setupProd("UPDATE t SET a = 1 WHERE id = 1;\nUPDATE t SET a = 2 WHERE id = 2;\nSELECT 3;");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true, shiftKey: true });
  await userEvent.click(await screen.findByRole("button", { name: "Run on KFC Postgres" }));
  await waitFor(() => expect(callsTo("prepare_run")).toHaveLength(2));
  expect(callsTo("prepare_run")[1].statements).toEqual(["UPDATE t SET a = 2 WHERE id = 2", "SELECT 3"]);
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("1 of 2 statements writes.");
  expect(callsTo("execute_sql").map((c) => c.sql)).toEqual(["UPDATE t SET a = 1 WHERE id = 1", "UPDATE t SET a = 2 WHERE id = 2"]);
  await userEvent.click(screen.getByRole("button", { name: "Run on KFC Postgres" }));
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(4));
  expect(callsTo("execute_sql").slice(2).map((c) => c.sql)).toEqual(["UPDATE t SET a = 2 WHERE id = 2", "SELECT 3"]);
});

test("continuing_after_an_expired_pass_keeps_the_results_that_ran", async () => {
  let refused = false;
  productionRoutes({
    execute_sql: ({ sql }) => {
      if (sql === "UPDATE t SET a = 2 WHERE id = 2" && !refused) {
        refused = true;
        throw { kind: "needsConfirmation" };
      }
      return { outcome: { t: "affected", rows: 1 }, elapsedMs: 2 };
    },
  });
  const { view } = setupProd("UPDATE t SET a = 1 WHERE id = 1;\nUPDATE t SET a = 2 WHERE id = 2;\nSELECT 3;");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true, shiftKey: true });
  await userEvent.click(await screen.findByRole("button", { name: "Run on KFC Postgres" }));
  await screen.findByRole("dialog");
  await userEvent.click(screen.getByRole("button", { name: "Run on KFC Postgres" }));
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(4));
  await waitFor(() =>
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("title"))).toEqual([
      "UPDATE t SET a = 1 WHERE id = 1",
      "UPDATE t SET a = 2 WHERE id = 2",
      "SELECT 3",
    ]),
  );
});

test("add_where_does_nothing_when_the_statement_was_edited", async () => {
  routes({ execute_sql: () => ({ outcome: { t: "affected", rows: 12 }, elapsedMs: 3 }) });
  const { view } = setup(doc("UPDATE sales.orders SET status = 'x'"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await screen.findByRole("alertdialog");
  act(() => view().dispatch({ changes: { from: 0, to: 6, insert: "DELETE FROM" } }));
  const edited = view().state.doc.toString();
  await userEvent.click(screen.getByRole("button", { name: "Add WHERE" }));
  expect(view().state.doc.toString()).toBe(edited);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(callsTo("execute_sql")).toHaveLength(0);
});

const ro: ConnectionConfig = { ...conn, name: "kestrel-reporting", readOnly: true };
const setupRo = (text: string) => setup(doc(text), true, { connections: [ro] });
const runButton = () => screen.getByRole("button", { name: /^Run Ctrl Enter/ }) as HTMLButtonElement;
const runAllButton = () => screen.getByRole("button", { name: "Run all" }) as HTMLButtonElement;

test("read_only_writing_statement_shows_note_and_disables_run", async () => {
  routes();
  const text = "SELECT 1;\nUPDATE t SET a = 1 WHERE id = 1;";
  const { view } = setupRo(text);
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  act(() => view().dispatch({ selection: { anchor: text.indexOf("SET") } }));
  const note = await waitFor(() => {
    const n = document.querySelector(".cm-blocked-note");
    expect(n).toBeTruthy();
    return n as HTMLElement;
  });
  expect(note.textContent).toContain("Read-only Connection: this statement writes");
  expect(note.textContent).toContain("kestrel-reporting blocks every write.");
  // The lock sits in the gutter on the statement's first line.
  const lock = document.querySelector(".cm-blocked-lock") as HTMLElement;
  expect(lock).toBeTruthy();
  expect(lock.textContent).toBe("2");
  expect(runButton().disabled).toBe(true);
  expect(runButton().title).toBe("This Connection is Read-only");
  expect(runAllButton().disabled).toBe(true);
  expect(callsTo("classify_sql")).toContainEqual({ dialect: "postgres", sql: "UPDATE t SET a = 1 WHERE id = 1" });
  // Moving to the read clears the note and turns Run back on.
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  await waitFor(() => expect(document.querySelector(".cm-blocked-note")).toBeNull());
  expect(runButton().disabled).toBe(false);
  expect(runAllButton().disabled).toBe(true);
});

test("read_only_reads_run_normally", async () => {
  routes();
  const { view } = setupRo("SELECT 1");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  await waitFor(() => expect(callsTo("classify_sql").length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.querySelector(".cm-blocked-note")).toBeNull();
  expect(runButton().disabled).toBe(false);
  expect(runAllButton().disabled).toBe(false);
  await userEvent.click(runButton());
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(1));
  expect(await screen.findByText("1 row")).toBeTruthy();
});

test("run_all_disabled_when_any_statement_writes", async () => {
  routes();
  const { view } = setupRo("SELECT 1;\nDELETE FROM t WHERE id = 1;");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  await waitFor(() => expect(runAllButton().disabled).toBe(true));
  expect(runAllButton().title).toBe("This Connection is Read-only");
  expect(runButton().disabled).toBe(false);
});

test("server_refusal_message", async () => {
  routes({
    execute_sql: () => {
      throw { kind: "readOnlyRefused" };
    },
  });
  const { view } = setupRo("SELECT refresh_customer_totals()");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  expect(await screen.findByText("The server refused a write: this Connection is Read-only")).toBeTruthy();
  expect(
    screen.getByText(
      "This Connection opens every session read-only. The statement did not change anything, and statements after it did not run.",
    ),
  ).toBeTruthy();
});

test("a_read_only_verdict_runs_nothing_and_says_why", async () => {
  routes({ prepare_run: () => ({ kind: "readOnly", statement: 0 }) });
  const { view } = setup(doc("UPDATE t SET a = 1 WHERE id = 1"), true, { connections: [{ ...conn, readOnly: true }] });
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  expect((await screen.findByRole("alert")).textContent).toContain("Read-only Connection");
  expect(callsTo("execute_sql")).toHaveLength(0);
  expect(screen.queryByRole("dialog")).toBeNull();
});
