import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import App from "../App";
import type { ConnectionConfig, ConnectionId, DbObject, Group, SavedQuery } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import { GroupImagesProvider } from "../components/GroupBadge";
import { iconElement } from "../components/Icon";
import OneTree, { type OneTreeProps } from "./OneTree";
import { type RevealRequest, useTreeData } from "./useTreeData";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const groups: Group[] = [
  { id: "g1", name: "KFC", color: "indigo", hasImage: false },
  { id: "g2", name: "Acme", color: "sky", hasImage: false },
];

function conn(id: string, name: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id,
    name,
    dialect: "mysql",
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    database: "shop",
    ssl: { mode: "disable" },
    file: null,
    queryTimeoutSecs: null,
    aiAccess: "schema",
    production: false,
    readOnly: false,
    groupId: "g1",
    ...over,
  };
}

const OBJECTS: DbObject[] = [
  { kind: "table", name: "orders", rows: 18402 },
  { kind: "table", name: "stores", rows: null },
  { kind: "view", name: "v_daily_sales", rows: null },
  { kind: "procedure", name: "close_day", rows: null },
];

type HarnessProps = Partial<OneTreeProps> & {
  connections: ConnectionConfig[];
  open?: ConnectionId[];
  reveal?: RevealRequest | null;
  onNotOpen?: (id: ConnectionId) => void;
  onRevealed?: () => void;
  /** Hands the test the tree's data, to call refresh and reveal as the App does. */
  treeRef?: { current: ReturnType<typeof useTreeData> | null };
};

function noop() {}

function handlers() {
  return {
    onSelectObject: vi.fn(),
    onOpenConnection: vi.fn(),
    onCloseConnection: vi.fn(),
    onEditConnection: vi.fn(),
    onDuplicateConnection: vi.fn(),
    onNewQuery: vi.fn(),
    onNewVisualQuery: vi.fn(),
    onNewSchemaModel: vi.fn(),
    onMoveConnection: vi.fn(),
    onNewGroup: vi.fn(),
    onClearHistory: vi.fn(),
    onDeleteConnection: vi.fn(),
    onRefresh: vi.fn(),
    onOpenSaved: vi.fn(),
    onOpenSavedList: vi.fn(),
    onFocusBranch: vi.fn(),
    onSavedChanged: vi.fn(),
  };
}

function Harness({ connections, open = [], reveal, onNotOpen, onRevealed, treeRef, ...rest }: HarnessProps) {
  const openIds = new Set(open);
  const tree = useTreeData({ connections, openIds: useStable(openIds), onNotOpen, onRevealed });
  if (treeRef) treeRef.current = tree;
  const revealSeq = reveal?.seq;
  // The App calls reveal once per request, as here.
  useRevealOnce(tree, reveal ?? null, revealSeq);
  return (
    <OneTree
      connections={connections}
      groups={groups}
      openIds={openIds}
      saved={[]}
      activeSavedId={null}
      selected={null}
      tree={tree}
      onSelectObject={noop}
      onOpenConnection={noop}
      onCloseConnection={noop}
      onEditConnection={noop}
      onDuplicateConnection={noop}
      onNewQuery={noop}
      onNewVisualQuery={noop}
      onNewSchemaModel={noop}
      onMoveConnection={noop}
      onNewGroup={noop}
      onClearHistory={noop}
      onDeleteConnection={noop}
      onRefresh={noop}
      onOpenSaved={noop}
      onOpenSavedList={noop}
      onFocusBranch={noop}
      {...rest}
    />
  );
}

// A set equal to the last one is kept, so the tree's open effect sees no change on a rerender.
let lastSet: ReadonlySet<string> | null = null;
function useStable(s: ReadonlySet<string>): ReadonlySet<string> {
  if (lastSet && lastSet.size === s.size && [...s].every((x) => lastSet!.has(x))) return lastSet;
  lastSet = s;
  return s;
}

let lastReveal: number | undefined;
function useRevealOnce(tree: ReturnType<typeof useTreeData>, reveal: RevealRequest | null, seq: number | undefined) {
  if (reveal && seq !== lastReveal) {
    lastReveal = seq;
    queueMicrotask(() => tree.reveal(reveal));
  }
}

beforeEach(() => {
  lastSet = null;
  lastReveal = undefined;
});

function routeMy(extra: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({ list_databases: () => ["shop"], list_objects: () => OBJECTS, ...extra });
}

const item = (name: string | RegExp) => screen.getByRole("treeitem", { name });
const findItem = (name: string | RegExp) => screen.findByRole("treeitem", { name });
const names = () => screen.getAllByRole("treeitem").map((r) => r.getAttribute("aria-label"));

// ---------- Structure ----------

test("role_tree_with_levels_expanded_and_selected", async () => {
  routeMy();
  const c = conn("c1", "KFC Shop");
  render(
    <Harness
      connections={[c]}
      open={["c1"]}
      selected={{ connectionId: "c1", kind: "table", path: { database: "shop", schema: null, name: "orders" } }}
    />,
  );
  const tree = screen.getByRole("tree", { name: "Connections" });
  const orders = await findItem("orders");
  expect(within(tree).getAllByRole("treeitem").length).toBeGreaterThan(3);
  const row = item("KFC Shop, open");
  expect(row.getAttribute("aria-level")).toBe("1");
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(item("shop").getAttribute("aria-level")).toBe("2");
  expect(item("shop").getAttribute("aria-expanded")).toBe("true");
  expect(item("Tables").getAttribute("aria-level")).toBe("3");
  expect(orders.getAttribute("aria-level")).toBe("4");
  expect(orders.getAttribute("aria-selected")).toBe("true");
  expect(orders.hasAttribute("aria-expanded")).toBe(false);
  expect(item("stores").getAttribute("aria-selected")).toBe("false");
  // The roving focus starts on the selected row.
  expect(orders.tabIndex).toBe(0);
  expect(item("stores").tabIndex).toBe(-1);
  // Views start closed; Tables open the first time a scope loads.
  expect(item("Views").getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("treeitem", { name: "v_daily_sales" })).toBeNull();
});

test("every_open_connection_is_expanded_at_once", async () => {
  routeInvoke({
    list_databases: ({ id }) => (id === "a" ? ["shop"] : ["crm"]),
    list_objects: ({ database }) => (database === "shop" ? OBJECTS : [{ kind: "table", name: "leads", rows: 3 }]),
  });
  render(
    <Harness
      connections={[conn("a", "Shop"), conn("b", "CRM", { database: "crm" }), conn("c", "Closed one")]}
      open={["a", "b"]}
    />,
  );
  await findItem("orders");
  await findItem("leads");
  expect(item("Shop, open").getAttribute("aria-expanded")).toBe("true");
  expect(item("CRM, open").getAttribute("aria-expanded")).toBe("true");
  expect(item("Closed one, closed").getAttribute("aria-expanded")).toBe("false");
  expect(names()).toEqual([
    "Closed one, closed",
    "CRM, open",
    "crm",
    "Tables",
    "leads",
    "Shop, open",
    "shop",
    "Tables",
    "orders",
    "stores",
    "Views",
    "Procedures",
    "Saved Queries",
    expect.stringContaining("to keep the query here"),
  ]);
});

test("connection_row_mark_is_brand_when_open_and_muted_when_closed", async () => {
  routeInvoke({ list_databases: () => [] });
  const pg = { dialect: "postgres" as const, port: 5432 };
  render(<Harness connections={[conn("a", "Orders", pg), conn("b", "Reporting", pg)]} open={["a"]} />);
  const open = within(item("Orders, open")).getByRole("img", { name: "PostgreSQL, open" });
  const closed = within(item("Reporting, closed")).getByRole("img", { name: "PostgreSQL, closed" });
  expect(open.getAttribute("style")).toContain("var(--db-pg)");
  expect(closed.getAttribute("style")).toContain("var(--c-text-faint)");
  expect(document.querySelector(".status-dot")).toBeNull();
  await waitFor(() => expect(callsTo("list_databases")).toHaveLength(1));
});

