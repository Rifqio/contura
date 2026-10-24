// UX step 8: following a key opens its table as a preview tab with a request for the grid; Back and Forward walk
// the window's history, opening a closed tab again; Alt+Left acts only where the rulings let it.
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import type { GridControl, GridLocation } from "../components/DataGrid";
import { rowFiltersOf } from "../grid/foreignKeys";
import { SHOP_SCHEMA } from "../test/shopKeys";
import { objectKey } from "../objectPath";
import type { WorkTab } from "../shell/tabs";
import { backKeyApplies, useFkNav } from "./useFkNav";

const at = (name: string) => ({ database: "shop", schema: "public", name });
const sel = (name: string) => ({ connectionId: "c1", kind: "table" as const, path: at(name) });
const key = (name: string) => objectKey("c1", "table", at(name));
const tab = (name: string, preview = false): WorkTab => ({ kind: "object", key: key(name), selection: sel(name), preview });

function setup(initial: WorkTab[], active: string, say: (text: string) => void = () => {}) {
  const where = new Map<string, GridLocation>();
  const control = (k: string): GridControl | null =>
    where.has(k) ? { save: async () => true, discard: () => true, flush: () => false, pendingCount: () => 0, location: () => where.get(k)! } : null;
  const hook = renderHook(
    ({ place }) => {
      const [tabs, setTabs] = useState(initial);
      const [activeKey, setActiveKey] = useState<string | null>(active);
      const nav = useFkNav({ tabs, setTabs, activeKey, setActiveKey, dirty: () => new Set(), control, place, say });
      return { tabs, activeKey, setTabs, ...nav };
    },
    { initialProps: { place: "g1" } },
  );
  return { ...hook, where };
}

const fk = SHOP_SCHEMA.fks[0];
const follow = (from: { table: string; row: number }, to: string, value: string, dir: "out" | "in" = "out") => ({
  way: { dir, fk, path: at(to), filters: [{ column: dir === "out" ? "id" : "customer_id", value }], blocked: null },
  filters: rowFiltersOf([{ column: dir === "out" ? "id" : "customer_id", value }]),
  where: `"${dir === "out" ? "id" : "customer_id"}" = ${value}`,
  from: { ...from, key: dir === "in" ? [{ column: "id", value }] : [] },
});
const names = (tabs: WorkTab[]) => tabs.map((t) => (t.kind === "object" ? `${t.selection.path.name}${t.preview ? "*" : ""}` : t.kind));

afterEach(() => {
  document.body.innerHTML = "";
});

test("following_a_key_opens_a_preview_keeps_the_source_and_asks_the_grid_to_filter_and_select", () => {
  const h = setup([tab("orders"), tab("order_items", true)], key("orders"));
  h.where.set(key("orders"), { filters: [], where: null, page: 0, sort: null, cell: { row: 2, column: "customer_id", key: null } });
  act(() => h.result.current.follow(key("orders"), follow({ table: "orders", row: 3 }, "customers", "214")));
  // The preview tab's place is taken by the target, as a single click would.
  expect(names(h.result.current.tabs)).toEqual(["orders", "customers*"]);
  expect(h.result.current.activeKey).toBe(key("customers"));
  expect(h.result.current.jumpFor(key("customers"))).toMatchObject({
    filters: [{ column: "id", op: "eq", value: "214" }],
    where: '"id" = 214',
    page: 0,
    select: { row: 0, column: "id", wholeRow: true },
    say: { kind: "out", fromTable: "orders", fromRow: 3 },
  });
  expect(h.result.current.nav).toEqual({ back: "orders", forward: null });
});

test("a_preview_you_follow_a_key_from_is_kept_and_an_open_tab_of_the_target_is_reused", () => {
  const h = setup([tab("customers"), tab("orders", true)], key("orders"));
  h.where.set(key("orders"), { filters: [], where: null, page: 0, sort: null, cell: { row: 0, column: "customer_id", key: null } });
  act(() => h.result.current.follow(key("orders"), follow({ table: "orders", row: 1 }, "customers", "214")));
  expect(names(h.result.current.tabs)).toEqual(["customers", "orders"]);
  const first = h.result.current.jumpFor(key("customers"))!.seq;
  // Rows that point here select the first key cell, not the whole row.
  act(() => h.result.current.follow(key("customers"), follow({ table: "customers", row: 1 }, "orders", "214", "in")));
  const j = h.result.current.jumpFor(key("orders"))!;
  expect(j.select).toEqual({ row: 0, column: "customer_id", wholeRow: false });
  expect(j.say).toEqual({ kind: "in", toTable: "customers", toKey: [{ column: "id", value: "214" }] });
  expect(j.seq).toBeGreaterThan(first);
});

