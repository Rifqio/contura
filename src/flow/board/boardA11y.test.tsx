// Task 16: the accessibility pass over every board control: names, Tab or arrow reach, focus rings, copy rules, the
// word "Frame", reduced motion, and keys typed inside a dialog.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import ts from "typescript";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS } from "../../api/types";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import { GROQ } from "../../test/settingsRoutes";
import appCss from "../../styles/app.css?raw";
import boardCss from "../../styles/flow-board.css?raw";
import FlowTab from "../FlowTab";
import flowTabSource from "../FlowTab.tsx?raw";
import { sketchNodeId } from "./sketches";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      return real.default({
        ...p,
        onInit: (i) => {
          canvas.instance = i;
          p.onInit?.(i);
        },
      });
    },
  };
});

const reduced = { on: true };
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});
beforeEach(() => {
  localStorage.clear();
  reduced.on = true;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced.on && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  canvas.props = null;
  canvas.instance = null;
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const LOGIN = 'diagram sequence "Login"\nApp -> Api\n';
const BOARD = [CHECKOUT, REFUND, LOGIN].join("\n");
const SECTION = { id: "s1", kind: "section", x: 50, y: 850, w: 300, h: 200, text: "Plan" };
const RECT = { id: "s2", kind: "rect", x: 400, y: 850, w: 100, h: 60 };
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Refund: { at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Login: { at: { x: 1200, y: 0 }, nodes: {}, style: "modern", direction: "TB" },
  },
  sketches: [SECTION, RECT],
});

function setup() {
  const saved = { text: BOARD, layout: LAYOUT as string | null };
  routeInvoke({
    read_diagram: () => saved,
    write_diagram: (a) => {
      saved.text = a.text as string;
      saved.layout = a.layout as string;
      return null;
    },
    write_diagram_layout: (a) => {
      saved.layout = a.layout as string;
      return null;
    },
    ui_prefs: () => DEFAULT_UI_PREFS,
    save_ui_prefs: () => null,
    list_ai_threads: () => [],
    get_ai_thread: () => null,
    ai_settings: () => ({ settings: { ...GROQ, diagramTool: true }, groupOverride: false, keySaved: true, keyLast4: "abcd" }),
  });
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const pane = () => utils.container.querySelector('section[aria-label="Side panel"]') as HTMLElement;
  return { ...utils, saved, canvasEl, pane };
}
type Setup = ReturnType<typeof setup>;

async function opened(_s?: Setup) {
  for (const t of ["Checkout", "Refund"]) await screen.findByRole("button", { name: `Flowchart ${t}` });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  fireEvent.click(await screen.findByRole("button", { name: "Flowchart Checkout" }));
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === "Cart")).toBe(true));
  await screen.findByRole("toolbar", { name: "Checkout settings" });
}

/** A tab opened for the first time opens with its pane open (owner answer 6). */
async function openPane(s: Setup) {
  await waitFor(() => expect(s.pane().hidden).toBe(false));
  await waitFor(() => expect(within(s.pane()).getByRole("button", { name: "Syntax help" })).toBeTruthy());
}

/** The accessible name a control carries: its label, the text it labels itself with, or its title. */
function nameOf(el: HTMLElement): string {
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  return (el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("title") ?? "").trim();
}

const CONTROLS = "button, input, textarea, select, [role=menuitem], [role=tab], [role=combobox], [role=option]";

/** Every control inside `root`, each named; returns them for the reach checks. */
function controlsOf(root: HTMLElement, where: string): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(CONTROLS)];
  expect(all.length, where).toBeGreaterThan(0);
  for (const el of all) expect(nameOf(el), `${where}: ${el.outerHTML.slice(0, 80)}`).not.toBe("");
  return all;
}

/** Tab reaches a control when its tab index is 0, or it sits in a roving group (toolbar, menu, tab list, listbox) that has one stop. */
function reachable(all: HTMLElement[], where: string) {
  for (const el of all) {
    if (el.tabIndex >= 0) continue;
    const group = el.closest<HTMLElement>("[role=toolbar], [role=menu], [role=tablist], [role=listbox]");
    expect(group, `${where}: ${nameOf(el)} is out of the tab order`).not.toBeNull();
    if (group!.getAttribute("role") === "toolbar") {
      expect(
        [...group!.querySelectorAll<HTMLElement>("button, input")].some((b) => b.tabIndex === 0),
        `${where}: the toolbar has a tab stop`,
      ).toBe(true);
    }
  }
}

