// UX step 8 (G8): the ways out of a row along its Foreign Keys, and the words the grid says about them.
import { expect, test } from "vitest";
import type { Cell } from "../api/types";
import { filterWords, filtersSql } from "./rowFilters";
import { MYSQL_SHOP, NULL, SHOP_SCHEMA, SQLITE_SHOP, num, text } from "../test/shopKeys";
import {
  backNote,
  countText,
  danglingNote,
  filtersText,
  fkText,
  inNote,
  isKeyColumn,
  keyText,
  keysOfTable,
  nullNote,
  outNote,
  rowFiltersOf,
  waysIn,
  waysOut,
} from "./foreignKeys";

const at = (name: string) => ({ database: "shop", schema: "public", name });
const row = (cells: Record<string, Cell>) => (c: string) => cells[c];

test("a_key_column_is_any_column_of_an_outgoing_key", () => {
  expect(isKeyColumn(SHOP_SCHEMA, at("orders"), "customer_id")).toBe(true);
  expect(isKeyColumn(SHOP_SCHEMA, at("orders"), "status")).toBe(false);
  expect(isKeyColumn(SHOP_SCHEMA, at("order_items"), "currency")).toBe(true);
  // Another schema's table of the same name is not this one.
  expect(isKeyColumn(SHOP_SCHEMA, { database: "shop", schema: "audit", name: "orders" }, "customer_id")).toBe(false);
  // MySQL and SQLite tables have no schema: the name decides.
  expect(isKeyColumn(SHOP_SCHEMA, { database: "shop", schema: null, name: "orders" }, "customer_id")).toBe(true);
});

test("one_key_goes_to_one_row_filtered_by_its_columns", () => {
  const ways = waysOut(SHOP_SCHEMA, at("orders"), row({ customer_id: num(214), ship_address_id: num(31) }), "customer_id");
  expect(ways).toHaveLength(1);
  expect(ways[0]).toMatchObject({ dir: "out", path: at("customers"), filters: [{ column: "id", value: "214" }], blocked: null });
  expect(keyText(ways[0].filters)).toBe("id = 214");
  // Without a column, every key the row holds.
  expect(waysOut(SHOP_SCHEMA, at("orders"), row({ customer_id: num(214), ship_address_id: num(31) })).map((w) => w.path.name)).toEqual([
    "customers",
    "addresses",
  ]);
});

test("a_column_in_two_keys_has_two_ways_and_a_null_part_blocks_one", () => {
  const ways = waysOut(SHOP_SCHEMA, at("order_items"), row({ product_id: num(5), currency: text("IDR") }), "product_id");
  expect(ways.map((w) => w.path.name)).toEqual(["products", "product_prices"]);
  expect(keyText(ways[1].filters)).toBe("product_id = 5 AND currency = IDR");
  expect(fkText(ways[1].fk)).toBe("(product_id, currency) → product_prices(product_id, currency)");
  expect(fkText(ways[0].fk)).toBe("product_id → products.id");
  const nulled = waysOut(SHOP_SCHEMA, at("order_items"), row({ product_id: num(6), currency: NULL }), "product_id");
  expect(nulled.map((w) => w.blocked)).toEqual([null, "currency is NULL"]);
});

test("null_and_binary_keys_cannot_be_followed_and_the_note_says_why", () => {
  const [w] = waysOut(SHOP_SCHEMA, at("orders"), row({ customer_id: NULL }), "customer_id");
  expect(w.blocked).toBe("customer_id is NULL");
  expect(nullNote("customer_id", "customers")).toBe("customer_id is NULL: there is no customers row to go to.");
  const bytes: Cell = { t: "bytes", previewHex: "00", truncated: false, totalBytes: 1 };
  expect(waysOut(SHOP_SCHEMA, at("orders"), row({ customer_id: bytes }), "customer_id")[0].blocked).toBe("customer_id is binary");
});

test("rows_that_point_here_filter_the_other_table_by_this_row", () => {
  const ways = waysIn(SHOP_SCHEMA, at("customers"), row({ id: num(214) }));
  expect(ways.map((w) => [w.path.name, keyText(w.filters)])).toEqual([
    ["orders", "customer_id = 214"],
    ["addresses", "customer_id = 214"],
  ]);
  expect(ways[0].dir).toBe("in");
  // A two-column key is filtered by both its columns.
  const prices = waysIn(SHOP_SCHEMA, at("product_prices"), row({ product_id: num(5), currency: text("IDR") }));
  expect(prices.map((w) => keyText(w.filters))).toEqual(["product_id = 5 AND currency = IDR"]);
  expect(waysIn(SHOP_SCHEMA, at("order_items"), row({}))).toEqual([]);
});

test("the_filters_become_one_chip_per_column", () => {
  const filters = rowFiltersOf([
    { column: "product_id", value: "5" },
    { column: "currency", value: "IDR" },
  ]);
  expect(filters.map((f) => [f.column, f.op, f.value])).toEqual([
    ["product_id", "eq", "5"],
    ["currency", "eq", "IDR"],
  ]);
  expect(new Set(filters.map((f) => f.id)).size).toBe(2);
});

