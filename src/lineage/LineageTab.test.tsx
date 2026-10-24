import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { FlowTableLink, Lineage, LineageLink, LineageTable, ObjectPath } from "../api/types";
import { setReducedMotionPref } from "../diagram/motion";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockReactFlowDom } from "../test/reactFlow";
import lineageCss from "../styles/lineage.css?raw";
import { layoutText } from "./layout";
import { tableId } from "./scene";
import LineageTab, { centerOn } from "./LineageTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/** How often each card's frame drew, by its label. */
const frameRenders = new Map<string, number>();
vi.mock("../diagram/CardFrame", async (load) => {
  const real = await load<typeof import("../diagram/CardFrame")>();
  return {
    ...real,
    default: (props: Parameters<typeof real.default>[0]) => {
      if (props.label) frameRenders.set(props.label, (frameRenders.get(props.label) ?? 0) + 1);
      return real.default(props);
    },
  };
});
const cleanupAll = () => cleanup();

beforeAll(() => {
  mockReactFlowDom();
});
beforeEach(() => {
  // No fit animation: the view settles at once.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => setReducedMotionPref(false));

const p = (name: string): ObjectPath => ({ database: "kestrel", schema: "shop", name });
const ORDERS = p("orders");
const col = (name: string, more: Partial<LineageTable["columns"][number]> = {}) => ({ name, ty: "bigint", pk: false, fk: false, nullable: false, ...more });
const table = (name: string, distance: number, columns = [col("id", { pk: true })], more: Partial<LineageTable> = {}): LineageTable => ({
  path: p(name),
  columns,
  columnCount: 6,
  distance,
  unreadable: null,
  ...more,
});
const link = (from: string, fromColumns: string[], to: string, more: Partial<LineageLink> = {}): LineageLink => ({
  from: p(from),
  fromColumns,
  to: p(to),
  toColumns: ["id"],
  onDelete: "RESTRICT",
  onUpdate: null,
  nullable: false,
  ...more,
});

const FULL: Lineage = {
  center: ORDERS,
  tables: [
    table("orders", 0, [col("id", { pk: true }), col("customer_id", { fk: true }), col("store_id", { fk: true, ty: "int", nullable: true })], { columnCount: 12 }),
    table("customers", -1),
    table("stores", -1),
    table("order_lines", 1, [col("order_id", { fk: true })]),
    table("shipments", 1, [col("order_id", { fk: true })]),
  ],
  links: [
    link("orders", ["customer_id"], "customers"),
    link("orders", ["store_id"], "stores", { onDelete: "SET NULL", nullable: true }),
    link("order_lines", ["order_id"], "orders", { onDelete: "CASCADE" }),
    link("shipments", ["order_id"], "orders", { onDelete: "NO ACTION" }),
  ],
  truncated: false,
};

const FLOWS: FlowTableLink[] = [
  { file: "checkout", node: "Orders", kind: "store", table: "shop.orders", access: "writes", processes: [] },
  { file: "fulfilment", node: "Orders", kind: "store", table: "orders", access: "reads", processes: [] },
  { file: "crm", node: "People", kind: "store", table: "shop.customers", access: "both", processes: [] },
];

const connection = { id: "c1", name: "kestrel-main", dialect: "postgres" as const };

function setup(handlers: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {}, props: Partial<Parameters<typeof LineageTab>[0]> = {}) {
  routeInvoke({
    lineage: () => FULL,
    list_flow_table_links: () => FLOWS,
    list_objects: () => [],
    object_definition: () => "",
    ...handlers,
  } as Record<string, (args: Record<string, unknown>) => unknown>);
  const calls = { openTable: vi.fn(), addKey: vi.fn(), openDiagram: vi.fn(), openView: vi.fn() };
  const utils = render(
    <div style={{ width: 1200, height: 700 }}>
      <LineageTab
        connection={connection}
        path={ORDERS}
        onOpenTable={calls.openTable}
        onAddForeignKey={calls.addKey}
        onOpenDiagram={calls.openDiagram}
        onOpenView={calls.openView}
        {...props}
      />
    </div>,
  );
  return { ...utils, calls };
}

const panel = () => screen.getByRole("complementary", { name: "What links do" });
const group = (name: string) => within(panel()).getByRole("region", { name });

test("panel_says_what_each_link_does", async () => {
  const { calls } = setup();
  const warning = await screen.findByRole("note", { name: "Before you delete an order" });
  expect(within(warning).getByText("A shipment stops the delete.")).toBeTruthy();
  expect(within(warning).getByText("Its order lines go with it.")).toBeTruthy();

  const uses = group("orders points to");
  expect(within(uses).getByText("2 tables")).toBeTruthy();
  const customer = within(uses).getByText("Every order needs a customer").closest("li")!;
  expect(within(customer).getByText("customer_id → customers.id")).toBeTruthy();
  expect(within(customer).getByText("Blocks")).toBeTruthy();
  const store = within(uses).getByText("An order can have no store").closest("li")!;
  expect(within(store).getByText("Info")).toBeTruthy();

  const usedBy = group("Points to orders");
  expect(within(usedBy).getByText("2 tables")).toBeTruthy();
  const lines = within(usedBy).getByText("Order lines go when their order goes").closest("li")!;
  expect(within(lines).getByText("order_lines.order_id")).toBeTruthy();
  expect(within(lines).getByText("Also deletes")).toBeTruthy();
  expect(within(within(usedBy).getByText("An order with shipments can't be deleted").closest("li")!).getByText("Blocks")).toBeTruthy();

  // Only the diagrams whose `table:` names this table.
  const diagrams = group("Diagrams");
  expect(within(diagrams).getByText("2")).toBeTruthy();
  const checkout = within(diagrams).getByText("Checkout writes orders").closest("li")!;
  expect(within(checkout).getByText("checkout.flow")).toBeTruthy();
  expect(within(diagrams).getByText("Fulfilment reads orders")).toBeTruthy();
  expect(within(diagrams).queryByText(/crm/i)).toBeNull();
  fireEvent.click(within(checkout).getByRole("button", { name: "Open checkout.flow" }));
  expect(calls.openDiagram).toHaveBeenCalledWith("checkout");

  // The canvas: every table as a card, with a ? after a type that can be empty.
  for (const n of ["orders", "customers", "stores", "order_lines", "shipments"]) expect(await screen.findByRole("group", { name: `Table ${n}` })).toBeTruthy();
  const center = screen.getByRole("group", { name: "Table orders" });
  expect(within(center).getByText("int ?")).toBeTruthy();
  expect(within(center).getByText("9 more columns")).toBeTruthy();
  await waitFor(() => expect(document.querySelectorAll(".react-flow__edge.lineage-edge")).toHaveLength(6));
  expect(lineageCalls()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "c1", path: ORDERS, depth: 1, direction: "both" }),
      // The warning's own read: everything using the table.
      expect.objectContaining({ id: "c1", path: ORDERS, depth: 0, direction: "usedBy" }),
    ]),
  );
});

