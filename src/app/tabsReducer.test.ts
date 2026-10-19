import { describe, expect, it } from "vitest";
import type { QueryTabDoc } from "../query/QueryTab";
import type { ModelDoc } from "../schema/SchemaBuilder";
import { type Selection, type VisualTabDoc, type WorkTab, tabKey } from "../shell/tabs";
import { emptyQuery } from "../visualquery/model";
import { type SchemaTab, type TabsAction, type TabsState, tabsReducer } from "./tabsReducer";

const doc = (id: string, savedId: string | null = null): QueryTabDoc => ({
  id,
  name: `Query ${id}`,
  text: "SELECT 1",
  connectionId: null,
  database: null,
  savedId,
  savedText: savedId ? "SELECT 1" : null,
});
const query = (id: string, savedId: string | null = null): WorkTab => ({ kind: "query", doc: doc(id, savedId) });
const object = (key: string): WorkTab => ({
  kind: "object",
  key,
  selection: { connectionId: "c1", kind: "table", path: { database: "d", schema: null, name: key } } as Selection,
});
const model = (path: string | null): ModelDoc =>
  ({ path, dbml: "", savedDbml: "", layout: {}, dialect: "postgres", source: "blank", connectionId: null }) as unknown as ModelDoc;
const schema = (id: string, path: string | null): SchemaTab => ({ kind: "schema", id, doc: model(path) });
const state = (over: Partial<TabsState> = {}): TabsState => ({ tabs: [], windowTabs: [], activeKey: null, ...over });

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

