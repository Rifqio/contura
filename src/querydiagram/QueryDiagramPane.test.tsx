import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, SqlPart, SqlSchema, VisualQuery, VqPreview } from "../api/types";
import { ToastProvider } from "../components/Toast";
import type { LayoutRequest, Positions } from "../diagram/layout";
import type { Scene } from "../diagram/export/scene";
import { LangClient } from "../lang/client";
import { analyzeSql } from "../lang/sql/analyze";
import { KFC_SCHEMA } from "../lang/sql/fixtures";
import { type QueryShape, queryShape, type ShapeProblem } from "../lang/sql/queryShape";
import { SchemaCache } from "../lang/sql/schemaCache";
import type { VisualTabDoc } from "../shell/tabs";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import { emptyQuery } from "../visualquery/model";
import VisualQueryTab from "../visualquery/VisualQueryTab";
import QueryDiagramPane, { type QueryDiagramPaneProps } from "./QueryDiagramPane";
import { toScene } from "./toScene";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The Publish dialog has its own tests; here it only has to be opened with the diagram's scene.
const published: { scene: Scene; selected: string[] }[] = [];
vi.mock("../diagram/export/PublishDialog", () => ({
  default: (p: { scene: Scene; selected: string[]; onClose(): void }) => {
    published.push({ scene: p.scene, selected: p.selected });
    return <div role="dialog" aria-label="Publish image" />;
  },
}));

beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
beforeEach(() => {
  published.length = 0;
});

const LATE = `SELECT s.name,
       s.city,
       count(o.id) AS late_orders,
       sum(o.total) AS late_total
FROM sales.orders o
JOIN public.stores s ON s.id = o.store_id
LEFT JOIN public.customers c ON c.id = o.customer_id
WHERE o.status = 'late'
  AND o.placed_at >= '2026-10-01'
  AND o.channel IN ('app', 'kiosk')
GROUP BY s.name, s.city
ORDER BY late_orders DESC, s.name
LIMIT 50`;

const shapeOf = (text: string): QueryShape => {
  const s = queryShape(analyzeSql(text, "postgres", KFC_SCHEMA), 0, "loaded");
  if ("kind" in s) throw new Error(JSON.stringify(s));
  return s;
};
const LATE_SHAPE = shapeOf(LATE);

/** Places the nodes `existing` lacks in a row, 300 px apart. */
const placeRow = async (req: LayoutRequest): Promise<Positions> => {
  const out: Positions = { ...req.existing };
  req.nodes.filter((n) => !req.existing[n.id]).forEach((n, i) => (out[n.id] = { x: 300 * (i + Object.keys(req.existing).length), y: 0 }));
  return out;
};

function stubClient(first: QueryShape | ShapeProblem) {
  let answer = first;
  const sqlShape = vi.fn(async () => answer);
  const layout = vi.fn(placeRow);
  const client = { sqlShape, layout } as unknown as LangClient;
  return { client, sqlShape, layout, answer: (a: QueryShape | ShapeProblem) => (answer = a) };
}

function setup(first: QueryShape | ShapeProblem, over: Partial<QueryDiagramPaneProps> = {}) {
  const stub = stubClient(first);
  const onBand = vi.fn();
  const onStatus = vi.fn();
  const onClose = vi.fn();
  const props = (text: string, pos = 0): QueryDiagramPaneProps => ({
    source: { kind: "editor", docId: "t1", text, pos },
    dialect: "postgres",
    schemaKey: "c1\u0000kfc_shop",
    schemaState: "loaded",
    lang: { client: stub.client },
    onBand,
    onStatus,
    onClose,
    ...over,
  });
  const utils = render(
    <div style={{ width: 900, height: 700 }}>
      <QueryDiagramPane {...props(LATE)} />
    </div>,
  );
  const retype = (text: string, pos = 0) =>
    utils.rerender(
      <div style={{ width: 900, height: 700 }}>
        <QueryDiagramPane {...props(text, pos)} />
      </div>,
    );
  return { ...utils, ...stub, onBand, onStatus, onClose, retype };
}

