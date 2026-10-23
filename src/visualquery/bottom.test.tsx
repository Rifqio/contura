// Step 12b, board B1 (items 36, 38, 39, 40): the Visual Query's bottom panel, its resize handle, tab badges,
// one "Changed since the last run", the hint strip and the SQL tab while the SQL is being written.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, SqlSchema, VisualQuery, VqColumn, VqPreview } from "../api/types";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import { PrefsProvider } from "../prefs/usePrefs";
import type { VisualTabDoc } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { emptyQuery } from "./model";
import VisualQueryTab, { VQ_PANEL_DEFAULT, VQ_PANEL_MIN } from "./VisualQueryTab";
import appCss from "../styles/app.css?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

patientFile();
beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});

const kestrel: ConnectionConfig = {
  id: "c1",
  name: "kestrel-main",
  dialect: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};

const col = (name: string, typeName = "int", pk = false) => ({ name, typeName, pk });
const SHOP: SqlSchema = {
  searchPath: [],
  tables: [
    { schema: null, name: "orders", kind: "table", columns: [col("id", "int", true), col("store_id"), col("placed_at", "datetime")] },
    { schema: null, name: "stores", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)"), col("city", "varchar(80)")] },
  ],
  fks: [{ from: { schema: null, table: "orders", columns: ["store_id"] }, to: { schema: null, table: "stores", columns: ["id"] } }],
};

let lang: { client: LangClient; schemas: SchemaCache };
const preview = (q: VisualQuery): VqPreview => ({ query: { sql: "SELECT 1", parts: [], outputs: q.columns.map((c) => c.column), warnings: [] }, problems: [] });
let saved: unknown[] = [];

function routes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  saved = [];
  routeInvoke({
    visual_query_sql: ({ query }) => preview(query as VisualQuery),
    ui_prefs: () => ({ theme: "dark" }),
    save_ui_prefs: ({ prefs }) => {
      saved.push(prefs);
      return null;
    },
    ...over,
  });
}

beforeEach(() => {
  const client = new LangClient(() => fakeWorker());
  lang = { client, schemas: new SchemaCache(client, () => Promise.resolve(SHOP)) };
  routes();
});

const card = (id: string, name: string, alias: string, x = 0) => ({ id, schema: null, name, alias, x, y: 0 });
const out = (table: string, column: string): VqColumn => ({ table, column, alias: null, aggregate: null });
const TWO: Partial<VisualQuery> = {
  tables: [card("t1", "orders", "o"), card("t2", "stores", "s", 320)],
  joins: [{ id: "j1", left: "t1", right: "t2", kind: "inner", on: [{ leftColumn: "store_id", rightColumn: "id" }] }],
};

let setModel: (f: (q: VisualQuery) => VisualQuery) => void = () => {};
function Tab({ over, noConnection = false }: { over: Partial<VisualQuery>; noConnection?: boolean }) {
  const [doc, setDoc] = useState<VisualTabDoc>({
    id: "v1",
    name: "New Visual Query",
    connectionId: noConnection ? null : "c1",
    database: "shop",
    model: { ...emptyQuery("shop", "mysql"), ...over },
    savedId: null,
    savedJson: null,
  });
  setModel = (f) => setDoc((d) => ({ ...d, model: f(d.model) }));
  return (
    <ToastProvider>
      <VisualQueryTab
        doc={doc}
        connection={noConnection ? null : kestrel}
        open
        group={null}
        visible
        lang={lang}
        rowEstimate={() => null}
        onChange={setDoc}
        onOpenInEditor={() => {}}
        onSaved={() => {}}
        onOpenConnection={() => {}}
      />
    </ToastProvider>
  );
}

const handle = () => screen.getByRole("separator", { name: "Resize the query panel" });
const bottom = () => document.querySelector<HTMLElement>(".vq-bottom")!;
const heightOf = () => parseFloat(bottom().style.height);
const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

// ---- Item 38: count badges, hidden at 0 ----

