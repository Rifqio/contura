// The ER kind in table blocks: `orders [icon: shopping-cart] {`, one column per line, `}`; relationships between
// tables or their columns with >, <, - and <> (DBML's operators); groups written `group Billing {`.
import { expect, test } from "vitest";
import { writeFlow } from "../../flow/flowModel";
import { columnFlagsText, columnLine, columnTypeText, defaultArrow, erCardinality, linkEndText, sqlFreeName, tableText } from "./model";
import { flowOutline } from "./outline";
import { parseFlow } from "./parse";
import { MESSAGES } from "./problems";

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const errors = (t: string) => parseFlow(t).problems.filter((p) => p.severity === "error");
const er = (...l: string[]) => lines('diagram er "x"', ...l);

const SHOP = lines(
  'diagram er "Shop"',
  "orders [icon: shopping-cart, color: info] {",
  "  id int pk",
  "  customer_id int not null",
  "  total decimal(10, 2)",
  '  placed_at "timestamp with time zone" not null',
  "  status text unique // draft, paid",
  "}",
  "customers {",
  "  id int PK",
  "  email text Not  Null unique",
  "}",
  "audit_log [weak]",
  "",
  "orders.customer_id > customers.id: placed by",
);

test("reads_tables_columns_flags_and_a_relationship", () => {
  const r = parseFlow(SHOP);
  expect(r.problems).toEqual([]);
  const [orders, customers, audit] = r.doc!.nodes;
  expect(orders).toMatchObject({ name: "orders", kind: "entity", attrs: { icon: "shopping-cart", color: "info" } });
  expect(orders.rows).toEqual(["id int", "customer_id int", "total decimal(10, 2)", "placed_at timestamp with time zone", "status text"]);
  expect(orders.rowFlags).toEqual([["pk"], ["not null"], [], ["not null"], ["unique"]]);
  expect(customers.rowFlags).toEqual([["pk"], ["not null", "unique"]]);
  expect(audit).toMatchObject({ name: "audit_log", kind: "weak" });
  expect(audit.rows).toBeUndefined();
  expect(r.doc!.links).toEqual([{ from: "orders", to: "customers", arrow: ">", fromColumn: "customer_id", toColumn: "id", label: "placed by" }]);
});

test("each_cardinality_and_whole_table_ends", () => {
  const t = er(
    "orders {",
    "  id int pk",
    "  customer_id int",
    "}",
    "customers {",
    "  id int pk",
    "}",
    "employees {",
    "  id int pk",
    "  manager_id int",
    "}",
    "customers.id < orders.customer_id",
    "orders.id - customers.id",
    "orders.id <> customers.id",
    "orders > customers",
    "employees.manager_id > employees.id",
  );
  const r = parseFlow(t);
  expect(errors(t)).toEqual([]);
  expect(r.doc!.links).toEqual([
    { from: "customers", to: "orders", arrow: "<", fromColumn: "id", toColumn: "customer_id" },
    { from: "orders", to: "customers", arrow: "-", fromColumn: "id", toColumn: "id" },
    { from: "orders", to: "customers", arrow: "<>", fromColumn: "id", toColumn: "id" },
    { from: "orders", to: "customers", arrow: ">" },
    { from: "employees", to: "employees", arrow: ">", fromColumn: "manager_id", toColumn: "id" },
  ]);
  expect(erCardinality).toEqual({ ">": "many-to-one", "<": "one-to-many", "-": "one-to-one", "<>": "many-to-many" });
  expect(defaultArrow("er")).toBe(">");
  // `--` is an old ER line: it is now `-`.
  const dashed = errors(er("a", "b", "a -- b"));
  expect(dashed.map((p) => p.message)).toEqual([MESSAGES.oldCard("--", "-")]);
  expect(errors(er("a", "b", "a ..> b")).map((p) => p.message)).toEqual([MESSAGES.arrowKind("..>", "er", ">")]);
  expect(MESSAGES.arrowKind("--", "er", ">")).toBe("An ER diagram does not draw --. Use >.");
});

