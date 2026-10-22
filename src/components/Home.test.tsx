import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, Group } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import App from "../App";
import Home from "./Home";
import appCss from "../styles/app.css?raw";
import { setPlatformForTests } from "../platform";

/** The tab strip's New query button (the feature bar has its own, item 16). */
const stripNew = () => screen.getAllByRole("button", { name: "New query" }).find((b) => b.closest(".tab-strip")) ?? (() => { throw new Error("no New query in the tab strip"); })();


/** The body of the rule whose selector is exactly `selector`. */
function rulesOf(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(appCss)?.[1] ?? "";
}

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const groups: Group[] = [
  { id: "g1", name: "KFC", color: "indigo", hasImage: false },
  { id: "g2", name: "Acme", color: "sky", hasImage: false },
];

function conn(id: string, name: string, groupId: string | null): ConnectionConfig {
  return {
    id,
    name,
    dialect: "mysql",
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    database: null,
    ssl: { mode: "disable" },
    file: null,
    queryTimeoutSecs: null,
    aiAccess: "schema",
    production: false,
    readOnly: false,
    groupId,
  };
}

const connections = [conn("a", "kfc-prod", "g1"), conn("b", "kfc-staging", "g1"), conn("c", "laragon", null)];

function renderHome(props: Partial<Parameters<typeof Home>[0]> = {}) {
  render(
    <Home
      groups={groups}
      connections={connections}
      openIds={new Set()}
      recent={[]}
      onOpenGroup={() => {}}
      onOpenConnection={() => {}}
      onOpenUngrouped={() => {}}
      onOpenRecent={() => {}}
      onChanged={() => {}}
      onShowAllHistory={() => {}}
      {...props}
    />,
  );
}

test("lists groups with connection counts and ungrouped connections", async () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome();
  const kfc = screen.getByRole("region", { name: "KFC" });
  expect(within(kfc).getByText("2 Connections")).toBeTruthy();
  expect(within(kfc).getByText("kfc-prod")).toBeTruthy();
  expect(within(kfc).getByText("kfc-staging")).toBeTruthy();
  const acme = screen.getByRole("region", { name: "Acme" });
  expect(within(acme).getByText("No Connections")).toBeTruthy();
  const ungrouped = screen.getByRole("region", { name: "Ungrouped" });
  expect(within(ungrouped).getByText("laragon")).toBeTruthy();
  expect(within(ungrouped).queryByText("kfc-prod")).toBeNull();
  expect(screen.getByText("3 Connections in 2 Groups, 1 Ungrouped")).toBeTruthy();
});

