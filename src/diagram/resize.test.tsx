// Resizing by pointer zones on the edges and corners, live, within limits.
import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import appCss from "../styles/app.css?raw";
import { type Box, liveResizes, RESIZE_DIRS, ResizeZones, resizeBox } from "./resize";

const L = { minW: 96, maxW: 320, minH: 44, maxH: 200 };
const start: Box = { x: 100, y: 100, w: 172, h: 72 };
const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

test("item_51_each_edge_and_corner_resizes_its_own_way_within_the_limits", () => {
  expect(resizeBox(start, "e", 30, 99, L)).toEqual({ x: 100, y: 100, w: 202, h: 72 });
  expect(resizeBox(start, "s", 99, 20, L)).toEqual({ x: 100, y: 100, w: 172, h: 92 });
  // The left and top edges move the box, so the far edge stays put.
  expect(resizeBox(start, "w", -20, 0, L)).toEqual({ x: 80, y: 100, w: 192, h: 72 });
  expect(resizeBox(start, "n", 0, -10, L)).toEqual({ x: 100, y: 90, w: 172, h: 82 });
  // Corners resize both ways.
  expect(resizeBox(start, "se", 10, 10, L)).toEqual({ x: 100, y: 100, w: 182, h: 82 });
  expect(resizeBox(start, "nw", 10, 10, L)).toEqual({ x: 110, y: 110, w: 162, h: 62 });
  // Limits: never under 96 x 44, never over 320 x 200; the far edge still stays put.
  expect(resizeBox(start, "se", -500, -500, L)).toEqual({ x: 100, y: 100, w: 96, h: 44 });
  expect(resizeBox(start, "se", 900, 900, L)).toEqual({ x: 100, y: 100, w: 320, h: 200 });
  expect(resizeBox(start, "nw", 500, 500, L)).toEqual({ x: 176, y: 128, w: 96, h: 44 });
  // A diamond or a marker keeps its shape.
  expect(resizeBox({ x: 0, y: 0, w: 116, h: 116 }, "se", 20, 0, L, true)).toEqual({ x: 0, y: 0, w: 136, h: 136 });
});

function Zones({ onLive, onDone }: { onLive: (b: Box) => void; onDone: (b: Box, s: Box) => void }) {
  return (
    <div className="host" style={{ position: "relative" }}>
      <ResizeZones start={() => start} limits={L} onLive={onLive} onDone={onDone} />
    </div>
  );
}

test("item_51_eight_invisible_zones_and_no_square_handles", () => {
  const { container } = render(<Zones onLive={() => {}} onDone={() => {}} />);
  const zones = [...container.querySelectorAll<HTMLElement>(".rz-zone")];
  expect(zones.map((z) => z.dataset.dir)).toEqual([...RESIZE_DIRS]);
  expect(RESIZE_DIRS).toEqual(["n", "s", "e", "w", "nw", "ne", "sw", "se"]);
  for (const z of zones) {
    expect(z.getAttribute("aria-hidden")).toBe("true");
    // The canvas does not drag or pan from a zone.
    expect(z.classList.contains("nodrag")).toBe(true);
    expect(z.classList.contains("nopan")).toBe(true);
  }
  expect(container.querySelector(".selbox i, .fnode-resize")).toBeNull();
});

test("item_51_a_drag_is_live_once_a_frame_shows_its_size_and_ends_once", async () => {
  const onLive = vi.fn();
  const onDone = vi.fn();
  const { container } = render(<Zones onLive={onLive} onDone={onDone} />);
  const se = container.querySelector<HTMLElement>('.rz-zone[data-dir="se"]')!;
  fireEvent.pointerDown(se, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  // Two moves in one frame: one update.
  fireEvent.pointerMove(se, { clientX: 20, clientY: 15, pointerId: 1 });
  fireEvent.pointerMove(se, { clientX: 30, clientY: 20, pointerId: 1 });
  expect(onLive).not.toHaveBeenCalled();
  await frame();
  expect(onLive).toHaveBeenCalledTimes(1);
  expect(onLive.mock.calls[0][0]).toEqual({ x: 100, y: 100, w: 192, h: 82 });
  // The size shows while dragging.
  expect(container.querySelector(".rz-readout")!.textContent).toBe("192 × 82");
  expect(container.querySelector(".rz-dragging")).not.toBeNull();
  fireEvent.pointerUp(se, { clientX: 30, clientY: 20, pointerId: 1 });
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onDone.mock.calls[0].slice(0, 2)).toEqual([{ x: 100, y: 100, w: 192, h: 82 }, start]);
  expect(container.querySelector(".rz-dragging")).toBeNull();
  // A move after the release does nothing.
  fireEvent.pointerMove(se, { clientX: 90, clientY: 90, pointerId: 1 });
  await frame();
  expect(onLive).toHaveBeenCalledTimes(1);
});