test("the_notes", () => {
  expect(outNote("orders", 3)).toBe("Opened from orders, row 3. Alt+Left goes back.");
  expect(outNote("orders", 3, "id = 87")).toBe("Opened from orders, row 3. Its filter id = 87 was replaced. Alt+Left goes back.");
  expect(inNote({ rows: 2, more: false }, "order_items", "orders", [{ column: "id", value: "1003" }])).toBe(
    "2 rows of order_items point to orders id = 1003. Alt+Left goes back.",
  );
  expect(inNote({ rows: 1, more: false }, "orders", "customers", [{ column: "id", value: "214" }], "status = paid")).toBe(
    "1 row of orders points to customers id = 214. Its filter status = paid was replaced. Alt+Left goes back.",
  );
  expect(inNote({ rows: 1000, more: true }, "orders", "customers", [{ column: "id", value: "1" }])).toBe(
    "1,000+ rows of orders point to customers id = 1. Alt+Left goes back.",
  );
  expect(danglingNote("customers", [{ column: "id", value: "999" }])).toBe(
    "No customers row has id = 999: the database does not enforce this key.",
  );
  expect(backNote("Back on", "orders", "customer_id", 3, null)).toBe("Back on orders.customer_id of row 3.");
  expect(backNote("Back on", "orders", "customer_id", 1, "id = 214")).toBe("Back on orders.customer_id of row 1, filter id = 214.");
  expect(backNote("Forward to", "customers", "id", 1, null)).toBe("Forward to customers.id of row 1.");
  expect(filtersText([])).toBeNull();
  expect(filtersText(rowFiltersOf([{ column: "id", value: "214" }]))).toBe("id = 214");
});

test("counts_read_as_rows_capped_at_1000", () => {
  expect(countText({ state: "counting" })).toBe("counting");
  expect(countText({ state: "done", rows: 0, more: false })).toBe("none");
  expect(countText({ state: "done", rows: 1, more: false })).toBe("1 row");
  expect(countText({ state: "done", rows: 2, more: false })).toBe("2 rows");
  expect(countText({ state: "done", rows: 1000, more: true })).toBe("1,000+ rows");
  expect(countText({ state: "timeout" })).toBe("not counted, slow");
  expect(countText({ state: "skipped" })).toBe("not counted");
});

test("mysql_and_sqlite_keys_open_the_table_as_their_tabs_name_it_with_no_schema", () => {
  // MySQL's Core puts the database name in the endpoint's schema, SQLite's puts `main`; their tabs have none.
  for (const schema of [MYSQL_SHOP, SQLITE_SHOP]) {
    const orders = { database: "shop", schema: null, name: "orders" };
    const [out] = waysOut(schema, orders, row({ customer_id: num(214) }), "customer_id");
    expect(out.path).toEqual({ database: "shop", schema: null, name: "customers" });
    const ins = waysIn(schema, { database: "shop", schema: null, name: "customers" }, row({ id: num(214) }));
    expect(ins.map((w) => w.path)).toEqual([orders, { database: "shop", schema: null, name: "addresses" }]);
  }
  // Postgres keeps its schema.
  expect(waysOut(SHOP_SCHEMA, at("orders"), row({ customer_id: num(1) }), "customer_id")[0].path).toEqual(at("customers"));
});

test("a_self_reference_opens_the_same_table_path", () => {
  const people = { database: "shop", schema: null, name: "employees" };
  const schema = {
    searchPath: ["shop"],
    tables: [],
    fks: [{ name: "boss", from: { schema: "shop", table: "employees", columns: ["manager_id"] }, to: { schema: "shop", table: "employees", columns: ["id"] } }],
  };
  expect(waysOut(schema, people, row({ manager_id: num(3) }), "manager_id")[0].path).toEqual(people);
});

test("key_filters_are_exact_equalities_whatever_the_column_type", () => {
  // A timestamp key: the filter bar's date words take only a day, so the key must not go through them.
  const at = rowFiltersOf([{ column: "created_at", value: "2024-05-01 10:00:00" }]);
  expect(filtersSql("postgres", at, () => "date")).toBe(`"created_at" = '2024-05-01 10:00:00'`);
  // A composite key keeps every part, each typed by the column on the server.
  const both = rowFiltersOf([
    { column: "placed_at", value: "2024-05-01 10:00:00.123+07" },
    { column: "amount", value: "12.50" },
  ]);
  expect(filtersSql("mysql", both, (c) => (c === "amount" ? "number" : "date"))).toBe("(`placed_at` = '2024-05-01 10:00:00.123+07') AND (`amount` = '12.50')");
  expect(filtersSql("sqlite", rowFiltersOf([{ column: "id", value: "6f1c-uuid" }]), () => "text")).toBe(`"id" = '6f1c-uuid'`);
  // The chip says "is".
  expect(filterWords("date", at[0])).toEqual({ column: "created_at", condition: "is", value: "2024-05-01 10:00:00" });
});

