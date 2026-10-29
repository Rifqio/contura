// The review bar (Plan D Task 13, Decision 11, A8): it floats 8 px above the top right of the frames a proposal
// changes, follows pan and zoom inside the canvas, names those frames, and lands or drops the changes with Accept
// (Ctrl+Enter) and Reject (Ctrl+Backspace). On the canvas the keys act only on an event no canvas key took: a selected
// ER column (B3 decision 10) and a picked class member (CL1) keep their Ctrl+Enter. Each touched frame counts its own
// changes on its AI Chat button, and Ask counts the sum.
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactFlowInstance, ReactFlowProvider } from "@xyflow/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { withTurn } from "../../api/client";
import type { AiEvent, AiThread, AppendTurn, DiagramAskRequest, Preview, ProposedChange } from "../../api/types";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { done, sent } from "../../test/aiStream";
import { turnViewOf } from "../../test/aiThreads";
import { mockEditorDom } from "../../test/editor";
import { callsTo, routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import { GROQ } from "../../test/settingsRoutes";
import type { BoardAsk } from "../ai/useBoardAsk";
import FlowTab from "../FlowTab";
import type { FlowDocApi } from "../useFlowDoc";
import { tabHeight } from "./boardDetail";
import { FRAME_TAB_H, type FrameBox } from "./boardScene";
import ReviewBar, { placeReviewBar, REVIEW_GAP, reviewKeys, reviewText } from "./ReviewBar";

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
vi.mock("../ai/useBoardAsk", async (load) => {
  const real = await load<typeof import("../ai/useBoardAsk")>();
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
  "Cart",
  "Pay",
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
  'diagram class "Billing"',
  "class Invoice",
  "Invoice : + total: int",
  "",
].join("\n");
const TITLES = ["Checkout", "Orders ERD", "Refund", "Billing"];

type Sink = { onmessage: (e: AiEvent) => void };
let threads: AiThread[] = [];
let replies: AiEvent[][] = [];
const sinks: Sink[] = [];
const PREVIEW: Preview = { items: [], tables: { full: [], namesOnly: [], leftOut: [], reasons: [] }, totalBytes: 0, tokens: 0, exact: "", notes: [], log: [], context: null, rows: null };

beforeEach(() => {
  localStorage.clear();
  canvas.props = null;
  canvas.instance = null;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  threads = [];
  replies = [];
  sinks.length = 0;
  hooked.ai = null;
  hooked.doc = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The tab on the board, drawn, with its canvas ready. */
async function setup() {
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
      threads = [...threads.filter((x) => x.id !== v.threadId), withTurn(before, v)];
      return v;
    },
    save_ai_thread: (a) => ({ thread: a.thread as AiThread, topics: [], compactions: [] }),
    ai_known_models: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    ai_settings: () => ({ settings: { ...GROQ, diagramTool: true }, groupOverride: false, keySaved: true, keyLast4: "abcd" }),
    ai_diagram_preview: () => PREVIEW,
    ai_diagram_ask: (a) => {
      const sink = a.events as Sink;
      sinks.push(sink);
      const events = replies.shift() ?? [];
      setTimeout(() => events.forEach((e) => sink.onmessage(e)), 0);
      return null;
    },
    ai_cancel_place: () => true,
    ai_record_tool_result: (a) => a.outcome,
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>,
  );
  await waitFor(() => expect(hooked.doc?.parsed?.result.frames.map((f) => f.title)).toEqual(TITLES), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  /** The frame on the canvas whose tab names `title`. */
  const frameEl = (title: string) => [...utils.container.querySelectorAll<HTMLElement>(".board-frame")].find((f) => f.querySelector(".board-frame-name")?.textContent === title) ?? null;
  return { ...utils, view, text: () => view().state.doc.toString(), canvasEl, frameEl };
}

const asks = () => callsTo("ai_diagram_ask").map((c) => c.request as DiagramAskRequest);
const ai = () => hooked.ai!;

async function send(q: string) {
  const before = asks().length;
  fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
  const box = screen.getByRole("textbox", { name: "Describe a change" });
  fireEvent.change(box, { target: { value: q } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(asks().length).toBe(before + 1));
}

const okIn = (frame: string, index: number, op: ProposedChange["op"], dependsOn: number[] = []): ProposedChange => ({ index, op, status: { kind: "ok" }, dependsOn, frame });
const proposing = (changes: ProposedChange[]): AiEvent[] => [sent(), { type: "delta", text: "Here." }, { type: "proposal", proposal: { file: "board", baseHash: "b1", changes }, input: "{}" } as AiEvent, done()];
/** One change in Checkout, two in Refund. */
const THREE = [okIn("Checkout", 0, { add_node: { name: "Ship" } }), okIn("Refund", 1, { add_node: { name: "Refunded" } }), okIn("Refund", 2, { add_flow: { from: "Ask", to: "Refunded" } }, [1])];

/** Sends a proposal of `changes` from frame `title` and waits for its review. */
async function reviewing(changes: ProposedChange[] = THREE, title = "Checkout") {
  act(() => hooked.doc!.select({ title, index: TITLES.indexOf(title) }));
  replies = [proposing(changes)];
  await send("Add shipping and a refunded state");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  return await screen.findByRole("toolbar", { name: "Assistant changes" });
}

const ctrl = (key: string) => ({ key, ctrlKey: true });

// ----- The parts: the key rule, the words and the placement.

test("reviewKeys_reads_ctrl_enter_and_ctrl_backspace_by_the_a8_rule", () => {
  const key = (init: KeyboardEventInit, taken = false) => {
    const e = new KeyboardEvent("keydown", { ...init, cancelable: true });
    if (taken) e.preventDefault();
    return e;
  };
  const free = { inBar: false, typing: false };
  expect(reviewKeys(key(ctrl("Enter")), free)).toBe("accept");
  expect(reviewKeys(key({ key: "Enter", metaKey: true }), free)).toBe("accept");
  expect(reviewKeys(key(ctrl("Backspace")), free)).toBe("reject");
  expect(reviewKeys(key({ key: "Enter" }), free)).toBeNull();
  expect(reviewKeys(key({ key: "Enter", ctrlKey: true, altKey: true }), free)).toBeNull();
  expect(reviewKeys(key({ key: "Enter", ctrlKey: true, shiftKey: true }), free)).toBeNull();
  // A canvas key took it: only the bar still acts on it.
  expect(reviewKeys(key(ctrl("Enter"), true), free)).toBeNull();
  expect(reviewKeys(key(ctrl("Enter"), true), { inBar: true, typing: false })).toBe("accept");
  // Typing in the composer or the code pane keeps its keys.
  expect(reviewKeys(key(ctrl("Enter")), { inBar: false, typing: true })).toBeNull();
  expect(reviewKeys(key(ctrl("Backspace")), { inBar: false, typing: true })).toBeNull();
});

test("the_bar_names_the_touched_frames", async () => {
  expect(reviewText(["Checkout"], 1)).toBe("1 change in Checkout");
  expect(reviewText(["Checkout", "Refund"], 3)).toBe("3 changes in Checkout and Refund");
  expect(reviewText(["Checkout", "Refund", "Shipping"], 1200)).toBe("1,200 changes in 3 diagrams");
  expect(reviewText([""], 2)).toBe("2 changes in Untitled");

  // On the tab: the frames the changes are in, Reject, then Accept all.
  const s = await setup();
  const bar = await reviewing();
  expect(bar.textContent).toContain("3 changes in Checkout and Refund");
  expect(within(bar).getAllByRole("button")).toEqual([within(bar).getByRole("button", { name: "Reject" }), within(bar).getByRole("button", { name: "Accept all" })]);
  // A change taken out counts down and Accept names what lands.
  act(() => ai().reject(0));
  await waitFor(() => expect(bar.textContent).toContain("2 changes in Refund"));
  expect(within(bar).getByRole("button", { name: /^Accept 2/ })).toBeTruthy();
  // Accept lands the rest; the bar goes.
  fireEvent.click(within(bar).getByRole("button", { name: /^Accept 2/ }));
  expect(ai().waiting).toBeNull();
  expect(s.text()).toContain("Ask > Refunded");
  expect(s.text()).not.toContain("Ship");
  expect(screen.queryByRole("toolbar", { name: "Assistant changes" })).toBeNull();
  // The old strip over the code pane is gone on boards.
  expect(s.container.querySelector(".flow-ebar")).toBeNull();
});

test("the_bar_hides_while_the_remove_question_is_open", async () => {
  const s = await setup();
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  replies = [proposing(["Cart", "Pay"].map((t, i) => okIn("Checkout", i, { remove_node: { target: t } })).concat(["Ask", "Refund it"].map((t, i) => okIn("Refund", i + 2, { remove_node: { target: t } }))))];
  await send("Start over");
  await waitFor(() => expect(ai().waiting?.step).toBe("remove"));
  expect(screen.queryByRole("toolbar", { name: "Assistant changes" })).toBeNull();
  expect(s.container.querySelector(".flow-ebar")).toBeNull();
});

test("the_bar_follows_pan_and_zoom_and_stays_inside", async () => {
  // Its right edge on the frames' right edge, REVIEW_GAP above their tabs; held REVIEW_GAP inside the canvas.
  const bounds = { w: 800, h: 600 };
  expect(placeReviewBar({ x: 500, y: 300 }, { w: 240, h: 36 }, bounds)).toEqual({ x: 260, y: 300 - REVIEW_GAP - 36 });
  expect(placeReviewBar({ x: 100, y: 300 }, { w: 240, h: 36 }, bounds)).toEqual({ x: REVIEW_GAP, y: 256 });
  // No room above the frames: it flips below them.
  expect(placeReviewBar({ x: 5000, y: 20 }, { w: 240, h: 36 }, bounds, 200)).toEqual({ x: 800 - REVIEW_GAP - 240, y: 200 + REVIEW_GAP });
  expect(placeReviewBar({ x: 500, y: 9000 }, { w: 240, h: 36 }, bounds, 9500)).toEqual({ x: 260, y: 600 - REVIEW_GAP - 36 });
  // The chrome's room: never above its top or below its bottom; frames filling the view keep it at the room's top.
  const room = { top: 62, bottom: 480 };
  expect(placeReviewBar({ x: 500, y: 50 }, { w: 240, h: 36 }, bounds, 300, room)).toEqual({ x: 260, y: 308 });
  expect(placeReviewBar({ x: 500, y: -400 }, { w: 240, h: 36 }, bounds, -100, room)).toEqual({ x: 260, y: 62 });
  expect(placeReviewBar({ x: 500, y: 40 }, { w: 240, h: 36 }, bounds, 2000, room)).toEqual({ x: 260, y: 62 });
  expect(placeReviewBar({ x: 500, y: 9000 }, { w: 240, h: 36 }, bounds, 9500, room)).toEqual({ x: 260, y: 480 - 36 });

  await setup();
  const bar = await reviewing();
  // The touched frames' union on the board, their tabs included.
  const boxes = canvas.props!.nodes.filter((n) => n.type === "boardFrame" && ((n.data as { pending?: number }).pending ?? 0) > 0).map((n) => (n.data as { box: FrameBox }).box);
  expect(boxes.map((b) => b.title).sort()).toEqual(["Checkout", "Refund"]);
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  // The tabs' top: the strip keeps its screen height below 100 percent (Plan F Decision 5).
  const top = (zoom: number) => Math.min(...boxes.map((b) => b.y)) - tabHeight(zoom);
  const at = () => ({ x: Number.parseFloat(bar.style.left), y: Number.parseFloat(bar.style.top) });
  // jsdom lays nothing out: the bar measures 0 by 0, so its corner is the anchor less the gap.
  for (const [zoom, x, y] of [
    [0.5, 400, 300],
    [1, 500, 420],
  ]) {
    await act(async () => {
      await canvas.instance!.setViewport({ x: x - right * zoom, y: y - top(zoom) * zoom, zoom });
    });
    await waitFor(() => expect(at()).toEqual({ x, y: y - REVIEW_GAP }));
  }
  // Panned far away, it stays inside the canvas.
  await act(async () => {
    await canvas.instance!.setViewport({ x: -100_000, y: 100_000, zoom: 1 });
  });
  await waitFor(() => expect(at()).toEqual({ x: REVIEW_GAP, y: 600 - REVIEW_GAP }));
});

test("the_bar_is_announced_and_is_the_next_tab_stop", async () => {
  const s = await setup();
  const bar = await reviewing();
  // Announced once in the tab's own polite live region, which stays in the page; the bar holds none. Focus stays out.
  const live = s.container.querySelector("[data-review-said]")!;
  expect(live.getAttribute("aria-live")).toBe("polite");
  await waitFor(() => expect(live.textContent).toBe("3 changes in Checkout and Refund"));
  expect(bar.querySelector("[aria-live]")).toBeNull();
  expect(bar.contains(document.activeElement)).toBe(false);
  // A change taken out does not announce again.
  act(() => ai().reject(0));
  await waitFor(() => expect(bar.textContent).toContain("2 changes in Refund"));
  expect(live.textContent).toBe("3 changes in Checkout and Refund");
  // The next tab stop after the board toolbar's.
  const tabbable = [...s.container.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, [tabindex]")].filter((e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled);
  const tools = screen.getByRole("toolbar", { name: "Board tools" });
  const i = tabbable.findIndex((e) => tools.contains(e));
  expect(tabbable.filter((e) => tools.contains(e))).toHaveLength(1);
  expect(bar.contains(tabbable[i + 1])).toBe(true);
  // One tab stop in the bar; the arrow keys move along it (WAI-ARIA toolbar).
  expect(tabbable.filter((e) => bar.contains(e))).toHaveLength(1);
  const [reject, accept] = within(bar).getAllByRole("button");
  act(() => reject.focus());
  fireEvent.keyDown(reject, { key: "ArrowRight" });
  expect(document.activeElement).toBe(accept);
  expect(accept.tabIndex).toBe(0);
  expect(reject.tabIndex).toBe(-1);
  expect(accept.getAttribute("aria-keyshortcuts")).toBe("Control+Enter Meta+Enter");
  expect(reject.getAttribute("aria-keyshortcuts")).toBe("Control+Backspace Meta+Backspace");
});

/** Gives the board toolbar, the bottom stack and the bar the boxes a laid-out canvas would; jsdom lays nothing out. */
function laidOut(boxes: { toolbar?: [number, number]; bottom?: [number, number]; bar: [number, number] }) {
  const real = Element.prototype.getBoundingClientRect;
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} }) as DOMRect;
    if (this.classList.contains("board-toolbar") && boxes.toolbar) return box(300, boxes.toolbar[0], 200, boxes.toolbar[1] - boxes.toolbar[0]);
    if (this.classList.contains("board-bottom") && boxes.bottom) return box(300, boxes.bottom[0], 200, boxes.bottom[1] - boxes.bottom[0]);
    if (this.classList.contains("board-review")) return box(0, 0, boxes.bar[0], boxes.bar[1]);
    return real.call(this);
  });
}

