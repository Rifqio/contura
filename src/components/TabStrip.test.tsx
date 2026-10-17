import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { nextQueryName, parseDrafts, placeKey, serializeDrafts } from "../query/drafts";
import type { QueryTabDoc } from "../query/QueryTab";
import { EMPTY_LAYOUT } from "../schema/layout";
import type { AnyTab } from "../shell/tabs";
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
