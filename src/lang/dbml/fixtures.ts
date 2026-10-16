// The commented KFC sample used by the language engine tests.
import type { SchemaModel } from "../../api/types";

export const KFC_TEXT = `// KFC store ordering
Enum store_kind { // where the store is
  drive
  mall
}

Table stores { // one row per store
  id integer [pk, increment, note: 'store id'] // surrogate key
  name varchar(80) [not null, unique]
  kind store_kind [default: 'mall']
  opened_at timestamptz [default: \`now()\`]
  Note: 'KFC stores'
}

// orders placed at a store
Table orders {
  id bigint
  line integer
  store_id integer [not null] // FK
  total "numeric(10,2)" [default: 0]

  indexes {
    (id, line) [pk]
    store_id [name: 'ix_store']
  }
}

Ref: orders.store_id > stores.id [delete: cascade] // stores own orders
`;

const col = (name: string, typeName: string, extra: Partial<SchemaModel["tables"][0]["columns"][0]> = {}) => ({
  name,
  typeName,
  pk: false,
  increment: false,
  notNull: false,
  unique: false,
  default: null,
  note: null,
  ...extra,
});

export const KFC_MODEL: SchemaModel = {
  dialect: "postgres",
  enums: [{ schema: "public", name: "store_kind", values: ["drive", "mall"] }],
  tables: [
    {
      schema: "public",
      name: "stores",
      alias: null,
      note: "KFC stores",
      columns: [
        col("id", "integer", { pk: true, increment: true, note: "store id" }),
        col("name", "varchar(80)", { notNull: true, unique: true }),
        col("kind", "store_kind", { default: { t: "string", value: "mall" } }),
        col("opened_at", "timestamptz", { default: { t: "expression", value: "now()" } }),
      ],
      indexes: [],
    },
    {
      schema: "public",
      name: "orders",
      alias: null,
      note: null,
      columns: [
        col("id", "bigint"),
        col("line", "integer"),
        col("store_id", "integer", { notNull: true }),
        col("total", "numeric(10,2)", { default: { t: "number", value: "0" } }),
      ],
      indexes: [
        { name: null, columns: ["id", "line"], unique: true, pk: true },
        { name: "ix_store", columns: ["store_id"], unique: false, pk: false },
      ],
    },
  ],
  refs: [
    {
      name: null,
      from: { schema: "public", table: "orders", columns: ["store_id"] },
      to: { schema: "public", table: "stores", columns: ["id"] },
      onDelete: "CASCADE",
      onUpdate: null,
    },
  ],
  skipped: [],
};
