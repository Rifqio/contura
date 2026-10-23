import { expect, test } from "vitest";
import { EMPTY_LAYOUT } from "../schema/layout";
import type { ModelDoc } from "../schema/SchemaBuilder";
import { objectKey } from "../objectPath";
import {
  afterClose,
  designKey,
  importKey,
  lineageKey,
  moveTab,
  newDesignKey,
  objectTabOf,
  openSettingsTab,
  placeObject,
  stripOrder,
  stripSegment,
  tabConnectionId,
  tabKey,
  withRestored,
  type WindowTab,
  type AnyTab,
  type WorkTab,
} from "./tabs";

const query = (id: string): WorkTab => ({
  kind: "query",
  doc: { id, name: id, text: "", connectionId: null, database: null, savedId: null, savedText: null },
});
const table: WorkTab = {
  kind: "object",
  key: "c1:table:shop..orders",
  selection: { connectionId: "c1", kind: "table", path: { database: "shop", schema: null, name: "orders" } },
};
const model: ModelDoc = {
  path: null,
  dbml: "",
  savedDbml: "",
  layout: EMPTY_LAYOUT,
  dialect: "postgres",
  source: "blank",
  connectionId: null,
};
const home: WindowTab = { kind: "home" };
const settings: WindowTab = { kind: "settings", section: "ai" };
const schema: WindowTab = { kind: "schema", id: "m1", doc: model };

test("home_comes_first_and_other_window_tabs_after_the_place_tabs", () => {
  // Window tabs in open order: Settings, then Home, then a model.
  const order = stripOrder([settings, home, schema], [query("q1"), table]).map(tabKey);
  expect(order).toEqual(["home", "query:q1", "c1:table:shop..orders", "settings", "schema:m1"]);
  // Without Home the place's tabs lead.
  expect(stripOrder([schema], [query("q1")]).map(tabKey)).toEqual(["query:q1", "schema:m1"]);
  expect(stripOrder([], [])).toEqual([]);
});

test("closing_the_active_tab_picks_the_right_neighbour_then_the_left", () => {
  const order = ["home", "query:a", "query:b", "settings"];
  expect(afterClose(order, "query:a", "query:a")).toBe("query:b");
  expect(afterClose(order, "settings", "settings")).toBe("query:b");
  expect(afterClose(["home"], "home", "home")).toBeNull();
  // Closing another tab keeps the active one.
  expect(afterClose(order, "query:b", "home")).toBe("query:b");
  expect(afterClose(order, null, "home")).toBeNull();
});

test("keys_are_stable_per_kind", () => {
  expect(tabKey(home)).toBe("home");
  expect(tabKey({ kind: "settings", section: "keymap" })).toBe("settings");
  expect(tabKey(schema)).toBe("schema:m1");
  expect(tabKey(query("d1"))).toBe("query:d1");
  expect(tabKey(table)).toBe("c1:table:shop..orders");
  // A renamed query keeps its key.
  const renamed = query("d1");
  if (renamed.kind === "query") renamed.doc.name = "Weekly sales";
  expect(tabKey(renamed)).toBe("query:d1");
});

test("a_design_tab_is_keyed_apart_from_its_table", () => {
  const path = { database: "shop", schema: null, name: "orders" };
  const key = designKey("c1", path);
  const design: WorkTab = { kind: "design", key, connectionId: "c1", target: { kind: "alter", path } };
  expect(tabKey(design)).toBe(key);
  expect(key).not.toBe(objectKey("c1", "table", path));
  expect(key).toBe(`design\u0000${objectKey("c1", "table", path)}`);
  expect(newDesignKey("n1")).toBe("design\u0000new\u0000n1");
});

test("a_lineage_tab_is_keyed_apart_from_its_table_and_design", () => {
  const path = { database: "shop", schema: "public", name: "orders" };
  const key = lineageKey("c1", path);
  expect(key).toBe(`lineage\u0000${objectKey("c1", "table", path)}`);
  expect(key).not.toBe(designKey("c1", path));
  const tab: WorkTab = { kind: "lineage", key, connectionId: "c1", path };
  expect(tabKey(tab)).toBe(key);
  expect(tabConnectionId(tab)).toBe("c1");
  // Read only: never asked about by the Pending Edits guard.
  expect(objectTabOf(tab)).toBeNull();
});

test("an_import_tab_is_keyed_by_its_connection_and_target", () => {
  const path = { database: "shop", schema: "public", name: "menu_items" };
  const key = importKey("c1", { kind: "table", path });
  expect(key).toBe(`import\u0000${objectKey("c1", "table", path)}`);
  expect(importKey("c1", { kind: "database", database: "shop" })).toBe("import\u0000c1\u0000database\u0000shop");
  const tab: WorkTab = { kind: "import", key, connectionId: "c1", target: { kind: "table", path } };
  expect(tabKey(tab)).toBe(key);
  expect(tabConnectionId(tab)).toBe("c1");
  // Not a Pending Edits tab: it is never asked about by the grid guard.
  expect(objectTabOf(tab)).toBeNull();
});