test("warning_left_out_when_delete_changes_nothing", async () => {
  setup({ lineage: () => ({ ...FULL, tables: FULL.tables.slice(0, 3), links: FULL.links.slice(0, 2) }) });
  await screen.findByText("Every order needs a customer");
  expect(screen.queryByText(/Before you delete/)).toBeNull();
  expect(within(panel()).queryByRole("region", { name: "Points to orders" })).toBeNull();
});

test("hover_marks_the_edge_and_drive_row", async () => {
  setup();
  const row = (await screen.findByText("Every order needs a customer")).closest("li")!;
  await waitFor(() => expect(edge("link:0")).toBeTruthy());
  await screen.findByRole("group", { name: "Table orders" });
  const drive = () => within(screen.getByRole("group", { name: "Table orders" })).getByText("customer_id").closest("li")!;
  expect(edge("link:0")!.classList.contains("lineage-edge-hot")).toBe(false);
  fireEvent.mouseEnter(row);
  expect(row.classList.contains("lineage-row-hot")).toBe(true);
  await waitFor(() => expect(edge("link:0")!.classList.contains("lineage-edge-hot")).toBe(true));
  expect(drive().classList.contains("lineage-drive")).toBe(true);
  expect(edge("link:1")!.classList.contains("lineage-edge-hot")).toBe(false);
  fireEvent.mouseLeave(row);
  await waitFor(() => expect(edge("link:0")!.classList.contains("lineage-edge-hot")).toBe(false));
  expect(drive().classList.contains("lineage-drive")).toBe(false);

  // A diagram row marks its dashed line.
  fireEvent.mouseEnter(within(panel()).getByText("Checkout writes orders").closest("li")!);
  await waitFor(() => expect(edge("ref:0")!.classList.contains("lineage-edge-hot")).toBe(true));
});

