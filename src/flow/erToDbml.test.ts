// One ERD (ADR 0030): an old `diagram er` file converts to DBML for the Schema Builder. Real samples: the README's
// billing schema (site/model-diagrams.js), the ER builds' own test files, and the odd cases a hand-written file has.
import { describe, expect, test } from "vitest";
import { parseDbml } from "../lang/dbml/parse";
import { migrateOldEr } from "../lang/flow/erMigrate";
import { parseFlow } from "../lang/flow/parse";
import { erFrameToDbml, erToDbml, openAsDbml } from "./erToDbml";
import { README_BILLING } from "./fixtures/erBilling";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

/** Valid DBML, read by the Schema Builder's own parser. */
function valid(dbml: string) {
  const out = parseDbml(dbml, "postgres");
  expect(out.diagnostics.map((d) => d.message)).toEqual([]);
  return out.model!;
}

describe("erToDbml", () => {
  test("the README's billing schema: tables, columns, and each relationship as a Ref with its name as a note", () => {
    const dbml = erToDbml(README_BILLING, "billing");
    expect(dbml).toBe(
      lines(
        "// Converted from the ER diagram billing. The original file is unchanged.",
        "",
        "Table customers {",
        "  id bigint",
        "  email text",
        "}",
        "",
        "Table orders {",
        "  id bigint",
        "  customer_id bigint [note: 'customers places orders']",
        "  total numeric",
        "}",
        "",
        "Table invoices {",
        "  id bigint",
        "  order_id bigint [note: 'orders billed in invoices']",
        "  paid_at timestamptz",
        "}",
        "",
        "Ref: orders.customer_id > customers.id",
        "Ref: invoices.order_id > orders.id",
      ),
    );
    const model = valid(dbml);
    expect(model.tables.map((t) => t.name)).toEqual(["customers", "orders", "invoices"]);
    expect(model.refs.map((r) => [r.from.table, r.from.columns, r.to.table, r.to.columns])).toEqual([
      ["orders", ["customer_id"], "customers", ["id"]],
      ["invoices", ["order_id"], "orders", ["id"]],
    ]);
  });

  test("column flags carry over as pk, not null and unique; column ends join the columns they name", () => {
    const text = lines(
      'diagram er "Billing"',
      "customers",
      "customers.id int [pk]",
      "customers.email varchar(255) [not null, unique]",
      "invoices",
      "invoices.id int [PK]",
      "invoices.customer_id int [not null]",
      "",
      "invoices.customer_id *--1 customers.id",
    );
    const dbml = erToDbml(text, "billing");
    expect(dbml).toContain("  id int [pk]\n  email varchar(255) [not null, unique]\n");
    expect(dbml).toContain("  customer_id int [not null]\n");
    expect(dbml).toContain("Ref: invoices.customer_id > customers.id\n");
    const model = valid(dbml);
    const customers = model.tables.find((t) => t.name === "customers")!;
    expect(customers.columns.map((c) => [c.name, c.typeName, c.pk, c.notNull, c.unique])).toEqual([
      ["id", "int", true, false, false],
      ["email", "varchar(255)", false, true, true],
    ]);
  });

  test("each cardinality: 1--* and *--1 point the many side at the one, 1--1 is -, *--* is <>", () => {
    const text = lines(
      'diagram er "x"',
      "a",
      "a.id int [pk]",
      "a.b_id int",
      "b",
      "b.id int [pk]",
      "b.a_id int",
      "a.id 1--* b.a_id",
      "b.a_id *--1 a.id : again",
      "a.b_id 1--1 b.id",
      "a.id *--* b.id",
    );
    const dbml = erToDbml(text, "x");
    expect(dbml).toContain("Ref: b.a_id > a.id\nRef: a.b_id - b.id\nRef: a.id <> b.id\n");
    // The same two columns joined twice are one Ref; the name still goes in the note.
    expect(dbml.match(/Ref: b\.a_id > a\.id/g)).toHaveLength(1);
    expect(dbml).toContain("  a_id int [note: 'b again a']\n");
    valid(dbml);
  });

  test("a table-to-table line finds the key and the referring column the ER board would have made", () => {
    const text = lines(
      'diagram er "x"',
      "categories",
      "categories.code text [pk]",
      "products",
      "products.id int [pk]",
      "products.category_code text",
      "people",
      "people.id int",
      "OrderItems",
      "OrderItems.id int",
      "OrderItems.person_id int",
      "categories 1--* products",
      "OrderItems *--1 people : bought by",
    );
    const dbml = erToDbml(text, "x");
    expect(dbml).toContain("Ref: products.category_code > categories.code\n");
    expect(dbml).toContain("Ref: OrderItems.person_id > people.id\n");
    valid(dbml);
  });

  test("a line with no column to join keeps its words as a comment, and nothing is invented", () => {
    const text = lines('diagram er "x"', "a", "a.id int", "b", "b.name text", "a -- b : knows", "a 1--* b");
    const dbml = erToDbml(text, "x");
    expect(dbml).toContain("// Not converted: a -- b : knows. No column joins these tables; add one and a Ref.\n");
    expect(dbml).toContain("// Not converted: a 1--* b. No column joins these tables; add one and a Ref.\n");
    expect(dbml).not.toContain("Ref:");
    valid(dbml);
  });

  test("a weak entity is a note on its table, and a table with no columns stays as a comment", () => {
    const text = lines('diagram er "x"', "orders", "orders.id int [pk]", "lines [weak]", "lines.order_id int", "empty", "lines *--1 orders : of", "empty -- orders");
    const dbml = erToDbml(text, "x");
    expect(dbml).toContain("Table lines {\n  order_id int [note: 'lines of orders']\n  Note: 'Weak entity'\n}\n");
    expect(dbml).toContain("// Table empty had no columns in the ER diagram; add one to keep it.\n");
    expect(dbml).toContain("Ref: lines.order_id > orders.id\n");
    expect(dbml).toContain("// Not converted: empty -- orders. No column joins these tables; add one and a Ref.\n");
    valid(dbml);
  });

  test("odd names and types are quoted; comments, ids and colours are dropped; a chain is one Ref per link", () => {
    const text = lines(
      'diagram er "x"  // the title',
      "// a comment line",
      "order lines [entity, id: T1, color: accent]",
      "order lines.id int [pk]",
      '"old stuff" [weak]',
      "sales.orders [entity]",
      "sales",
      "sales.id int [pk]",
      "sales.at timestamp with time zone",
      "sales.note text // says why",
      "a",
      "a.id int",
      "a.sale_id int",
      "a.sale_id *--1 sales.id *--1 order lines.id : odd",
    );
    const dbml = erToDbml(text, "x");
    expect(dbml).toContain('Table "order lines" {\n  id int [pk]\n}\n');
    expect(dbml).toContain('  at "timestamp with time zone"\n  note text\n');
    expect(dbml).toContain("// Table sales.orders had no columns in the ER diagram; add one to keep it.\n");
    expect(dbml).toContain("// Table old stuff had no columns in the ER diagram; add one to keep it.\n");
    expect(dbml).toContain("  id int [pk, note: 'sales odd order lines']\n");
    expect(dbml).toContain('Ref: a.sale_id > sales.id\nRef: sales.id > "order lines".id\n');
    const model = valid(dbml);
    expect(model.tables.map((t) => t.name)).toEqual(["order lines", "sales", "a"]);
  });

  test("a column with no type gets text, and quotes in notes are escaped", () => {
    const text = lines('diagram er "x"', "a", "a.id", "a.b_id int", "b", "b.id int [pk]", "a.b_id *--1 b.id : it's \\ odd");
    const dbml = erToDbml(text, "x");
    expect(dbml).toContain("  id text\n");
    expect(dbml).toContain("[note: 'a it\\'s \\\\ odd b']");
    valid(dbml);
  });

  test("CRLF and a BOM read as LF, and a file with no tables is still valid DBML", () => {
    const dbml = erToDbml(README_BILLING.replace(/\n/g, "\r\n").replace(/^/, "\uFEFF"), "billing");
    expect(dbml).toBe(erToDbml(README_BILLING, "billing"));
    expect(erToDbml('diagram er "x"\n', "x")).toBe("// Converted from the ER diagram x. The original file is unchanged.\n");
    valid(erToDbml('diagram er "x"\n', "x"));
  });
});

