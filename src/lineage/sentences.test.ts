import { expect, test } from "vitest";
import type { Lineage, LineageLink, LineageTable, ObjectPath } from "../api/types";
import {
  type KeyContext,
  columnsText,
  deleteEffects,
  deleteTitle,
  flowMatches,
  flowSentence,
  linkSentence,
  processSentence,
  tablesCount,
  tagOf,
  updateSentence,
} from "./sentences";

const p = (name: string): ObjectPath => ({ database: "kestrel", schema: "shop", name });

function link(from: string, fromColumns: string[], to: string, toColumns: string[], more: Partial<LineageLink> = {}): LineageLink {
  return { from: p(from), fromColumns, to: p(to), toColumns, onDelete: null, onUpdate: null, nullable: false, ...more };
}

const table = (name: string, distance: number): LineageTable => ({ path: p(name), columns: [], columnCount: 4, distance, unreadable: null });

function lineageOf(center: string, links: LineageLink[]): Lineage {
  const names = [center, ...new Set(links.flatMap((l) => [l.from.name, l.to.name]).filter((n) => n !== center))];
  return { center: p(center), tables: names.map((n, i) => table(n, i === 0 ? 0 : 1)), links, truncated: false };
}

const ORDERS = p("orders");
const customer = link("orders", ["customer_id"], "customers", ["id"], { onDelete: "RESTRICT" });
const store = link("orders", ["store_id"], "stores", ["id"], { onDelete: "SET NULL", nullable: true });
const lines = link("order_lines", ["order_id"], "orders", ["id"], { onDelete: "CASCADE" });
const shipments = link("shipments", ["order_id"], "orders", ["id"], { onDelete: "NO ACTION" });

const DELETES = [null, "RESTRICT", "NO ACTION", "CASCADE", "SET NULL", "SET DEFAULT"] as const;

test("restrict_and_no_action_block", () => {
  for (const onDelete of [null, "RESTRICT", "NO ACTION"]) {
    const l = link("shipments", ["order_id"], "orders", ["id"], { onDelete });
    expect(tagOf(l)).toBe("blocks");
    expect(linkSentence(l, ORDERS)).toBe("An order with shipments can't be deleted");
  }
});

test("cascade_also_deletes", () => {
  expect(tagOf(lines)).toBe("cascade");
  expect(linkSentence(lines, ORDERS)).toBe("Order lines go when their order goes");
  // The Core writes the rule in upper case; any case reads the same.
  expect(tagOf({ ...lines, onDelete: "cascade" })).toBe("cascade");
});

test("set_null_and_set_default_are_info", () => {
  expect(tagOf(store)).toBe("info");
  expect(linkSentence(store, ORDERS)).toBe("An order can have no store");
  expect(tagOf({ ...store, onDelete: "SET DEFAULT" })).toBe("info");
  // Seen from the table pointed to.
  expect(linkSentence(store, p("stores"))).toBe("Orders lose their store when it goes");
  expect(linkSentence({ ...store, onDelete: "SET DEFAULT" }, p("stores"))).toBe("Orders get the default store when theirs goes");
});

test("a_required_column_needs_its_table", () => {
  expect(linkSentence(customer, ORDERS)).toBe("Every order needs a customer");
  expect(tagOf(customer)).toBe("blocks");
  expect(linkSentence(link("orders", ["address_id"], "addresses", ["id"]), ORDERS)).toBe("Every order needs an address");
});

test("columns_read_from_the_center", () => {
  expect(columnsText(customer, ORDERS)).toBe("customer_id → customers.id");
  expect(columnsText(lines, ORDERS)).toBe("order_lines.order_id");
});

