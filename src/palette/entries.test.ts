import { expect, test } from "vitest";
import type { ConnectionConfig, DiagramEntry, RecentItem, SavedQuery } from "../api/types";
import { resolveKeymap } from "../commands/keymap";
import { COMMANDS, type CommandId } from "../commands/registry";
import { objectKey } from "../objectPath";
import { NameIndex } from "./nameIndex";
import { MAX_RESULTS, type QuickItem, createQuickSearch, modeOf, paletteRows, quickItems, quickRows } from "./entries";

const conn = (id: string, name: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name,
  dialect: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
  ...over,
});

const connections = [conn("p", "shop_prod", { production: true }), conn("a", "analytics", { dialect: "mysql", database: "analytics" })];

function index() {
  const idx = new NameIndex();
  idx.keep("p", "shop", "public", [
    { kind: "table", name: "orders", rows: 1 },
    { kind: "table", name: "inventory_moves", rows: 1 },
    { kind: "view", name: "order_totals", rows: null },
  ]);
  idx.keep("p", "shop", "billing", [
    { kind: "table", name: "invoices", rows: 1 },
    { kind: "table", name: "invoice_lines", rows: 1 },
    { kind: "view", name: "open_invoices", rows: null },
    { kind: "function", name: "next_invoice_no", rows: null },
  ]);
  return idx;
}

const saved: SavedQuery[] = [
  { id: "q1", name: "Unpaid invoices", sql: "select 1", updatedAtMs: 1, connectionId: "p" },
  { id: "q2", name: "Top customers", sql: "select 2", updatedAtMs: 1, connectionId: "p", kind: "visual", visualJson: "{}" },
];
const diagrams: DiagramEntry[] = [{ name: "order-flow", kind: "flow", title: "order-flow", modifiedMs: 50 }];
const recent: RecentItem[] = [
  { target: { kind: "table", path: { database: "shop", schema: "billing", name: "invoices" }, object: "table" }, connectionId: "p", openedAtMs: 100 },
  // Never loaded this session: Recent is the fallback for a closed Connection's table.
  { target: { kind: "table", path: { database: "analytics", schema: null, name: "daily_orders" }, object: "table" }, connectionId: "a", openedAtMs: 90 },
  { target: { kind: "query", savedId: "q1", name: "Unpaid invoices" }, connectionId: "p", openedAtMs: 80 },
  { target: { kind: "schemaModel", file: "C:/models/shop-v2.dbml" }, connectionId: "p", openedAtMs: 10 },
];

function items(over: { activeId?: string | null } = {}) {
  return quickItems({
    connections,
    openIds: new Set(["p"]),
    names: index(),
    savedQueries: saved,
    diagrams,
    recent,
    activeId: over.activeId ?? null,
  });
}

const names = (rows: { item: QuickItem }[]) => rows.map((r) => r.item.name);
const hits = (parts: { text: string; hit: boolean }[]) => parts.filter((p) => p.hit).map((p) => p.text).join("");

test("the_list_mixes_objects_saved_queries_diagrams_and_models_with_their_connection", () => {
  const { all } = items();
  const by = (name: string) => all.find((i) => i.name === name)!;
  expect(by("orders")).toMatchObject({ kind: "table", qualifier: "public", connection: { name: "shop_prod", production: true, open: true } });
  expect(by("orders").id).toBe(objectKey("p", "table", { database: "shop", schema: "public", name: "orders" }));
  expect(by("next_invoice_no")).toMatchObject({ kind: "function", qualifier: "billing" });
  expect(by("Unpaid invoices")).toMatchObject({ kind: "saved", qualifier: null });
  expect(by("Top customers")).toMatchObject({ kind: "visual" });
  expect(by("order-flow")).toMatchObject({ kind: "flow", connection: null });
  expect(by("shop-v2.dbml")).toMatchObject({ kind: "model" });
  // A closed Connection's table, from Recent; MySQL qualifies by database.
  expect(by("daily_orders")).toMatchObject({ kind: "table", qualifier: "analytics", connection: { name: "analytics", open: false } });
  // Each object once, though both the index and Recent know invoices.
  expect(all.filter((i) => i.name === "invoices")).toHaveLength(1);
});

