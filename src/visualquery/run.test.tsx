import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, ObjectPath, SqlPart, SqlSchema, VisualQuery, VqPreview, VqRun } from "../api/types";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import type { VisualTabDoc } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import CrossJoinDialog, { aboutRows } from "./CrossJoinDialog";
import { emptyQuery } from "./model";
import VisualQueryTab, { type VisualQueryTabProps, runBlock } from "./VisualQueryTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

patientFile();
beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});

const kestrel: ConnectionConfig = {
  id: "c1",
  name: "kestrel-main",
  dialect: "mysql",
  host: "127.0.0.1",
  port: 3306,
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

const col = (name: string, typeName = "int", pk = false) => ({ name, typeName, pk });
const SHOP: SqlSchema = {
  searchPath: [],
  tables: [
    { schema: null, name: "menu_items", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)")] },
    { schema: null, name: "orders", kind: "table", columns: [col("id", "int", true), col("store_id"), col("code", "varchar(8)")] },
    { schema: null, name: "stores", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)")] },
    { schema: null, name: "regions", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)")] },
  ],
  fks: [{ from: { schema: null, table: "orders", columns: ["store_id"] }, to: { schema: null, table: "stores", columns: ["id"] } }],
};

const ROWS: Record<string, number> = { orders: 1284339, menu_items: 86, regions: 5 };

let lang: { client: LangClient; schemas: SchemaCache };

/** The Core's preview, as far as these tests need: a FROM line, then a line per Join or CROSS JOIN. */
function previewFor(query: VisualQuery): VqPreview {
  if (query.columns.length === 0) return { query: null, problems: [{ target: { kind: "columns" }, message: "Tick at least one column." }] };
  const [root, ...rest] = query.tables;
  const lines = [`SELECT ${query.columns.map((c) => c.column).join(", ")}`, `FROM ${root.name} AS ${root.alias}`];
  const parts: SqlPart[] = [
    { part: { kind: "select" }, fromLine: 1, toLine: 1 },
    { part: { kind: "from", table: root.id }, fromLine: 2, toLine: 2 },
  ];
  const warnings: NonNullable<VqPreview["query"]>["warnings"] = [];
  for (const t of rest) {
    const j = query.joins.find((x) => x.right === t.id || x.left === t.id);
    if (j) {
      lines.push(`INNER JOIN ${t.name} AS ${t.alias} ON ${t.alias}.id = ${root.alias}.store_id`);
      parts.push({ part: { kind: "join", join: j.id }, fromLine: lines.length, toLine: lines.length });
    } else {
      lines.push(`CROSS JOIN ${t.name} AS ${t.alias}`);
      warnings.push({ kind: "crossJoin", table: t.id, rows: null });
    }
  }
  return { query: { sql: lines.join("\n"), parts, outputs: query.columns.map((c) => c.column), warnings }, problems: [] };
}

const TEN = Array.from({ length: 10 }, (_, i) => [{ t: "number" as const, value: String(i + 1) }]);
const ran = (sql: string): VqRun => ({
  sql,
  execution: { outcome: { t: "rows", columns: [{ name: "id", typeName: "int", numeric: true }], rows: TEN, hasMore: false }, elapsedMs: 38 },
});

let runAnswer: (args: Record<string, unknown>) => unknown;
beforeEach(() => {
  const client = new LangClient(() => fakeWorker());
  lang = { client, schemas: new SchemaCache(client, () => Promise.resolve(SHOP)) };
  runAnswer = ({ query }) => ran(previewFor(query as VisualQuery).query!.sql);
  routes = {
    visual_query_sql: ({ query }) => previewFor(query as VisualQuery),
    open_query_session: () => "s1",
    close_query_session: () => null,
    close_query_result: () => null,
    cancel_query: () => null,
    run_visual_query: (args) => runAnswer(args),
  };
  routeInvoke(routes);
});
let routes: Parameters<typeof routeInvoke>[0] = {};

const card = (id: string, name: string, alias: string, x = 0) => ({ id, schema: null, name, alias, x, y: 0 });
const ORDERS_STORES: Partial<VisualQuery> = {
  tables: [card("t1", "orders", "o"), card("t2", "stores", "s", 300)],
  joins: [{ id: "j1", left: "t1", right: "t2", kind: "inner", on: [{ leftColumn: "store_id", rightColumn: "id" }] }],
  columns: [
    { table: "t1", column: "id", aggregate: null, alias: null },
    { table: "t2", column: "name", aggregate: null, alias: null },
  ],
};
const ORDERS_MENU: Partial<VisualQuery> = {
  tables: [card("t1", "orders", "o"), card("t2", "menu_items", "m", 300)],
  joins: [],
  columns: [{ table: "t1", column: "id", aggregate: null, alias: null }],
};

const docWith = (over: Partial<VisualQuery> = {}): VisualTabDoc => ({
  id: "v1",
  name: "New Visual Query",
  connectionId: "c1",
  database: "shop",
  model: { ...emptyQuery("shop", "mysql"), ...over },
  savedId: null,
  savedJson: null,
});

let setModel: (f: (q: VisualQuery) => VisualQuery) => void = () => {};
function Harness({ initial, ...props }: { initial: VisualTabDoc } & Partial<VisualQueryTabProps>) {
  const [doc, setDoc] = useState(initial);
  setModel = (f) => setDoc((d) => ({ ...d, model: f(d.model) }));
  return (
    <ToastProvider>
      <div style={{ width: 1200, height: 800 }}>
        <VisualQueryTab
          doc={doc}
          connection={kestrel}
          open
          group={null}
          visible
          lang={lang}
          rowEstimate={(p: ObjectPath) => ROWS[p.name] ?? null}
          onChange={setDoc}
          onOpenInEditor={() => {}}
          onSaved={() => {}}
          onOpenConnection={() => {}}
          {...props}
        />
      </div>
    </ToastProvider>
  );
}

const runButton = () => within(screen.getByRole("toolbar", { name: "Visual Query" })).getByRole("button", { name: /^Run/ }) as HTMLButtonElement;
const canvas = () => document.querySelector<HTMLElement>(".diagram-canvas")!;
const ctrlEnter = () => fireEvent.keyDown(canvas(), { key: "Enter", ctrlKey: true });
const panelHeader = () => screen.getByRole("tablist", { name: "Query panel" }).parentElement!;
/** Waits for the session and the preview, so Run is on. */
async function ready() {
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(1));
  await waitFor(() => expect(runButton().disabled).toBe(false));
}

