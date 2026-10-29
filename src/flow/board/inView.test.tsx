// Only frames in view are drawn, and every glide reports where it lands. A pan inside
// the overscan builds no scene; a frame coming into view (by a pan or by an edit) is drawn; a jitter at the readable line
// builds once; each glide reports its landing view once, before it moves, and plans for it once.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { CanvasView } from "../../diagram/canvasView";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { setReducedMotionPref } from "../../diagram/motion";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import { FRAME_MIN } from "./boardLayout";
import { boardFrameId, inFrameId } from "./boardScene";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

// The real canvas draws; the test keeps its latest props, its React Flow instance and every view it reports.
const canvas = vi.hoisted(() => ({
  props: null as DiagramCanvasProps | null,
  instance: null as ReactFlowInstance | null,
  views: [] as { v: CanvasView; landing: boolean }[],
}));
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
        onViewChange: (v, landing) => {
          canvas.views.push({ v, landing });
          p.onViewChange?.(v, landing);
        },
      });
    },
  };
});

// Every scene build and every frame plan FlowTab makes.
const count = vi.hoisted(() => ({ builds: 0, plans: 0, toward: [] as { x: number; y: number }[] }));
vi.mock("./boardScene", async (load) => {
  const real = await load<typeof import("./boardScene")>();
  return {
    ...real,
    createBoardScene: (look: Parameters<typeof real.createBoardScene>[0]) => {
      const scene = real.createBoardScene(look);
      const build = scene.build;
      scene.build = (...a: Parameters<typeof build>) => {
        count.builds++;
        return build(...a);
      };
      return scene;
    },
  };
});
vi.mock("./boardDetail", async (load) => {
  const real = await load<typeof import("./boardDetail")>();
  return {
    ...real,
    frameDraw: (i: Parameters<typeof real.frameDraw>[0]) => {
      count.plans++;
      return real.frameDraw(i);
    },
    stepForms: (...a: Parameters<typeof real.stepForms>) => {
      count.toward.push(a[5]);
      return real.stepForms(...a);
    },
  };
});

// The doc FlowTab works on, so a test can change a frame's setting as the frame bar does.
const docs = vi.hoisted(() => ({ last: null as { setFrameSetting(key: string, patch: { textSize?: "s" | "m" | "l" }): void } | null }));
vi.mock("../useFlowDoc", async (load) => {
  const real = await load<typeof import("../useFlowDoc")>();
  return {
    ...real,
    useFlowDoc: (...a: Parameters<typeof real.useFlowDoc>) => {
      const d = real.useFlowDoc(...a);
      docs.last = d;
      return d;
    },
  };
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
  canvas.views = [];
  count.builds = 0;
  count.plans = 0;
  count.toward = [];
  reduce = true;
  setReducedMotionPref(false);
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\n';
const FAR = 'diagram flow "Far"\nLeft\nRight\nLeft > Right\n';
const BOARD = [CHECKOUT, REFUND, SHIPPING, FAR].join("\n");
// Far is well past the overscan of a 100 percent view at the board's start (x up to 1,200).
const FAR_AT = 6000;
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Refund: { at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Shipping: { at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Far: { at: { x: FAR_AT, y: 0 }, nodes: { Left: { x: 0, y: 0 }, Right: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
  },
  sketches: [],
});

function setup(text = BOARD, layout: string = LAYOUT) {
  const saved = { text, layout: layout as string | null };
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
  const kids = (key: string) => props().nodes.filter((n) => n.parentId === boardFrameId(key));
  const frameEl = (key: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === boardFrameId(key)) ?? null;
  const isSelected = (key: string) => {
    const el = frameEl(key);
    return !!el && within(el).queryByRole("button", { name: /^Code Editor/ }) !== null;
  };
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const clickAt = (flow: { x: number; y: number }) => {
    const p = inst().flowToScreenPosition(flow);
    const pane = utils.container.querySelector(".react-flow__pane") as HTMLElement;
    fireEvent.click(pane, { clientX: p.x, clientY: p.y });
  };
  const tab = (title: RegExp | string) => screen.findByRole("button", { name: title });
  return { ...utils, saved, canvasEl, props, inst, ids, nodeOf, kids, frameEl, isSelected, press, clickAt, tab };
}
type Setup = ReturnType<typeof setup>;

async function opened(s: Setup) {
  for (const t of ["Flowchart Checkout", "Flowchart Refund", "Flowchart Shipping"]) await s.tab(t);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await settle();
}

/** Two animation frames: a reported view, its plan and its first step have run. */
async function settle() {
  for (let i = 0; i < 2; i++) await act(async () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))));
}