test("every_on_delete_and_on_update_combination", () => {
  const updates: Record<string, string | null> = {
    null: null,
    RESTRICT: null,
    "NO ACTION": null,
    CASCADE: "A changed order key carries over to its order lines",
    "SET NULL": "Changing an order key empties it in its order lines",
    // A key that can't be empty: SET NULL can't run, so it reads like RESTRICT.
    "SET NULL!": null,
    "SET DEFAULT": "Changing an order key sets its order lines to the default",
    // With no table details the default is unchecked; a key that can't be empty depends on it.
    "SET DEFAULT?": "Changing an order key sets its order lines to the default, if order_id has a default",
  };
  const deletes: Record<string, string> = {
    null: "An order with order lines can't be deleted",
    RESTRICT: "An order with order lines can't be deleted",
    "NO ACTION": "An order with order lines can't be deleted",
    CASCADE: "Order lines go when their order goes",
    "SET NULL": "Order lines lose their order when it goes",
    "SET NULL!": "An order with order lines can't be deleted: order_id can't be empty",
    "SET DEFAULT": "Order lines get the default order when theirs goes",
    "SET DEFAULT?": "Order lines get the default order when theirs goes, if order_id has a default",
  };
  const tags: Record<string, string> = {
    null: "blocks",
    RESTRICT: "blocks",
    "NO ACTION": "blocks",
    CASCADE: "cascade",
    "SET NULL": "info",
    "SET NULL!": "blocks",
    // With no table details the defaults are unknown: the default is assumed to apply.
    "SET DEFAULT": "info",
    "SET DEFAULT?": "info",
  };
  for (const onDelete of DELETES) {
    for (const onUpdate of DELETES) {
      for (const nullable of [false, true]) {
        const l = link("order_lines", ["order_id"], "orders", ["id"], { onDelete, onUpdate, nullable });
        const stuck = (r: string | null) =>
          r === "SET NULL" && !nullable ? "SET NULL!" : r === "SET DEFAULT" && !nullable ? "SET DEFAULT?" : String(r);
        // The delete rule picks the tag and the sentence, with whether the key can be emptied; on-update adds its own line.
        expect(tagOf(l)).toBe(tags[stuck(onDelete)]);
        expect(linkSentence(l, ORDERS)).toBe(deletes[stuck(onDelete)]);
        expect(updateSentence(l)).toBe(updates[stuck(onUpdate)]);
        // From the holder, the sentence says whether the key can be empty.
        expect(linkSentence(l, p("order_lines"))).toBe(nullable ? "An order line can have no order" : "Every order line needs an order");
        for (const s of [linkSentence(l, ORDERS), linkSentence(l, p("order_lines")), updateSentence(l) ?? ""]) {
          expect(s).not.toMatch(/\u2014|cursor|caret/i);
        }
      }
    }
  }
});

test("delete_effects_list_blocks_and_cascades", () => {
  const all = lineageOf("orders", [customer, store, lines, shipments]);
  expect(deleteEffects(all, ORDERS)).toEqual({ blocks: ["A shipment stops the delete."], cascades: ["Its order lines go with it."], incomplete: null });
  expect(deleteTitle(ORDERS)).toBe("Before you delete an order");
  // Only keys the table holds: deleting it changes nothing elsewhere.
  expect(deleteEffects(lineageOf("orders", [customer, store]), ORDERS)).toEqual({ blocks: [], cascades: [], incomplete: null });
  // SET NULL changes the other rows but neither stops nor deletes.
  expect(deleteEffects(lineageOf("stores", [store]), p("stores"))).toEqual({ blocks: [], cascades: [], incomplete: null });
});

test("delete_effects_follow_cascades", () => {
  const notes = link("line_notes", ["line_id"], "order_lines", ["id"], { onDelete: "CASCADE" });
  const refunds = link("refunds", ["line_id"], "order_lines", ["id"], { onDelete: "RESTRICT" });
  const all = lineageOf("orders", [lines, notes, refunds, shipments]);
  expect(deleteEffects(all, ORDERS)).toEqual({
    blocks: ["A shipment stops the delete.", "A refund on its order lines stops the delete."],
    cascades: ["Its order lines go with it.", "Line notes of its order lines go too."],
    incomplete: null,
  });
});