test("the_bar_never_sits_under_the_toolbar_and_flips_below_the_frames", async () => {
  // The toolbar 12 to 54 px down, the bottom stack 540 to 588, the bar 240 by 36.
  const boxes = laidOut({ toolbar: [12, 54], bottom: [540, 588], bar: [240, 36] });
  try {
    await setup();
    const bar = await reviewing();
    const frames = canvas.props!.nodes.filter((n) => n.type === "boardFrame" && ((n.data as { pending?: number }).pending ?? 0) > 0).map((n) => (n.data as { box: FrameBox }).box);
    const right = Math.max(...frames.map((b) => b.x + b.w));
    // The tabs' top at the zoom these views use (Plan F Decision 5).
    const top = Math.min(...frames.map((b) => b.y)) - tabHeight(0.25);
    const bottom = Math.max(...frames.map((b) => b.y + b.h));
    const at = () => ({ x: Number.parseFloat(bar.style.left), y: Number.parseFloat(bar.style.top) });
    const view = async (zoom: number, x: number, tabTop: number) => {
      await act(async () => {
        await canvas.instance!.setViewport({ x: x - right * zoom, y: tabTop - top * zoom, zoom });
      });
    };
    // A fit view: the top frame's tab 40 to 60 px down. Above it the bar would be under the toolbar: it flips below.
    for (const tabTop of [40, 50, 60]) {
      await view(0.25, 500, tabTop);
      const below = tabTop + (bottom - top) * 0.25 + REVIEW_GAP;
      await waitFor(() => expect(at()).toEqual({ x: 260, y: below }));
      expect(at().y).toBeGreaterThanOrEqual(54 + REVIEW_GAP);
    }
    // Room above, clear of the toolbar: above the frames.
    await view(0.25, 500, 200);
    await waitFor(() => expect(at()).toEqual({ x: 260, y: 200 - REVIEW_GAP - 36 }));
    // The frames above the view: at the top of the room, below the toolbar.
    await view(0.25, 500, -2000);
    await waitFor(() => expect(at()).toEqual({ x: 260, y: 54 + REVIEW_GAP }));
    // The frames below the view: above the bottom stack.
    await view(0.25, 500, 5000);
    await waitFor(() => expect(at()).toEqual({ x: 260, y: 540 - REVIEW_GAP - 36 }));
  } finally {
    boxes.mockRestore();
  }
});

