// Plan F Task 5 (Decision 12, ruling 6): a frame switch in two paints. The first paint shows the picked frame
// selected, its shapes still static; the live shapes come one paint later. Keys pressed in the gap act on the picked
// frame, in order, never on the frame left; a switch also lets the strip's notice go (B3 L2).
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { splitFrames } from "../../lang/flow/board";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import type { FrameSelection } from "../useFlowDoc";
import { boardFrameId, inFrameId } from "./boardScene";
import { pictureShapes } from "../../test/framePictures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

// The real canvas draws; the test keeps its latest props and its React Flow instance, and every node id it was ever handed.
const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null, ever: null as Set<string> | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      if (canvas.ever) for (const n of p.nodes) canvas.ever.add(n.id);
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

// Every `doc.select` FlowTab makes, in order.
const selects = vi.hoisted(() => ({ calls: [] as (FrameSelection | null)[], wrapped: new WeakMap<object, unknown>() }));
vi.mock("../useFlowDoc", async (load) => {
  const real = await load<typeof import("../useFlowDoc")>();
  return {
    ...real,
    useFlowDoc: (...a: Parameters<typeof real.useFlowDoc>) => {
      const d = real.useFlowDoc(...a);
      let select = selects.wrapped.get(d.select) as typeof d.select | undefined;
      if (!select) {
        const inner = d.select;
        select = (sel) => {
          selects.calls.push(sel);
          inner(sel);
        };
        selects.wrapped.set(d.select, select);
      }
      return { ...d, select };
    },
  };
});

// The Assistant's lock, forced on by a test: a switch is refused while it holds the text.
const lock = vi.hoisted(() => ({ on: false }));
vi.mock("../ai/useBoardAsk", async (load) => {
  const real = await load<typeof import("../ai/useBoardAsk")>();
  return {
    ...real,
    useBoardAsk: (...a: Parameters<typeof real.useBoardAsk>) => {
      const ai = real.useBoardAsk(...a);
      return lock.on ? { ...ai, locked: true } : ai;
    },
  };
});

// The system clipboard; `hang` makes a read that never answers (a stuck clipboard plugin).
const clip = vi.hoisted(() => ({ hang: false }));
vi.mock("../../grid/clipboard", async (load) => {
  const real = await load<typeof import("../../grid/clipboard")>();
  return { ...real, readClipboard: () => (clip.hang ? new Promise<string | null>(() => {}) : Promise.resolve(null)) };
});

let reduce = true;
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  canvas.instance = null;
  canvas.ever = null;
  selects.calls = [];
  lock.on = false;
  clip.hang = false;
  reduce = true;
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\n';
const BOARD = [CHECKOUT, REFUND, SHIPPING].join("\n");
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Refund: { at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Shipping: { at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
  },
  sketches: [],
});

function setup(initial = BOARD, layout: string | null = LAYOUT) {
  const saved = { text: initial, layout };
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
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>,
  );
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const props = () => canvas.props!;
  const inst = () => canvas.instance!;
  const ids = () => props().nodes.map((n) => n.id);
  const nodeOf = (id: string) => props().nodes.find((n) => n.id === id);
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const text = () => view().state.doc.toString();
  /** Frame `i`'s block of the text, trimmed. */
  const frame = (i: number) => {
    const t = text();
    const f = splitFrames(t)[i];
    return t.slice(f.from, f.to).trim();
  };
  const frameEl = (key: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === boardFrameId(key)) ?? null;
  /** A frame drawn selected: its ring and its tab's buttons (the Code Editor button shows on the selected tab only). */
  const isSelected = (key: string) => {
    const el = frameEl(key);
    return !!el && within(el).queryByRole("button", { name: /^Code Editor/ }) !== null;
  };
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  /** A click on the canvas at a flow position. */
  const clickAt = (flow: { x: number; y: number }) => {
    const s = inst().flowToScreenPosition(flow);
    const pane = utils.container.querySelector(".react-flow__pane") as HTMLElement;
    fireEvent.click(pane, { clientX: s.x, clientY: s.y });
  };
  /** A click on static shape `name` of frame `key`. */
  const clickShape = (key: string, name: string) => {
    const box = nodeOf(boardFrameId(key))!;
    const n = nodeOf(inFrameId(key, name))!;
    clickAt({ x: box.position.x + n.position.x + 10, y: box.position.y + n.position.y + 10 });
  };
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const notice = () => strip().querySelector(".flow-notice")?.textContent ?? "";
  const tab = (title: RegExp | string) => screen.findByRole("button", { name: title });
  /** FlowTab drawn again with the same props (a forced lock read in its render). */
  const redraw = () =>
    utils.rerender(
      <div style={{ width: 1280, height: 800 }}>
        <FlowTab name="board" client={client} />
      </div>,
    );
  return { ...utils, client, redraw, saved, canvasEl, props, inst, ids, nodeOf, view, text, frame, frameEl, isSelected, press, clickAt, clickShape, notice, tab };
}
type Setup = ReturnType<typeof setup>;

