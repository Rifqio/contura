import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { AiAccess, ConnectionConfig } from "../api/types";
import EditorHeader from "./EditorHeader";

const conn: ConnectionConfig = {
  id: "c1",
  name: "freight-prod",
  dialect: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: "freight",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};
const other: ConnectionConfig = { ...conn, id: "c2", name: "kestrel-main", database: "kestrel" };

function setup(over: Partial<Parameters<typeof EditorHeader>[0]> = {}) {
  const props = {
    connection: conn,
    connections: [conn, other],
    openIds: new Set(["c1"]),
    databases: ["freight", "archive"],
    database: "freight",
    production: false,
    running: false,
    writeHazard: false,
    canRun: true,
    blockedTip: null,
    compact: false,
    aiAccess: "schema" as AiAccess,
    historyOpen: false,
    onPickConnection: vi.fn(),
    onPickDatabase: vi.fn(),
    onRun: vi.fn(),
    onRunAll: vi.fn(),
    onExplain: vi.fn(),
    onFormat: vi.fn(),
    onSave: vi.fn(),
    onToggleHistory: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  return { ...props, ...render(<EditorHeader {...props} />) };
}

test("strip_order_matches_frame_b", () => {
  setup({ production: true, connection: { ...conn, production: true } });
  const strip = screen.getByRole("toolbar", { name: "Query" });
  const names = Array.from(strip.querySelectorAll("button, .chip, .production-label, .editor-header-divider")).map((el) =>
    el.classList.contains("production-label") ? "PRODUCTION" : el.classList.contains("editor-header-divider") ? "|" : (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
  expect(names).toEqual(["freight-prod", "PRODUCTION", "freight", "|", "Run Ctrl+Enter", "Run all", "Explain", "Format", "AI: Schema only", "Save query (Ctrl+S)", "Query History"]);
  expect(strip.querySelector(".spacer")).toBeTruthy();
});

test("production_shows_the_production_label", () => {
  setup({ production: true, connection: { ...conn, production: true } });
  expect(screen.getByText("PRODUCTION")).toBeTruthy();
});

test("a_normal_connection_has_no_production_label", () => {
  setup();
  expect(screen.queryByText("PRODUCTION")).toBeNull();
});

test("connection_button_opens_a_menu_of_the_place_connections", async () => {
  const { onPickConnection } = setup();
  await userEvent.click(screen.getByRole("button", { name: /freight-prod/ }));
  const menu = screen.getByRole("menu", { name: "Connection" });
  expect(menu).toBeTruthy();
  const closed = screen.getByRole("menuitem", { name: "kestrel-main" });
  expect(closed.textContent).toContain("closed");
  expect(screen.getByRole("menuitem", { name: "freight-prod" }).textContent).not.toContain("closed");
  await userEvent.click(closed);
  expect(onPickConnection).toHaveBeenCalledWith("c2");
});

test("database_button_lists_databases", async () => {
  const { onPickDatabase } = setup();
  await userEvent.click(screen.getByRole("button", { name: /^freight$/ }));
  expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["freight", "archive"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "archive" }));
  expect(onPickDatabase).toHaveBeenCalledWith("archive");
});

test("no_database_button_without_a_database_list", () => {
  setup({ databases: null });
  expect(screen.queryByRole("button", { name: /^freight$/ })).toBeNull();
});

test("compact_turns_run_all_explain_and_format_into_icon_buttons", () => {
  setup({ compact: true });
  for (const name of ["Run all (Ctrl+Shift+Enter)", "Explain", "Format (Shift+Alt+F)"]) {
    const b = screen.getByRole("button", { name });
    expect(b.getAttribute("title")).toBe(name);
    expect(b.textContent).toBe("");
    expect(b.querySelector("svg")).toBeTruthy();
  }
});

/** E2: at 1280 px with Run on PROD and a long database name, labels that would overflow turn into icons so Save and History stay in reach. */
test("labels_turn_into_icons_when_they_would_overflow_and_come_back_when_there_is_room", () => {
  let width = 900;
  const sizes = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("editor-header") ? width : 0;
  });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains("editor-header")) return 0;
    // The labelled strip needs 980 px; the icon strip 760.
    return this.querySelector("button[aria-label^='Explain']") ? 760 : 980;
  });
  let resize: () => void = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  try {
    setup({ production: true, writeHazard: true, database: "dbview_test_023794c6" });
    expect(screen.getByRole("button", { name: "Explain" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Save query (Ctrl+S)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Query History" })).toBeTruthy();
    width = 1000;
    act(() => resize());
    expect(screen.getByRole("button", { name: "Explain" }).textContent).toBe("Explain");
  } finally {
    sizes.mockRestore();
    scroll.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("the_database_name_shows_in_full_as_its_tooltip", () => {
  setup({ database: "dbview_test_023794c6", databases: ["dbview_test_023794c6"] });
  expect(screen.getByRole("button", { name: /dbview_test_023794c6/ }).getAttribute("title")).toBe("dbview_test_023794c6");
});

test("wide_keeps_the_labels", () => {
  setup();
  for (const t of ["Run all", "Explain", "Format"]) expect(screen.getByRole("button", { name: t }).textContent).toBe(t);
});

test("ai_chip_names_the_access_level", () => {
  const cases: [AiAccess, string, string][] = [
    ["never", "AI: Nothing", "chip-neutral"],
    ["schema", "AI: Schema only", "chip-info"],
    ["schemaQuery", "AI: Schema and query text", "chip-info"],
    ["schemaQueryRows", "AI: Plus sample rows", "chip-warning"],
  ];
  for (const [access, text, cls] of cases) {
    const { unmount } = setup({ aiAccess: access });
    const chip = screen.getByText(text).closest(".chip") as HTMLElement;
    expect(chip.className).toContain(cls);
    unmount();
  }
});

test("run_on_prod_is_the_outline_with_a_boxed_hint", () => {
  setup({ production: true, writeHazard: true, connection: { ...conn, production: true } });
  const run = screen.getByRole("button", { name: "Run on Production (Ctrl+Enter)" });
  expect(run.className).toContain("button-prod");
  expect(run.textContent).toContain("Run on PROD");
  expect(run.querySelector("kbd.kbd")?.textContent).toBe("Ctrl+Enter");
});

test("run_is_the_primary_24px_button_and_cancel_replaces_it_while_running", async () => {
  const { onRun, rerender, ...rest } = setup();
  const run = screen.getByRole("button", { name: /^Run Ctrl\+Enter/ });
  expect(run.className).toContain("button-primary");
  await userEvent.click(run);
  expect(onRun).toHaveBeenCalled();
  rerender(<EditorHeader {...(rest as unknown as Parameters<typeof EditorHeader>[0])} running />);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Run/ })).toBeNull();
});

test("a_blocked_run_is_disabled_and_says_why", () => {
  setup({ blockedTip: "This Connection is Read-only" });
  const run = screen.getByRole("button", { name: /^Run Ctrl\+Enter/ }) as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  expect(run.title).toBe("This Connection is Read-only");
});

test("pickers_lock_while_running", () => {
  setup({ running: true });
  expect((screen.getByRole("button", { name: /freight-prod/ }) as HTMLButtonElement).disabled).toBe(true);
});

test("the_ai_chip_toggles_the_assistant_when_wired", async () => {
  const onToggleAssistant = vi.fn();
  setup({ onToggleAssistant, assistantOpen: true });
  const chip = screen.getByRole("button", { name: "AI: Schema only" });
  expect(chip.getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(chip);
  expect(onToggleAssistant).toHaveBeenCalled();
});

/** NF4, frames i and 8: a Read-only Connection shows a lock and Read-only chip after its name. */
test("read_only_connection_shows_the_read_only_chip", () => {
  setup({ connection: { ...conn, readOnly: true } });
  const chip = screen.getByRole("toolbar", { name: "Query" }).querySelector(".editor-header-readonly") as HTMLElement;
  expect(chip.textContent).toBe("Read-only");
  expect(chip.className).toContain("chip");
  expect(chip.querySelector("svg")).toBeTruthy();
  expect(chip.previousElementSibling?.className).toBe("menu-root");
});

test("ordinary_connection_has_no_read_only_chip", () => {
  setup();
  expect(document.querySelector(".editor-header-readonly")).toBeNull();
});

test("diagram_button_sits_after_format_with_its_key_and_is_pressed_while_open", async () => {
  const onToggleDiagram = vi.fn();
  const { rerender, container: _c, baseElement: _b, ...rest } = setup({ onToggleDiagram, diagramOpen: false });
  const strip = screen.getByRole("toolbar", { name: "Query" });
  const names = Array.from(strip.querySelectorAll("button")).map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim());
  expect(names.indexOf("Diagram Ctrl+Shift+D")).toBe(names.indexOf("Format") + 1);
  const diagram = screen.getByRole("button", { name: /^Diagram/ });
  expect(diagram.getAttribute("aria-pressed")).toBe("false");
  expect(diagram.querySelector(".kbd, kbd")).toBeTruthy();
  await userEvent.click(diagram);
  expect(onToggleDiagram).toHaveBeenCalledTimes(1);
  const props: Parameters<typeof EditorHeader>[0] = {
    connection: rest.connection,
    connections: rest.connections,
    openIds: rest.openIds,
    databases: rest.databases,
    database: rest.database,
    production: rest.production,
    running: rest.running,
    writeHazard: rest.writeHazard,
    canRun: rest.canRun,
    blockedTip: rest.blockedTip,
    compact: rest.compact,
    aiAccess: rest.aiAccess,
    historyOpen: rest.historyOpen,
    onPickConnection: rest.onPickConnection,
    onPickDatabase: rest.onPickDatabase,
    onRun: rest.onRun,
    onRunAll: rest.onRunAll,
    onExplain: rest.onExplain,
    onFormat: rest.onFormat,
    onSave: rest.onSave,
    onToggleHistory: rest.onToggleHistory,
    onCancel: rest.onCancel,
  };
  rerender(<EditorHeader {...props} onToggleDiagram={onToggleDiagram} diagramOpen />);
  expect(screen.getByRole("button", { name: /^Diagram/ }).getAttribute("aria-pressed")).toBe("true");
});

test("no_diagram_button_without_a_handler", () => {
  setup();
  expect(screen.queryByRole("button", { name: /^Diagram/ })).toBeNull();
});

/** P11-14: with the Ask panel open beside a PROD tab even the icon strip is too wide; the right end moves into More. */
test("parity_P11_14_a_strip_still_too_wide_moves_its_right_end_into_more", async () => {
  let width = 700;
  const sizes = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("editor-header") ? width : 0;
  });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains("editor-header")) return 0;
    // Labelled 980 px, icons 760 px, icons with the right end in More 640 px.
    if (this.querySelector("button[aria-label='More actions']")) return 640;
    return this.querySelector("button[aria-label^='Explain']") ? 760 : 980;
  });
  let resize: () => void = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  const user = userEvent.setup();
  try {
    const p = setup({ production: true, writeHazard: true, compact: true, onToggleAssistant: vi.fn(), aiAccess: "schemaQuery" });
    const strip = screen.getByRole("toolbar", { name: "Query" });
    expect(within(strip).queryByRole("button", { name: "Save query (Ctrl+S)" })).toBeNull();
    expect(within(strip).queryByRole("button", { name: "Query History" })).toBeNull();
    expect(within(strip).queryByRole("button", { name: /AI: Schema and query text/ })).toBeNull();
    await user.click(within(strip).getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(Array.from(menu.querySelectorAll<HTMLElement>("[role^=menuitem]")).map((i) => i.querySelector(".menu-label")?.textContent)).toEqual([
      "Assistant",
      "Save query",
      "Query History",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: /Save query/ }));
    expect(p.onSave).toHaveBeenCalledTimes(1);
    // Room again: the buttons come back into the strip.
    width = 800;
    act(() => resize());
    expect(within(strip).getByRole("button", { name: "Save query (Ctrl+S)" })).toBeTruthy();
    expect(within(strip).queryByRole("button", { name: "More actions" })).toBeNull();
  } finally {
    sizes.mockRestore();
    scroll.mockRestore();
    vi.unstubAllGlobals();
  }
});