test("prod_chip_and_lock_sit_on_the_row", () => {
  routeInvoke({});
  render(
    <Harness
      connections={[conn("a", "kfc-prod", { production: true, readOnly: true }), conn("b", "kfc-staging")]}
    />,
  );
  const prod = item("kfc-prod, closed, Production, Read-only");
  expect(within(prod).getByText("PROD")).toBeTruthy();
  expect(within(prod).getByText("Production").className).toContain("visually-hidden");
  expect(within(prod).getByRole("img", { name: "Read-only" })).toBeTruthy();
  // Both on the one row, the chip before the lock.
  const chip = within(prod).getByText("PROD");
  const lock = within(prod).getByRole("img", { name: "Read-only" });
  expect(chip.compareDocumentPosition(lock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const staging = item("kfc-staging, closed");
  expect(within(staging).queryByText("PROD")).toBeNull();
  expect(within(staging).queryByRole("img", { name: "Read-only" })).toBeNull();
});

test("connection_row_name_says_production_and_read_only", () => {
  routeInvoke({});
  render(<Harness connections={[conn("a", "kfc-prod", { production: true, readOnly: true }), conn("b", "kfc-ro", { readOnly: true })]} />);
  expect(screen.getByRole("treeitem", { name: "kfc-prod, closed, Production, Read-only" })).toBeTruthy();
  expect(screen.getByRole("treeitem", { name: "kfc-ro, closed, Read-only" })).toBeTruthy();
  // R8: spoken "Production", never "PROD".
  expect(screen.queryByRole("treeitem", { name: /PROD/ })).toBeNull();
});

test("connection_rows_are_one_line_without_host_or_state_word", () => {
  routeInvoke({});
  const sqlite = conn("s", "shop-file", { dialect: "sqlite", host: "", port: 0, file: "C:\\data\\shop.db" });
  render(<Harness connections={[conn("a", "kfc-prod"), sqlite]} />);
  for (const row of [item("kfc-prod, closed"), item("shop-file, closed")]) {
    expect(row.textContent).not.toMatch(/127\.0\.0\.1|3306|shop\.db|Open|Closed|Working/);
    expect(row.querySelector(".connection-sub, .connection-meta, .connection-tags")).toBeNull();
  }
});

test("hover_offers_close_edit_and_more", async () => {
  routeMy();
  const h = handlers();
  const a = conn("a", "Shop");
  const b = conn("b", "CRM");
  render(<Harness connections={[a, b]} open={["a"]} {...h} />);
  const open = item("Shop, open");
  await userEvent.click(within(open).getByRole("button", { name: "Close Shop" }));
  expect(h.onCloseConnection).toHaveBeenCalledWith("a");
  await userEvent.click(within(open).getByRole("button", { name: "Edit Shop" }));
  expect(h.onEditConnection).toHaveBeenCalledWith(a);
  expect(within(open).getByRole("button", { name: "More actions for Shop" })).toBeTruthy();
  const closed = item("CRM, closed");
  await userEvent.click(within(closed).getByRole("button", { name: "Open CRM" }));
  expect(h.onOpenConnection).toHaveBeenCalledWith("b");
  expect(within(closed).queryByRole("button", { name: "Close CRM" })).toBeNull();
  // A button press is not a row click: the open branch stays expanded.
  expect(item("Shop, open").getAttribute("aria-expanded")).toBe("true");
});

test("double_click_opens_a_closed_connection", async () => {
  routeInvoke({});
  const h = handlers();
  render(<Harness connections={[conn("a", "Shop")]} {...h} />);
  await userEvent.click(item("Shop, closed"));
  expect(h.onOpenConnection).not.toHaveBeenCalled();
  await userEvent.dblClick(item("Shop, closed"));
  expect(h.onOpenConnection).toHaveBeenCalledWith("a");
});

test("a_connection_opening_is_busy_until_its_open_settles", async () => {
  routeInvoke({});
  let done: () => void = () => {};
  const onOpenConnection = vi.fn(() => new Promise<void>((r) => (done = r)));
  render(<Harness connections={[conn("a", "Shop")]} onOpenConnection={onOpenConnection} />);
  await userEvent.dblClick(item("Shop, closed"));
  expect((screen.getByRole("button", { name: "Open Shop" }) as HTMLButtonElement).disabled).toBe(true);
  // The row says so while it opens (frame 10b).
  expect(item("Shop, connecting").textContent).toContain("Connecting...");
  await userEvent.dblClick(item("Shop, connecting"));
  expect(onOpenConnection).toHaveBeenCalledTimes(1);
  done();
  await waitFor(() => expect((screen.getByRole("button", { name: "Open Shop" }) as HTMLButtonElement).disabled).toBe(false));
});

// ---------- Row menu ----------

const menuRows = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .filter((el) => el.closest("[role=menu]") === menu)
    .map((el) => [el.getAttribute("aria-label"), el.querySelector(".menu-shortcut")?.textContent ?? ""]);

test("row_menu_matches_frame_7", async () => {
  routeMy();
  render(<Harness connections={[conn("a", "freight-prod")]} open={["a"]} />);
  await userEvent.click(screen.getByRole("button", { name: "More actions for freight-prod" }));
  const menu = screen.getByRole("menu", { name: "freight-prod" });
  expect(menuRows(menu)).toEqual([
    ["Close Connection", ""],
    ["New query", "Ctrl+T"],
    ["New Visual Query", ""],
    ["New Schema Model...", ""],
    ["Edit Connection...", ""],
    ["Duplicate", ""],
    ["Copy host", ""],
    ["Refresh schema", "F5"],
    ["Move to Group", ""],
    ["Clear Query History...", ""],
    ["Delete Connection...", "Del"],
  ]);
  // Separators after New Schema Model, Move to Group and Clear Query History.
  expect(menu.querySelectorAll(":scope > div > hr.menu-separator")).toHaveLength(3);
  const del = within(menu).getByRole("menuitem", { name: "Delete Connection..." });
  expect(del.className).toContain("menu-item-danger");
});

test("a_closed_connection_menu_opens_instead_of_closing", async () => {
  routeInvoke({});
  const h = handlers();
  render(<Harness connections={[conn("a", "Shop")]} {...h} />);
  await userEvent.click(screen.getByRole("button", { name: "More actions for Shop" }));
  const menu = screen.getByRole("menu", { name: "Shop" });
  expect(menuRows(menu)[0]).toEqual(["Open Connection", ""]);
  expect((within(menu).getByRole("menuitem", { name: "Refresh schema" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Open Connection" }));
  expect(h.onOpenConnection).toHaveBeenCalledWith("a");
});

test("a_connection_row_says_connecting_and_failed", () => {
  routeInvoke({});
  const status = new Map([
    ["a", { s: "connecting" as const }],
    ["b", { s: "failed" as const, error: "Could not connect: refused." }],
  ]);
  render(<Harness connections={[conn("a", "Shop"), conn("b", "Stock"), conn("c", "Ledger")]} openStatus={status} />);
  const shop = screen.getByRole("treeitem", { name: "Shop, connecting" });
  expect(shop.querySelector(".tree-conn-state")?.textContent).toBe("Connecting...");
  const stock = screen.getByRole("treeitem", { name: "Stock, last connect failed" });
  const failed = stock.querySelector(".tree-conn-failed")!;
  expect(failed.textContent).toBe("Failed");
  expect(failed.getAttribute("title")).toBe("Could not connect: refused.");
  expect(failed.querySelector("svg")).not.toBeNull();
  const ledger = screen.getByRole("treeitem", { name: "Ledger, closed" });
  expect(ledger.querySelector(".tree-conn-state")).toBeNull();
});

test("move_to_group_shows_a_groups_image", async () => {
  routeInvoke({});
  const images = { images: new Map([["g2", "data:image/png;base64,AAAA"]]), set: () => {} };
  render(
    <GroupImagesProvider value={images}>
      <Harness connections={[conn("a", "Shop")]} {...handlers()} />
    </GroupImagesProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "More actions for Shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to Group" }));
  const sub = screen.getByRole("menu", { name: "Move to Group" });
  const acme = within(sub).getByRole("menuitem", { name: "Acme" });
  expect(acme.querySelector(".group-badge-image img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  // A Group without an image keeps its letter square.
  expect(within(sub).getByRole("menuitem", { name: "KFC" }).querySelector(".group-badge-image")).toBeNull();
});

test("move_to_group_is_a_submenu_with_the_current_group_disabled", async () => {
  routeInvoke({});
  const h = handlers();
  render(<Harness connections={[conn("a", "Shop")]} {...h} />);
  await userEvent.click(screen.getByRole("button", { name: "More actions for Shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to Group" }));
  const sub = screen.getByRole("menu", { name: "Move to Group" });
  expect(menuRows(sub).map(([l]) => l)).toEqual(["Acme", "KFC", "Ungrouped", "New Group..."]);
  const current = within(sub).getByRole("menuitem", { name: "KFC" }) as HTMLButtonElement;
  expect(current.disabled).toBe(true);
  expect(current.querySelector(".menu-hint")?.textContent).toBe("current");
  await userEvent.click(within(sub).getByRole("menuitem", { name: "Acme" }));
  expect(h.onMoveConnection).toHaveBeenCalledWith("a", "g2");

  await userEvent.click(screen.getByRole("button", { name: "More actions for Shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to Group" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
  expect(h.onMoveConnection).toHaveBeenLastCalledWith("a", null);

  await userEvent.click(screen.getByRole("button", { name: "More actions for Shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Move to Group" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New Group..." }));
  expect(h.onNewGroup).toHaveBeenCalled();
});

test("right_click_opens_the_row_menu", async () => {
  routeMy();
  const h = handlers();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  fireEvent.contextMenu(item("Shop, open"), { clientX: 40, clientY: 60 });
  const menu = screen.getByRole("menu", { name: "Shop" });
  expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Close Connection" }));
  await userEvent.click(within(menu).getByRole("menuitem", { name: "New query" }));
  expect(h.onNewQuery).toHaveBeenCalledWith("a");
  expect(screen.queryByRole("menu")).toBeNull();
  // The context menu key opens it on the focused row too.
  item("Shop, open").focus();
  fireEvent.keyDown(item("Shop, open"), { key: "ContextMenu" });
  expect(screen.getByRole("menu", { name: "Shop" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(item("Shop, open"));
});

test("delete_and_clear_history_confirm_first", async () => {
  routeInvoke({});
  const h = handlers();
  render(<Harness connections={[conn("a", "kfc-prod")]} {...h} />);
  await userEvent.click(screen.getByRole("button", { name: "More actions for kfc-prod" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Clear Query History..." }));
  expect(screen.getByText("Clear the Query History of kfc-prod? Saved Queries are kept.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
  expect(h.onClearHistory).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "More actions for kfc-prod" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Clear Query History..." }));
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(h.onClearHistory).toHaveBeenCalledWith("a");

  // Del on the focused Connection row asks too.
  item("kfc-prod, closed").focus();
  fireEvent.keyDown(item("kfc-prod, closed"), { key: "Delete" });
  const ask = screen.getByRole("dialog", { name: "Delete kfc-prod?" });
  expect(within(ask).getByText("Its saved password is removed too. This cannot be undone.")).toBeTruthy();
  expect(h.onDeleteConnection).not.toHaveBeenCalled();
  await userEvent.click(within(ask).getByRole("button", { name: "Delete Connection" }));
  expect(h.onDeleteConnection).toHaveBeenCalledWith("a");
});

test("copy_host_and_new_schema_model_and_duplicate_from_the_menu", async () => {
  routeInvoke({});
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const h = handlers();
  const c = conn("a", "Shop", { host: "10.0.4.20", port: 3307 });
  render(<Harness connections={[c]} {...h} />);
  const pick = async (label: string) => {
    await userEvent.click(screen.getByRole("button", { name: "More actions for Shop" }));
    await userEvent.click(screen.getByRole("menuitem", { name: label }));
  };
  await pick("Copy host");
  expect(writeText).toHaveBeenCalledWith("10.0.4.20:3307");
  await pick("New Schema Model...");
  expect(h.onNewSchemaModel).toHaveBeenCalledWith("a", "shop", null);
  await pick("Duplicate");
  expect(h.onDuplicateConnection).toHaveBeenCalledWith(c);
  await pick("Edit Connection...");
  expect(h.onEditConnection).toHaveBeenCalledWith(c);
});

// ---------- Folders, counts, databases ----------

test("tables_folder_has_chevron_icon_and_count", async () => {
  routeMy();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} />);
  const tables = await findItem("Tables");
  expect(tables.querySelector(".tree-chevron")).not.toBeNull();
  // The chevron, then the folder icon, then the label and the count on the right.
  expect(tables.querySelectorAll("svg.icon")).toHaveLength(2);
  const count = tables.querySelector(".tree-count") as HTMLElement;
  expect(count.textContent).toBe("2");
  expect(tables.lastElementChild).toBe(count);
  // Folder rows draw the same guides as any row (S5): a stub from the database's column.
  expect(tables.querySelector(".tree-stub")).not.toBeNull();
  await userEvent.click(tables);
  expect(screen.queryByRole("treeitem", { name: "orders" })).toBeNull();
  expect(item("Tables").getAttribute("aria-expanded")).toBe("false");
});

test("table_rows_show_row_estimates", async () => {
  routeMy();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} />);
  const orders = await findItem("orders");
  const est = orders.querySelector(".tree-rows") as HTMLElement;
  expect(est.textContent).toBe("18,402");
  expect(est.className).toContain("tree-count");
  // No estimate, no number.
  expect(item("stores").querySelector(".tree-rows")).toBeNull();
});

test("estimate_reads_the_loaded_row_estimate", async () => {
  routeMy();
  let api: ReturnType<typeof useTreeData> | null = null;
  function Probe() {
    const openIds = useStable(new Set(["a"]));
    api = useTreeData({ connections: [conn("a", "Shop")], openIds });
    return null;
  }
  render(<Probe />);
  await waitFor(() => expect(api!.estimate("a", { database: "shop", schema: null, name: "orders" })).toBe(18402));
  expect(api!.estimate("a", { database: "shop", schema: null, name: "stores" })).toBeNull();
  expect(api!.estimate("a", { database: "other", schema: null, name: "orders" })).toBeNull();
});

const PG_SCHEMAS = [
  { name: "information_schema", isSystem: true },
  { name: "pg_catalog", isSystem: true },
  { name: "public", isSystem: false },
  { name: "sales", isSystem: false },
];

function routePg(extra: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({
    list_databases: () => ["postgres", "shop"],
    list_schemas: () => PG_SCHEMAS,
    list_objects: ({ schema }) =>
      schema === "public"
        ? [{ kind: "table", name: "orders", rows: 5 }]
        : [
            { kind: "table", name: "orders", rows: 9 },
            { kind: "function", name: "add(a numeric, b numeric)", rows: null },
          ],
    ...extra,
  });
}

const pgConn = conn("p", "KFC Orders", { dialect: "postgres", port: 5432 });

test("default_postgres_database_opens_public", async () => {
  routePg();
  render(<Harness connections={[pgConn]} open={["p"]} />);
  await findItem("orders");
  expect(item("shop").getAttribute("aria-expanded")).toBe("true");
  expect(item("public").getAttribute("aria-expanded")).toBe("true");
  expect(item("sales").getAttribute("aria-expanded")).toBe("false");
  expect(item("orders").getAttribute("aria-level")).toBe("5");
  expect(callsTo("list_objects")).toEqual([{ id: "p", database: "shop", schema: "public" }]);
});

test("show_system_schemas_is_in_the_database_menu", async () => {
  routePg();
  const h = handlers();
  render(<Harness connections={[pgConn]} open={["p"]} {...h} />);
  await findItem("public");
  expect(screen.queryByRole("treeitem", { name: "pg_catalog" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Show system schemas" })).toBeNull();
  await userEvent.click(within(item("shop")).getByRole("button", { name: "More actions for shop" }));
  const menu = screen.getByRole("menu", { name: "shop" });
  const toggle = within(menu).getByRole("menuitemcheckbox", { name: "Show system schemas" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(toggle);
  expect(item("pg_catalog")).toBeTruthy();
  expect(item("information_schema")).toBeTruthy();
  // Showing them needs no reload.
  expect(callsTo("list_schemas")).toHaveLength(1);
  await userEvent.click(within(item("shop")).getByRole("button", { name: "More actions for shop" }));
  expect(screen.getByRole("menuitemcheckbox", { name: "Show system schemas" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(screen.getByRole("menuitem", { name: "Reverse-engineer into a Schema Model" }));
  expect(h.onNewSchemaModel).toHaveBeenCalledWith("p", "shop", null);
  // A schema's menu reverse-engineers that schema.
  await userEvent.click(within(item("sales")).getByRole("button", { name: "More actions for sales" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Reverse-engineer into a Schema Model" }));
  expect(h.onNewSchemaModel).toHaveBeenLastCalledWith("p", "shop", "sales");
});

test("mysql_database_menu_has_no_system_schemas", async () => {
  routeMy();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} />);
  await findItem("orders");
  await userEvent.click(within(item("shop")).getByRole("button", { name: "More actions for shop" }));
  expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Reverse-engineer into a Schema Model" })).toBeTruthy();
});

test("tables_with_one_name_in_two_schemas_are_distinct", async () => {
  routePg();
  const h = handlers();
  render(
    <Harness
      connections={[pgConn]}
      open={["p"]}
      selected={{ connectionId: "p", kind: "table", path: { database: "shop", schema: "sales", name: "orders" } }}
      {...h}
    />,
  );
  await findItem("orders");
  await userEvent.click(item("sales"));
  await waitFor(() => expect(screen.getAllByRole("treeitem", { name: "orders" })).toHaveLength(2));
  const [inPublic, inSales] = screen.getAllByRole("treeitem", { name: "orders" });
  expect(inPublic.getAttribute("aria-selected")).toBe("false");
  expect(inSales.getAttribute("aria-selected")).toBe("true");
  await userEvent.click(inPublic);
  expect(h.onSelectObject).toHaveBeenCalledWith({
    connectionId: "p",
    kind: "table",
    path: { database: "shop", schema: "public", name: "orders" },
  });
});

test("sqlite_opens_main_at_once", async () => {
  routeInvoke({ list_databases: () => ["main"], list_objects: () => [{ kind: "table", name: "orders", rows: null }] });
  const file = conn("s", "shop-file", { dialect: "sqlite", host: "", port: 0, database: null, file: "C:\\data\\shop.db" });
  render(<Harness connections={[file]} open={["s"]} />);
  await findItem("orders");
  expect(callsTo("list_objects")).toEqual([{ id: "s", database: "main", schema: null }]);
  expect(callsTo("list_schemas")).toHaveLength(0);
});

test("a_load_error_offers_try_again", async () => {
  let fail = true;
  routePg({
    list_objects: ({ schema }) => {
      if (fail) throw { kind: "query", message: `permission denied for schema ${schema}` };
      return [{ kind: "table", name: "orders", rows: 1 }];
    },
  });
  render(<Harness connections={[pgConn]} open={["p"]} />);
  const note = await findItem(/permission denied for schema public/);
  fail = false;
  await userEvent.click(within(note).getByRole("button", { name: "Try again" }));
  expect(await findItem("orders")).toBeTruthy();
});

test("a_connection_not_open_error_tells_the_owner", async () => {
  routeInvoke({
    list_databases: () => {
      throw { kind: "notFound", message: "connection not open" };
    },
  });
  const onNotOpen = vi.fn();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} onNotOpen={onNotOpen} />);
  expect(await findItem("This Connection is not open. Open it again to continue.")).toBeTruthy();
  expect(onNotOpen).toHaveBeenCalledWith("a");
});

test("reveal_expands_to_the_object_and_focuses_it", async () => {
  routePg();
  const onRevealed = vi.fn();
  const { rerender } = render(<Harness connections={[pgConn]} open={["p"]} onRevealed={onRevealed} />);
  await findItem("public");
  rerender(
    <Harness
      connections={[pgConn]}
      open={["p"]}
      onRevealed={onRevealed}
      reveal={{ connectionId: "p", database: "shop", schema: "sales", name: "add(a numeric, b numeric)", seq: 1 }}
    />,
  );
  const row = await findItem("add(a numeric, b numeric)");
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(item("sales").getAttribute("aria-expanded")).toBe("true");
  expect(item("Functions").getAttribute("aria-expanded")).toBe("true");
  expect(onRevealed).toHaveBeenCalledTimes(1);
});

test("reveal_clears_a_filter_that_hides_the_row", async () => {
  routeMy();
  const { rerender } = render(<Harness connections={[conn("a", "Shop")]} open={["a"]} />);
  await findItem("orders");
  const field = screen.getByRole("searchbox", { name: "Filter objects" }) as HTMLInputElement;
  await userEvent.type(field, "sto");
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: "orders" })).toBeNull());
  rerender(
    <Harness connections={[conn("a", "Shop")]} open={["a"]} reveal={{ connectionId: "a", database: "shop", schema: null, name: "orders", seq: 1 }} />,
  );
  // A reveal always ends on a visible, focused row.
  const row = await findItem("orders");
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(field.value).toBe("");
});

test("reveal_keeps_a_filter_that_shows_the_row", async () => {
  routeMy();
  const { rerender } = render(<Harness connections={[conn("a", "Shop")]} open={["a"]} />);
  await findItem("orders");
  const field = screen.getByRole("searchbox", { name: "Filter objects" }) as HTMLInputElement;
  await userEvent.type(field, "sto");
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: "orders" })).toBeNull());
  rerender(
    <Harness connections={[conn("a", "Shop")]} open={["a"]} reveal={{ connectionId: "a", database: "shop", schema: null, name: "stores", seq: 1 }} />,
  );
  await waitFor(() => expect(document.activeElement).toBe(item("stores")));
  expect(field.value).toBe("sto");
});

test("a_reveal_right_after_a_refresh_waits_for_the_new_list", async () => {
  let created = false;
  routeMy({ list_objects: () => (created ? [...OBJECTS, { kind: "table", name: "invoices", rows: 0 }] : OBJECTS) });
  const treeRef: { current: ReturnType<typeof useTreeData> | null } = { current: null };
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} treeRef={treeRef} />);
  await findItem("orders");
  created = true;
  // The App refreshes the branch and reveals the new table in the same turn.
  act(() => {
    treeRef.current!.refresh("a");
    treeRef.current!.reveal({ connectionId: "a", database: "shop", schema: null, name: "invoices", seq: 1 });
  });
  const row = await findItem("invoices");
  await waitFor(() => expect(document.activeElement).toBe(row));
});

// ---------- Filter ----------

const ctrlShiftF = () =>
  fireEvent.keyDown(document.body, { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });

test("ctrl_shift_f_focuses_filter_objects_and_escape_clears", async () => {
  routeMy();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} />);
  await findItem("orders");
  const field = screen.getByRole("searchbox", { name: "Filter objects" }) as HTMLInputElement;
  expect(field.parentElement?.querySelector("kbd")?.textContent).toBe("Ctrl+Shift+F");
  ctrlShiftF();
  expect(document.activeElement).toBe(field);
  await userEvent.type(field, "sto");
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: "orders" })).toBeNull());
  expect(item("stores")).toBeTruthy();
  expect(item("stores").querySelector("mark")?.textContent).toBe("sto");
  await userEvent.keyboard("{Escape}");
  expect(field.value).toBe("");
  expect(item("orders")).toBeTruthy();
  // A second Escape goes back to the tree.
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement?.getAttribute("role")).toBe("treeitem");
});

test("filter_keys_stay_with_whoever_shows_while_the_tree_is_hidden", () => {
  routeInvoke({});
  render(<Harness connections={[conn("a", "Shop")]} keysActive={false} />);
  ctrlShiftF();
  expect(document.activeElement).not.toBe(screen.getByRole("searchbox", { name: "Filter objects" }));
});

const SAVED: SavedQuery[] = [
  { id: "q1", name: "late orders", sql: "SELECT 2", updatedAtMs: 1, connectionId: "a" },
  { id: "q2", name: "weekly sales", sql: "SELECT 1", updatedAtMs: 2, connectionId: null },
];

test("filter_finds_tables_and_saved_queries", async () => {
  routeMy();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} saved={SAVED} />);
  await findItem("orders");
  await userEvent.type(screen.getByRole("searchbox", { name: "Filter objects" }), "ord");
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: "stores" })).toBeNull());
  expect(names()).toEqual(["Shop, open", "shop", "Tables", "orders", "Saved Queries", "late orders"]);
  await userEvent.clear(screen.getByRole("searchbox", { name: "Filter objects" }));
  await userEvent.type(screen.getByRole("searchbox", { name: "Filter objects" }), "zzz");
  expect(screen.queryAllByRole("treeitem")).toHaveLength(0);
  expect(screen.getByText('Nothing matches "zzz".')).toBeTruthy();
});