test("depth_direction_and_source_switches_refetch", async () => {
  setup({
    lineage: (a) => ({ ...FULL, truncated: a.depth === 0 }),
    list_objects: () => [
      { kind: "view", name: "daily_orders", rows: null },
      { kind: "view", name: "stock_left", rows: null },
      { kind: "table", name: "orders", rows: 10 },
    ],
    list_schemas: () => [{ name: "shop", isSystem: false }],
    object_definition: (a) =>
      (a.path as ObjectPath).name === "daily_orders" ? "SELECT placed_at::date, count(*) FROM shop.orders GROUP BY 1" : "SELECT * FROM shop.stock",
  });
  await screen.findByText("Every order needs a customer");
  const depth = screen.getByRole("radiogroup", { name: "Depth" });
  fireEvent.click(within(depth).getByRole("radio", { name: "2" }));
  await waitFor(() => expect(lastLineage()).toMatchObject({ depth: 2, direction: "both" }));
  fireEvent.click(within(depth).getByRole("radio", { name: "All" }));
  await waitFor(() => expect(lastLineage()).toMatchObject({ depth: 0 }));
  expect(await screen.findByText("Reading stopped after 10s, so some tables are left out.")).toBeTruthy();

  const direction = screen.getByRole("radiogroup", { name: "Direction" });
  fireEvent.click(within(direction).getByRole("radio", { name: "Uses" }));
  await waitFor(() => expect(lastLineage()).toMatchObject({ depth: 0, direction: "uses" }));
  fireEvent.click(within(direction).getByRole("radio", { name: "Used by" }));
  await waitFor(() => expect(lastLineage()).toMatchObject({ direction: "usedBy" }));

  expect(callsTo("list_flow_table_links")).toHaveLength(1);
  const source = screen.getByRole("radiogroup", { name: "Source" });
  fireEvent.click(within(source).getByRole("radio", { name: "Views" }));
  const views = await within(panel()).findByRole("region", { name: "Views" });
  expect(callsTo("list_objects")[0]).toMatchObject({ id: "c1", database: "kestrel", schema: "shop" });
  expect(within(views).getByText("daily_orders names orders")).toBeTruthy();
  expect(within(views).queryByText(/stock_left/)).toBeNull();
  expect(within(panel()).queryByRole("region", { name: "Diagrams" })).toBeNull();
  fireEvent.click(within(source).getByRole("radio", { name: "Flows" }));
  await within(panel()).findByRole("region", { name: "Diagrams" });
  expect(callsTo("list_flow_table_links")).toHaveLength(2);
});

test("double_click_recentres_the_card_with_a_canvas_move", async () => {
  // The move itself: the card's middle, at the same zoom, over the canvas-move time.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  const setCenter = vi.fn(() => Promise.resolve(true));
  const flow = {
    getNode: () => ({ id: "n", position: { x: 100, y: 40 }, measured: { width: 214, height: 100 }, data: {} }),
    getZoom: () => 0.8,
    setCenter,
  };
  centerOn(flow as never, "n");
  expect(setCenter).toHaveBeenCalledWith(207, 90, { zoom: 0.8, duration: 240 });
  setReducedMotionPref(true);
  centerOn(flow as never, "n");
  expect(setCenter).toHaveBeenLastCalledWith(207, 90, { zoom: 0.8, duration: 0 });
  setReducedMotionPref(false);

  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  setup();
  const card = await screen.findByRole("group", { name: "Table shipments" });
  const viewport = () => (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
  await waitFor(() => expect(viewport()).not.toBe(""));
  const before = viewport();
  fireEvent.doubleClick(card);
  await waitFor(() => expect(viewport()).not.toBe(before));
});

test("loading_shows_the_table_in_place", async () => {
  setup({ lineage: () => new Promise(() => {}) });
  const loading = await screen.findByRole("status");
  expect(within(loading).getByText("Reading Foreign Keys in shop")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Table orders" })).toBeTruthy();
  expect(document.querySelectorAll(".lineage-skel")).toHaveLength(2);
});

test("nothing_linked_offers_a_key_and_the_table", async () => {
  const { calls } = setup({
    lineage: () => ({ ...FULL, tables: [FULL.tables[0]], links: [] }),
    list_flow_table_links: () => [],
  });
  expect(await screen.findByText("Nothing links to orders yet")).toBeTruthy();
  expect(screen.getByText("No Foreign Key points to or from it, and no diagram arrow reads or writes it.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add a Foreign Key" }));
  expect(calls.addKey).toHaveBeenCalledWith(ORDERS);
  fireEvent.click(screen.getByRole("button", { name: "Open orders" }));
  expect(calls.openTable).toHaveBeenCalledWith(ORDERS);
});

test("could_not_read_shows_the_server_text_with_copy_and_retry", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  let fail = true;
  setup({
    lineage: () => {
      if (fail) throw { kind: "query", message: "permission denied for table pg_constraint" };
      return FULL;
    },
  });
  const notice = await screen.findByRole("alert");
  expect(within(notice).getByText("Can't read the keys in shop")).toBeTruthy();
  expect(
    within(notice).getByText("Your account isn't allowed to read key details here. Ask the database owner for access, then try again."),
  ).toBeTruthy();
  const raw = within(notice).getByRole("group", { name: "From the database" });
  expect(within(raw).getByText("permission denied for table pg_constraint")).toBeTruthy();
  const copy = within(raw).getByRole("button", { name: "Copy error" });
  expect(copy.getAttribute("title")).toBe("Copy error");
  fireEvent.click(copy);
  expect(writeText).toHaveBeenCalledWith("permission denied for table pg_constraint");

  const retry = within(notice).getByRole("button", { name: "Try again" });
  expect(retry.getAttribute("title")).toBe("Try again");
  fail = false;
  await act(async () => fireEvent.click(retry));
  expect(await screen.findByText("Every order needs a customer")).toBeTruthy();
  // The drawing and the warning each read once, and again on Try again.
  expect(lineageCalls()).toHaveLength(4);
});

