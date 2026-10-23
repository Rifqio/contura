import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, SqlPart, SqlSchema, VisualQuery, VqPreview } from "../api/types";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import type { VisualTabDoc } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { emptyQuery } from "./model";
import { fitWidth, type QueryCardData, queryCardHeight } from "./QueryCard";
import { rowAnchor } from "./JoinEdge";
import { parseVisualDrafts } from "./drafts";
import VisualQueryTab, { type VisualQueryTabProps, joinBrings, pairsSentence, warningLines } from "./VisualQueryTab";

/** Item 30: the SQL is a tab of the bottom panel; this shows it. */
async function showSql() {
  await userEvent.click(screen.getByRole("tab", { name: "SQL" }));
  return screen.findByRole("region", { name: "SQL" });
}


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
const WIDE = ["id", ...Array.from({ length: 14 }, (_, i) => `c${i + 1}`)];
const SHOP: SqlSchema = {
  searchPath: [],
  tables: [
    { schema: null, name: "menu_items", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)")] },
    {
      schema: null,
      name: "orders",
      kind: "table",
      columns: [col("id", "int", true), col("store_id"), col("placed_at", "datetime"), col("total", "decimal(10,2)")],
    },
    { schema: null, name: "stores", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)"), col("city", "varchar(80)")] },
    { schema: null, name: "v_daily_sales", kind: "view", columns: [col("day", "date"), col("total", "decimal(10,2)")] },
    { schema: null, name: "wide", kind: "table", columns: WIDE.map((c, i) => col(c, "int", i === 0)) },
  ],
  fks: [{ from: { schema: null, table: "orders", columns: ["store_id"] }, to: { schema: null, table: "stores", columns: ["id"] } }],
};
const ARCHIVE: SqlSchema = {
  searchPath: [],
  tables: [{ schema: null, name: "old_orders", kind: "table", columns: [col("id", "int", true)] }],
  fks: [],
};

type Held = { resolve: (s: SqlSchema) => void; reject: (e: unknown) => void };
let held: Map<string, Held>;
let loads: string[];
let lang: { client: LangClient; schemas: SchemaCache };

/** Every schema load answers at once, except databases listed in `hold`, which wait for the test. */
function makeLang(hold: string[] = []) {
  held = new Map();
  loads = [];
  const client = new LangClient(() => fakeWorker());
  const load = (_id: string, database: string) =>
    new Promise<SqlSchema>((resolve, reject) => {
      loads.push(database);
      if (hold.includes(database)) held.set(database, { resolve, reject });
      else resolve(database === "archive" ? ARCHIVE : SHOP);
    });
  lang = { client, schemas: new SchemaCache(client, load) };
}

function previewFor(query: VisualQuery): VqPreview {
  const [o, s] = query.tables;
  // Item 37: nothing ticked selects every column.
  const select = query.columns.length === 0 ? (query.tables.length === 1 ? "*" : query.tables.map((t) => `${t.alias}.*`).join(", ")) : query.columns.map((c) => `${o.alias}.${c.column}`).join(", ");
  const lines = [`SELECT ${select}`, `FROM ${o.name} ${o.alias}`];
  const parts: SqlPart[] = [
    { part: { kind: "select" }, fromLine: 1, toLine: 1 },
    { part: { kind: "from", table: o.id }, fromLine: 2, toLine: 2 },
  ];
  if (s && query.joins[0]) {
    lines.push(`JOIN ${s.name} ${s.alias} ON ${s.alias}.id = ${o.alias}.store_id`);
    parts.push({ part: { kind: "join", join: query.joins[0].id }, fromLine: 3, toLine: 3 });
  }
  return { query: { sql: lines.join("\n"), parts, outputs: query.columns.map((c) => c.column), warnings: [] }, problems: [] };
}

beforeEach(() => {
  makeLang();
  routeInvoke({ visual_query_sql: ({ query }) => previewFor(query as VisualQuery) });
});

const card = (id: string, name: string, alias: string, x = 0, schema: string | null = null) => ({ id, schema, name, alias, x, y: 0 });
const docWith = (over: Partial<VisualQuery> = {}, doc: Partial<VisualTabDoc> = {}): VisualTabDoc => ({
  id: "v1",
  name: "New Visual Query",
  connectionId: "c1",
  database: "shop",
  model: { ...emptyQuery("shop", "mysql"), ...over },
  savedId: null,
  savedJson: null,
  ...doc,
});

function Harness({ initial, ...props }: { initial: VisualTabDoc } & Partial<VisualQueryTabProps>) {
  const [doc, setDoc] = useState(initial);
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
          rowEstimate={() => null}
          onOpenInEditor={() => {}}
          onSaved={() => {}}
          onOpenConnection={() => {}}
          {...props}
          onChange={(d) => {
            setDoc(d);
            props.onChange?.(d);
          }}
        />
      </div>
    </ToastProvider>
  );
}