test("every_new_control_is_named_and_reachable", async () => {
  const s = setup();
  await opened(s);

  // The toolbar: named, one tab stop, the arrows move between its buttons.
  const bar = screen.getByRole("toolbar", { name: "Board tools" });
  const tools = controlsOf(bar, "toolbar");
  reachable(tools, "toolbar");
  expect(tools.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  const stop = tools.find((b) => b.tabIndex === 0)!;
  stop.focus();
  fireEvent.keyDown(stop, { key: "ArrowRight" });
  expect(document.activeElement).toBe(tools[(tools.indexOf(stop) + 1) % tools.length]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(stop);

  // The tab strips: every frame's tab buttons.
  const strips = [...s.container.querySelectorAll<HTMLElement>(".board-frame-tab")];
  expect(strips.length).toBe(3);
  for (const strip of strips) reachable(controlsOf(strip, "frame tab"), "frame tab");

  // The frame bar and its More menu.
  const frameBar = screen.getByRole("toolbar", { name: "Checkout settings" });
  reachable(controlsOf(frameBar, "frame bar"), "frame bar");
  fireEvent.click(within(frameBar).getByRole("button", { name: "More" }));
  const more = await screen.findByRole("menu");
  reachable(controlsOf(more, "frame more menu"), "frame more menu");
  fireEvent.keyDown(more, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  // The Shelf behind Add (B2 R25).
  fireEvent.click(within(bar).getByRole("button", { name: "Add" }));
  const shelf = await screen.findByRole("dialog", { name: "Add to the board" });
  reachable(controlsOf(shelf, "shelf"), "shelf");
  fireEvent.keyDown(within(shelf).getByRole("combobox"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add to the board" })).toBeNull());

  // The sketch bar.
  act(() => canvas.props!.onSelect!([sketchNodeId("s2")]));
  const sketchBar = await screen.findByRole("toolbar", { name: "Sketch settings" });
  reachable(controlsOf(sketchBar, "sketch bar"), "sketch bar");

  // The pane head.
  await openPane(s);
  expect(within(s.pane()).getByRole("heading", { name: "Flowchart" })).toBeTruthy();
  reachable(controlsOf(s.pane().querySelector<HTMLElement>(".code-pane-chips")!, "pane head"), "pane head");
  reachable(controlsOf(s.pane().querySelector<HTMLElement>(".flow-side-head")!, "pane tabs"), "pane tabs");

  // The Syntax Help modal: every control named and in the tab order (the dialog traps Tab itself).
  fireEvent.click(within(s.pane()).getByRole("button", { name: "Syntax help" }));
  const dialog = await screen.findByRole("dialog", { name: /syntax$/ });
  reachable(controlsOf(dialog, "syntax help"), "syntax help");
  expect(dialog.getAttribute("aria-modal")).toBe("true");

  // Focus rings: the global rule draws one, no board control class turns it off, and the board's own rules keep theirs.
  expect(appCss).toMatch(/:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--c-focus\)/);
  for (const cls of ["board-frame-title", "board-frame-pane", "board-frame-problems"]) {
    expect(boardCss, cls).toMatch(new RegExp(`\\.${cls}:focus-visible[^{]*\\{[^}]*outline:\\s*2px solid var\\(--c-focus\\)`));
  }
  expect(boardCss).toMatch(/\.frame-bar \.flow-tool:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--c-focus\)/);
  // Contrast (checked with a WCAG script, both themes): a tab's edge is 3:1 on the canvas only in the strong border token.
  expect(boardCss).toMatch(/\.board-frame-title,\s*\.board-frame-pane\s*\{[^}]*border:[^;]*var\(--c-border-strong\)/);
  // The one rule with `outline: none` (the name field) swaps in an accent border for the ring.
  const quiet = boardCss.split("}").filter((r) => /outline:\s*none/.test(r));
  expect(quiet.length).toBe(1);
  expect(quiet[0]).toMatch(/\.frame-bar-name:focus-visible[\s\S]*border-color:\s*var\(--c-accent\)/);
  for (const cls of ["board-tool", "board-add", "board-ask", "code-pane-chip", "syntax-help-copy"]) {
    const rules = boardCss.split("}").filter((r) => new RegExp(`\\.${cls}\\b[^{]*\\{`).test(r));
    for (const r of rules) expect(r, cls).not.toMatch(/outline:\s*(none|0)\b/);
  }
});

// The board's source files, not the tests: everything under src/flow/board.
const sources = {
  ...(import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>),
  "../FlowTab.tsx": flowTabSource,
};

/** Every string a source file can show: string and template literals (aria-label and title props included) and JSX text, read with the TypeScript parser. */
function copyOf(src: string, name = "x.tsx"): string[] {
  const found: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) found.push(n.text);
    ts.forEachChild(n, walk);
  };
  walk(ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return found;
}

/** Every control name, title and visible text under `root`. */
function copyIn(root: ParentNode): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    for (const a of ["aria-label", "title", "placeholder"]) {
      const v = el.getAttribute(a);
      if (v) out.push(v);
    }
    if (el.children.length === 0 && el.textContent) out.push(el.textContent);
  }
  return out;
}