test("ctrl_enter_runs_on_the_tab_session_with_no_pass_and_shows_the_results", async () => {
  const onRan = vi.fn();
  const slot = document.createElement("span");
  slot.id = "app-status-slot";
  document.body.appendChild(slot);
  try {
    render(<Harness initial={docWith(ORDERS_STORES)} onRan={onRan} />);
    await ready();
    // The run opens its session on the model's database (MySQL tables are written without it).
    expect(callsTo("open_query_session")).toEqual([{ id: "c1", database: "shop" }]);
    ctrlEnter();
    await waitFor(() => expect(callsTo("run_visual_query")).toHaveLength(1));
    const call = callsTo("run_visual_query")[0];
    expect(call.session).toBe("s1");
    expect(call.pass).toBeNull();
    expect((call.query as VisualQuery).tables.map((t) => t.name)).toEqual(["orders", "stores"]);
    expect(call.types).toMatchObject({ t1: { id: "int" }, t2: { name: "varchar(80)" } });
    // The panel switches to Results.
    expect(await screen.findByText("10 rows in 38ms")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Results" }).getAttribute("aria-selected")).toBe("true");
    expect(onRan).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(slot.textContent).toContain("2 tables"));
    expect(slot.textContent).toContain("10 rows");
    expect(slot.textContent).toContain("38ms");
    expect(slot.textContent).not.toContain("Changed since the last run");

    // Any change after a run says so in the panel header and the status slot.
    act(() => setModel((q) => ({ ...q, distinct: true })));
    await waitFor(() => expect(within(panelHeader()).getByText("Changed since the last run")).toBeTruthy());
    expect(slot.textContent).toContain("Changed since the last run");

    // The next run clears it.
    await waitFor(() => expect(runButton().disabled).toBe(false));
    await userEvent.click(runButton());
    await waitFor(() => expect(callsTo("run_visual_query")).toHaveLength(2));
    await waitFor(() => expect(within(panelHeader()).queryByText("Changed since the last run")).toBeNull());
    expect(slot.textContent).not.toContain("Changed since the last run");
  } finally {
    slot.remove();
  }
});