const cardEl = (label: string) => screen.findByRole("group", { name: label });
const strip = () => screen.getByRole("toolbar", { name: "Visual Query" });
const canvas = () => document.querySelector(".diagram-canvas") as HTMLElement;
const dropOf = (object: unknown) => ({
  dataTransfer: {
    types: ["application/x-contura-object"],
    getData: (t: string) => (t === "application/x-contura-object" ? JSON.stringify(object) : ""),
    dropEffect: "none",
  },
  clientX: 300,
  clientY: 200,
});
/** Drops a table of `database` from the tree onto the canvas (item 35: the only way to add one). */
const dropTable = (name: string, database = "shop") =>
  fireEvent.drop(canvas(), dropOf({ connectionId: "c1", kind: "table", path: { database, schema: null, name } }));

test("empty_state_explains_and_runs_nothing", async () => {
  render(<Harness initial={docWith()} />);
  expect(await screen.findByText("Add tables to start")).toBeTruthy();
  // Item 35: drag only; no finder in place.
  expect(screen.getByText("Drag tables from the tree onto the canvas. To find one, filter the tree. Joins fill in from Foreign Keys.")).toBeTruthy();
  expect(screen.queryByRole("searchbox", { name: "Find a table" })).toBeNull();
  // Item 37: nothing ticked means every column.
  expect(screen.getByText("All columns.")).toBeTruthy();
  expect(screen.getByText("Tick columns to choose them.")).toBeTruthy();
  // Said once: the Columns tab says what to do; the SQL tab only says when it will show.
  expect(screen.queryByText("Tick at least one column.")).toBeNull();
  expect((within(strip()).getByRole("button", { name: /^Run/ }) as HTMLButtonElement).disabled).toBe(true);
  await showSql();
  expect(screen.getByText("The SQL appears here once a table is on the canvas.")).toBeTruthy();
  expect((screen.getByRole("button", { name: /^Open in editor/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(strip()).getByText("No tables")).toBeTruthy();
  // Nothing to preview yet.
  expect(callsTo("visual_query_sql")).toEqual([]);
});

test("item_35_tables_come_only_by_dragging_no_finder_no_add_table_no_ctrl_shift_a", async () => {
  render(<Harness initial={docWith()} />);
  await screen.findByText("Add tables to start");
  expect(within(strip()).queryByRole("button", { name: /Add table/ })).toBeNull();
  expect(screen.queryByRole("searchbox", { name: "Find a table" })).toBeNull();
  dropTable("orders");
  expect(await cardEl("Table orders o")).toBeTruthy();
  expect(screen.queryByText("Add tables to start")).toBeNull();
  // Ctrl+Shift+A opens nothing.
  (document.querySelector(".diagram-canvas") as HTMLElement).focus();
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  expect(screen.queryByRole("dialog", { name: "Add table" })).toBeNull();
  expect(screen.queryByRole("searchbox", { name: "Find a table" })).toBeNull();
  // The canvas menu has no Add table either.
  fireEvent.contextMenu(document.querySelector(".react-flow__pane") as HTMLElement, { clientX: 500, clientY: 300 });
  const menu = await screen.findByRole("menu", { name: "Canvas actions" });
  expect(within(menu).queryByRole("menuitem", { name: /Add table/ })).toBeNull();
});

test("a_table_dropped_from_another_database_loads_that_schema", async () => {
  render(<Harness initial={docWith()} databases={["shop", "archive", "mysql", "information_schema"]} />);
  await screen.findByText("Add tables to start");
  // Nothing beyond the tab's database loads until a card names it.
  expect(loads.filter((d) => d !== "shop")).toEqual([]);
  dropTable("old_orders", "archive");
  const archived = await cardEl("Table old_orders oo");
  expect(await within(archived).findByRole("checkbox", { name: "oo.id" })).toBeTruthy();
  expect(loads.filter((d) => d !== "shop")).toEqual(["archive"]);
});

test("a_failed_schema_load_says_so_with_try_again_and_never_loads_forever", async () => {
  makeLang(["archive"]);
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o"), card("t2", "old_orders", "oo", 300, "archive")] })} />);
  const archived = await cardEl("Table old_orders oo");
  await within(archived).findByText("Loading schema");
  await act(async () => held.get("archive")!.reject({ kind: "connect", message: "gone" }));
  expect(await within(archived).findByText("Schema did not load.")).toBeTruthy();
  expect(within(archived).queryByText("Loading schema")).toBeNull();
  await userEvent.click(within(archived).getByRole("button", { name: "Try again" }));
  await act(async () => held.get("archive")!.resolve(ARCHIVE));
  expect(await within(archived).findByRole("checkbox", { name: "oo.id" })).toBeTruthy();
  expect(within(archived).queryByText("Schema did not load.")).toBeNull();
  expect(loads.filter((d) => d === "archive")).toHaveLength(2);
});

test("a_closed_connection_says_so_on_the_cards_not_loading", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")] })} open={false} />);
  const orders = await cardEl("Table orders o");
  // V8: the canvas banner says it once; the card carries no line of its own.
  expect(screen.getByText("kestrel-main is not open", { selector: ".vq-banner p" })).toBeTruthy();
  expect(within(orders).queryByText("kestrel-main is not open")).toBeNull();
  expect(within(orders).queryByText("Loading schema")).toBeNull();
  expect(loads).toEqual([]);
});

test("a_column_row_is_one_tab_stop", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")] })} />);
  const box = await screen.findByRole("checkbox", { name: "o.id" });
  expect(box.tabIndex).toBe(-1);
  expect(box.closest("li")!.tabIndex).toBe(0);
});

test("warnings_read_one_way_and_count_columns", () => {
  expect(pairsSentence("orders", "menu_items")).toBe("every order pairs with every menu item");
  expect(pairsSentence("orders", "data")).toBe("every row of orders pairs with every row of data");
  const model = { ...emptyQuery("shop", "mysql"), tables: [card("t1", "orders", "o"), card("t2", "stores", "s")] };
  const preview = (columns: string[]): VqPreview => ({
    query: { sql: "", parts: [], outputs: [], warnings: [{ kind: "leftOut", table: "t2", columns }] },
    problems: [],
  });
  expect(warningLines(preview(["name"]), model)).toEqual(["name of stores is left out with it."]);
  expect(warningLines(preview(["name", "city"]), model)).toEqual(["name and city of stores are left out with it."]);
  // Item 37: with nothing ticked the whole table is left out.
  expect(warningLines(preview([]), model)).toEqual(["stores is left out with it."]);
});

test("a_join_line_belongs_to_the_card_it_brings_in_even_after_a_swap", () => {
  // stores is the root; the Left Join from orders to stores is reached from its right side, so the Core writes it swapped.
  const model = {
    ...emptyQuery("shop", "mysql"),
    tables: [card("t2", "stores", "s"), card("t1", "orders", "o")],
    joins: [{ id: "j1", left: "t1", right: "t2", kind: "left" as const, on: [{ leftColumn: "store_id", rightColumn: "id" }] }],
  };
  const parts: SqlPart[] = [
    { part: { kind: "select" }, fromLine: 1, toLine: 1 },
    { part: { kind: "join", join: "j1" }, fromLine: 3, toLine: 3 },
    { part: { kind: "from", table: "t2" }, fromLine: 2, toLine: 2 },
  ];
  expect([...joinBrings(parts, model)]).toEqual([["j1", "t1"]]);
});

test("adding_stores_after_orders_joins_them_and_says_so_once", async () => {
  render(<Harness initial={docWith()} />);
  await screen.findByText("Add tables to start");
  dropTable("orders");
  const orders = await cardEl("Table orders o");
  await within(orders).findByRole("checkbox", { name: "o.store_id" });
  dropTable("stores");
  expect(await cardEl("Table stores s")).toBeTruthy();
  expect(await screen.findByText("Joined stores to orders from their Foreign Keys.")).toBeTruthy();
  expect(screen.getAllByText("Joined stores to orders from their Foreign Keys.")).toHaveLength(1);
  expect(within(strip()).getByText("2 tables, 1 Join")).toBeTruthy();
});


test("a_tree_row_dropped_on_the_canvas_becomes_a_card_and_another_connection_is_refused", async () => {
  render(<Harness initial={docWith()} />);
  await screen.findByText("Add tables to start");
  fireEvent.drop(canvas(), dropOf({ connectionId: "c1", kind: "table", path: { database: "shop", schema: null, name: "stores" } }));
  expect(await cardEl("Table stores s")).toBeTruthy();
  fireEvent.drop(canvas(), dropOf({ connectionId: "c2", kind: "table", path: { database: "crm", schema: null, name: "people" } }));
  expect(await screen.findByText("Visual Queries use one Connection. Data Transfer copies between Connections.")).toBeTruthy();
  expect(screen.queryByRole("group", { name: /people/ })).toBeNull();
});

test("space_ticks_a_column_and_the_sql_follows_120ms_later", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")] })} />);
  const box = await screen.findByRole("checkbox", { name: "o.id" });
  // A preview of one table and no columns, with the types once the schema is in.
  await waitFor(() => expect(callsTo("visual_query_sql").some((c) => (c.types as Record<string, unknown>).t1)).toBe(true));
  expect(callsTo("visual_query_sql").slice(-1)[0]).toMatchObject({ id: "c1", types: { t1: { id: "int", store_id: "int" } } });
  const before = callsTo("visual_query_sql").length;
  const row = box.closest("li")!;
  row.focus();
  fireEvent.keyDown(row, { key: " ", code: "Space" });
  expect((box as HTMLInputElement).checked).toBe(true);
  // Not at once: the pane waits 120ms after the last change.
  expect(callsTo("visual_query_sql")).toHaveLength(before);
  const pane = await showSql();
  await waitFor(() => expect(within(pane).getByRole("group", { name: "Generated SQL" }).textContent).toContain("SELECT o.id"));
  expect(callsTo("visual_query_sql")).toHaveLength(before + 1);
  expect((callsTo("visual_query_sql")[before].query as VisualQuery).columns).toEqual([{ table: "t1", column: "id", alias: null, aggregate: null }]);
  // The panel lists it.
  await userEvent.click(screen.getByRole("tab", { name: /^Columns/ }));
  expect(within(screen.getByRole("tabpanel", { name: /Columns/ })).getByText("o.id")).toBeTruthy();
});