test("filter_hides_rows_and_empty_cards", async () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome();
  await userEvent.type(screen.getByRole("searchbox", { name: "Filter Connections" }), "stag");
  const kfc = screen.getByRole("region", { name: "KFC" });
  expect(within(kfc).getByText("kfc-staging")).toBeTruthy();
  expect(within(kfc).queryByText("kfc-prod")).toBeNull();
  expect(screen.queryByRole("region", { name: "Acme" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Ungrouped" })).toBeNull();
});

test("ctrl_shift_f_moves_into_the_filter", async () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome();
  await userEvent.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
  expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter Connections" }));
});

test("drop_on_a_card_moves_the_connection", async () => {
  const onChanged = vi.fn();
  routeInvoke({ suggested_connections: () => [], move_connection: () => ({ ...connections[2], groupId: "g1" }) });
  renderHome({ connections: [conn("a", "kfc-prod", "g1"), conn("c2", "laragon", null)], onChanged });
  expect(screen.getByText("Drag a Connection onto another card to move it to that Group.")).toBeTruthy();
  const row = within(screen.getByRole("region", { name: "Ungrouped" })).getByRole("listitem");
  expect(row.getAttribute("draggable")).toBe("true");
  const data = new Map<string, string>();
  const dataTransfer = {
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    effectAllowed: "",
    dropEffect: "",
    types: ["text/plain"],
  };
  fireEvent.dragStart(row, { dataTransfer });
  const kfc = screen.getByRole("region", { name: "KFC" });
  fireEvent.dragOver(kfc, { dataTransfer });
  fireEvent.drop(kfc, { dataTransfer });
  await waitFor(() => expect(callsTo("move_connection")).toEqual([{ id: "c2", groupId: "g1" }]));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

afterEach(() => vi.useRealTimers());

test("open_word_and_last_opened_time", () => {
  // Midday on a fixed day: "12m ago" must not depend on the time the suite runs.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 15, 14, 0));
  routeInvoke({ suggested_connections: () => [] });
  const recent = [
    {
      target: { kind: "table" as const, path: { database: "shop", schema: null, name: "orders" }, object: "table" as const },
      connectionId: "a",
      openedAtMs: Date.now() - 12 * 60_000,
    },
  ];
  renderHome({ openIds: new Set(["a"]), recent });
  const kfc = screen.getByRole("region", { name: "KFC" });
  const [prod, staging] = within(kfc).getAllByRole("listitem");
  expect(within(prod).getByText("Open")).toBeTruthy();
  expect(within(prod).getByText("12m ago")).toBeTruthy();
  expect(within(staging).queryByText("Open")).toBeNull();
  expect(within(prod).getByRole("button", { name: "kfc-prod, open" })).toBeTruthy();
  expect(within(staging).getByRole("button", { name: "kfc-staging, closed" })).toBeTruthy();
});

test("the_ungrouped_card_name_opens_ungrouped", async () => {
  routeInvoke({ suggested_connections: () => [] });
  const onOpenUngrouped = vi.fn();
  renderHome({ onOpenUngrouped });
  await userEvent.click(within(screen.getByRole("region", { name: "Ungrouped" })).getByRole("button", { name: "Open Ungrouped" }));
  expect(onOpenUngrouped).toHaveBeenCalled();
});

test("clicking_a_connection_row_opens_it", async () => {
  routeInvoke({ suggested_connections: () => [] });
  const onOpenConnection = vi.fn();
  renderHome({ onOpenConnection });
  await userEvent.click(screen.getByRole("button", { name: "laragon, closed" }));
  expect(onOpenConnection).toHaveBeenCalledWith("c");
});

// Opening a Group and remembering it is one path in App, so this renders the whole app starting at Home.
test("clicking a group card opens it and calls set_last_group", async () => {
  routeInvoke({
    list_groups: () => groups,
    list_connections: () => connections,
    last_group: () => null,
    suggested_connections: () => [],
    set_last_group: () => null,
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Home" });
  await userEvent.click(screen.getByRole("button", { name: "Open KFC" }));
  expect(await screen.findByRole("button", { name: "Switch Group, current KFC" })).toBeTruthy();
  await waitFor(() => expect(callsTo("set_last_group")).toEqual([{ id: "g1" }]));
  expect(within(screen.getByRole("tree", { name: "Connections" })).getByRole("treeitem", { name: "kfc-prod, closed" })).toBeTruthy();
});

test("suggested connection add pre-fills form with port 3310 and no group", async () => {
  routeInvoke({
    suggested_connections: () => [
      { name: "Laragon MySQL", dialect: "mysql", host: "127.0.0.1", port: 3310, user: "root", version: "8.0.30" },
    ],
  });
  renderHome();
  await userEvent.click(await screen.findByRole("button", { name: "Add MySQL 8.0.30" }));
  const dialog = await screen.findByRole("dialog");
  expect((within(dialog).getByLabelText("Port") as HTMLInputElement).value).toBe("3310");
  expect((within(dialog).getByLabelText("Host") as HTMLInputElement).value).toBe("127.0.0.1");
  expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Laragon MySQL");
  expect((within(dialog).getByLabelText("Group") as HTMLSelectElement).value).toBe("");
});

test("postgres_and_mysql_suggestions_on_one_host_both_show", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  // One host and port for both, so only the Dialect tells the two rows apart.
  routeInvoke({
    suggested_connections: () => [
      { name: "Laragon MySQL", dialect: "mysql", host: "127.0.0.1", port: 5432, user: "root", version: "8.0.30" },
      { name: "Laragon PostgreSQL", dialect: "postgres", host: "127.0.0.1", port: 5432, user: "postgres", version: "17.0" },
    ],
  });
  renderHome();
  expect(await screen.findByRole("button", { name: "Add MySQL 8.0.30" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add PostgreSQL 17.0" })).toBeTruthy();
  const keyWarnings = errors.mock.calls.filter((args) => String(args[0]).includes("same key"));
  errors.mockRestore();
  expect(keyWarnings).toEqual([]);
});

test("sqlite_connection_shows_its_file", async () => {
  routeInvoke({ suggested_connections: () => [] });
  const short = { ...conn("s1", "Shop file", null), dialect: "sqlite" as const, host: "", port: 0, file: "C:\\data\\shop.db" };
  const longPath = "C:\\Users\\Rifqi\\Documents\\Projects\\kfc\\exports\\2026\\october\\stores-2026-10-15.sqlite";
  const long = { ...short, id: "s2", name: "Store exports", file: longPath };
  renderHome({ connections: [short, long] });
  const list = screen.getByRole("list", { name: "Ungrouped Connections" });
  expect(within(list).getByText("C:\\data\\shop.db").getAttribute("title")).toBe("C:\\data\\shop.db");
  const shortened = within(list).getByText("C:\\Users\\Rifqi\\…\\stores-2026-10-15.sqlite");
  expect(shortened.getAttribute("title")).toBe(longPath);
  expect(within(list).queryByText(":0")).toBeNull();
});

test("marks_follow_the_open_state", () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome({ openIds: new Set(["c"]) });
  const ungrouped = screen.getByRole("list", { name: "Ungrouped Connections" });
  expect(within(ungrouped).getByRole("img", { name: "MySQL" }).getAttribute("style")).toContain("var(--db-mysql)");
  cleanup();
  routeInvoke({ suggested_connections: () => [] });
  renderHome({ openIds: new Set() });
  const again = screen.getByRole("list", { name: "Ungrouped Connections" });
  expect(within(again).getByRole("img", { name: "MySQL" }).getAttribute("style")).toContain("var(--c-text-faint)");
});

test("rows_show_the_database_mark", async () => {
  routeInvoke({
    suggested_connections: () => [
      { name: "Laragon PostgreSQL", dialect: "postgres", host: "127.0.0.1", port: 5432, user: "postgres", version: null },
    ],
  });
  const sqlite = { ...conn("s1", "Shop file", null), dialect: "sqlite" as const, file: "C:\\data\\shop.db" };
  renderHome({ connections: [conn("c", "laragon", null), sqlite] });
  const ungrouped = screen.getByRole("list", { name: "Ungrouped Connections" });
  const rows = within(ungrouped).getAllByRole("listitem");
  expect(within(rows[0]).getByRole("img", { name: "MySQL" })).toBeTruthy();
  expect(within(rows[1]).getByRole("img", { name: "SQLite" })).toBeTruthy();
  const suggested = await screen.findByRole("list", { name: "Suggested Connections" });
  expect(within(suggested).getByRole("img", { name: "PostgreSQL" })).toBeTruthy();
});

test("empty_state_follows_dn_with_the_laragon_box", async () => {
  routeInvoke({
    suggested_connections: () => [
      { name: "Laragon MySQL", dialect: "mysql", host: "127.0.0.1", port: 3306, user: "root", version: "8.0.30" },
    ],
  });
  renderHome({ groups: [], connections: [] });
  expect(screen.getByText("No Connections yet")).toBeTruthy();
  expect(screen.getByText("Add a Connection to browse, query and change a database.")).toBeTruthy();
  expect(await screen.findByText("Found on this computer in Laragon. Nothing is saved until you add it.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "New Connection" }));
  expect(await screen.findByRole("dialog", { name: "New Connection" })).toBeTruthy();
});

test("empty_state_without_suggestions_has_no_laragon_box", async () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome({ groups: [], connections: [] });
  await waitFor(() => expect(callsTo("suggested_connections").length).toBeGreaterThan(0));
  expect(screen.queryByText(/Found on this computer/)).toBeNull();
});

const suggest = [
  { name: "Laragon MySQL", dialect: "mysql" as const, host: "127.0.0.1", port: 3306, user: "root", version: "8.0.30" },
  { name: "Laragon PostgreSQL", dialect: "postgres" as const, host: "127.0.0.1", port: 5432, user: "postgres", version: null },
];

test("header_actions_are_filter_new_group_new_connection", () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome();
  const header = document.querySelector<HTMLElement>("header.home-header")!;
  expect(within(header).getByRole("heading", { name: "Home" })).toBeTruthy();
  expect(within(header).getByRole("searchbox", { name: "Filter Connections" })).toBeTruthy();
  const buttons = within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(buttons).toEqual(["New Group", "New Connection"]);
  expect(within(header).queryByRole("button", { name: "New Schema Model" })).toBeNull();
});

test("new_diagram_sits_beside_new_group_with_its_key", async () => {
  routeInvoke({ suggested_connections: () => [] });
  const onNewDiagram = vi.fn();
  renderHome({ onNewDiagram });
  const header = document.querySelector<HTMLElement>("header.home-header")!;
  const buttons = within(header).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(buttons).toEqual(["New Group", "New diagram", "New Connection"]);
  const button = within(header).getByRole("button", { name: "New diagram" });
  expect(button.className).toBe("button");
  expect(within(button).getByText("Ctrl+Alt+N")).toBeTruthy();
  await userEvent.click(button);
  expect(onNewDiagram).toHaveBeenCalledTimes(1);
});

test("count_line_stays_on_one_line", () => {
  expect(rulesOf(".home-count")).toMatch(/white-space:\s*nowrap/);
  expect(rulesOf(".home-heading")).toMatch(/flex:\s*1 0 auto/);
  expect(rulesOf(".home-actions")).toMatch(/flex:\s*none/);
});

test("filter_hint_is_boxed_and_new_connection_has_ctrl_n", () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome();
  const filter = screen.getByRole("searchbox", { name: "Filter Connections" }).closest("label")!;
  expect(filter.querySelector("kbd.kbd")?.textContent).toBe("Ctrl+Shift+F");
  expect(appCss).not.toMatch(/\.home-filter \.kbd/);
  const add = screen.getByRole("button", { name: "New Connection" });
  expect(add.querySelector("kbd.kbd")?.textContent).toBe("Ctrl+N");
});

test("group_card_has_one_horizontal_actions_button_and_rows_have_none", () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome();
  const kfc = screen.getByRole("region", { name: "KFC" });
  expect(within(kfc).getAllByRole("button", { name: /actions/i }).map((b) => b.getAttribute("aria-label"))).toEqual(["Group actions for KFC"]);
  expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
  const dots = screen.getByRole("button", { name: "Group actions for KFC" }).querySelector("svg path")!.getAttribute("d");
  // H4: three filled-looking r=1 rings in a row (Lucide ellipsis), not 1 px specks.
  expect(dots).toBe("M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0zM11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0zM18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0z");
});

test("group_menu_is_not_inside_an_overflow_hidden_card", () => {
  expect(rulesOf(".group-card")).not.toMatch(/overflow:\s*hidden/);
});

test("open_connection_mark_is_brand_coloured", () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome({ openIds: new Set(["a"]) });
  const kfc = screen.getByRole("region", { name: "KFC" });
  const [open, closed] = within(kfc).getAllByRole("listitem");
  expect(within(open).getByRole("img", { name: "MySQL" }).getAttribute("style")).toContain("var(--db-mysql)");
  expect(within(closed).getByRole("img", { name: "MySQL" }).getAttribute("style")).toContain("var(--c-text-faint)");
});

test("every_row_shows_its_last_opened_time", () => {
  routeInvoke({ suggested_connections: () => [] });
  const now = new Date(2026, 9, 17, 11, 0);
  renderHome({
    now,
    connections: [conn("a", "one", null), conn("b", "two", null), conn("c", "three", null)],
    openedTimes: {
      a: now.getTime() - 12 * 60_000,
      b: new Date(2026, 9, 17, 9, 41).getTime(),
      c: new Date(2026, 9, 9, 12, 0).getTime(),
    },
  });
  const rows = within(screen.getByRole("list", { name: "Ungrouped Connections" })).getAllByRole("listitem");
  expect(within(rows[0]).getByText("12m ago")).toBeTruthy();
  expect(within(rows[1]).getByText("Today 09:41")).toBeTruthy();
  expect(within(rows[2]).getByText("Oct 9")).toBeTruthy();
});

test("drag_hint_sits_under_the_cards", () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome();
  const hint = screen.getByText("Drag a Connection onto another card to move it to that Group.");
  const area = hint.closest(".home-scroll")!;
  expect(area.querySelector(".group-cards")).toBeTruthy();
  expect(area.contains(document.querySelector("header.home-header"))).toBe(false);
});

test("open_word_is_success_text_600_in_ui_font", () => {
  const body = rulesOf(".list-row-state");
  expect(body).toMatch(/color:\s*var\(--c-success-text\)/);
  expect(body).toMatch(/font-weight:\s*600/);
  expect(body).toMatch(/font-family:\s*var\(--font-family-ui\)/);
});

test("empty_state_has_no_home_header", () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome({ groups: [], connections: [] });
  expect(screen.queryByRole("heading", { name: "Home" })).toBeNull();
  expect(document.querySelector("header.home-header")).toBeNull();
  expect(screen.queryByRole("button", { name: "New Group" })).toBeNull();
  expect(screen.getByRole("heading", { name: "No Connections yet" })).toBeTruthy();
  expect(screen.getByText("Add a Connection to browse, query and change a database.")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "New Connection" })).toHaveLength(1);
});