test("a_fan_out_line_carries_each_end_column", () => {
  const t = er("orders {", "  id int", "  a_id int", "  b_id int", "}", "a {", "  id int", "}", "b {", "  id int", "}", "orders.a_id, orders.b_id > a.id, b");
  const r = parseFlow(t);
  expect(errors(t)).toEqual([]);
  expect(r.doc!.links).toEqual([
    { from: "orders", to: "a", arrow: ">", fromColumn: "a_id", toColumn: "id" },
    { from: "orders", to: "b", arrow: ">", fromColumn: "a_id" },
    { from: "orders", to: "a", arrow: ">", fromColumn: "b_id", toColumn: "id" },
    { from: "orders", to: "b", arrow: ">", fromColumn: "b_id" },
  ]);
  expect(parseFlow(writeFlow(r.doc!)).doc).toEqual(r.doc);
});

test("a_column_with_no_type", () => {
  const r = parseFlow(er("orders {", "  id pk", "  note", "  code unique not null", "}"));
  expect(r.problems).toEqual([]);
  expect(r.doc!.nodes[0].rows).toEqual(["id", "note", "code"]);
  expect(r.doc!.nodes[0].rowFlags).toEqual([["pk"], [], ["not null", "unique"]]);
});

test("an_unknown_flag_says_so_with_a_fix", () => {
  const t = er("orders {", "  id int uniqe", "}");
  const [p] = errors(t);
  expect(p.message).toBe(MESSAGES.unknownFlag("uniqe", "unique"));
  expect(p.message).toBe('Unknown column flag "uniqe". Did you mean unique?');
  expect(p.fixes[0].title).toBe("Use unique");
  expect(t.slice(p.fixes[0].edits[0].from, p.fixes[0].edits[0].to)).toBe("uniqe");
  expect(p.fixes[0].edits[0].insert).toBe("unique");
  const [q] = errors(er("orders {", "  id int primary", "}"));
  expect(q.message).toBe(MESSAGES.unknownFlag("primary", null));
  expect(q.message).toBe('Unknown column flag "primary". Use pk, not null or unique.');
  expect(q.fixes).toEqual([]);
  const [n] = errors(er("orders {", "  id int not nul", "}"));
  expect(n.message).toBe(MESSAGES.unknownFlag("not nul", "not null"));
});

test("a_column_the_table_lacks_is_a_problem", () => {
  const t = er("orders {", "  id int", "}", "customers {", "  id int", "}", "orders.nope > customers.id");
  const [p] = errors(t);
  expect(p.message).toBe("orders has no column nope.");
  expect(p.message).toBe(MESSAGES.noColumn("orders", "nope"));
  expect(t.slice(p.from, p.to)).toBe("orders.nope");
  // A dotted end that names no table stays an undefined name.
  expect(errors(er("a", "a > b.c")).map((x) => x.message)).toEqual([MESSAGES.notDefined("b.c")]);
});

test("a_table_inside_a_table_is_refused", () => {
  const t = er("orders {", "  id int", "  x {", "    y int", "  }", "}", "after");
  const ps = errors(t);
  expect(ps.map((p) => p.message)).toEqual([MESSAGES.tableInTable]);
  expect(MESSAGES.tableInTable).toBe("A table holds columns. Put tables side by side, or in a group: group Billing {.");
  // The inner braces pair, so the line after the table is read as a table again.
  expect(parseFlow(t).defined.has("after")).toBe(true);
});

test("a_column_starts_with_its_name", () => {
  const ps = errors(er("orders {", '  "id" int', "}"));
  expect(ps.map((p) => p.message)).toEqual([MESSAGES.columnName]);
  expect(MESSAGES.columnName).toBe("Start a column with its name, for example id int pk.");
});

test("an_unclosed_table_says_so", () => {
  const t = er("orders {", "  id int");
  const [p] = errors(t);
  expect(p.message).toBe(MESSAGES.unclosed("orders"));
  expect(p.fixes[0].title).toBe("Add } at the end");
});