test("a_lone_card_says_it_runs_as_a_cross_join", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o"), card("t2", "menu_items", "mi", 300)] })} />);
  const lone = await cardEl("Table menu_items mi");
  expect(await within(lone).findByText("No Join. Runs as a CROSS JOIN.")).toBeTruthy();
  expect(lone.className).toContain("card-warning");
  expect(lone.className).toContain("card-dashed");
  const root = await cardEl("Table orders o");
  expect(within(root).queryByText("No Join. Runs as a CROSS JOIN.")).toBeNull();
});

test("card_shows_loading_schema", async () => {
  makeLang(["archive"]);
  render(
    <Harness
      initial={docWith({
        tables: [card("t1", "orders", "o"), card("t2", "old_orders", "oo", 300, "archive"), card("t3", "gone", "g", 600)],
      })}
    />,
  );
  // The other database is still loading: the card waits, it is not missing.
  const archived = await cardEl("Table old_orders oo");
  expect(await within(archived).findByText("Loading schema")).toBeTruthy();
  expect(archived.className).not.toContain("card-danger");
  // A card the loaded database lacks is missing.
  const gone = await cardEl("Table gone g");
  expect(await within(gone).findByText("Not found in shop")).toBeTruthy();
  expect(gone.className).toContain("card-danger");
  await act(async () => held.get("archive")!.resolve(ARCHIVE));
  await waitFor(() => expect(within(archived).queryByText("Loading schema")).toBeNull());
  expect(within(archived).getByRole("checkbox", { name: "oo.id" })).toBeTruthy();
});