/** The board drawn: every frame's tab is on the page and the canvas has its instance. */
async function opened(s: Setup, titles: (string | RegExp)[] = ["Flowchart Checkout", "Flowchart Refund", "Flowchart Shipping"]) {
  for (const t of titles) await s.tab(t);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

/** Selects a frame by its tab and waits for its shapes to be live. */
async function pick(s: Setup, title: string, first: string) {
  fireEvent.click(await s.tab(`Flowchart ${title}`));
  await waitFor(() => expect(s.ids()).toContain(first));
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
}

/** One paint: an animation frame, then a task, as the switch waits. */
async function nextPaint() {
  await act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  });
}

/** The first paint after a click on frame `to`'s tab or shape: `to` drawn selected with its shapes static, `from` still live. */
function inTheGap(s: Setup, from: { title: string; shape: string }, to: { title: string; shape: string }) {
  expect(s.isSelected(to.title)).toBe(true);
  expect(s.isSelected(from.title)).toBe(false);
  expect(s.ids()).toContain(inFrameId(to.title, to.shape));
  expect(s.ids()).not.toContain(to.shape);
  expect(s.ids()).toContain(from.shape);
  expect(selects.calls).toEqual([]);
}

async function switchesInTwoPaints() {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  selects.calls = [];
  fireEvent.click(await s.tab("Flowchart Refund"));
  // The first commit: the ring and the tab on Refund, its shapes static; Checkout still live; nothing selected yet.
  inTheGap(s, { title: "Checkout", shape: "Cart" }, { title: "Refund", shape: "Ask" });
  await nextPaint();
  await waitFor(() => expect(s.ids()).toContain("Ask"));
  expect(selects.calls).toEqual([{ title: "Refund", index: 1 }]);
  expect(s.ids()).toContain(inFrameId("Checkout", "Cart"));
  expect(s.ids()).not.toContain("Cart");
  expect(s.isSelected("Refund")).toBe(true);
  expect(s.isSelected("Checkout")).toBe(false);
}

test("the_switch_paints_the_selection_before_the_live_shapes", async () => {
  await switchesInTwoPaints();
});

test("reduced_motion_switches_the_same_way", async () => {
  reduce = false;
  await switchesInTwoPaints();
  cleanup();
  canvas.props = null;
  canvas.instance = null;
  selects.calls = [];
  reduce = true;
  await switchesInTwoPaints();
});