// ---------- Saved Queries ----------

test("saved_queries_is_the_last_branch_with_opens_on_text", async () => {
  routeInvoke({});
  const h = handlers();
  render(
    <Harness connections={[conn("a", "shop-staging")]} saved={SAVED} activeSavedId="q2" {...h} />,
  );
  expect(names()).toEqual(["shop-staging, closed", "Saved Queries", "late orders", "weekly sales"]);
  const root = item("Saved Queries");
  expect(root.getAttribute("aria-level")).toBe("1");
  expect(root.querySelector(".tree-count")?.textContent).toBe("2");
  const late = item("late orders");
  expect(late.getAttribute("aria-level")).toBe("2");
  expect(late.querySelector(".tree-meta")?.textContent).toBe("shop-staging");
  expect(late.getAttribute("title")).toBe("late orders, Saved Query on shop-staging");
  expect(item("weekly sales").querySelector(".tree-meta")).toBeNull();
  expect(item("weekly sales").getAttribute("aria-selected")).toBe("true");
  await userEvent.click(late);
  expect(h.onOpenSaved).toHaveBeenCalledWith(SAVED[0]);
});

test("a_saved_visual_query_row_has_its_icon_and_connection_or_says_the_connection_was_removed", async () => {
  routeInvoke({});
  const h = handlers();
  const visual: SavedQuery[] = [
    { id: "v1", name: "late orders by store", sql: "SELECT 1", updatedAtMs: 1, connectionId: "a", kind: "visual", visualJson: "{}" },
    { id: "v2", name: "orphan", sql: "SELECT 1", updatedAtMs: 1, connectionId: null, kind: "visual", visualJson: "{}" },
  ];
  render(<Harness connections={[conn("a", "shop-staging")]} saved={[...SAVED, ...visual]} {...h} />);
  const vq = iconElement("visualQuery").querySelector("path")!.getAttribute("d");
  const iconOf = (name: string) => item(name).querySelector("path")?.getAttribute("d");
  expect(iconOf("late orders by store")).toBe(vq);
  expect(iconOf("late orders")).not.toBe(vq);
  expect(item("late orders by store").querySelector(".tree-meta")?.textContent).toBe("shop-staging");
  expect(item("orphan").querySelector(".tree-meta")?.textContent).toBe("Connection removed");
  // A SQL row with no Connection says nothing.
  expect(item("weekly sales").querySelector(".tree-meta")).toBeNull();
  await userEvent.click(item("orphan"));
  expect(h.onOpenSaved).toHaveBeenCalledWith(visual[1]);
});