test("over_twelve_columns_a_card_shows_ticked_and_key_columns_and_the_rest_on_request", async () => {
  render(
    <Harness
      initial={docWith({ tables: [card("t1", "wide", "w")], columns: [{ table: "t1", column: "c3", alias: null, aggregate: null }] })}
    />,
  );
  const wide = await cardEl("Table wide w");
  await within(wide).findByRole("checkbox", { name: "w.id" });
  expect(within(wide).getAllByRole("checkbox").map((b) => b.getAttribute("aria-label"))).toEqual(["w.id", "w.c3"]);
  await userEvent.click(within(wide).getByRole("button", { name: "13 more columns" }));
  expect(within(wide).getAllByRole("checkbox")).toHaveLength(15);
});

test("a_selected_card_bands_its_lines_and_a_banded_line_selects_its_card", async () => {
  const join = { id: "j1", left: "t1", right: "t2", kind: "inner" as const, on: [{ leftColumn: "store_id", rightColumn: "id" }] };
  render(
    <Harness
      initial={docWith({
        tables: [card("t1", "orders", "o"), card("t2", "stores", "s", 300)],
        joins: [join],
        columns: [{ table: "t1", column: "id", alias: null, aggregate: null }],
      })}
    />,
  );
  const pane = await showSql();
  await waitFor(() => expect(pane.textContent).toContain("JOIN stores s"));
  const lines = () => [...pane.querySelectorAll(".sql-block-line")];
  const node = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
  fireEvent.click(node("t2"));
  await waitFor(() => expect(lines()[2].className).toContain("sql-block-line-select"));
  expect(lines()[1].className).not.toContain("sql-block-line-select");
  fireEvent.click(node("t1"));
  await waitFor(() => expect(lines()[1].className).toContain("sql-block-line-select"));
  expect(lines()[2].className).not.toContain("sql-block-line-select");
  // Clicking the Join line selects the card it brings in.
  fireEvent.click(lines()[2]);
  await waitFor(() => expect(node("t2").className).toContain("selected"));
  expect(node("t1").className).not.toContain("selected");
});

test("production_washes_the_canvas_the_panel_and_the_sql_pane", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")] })} connection={{ ...kestrel, production: true }} />);
  await cardEl("Table orders o");
  const washed = [...document.querySelectorAll(".prod-wash")];
  expect(washed.map((el) => el.getAttribute("data-part"))).toEqual(["canvas", "panel"]);
  // The SQL tab draws its own surface over the panel, so it carries the wash itself.
  const pane = await showSql();
  expect(pane.getAttribute("data-part")).toBe("sql");
  expect(pane.className).toContain("prod-wash");
});