test("sentences_composite_and_self", () => {
  // A composite key: every column on both sides is named, in key order.
  const composite = link("notes", ["note_order", "note_line"], "order_lines", ["order_id", "line_no"], { onDelete: "CASCADE" });
  const fromHolder = `${linkSentence(composite, p("notes"))} ${columnsText(composite, p("notes"))}`;
  const fromTarget = `${linkSentence(composite, p("order_lines"))} ${columnsText(composite, p("order_lines"))}`;
  for (const text of [fromHolder, fromTarget]) {
    for (const c of ["note_order", "note_line", "order_id", "line_no"]) expect(text).toContain(c);
  }
  expect(columnsText(composite, p("notes"))).toBe("(note_order, note_line) → order_lines.(order_id, line_no)");
  expect(columnsText(composite, p("order_lines"))).toBe("notes.(note_order, note_line) → (order_id, line_no)");

  // A self-reference names its column in the sentence, the columns and the delete effect.
  const manager = link("employees", ["manager_id"], "employees", ["id"], { nullable: true, onDelete: "CASCADE" });
  const boss = p("employees");
  expect(linkSentence(manager, boss)).toBe("An employee can point to another employee through manager_id");
  expect(linkSentence({ ...manager, nullable: false }, boss)).toBe("Every employee points to another employee through manager_id");
  expect(columnsText(manager, boss)).toBe("manager_id → employees.id");
  expect(deleteEffects(lineageOf("employees", [manager]), boss)).toEqual({
    blocks: [],
    cascades: ["Other employees that point to it through manager_id go with it."],
    incomplete: null,
  });
  expect(deleteEffects(lineageOf("employees", [{ ...manager, onDelete: "RESTRICT" }]), boss)).toEqual({
    blocks: ["Another employee that points to it through manager_id stops the delete."],
    cascades: [],
    incomplete: null,
  });

  // A cycle of cascades ends, and each effect is listed once.
  const ab = link("cyc_a", ["b_id"], "cyc_b", ["id"], { onDelete: "CASCADE" });
  const ba = link("cyc_b", ["a_id"], "cyc_a", ["id"], { onDelete: "CASCADE" });
  const cycle = deleteEffects(lineageOf("cyc_a", [ab, ba]), p("cyc_a"));
  expect(cycle.blocks).toEqual([]);
  expect(cycle.cascades).toEqual(["Its cyc bs go with it.", "Cyc as of its cyc bs go too."]);
});

test("singular_and_plural_use_the_step6_nouns", () => {
  const cat = link("products", ["category_id"], "categories", ["id"]);
  expect(linkSentence(cat, p("products"))).toBe("Every product needs a category");
  expect(deleteTitle(p("categories"))).toBe("Before you delete a category");
  expect(deleteTitle(p("people"))).toBe("Before you delete a person");
  // A name the rules are unsure of reads by rows of the table.
  const menus = link("menus", ["shop_id"], "shops", ["id"], { onDelete: "CASCADE" });
  expect(linkSentence(menus, p("shops"))).toBe("Rows of menus go when their shop goes");
  expect(deleteTitle(p("menus"))).toBe("Before you delete a row of menus");
  expect(deleteEffects(lineageOf("shops", [menus]), p("shops")).cascades).toEqual(["Its rows of menus go with it."]);
  expect(tablesCount(1)).toBe("1 table");
  expect(tablesCount(2)).toBe("2 tables");
});

test("flow_rows_and_both_sentences", () => {
  expect(flowSentence("checkout", "writes", ORDERS)).toBe("Checkout writes orders");
  expect(flowSentence("fulfilment", "reads", ORDERS)).toBe("Fulfilment reads orders");
  expect(flowSentence("checkout", "both", ORDERS)).toBe("Checkout reads and writes orders");
  expect(flowSentence("stock", "reads", p("order_lines"))).toBe("Stock reads order lines");
  expect(flowMatches("shop.orders", ORDERS)).toBe(true);
  expect(flowMatches("orders", ORDERS)).toBe(true);
  expect(flowMatches("Shop.Orders", ORDERS)).toBe(true);
  expect(flowMatches('"shop"."orders"', ORDERS)).toBe(true);
  expect(flowMatches("kestrel.shop.orders", ORDERS)).toBe(true);
  expect(flowMatches("sales.orders", ORDERS)).toBe(false);
  expect(flowMatches("order_lines", ORDERS)).toBe(false);
  expect(flowMatches("kestrel.orders", { database: "kestrel", schema: null, name: "orders" })).toBe(true);
});

// ---- Fix round 1 (P14) ----

const c = (name: string, nullable: boolean) => ({ name, ty: "bigint", pk: false, fk: true, nullable });

/** A lineage of `center` whose holder cards carry the key columns' nullability. */
function withCards(center: string, links: LineageLink[], cols: Record<string, ReturnType<typeof c>[]>, more: Partial<Lineage> = {}): Lineage {
  const l = lineageOf(center, links);
  return { ...l, tables: l.tables.map((t) => ({ ...t, columns: cols[t.path.name] ?? [] })), ...more };
}

const samePathTest = (a: ObjectPath, b: ObjectPath) => a.database === b.database && a.schema === b.schema && a.name === b.name;