test("no_dash_or_banned_word_in_board_copy", async () => {
  expect(Object.keys(sources).length).toBeGreaterThan(15);
  for (const [file, src] of Object.entries(sources)) {
    const text = copyOf(src, file).join("\n");
    expect(text, file).not.toMatch(/[–—]/);
    // The project's banned words (the Assistant's and Syntax Help's copy tests): cursor and caret.
    expect(text, file).not.toMatch(/\bcursor\b|\bcaret\b/i);
  }
  const s = setup();
  await opened(s);
  await openPane(s);
  const seen = [...copyIn(s.container)];
  fireEvent.click(within(s.pane()).getByRole("button", { name: "Syntax help" }));
  seen.push(...copyIn(await screen.findByRole("dialog", { name: /syntax$/ })));
  const joined = seen.join("\n");
  expect(joined).not.toMatch(/[–—]/);
  expect(joined).not.toMatch(/\bcursor\b|\bcaret\b/i);
});

test("frame_means_a_diagram_in_copy", async () => {
  for (const [file, src] of Object.entries(sources)) {
    for (const text of copyOf(src, file)) expect(text, file).not.toMatch(/section[^\n]*\bframe\b|\bframe\b[^\n]*section/i);
  }
  const s = setup();
  await opened(s);
  act(() => canvas.props!.onSelect!([sketchNodeId("s1")]));
  await screen.findByRole("toolbar", { name: "Sketch settings" });
  // Section's own names: its tool, its drawn shape.
  const sectionNames = [...document.querySelectorAll<HTMLElement>("[aria-label]")].map((e) => e.getAttribute("aria-label")!).filter((n) => /section/i.test(n));
  expect(sectionNames.length).toBeGreaterThan(1);
  for (const n of sectionNames) expect(n).not.toMatch(/frame/i);
});

test("reduced_motion_zeroes_every_board_glide", async () => {
  const s = setup();
  await opened(s);
  const fit = vi.spyOn(canvas.instance!, "fitBounds").mockResolvedValue(true);
  const centre = vi.spyOn(canvas.instance!, "setCenter").mockResolvedValue(true);

  // Zoom to frame: Shift+2 with nothing selected.
  act(() => canvas.props!.onSelect!([]));
  fireEvent.keyDown(s.canvasEl(), { key: "@", code: "Digit2", shiftKey: true });
  await waitFor(() => expect(fit).toHaveBeenCalled());
  // The pane's glide: a tab's Code Editor button selects that frame, opens the pane on it and zooms to it.
  fit.mockClear();
  await openPane(s);
  fireEvent.click(within(s.pane()).getByRole("button", { name: "Hide the side panel" }));
  await waitFor(() => expect(s.pane().hidden).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: "Flowchart Refund" }));
  fireEvent.click((await screen.findAllByRole("button", { name: /^Code Editor/ }))[0]);
  await waitFor(() => expect(fit).toHaveBeenCalled());
  // Add's glide: a new frame comes into view.
  fireEvent.click(within(screen.getByRole("toolbar", { name: "Board tools" })).getByRole("button", { name: "Add" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Add to the board" })).getByRole("option", { name: /^Flowchart/ }));
  await waitFor(() => expect(centre).toHaveBeenCalled());
  for (const c of fit.mock.calls) expect(c[1]?.duration).toBe(0);
  for (const c of centre.mock.calls) expect(c[2]?.duration).toBe(0);
  // The keyboard menu's Zoom to fit (the canvas's Shift+1 fit) jumps too: the view is there at once.
  act(() => canvas.props!.onSelect!([]));
  const away = { x: -5000, y: -3000, zoom: 1 };
  act(() => void canvas.instance!.setViewport(away));
  fireEvent.keyDown(s.canvasEl(), { key: "F10", shiftKey: true });
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Zoom to fit/ }));
  expect(canvas.instance!.getViewport()).not.toEqual(away);

  // The same zoom with motion on takes the table's 240 ms: the zeros above come from the preference.
  reduced.on = false;
  fit.mockClear();
  act(() => canvas.props!.onSelect!([]));
  fireEvent.keyDown(s.canvasEl(), { key: "@", code: "Digit2", shiftKey: true });
  await waitFor(() => expect(fit).toHaveBeenCalled());
  expect(fit.mock.calls[0][1]?.duration).toBe(240);
});