test("a_removed_connection_is_said_and_one_of_the_same_dialect_can_take_over", async () => {
  const pg = { ...kestrel, id: "c3", name: "pg-main", dialect: "postgres" as const };
  const other = { ...kestrel, id: "c2", name: "kestrel-replica" };
  const changes: VisualTabDoc[] = [];
  function Rebind() {
    const [doc, setDoc] = useState(docWith({ tables: [card("t1", "orders", "o")] }, { connectionId: null }));
    return (
      <ToastProvider>
        <VisualQueryTab
          doc={doc}
          connection={doc.connectionId === "c2" ? other : null}
          connections={[pg, other]}
          open={false}
          group={null}
          visible
          lang={lang}
          rowEstimate={() => null}
          onChange={(d) => {
            changes.push(d);
            setDoc(d);
          }}
          onOpenInEditor={() => {}}
          onSaved={() => {}}
          onOpenConnection={() => {}}
        />
      </ToastProvider>
    );
  }
  render(<Rebind />);
  expect(await screen.findByText("This Visual Query's Connection was removed.")).toBeTruthy();
  await userEvent.click(screen.getByRole("combobox", { name: "Connection" }));
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["kestrel-replica"]);
  await userEvent.click(screen.getByRole("option", { name: "kestrel-replica" }));
  await userEvent.click(screen.getByRole("button", { name: "Open here" }));
  await waitFor(() => expect(changes[changes.length - 1]?.connectionId).toBe("c2"));
  await waitFor(() => expect(screen.queryByText("This Visual Query's Connection was removed.")).toBeNull());
});

test("delete_inside_a_cards_more_menu_does_not_remove_the_card", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o"), card("t2", "stores", "s", 300)] })} />);
  const stores = await cardEl("Table stores s");
  await userEvent.click(within(stores).getByRole("button", { name: "More for stores" }));
  const item = await screen.findByRole("menuitem", { name: "Start the query from stores" });
  fireEvent.keyDown(item, { key: "Delete" });
  expect(screen.getByRole("group", { name: "Table stores s" })).toBeTruthy();
  // Delete on the card itself still removes it.
  fireEvent.keyDown(screen.getByRole("group", { name: "Table orders o" }), { key: "Delete" });
  await waitFor(() => expect(screen.queryByRole("group", { name: "Table orders o" })).toBeNull());
});

test("a_card_counts_a_note_row_only_for_a_note_it_draws", () => {
  const base: QueryCardData = {
    table: card("t1", "orders", "o"),
    kind: "table",
    columns: [{ name: "id", type: "int", pk: true }],
    ticked: {},
    joined: [],
    state: "ok",
    lone: false,
    home: "shop",
    problems: [],
    expanded: false,
    root: true,
  };
  const plain = queryCardHeight(base);
  // A loading card says so in a header chip, and a closed one in the banner: no note row.
  expect(queryCardHeight({ ...base, state: "loading" })).toBe(plain);
  expect(queryCardHeight({ ...base, state: "closed" })).toBe(plain);
  expect(queryCardHeight({ ...base, state: "missing" })).toBeGreaterThan(plain);
  expect(queryCardHeight({ ...base, state: "failed" })).toBeGreaterThan(plain);
  expect(queryCardHeight({ ...base, lone: true })).toBeGreaterThan(plain);
});

test("item_27_28_the_card_menu_explains_its_rows_and_closes_on_escape_or_a_press_outside", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o"), card("t2", "stores", "s", 300)] })} />);
  const orders = await cardEl("Table orders o");
  // The first card is the root: its row is off and says why; nothing in the menu holds focus.
  await userEvent.click(within(orders).getByRole("button", { name: "More for orders" }));
  const root = await screen.findByRole("menuitem", { name: "Start the query from orders" });
  expect(root).toHaveProperty("disabled", true);
  expect(root.textContent).toContain("It is first after FROM already.");
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu", { name: "orders actions" })).toBeNull());
  // A press on the canvas closes it too.
  const stores = await cardEl("Table stores s");
  await userEvent.click(within(stores).getByRole("button", { name: "More for stores" }));
  const start = await screen.findByRole("menuitem", { name: "Start the query from stores" });
  expect(start.textContent).toContain("Puts it first after FROM. The Joins follow from it.");
  fireEvent.pointerDown(document.querySelector(".react-flow__pane") ?? document.body);
  await waitFor(() => expect(screen.queryByRole("menu", { name: "stores actions" })).toBeNull());
});

test("item_26_27_right_click_on_a_card_opens_its_menu_and_tick_every_column_ticks_them", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "stores", "s")] })} />);
  const stores = await cardEl("Table stores s");
  const box = (c: string) => within(stores).getByRole("checkbox", { name: `s.${c}` }) as HTMLInputElement;
  await waitFor(() => expect(box("city")).toBeTruthy());
  fireEvent.contextMenu(stores, { clientX: 40, clientY: 50 });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Tick every column" }));
  await waitFor(() => expect(["id", "name", "city"].map((c) => box(c).checked)).toEqual([true, true, true]));
  fireEvent.contextMenu(stores, { clientX: 40, clientY: 50 });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Untick every column" }));
  await waitFor(() => expect(["id", "name", "city"].map((c) => box(c).checked)).toEqual([false, false, false]));
});

