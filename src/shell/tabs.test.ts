import { expect, test } from "vitest";
import { EMPTY_LAYOUT } from "../schema/layout";
import type { ModelDoc } from "../schema/SchemaBuilder";
import { objectKey } from "../objectPath";
import { afterClose, designKey, newDesignKey, stripOrder, tabKey, type WindowTab, type WorkTab } from "./tabs";

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