describe("tabsReducer", () => {
  it("remove_keeps_the_active_tab_when_it_stays", () => {
    const s = state({ tabs: [object("a"), object("b"), query("q")], activeKey: "query:q" });
    const next = tabsReducer(s, { type: "remove", drop: (t) => t.kind === "object", order: ["a", "b", "query:q"] });
    expect(next.tabs).toEqual([query("q")]);
    expect(next.activeKey).toBe("query:q");
  });

  it("remove_moves_to_the_nearest_kept_neighbour_in_strip_order", () => {
    const s = state({ tabs: [query("x"), object("a"), object("b"), query("y")], activeKey: "a" });
    const next = tabsReducer(s, {
      type: "remove",
      drop: (t) => t.kind === "object",
      order: ["home", "query:x", "a", "b", "query:y"],
    });
    expect(next.tabs).toEqual([query("x"), query("y")]);
    expect(next.activeKey).toBe("query:y");
    const last = tabsReducer(state({ tabs: [query("x"), object("a")], activeKey: "a" }), {
      type: "remove",
      drop: (t) => t.kind === "object",
      order: ["query:x", "a"],
    });
    expect(last.activeKey).toBe("query:x");
  });

  it("remove_with_nothing_to_drop_returns_the_same_state", () => {
    const s = state({ tabs: [query("q")], activeKey: "query:q" });
    expect(tabsReducer(s, { type: "remove", drop: (t) => t.kind === "object", order: ["query:q"] })).toBe(s);
  });

  it("open_saved_reuses_a_tab_of_the_same_saved_query", () => {
    const s = state({ tabs: [query("old", "s1"), query("other")], activeKey: "query:other" });
    const next = tabsReducer(s, { type: "openSaved", doc: doc("new", "s1") });
    expect(next.tabs).toBe(s.tabs);
    expect(next.activeKey).toBe("query:old");
  });

  it("open_saved_adds_and_activates_a_new_tab", () => {
    const s = state({ tabs: [query("q", "s2")], activeKey: null });
    const next = tabsReducer(s, { type: "openSaved", doc: doc("new", "s1") });
    expect(next.tabs).toEqual([query("q", "s2"), query("new", "s1")]);
    expect(next.activeKey).toBe("query:new");
  });

  it("open_saved_without_a_saved_id_never_reuses_a_plain_query_tab", () => {
    const s = state({ tabs: [query("plain")], activeKey: null });
    const next = tabsReducer(s, { type: "openSaved", doc: doc("new", null) });
    expect(next.tabs).toEqual([query("plain"), query("new", null)]);
    expect(next.activeKey).toBe("query:new");
  });

  it("open_visual_shows_the_tab_of_the_same_saved_visual_query_else_adds_it", () => {
    const vdoc = (id: string, savedId: string | null): VisualTabDoc => ({
      id,
      name: `V ${id}`,
      connectionId: "c1",
      database: "shop",
      model: emptyQuery("shop", "mysql"),
      savedId,
      savedJson: savedId ? "{}" : null,
    });
    // A query tab with the same savedId is not the Visual Query's tab.
    const s = state({ tabs: [query("q", "s1"), { kind: "visual", doc: vdoc("old", "s1") }], activeKey: "query:q" });
    const again = tabsReducer(s, { type: "openVisual", doc: vdoc("new", "s1") });
    expect(again.tabs).toBe(s.tabs);
    expect(again.activeKey).toBe("visual:old");
    const other = tabsReducer(s, { type: "openVisual", doc: vdoc("new", "s2") });
    expect(other.tabs).toHaveLength(3);
    expect(other.activeKey).toBe("visual:new");
  });

  it("open_schema_reuses_the_tab_of_an_open_file", () => {
    const s = state({ windowTabs: [{ kind: "home" }, schema("m1", "a.dbml")], activeKey: "home" });
    const next = tabsReducer(s, { type: "openSchema", tab: schema("m2", "a.dbml") });
    expect(next.windowTabs).toBe(s.windowTabs);
    expect(next.activeKey).toBe("schema:m1");
  });

  it("open_schema_without_a_path_always_adds", () => {
    const s = state({ windowTabs: [schema("m1", null)], activeKey: "schema:m1" });
    const next = tabsReducer(s, { type: "openSchema", tab: schema("m2", null) });
    expect(next.windowTabs).toEqual([schema("m1", null), schema("m2", null)]);
    expect(next.activeKey).toBe("schema:m2");
  });

  it("open_flow_adds_a_diagram_tab_once_per_name", () => {
    const s = state({ windowTabs: [{ kind: "home" }], activeKey: "home" });
    const a = tabsReducer(s, { type: "openFlow", name: "checkout" });
    expect(a.windowTabs).toEqual([{ kind: "home" }, { kind: "flow", name: "checkout" }]);
    expect(a.activeKey).toBe("flow:checkout");
    // Opened again, the same tab is shown.
    const b = tabsReducer({ ...a, activeKey: "home" }, { type: "openFlow", name: "checkout" });
    expect(b.windowTabs).toBe(a.windowTabs);
    expect(b.activeKey).toBe("flow:checkout");
    // Windows names are not case-sensitive: Checkout is the same file, so the same tab.
    const c = tabsReducer({ ...a, activeKey: "home" }, { type: "openFlow", name: "Checkout" });
    expect(c.windowTabs).toBe(a.windowTabs);
    expect(c.activeKey).toBe("flow:checkout");
  });

  it("rename_flow_swaps_the_diagram_tab_in_place_and_keeps_it_active", () => {
    const s = state({ windowTabs: [{ kind: "home" }, { kind: "flow", name: "checkout" }, { kind: "flow", name: "refunds" }], activeKey: "flow:checkout" });
    const a = tabsReducer(s, { type: "renameFlow", from: "checkout", to: "payments" });
    expect(a.windowTabs).toEqual([{ kind: "home" }, { kind: "flow", name: "payments" }, { kind: "flow", name: "refunds" }]);
    expect(a.activeKey).toBe("flow:payments");
    // Another tab active: it stays active.
    const b = tabsReducer({ ...s, activeKey: "home" }, { type: "renameFlow", from: "checkout", to: "payments" });
    expect(b.activeKey).toBe("home");
  });

  it("set_actions_take_values_or_updaters_and_keep_the_state_when_unchanged", () => {
    const s = state();
    const tabs = [query("q")];
    const a = tabsReducer(s, { type: "tabs", next: tabs });
    expect(a.tabs).toBe(tabs);
    const b = tabsReducer(a, { type: "tabs", next: (t) => [...t, query("r")] });
    expect(b.tabs.map(tabKey)).toEqual(["query:q", "query:r"]);
    const c = tabsReducer(b, { type: "windowTabs", next: (w) => [...w, { kind: "home" }] });
    expect(c.windowTabs).toEqual([{ kind: "home" }]);
    const d = tabsReducer(c, { type: "active", next: "home" });
    expect(d.activeKey).toBe("home");
    const e = tabsReducer(d, { type: "active", next: (k) => (k === "home" ? "query:q" : k) });
    expect(e.activeKey).toBe("query:q");
    expect(tabsReducer(e, { type: "tabs", next: (t) => t })).toBe(e);
    expect(tabsReducer(e, { type: "windowTabs", next: e.windowTabs })).toBe(e);
    expect(tabsReducer(e, { type: "active", next: (k) => k })).toBe(e);
  });

  it("the_reducer_is_pure", () => {
    const s = deepFreeze(
      state({ tabs: [query("a", "s1"), object("t")], windowTabs: [{ kind: "home" }, schema("m1", "a.dbml")], activeKey: "t" }),
    );
    const copy = structuredClone({ tabs: s.tabs, windowTabs: s.windowTabs, activeKey: s.activeKey });
    const actions: TabsAction[] = [
      { type: "remove", drop: (t: WorkTab) => t.kind === "object", order: ["home", "query:a", "t", "schema:m1"] },
      { type: "openSaved", doc: doc("n", "s1") },
      { type: "openSaved", doc: doc("n", "s9") },
      { type: "openSchema", tab: schema("m2", "a.dbml") },
      { type: "openSchema", tab: schema("m3", null) },
      { type: "tabs", next: (t: WorkTab[]) => [...t, query("z")] },
      { type: "active", next: "home" },
    ];
    for (const action of actions) {
      const once = tabsReducer(s, action);
      const twice = tabsReducer(s, action);
      expect(twice).toEqual(once);
    }
    expect({ tabs: s.tabs, windowTabs: s.windowTabs, activeKey: s.activeKey }).toEqual(copy);
  });

  it("restore_then_open_saved_in_one_batch_reuses_the_restored_draft", () => {
    // The drafts restore prepends its tabs, then a Recent open of the same Saved Query runs before that commits.
    const restored = [query("draft", "s1")];
    const queue: TabsAction[] = [
      { type: "tabs", next: (t: WorkTab[]) => [...restored, ...t] },
      { type: "active", next: (k: string | null) => k ?? tabKey(restored[0]) },
      { type: "openSaved", doc: doc("fresh", "s1") },
    ];
    const next = queue.reduce(tabsReducer, state());
    expect(next.tabs).toEqual(restored);
    expect(next.activeKey).toBe("query:draft");
  });
});