test("item_25_41_the_selected_card_resizes_from_its_edges_and_corners_and_keeps_its_size", async () => {
  const changes: VisualTabDoc[] = [];
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")] })} onChange={(d) => changes.push(d)} />);
  const orders = await cardEl("Table orders o");
  fireEvent.click(document.querySelector('.react-flow__node[data-id="t1"]') as HTMLElement);
  // Board B2: eight pointer zones, no square handles.
  const se = await waitFor(() => {
    expect(orders.querySelectorAll(".rz-zone")).toHaveLength(8);
    return orders.querySelector('.rz-zone[data-dir="se"]') as HTMLElement;
  });
  expect(orders.querySelector(".selbox i")).toBeNull();
  // Four columns: 136 px when every row shows.
  await waitFor(() => expect(within(orders).getAllByRole("checkbox")).toHaveLength(4));
  fireEvent.pointerDown(se, { button: 0, clientX: 100, clientY: 300, pointerId: 1 });
  fireEvent.pointerMove(se, { clientX: 160, clientY: 260, pointerId: 1 });
  // Live: the node takes the box on the next frame.
  const wrap = document.querySelector('.react-flow__node[data-id="t1"]') as HTMLElement;
  await waitFor(() => expect(wrap.classList.contains("is-resizing")).toBe(true));
  fireEvent.pointerUp(se, { clientX: 160, clientY: 260, pointerId: 1 });
  await waitFor(() => expect(changes[changes.length - 1]?.widths).toEqual({ t1: 276 }));
  expect(changes[changes.length - 1].heights).toEqual({ t1: 96 });
  // A shorter card scrolls its rows inside; the wheel scrolls them, not the canvas.
  const drawn = await cardEl("Table orders o");
  await waitFor(() => expect(drawn.style.height).toBe("96px"));
  expect(drawn.style.width).toBe("276px");
  expect(drawn.classList.contains("table-card-scroll")).toBe(true);
  expect(drawn.querySelector("ul.table-card-columns")!.classList.contains("nowheel")).toBe(true);
});

test("item_41_card_limits_two_rows_to_every_row_and_216_to_340_wide", async () => {
  const changes: VisualTabDoc[] = [];
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")] })} onChange={(d) => changes.push(d)} />);
  const orders = await cardEl("Table orders o");
  await waitFor(() => expect(within(orders).getAllByRole("checkbox")).toHaveLength(4));
  fireEvent.click(document.querySelector('.react-flow__node[data-id="t1"]') as HTMLElement);
  const zone = (d: string) => document.querySelector(`.react-flow__node[data-id="t1"] .rz-zone[data-dir="${d}"]`) as HTMLElement;
  await waitFor(() => expect(zone("se")).toBeTruthy());
  const drag = async (d: string, dx: number, dy: number) => {
    fireEvent.pointerDown(zone(d), { button: 0, clientX: 500, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(zone(d), { clientX: 500 + dx, clientY: 500 + dy, pointerId: 1 });
    fireEvent.pointerUp(zone(d), { clientX: 500 + dx, clientY: 500 + dy, pointerId: 1 });
    await waitFor(() => expect(changes.length).toBeGreaterThan(0));
  };
  // Smallest: 216 wide, two rows high (32 + 2 x 24 + 8).
  await drag("se", -900, -900);
  await waitFor(() => expect(changes[changes.length - 1].heights).toEqual({ t1: 88 }));
  expect(changes[changes.length - 1].widths).toEqual({ t1: 216 });
  // Largest: 340 wide, every row: a card as tall as its rows keeps no height of its own.
  await waitFor(() => expect(zone("se")).toBeTruthy());
  await drag("se", 900, 900);
  await waitFor(() => expect(changes[changes.length - 1].widths).toEqual({ t1: 340 }));
  expect(changes[changes.length - 1].heights ?? {}).toEqual({});
});

test("item_41_a_card_with_many_columns_draws_only_its_visible_rows_and_keeps_joined_ones", async () => {
  const many = ["id", ...Array.from({ length: 119 }, (_, i) => `c${i + 1}`)];
  makeLang();
  const HUGE: SqlSchema = { ...SHOP, tables: [...SHOP.tables, { schema: null, name: "huge", kind: "table", columns: many.map((c, i) => col(c, "int", i === 0)) }] };
  const client = new LangClient(() => fakeWorker());
  lang = { client, schemas: new SchemaCache(client, () => Promise.resolve(HUGE)) };
  render(
    <Harness
      initial={docWith(
        {
          tables: [card("t1", "huge", "h"), card("t2", "stores", "s", 400)],
          joins: [{ id: "j1", left: "t1", right: "t2", kind: "inner", on: [{ leftColumn: "c100", rightColumn: "id" }] }],
        },
        { heights: { t1: 200 } },
      )}
    />,
  );
  const huge = await cardEl("Table huge h");
  // Expanded, its 120 columns scroll in 200 px.
  await userEvent.click(await within(huge).findByRole("button", { name: /more columns/ }));
  await waitFor(() => expect(huge.classList.contains("table-card-scroll")).toBe(true));
  const rows = () => [...huge.querySelectorAll<HTMLElement>("li.vq-card-row")].map((r) => r.dataset.column);
  await waitFor(() => expect(rows().length).toBeLessThan(30));
  // The joined column keeps its row (and its port), far below the visible ones.
  expect(rows()).toContain("c100");
  expect(rows()).toContain("id");
  // Spacers keep every row at its place.
  const gaps = [...huge.querySelectorAll<HTMLElement>("li.vq-card-gap")].reduce((n, g) => n + parseFloat(g.style.height), 0);
  expect(gaps + rows().length * 24).toBe(120 * 24);
});

test("item_41_a_join_to_a_scrolled_out_column_goes_to_the_card_edge", () => {
  // Rows show between 33 px and 195 px down a 200 px card at y 100.
  expect(rowAnchor(160, 100, 200)).toEqual({ y: 160, out: false });
  expect(rowAnchor(120, 100, 200)).toEqual({ y: 133, out: true });
  expect(rowAnchor(400, 100, 200)).toEqual({ y: 295, out: true });
});

test("item_41_drafts_keep_card_heights", () => {
  const doc = docWith({ tables: [card("t1", "orders", "o")] }, { widths: { t1: 276 }, heights: { t1: 120, bad: Number.NaN as unknown as number } });
  const back = parseVisualDrafts(JSON.stringify({ version: 1, visual: [doc] }));
  expect(back[0].widths).toEqual({ t1: 276 });
  expect(back[0].heights).toEqual({ t1: 120 });
});

test("item_32_a_card_is_wide_enough_for_its_names_and_ticking_writes_no_output_name", async () => {
  const base = { columns: [{ name: "id", type: "int", pk: true }], home: "shop" };
  expect(fitWidth({ ...base, table: card("t1", "orders", "o") })).toBe(216);
  const long = fitWidth({ ...base, table: { ...card("t1", "blog_images_archive", "bia"), schema: "jrp-cms" } });
  expect(long).toBeGreaterThan(216);
  expect(long).toBeLessThanOrEqual(480);

  const changes: VisualTabDoc[] = [];
  render(<Harness initial={docWith({ tables: [card("t1", "stores", "s")] })} onChange={(d) => changes.push(d)} />);
  const stores = await cardEl("Table stores s");
  await userEvent.click(await within(stores).findByRole("checkbox", { name: "s.city" }));
  await waitFor(() => expect(changes.length).toBeGreaterThan(0));
  expect(changes[changes.length - 1].model.columns).toEqual([{ table: "t1", column: "city", alias: null, aggregate: null }]);
});

test("item_26_right_click_on_the_canvas_opens_its_menu_without_paste_and_clear_can_be_undone", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o"), card("t2", "stores", "s", 300)] })} />);
  await cardEl("Table orders o");
  const pane = document.querySelector(".react-flow__pane") as HTMLElement;
  fireEvent.contextMenu(pane, { clientX: 500, clientY: 300 });
  const menu = await screen.findByRole("menu", { name: "Canvas actions" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual([
    "Select all",
    "Tidy",
    "Zoom to fit",
    "Show the SQL",
    "Open in editor",
    "Clear the canvas",
  ]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Clear the canvas" }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Table orders o" })).toBeNull());
  await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await cardEl("Table orders o")).toBeTruthy();
});

