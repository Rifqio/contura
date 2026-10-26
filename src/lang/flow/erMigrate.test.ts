// Old ER files (`table.column type [flags]` lines, `1--*` lines, `Name {` groups) rewrite to table blocks with one
// quick fix.
import { expect, test } from "vitest";
import { README_BILLING } from "../../flow/fixtures/erBilling";
import { parseBoard } from "./board";
import { migrateOldEr } from "./erMigrate";
import { parseFlow } from "./parse";
import { FIX_TITLES, MESSAGES } from "./problems";
import { applyEdits } from "./service";

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const crlf = (...l: string[]) => `${l.join("\r\n")}\r\n`;
const isOld = (message: string) =>
  message === MESSAGES.oldColumn || message === MESSAGES.oldGroup || message.includes(" is the old way to write a relationship.");

const SHOP_CRLF =
  "\uFEFF" +
  crlf(
    'diagram er "Shop"',
    "customers [weak, color: info]",
    "customers.id int [pk, not null] // key",
    "// how we reach them",
    "customers.email text",
    "invoices [entity, color: muted]",
    "invoices.customer_id int",
    "invoices.customer_id *--1 customers.id",
  );
const ARROWS = lines("diagram er", "a", "b", "a 1--* b : one--many [color: info]", "a *--1 b", "a 1--1 b", "a -- b // a -- b", "a *--* b");
const QUOTED = lines(
  "diagram er",
  "orders",
  "orders.placed_at timestamp with time zone",
  "customers",
  "orders.status pk [unique]",
  "customers.id int",
  "orders 1--* customers",
);
const GROUP_ICON = lines("diagram er", "Billing [icon: aws-vpc] {", "  invoices", "  invoices.total numeric", "}", "invoices.id int");
const NESTED = lines("diagram er", "Outer {", "  Inner {", "    a", "  }", "  Empty {", "  }", "}", "a.id int");
const OUTSIDE_IN_GROUP = lines("diagram er", "orders", "Billing {", "  orders.total numeric", "  invoices", "}");
const ABOVE = lines("diagram er", "orders.id int [pk]", "orders");
const DOTTED = lines("diagram er", "sales.orders [entity]", "sales.orders.id int", "sales.orders.note text");
const ARRAYS = lines("diagram er", "a", "a.tags int[]", "a.ids text[] [pk]", "a.grid int[][] // cells");
const JOIN_BLOCK = lines("diagram er", "orders {", "  id int", "}", "orders.total numeric");
const MIXED = lines("diagram er", "orders {", "  id int", "}", "Billing {", "  invoices", "  invoices.total numeric", "}");
const GROUP_BY_EVIDENCE = lines("diagram er", "Billing {", "  invoices", "}", "invoices.total numeric");
const TABLE_WITHOUT_EVIDENCE = lines("diagram er", "a", "a.id int", "Billing {", "  invoices", "}");
const OWN_COLUMN_IN_BLOCK = lines("diagram er", "orders {", "  id int pk", "  name text", "  orders.total numeric", "}");
const FOREIGN_COLUMN_IN_BLOCK = lines("diagram er", "customers", "orders {", "  id int", "  customers.id int", "}");
const FIXTURES = [
  README_BILLING,
  SHOP_CRLF,
  ARROWS,
  QUOTED,
  GROUP_ICON,
  NESTED,
  OUTSIDE_IN_GROUP,
  ABOVE,
  DOTTED,
  ARRAYS,
  JOIN_BLOCK,
  MIXED,
  GROUP_BY_EVIDENCE,
  TABLE_WITHOUT_EVIDENCE,
  OWN_COLUMN_IN_BLOCK,
  FOREIGN_COLUMN_IN_BLOCK,
];

test("the_readme_billing_file_rewrites_to_blocks", () => {
  expect(migrateOldEr(README_BILLING)).toBe(
    lines(
      'diagram er "Billing"',
      "",
      "customers {",
      "  id bigint",
      "  email text",
      "}",
      "orders {",
      "  id bigint",
      "  customer_id bigint",
      "  total numeric",
      "}",
      "invoices {",
      "  id bigint",
      "  order_id bigint",
      "  paid_at timestamptz",
      "}",
      "",
      "customers < orders : places",
      "orders < invoices : billed in",
    ),
  );
  expect(parseFlow(migrateOldEr(README_BILLING)).problems).toEqual([]);
});

