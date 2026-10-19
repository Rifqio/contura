import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { nextQueryName, parseDrafts, placeKey, serializeDrafts } from "../query/drafts";
import type { QueryTabDoc } from "../query/QueryTab";
import { EMPTY_LAYOUT } from "../schema/layout";
import { type AnyTab, moveTab, tabKey, type VisualTabDoc } from "../shell/tabs";
import { useState } from "react";
import { parseVisualDrafts } from "../visualquery/drafts";
import { registerFlow, updateFlow } from "../flow/flowRegistry";
import Icon, { type IconName } from "./Icon";
import TabStrip, { type WorkTab } from "./TabStrip";

const q = (id: string, name: string, over: Partial<QueryTabDoc> = {}): WorkTab => ({
  kind: "query",
  doc: { id, name, text: "", connectionId: "c1", database: null, savedId: null, savedText: null, ...over },
});
const table: WorkTab = {
  kind: "object",
  key: "c1:table:shop..stores",
  selection: { connectionId: "c1", kind: "table", path: { database: "shop", schema: null, name: "stores" } },
};
const prod = {
  id: "c1",
  name: "kfc-prod",
  dialect: "mysql",
  host: "h",
  port: 3306,
  user: "u",
  database: null,
  ssl: { mode: "disable" },
  file: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: true,
  readOnly: false,
  groupId: null,
} as const;

/** The path an icon draws, to tell which icon a tab shows. */
function iconPath(name: IconName): string {
  const { container, unmount } = render(<Icon name={name} />);
  const d = container.querySelector("path")?.getAttribute("d") ?? "";
  unmount();
  return d;
}
/** Which of the given icons an element draws; the database mark is not an `.icon`. */
const iconsIn = (el: Element, names: IconName[]) => {
  const drawn = [...el.querySelectorAll("svg.icon path")].map((p) => p.getAttribute("d"));
  return names.filter((n) => drawn.includes(iconPath(n)));
};
const KINDS: IconName[] = ["fileQuery", "table", "view", "trigger", "routine", "grid", "gear", "layers"];

test("tabs_hold_tables_and_queries_and_close_with_their_x", async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onNew = vi.fn();
  render(
    <TabStrip
      tabs={[table, q("a", "Query 1"), q("b", "Weekly sales", { savedId: "s", savedText: "SELECT 1", text: "SELECT 2" })]}
      active="query:a"
      onSelect={onSelect}
      onClose={onClose}
      onNew={onNew}
    />,
  );
  expect(screen.getByRole("tab", { name: "stores" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  expect(screen.getByRole("tab", { name: /Weekly sales, unsaved changes/ })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "stores" }));
  expect(onSelect).toHaveBeenCalledWith("c1:table:shop..stores");
  await userEvent.click(screen.getByRole("button", { name: "Close Query 1" }));
  expect(onClose).toHaveBeenCalledWith("query:a");
  await userEvent.click(screen.getByRole("button", { name: "New query" }));
  expect(onNew).toHaveBeenCalled();
});

test("query_tab_strip_shows_tag", () => {
  render(
    <TabStrip
      tabs={[table, q("a", "Query 1")]}
      active="query:a"
      connections={[prod]}
      onSelect={() => {}}
      onClose={() => {}}
      onNew={() => {}}
    />,
  );
  // R8: the chip says PROD, the spoken name keeps the word.
  expect(screen.getAllByText("PROD")).toHaveLength(2);
  // "Production" is there only for screen readers.
  expect(screen.getAllByText("Production").every((e) => e.classList.contains("visually-hidden"))).toBe(true);
  expect(screen.getByRole("tab", { name: "Query 1, Production" })).toBeTruthy();
  const objectTab = screen.getByRole("tab", { name: /^stores/ });
  expect(objectTab.getAttribute("aria-label")?.endsWith(", Production")).toBe(true);
  expect(objectTab.textContent).toContain("PROD");
});