test("suggestions_show_brand_mark_name_with_version_and_mono_host", async () => {
  routeInvoke({ suggested_connections: () => suggest });
  renderHome({ groups: [], connections: [] });
  const list = await screen.findByRole("list", { name: "Suggested Connections" });
  expect(within(list).getByText("MySQL 8.0.30")).toBeTruthy();
  expect(within(list).getByText("PostgreSQL")).toBeTruthy();
  const host = within(list).getByText("127.0.0.1:3306");
  expect(host.className).toBe("home-suggested-target");
  expect(rulesOf(".home-suggested-target")).toMatch(/font:\s*var\(--font-mono-small\)/);
  expect(within(list).getByRole("img", { name: "MySQL" }).getAttribute("style")).toContain("var(--db-mysql)");
  expect(rulesOf(".home-suggested-row .button")).toMatch(/height:\s*24px/);
  expect(screen.getByText("Found on this computer in Laragon. Nothing is saved until you add it.")).toBeTruthy();
});

test("empty_new_connection_has_ctrl_n", () => {
  routeInvoke({ suggested_connections: () => [] });
  renderHome({ groups: [], connections: [] });
  expect(screen.getByRole("button", { name: "New Connection" }).querySelector("kbd.kbd")?.textContent).toBe("Ctrl+N");
});