const pane = () => screen.getByRole("region", { name: "Query diagram" });
const node = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
const [ORDERS, STORES, CUSTOMERS] = LATE_SHAPE.tables.map((t) => t.key);

test("the_strip_says_what_the_pane_is", async () => {
  const { onClose } = setup(LATE_SHAPE);
  const strip = within(pane()).getByRole("toolbar", { name: "Query diagram" });
  expect(strip.textContent).toContain("Query diagram");
  expect(strip.textContent).toContain("Read only");
  expect(strip.textContent).toContain("Built from the current statement, table details only, no rows");
  expect(within(strip).getByRole("button", { name: "Tidy" })).toBeTruthy();
  expect(within(strip).getByRole("button", { name: "Publish" })).toBeTruthy();
  await userEvent.click(within(strip).getByRole("button", { name: "Close diagram" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("the_late_orders_shape_draws_three_cards_two_joins_and_the_result", async () => {
  const { sqlShape, onStatus } = setup(LATE_SHAPE);
  expect(await screen.findByRole("group", { name: "Table orders o" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Table stores s" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Table customers c" })).toBeTruthy();
  expect(sqlShape).toHaveBeenCalledWith({ docId: "t1", text: LATE, dialect: "postgres", schemaKey: "c1\u0000kfc_shop", schemaState: "loaded", pos: 0 });

  const cards = screen.getAllByRole("group").filter((g) => g.classList.contains("table-card"));
  expect(cards.map((c) => c.style.width)).toEqual(["200px", "200px", "200px", "268px"]);

  const result = screen.getByRole("group", { name: "Result" });
  expect(result.textContent).toContain("4 columns, up to 50 rows");
  const late = within(result).getByText("late_orders").closest("li")!;
  expect(late.textContent).toContain("count(o.id)");
  expect(late.textContent).toContain("bigint");
  const clauses = [...result.querySelectorAll(".qd-clause")].map((c) => [c.querySelector(".qd-clause-keyword")?.textContent, c.textContent]);
  expect(clauses).toEqual([
    ["WHERE", "WHERE3 conditions on o"],
    ["GROUP BY", "GROUP BYs.name, s.city"],
    ["ORDER BY", "ORDER BYlate_orders DESC, s.name"],
    ["LIMIT", "LIMIT50"],
  ]);

  await waitFor(() => expect(document.querySelectorAll(".react-flow__edge.qd-edge-lineage")).toHaveLength(4));
  await waitFor(() => expect([...document.querySelectorAll(".qd-pill")].map((p) => p.textContent)).toEqual(["Inner join", "Left join"]));
  expect(onStatus).toHaveBeenLastCalledWith("3 tables, 2 Joins");
  expect(screen.getByText("Select a card to find its lines in the SQL.")).toBeTruthy();
});

test("a_syntax_error_keeps_the_last_drawing_and_names_the_line", async () => {
  const { answer, retype } = setup(LATE_SHAPE);
  await screen.findByRole("group", { name: "Table orders o" });
  answer({ kind: "syntax", line: 10, message: "A value is missing after >=." });
  retype(LATE.replace(">= '2026-10-01'", ">= AND"));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Line 10: a value is missing after >=. The diagram shows the last version that could be read.");
  expect(screen.getByRole("group", { name: "Table orders o" })).toBeTruthy();
});

test("a_syntax_error_with_nothing_drawn_yet_says_so", async () => {
  setup({ kind: "syntax", line: 10, message: "A value is missing after >=." });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("The diagram appears once this statement can be read. Line 10: a value is missing after >=.");
  expect(screen.queryByRole("group", { name: "Result" })).toBeNull();
});

test("an_update_clears_the_drawing_and_says_why", async () => {
  const { answer, retype } = setup(LATE_SHAPE);
  await screen.findByRole("group", { name: "Table orders o" });
  answer({ kind: "notRead", verb: "UPDATE" });
  retype("UPDATE sales.orders SET status = 'x'");
  expect(await screen.findByText("The diagram shows SELECT statements. This one is an UPDATE.")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Table orders o" })).toBeNull();
  answer({ kind: "notRead", verb: "DELETE" });
  retype("DELETE FROM sales.orders");
  expect(await screen.findByText("The diagram shows SELECT statements. This one is a DELETE.")).toBeTruthy();
});

test("no_statement_asks_for_a_click_into_one", async () => {
  setup({ kind: "noStatement" });
  expect(await screen.findByText("Click into a statement to draw it.")).toBeTruthy();
});

test("a_union_shows_its_note", async () => {
  setup({ ...LATE_SHAPE, note: "Shows the first of 2 parts of a UNION." });
  expect(await screen.findByText("Shows the first of 2 parts of a UNION.")).toBeTruthy();
});

test("selecting_a_card_bands_its_lines_and_the_result_bands_the_select_list", async () => {
  const onSelectTable = vi.fn();
  const { onBand } = setup(LATE_SHAPE, { onSelectTable });
  await screen.findByRole("group", { name: "Table orders o" });
  fireEvent.click(node(ORDERS));
  await waitFor(() => expect(onBand).toHaveBeenLastCalledWith(LATE_SHAPE.tables[0].ranges));
  expect(onSelectTable).toHaveBeenLastCalledWith("o");
  fireEvent.click(node("result"));
  await waitFor(() => expect(onBand).toHaveBeenLastCalledWith([LATE_SHAPE.result.selectRange]));
  expect(LATE.slice(LATE_SHAPE.result.selectRange.from, LATE_SHAPE.result.selectRange.to)).toMatch(/^SELECT s\.name/);
});

test("new_cards_are_placed_by_layout_and_tidy_lays_out_everything", async () => {
  const { layout, answer, retype } = setup(LATE_SHAPE);
  await screen.findByRole("group", { name: "Table orders o" });
  expect(layout).toHaveBeenCalledTimes(1);
  const first = layout.mock.calls[0][0];
  expect(first.nodes.map((n) => n.id)).toEqual([ORDERS, STORES, CUSTOMERS, "result"]);
  expect(first.nodes.map((n) => n.w)).toEqual([200, 200, 200, 268]);
  expect(first).toMatchObject({ existing: {}, pin: "result", rankdir: "LR" });
  const placed = await layout.mock.results[0].value;

  // One new table: the cards already drawn keep their places.
  const withItems = `${LATE.split("WHERE")[0]}JOIN sales.order_items i ON i.order_id = o.id\nWHERE o.status = 'late'`;
  const second = shapeOf(withItems);
  answer(second);
  retype(withItems);
  await screen.findByRole("group", { name: "Table order_items i" });
  expect(layout).toHaveBeenCalledTimes(2);
  const again = layout.mock.calls[1][0];
  expect(again.pin).toBe("result");
  expect(again.existing).toEqual({ [ORDERS]: placed[ORDERS], [STORES]: placed[STORES], [CUSTOMERS]: placed[CUSTOMERS], result: placed.result });

  await userEvent.click(screen.getByRole("button", { name: "Tidy" }));
  await waitFor(() => expect(layout).toHaveBeenCalledTimes(3));
  const tidy = layout.mock.calls[2][0];
  expect(tidy.nodes.map((n) => n.id)).toEqual([...second.tables.map((t) => t.key), "result"]);
  expect(tidy).toMatchObject({ existing: {}, pin: "result" });
});

test("publish_opens_the_publish_image_dialog_with_the_diagram_scene", async () => {
  setup(LATE_SHAPE);
  await screen.findByRole("group", { name: "Table orders o" });
  await userEvent.click(screen.getByRole("button", { name: "Publish" }));
  expect(screen.getByRole("dialog", { name: "Publish image" })).toBeTruthy();
  const { scene } = published[published.length - 1];
  expect(scene.nodes.map((n) => [n.id, n.kind, n.w])).toEqual([
    [ORDERS, "table", 200],
    [STORES, "table", 200],
    [CUSTOMERS, "table", 200],
    ["result", "result", 268],
  ]);
});

test("to_scene_draws_cards_the_result_and_every_line", () => {
  const positions: Positions = { [ORDERS]: { x: 300, y: 200 }, [STORES]: { x: 0, y: 0 }, [CUSTOMERS]: { x: 0, y: 400 }, result: { x: 600, y: 100 } };
  const scene = toScene(LATE_SHAPE, positions);
  const result = scene.nodes.find((n) => n.id === "result")!;
  expect(result).toMatchObject({ kind: "result", title: "Result", subtitle: "4 columns, up to 50 rows", x: 600, y: 100, w: 268 });
  expect(result.rows[2]).toEqual({ left: "late_orders  count(o.id)", right: "bigint" });
  expect(result.footer).toEqual(["WHERE 3 conditions on o", "GROUP BY s.name, s.city", "ORDER BY late_orders DESC, s.name", "LIMIT 50"]);
  const stores = scene.nodes.find((n) => n.id === STORES)!;
  expect(stores).toMatchObject({ title: "stores s", subtitle: "public" });
  expect(stores.rows[0]).toEqual({ left: "id", right: "int4", mark: "pk" });
  expect(scene.edges.filter((e) => e.kind === "join").map((e) => e.label)).toEqual(["Inner join", "Left join"]);
  expect(scene.edges.filter((e) => e.kind === "lineage")).toHaveLength(4);
  // Every line starts on one card's side and ends on the other's.
  const join = scene.edges.find((e) => e.label === "Inner join")!;
  expect(join.points[0].x).toBe(200);
  expect(join.points[join.points.length - 1].x).toBe(300);
});

// ---- From a Visual Query (B1, open question 2) ----

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
    { schema: null, name: "orders", kind: "table", columns: [col("id", "int", true), col("store_id"), col("total", "decimal(10,2)")] },
    { schema: null, name: "stores", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)")] },
  ],
  fks: [{ from: { schema: null, table: "orders", columns: ["store_id"] }, to: { schema: null, table: "stores", columns: ["id"] } }],
};
const VQ_SQL = "SELECT o.id\nFROM orders o\nJOIN stores s ON s.id = o.store_id";
function previewFor(): VqPreview {
  const parts: SqlPart[] = [
    { part: { kind: "select" }, fromLine: 1, toLine: 1 },
    { part: { kind: "from", table: "t1" }, fromLine: 2, toLine: 2 },
    { part: { kind: "join", join: "j1" }, fromLine: 3, toLine: 3 },
  ];
  return { query: { sql: VQ_SQL, parts, outputs: ["id"], warnings: [] }, problems: [] };
}

test("show_diagram_in_a_visual_query_draws_the_generated_sql_and_a_card_click_selects_the_query_card", async () => {
  routeInvoke({ visual_query_sql: () => previewFor() });
  const client = new LangClient(() => fakeWorker());
  const lang = { client, schemas: new SchemaCache(client, async () => SHOP) };
  const asked = vi.spyOn(client, "sqlShape");
  const model: VisualQuery = {
    ...emptyQuery("shop", "mysql"),
    tables: [
      { id: "t1", schema: null, name: "orders", alias: "o", x: 0, y: 0 },
      { id: "t2", schema: null, name: "stores", alias: "s", x: 300, y: 0 },
    ],
    joins: [{ id: "j1", left: "t1", right: "t2", kind: "inner", on: [{ leftColumn: "store_id", rightColumn: "id" }] }],
    columns: [{ table: "t1", column: "id", alias: null, aggregate: null }],
  };
  const initial: VisualTabDoc = { id: "v1", name: "late orders", connectionId: "c1", database: "shop", model, savedId: null, savedJson: null };
  function Harness() {
    const [doc, setDoc] = useState(initial);
    return (
      <ToastProvider>
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
        />
      </ToastProvider>
    );
  }
  render(<Harness />);
  const toolbar = screen.getByRole("toolbar", { name: "Visual Query" });
  const show = within(toolbar).getByRole("button", { name: /Show diagram/ });
  await waitFor(() => expect((show as HTMLButtonElement).disabled).toBe(false));
  expect(asked).not.toHaveBeenCalled();
  await userEvent.click(show);
  expect(show.getAttribute("aria-pressed")).toBe("true");
  const diagram = await screen.findByRole("region", { name: "Query diagram" });
  await waitFor(() => expect(asked).toHaveBeenCalled());
  expect(asked.mock.calls[0][0]).toMatchObject({ docId: "vq:v1", text: VQ_SQL, dialect: "mysql" });
  const storesCard = await within(diagram).findByRole("group", { name: "Table stores s" });
  const paneNode = storesCard.closest(".react-flow__node") as HTMLElement;
  act(() => {
    fireEvent.click(paneNode);
  });
  const vqNode = () => document.querySelector(`.vq-canvas .react-flow__node[data-id="t2"]`) as HTMLElement;
  await waitFor(() => expect(vqNode().className).toContain("selected"));
  // Ctrl+Shift+D hides it again.
  fireEvent.keyDown(document.body, { key: "D", code: "KeyD", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Query diagram" })).toBeNull());
  client.dispose();
});

// ---- V9: every database a statement names loads, and its tables never read "Not in the schema" ----

const ARCHIVE: SqlSchema = {
  searchPath: [],
  tables: [{ schema: null, name: "old_orders", kind: "table", columns: [col("id", "int", true), col("placed_at", "datetime")] }],
  fks: [],
};

function heldLang() {
  const client = new LangClient(() => fakeWorker());
  const held = new Map<string, () => void>();
  const loads: string[] = [];
  const cache = new SchemaCache(client, (_id, database) => {
    loads.push(database);
    return database === "archive" ? new Promise<SqlSchema>((r) => held.set(database, () => r(ARCHIVE))) : Promise.resolve(SHOP);
  });
  return { client, cache, held, loads };
}

test("a_table_in_another_mysql_database_loads_that_schema_and_shows_loading_then_its_columns", async () => {
  const { client, cache, held, loads } = heldLang();
  await cache.ensure("c1", "shop");
  const text = "SELECT a.placed_at FROM archive.old_orders a JOIN orders o ON o.id = a.id JOIN archive.nope n ON n.id = a.id";
  render(
    <div style={{ width: 900, height: 700 }}>
      <QueryDiagramPane
        source={{ kind: "editor", docId: "t1", text, pos: 0 }}
        dialect="mysql"
        schemaKey={"c1\u0000shop"}
        schemaState="loaded"
        lang={{ client }}
        schemas={{ cache, connectionId: "c1", database: "shop" }}
        onBand={() => {}}
        onClose={() => {}}
      />
    </div>,
  );
  const card = await screen.findByRole("group", { name: "Table old_orders a" });
  await waitFor(() => expect(loads).toContain("archive"));
  expect(card.textContent).toContain("Loading schema");
  expect(card.textContent).not.toContain("Not in the schema");
  expect(screen.getByRole("group", { name: "Table nope n" }).textContent).not.toContain("Not in the schema");
  act(() => held.get("archive")!());
  await waitFor(() => expect(screen.getByRole("group", { name: "Table old_orders a" }).textContent).toContain("datetime"));
  const loaded = screen.getByRole("group", { name: "Table old_orders a" });
  expect(loaded.textContent).not.toContain("Loading schema");
  expect(loaded.textContent).not.toContain("Not in the schema");
  expect(loaded.classList.contains("card-dashed")).toBe(false);
  // A table the loaded database does not have still says so.
  await waitFor(() => expect(screen.getByRole("group", { name: "Table nope n" }).textContent).toContain("Not in the schema"));
  client.dispose();
});

test("the_pane_draws_unknown_tables_derived_cards_self_joins_loading_and_values", async () => {
  const unknownShape = shapeOf("SELECT x.id FROM sales.nowhere x");
  const { answer, retype } = setup(unknownShape);
  const unknown = await screen.findByRole("group", { name: "Table nowhere x" });
  expect(unknown.textContent).toContain("Not in the schema");
  expect(unknown.classList.contains("card-dashed")).toBe(true);
  expect(unknown.classList.contains("card-danger")).toBe(true);

  const derived = shapeOf("WITH late AS (SELECT o.id FROM sales.orders o) SELECT l.id FROM late l");
  answer(derived);
  retype("WITH late AS (SELECT o.id FROM sales.orders o) SELECT l.id FROM late l");
  const card = await screen.findByRole("group", { name: /^Derived late/ });
  expect(card.textContent).toContain("derived");

  const self = shapeOf("SELECT o.id FROM sales.orders o JOIN sales.orders o2 ON o2.id = o.id");
  answer(self);
  retype("SELECT o.id FROM sales.orders o JOIN sales.orders o2 ON o2.id = o.id");
  expect(await screen.findByRole("group", { name: "Table orders o2" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "Table orders o" })).toBeTruthy();

  const loading = queryShape(analyzeSql("SELECT o.id FROM sales.orders o", "postgres", null), 0, "loading") as QueryShape;
  answer(loading);
  retype("SELECT o.id FROM sales.orders o");
  await waitFor(() => expect(screen.getByRole("group", { name: "Table orders o" }).textContent).toContain("Loading schema"));

  const values = shapeOf("VALUES (1, 'a')");
  answer(values);
  retype("VALUES (1, 'a')");
  await waitFor(() => expect(screen.queryByRole("group", { name: "Table orders o" })).toBeNull());
  expect(screen.getByRole("group", { name: "Result" }).textContent).toContain("column1");
});

test("a_derived_card_with_two_outputs_of_one_name_keeps_both_rows", async () => {
  const text = "SELECT d.id FROM (SELECT a.id, b.id FROM sales.orders a JOIN stores b ON b.id = a.store_id) d";
  setup(shapeOf(text));
  const card = await screen.findByRole("group", { name: /^Derived/ });
  expect(card.querySelectorAll("li.qd-row")).toHaveLength(2);
  const ids = [...card.querySelectorAll(".react-flow__handle")].map((h) => h.getAttribute("data-handleid"));
  expect(new Set(ids).size).toBe(ids.length);
});

test("to_scene_draws_a_line_for_every_on_pair", () => {
  const s = shapeOf("SELECT o.id FROM sales.orders o JOIN sales.order_items i ON i.order_id = o.id AND i.id = o.id");
  const scene = toScene(s, {});
  expect(scene.edges.filter((e) => e.kind === "join")).toHaveLength(2);
  expect(scene.edges.filter((e) => e.kind === "join" && e.label)).toHaveLength(1);
});

test("show_diagram_loads_the_other_database_a_visual_query_card_names", async () => {
  const sql = "SELECT a.id\nFROM archive.old_orders a";
  routeInvoke({
    visual_query_sql: () => ({
      query: { sql, parts: [{ part: { kind: "select" }, fromLine: 1, toLine: 1 }, { part: { kind: "from", table: "t1" }, fromLine: 2, toLine: 2 }], outputs: ["id"], warnings: [] },
      problems: [],
    }),
  });
  const { client, cache, held } = heldLang();
  const model: VisualQuery = {
    ...emptyQuery("shop", "mysql"),
    tables: [{ id: "t1", schema: "archive", name: "old_orders", alias: "a", x: 0, y: 0 }],
    columns: [{ table: "t1", column: "id", alias: null, aggregate: null }],
  };
  render(
    <ToastProvider>
      <VisualQueryTab
        doc={{ id: "v1", name: "old", connectionId: "c1", database: "shop", model, savedId: null, savedJson: null }}
        connection={kestrel}
        open
        group={null}
        visible
        lang={{ client, schemas: cache }}
        rowEstimate={() => null}
        onChange={() => {}}
        onOpenInEditor={() => {}}
        onSaved={() => {}}
        onOpenConnection={() => {}}
      />
    </ToastProvider>,
  );
  const show = within(screen.getByRole("toolbar", { name: "Visual Query" })).getByRole("button", { name: /Show diagram/ });
  await waitFor(() => expect((show as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(show);
  const diagram = await screen.findByRole("region", { name: "Query diagram" });
  const card = await within(diagram).findByRole("group", { name: "Table old_orders a" });
  expect(card.textContent).not.toContain("Not in the schema");
  expect(card.textContent).toContain("Loading schema");
  act(() => held.get("archive")!());
  await waitFor(() => expect(within(diagram).getByRole("group", { name: "Table old_orders a" }).textContent).toContain("int"));
  expect(within(diagram).getByRole("group", { name: "Table old_orders a" }).textContent).not.toContain("Not in the schema");
  client.dispose();
});

test("a_card_whose_database_did_not_load_offers_try_again", async () => {
  const client = new LangClient(() => fakeWorker());
  let fail = true;
  const loads: string[] = [];
  const cache = new SchemaCache(client, (_id, database) => {
    loads.push(database);
    if (database === "archive" && fail) return Promise.reject(new Error("timed out"));
    return Promise.resolve(database === "archive" ? ARCHIVE : SHOP);
  });
  await cache.ensure("c1", "shop");
  const text = "SELECT a.placed_at FROM archive.old_orders a";
  render(
    <div style={{ width: 900, height: 700 }}>
      <QueryDiagramPane
        source={{ kind: "editor", docId: "t1", text, pos: 0 }}
        dialect="mysql"
        schemaKey={"c1\u0000shop"}
        schemaState="loaded"
        lang={{ client }}
        schemas={{ cache, connectionId: "c1", database: "shop" }}
        onBand={() => {}}
        onClose={() => {}}
      />
    </div>,
  );
  await waitFor(() => expect(screen.getByRole("group", { name: "Table old_orders a" }).textContent).toContain("Schema did not load."));
  fail = false;
  await userEvent.click(within(screen.getByRole("group", { name: "Table old_orders a" })).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("group", { name: "Table old_orders a" }).textContent).toContain("datetime"));
  expect(loads.filter((d) => d === "archive")).toHaveLength(2);
  client.dispose();
});

test("a_hidden_pane_does_no_work_until_it_shows_again", async () => {
  const { client, cache, held, loads } = heldLang();
  await cache.ensure("c1", "shop");
  const shapes = vi.spyOn(client, "sqlShape");
  const text = "SELECT a.placed_at FROM archive.old_orders a";
  const pane = (visible: boolean) => (
    <div style={{ width: 900, height: 700 }}>
      <QueryDiagramPane
        source={{ kind: "editor", docId: "t1", text, pos: 0 }}
        dialect="mysql"
        schemaKey={"c1\u0000shop"}
        schemaState="loaded"
        lang={{ client }}
        schemas={{ cache, connectionId: "c1", database: "shop" }}
        visible={visible}
        onBand={() => {}}
        onClose={() => {}}
      />
    </div>
  );
  const { rerender } = render(pane(true));
  await screen.findByRole("group", { name: "Table old_orders a" });
  await waitFor(() => expect(loads).toContain("archive"));
  rerender(pane(false));
  const before = shapes.mock.calls.length;
  // The other database arrives, and another tab reloads the home one: the hidden pane merges and asks nothing.
  act(() => held.get("archive")!());
  await act(async () => {
    cache.invalidate("c1", "shop");
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(shapes.mock.calls.length).toBe(before);
  // Shown again, it catches up.
  rerender(pane(true));
  await waitFor(() => expect(screen.getByRole("group", { name: "Table old_orders a" }).textContent).toContain("datetime"));
  client.dispose();
});