test("tables_in_a_group", () => {
  const t = er("group Billing [color: muted] {", "  invoices {", "    id int pk", "  }", "  ledger", "}");
  const r = parseFlow(t);
  expect(r.problems).toEqual([]);
  expect(r.doc!.groups[0]).toEqual({ name: "Billing", color: "muted", nodes: ["invoices", "ledger"], groups: [] });
  expect(r.doc!.nodes[0].rows).toEqual(["id int"]);
  expect(t.slice(r.span("group:Billing")!.from, r.span("group:Billing")!.to)).toBe(t.slice(t.indexOf("group"), t.lastIndexOf("}") + 1));
  // A group takes an icon and a colour only.
  expect(errors(er("group Billing [weak] {", "}")).map((p) => p.message)).toEqual([MESSAGES.groupAttrs]);
  expect(parseFlow(writeFlow(r.doc!)).doc).toEqual(r.doc);
  expect(writeFlow(r.doc!)).toBe(lines('diagram er "x"', "", "group Billing [color: muted] {", "  invoices {", "    id int pk", "  }", "  ledger", "}"));
});

test("spans_of_a_table_and_its_columns", () => {
  const r = parseFlow(SHOP);
  const t = r.span("table:orders")!;
  expect(SHOP.slice(t.open!.from, t.open!.to)).toBe("{");
  expect(SHOP.slice(t.close!.from, t.close!.to)).toBe("}");
  expect(SHOP.slice(t.name!.from, t.name!.to)).toBe("orders");
  expect(SHOP.slice(t.attrs!.from, t.attrs!.to)).toBe("[icon: shopping-cart, color: info]");
  expect(SHOP.slice(r.span("node:orders")!.to - 1, r.span("node:orders")!.to)).toBe("}");
  expect(r.span("node:orders")!.from).toBe(SHOP.indexOf("orders"));
  const row = r.rowsOf("orders")[1];
  expect(SHOP.slice(row.column!.from, row.column!.to)).toBe("customer_id");
  expect(SHOP.slice(row.flags!.from, row.flags!.to)).toBe("not null");
  expect(row.name).toBeUndefined();
  const placed = r.rowsOf("orders")[3];
  expect(SHOP.slice(placed.type!.from, placed.type!.to)).toBe('"timestamp with time zone"');
  expect(SHOP.slice(placed.line.from, placed.line.to)).toBe('placed_at "timestamp with time zone" not null');
  expect(r.rowsOf("orders")[2].flags).toBeUndefined();
  expect(r.rowsOf("customers")[1].flags).toEqual({ from: SHOP.indexOf("Not  Null"), to: SHOP.indexOf("Not  Null unique") + "Not  Null unique".length });
});

test("less_than_is_an_er_arrow_only", () => {
  const t = lines('diagram flow "x"', "A", "B", "A < B");
  const [p] = errors(t);
  expect(p.message).toBe(MESSAGES.arrowKind("<", "flow", ">"));
  expect(p.message).toContain("Use >");
  expect(p.fixes[0].edits[0].insert).toBe(">");
});

test("the_writer_reads_back", () => {
  const d = parseFlow(SHOP).doc!;
  // A column's own comment stays on its row; it is not one of the doc's comments.
  expect(d.comments).toEqual([]);
  expect(parseFlow(writeFlow(d)).doc).toEqual(d);
  expect(writeFlow(d)).toBe(
    lines(
      'diagram er "Shop"',
      "",
      "orders [icon: shopping-cart, color: info] {",
      "  id int pk",
      "  customer_id int not null",
      "  total decimal(10, 2)",
      '  placed_at "timestamp with time zone" not null',
      "  status text unique // draft, paid",
      "}",
      "customers {",
      "  id int pk",
      "  email text not null unique",
      "}",
      "audit_log [weak]",
      "",
      "orders.customer_id > customers.id: placed by",
    ),
  );
});

