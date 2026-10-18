import { describe, expect, it } from "vitest";
import type { ColumnRef, SqlFk, SqlSchema, SqlTable, VisualQuery } from "../api/types";
import {
  addFilter,
  addSort,
  addTable,
  aliasFor,
  autoGroupBy,
  columnTypes,
  connectColumns,
  countLine,
  crossGroups,
  crossTables,
  editFilter,
  editSort,
  emptyQuery,
  joinCandidates,
  loadingTables,
  mergeSchemas,
  missing,
  moveOutput,
  moveTable,
  pendingTables,
  pickForeignKey,
  removeCondition,
  removeFilter,
  removeJoin,
  removeSort,
  removeTable,
  setAggregate,
  setAlias,
  setDistinct,
  setGroupBy,
  setJoinKind,
  setLimit,
  setOutputName,
  setRoot,
  swapSides,
  toggleColumn,
  type VqSchema,
} from "./model";

// Fixtures ------------------------------------------------------------------

function table(schema: string | null, name: string, cols: [string, string, boolean?][]): SqlTable {
  return { schema, name, kind: "table", columns: cols.map(([n, t, pk]) => ({ name: n, typeName: t, pk: pk ?? false })) };
}

function fk(
  schema: string | null,
  from: string,
  fromCols: string[],
  to: string,
  toCols: string[],
  extra: Partial<SqlFk> = {},
): SqlFk {
  return { from: { schema, table: from, columns: fromCols }, to: { schema, table: to, columns: toCols }, ...extra };
}

const ORDERS = table(null, "orders", [
  ["id", "int", true],
  ["store_id", "int"],
  ["pickup_store_id", "int"],
  ["customer_id", "int"],
  ["status", "varchar(16)"],
  ["total", "numeric(12,2)"],
  ["placed_at", "date"],
]);
const STORES = table(null, "stores", [
  ["id", "int", true],
  ["name", "varchar(120)"],
  ["city", "varchar(60)"],
]);
const CUSTOMERS = table(null, "customers", [
  ["id", "int", true],
  ["name", "varchar(80)"],
]);
const MENU_ITEMS = table(null, "menu_items", [
  ["id", "int", true],
  ["category", "varchar(40)"],
]);
const ORDER_ITEMS = table(null, "order_items", [
  ["order_id", "int"],
  ["store_id", "int"],
  ["menu_item_id", "int"],
  ["qty", "int"],
]);

const STORE_KEY = fk(null, "orders", ["store_id"], "stores", ["id"], { name: "fk_orders_store" });
const PICKUP_KEY = fk(null, "orders", ["pickup_store_id"], "stores", ["id"], {
  name: "fk_orders_pickup",
  comment: "Where the order is collected",
});
const CUSTOMER_KEY = fk(null, "orders", ["customer_id"], "customers", ["id"]);
const LINE_KEY = fk(null, "order_items", ["order_id", "store_id"], "orders", ["id", "store_id"]);

const TABLES = [ORDERS, STORES, CUSTOMERS, MENU_ITEMS, ORDER_ITEMS];
/** `orders` references `stores` once. */
const SHOP: VqSchema = { tables: TABLES, fks: [STORE_KEY, CUSTOMER_KEY, LINE_KEY], loading: false, loadingDatabases: [] };
/** `orders` references `stores` twice (`store_id` and `pickup_store_id`). */
const TWICE: VqSchema = { tables: TABLES, fks: [STORE_KEY, PICKUP_KEY, CUSTOMER_KEY, LINE_KEY], loading: false, loadingDatabases: [] };