test("tags_follow_what_the_delete_can_do", () => {
  const cases: {
    name: string;
    l: LineageLink;
    cols: ReturnType<typeof c>[];
    defaults?: Record<string, boolean>;
    tag: string;
    sentence: string;
    effect: { blocks: string[]; cascades: string[] };
  }[] = [
    {
      name: "cascade",
      l: link("order_lines", ["order_id"], "orders", ["id"], { onDelete: "CASCADE" }),
      cols: [c("order_id", false)],
      tag: "cascade",
      sentence: "Order lines go when their order goes",
      effect: { blocks: [], cascades: ["Its order lines go with it."] },
    },
    {
      name: "set null, the column can be empty",
      l: link("order_lines", ["order_id"], "orders", ["id"], { onDelete: "SET NULL", nullable: true }),
      cols: [c("order_id", true)],
      tag: "info",
      sentence: "Order lines lose their order when it goes",
      effect: { blocks: [], cascades: [] },
    },
    {
      name: "set null, the column can't be empty",
      // The Core's flag says some column can be empty; the card says this one can't.
      l: link("order_lines", ["order_id"], "orders", ["id"], { onDelete: "SET NULL", nullable: true }),
      cols: [c("order_id", false)],
      tag: "blocks",
      sentence: "An order with order lines can't be deleted: order_id can't be empty",
      effect: { blocks: ["An order line stops the delete: order_id can't be empty."], cascades: [] },
    },
    {
      name: "set null, a composite key with one column that can't be empty",
      l: link("notes", ["note_order", "note_line"], "orders", ["id", "line"], { onDelete: "SET NULL", nullable: true }),
      cols: [c("note_order", true), c("note_line", false)],
      tag: "blocks",
      sentence: "An order with notes can't be deleted: note_line can't be empty",
      effect: { blocks: ["A note stops the delete: note_line can't be empty."], cascades: [] },
    },
    {
      name: "restrict",
      l: link("shipments", ["order_id"], "orders", ["id"], { onDelete: "RESTRICT" }),
      cols: [c("order_id", false)],
      tag: "blocks",
      sentence: "An order with shipments can't be deleted",
      effect: { blocks: ["A shipment stops the delete."], cascades: [] },
    },
    {
      name: "no action",
      l: link("shipments", ["order_id"], "orders", ["id"], { onDelete: "NO ACTION" }),
      cols: [c("order_id", false)],
      tag: "blocks",
      sentence: "An order with shipments can't be deleted",
      effect: { blocks: ["A shipment stops the delete."], cascades: [] },
    },
    {
      name: "set default with a default",
      l: link("orders", ["store_id"], "stores", ["id"], { onDelete: "SET DEFAULT" }),
      cols: [c("store_id", false)],
      defaults: { store_id: true },
      tag: "info",
      sentence: "Orders get the default store when theirs goes",
      effect: { blocks: [], cascades: [] },
    },
    {
      name: "set default with no default on a column that can't be empty",
      l: link("orders", ["store_id"], "stores", ["id"], { onDelete: "SET DEFAULT" }),
      cols: [c("store_id", false)],
      defaults: { store_id: false },
      tag: "blocks",
      sentence: "A store with orders can't be deleted: store_id has no default and can't be empty",
      effect: { blocks: ["An order stops the delete: store_id has no default and can't be empty."], cascades: [] },
    },
    {
      name: "set default with no default on a column that can be empty",
      // The server puts NULL there, which the column takes.
      l: link("orders", ["store_id"], "stores", ["id"], { onDelete: "SET DEFAULT", nullable: true }),
      cols: [c("store_id", true)],
      defaults: { store_id: false },
      tag: "info",
      sentence: "Orders get the default store when theirs goes",
      effect: { blocks: [], cascades: [] },
    },
  ];
  for (const k of cases) {
    const center = k.l.to;
    const lineage = withCards(center.name, [k.l], { [k.l.from.name]: k.cols });
    const ctx: KeyContext = {
      lineage,
      hasDefault: (holder, column) => (samePathTest(holder, k.l.from) && k.defaults ? (k.defaults[column] ?? null) : null),
    };
    expect([k.name, tagOf(k.l, ctx)]).toEqual([k.name, k.tag]);
    expect([k.name, linkSentence(k.l, center, ctx)]).toEqual([k.name, k.sentence]);
    expect([k.name, deleteEffects(lineage, center, ctx.hasDefault)]).toEqual([k.name, { ...k.effect, incomplete: null }]);
  }
  // The update line is left out where the change can't run, as for RESTRICT.
  const stuck = link("order_lines", ["order_id"], "orders", ["id"], { onUpdate: "SET NULL", nullable: true });
  const cards = withCards("orders", [stuck], { order_lines: [c("order_id", false)] });
  expect(updateSentence(stuck, { lineage: cards })).toBeNull();
  expect(updateSentence(stuck, { lineage: withCards("orders", [stuck], { order_lines: [c("order_id", true)] }) })).toBe(
    "Changing an order key empties it in its order lines",
  );
  const noDefault = { ...stuck, onUpdate: "SET DEFAULT" };
  expect(updateSentence(noDefault, { lineage: cards, hasDefault: () => false })).toBeNull();
  expect(updateSentence(noDefault, { lineage: cards, hasDefault: () => true })).toBe("Changing an order key sets its order lines to the default");
});

