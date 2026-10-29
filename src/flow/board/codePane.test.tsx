// Task 13: the code pane on the frame block (Decisions 14 to 17, 24 and 25; Review Focus 2 and 3). The pane shows the
// selected frame's block only (frame 0 with nothing selected), follows the canvas both ways, numbers lines from the
// shown frame's header, and opens per tab.
import { undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_UI_PREFS, type AiEvent, type DiagramAskRequest, type DiagramProposal, type ProposedChange, type UiPrefs } from "../../api/types";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { MESSAGES } from "../../lang/flow/problems";
import { PrefsProvider } from "../../prefs/usePrefs";
import appCss from "../../styles/app.css?raw";
import { done } from "../../test/aiStream";
import { turnViewOf } from "../../test/aiThreads";
import { callsTo, routeInvoke } from "../../test/invoke";
import { mockEditorDom } from "../../test/editor";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import { GROQ } from "../../test/settingsRoutes";
import { withTurn } from "../../api/client";
import type { AiThread, AppendTurn } from "../../api/types";
import { README_BILLING } from "../fixtures/erBilling";
import { flowEntry } from "../flowRegistry";
import FlowTab from "../FlowTab";
import { boardFrameId } from "./boardScene";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null, seen: null as ((p: DiagramCanvasProps) => void) | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      canvas.seen?.(p);
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

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  replies = [];
  threads = [];
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  canvas.instance = null;
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\n';
const BOARD = [CHECKOUT, REFUND, SHIPPING].join("\n");

function boardLayout() {
  return JSON.stringify({
    version: 2,
    frames: {
      Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
      Refund: { at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
      Shipping: { at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    },
    sketches: [],
  });
}

// ----- the Assistant's side of the Core, for Ask
type Sink = { onmessage: (e: AiEvent) => void };
let replies: AiEvent[][] = [];
let threads: AiThread[] = [];
const sinks: Sink[] = [];
const ok = { kind: "ok" } as const;
const proposal = (changes: ProposedChange[]): DiagramProposal => ({ file: "board", baseHash: "b1", changes });
const answer = (changes: ProposedChange[]): AiEvent[] => [
  { type: "delta", text: "Here it is." },
  { type: "proposal", proposal: proposal(changes), input: '{"file":"board","base_hash":"b1","ops":[]}' } as AiEvent,
  done(),
];
const aiRoutes = {
  list_ai_threads: () => [],
  get_ai_thread: () => null,
  save_ai_thread: (a: Record<string, unknown>) => ({ thread: a.thread, topics: [], compactions: [] }),
  ai_append_turn: (a: Record<string, unknown>) => {
    const turn = a.turn as AppendTurn;
    const before = threads.find((x) => x.id === turn.threadId) ?? null;
    const v = turnViewOf(turn, before);
    threads = [...threads.filter((x) => x.id !== turn.threadId), withTurn(before, v)];
    return v;
  },
  ai_known_models: () => {
    throw { kind: "ai", message: { kind: "notConfigured" } };
  },
  save_ai_settings: () => null,
  ai_settings: () => ({ settings: { ...GROQ, diagramTool: true }, groupOverride: false, keySaved: true, keyLast4: "abcd" }),
  ai_diagram_preview: (a: Record<string, unknown>) => {
    const r = a.request as DiagramAskRequest;
    return {
      items: [{ kind: "question", label: "Question", bytes: r.question.length, tokens: 4, locked: null, on: true }],
      tables: { full: [], namesOnly: [], leftOut: [], reasons: [] },
      totalBytes: 10,
      tokens: 10,
      exact: r.question,
      notes: [],
      log: [],
      context: null,
      rows: null,
    };
  },
  ai_diagram_ask: (a: Record<string, unknown>) => {
    const sink = a.events as Sink;
    sinks.push(sink);
    const events = replies.shift() ?? [];
    setTimeout(() => events.forEach((e) => sink.onmessage(e)), 0);
    return null;
  },
  ai_cancel_place: () => true,
  ai_record_tool_result: (a: Record<string, unknown>) => a.outcome,
};

interface Opts {
  text?: string;
  layout?: string | null;
  name?: string;
  /** Wraps the tab in the app's prefs, as the window does; the Core's stored prefs. */
  prefs?: UiPrefs;
  /** A second diagram tab beside this one (both mounted, as the window keeps them). */
  other?: { name: string; text: string };
}

function setup(opts: Opts = {}) {
  const files = new Map<string, { text: string; layout: string | null }>();
  files.set(opts.name ?? "board", { text: opts.text ?? BOARD, layout: opts.layout === undefined ? boardLayout() : opts.layout });
  if (opts.other) files.set(opts.other.name, { text: opts.other.text, layout: null });
  routeInvoke({
    read_diagram: (a) => files.get(a.name as string) ?? { text: "", layout: null },
    write_diagram: (a) => {
      const f = files.get(a.name as string)!;
      f.text = a.text as string;
      f.layout = a.layout as string;
      return null;
    },
    write_diagram_layout: (a) => {
      files.get(a.name as string)!.layout = a.layout as string;
      return null;
    },
    ui_prefs: () => opts.prefs ?? DEFAULT_UI_PREFS,
    save_ui_prefs: () => null,
    ...aiRoutes,
  });
  const client = new LangClient(() => fakeWorker());
  const name = opts.name ?? "board";
  const tabs = (show: boolean) => (
    <>
      {show && (
        <div className="tab-a" style={{ width: 1280, height: 800 }}>
          <FlowTab name={name} client={client} />
        </div>
      )}
      {opts.other && (
        <div className="tab-b" style={{ width: 1280, height: 800 }}>
          <FlowTab name={opts.other.name} client={client} />
        </div>
      )}
    </>
  );
  const wrap = (n: ReactNode) => (opts.prefs ? <PrefsProvider>{n}</PrefsProvider> : n);
  const utils = render(wrap(tabs(true)));
  const tabEl = () => (utils.container.querySelector(".tab-a") ?? utils.container) as HTMLElement;
  const view = () => EditorView.findFromDOM(tabEl().querySelector(".cm-editor") as HTMLElement)!;
  const text = () => view().state.doc.toString();
  /** The text the pane shows: hidden frames are not drawn. */
  const visible = () => view().contentDOM.textContent ?? "";
  // The first element only sizes the gutter.
  const gutter = () => [...tabEl().querySelectorAll(".cm-lineNumbers .cm-gutterElement")].map((e) => e.textContent).slice(1);
  const pane = () => tabEl().querySelector('section[aria-label="Side panel"]') as HTMLElement;
  const frameEl = (key: string) => [...tabEl().querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === boardFrameId(key)) ?? null;
  const isSelected = (key: string) => {
    const el = frameEl(key);
    return !!el && within(el).queryByRole("button", { name: /^Code Editor/ }) !== null;
  };
  const tab = (title: string) => within(tabEl()).findByRole("button", { name: `Flowchart ${title}` });
  const canvasEl = () => tabEl().querySelector(".flow-canvas") as HTMLElement;
  /** Types `insert` at `at` as the keyboard does, the cursor after it. */
  const type = (at: number, insert: string) =>
    act(() => view().dispatch({ changes: { from: at, insert }, selection: EditorSelection.cursor(at + insert.length), userEvent: "input.type" }));
  const reopen = () => {
    utils.rerender(wrap(tabs(false)));
    utils.rerender(wrap(tabs(true)));
  };
  return { ...utils, files, client, view, text, visible, gutter, pane, frameEl, isSelected, tab, canvasEl, type, reopen, tabEl };
}
type Setup = ReturnType<typeof setup>;

async function opened(s: Setup, titles = ["Checkout", "Refund", "Shipping"]) {
  for (const t of titles) await s.tab(t);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => expect(s.tabEl().querySelector(".cm-editor")).not.toBeNull());
}

/** Selects a frame by its tab and waits for the pane to show it. */
async function pick(s: Setup, title: string) {
  fireEvent.click(await s.tab(title));
  // The frame goes live one paint after it is drawn selected (Plan F Decision 12).
  await act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  });
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
  await waitFor(() => expect(s.visible()).toContain(`"${title}"`));
}