test("item_24_a_table_dragged_over_the_canvas_rings_it_and_dropping_adds_it", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")] })} />);
  await cardEl("Table orders o");
  const drop = dropOf({ connectionId: "c1", kind: "table", path: { database: "shop", schema: null, name: "stores" } });
  fireEvent.dragOver(canvas(), drop);
  expect(canvas().className).toContain("is-drop-target");
  fireEvent.drop(canvas(), drop);
  expect(canvas().className).not.toContain("is-drop-target");
  expect(await cardEl("Table stores s")).toBeTruthy();
});

test("item_37_with_nothing_ticked_the_sql_tab_says_the_real_problem", async () => {
  const grouped = "A grouped query needs ticked columns. Tick the ones to show.";
  routeInvoke({ visual_query_sql: () => ({ query: null, problems: [{ target: { kind: "columns" }, message: grouped }] }) });
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")], groupBy: { kind: "manual", columns: [{ table: "t1", column: "id" }] } })} />);
  await cardEl("Table orders o");
  const pane = await showSql();
  expect(await within(pane).findByText(grouped)).toBeTruthy();
  expect(within(pane).queryByText("The SQL appears here once a column is ticked.")).toBeNull();
});

// ---- Fix round 1 ----

/**
 * jsdom has no layout. React Flow finds a port from its box against the card's, so each port reports the box a
 * browser would give it: its row's middle, less how far the card's rows are scrolled.
 */
function layOutPorts() {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const row = this.classList.contains("react-flow__handle") ? this.closest<HTMLElement>("li.vq-card-row") : null;
    if (!row) return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} } as DOMRect;
    const list = row.parentElement!;
    const index = [...list.children].indexOf(row);
    const top = 37 + index * 24 + 12 - 4 - list.scrollTop;
    return { x: 0, y: top, left: 0, top, right: 8, bottom: top + 8, width: 8, height: 8, toJSON() {} } as DOMRect;
  };
  // A port is 8 px; a card is as tall as its own height says (the shared mock makes every box 800 x 600).
  const protoH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  const protoW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
  const sized = (el: HTMLElement, own: number) => {
    if (el.classList.contains("react-flow__handle")) return 8;
    const h = el.classList.contains("react-flow__node") ? parseFloat(el.querySelector<HTMLElement>(".table-card")?.style.height ?? "") : NaN;
    return Number.isFinite(h) ? h : own;
  };
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get(this: HTMLElement) { return sized(this, 600); } },
    offsetWidth: { configurable: true, get(this: HTMLElement) { return this.classList.contains("react-flow__handle") ? 8 : 800; } },
  });
  return () => {
    Element.prototype.getBoundingClientRect = original;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", protoH);
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", protoW);
  };
}