test("moving_a_card_is_not_a_change_to_the_query", async () => {
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  ctrlEnter();
  await screen.findByText("10 rows in 38ms");
  act(() => setModel((q) => ({ ...q, tables: q.tables.map((t) => (t.id === "t2" ? { ...t, x: 640 } : t)) })));
  await new Promise((r) => setTimeout(r, 50));
  expect(within(panelHeader()).queryByText("Changed since the last run")).toBeNull();
});

test("run_is_off_and_says_why_when_the_connection_is_closed_or_a_table_is_missing", async () => {
  const { unmount } = render(<Harness initial={docWith(ORDERS_STORES)} open={false} />);
  await waitFor(() => expect(runButton().title).toBe("kestrel-main is not open"));
  expect(runButton().disabled).toBe(true);
  ctrlEnter();
  expect(callsTo("open_query_session")).toHaveLength(0);
  expect(callsTo("run_visual_query")).toHaveLength(0);
  unmount();

  render(
    <Harness
      initial={docWith({
        tables: [card("t1", "orders", "o"), card("t9", "shipments", "sh", 300)],
        joins: [],
        columns: [{ table: "t1", column: "id", aggregate: null, alias: null }],
      })}
    />,
  );
  await waitFor(() => expect(runButton().title).toBe("Remove or replace 1 missing table to run."));
  expect(runButton().disabled).toBe(true);
});

test("run_is_off_with_the_problem_that_stops_the_sql", async () => {
  render(<Harness initial={docWith({ ...ORDERS_STORES, columns: [] })} />);
  await waitFor(() => expect(runButton().title).toBe("Tick at least one column."));
  expect(runButton().disabled).toBe(true);
});