function counter() {
  let n = 0;
  return () => `id${++n}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Adds each table by name (schema null) at a stepped position; every input is frozen, so a mutation throws. */
function build(names: string[], schema: VqSchema = SHOP, ids = counter()) {
  let q = deepFreeze(emptyQuery("shop", "mysql"));
  const results = [];
  for (const [i, name] of names.entries()) {
    const r = addTable(q, { schema: null, name }, schema, { x: i * 300, y: 0 }, ids);
    results.push(r);
    q = deepFreeze(r.query);
  }
  return { q, results, ids };
}

const idOf = (q: VisualQuery, alias: string) => q.tables.find((t) => t.alias === alias)!.id;
const ref = (q: VisualQuery, alias: string, column: string): ColumnRef => ({ table: idOf(q, alias), column });

/** Every table id the model mentions anywhere outside `tables`. */
function referencedIds(q: VisualQuery): Set<string> {
  const ids = new Set<string>();
  for (const j of q.joins) ids.add(j.left).add(j.right);
  for (const c of q.columns) ids.add(c.table);
  for (const f of q.filters) if (f.table) ids.add(f.table);
  for (const s of q.orderBy) if (s.target.kind === "column") ids.add(s.target.table);
  if (q.groupBy.kind === "manual") for (const c of q.groupBy.columns) ids.add(c.table);
  return ids;
}

// Tests ---------------------------------------------------------------------

describe("emptyQuery", () => {
  it("starts at version 1 with Auto GROUP BY", () => {
    expect(emptyQuery("shop", "mysql")).toEqual({
      version: 1,
      database: "shop",
      dialect: "mysql",
      tables: [],
      joins: [],
      columns: [],
      filters: [],
      groupBy: { kind: "auto" },
      orderBy: [],
      limit: null,
      distinct: false,
    });
  });
});

describe("aliasFor", () => {
  it("takes the initials of the name's words", () => {
    expect(aliasFor("order_items", new Set())).toBe("oi");
    expect(aliasFor("stores", new Set())).toBe("s");
    expect(aliasFor("OrderItems", new Set())).toBe("oi");
    expect(aliasFor("Order Items", new Set())).toBe("oi");
    expect(aliasFor("café_menu", new Set())).toBe("cm");
  });

  it("adds a number when the alias is taken", () => {
    expect(aliasFor("stores", new Set(["s"]))).toBe("s2");
    expect(aliasFor("stores", new Set(["s", "s2"]))).toBe("s3");
    expect(aliasFor("stores", new Set(["S"]))).toBe("s2");
  });

  it("skips reserved words", () => {
    expect(aliasFor("or_rows", new Set())).toBe("or2");
    expect(aliasFor("in_stock", new Set())).toBe("is2");
    expect(aliasFor("on_order", new Set(["oo"]))).toBe("oo2");
  });

  it("falls back to t for a name with no word", () => {
    expect(aliasFor("__", new Set())).toBe("t");
  });
});

describe("addTable", () => {
  it("one Foreign Key gives a solid Inner Join, s.id = o.store_id", () => {
    const { q, results } = build(["orders", "stores"]);
    expect(q.tables.map((t) => [t.name, t.alias, t.x])).toEqual([
      ["orders", "o", 0],
      ["stores", "s", 300],
    ]);
    expect(q.joins).toEqual([
      { id: "id3", left: idOf(q, "o"), right: idOf(q, "s"), kind: "inner", on: [{ leftColumn: "store_id", rightColumn: "id" }] },
    ]);
    expect(results[1].joinedTo).toEqual(["orders"]);
    expect(results[1].pick).toBeNull();
    expect(results[0].joinedTo).toEqual([]);
  });

  it("joins in the reverse direction too (stores, then orders)", () => {
    const { q } = build(["stores", "orders"]);
    expect(q.joins).toHaveLength(1);
    expect(q.joins[0]).toMatchObject({
      left: idOf(q, "s"),
      right: idOf(q, "o"),
      kind: "inner",
      on: [{ leftColumn: "id", rightColumn: "store_id" }],
    });
  });

  it("a composite key gives two pairs", () => {
    const { q } = build(["orders", "order_items"]);
    expect(q.joins[0].on).toEqual([
      { leftColumn: "id", rightColumn: "order_id" },
      { leftColumn: "store_id", rightColumn: "store_id" },
    ]);
  });

  it("two keys give one pending Join with two choices and pick set", () => {
    const { q, results } = build(["orders", "stores"], TWICE);
    expect(q.joins).toHaveLength(1);
    const join = q.joins[0];
    expect(join.on).toEqual([]);
    expect(join.pending).toEqual([
      { name: "store_id", on: [{ leftColumn: "store_id", rightColumn: "id" }], comment: null },
      { name: "pickup_store_id", on: [{ leftColumn: "pickup_store_id", rightColumn: "id" }], comment: "Where the order is collected" },
    ]);
    expect(results[1].pick).toBe(join.id);
    expect(results[1].joinedTo).toEqual([]);
    expect(pendingTables(q)).toEqual([idOf(q, "s")]);
    expect(crossTables(q)).toEqual([]);
  });

  it("no key gives no Join and a CROSS JOIN card", () => {
    const { q, results } = build(["orders", "menu_items"]);
    expect(q.joins).toEqual([]);
    expect(results[1].joinedTo).toEqual([]);
    expect(crossTables(q)).toEqual([idOf(q, "mi")]);
  });

  it("joins every table on the canvas it has one key with", () => {
    const { q, results } = build(["customers", "stores", "orders"]);
    expect(q.joins.map((j) => [j.left, j.right])).toEqual([
      [idOf(q, "c"), idOf(q, "o")],
      [idOf(q, "s"), idOf(q, "o")],
    ]);
    expect(results[2].joinedTo).toEqual(["customers", "stores"]);
  });

  it("adding a table already on the canvas gives it a new alias", () => {
    const { q } = build(["stores", "stores"]);
    expect(q.tables.map((t) => t.alias)).toEqual(["s", "s2"]);
    expect(new Set(q.tables.map((t) => t.id)).size).toBe(2);
  });
});

describe("same table name twice", () => {
  it("same_name_in_two_schemas_gets_o_and_o2", () => {
    const pg: VqSchema = {
      tables: [
        { ...ORDERS, schema: "public" },
        { ...ORDERS, schema: "archive" },
        { ...STORES, schema: "public" },
      ],
      fks: [fk("public", "orders", ["store_id"], "stores", ["id"])],
      loading: false,
      loadingDatabases: [],
    };
    const ids = counter();
    let q = emptyQuery("shop", "postgres");
    q = addTable(q, { schema: "public", name: "orders" }, pg, { x: 0, y: 0 }, ids).query;
    q = addTable(q, { schema: "archive", name: "orders" }, pg, { x: 300, y: 0 }, ids).query;
    q = addTable(q, { schema: "public", name: "stores" }, pg, { x: 600, y: 0 }, ids).query;
    expect(q.tables.map((t) => [t.schema, t.name, t.alias])).toEqual([
      ["public", "orders", "o"],
      ["archive", "orders", "o2"],
      ["public", "stores", "s"],
    ]);
    expect(new Set(q.tables.map((t) => t.id)).size).toBe(3);
    // Only public.orders has the key to stores.
    expect(q.joins.map((j) => [j.left, j.right])).toEqual([[idOf(q, "o"), idOf(q, "s")]]);
  });
});

describe("pickForeignKey", () => {
  it("a number takes that key", () => {
    const { q, results } = build(["orders", "stores"], TWICE);
    const next = pickForeignKey(q, results[1].pick!, 1, TWICE);
    expect(next.joins).toEqual([
      { id: results[1].pick, left: idOf(q, "o"), right: idOf(q, "s"), kind: "inner", on: [{ leftColumn: "pickup_store_id", rightColumn: "id" }] },
    ]);
    expect(pendingTables(next)).toEqual([]);
  });

  it("both_adds_s2", () => {
    const { q, results, ids } = build(["orders", "stores"], TWICE);
    const next = pickForeignKey(q, results[1].pick!, "both", TWICE, ids);
    expect(next.tables.map((t) => [t.name, t.alias])).toEqual([
      ["orders", "o"],
      ["stores", "s"],
      ["stores", "s2"],
    ]);
    expect(next.joins).toEqual([
      { id: results[1].pick, left: idOf(q, "o"), right: idOf(q, "s"), kind: "inner", on: [{ leftColumn: "store_id", rightColumn: "id" }] },
      {
        id: expect.any(String),
        left: idOf(q, "o"),
        right: idOf(next, "s2"),
        kind: "inner",
        on: [{ leftColumn: "pickup_store_id", rightColumn: "id" }],
      },
    ]);
    expect(next.joins[1].id).not.toBe(next.joins[0].id);
    const s2 = next.tables[2];
    expect(s2.id).not.toBe(idOf(q, "s"));
    expect(s2.y).toBeGreaterThan(next.tables[1].y);
  });

  it("an unknown join id changes nothing", () => {
    const { q } = build(["orders", "stores"], TWICE);
    expect(pickForeignKey(q, "nope", 0, TWICE)).toBe(q);
  });
});

describe("connectColumns", () => {
  it("replaces the condition of an existing Join", () => {
    const { q } = build(["orders", "stores"]);
    const next = connectColumns(q, ref(q, "o", "pickup_store_id"), ref(q, "s", "id"), false);
    expect(next.joins).toHaveLength(1);
    expect(next.joins[0].on).toEqual([{ leftColumn: "pickup_store_id", rightColumn: "id" }]);
  });

  it("orients the pair to the Join when dragged from its right side", () => {
    const { q } = build(["orders", "stores"]);
    const next = connectColumns(q, ref(q, "s", "id"), ref(q, "o", "pickup_store_id"), false);
    expect(next.joins[0].on).toEqual([{ leftColumn: "pickup_store_id", rightColumn: "id" }]);
  });

  it("Shift appends a pair", () => {
    const { q } = build(["orders", "stores"]);
    const next = connectColumns(q, ref(q, "o", "status"), ref(q, "s", "city"), true);
    expect(next.joins[0].on).toEqual([
      { leftColumn: "store_id", rightColumn: "id" },
      { leftColumn: "status", rightColumn: "city" },
    ]);
    // The same pair again is not added twice.
    expect(connectColumns(next, ref(q, "o", "status"), ref(q, "s", "city"), true).joins[0].on).toHaveLength(2);
  });

  it("a drop on a pending Join settles it", () => {
    const { q } = build(["orders", "stores"], TWICE);
    const next = connectColumns(q, ref(q, "o", "store_id"), ref(q, "s", "id"), false);
    expect(next.joins[0].pending).toBeUndefined();
    expect(next.joins[0].on).toEqual([{ leftColumn: "store_id", rightColumn: "id" }]);
  });

  it("a new pair of tables makes an Inner Join", () => {
    const { q } = build(["orders", "menu_items"]);
    const next = connectColumns(q, ref(q, "mi", "id"), ref(q, "o", "id"), false, () => "j9");
    expect(next.joins).toEqual([
      { id: "j9", left: idOf(q, "mi"), right: idOf(q, "o"), kind: "inner", on: [{ leftColumn: "id", rightColumn: "id" }] },
    ]);
    expect(crossTables(next)).toEqual([]);
  });

  it("a column dropped on its own card changes nothing", () => {
    const { q } = build(["orders"]);
    expect(connectColumns(q, ref(q, "o", "id"), ref(q, "o", "store_id"), false)).toBe(q);
  });
});

describe("Join edits", () => {
  it("setJoinKind sets the kind", () => {
    const { q } = build(["orders", "stores"]);
    expect(setJoinKind(q, q.joins[0].id, "left").joins[0].kind).toBe("left");
  });

  it("removeCondition drops one pair, and the Join with its last pair", () => {
    const { q } = build(["orders", "order_items"]);
    const one = removeCondition(q, q.joins[0].id, 0);
    expect(one.joins[0].on).toEqual([{ leftColumn: "store_id", rightColumn: "store_id" }]);
    const none = removeCondition(one, q.joins[0].id, 0);
    expect(none.joins).toEqual([]);
    expect(crossTables(none)).toEqual([idOf(q, "oi")]);
  });

  it("swapSides swaps tables, pairs and Left or Right", () => {
    const { q } = build(["orders", "stores"]);
    const left = setJoinKind(q, q.joins[0].id, "left");
    expect(swapSides(left, q.joins[0].id).joins[0]).toEqual({
      id: q.joins[0].id,
      left: idOf(q, "s"),
      right: idOf(q, "o"),
      kind: "right",
      on: [{ leftColumn: "id", rightColumn: "store_id" }],
    });
    expect(swapSides(q, q.joins[0].id).joins[0].kind).toBe("inner");
  });

  it("swapSides leaves a pending Join alone, so Both still copies the added card", () => {
    const { q, results, ids } = build(["orders", "stores"], TWICE);
    const swapped = swapSides(q, q.joins[0].id);
    expect(swapped).toBe(q);
    const both = pickForeignKey(swapped, results[1].pick!, "both", TWICE, ids);
    expect(both.tables.map((t) => t.alias)).toEqual(["o", "s", "s2"]);
  });

  it("a Join with pending: [] cannot be picked, counts as to pick, and a drop settles it", () => {
    const { q } = build(["orders", "stores"]);
    const stuck: VisualQuery = { ...q, joins: [{ ...q.joins[0], on: [], pending: [] }] };
    expect(pickForeignKey(stuck, q.joins[0].id, 0, SHOP)).toBe(stuck);
    expect(countLine(stuck)).toBe("2 tables, 1 to pick");
    expect(pendingTables(stuck)).toEqual([idOf(q, "s")]);
    const settledQ = connectColumns(stuck, ref(q, "o", "store_id"), ref(q, "s", "id"), false);
    expect(settledQ.joins[0].pending).toBeUndefined();
    expect(countLine(settledQ)).toBe("2 tables, 1 Join");
  });

  it("removeJoin leaves a CROSS JOIN card", () => {
    const { q } = build(["orders", "stores"]);
    const next = removeJoin(q, q.joins[0].id);
    expect(next.joins).toEqual([]);
    expect(crossTables(next)).toEqual([idOf(q, "s")]);
  });
});

describe("removeTable", () => {
  it("removing_the_root_promotes_the_next_table", () => {
    let { q } = build(["orders", "stores", "customers"]);
    const o = idOf(q, "o");
    q = toggleColumn(q, o, "id");
    q = toggleColumn(q, idOf(q, "s"), "name");
    q = toggleColumn(q, idOf(q, "c"), "name");
    q = addFilter(q, { table: o, column: "status", op: "eq", values: ["late"] });
    q = addSort(q, { target: { kind: "column", table: o, column: "placed_at" }, dir: "desc" });
    q = addSort(q, { target: { kind: "output", index: 2 }, dir: "asc" });
    q = setGroupBy(q, { kind: "manual", columns: [ref(q, "o", "status"), ref(q, "s", "name")] });

    const next = removeTable(deepFreeze(q), o);
    expect(next.tables.map((t) => t.alias)).toEqual(["s", "c"]);
    expect(next.joins).toEqual([]);
    expect(next.columns.map((c) => c.column)).toEqual(["name", "name"]);
    expect(next.filters).toEqual([]);
    expect(next.orderBy).toEqual([{ target: { kind: "output", index: 1 }, dir: "asc" }]);
    expect(next.groupBy).toEqual({ kind: "manual", columns: [ref(q, "s", "name")] });
    expect(referencedIds(next).has(o)).toBe(false);
    // stores is the root now; customers has no Join to it.
    expect(crossTables(next)).toEqual([idOf(q, "c")]);
  });

  it("removing_a_middle_card_leaves_cross_join_cards", () => {
    let { q } = build(["stores", "orders", "order_items"]);
    expect(q.joins).toHaveLength(2);
    expect(crossTables(q)).toEqual([]);
    q = toggleColumn(q, idOf(q, "oi"), "qty");
    const next = removeTable(q, idOf(q, "o"));
    expect(next.tables.map((t) => t.alias)).toEqual(["s", "oi"]);
    expect(next.joins).toEqual([]);
    expect(crossTables(next)).toEqual([idOf(q, "oi")]);
    expect(next.columns).toEqual([{ table: idOf(q, "oi"), column: "qty", alias: null, aggregate: null }]);
    expect(referencedIds(next).has(idOf(q, "o"))).toBe(false);
  });

  it("removing the last table gives the empty model back", () => {
    const { q } = build(["orders"]);
    const next = removeTable(q, idOf(q, "o"));
    expect(next.tables).toEqual([]);
    expect(countLine(next)).toBe("No tables");
  });
});

describe("tables", () => {
  it("setRoot moves the table to the front", () => {
    const { q } = build(["orders", "stores", "menu_items"]);
    const next = setRoot(q, idOf(q, "mi"));
    expect(next.tables.map((t) => t.alias)).toEqual(["mi", "o", "s"]);
    expect(crossTables(next)).toEqual([idOf(q, "o"), idOf(q, "s")]);
  });

  it("setAlias renames, refusing an empty or taken alias", () => {
    const { q } = build(["orders", "stores"]);
    expect(setAlias(q, idOf(q, "o"), " ord ").tables[0].alias).toBe("ord");
    expect(setAlias(q, idOf(q, "o"), "S")).toBe(q);
    expect(setAlias(q, idOf(q, "o"), "  ")).toBe(q);
  });

  it("moveTable sets the position", () => {
    const { q } = build(["orders"]);
    expect(moveTable(q, idOf(q, "o"), { x: 40, y: 80 }).tables[0]).toMatchObject({ x: 40, y: 80 });
  });
});

describe("columns", () => {
  function ticked() {
    let { q } = build(["orders", "stores"]);
    q = toggleColumn(q, idOf(q, "s"), "name");
    q = toggleColumn(q, idOf(q, "o"), "id");
    q = toggleColumn(q, idOf(q, "o"), "total");
    return deepFreeze(q);
  }

  it("ticking appends the column", () => {
    const q = ticked();
    expect(q.columns.map((c) => c.column)).toEqual(["name", "id", "total"]);
    expect(q.columns[0]).toEqual({ table: idOf(q, "s"), column: "name", alias: null, aggregate: null });
  });

  it("untick removes the column and its sorts, renumbers the rest, and keeps a GROUP BY by hand", () => {
    let q = ticked();
    q = addSort(q, { target: { kind: "output", index: 1 }, dir: "desc" });
    q = addSort(q, { target: { kind: "output", index: 2 }, dir: "asc" });
    q = addSort(q, { target: { kind: "column", table: idOf(q, "o"), column: "id" }, dir: "asc" });
    q = setGroupBy(q, { kind: "manual", columns: [ref(q, "o", "id"), ref(q, "s", "name")] });
    const next = toggleColumn(deepFreeze(q), idOf(q, "o"), "id");
    expect(next.columns.map((c) => c.column)).toEqual(["name", "total"]);
    expect(next.orderBy).toEqual([{ target: { kind: "output", index: 1 }, dir: "asc" }]);
    // The by-hand list is the user's: hiding o.id must not change the grouping.
    expect(next.groupBy).toEqual({ kind: "manual", columns: [ref(q, "o", "id"), ref(q, "s", "name")] });
  });

  it("moveOutput reorders and renumbers output sorts", () => {
    let q = ticked();
    q = addSort(q, { target: { kind: "output", index: 0 }, dir: "asc" });
    q = addSort(q, { target: { kind: "output", index: 2 }, dir: "desc" });
    const next = moveOutput(deepFreeze(q), 2, 0);
    expect(next.columns.map((c) => c.column)).toEqual(["total", "name", "id"]);
    expect(next.orderBy).toEqual([
      { target: { kind: "output", index: 1 }, dir: "asc" },
      { target: { kind: "output", index: 0 }, dir: "desc" },
    ]);
    expect(moveOutput(q, 0, 9)).toBe(q);
  });

  it("setAggregate and setOutputName edit one output", () => {
    const q = ticked();
    const next = setOutputName(setAggregate(q, 1, "count"), 1, "orders");
    expect(next.columns[1]).toMatchObject({ aggregate: "count", alias: "orders" });
    expect(setOutputName(next, 1, null).columns[1].alias).toBeNull();
    expect(setOutputName(next, 1, "  ").columns[1].alias).toBeNull();
  });

  it("autoGroupBy lists the outputs without an aggregate, in order", () => {
    const q = ticked();
    expect(autoGroupBy(q)).toEqual([]);
    const grouped = setAggregate(q, 1, "count");
    expect(autoGroupBy(grouped)).toEqual([ref(q, "s", "name"), ref(q, "o", "total")]);
  });

  it("setGroupBy switches between Auto and by hand", () => {
    const q = ticked();
    const manual = setGroupBy(q, { kind: "manual", columns: [ref(q, "s", "name")] });
    expect(manual.groupBy).toEqual({ kind: "manual", columns: [ref(q, "s", "name")] });
    expect(setGroupBy(manual, { kind: "auto" }).groupBy).toEqual({ kind: "auto" });
  });
});

describe("filters, sorts, limit and distinct", () => {
  it("addFilter, editFilter and removeFilter", () => {
    const { q } = build(["orders"]);
    const o = idOf(q, "o");
    let next = addFilter(q);
    // The root card, no column: the Core says "Pick a column for filter 1.", not "names a table that is not in the query".
    expect(next.filters).toEqual([{ joiner: "and", table: o, column: "", op: "eq", values: [] }]);
    expect(addFilter(emptyQuery(null, "mysql")).filters[0].table).toBe("");
    next = editFilter(next, 0, { table: o, column: "status", values: ["late"] });
    next = addFilter(next, { joiner: "or", table: o, column: "total", op: "gt", values: ["100"] });
    expect(next.filters[0]).toEqual({ joiner: "and", table: o, column: "status", op: "eq", values: ["late"] });
    expect(removeFilter(next, 0).filters.map((f) => f.column)).toEqual(["total"]);
    expect(editFilter(next, 7, { column: "x" })).toBe(next);
  });

  it("addSort replaces the direction of a target already sorted", () => {
    const { q } = build(["orders"]);
    let next = addSort(q, { target: { kind: "output", index: 0 }, dir: "asc" });
    next = addSort(next, { target: { kind: "output", index: 0 }, dir: "desc" });
    expect(next.orderBy).toEqual([{ target: { kind: "output", index: 0 }, dir: "desc" }]);
  });

  it("editSort and removeSort", () => {
    const { q } = build(["orders"]);
    let next = addSort(q, { target: { kind: "output", index: 0 }, dir: "asc" });
    next = addSort(next, { target: { kind: "column", table: idOf(q, "o"), column: "placed_at" }, dir: "asc" });
    next = editSort(next, 1, { dir: "desc" });
    expect(next.orderBy[1].dir).toBe("desc");
    expect(removeSort(next, 0).orderBy).toEqual([
      { target: { kind: "column", table: idOf(q, "o"), column: "placed_at" }, dir: "desc" },
    ]);
  });

  it("setLimit keeps whole numbers from 0 up and null", () => {
    const q = emptyQuery(null, "sqlite");
    expect(setLimit(q, 50).limit).toBe(50);
    expect(setLimit(q, 0).limit).toBe(0);
    expect(setLimit(setLimit(q, 50), null).limit).toBeNull();
    expect(setLimit(q, -1).limit).toBeNull();
    expect(setLimit(q, 2.7).limit).toBe(2);
  });

  it("setDistinct", () => {
    const q = emptyQuery(null, "sqlite");
    expect(setDistinct(q, true).distinct).toBe(true);
    expect(setDistinct(setDistinct(q, true), false).distinct).toBe(false);
  });
});

describe("countLine", () => {
  it("names tables, Joins and picks", () => {
    expect(countLine(emptyQuery(null, "mysql"))).toBe("No tables");
    expect(countLine(build(["orders"]).q)).toBe("1 table");
    expect(countLine(build(["orders", "menu_items"]).q)).toBe("2 tables");
    expect(countLine(build(["orders", "stores"]).q)).toBe("2 tables, 1 Join");
    expect(countLine(build(["customers", "stores", "orders"]).q)).toBe("3 tables, 2 Joins");
    expect(countLine(build(["customers", "orders", "stores"], TWICE).q)).toBe("3 tables, 1 Join, 1 to pick");
  });
});

describe("pendingTables", () => {
  it("lists the table behind a pending Join and what is reachable only through it", () => {
    // stores is the root; orders waits for a pick, and order_items is reachable only through orders.
    const { q } = build(["stores", "orders", "order_items"], TWICE);
    expect(q.joins[0].pending).toHaveLength(2);
    expect(pendingTables(q)).toEqual([idOf(q, "o"), idOf(q, "oi")]);
    expect(crossTables(q)).toEqual([]);
  });
});

describe("missing", () => {
  it("flags a dropped table and a dropped column", () => {
    let { q } = build(["orders", "stores", "customers"]);
    q = toggleColumn(q, idOf(q, "o"), "status");
    q = toggleColumn(q, idOf(q, "c"), "name");
    q = addFilter(q, { table: idOf(q, "o"), column: "placed_at", op: "isNull", values: [] });
    const now: VqSchema = {
      tables: [table(null, "orders", [["id", "int", true], ["store_id", "int"], ["customer_id", "int"]]), STORES],
      fks: [],
      loading: false,
      loadingDatabases: [],
    };
    expect(missing(q, now)).toEqual({
      tables: [idOf(q, "c")],
      columns: [ref(q, "o", "status"), ref(q, "o", "placed_at")],
    });
    expect(missing(q, SHOP)).toEqual({ tables: [], columns: [] });
    expect(missing(q, { ...now, loading: true })).toEqual({ tables: [], columns: [] });
  });
});

describe("columnTypes", () => {
  it("maps table ids to column types", () => {
    const { q } = build(["stores", "menu_items"]);
    expect(columnTypes(q, SHOP)).toEqual({
      [idOf(q, "s")]: { id: "int", name: "varchar(120)", city: "varchar(60)" },
      [idOf(q, "mi")]: { id: "int", category: "varchar(40)" },
    });
  });
});

describe("joinCandidates", () => {
  it("puts int columns first for o.store_id, then by card order", () => {
    const { q } = build(["orders", "stores", "customers"]);
    expect(joinCandidates(q, ref(q, "o", "store_id"), SHOP)).toEqual([
      ref(q, "s", "id"),
      ref(q, "c", "id"),
      ref(q, "s", "name"),
      ref(q, "s", "city"),
      ref(q, "c", "name"),
    ]);
  });
});

describe("mergeSchemas", () => {
  const shop: SqlSchema = {
    searchPath: [],
    tables: [{ ...ORDERS, schema: "shop" }, { ...STORES, schema: "shop" }],
    fks: [fk("shop", "orders", ["store_id"], "stores", ["id"])],
  };
  const archive: SqlSchema = {
    searchPath: [],
    tables: [{ ...ORDERS, schema: "archive" }, { ...CUSTOMERS, schema: "archive" }],
    fks: [fk("archive", "orders", ["customer_id"], "customers", ["id"], { name: "fk_c" })],
  };

  it("MySQL: the tab's database is unqualified, others are named by their database", () => {
    const merged = mergeSchemas("mysql", "shop", new Map([["shop", shop], ["archive", archive]]));
    expect(merged.loading).toBe(false);
    expect(merged.tables.map((t) => [t.schema, t.name])).toEqual([
      [null, "orders"],
      [null, "stores"],
      ["archive", "orders"],
      ["archive", "customers"],
    ]);
    expect(merged.fks).toEqual([
      { from: { schema: null, table: "orders", columns: ["store_id"] }, to: { schema: null, table: "stores", columns: ["id"] } },
      {
        from: { schema: "archive", table: "orders", columns: ["customer_id"] },
        to: { schema: "archive", table: "customers", columns: ["id"] },
        name: "fk_c",
      },
    ]);
  });

  it("Foreign Keys from another database join on the canvas", () => {
    const merged = mergeSchemas("mysql", "shop", new Map([["shop", shop], ["archive", archive]]));
    let q = emptyQuery("shop", "mysql");
    q = addTable(q, { schema: "archive", name: "orders" }, merged, { x: 0, y: 0 }).query;
    q = addTable(q, { schema: "archive", name: "customers" }, merged, { x: 300, y: 0 }).query;
    expect(q.joins).toHaveLength(1);
    expect(q.joins[0].on).toEqual([{ leftColumn: "customer_id", rightColumn: "id" }]);
  });

  it("SQLite: main is unqualified, an attached scope keeps its name", () => {
    const main: SqlSchema = { searchPath: ["main"], tables: [{ ...STORES, schema: "main" }], fks: [] };
    const aux: SqlSchema = { searchPath: ["aux"], tables: [{ ...STORES, schema: "aux" }], fks: [] };
    const merged = mergeSchemas("sqlite", "main", new Map([["main", main], ["aux", aux]]));
    expect(merged.tables.map((t) => t.schema)).toEqual([null, "aux"]);
  });

  it("PostgreSQL keeps schemas and reads only the tab's database", () => {
    const pg: SqlSchema = { searchPath: ["public"], tables: [{ ...STORES, schema: "public" }], fks: [] };
    const other: SqlSchema = { searchPath: ["public"], tables: [{ ...ORDERS, schema: "public" }], fks: [] };
    const merged = mergeSchemas("postgres", "shop", new Map([["shop", pg], ["other", other]]));
    expect(merged.tables.map((t) => [t.schema, t.name])).toEqual([["public", "stores"]]);
  });

  it("is loading until the tab's database is in", () => {
    expect(mergeSchemas("mysql", "shop", new Map([["archive", archive]])).loading).toBe(true);
    expect(mergeSchemas("mysql", null, new Map()).loading).toBe(false);
  });

  it("keeps the other databases still loading, dropping those that arrived", () => {
    const merged = mergeSchemas("mysql", "shop", new Map([["shop", shop], ["archive", archive]]), ["archive", "sales", "shop"]);
    expect(merged.loadingDatabases).toEqual(["sales"]);
  });

  it("PostgreSQL with no tab database reads only the first database", () => {
    const a: SqlSchema = { searchPath: ["public"], tables: [{ ...STORES, schema: "public" }], fks: [] };
    const b: SqlSchema = { searchPath: ["public"], tables: [{ ...STORES, schema: "public" }], fks: [] };
    expect(mergeSchemas("postgres", null, new Map([["a", a], ["b", b]])).tables).toHaveLength(1);
  });
});

describe("a card whose database is still loading (Review Focus 4)", () => {
  it("reads as loading, never missing, so Run stays on", () => {
    const shop: SqlSchema = { searchPath: [], tables: [{ ...ORDERS, schema: "shop" }], fks: [] };
    const schema = mergeSchemas("mysql", "shop", new Map([["shop", shop]]), ["archive"]);
    const ids = counter();
    let q = emptyQuery("shop", "mysql");
    q = addTable(q, { schema: null, name: "orders" }, schema, { x: 0, y: 0 }, ids).query;
    q = addTable(q, { schema: "archive", name: "customers" }, schema, { x: 300, y: 0 }, ids).query;
    q = addTable(q, { schema: null, name: "gone" }, schema, { x: 600, y: 0 }, ids).query;
    const [, c, g] = q.tables.map((t) => t.id);
    expect(loadingTables(q, schema)).toEqual([c]);
    expect(missing(q, schema)).toEqual({ tables: [g], columns: [] });
    // Once archive arrives without the table, it is missing.
    const arrived = mergeSchemas("mysql", "shop", new Map([["shop", shop], ["archive", { ...shop, tables: [] }]]));
    expect(loadingTables(q, arrived)).toEqual([]);
    expect(missing(q, arrived).tables).toEqual([c, g]);
  });
});

describe("matching the Core plan (V4)", () => {
  // The Core's golden case empty_on_cross_join: a settled Join with no pairs links nothing.
  const golden: VisualQuery = {
    version: 1,
    database: "app",
    tables: [
      { id: "t1", schema: null, name: "orders", alias: "o", x: 0, y: 0 },
      { id: "t2", schema: null, name: "stores", alias: "s", x: 300, y: 0 },
      { id: "t3", schema: null, name: "regions", alias: "r", x: 600, y: 0 },
    ],
    joins: [
      { id: "j1", left: "t1", right: "t2", kind: "left", on: [] },
      { id: "j2", left: "t2", right: "t3", kind: "inner", on: [{ leftColumn: "region_id", rightColumn: "id" }] },
    ],
    columns: [
      { table: "t1", column: "id", alias: null, aggregate: null },
      { table: "t2", column: "city", alias: null, aggregate: null },
      { table: "t3", column: "code", alias: null, aggregate: null },
    ],
    filters: [{ joiner: "and", table: "t2", column: "city", op: "eq", values: ["Oslo"] }],
    groupBy: { kind: "auto" },
    orderBy: [{ target: { kind: "column", table: "t3", column: "code" }, dir: "asc" }],
    limit: null,
    distinct: false,
  };

  it("empty_on_cross_join: the table is a CROSS JOIN, not waiting for a pick", () => {
    expect(crossTables(golden)).toEqual(["t2", "t3"]);
    // The Core warns once, for t2, the group's first table.
    expect(crossGroups(golden)).toEqual([["t2", "t3"]]);
    expect(pendingTables(golden)).toEqual([]);
    expect(countLine(golden)).toBe("3 tables, 1 Join");
  });

  it("crossGroups gives each CROSS JOIN group, a lone card as a group of one", () => {
    const { q } = build(["orders", "menu_items", "stores"]);
    expect(crossGroups(q)).toEqual([[idOf(q, "mi")]]);
  });

  it("a repeated table id is the first table, as in the Core", () => {
    const { q } = build(["orders", "menu_items"]);
    const dup: VisualQuery = { ...q, tables: [...q.tables, { ...q.tables[0], alias: "o9" }] };
    expect(crossTables(dup)).toEqual([idOf(q, "mi")]);
  });

  it("autoGroupBy leaves out columns behind a pending pick", () => {
    let { q } = build(["orders", "stores"], TWICE);
    q = toggleColumn(q, idOf(q, "o"), "status");
    q = toggleColumn(q, idOf(q, "s"), "name");
    expect(autoGroupBy(setAggregate(q, 1, "count"))).toEqual([]);
    expect(autoGroupBy(setAggregate(q, 0, "count"))).toEqual([]);
    const picked = pickForeignKey(q, q.joins[0].id, 0, TWICE);
    expect(autoGroupBy(setAggregate(picked, 0, "count"))).toEqual([ref(q, "s", "name")]);
  });
});

describe("cheap safety", () => {
  it("aliasFor skips words that do not start with an ASCII letter", () => {
    expect(aliasFor("2024_sales", new Set())).toBe("s");
    expect(aliasFor("Ürün", new Set())).toBe("t");
  });

  it("setAlias refuses a NUL", () => {
    const { q } = build(["orders"]);
    expect(setAlias(q, idOf(q, "o"), "a\0b")).toBe(q);
  });
});