test("review_gaps_scrolling_a_short_card_moves_its_join_to_the_edge_dashed_on_a_ring", async () => {
  const restore = layOutPorts();
  try {
    // orders is two rows high; its join leaves from store_id, the second row.
    render(
      <Harness
        initial={docWith(
          {
            tables: [card("t1", "orders", "o"), card("t2", "stores", "s", 400)],
            joins: [{ id: "j1", left: "t1", right: "t2", kind: "inner", on: [{ leftColumn: "store_id", rightColumn: "id" }] }],
          },
          { heights: { t1: 88 } },
        )}
      />,
    );
    const orders = await cardEl("Table orders o");
    await waitFor(() => expect(orders.classList.contains("table-card-scroll")).toBe(true));
    const line = () => document.querySelector<SVGPathElement>(".vq-join-line");
    // In view: a solid line on a dot at both ends.
    await waitFor(() => expect(line()).not.toBeNull());
    await waitFor(() => expect(document.querySelectorAll(".vq-join-dot")).toHaveLength(2));
    expect(line()!.classList.contains("vq-join-out")).toBe(false);
    expect(document.querySelector(".vq-join-ring")).toBeNull();
    const before = line()!.getAttribute("d");
    // Scrolled out above: on the next frame the ports are found again; the line goes to the card's edge, dashed,
    // and ends on a hollow ring.
    const list = orders.querySelector<HTMLElement>("ul.table-card-columns")!;
    list.scrollTop = 48;
    fireEvent.scroll(list);
    await waitFor(() => expect(line()!.classList.contains("vq-join-out")).toBe(true));
    expect(document.querySelectorAll(".vq-join-ring")).toHaveLength(1);
    expect(document.querySelectorAll(".vq-join-dot")).toHaveLength(1);
    expect(line()!.getAttribute("d")).not.toBe(before);
    expect(list.classList.contains("is-scrolled")).toBe(true);
  } finally {
    restore();
  }
});

test("review_gaps_scrolling_a_long_card_moves_its_window_and_keeps_the_joined_row", async () => {
  const many = ["id", ...Array.from({ length: 119 }, (_, i) => `c${i + 1}`)];
  const HUGE: SqlSchema = { ...SHOP, tables: [...SHOP.tables, { schema: null, name: "huge", kind: "table", columns: many.map((c, i) => col(c, "int", i === 0)) }] };
  const client = new LangClient(() => fakeWorker());
  lang = { client, schemas: new SchemaCache(client, () => Promise.resolve(HUGE)) };
  render(
    <Harness
      initial={docWith(
        {
          tables: [card("t1", "huge", "h"), card("t2", "stores", "s", 400)],
          joins: [{ id: "j1", left: "t1", right: "t2", kind: "inner", on: [{ leftColumn: "c100", rightColumn: "id" }] }],
        },
        { heights: { t1: 200 } },
      )}
    />,
  );
  const huge = await cardEl("Table huge h");
  await userEvent.click(await within(huge).findByRole("button", { name: /more columns/ }));
  const rows = () => [...huge.querySelectorAll<HTMLElement>("li.vq-card-row")].map((r) => r.dataset.column);
  await waitFor(() => expect(rows()).toContain("c3"));
  const list = huge.querySelector<HTMLElement>("ul.table-card-columns")!;
  list.scrollTop = 60 * 24;
  fireEvent.scroll(list);
  // The window follows on the next frame: rows near c60 are drawn, the top ones are not.
  await waitFor(() => expect(rows()).toContain("c60"));
  expect(rows()).not.toContain("c3");
  expect(rows().length).toBeLessThan(30);
  // The joined row keeps its port, so its line stays.
  expect(rows()).toContain("c100");
  expect(huge.querySelector('li[data-column="c100"] .react-flow__handle[data-handleid="c100:s"]')).not.toBeNull();
  expect(document.querySelector(".vq-join-line")).not.toBeNull();
});

test("review_minor_5_a_removed_card_takes_its_kept_size_with_it", async () => {
  const changes: VisualTabDoc[] = [];
  render(
    <Harness
      initial={docWith({ tables: [card("t1", "orders", "o"), card("t2", "stores", "s", 400)] }, { widths: { t1: 300, t2: 260 }, heights: { t1: 100 } })}
      onChange={(d) => changes.push(d)}
    />,
  );
  const orders = await cardEl("Table orders o");
  await userEvent.click(within(orders).getByRole("button", { name: "Remove orders" }));
  await waitFor(() => expect(changes.length).toBeGreaterThan(0));
  const last = changes[changes.length - 1];
  expect(last.model.tables.map((t) => t.id)).toEqual(["t2"]);
  expect(last.widths).toEqual({ t2: 260 });
  expect(last.heights).toBeUndefined();
});