test("flags_weak_comments_crlf_and_bom_survive", () => {
  const out = migrateOldEr(SHOP_CRLF);
  expect(out).toBe(
    "\uFEFF" +
      crlf(
        'diagram er "Shop"',
        "customers [weak, color: info] {",
        "  id int pk not null // key",
        "// how we reach them",
        "  email text",
        "}",
        "invoices [color: muted] {",
        "  customer_id int",
        "}",
        "invoices.customer_id > customers.id",
      ),
  );
  expect(parseFlow(out).problems).toEqual([]);
});

test("each_old_arrow_maps_and_only_the_arrow_changes", () => {
  expect(migrateOldEr(ARROWS)).toBe(
    lines("diagram er", "a", "b", "a < b : one--many [color: info]", "a > b", "a - b", "a - b // a -- b", "a <> b"),
  );
});

test("a_type_that_needs_quotes_is_quoted_and_columns_after_other_lines_still_move", () => {
  const out = migrateOldEr(QUOTED);
  expect(out).toBe(
    lines(
      "diagram er",
      "orders {",
      '  placed_at "timestamp with time zone"',
      '  status "pk" unique',
      "}",
      "customers {",
      "  id int",
      "}",
      "orders < customers",
    ),
  );
  expect(parseFlow(out).problems).toEqual([]);
});

test("migrating_twice_changes_nothing", () => {
  for (const old of [...FIXTURES, lines("diagram er", "t [weak]", "t.a int [pk]", "u", "t 1--1 u")]) {
    const once = migrateOldEr(old);
    expect(migrateOldEr(once)).toBe(once);
  }
});

test("only_the_first_old_problem_carries_the_rewrite", () => {
  const ps = parseFlow(README_BILLING).problems;
  const columns = ps.filter((p) => p.message === MESSAGES.oldColumn);
  expect(columns).toHaveLength(8);
  expect(ps[0]).toBe(columns[0]);
  expect(ps[0].fixes.map((f) => f.title)).toEqual([FIX_TITLES.rewriteBlocks]);
  expect(columns.slice(1).every((p) => p.fixes.length === 0)).toBe(true);
  const arrow = ps.find((p) => p.message === MESSAGES.oldCard("1--*", "<"))!;
  expect(arrow.fixes.map((f) => f.title)).toEqual(["Use <"]);
  expect(applyEdits(README_BILLING, ps[0].fixes[0].edits)).toBe(migrateOldEr(README_BILLING));
  expect(applyEdits(README_BILLING, arrow.fixes[0].edits)).toContain("\ncustomers < orders : places\n");
  // An old arrow first in the frame carries both.
  const first = parseFlow(lines("diagram er", "a", "b", "a 1--* b", "a.id int")).problems;
  expect(first.map((p) => p.message)).toEqual([MESSAGES.oldCard("1--*", "<"), MESSAGES.oldColumn]);
  expect(first[0].fixes.map((f) => f.title)).toEqual(["Use <", FIX_TITLES.rewriteBlocks]);
  expect(first[1].fixes).toEqual([]);
  expect(MESSAGES.oldColumn).toBe("Columns go inside their table's braces now.");
  expect(MESSAGES.oldCard("*--1", ">")).toBe("*--1 is the old way to write a relationship. Use >.");
  expect(MESSAGES.oldGroup).toBe("Groups start with the word group now: group Name {.");
  expect(FIX_TITLES.rewriteBlocks).toBe("Rewrite as table blocks");
});

test("the_fix_on_a_board_rewrites_only_its_frame", () => {
  const first = lines('diagram flow "Intro"', "Start [start]", "Finish [end]", "Start > Finish", "");
  const board = first + README_BILLING;
  const parsed = parseBoard(board);
  expect(parsed.frames).toHaveLength(2);
  const p = parsed.problems.find((x) => x.message === MESSAGES.oldColumn)!;
  const fixed = applyEdits(board, p.fixes[0].edits);
  expect(fixed.slice(0, first.length)).toBe(first);
  expect(fixed.slice(first.length)).toBe(migrateOldEr(README_BILLING));
  expect(parseBoard(fixed).problems).toEqual([]);
});