test("unsaved_tab_shows_a_star_labelled_unsaved_changes", () => {
  render(
    <TabStrip
      tabs={[q("a", "Query 1"), q("b", "Weekly sales", { savedId: "s", savedText: "SELECT 1", text: "SELECT 2" })]}
      active="query:a"
      onSelect={() => {}}
      onClose={() => {}}
      onNew={() => {}}
    />,
  );
  const tab = screen.getByRole("tab", { name: /^Weekly sales/ });
  const star = within(tab).getByLabelText("Unsaved changes");
  expect(star.textContent).toBe("*");
  expect(within(screen.getByRole("tab", { name: "Query 1" })).queryByLabelText("Unsaved changes")).toBeNull();
  expect(document.querySelector(".work-tab-dot")).toBeNull();
});

test("active_tab_takes_the_group_hue_of_its_connection", () => {
  const kfc = {
    id: "c1",
    name: "kfc-db",
    dialect: "postgres",
    host: "h",
    port: 5432,
    user: "u",
    database: null,
    ssl: { mode: "disable" },
    file: null,
    queryTimeoutSecs: null,
    aiAccess: "schema",
    production: false,
    readOnly: false,
    groupId: "g1",
  } as const;
  render(
    <TabStrip
      tabs={[table, q("a", "Query 1")]}
      active="query:a"
      connections={[kfc]}
      groups={[{ id: "g1", name: "KFC", color: "teal", hasImage: false }]}
      onSelect={() => {}}
      onClose={() => {}}
      onNew={() => {}}
    />,
  );
  const active = screen.getByRole("tab", { name: "Query 1", selected: true }).closest(".work-tab") as HTMLElement;
  expect(active.style.getPropertyValue("--group")).toBe("var(--c-group-teal)");
  expect(active.style.getPropertyValue("--group-tint")).toBe("var(--c-group-teal-tint)");
});

test("empty_parts_of_the_tab_strip_drag_the_window", () => {
  render(<TabStrip tabs={[q("a", "Query 1")]} active="query:a" onSelect={() => {}} onClose={() => {}} onNew={() => {}} />);
  const list = screen.getByRole("tablist", { name: "Open tabs" });
  expect(list.hasAttribute("data-tauri-drag-region")).toBe(true);
  expect((list.closest(".tab-strip") as HTMLElement).hasAttribute("data-tauri-drag-region")).toBe(true);
  // The tabs themselves stay clickable, not drag handles.
  expect(screen.getByRole("tab", { name: "Query 1" }).hasAttribute("data-tauri-drag-region")).toBe(false);
});

test("query_tab_shows_mark_prod_and_title_without_a_kind_icon", () => {
  render(<TabStrip tabs={[q("a", "Query 1")]} active="query:a" connections={[prod]} onSelect={() => {}} onClose={() => {}} onNew={() => {}} />);
  const tab = screen.getByRole("tab", { name: "Query 1, Production" });
  // C5: the database mark at 14 px, the PROD chip, then the title; no document icon.
  const mark = tab.querySelector(".db-mark") as SVGElement;
  expect(mark.getAttribute("width")).toBe("14");
  expect(iconsIn(tab, KINDS)).toEqual([]);
  const parts = [...tab.children].map((el) => el.getAttribute("class") ?? "");
  expect(parts[0]).toContain("db-mark");
  expect(parts[1]).toContain("safety-tag-production");
  expect(parts[parts.length - 1]).toBe("work-tab-name");
});

test("table_tab_keeps_its_table_icon", () => {
  render(<TabStrip tabs={[table]} active={table.key} connections={[prod]} onSelect={() => {}} onClose={() => {}} onNew={() => {}} />);
  const tab = screen.getByRole("tab", { name: "stores, Production" });
  expect(iconsIn(tab, KINDS)).toEqual(["table"]);
  expect(tab.textContent).toContain("PROD");
});