test("renaming_a_saved_visual_query_keeps_it_visual", async () => {
  routeInvoke({ save_saved_query: ({ input }) => ({ ...(input as object), updatedAtMs: 3, connectionId: null }) });
  const h = handlers();
  const v: SavedQuery = { id: "v1", name: "by store", sql: "SELECT 1", updatedAtMs: 1, connectionId: null, kind: "visual", visualJson: '{"version":1}' };
  render(<Harness connections={[]} saved={[v]} {...h} />);
  fireEvent.contextMenu(item("by store"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename..." }));
  const name = screen.getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "orders by store");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(h.onSavedChanged).toHaveBeenCalledTimes(1));
  expect(callsTo("save_saved_query")[0].input).toEqual({ id: "v1", name: "orders by store", sql: "SELECT 1", kind: "visual", visualJson: '{"version":1}' });
});

test("saved_list_button_opens_the_list", async () => {
  routeInvoke({});
  const h = handlers();
  render(<Harness connections={[]} saved={SAVED} {...h} />);
  await userEvent.click(within(item("Saved Queries")).getByRole("button", { name: "Open the Saved Queries list" }));
  expect(h.onOpenSavedList).toHaveBeenCalledTimes(1);
  // Opening the list does not fold the branch.
  expect(item("Saved Queries").getAttribute("aria-expanded")).toBe("true");
});