test("an_empty_box_lists_recent_in_homes_order_without_the_active_tab", () => {
  const { all, recentIds } = items({ activeId: objectKey("p", "table", { database: "shop", schema: "billing", name: "invoices" }) });
  const rows = quickRows(all, recentIds, "");
  // Recent and diagrams by time, newest first, as Home's Recent column.
  expect(names(rows)).toEqual(["daily_orders", "Unpaid invoices", "order-flow", "shop-v2.dbml"]);
  expect(rows[0].section).toBe("recently opened");
  expect(rows.slice(1).every((r) => r.section === null)).toBe(true);
});

test("typing_ranks_recent_matches_first_then_by_score_then_shorter_names", () => {
  const { all, recentIds } = items();
  const rows = quickRows(all, recentIds, "inv");
  expect(names(rows)).toEqual(["invoices", "Unpaid invoices", "invoice_lines", "inventory_moves", "open_invoices", "next_invoice_no"]);
  expect(rows[0].section).toBe("recently opened");
  expect(rows[2].section).toBe("other results");
  for (const r of rows) expect(hits(r.label)).toBe("inv");
});

test("a_dotted_query_marks_the_schema_too", () => {
  const { all, recentIds } = items();
  const rows = quickRows(all, recentIds, "billing.inv");
  expect(rows[0].item.name).toBe("invoices");
  expect(hits(rows[0].description)).toBe("billing");
  expect(hits(rows[0].label)).toBe("inv");
  // Without a schema the description is the kind word.
  const saved = quickRows(all, recentIds, "unpaid")[0];
  expect(saved.description).toEqual([{ text: "Saved Query", hit: false }]);
});

test("nothing_matches_gives_an_empty_list_and_results_are_capped", () => {
  const { all, recentIds } = items();
  expect(quickRows(all, recentIds, "zzz")).toEqual([]);
  const many: QuickItem[] = Array.from({ length: MAX_RESULTS + 50 }, (_, i) => ({ ...all[0], id: `x${i}`, name: `t${i}` }));
  expect(quickRows(many, [], "t")).toHaveLength(MAX_RESULTS);
});

test("modes_follow_the_first_letter", () => {
  expect(modeOf("")).toBe("open");
  expect(modeOf("orders")).toBe("open");
  expect(modeOf(">")).toBe("commands");
  expect(modeOf("> new q")).toBe("commands");
  expect(modeOf("?")).toBe("help");
});

const keymap = resolveKeymap({});
const cmd = (id: CommandId, note: string | null = null) => ({ command: COMMANDS.find((c) => c.id === id)!, keys: keymap.get(id)?.[0] ?? null, note });

test("the_palette_lists_category_and_title_with_the_first_key_recently_used_first", () => {
  const list = [cmd("query.new"), cmd("tab.close"), cmd("home.open"), cmd("tree.refresh"), cmd("group.open.1", "Shop")];
  const rows = paletteRows(list, ["tree.refresh", "flow.delete"], "");
  expect(rows.map((r) => r.text)).toEqual(["Tree: Refresh schema", "Groups: Open Group 1", "Query: New query", "Tabs: Close tab", "View: Home"]);
  expect(rows[0]).toMatchObject({ section: "recently used", keys: "F5" });
  expect(rows[1]).toMatchObject({ section: "other commands", note: "Shop", keys: "Ctrl+Alt+1" });
});

test("the_palette_matches_across_words_and_marks_the_letters", () => {
  const rows = paletteRows([cmd("query.new"), cmd("tab.close"), cmd("flow.new")], [], "new q");
  expect(rows[0].text).toBe("Query: New query");
  expect(hits(rows[0].label)).toBe("Newq");
  expect(paletteRows([cmd("query.new")], [], "zzz")).toEqual([]);
});

test("one_search_narrows_and_widens_with_the_text_as_a_fresh_one_would", () => {
  const { all, recentIds } = items();
  const search = createQuickSearch(all, recentIds);
  for (const text of ["i", "in", "inv", "invo", "inv", "", "o", "op", "ord"]) {
    expect(names(search.rows(text))).toEqual(names(quickRows(all, recentIds, text)));
  }
  expect(names(search.rows("invo"))).toEqual(["invoices", "Unpaid invoices", "invoice_lines", "open_invoices", "next_invoice_no", "inventory_moves"]);
});