const hideButton = (s: Setup) => within(s.pane()).getByRole("button", { name: "Hide the side panel", hidden: true });

test("a_new_board_opens_with_the_pane_open", async () => {
  // The Core remembers an old hidden panel; a tab opened for the first time opens with its pane open (owner answer 6).
  const s = setup({ prefs: { ...DEFAULT_UI_PREFS, flowSidePanel: { hidden: true, tab: "editor" } } });
  await opened(s);
  expect(s.pane().hidden).toBe(false);
  expect(s.tabEl().querySelector(".srail")).toBeNull();
  expect(screen.getByRole("tab", { name: /^Editor/ }).getAttribute("aria-selected")).toBe("true");
});

test("a_closed_pane_is_hidden_and_takes_no_space", async () => {
  const s = setup();
  await opened(s);
  fireEvent.click(hideButton(s));
  await waitFor(() => expect(s.pane().hidden).toBe(true));
  // No rail, the layout gives the pane nothing, and the editor stays mounted with its history.
  expect(s.tabEl().querySelector(".srail")).toBeNull();
  expect(s.tabEl().querySelector(".flow-tab")!.classList.contains("is-pane-closed")).toBe(true);
  expect(s.tabEl().querySelector(".cm-editor")).not.toBeNull();
  // A hidden island is not laid out at all (no width measured: jsdom lays nothing out).
  expect(appCss.replace(/\s+/g, " ")).toMatch(/\.schema-island\[hidden\] \{ display: none;/);
});

test("with_nothing_selected_the_pane_shows_frame_zero", async () => {
  const s = setup();
  await opened(s);
  for (const t of ["Checkout", "Refund", "Shipping"]) expect(s.isSelected(t)).toBe(false);
  await waitFor(() => expect(s.visible()).toContain('"Checkout"'));
  expect(s.visible()).toContain("Cart > Pay");
  expect(s.visible()).not.toContain("Refund");
  expect(s.visible()).not.toContain("Pack");
  expect(within(s.pane()).getByRole("heading", { name: "Flowchart" })).toBeTruthy();
});

test("ask_works_on_the_selected_frame", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Shipping");
  // The board Ask reads the whole board in one worker call (Plan D Task 10), with the selected frame as its focus.
  const outline = vi.spyOn(s.client, "boardOutline");
  replies = [answer([{ index: 0, op: { add_node: { name: "Label", kind: "step" } }, status: ok, dependsOn: [], frame: "Shipping" }])];
  fireEvent.click(within(s.tabEl()).getByRole("button", { name: "Ask" }));
  const box = await screen.findByRole("textbox", { name: "Describe a change" });
  fireEvent.change(box, { target: { value: "Add a label step" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(outline).toHaveBeenCalled());
  await waitFor(() => expect(callsTo("ai_diagram_ask")).toHaveLength(1));
  const r = callsTo("ai_diagram_ask")[0].request as DiagramAskRequest;
  expect(r.board!.focus).toEqual(["Shipping"]);
  expect(r.board!.selected?.frame).toBe("Shipping");
  expect(r.outline.nodes.map((n) => n.name)).toEqual(["Pack", "Send"]);
  await screen.findByRole("region", { name: "Changes to review" });
  fireEvent.click(within(screen.getByRole("region", { name: "Changes to review" })).getByRole("button", { name: /^Accept all/ }));
  await waitFor(() => expect(s.text()).toContain("Label"));
  const [checkout, refund, shipping] = s.text().split(/\n(?=diagram )/);
  expect(checkout).toBe(CHECKOUT);
  expect(refund).toBe(REFUND);
  expect(shipping).toContain("Label");
  expect(shipping.startsWith('diagram flow "Shipping"')).toBe(true);
});

test("a_tab_reopens_the_way_it_was_left", async () => {
  const s = setup({ prefs: DEFAULT_UI_PREFS });
  await opened(s);
  fireEvent.click(hideButton(s));
  await waitFor(() => expect(s.pane().hidden).toBe(true));
  s.reopen();
  await opened(s);
  expect(s.pane().hidden).toBe(true);
  expect(s.tabEl().querySelector(".srail")).toBeNull();
});

test("the_pane_is_on_the_left", async () => {
  const s = setup();
  await opened(s);
  const drawing = within(s.tabEl()).getByRole("region", { name: "board drawing" });
  expect(s.pane().compareDocumentPosition(drawing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("another_tab_open_does_not_open_this_one", async () => {
  const s = setup({ prefs: { ...DEFAULT_UI_PREFS, flowSidePanel: { hidden: true, tab: "editor" } }, other: { name: "notes", text: 'diagram flow "Notes"\nIdea\n' } });
  await opened(s);
  const other = s.container.querySelector(".tab-b") as HTMLElement;
  const otherPane = () => other.querySelector('section[aria-label="Side panel"]') as HTMLElement;
  await waitFor(() => expect(otherPane().hidden).toBe(false));
  fireEvent.click(hideButton(s));
  await waitFor(() => expect(s.pane().hidden).toBe(true));
  expect(otherPane().hidden).toBe(false);
  // The stored pref keeps only the tab: the Assistant tab on the other diagram is saved, the Core's hidden as it was.
  fireEvent.click(within(other).getByRole("tab", { name: /^Assistant/ }));
  await waitFor(() => expect(callsTo("save_ui_prefs").length).toBeGreaterThan(0));
  for (const c of callsTo("save_ui_prefs")) expect((c.prefs as UiPrefs).flowSidePanel.hidden).toBe(true);
  expect((callsTo("save_ui_prefs").slice(-1)[0].prefs as UiPrefs).flowSidePanel.tab).toBe("assistant");
  expect(s.pane().hidden).toBe(true);
});

test("code_editor_on_a_tab_opens_that_frame_and_glides_to_it", async () => {
  const s = setup();
  await opened(s);
  fireEvent.click(hideButton(s));
  await pick(s, "Refund");
  const fit = vi.spyOn(canvas.instance!, "fitBounds");
  fireEvent.click(within(s.frameEl("Refund")!).getByRole("button", { name: /^Code Editor/ }));
  await waitFor(() => expect(s.pane().hidden).toBe(false));
  expect(screen.getByRole("tab", { name: /^Editor/ }).getAttribute("aria-selected")).toBe("true");
  expect(s.visible()).toContain("Ask > Refund it");
  expect(s.visible()).not.toContain("Cart");
  await waitFor(() => expect(fit).toHaveBeenCalled());
  const box = canvas.props!.nodes.find((n) => n.id === boardFrameId("Refund"))!;
  expect(fit.mock.calls.slice(-1)[0][0].x).toBe(box.position.x);
});

test("selecting_a_shape_bands_its_line", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  act(() => canvas.props!.onSelect!(["Refund it"]));
  await waitFor(() => expect(s.tabEl().querySelector(".cm-flow-band")?.textContent).toBe("Refund it"));
});

test("a_new_header_splits_the_shown_frame_and_the_pane_follows", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  // A header typed at the end of "Refund it" in the middle of the shown frame.
  const at = s.text().indexOf("Refund it\n") + "Refund it".length;
  s.type(at, '\ndiagram flow "Returns"');
  // The pane shows the part holding the selection; the canvas selects it; no typed text is hidden.
  // (The new frame sits off screen, where React Flow draws no node: the canvas's own data says what it selected.)
  await waitFor(() =>
    expect(canvas.props!.nodes.filter((n) => n.type === "boardFrame" && (n.data as { selected: boolean }).selected).map((n) => n.id)).toEqual([boardFrameId("Returns")]),
  );
  await waitFor(() => expect(s.visible()).toContain('diagram flow "Returns"'));
  expect(s.visible()).toContain("Ask > Refund it");
  expect(s.visible()).not.toContain('"Refund"');
  expect(s.view().state.selection.main.head).toBe(at + '\ndiagram flow "Returns"'.length);
  expect(s.gutter()[0]).toBe("1");
  // The new frame is placed beside the others, overlapping none.
  const boxOf = (k: string) => {
    const n = canvas.props!.nodes.find((x) => x.id === boardFrameId(k))!;
    return { x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) };
  };
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === boardFrameId("Returns"))).toBe(true));
  const r = boxOf("Returns");
  for (const k of ["Checkout", "Refund", "Shipping"]) {
    const o = boxOf(k);
    expect(r.x >= o.x + o.w || r.x + r.w <= o.x || r.y >= o.y + o.h || r.y + r.h <= o.y).toBe(true);
  }
});