test("no_saved_queries_says_how_to_add_one", () => {
  routeInvoke({});
  render(<Harness connections={[]} />);
  expect(item("Press Ctrl+S in a query tab to keep the query here.")).toBeTruthy();
  expect(item("Saved Queries").querySelector(".tree-count")?.textContent).toBe("0");
});

test("saved_query_menu_renames_and_deletes", async () => {
  routeInvoke({
    save_saved_query: ({ input }) => {
      const i = input as { id: string; name: string; sql: string };
      if (i.name === "late orders") throw { kind: "invalidInput", message: 'A Saved Query named "late orders" exists. Choose another name.' };
      return { ...i, updatedAtMs: 3, connectionId: null };
    },
    delete_saved_query: () => null,
  });
  const h = handlers();
  render(<Harness connections={[]} saved={SAVED} {...h} />);
  fireEvent.contextMenu(item("weekly sales"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename..." }));
  const name = screen.getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "late orders");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Save/ }));
  expect(await screen.findByText('A Saved Query named "late orders" exists. Choose another name.')).toBeTruthy();
  await userEvent.clear(name);
  await userEvent.type(name, "weekly store sales");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(h.onSavedChanged).toHaveBeenCalledTimes(1));
  expect(callsTo("save_saved_query").slice(-1)[0].input).toEqual({ id: "q2", name: "weekly store sales", sql: "SELECT 1" });

  fireEvent.contextMenu(item("weekly sales"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete..." }));
  expect(screen.getByText('Delete the Saved Query "weekly sales"?')).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(callsTo("delete_saved_query")).toEqual([{ id: "q2" }]));
  expect(h.onSavedChanged).toHaveBeenCalledTimes(2);
});