/** The view moved without a glide (a pan or a wheel zoom), then settled. */
async function viewAt(s: Setup, v: { x: number; y: number; zoom: number }) {
  await act(async () => void (await s.inst().setViewport(v)));
  await settle();
}

/** The board's start at 100 percent: Checkout, Refund and Shipping in view, Far not. */
const START = { x: 0, y: 100, zoom: 1 };

test("a_pan_tick_builds_no_scene", async () => {
  const s = setup();
  await opened(s);
  await viewAt(s, START);
  await waitFor(() => expect(s.kids("Refund").length).toBeGreaterThan(0));
  count.builds = 0;
  for (let i = 1; i <= 10; i++) await viewAt(s, { ...START, x: -10 * i });
  expect(count.builds).toBe(0);
});

test("a_frame_coming_into_view_is_drawn", async () => {
  const s = setup();
  await opened(s);
  await viewAt(s, START);
  await waitFor(() => expect(s.kids("Shipping").length).toBeGreaterThan(0));
  expect(s.kids("Far")).toEqual([]);
  // Its box node is still on the canvas: its tab and strip stay where they are.
  expect(s.nodeOf(boardFrameId("Far"))).toBeTruthy();
  await viewAt(s, { x: -(FAR_AT - 200), y: 100, zoom: 1 });
  await waitFor(() => expect(s.ids()).toContain(inFrameId("Far", "Left")));
  expect(s.ids()).toContain(inFrameId("Far", "Right"));
  // Checkout left the view: its shapes went at once.
  expect(s.kids("Checkout")).toEqual([]);
});

test("a_frame_grown_into_view_by_an_edit_is_drawn", async () => {
  const s = setup();
  await opened(s);
  await viewAt(s, START);
  await waitFor(() => expect(s.kids("Shipping").length).toBeGreaterThan(0));
  expect(s.kids("Far")).toEqual([]);
  const views = canvas.views.length;
  // Far is moved next to Shipping by its tab: the view does not change, the board's boxes do.
  act(() => s.props().onFrameDrag!(boardFrameId("Far"), { x: 900, y: 300 }, false));
  act(() => s.props().onFrameDrag!(boardFrameId("Far"), { x: 900, y: 300 }, true));
  await waitFor(() => expect(s.ids()).toContain(inFrameId("Far", "Left")));
  expect(canvas.views.length).toBe(views);
});

test("a_jitter_at_the_line_builds_the_scene_once", async () => {
  // Review Focus 1: a trackpad hovering around 46 percent on m frames.
  const s = setup();
  await opened(s);
  await viewAt(s, START);
  await waitFor(() => expect(s.kids("Refund").length).toBeGreaterThan(0));
  count.builds = 0;
  for (const zoom of [0.47, 0.46, 0.47, 0.48, 0.46]) await viewAt(s, { ...START, zoom });
  expect(count.builds).toBe(1);
  // The frames turned into their pictures once, at 0.46, and stayed.
  expect(s.ids()).not.toContain(inFrameId("Refund", "Ask"));
  expect(s.canvasEl().getAttribute("data-far")).toContain("m");
});