test("other_errors_keep_the_layout_with_their_own_sentence", async () => {
  setup({
    lineage: () => {
      throw { kind: "timedOut", message: 10 };
    },
  });
  const notice = await screen.findByRole("alert");
  expect(within(notice).getByText("Can't read the keys in shop")).toBeTruthy();
  expect(within(notice).queryByText(/isn't allowed/)).toBeNull();
  expect(within(notice).getByText("Reading the keys took longer than Contura's 10s limit. Try a smaller depth, then try again.")).toBeTruthy();
  // Not the database's words, and not the Connection's timeout.
  expect(within(within(notice).getByRole("group", { name: "From the database" })).getByText("Contura stops reading keys after 10s.")).toBeTruthy();
  expect(within(notice).getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("an_unreadable_neighbour_keeps_its_card_with_the_reason", async () => {
  setup({
    lineage: () => ({
      ...FULL,
      tables: FULL.tables.map((t) => (t.path.name === "stores" ? { ...t, columnCount: 0, unreadable: "Contura can't find this table." } : t)),
    }),
  });
  const card = await screen.findByRole("group", { name: "Table stores" });
  expect(within(card).getByText("Contura can't find this table.")).toBeTruthy();
});

const lineageCalls = () => callsTo("lineage");
const lastLineage = () => lineageCalls()[lineageCalls().length - 1];
const edge = (id: string) => document.querySelector(`.react-flow__edge[data-id="${id}"]`);

test("the_stylesheet_uses_tokens_only", () => {
  const text = lineageCss.replace(/\/\*[\s\S]*?\*\//g, "");
  expect(text).toMatch(/\.lineage-panel\s*\{[^}]*width: 344px/);
  expect(text).toMatch(/var\(--c-warning-subtle\)/);
  // No literal colours (ADR 0008) and no timings: nothing on this tab animates outside motion.ts.
  expect(text).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
  expect(text).not.toMatch(/\b\d+(?:\.\d+)?m?s\b|transition|animation/);
});

// ---- Fix round 1 (P14) ----

const isEffects = (a: Record<string, unknown>) => a.depth === 0 && a.direction === "usedBy";

/** Everything using orders: order_lines cascade, and a refund on an order line stops the delete. */
const EFFECTS: Lineage = {
  center: ORDERS,
  tables: [FULL.tables[0], FULL.tables[3], table("refunds", 2, [col("line_id", { fk: true })])],
  links: [link("order_lines", ["order_id"], "orders", { onDelete: "CASCADE" }), link("refunds", ["line_id"], "order_lines")],
  truncated: false,
};

test("the_warning_comes_from_its_own_read_of_everything_using_the_table", async () => {
  setup({
    lineage: (a) =>
      isEffects(a) ? EFFECTS : a.direction === "uses" ? { ...FULL, tables: FULL.tables.slice(0, 3), links: FULL.links.slice(0, 2) } : FULL,
  });
  const warning = await screen.findByRole("note", { name: "Before you delete an order" });
  // Two steps out, though the drawing shows one.
  expect(within(warning).getByText("A refund on its order lines stops the delete.")).toBeTruthy();
  expect(within(warning).getByText("Its order lines go with it.")).toBeTruthy();
  const direction = screen.getByRole("radiogroup", { name: "Direction" });
  fireEvent.click(within(direction).getByRole("radio", { name: "Uses" }));
  await waitFor(() => expect(lastLineage()).toMatchObject({ direction: "uses" }));
  await waitFor(() => expect(within(panel()).queryByRole("region", { name: "Points to orders" })).toBeNull());
  // The toolbar changes the drawing, not the warning.
  expect(within(screen.getByRole("note", { name: "Before you delete an order" })).getByText("A refund on its order lines stops the delete.")).toBeTruthy();
  expect(lineageCalls().filter(isEffects)).toHaveLength(1);
});

test("the_warning_says_when_it_may_be_incomplete", async () => {
  setup({ lineage: (a) => (isEffects(a) ? { ...EFFECTS, truncated: true } : FULL) });
  const warning = await screen.findByRole("note", { name: "Before you delete an order" });
  expect(await within(warning).findByText("This list may be incomplete: reading stopped at Contura's 10s limit.")).toBeTruthy();
});

test("the_warning_says_when_its_read_failed", async () => {
  setup({
    lineage: (a) => {
      if (isEffects(a)) throw { kind: "timedOut", message: 10 };
      return FULL;
    },
  });
  const warning = await screen.findByRole("note", { name: "Before you delete an order" });
  expect(await within(warning).findByText("This list may be incomplete: Contura couldn't read the keys that point to orders.")).toBeTruthy();
});

test("sqlite_says_keys_are_enforced_only_when_on", async () => {
  setup({}, { connection: { ...connection, dialect: "sqlite" } });
  const warning = await screen.findByRole("note", { name: "Before you delete an order" });
  expect(within(warning).getByText("SQLite enforces these only when foreign keys are on.")).toBeTruthy();
});

test("set_default_reads_the_holder_defaults", async () => {
  const withDefault: Lineage = { ...FULL, links: FULL.links.map((l, i) => (i === 3 ? { ...l, onDelete: "SET DEFAULT" } : l)) };
  setup({
    lineage: () => withDefault,
    table_design: (a) => ({ path: a.path, columns: [{ name: "order_id", defaultSql: null, nullable: false }] }),
  });
  const row = (await screen.findByText("An order with shipments can't be deleted: order_id has no default and can't be empty")).closest("li")!;
  expect(group("Points to orders").contains(row)).toBe(true);
  expect(within(row).getByText("Blocks")).toBeTruthy();
  expect(callsTo("table_design").map((c) => (c.path as ObjectPath).name)).toEqual(["shipments"]);
  expect(within(screen.getByRole("note", { name: "Before you delete an order" })).getByText(
    "A shipment stops the delete: order_id has no default and can't be empty.",
  )).toBeTruthy();
});

test("views_are_name_matches_across_schemas_with_notes", async () => {
  setup({
    list_schemas: () => [
      { name: "shop", isSystem: false },
      { name: "sales", isSystem: false },
      { name: "pg_catalog", isSystem: true },
    ],
    list_objects: (a) =>
      a.schema === "shop"
        ? [
            { kind: "view", name: "daily_orders", rows: null },
            { kind: "view", name: "old_orders", rows: null },
            { kind: "view", name: "broken", rows: null },
          ]
        : [
            { kind: "view", name: "sales_orders", rows: null },
            { kind: "view", name: "own_orders", rows: null },
          ],
    object_definition: (a) => {
      const name = (a.path as ObjectPath).name;
      if (name === "broken") throw { kind: "query", message: "permission denied" };
      return {
        daily_orders: "SELECT count(*) FROM orders",
        old_orders: "SELECT * FROM archive.orders",
        sales_orders: 'SELECT * FROM "shop"."orders"',
        own_orders: "SELECT * FROM orders",
      }[name];
    },
  });
  await screen.findByText("Every order needs a customer");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  const views = await within(panel()).findByRole("region", { name: "Views" });
  // A name match, said as one: "names", not "reads".
  expect(within(views).getByText("daily_orders names orders")).toBeTruthy();
  expect(within(views).getByText("sales_orders names orders")).toBeTruthy();
  expect(within(views).getByText("sales.sales_orders")).toBeTruthy();
  // Another schema's orders, and an unqualified orders in another schema, are not this table.
  expect(within(views).queryByText(/old_orders/)).toBeNull();
  expect(within(views).queryByText(/own_orders/)).toBeNull();
  expect(within(views).getByText("1 view could not be read.")).toBeTruthy();
  expect(callsTo("list_objects").map((c) => c.schema)).toEqual(["shop", "sales"]);
});

test("views_note_the_cap", async () => {
  setup({
    list_objects: () => Array.from({ length: 205 }, (_, i) => ({ kind: "view", name: `v${i}`, rows: null })),
    list_schemas: () => [{ name: "shop", isSystem: false }],
    object_definition: () => "SELECT 1",
  });
  await screen.findByText("Every order needs a customer");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  const views = await within(panel()).findByRole("region", { name: "Views" }, { timeout: 5000 });
  expect(within(views).getByText("Checked the first 200 views.")).toBeTruthy();
  expect(callsTo("object_definition")).toHaveLength(200);
});

test("nothing_linked_says_what_was_searched", async () => {
  setup({ lineage: () => ({ ...FULL, tables: [FULL.tables[0]], links: [] }), list_flow_table_links: () => { throw { kind: "file", message: "cannot read" }; }, list_schemas: () => [] });
  expect(await screen.findByText("Nothing links to orders yet")).toBeTruthy();
  expect(screen.getByText("No Foreign Key points to or from it. Contura couldn't read the diagrams folder, so diagrams weren't checked.")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  expect(await screen.findByText("No Foreign Key points to or from it, and no view names it.")).toBeTruthy();
});

test("unknown_and_loading_counts_are_not_shown_as_numbers", async () => {
  setup({
    lineage: () => ({
      ...FULL,
      tables: FULL.tables.map((t) => (t.path.name === "stores" ? { ...t, columnCount: 0, unreadable: "Contura can't find this table." } : t)),
    }),
  });
  const card = await screen.findByRole("group", { name: "Table stores" });
  expect(card.querySelector(".table-card-count")!.textContent).toBe("?");
  cleanupAll();
  setup({ lineage: () => new Promise(() => {}) });
  const loading = await screen.findByRole("group", { name: "Table orders" });
  expect(loading.querySelector(".table-card-count")).toBeNull();
});

test("hovering_a_row_redraws_only_the_card_it_marks", async () => {
  setup();
  const row = (await screen.findByText("Every order needs a customer")).closest("li")!;
  await screen.findByRole("group", { name: "Table customers" });
  await waitFor(() => expect(edge("link:0")).toBeTruthy());
  frameRenders.clear();
  fireEvent.mouseEnter(row);
  await waitFor(() => expect(edge("link:0")!.classList.contains("lineage-edge-hot")).toBe(true));
  expect(frameRenders.get("Table orders") ?? 0).toBeGreaterThan(0);
  expect(frameRenders.get("Table customers") ?? 0).toBe(0);
  expect(frameRenders.get("Table shipments") ?? 0).toBe(0);
});

// ---- Fix round 2 (P15) ----

const SET_DEFAULT: Lineage = { ...FULL, links: FULL.links.map((l, i) => (i === 3 ? { ...l, onDelete: "SET DEFAULT" } : l)) };

test("defaults_while_loading_are_said_unchecked", async () => {
  setup({ lineage: () => SET_DEFAULT, table_design: () => new Promise(() => {}) });
  expect(await screen.findByText("Shipments get the default order when theirs goes, if order_id has a default")).toBeTruthy();
  const warning = await screen.findByRole("note", { name: "Before you delete an order" });
  expect(within(warning).getByText("This list may be incomplete: Contura hasn't checked the defaults of order_id.")).toBeTruthy();
});

test("defaults_that_fail_are_said_and_try_again_reads_them_again", async () => {
  let drawnFails = true;
  setup({
    lineage: (a) => {
      if (!isEffects(a) && drawnFails) throw { kind: "query", message: "permission denied" };
      return SET_DEFAULT;
    },
    table_design: () => {
      throw { kind: "query", message: "permission denied" };
    },
  });
  await screen.findByRole("alert");
  await waitFor(() => expect(callsTo("table_design")).toHaveLength(1));
  drawnFails = false;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  const warning = await screen.findByRole("note", { name: "Before you delete an order" });
  expect(await within(warning).findByText("This list may be incomplete: Contura couldn't read the defaults of shipments.")).toBeTruthy();
  expect(screen.getByText("Shipments get the default order when theirs goes, if order_id has a default")).toBeTruthy();
  // Try again forgot the failed read and asked once more.
  await waitFor(() => expect(callsTo("table_design")).toHaveLength(2));
});

test("a_known_default_reads_plainly", async () => {
  setup({ lineage: () => SET_DEFAULT, table_design: (a) => ({ path: a.path, columns: [{ name: "order_id", defaultSql: "0", nullable: false }] }) });
  expect(await screen.findByText("Shipments get the default order when theirs goes")).toBeTruthy();
  const warning = await screen.findByRole("note", { name: "Before you delete an order" });
  await waitFor(() => expect(within(warning).queryByText(/defaults of/)).toBeNull());
});

test("a_failed_views_read_says_views_were_not_checked", async () => {
  setup({
    lineage: () => ({ ...FULL, tables: [FULL.tables[0]], links: [] }),
    list_flow_table_links: () => [],
    list_schemas: () => {
      throw { kind: "query", message: "permission denied" };
    },
  });
  await screen.findByText("Nothing links to orders yet");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  expect(await screen.findByText("No Foreign Key points to or from it. Contura couldn't read the views, so views weren't checked.")).toBeTruthy();
});

test("a_failed_views_read_is_noted_in_the_panel", async () => {
  setup({
    list_schemas: () => {
      throw { kind: "query", message: "permission denied" };
    },
  });
  await screen.findByText("Every order needs a customer");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  const views = await within(panel()).findByRole("region", { name: "Views" });
  expect(within(views).getByText("Contura couldn't read the views, so views weren't checked.")).toBeTruthy();
});

test("diagram_rows_name_the_process_that_touches_the_table", async () => {
  const { calls } = setup({
    list_flow_table_links: () => [
      {
        file: "fulfilment",
        node: "Orders",
        kind: "store",
        table: "orders",
        access: "both",
        processes: [
          { node: "Ship order", access: "reads" },
          { node: "Restock", access: "writes" },
        ],
      },
      { file: "checkout", node: "Orders", kind: "store", table: "shop.orders", access: "writes", processes: [] },
    ],
  });
  await screen.findByText("Ship order reads orders");
  const diagrams = group("Diagrams");
  // The header counts diagrams, not rows.
  expect(within(diagrams).getByText("2")).toBeTruthy();
  const ship = within(diagrams).getByText("Ship order reads orders").closest("li")!;
  expect(within(ship).getByText("fulfilment.flow")).toBeTruthy();
  expect(within(diagrams).getByText("Restock writes orders")).toBeTruthy();
  // A table node no process touches still reads by its diagram.
  expect(within(diagrams).getByText("Checkout writes orders")).toBeTruthy();
  fireEvent.click(within(ship).getByRole("button", { name: "Open fulfilment.flow" }));
  expect(calls.openDiagram).toHaveBeenCalledWith("fulfilment");
});

test("views_from_the_catalog_read_as_dependencies", async () => {
  setup({
    view_dependencies: () => ({
      catalog: true,
      views: [
        { database: "kestrel", schema: "shop", name: "daily_orders" },
        { database: "kestrel", schema: "sales", name: "big_orders" },
      ],
      capped: true,
    }),
  });
  await screen.findByText("Every order needs a customer");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  const views = await within(panel()).findByRole("region", { name: "Views" });
  // The catalog said so: "reads", not "names".
  expect(within(views).getByText("daily_orders reads orders")).toBeTruthy();
  expect(within(views).getByText("big_orders reads orders")).toBeTruthy();
  expect(within(views).getByText("sales.big_orders")).toBeTruthy();
  expect(within(views).getByText("Showing the first 200 views.")).toBeTruthy();
  expect(callsTo("view_dependencies")).toEqual([{ id: "c1", path: ORDERS }]);
  expect(callsTo("object_definition")).toHaveLength(0);
});

test("views_fall_back_to_names_without_a_catalog", async () => {
  setup({
    view_dependencies: () => ({ catalog: false, views: [], capped: false }),
    list_schemas: () => [{ name: "shop", isSystem: false }],
    list_objects: () => [{ kind: "view", name: "daily_orders", rows: null }],
    object_definition: () => "SELECT count(*) FROM orders",
  });
  await screen.findByText("Every order needs a customer");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  const views = await within(panel()).findByRole("region", { name: "Views" });
  expect(within(views).getByText("daily_orders names orders")).toBeTruthy();
});

test("nothing_linked_says_no_view_reads_it_when_the_catalog_says_so", async () => {
  setup({
    lineage: () => ({ ...FULL, tables: [FULL.tables[0]], links: [] }),
    list_flow_table_links: () => [],
    view_dependencies: () => ({ catalog: true, views: [], capped: false }),
  });
  expect(await screen.findByText("Nothing links to orders yet")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  expect(await screen.findByText("No Foreign Key points to or from it, and no view reads it.")).toBeTruthy();
});

test("moved_cards_come_back_from_the_layout_file_and_reset_removes_it", async () => {
  setup({
    read_lineage_layout: () => layoutText({ [tableId(p("customers"))]: { x: 999, y: 777 } }),
    delete_lineage_layout: () => undefined,
  });
  await screen.findByRole("group", { name: "Table customers" });
  const node = () => [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find((n) => n.getAttribute("data-id") === tableId(p("customers")))!;
  await waitFor(() => expect(node().style.transform).toContain("999px"));
  expect(callsTo("read_lineage_layout")).toEqual([{ id: "c1", path: ORDERS }]);
  fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
  await waitFor(() => expect(node().style.transform).not.toContain("999px"));
  expect(callsTo("delete_lineage_layout")).toEqual([{ id: "c1", path: ORDERS }]);
  expect(screen.queryByRole("button", { name: "Reset layout" })).toBeNull();
});

test("reset_glides_every_card_back_with_the_tidy_timing", async () => {
  // Motion on: Reset is lineage's Tidy (its layout is computed), so the cards glide back over 240 ms.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  setup({
    read_lineage_layout: () => layoutText({ [tableId(p("customers"))]: { x: 999, y: 777 } }),
    delete_lineage_layout: () => undefined,
  });
  await screen.findByRole("group", { name: "Table customers" });
  const node = () => [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find((n) => n.getAttribute("data-id") === tableId(p("customers")))!;
  await waitFor(() => expect(node().style.transform).toContain("999px"));
  const started = performance.now();
  fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
  // The first frame still draws the card where it was; then it glides home through places in between.
  const seen = new Set([node().style.transform]);
  expect(node().style.transform).toContain("999px");
  await waitFor(
    () => {
      seen.add(node().style.transform);
      expect(performance.now() - started).toBeGreaterThan(400);
    },
    { timeout: 3000, interval: 10 },
  );
  expect(node().style.transform).not.toContain("999px");
  expect(seen.size).toBeGreaterThanOrEqual(3);
  expect(callsTo("delete_lineage_layout")).toEqual([{ id: "c1", path: ORDERS }]);
});

test("moved_cards_stay_when_the_depth_changes", async () => {
  setup({ read_lineage_layout: () => layoutText({ [tableId(p("customers"))]: { x: 999, y: 777 } }) });
  await screen.findByRole("group", { name: "Table customers" });
  const node = () => [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find((n) => n.getAttribute("data-id") === tableId(p("customers")))!;
  await waitFor(() => expect(node().style.transform).toContain("999px"));
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Depth" })).getByRole("radio", { name: "2" }));
  await waitFor(() => expect(lastLineage()).toMatchObject({ depth: 2 }));
  await waitFor(() => expect(node().style.transform).toContain("999px"));
  expect(callsTo("read_lineage_layout")).toHaveLength(1);
});

test("a_failed_view_catalog_read_says_these_are_name_matches", async () => {
  setup({
    view_dependencies: () => {
      throw { kind: "query", message: "permission denied for pg_depend" };
    },
    list_schemas: () => [{ name: "shop", isSystem: false }],
    list_objects: () => [{ kind: "view", name: "daily_orders", rows: null }],
    object_definition: () => "SELECT count(*) FROM orders",
  });
  await screen.findByText("Every order needs a customer");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  const views = await within(panel()).findByRole("region", { name: "Views" });
  expect(within(views).getByText("daily_orders names orders")).toBeTruthy();
  expect(within(views).getByText("Contura couldn't read the view catalog, so these are name matches.")).toBeTruthy();
});

test("no_view_catalog_is_silent", async () => {
  setup({
    view_dependencies: () => ({ catalog: false, views: [], capped: false }),
    list_schemas: () => [{ name: "shop", isSystem: false }],
    list_objects: () => [{ kind: "view", name: "daily_orders", rows: null }],
    object_definition: () => "SELECT count(*) FROM orders",
  });
  await screen.findByText("Every order needs a customer");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  const views = await within(panel()).findByRole("region", { name: "Views" });
  expect(within(views).getByText("daily_orders names orders")).toBeTruthy();
  expect(within(views).queryByText(/view catalog/)).toBeNull();
});

test("views_in_another_mysql_database_name_their_database", async () => {
  const at = (database: string, name: string): ObjectPath => ({ database, schema: null, name });
  routeInvoke({
    lineage: () => ({ ...FULL, center: at("shop", "orders"), tables: [{ ...FULL.tables[0], path: at("shop", "orders") }], links: [] }),
    list_flow_table_links: () => [],
    view_dependencies: () => ({ catalog: true, views: [at("shop", "daily"), at("archive", "daily")], capped: false }),
  });
  render(
    <div style={{ width: 1200, height: 700 }}>
      <LineageTab connection={{ id: "c1", name: "m", dialect: "mysql" }} path={at("shop", "orders")} onOpenTable={() => {}} onAddForeignKey={() => {}} />
    </div>,
  );
  await screen.findByText("Nothing links to orders yet");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Source" })).getByRole("radio", { name: "Views" }));
  const views = await within(panel()).findByRole("region", { name: "Views" });
  // Same name in two databases: the other database is named, and each card has its own place.
  expect(within(views).getByText("daily")).toBeTruthy();
  expect(within(views).getByText("archive.daily")).toBeTruthy();
});

test("publish_opens_the_publish_image_dialog_with_the_lineage", async () => {
  setup({ read_lineage_layout: () => null, list_objects: () => [], view_dependencies: () => ({ catalog: false, views: [], capped: false }) });
  const bar = screen.getByRole("toolbar", { name: "Lineage" });
  await waitFor(() => expect(screen.getByRole("group", { name: "Diagram checkout.flow" })).toBeTruthy());
  fireEvent.click(within(bar).getByRole("button", { name: "Publish" }));
  const dialog = await screen.findByRole("dialog", { name: "Publish image" });
  expect(within(dialog).getByText("orders lineage")).toBeTruthy();
  // The whole lineage: five cards and the diagram cards below, so the image is wider than one card.
  const out = within(dialog).getByRole("status", { name: "Output" }).textContent ?? "";
  const width = Number(/([\d,]+) x/.exec(out)![1].replace(/,/g, ""));
  expect(width).toBeGreaterThan(2 * 214 * 2);
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish image" })).toBeNull());
});

// ---- Fix wave (P24 I2) ----

test("the_warning_says_it_is_checking_while_its_own_read_runs", async () => {
  setup({ lineage: (a) => (isEffects(a) ? new Promise(() => {}) : FULL) });
  await screen.findByText("Every order needs a customer");
  // Never nothing while unchecked: the block's title with the checking line.
  const warning = await screen.findByRole("note", { name: "Before you delete an order" });
  expect(within(warning).getByText("Checking what deleting an order does...")).toBeTruthy();
});

test("try_again_keeps_the_last_warning_while_it_reads_again", async () => {
  let drawnFails = true;
  let second = false;
  setup({
    lineage: (a) => {
      if (isEffects(a)) {
        if (second) return new Promise(() => {});
        second = true;
        return EFFECTS;
      }
      if (drawnFails) throw { kind: "query", message: "permission denied" };
      return FULL;
    },
  });
  await screen.findByRole("alert");
  drawnFails = false;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  await screen.findByText("Every order needs a customer");
  const warning = await screen.findByRole("note", { name: "Before you delete an order" });
  expect(within(warning).getByText("A refund on its order lines stops the delete.")).toBeTruthy();
  expect(within(warning).queryByText("Checking what deleting an order does...")).toBeNull();
  expect(lineageCalls().filter(isEffects)).toHaveLength(2);
});

test("F32 a drag on the empty lineage canvas selects; it does not pan", async () => {
  setup();
  const pane = await waitFor(() => {
    const p = document.querySelector(".react-flow__pane");
    expect(p).not.toBeNull();
    return p as HTMLElement;
  });
  expect(pane.classList.contains("draggable")).toBe(false);
});
