import { forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LOAD_TIMEOUT, patient } from "../test/load";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { Cell, ConnectionConfig, Execution } from "../api/types";
import { LangClient, type WorkerLike } from "../lang/client";
import { KFC_SCHEMA } from "../lang/sql/fixtures";
import { SchemaCache } from "../lang/sql/schemaCache";
import { openConnection } from "../api/client";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockEditorDom } from "../test/editor";
import { mockReactFlowDom } from "../test/reactFlow";
import { ToastProvider } from "../components/Toast";
import appCss from "../styles/app.css?raw";
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
  const utils = render(<ToastProvider>{ui(d)}</ToastProvider>);
  return { ...utils, onChange, onSaved, view, rerenderCurrent: () => utils.rerender(<ToastProvider>{ui(current)}</ToastProvider>) };
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
  expect(await screen.findByText("1 row in 4ms")).toBeTruthy();
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
  await waitFor(() => expect(document.querySelector(".query-error-message")?.textContent).toBe('column "bad" does not exist'));
  expect(callsTo("execute_sql").map((c) => c.sql)).toEqual(["SELECT 1", "SELECT bad"]);
  expect(screen.getByRole("tab", { name: /Statement 2/, selected: true })).toBeTruthy();
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
  expect(await screen.findByText(/^2,000 rows in /)).toBeTruthy();
  expect(callsTo("fetch_more_rows")[0]).toEqual({ session: "s1" });
});

test("saving_shows_the_success_toast_with_the_name_in_bold", async () => {
  routes({
    save_saved_query: ({ input }) => {
      const i = input as { name: string; sql: string };
      return { id: "q1", name: i.name, sql: i.sql, updatedAtMs: 1 };
    },
  });
  const { view } = setup(doc("SELECT 1"));
  key(view(), "s", { ctrlKey: true });
  await userEvent.type(await screen.findByLabelText("Name"), "late shipments by carrier");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Save/ }));
  const toast = await screen.findByRole("status");
  expect(toast.textContent).toContain("Saved late shipments by carrier.");
  expect(toast.textContent).not.toContain('"');
  expect(toast.querySelector("b")?.textContent).toBe("late shipments by carrier");
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
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Save/ }));
  expect(screen.getByText("Give the query a name.")).toBeTruthy();
  await userEvent.type(name, "Taken");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Save/ }));
  expect(await screen.findByText('A Saved Query named "Taken" exists. Choose another name.')).toBeTruthy();
  await userEvent.clear(name);
  await userEvent.type(name, "Weekly sales");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Save/ }));
  await screen.findByRole("status");
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "q1", name: "Weekly sales" }));
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Weekly sales", savedId: "q1", savedText: "SELECT 1" }));
  rerenderCurrent();
  key(view(), "s", { ctrlKey: true });
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(3));
  expect(callsTo("save_saved_query")[2].input).toEqual({ id: "q1", name: "Weekly sales", sql: "SELECT 1" });
  expect(screen.queryByLabelText("Name")).toBeNull();
});

test("after_the_save_query_dialog_focus_is_back_in_the_editor_and_runs_reach_the_runner", async () => {
  routes({
    save_saved_query: ({ input }) => {
      const i = input as { name: string; sql: string };
      return { id: "q1", name: i.name, sql: i.sql, updatedAtMs: 1 };
    },
  });
  const onRan = vi.fn();
  const { view, rerenderCurrent } = setup(doc("SELECT 1"), true, { onRan });
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  act(() => view().focus());
  await userEvent.keyboard("{Control>}s{/Control}");
  await userEvent.type(await screen.findByLabelText("Name"), "late shipments by carrier");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // The App hands back the tab with its new name and saved id; the editor must survive that.
  rerenderCurrent();
  expect(view().contentDOM.contains(document.activeElement)).toBe(true);
  // Keys go wherever focus is, as a real press does.
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(1));
  await waitFor(() => expect(onRan).toHaveBeenCalledTimes(1));
  await userEvent.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(2));
  await waitFor(() => expect(onRan).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole("button", { name: /^Run(?! all)/ }));
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(3));
  await waitFor(() => expect(onRan).toHaveBeenCalledTimes(3));
});

test("ctrl_s_on_a_saved_query_saves_without_the_dialog_and_toasts", async () => {
  routes({
    save_saved_query: ({ input }) => {
      const i = input as { id: string; name: string; sql: string };
      return { id: i.id, name: i.name, sql: i.sql, updatedAtMs: 5, connectionId: "c1" };
    },
  });
  const onShowSaved = vi.fn();
  const { view, onChange } = setup(
    doc("SELECT 2", { name: "late shipments by carrier", savedId: "q1", savedText: "SELECT 1" }),
    true,
    { onShowSaved },
  );
  key(view(), "s", { ctrlKey: true });
  const toast = await screen.findByRole("status");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("save_saved_query")).toEqual([{ input: { id: "q1", name: "late shipments by carrier", sql: "SELECT 2" } }]);
  expect(toast.textContent).toContain("Saved late shipments by carrier.");
  expect(toast.querySelector("b")?.textContent).toBe("late shipments by carrier");
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ savedText: "SELECT 2" }));
  await userEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(onShowSaved).toHaveBeenCalledWith("q1");
});

