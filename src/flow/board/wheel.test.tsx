// On a board Ctrl+wheel and a pinch zoom around the pointer by one clamped step, once (React
// Flow does not zoom it a second time), over a scrolling card and an open field alike; a plain wheel still pans; other
// canvases keep React Flow's wheel. The view reports once per animation frame, with the pointer's flow point.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Node, NodeProps, ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { CanvasView } from "../../diagram/canvasView";
import type { CanvasHandle } from "../../diagram/canvasView";
import DiagramCanvas from "../../diagram/DiagramCanvas";
import { mockReactFlowDom } from "../../test/reactFlow";

let reduce = true;
beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  reduce = true;
});

function Card(_: NodeProps) {
  return (
    <div className="test-card">
      <ul className="nowheel test-rows" style={{ overflow: "auto", height: 100 }}>
        <li>row</li>
      </ul>
      <input aria-label="field" className="inline-edit nodrag nopan nowheel" defaultValue="" />
    </div>
  );
}
const nodes: Node[] = [{ id: "a", type: "card", position: { x: 0, y: 0 }, initialWidth: 200, initialHeight: 200, data: {} }];

function setup(smoothWheel: boolean) {
  let flow: ReactFlowInstance | null = null;
  let handle: CanvasHandle | null = null;
  const seen: { v: CanvasView; landing: boolean; at?: { x: number; y: number } }[] = [];
  const utils = render(
    <div style={{ width: 800, height: 600 }}>
      <DiagramCanvas
        nodes={nodes}
        edges={[]}
        nodeTypes={{ card: Card }}
        smoothWheel={smoothWheel}
        boxSelect
        onInit={(i) => (flow = i)}
        onCanvasReady={(h) => (handle = h)}
        onViewChange={(v, landing, at) => seen.push({ v, landing, at })}
      />
    </div>,
  );
  const root = utils.container.querySelector(".diagram-canvas") as HTMLElement;
  return { ...utils, root, flow: () => flow!, handle: () => handle!, seen };
}
const frame = () => act(async () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))));

async function atZoom1(s: ReturnType<typeof setup>) {
  await frame();
  await act(async () => void (await s.flow().setViewport({ x: 0, y: 0, zoom: 1 })));
  await frame();
  s.seen.length = 0;
}

test("ctrl_wheel_zooms_around_the_pointer_once", async () => {
  const s = setup(true);
  await atZoom1(s);
  const pane = s.root.querySelector(".react-flow__pane") as HTMLElement;
  const rect = s.root.getBoundingClientRect();
  const ev = new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, clientX: rect.left + 300, clientY: rect.top + 200, bubbles: true, cancelable: true });
  await act(async () => void pane.dispatchEvent(ev));
  await frame();
  const vp = s.flow().getViewport();
  expect(vp.zoom).toBeCloseTo(0.8187, 4);
  // The point under the pointer stayed under it.
  expect((300 - vp.x) / vp.zoom).toBeCloseTo(300, 2);
  expect((200 - vp.y) / vp.zoom).toBeCloseTo(200, 2);
  expect(ev.defaultPrevented).toBe(true);
});

test("a_burst_of_wheel_events_reports_once_a_frame_with_the_pointer", async () => {
  const s = setup(true);
  await atZoom1(s);
  const rect = s.root.getBoundingClientRect();
  await act(async () => {
    for (let i = 0; i < 5; i++) s.root.querySelector(".react-flow__pane")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -50, ctrlKey: true, clientX: rect.left + 400, clientY: rect.top + 100, bubbles: true, cancelable: true }));
  });
  await frame();
  expect(s.seen).toHaveLength(1);
  expect(s.seen[0].landing).toBe(false);
  expect(s.seen[0].v.zoom).toBeCloseTo(Math.exp(0.1 * 5), 4);
  expect(s.seen[0].at?.x).toBeCloseTo(400, 2);
  expect(s.seen[0].at?.y).toBeCloseTo(100, 2);
});

test("a_plain_wheel_still_pans", async () => {
  const s = setup(true);
  await atZoom1(s);
  const ev = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
  await act(async () => void s.root.querySelector(".react-flow__pane")!.dispatchEvent(ev));
  expect(s.flow().getViewport().zoom).toBe(1);
  // React Flow's own pan took it.
  expect(s.flow().getViewport().y).toBeLessThan(0);
});