test("prod_chip_says_production_to_readers", () => {
  render(<TabStrip tabs={[q("a", "Query 1")]} active="query:a" connections={[prod]} onSelect={() => {}} onClose={() => {}} onNew={() => {}} />);
  const tab = screen.getByRole("tab", { name: "Query 1, Production" });
  const chip = tab.querySelector(".safety-tag-production") as HTMLElement;
  expect(chip.classList.contains("safety-tag-small")).toBe(true);
  expect(within(chip).getByText("PROD").getAttribute("aria-hidden")).toBe("true");
  expect(within(chip).getByText("Production").classList.contains("visually-hidden")).toBe(true);
});

test("window_tabs_show_their_icon_and_name", () => {
  const model = { path: "E:\\models\\shop.dbml", dbml: "", savedDbml: "", layout: EMPTY_LAYOUT, dialect: "mysql", source: "file", connectionId: null } as const;
  const tabs: AnyTab[] = [
    { kind: "home" },
    { kind: "settings", section: "ai" },
    { kind: "schema", id: "m1", doc: model },
    { kind: "schema", id: "m2", doc: { ...model, path: null } },
  ];
  render(<TabStrip tabs={tabs} active="home" onSelect={() => {}} onClose={() => {}} onNew={() => {}} />);
  expect(iconsIn(screen.getByRole("tab", { name: "Home", selected: true }), KINDS)).toEqual(["grid"]);
  expect(iconsIn(screen.getByRole("tab", { name: "Settings" }), KINDS)).toEqual(["gear"]);
  expect(iconsIn(screen.getByRole("tab", { name: "shop.dbml" }), KINDS)).toEqual(["layers"]);
  expect(screen.getByRole("tab", { name: "untitled.dbml" })).toBeTruthy();
  // C1: "+" is there with no place tab at all, and Home closes like any tab.
  expect(screen.getByRole("button", { name: "New query" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Close Home" })).toBeTruthy();
});

test("ctrl_w_closes_and_ctrl_tab_cycles", async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const tabs: AnyTab[] = [{ kind: "home" }, q("a", "Query 1"), q("b", "Query 2")];
  const { rerender } = render(<TabStrip tabs={tabs} active="query:a" onSelect={onSelect} onClose={onClose} onNew={() => {}} />);
  await userEvent.keyboard("{Control>}w{/Control}");
  expect(onClose).toHaveBeenCalledWith("query:a");
  await userEvent.keyboard("{Control>}{Tab}{/Control}");
  expect(onSelect).toHaveBeenLastCalledWith("query:b");
  await userEvent.keyboard("{Control>}{Shift>}{Tab}{/Shift}{/Control}");
  expect(onSelect).toHaveBeenLastCalledWith("home");
  // It wraps at either end.
  rerender(<TabStrip tabs={tabs} active="query:b" onSelect={onSelect} onClose={onClose} onNew={() => {}} />);
  await userEvent.keyboard("{Control>}{Tab}{/Control}");
  expect(onSelect).toHaveBeenLastCalledWith("home");
  // A middle click closes the tab under the pointer.
  fireEvent(screen.getByRole("tab", { name: "Query 2" }), new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
  expect(onClose).toHaveBeenLastCalledWith("query:b");
});

test("new_query_names_count_up", () => {
  expect(nextQueryName([])).toBe("Query 1");
  expect(nextQueryName(["Query 1", "Weekly sales", "Query 3"])).toBe("Query 4");
});

test("parse_drafts_never_throws", () => {
  const docs = [
    { id: "a", name: "Query 1", text: "SELECT 1", connectionId: "c1", database: "shop", savedId: null, savedText: null },
  ];
  expect(parseDrafts(serializeDrafts(docs))).toEqual(docs);
  expect(parseDrafts("not json")).toEqual([]);
  expect(parseDrafts('{"version":9}')).toEqual([]);
  expect(parseDrafts('[{"id":1}]')).toEqual([]);
  expect(placeKey({ kind: "group", groupId: "g1" })).toBe("group:g1");
  expect(placeKey({ kind: "ungrouped" })).toBe("ungrouped");
});

test("saved_query_tab_has_no_kind_word_and_says_it_in_the_tooltip", () => {
  const shop = { ...prod, name: "shop-staging", production: false };
  render(
    <TabStrip
      tabs={[q("a", "late shipments by carrier", { savedId: "s1", savedText: "SELECT 1", text: "SELECT 1" })]}
      active="query:a"
      connections={[shop]}
      onSelect={() => {}}
      onClose={() => {}}
      onNew={() => {}}
    />,
  );
  const tab = screen.getByRole("tab", { name: "late shipments by carrier" });
  expect(tab.textContent).toBe("late shipments by carrier");
  expect(tab.getAttribute("title")).toBe("late shipments by carrier, Saved Query on shop-staging");
});

test("the_saved_queries_list_tab_is_named_and_closes", async () => {
  const onClose = vi.fn();
  render(
    <TabStrip
      tabs={[{ kind: "savedQueries" }]}
      active="savedQueries"
      onSelect={() => {}}
      onClose={onClose}
      onNew={() => {}}
    />,
  );
  expect(screen.getByRole("tab", { name: "Saved Queries" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Close Saved Queries" }));
  expect(onClose).toHaveBeenCalledWith("savedQueries");
});

/** NF1: picking or opening a tab scrolls it into view inside the strip. */
test("the_active_tab_scrolls_into_view", () => {
  const scrolled: string[] = [];
  // jsdom has no scrollIntoView; the strip calls it when it exists.
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute("data-key") ?? "");
  };
  try {
    const props = { onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn() };
    const { rerender } = render(<TabStrip tabs={[q("a", "Query 1"), q("b", "Query 2")]} active="query:a" {...props} />);
    expect(scrolled).toEqual(["query:a"]);
    rerender(<TabStrip tabs={[q("a", "Query 1"), q("b", "Query 2")]} active="query:b" {...props} />);
    expect(scrolled).toEqual(["query:a", "query:b"]);
    rerender(<TabStrip tabs={[q("a", "Query 1"), q("b", "Query 2"), q("c", "Query 3")]} active="query:c" {...props} />);
    expect(scrolled[scrolled.length - 1]).toBe("query:c");
  } finally {
    if (original) Element.prototype.scrollIntoView = original;
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

test("design_tabs_read_table_design_or_new_table_with_the_edit_icon", () => {
  const path = { database: "shop", schema: null, name: "orders" };
  const design: WorkTab = { kind: "design", key: "design\u0000orders", connectionId: "c1", target: { kind: "alter", path } };
  const create: WorkTab = {
    kind: "design",
    key: "design\u0000new\u0000n1",
    connectionId: "c1",
    target: { kind: "create", scope: { database: "shop", schema: null }, id: "n1" },
  };
  render(
    <TabStrip
      tabs={[design, create]}
      active={design.key}
      connections={[prod]}
      dirtyKeys={new Set([design.key])}
      onSelect={() => {}}
      onClose={() => {}}
      onNew={() => {}}
    />,
  );
  const tab = screen.getByRole("tab", { name: "orders design, unsaved changes, Production" });
  expect(iconsIn(tab, [...KINDS, "edit"])).toEqual(["edit"]);
  expect(within(tab).getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
  expect(within(tab).getByText("PROD")).toBeTruthy();
  const fresh = screen.getByRole("tab", { name: "New table, Production" });
  expect(iconsIn(fresh, [...KINDS, "edit"])).toEqual(["edit"]);
});

test("import_tabs_read_import_into_with_the_import_icon_and_chips", () => {
  const path = { database: "shop", schema: "public", name: "menu_items" };
  const into: WorkTab = { kind: "import", key: "import\u0000t", connectionId: "c1", target: { kind: "table", path } };
  const script: WorkTab = { kind: "import", key: "import\u0000d", connectionId: "c2", target: { kind: "database", database: "shop" } };
  const readOnly = { ...prod, id: "c2", name: "replica", production: false, readOnly: true };
  render(
    <TabStrip
      tabs={[into, script]}
      active={into.key}
      connections={[prod, readOnly]}
      onSelect={() => {}}
      onClose={() => {}}
      onNew={() => {}}
    />,
  );
  const tab = screen.getByRole("tab", { name: "Import into menu_items, Production" });
  expect(iconsIn(tab, [...KINDS, "import"])).toEqual(["import"]);
  expect(within(tab).getByText("PROD")).toBeTruthy();
  const db = screen.getByRole("tab", { name: "Import into shop, Read-only" });
  expect(iconsIn(db, [...KINDS, "import"])).toEqual(["import"]);
});

test("a_lineage_tab_reads_table_lineage_with_the_flow_icon", () => {
  const path = { database: "shop", schema: "public", name: "orders" };
  const tab: WorkTab = { kind: "lineage", key: "lineage\u0000o", connectionId: "c1", path };
  render(<TabStrip tabs={[tab]} active={tab.key} connections={[prod]} onSelect={() => {}} onClose={() => {}} onNew={() => {}} />);
  const el = screen.getByRole("tab", { name: "orders lineage, Production" });
  expect(iconsIn(el, [...KINDS, "flow"])).toEqual(["flow"]);
});

const vqModel = (tables: string[] = []) => ({
  version: 1,
  database: "shop",
  dialect: "mysql" as const,
  tables: tables.map((name, i) => ({ id: `t${i}`, schema: null, name, alias: name[0], x: 0, y: 0 })),
  joins: [],
  columns: [],
  filters: [],
  groupBy: { kind: "auto" as const },
  orderBy: [],
  limit: null,
  distinct: false,
});
const visual = (id: string, over: Partial<VisualTabDoc> = {}): WorkTab => ({
  kind: "visual",
  doc: { id, name: "New Visual Query", connectionId: "c1", database: "shop", model: vqModel(), savedId: null, savedJson: null, ...over },
});

test("visual_tab_shows_its_icon_name_mark_and_prod_chip", () => {
  render(<TabStrip tabs={[visual("v1")]} active="visual:v1" onSelect={() => {}} onClose={() => {}} onNew={() => {}} onNewVisual={() => {}} connections={[prod]} />);
  const tab = screen.getByRole("tab", { name: "New Visual Query, Production", selected: true });
  expect(iconsIn(tab, ["visualQuery", ...KINDS])).toEqual(["visualQuery"]);
  expect(tab.querySelector(".db-mark")).toBeTruthy();
  expect(within(tab).getByText("PROD")).toBeTruthy();
});

test("visual_tab_is_dirty_only_when_saved_and_its_model_changed", () => {
  const saved = JSON.stringify(vqModel(["orders"]));
  render(
    <TabStrip
      tabs={[
        visual("a", { name: "late orders", savedId: "s1", savedJson: saved, model: vqModel(["orders"]) }),
        visual("b", { name: "by store", savedId: "s2", savedJson: saved, model: vqModel(["orders", "stores"]) }),
        visual("c", { model: vqModel(["orders"]) }),
      ]}
      active="visual:a"
      onSelect={() => {}}
      onClose={() => {}}
      onNew={() => {}}
      onNewVisual={() => {}}
    />,
  );
  expect(within(screen.getByRole("tab", { name: "late orders" })).queryByLabelText("Unsaved changes")).toBeNull();
  expect(within(screen.getByRole("tab", { name: "by store, unsaved changes" })).getByLabelText("Unsaved changes")).toBeTruthy();
  expect(within(screen.getByRole("tab", { name: "New Visual Query" })).queryByLabelText("Unsaved changes")).toBeNull();
});

test("the_chevron_menu_offers_new_query_and_new_visual_query", async () => {
  const onNew = vi.fn();
  const onNewVisual = vi.fn();
  const { rerender } = render(<TabStrip tabs={[]} active={null} onSelect={() => {}} onClose={() => {}} onNew={onNew} onNewVisual={onNewVisual} />);
  await userEvent.click(screen.getByRole("button", { name: "More new tabs" }));
  const menu = screen.getByRole("menu", { name: "New tab" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual(["New query", "New Visual Query"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "New Visual Query" }));
  expect(onNewVisual).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "More new tabs" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New query" }));
  expect(onNew).toHaveBeenCalledTimes(1);

  // No open Connection: New Visual Query is off and says why.
  rerender(<TabStrip tabs={[]} active={null} onSelect={() => {}} onClose={() => {}} onNew={onNew} onNewVisual={onNewVisual} newVisualReady={false} />);
  await userEvent.click(screen.getByRole("button", { name: "More new tabs" }));
  const off = screen.getByRole("menuitem", { name: "New Visual Query" }) as HTMLButtonElement;
  expect(off.getAttribute("aria-disabled")).toBe("true");
  expect(off.title).toBe("Open a Connection first");
  // The arrow keys reach it, so the reason can be read; Enter on it does nothing.
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "New query" }));
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(off);
  expect(off.getAttribute("aria-description")).toBe("Open a Connection first");
  await userEvent.keyboard("{Enter}");
  expect(onNewVisual).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("menu", { name: "New tab" })).toBeTruthy();
  await userEvent.click(off);
  expect(onNewVisual).toHaveBeenCalledTimes(1);
});

test("a_visual_draft_round_trips_and_an_old_draft_has_none", () => {
  const doc: VisualTabDoc = { id: "v1", name: "New Visual Query", connectionId: "c1", database: "shop", model: vqModel(["orders"]), savedId: null, savedJson: null };
  const queries = [{ id: "a", name: "Query 1", text: "SELECT 1", connectionId: "c1", database: "shop", savedId: null, savedText: null }];
  const json = serializeDrafts(queries, [doc]);
  expect(JSON.parse(json).version).toBe(1);
  expect(parseDrafts(json)).toEqual(queries);
  expect(parseVisualDrafts(json)).toEqual([doc]);
  // A draft written before step 6 has no `visual` key.
  expect(parseVisualDrafts(JSON.stringify({ version: 1, tabs: queries }))).toEqual([]);
  // A model of an unknown version is dropped; nothing throws.
  const newer = { ...doc, id: "v2", model: { ...doc.model, version: 2 } };
  expect(parseVisualDrafts(JSON.stringify({ version: 1, tabs: [], visual: [doc, newer, { id: 3 }] }))).toEqual([doc]);
  expect(parseVisualDrafts("not json")).toEqual([]);
  // A removed Connection is null and still restores (P10).
  const removed = { ...doc, id: "v3", connectionId: null };
  expect(parseVisualDrafts(serializeDrafts([], [removed]))).toEqual([removed]);
});

test("a_diagram_tab_marks_a_save_still_to_come_or_failed", () => {
  const off = registerFlow("strip-demo", { save: "saved", line: null, col: null, errors: 0, flush: async () => true });
  try {
    render(<TabStrip tabs={[{ kind: "flow", name: "strip-demo" }]} active="flow:strip-demo" connections={[]} onSelect={() => {}} onClose={() => {}} onNew={() => {}} />);
    expect(screen.getByRole("tab", { name: "strip-demo.flow" })).toBeTruthy();
    act(() => updateFlow("strip-demo", { save: "waiting" }));
    const tab = screen.getByRole("tab", { name: "strip-demo.flow, unsaved changes" });
    expect(within(tab).getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
    act(() => updateFlow("strip-demo", { save: "failed", message: "disk full" }));
    expect(screen.getByRole("tab", { name: "strip-demo.flow, unsaved changes" })).toBeTruthy();
  } finally {
    off();
  }
});

test("the_chevron_menu_offers_new_diagram_with_its_key", async () => {
  const onNewDiagram = vi.fn();
  render(<TabStrip tabs={[]} active={null} onSelect={() => {}} onClose={() => {}} onNew={() => {}} onNewVisual={() => {}} onNewDiagram={onNewDiagram} />);
  await userEvent.click(screen.getByRole("button", { name: "More new tabs" }));
  const menu = screen.getByRole("menu", { name: "New tab" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual(["New query", "New Visual Query", "New diagram"]);
  expect(within(within(menu).getByRole("menuitem", { name: "New diagram" })).getByText("Ctrl+Alt+N")).toBeTruthy();
  await userEvent.click(within(menu).getByRole("menuitem", { name: "New diagram" }));
  expect(onNewDiagram).toHaveBeenCalledTimes(1);
});

test("a_diagram_tab_has_its_file_actions_on_right_click", async () => {
  const actions = { rename: vi.fn(), saveCopy: vi.fn(), remove: vi.fn() };
  render(
    <TabStrip tabs={[{ kind: "flow", name: "checkout" }]} active="flow:checkout" onSelect={() => {}} onClose={() => {}} onNew={() => {}} diagramActions={actions} />,
  );
  fireEvent.contextMenu(screen.getByRole("tab", { name: "checkout.flow" }));
  const menu = screen.getByRole("menu", { name: "checkout.flow" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual(["Rename...", "Save a copy as...", "Delete..."]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Save a copy as..." }));
  expect(actions.saveCopy).toHaveBeenCalledWith("checkout");
  expect(screen.queryByRole("menu", { name: "checkout.flow" })).toBeNull();
});

test("item_34_the_new_tab_menu_draws_large_icon_tiles_with_a_line_each_and_closes_on_escape", async () => {
  render(
    <TabStrip tabs={[]} active={null} onSelect={() => {}} onClose={() => {}} onNew={() => {}} onNewVisual={() => {}} onNewDiagram={() => {}} onNewModel={() => {}} newQueryWhere="On kestrel-main, shop" />,
  );
  await userEvent.click(screen.getByRole("button", { name: "More new tabs" }));
  const menu = screen.getByRole("menu", { name: "New tab" });
  expect(within(menu).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Write", "Draw"]);
  const query = within(menu).getByRole("menuitem", { name: "New query" });
  expect(query.querySelector(".new-tab-tile svg.feature-icon")?.getAttribute("data-feature")).toBe("query");
  expect(query.querySelector(".new-tab-tile svg")?.getAttribute("width")).toBe("28");
  expect(query.textContent).toContain("On kestrel-main, shop");
  expect(within(menu).getByRole("menuitem", { name: "New Schema Model" }).querySelector("svg")?.getAttribute("data-feature")).toBe("model");
  // The first row has focus; arrows move; Escape closes.
  expect(document.activeElement).toBe(query);
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "New Visual Query" }));
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu", { name: "New tab" })).toBeNull();
});

test("item_7_dragging_a_tab_past_its_neighbours_reorders_and_a_short_press_does_not", async () => {
  const q = (id: string) => ({ kind: "query" as const, doc: { id, name: id, text: "", connectionId: null, database: null, savedId: null, savedText: null } });
  const onReorder = vi.fn();
  const onSelect = vi.fn();
  render(<TabStrip tabs={[{ kind: "home" }, q("a"), q("b"), q("c")]} active="query:a" onSelect={onSelect} onClose={() => {}} onNew={() => {}} onReorder={onReorder} />);
  // Lay the tabs out 100 px wide, 6 px apart.
  const tabsEl = [...document.querySelectorAll<HTMLElement>(".work-tab")];
  tabsEl.forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: i * 106, width: 100, right: i * 106 + 100, top: 0, bottom: 32, height: 32, x: i * 106, y: 0, toJSON() {} }) as DOMRect;
  });
  const a = tabsEl[1];
  // A short press is a click, never a move.
  fireEvent.pointerDown(a, { button: 0, clientX: 150 });
  fireEvent.pointerMove(window, { clientX: 152 });
  fireEvent.pointerUp(window, { clientX: 152 });
  expect(onReorder).not.toHaveBeenCalled();
  // Dragged right past b's middle: b slides left by a's width, and the drop puts a after b.
  fireEvent.pointerDown(a, { button: 0, clientX: 150 });
  fireEvent.pointerMove(window, { clientX: 260 });
  expect(a.style.transform).toBe("translateX(110px)");
  expect(tabsEl[2].style.transform).toBe("translateX(-106px)");
  fireEvent.pointerUp(window, { clientX: 260 });
  expect(onReorder).toHaveBeenCalledWith("query:a", "query:b");
  // Home never moves.
  fireEvent.pointerDown(tabsEl[0], { button: 0, clientX: 50 });
  fireEvent.pointerMove(window, { clientX: 300 });
  fireEvent.pointerUp(window, { clientX: 300 });
  expect(onReorder).toHaveBeenCalledTimes(1);
});

test("item_7_alt_arrows_move_the_focused_tab_within_its_part_of_the_strip", async () => {
  const q = (id: string) => ({ kind: "query" as const, doc: { id, name: id, text: "", connectionId: null, database: null, savedId: null, savedText: null } });
  const flow = { kind: "flow" as const, name: "d" };
  const onSelect = vi.fn();
  function Strip() {
    const [tabs, setTabs] = useState<AnyTab[]>([{ kind: "home" }, q("a"), q("b"), flow]);
    return (
      <TabStrip tabs={tabs} active="query:a" onSelect={onSelect} onClose={() => {}} onNew={() => {}} onReorder={(from, to) => setTabs((t) => moveTab(t, from, to))} />
    );
  }
  render(<Strip />);
  const order = () => [...document.querySelectorAll<HTMLElement>(".work-tab")].map((el) => el.dataset.key);
  screen.getByRole("tab", { name: "a" }).focus();
  await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
  expect(order()).toEqual(["home", "query:b", "query:a", tabKey(flow)]);
  // Focus stays on the moved tab.
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "a" }));
  // A place tab never crosses into the window tabs, nor past Home.
  await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
  expect(order()).toEqual(["home", "query:b", "query:a", tabKey(flow)]);
  await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}{Alt>}{ArrowLeft}{/Alt}");
  expect(order()).toEqual(["home", "query:a", "query:b", tabKey(flow)]);
  expect(onSelect).not.toHaveBeenCalled();
});

test("item_7_the_click_that_ends_a_drag_does_not_select_the_tab", () => {
  const q = (id: string) => ({ kind: "query" as const, doc: { id, name: id, text: "", connectionId: null, database: null, savedId: null, savedText: null } });
  const onSelect = vi.fn();
  render(<TabStrip tabs={[q("a"), q("b")]} active="query:b" onSelect={onSelect} onClose={() => {}} onNew={() => {}} onReorder={() => {}} />);
  const a = document.querySelector<HTMLElement>(".work-tab") as HTMLElement;
  const button = within(a).getByRole("tab", { name: "a" });
  fireEvent.pointerDown(button, { button: 0, clientX: 50 });
  fireEvent.pointerMove(window, { clientX: 200 });
  fireEvent.pointerUp(window, { clientX: 200 });
  fireEvent.click(button);
  expect(onSelect).not.toHaveBeenCalled();
  // A plain click after it selects as before.
  fireEvent.pointerDown(button, { button: 0, clientX: 50 });
  fireEvent.pointerUp(window, { clientX: 50 });
  fireEvent.click(button);
  expect(onSelect).toHaveBeenCalledWith("query:a");
});

test("item_1_a_preview_tab_is_italic_and_a_double_click_keeps_it", () => {
  const onKeep = vi.fn();
  const preview = {
    kind: "object" as const,
    key: "c1:table:shop..orders",
    preview: true,
    selection: { connectionId: "c1", kind: "table" as const, path: { database: "shop", schema: null, name: "orders" } },
  };
  render(<TabStrip tabs={[preview]} active={preview.key} onSelect={() => {}} onClose={() => {}} onNew={() => {}} onKeep={onKeep} />);
  const tab = document.querySelector(".work-tab") as HTMLElement;
  expect(tab.className).toContain("work-tab-preview");
  expect(screen.getByRole("tab", { name: "orders" }).getAttribute("title")).toBe("orders. Preview: the next table you open replaces it. Double-click to keep it.");
  fireEvent.doubleClick(tab);
  expect(onKeep).toHaveBeenCalledWith(preview.key);
});
