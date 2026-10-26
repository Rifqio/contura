// The README's billing schema in the old ER form (`table.column type` lines, `1--*` lines), as the site and the
// screenshot drew it. Shared by the DBML converter's tests and the rewrite to table blocks.
const lines = (...l: string[]) => `${l.join("\n")}\n`;

export const README_BILLING = lines(
  'diagram er "Billing"',
  "",
  "customers [entity]",
  "customers.id bigint",
  "customers.email text",
  "orders",
  "orders.id bigint",
  "orders.customer_id bigint",
  "orders.total numeric",
  "invoices",
  "invoices.id bigint",
  "invoices.order_id bigint",
  "invoices.paid_at timestamptz",
  "",
  "customers 1--* orders : places",
  "orders 1--* invoices : billed in",
);