test("an_old_group_with_an_icon_takes_the_group_word_and_its_table_takes_columns_from_outside", () => {
  const ps = parseFlow(GROUP_ICON).problems;
  expect(ps.map((p) => [p.line, p.message])).toEqual([
    [2, MESSAGES.oldGroup],
    [4, MESSAGES.oldColumn],
    [6, MESSAGES.oldColumn],
  ]);
  expect(ps[0].fixes.map((f) => f.title)).toEqual([FIX_TITLES.rewriteBlocks]);
  expect(migrateOldEr(GROUP_ICON)).toBe(
    lines("diagram er", "group Billing [icon: aws-vpc] {", "  invoices {", "    total numeric", "    id int", "  }", "}"),
  );
});

test("nested_old_groups_and_an_empty_block_that_stays_a_table", () => {
  expect(migrateOldEr(NESTED)).toBe(
    lines("diagram er", "group Outer {", "  group Inner {", "    a {", "      id int", "    }", "  }", "  Empty {", "  }", "}"),
  );
  expect(parseFlow(NESTED).problems.filter((p) => p.message === MESSAGES.oldGroup).map((p) => p.line)).toEqual([2, 3]);
});

test("old_columns_join_a_new_table_block_after_its_columns", () => {
  expect(parseFlow(JOIN_BLOCK).problems.map((p) => p.message)).toEqual([MESSAGES.oldColumn]);
  expect(migrateOldEr(JOIN_BLOCK)).toBe(lines("diagram er", "orders {", "  id int", "  total numeric", "}"));
});

test("a_new_table_block_beside_an_old_group_stays_a_table", () => {
  expect(parseFlow(MIXED).problems.map((p) => [p.line, p.message])).toEqual([
    [5, MESSAGES.oldGroup],
    [7, MESSAGES.oldColumn],
  ]);
  expect(migrateOldEr(MIXED)).toBe(
    lines("diagram er", "orders {", "  id int", "}", "group Billing {", "  invoices {", "    total numeric", "  }", "}"),
  );
});

test("a_block_holding_a_table_with_old_columns_elsewhere_is_a_group", () => {
  expect(parseFlow(GROUP_BY_EVIDENCE).problems.map((p) => p.message)).toEqual([MESSAGES.oldGroup, MESSAGES.oldColumn]);
  expect(migrateOldEr(GROUP_BY_EVIDENCE)).toBe(lines("diagram er", "group Billing {", "  invoices {", "    total numeric", "  }", "}"));
});

test("a_block_without_evidence_stays_a_table_in_an_old_frame", () => {
  expect(parseFlow(TABLE_WITHOUT_EVIDENCE).problems.map((p) => p.message)).toEqual([MESSAGES.oldColumn]);
  expect(migrateOldEr(TABLE_WITHOUT_EVIDENCE)).toBe(lines("diagram er", "a {", "  id int", "}", "Billing {", "  invoices", "}"));
});

test("an_outside_tables_column_inside_a_group_moves_to_its_table", () => {
  expect(migrateOldEr(OUTSIDE_IN_GROUP)).toBe(lines("diagram er", "orders {", "  total numeric", "}", "group Billing {", "  invoices", "}"));
});

test("a_column_above_its_table_moves_down_to_it", () => {
  expect(parseFlow(ABOVE).problems.map((p) => p.message)).toEqual([MESSAGES.oldColumn]);
  expect(migrateOldEr(ABOVE)).toBe(lines("diagram er", "orders {", "  id int pk", "}"));
});

test("a_dotted_table_name_takes_the_longest_prefix", () => {
  expect(parseFlow(DOTTED).problems.map((p) => p.message)).toEqual([MESSAGES.oldColumn, MESSAGES.oldColumn]);
  expect(migrateOldEr(DOTTED)).toBe(lines("diagram er", "sales.orders {", "  id int", "  note text", "}"));
});

test("array_types_keep_their_brackets", () => {
  expect(parseFlow(ARRAYS).problems.map((p) => p.message)).toEqual([MESSAGES.oldColumn, MESSAGES.oldColumn, MESSAGES.oldColumn]);
  expect(migrateOldEr(ARRAYS)).toBe(lines("diagram er", "a {", "  tags int[]", "  ids text[] pk", "  grid int[][] // cells", "}"));
});

test("a_new_frame_reads_as_before_and_is_left_alone", () => {
  const text = lines("diagram er", "Billing {", "  id int", "}", '"x\\"y" // a "quote', "Billing > x");
  expect(parseFlow(text).problems.some((p) => isOld(p.message))).toBe(false);
  expect(migrateOldEr(text)).toBe(text);
});