test("an_undo_in_another_frame_shows_that_frame", async () => {
  const s = setup();
  await opened(s);
  // A move in Shipping, then Checkout selected: Ctrl+Z puts Shipping's move back and shows Shipping.
  await pick(s, "Shipping");
  act(() => canvas.props!.onSelect!(["Pack"]));
  fireEvent.keyDown(s.canvasEl(), { key: "ArrowRight", shiftKey: true });
  fireEvent.keyUp(s.canvasEl(), { key: "ArrowRight", shiftKey: true });
  await pick(s, "Checkout");
  const glide = vi.spyOn(canvas.instance!, "setCenter");
  fireEvent.keyDown(s.canvasEl(), { key: "z", ctrlKey: true });
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(true));
  await waitFor(() => expect(s.visible()).toContain("Pack > Send"));
  await waitFor(() => expect(glide).toHaveBeenCalled());
  // A text edit in Refund, then Checkout selected: an undo shows Refund with the text put back.
  await pick(s, "Refund");
  const at = s.text().indexOf("Refund it\n") + "Refund it".length;
  s.type(at, "\nWait");
  await pick(s, "Checkout");
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.isSelected("Refund")).toBe(true));
  await waitFor(() => expect(s.visible()).toContain("Ask > Refund it"));
  expect(s.text()).toBe(BOARD);
});