it("openTransfer adds a tab each time and transferMeta sets its title and mark", () => {
  const seed = { connectionId: "c1", database: "pos_live", schema: null, table: null };
  let s = tabsReducer({ tabs: [], windowTabs: [], activeKey: null }, { type: "openTransfer", id: "t1", seed });
  s = tabsReducer(s, { type: "openTransfer", id: "t2", seed });
  expect(s.windowTabs.map((t) => t.kind === "transfer" && t.id)).toEqual(["t1", "t2"]);
  expect(s.activeKey).toBe("transfer:t2");
  const next = tabsReducer(s, { type: "transferMeta", id: "t1", title: "pos_live to analytics", dirty: true });
  expect(next.windowTabs[0]).toMatchObject({ kind: "transfer", title: "pos_live to analytics", dirty: true });
  // The same title and mark change nothing.
  expect(tabsReducer(next, { type: "transferMeta", id: "t1", title: "pos_live to analytics", dirty: true })).toBe(next);
});

it("openCompare adds a tab each time and compareMeta sets its title and target", () => {
  const seed = { source: { kind: "database" as const, connectionId: "stg", database: "freight", schema: "billing" }, target: null };
  let s = tabsReducer({ tabs: [], windowTabs: [], activeKey: null }, { type: "openCompare", id: "c1", seed });
  s = tabsReducer(s, { type: "openCompare", id: "c2", seed });
  expect(s.windowTabs.map((t) => t.kind === "compare" && t.title)).toEqual(["Schema Compare", "Schema Compare"]);
  expect(s.activeKey).toBe("compare:c2");
  const next = tabsReducer(s, { type: "compareMeta", id: "c1", title: "freight-staging to freight-prod", connectionId: "prod" });
  expect(next.windowTabs[0]).toMatchObject({ kind: "compare", title: "freight-staging to freight-prod", connectionId: "prod" });
  expect(tabsReducer(next, { type: "compareMeta", id: "c1", title: "freight-staging to freight-prod", connectionId: "prod" })).toBe(next);
});
