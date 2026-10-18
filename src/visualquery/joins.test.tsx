import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, SqlSchema, VisualQuery, VqJoin, VqPreview } from "../api/types";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import type { VisualTabDoc } from "../shell/tabs";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { placeBeside } from "./JoinPopover";
import { emptyQuery } from "./model";
import VisualQueryTab, { type VisualQueryTabProps } from "./VisualQueryTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

patientFile();
beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
const realElementFromPoint = document.elementFromPoint;
afterEach(() => {
  document.elementFromPoint = realElementFromPoint;
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
    {
      schema: null,
      name: "orders",
      kind: "table",
      columns: [col("id", "int", true), col("store_id"), col("pickup_store_id"), col("code", "varchar(8)"), col("placed_at", "datetime")],
    },
    { schema: null, name: "stores", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)"), col("city", "varchar(80)")] },
  ],
  fks: [
    {
      from: { schema: null, table: "orders", columns: ["store_id"] },
      to: { schema: null, table: "stores", columns: ["id"] },
      name: "fk_orders_store",
      comment: "Where the order was placed",
    },
    {
      from: { schema: null, table: "orders", columns: ["pickup_store_id"] },
      to: { schema: null, table: "stores", columns: ["id"] },
      name: "fk_orders_pickup",
      comment: "Where the order is picked up",
    },
  ],
};
/** One key only, for the plain Foreign Key Join. */
const ONE_KEY: SqlSchema = { ...SHOP, fks: [SHOP.fks[0]] };

let lang: { client: LangClient; schemas: SchemaCache };
function makeLang(schema: SqlSchema) {
  const client = new LangClient(() => fakeWorker());
  lang = { client, schemas: new SchemaCache(client, () => Promise.resolve(schema)) };
}

/** The Core's preview, as far as these tests need: the pending pick warning by table id. */
function previewFor(query: VisualQuery): VqPreview {
  const pending = query.joins.filter((j) => j.pending != null).map((j) => j.right);
  return {
    query: {
      sql: "SELECT 1",
      parts: [],
      outputs: query.columns.map((c) => c.column),
      warnings: pending.map((table) => ({ kind: "pendingPick" as const, table })),
    },
    problems: [],
  };
}

beforeEach(() => {
  makeLang(ONE_KEY);
  routeInvoke({ visual_query_sql: ({ query }) => previewFor(query as VisualQuery) });
});

const card = (id: string, name: string, alias: string, x = 0) => ({ id, schema: null, name, alias, x, y: 0 });
const docWith = (over: Partial<VisualQuery> = {}, connection: Partial<VisualTabDoc> = {}): VisualTabDoc => ({
  id: "v1",
  name: "New Visual Query",
  connectionId: "c1",
  database: "shop",
  model: { ...emptyQuery("shop", "mysql"), ...over },
  savedId: null,
  savedJson: null,
  ...connection,
});

