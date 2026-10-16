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
  expect(callsTo("execute_sql")[0]).toEqual({ session: "s1", sql: "SELECT 1" });
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