test("a_key_in_the_gap_runs_on_the_new_frame", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  selects.calls = [];
  // Review Focus 5: a click on a shape in frame Refund, then Delete before the next paint.
  s.clickShape("Refund", "Ask");
  inTheGap(s, { title: "Checkout", shape: "Cart" }, { title: "Refund", shape: "Ask" });
  s.press("Delete");
  // The key waited for the frame: Checkout's selection was never touched.
  expect(s.frame(0)).toBe(CHECKOUT.trim());
  await waitFor(() => expect(s.frame(1)).toBe('diagram flow "Refund"\nRefund it'));
  expect(s.frame(0)).toBe(CHECKOUT.trim());
  expect(s.frame(2)).toBe(SHIPPING.trim());
  // A rename typed in the gap: F2 and a letter on Shipping's picked shape open its field with that letter.
  selects.calls = [];
  s.clickShape("Shipping", "Pack");
  expect(s.isSelected("Shipping")).toBe(true);
  expect(selects.calls).toEqual([]);
  s.press("F2");
  s.press("X");
  const field = (await screen.findByRole("textbox", { name: /^Rename/ })) as HTMLInputElement;
  await waitFor(() => expect(field.value).toBe("X"));
  expect(s.ids()).toContain("Pack");
  // The letter armed no tool: it went into the field.
  expect(s.frame(2)).toBe(SHIPPING.trim());
});

test("keys_in_the_gap_replay_in_order", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  const texts: string[] = [];
  selects.calls = [];
  s.clickShape("Refund", "Ask");
  inTheGap(s, { title: "Checkout", shape: "Cart" }, { title: "Refund", shape: "Ask" });
  s.press("Delete");
  s.press("z", { ctrlKey: true });
  // The delete lands first, then the undo takes it back.
  await waitFor(() => {
    texts.push(s.frame(1));
    expect(texts.some((t) => !t.includes("Ask\n"))).toBe(true);
  });
  await waitFor(() => expect(s.frame(1)).toBe(REFUND.trim()));
  expect(s.frame(0)).toBe(CHECKOUT.trim());
  expect(s.frame(2)).toBe(SHIPPING.trim());
});

test("two_quick_switches_end_on_the_last", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  canvas.ever = new Set();
  selects.calls = [];
  // Refund, then a shape in Shipping, inside one paint, then Delete.
  fireEvent.click(await s.tab("Flowchart Refund"));
  expect(s.isSelected("Refund")).toBe(true);
  s.clickShape("Shipping", "Pack");
  expect(s.isSelected("Shipping")).toBe(true);
  expect(s.isSelected("Refund")).toBe(false);
  s.press("Delete");
  await nextPaint();
  await waitFor(() => expect(s.ids()).toContain("Send"));
  expect(selects.calls).toEqual([{ title: "Shipping", index: 2 }]);
  // The held Delete went to Shipping's picked shape.
  await waitFor(() => expect(s.frame(2)).toBe('diagram flow "Shipping"\nSend'));
  expect(s.frame(0)).toBe(CHECKOUT.trim());
  expect(s.frame(1)).toBe(REFUND.trim());
  // Refund was never live.
  expect(canvas.ever.has("Ask")).toBe(false);
  expect(canvas.ever.has("Refund it")).toBe(false);
});

test("esc_in_the_gap_goes_up_one_level_on_the_new_frame", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  act(() => s.props().onSelect!(["Cart"]));
  await waitFor(() => expect(s.props().selection).toEqual(["Cart"]));
  selects.calls = [];
  s.clickShape("Refund", "Ask");
  inTheGap(s, { title: "Checkout", shape: "Cart" }, { title: "Refund", shape: "Ask" });
  // Esc in the gap is Refund's: it lets its picked shape go, and never Checkout's selection or Checkout itself.
  s.press("Escape");
  await nextPaint();
  await waitFor(() => expect(s.ids()).toContain("Ask"));
  await waitFor(() => expect(s.props().selection).toEqual([]));
  expect(s.isSelected("Refund")).toBe(true);
  expect(selects.calls).toEqual([{ title: "Refund", index: 1 }]);
});

