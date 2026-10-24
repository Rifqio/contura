// The step 8 board's shop (ForeignKeys.dc.html): six tables and their Foreign Keys, one of them on two columns.
import type { Cell, Page, SqlColumn, SqlFk, SqlSchema, SqlTable } from "../api/types";

const col = (name: string, typeName: string, pk = false): SqlColumn => ({ name, typeName, pk });
const table = (name: string, columns: SqlColumn[]): SqlTable => ({ schema: "public", name, kind: "table", columns });
const key = (name: string, ft: string, fc: string[], tt: string, tc: string[]): SqlFk => ({
  name,
  from: { schema: "public", table: ft, columns: fc },
  to: { schema: "public", table: tt, columns: tc },
});

export const SHOP_SCHEMA: SqlSchema = {
  searchPath: ["public"],
  tables: [
    table("orders", [col("id", "int8", true), col("customer_id", "int8"), col("ship_address_id", "int8"), col("status", "text"), col("total", "numeric(12,2)")]),
    table("customers", [col("id", "int8", true), col("name", "text"), col("email", "text"), col("country", "char(2)")]),
    table("addresses", [col("id", "int8", true), col("customer_id", "int8"), col("city", "text"), col("line1", "text")]),
    table("order_items", [col("id", "int8", true), col("order_id", "int8"), col("product_id", "int8"), col("currency", "char(3)"), col("qty", "int4")]),
    table("products", [col("id", "int8", true), col("sku", "text"), col("name", "text")]),
    table("product_prices", [col("product_id", "int8", true), col("currency", "char(3)", true), col("price", "numeric(12,2)")]),
  ],
  fks: [
    key("orders_customer_fk", "orders", ["customer_id"], "customers", ["id"]),
    key("orders_ship_address_fk", "orders", ["ship_address_id"], "addresses", ["id"]),
    key("addresses_customer_fk", "addresses", ["customer_id"], "customers", ["id"]),
    key("order_items_order_fk", "order_items", ["order_id"], "orders", ["id"]),
    key("order_items_product_fk", "order_items", ["product_id"], "products", ["id"]),
    key("order_items_price_fk", "order_items", ["product_id", "currency"], "product_prices", ["product_id", "currency"]),
    key("product_prices_product_fk", "product_prices", ["product_id"], "products", ["id"]),
  ],
};

export const num = (value: string | number): Cell => ({ t: "number", value: String(value) });
export const text = (value: string): Cell => ({ t: "text", value, truncated: false, totalBytes: value.length });
export const NULL: Cell = { t: "null" };

/** A page of a table of SHOP_SCHEMA: numbers for int columns, text for the rest, null for NULL. */
export function shopPage(name: string, rows: (string | number | null)[][], hasMore = false): Page {
  const t = SHOP_SCHEMA.tables.find((x) => x.name === name)!;
  return {
    columns: t.columns.map((c) => ({ name: c.name, typeName: c.typeName, isPrimaryKey: c.pk })),
    rows: rows.map((r) => r.map((v, i) => (v === null ? NULL : /^(int|numeric)/.test(t.columns[i].typeName) ? num(v) : text(String(v))))),
    hasMore,
  };
}

/** Orders as on the board: 1006 has no ship address, 1008 neither a customer nor an address. */
export const ORDERS: (string | number | null)[][] = [
  [1001, 214, 31, "paid", "129.90"],
  [1002, 87, 40, "shipped", "58.00"],
  [1003, 214, 32, "pending", "310.25"],
  [1006, 903, null, "paid", "1204.00"],
  [1008, null, null, "pending", "19.99"],
];

/**
 * The same keys as each Core reads them: Postgres names the schema (`public`), MySQL puts the database name in the
 * schema (`shop`) and SQLite puts `main` there, while MySQL and SQLite tabs have no schema (`null`).
 */
export function shopSchemaAs(schema: string): SqlSchema {
  const at = (e: SqlFk["from"]) => ({ ...e, schema });
  return {
    ...SHOP_SCHEMA,
    searchPath: [schema],
    tables: SHOP_SCHEMA.tables.map((t) => ({ ...t, schema })),
    fks: SHOP_SCHEMA.fks.map((k) => ({ ...k, from: at(k.from), to: at(k.to) })),
  };
}
export const MYSQL_SHOP = shopSchemaAs("shop");
export const SQLITE_SHOP = shopSchemaAs("main");