let latest: VisualQuery;
function Harness({ initial, ...props }: { initial: VisualTabDoc } & Partial<VisualQueryTabProps>) {
  const [doc, setDoc] = useState(initial);
  latest = doc.model;
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
const edgePath = (id: string) => document.querySelector(`.react-flow__edge[data-id="${id}"] .vq-join-line`) as SVGPathElement | null;
const badge = (id: string) => document.querySelector(`.vq-join-badge[data-join="${id}"]`) as HTMLButtonElement | null;
const handle = (node: string, id: string) =>
  document.querySelector(`.react-flow__node[data-id="${node}"] .react-flow__handle[data-handleid="${id}"]`) as HTMLElement;
const FK_JOIN: VqJoin = { id: "j1", left: "t1", right: "t2", kind: "inner", on: [{ leftColumn: "store_id", rightColumn: "id" }] };
const ORDERS_STORES = { tables: [card("t1", "orders", "o"), card("t2", "stores", "s", 320)] };

/** A column drag as React Flow reads it: down on one dot, a move, then (by the caller) the release. */
function dragPort(from: Element, to: Element) {
  document.elementFromPoint = () => to;
  fireEvent.mouseDown(from, { clientX: 10, clientY: 10, button: 0 });
  fireEvent.mouseMove(document, { clientX: 300, clientY: 40 });
}
/** Clicks a Join's badge until its popover is open: the edge is drawn again once the cards are measured. */
/**
 * Opens a Join's popover from its badge as the keyboard would (focus, then press). The edge is drawn
 * again once the cards are measured, so a badge found too early may be detached: try again, but
 * never press once a dialog is open (the badge toggles).
 */
async function openBadge(id: string) {
  await waitFor(() => {
    if (!screen.queryByRole("dialog")) {
      const b = badge(id)!;
      b.focus();
      fireEvent.click(b);
    }
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
}
const chip = () => document.querySelector(".vq-drop-chip") as HTMLElement | null;

async function ready() {
  await cardEl("Table orders o");
  await waitFor(() => expect(handle("t1", "store_id:s")).toBeTruthy());
  await waitFor(() => expect(handle("t2", "id:t")).toBeTruthy());
}

test("a_foreign_key_join_is_solid_with_its_inner_badge_and_a_join_made_here_is_dashed", async () => {
  const made: VqJoin = { id: "j2", left: "t1", right: "t3", kind: "left", on: [{ leftColumn: "id", rightColumn: "id" }] };
  render(<Harness initial={docWith({ tables: [...ORDERS_STORES.tables, card("t3", "menu_items", "mi", 640)], joins: [FK_JOIN, made] })} />);
  await waitFor(() => expect(edgePath("j1")).toBeTruthy());
  await waitFor(() => expect(edgePath("j2")).toBeTruthy());
  expect(edgePath("j1")!.getAttribute("class")).toContain("vq-join-fk");
  expect(edgePath("j1")!.getAttribute("class")).not.toContain("vq-join-made");
  expect(edgePath("j2")!.getAttribute("class")).toContain("vq-join-made");
  // A badge at the midpoint with the Venn mark and the kind.
  expect(badge("j1")!.textContent).toBe("Inner");
  expect(badge("j1")!.querySelector("svg.vq-venn")).not.toBeNull();
  expect(badge("j2")!.textContent).toBe("Left");
  expect(badge("j1")!.closest(".edge-badge")).not.toBeNull();
  // A dot at each end of the line.
  expect(document.querySelectorAll(`.react-flow__edge[data-id="j1"] .vq-join-dot`)).toHaveLength(2);
});

test("the_drag_chip_says_add_then_change_with_the_condition", async () => {
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  dragPort(handle("t1", "store_id:s"), handle("t2", "id:t"));
  await waitFor(() => expect(chip()).toBeTruthy());
  expect(chip()!.textContent).toContain("Drop to add a Join");
  expect(within(chip()!).getByText("s.id = o.store_id")).toBeTruthy();
  // Every column is a target while dragging; the one under the drag is marked.
  expect(document.querySelector(".vq-canvas")!.className).toContain("vq-joining");
  expect(document.querySelector(`.react-flow__node[data-id="t2"] li[data-column="id"]`)!.className).toContain("vq-card-row-target");
  fireEvent.mouseUp(document, { clientX: 300, clientY: 40 });
  await waitFor(() => expect(chip()).toBeNull());
  await waitFor(() => expect(latest.joins).toHaveLength(1));
  expect(latest.joins[0]).toMatchObject({ left: "t1", right: "t2", on: [{ leftColumn: "store_id", rightColumn: "id" }] });

  // The two cards are joined now: a second drop changes that Join.
  await waitFor(() => expect(handle("t1", "store_id:s")).toBeTruthy());
  dragPort(handle("t1", "store_id:s"), handle("t2", "id:t"));
  await waitFor(() => expect(chip()?.textContent).toContain("Drop to change the Join"));
  expect(within(chip()!).getByText("s.id = o.store_id")).toBeTruthy();
  // Esc cancels: no chip, nothing changes.
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(chip()).toBeNull());
  expect(latest.joins).toHaveLength(1);
});

test("different_types_mark_the_target_gold_and_still_connect", async () => {
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  dragPort(handle("t1", "store_id:s"), handle("t2", "name:t"));
  await waitFor(() => expect(chip()?.textContent).toContain("Types differ: int and varchar(80). The server may refuse it."));
  expect(document.querySelector(`.react-flow__node[data-id="t2"] li[data-column="name"]`)!.className).toContain("vq-card-row-target-warn");
  fireEvent.mouseUp(document, { clientX: 300, clientY: 40 });
  await waitFor(() => expect(latest.joins[0]?.on).toEqual([{ leftColumn: "store_id", rightColumn: "name" }]));
});

test("shift_on_the_drop_adds_a_condition_and_the_popover_lists_both", async () => {
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [FK_JOIN] })} />);
  await ready();
  dragPort(handle("t1", "code:s"), handle("t2", "name:t"));
  await waitFor(() => expect(chip()).toBeTruthy());
  fireEvent.mouseUp(document, { clientX: 300, clientY: 40, shiftKey: true });
  await waitFor(() => expect(latest.joins[0].on).toHaveLength(2));
  await openBadge("j1");
  const pop = await screen.findByRole("dialog", { name: "Join orders to stores" });
  const conditions = within(pop).getAllByRole("listitem").map((li) => li.querySelector(".vq-join-condition")?.textContent);
  expect(conditions).toEqual(["s.id = o.store_id", "s.name = o.code"]);
  // The hint says how.
  expect(within(pop).getByText("Hold Shift while you drop a column to add another condition.")).toBeTruthy();
  // Removing one keeps the Join; removing the last removes it.
  await userEvent.click(within(pop).getAllByRole("button", { name: "Remove this condition" })[1]);
  await waitFor(() => expect(latest.joins[0].on).toEqual([{ leftColumn: "store_id", rightColumn: "id" }]));
});