test("a_lone_table_asks_once_before_its_first_run", async () => {
  render(<Harness initial={docWith(ORDERS_MENU)} />);
  await ready();
  await userEvent.click(runButton());
  const ask = await screen.findByRole("dialog", { name: "Run with a CROSS JOIN?" });
  expect(
    within(ask).getByText(
      "menu_items has no Join. Every one of the 1,284,339 orders pairs with all 86 menu items, about 110 million rows before the filter.",
    ),
  ).toBeTruthy();
  expect(within(ask).getByText("Asked once for this query. Draw a Join from a column of menu_items to avoid it.")).toBeTruthy();
  expect(callsTo("run_visual_query")).toHaveLength(0);
  await userEvent.click(within(ask).getByRole("button", { name: /Run anyway/ }));
  await waitFor(() => expect(callsTo("run_visual_query")).toHaveLength(1));
  expect(screen.queryByRole("dialog")).toBeNull();

  // The same set does not ask again.
  await screen.findByText("10 rows in 38ms");
  await userEvent.click(runButton());
  await waitFor(() => expect(callsTo("run_visual_query")).toHaveLength(2));
  expect(screen.queryByRole("dialog")).toBeNull();

  // Another unjoined table makes a new set: it asks again. Cancel runs nothing.
  act(() => setModel((q) => ({ ...q, tables: [...q.tables, card("t3", "regions", "r", 600)] })));
  await waitFor(() => expect(callsTo("visual_query_sql").some((c) => (c.query as VisualQuery).tables.length === 3)).toBe(true));
  await waitFor(() => expect(runButton().disabled).toBe(false));
  await userEvent.click(runButton());
  const again = await screen.findByRole("dialog", { name: "Run with a CROSS JOIN?" });
  expect(within(again).getByText(/^regions has no Join\./)).toBeTruthy();
  await userEvent.click(within(again).getByRole("button", { name: /Cancel/ }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("run_visual_query")).toHaveLength(2);

  // Add a Join closes it and puts focus on the lone card.
  await userEvent.click(runButton());
  const third = await screen.findByRole("dialog", { name: "Run with a CROSS JOIN?" });
  await userEvent.click(within(third).getByRole("button", { name: "Add a Join" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement?.closest(".react-flow__node")?.getAttribute("data-id")).toBe("t2"));
  expect(callsTo("run_visual_query")).toHaveLength(2);
});

test("the_cross_join_dialog_reads_its_counts", () => {
  expect(aboutRows(110_453_154)).toBe("110 million");
  expect(aboutRows(2_400)).toBe("2.4 thousand");
  expect(aboutRows(2_000)).toBe("2 thousand");
  expect(aboutRows(999)).toBe("999");
  expect(aboutRows(3_200_000_000)).toBe("3.2 billion");
  const noop = () => {};
  const { unmount } = render(
    <CrossJoinDialog
      tables={[{ name: "menu_items", rows: 86, estimated: false }]}
      root={{ name: "orders", rows: 12, estimated: false }}
      onAddJoin={noop}
      onCancel={noop}
      onRun={noop}
    />,
  );
  // Every count exact: no "about", and the product written as it is.
  expect(screen.getByText("menu_items has no Join. Every one of the 12 orders pairs with all 86 menu items, 1,032 rows before the filter.")).toBeTruthy();
  unmount();
  render(
    <CrossJoinDialog
      tables={[{ name: "menu_items", rows: null, estimated: true }]}
      root={{ name: "orders", rows: 1284339 }}
      onAddJoin={noop}
      onCancel={noop}
      onRun={noop}
    />,
  );
  expect(screen.getByText("menu_items has no Join. Every one of the 1,284,339 orders pairs with every row of menu_items.")).toBeTruthy();
  // Run anyway takes Enter: it has the focus.
  expect(document.activeElement?.textContent).toContain("Run anyway");
});

test("a_server_error_in_a_join_marks_the_join_and_its_line_until_the_next_change", async () => {
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  // As a MySQL server says it: the Join is line 3 of the text that ran.
  runAnswer = () => {
    throw {
      kind: "query",
      message: "Server error: `ERROR 1064 (42000): Unknown column 's.id' in 'on clause' near 'ON s.id' at line 3'",
    };
  };
  ctrlEnter();
  // The message as sent, in Results.
  expect(await screen.findByText(/Unknown column/)).toBeTruthy();
  const lines = () => [...document.querySelectorAll('[aria-label="Generated SQL"] .sql-block-line')];
  await waitFor(() => expect(lines()[2].className).toContain("sql-block-line-danger"));
  expect(lines()[1].className).not.toContain("sql-block-line-danger");
  const badge = () => document.querySelector('.vq-join-badge[data-join="j1"]')!;
  await waitFor(() => expect(badge().className).toContain("vq-join-badge-danger"));
  expect(document.querySelector(".vq-join-line.vq-join-danger")).toBeTruthy();
  // Both column rows of the Join are marked.
  const row = (table: string, column: string) =>
    document.querySelector(`.react-flow__node[data-id="${table}"] li[data-column="${column}"]`)!;
  expect(row("t1", "store_id").className).toContain("vq-card-row-danger");
  expect(row("t2", "id").className).toContain("vq-card-row-danger");
  expect(row("t1", "id").className).not.toContain("vq-card-row-danger");

  await userEvent.click(screen.getByRole("button", { name: "Show the Join" }));
  expect(await screen.findByRole("dialog", { name: "Join orders to stores" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Join orders to stores" }), { key: "Escape" });

  // The next change clears the marks.
  act(() => setModel((q) => ({ ...q, distinct: true })));
  await waitFor(() => expect(badge().className).not.toContain("vq-join-badge-danger"));
  expect(lines().some((l) => l.className.includes("sql-block-line-danger"))).toBe(false);
  expect(row("t1", "store_id").className).not.toContain("vq-card-row-danger");
});

test("a_mysql_error_at_a_line_bands_that_line", async () => {
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  runAnswer = () => {
    throw {
      kind: "query",
      message: "Server error: `ERROR 1064 (42000): You have an error in your SQL syntax; check the manual near 'ON' at line 2'",
    };
  };
  ctrlEnter();
  expect(await screen.findByText(/You have an error/)).toBeTruthy();
  const lines = () => [...document.querySelectorAll('[aria-label="Generated SQL"] .sql-block-line')];
  await waitFor(() => expect(lines()[1].className).toContain("sql-block-line-danger"));
  // Not a Join line: no Join is marked and there is nothing to show.
  expect(document.querySelector(".vq-join-badge-danger")).toBeNull();
  expect(screen.queryByRole("button", { name: "Show the Join" })).toBeNull();
});

test("production_washes_the_tab_and_runs_without_asking", async () => {
  render(<Harness initial={docWith(ORDERS_STORES)} connection={{ ...kestrel, production: true }} />);
  await ready();
  expect([...document.querySelectorAll(".prod-wash")].map((e) => e.getAttribute("data-part")).filter(Boolean).sort()).toEqual([
    "canvas",
    "panel",
    "sql",
  ]);
  expect(runButton().textContent).toMatch(/^Run/);
  expect(runButton().textContent).not.toMatch(/PROD/);
  expect(runButton().className).toContain("button-primary");
  ctrlEnter();
  await waitFor(() => expect(callsTo("run_visual_query")).toHaveLength(1));
  expect(callsTo("run_visual_query")[0].pass).toBeNull();
  expect(await screen.findByText("10 rows in 38ms")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("prepare_run")).toHaveLength(0);
});

test("a_read_only_connection_runs", async () => {
  render(<Harness initial={docWith(ORDERS_STORES)} connection={{ ...kestrel, readOnly: true }} />);
  await ready();
  ctrlEnter();
  expect(await screen.findByText("10 rows in 38ms")).toBeTruthy();
});

test("esc_while_running_cancels_on_the_server", async () => {
  let release: (v: VqRun) => void = () => {};
  runAnswer = () => new Promise<VqRun>((r) => (release = r));
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  ctrlEnter();
  await screen.findByRole("button", { name: "Cancel" });
  fireEvent.keyDown(canvas(), { key: "Escape" });
  await waitFor(() => expect(callsTo("cancel_query")).toEqual([{ session: "s1" }]));
  release(ran("SELECT 1"));
});

test("closing_the_tab_closes_its_session", async () => {
  const { unmount } = render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  unmount();
  await waitFor(() => expect(callsTo("close_query_session")).toEqual([{ session: "s1" }]));
});

/** A run whose answer waits until released. */
function pendingRun() {
  let release: (v: VqRun) => void = () => {};
  runAnswer = () => new Promise<VqRun>((r) => (release = r));
  return () => release(ran("SELECT 1"));
}

test("a_run_going_when_the_connection_closes_settles_and_run_comes_back", async () => {
  const release = pendingRun();
  const { rerender } = render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  ctrlEnter();
  await screen.findByRole("button", { name: "Cancel" });
  rerender(<Harness initial={docWith(ORDERS_STORES)} open={false} />);
  expect(await screen.findByText("The run stopped because kestrel-main closed.")).toBeTruthy();
  rerender(<Harness initial={docWith(ORDERS_STORES)} open />);
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(2));
  await waitFor(() => expect(runButton().disabled).toBe(false));
  // The late answer stays ignored.
  release();
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText("10 rows in 38ms")).toBeNull();
  expect(screen.getByText("The run stopped because kestrel-main closed.")).toBeTruthy();
});

test("a_run_going_when_the_tab_moves_to_another_connection_settles", async () => {
  const release = pendingRun();
  const { rerender } = render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  ctrlEnter();
  await screen.findByRole("button", { name: "Cancel" });
  rerender(<Harness initial={docWith(ORDERS_STORES)} connection={{ ...kestrel, id: "c2", name: "kestrel-replica" }} />);
  expect(await screen.findByText("The run stopped because the Connection changed.")).toBeTruthy();
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(2));
  await waitFor(() => expect(runButton().disabled).toBe(false));
  release();
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText("10 rows in 38ms")).toBeNull();
});

test("a_run_going_when_the_database_changes_settles", async () => {
  const release = pendingRun();
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  ctrlEnter();
  await screen.findByRole("button", { name: "Cancel" });
  act(() => setModel((q) => ({ ...q, database: "archive" })));
  expect(await screen.findByText("The run stopped because the database changed.")).toBeTruthy();
  await waitFor(() => expect(callsTo("open_query_session")).toEqual([{ id: "c1", database: "shop" }, { id: "c1", database: "archive" }]));
  await waitFor(() => expect(runButton().disabled).toBe(false));
  release();
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText("10 rows in 38ms")).toBeNull();
});