test("a_failed_saved_query_delete_error_clears_on_cancel", async () => {
  routeInvoke({
    delete_saved_query: () => {
      throw { kind: "io", message: "disk full" };
    },
  });
  render(<Harness connections={[]} saved={SAVED} />);
  fireEvent.contextMenu(item("weekly sales"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete..." }));
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.contextMenu(item("weekly sales"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Delete..." }));
  expect(screen.getByText('Delete the Saved Query "weekly sales"?')).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

// ---------- Keyboard, focus and size ----------

test("arrow_keys_move_open_and_close_rows", async () => {
  routeMy();
  const h = handlers();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  await findItem("orders");
  item("Shop, open").focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(item("shop"));
  await userEvent.keyboard("{ArrowLeft}");
  expect(item("shop").getAttribute("aria-expanded")).toBe("false");
  await userEvent.keyboard("{ArrowRight}{ArrowDown}{ArrowDown}");
  expect(document.activeElement).toBe(item("orders"));
  await userEvent.keyboard("{Enter}");
  // Enter keeps the tab, as a double click does (item 1).
  expect(h.onSelectObject).toHaveBeenLastCalledWith({ connectionId: "a", kind: "table", path: { database: "shop", schema: null, name: "orders" } }, { newTab: true });
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(item("Tables"));
});

test("virtualised_with_hundreds_of_tables", async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ kind: "table" as const, name: `table_${String(i).padStart(3, "0")}`, rows: i }));
  routeInvoke({ list_databases: ({ id }) => [`db_${id}`], list_objects: () => many });
  const cs = ["a", "b", "c"].map((id) => conn(id, `Conn ${id}`, { database: `db_${id}` }));
  render(<Harness connections={cs} open={["a", "b", "c"]} saved={SAVED} />);
  await waitFor(() => expect(callsTo("list_objects")).toHaveLength(3));
  await findItem("Conn a, open");
  expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(45);
  const scroller = screen.getByRole("tree");
  const spacers = scroller.querySelectorAll<HTMLElement>(':scope > [role="presentation"]');
  // Every row keeps its place: the spacer below stands in for the rows not drawn.
  expect(parseFloat(spacers[1].style.height)).toBeGreaterThan(28 * 1700);
  item("Conn a, open").focus();
  await userEvent.keyboard("{End}");
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("weekly sales"));
  expect(scroller.scrollTop).toBeGreaterThan(0);
  expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(45);
  await userEvent.keyboard("{Home}");
  await waitFor(() => expect(document.activeElement).toBe(item("Conn a, open")));
  expect(scroller.scrollTop).toBe(0);
});

test("the_tree_stays_tabbable_and_keeps_focus_when_its_row_scrolls_away", async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ kind: "table" as const, name: `table_${String(i).padStart(3, "0")}`, rows: i }));
  routeInvoke({ list_databases: () => ["shop"], list_objects: () => many });
  const h = handlers();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  const row = await findItem("table_002");
  row.focus();
  expect(h.onFocusBranch).toHaveBeenLastCalledWith("a");
  const scroller = screen.getByRole("tree");
  scroller.scrollTop = 28 * 400;
  fireEvent.scroll(scroller);
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: "table_400" })).not.toBeNull());
  // The focused row is still drawn (in its own place) and keeps the focus.
  expect(document.activeElement).toBe(item("table_002"));
  expect(h.onFocusBranch).toHaveBeenLastCalledWith("a");
  // Exactly one row is tabbable, so Tab still reaches the tree.
  expect(screen.getAllByRole("treeitem").filter((r) => r.tabIndex === 0)).toEqual([item("table_002")]);
  // The rows keep their places: the focused row sits above the window, with spacers either side.
  const parts = [...scroller.children] as HTMLElement[];
  const at = parts.indexOf(item("table_002"));
  expect(parts[at - 1].getAttribute("role")).toBe("presentation");
  expect(parts[at + 1].getAttribute("role")).toBe("presentation");
  // Shop, shop, Tables, table_000 and table_001 come before it.
  expect(parseFloat(parts[at - 1].style.height)).toBe(28 * 5);
});

test("a_tree_scrolled_before_any_focus_still_has_one_tabbable_row", async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ kind: "table" as const, name: `t_${i}`, rows: null }));
  routeInvoke({ list_databases: () => ["shop"], list_objects: () => many });
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} />);
  await findItem("t_0");
  const scroller = screen.getByRole("tree");
  scroller.scrollTop = 28 * 500;
  fireEvent.scroll(scroller);
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: "t_0" })).toBeNull());
  const tabbable = screen.getAllByRole("treeitem").filter((r) => r.tabIndex === 0);
  expect(tabbable.map((r) => r.getAttribute("aria-label"))).toEqual(["Shop, open"]);
});

test("f5_refreshes_the_focused_branch", async () => {
  routeInvoke({
    list_databases: ({ id }) => (id === "a" ? ["shop"] : ["crm"]),
    list_objects: ({ database }) => (database === "shop" ? OBJECTS : [{ kind: "table", name: "leads", rows: 3 }]),
  });
  const h = handlers();
  render(<Harness connections={[conn("a", "Shop"), conn("b", "CRM", { database: "crm" })]} open={["a", "b"]} {...h} />);
  await findItem("leads");
  await findItem("orders");
  item("leads").focus();
  const before = callsTo("list_databases").length;
  const f5 = new KeyboardEvent("keydown", { key: "F5", code: "F5", bubbles: true, cancelable: true });
  item("leads").dispatchEvent(f5);
  expect(f5.defaultPrevented).toBe(true);
  expect(h.onRefresh).toHaveBeenCalledWith("b");
  await waitFor(() => expect(callsTo("list_databases").slice(before)).toEqual([{ id: "b" }]));
  expect(callsTo("list_objects").filter((a) => a.id === "a")).toHaveLength(1);
  // What shows stays while it reloads, so the focus does not jump.
  expect(document.activeElement).toBe(item("leads"));
});

test("focus_tells_the_owner_which_branch_leads", async () => {
  routeMy();
  const h = handlers();
  render(
    <>
      <Harness connections={[conn("a", "Shop")]} open={["a"]} saved={SAVED} {...h} />
      <button type="button">Elsewhere</button>
    </>,
  );
  await findItem("orders");
  item("orders").focus();
  expect(h.onFocusBranch).toHaveBeenLastCalledWith("a");
  item("late orders").focus();
  expect(h.onFocusBranch).toHaveBeenLastCalledWith(null);
  item("shop").focus();
  expect(h.onFocusBranch).toHaveBeenLastCalledWith("a");
  screen.getByRole("button", { name: "Elsewhere" }).focus();
  expect(h.onFocusBranch).toHaveBeenLastCalledWith(null);
});

test("a_new_set_of_connections_tells_the_same_branch_again", async () => {
  routeMy();
  const h = handlers();
  const view = (conns: ReturnType<typeof conn>[]) => (
    <Harness connections={conns} open={conns.map((c) => c.id)} saved={SAVED} {...h} />
  );
  const { rerender } = render(view([conn("a", "Shop")]));
  await findItem("orders");
  item("orders").focus();
  expect(h.onFocusBranch).toHaveBeenCalledTimes(1);
  rerender(view([conn("b", "Other")]));
  await findItem("orders");
  rerender(view([conn("a", "Shop")]));
  await findItem("orders");
  item("orders").focus();
  expect(h.onFocusBranch).toHaveBeenCalledTimes(2);
  expect(h.onFocusBranch).toHaveBeenLastCalledWith("a");
});

// ---------- In the App ----------