test("j_on_a_column_lists_the_other_cards_columns_and_enter_makes_the_join", async () => {
  render(<Harness initial={docWith(ORDERS_STORES)} />);
  await ready();
  const row = document.querySelector(`.react-flow__node[data-id="t1"] li[data-column="store_id"]`) as HTMLElement;
  row.focus();
  fireEvent.keyDown(row, { key: "j", code: "KeyJ" });
  const menu = await screen.findByRole("menu", { name: "Join o.store_id to" });
  // Same type first: the int columns of stores, then the rest.
  expect(within(menu).getAllByRole("menuitem").map((b) => b.getAttribute("aria-label"))).toEqual(["s.id", "s.name", "s.city"]);
  expect(within(menu).getAllByRole("menuitem")[0].textContent).toBe("s.idint");
  expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(latest.joins).toHaveLength(1));
  expect(latest.joins[0]).toMatchObject({ left: "t1", right: "t2", on: [{ leftColumn: "store_id", rightColumn: "id" }] });
});

test("the_join_popover_sets_the_kind_with_its_keys", async () => {
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [FK_JOIN] })} />);
  await openBadge("j1");
  const pop = await screen.findByRole("dialog", { name: "Join orders to stores" });
  expect(within(pop).getByText("Esc")).toBeTruthy();
  const kinds = within(pop).getAllByRole("radio");
  expect(kinds.map((k) => k.querySelector(".vq-join-kind-name")?.textContent)).toEqual(["Inner", "Left", "Right", "Full"]);
  expect(kinds.map((k) => k.querySelector(".kbd")?.textContent)).toEqual(["I", "L", "R", "F"]);
  expect(within(pop).getByText("Only orders that have a store")).toBeTruthy();
  expect(within(pop).getByText("Every order, with its store if any")).toBeTruthy();
  expect(within(pop).getByText("Every store, with its orders if any")).toBeTruthy();
  expect(kinds[0].getAttribute("aria-checked")).toBe("true");
  // MySQL: Full is off with its reason.
  expect((kinds[3] as HTMLButtonElement).disabled).toBe(true);
  expect(within(pop).getByText("MySQL has no FULL JOIN.")).toBeTruthy();
  expect(within(pop).queryByText("Every row from both sides")).toBeNull();
  fireEvent.keyDown(pop, { key: "l" });
  await waitFor(() => expect(latest.joins[0].kind).toBe("left"));
  await waitFor(() => expect(badge("j1")!.textContent).toBe("Left"));
  fireEvent.keyDown(pop, { key: "f" });
  expect(latest.joins[0].kind).toBe("left");
  // The selected Join is drawn in the accent.
  expect(edgePath("j1")!.getAttribute("class")).toContain("vq-join-selected");
  // Swap sides turns Left into Right and keeps the meaning.
  await userEvent.click(within(pop).getByRole("button", { name: /Swap sides/ }));
  await waitFor(() => expect(latest.joins[0]).toMatchObject({ left: "t2", right: "t1", kind: "right" }));
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Join stores to orders" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Join / })).toBeNull());
});