test("keys_typed_in_a_dialog_never_act_on_the_board", async () => {
  const s = setup();
  await opened(s);
  await openPane(s);
  act(() => canvas.props!.onSelect!(["Cart"]));
  const textBefore = s.saved.text;
  const bar = screen.getByRole("toolbar", { name: "Board tools" });
  const pressed = () =>
    within(bar)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.getAttribute("aria-label"));
  const pressedBefore = pressed();

  fireEvent.click(within(s.pane()).getByRole("button", { name: "Syntax help" }));
  const dialog = await screen.findByRole("dialog", { name: /syntax$/ });
  const copy = within(dialog).getAllByRole("button")[0];
  copy.focus();
  const keys: KeyboardEventInit[] = [{ key: "r" }, { key: "f" }, { key: "n" }, { key: "h" }, { key: " " }, { key: "Delete" }, { key: "Backspace" }, { key: "Enter", ctrlKey: true }, { key: "j", ctrlKey: true }, { key: "b", ctrlKey: true }];
  // Not cancelled by anything on the board's path: a bubble listener on the document runs after React's handlers and
  // the board's own listeners, and before the app keymap's window listener, which keeps every app command's key (Ctrl+B
  // is grid.followKey) from the browser (PR41) and holds it while a dialog is open.
  const seen: boolean[] = [];
  const probe = (e: KeyboardEvent) => seen.push(e.defaultPrevented);
  document.addEventListener("keydown", probe);
  try {
    for (const k of keys) {
      seen.length = 0;
      fireEvent.keyDown(copy, k);
      // The dialog's own buttons keep Space and Enter.
      expect(seen, JSON.stringify(k)).toEqual([false]);
      fireEvent.keyUp(copy, k);
    }
  } finally {
    document.removeEventListener("keydown", probe);
  }
  expect(s.canvasEl().classList.contains("is-space-held")).toBe(false);
  expect(screen.queryByRole("dialog", { name: "Add here" })).toBeNull();
  expect(pressed()).toEqual(pressedBefore);
  expect(s.saved.text).toBe(textBefore);
  expect(s.pane().hidden).toBe(false);
  expect(screen.getByRole("dialog", { name: /syntax$/ })).toBeTruthy();

  // Esc still closes it.
  fireEvent.keyDown(copy, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: /syntax$/ })).toBeNull());
});

test("root_shortcuts_still_act_from_the_canvas_and_a_non_modal_menu", async () => {
  const s = setup();
  await opened(s);
  await openPane(s);
  // Ctrl+J opens the Assistant on the frame: the canvas, then from the Shelf's search (not modal).
  const assistant = () => screen.getByRole("tab", { name: /^Assistant/ }).getAttribute("aria-selected");
  expect(assistant()).toBe("false");
  expect(fireEvent.keyDown(s.canvasEl(), { key: "j", ctrlKey: true })).toBe(false);
  await waitFor(() => expect(assistant()).toBe("true"));
  fireEvent.click(screen.getAllByRole("tab", { name: /^Editor/ })[0]);
  await waitFor(() => expect(assistant()).toBe("false"));
  fireEvent.click(within(screen.getByRole("toolbar", { name: "Board tools" })).getByRole("button", { name: "Add" }));
  const menu = within(await screen.findByRole("dialog", { name: "Add to the board" })).getByRole("combobox");
  expect(fireEvent.keyDown(menu, { key: "j", ctrlKey: true })).toBe(false);
  await waitFor(() => expect(assistant()).toBe("true"));
  // Ctrl+Shift+E is taken (prevented) from both places too.
  expect(fireEvent.keyDown(s.canvasEl(), { key: "E", ctrlKey: true, shiftKey: true })).toBe(false);
  expect(fireEvent.keyDown(menu, { key: "E", ctrlKey: true, shiftKey: true })).toBe(false);
});