test("lines_are_frame_relative_everywhere", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Shipping");
  // A good drawing first, then line 4 of Shipping (line 14 of the file) breaks: the last drawing stays.
  const at = s.text().indexOf("Pack > Send") + "Pack > ".length;
  act(() => s.view().dispatch({ changes: { from: at, to: at + 4, insert: "Nowhere" }, userEvent: "input.type" }));
  const problems = await within(s.pane()).findByRole("region", { name: "Problems" });
  await waitFor(() => expect(within(problems).getByRole("button", { name: "Line 4" })).toBeTruthy());
  expect(s.gutter()).toEqual(["1", "2", "3", "4", "5"]);
  await waitFor(() => expect(s.tabEl().querySelector(".flow-stale")?.textContent).toContain("Fix line 4 "));
  fireEvent.click(within(problems).getByRole("button", { name: "Line 4" }));
  await waitFor(() => expect(flowEntry("board")?.line).toBe(4));
  expect(s.view().state.doc.lineAt(s.view().state.selection.main.head).number).toBe(14);
});

test("chips_insert_the_kind_syntax", async () => {
  const SEQ = 'diagram sequence "Login"\nApp -> Api\n';
  const s = setup({ text: [CHECKOUT, SEQ].join("\n"), layout: null });
  fireEvent.click(await within(s.tabEl()).findByRole("button", { name: "Sequence Login" }));
  await waitFor(() => expect(s.visible()).toContain("App -> Api"));
  const chips = within(s.pane()).getAllByRole("button", { name: /^Insert / });
  expect(chips.map((c) => [c.getAttribute("aria-label"), c.textContent])).toEqual([
    ["Insert message", "->"],
    ["Insert reply", "-->"],
    ["Insert label", ":"],
  ]);
  expect(within(s.pane()).getByRole("heading", { name: "Sequence" })).toBeTruthy();
  const end = s.text().indexOf("App -> Api") + "App -> Api".length;
  act(() => s.view().dispatch({ selection: EditorSelection.cursor(end) }));
  fireEvent.click(chips[2]);
  expect(s.text()).toContain("App -> Api: ");
});

