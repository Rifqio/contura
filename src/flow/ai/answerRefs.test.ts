// An answer's backticked names found on the board: each match is a range in the text
// and the frame, shape and column it names; a name that is not one thing on the board stays code.
import { describe, expect, test } from "vitest";
import type { FlowOutline } from "../../api/types";
import { answerRefs, columnRing, docParts, outlineParts, type PartFrame, proseCodes, ringParts } from "./answerRefs";

const frame = (title: string, names: string[], columns: Record<string, string[]> = {}): PartFrame => ({
  title,
  names: new Set(names),
  columns: new Map(Object.entries(columns).map(([t, c]) => [t, new Set(c)])),
});

const CHECKOUT = frame("Checkout", ["Cart", "Pay"]);
const ORDERS = frame("Orders ERD", ["orders", "users"], { orders: ["id", "total"], users: ["id", "email"] });
const REFUND = frame("Refund", ["Ask", "Pay"]);

describe("answerRefs", () => {
  test("a_backticked_name_in_one_frame_links", () => {
    const text = "Open `Cart` first, then Cart again.";
    const links = answerRefs(text, [CHECKOUT, ORDERS, REFUND]);
    expect(links).toEqual([{ from: 6, to: 10, at: 0, frame: "Checkout", name: "Cart", column: null }]);
    expect(text.slice(links[0].from, links[0].to)).toBe("Cart");
  });

  test("a_title_prefix_picks_the_frame", () => {
    const links = answerRefs("`Refund: Pay` is the late one, `Checkout: Pay` the early one.", [CHECKOUT, ORDERS, REFUND]);
    expect(links.map((l) => [l.at, l.frame, l.name])).toEqual([
      [2, "Refund", "Pay"],
      [0, "Checkout", "Pay"],
    ]);
    // A prefix naming a frame that lacks the name links nothing, and a frame title twice cannot pick.
    expect(answerRefs("`Refund: Cart`", [CHECKOUT, REFUND])).toEqual([]);
    expect(answerRefs("`Checkout: Cart`", [CHECKOUT, { ...CHECKOUT, names: new Set(["Cart", "Other"]) }])).toEqual([]);
  });

  test("a_name_in_two_frames_without_a_title_stays_code", () => {
    expect(answerRefs("`Pay` is in both.", [CHECKOUT, ORDERS, REFUND])).toEqual([]);
    // A name only one of two same-titled frames has still links, by the frame's place.
    const twin = frame("Checkout", ["Extra"]);
    expect(answerRefs("`Extra`", [CHECKOUT, twin]).map((l) => [l.at, l.name])).toEqual([[1, "Extra"]]);
    expect(answerRefs("`Missing`", [CHECKOUT])).toEqual([]);
  });

  test("table_dot_column_links_the_column", () => {
    const links = answerRefs("Check `orders.total` and `Orders ERD: users.email`, not `orders.nope`.", [CHECKOUT, ORDERS]);
    expect(links.map((l) => [l.frame, l.name, l.column])).toEqual([
      ["Orders ERD", "orders", "total"],
      ["Orders ERD", "users", "email"],
    ]);
    // A bare column is not a part; the table by itself is.
    expect(answerRefs("`total` `orders`", [ORDERS]).map((l) => [l.name, l.column])).toEqual([["orders", null]]);
    // A shape whose own name has a dot is the shape, not a table and column.
    expect(answerRefs("`v1.api`", [frame("Api", ["v1.api"], { v1: ["api"] })]).map((l) => [l.name, l.column])).toEqual([["v1.api", null]]);
  });

  test("names_in_code_blocks_never_link", () => {
    const text = ["Before `Cart`.", "```sql", "select `Cart` from `Pay`", "```", "After `Pay`?", "~~~", "`Cart`"].join("\n");
    const links = answerRefs(text, [frame("Checkout", ["Cart", "Pay"])]);
    expect(links.map((l) => text.slice(l.from, l.to))).toEqual(["Cart", "Pay", "Cart"]);
    expect(links.map((l) => l.from)).toEqual([text.indexOf("Cart"), text.lastIndexOf("`Pay`") + 1, text.lastIndexOf("`Cart`") + 1]);
    // An unclosed fence runs to the end.
    expect(answerRefs("```\n`Cart`", [CHECKOUT])).toEqual([]);
    expect(proseCodes("a `b`\n```\n`c`\n```\n`d`").map((c) => c.text)).toEqual(["b", "d"]);
  });

  test("a_shape_named_like_a_title_prefix_still_links_as_a_bare_name", () => {
    const f = frame("Refund", ["Refund: Ask", "Ask"]);
    // The prefix reads as `Refund` + `Ask`, which is a shape of that frame too: the prefix wins.
    expect(answerRefs("`Refund: Ask`", [f]).map((l) => l.name)).toEqual(["Ask"]);
    // Without that shape, the whole text is a bare name of the one frame that has it.
    const g = frame("Other", ["Refund: Pay"]);
    expect(answerRefs("`Refund: Pay`", [frame("Refund", ["Ask"]), g]).map((l) => [l.at, l.name])).toEqual([[1, "Refund: Pay"]]);
  });

  test("double_backticks_and_unicode_names_and_groups", () => {
    // `` `Cart` `` reads as the INLINE pattern reads it: the code is Cart, as AnswerText draws it.
    expect(answerRefs("``Cart``", [CHECKOUT]).map((l) => "``Cart``".slice(l.from, l.to))).toEqual(["Cart"]);
    const uni = frame("Zahlungen \u2713", ["Caf\u00e9", "\u6ce8\u6587", "Gruppe"]);
    expect(answerRefs("`Zahlungen \u2713: Caf\u00e9` und `\u6ce8\u6587`", [uni]).map((l) => l.name)).toEqual(["Caf\u00e9", "\u6ce8\u6587"]);
    // A group is in `names`, so it links like a shape.
    expect(answerRefs("`Gruppe`", [uni]).map((l) => [l.name, l.column])).toEqual([["Gruppe", null]]);
  });

  test("the_same_code_text_twice_links_twice", () => {
    const text = "`Cart` then `Cart`";
    const links = answerRefs(text, [CHECKOUT]);
    expect(links.map((l) => l.from)).toEqual([1, 13]);
    expect(proseCodes(text).map((c) => c.from)).toEqual([1, 13]);
  });

  test("bold_around_code_and_text_without_backticks_never_link", () => {
    expect(answerRefs("**`Cart`** and Cart", [CHECKOUT])).toEqual([]);
    expect(answerRefs("no code here", [CHECKOUT])).toEqual([]);
  });
});