test("an_escaped_quote_does_not_hide_a_comment", () => {
  // The name ends at its closing quote, so `// a "b` is a comment, and the line is a table.
  const old = lines("diagram er", '"x\\"y" [entity] // a "b', "a", "a.id int");
  expect(migrateOldEr(old)).toBe(lines("diagram er", '"x\\"y" // a "b', "a {", "  id int", "}"));
});

test("every_fixture_is_free_of_old_forms_after_the_first_fix", () => {
  for (const old of FIXTURES) {
    const ps = parseFlow(old).problems;
    const first = ps.find((p) => isOld(p.message))!;
    const fix = first.fixes.find((f) => f.title === FIX_TITLES.rewriteBlocks)!;
    const fixed = applyEdits(old, fix.edits);
    expect(fixed).toBe(migrateOldEr(old));
    expect(parseFlow(fixed).problems.filter((p) => isOld(p.message))).toEqual([]);
  }
});

test("a_tables_own_old_column_inside_its_block_stays_in_place", () => {
  expect(parseFlow(OWN_COLUMN_IN_BLOCK).problems.map((p) => p.message)).toEqual([MESSAGES.oldColumn]);
  expect(migrateOldEr(OWN_COLUMN_IN_BLOCK)).toBe(lines("diagram er", "orders {", "  id int pk", "  name text", "  total numeric", "}"));
});

test("a_typeless_dotted_column_of_a_new_block_is_no_old_form", () => {
  const text = lines("diagram er", "audit {", "  id", "  audit.entry", "}");
  const r = parseFlow(text);
  expect(r.problems).toEqual([]);
  expect(r.doc!.nodes[0].rows).toEqual(["id", "audit.entry"]);
  expect(migrateOldEr(text)).toBe(text);
});

test("a_typed_block_holding_another_tables_old_column_stays_a_table", () => {
  expect(parseFlow(FOREIGN_COLUMN_IN_BLOCK).problems.map((p) => p.message)).toEqual([MESSAGES.oldColumn]);
  expect(migrateOldEr(FOREIGN_COLUMN_IN_BLOCK)).toBe(lines("diagram er", "customers {", "  id int", "}", "orders {", "  id int", "}"));
});

test("an_arrow_inside_a_table_block_is_no_old_form", () => {
  const text = lines("diagram er", "orders {", "  id int", "  note text -- legacy", "}", "orders.x > orders.id");
  const messages = parseFlow(text).problems.map((p) => p.message);
  expect(messages).toContain(MESSAGES.noColumn("orders", "x"));
  expect(messages.some(isOld)).toBe(false);
  expect(migrateOldEr(text)).toBe(text);
});

test("a_dotted_name_with_a_kind_or_attrs_beside_its_prefix_table_is_a_node", () => {
  const old = lines("diagram er", "sales.orders [entity]", "sales", "sales.id int", "sales.orders -- sales");
  const out = migrateOldEr(old);
  // No line is lost: the dotted entity stays a table of its own, and its line stays where it was.
  expect(out).toBe(lines("diagram er", "sales.orders", "sales {", "  id int", "}", "sales.orders - sales"));
  const r = parseFlow(out);
  expect(r.problems).toEqual([]);
  expect(r.doc!.nodes.map((n) => n.name)).toEqual(["sales.orders", "sales"]);
  expect(r.doc!.links).toEqual([{ from: "sales.orders", to: "sales", arrow: "-" }]);
  for (const line of ["sales.items [weak]", "sales.items [icon: box]", "sales.items [label: Items, color: info]", "sales.items [entity]"]) {
    const text = lines("diagram er", "sales {", "  id int", "}", line);
    expect(parseFlow(text).problems).toEqual([]);
    expect(migrateOldEr(text)).toBe(text);
  }
});

test("a_bare_typeless_dotted_name_is_old_only_beside_other_old_forms", () => {
  const fresh = lines("diagram er", "sales {", "  id int", "}", "sales.orders");
  expect(parseFlow(fresh).problems).toEqual([]);
  expect(migrateOldEr(fresh)).toBe(fresh);
  const old = lines("diagram er", "sales", "sales.id int", "sales.code");
  expect(parseFlow(old).problems.map((p) => p.message)).toEqual([MESSAGES.oldColumn, MESSAGES.oldColumn]);
  expect(migrateOldEr(old)).toBe(lines("diagram er", "sales {", "  id int", "  code", "}"));
});