/** The paths that glide, each started on a settled view. */
const GLIDES: { name: string; plans: boolean; run(s: Setup): Promise<void> | void }[] = [
  // The canvas's own key: React Flow's pane, inside the board's canvas.
  { name: "Shift+1", plans: true, run: (s) => void fireEvent.keyDown(s.canvasEl().querySelector(".diagram-canvas")!, { key: "!", shiftKey: true, code: "Digit1" }) },
  {
    name: "Shift+2",
    plans: true,
    run: (s) => {
      act(() => s.props().onSelect!([]));
      s.press("@", { shiftKey: true, code: "Digit2" });
    },
  },
  { name: "a tab double-click", plans: true, run: async (s) => void fireEvent.doubleClick(await s.tab("Flowchart Shipping")) },
  { name: "zoom in", plans: true, run: () => void fireEvent.click(screen.getByRole("button", { name: "Zoom in" })) },
  { name: "zoom out", plans: true, run: () => void fireEvent.click(screen.getByRole("button", { name: "Zoom out" })) },
  {
    name: "the menu's fit",
    plans: true,
    run: async (s) => {
      act(() => s.props().onSelect!([]));
      s.press("F10", { shiftKey: true });
      fireEvent.click(await screen.findByRole("menuitem", { name: /^Zoom to fit/ }));
    },
  },
  {
    // `glideToFrame` after an add: the board's boxes change too, so its plans are not counted.
    name: "glideToFrame after an add",
    plans: false,
    run: async () => {
      fireEvent.click(within(screen.getByRole("toolbar", { name: "Board tools" })).getByRole("button", { name: "Add" }));
      fireEvent.click(within(await screen.findByRole("dialog", { name: "Add to the board" })).getByRole("option", { name: /^Flowchart/ }));
    },
  },
];

/** Picks Checkout (so Shift+2 has a frame) and moves the view off the board's fit, so every glide moves it. */
async function ready(s: Setup) {
  await opened(s);
  fireEvent.click(await s.tab("Flowchart Checkout"));
  await waitFor(() => expect(s.ids()).toContain("Cart"));
  await viewAt(s, { x: 0, y: 200, zoom: 0.5 });
}

test("each_glide_plans_once_for_where_it_lands", async () => {
  reduce = false;
  const s = setup();
  await ready(s);
  for (const g of GLIDES) {
    await viewAt(s, { x: (canvas.views.length % 7) * 10, y: 200, zoom: 0.5 });
    canvas.views = [];
    count.plans = 0;
    await g.run(s);
    // The landing view is reported at once, before the glide has moved the view.
    await waitFor(() => expect(canvas.views.length, g.name).toBeGreaterThan(0));
    expect(canvas.views[0].landing, g.name).toBe(true);
    if (g.plans) expect(count.plans, g.name).toBe(1);
    // Nothing more while it glides (240 ms) or once it is there.
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    await settle();
    expect(canvas.views, g.name).toHaveLength(1);
    if (g.plans) expect(count.plans, g.name).toBe(1);
    const { x, y, zoom } = s.inst().getViewport();
    const v = canvas.views[0].v;
    expect(v.zoom, g.name).toBeCloseTo(zoom, 4);
    expect(v.x, g.name).toBeCloseTo(-x / zoom, 2);
    expect(v.y, g.name).toBeCloseTo(-y / zoom, 2);
  }
});

test("glides_take_240ms_and_0_under_reduced_motion", async () => {
  reduce = false;
  const s = setup();
  await ready(s);
  const calls: { duration?: number }[] = [];
  const rec =
    <A extends unknown[]>(at: number, real: (...a: A) => Promise<boolean>) =>
    (...a: A) => {
      calls.push((a[at] ?? {}) as { duration?: number });
      return real(...a);
    };
  const f = s.inst();
  const real = { setViewport: f.setViewport.bind(f), fitBounds: f.fitBounds.bind(f), setCenter: f.setCenter.bind(f) };
  vi.spyOn(f, "setViewport").mockImplementation(rec(1, real.setViewport));
  vi.spyOn(f, "fitBounds").mockImplementation(rec(1, real.fitBounds));
  vi.spyOn(f, "setCenter").mockImplementation(rec(2, real.setCenter));
  for (const pref of [false, true]) {
    setReducedMotionPref(pref);
    for (const g of GLIDES) {
      await act(async () => void (await real.setViewport({ x: 0, y: 200, zoom: 0.5 })));
      await settle();
      calls.length = 0;
      await g.run(s);
      await waitFor(() => expect(calls.length, g.name).toBeGreaterThan(0));
      for (const c of calls) expect(c.duration, `${g.name}, reduced ${pref}`).toBe(pref ? 0 : 240);
      await act(async () => new Promise((r) => setTimeout(r, 400)));
      await settle();
    }
  }
});