describe("parts of a frame", () => {
  test("outlineParts_and_docParts_read_names_groups_and_columns", () => {
    const outline = {
      kind: "er",
      kinds: [],
      nodes: [
        { name: "orders", id: null, kind: "table", group: null, line: 2, table: false, columns: ["id", "total"] },
        { name: "Cart", id: null, kind: null, group: "Shop", line: 3, table: false },
      ],
      groups: [{ name: "Shop", group: null, line: 1 }],
      links: [],
    } as unknown as FlowOutline;
    const [o] = outlineParts([{ title: "Orders ERD", outline }]);
    expect([...o.names].sort()).toEqual(["Cart", "Shop", "orders"]);
    expect([...o.columns.get("orders")!]).toEqual(["id", "total"]);
    expect(o.columns.has("Cart")).toBe(false);
    const d = docParts("Orders ERD", {
      kind: "er",
      title: "Orders ERD",
      comments: [],
      nodes: [{ name: "orders", kind: "table", attrs: {}, rows: ["id int", "total"] }, { name: "Cart", kind: "box", attrs: {} }],
      links: [],
      groups: [{ name: "Shop", nodes: ["Cart"], groups: [{ name: "Inner", nodes: [], groups: [] }] }],
    } as never);
    expect([...d.names].sort()).toEqual(["Cart", "Inner", "Shop", "orders"]);
    expect([...d.columns.get("orders")!]).toEqual(["id", "total"]);
  });

  test("ringParts_keys_by_layout_key_and_marks_a_column_apart_from_its_table", () => {
    const links = answerRefs("`orders` `orders.total` `Cart`", [CHECKOUT, ORDERS]);
    const ring = ringParts(links, (at) => ["Checkout", "\u0000#1"][at]);
    expect([...ring.keys()]).toEqual(["\u0000#1", "Checkout"]);
    expect([...ring.get("\u0000#1")!]).toEqual(["orders", columnRing("orders", "total")]);
    expect(columnRing("orders", "total")).not.toBe("orders.total");
  });
});