test("full_is_offered_on_postgresql", async () => {
  const pg = { ...kestrel, dialect: "postgres" as const };
  const doc = docWith({ ...ORDERS_STORES, joins: [FK_JOIN], dialect: "postgres" });
  render(<Harness initial={doc} connection={pg} />);
  await waitFor(() => expect(badge("j1")).toBeTruthy());
  await openBadge("j1");
  const pop = await screen.findByRole("dialog", { name: "Join orders to stores" });
  expect(within(pop).getByText("Every row from both sides")).toBeTruthy();
  fireEvent.keyDown(pop, { key: "F" });
  await waitFor(() => expect(latest.joins[0].kind).toBe("full"));
});

test("delete_in_the_popover_removes_the_join_and_the_card_becomes_a_cross_join_card", async () => {
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [FK_JOIN] })} />);
  await openBadge("j1");
  const pop = await screen.findByRole("dialog", { name: "Join orders to stores" });
  const remove = within(pop).getByRole("button", { name: /Remove Join/ });
  expect(remove.className).toContain("vq-danger-text");
  expect(within(remove).getByText("Delete")).toBeTruthy();
  fireEvent.keyDown(pop, { key: "Delete" });
  await waitFor(() => expect(latest.joins).toEqual([]));
  expect(screen.queryByRole("dialog", { name: "Join orders to stores" })).toBeNull();
  const stores = await cardEl("Table stores s");
  expect(await within(stores).findByText("No Join. Runs as a CROSS JOIN.")).toBeTruthy();
});

test("two_keys_give_a_pick_that_opens_once_by_itself_and_2_picks_the_second", async () => {
  makeLang(SHOP);
  render(<Harness initial={docWith({ tables: [card("t1", "orders", "o")] })} />);
  await cardEl("Table orders o");
  await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const finder = await screen.findByRole("dialog", { name: "Add table" });
  await userEvent.type(within(finder).getByRole("searchbox", { name: "Find a table" }), "stores{Enter}");
  const pop = await screen.findByRole("dialog", { name: "orders links to stores twice" });
  expect(within(pop).getByText("Pick the Foreign Key this Join uses. stores stays out of the SQL until you pick.")).toBeTruthy();
  const choices = within(pop).getAllByRole("button");
  expect(choices.map((c) => c.querySelector(".kbd")?.textContent)).toEqual(["1", "2", "3"]);
  // Each key by its columns, its name and its comment (P9).
  expect(within(choices[0]).getByText("store_id").className).toContain("vq-pick-columns");
  expect(within(choices[0]).getByText("fk_orders_store")).toBeTruthy();
  expect(within(choices[0]).getByText("Where the order was placed")).toBeTruthy();
  expect(within(choices[1]).getByText("pickup_store_id")).toBeTruthy();
  expect(within(choices[2]).getByText("Both")).toBeTruthy();
  expect(within(choices[2]).getByText("Adds stores a second time as s2")).toBeTruthy();
  // The pending Join is a dashed warning line with a "Pick" badge, and the status line says why.
  const join = latest.joins[0];
  await waitFor(() => expect(badge(join.id)?.textContent).toBe("Pick"));
  expect(edgePath(join.id)!.getAttribute("class")).toContain("vq-join-pending");
  expect(screen.getByRole("status", { name: "Visual Query status" }).textContent).toBe("stores is left out until you pick a Foreign Key.");
  fireEvent.keyDown(pop, { key: "2" });
  await waitFor(() => expect(latest.joins[0].pending ?? null).toBeNull());
  expect(latest.joins[0].on).toEqual([{ leftColumn: "pickup_store_id", rightColumn: "id" }]);
  expect(screen.queryByRole("dialog", { name: "orders links to stores twice" })).toBeNull();
  await waitFor(() => expect(screen.getByRole("status", { name: "Visual Query status" }).textContent).toBe(""));
  // Opened once: a later change does not bring it back.
  await waitFor(() => expect(badge(join.id)?.textContent).toBe("Inner"));
  expect(screen.queryByRole("dialog", { name: "orders links to stores twice" })).toBeNull();
});

