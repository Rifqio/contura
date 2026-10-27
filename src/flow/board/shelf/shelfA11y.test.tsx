// Task 13: the accessibility, motion and growth pass over the Shelf, the Space box, the New diagram dialog and the
// database dialog: names, reach, focus rings, copy rules, reduced motion, what 100 opens leave behind, stray
// overlays after a resize and a tab change, and the Shelf's layout (chips that wrap, zoom controls left clear).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import ts from "typescript";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, IconEntry } from "../../../api/types";
import { ToastProvider } from "../../../components/Toast";
import type { DiagramCanvasProps } from "../../../diagram/DiagramCanvas";
import { motionMs } from "../../../diagram/motion";
import { LangClient } from "../../../lang/client";
import appCss from "../../../styles/app.css?raw";
import shelfCss from "../../../styles/flow-shelf.css?raw";
import { mockEditorDom } from "../../../test/editor";
import { routeInvoke } from "../../../test/invoke";
import { fakeWorker } from "../../../test/langWorker";
import { mockReactFlowDom } from "../../../test/reactFlow";
import FlowTab from "../../FlowTab";
import flowTabSource from "../../FlowTab.tsx?raw";
import NewDiagramDialog from "../../NewDiagramDialog";
import newDiagramSource from "../../NewDiagramDialog.tsx?raw";
import FromDatabaseDialog from "../catalog/FromDatabaseDialog";
import { previewCacheSize } from "../catalog/preview";
import { SHELF_GROUP_ICONS, SHELF_ICON_LIMIT } from "./iconSource";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null }));
vi.mock("../../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../../diagram/DiagramCanvas")>();
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

/** 300 icons, all matching "icon", so the Icons tab and the grouped search both reach their caps. */
const ICONS: IconEntry[] = Array.from({ length: 300 }, (_, i) => ({ name: `icon-${i}`, set: "tabler", title: `Icon ${i}`, licence: null, aliasOf: null }));

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const LOGIN = 'diagram sequence "Login"\nApp -> Api\n';
const BOARD = [CHECKOUT, LOGIN].join("\n");
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Login: { at: { x: 700, y: 0 }, nodes: {}, style: "modern", direction: "TB" },
  },
  sketches: [],
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
    icon_index: () => ICONS,
    icon: () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  const client = new LangClient(() => fakeWorker());
  const view = (active = true) => (
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} active={active} />
    </div>
  );
  const utils = render(view());
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const bar = () => screen.getByRole("toolbar", { name: "Board tools" });
  const shelf = () => screen.queryByRole("dialog", { name: "Add to the board" });
  const sized = () =>
    vi.spyOn(canvasEl(), "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} } as DOMRect);
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  /** A Space tap over the canvas opens the Space box there. */
  const openBox = async () => {
    fireEvent.pointerMove(canvasEl(), { clientX: 420, clientY: 330 });
    fireEvent.keyDown(canvasEl(), { key: " " });
    now += 100;
    fireEvent.keyUp(canvasEl(), { key: " " });
    const b = await screen.findByRole("dialog", { name: "Add here" });
    await waitFor(() => expect(document.activeElement).toBe(within(b).getByRole("combobox")));
    return b;
  };
  const openShelf = async () => {
    fireEvent.click(within(bar()).getByRole("button", { name: "Add" }));
    const p = await screen.findByRole("dialog", { name: "Add to the board" });
    await waitFor(() => expect(p.contains(document.activeElement)).toBe(true));
    return p;
  };
  return { ...utils, view, saved, canvasEl, bar, shelf, sized, openBox, openShelf };
}