test("the_column_helpers", () => {
  expect(columnFlagsText(["unique", "pk", "not null"])).toBe(" pk not null unique");
  expect(columnFlagsText([])).toBe("");
  expect(columnTypeText("decimal(10, 2)")).toBe("decimal(10, 2)");
  expect(columnTypeText("timestamp with time zone")).toBe('"timestamp with time zone"');
  expect(columnTypeText('a"b')).toBe('"a\\"b"');
  expect(columnTypeText("a//b")).toBe('"a//b"');
  expect(linkEndText("orders", "id")).toBe("orders.id");
  expect(linkEndText("orders")).toBe("orders");
  expect(sqlFreeName("orders", ["Orders"])).toBe("orders_2");
  expect(sqlFreeName("orders_2", ["orders", "orders_2"])).toBe("orders_3");
  expect(sqlFreeName("table", ["table_1"], 1)).toBe("table_2");
  // A type that reads as a flag is quoted, so it reads back as the type.
  const t = er("a {", `  x ${columnTypeText("unique")}`, `  y ${columnTypeText("Not")}`, "}");
  expect(parseFlow(t).doc!.nodes[0].rows).toEqual(["x unique", "y Not"]);
});

test("an_empty_table_on_one_line", () => {
  const r = parseFlow(er("orders {}", "customers { }"));
  expect(r.problems).toEqual([]);
  expect(r.doc!.nodes.map((n) => [n.name, n.rows])).toEqual([["orders", undefined], ["customers", undefined]]);
});

test("the_outline_of_an_er_frame", () => {
  const o = flowOutline(parseFlow(SHOP), null);
  expect(o.kinds).toEqual(["entity", "weak"]);
  expect(o.nodes.map((n) => [n.name, n.kind, n.line])).toEqual([
    ["orders", "entity", 2],
    ["customers", "entity", 9],
    ["audit_log", "weak", 13],
  ]);
  // Plan D Task 2: a line between columns keeps them for the assistant's checker.
  expect(o.links).toEqual([{ from: "orders", to: "customers", label: "placed by", line: 15, fromColumn: "customer_id", toColumn: "id" }]);
});

test("a_column_comment_stays_on_its_row", () => {
  const t = er("orders {", "  id int pk // the key", "  total decimal(10, 2)", "  status text //", "}");
  const d = parseFlow(t).doc!;
  expect(d.comments).toEqual([]);
  expect(d.nodes[0].rowComments).toEqual(["the key", undefined, ""]);
  expect(writeFlow(d)).toBe(lines('diagram er "x"', "", "orders {", "  id int pk // the key", "  total decimal(10, 2)", "  status text //", "}"));
  expect(parseFlow(writeFlow(d)).doc).toEqual(d);
  // No comment on any column: no list.
  expect(parseFlow(er("orders {", "  id int", "}")).doc!.nodes[0].rowComments).toBeUndefined();
});

test("a_lone_less_than_before_a_dash_bar_or_equals_is_no_arrow", () => {
  // As before the ER kind came back: the line is left unread, with no fix that writes A ->- B.
  const seq = parseFlow('diagram sequence "x"\nA -> B\nA <- B\n').problems;
  expect(seq.map((p) => [p.message, p.from, p.to, p.fixes.map((f) => f.title)])).toEqual([[MESSAGES.extra("<- B"), 30, 34, []]]);
  const state = parseFlow('diagram state "x"\nA > B\nA <-- B\n').problems;
  expect(state.map((p) => [p.message, p.from, p.to])).toEqual([
    [MESSAGES.notDefined("B"), 22, 23],
    [MESSAGES.extra("<-- B"), 26, 31],
  ]);
  const flow = parseFlow('diagram flow "x"\nA\nB\nA <= B\n').problems;
  expect(flow.map((p) => p.message)).toEqual([MESSAGES.definedTwice("A", 2, 4), MESSAGES.extra("<= B")]);
});

test("quoted_and_lone_not_flags", () => {
  const t = er("orders {", '  id int "pk"', "}");
  const [q] = errors(t);
  expect(q.message).toBe('Unknown column flag "pk". Did you mean pk?');
  expect(q.fixes[0].edits[0]).toEqual({ from: t.indexOf('"pk"'), to: t.indexOf('"pk"') + 4, insert: "pk" });
  for (const line of ["  id int not", "  id int not pk"]) {
    const u = er("orders {", line, "}");
    const [p] = errors(u);
    expect(p.message).toBe(MESSAGES.unknownFlag("not", "not null"));
    expect(p.fixes[0].title).toBe("Use not null");
    expect(u.slice(p.fixes[0].edits[0].from, p.fixes[0].edits[0].to)).toBe("not");
  }
});