test("below_100_percent_the_bar_sits_above_the_tab_strip", async () => {
  // Final review I1: the tab strip keeps its 30 screen px below 100 percent (Plan F Decision 5), so the bar's bottom
  // sits REVIEW_GAP above the strip's top at any zoom, never over the frame's title and its AI Chat count.
  const boxes = laidOut({ bar: [240, 36] });
  try {
    await setup();
    const bar = await reviewing();
    const frames = canvas.props!.nodes.filter((n) => n.type === "boardFrame" && ((n.data as { pending?: number }).pending ?? 0) > 0).map((n) => (n.data as { box: FrameBox }).box);
    const right = Math.max(...frames.map((b) => b.x + b.w));
    const boxTop = Math.min(...frames.map((b) => b.y));
    const barBottom = () => Number.parseFloat(bar.style.top) + 36;
    for (const zoom of [0.5, 0.2]) {
      // The frames' top 300 px down the canvas; their strip FRAME_TAB_H screen px above that.
      await act(async () => {
        await canvas.instance!.setViewport({ x: 500 - right * zoom, y: 300 - boxTop * zoom, zoom });
      });
      const stripTop = 300 - FRAME_TAB_H;
      await waitFor(() => expect(barBottom()).toBe(stripTop - REVIEW_GAP));
      expect(barBottom()).toBeLessThan(stripTop);
    }
  } finally {
    boxes.mockRestore();
  }
});