test("a_visual_tab_is_keyed_by_its_doc_and_names_its_connection", () => {
  const visual: WorkTab = {
    kind: "visual",
    doc: {
      id: "v1",
      name: "New Visual Query",
      connectionId: "c1",
      database: "shop",
      model: { version: 1, database: "shop", dialect: "mysql", tables: [], joins: [], columns: [], filters: [], groupBy: { kind: "auto" }, orderBy: [], limit: null, distinct: false },
      savedId: null,
      savedJson: null,
    },
  };
  expect(tabKey(visual)).toBe("visual:v1");
  expect(tabConnectionId(visual)).toBe("c1");
  expect(tabConnectionId(query("q1"))).toBeNull();
  expect(tabConnectionId(table)).toBe("c1");
  expect(tabConnectionId(home)).toBeNull();
});

const tableSel = (name: string) => ({ connectionId: "c1", kind: "table" as const, path: { database: "shop", schema: null, name } });
const keyOf = (name: string) => objectKey("c1", "table", tableSel(name).path);

test("item_1_a_single_click_reuses_the_preview_tab_and_a_double_click_keeps_its_own", () => {
  let tabs: WorkTab[] = [query("q1")];
  tabs = placeObject(tabs, tableSel("orders"), keyOf("orders"), false, new Set());
  tabs = placeObject(tabs, tableSel("stores"), keyOf("stores"), false, new Set());
  // One preview tab, in the same place: stores took orders' place.
  expect(tabs.map(tabKey)).toEqual(["query:q1", keyOf("stores")]);
  // A double click on the previewed table keeps it; the next click opens a new preview beside it.
  tabs = placeObject(tabs, tableSel("stores"), keyOf("stores"), true, new Set());
  tabs = placeObject(tabs, tableSel("menu"), keyOf("menu"), false, new Set());
  expect(tabs.map(tabKey)).toEqual(["query:q1", keyOf("stores"), keyOf("menu")]);
  // A preview with Pending Edits is never replaced.
  tabs = placeObject(tabs, tableSel("items"), keyOf("items"), false, new Set([keyOf("menu")]));
  expect(tabs.map(tabKey)).toEqual(["query:q1", keyOf("stores"), keyOf("menu"), keyOf("items")]);
  // A double click opens a tab of its own even when a preview exists.
  tabs = placeObject(tabs, tableSel("x"), keyOf("x"), true, new Set());
  expect(tabs.map(tabKey)).toHaveLength(5);
});

test("item_7_move_tab_lands_after_when_dragged_right_and_before_when_dragged_left", () => {
  const list = [query("a"), query("b"), query("c"), query("d")];
  expect(moveTab(list, "query:a", "query:c").map(tabKey)).toEqual(["query:b", "query:c", "query:a", "query:d"]);
  expect(moveTab(list, "query:d", "query:b").map(tabKey)).toEqual(["query:a", "query:d", "query:b", "query:c"]);
  expect(moveTab(list, "query:a", "nope")).toBe(list);
  expect(stripSegment({ kind: "home" })).toBe("home");
  expect(stripSegment({ kind: "flow", name: "x" })).toBe("window");
  expect(stripSegment(query("a"))).toBe("place");
});

test("a_compare_tab_drags_with_the_window_tabs", () => {
  const compare = { kind: "compare", id: "c1", seed: { source: null, target: null }, title: "a to b", connectionId: null } as unknown as AnyTab;
  expect(stripSegment(compare)).toBe("window");
  expect(stripSegment({ kind: "transfer", id: "t", seed: {}, title: "", dirty: false } as unknown as AnyTab)).toBe("window");
  expect(stripSegment({ kind: "settings", section: "general" } as unknown as AnyTab)).toBe("window");
});

test("settings_opens_once_keeps_its_page_on_a_plain_open_and_moves_only_when_asked", () => {
  const home: WindowTab = { kind: "home" };
  // Closed: a plain open starts on Appearance.
  const opened = openSettingsTab([home]);
  expect(opened).toEqual([home, { kind: "settings", section: "appearance", seq: 0, row: undefined }]);
  // The user moved to AI assistant, Privacy: a plain open (Ctrl+, the gear, Home's Settings) leaves it there.
  const onPrivacy: WindowTab[] = [home, { kind: "settings", section: "ai", aiPage: "privacy", seq: 0 }];
  expect(openSettingsTab(onPrivacy)).toBe(onPrivacy);
  // A link to a section (and a row) moves it, and drops the AI page the user was on.
  expect(openSettingsTab(onPrivacy, "ai", "tools")).toEqual([home, { kind: "settings", section: "ai", seq: 1, row: "tools" }]);
  expect(openSettingsTab(onPrivacy, "updates")).toEqual([home, { kind: "settings", section: "updates", seq: 1, row: undefined }]);
  // Never a second tab.
  expect(openSettingsTab(openSettingsTab(opened, "keymap"), "editor").filter((t) => t.kind === "settings")).toHaveLength(1);
});

test("restored_tabs_never_duplicate_a_key", () => {
  // Two tabs with one key drew two panes, both shown, the second below the work area.
  const open = [query("a"), table];
  expect(withRestored(open, [query("b"), query("a"), query("b")]).map(tabKey)).toEqual([tabKey(query("b")), tabKey(query("a")), tabKey(table)]);
  expect(withRestored(open, [query("a")])).toBe(open);
});
