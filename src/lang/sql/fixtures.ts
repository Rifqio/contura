// The design's sample schema: a KFC shop on PostgreSQL.
import type { SqlColumn, SqlSchema, SqlTable } from "./types";

const col = (name: string, typeName: string, pk = false): SqlColumn => ({ name, typeName, pk });
const table = (schema: string, name: string, columns: SqlColumn[], kind: SqlTable["kind"] = "table"): SqlTable => ({
  schema,
  name,
  kind,
  columns,
});
const fk = (fs: string, ft: string, fc: string, ts: string, tt: string, tc: string) => ({
  from: { schema: fs, table: ft, columns: [fc] },
  to: { schema: ts, table: tt, columns: [tc] },
});

export const KFC_SCHEMA: SqlSchema = {
  searchPath: ["public", "sales"],
  tables: [
    table("public", "customers", [
      col("id", "int4", true),
      col("full_name", "varchar(120)"),
      col("phone", "varchar(20)"),
      col("email", "varchar(160)"),
      col("joined_at", "timestamptz"),
      col("points", "int4"),
    ]),
    table("public", "menu_items", [
      col("id", "int4", true),
      col("sku", "varchar(16)"),
      col("name", "varchar(120)"),
      col("category", "varchar(40)"),
      col("price", "numeric(10,2)"),
      col("is_available", "bool"),
    ]),
    table("public", "stores", [
      col("id", "int4", true),
      col("code", "varchar(8)"),
      col("name", "varchar(120)"),
      col("city", "varchar(60)"),
      col("opened_on", "date"),
      col("is_active", "bool"),
    ]),
    table("sales", "order_items", [
      col("id", "int8", true),
      col("order_id", "int8"),
      col("menu_item_id", "int4"),
      col("qty", "int2"),
      col("unit_price", "numeric(10,2)"),
    ]),
    table("sales", "orders", [
      col("id", "int8", true),
      col("store_id", "int4"),
      col("customer_id", "int4"),
      col("channel", "varchar(16)"),
      col("status", "varchar(16)"),
      col("total", "numeric(12,2)"),
      col("placed_at", "timestamptz"),
    ]),
    table("sales", "v_store_daily_sales", [col("store_id", "int4"), col("day", "date"), col("orders", "int8"), col("revenue", "numeric")], "view"),
    table("archive", "orders_2019", [col("id", "int8", true), col("total", "numeric(12,2)")]),
    table("public", "Order Items", [col("id", "int4", true), col("Note", "text")]),
  ],
  fks: [
    fk("sales", "order_items", "order_id", "sales", "orders", "id"),
    fk("sales", "order_items", "menu_item_id", "public", "menu_items", "id"),
    fk("sales", "orders", "store_id", "public", "stores", "id"),
    fk("sales", "orders", "customer_id", "public", "customers", "id"),
  ],
};

/** `text` with a `|` marking where the user is typing, and that offset. */
export function at(marked: string): { text: string; pos: number } {
  const pos = marked.indexOf("|");
  return { text: marked.slice(0, pos) + marked.slice(pos + 1), pos };
}