test("problems_list_only_the_shown_frame", async () => {
  const text = [CHECKOUT.replace("Cart > Pay", "Cart > Gone"), REFUND, SHIPPING.replace("Pack > Send", "Pack > Lost")].join("\n");
  const s = setup({ text });
  await opened(s);
  await pick(s, "Shipping");
  const problems = await within(s.pane()).findByRole("region", { name: "Problems" });
  await waitFor(() => expect(problems.textContent).toContain("Lost"));
  expect(problems.textContent).not.toContain("Gone");
  expect(within(s.pane()).getByText("1 problem")).toBeTruthy();
});

test("a_problem_count_opens_its_frame", async () => {
  const s = setup({ text: [CHECKOUT, REFUND, SHIPPING.replace("Pack > Send", "Pack > Lost")].join("\n") });
  await opened(s);
  fireEvent.click(hideButton(s));
  await waitFor(() => expect(s.pane().hidden).toBe(true));
  const count = await within(s.frameEl("Shipping")!).findByRole("button", { name: "1 problem" });
  fireEvent.click(count);
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(true));
  await waitFor(() => expect(s.pane().hidden).toBe(false));
  expect(screen.getByRole("tab", { name: /^Editor/ }).getAttribute("aria-selected")).toBe("true");
  await waitFor(() => expect(s.visible()).toContain("Pack > Lost"));
});

test("a_problem_outside_every_frame_shows_a_banner", async () => {
  const frames = Array.from({ length: 51 }, (_, i) => `diagram flow "F${i}"\nA${i}\n`);
  const s = setup({ text: frames.join("\n"), layout: null });
  const banner = await within(s.tabEl()).findByText(MESSAGES.tooManyFrames, undefined, { timeout: 8000 });
  expect(banner.closest("[role=status]")).not.toBeNull();
  expect(banner.closest(".flow-pane-draw")).not.toBeNull();
  // It is no frame's problem: the pane's list leaves it out.
  expect(s.pane().querySelector(".flow-problems")?.textContent ?? "").not.toContain(MESSAGES.tooManyFrames);
});

test("an_old_er_frame_lists_its_rewrite_fix", async () => {
  const s = setup({ text: [CHECKOUT, README_BILLING].join("\n"), layout: null });
  const er = await within(s.tabEl()).findByRole("button", { name: /^ER diagram / });
  fireEvent.click(er);
  const problems = await within(s.pane()).findByRole("region", { name: "Problems" });
  const fix = (await within(problems).findAllByRole("button", { name: "Rewrite as table blocks" }))[0];
  expect(within(problems).queryByText(/Cart/)).toBeNull();
  fireEvent.click(fix);
  await waitFor(() => expect(s.text()).toContain("customers {\n"));
  expect(s.text().startsWith(CHECKOUT)).toBe(true);
});

test("ctrl_b_toggles_the_pane", async () => {
  const s = setup();
  await opened(s);
  fireEvent.keyDown(s.canvasEl(), { key: "b", ctrlKey: true });
  await waitFor(() => expect(s.pane().hidden).toBe(true));
  fireEvent.keyDown(s.canvasEl(), { key: "b", ctrlKey: true });
  await waitFor(() => expect(s.pane().hidden).toBe(false));
});

