// The board assistant's accessibility pass, as Task 16's boardA11y is the board's. Every control the
// AI added (the start screen, the chat head, the chips, the `/` list, the follow-up card, the part buttons in an
// answer, the change card and the review bar) is named and in the tab order; its copy has no dash and no banned word;
// reduced motion turns every AI glide into a jump and stills every AI animation.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { useRef } from "react";
import ts from "typescript";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { withTurn } from "../../api/client";
import type { AiEvent, AiThread, AppendTurn, Preview, ProposedChange } from "../../api/types";
import { useCommandKeys } from "../../commands/useCommandKeys";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import appCss from "../../styles/app.css?raw";
import flowBoardCss from "../../styles/flow-board.css?raw";
import flowTabCss from "../../styles/flow-tab.css?raw";
import tokensCss from "../../styles/tokens.css?raw";
import { done, sent } from "../../test/aiStream";
import { turnViewOf } from "../../test/aiThreads";
import { mockEditorDom } from "../../test/editor";
import { callsTo, routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import { GROQ } from "../../test/settingsRoutes";
import aiSectionSource from "../../settings/sections/AiSection.tsx?raw";
import reviewBarSource from "../board/ReviewBar.tsx?raw";
import FlowTab from "../FlowTab";
import type { FlowDocApi } from "../useFlowDoc";
import type { BoardAsk } from "./useBoardAsk";

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

const hooked = vi.hoisted(() => ({ ai: null as BoardAsk | null, doc: null as FlowDocApi | null }));
vi.mock("./useBoardAsk", async (load) => {
  const real = await load<typeof import("./useBoardAsk")>();
  return {
    ...real,
    useBoardAsk: (...a: Parameters<typeof real.useBoardAsk>) => {
      const r = real.useBoardAsk(...a);
      hooked.ai = r;
      hooked.doc = a[1];
      return r;
    },
  };
});

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});

const BOARD = [
  'diagram flow "Checkout"',
  "Shop {",
  "  Cart",
  "  Pay",
  "}",
  "Cart > Pay",
  "",
  'diagram er "Orders ERD"',
  "orders {",
  "  id int pk",
  "  total int",
  "}",
  "",
  'diagram flow "Refund"',
  "Ask",
  "Refund it",
  "Ask > Refund it",
  "",
].join("\n");
const TITLES = ["Checkout", "Orders ERD", "Refund"];

type Sink = { onmessage: (e: AiEvent) => void };
let threads: AiThread[] = [];
let replies: AiEvent[][] = [];
let reduce = true;

const PREVIEW: Preview = { items: [], tables: { full: [], namesOnly: [], leftOut: [], reasons: [] }, totalBytes: 0, tokens: 0, exact: "", notes: [], log: [], context: null, rows: null };