test("a_pick_on_an_undrawn_frame_still_selects_it", async () => {
  const s = setup();
  await opened(s);
  await viewAt(s, START);
  await waitFor(() => expect(s.kids("Refund").length).toBeGreaterThan(0));
  const ask = s.nodeOf(inFrameId("Refund", "Ask"))!;
  const box = s.nodeOf(boardFrameId("Refund"))!;
  const at = { x: box.position.x + ask.position.x + 10, y: box.position.y + ask.position.y + 10 };
  // At 45.5 percent the m frames are far: Refund is a picture, its shapes not drawn one by one.
  await viewAt(s, { ...START, zoom: 0.455 });
  await waitFor(() => expect(s.ids()).not.toContain(inFrameId("Refund", "Ask")));
  s.clickAt(at);
  await waitFor(() => expect(s.isSelected("Refund")).toBe(true));
  // The shape under the click was picked, and is live once the frame is.
  await waitFor(() => expect(s.ids()).toContain("Ask"));
  await waitFor(() => expect(s.props().selection).toEqual(["Ask"]));
});

// ----- Fix round 1 (review Important 1): a frame's text size alone plans again, with no view change and no box change.

const SOLO = 'diagram flow "Solo"\nOnly\n';
const SOLO_LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Solo: { at: { x: 600, y: 0 }, nodes: { Only: { x: 0, y: 0 } }, style: "modern", direction: "TB" },
  },
  sketches: [],
});

test("a_text_size_change_alone_plans_again", async () => {
  const s = setup([CHECKOUT, SOLO].join("\n"), SOLO_LAYOUT);
  await s.tab("Flowchart Checkout");
  await s.tab("Flowchart Solo");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await settle();
  const only = inFrameId("Solo", "Only");
  const size = () => {
    const n = s.nodeOf(boardFrameId("Solo"))!;
    return { x: n.position.x, y: n.position.y, w: n.initialWidth, h: n.initialHeight };
  };
  // At 45 percent m text is far: Solo, one shape in a box clamped to FRAME_MIN, is its picture.
  await viewAt(s, { x: 0, y: 100, zoom: 0.45 });
  await waitFor(() => expect(s.ids()).not.toContain(only));
  expect(size()).toMatchObject({ w: FRAME_MIN.w, h: FRAME_MIN.h });
  const box = size();
  const views = canvas.views.length;
  // m to l: l is readable at 45 percent, so Solo is drawn with its text, though neither the view nor its box moved.
  act(() => docs.last!.setFrameSetting("Solo", { textSize: "l" }));
  await waitFor(() => expect(s.ids()).toContain(only));
  expect(size()).toEqual(box);
  expect(canvas.views.length).toBe(views);
  // The reverse at 50 percent: m is readable, s is far.
  act(() => docs.last!.setFrameSetting("Solo", { textSize: "m" }));
  await viewAt(s, { x: 0, y: 100, zoom: 0.5 });
  await waitFor(() => expect(s.ids()).toContain(only));
  const at50 = canvas.views.length;
  act(() => docs.last!.setFrameSetting("Solo", { textSize: "s" }));
  await waitFor(() => expect(s.ids()).not.toContain(only));
  expect(size()).toEqual(box);
  expect(canvas.views.length).toBe(at50);
});

test("the_wheels_pointer_steers_only_its_own_swap", async () => {
  // Frames fill nearest the pointer for the swap a wheel zoom started; a later replan (an edit) fills
  // from the view centre.
  const s = setup();
  await opened(s);
  await viewAt(s, START);
  await waitFor(() => expect(s.kids("Shipping").length).toBeGreaterThan(0));
  const v = { x: FAR_AT - 200, y: -100, w: 800, h: 600, zoom: 1 };
  count.toward = [];
  act(() => s.props().onViewChange!(v, false, { x: 123, y: 456 }));
  await settle();
  await settle();
  expect(count.toward.length).toBeGreaterThan(0);
  expect(count.toward[0]).toEqual({ x: 123, y: 456 });
  // Settled: an edit that moves a frame replans from the view centre.
  count.toward = [];
  act(() => s.props().onFrameDrag!(boardFrameId("Checkout"), { x: FAR_AT, y: 0 }, false));
  act(() => s.props().onFrameDrag!(boardFrameId("Checkout"), { x: FAR_AT, y: 0 }, true));
  await settle();
  await settle();
  expect(count.toward.length).toBeGreaterThan(0);
  expect(count.toward.every((t) => t.x === v.x + v.w / 2 && t.y === v.y + v.h / 2)).toBe(true);
});