test("the_pending_count_moves_to_ask", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  replies = [
    answer([
      { index: 0, op: { add_node: { name: "Wait", kind: "step" } }, status: ok, dependsOn: [], frame: "Refund" },
      { index: 1, op: { add_node: { name: "Check", kind: "step" } }, status: ok, dependsOn: [], frame: "Refund" },
    ]),
  ];
  fireEvent.click(within(s.tabEl()).getByRole("button", { name: "Ask" }));
  const box = await screen.findByRole("textbox", { name: "Describe a change" });
  fireEvent.change(box, { target: { value: "Add two steps" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByRole("region", { name: "Changes to review" });
  fireEvent.click(hideButton(s));
  await waitFor(() => expect(s.pane().hidden).toBe(true));
  expect(s.tabEl().querySelector(".srail, .rbadge")).toBeNull();
  const ask = within(s.tabEl()).getByRole("button", { name: "Ask" });
  expect(ask.textContent).toContain("2");
  const chat = within(s.frameEl("Refund")!).getByRole("button", { name: /^AI Chat/ });
  expect(chat.textContent).toContain("2");
});

test("a_frame_switch_waits_while_the_assistant_holds_the_text", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  replies = [answer([{ index: 0, op: { add_node: { name: "Wait", kind: "step" } }, status: ok, dependsOn: [], frame: "Refund" }])];
  fireEvent.click(within(s.tabEl()).getByRole("button", { name: "Ask" }));
  const box = await screen.findByRole("textbox", { name: "Describe a change" });
  fireEvent.change(box, { target: { value: "Add a step" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByRole("region", { name: "Changes to review" });
  // The proposal's glide (Plan D Task 12) fits the frame it changes; zoom out around the live frame so every frame's tab is drawn again.
  await act(async () => {
    await canvas.instance!.setViewport({ x: 400, y: 100, zoom: 0.25 });
  });
  // A tab click, the pane (a reveal) and a right-click all leave Refund selected and say why.
  fireEvent.click(await s.tab("Shipping"));
  expect(await within(s.tabEl()).findByText(/The Assistant is working on this diagram/)).toBeTruthy();
  const pack = s.text().indexOf("Pack");
  act(() => s.view().dispatch({ selection: EditorSelection.cursor(pack), userEvent: "select.search" }));
  await new Promise((r) => setTimeout(r, 20));
  expect(s.isSelected("Refund")).toBe(true);
  expect(s.visible()).toContain("Ask > Refund it");
  expect(s.visible()).not.toContain("Pack");
  // Once the changes land, a switch goes through, and the Assistant's bands go with the frame they were for.
  fireEvent.click(within(screen.getByRole("region", { name: "Changes to review" })).getByRole("button", { name: /^Accept all/ }));
  await waitFor(() => expect(s.text()).toContain("Wait"));
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  await pick(s, "Shipping");
  expect(s.tabEl().querySelector(".cm-flow-band")).toBeNull();
});

test("a_header_typed_in_the_pane_switches_at_once", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  // Every canvas render: the frames drawn selected, and whether Refund's shapes are still live.
  const renders: { selected: string[]; refundLive: boolean }[] = [];
  canvas.seen = (p) =>
    renders.push({
      selected: p.nodes.filter((n) => n.type === "boardFrame" && (n.data as { selected: boolean }).selected).map((n) => n.id),
      refundLive: p.nodes.some((n) => n.id === "Ask"),
    });
  try {
    const at = s.text().indexOf("Refund it\n") + "Refund it".length;
    s.type(at, '\ndiagram flow "Returns"');
    await waitFor(() => expect(renders.some((r) => r.selected.includes(boardFrameId("Returns")))).toBe(true));
    // Typing in the pane is no canvas pick (Plan F Decision 12): the frame typed into is selected at once, never drawn
    // selected while Refund is still live.
    expect(renders.filter((r) => r.selected.includes(boardFrameId("Returns")) && r.refundLive)).toEqual([]);
  } finally {
    canvas.seen = null;
  }
});

test("renaming_the_shown_frame_keeps_its_selection", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  act(() => canvas.props!.onSelect!(["Ask"]));
  await waitFor(() => expect(canvas.props!.selection).toEqual(["Ask"]));
  // A rename typed in the header is the same frame: the shape selection stays (Figma keeps it on a page rename).
  const at = s.text().indexOf('"Refund"') + '"Refund'.length;
  s.type(at, "s");
  await waitFor(() => expect(s.isSelected("Refunds")).toBe(true));
  await new Promise((r) => setTimeout(r, 20));
  expect(canvas.props!.selection).toEqual(["Ask"]);
  expect(s.visible()).toContain('"Refunds"');
  // A real switch still lets it go.
  await pick(s, "Shipping");
  await waitFor(() => expect(canvas.props!.selection ?? []).toEqual([]));
});

test("a_canvas_edit_bands_the_line_it_wrote", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  // A line drawn on the canvas between two shapes: the pane bands the line the edit wrote.
  act(() => canvas.props!.onConnectPorts!({ node: "Refund it", port: "r" }, { node: "Ask", port: "l" }, false));
  await waitFor(() => expect(s.text()).toContain("Refund it > Ask"));
  await waitFor(() => expect(s.tabEl().querySelector(".cm-flow-band")?.textContent).toBe("Refund it > Ask"));
});

/** Shipping's Ask with one unclear word: the pick step, where the text is not held. */
const UNCLEAR: ProposedChange[] = [
  { index: 0, op: { add_node: { name: "Label", kind: "step" } }, status: ok, dependsOn: [], frame: "Shipping" },
  {
    index: 1,
    frame: "Shipping",
    op: { add_flow: { from: "the box", to: "Label" } },
    status: {
      kind: "ambiguous",
      field: "from",
      word: "the box",
      candidates: [
        { name: "Pack", id: null, line: 2, detail: "line 2" },
        { name: "Send", id: null, line: 3, detail: "line 3" },
      ],
    },
    dependsOn: [0],
  },
] as ProposedChange[];

test("a_switch_during_the_pick_step_is_refused", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Shipping");
  replies = [answer(UNCLEAR)];
  fireEvent.click(within(s.tabEl()).getByRole("button", { name: "Ask" }));
  const box = await screen.findByRole("textbox", { name: "Describe a change" });
  fireEvent.change(box, { target: { value: "Label the box" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(document.querySelectorAll(".pickrow").length).toBe(2));
  // The text is free to type in during the pick, but the run is Shipping's: a switch is refused with the note.
  expect(s.view().state.readOnly).toBe(false);
  // The proposal's glide (Plan D Task 12) fits the frame it changes; zoom out around the live frame so every frame's tab is drawn again.
  await act(async () => {
    await canvas.instance!.setViewport({ x: 400, y: 100, zoom: 0.25 });
  });
  fireEvent.click(await s.tab("Checkout"));
  expect(await within(s.tabEl()).findByText(/The Assistant is working on this diagram/)).toBeTruthy();
  expect(s.isSelected("Shipping")).toBe(true);
  // Pick, then try again from the review: the proposal draws in Shipping and lands there only.
  fireEvent.click(document.querySelectorAll(".pickrow")[0]);
  const card = await screen.findByRole("region", { name: "Changes to review" });
  // Out of the pick step the proposal glides to Shipping again: zoom out once more.
  await act(async () => {
    await canvas.instance!.setViewport({ x: 400, y: 100, zoom: 0.25 });
  });
  fireEvent.click(await s.tab("Checkout"));
  expect(s.isSelected("Shipping")).toBe(true);
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === "Label")).toBe(true));
  expect(canvas.props!.nodes.some((n) => n.id === "Cart")).toBe(false);
  fireEvent.click(within(card).getByRole("button", { name: /^Accept all/ }));
  await waitFor(() => expect(s.text()).toContain("Pack > Label"));
  const [checkout, refund, shipping] = s.text().split(/\n(?=diagram )/);
  expect(checkout).toBe(CHECKOUT);
  expect(refund).toBe(REFUND);
  expect(shipping).toContain("Label");
});