beforeEach(() => {
  localStorage.clear();
  reduce = true;
  canvas.props = null;
  canvas.instance = null;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  threads = [];
  replies = [];
  hooked.ai = null;
  hooked.doc = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A second owner of New chat, on screen beside the tab, as the app's Ask panel is. */
function AskPanelStandIn({ onNewChat }: { onNewChat(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useCommandKeys({ "assistant.newChat": onNewChat }, { region: ref });
  return <div ref={ref} data-ask-panel="" />;
}

function setup(o: { askPanel?: () => void } = {}) {
  routeInvoke({
    read_diagram: () => ({ text: BOARD, layout: null }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    list_ai_threads: (a) => threads.filter((t) => t.place === a.place).map((t) => ({ id: t.id, place: t.place, title: t.title, updatedAt: t.updatedAt, messages: t.messages.length, topics: 0 })),
    get_ai_thread: (a) => {
      const t = threads.find((x) => x.id === a.threadId);
      return t ? { thread: t, topics: [], compactions: [] } : null;
    },
    ai_append_turn: (a) => {
      const turn = a.turn as AppendTurn;
      const before = threads.find((x) => x.id === turn.threadId) ?? null;
      const v = turnViewOf(turn, before);
      threads = [...threads.filter((x) => x.id !== turn.threadId), withTurn(before, v)];
      return v;
    },
    ai_known_models: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    ai_settings: () => ({ settings: { ...GROQ, diagramTool: true }, groupOverride: false, keySaved: true, keyLast4: "abcd" }),
    ai_diagram_preview: () => PREVIEW,
    ai_diagram_ask: (a) => {
      const sink = a.events as Sink;
      const events = replies.shift() ?? [];
      setTimeout(() => events.forEach((e) => sink.onmessage(e)), 0);
      return null;
    },
    ai_cancel_place: () => true,
    ai_record_tool_result: (a) => a.outcome,
    ai_clear_attachment: () => null,
  });
  return render(
    <>
      <div style={{ width: 1280, height: 800 }}>
        <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
      </div>
      {o.askPanel && <AskPanelStandIn onNewChat={o.askPanel} />}
    </>,
  );
}

/** The board is parsed and drawn; `fit` watches every glide of the view. */
async function drawnBoard(o: { askPanel?: () => void } = {}) {
  const s = setup(o);
  await waitFor(() => expect(hooked.doc?.parsed?.result.frames.map((f) => f.title)).toEqual(TITLES), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  const fit = vi.spyOn(canvas.instance!, "fitBounds").mockResolvedValue(true);
  return { s, fit };
}

const asks = () => callsTo("ai_diagram_ask");
const ai = () => hooked.ai!;
const composer = () => screen.getByRole("textbox", { name: "Describe a change" }) as HTMLTextAreaElement;
const openAssistant = () => fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));

async function send(q: string) {
  const before = asks().length;
  openAssistant();
  fireEvent.change(composer(), { target: { value: q } });
  fireEvent.keyDown(composer(), { key: "Enter" });
  await waitFor(() => expect(asks().length).toBe(before + 1));
}

async function idle() {
  await waitFor(() => expect(ai().working).toBeNull());
}

const okIn = (frame: string, index: number, op: ProposedChange["op"], dependsOn: number[] = []): ProposedChange => ({ index, op, status: { kind: "ok" }, dependsOn, frame });
const proposing = (changes: ProposedChange[]): AiEvent[] => [sent(), { type: "delta", text: "Here." }, { type: "proposal", proposal: { file: "board", baseHash: "b1", changes }, input: "{}" } as AiEvent, done()];
const answered = (text: string): AiEvent[] => [sent(), { type: "delta", text }, done()];
const followUp = (question: string): AiEvent[] => [sent(), { type: "followUp", question } as AiEvent, done()];

/** A proposal over two frames: Checkout's group renamed and a shape added, Refund's Ask removed. */
const CHANGES = [okIn("Checkout", 0, { rename_node: { target: "Shop", name: "Store" } }), okIn("Checkout", 1, { add_node: { name: "Ship" } }), okIn("Refund", 2, { remove_node: { target: "Ask" } })];

// ----- Names and reach (the checks of boardA11y, over the AI's controls).

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

const CONTROLS = "button, input, textarea, select, [role=menuitem], [role=tab], [role=combobox], [role=option], [role=listbox], [role=radio]";

/** Every control inside `root`, each named; returns them for the reach checks. */
function controlsOf(root: HTMLElement, where: string): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(CONTROLS)];
  expect(all.length, where).toBeGreaterThan(0);
  for (const el of all) expect(nameOf(el), `${where}: ${el.outerHTML.slice(0, 80)}`).not.toBe("");
  return all;
}

/** Tab reaches a control when its tab index is 0, or it sits in a roving group (toolbar, listbox, radio group) with one stop. */
function reachable(all: HTMLElement[], where: string) {
  for (const el of all) {
    if (el.tabIndex >= 0 || (el as HTMLButtonElement).disabled) continue;
    const group = el.closest<HTMLElement>("[role=toolbar], [role=menu], [role=tablist], [role=listbox], [role=radiogroup]");
    expect(group, `${where}: ${nameOf(el)} is out of the tab order`).not.toBeNull();
    // A listbox is reached by its own stop, or by the box that drives it (aria-activedescendant, the `/` list).
    if (group!.getAttribute("role") === "listbox" && group!.tabIndex < 0) {
      expect(document.querySelector(`[aria-controls="${group!.id}"]`), `${where}: the list's box`).not.toBeNull();
    }
    if (group!.getAttribute("role") === "toolbar") {
      expect(
        [...group!.querySelectorAll<HTMLElement>("button")].some((b) => b.tabIndex === 0),
        `${where}: the toolbar has a tab stop`,
      ).toBe(true);
    }
  }
}

test("every_new_control_is_named_and_reachable", async () => {
  const { s } = await drawnBoard();
  openAssistant();

  // The start screen: the kinds' listbox named by its question, Template and File.
  const start = await screen.findByRole("region", { name: "What would you like to create?" });
  const kinds = within(start).getByRole("listbox");
  expect(kinds.tabIndex).toBe(0);
  reachable(controlsOf(start, "start screen"), "start screen");
  // The chat head: New chat with its key, and the clock of past chats.
  const head = s.container.querySelector<HTMLElement>(".flow-assist-head")!;
  reachable(controlsOf(head, "chat head"), "chat head");
  expect(within(head).getByRole("button", { name: "New chat" }).getAttribute("aria-keyshortcuts")).toBe("Control+Shift+N");

  // The chips: the selected frame's, each with its named remove button.
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  const chips = await screen.findByRole("list", { name: "References for this question" });
  reachable(controlsOf(chips, "chips"), "chips");
  expect(within(chips).getByRole("button", { name: /^Remove .*Checkout$/ })).toBeTruthy();

  // The `/` list: the box drives it; every diagram is an option with its name.
  fireEvent.change(composer(), { target: { value: "/", selectionStart: 1 } });
  const slash = await screen.findByRole("listbox", { name: "Diagrams on this board" });
  expect(composer().getAttribute("aria-controls")).toBe(slash.id);
  const options = controlsOf(slash, "slash list").filter((o) => o.getAttribute("role") === "option");
  expect(options.map(nameOf)).toEqual(expect.arrayContaining([expect.stringContaining("Refund")]));
  reachable(options, "slash list");
  expect(composer().getAttribute("aria-activedescendant")).toBe(options[0].id);
  fireEvent.keyDown(composer(), { key: "Escape" });
  fireEvent.change(composer(), { target: { value: "" } });

  // The follow-up card: a group named by its question, the reply box focused, Cancel and Continue.
  replies = [followUp("Which table?"), answered("The amount is `Orders ERD: orders.total`, and `Refund: Ask` starts a refund.")];
  await send("Add a status column");
  const card = await screen.findByRole("group", { name: "Which table?" });
  reachable(controlsOf(card, "follow-up"), "follow-up");
  expect(document.activeElement).toBe(within(card).getByRole("textbox", { name: "Your reply" }));
  // The composer waits, and says why.
  expect(composer().disabled).toBe(true);
  expect(document.getElementById(composer().getAttribute("aria-describedby")!)?.textContent).toBe("Answer the question above first.");
  fireEvent.click(within(card).getByRole("button", { name: /^Continue/ }));
  await idle();

  // The part buttons: real buttons in the tab order, whose names start with the words they show (WCAG 2.5.3).
  const parts = await screen.findAllByRole("button", { name: /show in/ });
  expect(parts.length).toBe(2);
  for (const b of parts) {
    expect(b.tagName).toBe("BUTTON");
    expect(b.tabIndex).toBe(0);
    expect(nameOf(b).startsWith(b.textContent!)).toBe(true);
  }

  // The change card and the review bar.
  replies = [proposing(CHANGES)];
  await send("Rename the shop, add shipping and drop the refund question");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  const review = await screen.findByRole("region", { name: "Changes to review" });
  reachable(controlsOf(review, "change card"), "change card");
  for (const g of within(review).getAllByRole("group")) expect(nameOf(g)).toMatch(/^(Checkout|Refund), \d changes?$/);
  const bar = await screen.findByRole("toolbar", { name: "Assistant changes" });
  const barButtons = controlsOf(bar, "review bar");
  reachable(barButtons, "review bar");
  expect(barButtons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  // What the review marks says itself: the renamed group, and the shape it would remove, though the answer before
  // named it and it still rings (the review's mark wins over the ring).
  await waitFor(() => expect(s.container.querySelector('[aria-label="Group Store, changed by AI"]')).not.toBeNull());
  expect(s.container.querySelector('[aria-label="Step Ask, removal suggested by AI"]')).not.toBeNull();
});

test("a_part_an_answer_only_names_rings_without_saying_it_was_added", async () => {
  // Fix round 1: the ring on a named part is a pointer, not a change; only what a landing added says ", added by AI".
  const { s } = await drawnBoard();
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  replies = [answered("`Cart` feeds `Pay`; `Refund: Ask` starts a refund and `Orders ERD: orders.total` is the amount.")];
  await send("What does the board do?");
  await idle();
  const ringing = () => [...s.container.querySelectorAll<HTMLElement>(".fnode-airing")];
  // The live frame's shapes and a static frame's shape ring, each under its own name alone.
  await waitFor(() => expect(ringing().map((n) => n.getAttribute("aria-label")).sort()).toEqual(["Step Ask", "Step Cart", "Step Pay"]));
  // The column's row rings with its plain hint.
  const row = s.container.querySelector<HTMLElement>(".fkind-er-row.is-ai-airing");
  expect(row).not.toBeNull();
  expect(row!.getAttribute("title") ?? "").not.toMatch(/by AI/);

  // A landing's new shapes still say so.
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
  replies = [proposing([okIn("Refund", 0, { add_node: { name: "Refunded" } })])];
  await send("Add a refunded state");
  await waitFor(() => expect(s.container.querySelector('[aria-label="Step Refunded, added by AI"]')).not.toBeNull());
  expect(s.container.querySelector('[aria-label="Step Refunded, added by AI"]')!.classList.contains("fnode-airing")).toBe(true);
});

test("ctrl_shift_n_on_the_canvas_starts_a_board_chat_before_the_ask_panel", async () => {
  // Carried from Task 15: focus in neither the board's pane nor the Ask panel, both on screen. The focused region
  // wins, else the visible board pane; the Ask panel registered later no longer takes it.
  const askPanel = vi.fn();
  const { s } = await drawnBoard({ askPanel });
  replies = [answered("Two shapes.")];
  await send("What is here?");
  await idle();
  expect(ai().thread).not.toBeNull();
  const flow = s.container.querySelector<HTMLElement>(".flow-canvas")!;
  flow.focus();
  fireEvent.keyDown(flow, { key: "N", code: "KeyN", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(ai().thread).toBeNull());
  expect(askPanel).not.toHaveBeenCalled();
  // With focus in the Ask panel's region, it takes the key.
  const panel = s.container.ownerDocument.querySelector<HTMLElement>("[data-ask-panel]")!;
  const field = document.createElement("input");
  panel.appendChild(field);
  field.focus();
  fireEvent.keyDown(field, { key: "N", code: "KeyN", ctrlKey: true, shiftKey: true });
  expect(askPanel).toHaveBeenCalledTimes(1);
});

// ----- Copy.

// The AI's source files, not the tests: everything under src/flow/ai, the review bar and the AI settings.
const sources = {
  ...(import.meta.glob(["./*.ts", "./*.tsx", "!./*.test.ts", "!./*.test.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>),
  "../board/ReviewBar.tsx": reviewBarSource,
  "../../settings/sections/AiSection.tsx": aiSectionSource,
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

/** No em or en dash, and none of the project's banned words (the board's, Shelf's and Syntax Help's copy tests). */
function clean(text: string, where: string) {
  expect(text, where).not.toMatch(/[–—]/);
  expect(text, where).not.toMatch(/\bcursor\b|\bcaret\b/i);
}

test("no_dash_or_banned_word_in_ai_copy", async () => {
  expect(Object.keys(sources).length).toBeGreaterThan(12);
  for (const [file, src] of Object.entries(sources)) clean(copyOf(src, file).join("\n"), file);

  // And what a session shows: the start screen, the follow-up card, an answer with its part buttons, the change card,
  // the review bar and the remove question.
  const { s } = await drawnBoard();
  openAssistant();
  const seen = [...copyIn(s.container)];
  replies = [followUp("Which table?"), answered("See `Refund: Ask`.")];
  await send("Add a status column");
  await screen.findByRole("group", { name: "Which table?" });
  seen.push(...copyIn(s.container));
  fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));
  await idle();
  await screen.findByRole("button", { name: /show in Refund/ });
  seen.push(...copyIn(s.container));
  replies = [proposing(CHANGES)];
  await send("Rename the shop");
  await screen.findByRole("toolbar", { name: "Assistant changes" });
  seen.push(...copyIn(s.container));
  act(() => ai().rejectAll());
  const removing = ["Cart", "Pay", "Ask", "Refund it"].map((target, i) => okIn(i < 2 ? "Checkout" : "Refund", i, { remove_node: { target } }));
  replies = [proposing(removing)];
  await send("Remove everything");
  await screen.findByRole("group", { name: /^Remove / });
  seen.push(...copyIn(s.container));
  clean(seen.join("\n"), "on screen");
});

// ----- Motion.

/** Every rule in `css` that runs one of the AI's animations, by its selector. */
/** A style rule of a stylesheet, its selectors split, with the media query it sits in (null at the top level). */
type ParsedRule = { selectors: string[]; animation: string; media: string | null };

/** Every style rule of `css`, parsed by the DOM's own CSS parser (jsdom's CSSOM), media rules opened. */
function parsedRules(css: string): ParsedRule[] {
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
  try {
    const out: ParsedRule[] = [];
    const walk = (list: CSSRuleList, media: string | null) => {
      for (const r of Array.from(list)) {
        if (r instanceof CSSMediaRule) walk(r.cssRules, r.media.mediaText);
        else if (r instanceof CSSStyleRule) out.push({ selectors: r.selectorText.split(",").map((x) => x.trim()), animation: r.style.getPropertyValue("animation").trim(), media });
      }
    };
    walk(el.sheet!.cssRules, null);
    return out;
  } finally {
    el.remove();
  }
}

test("reduced_motion_jumps_every_ai_glide", async () => {
  const { fit } = await drawnBoard();
  // The proposal's glide to its frames.
  replies = [proposing(CHANGES)];
  await send("Rename the shop, add shipping and drop the refund question");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  await waitFor(() => expect(fit).toHaveBeenCalled());
  // The landing's glide.
  fit.mockClear();
  act(() => ai().acceptAll());
  await waitFor(() => expect(fit).toHaveBeenCalled());
  await idle();
  // A part button's glide.
  replies = [answered("It starts at `Refund: Refund it`.")];
  await send("Where does a refund start?");
  await idle();
  const calls = fit.mock.calls.length;
  fireEvent.click(await screen.findByRole("button", { name: /show in Refund/ }));
  await waitFor(() => expect(fit.mock.calls.length).toBeGreaterThan(calls));
  expect(fit.mock.calls.length).toBeGreaterThan(1);
  for (const c of fit.mock.calls) expect(c[1]?.duration).toBe(0);

  // Every AI animation is still under reduced motion: Windows' setting, and the app's own preference, which drops the
  // motion tokens to 0 ms (so a fill-mode fade would end at once, and the ring would vanish).
  const parsed = parsedRules(flowTabCss);
  const animated = parsed.filter((r) => /^ai-/.test(r.animation)).flatMap((r) => r.selectors);
  expect(animated.length).toBeGreaterThan(3);
  /** A rule that sets `animation: none` on `sel`, under `media` (null: at the top level). */
  const stills = (sel: string, media: string | null) => parsed.some((r) => r.media === media && r.animation === "none" && r.selectors.includes(sel));
  for (const sel of animated) {
    expect(stills(sel, "(prefers-reduced-motion: reduce)"), `${sel} under prefers-reduced-motion`).toBe(true);
    expect(stills(`:root[data-reduced-motion] ${sel}`, null), `${sel} under data-reduced-motion`).toBe(true);
  }
  // The rest (the menus, the cards' fade in) run on the motion tokens, which both preferences zero.
  expect(appCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{\s*animation-duration: 0ms !important;/);
  expect(tokensCss).toMatch(/:root\[data-reduced-motion\] \{[^}]*--motion-base: 0ms;/);

  // With motion on, the same glide takes the table's 240 ms: the zeros above come from the preference.
  reduce = false;
  fit.mockClear();
  fireEvent.click(screen.getByRole("button", { name: /show in Refund/ }));
  await waitFor(() => expect(fit).toHaveBeenCalled());
  expect(fit.mock.calls[0][1]?.duration).toBe(240);
});

// ----- Contrast: the review's marks, the new frame's box, the row states and the bar, in both themes.

/** The theme's tokens, `var()` resolved, as hex. */
function theme(head: string): (token: string) => string {
  const at = tokensCss.indexOf(head);
  const block = tokensCss.slice(at, tokensCss.indexOf("\n}", at));
  const own = new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const get = (t: string): string => {
    const v = own.get(t);
    if (!v) throw new Error(`${head} has no ${t}`);
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    return ref ? get(ref[1]) : v;
  };
  return get;
}
const THEMES = { light: theme(":root, .theme-light {"), dark: theme(':root[data-theme="dark"], .theme-dark {') };
const rgbOf = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
/** `color-mix(in srgb, a p%, b)`. */
const mixOf = (a: string, p: number, b: string) => {
  const [x, y] = [rgbOf(a), rgbOf(b)];
  return `#${x.map((c, i) => Math.round(c * p + y[i] * (1 - p)).toString(16).padStart(2, "0")).join("")}`;
};
/** WCAG 2.x contrast ratio. */
function ratio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = rgbOf(hex).map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
}
/** The declarations of the rule whose selector is exactly `sel` in `css`. */
const ruleOf = (css: string, sel: string) => {
  const at = css.indexOf(`${sel} {`);
  expect(at, sel).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

test("the_review_marks_and_the_bar_keep_wcag_contrast_in_both_themes", () => {
  // The rules use the tokens measured below.
  expect(ruleOf(flowBoardCss, ".flow-canvas .fnode-changed")).toMatch(/box-shadow: 0 0 0 2px var\(--c-accent\);/);
  expect(ruleOf(flowBoardCss, ".flow-canvas .react-flow__node.is-ai-changed > .flow-area")).toMatch(/border-color: var\(--c-accent\);/);
  expect(ruleOf(flowBoardCss, ".fkind-er-row.is-ai-changed")).toMatch(/background: color-mix\(in srgb, var\(--c-accent\) 10%, var\(--c-bg-surface\)\);/);
  expect(ruleOf(flowBoardCss, ".board-frame.is-new .board-frame-body")).toMatch(/border-color: var\(--c-accent\);/);
  expect(ruleOf(flowBoardCss, ".board-frame-new")).toMatch(/color: var\(--c-gmk-ink\);/);
  expect(ruleOf(flowBoardCss, ".board-review")).toMatch(/border: var\(--border-hairline\) solid var\(--c-border-strong\);/);
  // Words on the accent or danger fill (Accept, Send, Remove, the working tag, the rail's count): the app's on-accent ink.
  for (const sel of [".btn.pbtn2.pri", ".btn.pbtn2.dng", ".btn.sendb", ".flow-aipres", ".rbadge"]) expect(ruleOf(flowTabCss, sel), sel).toMatch(/color: var\(--on-accent\);/);

  for (const [name, t] of Object.entries(THEMES)) {
    const canvasBg = t("--c-bg-canvas");
    const surface = t("--c-bg-surface");
    const accent = t("--c-accent");
    const text: [string, string, string][] = [
      ["changed shape", t("--c-text"), mixOf(accent, 0.1, canvasBg)],
      ["renamed group's name", t("--c-text-muted"), mixOf(accent, 0.1, canvasBg)],
      ["new row", t("--c-text"), t("--c-success-subtle")],
      ["new row's type", t("--c-syn-type"), t("--c-success-subtle")],
      ["removed row", t("--c-text"), t("--c-danger-subtle")],
      ["removed row's type", t("--c-syn-type"), t("--c-danger-subtle")],
      ["changed row", t("--c-text"), mixOf(accent, 0.1, surface)],
      ["changed row's type", t("--c-syn-type"), mixOf(accent, 0.1, surface)],
      ["new frame's tag", t("--c-gmk-ink"), accent],
      ["bar's words", t("--c-text"), surface],
      ["Accept", t("--on-accent"), accent],
      ["Remove", t("--on-accent"), t("--c-danger-solid")],
    ];
    for (const [what, fg, bg] of text) expect(ratio(fg, bg), `${name}: ${what}`).toBeGreaterThanOrEqual(4.5);
    const marks: [string, string, string][] = [
      ["changed ring, line and group edge", accent, canvasBg],
      ["new frame's dashed box", accent, canvasBg],
      ["new row's edge", t("--c-success-solid"), t("--c-success-subtle")],
      ["removed row's edge", t("--c-danger-solid"), t("--c-danger-subtle")],
      ["changed row's edge", accent, mixOf(accent, 0.1, surface)],
      ["ringed row's edge", accent, surface],
      ["bar's edge", t("--c-border-strong"), canvasBg],
    ];
    for (const [what, fg, bg] of marks) expect(ratio(fg, bg), `${name}: ${what}`).toBeGreaterThanOrEqual(3);
  }
});
