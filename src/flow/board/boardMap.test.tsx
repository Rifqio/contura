// The frame-box minimap. An option beside the zoom control, off by default, boxes only.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import type { CanvasHandle } from "../../diagram/canvasView";
import DiagramCanvas, { type DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { mockReactFlowDom } from "../../test/reactFlow";
import appCss from "../../styles/app.css?raw";
import BoardMap from "./BoardMap";
import type { FrameBox } from "./boardScene";

beforeAll(() => {
  mockReactFlowDom();
  // Reduced motion: a glide lands at once.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});

const box = (index: number, x: number, y = 0): FrameBox => ({ key: `f${index}`, index, title: `Frame ${index}`, kind: "flow", x, y, w: 400, h: 300, problems: 0, clash: false });
const TWO = [box(0, 0), box(1, 1000)];

function renderMap(boxes: readonly FrameBox[], opts: { glide?: CanvasHandle["glideView"]; withSlot?: boolean; onViewChange?: DiagramCanvasProps["onViewChange"] } = {}) {
  let handle: CanvasHandle | null = null;
  let flow: ReactFlowInstance | null = null;
  const glide: CanvasHandle["glideView"] = (to) => (opts.glide ? opts.glide(to) : (handle?.glideView(to) ?? Promise.resolve()));
  const ui = () => (
    <div style={{ width: 800, height: 600 }}>
      <DiagramCanvas
        nodes={[]}
        edges={[]}
        nodeTypes={{}}
        onInit={(i) => (flow = i)}
        onCanvasReady={(h) => (handle = h)}
        onViewChange={opts.onViewChange}
        showMiniMap={false}
        mapSlot={opts.withSlot === false ? undefined : <BoardMap boxes={boxes} live={1} glide={glide} cancelGlide={() => handle?.cancelGlide()} />}
      />
    </div>
  );
  const utils = render(ui());
  return { ...utils, ui, flow: () => flow!, handle: () => handle! };
}

const toggle = () => within(screen.getByRole("group", { name: "Zoom" })).getByRole("button", { name: "Overview" });
const on = async () => {
  await userEvent.click(toggle());
  return screen.getByRole("img", { name: "Overview" });
};

test("the_toggle_shows_on_boards_with_frames", () => {
  const two = renderMap(TWO);
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(toggle().getAttribute("title")).toBe("Overview");
  // Off: no map is drawn.
  expect(screen.queryByRole("img", { name: "Overview" })).toBeNull();
  two.unmount();
  // One frame: no slot, today's MiniMap and no toggle.
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <DiagramCanvas nodes={[]} edges={[]} nodeTypes={{}} />
    </div>,
  );
  expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
  expect(container.querySelector(".react-flow__minimap")).not.toBeNull();
});

test("the_map_draws_frame_boxes_only", async () => {
  // 50 frames carrying 10,000 shapes: the map is told the boxes and nothing else, so it draws 50 rects and the view.
  const boxes = Array.from({ length: 50 }, (_, i) => box(i, (i % 10) * 500, Math.floor(i / 10) * 400));
  renderMap(boxes);
  const map = await on();
  expect(map.querySelectorAll("rect")).toHaveLength(51);
  expect(map.querySelectorAll("rect.board-map-view")).toHaveLength(1);
  expect(map.getAttribute("width")).toBe("200");
  expect(map.getAttribute("height")).toBe("140");
});

test("the_live_frame_is_filled_with_the_accent_tokens", async () => {
  renderMap(TWO);
  const map = await on();
  const live = map.querySelectorAll("rect.board-map-live");
  expect(live).toHaveLength(1);
  expect(live[0].getAttribute("x")).toBe("1000");
  const rule = (sel: string) => new RegExp(`${sel.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(appCss)?.[1] ?? "";
  expect(rule(".board-map-box")).toContain("stroke: var(--c-border-strong)");
  expect(rule(".board-map-live")).toContain("fill: var(--c-accent-subtle)");
  expect(rule(".board-map-live")).toContain("stroke: var(--c-accent)");
  // Theme tokens only: no colour literal in the map's rules.
  const mapCss = appCss.slice(appCss.indexOf("The overview of frame boxes"));
  expect(mapCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test("a_click_on_the_map_glides_there", async () => {
  const glide = vi.fn<CanvasHandle["glideView"]>(() => Promise.resolve());
  const r = renderMap(TWO, { glide });
  const map = await on();
  // The view (0..800 by 0..600) and the two boxes make a world whose middle is (700, 300); the map's middle is that point.
  fireEvent.pointerDown(map, { clientX: 100, clientY: 70, pointerId: 1, button: 0 });
  fireEvent.pointerUp(map, { clientX: 100, clientY: 70, pointerId: 1, button: 0 });
  expect(glide).toHaveBeenCalledTimes(1);
  const to = glide.mock.calls[0][0] as { center: { x: number; y: number }; zoom: number };
  expect(to.center.x).toBeCloseTo(700, 0);
  expect(to.center.y).toBeCloseTo(300, 0);
  expect(to.zoom).toBe(1);
  r.unmount();
  // Through the canvas's own glide under reduced motion it jumps: the view is there at once.
  const real = renderMap(TWO);
  await waitFor(() => expect(real.flow()).not.toBeNull());
  const map2 = await on();
  await act(async () => {
    fireEvent.pointerDown(map2, { clientX: 100, clientY: 70, pointerId: 1, button: 0 });
    fireEvent.pointerUp(map2, { clientX: 100, clientY: 70, pointerId: 1, button: 0 });
  });
  const v = real.flow().getViewport();
  expect(v.x).toBeCloseTo(-300, 0);
  expect(v.y).toBeCloseTo(0, 0);
  expect(v.zoom).toBe(1);
});

test("a_drag_on_the_map_pans_without_a_glide", async () => {
  const glide = vi.fn<CanvasHandle["glideView"]>(() => Promise.resolve());
  const r = renderMap(TWO, { glide });
  const map = await on();
  const s = 200 / 1540;
  fireEvent.pointerDown(map, { clientX: 100, clientY: 70, pointerId: 1, button: 0 });
  await act(async () => {
    fireEvent.pointerMove(map, { clientX: 130, clientY: 70, pointerId: 1 });
  });
  // The view's middle follows the pointer, at once: no glide.
  expect(r.flow().getViewport().x).toBeCloseTo(400 - (-70 + 130 / s), 0);
  fireEvent.pointerUp(map, { clientX: 130, clientY: 70, pointerId: 1, button: 0 });
  expect(glide).not.toHaveBeenCalled();
  expect(r.flow().getViewport().zoom).toBe(1);
});

test("a_drag_on_the_map_during_a_glide_ends_the_glide", async () => {
  // Final review M4: the map's drag moves the view with no event, which does not end a glide. The press ends it, so
  // the drag's views are reported as they come, not when the glide's fallback timer runs out.
  const views: number[] = [];
  const r = renderMap(TWO, { onViewChange: (v, landing) => void (landing || views.push(v.x)) });
  await waitFor(() => expect(r.flow()).not.toBeNull());
  const map = await on();
  // A glide that never lands of itself: its fallback timer would end it.
  vi.spyOn(r.flow(), "setCenter").mockReturnValue(new Promise<boolean>(() => {}));
  void r.handle().glideView({ center: { x: 2000, y: 300 }, zoom: 1 });
  views.length = 0;
  fireEvent.pointerDown(map, { clientX: 100, clientY: 70, pointerId: 1, button: 0 });
  await act(async () => {
    fireEvent.pointerMove(map, { clientX: 130, clientY: 70, pointerId: 1 });
    // Two animation frames, well inside the glide's fallback.
    for (let i = 0; i < 2; i++) await new Promise((f) => requestAnimationFrame(f));
  });
  expect(views[views.length - 1]).toBeCloseTo(-r.flow().getViewport().x, 0);
  fireEvent.pointerUp(map, { clientX: 130, clientY: 70, pointerId: 1, button: 0 });
});

test("the_toggle_is_keyboard_complete", async () => {
  renderMap(TWO);
  const zoomIn = screen.getByRole("button", { name: "Fit to view" });
  zoomIn.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(toggle());
  await userEvent.keyboard(" ");
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("img", { name: "Overview" })).not.toBeNull();
  await userEvent.keyboard("{Enter}");
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("img", { name: "Overview" })).toBeNull();
  // A visible focus ring: the app's own, which no rule of the toggle turns off.
  expect(appCss).toMatch(/:focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--c-focus\)/);
  expect(appCss).not.toMatch(/\.canvas-zoom[^{]*\{[^}]*outline:\s*none/);
});

test("the_map_is_not_saved", async () => {
  const r = renderMap(TWO);
  await on();
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  r.unmount();
  renderMap(TWO);
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("img", { name: "Overview" })).toBeNull();
  expect(localStorage.length).toBe(0);
});