/** The old-form samples above, as one list: the new reader must convert each one as the old reader does. */
const OLD_SAMPLES: [string, string][] = [
  ["billing", README_BILLING],
  [
    "flags",
    lines(
      'diagram er "Billing"',
      "customers",
      "customers.id int [pk]",
      "customers.email varchar(255) [not null, unique]",
      "invoices",
      "invoices.id int [PK]",
      "invoices.customer_id int [not null]",
      "",
      "invoices.customer_id *--1 customers.id",
    ),
  ],
  [
    "cardinalities",
    lines('diagram er "x"', "a", "a.id int [pk]", "a.b_id int", "b", "b.id int [pk]", "b.a_id int", "a.id 1--* b.a_id", "b.a_id *--1 a.id : again", "a.b_id 1--1 b.id", "a.id *--* b.id"),
  ],
  [
    "whole tables",
    lines(
      'diagram er "x"',
      "categories",
      "categories.code text [pk]",
      "products",
      "products.id int [pk]",
      "products.category_code text",
      "people",
      "people.id int",
      "OrderItems",
      "OrderItems.id int",
      "OrderItems.person_id int",
      "categories 1--* products",
      "OrderItems *--1 people : bought by",
    ),
  ],
  ["weak and empty", lines('diagram er "x"', "orders", "orders.id int [pk]", "lines [weak]", "lines.order_id int", "empty", "lines *--1 orders : of")],
  [
    "odd names",
    lines(
      'diagram er "x"',
      "order lines [entity]",
      "order lines.id int [pk]",
      '"old stuff" [weak]',
      "sales",
      "sales.id int [pk]",
      "sales.at timestamp with time zone",
      "sales.note text",
      "a",
      "a.id int",
      "a.sale_id int",
      "a.sale_id *--1 sales.id *--1 order lines.id : odd",
    ),
  ],
  ["quotes", lines('diagram er "x"', "a", "a.id", "a.b_id int", "b", "b.id int [pk]", "a.b_id *--1 b.id : it's \\ odd")],
];