test("a_click_back_on_the_live_frame_in_the_gap_drops_the_switch", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  canvas.ever = new Set();
  selects.calls = [];
  fireEvent.click(await s.tab("Flowchart Refund"));
  expect(s.isSelected("Refund")).toBe(true);
  // A key for Refund, then back on Checkout's tab inside the same paint: the switch and its key go.
  s.press("Delete");
  fireEvent.click(await s.tab("Flowchart Checkout"));
  expect(s.isSelected("Checkout")).toBe(true);
  expect(s.isSelected("Refund")).toBe(false);
  await nextPaint();
  await nextPaint();
  expect(selects.calls).toEqual([]);
  expect(s.ids()).toContain("Cart");
  expect(canvas.ever.has("Ask")).toBe(false);
  expect(s.frame(0)).toBe(CHECKOUT.trim());
  expect(s.frame(1)).toBe(REFUND.trim());
});

const ER_A = 'diagram er "Billing"\ncustomers {\n  id int pk\n}\ninvoices {\n  id int pk\n  customer_id int\n}\n';
const ER_B = 'diagram er "Shop"\norders {\n  id int pk\n}\n';
const ER_LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Billing: { at: { x: 0, y: 0 }, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 400, y: 0 } }, style: "modern", direction: "TB" },
    Shop: { at: { x: 2000, y: 0 }, nodes: { orders: { x: 0, y: 0 } }, style: "modern", direction: "TB" },
  },
  sketches: [],
});

test("a_notice_does_not_follow_a_switch", async () => {
  const s = setup([ER_A, ER_B].join("\n"), ER_LAYOUT);
  await opened(s, [/Billing$/, /Shop$/]);
  fireEvent.click(await s.tab(/Billing$/));
  await waitFor(() => expect(s.ids()).toContain("invoices"));
  act(() => s.props().onConnectPorts!({ node: "invoices", port: "col:customer_id" }, { node: "customers", port: "col:id" }, false));
  await waitFor(() => expect(s.notice()).toMatch(/^Linked invoices\.customer_id > customers\.id/));
  fireEvent.click(await s.tab(/Shop$/));
  await nextPaint();
  await waitFor(() => expect(s.ids()).toContain("orders"));
  act(() => s.props().onSelect!(["orders"]));
  await waitFor(() => expect(s.props().selection).toEqual(["orders"]));
  expect(s.notice()).toBe("");
});

test("a_refused_line_notice_does_not_follow_a_switch", async () => {
  // Seen live: an ER line dropped nowhere says why in the strip; a click on another frame's card lets it go.
  const s = setup([ER_A, ER_B].join("\n"), ER_LAYOUT);
  await opened(s, [/Billing$/, /Shop$/]);
  fireEvent.click(await s.tab(/Billing$/));
  await waitFor(() => expect(s.ids()).toContain("invoices"));
  act(() => s.props().onConnectRelease!({ node: "invoices", port: "col:customer_id" }, { x: -500, y: -500 }));
  await waitFor(() => expect(s.notice()).toBe("No line made: drop on a column of another table."));
  // Shop is pictured (one image): a click on its one card, where the picture draws it.
  const shop = s.nodeOf(boardFrameId("Shop"))!;
  await waitFor(() => expect(s.nodeOf(inFrameId("Shop", "\u0000picture"))).toBeTruthy());
  const [card] = pictureShapes(s.nodeOf(inFrameId("Shop", "\u0000picture"))!, shop.position);
  s.clickAt({ x: card.x + 10, y: card.y + 10 });
  await nextPaint();
  await waitFor(() => expect(s.ids()).toContain("orders"));
  await waitFor(() => expect(s.props().selection).toEqual(["orders"]));
  expect(s.notice()).toBe("");
});

test("a_refused_switch_drops_the_keys_held_for_it", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  // Refund's shape picked, Delete held for it.
  s.clickShape("Refund", "Ask");
  s.press("Delete");
  // The Assistant takes the text in the gap: a pick of Shipping is refused, and Refund's switch goes with it.
  lock.on = true;
  s.redraw();
  s.clickShape("Shipping", "Pack");
  await nextPaint();
  expect(s.ids()).toContain("Cart");
  lock.on = false;
  s.redraw();
  // A later switch lands with nothing held: the Delete pressed for Refund never runs on Shipping.
  selects.calls = [];
  s.clickShape("Shipping", "Pack");
  await nextPaint();
  await waitFor(() => expect(s.ids()).toContain("Pack"));
  await waitFor(() => expect(s.props().selection).toEqual(["Pack"]));
  await new Promise((r) => setTimeout(r, 100));
  expect(s.frame(0)).toBe(CHECKOUT.trim());
  expect(s.frame(1)).toBe(REFUND.trim());
  expect(s.frame(2)).toBe(SHIPPING.trim());
});