test("a_double_ctrl_enter_runs_once", async () => {
  const release = pendingRun();
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  ctrlEnter();
  ctrlEnter();
  await screen.findByRole("button", { name: "Cancel" });
  await new Promise((r) => setTimeout(r, 20));
  expect(callsTo("run_visual_query")).toHaveLength(1);
  release();
});

test("v7_a_joined_cross_join_group_is_counted_by_its_largest_table", async () => {
  render(
    <Harness
      initial={docWith({
        tables: [card("t1", "regions", "r"), card("t2", "stores", "s", 300), card("t3", "orders", "o", 600)],
        joins: [{ id: "j1", left: "t3", right: "t2", kind: "inner", on: [{ leftColumn: "store_id", rightColumn: "id" }] }],
        columns: [{ table: "t1", column: "id", aggregate: null, alias: null }],
      })}
    />,
  );
  await ready();
  await userEvent.click(runButton());
  const ask = await screen.findByRole("dialog", { name: "Run with a CROSS JOIN?" });
  expect(
    within(ask).getByText(
      "stores has no Join. Every one of the 5 regions pairs with all 1,284,339 orders, about 6.4 million rows before the filter.",
    ),
  ).toBeTruthy();
});

test("keys_inside_a_dialog_do_not_run_or_cancel", async () => {
  const release = pendingRun();
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  ctrlEnter();
  await screen.findByRole("button", { name: "Cancel" });
  await userEvent.click(within(screen.getByRole("toolbar", { name: "Visual Query" })).getByRole("button", { name: "More" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename..." }));
  const field = await screen.findByRole("textbox", { name: "Name" });
  fireEvent.keyDown(field, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull());
  expect(callsTo("cancel_query")).toHaveLength(0);
  release();
});

test("a_session_that_did_not_open_says_so_on_run", () => {
  const base = { connection: "kestrel-main", open: true, missing: 0, sql: "SELECT 1", problems: [] };
  expect(runBlock({ ...base, sessionError: "Could not open a session." })).toBe("Could not open a session.");
  expect(runBlock(base)).toBeNull();
});

test("a_lost_connection_reconnects_opens_a_new_session_and_runs_again", async () => {
  let lost = true;
  runAnswer = ({ query }) => {
    if (lost) throw { kind: "connect", message: "Server has gone away" };
    return ran(previewFor(query as VisualQuery).query!.sql);
  };
  const opened = vi.fn();
  routeInvoke({ ...routes, open_connection: () => "8.0.30" });
  render(<Harness initial={docWith(ORDERS_STORES)} onConnectionOpened={opened} />);
  await ready();
  ctrlEnter();
  const reconnect = await screen.findByRole("button", { name: /Reconnect and run/ });
  lost = false;
  await userEvent.click(reconnect);
  await waitFor(() => expect(callsTo("open_connection")).toEqual([{ id: "c1" }]));
  expect(opened).toHaveBeenCalledWith("c1");
  // The session opens again, and the run goes on it.
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(2));
  await waitFor(() => expect(callsTo("run_visual_query")).toHaveLength(2));
  expect(await screen.findByText("10 rows in 38ms")).toBeTruthy();
});

test("a_session_that_did_not_open_offers_try_again", async () => {
  let fail = true;
  routeInvoke({
    ...routes,
    open_query_session: () => {
      if (fail) throw { kind: "connect", message: "refused" };
      return "s2";
    },
  });
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await userEvent.click(screen.getByRole("tab", { name: "Results" }));
  const again = await screen.findByRole("button", { name: "Try again" });
  expect(runButton().disabled).toBe(true);
  fail = false;
  await userEvent.click(again);
  await waitFor(() => expect(callsTo("open_query_session")).toHaveLength(2));
  await waitFor(() => expect(runButton().disabled).toBe(false));
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("a_run_stopped_by_a_closed_connection_reads_as_stopped_not_failed", async () => {
  pendingRun();
  const { rerender } = render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  ctrlEnter();
  await screen.findByRole("button", { name: "Cancel" });
  rerender(<Harness initial={docWith(ORDERS_STORES)} open={false} />);
  await screen.findByText("The run stopped because kestrel-main closed.");
  expect(screen.getByRole("heading", { name: /^Stopped after/ })).toBeTruthy();
  expect(screen.queryByText(/Statement 1 failed/)).toBeNull();
  expect(screen.queryByText("Contura said")).toBeNull();
});

test("run_right_after_an_edit_shows_the_sql_it_runs_at_once", async () => {
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  await waitFor(() => expect(screen.getByRole("group", { name: "Generated SQL" }).textContent).toContain("SELECT id, name"));
  act(() => setModel((q) => ({ ...q, columns: [...q.columns, { table: "t1", column: "code", aggregate: null, alias: null }] })));
  ctrlEnter();
  // Well inside the pane's 120ms wait.
  await act(() => new Promise((r) => setTimeout(r, 0)));
  expect(callsTo("run_visual_query")).toHaveLength(1);
  // No 120ms wait: the pane already shows the SQL that runs.
  expect(screen.getByRole("group", { name: "Generated SQL" }).textContent).toContain("SELECT id, name, code");
});

test("after_clicking_run_esc_cancels_and_ctrl_enter_runs_again", async () => {
  const release = pendingRun();
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  await userEvent.click(runButton());
  await screen.findByRole("button", { name: "Cancel" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(callsTo("cancel_query")).toEqual([{ session: "s1" }]));
  release();
  await waitFor(() => expect(runButton().disabled).toBe(false));
  runAnswer = ({ query }) => ran(previewFor(query as VisualQuery).query!.sql);
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(callsTo("run_visual_query")).toHaveLength(2));
});

test("ctrl_c_in_the_sql_pane_with_nothing_selected_copies_the_sql", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  try {
    render(<Harness initial={docWith(ORDERS_STORES)} />);
    await ready();
    const code = await screen.findByRole("group", { name: "Generated SQL" });
    fireEvent.keyDown(code, { key: "c", code: "KeyC", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(previewFor({ ...emptyQuery("shop", "mysql"), ...ORDERS_STORES } as VisualQuery).query!.sql));
  } finally {
    vi.unstubAllGlobals();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  }
});