test("no_connection_disables_run_and_offers_a_choice", () => {
  routes();
  setup(doc("SELECT 1", { connectionId: null, database: null }));
  expect((screen.getByRole("button", { name: /^Run Ctrl\+Enter/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Choose a Connection to run this query")).toBeTruthy();
  expect(callsTo("open_query_session")).toHaveLength(0);
});

test("ask_ai_button_shows_an_icon_not_text", () => {
  routes();
  setup(doc("SELECT 1"), true, { onToggleAssistant: () => {} });
  const btn = screen.getByRole("button", { name: "AI: Schema only" });
  expect(btn.querySelector("svg")).toBeTruthy();
  expect(btn.getAttribute("title")).toContain("Open the assistant");
});

test("no_native_select_in_the_query_tab", () => {
  routes();
  setup(doc("SELECT 1"));
  expect(document.querySelector("select")).toBeNull();
});

test("status_bar_shows_tag", () => {
  routes();
  setup(doc("SELECT 1"), true, { connections: [{ ...conn, production: true }] });
  const status = document.querySelector(".query-status") as HTMLElement;
  expect(status.textContent).toContain("PROD");
});

test("visible_tab_renders_its_status_into_the_window_status_bar", () => {
  routes();
  const slot = document.createElement("span");
  slot.id = "app-status-slot";
  document.body.appendChild(slot);
  try {
    const { rerender } = setup(doc("SELECT 1"), true, { visible: true });
    expect(slot.querySelector(".query-status")?.textContent).toContain("Ln 1, Col 1");
    rerender(
      <QueryTab
        tab={doc("SELECT 1")}
        connections={[conn]}
        openIds={new Set(["c1"])}
        onChange={() => {}}
        onSaved={() => {}}
        historyOpen={false}
        onToggleHistory={() => {}}
        editorRef={{ current: null }}
        visible={false}
      />,
    );
    expect(slot.querySelector(".query-status")).toBeNull();
    expect(document.querySelector("section .query-status")).toBeTruthy();
  } finally {
    slot.remove();
  }
});

test("a_closed_connection_says_to_open_it", () => {
  routes();
  setup(doc("SELECT 1"), false);
  expect(screen.getByRole("heading", { name: "Open the Connection to run this query" })).toBeTruthy();
  expect(callsTo("open_query_session")).toHaveLength(0);
});

test("run_is_disabled_with_a_tooltip_while_closed", async () => {
  routes();
  const runRef = { current: null as ((sql: string) => Promise<{ ran: boolean }>) | null };
  setup(doc("SELECT 1"), false, { runRef });
  const run = screen.getByRole("button", { name: /^Run(?! all)/ }) as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  expect(run.getAttribute("title")).toBe("Open KFC Postgres to run this query.");
  expect(await runRef.current?.("SELECT 2")).toEqual({ ran: false });
  expect(callsTo("execute_sql")).toHaveLength(0);
});

test("connection_button_reads_name_closed", () => {
  routes();
  setup(doc("SELECT 1"), false);
  const button = within(screen.getByRole("toolbar", { name: "Query" })).getByRole("button", { name: /KFC Postgres/ });
  expect(button.textContent).toContain("KFC Postgres");
  expect(button.textContent).toContain("closed");
});

test("opening_from_the_result_area_connects_and_a_failure_offers_try_again_and_edit", async () => {
  let fail = true;
  routes({
    open_connection: () => {
      if (fail) throw { kind: "connect", message: "timeout connecting to 127.0.0.1:5432" };
      return "16";
    },
  });
  const onConnectionOpened = vi.fn();
  const onEditConnection = vi.fn();
  const onOpenStatus = vi.fn();
  setup(doc("SELECT 1"), false, { onConnectionOpened, onEditConnection, onOpenStatus });
  await userEvent.click(screen.getByRole("button", { name: /Open KFC Postgres/ }));
  expect(await screen.findByRole("heading", { name: "Could not open KFC Postgres" })).toBeTruthy();
  // The tree row follows: Connecting..., then Failed with the reason (frames 10b, 10c).
  expect(onOpenStatus.mock.calls[0]).toEqual(["c1", { s: "connecting" }]);
  expect(onOpenStatus).toHaveBeenLastCalledWith("c1", { s: "failed", error: expect.stringContaining("timeout connecting") });
  expect(screen.getByText("timeout connecting to 127.0.0.1:5432")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Edit Connection..." }));
  expect(onEditConnection).toHaveBeenCalledWith("c1");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: /Try again/ }));
  await waitFor(() => expect(onConnectionOpened).toHaveBeenCalledWith("c1"));
  expect(callsTo("open_connection")).toHaveLength(2);
  expect(onOpenStatus).toHaveBeenLastCalledWith("c1", null);
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
  expect((screen.getByRole("button", { name: /KFC Postgres/ }) as HTMLButtonElement).disabled).toBe(true);
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
  await screen.findByText(/^First 1,000 rows in /);
  await userEvent.click(document.querySelector<HTMLElement>(".result-tab-close[aria-label='Close Result 1']")!);
  await waitFor(() => expect(callsTo("close_query_result")).toEqual([{ session: "s1" }]));
  expect(screen.queryByRole("tab", { name: "Result 1" })).toBeNull();
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

test("status_shows_schema_loading_and_closed", async () => {
  routes({ sql_schema: () => new Promise(() => {}) });
  const closed = setup(doc("SELECT 1"), false, { lang: withLang() });
  expect(screen.getByText("Closed")).toBeTruthy();
  expect(screen.queryByText("Not connected")).toBeNull();
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
  expect(Array.from(dialog.querySelectorAll(".sql-block-tag")).map((t) => t.textContent)).toEqual(["reads", "reads", "writes"]);
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
  expect(screen.getByRole("alert").textContent).toContain("Statement 1 has no WHERE. It changes every row in sales.orders.");
  await userEvent.click(screen.getByRole("button", { name: "Add WHERE" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const text = "UPDATE sales.orders SET status = 'x'\nWHERE ";
  expect(view().state.doc.toString()).toBe(text);
  expect(view().state.selection.main.head).toBe(text.length);
  expect(callsTo("confirm_run")).toHaveLength(0);
  expect(callsTo("execute_sql")).toHaveLength(0);
});

test("no_where_warning_gets_the_row_estimate_of_its_table", async () => {
  productionRoutes();
  const rowEstimate = vi.fn(() => 412960);
  const { view } = setup(doc("UPDATE sales.orders SET status = 'x'"), true, { connections: [prod], rowEstimate });
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await screen.findByRole("dialog");
  expect(screen.getByRole("alert").textContent).toContain(
    "Statement 1 has no WHERE. It changes every row in sales.orders, about 412,960 rows.",
  );
  expect(rowEstimate).toHaveBeenCalledWith("c1", { database: "kfc_shop", schema: "sales", name: "orders" });
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

// Production wash and write hazard (restyle Task 10).
const freight: ConnectionConfig = { ...conn, name: "freight-prod", production: true };
const setupFreight = (text: string) => setup(doc(text), true, { connections: [freight] });

test("production_panes_carry_the_wash", async () => {
  productionRoutes();
  const prodTab = setupFreight("SELECT 1");
  await waitFor(() => expect(document.querySelector(".results")).toBeTruthy());
  expect(document.querySelector(".query-editor")!.classList.contains("prod-wash")).toBe(true);
  expect(document.querySelector(".results")!.classList.contains("prod-wash")).toBe(true);
  prodTab.unmount();

  routes();
  setup(doc("SELECT 1"));
  await waitFor(() => expect(document.querySelector(".results")).toBeTruthy());
  expect(document.querySelector(".prod-wash")).toBeNull();
});

test("writing_statement_on_production_gets_band_and_note", async () => {
  productionRoutes();
  const { view } = setupFreight("UPDATE orders SET status = 'x'");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  const note = await waitFor(() => {
    const n = document.querySelector(".cm-prod-write-note");
    expect(n).toBeTruthy();
    return n as HTMLElement;
  });
  expect(note.textContent).toBe("Writes on freight-prod (Production)");
  expect(document.querySelector(".cm-line.cm-prod-write")).toBeTruthy();
  // Read-only lock widgets keep their own meaning and never show for Production.
  expect(document.querySelector(".cm-blocked-note")).toBeNull();
  // R8: the button shows PROD; its spoken name keeps the word.
  const run = screen.getByRole("button", { name: "Run on Production (Ctrl+Enter)" });
  expect(run.className).toContain("button-prod");
  expect(run.textContent).toContain("Run on PROD");
  // Run on PROD still goes through the confirm dialog.
  await userEvent.click(run);
  expect((await screen.findByRole("dialog")).textContent).toContain("1 of 1 statement writes.");
  expect(callsTo("execute_sql")).toHaveLength(0);
});

test("reading_statement_gets_neither", async () => {
  productionRoutes();
  const { view } = setupFreight("SELECT 1");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  act(() => view().dispatch({ selection: { anchor: 3 } }));
  await waitFor(() => expect(callsTo("classify_sql").length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 20));
  expect(document.querySelector(".cm-prod-write")).toBeNull();
  expect(document.querySelector(".cm-prod-write-note")).toBeNull();
  expect(screen.queryByRole("button", { name: "Run on Production (Ctrl+Enter)" })).toBeNull();
  expect(screen.getByRole("button", { name: /^Run Ctrl\+Enter/ }).className).not.toContain("button-prod");
});

const ro: ConnectionConfig = { ...conn, name: "kestrel-reporting", readOnly: true };
const setupRo = (text: string) => setup(doc(text), true, { connections: [ro] });
const runButton = () => screen.getByRole("button", { name: /^Run Ctrl\+Enter/ }) as HTMLButtonElement;
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
  // NF4, frame i: one short line; the header's Read-only chip and Run's tooltip say the rest.
  expect(note.textContent).toBe("Read-only Connection: this statement writes");
  expect(screen.getByRole("toolbar", { name: "Query" }).querySelector(".editor-header-readonly")?.textContent).toBe("Read-only");
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
  expect(await screen.findByText("1 row in 4ms")).toBeTruthy();
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

test("status_shows_rows_ms_and_position_in_ui_font", async () => {
  routes({ execute_sql: () => ({ ...rowsResult(200), elapsedMs: 48 }) });
  const slot = document.createElement("span");
  slot.id = "app-status-slot";
  document.body.appendChild(slot);
  try {
    const { view } = setup(doc("SELECT 1"), true, { visible: true });
    await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
    key(view(), "Enter", { ctrlKey: true });
    await waitFor(() => expect(slot.textContent).toContain("200 rows"));
    const texts = Array.from(slot.querySelectorAll(".query-status > span")).map((s) => s.textContent);
    expect(texts).toContain("48ms");
    expect(texts).toContain("Ln 1, Col 1");
    // The position is in the UI font, not the editor face.
    const rule = /\.query-position\s*\{[^}]*\}/.exec(appCss)?.[0] ?? "";
    expect(rule).not.toContain("--font-mono");
  } finally {
    slot.remove();
  }
});

const PLAN = { nodes: [{ label: "Seq Scan on orders", object: "orders", rows: 12, cost: 4, fullScan: false, children: [] }], raw: "Seq Scan", totalCost: 4 };

test("explain_runs_the_current_statement_and_opens_a_plan_tab", async () => {
  routes({ explain_statement: () => PLAN });
  const { view } = setup(doc("SELECT 1;\nSELECT * FROM orders;"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  act(() => view().dispatch({ selection: { anchor: 14 } }));
  await userEvent.click(screen.getByRole("button", { name: /Explain/ }));
  await waitFor(() => expect(callsTo("explain_statement")).toHaveLength(1));
  expect(callsTo("explain_statement")[0]).toEqual({ session: "s1", statement: "SELECT * FROM orders" });
  expect(await screen.findByRole("tab", { name: "Plan", selected: true })).toBeTruthy();
  expect(await screen.findByText("Seq Scan on orders")).toBeTruthy();
  expect(callsTo("execute_sql")).toHaveLength(0);
});

test("explain_on_a_production_write_never_runs_or_confirms", async () => {
  productionRoutes({ explain_statement: () => PLAN });
  setupProd("UPDATE t SET a = 1");
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: /Explain/ }));
  await waitFor(() => expect(callsTo("explain_statement")).toHaveLength(1));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("execute_sql")).toHaveLength(0);
  expect(callsTo("prepare_run")).toHaveLength(0);
  expect(callsTo("confirm_run")).toHaveLength(0);
});

test("explain_refusal_shows_as_an_error", async () => {
  routes({
    explain_statement: () => {
      throw { kind: "invalidInput", message: "Explain does not cover this statement" };
    },
  });
  setup(doc("CREATE TABLE x (a int)"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: /Explain/ }));
  expect(await screen.findByText(/Explain does not cover/)).toBeTruthy();
});

test("explain_over_an_open_result_closes_it_on_the_server_first", async () => {
  routes({ execute_sql: () => rowsResult(1000, true), close_query_result: () => null, explain_statement: () => PLAN });
  const { view } = setup(doc("SELECT * FROM sales.orders"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  await screen.findByText(/^First 1,000 rows in /);
  await userEvent.click(screen.getByRole("button", { name: /Explain/ }));
  await waitFor(() => expect(callsTo("explain_statement")).toHaveLength(1));
  expect(callsTo("close_query_result")).toEqual([{ session: "s1" }]);
});

test("did_you_mean_also_offers_column_names", async () => {
  routes({
    sql_schema: () => KFC_SCHEMA,
    execute_sql: () => {
      throw { kind: "query", message: 'column "ful_name" does not exist (position 8)' };
    },
  });
  const { view } = setup(doc("SELECT ful_name FROM customers"), true, { lang: withLang() });
  await waitFor(() => expect(callsTo("sql_schema")).toHaveLength(1));
  await waitFor(() => expect(screen.queryByText("Loading schema")).toBeNull());
  key(view(), "Enter", { ctrlKey: true });
  await waitFor(() =>
    expect(document.querySelector(".query-error-near")?.textContent).toBe("There is no column named ful_name. Did you mean full_name?"),
  );
});

test("reconnect_reopens_the_connection_and_tells_the_app", async () => {
  let drop = true;
  routes({
    open_connection: () => "16",
    execute_sql: () => {
      if (drop) throw { kind: "connect", message: "gone" };
      return rowsResult(1);
    },
  });
  const onConnectionOpened = vi.fn();
  const { view } = setup(doc("SELECT 1"), true, { onConnectionOpened });
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true });
  const button = await screen.findByRole("button", { name: /Reconnect and run statement 1/ });
  drop = false;
  await userEvent.click(button);
  await waitFor(() => expect(onConnectionOpened).toHaveBeenCalledWith("c1"));
  expect(callsTo("open_connection")).toHaveLength(1);
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(2));
  await waitFor(() => expect(callsTo("execute_sql")).toHaveLength(2));
});

// ---- runs asked for from outside the editor (Query History, answers in the Ask panel) ----

const externalRun = (extra: Partial<Parameters<typeof QueryTab>[0]> = {}) => {
  const runRef = { current: null as ((sql: string) => Promise<{ ran: boolean; rows?: number }>) | null };
  setup(doc("SELECT 1"), true, { runRef, ...extra });
  return runRef;
};

test("an_outside_run_resolves_with_the_row_count_when_it_ran", async () => {
  routes({ execute_sql: () => rowsResult(8) });
  const runRef = externalRun();
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  let outcome: Promise<{ ran: boolean; rows?: number }>;
  await act(async () => {
    outcome = runRef.current!("SELECT n FROM t");
  });
  await expect(outcome!).resolves.toEqual({ ran: true, rows: 8 });
});

test(
  "an_outside_run_on_production_resolves_not_ran_when_the_dialog_is_declined",
  patient(async () => {
    productionRoutes();
    const runRef = externalRun({ connections: [prod] });
    await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
    let outcome: Promise<{ ran: boolean; rows?: number }>;
    await act(async () => {
      outcome = runRef.current!("UPDATE t SET a = 1 WHERE id = 1");
    });
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await expect(outcome!).resolves.toEqual({ ran: false });
    expect(callsTo("execute_sql")).toHaveLength(0);
  }),
  LOAD_TIMEOUT,
);

test("an_outside_run_on_production_resolves_ran_after_the_dialog_is_confirmed", async () => {
  productionRoutes({ execute_sql: () => ({ outcome: { t: "affected", rows: 3 }, elapsedMs: 2 }) });
  const runRef = externalRun({ connections: [prod] });
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  let outcome: Promise<{ ran: boolean; rows?: number }>;
  await act(async () => {
    outcome = runRef.current!("UPDATE t SET a = 1 WHERE id = 1");
  });
  await userEvent.click(await screen.findByRole("button", { name: "Run on KFC Postgres" }));
  await expect(outcome!).resolves.toEqual({ ran: true, rows: 3 });
});

test("an_outside_run_blocked_by_read_only_resolves_not_ran", async () => {
  routes({ prepare_run: () => ({ kind: "readOnly", statement: "UPDATE t SET a = 1" }) });
  const runRef = externalRun();
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  let outcome: Promise<{ ran: boolean; rows?: number }>;
  await act(async () => {
    outcome = runRef.current!("UPDATE t SET a = 1");
  });
  await expect(outcome!).resolves.toEqual({ ran: false });
});

test("cancelled_open_that_finishes_is_closed_and_a_second_open_waits", async () => {
  let finish: (v: string) => void = () => {};
  routes({
    open_connection: () => new Promise<string>((r) => (finish = r)),
    close_connection: () => null,
  });
  const onConnectionOpened = vi.fn();
  setup(doc("SELECT 1"), false, { onConnectionOpened });
  await userEvent.click(screen.getByRole("button", { name: /Open KFC Postgres/ }));
  await userEvent.click(await screen.findByRole("button", { name: /Cancel/ }));
  const again = screen.getByRole("button", { name: /Stopping/ }) as HTMLButtonElement;
  expect(again.disabled).toBe(true);
  await userEvent.click(again);
  expect(callsTo("open_connection")).toHaveLength(1);
  finish("16");
  await waitFor(() => expect(callsTo("close_connection")).toEqual([{ id: "c1" }]));
  expect(onConnectionOpened).not.toHaveBeenCalled();
  expect(callsTo("open_query_session")).toHaveLength(0);
  expect(await screen.findByRole("heading", { name: "Open the Connection to run this query" })).toBeTruthy();
  expect((screen.getByRole("button", { name: /Open KFC Postgres/ }) as HTMLButtonElement).disabled).toBe(false);
});

// ---- final review fixes: outside runs of several statements, reconnect, cancelled open ----

test("an_outside_run_splits_its_statements_so_a_delete_without_where_asks", async () => {
  routes();
  const runRef = externalRun();
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  let outcome: Promise<{ ran: boolean; rows?: number }>;
  await act(async () => {
    outcome = runRef.current!("DELETE FROM orders;\nSELECT * FROM x WHERE id = 1");
  });
  expect(await screen.findByRole("alertdialog", { name: "Confirm DELETE without WHERE" })).toBeTruthy();
  expect(callsTo("prepare_run")).toEqual([{ session: "s1", statements: ["DELETE FROM orders", "SELECT * FROM x WHERE id = 1"] }]);
  expect(callsTo("execute_sql")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await expect(outcome!).resolves.toEqual({ ran: false });
  expect(callsTo("execute_sql")).toHaveLength(0);
});

test("an_outside_run_of_several_statements_runs_each_and_counts_the_last", async () => {
  routes({ execute_sql: ({ sql }) => (sql === "SELECT 1" ? rowsResult(1) : rowsResult(3)) });
  const runRef = externalRun();
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  let outcome: Promise<{ ran: boolean; rows?: number }>;
  await act(async () => {
    outcome = runRef.current!("SELECT 1;\nSELECT n FROM t;");
  });
  await expect(outcome!).resolves.toEqual({ ran: true, rows: 3 });
  expect(callsTo("execute_sql").map((c) => c.sql)).toEqual(["SELECT 1", "SELECT n FROM t"]);
});

test("an_outside_run_with_more_rows_than_the_first_page_says_so", async () => {
  routes({ execute_sql: () => rowsResult(200, true) });
  const runRef = externalRun();
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  let outcome: Promise<{ ran: boolean; rows?: number; more?: boolean }>;
  await act(async () => {
    outcome = runRef.current!("SELECT n FROM t");
  });
  await expect(outcome!).resolves.toEqual({ ran: true, rows: 200, more: true });
});

test("reconnect_runs_only_the_failed_statement_and_keeps_the_numbers", async () => {
  let drop = true;
  routes({
    open_connection: () => "16",
    execute_sql: ({ sql }) => {
      if (sql === "SELECT 2" && drop) throw { kind: "connect", message: "gone" };
      return rowsResult(1);
    },
  });
  const { view } = setup(doc("SELECT 1;\nSELECT 2;\nSELECT 3;"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true, shiftKey: true });
  const button = await screen.findByRole("button", { name: /Reconnect and run statement 2/ });
  drop = false;
  await userEvent.click(button);
  expect(await screen.findByText("Statement 3 did not run.")).toBeTruthy();
  expect(callsTo("execute_sql").map((c) => c.sql)).toEqual(["SELECT 1", "SELECT 2", "SELECT 2"]);
  expect(screen.queryByText(/Lost the connection/)).toBeNull();
});

test("reconnect_rerun_that_fails_again_keeps_statement_n_and_its_not_run_list", async () => {
  let drop = true;
  routes({
    open_connection: () => "16",
    execute_sql: ({ sql }) => {
      if (sql === "SELECT 2") {
        if (drop) throw { kind: "connect", message: "gone" };
        throw { kind: "query", message: "boom" };
      }
      return rowsResult(1);
    },
  });
  const { view } = setup(doc("SELECT 1;\nSELECT 2;\nSELECT 3;"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  key(view(), "Enter", { ctrlKey: true, shiftKey: true });
  const button = await screen.findByRole("button", { name: /Reconnect and run statement 2/ });
  drop = false;
  await userEvent.click(button);
  expect(await screen.findByRole("heading", { name: "Statement 2 failed" })).toBeTruthy();
  expect(screen.getByText("Not run, because statement 2 failed")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Statements that did not run" }).textContent).toContain("SELECT 3");
  expect(callsTo("execute_sql").map((c) => c.sql)).toEqual(["SELECT 1", "SELECT 2", "SELECT 2"]);
});

test("a_failed_reconnect_session_does_not_run_later_on_another_database", async () => {
  let sessions = 0;
  routeInvoke({
    open_connection: () => "16",
    open_query_session: () => {
      sessions += 1;
      if (sessions === 2) throw { kind: "connect", message: "refused" };
      return `s${sessions}`;
    },
    close_query_session: () => null,
    list_databases: () => ["kfc_shop", "other"],
    prepare_run: () => ({ kind: "ok" }),
    execute_sql: () => {
      throw { kind: "connect", message: "gone" };
    },
  });
  const editorRef = { current: null as SqlEditorApi | null };
  const ui = (database: string) => (
    <ToastProvider>
      <QueryTab
        tab={doc("UPDATE t SET a = 1 WHERE id = 1", { database })}
        connections={[conn]}
        openIds={new Set(["c1"])}
        onChange={() => {}}
        onSaved={() => {}}
        historyOpen={false}
        onToggleHistory={() => {}}
        editorRef={editorRef}
      />
    </ToastProvider>
  );
  const { rerender } = render(ui("kfc_shop"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
  key(view, "Enter", { ctrlKey: true });
  await userEvent.click(await screen.findByRole("button", { name: /Reconnect and run statement 1/ }));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(2));
  rerender(ui("other"));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(3));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(callsTo("execute_sql")).toHaveLength(1);
});

test("a_reconnect_rerun_is_dropped_when_the_connection_is_not_open_so_a_later_open_never_runs_it", async () => {
  let sessions = 0;
  let rerenderRef: (ui: React.ReactElement) => void = () => {};
  const editorRef = { current: null as SqlEditorApi | null };
  const ui = (openIds: string[]) => (
    <ToastProvider>
      <QueryTab
        tab={doc("UPDATE t SET a = 1 WHERE id = 1")}
        connections={[conn]}
        openIds={new Set(openIds)}
        onChange={() => {}}
        onSaved={() => {}}
        historyOpen={false}
        onToggleHistory={() => {}}
        editorRef={editorRef}
      />
    </ToastProvider>
  );
  routeInvoke({
    // The Connection is reported not open for the render that follows the reconnect.
    open_connection: () => {
      rerenderRef(ui([]));
      return "16";
    },
    open_query_session: () => `s${++sessions}`,
    close_query_session: () => null,
    list_databases: () => ["kfc_shop"],
    prepare_run: () => ({ kind: "ok" }),
    execute_sql: () => {
      throw { kind: "connect", message: "gone" };
    },
  });
  const { rerender } = render(ui(["c1"]));
  rerenderRef = rerender;
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
  key(view, "Enter", { ctrlKey: true });
  await userEvent.click(await screen.findByRole("button", { name: /Reconnect and run statement 1/ }));
  rerender(ui(["c1"]));
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(2));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(callsTo("execute_sql")).toHaveLength(1);
});

function closedTab(openIds: string[]) {
  const editorRef = { current: null as SqlEditorApi | null };
  return (
    <ToastProvider>
      <QueryTab
        tab={doc("SELECT 1")}
        connections={[conn]}
        openIds={new Set(openIds)}
        onChange={() => {}}
        onSaved={() => {}}
        historyOpen={false}
        onToggleHistory={() => {}}
        editorRef={editorRef}
      />
    </ToastProvider>
  );
}

test("a_cancelled_open_leaves_the_connection_open_when_another_path_opened_it", async () => {
  let finish: (v: string) => void = () => {};
  routes({
    open_connection: () => new Promise<string>((r) => (finish = r)),
    close_connection: () => null,
  });
  const { rerender } = render(closedTab([]));
  await userEvent.click(screen.getByRole("button", { name: /Open KFC Postgres/ }));
  await userEvent.click(await screen.findByRole("button", { name: /Cancel/ }));
  // The tree opened it meanwhile.
  rerender(closedTab(["c1"]));
  await act(async () => finish("16"));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(callsTo("close_connection")).toHaveLength(0);
});

test("a_cancelled_open_leaves_the_connection_open_while_another_open_is_in_flight", async () => {
  const finishers: ((v: string) => void)[] = [];
  routes({
    open_connection: () => new Promise<string>((r) => finishers.push(r)),
    close_connection: () => null,
  });
  render(closedTab([]));
  await userEvent.click(screen.getByRole("button", { name: /Open KFC Postgres/ }));
  await userEvent.click(await screen.findByRole("button", { name: /Cancel/ }));
  // Another tab or the tree starts its own open before this one ends.
  const other = openConnection("c1");
  await act(async () => finishers[0]("16"));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(callsTo("close_connection")).toHaveLength(0);
  finishers[1]("16");
  await other;
});

// The query diagram beside the editor (step 6, B1).

const DIAGRAM_SQL = "SELECT o.id, s.name\nFROM sales.orders o\nJOIN stores s ON s.id = o.store_id";
const ctrlShiftD = (view: EditorView) => key(view, "D", { ctrlKey: true, shiftKey: true, code: "KeyD", keyCode: 68 });

test("ctrl_shift_d_opens_the_query_diagram_beside_the_editor_and_closes_it_again", async () => {
  routes({ sql_schema: () => KFC_SCHEMA });
  const lang = withLang();
  const asked = vi.spyOn(lang.client, "sqlShape");
  const { view, rerenderCurrent } = setup(doc(DIAGRAM_SQL), true, { lang, visible: true });
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  const diagramButton = () => screen.getByRole("button", { name: /^Diagram/ });
  expect(diagramButton().getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("region", { name: "Query diagram" })).toBeNull();
  expect(asked).not.toHaveBeenCalled();

  ctrlShiftD(view());
  const pane = await screen.findByRole("region", { name: "Query diagram" });
  expect(diagramButton().getAttribute("aria-pressed")).toBe("true");
  await waitFor(() => expect(asked).toHaveBeenCalled());
  expect(asked.mock.calls[0][0]).toMatchObject({ docId: "t1", text: DIAGRAM_SQL, dialect: "postgres", pos: 0 });
  expect(await within(pane).findByRole("group", { name: "Table orders o" })).toBeTruthy();
  // The editor keeps 580 px; the pane takes the rest.
  expect(document.querySelector(".query-tab")?.classList.contains("query-tab-with-diagram")).toBe(true);
  expect(/\.query-tab-with-diagram\s*\{[^}]*grid-template-columns:\s*580px minmax\(0, 1fr\)/.test(appCss)).toBe(true);

  // Moving where you are typing asks again.
  const before = asked.mock.calls.length;
  act(() => view().dispatch({ selection: { anchor: DIAGRAM_SQL.indexOf("JOIN") } }));
  rerenderCurrent();
  await waitFor(() => expect(asked.mock.calls.length).toBeGreaterThan(before));
  expect(asked.mock.calls[asked.mock.calls.length - 1][0].pos).toBe(DIAGRAM_SQL.indexOf("JOIN"));

  ctrlShiftD(view());
  await waitFor(() => expect(screen.queryByRole("region", { name: "Query diagram" })).toBeNull());
  expect(diagramButton().getAttribute("aria-pressed")).toBe("false");
  const closedAt = asked.mock.calls.length;
  act(() => view().dispatch({ changes: { from: 0, insert: "-- note\n" } }));
  rerenderCurrent();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(asked.mock.calls.length).toBe(closedAt);
});

test("the_diagram_button_opens_the_pane_and_a_selected_card_bands_its_lines_in_the_editor", async () => {
  routes({ sql_schema: () => KFC_SCHEMA });
  const lang = withLang();
  setup(doc(DIAGRAM_SQL), true, { lang, visible: true });
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: /^Diagram/ }));
  const pane = await screen.findByRole("region", { name: "Query diagram" });
  const card = await within(pane).findByRole("group", { name: "Table stores s" });
  fireEvent.click(card.closest(".react-flow__node") as HTMLElement);
  // Line 3 names stores (FROM ... JOIN stores s ON s.id = ...); line 1 reads s.name.
  await waitFor(() => expect([...document.querySelectorAll(".cm-line.cm-diagram-band")].map((l) => l.textContent)).toEqual([
    "SELECT o.id, s.name",
    "JOIN stores s ON s.id = o.store_id",
  ]));
  await userEvent.click(within(pane).getByRole("button", { name: "Close diagram" }));
  await waitFor(() => expect(document.querySelectorAll(".cm-line.cm-diagram-band")).toHaveLength(0));
});

test("the_diagram_loads_another_mysql_database_a_statement_names", async () => {
  const mysql: ConnectionConfig = { ...conn, dialect: "mysql", port: 3306, database: "shop" };
  const SHOP_SCHEMA = { searchPath: [], tables: [{ schema: null, name: "orders", kind: "table" as const, columns: [{ name: "id", typeName: "int", pk: true }] }], fks: [] };
  const ARCHIVE_SCHEMA = { searchPath: [], tables: [{ schema: null, name: "old_orders", kind: "table" as const, columns: [{ name: "id", typeName: "int", pk: true }, { name: "placed_at", typeName: "datetime", pk: false }] }], fks: [] };
  let release: () => void = () => {};
  routes({
    list_databases: () => ["shop", "archive"],
    sql_schema: ({ database }) => (database === "archive" ? new Promise((r) => (release = () => r(ARCHIVE_SCHEMA))) : SHOP_SCHEMA),
  });
  const lang = withLang();
  setup(doc("SELECT a.placed_at FROM archive.old_orders a", { database: "shop" }), true, { lang, connections: [mysql], visible: true });
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: /^Diagram/ }));
  const pane = await screen.findByRole("region", { name: "Query diagram" });
  await waitFor(() => expect(callsTo("sql_schema")).toContainEqual({ id: "c1", database: "archive" }));
  const card = await within(pane).findByRole("group", { name: "Table old_orders a" });
  expect(card.textContent).toContain("Loading schema");
  expect(card.textContent).not.toContain("Not in the schema");
  act(() => release());
  await waitFor(() => expect(within(pane).getByRole("group", { name: "Table old_orders a" }).textContent).toContain("datetime"));
  expect(within(pane).getByRole("group", { name: "Table old_orders a" }).textContent).not.toContain("Loading schema");
});