test("a_duplicate_and_an_undo_in_the_gap_replay_in_order", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  selects.calls = [];
  const texts: string[] = [];
  s.clickShape("Refund", "Ask");
  inTheGap(s, { title: "Checkout", shape: "Cart" }, { title: "Refund", shape: "Ask" });
  // The worker takes its time over the duplicate: the undo must still wait for it.
  const edit = s.client.flowEdit.bind(s.client);
  vi.spyOn(s.client, "flowEdit").mockImplementation(async (...a: Parameters<typeof edit>) => {
    await new Promise((r) => setTimeout(r, 60));
    return edit(...a);
  });
  s.press("d", { ctrlKey: true });
  s.press("z", { ctrlKey: true });
  // The duplicate lands first, then the undo takes it back.
  await waitFor(() => {
    texts.push(s.frame(1));
    expect(texts.some((t) => t !== REFUND.trim())).toBe(true);
  });
  await waitFor(() => expect(s.frame(1)).toBe(REFUND.trim()));
  await new Promise((r) => setTimeout(r, 100));
  expect(s.frame(1)).toBe(REFUND.trim());
  expect(s.frame(0)).toBe(CHECKOUT.trim());
});

test("a_press_on_the_frame_left_in_the_gap_is_ignored", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  selects.calls = [];
  s.clickShape("Refund", "Ask");
  inTheGap(s, { title: "Checkout", shape: "Cart" }, { title: "Refund", shape: "Ask" });
  // A press, click and double-click on Checkout's live shape inside the gap: Checkout takes none of them.
  const cart = [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === "Cart")!;
  fireEvent.pointerDown(cart);
  fireEvent.mouseDown(cart);
  fireEvent.mouseUp(cart);
  fireEvent.click(cart);
  fireEvent.doubleClick(cart);
  expect(s.props().selection ?? []).toEqual([]);
  expect(screen.queryByRole("textbox", { name: /^Rename/ })).toBeNull();
  await nextPaint();
  await waitFor(() => expect(s.ids()).toContain("Ask"));
  await waitFor(() => expect(s.props().selection).toEqual(["Ask"]));
  expect(screen.queryByRole("textbox", { name: /^Rename/ })).toBeNull();
});

test("a_clipboard_that_never_answers_holds_keys_no_longer_than_a_key_waits", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  // Ctrl+V on Checkout, and the clipboard never answers.
  clip.hang = true;
  s.press("v", { ctrlKey: true });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 4_300));
  });
  // Past the longest a key waits, a key held in a later switch's gap runs as soon as that frame is live.
  selects.calls = [];
  s.clickShape("Refund", "Ask");
  s.press("Delete");
  await nextPaint();
  await waitFor(() => expect(s.frame(1)).toBe('diagram flow "Refund"\nRefund it'), { timeout: 1_500 });
  expect(s.frame(0)).toBe(CHECKOUT.trim());
}, 15_000);

test("a_right_click_on_the_frame_left_in_the_gap_is_ignored", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout", "Cart");
  selects.calls = [];
  s.clickShape("Refund", "Ask");
  inTheGap(s, { title: "Checkout", shape: "Cart" }, { title: "Refund", shape: "Ask" });
  const cart = [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === "Cart")!;
  fireEvent.contextMenu(cart, { clientX: 200, clientY: 200 });
  expect(screen.queryByRole("menu")).toBeNull();
  await nextPaint();
  await waitFor(() => expect(s.props().selection).toEqual(["Ask"]));
  expect(screen.queryByRole("menu")).toBeNull();
});