const doc = (text: string) => {
  const parse = parseFlow(text);
  expect(parse.problems.filter((p) => p.severity === "error")).toEqual([]);
  return parse.doc!;
};

describe("erFrameToDbml", () => {
  test.each(OLD_SAMPLES)("the_new_form_converts_like_the_old: %s", (_name, old) => {
    expect(erFrameToDbml(doc(migrateOldEr(old)), "x")).toBe(erToDbml(old, "x"));
  });

  test("the_new_form_converts_like_the_old: the README billing schema", () => {
    expect(erFrameToDbml(doc(migrateOldEr(README_BILLING)), "billing")).toBe(erToDbml(README_BILLING, "billing"));
  });

  test("each_cardinality_becomes_its_ref", () => {
    const text = lines(
      'diagram er "x"',
      "customers {",
      "  id int pk",
      "  tag int",
      "}",
      "orders {",
      "  id int pk",
      "  customer_id int",
      "  tag int",
      "}",
      "orders.customer_id > customers.id",
      "customers.id < orders.customer_id : again",
      "orders.id - customers.id",
      "customers.tag <> orders.tag",
    );
    const dbml = erFrameToDbml(doc(text), "x");
    expect(dbml).toContain("Ref: orders.customer_id > customers.id\nRef: orders.id - customers.id\nRef: customers.tag <> orders.tag\n");
    expect(dbml.match(/Ref: orders\.customer_id > customers\.id/g)).toHaveLength(1);
    expect(dbml).toContain("customer_id int [note: 'customers again orders']");
    valid(dbml);
  });

  test("a dotted table name keeps its columns: sales.orders.id is the column id of sales.orders", () => {
    const text = lines('diagram er "x"', "sales.orders {", "  id int pk", "}", "items {", "  order_id int", "}", "items.order_id > sales.orders.id");
    const dbml = erFrameToDbml(doc(text), "x");
    expect(dbml).toContain("Table sales.orders {");
    expect(dbml).toContain("Ref: items.order_id > sales.orders.id\n");
    const model = valid(dbml);
    expect(model.refs.map((r) => [r.from.table, r.to.schema, r.to.table, r.to.columns])).toEqual([["items", "sales", "orders", ["id"]]]);
  });

  test("groups_and_colours_are_dropped_and_the_result_is_valid", () => {
    const text = lines(
      'diagram er "x"',
      "group Billing [color: accent] {",
      "  customers [icon: user, color: warning] {",
      "    id int pk",
      '    email "varchar 255" not null unique // the login',
      "  }",
      "  orders [weak] {",
      "    customer_id int",
      "  }",
      "}",
      "orders.customer_id > customers.id [color: error]",
    );
    const dbml = erFrameToDbml(doc(text), "x");
    expect(dbml).not.toMatch(/icon|color|group|Billing/);
    expect(dbml).toContain("Note: 'Weak entity'");
    const model = valid(dbml);
    expect(model.tables.map((t) => t.name)).toEqual(["customers", "orders"]);
    expect(model.refs).toHaveLength(1);
  });
});

describe("openAsDbml", () => {
  const board = lines(
    'diagram flowchart "Flow"',
    "A > B",
    "",
    'diagram er "Shop"',
    "customers {",
    "  id int pk",
    "}",
    "orders {",
    "  id int pk",
    "  customer_id int",
    "}",
    "orders.customer_id > customers.id",
  );

  test("open_as_dbml_picks_the_frame", () => {
    const dbml = openAsDbml(board, 1, "shop")!;
    expect(dbml).toContain("// Converted from the ER diagram shop.");
    expect(dbml).toContain("Ref: orders.customer_id > customers.id");
    valid(dbml);
    expect(openAsDbml(board, 0, "shop")).toBeNull();
    expect(openAsDbml(board, 5, "shop")).toBeNull();
  });

  test("an old-form frame goes through the old reader, a new one with errors is null", () => {
    expect(openAsDbml(README_BILLING, 0, "billing")).toBe(erToDbml(README_BILLING, "billing"));
    expect(openAsDbml(lines('diagram er "x"', "a {", "  id int", "a.id > nowhere.id", "b {"), 0, "x")).toBeNull();
  });
});

test("a column's comment becomes its note", () => {
  const doc = parseFlow('diagram er "Shop"\norders {\n  id int pk // the key\n  total numeric\n}\n').doc!;
  expect(erFrameToDbml(doc, "shop")).toContain("id int [pk, note: 'the key']");
});