test("an_unreadable_holder_falls_back_to_the_core_flag", () => {
  const l = link("order_lines", ["order_id"], "orders", ["id"], { onDelete: "SET NULL", nullable: false });
  const lineage = withCards("orders", [l], { order_lines: [c("order_id", true)] });
  const unreadable = { ...lineage, tables: lineage.tables.map((t) => (t.path.name === "order_lines" ? { ...t, unreadable: "Contura can't find this table." } : t)) };
  expect(tagOf(l, { lineage: unreadable })).toBe("blocks");
  expect(tagOf({ ...l, nullable: true }, { lineage: unreadable })).toBe("info");
});

test("the_list_says_when_it_may_be_incomplete", () => {
  const notes = link("line_notes", ["line_id"], "order_lines", ["id"], { onDelete: "CASCADE" });
  const base = lineageOf("orders", [lines, notes]);
  expect(deleteEffects({ ...base, truncated: true }, ORDERS).incomplete).toBe(
    "This list may be incomplete: reading stopped at Contura's 10s limit.",
  );
  const many = { ...base, truncated: true, tables: Array.from({ length: 300 }, (_, i) => table(`t${i}`, 1)) };
  expect(deleteEffects(many, ORDERS).incomplete).toBe("This list may be incomplete: Contura reads at most 300 tables.");
  // A table reached through a cascade that can't be read: what points to it is unknown.
  const hidden = { ...base, tables: base.tables.map((t) => (t.path.name === "order_lines" ? { ...t, unreadable: "Contura can't find this table." } : t)) };
  expect(deleteEffects(hidden, ORDERS).incomplete).toBe("This list may be incomplete: Contura can't read order_lines.");
  // An unreadable table that only stops the delete hides nothing further.
  const blocker = lineageOf("orders", [shipments]);
  const blockerHidden = { ...blocker, tables: blocker.tables.map((t) => (t.path.name === "shipments" ? { ...t, unreadable: "x" } : t)) };
  expect(deleteEffects(blockerHidden, ORDERS).incomplete).toBeNull();
});

test("a_self_reference_reached_through_a_cascade_is_listed", () => {
  const cats = link("categories", ["store_id"], "stores", ["id"], { onDelete: "CASCADE" });
  const parent = link("categories", ["parent_id"], "categories", ["id"], { onDelete: "RESTRICT", nullable: true });
  expect(deleteEffects(lineageOf("stores", [cats, parent]), p("stores"))).toEqual({
    blocks: ["A category that points to one of its categories through parent_id stops the delete."],
    cascades: ["Its categories go with it."],
    incomplete: null,
  });
  const tree = { ...parent, onDelete: "CASCADE" };
  expect(deleteEffects(lineageOf("stores", [cats, tree]), p("stores")).cascades).toEqual([
    "Its categories go with it.",
    "Categories that point to its categories through parent_id go too.",
  ]);
});

test("effects_from_two_schemas_stay_apart", () => {
  const at = (schema: string, name: string): ObjectPath => ({ database: "kestrel", schema, name });
  const a: LineageLink = { ...shipments, from: at("sales", "returns"), to: ORDERS };
  const b: LineageLink = { ...shipments, from: at("archive", "returns"), to: ORDERS };
  const both: Lineage = {
    center: ORDERS,
    tables: [table("orders", 0), { ...table("returns", 1), path: a.from }, { ...table("returns", 1), path: b.from }],
    links: [a, b],
    truncated: false,
  };
  expect(deleteEffects(both, ORDERS).blocks).toEqual(["A return stops the delete (sales.returns).", "A return stops the delete (archive.returns)."]);
  // The same holder through two keys is still one line.
  const twice: Lineage = { ...both, tables: both.tables.slice(0, 2), links: [a, { ...a, fromColumns: ["other_id"] }] };
  expect(deleteEffects(twice, ORDERS).blocks).toEqual(["A return stops the delete."]);
});