test("duplicate_opens_new_connection_prefilled", async () => {
  const c = {
    ...conn("c1", "kfc-orders", { dialect: "postgres", host: "10.0.4.20", port: 5432, user: "kfc_app", groupId: null }),
    production: true,
  };
  routeInvoke({
    ui_prefs: () => ({ theme: "dark" }),
    keymap: () => ({}),
    list_groups: () => [],
    list_connections: () => [c],
    last_group: () => null,
    suggested_connections: () => [],
    list_saved_queries: () => [],
    recent_items: () => [],
    load_query_tabs: () => null,
    save_query_tabs: () => null,
    connection_opened_times: () => ({}),
    ai_settings: () => ({ settings: { newConnectionAccess: "schema", inlineAsk: true, errorAsk: true } }),
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Close Home" }));
  await userEvent.click(await screen.findByRole("button", { name: "More actions for kfc-orders" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
  const dialog = await screen.findByRole("dialog", { name: "New Connection" });
  expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("kfc-orders copy");
  expect((within(dialog).getByLabelText("Host") as HTMLInputElement).value).toBe("10.0.4.20");
  expect((within(dialog).getByLabelText("User") as HTMLInputElement).value).toBe("kfc_app");
  expect((within(dialog).getByLabelText("Password") as HTMLInputElement).value).toBe("");
});

test("reopened_connection_starts_with_its_levels_closed_and_nothing_stuck_loading", async () => {
  routeInvoke({ list_databases: () => ["shop", "other"], list_objects: () => OBJECTS });
  const c = conn("a", "Shop");
  const { rerender } = render(<Harness connections={[c]} open={["a"]} />);
  await findItem("orders");
  await userEvent.click(item("other"));
  await waitFor(() => expect(item("other").getAttribute("aria-expanded")).toBe("true"));
  rerender(<Harness connections={[c]} open={[]} />);
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: "other" })).toBeNull());
  rerender(<Harness connections={[c]} open={["a"]} />);
  await findItem("other");
  await waitFor(() => expect(screen.getAllByRole("treeitem", { name: "orders" })).toHaveLength(1));
  expect(item("other").getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText(/Loading/)).toBeNull();
});

test("postgres_database_with_only_system_schemas_offers_to_show_them", async () => {
  routePg({ list_schemas: () => PG_SCHEMAS.filter((s) => s.isSystem) });
  render(<Harness connections={[pgConn]} open={["p"]} />);
  expect(await screen.findByText("shop has no user schemas.")).toBeTruthy();
  expect(screen.queryByText(/has no schemas/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show system schemas" }));
  expect(await findItem("pg_catalog")).toBeTruthy();
  expect(item("information_schema")).toBeTruthy();
  expect(screen.queryByText("shop has no user schemas.")).toBeNull();
});

// ---------- New table and Drop table (D7) ----------

const menuLabels = (name: string) =>
  within(screen.getByRole("menu", { name }))
    .getAllByRole("menuitem")
    .map((el) => el.getAttribute("aria-label"));

test("mysql_database_row_menu_offers_new_table", async () => {
  routeMy();
  const h = { ...handlers(), onNewTable: vi.fn() };
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  await findItem("orders");
  fireEvent.contextMenu(item("shop"));
  expect(menuLabels("shop")).toEqual(["New table...", "Reverse-engineer into a Schema Model"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "New table..." }));
  expect(h.onNewTable).toHaveBeenCalledWith("a", "shop", null);
});

test("postgres_schema_row_offers_new_table_and_its_database_row_does_not", async () => {
  routePg();
  const h = { ...handlers(), onNewTable: vi.fn() };
  render(<Harness connections={[pgConn]} open={["p"]} {...h} />);
  await findItem("orders");
  fireEvent.contextMenu(item("shop"));
  expect(menuLabels("shop")).not.toContain("New table...");
  await userEvent.keyboard("{Escape}");
  fireEvent.contextMenu(item("public"));
  expect(menuLabels("public")[0]).toBe("New table...");
  await userEvent.click(screen.getByRole("menuitem", { name: "New table..." }));
  expect(h.onNewTable).toHaveBeenCalledWith("p", "shop", "public");
});

test("tables_folder_row_offers_new_table", async () => {
  routeMy();
  const h = { ...handlers(), onNewTable: vi.fn() };
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  await findItem("orders");
  fireEvent.contextMenu(item("Tables"));
  expect(menuLabels("Tables")).toEqual(["New table..."]);
  await userEvent.click(screen.getByRole("menuitem", { name: "New table..." }));
  expect(h.onNewTable).toHaveBeenCalledWith("a", "shop", null);
});

test("new_table_is_absent_without_the_handler_and_on_read_only", async () => {
  routeMy();
  const { unmount } = render(<Harness connections={[conn("a", "Shop")]} open={["a"]} />);
  await findItem("orders");
  fireEvent.contextMenu(item("shop"));
  expect(menuLabels("shop")).not.toContain("New table...");
  unmount();
  routeMy();
  render(<Harness connections={[conn("b", "Shop RO", { readOnly: true })]} open={["b"]} onNewTable={vi.fn()} />);
  await findItem("orders");
  fireEvent.contextMenu(item("shop"));
  expect(menuLabels("shop")).not.toContain("New table...");
  await userEvent.keyboard("{Escape}");
  fireEvent.contextMenu(item("Tables"));
  expect(screen.queryByRole("menu", { name: "Tables" })).toBeNull();
});

test("table_row_menu_has_open_design_and_drop", async () => {
  routeMy();
  const h = { ...handlers(), onDesignTable: vi.fn(), onDropTable: vi.fn() };
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  await findItem("orders");
  fireEvent.contextMenu(item("orders"));
  expect(menuLabels("orders")).toEqual(["Open", "Edit structure", "Drop table..."]);
  const path = { database: "shop", schema: null, name: "orders" };
  await userEvent.click(screen.getByRole("menuitem", { name: "Open" }));
  expect(h.onSelectObject).toHaveBeenCalledWith({ connectionId: "a", kind: "table", path }, { newTab: true });
  fireEvent.contextMenu(item("orders"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Edit structure" }));
  expect(h.onDesignTable).toHaveBeenCalledWith({ connectionId: "a", kind: "table", path });
  fireEvent.contextMenu(item("orders"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Drop table..." }));
  expect(h.onDropTable).toHaveBeenCalledWith("a", path);
  // The row count stays on the right; no hover buttons on table rows.
  expect(within(item("orders")).queryByRole("button")).toBeNull();
});

test("table_row_menu_shows_lineage", async () => {
  routeMy();
  const h = { ...handlers(), onDesignTable: vi.fn(), onShowLineage: vi.fn() };
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  await findItem("orders");
  fireEvent.contextMenu(item("orders"));
  expect(menuLabels("orders")).toEqual(["Open", "Edit structure", "Show lineage"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Show lineage" }));
  expect(h.onShowLineage).toHaveBeenCalledWith({ connectionId: "a", kind: "table", path: { database: "shop", schema: null, name: "orders" } });
  expect(within(item("orders")).getByText("18,402")).toBeTruthy();
});

test("table_row_menu_opens_from_the_keyboard", async () => {
  routeMy();
  const h = { ...handlers(), onDesignTable: vi.fn(), onDropTable: vi.fn() };
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  await findItem("orders");
  await userEvent.click(item("orders"));
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  expect(menuLabels("orders")).toEqual(["Open", "Edit structure", "Drop table..."]);
});

test("read_only_table_row_has_design_but_no_drop", async () => {
  routeMy();
  const h = { ...handlers(), onDesignTable: vi.fn(), onDropTable: vi.fn() };
  render(<Harness connections={[conn("a", "Shop", { readOnly: true })]} open={["a"]} {...h} />);
  await findItem("orders");
  fireEvent.contextMenu(item("orders"));
  expect(menuLabels("orders")).toEqual(["Open", "Edit structure"]);
});
test("table_row_menu_has_export_and_import_after_design_table", async () => {
  routeMy();
  const h = { ...handlers(), onDesignTable: vi.fn(), onDropTable: vi.fn(), onExportTable: vi.fn(), onImportTable: vi.fn() };
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  await findItem("orders");
  fireEvent.contextMenu(item("orders"));
  expect(menuLabels("orders")).toEqual(["Open", "Edit structure", "Export...", "Import...", "Drop table..."]);
  const selection = { connectionId: "a", kind: "table", path: { database: "shop", schema: null, name: "orders" } };
  await userEvent.click(screen.getByRole("menuitem", { name: "Export..." }));
  expect(h.onExportTable).toHaveBeenCalledWith(selection);
  fireEvent.contextMenu(item("orders"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Import..." }));
  expect(h.onImportTable).toHaveBeenCalledWith(selection);
});

test("read_only_table_row_still_offers_import_q15", async () => {
  routeMy();
  const h = { ...handlers(), onDesignTable: vi.fn(), onDropTable: vi.fn(), onExportTable: vi.fn(), onImportTable: vi.fn() };
  render(<Harness connections={[conn("a", "Shop", { readOnly: true })]} open={["a"]} {...h} />);
  await findItem("orders");
  fireEvent.contextMenu(item("orders"));
  // Q15: the Import tab itself shows the Read-only state; Drop stays hidden.
  expect(menuLabels("orders")).toEqual(["Open", "Edit structure", "Export...", "Import..."]);
});

test("connection_menu_offers_new_visual_query_open_or_closed", async () => {
  routeMy();
  const h = handlers();
  render(<Harness connections={[conn("a", "Shop"), conn("b", "Archive")]} open={["a"]} {...h} />);
  await userEvent.click(screen.getByRole("button", { name: "More actions for Shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New Visual Query" }));
  expect(h.onNewVisualQuery).toHaveBeenCalledWith("a");
  fireEvent.contextMenu(item(/^Archive/));
  const menu = screen.getByRole("menu", { name: "Archive" });
  expect(menuRows(menu).map(([label]) => label).slice(0, 3)).toEqual(["Open Connection", "New query", "New Visual Query"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "New Visual Query" }));
  expect(h.onNewVisualQuery).toHaveBeenCalledWith("b");
});

test("add_to_visual_query_shows_only_with_its_handler_on_tables_and_views", async () => {
  routeMy();
  const h = { ...handlers(), onDesignTable: vi.fn() };
  const { rerender } = render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  await findItem("orders");
  fireEvent.contextMenu(item("orders"));
  expect(menuLabels("orders")).toEqual(["Open", "Edit structure"]);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(item("Views"));
  fireEvent.contextMenu(await findItem("v_daily_sales"));
  expect(screen.queryByRole("menu", { name: "v_daily_sales" })).toBeNull();

  const onAddToVisualQuery = vi.fn();
  rerender(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} onAddToVisualQuery={onAddToVisualQuery} />);
  fireEvent.contextMenu(item("orders"));
  expect(menuLabels("orders")).toEqual(["Open", "Add to Visual Query", "Edit structure"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Add to Visual Query" }));
  expect(onAddToVisualQuery).toHaveBeenCalledWith({ connectionId: "a", kind: "table", path: { database: "shop", schema: null, name: "orders" } });
  fireEvent.contextMenu(item("v_daily_sales"));
  expect(menuLabels("v_daily_sales")).toEqual(["Add to Visual Query"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Add to Visual Query" }));
  expect(onAddToVisualQuery).toHaveBeenLastCalledWith({ connectionId: "a", kind: "view", path: { database: "shop", schema: null, name: "v_daily_sales" } });
});

test("table_and_view_rows_drag_their_object", async () => {
  routeMy();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} />);
  await findItem("orders");
  await userEvent.click(item("Views"));
  expect(item("orders").getAttribute("draggable")).toBe("true");
  expect((await findItem("v_daily_sales")).getAttribute("draggable")).toBe("true");
  expect(item("Views").getAttribute("draggable")).toBeNull();
  const data = new Map<string, string>();
  const dataTransfer = { setData: (t: string, v: string) => data.set(t, v), effectAllowed: "" };
  fireEvent.dragStart(item("orders"), { dataTransfer });
  expect(JSON.parse(data.get("application/x-contura-object")!)).toEqual({
    connectionId: "a",
    kind: "table",
    path: { database: "shop", schema: null, name: "orders" },
  });
  expect(dataTransfer.effectAllowed).toBe("copy");
});

test("transfer_data_on_database_schema_and_table_rows", async () => {
  routeMy();
  const onTransfer = vi.fn();
  const { unmount } = render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...handlers()} onTransfer={onTransfer} />);
  await findItem("orders");
  await userEvent.click(within(item("shop")).getByRole("button", { name: "More actions for shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Transfer data..." }));
  expect(onTransfer).toHaveBeenLastCalledWith({ connectionId: "a", database: "shop", schema: null, table: null });
  // A table row also ticks that table first.
  fireEvent.contextMenu(item("orders"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Transfer data..." }));
  expect(onTransfer).toHaveBeenLastCalledWith({ connectionId: "a", database: "shop", schema: null, table: "orders" });
  unmount();

  // PostgreSQL copies a schema: the schema row offers it, the database row does not.
  routePg();
  render(<Harness connections={[pgConn]} open={["p"]} {...handlers()} onTransfer={onTransfer} />);
  await findItem("public");
  await userEvent.click(within(item("shop")).getByRole("button", { name: "More actions for shop" }));
  expect(screen.queryByRole("menuitem", { name: "Transfer data..." })).toBeNull();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(within(item("sales")).getByRole("button", { name: "More actions for sales" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Transfer data..." }));
  expect(onTransfer).toHaveBeenLastCalledWith({ connectionId: "p", database: "shop", schema: "sales", table: null });
});

test("schema_compare_on_database_and_schema_rows", async () => {
  routeMy();
  const onCompare = vi.fn();
  const { unmount } = render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...handlers()} onCompare={onCompare} />);
  await findItem("orders");
  await userEvent.click(within(item("shop")).getByRole("button", { name: "More actions for shop" }));
  expect(screen.getByRole("menuitem", { name: "Schema Compare" }).querySelector("svg[data-feature]")?.getAttribute("data-feature")).toBe("compare");
  await userEvent.click(screen.getByRole("menuitem", { name: "Schema Compare" }));
  expect(onCompare).toHaveBeenLastCalledWith({ connectionId: "a", database: "shop", schema: null });
  unmount();

  // PostgreSQL compares one schema: the schema row fills it, the database row starts from public.
  routePg();
  render(<Harness connections={[pgConn]} open={["p"]} {...handlers()} onCompare={onCompare} />);
  await findItem("public");
  await userEvent.click(within(item("sales")).getByRole("button", { name: "More actions for sales" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Schema Compare" }));
  expect(onCompare).toHaveBeenLastCalledWith({ connectionId: "p", database: "shop", schema: "sales" });
  await userEvent.click(within(item("shop")).getByRole("button", { name: "More actions for shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Schema Compare" }));
  expect(onCompare).toHaveBeenLastCalledWith({ connectionId: "p", database: "shop", schema: "public" });
});

test("back_up_and_restore_on_database_schema_and_connection_rows", async () => {
  routeMy();
  const onBackup = vi.fn();
  const onRestore = vi.fn();
  const { unmount } = render(
    <Harness connections={[conn("a", "Shop")]} open={["a"]} {...handlers()} onBackup={onBackup} onRestore={onRestore} />,
  );
  await findItem("orders");
  fireEvent.contextMenu(item("shop"));
  // The rows draw the feature bar's icons, as their neighbours do.
  for (const [name, icon] of [["Back up...", "backup"], ["Restore...", "restore"]] as const) {
    expect(screen.getByRole("menuitem", { name }).querySelector("svg[data-feature]")?.getAttribute("data-feature")).toBe(icon);
  }
  await userEvent.click(screen.getByRole("menuitem", { name: "Back up..." }));
  expect(onBackup).toHaveBeenLastCalledWith({ connectionId: "a", database: "shop", schema: null });
  fireEvent.contextMenu(item("shop"));
  await userEvent.click(screen.getByRole("menuitem", { name: "Restore..." }));
  expect(onRestore).toHaveBeenLastCalledWith({ connectionId: "a", database: "shop", schema: null });
  // A Connection row restores Into a new database.
  await userEvent.click(screen.getByRole("button", { name: "More actions for Shop" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Restore..." }));
  expect(onRestore).toHaveBeenLastCalledWith({ connectionId: "a", database: null, schema: null });
  unmount();

  // PostgreSQL backs up a schema: the schema row offers Back up, the database row only Restore.
  routePg();
  render(<Harness connections={[pgConn]} open={["p"]} {...handlers()} onBackup={onBackup} onRestore={onRestore} />);
  await findItem("public");
  await userEvent.click(within(item("shop")).getByRole("button", { name: "More actions for shop" }));
  expect(screen.queryByRole("menuitem", { name: "Back up..." })).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Restore..." })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(within(item("sales")).getByRole("button", { name: "More actions for sales" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Back up..." }));
  expect(onBackup).toHaveBeenLastCalledWith({ connectionId: "p", database: "shop", schema: "sales" });
  await userEvent.click(within(item("sales")).getByRole("button", { name: "More actions for sales" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Restore..." }));
  expect(onRestore).toHaveBeenLastCalledWith({ connectionId: "p", database: "shop", schema: "sales" });
});

test("item_1_a_click_previews_a_table_and_a_double_click_opens_it_to_stay", async () => {
  routeMy();
  const h = handlers();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} />);
  await userEvent.click(await findItem("orders"));
  expect(h.onSelectObject).toHaveBeenLastCalledWith({ connectionId: "a", kind: "table", path: { database: "shop", schema: null, name: "orders" } });
  fireEvent.doubleClick(item("orders"));
  expect(h.onSelectObject).toHaveBeenLastCalledWith({ connectionId: "a", kind: "table", path: { database: "shop", schema: null, name: "orders" } }, { newTab: true });
});

test("item_8_a_row_in_a_database_reports_it_as_the_one_in_use", async () => {
  routeMy();
  const h = handlers();
  const onUseDatabase = vi.fn();
  render(<Harness connections={[conn("a", "Shop")]} open={["a"]} {...h} onUseDatabase={onUseDatabase} />);
  await userEvent.click(await findItem("orders"));
  expect(onUseDatabase).toHaveBeenLastCalledWith("a", "shop");
});