/** Mocks a 700 px strip whose width needs follow its content; returns the restore and the resize trigger. */
function crowdedStrip(need: (el: HTMLElement) => number) {
  const sizes = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("editor-header") ? 700 : 0;
  });
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("editor-header") ? need(this) : 0;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  return () => {
    sizes.mockRestore();
    scroll.mockRestore();
    vi.unstubAllGlobals();
  };
}

test("more_goes_away_when_the_content_narrows_without_a_resize", () => {
  // Icons with PRODUCTION and Run on PROD need 760 px; without them 660 px; More always fits.
  const restore = crowdedStrip((el) => {
    if (el.querySelector("button[aria-label='More actions']")) return 600;
    if (!el.querySelector("button[aria-label^='Explain']")) return 980;
    return el.querySelector(".production-label") ? 760 : 660;
  });
  try {
    const prod = { ...conn, production: true };
    const p = setup({ connection: prod, production: true, writeHazard: true, compact: true });
    const strip = screen.getByRole("toolbar", { name: "Query" });
    expect(within(strip).getByRole("button", { name: "More actions" })).toBeTruthy();
    // The tab moves to a dev Connection: the strip fits at the same width, so the right end comes back.
    p.rerender(<EditorHeader {...p} connection={other} production={false} writeHazard={false} compact />);
    expect(within(strip).queryByRole("button", { name: "More actions" })).toBeNull();
    expect(within(strip).getByRole("button", { name: "Save query (Ctrl+S)" })).toBeTruthy();
    // And back to PROD: it is crowded again.
    p.rerender(<EditorHeader {...p} connection={prod} production writeHazard compact />);
    expect(within(strip).getByRole("button", { name: "More actions" })).toBeTruthy();
  } finally {
    restore();
  }
});

test("more_rows_keep_the_pressed_state_and_the_ai_row_opens_the_assistant", async () => {
  const restore = crowdedStrip((el) => (el.querySelector("button[aria-label='More actions']") ? 600 : 760));
  const user = userEvent.setup();
  try {
    setup({ compact: true, onToggleDiagram: vi.fn(), diagramOpen: true, onToggleAssistant: vi.fn(), assistantOpen: true, historyOpen: true });
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu", { name: "More actions" });
    const rows = Array.from(menu.querySelectorAll<HTMLElement>("[role^=menuitem]"));
    expect(rows.map((r) => [r.querySelector(".menu-label")?.textContent, r.getAttribute("aria-checked")])).toEqual([
      ["Diagram", "true"],
      ["Assistant", "true"],
      ["Save query", null],
      ["Query History", "true"],
    ]);
    // The AI row names the access level and says it opens the assistant.
    expect(rows[1].textContent).toContain("AI: Schema only");
    expect(rows[1].getAttribute("title")).toMatch(/^AI access for freight-prod\. Open the assistant/);
  } finally {
    restore();
  }
});