async function opened() {
  for (const n of ["Flowchart Checkout", "Sequence Login"]) await screen.findByRole("button", { name: n });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

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

const CONTROLS = "button, input, textarea, select, [role=menuitem], [role=tab], [role=combobox], [role=option], [role=listbox], [role=tabpanel], [role=dialog]";

function controlsOf(root: HTMLElement, where: string): HTMLElement[] {
  const all = [root, ...root.querySelectorAll<HTMLElement>(CONTROLS)].filter((el) => el.matches(CONTROLS));
  expect(all.length, where).toBeGreaterThan(1);
  for (const el of all) expect(nameOf(el), `${where}: ${el.outerHTML.slice(0, 100)}`).not.toBe("");
  return all;
}

/** Tab reaches a control when its tab index is 0, or it sits in a roving group (toolbar, menu, tab list, listbox) that has one stop. */
function reachable(all: HTMLElement[], where: string) {
  for (const el of all) {
    if (el.matches("[role=listbox], [role=tabpanel], [role=dialog]")) continue;
    if (el.tabIndex >= 0) continue;
    const group = el.closest<HTMLElement>("[role=toolbar], [role=menu], [role=tablist], [role=listbox], [role=radiogroup]");
    expect(group, `${where}: ${nameOf(el)} is out of the tab order`).not.toBeNull();
  }
}

/** Every option sits in a listbox, and the combobox's active descendant is a mounted option of a listbox it controls. */
function comboboxOwnsItsOptions(root: HTMLElement, where: string) {
  for (const o of root.querySelectorAll<HTMLElement>("[role=option]")) expect(o.closest("[role=listbox]"), `${where}: ${nameOf(o)}`).not.toBeNull();
  const box = within(root).getByRole("combobox");
  const id = box.getAttribute("aria-activedescendant");
  expect(id, `${where}: an active option`).toBeTruthy();
  const active = document.getElementById(id!);
  expect(active?.getAttribute("role"), where).toBe("option");
  const controls = box.getAttribute("aria-controls");
  expect(controls, where).toBeTruthy();
  expect(active!.closest("[role=listbox]")!.id, where).toBe(controls);
}

const kfc: ConnectionConfig = {
  id: "c1", name: "kfc", dialect: "mysql", host: "127.0.0.1", port: 3306, user: "u", database: null, ssl: { mode: "disable" },
  groupId: null, file: null, queryTimeoutSecs: null, aiAccess: "schema", production: false, readOnly: false,
};

test("every_shelf_control_is_named_and_reachable", async () => {
  const s = setup();
  await opened();
  s.sized();

  // The Shelf: the dialog, the search, the tabs named with their counts, the listboxes and their options.
  const p = await s.openShelf();
  await waitFor(() => expect(within(p).getByRole("tab", { name: /^Icons, / })).toBeTruthy());
  const all = controlsOf(p, "shelf");
  reachable(all, "shelf");
  for (const tab of within(p).getAllByRole("tab")) expect(nameOf(tab), "tab with its count").toMatch(/^(Diagrams|Icons|Shapes), [\d,]+$/);
  expect(within(p).getByRole("tab", { name: "Icons, 300" })).toBeTruthy();
  for (const lb of within(p).getAllByRole("listbox")) expect(nameOf(lb)).not.toBe("");
  comboboxOwnsItsOptions(p, "shelf");
  // Down moves the active option; the search's active descendant follows it, still a mounted option.
  const search = within(p).getByRole("combobox");
  const first = search.getAttribute("aria-activedescendant");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  await waitFor(() => expect(search.getAttribute("aria-activedescendant")).not.toBe(first));
  comboboxOwnsItsOptions(p, "shelf after Down");
  // Tab moves to the templates: the descendant is one of theirs.
  fireEvent.keyDown(search, { key: "Tab" });
  await waitFor(() => expect(search.getAttribute("aria-controls")).toBe(within(p).getByRole("listbox", { name: "Templates" }).id));
  comboboxOwnsItsOptions(p, "shelf templates");
  // Searching: the grouped list, named groups, the same rules.
  type(search, "icon");
  fireEvent.keyDown(search, { key: "Tab" });
  await waitFor(() => expect(within(p).getByRole("group", { name: "Icons" })).toBeTruthy());
  reachable(controlsOf(p, "shelf searching"), "shelf searching");
  comboboxOwnsItsOptions(p, "shelf searching");
  fireEvent.keyDown(search, { key: "Escape" });
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() => expect(s.shelf()).toBeNull());

  // The Space box.
  const box = await s.openBox();
  reachable(controlsOf(box, "space box"), "space box");
  comboboxOwnsItsOptions(box, "space box");
  fireEvent.keyDown(within(box).getByRole("combobox"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add here" })).toBeNull());
  cleanup();

  // The New diagram dialog.
  routeInvoke({ list_diagrams: () => [], write_diagram: () => undefined, icon_index: () => [] });
  render(
    <ToastProvider>
      <NewDiagramDialog initialQuery="" onClose={() => {}} onCreated={() => {}} onMermaid={() => {}} onDatabase={() => {}} />
    </ToastProvider>,
  );
  const fresh = screen.getByRole("dialog", { name: "New diagram" });
  reachable(controlsOf(fresh, "new diagram"), "new diagram");
  comboboxOwnsItsOptions(fresh, "new diagram");
  cleanup();

  // The database dialog.
  routeInvoke({ list_databases: () => ["shop"], list_diagrams: () => [], list_objects: () => [{ kind: "table" }] });
  render(<FromDatabaseDialog connections={[kfc]} openIds={new Set(["c1"])} target={{ kind: "frame", add: { file: "board", run: async () => null } }} onClose={() => {}} />);
  const db = await screen.findByRole("dialog");
  reachable(controlsOf(db, "database"), "database");
  expect(db.getAttribute("aria-modal")).toBe("true");

  // Focus rings: the global rule draws one, the Shelf's and the box's own rules keep or replace it.
  expect(appCss).toMatch(/:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--c-focus\)/);
  for (const sel of [".flow-shelf-input:focus-visible", ".flow-space-input:focus-visible", ".flow-shelf-tab:focus-visible"]) {
    const rule = shelfCss.split("}").find((r) => r.includes(sel));
    expect(rule, sel).toMatch(/outline:\s*2px solid var\(--c-focus\)/);
  }
  // Options take no focus; the active one draws the ring while the search has it.
  expect(shelfCss).toMatch(/\.flow-shelf:focus-within \.flow-shelf-row\.is-active[\s\S]*?\{[^}]*outline:\s*2px solid var\(--c-focus\)/);
  expect(shelfCss).toMatch(/\.flow-space-row\.is-active\s*\{[^}]*outline:\s*2px solid var\(--c-focus\)/);
  // The only rules that hide a ring are the side that does not own the keys.
  for (const r of shelfCss.split("}").filter((r) => /outline:\s*(none|0)\b/.test(r))) expect(r).toMatch(/data-side/);
});

// The Shelf's source files and its two dialogs, not the tests.
const sources = {
  ...(import.meta.glob(["./**/*.ts", "./**/*.tsx", "../catalog/**/*.ts", "../catalog/**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx", "!../catalog/**/*.test.ts", "!../catalog/**/*.test.tsx"], {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
  "../../NewDiagramDialog.tsx": newDiagramSource,
};

/** Every string a source file can show: string and template literals and JSX text, read with the TypeScript parser. */
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

/** Every control name, title, placeholder and visible text under `root`. */
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

/** The Shelf's copy as shown: each tab, searching, and the Space box. */
async function shownCopy(s: ReturnType<typeof setup>): Promise<string[]> {
  const seen: string[] = [];
  const p = await s.openShelf();
  for (const tab of within(p).getAllByRole("tab")) {
    fireEvent.click(tab);
    seen.push(...copyIn(p));
  }
  type(within(p).getByRole("combobox"), "state");
  seen.push(...copyIn(p));
  fireEvent.keyDown(within(p).getByRole("combobox"), { key: "Escape" });
  fireEvent.keyDown(within(p).getByRole("combobox"), { key: "Escape" });
  await waitFor(() => expect(s.shelf()).toBeNull());
  seen.push(...copyIn(await s.openBox()));
  return seen;
}

test("no_dash_or_banned_word_in_shelf_copy", async () => {
  expect(Object.keys(sources).length).toBeGreaterThan(10);
  expect(Object.keys(sources).some((f) => f.endsWith("FromDatabaseDialog.tsx"))).toBe(true);
  for (const [file, src] of Object.entries(sources)) {
    const text = copyOf(src, file).join("\n");
    expect(text, file).not.toMatch(/[–—]/);
    expect(text, file).not.toMatch(/\bcursor\b|\bcaret\b/i);
  }
  const s = setup();
  await opened();
  s.sized();
  const joined = (await shownCopy(s)).join("\n");
  expect(joined.length).toBeGreaterThan(200);
  expect(joined).not.toMatch(/[–—]/);
  expect(joined).not.toMatch(/\bcursor\b|\bcaret\b/i);
});

test("frame_means_a_diagram_in_shelf_copy", async () => {
  // "Frame" is a diagram frame only: never a section, a shape, a sketch or a picture's border.
  const wrong = /(section|sketch|shape|border|picture|image)[^\n]*\bframes?\b|\bframes?\b[^\n]*(section|sketch|shape|border|picture|image)/i;
  // Words, not class names or keys (a string with no space is an identifier: "flow-shelf-preview-frame-image").
  for (const [file, src] of Object.entries(sources)) for (const text of copyOf(src, file).filter((t) => /\s/.test(t.trim()))) expect(text, file).not.toMatch(wrong);
  const s = setup();
  await opened();
  s.sized();
  for (const text of await shownCopy(s)) expect(text).not.toMatch(wrong);
});

test("reduced_motion_opens_without_a_fade", async () => {
  const s = setup();
  await opened();
  s.sized();
  let p = await s.openShelf();
  expect(p.style.animationDuration).toBe("0ms");
  fireEvent.keyDown(within(p).getByRole("combobox"), { key: "Escape" });
  await waitFor(() => expect(s.shelf()).toBeNull());
  let box = await s.openBox();
  expect(box.style.animationDuration).toBe("0ms");
  fireEvent.keyDown(within(box).getByRole("combobox"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add here" })).toBeNull());

  // With motion on, both take the menu's time (D7): the zeros above come from the preference.
  reduced.on = false;
  const ms = `${motionMs("menu")}ms`;
  expect(ms).not.toBe("0ms");
  p = await s.openShelf();
  expect(p.style.animationDuration).toBe(ms);
  fireEvent.keyDown(within(p).getByRole("combobox"), { key: "Escape" });
  await waitFor(() => expect(s.shelf()).toBeNull());
  box = await s.openBox();
  expect(box.style.animationDuration).toBe(ms);
  // The CSS reads the motion tokens, never a fixed time.
  for (const cls of ["flow-shelf", "flow-space-box"]) {
    const rule = shelfCss.split("}").find((r) => new RegExp(`(^|\\n)\\.${cls}\\s*\\{`).test(r));
    expect(rule, cls).toMatch(/animation:\s*menu-in var\(--motion-base\)/);
  }
});

test("opening_the_shelf_100_times_leaves_nothing_behind", async () => {
  // The spies go on before the first render, so every listener the board adds is counted.
  let net = 0;
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((...a: Parameters<typeof document.addEventListener>) => {
    net++;
    add(...a);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((...a: Parameters<typeof document.removeEventListener>) => {
    net--;
    remove(...a);
  });
  const s = setup();
  await opened();
  s.sized();
  // Load the pack once (the index is read once per app run), then count from a settled board.
  let p = await s.openShelf();
  await waitFor(() => expect(within(p).getByRole("tab", { name: "Icons, 300" })).toBeTruthy());
  fireEvent.keyDown(within(p).getByRole("combobox"), { key: "Escape" });
  await waitFor(() => expect(s.shelf()).toBeNull());
  await act(async () => {});
  const before = net;

  const tiles = () => document.querySelectorAll(".flow-shelf-tile").length;
  let mostTiles = 0;
  let mostSearching = 0;
  for (let i = 0; i < 100; i++) {
    p = await s.openShelf();
    const search = within(p).getByRole("combobox");
    if (i % 10 === 0) {
      fireEvent.click(within(p).getByRole("tab", { name: /^Icons/ }));
      await waitFor(() => expect(tiles()).toBeGreaterThan(0));
      mostTiles = Math.max(mostTiles, tiles());
      fireEvent.click(within(p).getByRole("tab", { name: /^Diagrams/ }));
      type(search, "icon");
      await waitFor(() => expect(within(p).getByRole("group", { name: "Icons" })).toBeTruthy());
      mostSearching = Math.max(mostSearching, tiles());
      fireEvent.keyDown(search, { key: "Escape" });
    }
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(s.shelf()).toBeNull());
    // Closed means unmounted: nothing of it stays in the page.
    expect(document.querySelector(".flow-shelf")).toBeNull();
    expect(tiles()).toBe(0);
  }
  await act(async () => {});
  expect(net).toBe(before);
  expect(previewCacheSize()).toBeLessThanOrEqual(3);
  expect(mostTiles).toBeGreaterThan(0);
  expect(mostTiles).toBeLessThanOrEqual(SHELF_ICON_LIMIT);
  expect(SHELF_ICON_LIMIT).toBe(48);
  expect(mostSearching).toBeGreaterThan(0);
  expect(mostSearching).toBeLessThanOrEqual(SHELF_GROUP_ICONS);
  expect(SHELF_GROUP_ICONS).toBe(24);
}, 120_000);

/** The overlays a board can show over the page, by class: the C5 candidates that render in a board tab. (The bar seen live after a resize was the desktop's own collapsed Xfce panel, not one of these.) */
const OVERLAYS = [".flow-shelf", ".flow-space-box", ".flow-toast", ".flow-group-ask", ".menu", ".result-pop", ".history-menu", ".mmenu", ".tooltip"];

function noEmptyOverlay(where: string) {
  for (const sel of OVERLAYS) {
    for (const el of document.body.querySelectorAll<HTMLElement>(sel)) expect((el.textContent ?? "").trim(), `${where}: an empty ${sel}`).not.toBe("");
  }
}

test("no_empty_overlay_survives_a_resize_and_a_tab_change", async () => {
  const s = setup();
  await opened();
  s.sized();
  const away = () => {
    act(() => void window.dispatchEvent(new Event("resize")));
    s.rerender(s.view(false));
  };
  const back = () => s.rerender(s.view(true));

  // The Shelf.
  await s.openShelf();
  away();
  noEmptyOverlay("shelf");
  back();
  if (s.shelf()) {
    fireEvent.keyDown(within(s.shelf()!).getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(s.shelf()).toBeNull());
  }

  // The Space box.
  await s.openBox();
  away();
  noEmptyOverlay("space box");
  back();
  const box = screen.queryByRole("dialog", { name: "Add here" });
  if (box) fireEvent.keyDown(within(box).getByRole("combobox"), { key: "Escape" });

  // A toast: an add from the Shelf toasts with its Undo.
  const p = await s.openShelf();
  fireEvent.click(within(p).getByRole("option", { name: "Flowchart" }));
  await waitFor(() => expect(document.querySelector(".flow-toast")).not.toBeNull());
  away();
  noEmptyOverlay("toast");
  back();

  // A placed menu: the frame bar's More.
  fireEvent.click(await screen.findByRole("button", { name: "Flowchart Checkout" }));
  const frameBar = await screen.findByRole("toolbar", { name: "Checkout settings" });
  fireEvent.click(within(frameBar).getByRole("button", { name: "More" }));
  await screen.findByRole("menu");
  away();
  noEmptyOverlay("more menu");
  back();
  noEmptyOverlay("back on the tab");
});

// ----- layout (Checkpoint M2)

test("the_template_chips_wrap_inside_the_shelf", () => {
  // At 1,920 by 1,080 and 1,360 by 768 the six chips were wider than the template side: a scrollbar, "Cloud" clipped.
  const rule = (sel: string) => ruleOf(shelfCss, sel);
  expect(rule(".flow-shelf-filter .segmented")).toMatch(/flex-wrap:\s*wrap/);
  expect(rule(".flow-shelf-filter .segmented")).toMatch(/max-width:\s*100%/);
  // The side never scrolls sideways: a long title or tag gives way, not the panel.
  expect(rule(".flow-shelf-templates")).toMatch(/overflow-x:\s*hidden/);
  expect(rule(".flow-shelf-templates")).toMatch(/min-width:\s*0/);
  // A long template name gives way to its kind tag (live at 1,360 wide, two tags were pushed past the side's edge).
  expect(rule(".flow-shelf-templates .flow-shelf-row-name")).toMatch(/min-width:\s*0/);
  expect(rule(".flow-shelf-templates .flow-shelf-row-name")).toMatch(/text-overflow:\s*ellipsis/);
  expect(rule(".flow-shelf-templates .flow-shelf-row-name")).toMatch(/white-space:\s*nowrap/);
  expect(rule(".flow-shelf-badge,\n.flow-shelf-tag")).toMatch(/flex:\s*none/);
});

/** The body of the rule whose selector is exactly `sel`, comments dropped. */
function ruleOf(css: string, sel: string): string | undefined {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .find((r) => r.split("{")[0].trim() === sel);
}

/** A px number from a CSS declaration in `rule`. */
const px = (rule: string | undefined, prop: string) => Number(new RegExp(`${prop}:\\s*([\\d.]+)px`).exec(rule ?? "")?.[1] ?? NaN);

test("the_shelf_ends_above_the_zoom_controls", async () => {
  // The Shelf sits in a layer the canvas's size, which is a size container, so its height can follow the zoom
  // control's place (which itself follows the canvas's size).
  const layer = ruleOf(shelfCss, ".flow-shelf-layer");
  expect(layer).toMatch(/position:\s*absolute/);
  expect(layer).toMatch(/inset:\s*0/);
  expect(layer).toMatch(/pointer-events:\s*none/);
  expect(layer).toMatch(/container:\s*flow-shelf-layer\s*\/\s*size/);
  const shelf = ruleOf(shelfCss, ".flow-shelf");
  expect(shelf).toMatch(/pointer-events:\s*auto/);
  const top = px(shelf, "top");
  const big = /max-height:\s*min\(60cqh,\s*calc\(100cqh - (\d+)px\)\)/.exec(shelf ?? "");
  expect(big).not.toBeNull();

  // The zoom control: its bottom margin over the overview, and its height (a 24 px button, 2 px padding, a hairline).
  const zoom = ruleOf(appCss, ".diagram-canvas .react-flow__panel.canvas-zoom");
  const lift = /margin:\s*0 \d+px (\d+)px 0/.exec(zoom ?? "");
  expect(lift).not.toBeNull();
  const zoomH = 24 + 2 * px(zoom, "padding") + 2;
  const GAP = 8;
  // Where it ends at 1,360 by 768 (a canvas about 560 px tall) and at the shortest canvas with the overview.
  for (const h of [361, 480, 560, 700, 1000]) {
    const height = Math.min(0.6 * h, h - Number(big![1]));
    expect(top + height + GAP, `canvas ${h}`).toBeLessThanOrEqual(h - Number(lift![1]) - zoomH);
  }
  // A small canvas drops the overview and the zoom control takes the corner: the same query, the same room.
  const small = /@container flow-shelf-layer \(max-height: 360px\) or \(max-width: 480px\)\s*\{\s*\.flow-shelf\s*\{[^}]*max-height:\s*min\(60cqh,\s*calc\(100cqh - (\d+)px\)\)/.exec(shelfCss);
  expect(small).not.toBeNull();
  expect(appCss).toMatch(/@container diagram-canvas \(max-height: 360px\) or \(max-width: 480px\)[\s\S]*?canvas-zoom\s*\{\s*margin-bottom:\s*12px/);
  for (const h of [200, 300, 360]) {
    const height = Math.min(0.6 * h, h - Number(small![1]));
    expect(top + height + GAP, `small canvas ${h}`).toBeLessThanOrEqual(h - 12 - zoomH);
  }

  // In the board, the Shelf is in that layer, outside `.diagram-canvas`.
  const s = setup();
  await opened();
  const p = await s.openShelf();
  expect(p.parentElement!.classList.contains("flow-shelf-layer")).toBe(true);
  expect(s.container.querySelector(".diagram-canvas")!.contains(p)).toBe(false);
  expect(flowTabSource).toContain('className="flow-shelf-layer"');
});