test("chrome_that_mounts_after_the_bar_is_kept_clear_of", async () => {
  // Task 13's parked minor: the overview (a one-frame board's) or any other chrome drawn after the bar mounted is
  // measured as it comes, not on the next canvas resize. The overview here mounts 500 to 580 px down.
  const boxes = laidOut({ toolbar: [12, 54], bar: [240, 36] });
  const real = boxes.getMockImplementation()!;
  boxes.mockImplementation(function (this: Element) {
    if (this.classList.contains("react-flow__minimap")) return { x: 600, y: 500, left: 600, top: 500, width: 180, height: 80, right: 780, bottom: 580, toJSON() {} } as DOMRect;
    return real.call(this);
  });
  try {
    await setup();
    const bar = await reviewing();
    const frames = canvas.props!.nodes.filter((n) => n.type === "boardFrame" && ((n.data as { pending?: number }).pending ?? 0) > 0).map((n) => (n.data as { box: FrameBox }).box);
    const right = Math.max(...frames.map((b) => b.x + b.w));
    const top = Math.min(...frames.map((b) => b.y)) - tabHeight(0.25);
    // The frames below the view: the bar keeps to the bottom of the room.
    await act(async () => {
      await canvas.instance!.setViewport({ x: 500 - right * 0.25, y: 5000 - top * 0.25, zoom: 0.25 });
    });
    const y = () => Number.parseFloat(bar.style.top);
    await waitFor(() => expect(y()).toBeGreaterThan(500));
    const flow = bar.closest(".flow-canvas")!;
    const overview = document.createElement("div");
    overview.className = "react-flow__minimap";
    act(() => void flow.appendChild(overview));
    await waitFor(() => expect(y()).toBe(500 - REVIEW_GAP - 36));
    // And when it goes, the room is the canvas's again.
    act(() => overview.remove());
    await waitFor(() => expect(y()).toBeGreaterThan(500));
  } finally {
    boxes.mockRestore();
  }
});