test("an_awaited_action_writes_nothing_after_a_switch", async () => {
  const ONE = 'diagram flow "One"\nX\nY\n';
  const TWO = 'diagram flow "Two"\nX\nY\n';
  const s = setup({ text: [ONE, TWO].join("\n"), layout: null });
  await opened(s, ["One", "Two"]);
  await pick(s, "One");
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === "X")).toBe(true));
  // One breaks: its last good drawing stays, so a line drawn on it first asks the worker which names are defined.
  s.type(s.text().indexOf("Y\n") + 1, "\nX > Nowhere");
  await waitFor(() => expect(s.tabEl().querySelector(".flow-stale")).not.toBeNull());
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const spans = s.client.flowSpans.bind(s.client);
  vi.spyOn(s.client, "flowSpans").mockImplementationOnce(async (...a: Parameters<typeof spans>) => {
    await gate;
    return spans(...a);
  });
  act(() => canvas.props!.onConnectPorts!({ node: "X", port: "r" }, { node: "Y", port: "l" }, false));
  // Two is selected while that answer is out: the line, planned for One, writes nothing into Two.
  await pick(s, "Two");
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(s.text().split(/\n(?=diagram )/)[1]).toBe(TWO);
  expect(s.text()).not.toContain("X > Y");
});

test("a_typed_frame_off_screen_comes_into_view_and_one_on_screen_does_not", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  const glide = vi.spyOn(canvas.instance!, "setCenter");
  // jsdom lays nothing out: the canvas measures 0, so every frame is off screen.
  s.type(s.text().indexOf("Refund it\n") + "Refund it".length, '\ndiagram flow "Returns"');
  await waitFor(() => expect(glide).toHaveBeenCalled());
  const returns = canvas.props!.nodes.find((n) => n.id === boardFrameId("Returns"))!;
  const [cx] = glide.mock.calls.slice(-1)[0];
  expect(cx).toBeGreaterThan(returns.position.x);
  // A canvas big enough to show the whole board: a frame typed now is on screen, and the view stays.
  glide.mockClear();
  const big = { x: -1e5, y: -1e5, left: -1e5, top: -1e5, right: 1e5, bottom: 1e5, width: 2e5, height: 2e5, toJSON: () => ({}) } as DOMRect;
  vi.spyOn(s.canvasEl(), "getBoundingClientRect").mockReturnValue(big);
  // Typed in the frame shown (Returns, the first part's lines stay with Refund).
  s.type(s.text().indexOf("Ask > Refund it") + "Ask > Refund it".length, '\ndiagram flow "Boxes"');
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.type === "boardFrame" && (n.data as { selected: boolean }).selected && n.id === boardFrameId("Boxes"))).toBe(true));
  await new Promise((r) => setTimeout(r, 100));
  expect(glide).not.toHaveBeenCalled();
});

test("a_hidden_frame_edit_says_why_it_was_not_made", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  // A Replace all reaching another frame is one edit: it is not made, and the strip says so.
  const pack = s.text().indexOf("Pack");
  act(() => s.view().dispatch({ changes: { from: pack, to: pack + 4, insert: "Box" }, userEvent: "input.replace.all" }));
  expect(s.text()).toBe(BOARD);
  expect(await within(s.tabEl()).findByText(/That edit reaches another diagram on this board/)).toBeTruthy();
});

