import type { TableColumn, TableDesign } from "../api/types";

export const col = (name: string, typeSql: string, over: Partial<TableColumn> = {}): TableColumn => ({
  name,
  typeSql,
  nullable: true,
  defaultSql: null,
  increment: { kind: "none" },
  comment: null,
  generated: false,
  mysql: null,
  sqliteAutoincrement: false,
  collation: null,
  advanced: false,
  ...over,
});

/** `orders` as the MySQL read model gives it: five columns, the primary key on id. */
export const ORDERS: TableDesign = {
  path: { database: "shop", schema: null, name: "orders" },
  columns: [
    col("id", "int", { nullable: false, increment: { kind: "autoIncrement" } }),
    col("email", "varchar(80)"),
    col("status", "varchar(16)", { nullable: false, defaultSql: "'new'" }),
    col("total", "decimal(10,2)"),
    col("created_at", "timestamp", { defaultSql: "CURRENT_TIMESTAMP" }),
  ],
  indexes: [
    {
      name: "PRIMARY",
      columns: ["id"],
      unique: true,
      primary: true,
      constraint: false,
      sql: null,
      method: "btree",
      predicate: null,
      expression: false,
      advanced: false,
    },
  ],
  foreignKeys: [],
  referencedBy: [],
  comment: null,
  unsupported: [],
  sqlite: null,
};