test("3_in_the_pick_popover_adds_the_table_again_as_s2", async () => {
  makeLang(SHOP);
  const pending: VqJoin = {
    id: "j1",
    left: "t1",
    right: "t2",
    kind: "inner",
    on: [],
    pending: [
      { name: "store_id", on: [{ leftColumn: "store_id", rightColumn: "id" }], comment: null },
      { name: "pickup_store_id", on: [{ leftColumn: "pickup_store_id", rightColumn: "id" }], comment: null },
    ],
  };
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [pending] })} />);
  // A restored pending Join waits for its badge; clicking it opens the popover.
  await waitFor(() => expect(badge("j1")?.textContent).toBe("Pick"));
  expect(screen.queryByRole("dialog", { name: "orders links to stores twice" })).toBeNull();
  await openBadge("j1");
  const pop = await screen.findByRole("dialog", { name: "orders links to stores twice" });
  fireEvent.keyDown(pop, { key: "3" });
  await waitFor(() => expect(latest.tables.map((t) => t.alias)).toEqual(["o", "s", "s2"]));
  expect(await cardEl("Table stores s2")).toBeTruthy();
  expect(latest.joins.map((j) => j.on)).toEqual([[{ leftColumn: "store_id", rightColumn: "id" }], [{ leftColumn: "pickup_store_id", rightColumn: "id" }]]);
});

test("the_popover_sits_beside_the_badge_away_from_the_cards", () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const view = { width: 1200, height: 800 };
  // Cards left and right of the badge: the popover goes below it, clear of both.
  const at = placeBeside(rect(400, 100, 60, 20), [rect(100, 60, 216, 200), rect(600, 60, 216, 200)], { width: 300, height: 200 }, view);
  const box = rect(at.left, at.top, 300, 200);
  for (const c of [rect(100, 60, 216, 200), rect(600, 60, 216, 200)]) {
    expect(box.right <= c.left || box.left >= c.right || box.bottom <= c.top || box.top >= c.bottom).toBe(true);
  }
  // Nothing in the way: to the right of the badge.
  expect(placeBeside(rect(400, 100, 60, 20), [], { width: 300, height: 200 }, view).left).toBeGreaterThanOrEqual(460);
});

// ---- Focus: a popover keeps it while open and gives it back when it closes ----

const canvasRoot = () => document.querySelector(".diagram-canvas") as HTMLElement;

test("esc_in_the_join_popover_gives_focus_back_to_the_badge", async () => {
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [FK_JOIN] })} />);
  await openBadge("j1");
  const pop = screen.getByRole("dialog", { name: "Join orders to stores" });
  expect(pop.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(pop, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(badge("j1"));
});

test("a_press_outside_closes_the_join_popover_and_gives_focus_back", async () => {
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [FK_JOIN] })} />);
  await openBadge("j1");
  fireEvent.mouseDown(document.body);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(badge("j1"));
});

test("delete_in_the_join_popover_puts_focus_on_the_canvas_when_the_badge_is_gone", async () => {
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [FK_JOIN] })} />);
  await openBadge("j1");
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Join orders to stores" }), { key: "Delete" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(badge("j1")).toBeNull();
  expect(document.activeElement).toBe(canvasRoot());
});

const PENDING: VqJoin = {
  id: "j1",
  left: "t1",
  right: "t2",
  kind: "inner",
  on: [],
  pending: [
    { name: "store_id", on: [{ leftColumn: "store_id", rightColumn: "id" }], comment: null },
    { name: "pickup_store_id", on: [{ leftColumn: "pickup_store_id", rightColumn: "id" }], comment: null },
  ],
};