test("the_group_chip_leaves_you_inside_the_braces_and_chips_wait_for_the_assistant", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  const end = s.text().indexOf("Ask > Refund it") + "Ask > Refund it".length;
  act(() => s.view().dispatch({ selection: EditorSelection.cursor(end) }));
  fireEvent.click(within(s.pane()).getByRole("button", { name: "Insert group" }));
  const head = s.view().state.selection.main.head;
  const line = s.view().state.doc.lineAt(head);
  expect(line.text).toBe("  ");
  expect(s.view().state.doc.line(line.number + 1).text).toBe("}");
  replies = [answer([{ index: 0, op: { add_node: { name: "Wait", kind: "step" } }, status: ok, dependsOn: [] }])];
  fireEvent.click(within(s.tabEl()).getByRole("button", { name: "Ask" }));
  const box = await screen.findByRole("textbox", { name: "Describe a change" });
  fireEvent.change(box, { target: { value: "Add a step" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByRole("region", { name: "Changes to review" });
  for (const chip of within(s.pane()).getAllByRole("button", { name: /^Insert /, hidden: true })) expect((chip as HTMLButtonElement).disabled).toBe(true);
});

test("typing_a_header_during_the_pick_step_keeps_the_text", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Shipping");
  replies = [answer(UNCLEAR)];
  fireEvent.click(within(s.tabEl()).getByRole("button", { name: "Ask" }));
  const box = await screen.findByRole("textbox", { name: "Describe a change" });
  fireEvent.change(box, { target: { value: "Label the box" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(document.querySelectorAll(".pickrow").length).toBe(2));
  // Typing always wins: a header typed in the pane switches to the new frame, and the next letter goes after it.
  const at = s.text().indexOf("Pack > Send") + "Pack > Send".length;
  s.type(at, '\ndiagram flow "X"');
  await waitFor(() => expect(s.visible()).toContain('diagram flow "X"'));
  s.type(s.view().state.selection.main.head, "\nZ");
  await waitFor(() => expect(s.visible()).toContain("Z"));
  expect(s.text()).toBe(BOARD.replace("Pack > Send\n", 'Pack > Send\ndiagram flow "X"\nZ\n'));
  expect(s.visible()).toContain('diagram flow "X"');
  // The waiting changes no longer fit the text: they are stale, and the frame is no longer held.
  expect(await screen.findByText("The text changed in the editor after the assistant answered, so none of these changes were applied.")).toBeTruthy();
  // The frame is let go: Checkout's tab (off screen now, so its node's own handler) switches again, with no lock note.
  act(() => (canvas.props!.nodes.find((n) => n.id === boardFrameId("Checkout"))!.data as { onSelect(): void }).onSelect());
  await waitFor(() => expect((canvas.props!.nodes.find((n) => n.id === boardFrameId("Checkout"))!.data as { selected: boolean }).selected).toBe(true));
  expect(within(s.tabEl()).queryByText(/The Assistant is working on this diagram/)).toBeNull();
});

test("tidy_after_a_switch_moves_nothing_in_the_new_frame", async () => {
  // Two frames with the same names: frame One's tidy, let go after Two is selected, must not move Two's X and Y.
  const ONE = 'diagram flow "One"\nX\nY\nX > Y\n';
  const TWO = 'diagram flow "Two"\nX\nY\nX > Y\n';
  const layout = JSON.stringify({
    version: 2,
    frames: {
      One: { at: { x: 0, y: 0 }, nodes: { X: { x: 300, y: 0 }, Y: { x: 0, y: 300 } }, style: "modern", direction: "TB" },
      Two: { at: { x: 900, y: 0 }, nodes: { X: { x: 300, y: 0 }, Y: { x: 0, y: 300 } }, style: "modern", direction: "TB" },
    },
    sketches: [],
  });
  const s = setup({ text: [ONE, TWO].join("\n"), layout });
  await opened(s, ["One", "Two"]);
  await pick(s, "One");
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const run = s.client.layout.bind(s.client);
  vi.spyOn(s.client, "layout").mockImplementationOnce(async (...a: Parameters<typeof run>) => {
    await gate;
    return run(...a);
  });
  fireEvent.click(within(s.tabEl()).getByRole("button", { name: "Reset layout" }));
  await pick(s, "Two");
  const at = () => JSON.stringify(canvas.props!.nodes.filter((n) => n.id === "X" || n.id === "Y").map((n) => [n.id, n.position]));
  const before = at();
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(at()).toBe(before);
});

test("backspace_at_a_header_is_silent", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Refund");
  const head = s.text().indexOf('diagram flow "Refund"');
  act(() => s.view().dispatch({ selection: EditorSelection.cursor(head) }));
  act(() => s.view().dispatch({ changes: { from: head - 1, to: head }, userEvent: "delete.backward" }));
  await new Promise((r) => setTimeout(r, 20));
  expect(s.text()).toBe(BOARD);
  expect(within(s.tabEl()).queryByText(/That edit reaches another diagram on this board/)).toBeNull();
});