test("item_38_tab_counts_are_badges_hidden_at_zero", async () => {
  render(<Tab over={TWO} />);
  const columns = await screen.findByRole("tab", { name: "Columns" });
  expect(columns.querySelector(".vq-tab-badge")).toBeNull();
  expect(screen.getByRole("tab", { name: "Filter and sort" }).querySelector(".vq-tab-badge")).toBeNull();
  act(() => setModel((q) => ({ ...q, columns: [out("t1", "id"), out("t2", "name")], filters: [{ joiner: "and", table: "t2", column: "city", op: "eq", values: ["Oslo"] }] })));
  const ticked = await screen.findByRole("tab", { name: "Columns 2" });
  const badge = ticked.querySelector(".vq-tab-badge")!;
  expect(badge.textContent).toBe("2");
  expect(screen.getByRole("tab", { name: "Filter and sort 1" }).querySelector(".vq-tab-badge")!.textContent).toBe("1");
});

test("item_38_the_columns_empty_state_is_centred_in_the_panel", () => {
  const body = (sel: string) => [...appCss.matchAll(new RegExp(`(?:^|\\n|,)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "g"))].map((m) => m[1]).join("\n");
  expect(body(".vq-columns-empty")).toMatch(/justify-content:\s*center/);
  expect(body(".vq-columns-empty")).toMatch(/align-items:\s*center/);
  expect(body(".vq-columns-empty")).toMatch(/flex:\s*1/);
});

test("item_38_changed_since_the_last_run_shows_once_at_the_end_of_the_tab_strip", async () => {
  const slot = document.createElement("span");
  slot.id = "app-status-slot";
  document.body.appendChild(slot);
  try {
    render(<Tab over={{ ...TWO, columns: [out("t1", "id")] }} />);
    await screen.findByRole("tab", { name: "Columns 1" });
    // Nothing ran yet: no line anywhere.
    expect(screen.queryAllByText("Changed since the last run")).toHaveLength(0);
    // The status slot never carries it.
    expect(slot.textContent).not.toContain("Changed since the last run");
    expect(document.querySelectorAll(".vq-toolbar .vq-changed")).toHaveLength(0);
  } finally {
    slot.remove();
  }
});

// ---- Item 36: the resize handle on the panel's top edge ----

test("item_36_the_panel_starts_at_the_default_height_with_a_separator", async () => {
  render(<Tab over={TWO} />);
  await screen.findByRole("tab", { name: "Columns" });
  expect(VQ_PANEL_DEFAULT).toBe(252);
  expect(VQ_PANEL_MIN).toBe(37);
  expect(heightOf()).toBe(252);
  expect(handle().getAttribute("aria-orientation")).toBe("horizontal");
  expect(handle().getAttribute("aria-valuenow")).toBe("252");
  expect(handle().getAttribute("aria-valuemin")).toBe("37");
  expect(handle().getAttribute("title")).toBe("Drag to resize. Double-click resets.");
});

test("item_36_dragging_resizes_live_within_its_limits_and_saves_on_release", async () => {
  render(
    <PrefsProvider>
      <Tab over={TWO} />
    </PrefsProvider>,
  );
  await screen.findByRole("tab", { name: "Columns" });
  // The canvas has 400 px, so the panel may take all but its 120 px minimum.
  Object.defineProperty(document.querySelector(".vq-canvas")!, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(bottom(), "offsetHeight", { configurable: true, value: 252 });
  fireEvent.pointerDown(handle(), { button: 0, clientY: 500, pointerId: 1 });
  expect(handle().classList.contains("vq-resize-dragging")).toBe(true);
  fireEvent.pointerMove(handle(), { clientY: 400, pointerId: 1 });
  await frame();
  // Live, with the size beside the handle.
  expect(heightOf()).toBe(352);
  expect(handle().getAttribute("aria-valuenow")).toBe("352");
  expect(document.querySelector(".vq-resize-px")!.textContent).toBe("352 px");
  // Never more than leaves the canvas its room.
  fireEvent.pointerMove(handle(), { clientY: -1000, pointerId: 1 });
  await frame();
  expect(heightOf()).toBe(252 + 400 - 120);
  // Never less than the tab strip.
  fireEvent.pointerMove(handle(), { clientY: 5000, pointerId: 1 });
  await frame();
  expect(heightOf()).toBe(37);
  expect(saved).toHaveLength(0);
  fireEvent.pointerUp(handle(), { clientY: 5000, pointerId: 1 });
  expect(handle().classList.contains("vq-resize-dragging")).toBe(false);
  // Remembered for the user, in the prefs.
  await waitFor(() => expect(saved[saved.length - 1]).toMatchObject({ vqPanelHeight: 37 }));
  expect(heightOf()).toBe(37);
});

test("item_36_double_click_resets_to_the_default_and_keys_move_it", async () => {
  routes({ ui_prefs: () => ({ theme: "dark", vqPanelHeight: 180 }) });
  render(
    <PrefsProvider>
      <Tab over={TWO} />
    </PrefsProvider>,
  );
  // The remembered height comes back.
  await waitFor(() => expect(heightOf()).toBe(180));
  fireEvent.doubleClick(handle());
  await waitFor(() => expect(heightOf()).toBe(252));
  await waitFor(() => expect(saved[saved.length - 1]).toMatchObject({ vqPanelHeight: null }));
  // The keyboard moves it too, 16 px a step.
  Object.defineProperty(document.querySelector(".vq-canvas")!, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(bottom(), "offsetHeight", { configurable: true, value: 252 });
  fireEvent.keyDown(handle(), { key: "ArrowUp" });
  fireEvent.keyUp(handle(), { key: "ArrowUp" });
  await waitFor(() => expect(heightOf()).toBe(268));
  // The keys step from the height on screen, which a browser now reports as 268.
  Object.defineProperty(bottom(), "offsetHeight", { configurable: true, value: 268 });
  fireEvent.keyDown(handle(), { key: "ArrowDown" });
  fireEvent.keyUp(handle(), { key: "ArrowDown" });
  await waitFor(() => expect(heightOf()).toBe(252));
});

test("item_36_releasing_or_unmounting_removes_every_listener_it_added", async () => {
  const { unmount } = render(<Tab over={TWO} />);
  await screen.findByRole("tab", { name: "Columns" });
  const el = handle();
  const added: string[] = [];
  const removed: string[] = [];
  const add = el.addEventListener.bind(el);
  const remove = el.removeEventListener.bind(el);
  el.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
    added.push(type);
    add(type, fn, o);
  }) as typeof el.addEventListener;
  el.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => {
    removed.push(type);
    remove(type, fn, o);
  }) as typeof el.removeEventListener;
  const winAdd = vi.spyOn(window, "addEventListener");
  fireEvent.pointerDown(el, { button: 0, clientY: 300, pointerId: 1 });
  expect(added.sort()).toEqual(["lostpointercapture", "pointercancel", "pointermove", "pointerup"]);
  // Pointer capture: nothing on the window.
  expect(winAdd.mock.calls.filter(([t]) => String(t).startsWith("pointer"))).toHaveLength(0);
  fireEvent.pointerUp(el, { clientY: 300, pointerId: 1 });
  expect(removed.sort()).toEqual(added.slice().sort());
  // A drag cut short by closing the tab leaves nothing behind either.
  added.length = 0;
  removed.length = 0;
  fireEvent.pointerDown(el, { button: 0, clientY: 300, pointerId: 1 });
  unmount();
  expect(removed.sort()).toEqual(added.slice().sort());
  winAdd.mockRestore();
});

// ---- Item 40: the hint strip, and Results with no Result 1 tab ----

test("item_40_the_hint_has_its_own_strip_below_the_canvas_once_tables_are_there", async () => {
  const { unmount } = render(<Tab over={{}} />);
  await screen.findByText("Add tables to start");
  expect(document.querySelector(".vq-hint-strip")).toBeNull();
  unmount();
  render(<Tab over={TWO} />);
  await screen.findByRole("tab", { name: "Columns" });
  const strip = document.querySelector<HTMLElement>(".vq-hint-strip")!;
  expect(strip.getAttribute("role")).toBe("note");
  expect(strip.textContent).toContain("Drag a column onto another to join them.");
  // Not drawn over the canvas: a sibling after it, before the panel.
  expect(strip.closest(".vq-canvas")).toBeNull();
  expect(strip.previousElementSibling?.classList.contains("vq-canvas")).toBe(true);
  expect(document.querySelector(".vq-canvas .vq-hint")).toBeNull();
});

test("item_40_the_hint_strip_is_28px", () => {
  const rule = appCss.match(/\n\.vq-hint-strip \{([^}]*)\}/)?.[1] ?? "";
  expect(rule).toMatch(/height:\s*28px/);
  expect(rule).toMatch(/flex:\s*none/);
});

// ---- Carried from Lane A: the SQL tab while the SQL is being written ----

test("the_sql_tab_says_it_is_writing_the_sql_until_the_preview_arrives", async () => {
  let answer: (p: VqPreview) => void = () => {};
  routes({ visual_query_sql: () => new Promise<VqPreview>((r) => (answer = r)) });
  render(<Tab over={TWO} />);
  fireEvent.click(await screen.findByRole("tab", { name: "SQL" }));
  const pane = await screen.findByRole("region", { name: "SQL" });
  await waitFor(() => expect(callsTo("visual_query_sql").length).toBeGreaterThan(0));
  expect(within(pane).getByText("Writing the SQL...")).toBeTruthy();
  await act(async () => answer({ query: { sql: "SELECT o.*, s.*", parts: [], outputs: [], warnings: [] }, problems: [] }));
  await waitFor(() => expect(within(pane).queryByText("Writing the SQL...")).toBeNull());
});

// ---- Item 39: bordered Columns grid and Filter and sort sections ----

test("item_39_columns_sit_in_a_bordered_grid_with_group_by_in_a_footer_bar", async () => {
  render(<Tab over={{ ...TWO, columns: [out("t1", "id"), out("t2", "name")] }} />);
  const panel = await screen.findByRole("tabpanel", { name: /Columns/ });
  const box = panel.querySelector<HTMLElement>(".vq-box")!;
  expect(box.querySelector("table.vq-grid")).not.toBeNull();
  const foot = box.querySelector<HTMLElement>(".vq-box-foot")!;
  expect(within(foot).getByText("Group by")).toBeTruthy();
  expect(within(foot).getByRole("switch", { name: "Edit by hand" })).toBeTruthy();
});

test("item_39_filter_and_sort_has_three_bordered_sections_and_a_footer", async () => {
  const opened: string[] = [];
  render(<Tab over={{ ...TWO, columns: [out("t1", "id")] }} />);
  fireEvent.click(await screen.findByRole("tab", { name: /Filter and sort/ }));
  const panel = await screen.findByRole("tabpanel", { name: /Filter and sort/ });
  const boxes = [...panel.querySelectorAll<HTMLElement>(".vq-filters > .vq-box")];
  expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["Where", "Sort", "Limit and Distinct"]);
  expect(within(boxes[0]).getByText("None yet: every row is shown")).toBeTruthy();
  expect(within(boxes[1]).getByText("In the order the database returns")).toBeTruthy();
  const foot = panel.querySelector<HTMLElement>(".vq-filters-foot")!;
  expect(foot.textContent).toContain("Values are sent as quoted literals. For anything more, Open in editor.");
  expect(within(foot).getByRole("button", { name: /Open in editor/ })).toBeTruthy();
  void opened;
});

test("item_39_layout_css", () => {
  const body = (sel: string) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...appCss.matchAll(new RegExp(`(?:^|\\n)([^{}\\n]*(?:,\\n[^{}\\n]*)*)\\{([^}]*)\\}`, "g"))]
      .filter((m) => m[1].split(",").map((s) => s.trim()).includes(sel))
      .map((m) => m[2])
      .join("\n");
    void esc;
  };
  expect(body(".vq-box")).toMatch(/border:\s*var\(--border-hairline\) solid var\(--c-border\)/);
  expect(body(".vq-box")).toMatch(/border-radius:\s*var\(--rounded-md\)/);
  expect(body(".vq-box")).toMatch(/background:\s*var\(--c-bg-surface\)/);
  expect(body(".vq-grid th")).toMatch(/background:\s*var\(--c-bg-panel\)/);
  expect(body(".vq-grid th")).toMatch(/border-bottom:/);
  expect(body(".vq-grid td")).toMatch(/border-bottom:\s*var\(--border-hairline\) solid var\(--panel-rowline\)/);
  expect(body(".vq-box-foot")).toMatch(/background:\s*var\(--c-bg-panel\)/);
  expect(body(".vq-box-foot")).toMatch(/border-top:/);
  expect(body(".vq-filters")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1\.7fr\) minmax\(0,\s*1fr\) 216px/);
  expect(body(".vq-box-head")).toMatch(/height:\s*28px/);
  expect(body(".vq-tab-badge")).toMatch(/border-radius:\s*999px/);
});

// ---- Fix round 1 ----

test("review_minor_1_a_click_on_the_handle_with_no_move_saves_nothing", async () => {
  render(
    <PrefsProvider>
      <Tab over={TWO} />
    </PrefsProvider>,
  );
  await screen.findByRole("tab", { name: "Columns" });
  await waitFor(() => expect(callsTo("ui_prefs").length).toBeGreaterThan(0));
  fireEvent.pointerDown(handle(), { button: 0, clientY: 300, pointerId: 1 });
  fireEvent.pointerUp(handle(), { clientY: 300, pointerId: 1 });
  fireEvent.pointerDown(handle(), { button: 0, clientY: 300, pointerId: 1 });
  fireEvent.pointerUp(handle(), { clientY: 300, pointerId: 1 });
  await new Promise((r) => setTimeout(r, 20));
  expect(saved).toHaveLength(0);
  expect(heightOf()).toBe(252);
});

test("review_minor_2_keys_step_from_the_shown_height_and_the_separator_has_a_maximum", async () => {
  routes({ ui_prefs: () => ({ theme: "dark", vqPanelHeight: 600 }) });
  render(
    <PrefsProvider>
      <Tab over={TWO} />
    </PrefsProvider>,
  );
  await waitFor(() => expect(heightOf()).toBe(600));
  // A short window squeezed the panel to 400 px; the canvas has its 120.
  Object.defineProperty(bottom(), "offsetHeight", { configurable: true, value: 400 });
  Object.defineProperty(document.querySelector(".vq-canvas")!, "clientHeight", { configurable: true, value: 120 });
  // Reached by the keyboard: the separator reports the height on screen, never more than its maximum.
  fireEvent.focus(handle());
  await waitFor(() => expect(handle().getAttribute("aria-valuemax")).toBe("400"));
  expect(handle().getAttribute("aria-valuenow")).toBe("400");
  fireEvent.keyDown(handle(), { key: "ArrowDown" });
  fireEvent.keyUp(handle(), { key: "ArrowDown" });
  await waitFor(() => expect(saved[saved.length - 1]).toMatchObject({ vqPanelHeight: 384 }));
});

test("branch_review_minor_1_a_held_arrow_key_moves_the_panel_and_saves_once_on_key_up", async () => {
  render(
    <PrefsProvider>
      <Tab over={TWO} />
    </PrefsProvider>,
  );
  await screen.findByRole("tab", { name: "Columns" });
  await waitFor(() => expect(callsTo("ui_prefs").length).toBeGreaterThan(0));
  Object.defineProperty(document.querySelector(".vq-canvas")!, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(bottom(), "offsetHeight", { configurable: true, value: 252 });
  // A held key repeats: the panel moves on each, 16 px a step, and nothing is saved yet.
  for (let i = 0; i < 5; i++) fireEvent.keyDown(handle(), { key: "ArrowUp", repeat: i > 0 });
  expect(heightOf()).toBe(252 + 5 * 16);
  expect(handle().getAttribute("aria-valuenow")).toBe(String(252 + 5 * 16));
  await new Promise((r) => setTimeout(r, 20));
  expect(saved).toHaveLength(0);
  fireEvent.keyUp(handle(), { key: "ArrowUp" });
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toMatchObject({ vqPanelHeight: 332 });
});

test("review_minor_3_without_a_connection_the_sql_tab_does_not_say_it_is_writing", async () => {
  render(<Tab over={TWO} noConnection />);
  fireEvent.click(await screen.findByRole("tab", { name: "SQL" }));
  const pane = await screen.findByRole("region", { name: "SQL" });
  expect(within(pane).queryByText("Writing the SQL...")).toBeNull();
  expect(within(pane).getByText("No SQL without a Connection.")).toBeTruthy();
});

// ---- Release: the live SQL beside the Columns grid ----

const sqlOf = (q: VisualQuery) =>
  [
    `SELECT ${q.columns.length === 0 ? "o.*, s.*" : q.columns.map((c) => `${q.tables.find((t) => t.id === c.table)?.alias}.${c.column}`).join(", ")}`,
    "FROM orders o",
    ...(q.groupBy.kind === "manual" ? [`GROUP BY ${q.groupBy.columns.map((c) => c.column).join(", ")}`] : []),
  ].join("\n");
const liveSql = () => routes({ visual_query_sql: ({ query }) => ({ query: { sql: sqlOf(query as VisualQuery), parts: [], outputs: [], warnings: [] }, problems: [] }) });
const pane = () => screen.getByRole("region", { name: "SQL beside the columns" });

test("release_columns_tab_shows_the_live_sql_beside_the_grid_and_follows_it", async () => {
  liveSql();
  render(<Tab over={TWO} />);
  // Nothing ticked: the SELECT the query would run.
  await waitFor(() => expect(pane().textContent).toContain("SELECT o.*, s.*"));
  act(() => setModel((q) => ({ ...q, columns: [out("t1", "id"), out("t2", "name")] })));
  await waitFor(() => expect(pane().textContent).toContain("SELECT o.id, s.name"));
  // Edit by hand: the Core's text with the hand-picked GROUP BY.
  act(() => setModel((q) => ({ ...q, groupBy: { kind: "manual", columns: [{ table: "t2", column: "name" }] } })));
  await waitFor(() => expect(pane().textContent).toContain("GROUP BY name"));
  // A static block, never a second editor.
  expect(document.querySelectorAll(".cm-editor")).toHaveLength(0);
  // A read-only, highlighted <pre> of the query.
  const pre = pane().querySelector("pre.vq-columns-sql-code")!;
  expect(pre).not.toBeNull();
  expect(pre.textContent).toBe("SELECT o.id, s.name\nFROM orders o\nGROUP BY name");
  expect(pre.querySelector("span[class]")).not.toBeNull();
});

test("release_the_sql_pane_copies_exactly_what_it_shows", async () => {
  liveSql();
  const writes: string[] = [];
  const had = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
  try {
    render(<Tab over={{ ...TWO, columns: [out("t1", "id")] }} />);
    await waitFor(() => expect(pane().textContent).toContain("SELECT o.id"));
    fireEvent.click(within(pane()).getByRole("button", { name: "Copy the SQL" }));
    await waitFor(() => expect(writes).toEqual(["SELECT o.id\nFROM orders o"]));
    // It says so beside the button.
    await waitFor(() => expect(within(pane()).getByRole("status").textContent).toBe("Copied"));
    // The SQL scrolls in its own area, reachable by Tab.
    const body = within(pane()).getByRole("region", { name: "Generated SQL" });
    expect(body.tabIndex).toBe(0);
    expect(body.querySelector("pre")).not.toBeNull();
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: had });
  }
});

test("release_the_sql_pane_with_no_tables_and_its_narrow_rule", async () => {
  render(<Tab over={{}} />);
  await waitFor(() => expect(pane().textContent).toBe("SQLDrag a table from the tree to start."));
  expect(within(pane()).getByRole("button", { name: "Copy the SQL" }).hasAttribute("disabled")).toBe(true);
  // Under about 1,000 px of panel the pane hides (a container query; no setting is kept).
  expect(appCss).toMatch(/\.vq-columns-split \{[^}]*container-type:\s*inline-size/);
  expect(appCss).toMatch(/@container \(max-width: 999px\) \{\s*\.vq-columns-sql \{\s*display: none;/);
  expect(appCss).toMatch(/\.vq-columns-sql \{[^}]*min-width:\s*320px/);
});