test("a_pick_gives_focus_back_to_the_badge", async () => {
  makeLang(SHOP);
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [PENDING] })} />);
  await openBadge("j1");
  fireEvent.keyDown(screen.getByRole("dialog", { name: "orders links to stores twice" }), { key: "1" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(badge("j1")?.textContent).toBe("Inner"));
  expect(document.activeElement).toBe(badge("j1"));
});

test("esc_in_the_pick_popover_gives_focus_back_to_the_badge", async () => {
  makeLang(SHOP);
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [PENDING] })} />);
  await openBadge("j1");
  fireEvent.keyDown(screen.getByRole("dialog", { name: "orders links to stores twice" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(badge("j1"));
});

test("tab_and_shift_tab_stay_inside_the_join_popover", async () => {
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [FK_JOIN] })} />);
  await openBadge("j1");
  const pop = screen.getByRole("dialog", { name: "Join orders to stores" });
  const first = within(pop).getAllByRole("radio")[0];
  const last = within(pop).getByRole("button", { name: /Remove Join/ });
  // From the dialog itself, Shift+Tab goes to the last control.
  fireEvent.keyDown(pop, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  // Esc still closes it from there.
  fireEvent.keyDown(last, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("tab_stays_inside_the_pick_popover", async () => {
  makeLang(SHOP);
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [PENDING] })} />);
  await openBadge("j1");
  const pop = screen.getByRole("dialog", { name: "orders links to stores twice" });
  const choices = within(pop).getAllByRole("button");
  choices[choices.length - 1].focus();
  fireEvent.keyDown(choices[choices.length - 1], { key: "Tab" });
  expect(document.activeElement).toBe(choices[0]);
});

test("shift_over_a_joined_pair_says_the_drop_adds_a_condition", async () => {
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [FK_JOIN] })} />);
  await ready();
  dragPort(handle("t1", "code:s"), handle("t2", "name:t"));
  await waitFor(() => expect(chip()?.textContent).toContain("Drop to change the Join"));
  fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
  await waitFor(() => expect(chip()?.textContent).toContain("Drop to add a condition"));
  expect(within(chip()!).getByText("s.name = o.code")).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(chip()).toBeNull());
});

test("a_join_problem_marks_the_badge_and_shows_in_both_popovers", async () => {
  const message = "This Join has a NUL character in a name. Remove it.";
  routeInvoke({
    visual_query_sql: ({ query }) => ({ ...previewFor(query as VisualQuery), query: null, problems: [{ target: { kind: "join", id: "j1" }, message }] }),
  });
  const { unmount } = render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [FK_JOIN] })} />);
  await waitFor(() => expect(badge("j1")?.className).toContain("vq-join-badge-danger"));
  expect(badge("j1")!.title).toBe(message);
  await openBadge("j1");
  expect(within(screen.getByRole("dialog")).getByText(message).className).toContain("vq-problem");
  unmount();
  makeLang(SHOP);
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [PENDING] })} />);
  await waitFor(() => expect(badge("j1")?.className).toContain("vq-join-badge-danger"));
  await openBadge("j1");
  expect(within(screen.getByRole("dialog", { name: "orders links to stores twice" })).getByText(message)).toBeTruthy();
});

test("the_status_line_goes_to_the_window_status_bar_when_there_is_one", async () => {
  makeLang(SHOP);
  const slot = document.createElement("span");
  slot.id = "app-status-slot";
  document.body.appendChild(slot);
  try {
    render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [PENDING] })} />);
    await waitFor(() => expect(slot.textContent).toBe("stores is left out until you pick a Foreign Key."));
    expect(document.querySelector(".vq-status-line")).toBeNull();
  } finally {
    slot.remove();
  }
});

test("a_wheel_over_the_canvas_closes_the_popover", async () => {
  render(<Harness initial={docWith({ ...ORDERS_STORES, joins: [FK_JOIN] })} />);
  await openBadge("j1");
  fireEvent.wheel(canvasRoot(), { deltaY: 40 });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