test("pinch_over_a_scrolling_card_zooms_the_canvas", async () => {
  const s = setup(true);
  await atZoom1(s);
  const rows = s.root.querySelector(".test-rows") as HTMLElement;
  rows.scrollTop = 40;
  const ev = new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => void rows.dispatchEvent(ev));
  expect(ev.defaultPrevented).toBe(true);
  expect(s.flow().getViewport().zoom).toBeCloseTo(0.8187, 4);
  expect(rows.scrollTop).toBe(40);
});

test("zooming_keeps_an_open_field_and_its_text", async () => {
  const s = setup(true);
  await atZoom1(s);
  const field = s.root.querySelector("input") as HTMLInputElement;
  field.focus();
  fireEvent.change(field, { target: { value: "typed" } });
  const ev = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => void field.dispatchEvent(ev));
  // React Flow skips a `nowheel` field: only this canvas's step zooms, exactly once.
  expect(s.flow().getViewport().zoom).toBeCloseTo(Math.exp(0.2), 4);
  expect(ev.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe("typed");
});

test("a_wheel_at_a_zoom_limit_leaves_a_glide_alone_and_a_zoom_ends_it", async () => {
  reduce = false;
  const s = setup(true);
  await atZoom1(s);
  await act(async () => void (await s.flow().setViewport({ x: 0, y: 0, zoom: 4 })));
  await frame();
  const pane = s.root.querySelector(".react-flow__pane")!;
  const wheel = (deltaY: number) => pane.dispatchEvent(new WheelEvent("wheel", { deltaY, ctrlKey: true, bubbles: true, cancelable: true }));
  s.seen.length = 0;
  let landed = false;
  void s.handle().glideView({ center: { x: 100, y: 100 }, zoom: 2 }).then(() => (landed = true));
  // Zooming in at 400 percent changes nothing: the glide goes on, reporting nothing but its landing until it is there.
  await act(async () => void wheel(-100));
  await act(async () => new Promise<void>((r) => setTimeout(r, 120)));
  expect(landed).toBe(false);
  expect(s.seen.filter((x) => !x.landing)).toHaveLength(0);
  await vi.waitFor(() => expect(landed).toBe(true), { timeout: 2000 });
  // A step that does zoom ends a glide at once, and the view reports.
  s.seen.length = 0;
  void s.handle().glideView({ center: { x: 300, y: 300 }, zoom: 1 });
  await act(async () => void wheel(100));
  await frame();
  expect(s.seen.some((x) => !x.landing)).toBe(true);
});

test("other_canvases_keep_react_flows_wheel", async () => {
  const add = vi.spyOn(HTMLElement.prototype, "addEventListener");
  const s = setup(false);
  expect(add.mock.calls.filter(([t, , o]) => t === "wheel" && typeof o === "object" && o?.capture && o.passive === false)).toHaveLength(0);
  add.mockRestore();
  await atZoom1(s);
  const ev = new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => void s.root.querySelector(".react-flow__pane")!.dispatchEvent(ev));
  // React Flow's own step, 2^(-dy * 0.002): not this canvas's.
  expect(s.flow().getViewport().zoom).not.toBeCloseTo(0.8187, 3);
});

test("the_wheel_listener_goes_with_the_canvas", () => {
  const add = vi.spyOn(HTMLElement.prototype, "addEventListener");
  const remove = vi.spyOn(HTMLElement.prototype, "removeEventListener");
  const s = setup(true);
  const mine = (calls: unknown[][]) => calls.filter(([t, , o]) => t === "wheel" && typeof o === "object" && (o as AddEventListenerOptions).capture && (o as AddEventListenerOptions).passive === false);
  expect(mine(add.mock.calls)).toHaveLength(1);
  s.unmount();
  const removed = remove.mock.calls.filter(([t, , o]) => t === "wheel" && typeof o === "object" && (o as AddEventListenerOptions).capture);
  expect(removed.map((c) => c[1])).toContain(mine(add.mock.calls)[0][1]);
  add.mockRestore();
  remove.mockRestore();
});