test("a_or_an_by_sound", () => {
  expect(linkSentence(link("orders", ["user_id"], "users", ["id"]), ORDERS)).toBe("Every order needs a user");
  expect(deleteTitle(p("users"))).toBe("Before you delete a user");
  expect(deleteTitle(p("units"))).toBe("Before you delete a unit");
  expect(deleteTitle(p("hours"))).toBe("Before you delete an hour");
  expect(deleteTitle(p("uploads"))).toBe("Before you delete an upload");
  expect(deleteTitle(p("euros"))).toBe("Before you delete a euro");
  expect(deleteTitle(p("items"))).toBe("Before you delete an item");
});

// ---- Fix round 2 (P15) ----

test("an_unchecked_default_is_said_not_assumed", () => {
  const l = link("orders", ["store_id"], "stores", ["id"], { onDelete: "SET DEFAULT", onUpdate: "SET DEFAULT" });
  const STORES = p("stores");
  const lineage = withCards("stores", [l], { orders: [c("store_id", false)] });
  const states: { name: string; has: boolean | "failed" | null; sentence: string; tag: string; incomplete: string | null; blocks: string[] }[] = [
    {
      name: "loading",
      has: null,
      sentence: "Orders get the default store when theirs goes, if store_id has a default",
      tag: "info",
      incomplete: "This list may be incomplete: Contura hasn't checked the defaults of store_id.",
      blocks: [],
    },
    {
      name: "failed",
      has: "failed",
      sentence: "Orders get the default store when theirs goes, if store_id has a default",
      tag: "info",
      incomplete: "This list may be incomplete: Contura couldn't read the defaults of orders.",
      blocks: [],
    },
    { name: "has a default", has: true, sentence: "Orders get the default store when theirs goes", tag: "info", incomplete: null, blocks: [] },
    {
      name: "no default",
      has: false,
      sentence: "A store with orders can't be deleted: store_id has no default and can't be empty",
      tag: "blocks",
      incomplete: null,
      blocks: ["An order stops the delete: store_id has no default and can't be empty."],
    },
  ];
  for (const k of states) {
    const ctx: KeyContext = { lineage, hasDefault: () => k.has };
    expect([k.name, linkSentence(l, STORES, ctx)]).toEqual([k.name, k.sentence]);
    expect([k.name, tagOf(l, ctx)]).toEqual([k.name, k.tag]);
    const e = deleteEffects(lineage, STORES, ctx.hasDefault);
    expect([k.name, e.incomplete, e.blocks]).toEqual([k.name, k.incomplete, k.blocks]);
  }
  expect(updateSentence(l, { lineage, hasDefault: () => null })).toBe("Changing a store key sets its orders to the default, if store_id has a default");
  // A column that can be empty takes NULL when it has no default: nothing to check.
  const loose = link("orders", ["store_id"], "stores", ["id"], { onDelete: "SET DEFAULT", nullable: true });
  const looseCards = withCards("stores", [loose], { orders: [c("store_id", true)] });
  expect(linkSentence(loose, STORES, { lineage: looseCards, hasDefault: () => null })).toBe("Orders get the default store when theirs goes");
  expect(deleteEffects(looseCards, STORES, () => null).incomplete).toBeNull();
});

test("a_or_an_for_one_and_uni", () => {
  expect(deleteTitle(p("one_time_tokens"))).toBe("Before you delete a one time token");
  expect(deleteTitle(p("unicorns"))).toBe("Before you delete a unicorn");
  expect(deleteTitle(p("uninstalls"))).toBe("Before you delete an uninstall");
  expect(deleteTitle(p("unimportant_notes"))).toBe("Before you delete an unimportant note");
  expect(deleteTitle(p("onions"))).toBe("Before you delete an onion");
});

test("a_diagram_row_names_the_process_that_touches_the_table", () => {
  // The file is the row's second line, so the title names only the process (P18).
  expect(processSentence("Ship order", "reads", ORDERS)).toBe("Ship order reads orders");
  expect(processSentence("Checkout", "writes", ORDERS)).toBe("Checkout writes orders");
  expect(processSentence("Stock", "both", p("order_lines"))).toBe("Stock reads and writes order lines");
});