test("accept_from_the_bar_hands_focus_to_the_canvas_and_ctrl_z_takes_it_back", async () => {
  const s = await setup();
  let bar = await reviewing();
  const accept = within(bar).getByRole("button", { name: "Accept all" });
  act(() => accept.focus());
  fireEvent.keyDown(accept, ctrl("Enter"));
  expect(ai().waiting).toBeNull();
  expect(s.text()).toContain("Ship");
  expect(document.activeElement).toBe(s.canvasEl());
  // Straight after, Ctrl+Z on the canvas undoes the landing in one step.
  fireEvent.keyDown(document.activeElement!, ctrl("z"));
  await waitFor(() => expect(s.text()).toBe(BOARD));
  // A click on Reject does the same; a key elsewhere (here the canvas's own Ctrl+Backspace) moves nothing.
  bar = await reviewing();
  const reject = within(bar).getByRole("button", { name: "Reject" });
  act(() => reject.focus());
  fireEvent.click(reject);
  expect(ai().waiting).toBeNull();
  expect(document.activeElement).toBe(s.canvasEl());
  await reviewing();
  const composer = screen.getByRole("textbox", { name: "Describe a change" });
  act(() => composer.focus());
  fireEvent.click(within(screen.getByRole("toolbar", { name: "Assistant changes" })).getByRole("button", { name: "Reject" }));
  expect(document.activeElement).toBe(composer);
});