test("back_and_forward_restore_the_tab_filter_and_cell_and_back_reopens_a_closed_tab", () => {
  const h = setup([tab("orders")], key("orders"));
  const filters = rowFiltersOf([{ column: "status", value: "paid" }]);
  const sort = { column: "total", descending: true };
  h.where.set(key("orders"), { filters, where: "\"status\" = 'paid'", page: 1, sort, cell: { row: 2, column: "customer_id", key: '[{"t":"number","value":"1003"}]' } });
  act(() => h.result.current.follow(key("orders"), follow({ table: "orders", row: 1003 }, "customers", "214")));
  h.where.set(key("customers"), { filters: rowFiltersOf([{ column: "id", value: "214" }]), where: '"id" = 214', page: 0, sort: null, cell: { row: 0, column: "name", key: null } });
  act(() => h.result.current.back());
  expect(h.result.current.activeKey).toBe(key("orders"));
  expect(h.result.current.jumpFor(key("orders"))).toMatchObject({ filters, page: 1, sort, select: { row: 2, column: "customer_id", key: '[{"t":"number","value":"1003"}]', wholeRow: false }, say: { kind: "back" } });
  expect(h.result.current.nav).toEqual({ back: null, forward: "customers" });
  act(() => h.result.current.forward());
  expect(h.result.current.activeKey).toBe(key("customers"));
  expect(h.result.current.jumpFor(key("customers"))).toMatchObject({ select: { row: 0, column: "name" }, say: { kind: "forward" } });
  // Close orders, then Back: it opens again as a kept tab, without taking another tab's place.
  act(() => h.result.current.setTabs((all) => all.filter((t) => t.kind !== "object" || t.selection.path.name !== "orders")));
  act(() => h.result.current.back());
  expect(names(h.result.current.tabs)).toEqual(["customers*", "orders"]);
  expect(h.result.current.activeKey).toBe(key("orders"));
  expect(h.result.current.jumpFor(key("orders"))).toMatchObject({ filters, where: "\"status\" = 'paid'", page: 1 });
});

test("nothing_to_go_back_to_is_said_in_the_grid", () => {
  const h = setup([tab("orders")], key("orders"));
  h.where.set(key("orders"), { filters: [], where: null, page: 0, sort: null, cell: null });
  act(() => h.result.current.back());
  expect(h.result.current.jumpFor(key("orders"))!.say).toEqual({ kind: "none", text: "Nothing to go back to." });
  act(() => h.result.current.forward());
  expect(h.result.current.jumpFor(key("orders"))!.say).toEqual({ kind: "none", text: "Nothing to go forward to." });
});

test("the_history_is_dropped_with_the_place", () => {
  const h = setup([tab("orders")], key("orders"));
  h.where.set(key("orders"), { filters: [], where: null, page: 0, sort: null, cell: null });
  act(() => h.result.current.follow(key("orders"), follow({ table: "orders", row: 1 }, "customers", "214")));
  expect(h.result.current.nav.back).toBe("orders");
  h.rerender({ place: "g2" });
  expect(h.result.current.nav.back).toBeNull();
});

test("alt_left_acts_in_a_grid_the_tree_or_a_tabs_content_and_ctrl_alt_left_everywhere", () => {
  document.body.innerHTML = `
    <div role="tablist"><button id="strip">orders</button></div>
    <div role="tree"><div id="tree" tabindex="0"></div></div>
    <div class="work-pane"><div id="grid" class="grid-scroll" tabindex="0"></div><input id="field"><div id="cm" contenteditable="true"></div></div>
    <div class="work-pane"><div class="import-tab"><button id="wizard">Next</button></div></div>
    <aside><button id="ask">Ask</button></aside>`;
  const el = (id: string) => document.getElementById(id);
  expect(backKeyApplies("Alt+ArrowLeft", el("grid"))).toBe(true);
  expect(backKeyApplies("Alt+ArrowLeft", el("tree"))).toBe(true);
  // A strip tab keeps its move; a field and an editor keep their own Alt+Left; elsewhere it is not Back.
  expect(backKeyApplies("Alt+ArrowLeft", document.body)).toBe(false);
  // A wizard keeps Alt+Left as its Back, and Alt+Right does not leave it either.
  expect(backKeyApplies("Alt+ArrowRight", el("wizard"))).toBe(false);
  expect(backKeyApplies("Alt+ArrowLeft", el("wizard"))).toBe(false);
  expect(backKeyApplies("Alt+ArrowLeft", el("strip"))).toBe(false);
  expect(backKeyApplies("Alt+ArrowLeft", el("field"))).toBe(false);
  expect(backKeyApplies("Alt+ArrowLeft", el("cm"))).toBe(false);
  expect(backKeyApplies("Alt+ArrowLeft", el("ask"))).toBe(false);
  // DataGrip's Ctrl+Alt+Left, and the palette (no keys), work everywhere.
  for (const id of ["strip", "field", "cm", "ask", "wizard"]) expect(backKeyApplies("Ctrl+Alt+ArrowLeft", el(id))).toBe(true);
  expect(backKeyApplies(null, el("field"))).toBe(true);
});

test("a_self_reference_filters_the_tab_you_are_in", () => {
  const h = setup([tab("orders")], key("orders"));
  h.where.set(key("orders"), { filters: [], where: null, page: 0, sort: null, cell: { row: 1, column: "customer_id", key: null } });
  act(() => h.result.current.follow(key("orders"), follow({ table: "orders", row: 2 }, "orders", "1001")));
  expect(names(h.result.current.tabs)).toEqual(["orders"]);
  expect(h.result.current.jumpFor(key("orders"))).toMatchObject({ where: '"id" = 1001', say: { kind: "out" } });
  expect(h.result.current.nav.back).toBe("orders");
});

test("nothing_to_go_back_to_from_a_tab_that_is_not_a_table_is_said_too", () => {
  const said: string[] = [];
  const h = setup([{ kind: "savedQueries" }], "savedQueries", (t) => said.push(t));
  act(() => h.result.current.back());
  act(() => h.result.current.forward());
  expect(said).toEqual(["Nothing to go back to.", "Nothing to go forward to."]);
});