test("show_all_history_opens_query_history_for_all_beside_a_query_tab", async () => {
  routeInvoke({
    list_groups: () => groups,
    list_connections: () => connections,
    last_group: () => null,
    suggested_connections: () => [],
    recent_items: () => [],
    connection_opened_times: () => ({}),
    load_query_tabs: () => null,
    save_query_tabs: () => null,
    list_saved_queries: () => [],
    set_last_group: () => null,
    query_history: () => [],
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Show all history" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  expect(await screen.findByRole("searchbox", { name: "Filter history" })).toBeTruthy();
  expect(screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked")).toBe("true");
  await waitFor(() => expect(callsTo("query_history")[0]).toMatchObject({ id: null }));
});

test("show_all_history_uses_the_places_active_query_tab_not_the_last", async () => {
  routeInvoke({
    list_groups: () => groups,
    list_connections: () => connections,
    last_group: () => null,
    suggested_connections: () => [],
    recent_items: () => [],
    connection_opened_times: () => ({}),
    load_query_tabs: () => null,
    save_query_tabs: () => null,
    list_saved_queries: () => [],
    set_last_group: () => null,
    query_history: () => [],
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Open Ungrouped" }));
  await userEvent.click((await waitFor(stripNew)));
  await userEvent.click(stripNew());
  await userEvent.click(await screen.findByRole("tab", { name: "Query 1" }));
  await userEvent.click(screen.getByRole("tab", { name: "Home" }));
  await userEvent.click(await screen.findByRole("button", { name: "Show all history" }));
  expect(await screen.findByRole("tab", { name: "Query 1", selected: true })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Query 2", selected: false })).toBeTruthy();
  expect((await screen.findByRole("radio", { name: "All" })).getAttribute("aria-checked")).toBe("true");
});

test("item_11_a_dragged_connection_lifts_out_and_settles_into_its_new_group", async () => {
  const onChanged = vi.fn();
  routeInvoke({ suggested_connections: () => [], move_connection: () => ({ ...conn("c2", "laragon", "g2") }) });
  renderHome({
    connections: [conn("a", "kfc-prod", "g1"), conn("c2", "laragon", null)],
    groups: [{ id: "g1", name: "KFC", color: "teal", hasImage: false }, { id: "g2", name: "Orbit", color: "teal", hasImage: false }],
    onChanged,
  });
  // A new, empty Group says what to do with it.
  const orbit = screen.getByRole("region", { name: "Orbit" });
  expect(orbit.textContent).toContain("Drag a Connection here to add it to Orbit.");
  const row = within(screen.getByRole("region", { name: "Ungrouped" })).getByRole("listitem");
  const dataTransfer = { setData: () => {}, getData: () => "", effectAllowed: "", dropEffect: "", types: ["text/plain"] };
  fireEvent.dragStart(row, { dataTransfer });
  expect(row.className).toContain("is-dragging");
  fireEvent.dragOver(orbit, { dataTransfer });
  expect(orbit.className).toContain("group-card-drop");
  fireEvent.drop(orbit, { dataTransfer });
  await waitFor(() => expect(callsTo("move_connection")).toEqual([{ id: "c2", groupId: "g2" }]));
  expect(orbit.className).not.toContain("group-card-drop");
});

test("parity_P11_38_laragon_box_names_this_pc_on_windows", async () => {
  routeInvoke({
    suggested_connections: () => [
      { name: "Laragon MySQL", dialect: "mysql", host: "127.0.0.1", port: 3306, user: "root", version: "8.0.30" },
    ],
  });
  try {
    setPlatformForTests("windows");
    renderHome({ groups: [], connections: [] });
    expect(await screen.findByText("Found on this PC in Laragon. Nothing is saved until you add it.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Found on this PC" })).toBeTruthy();
  } finally {
    setPlatformForTests(null);
  }
});