test("ctrl_enter_accepts_on_the_canvas_with_no_column_selected", async () => {
  const s = await setup();
  await reviewing();
  fireEvent.keyDown(s.canvasEl(), ctrl("Enter"));
  expect(ai().waiting).toBeNull();
  expect(s.text()).toContain("Ship");
  expect(s.text()).toContain("Ask > Refunded");
});

test("with_a_column_selected_ctrl_enter_keeps_b3s_meaning", async () => {
  // B3 decision 10 (verified): a selected column takes Ctrl+Enter (erCanvas `onKey`, Duplicate). Under the review's
  // lock it writes nothing, but it still takes the key, so the changes do not land behind the user's back.
  const s = await setup();
  act(() => hooked.doc!.select({ title: "Orders ERD", index: 1 }));
  const row = () => [...s.container.querySelectorAll<HTMLElement>('[aria-label="Table orders"] .fkind-er-row')].find((r) => r.querySelector(".fkind-col")?.textContent === "id")!;
  await waitFor(() => expect(row()).toBeTruthy());
  fireEvent.click(row());
  await waitFor(() => expect(row().classList.contains("is-selected")).toBe(true));
  await reviewing([okIn("Orders ERD", 0, { add_column: { table: "orders", name: "status", type: "text" } })], "Orders ERD");
  expect(row().classList.contains("is-selected")).toBe(true);
  const text = s.text();
  const e = new KeyboardEvent("keydown", { ...ctrl("Enter"), bubbles: true, cancelable: true });
  act(() => void s.canvasEl().dispatchEvent(e));
  expect(e.defaultPrevented).toBe(true);
  expect(ai().waiting?.step).toBe("review");
  expect(s.text()).toBe(text);
});

test("with_a_class_member_picked_ctrl_enter_keeps_cl1s_meaning", async () => {
  // CL1 (A8): a picked class member takes Ctrl+Enter (FlowTab `memberKey`, copy below) before the review does.
  const s = await setup();
  act(() => hooked.doc!.select({ title: "Billing", index: 3 }));
  const card = () => [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === "Invoice") ?? null;
  await waitFor(() => expect(card()?.querySelector('[data-row="0"]')).toBeTruthy());
  fireEvent.doubleClick(card()!.querySelector('[data-row="0"]')!);
  const box = (await screen.findByLabelText("Member", { selector: "input, textarea" })) as HTMLInputElement;
  // Kept unchanged: the member stays picked.
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Member" })).toBeNull());
  await reviewing([okIn("Billing", 0, { add_node: { name: "Receipt" } })], "Billing");
  const text = s.text();
  const e = new KeyboardEvent("keydown", { ...ctrl("Enter"), bubbles: true, cancelable: true });
  act(() => void s.canvasEl().dispatchEvent(e));
  expect(e.defaultPrevented).toBe(true);
  expect(ai().waiting?.step).toBe("review");
  expect(s.text()).toBe(text);
});

