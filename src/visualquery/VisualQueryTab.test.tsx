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
import Finder, { type FinderTable } from "./Finder";
import { emptyQuery } from "./model";
import { fitWidth, type QueryCardData, queryCardHeight } from "./QueryCard";
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
  if (query.columns.length === 0) return { query: null, problems: [{ target: { kind: "columns" }, message: "Tick at least one column." }] };
  const [o, s] = query.tables;
  const lines = [`SELECT ${query.columns.map((c) => `${o.alias}.${c.column}`).join(", ")}`, `FROM ${o.name} ${o.alias}`];
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

const cardEl = (label: string) => screen.findByRole("group", { name: label });
const strip = () => screen.getByRole("toolbar", { name: "Visual Query" });

test("empty_state_explains_and_runs_nothing", async () => {
  render(<Harness initial={docWith()} />);
  expect(await screen.findByText("Add tables to start")).toBeTruthy();
  expect(screen.getByText("Drag tables from the tree onto the canvas, or find one here. Joins fill in from Foreign Keys.")).toBeTruthy();
  // The finder sits in place, with its key.
  const finder = screen.getByRole("searchbox", { name: "Find a table" });
  expect(finder.closest(".vq-finder")?.querySelector(".kbd")?.textContent).toBe("Ctrl+Shift+A");
  expect(screen.getByText("Tick a column to start")).toBeTruthy();
  expect(screen.getByText("Tick columns on the cards above. They become the result, in the order you tick them.")).toBeTruthy();
  // Said once: the Columns tab says what to do; the SQL tab only says when it will show.
  expect(screen.queryByText("Tick at least one column.")).toBeNull();
  expect((within(strip()).getByRole("button", { name: /^Run/ }) as HTMLButtonElement).disabled).toBe(true);
  await showSql();
  expect(screen.getByText("The SQL appears here once a table is on the canvas.")).toBeTruthy();
  expect((screen.getByRole("button", { name: /^Open in editor/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(strip()).getByText("No tables")).toBeTruthy();
  expect(screen.getByText("Tables on other Connections are not listed. Data Transfer copies between Connections.")).toBeTruthy();
  // Nothing to preview yet.
  expect(callsTo("visual_query_sql")).toEqual([]);
});

test("the_finder_adds_with_down_and_enter_and_ctrl_shift_a_opens_it_over_the_canvas", async () => {
  render(<Harness initial={docWith()} />);
  const search = await screen.findByRole("searchbox", { name: "Find a table" });
  await screen.findByRole("option", { name: /orders/ });
  const names = within(screen.getByRole("listbox", { name: "Tables" }))
    .getAllByRole("option")
    .map((o) => o.querySelector(".vq-finder-name")?.textContent);
  expect(names).toEqual(["menu_items", "orders", "stores", "v_daily_sales", "wide"]);
  // A view says so where a table shows its rows.
  expect(within(screen.getByRole("option", { name: /v_daily_sales/ })).getByText("shop, view")).toBeTruthy();
  search.focus();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(await cardEl("Table orders o")).toBeTruthy();
  expect(screen.queryByText("Add tables to start")).toBeNull();
  // The empty state went with its finder: the canvas keeps the keys.
  expect(document.activeElement?.classList.contains("diagram-canvas")).toBe(true);

  // Ctrl+Shift+A opens the finder over the canvas; Esc closes it.
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const over = await screen.findByRole("dialog", { name: "Add table" });
  expect(document.body.contains(over)).toBe(true);
  expect(within(over).getByRole("searchbox", { name: "Find a table" })).toBe(document.activeElement);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add table" })).toBeNull());
  expect(document.activeElement?.classList.contains("diagram-canvas")).toBe(true);
});

test("a_hidden_tab_closes_its_floating_finder_and_enter_adds_nothing", async () => {
  const changes: VisualTabDoc[] = [];
  const doc = docWith({ tables: [card("t1", "orders", "o")] });
  const { rerender } = render(<Harness initial={doc} onChange={(d) => changes.push(d)} />);
  await cardEl("Table orders o");
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  await screen.findByRole("dialog", { name: "Add table" });
  // Ctrl+Tab to another tab: this one hides.
  rerender(<Harness initial={doc} onChange={(d) => changes.push(d)} visible={false} />);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add table" })).toBeNull());
  expect(document.querySelector(".vq-tab")?.contains(document.activeElement)).toBe(false);
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  expect(screen.queryByRole("dialog", { name: "Add table" })).toBeNull();
  expect(changes).toEqual([]);
});

test("the_finder_lists_every_database_the_connection_reaches", async () => {
  render(<Harness initial={docWith()} databases={["shop", "archive", "mysql", "information_schema"]} />);
  const row = await screen.findByRole("option", { name: /old_orders/ });
  expect(within(row).getByText("archive")).toBeTruthy();
  // MySQL's own databases are not loaded.
  expect(loads.filter((d) => d !== "shop" && d !== "archive")).toEqual([]);
  fireEvent.click(row);
  expect(await cardEl("Table old_orders oo")).toBeTruthy();
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
  const search = await screen.findByRole("searchbox", { name: "Find a table" });
  await screen.findByRole("option", { name: /orders/ });
  search.focus();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await cardEl("Table orders o");
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const over = await screen.findByRole("dialog", { name: "Add table" });
  await userEvent.type(within(over).getByRole("searchbox", { name: "Find a table" }), "stores{Enter}");
  expect(await cardEl("Table stores s")).toBeTruthy();
  expect(await screen.findByText("Joined stores to orders from their Foreign Keys.")).toBeTruthy();
  expect(screen.getAllByText("Joined stores to orders from their Foreign Keys.")).toHaveLength(1);
  expect(within(strip()).getByText("2 tables, 1 Join")).toBeTruthy();
});

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

test("a_tree_row_dropped_on_the_canvas_becomes_a_card_and_another_connection_is_refused", async () => {
  render(<Harness initial={docWith()} />);
  await screen.findByRole("option", { name: /orders/ });
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

test("the_finder_draws_only_the_rows_in_view_of_a_large_schema", async () => {
  const tables: FinderTable[] = Array.from({ length: 3000 }, (_, i) => ({
    schema: `db_${Math.floor(i / 100)}`,
    name: `table_${String(i).padStart(4, "0")}`,
    kind: "table",
    rows: i,
  }));
  const onAdd = vi.fn();
  render(<Finder inline tables={tables} onAdd={onAdd} onClose={() => {}} />);
  const list = screen.getByRole("listbox", { name: "Tables" });
  expect(within(list).getAllByRole("option").length).toBeLessThanOrEqual(40);
  // Keys still reach every row: Up wraps to the last, and Enter adds it.
  const search = screen.getByRole("searchbox", { name: "Find a table" });
  search.focus();
  await userEvent.keyboard("{ArrowUp}");
  const active = search.getAttribute("aria-activedescendant")!;
  expect(document.getElementById(active)?.textContent).toContain("table_2999");
  await userEvent.keyboard("{Enter}");
  expect(onAdd).toHaveBeenCalledWith(tables[2999]);
  expect(within(list).getAllByRole("option").length).toBeLessThanOrEqual(40);
  // A search narrows the rows to the matches.
  await userEvent.type(search, "table_1234");
  expect(within(list).getAllByRole("option").map((o) => o.querySelector(".vq-finder-name")?.textContent)).toEqual(["table_1234"]);
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

test("item_29_picking_a_table_closes_the_floating_finder_and_a_press_outside_closes_it", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")] })} />);
  await cardEl("Table orders o");
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const over = await screen.findByRole("dialog", { name: "Add table" });
  await userEvent.click(await within(over).findByRole("option", { name: /stores/ }));
  expect(await cardEl("Table stores s")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add table" })).toBeNull());
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  await screen.findByRole("dialog", { name: "Add table" });
  fireEvent.pointerDown(document.querySelector(".react-flow__pane") ?? document.body);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add table" })).toBeNull());
  // Escape closes it with focus anywhere.
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  await screen.findByRole("dialog", { name: "Add table" });
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add table" })).toBeNull());
});

test("item_25_the_selected_cards_corner_handles_drag_its_width", async () => {
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")] })} />);
  const orders = await cardEl("Table orders o");
  fireEvent.click(document.querySelector('.react-flow__node[data-id="t1"]') as HTMLElement);
  const se = await waitFor(() => {
    const h = orders.querySelector('.selbox i[data-corner="se"]');
    expect(h).toBeTruthy();
    return h as HTMLElement;
  });
  fireEvent.pointerDown(se, { button: 0, clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(se, { clientX: 160, pointerId: 1 });
  expect(orders.style.width).toBe("276px");
  fireEvent.pointerUp(se, { clientX: 160, pointerId: 1 });
  await waitFor(() => expect((screen.getByRole("group", { name: "Table orders o" }) as HTMLElement).style.width).toBe("276px"));
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
    "Add table...",
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
  // Add table... opens the finder.
  fireEvent.contextMenu(document.querySelector(".react-flow__pane") as HTMLElement, { clientX: 500, clientY: 300 });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Add table..." }));
  expect(await screen.findByRole("dialog", { name: "Add table" })).toBeTruthy();
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