test("item_51_release_and_unmount_remove_every_listener", () => {
  const { container, unmount } = render(<Zones onLive={() => {}} onDone={() => {}} />);
  const zone = container.querySelector<HTMLElement>('.rz-zone[data-dir="e"]')!;
  const added: string[] = [];
  const removed: string[] = [];
  const add = zone.addEventListener.bind(zone);
  const remove = zone.removeEventListener.bind(zone);
  zone.addEventListener = ((t: string, f: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
    added.push(t);
    add(t, f, o);
  }) as typeof zone.addEventListener;
  zone.removeEventListener = ((t: string, f: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => {
    removed.push(t);
    remove(t, f, o);
  }) as typeof zone.removeEventListener;
  const win = vi.spyOn(window, "addEventListener");
  fireEvent.pointerDown(zone, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  expect(added.sort()).toEqual(["lostpointercapture", "pointercancel", "pointermove", "pointerup"]);
  expect(win.mock.calls.filter(([t]) => String(t).startsWith("pointer"))).toHaveLength(0);
  fireEvent.pointerUp(zone, { pointerId: 1 });
  expect(removed.sort()).toEqual([...added].sort());
  added.length = 0;
  removed.length = 0;
  fireEvent.pointerDown(zone, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  unmount();
  expect(removed.sort()).toEqual([...added].sort());
  win.mockRestore();
});

test("item_51_zone_css_hit_areas_and_pointers", () => {
  // Every rule whose selector list ends with `sel` (rules with one selector, or the last of a list).
  const rule = (sel: string) =>
    [...appCss.matchAll(new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "g"))].map((m) => m[1]).join("\n");
  // 8 px across each edge (4 in, 4 out), 14 px squares on the corners, in screen px at any zoom, the pointers.
  const k = (n: number) => new RegExp(`calc\\(${n} \\* var\\(--rz-k\\)\\)`);
  expect(rule(".rz-zone")).toMatch(/--rz-k:\s*calc\(1px \/ var\(--rz-zoom, 1\)\)/);
  expect(rule(".rz-n,\n.rz-s")).toMatch(new RegExp(`height:\\s*${k(8).source}`));
  expect(rule(".rz-n,\n.rz-s")).toMatch(/cursor:\s*ns-resize/);
  expect(rule(".rz-n")).toMatch(new RegExp(`top:\\s*${k(-4).source}`));
  expect(rule(".rz-e,\n.rz-w")).toMatch(new RegExp(`width:\\s*${k(8).source}`));
  expect(rule(".rz-e,\n.rz-w")).toMatch(/cursor:\s*ew-resize/);
  expect(rule(".rz-e")).toMatch(new RegExp(`right:\\s*${k(-4).source}`));
  expect(rule(".rz-nw,\n.rz-ne,\n.rz-sw,\n.rz-se")).toMatch(new RegExp(`width:\\s*${k(14).source}`));
  expect(rule(".rz-nw,\n.rz-ne,\n.rz-sw,\n.rz-se")).toMatch(new RegExp(`height:\\s*${k(14).source}`));
  expect(rule(".rz-nw")).toMatch(new RegExp(`left:\\s*${k(-7).source}`));
  expect(rule(".rz-nw")).toMatch(/cursor:\s*nwse-resize/);
  expect(rule(".rz-se")).toMatch(/cursor:\s*nwse-resize/);
  expect(rule(".rz-ne")).toMatch(/cursor:\s*nesw-resize/);
  expect(rule(".rz-sw")).toMatch(/cursor:\s*nesw-resize/);
  // The edges stop where the corners start (7 px), so a corner is never swallowed by an edge.
  expect(rule(".rz-n,\n.rz-s")).toMatch(new RegExp(`left:\\s*${k(7).source}`));
  expect(rule(".rz-e,\n.rz-w")).toMatch(new RegExp(`top:\\s*${k(7).source}`));
  // Nothing is drawn in a zone, and the ports sit above it (z-index 3).
  expect(rule(".rz-zone")).toMatch(/z-index:\s*2/);
  expect(rule(".rz-zone")).not.toMatch(/background:\s*var/);
  expect(rule(".diagram-canvas .react-flow__handle")).toMatch(/z-index:\s*3/);
  // No square handles are left.
  expect(appCss).not.toMatch(/\.selbox i/);
});

test("item_51_a_box_bigger_than_the_caps_never_snaps_down_when_its_own_size_is_the_limit", async () => {
  // Review fix 1: limits from the start box, as the diagram nodes and cards take them.
  const { nodeLimitsFor } = await import("../flow/flowNodes");
  // A class past the 200 px cap and an ER card past its 20 rows (decision 7), each at its own size.
  const erMax = nodeLimitsFor("erTable", { w: 200, h: 100 }).maxH;
  for (const [kind, big] of [
    ["class", { x: 0, y: 0, w: 340, h: 259 }],
    ["erTable", { x: 0, y: 0, w: 340, h: erMax + 40 }],
  ] as const) {
    const lim = nodeLimitsFor(kind, { w: big.w, h: big.h });
    // Its own height is its limit: a 1 px move down keeps it, nothing snaps to the cap.
    expect(resizeBox(big, "s", 0, 1, lim)).toEqual(big);
    expect(resizeBox(big, "e", 1, 0, lim).w).toBe(340);
    expect(resizeBox(big, "s", 0, -1, lim).h).toBe(big.h - 1);
  }
  // An ER card inside its rows stops at 20 of them.
  expect(erMax).toBeGreaterThan(200);
  expect(resizeBox({ x: 0, y: 0, w: 200, h: 100 }, "s", 0, 2000, nodeLimitsFor("erTable", { w: 200, h: 100 })).h).toBe(erMax);
  // A small node keeps the board's caps.
  expect(nodeLimitsFor("process", { w: 150, h: 50 })).toMatchObject({ maxW: 320, maxH: 200 });
});

test("item_51_zones_gone_mid_drag_cancel_cleanly", () => {
  const onCancel = vi.fn();
  const onDone = vi.fn();
  const { container, rerender } = render(
    <div>
      <ResizeZones start={() => start} limits={L} onLive={() => {}} onDone={onDone} onCancel={onCancel} />
    </div>,
  );
  const zone = container.querySelector<HTMLElement>('.rz-zone[data-dir="se"]')!;
  fireEvent.pointerDown(zone, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(zone, { clientX: 30, clientY: 30, pointerId: 1 });
  rerender(<div />);
  expect(onDone).not.toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onCancel.mock.calls[0][0]).toEqual(start);
  // Nothing listens any more: a late release does nothing.
  fireEvent.pointerUp(zone, { pointerId: 1 });
  expect(onDone).not.toHaveBeenCalled();
});

test("item_51_a_node_smaller_than_the_minimum_moves_at_most_a_pixel_on_a_1px_drag", async () => {
  // Branch review fix 1: a node's own size lowers the minimum as it raises the maximum.
  const { nodeLimitsFor } = await import("../flow/flowNodes");
  const cases: [Parameters<typeof nodeLimitsFor>[0], Box, boolean][] = [
    ["start", { x: 0, y: 0, w: 72, h: 36 }, false],
    ["choice", { x: 0, y: 0, w: 64, h: 64 }, true],
    ["state", { x: 0, y: 0, w: 120, h: 40 }, false],
    ["process", { x: 0, y: 0, w: 56, h: 24 }, false],
  ];
  for (const [kind, from, square] of cases) {
    const lim = nodeLimitsFor(kind, from);
    for (const dir of RESIZE_DIRS) {
      for (const d of [1, -1]) {
        const b = resizeBox(from, dir, d, d, lim, square);
        expect({ kind, dir, d, dw: Math.abs(b.w - from.w) <= 1, dh: Math.abs(b.h - from.h) <= 1 }).toEqual({ kind, dir, d, dw: true, dh: true });
      }
    }
    // Still never smaller than the board's minimum once it is bigger than that.
    expect(resizeBox({ ...from, w: 150, h: 60 }, "se", -500, -500, nodeLimitsFor(kind, { w: 150, h: 60 }), square).w).toBe(96);
  }
});

test("a resized node can always go back to its laid-out size, both ways", async () => {
  const { nodeLimitsFor } = await import("../flow/flowNodes");
  // A 72 x 36 start pill grown to 84 x 40 can shrink back to 72 x 36.
  const grown = nodeLimitsFor("start", { w: 84, h: 40 }, { w: 72, h: 36 });
  expect(resizeBox({ x: 0, y: 0, w: 84, h: 40 }, "se", -12, -4, grown, false)).toMatchObject({ w: 72, h: 36 });
  // A 340 px class shrunk to 330 can widen back to 340, and no further.
  const shrunk = nodeLimitsFor("class", { w: 330, h: 120 }, { w: 340, h: 120 });
  expect(resizeBox({ x: 0, y: 0, w: 330, h: 120 }, "e", 40, 0, shrunk, false).w).toBe(340);
});

test("release_a_drag_in_3px_steps_changes_the_box_3px_a_frame_in_both_axes_with_no_snapping", async () => {
  const lives: Box[] = [];
  const { container } = render(<Zones onLive={(b) => lives.push(b)} onDone={() => {}} />);
  const se = container.querySelector<HTMLElement>('.rz-zone[data-dir="se"]')!;
  fireEvent.pointerDown(se, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  for (let i = 1; i <= 6; i++) {
    fireEvent.pointerMove(se, { clientX: 3 * i, clientY: 3 * i, pointerId: 1 });
    await frame();
  }
  expect(lives.map((b) => [b.w, b.h])).toEqual([1, 2, 3, 4, 5, 6].map((i) => [172 + 3 * i, 72 + 3 * i]));
  fireEvent.pointerUp(se, { pointerId: 1 });
  // Nothing rounds the live box: at a 150% zoom a 3 px step is 2 canvas px, at 75% it is 4.
  expect(resizeBox(start, "se", 3 / 1.5, 3 / 1.5, L)).toEqual({ x: 100, y: 100, w: 174, h: 74 });
  expect(resizeBox(start, "se", 1 / 3, 1 / 3, L).w).toBeCloseTo(172.333, 3);
});

test("review_l3_live_boxes_are_kept_per_canvas_so_a_node_with_the_same_id_elsewhere_is_not_touched", () => {
  const a = document.createElement("div");
  const b = document.createElement("div");
  liveResizes(a).set("t1", { x: 1, y: 2, w: 300, h: 100 });
  expect(liveResizes(a).get("t1")).toEqual({ x: 1, y: 2, w: 300, h: 100 });
  expect(liveResizes(b).get("t1")).toBeUndefined();
  expect(liveResizes(a)).toBe(liveResizes(a));
  liveResizes(a).delete("t1");
  expect(liveResizes(a).size).toBe(0);
  // A canvas not yet in the page keeps nothing.
  liveResizes(null).set("t1", { x: 0, y: 0, w: 1, h: 1 });
  expect(liveResizes(null).size).toBe(0);
});

// ---- F26 (diagram): the usual resize modifiers, Esc, and a double-click on an edge to fit.

test("F26 Shift keeps the box's proportions and Alt resizes around its centre", () => {
  // 172 x 72: a corner drag of 86 across keeps 2.39 to 1.
  expect(resizeBox(start, "se", 86, 0, L, false, { ratio: true })).toEqual({ x: 100, y: 100, w: 258, h: 108 });
  // An edge with Shift grows the other side too, about the middle of that side.
  expect(resizeBox(start, "e", 43, 0, L, false, { ratio: true })).toEqual({ x: 100, y: 91, w: 215, h: 90 });
  // Alt: both opposite edges move, the centre stays.
  expect(resizeBox(start, "e", 20, 0, L, false, { centre: true })).toEqual({ x: 80, y: 100, w: 212, h: 72 });
  expect(resizeBox(start, "se", 10, 10, L, false, { centre: true })).toEqual({ x: 90, y: 90, w: 192, h: 92 });
});

test("F26 the keys held on each move decide; Esc during a drag puts the box back and keeps nothing", async () => {
  const onLive = vi.fn();
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const { container } = render(
    <div className="host" style={{ position: "relative" }}>
      <ResizeZones start={() => start} limits={L} onLive={onLive} onDone={onDone} onCancel={onCancel} />
    </div>,
  );
  const e = container.querySelector<HTMLElement>('.rz-zone[data-dir="e"]')!;
  fireEvent.pointerDown(e, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(e, { clientX: 30, clientY: 10, pointerId: 1, altKey: true });
  await frame();
  expect(onLive).toHaveBeenLastCalledWith({ x: 80, y: 100, w: 212, h: 72 }, null);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledWith(start, null);
  fireEvent.pointerUp(e, { clientX: 30, clientY: 10, pointerId: 1 });
  expect(onDone).not.toHaveBeenCalled();
});

test("F26 a double-click on an edge or corner fits the box to its content", () => {
  const onFit = vi.fn();
  const { container } = render(
    <div className="host" style={{ position: "relative" }}>
      <ResizeZones start={() => start} limits={L} onLive={() => {}} onDone={() => {}} onFit={onFit} />
    </div>,
  );
  fireEvent.doubleClick(container.querySelector<HTMLElement>('.rz-zone[data-dir="s"]')!);
  expect(onFit).toHaveBeenCalledTimes(1);
});

test("M9 Shift keeps the proportions at the size caps: both sides stop together", () => {
  // 172 x 72 can grow to 320 wide at most; 72 x 320/172 = 133.95 high, though 200 is allowed.
  const b = resizeBox(start, "se", 900, 0, L, false, { ratio: true });
  expect(b.w).toBe(320);
  expect(b.h).toBeCloseTo((72 * 320) / 172, 5);
});