test("ctrl_enter_in_the_bar_accepts_even_with_a_column_selected", async () => {
  const s = await setup();
  act(() => hooked.doc!.select({ title: "Orders ERD", index: 1 }));
  const row = () => [...s.container.querySelectorAll<HTMLElement>('[aria-label="Table orders"] .fkind-er-row')].find((r) => r.querySelector(".fkind-col")?.textContent === "id")!;
  await waitFor(() => expect(row()).toBeTruthy());
  fireEvent.click(row());
  await waitFor(() => expect(row().classList.contains("is-selected")).toBe(true));
  const bar = await reviewing([okIn("Orders ERD", 0, { add_column: { table: "orders", name: "status", type: "text" } })], "Orders ERD");
  const reject = within(bar).getAllByRole("button")[0];
  fireEvent.keyDown(reject, ctrl("Enter"));
  expect(ai().waiting).toBeNull();
  expect(s.text()).toContain("status");
});

test("ctrl_backspace_rejects", async () => {
  const s = await setup();
  await reviewing();
  fireEvent.keyDown(s.canvasEl(), ctrl("Backspace"));
  expect(ai().waiting).toBeNull();
  expect(s.text()).toBe(BOARD);
  // In the bar too.
  const bar = await reviewing();
  fireEvent.keyDown(within(bar).getAllByRole("button")[1], ctrl("Backspace"));
  expect(ai().waiting).toBeNull();
  expect(s.text()).toBe(BOARD);
});

test("keys_do_nothing_while_typing_in_the_composer_or_pane", async () => {
  const s = await setup();
  await reviewing();
  const composer = screen.getByRole("textbox", { name: "Describe a change" });
  for (const k of ["Enter", "Backspace"]) fireEvent.keyDown(composer, ctrl(k));
  expect(ai().waiting?.step).toBe("review");
  const pane = s.container.querySelector(".cm-content") as HTMLElement;
  for (const k of ["Enter", "Backspace"]) fireEvent.keyDown(pane, ctrl(k));
  expect(ai().waiting?.step).toBe("review");
  expect(s.text()).toBe(BOARD);
});

test("each_touched_frame_shows_its_count_on_ai_chat", async () => {
  const s = await setup();
  await reviewing();
  const chat = (title: string) => within(s.frameEl(title)!).queryByRole("button", { name: /^AI Chat/ });
  // Each touched frame counts its own, selected or not; an untouched frame shows no AI Chat unless selected.
  await waitFor(() => expect(chat("Refund")?.querySelector(".board-frame-pending")?.textContent).toBe("2"));
  expect(chat("Checkout")?.querySelector(".board-frame-pending")?.textContent).toBe("1");
  expect(chat("Orders ERD")).toBeNull();
  // The untouched, unselected frame shows no Code Editor either: only the count is added.
  expect(within(s.frameEl("Refund")!).queryByRole("button", { name: /^Code Editor/ })).toBeNull();
  // Ask counts the sum.
  expect(screen.getByRole("button", { name: "Ask" }).querySelector(".board-ask-count")?.textContent).toBe("3");
  // AI Chat on a touched frame opens the Assistant.
  fireEvent.click(screen.getByRole("tab", { name: /^Editor/ }));
  fireEvent.click(chat("Refund")!);
  expect(screen.getByRole("tab", { name: /^Assistant/ }).getAttribute("aria-selected")).toBe("true");
});

test("the_bar_alone_renders_its_parts", () => {
  const onAccept = vi.fn();
  const onReject = vi.fn();
  render(
    <ReactFlowProvider>
      <ReviewBar titles={["Checkout"]} count={1} label="Accept all" at={{ x: 300, y: 200 }} onAccept={onAccept} onReject={onReject} />
    </ReactFlowProvider>,
  );
  const bar = screen.getByRole("toolbar", { name: "Assistant changes" });
  fireEvent.click(within(bar).getByRole("button", { name: "Reject" }));
  expect(onReject).toHaveBeenCalledTimes(1);
  fireEvent.click(within(bar).getByRole("button", { name: "Accept all" }));
  expect(onAccept).toHaveBeenCalledTimes(1);
});