test("an_unclosed_parenthesis_in_a_type_says_so_and_keeps_the_flags", () => {
  const t = er("orders {", "  t decimal(10, 2 pk", "}");
  const r = parseFlow(t);
  const ps = r.problems.filter((p) => p.severity === "error");
  expect(ps.map((p) => p.message)).toEqual([MESSAGES.openParen]);
  expect(MESSAGES.openParen).toBe("This ( has no closing ).");
  expect(t.slice(ps[0].from, ps[0].to)).toBe("(");
  const row = r.rowsOf("orders")[0];
  expect(t.slice(row.type!.from, row.type!.to)).toBe("decimal(10, 2");
  expect(t.slice(row.flags!.from, row.flags!.to)).toBe("pk");
  // Only a flag word ends an open type early; anything else stays in it, and the problem is still told.
  expect(errors(er("orders {", "  t decimal(10, 2", "}")).map((p) => p.message)).toEqual([MESSAGES.openParen]);
});

test("a_schema_qualified_table_end_takes_the_longest_table_name", () => {
  const t = er("sales.orders {", "  id int pk", "  customer_id int", "}", "sales {", "  orders int", "}", "customers {", "  id int", "}", "sales.orders.customer_id > customers.id", "sales.orders > customers.id");
  const r = parseFlow(t);
  expect(errors(t)).toEqual([]);
  expect(r.doc!.links).toEqual([
    { from: "sales.orders", to: "customers", arrow: ">", fromColumn: "customer_id", toColumn: "id" },
    { from: "sales.orders", to: "customers", arrow: ">", toColumn: "id" },
  ]);
  expect(parseFlow(writeFlow(r.doc!)).doc).toEqual(r.doc);
  // With no qualified table, the first dot splits as before.
  const u = er("orders {", "  id int", "}", "customers {", "  id int", "}", "orders.id > customers.id");
  expect(parseFlow(u).doc!.links).toEqual([{ from: "orders", to: "customers", arrow: ">", fromColumn: "id", toColumn: "id" }]);
  // A column the longest table lacks is that table's problem.
  expect(errors(er("sales.orders {", "  id int", "}", "c", "sales.orders.nope > c")).map((p) => p.message)).toEqual([MESSAGES.noColumn("sales.orders", "nope")]);
});

test("quotes_and_a_spaced_close_inside_parentheses_stay_in_the_type", () => {
  const t = er("a {", "  s enum('does not apply')", "  k enum(a, 'x not y')", "  h set(a, pk )", `  u enum("unique", 'pk') not null`, "}");
  const r = parseFlow(t);
  expect(r.problems).toEqual([]);
  expect(r.doc!.nodes[0].rows).toEqual(["s enum('does not apply')", "k enum(a, 'x not y')", "h set(a, pk )", `u enum("unique", 'pk')`]);
  expect(r.doc!.nodes[0].rowFlags).toEqual([[], [], [], ["not null"]]);
  expect(parseFlow(writeFlow(r.doc!)).doc).toEqual(r.doc);
});

test("table_text_and_the_column_line_agree", () => {
  const doc = parseFlow(lines(SHOP.trimEnd(), "notes {", "  id int // a key", "  body", "  empty text //", "}")).doc!;
  for (const t of doc.nodes.filter((n) => n.rows?.length)) {
    const body = tableText(t).split("\n").slice(1, -1);
    expect(body).toEqual(t.rows!.map((_, i) => `  ${columnLine(t, i)}`));
  }
  const notes = doc.nodes.find((n) => n.name === "notes")!;
  expect(columnLine(notes, 0)).toBe("id int // a key");
  expect(columnLine(notes, 0, { comment: false })).toBe("id int");
});