test("a_key_part_that_cannot_be_named_is_refused_not_dropped", () => {
  const schema = {
    searchPath: ["main"],
    tables: [],
    fks: [{ from: { schema: "main", table: "orders", columns: ["customer_id"] }, to: { schema: "main", table: "customers", columns: [""] } }],
  };
  const orders = { database: "main", schema: null, name: "orders" };
  expect(waysOut(schema, orders, row({ customer_id: num(1) }), "customer_id")[0].blocked).toBe("the key's column in customers is unknown");
  expect(waysIn(schema, { database: "main", schema: null, name: "customers" }, row({ id: num(1) }))[0].blocked).toBe("the key's column in customers is unknown");
});

test("the_notes_name_the_back_key_as_it_is_bound", () => {
  expect(outNote("orders", 3, null, "Ctrl+Alt+Left")).toBe("Opened from orders, row 3. Ctrl+Alt+Left goes back.");
  expect(inNote({ rows: 2, more: false }, "order_items", "orders", [{ column: "id", value: "1003" }], null, "Alt+Home")).toBe(
    "2 rows of order_items point to orders id = 1003. Alt+Home goes back.",
  );
});

test("a_number_key_is_written_as_a_number_so_an_untyped_sqlite_column_matches", () => {
  // SQLite compares an untyped column holding 214 with '214' as false: number cells go unquoted.
  const [w] = waysOut(SQLITE_SHOP, { database: "main", schema: null, name: "orders" }, row({ customer_id: num(214) }), "customer_id");
  expect(filtersSql("sqlite", rowFiltersOf(w.filters), () => "text")).toBe(`"id" = 214`);
  const ins = waysIn(SQLITE_SHOP, { database: "main", schema: null, name: "product_prices" }, row({ product_id: num(5), currency: text("IDR") }));
  expect(filtersSql("sqlite", rowFiltersOf(ins[0].filters), () => "text")).toBe(`("product_id" = 5) AND ("currency" = 'IDR')`);
  // Only a plain number goes unquoted; anything else stays a literal.
  expect(filtersSql("postgres", rowFiltersOf([{ column: "x", value: "NaN", number: true }]), () => "text")).toBe(`"x" = 'NaN'`);
  expect(filtersSql("postgres", rowFiltersOf([{ column: "x", value: "1 OR 1=1", number: true }]), () => "text")).toBe(`"x" = '1 OR 1=1'`);
  expect(filtersSql("mysql", rowFiltersOf([{ column: "x", value: "-12.5e3", number: true }]), () => "text")).toBe("`x` = -12.5e3");
});

test("on SQLite a table name matches without case, as SQLite matches REFERENCES; elsewhere case counts", () => {
  const upper = {
    ...SQLITE_SHOP,
    fks: SQLITE_SHOP.fks.map((k) => (k.to.table === "customers" ? { ...k, to: { ...k.to, table: "Customers" } } : k)),
  };
  const tab = { database: "main", schema: null, name: "customers" };
  const keys = keysOfTable(upper, tab, "sqlite");
  const ways = waysIn(keys, tab, row({ id: num(214) }));
  expect(ways.map((w) => w.path.name)).toContain("orders");
  // The way in opens the declared table, and Back finds the tab by its own name.
  expect(ways.every((w) => w.fk.to.table === "customers")).toBe(true);
  const fromOrders = keysOfTable(upper, { database: "main", schema: null, name: "ORDERS" }, "sqlite");
  expect(isKeyColumn(fromOrders, { database: "main", schema: null, name: "ORDERS" }, "customer_id")).toBe(true);
  expect(waysIn(keysOfTable(upper, tab, "postgres"), tab, row({ id: num(214) })).map((w) => w.path.name)).not.toContain("orders");
});

test("M7: SQLite folds ASCII case only: Ärzte and ärzte are two tables", () => {
  const schema = {
    ...SQLITE_SHOP,
    fks: [{ ...SQLITE_SHOP.fks[0], from: { ...SQLITE_SHOP.fks[0].from, table: "visits" }, to: { ...SQLITE_SHOP.fks[0].to, table: "Ärzte" } }],
  };
  const lower = { database: "main", schema: null, name: "ärzte" };
  expect(keysOfTable(schema, lower, "sqlite").fks).toEqual([]);
  // The same Ä with other ASCII letters in upper case is the same table to SQLite.
  const upper = { database: "main", schema: null, name: "ÄRZTE" };
  expect(keysOfTable(schema, upper, "sqlite").fks).toHaveLength(1);
  // ASCII letters still fold.
  const ascii = { ...schema, fks: [{ ...schema.fks[0], to: { ...schema.fks[0].to, table: "DOCTORS" } }] };
  expect(keysOfTable(ascii, { database: "main", schema: null, name: "doctors" }, "sqlite").fks).toHaveLength(1);
});
