// Board B2 (items 25, 41, 51): resizing on the canvas by pointer zones, not square handles. A selected node or card
// has eight invisible zones: 8 px along each edge (4 in, 4 out) and a 12 px square on each corner, each with its
// resize pointer. A drag is live: the owner draws the new box once a frame. The zones sit under the ports, so a
// port wins at an edge's middle.
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from "react";

export type ResizeDir = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
export const RESIZE_DIRS: readonly ResizeDir[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Limits {
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
}

/**
 * The boxes of nodes being resized right now, by canvas and node id. A canvas that draws its nodes again from its
 * props mid-drag (a preview arriving, an edit elsewhere) keeps these, so the node never jumps back for a frame; another
 * canvas with a node of the same id is not touched. The canvas is its React Flow element (the store's `domNode`;
 * `useStoreApi` hands each component a different wrapper). Entries live only while a drag runs, and a canvas's map
 * goes with its element.
 */
const liveByCanvas = new WeakMap<Element, Map<string, Box>>();
export function liveResizes(canvas: Element | null | undefined): Map<string, Box> {
  if (!canvas) return new Map();
  let live = liveByCanvas.get(canvas);
  if (!live) {
    live = new Map();
    liveByCanvas.set(canvas, live);
  }
  return live;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * The box a drag of `dir` by (dx, dy) canvas px makes: the far edges stay put; `square` keeps a diamond's shape.
 * Nothing is rounded or snapped here: the box follows the pointer exactly, the limits are hard stops, and the owner
 * rounds the size it keeps.
 */
export function resizeBox(start: Box, dir: ResizeDir, dx: number, dy: number, lim: Limits, square = false): Box {
  let w = start.w;
  let h = start.h;
  if (dir.includes("e")) w = clamp(start.w + dx, lim.minW, lim.maxW);
  if (dir.includes("w")) w = clamp(start.w - dx, lim.minW, lim.maxW);
  if (dir.includes("s")) h = clamp(start.h + dy, lim.minH, lim.maxH);
  if (dir.includes("n")) h = clamp(start.h - dy, lim.minH, lim.maxH);
  if (square) {
    const side = dir.length === 2 ? Math.max(w, h) : dir === "e" || dir === "w" ? w : h;
    w = h = clamp(side, Math.max(lim.minW, lim.minH), Math.min(lim.maxW, lim.maxH));
  }
  return { x: dir.includes("w") ? start.x + start.w - w : start.x, y: dir.includes("n") ? start.y + start.h - h : start.y, w, h };
}

/** The canvas zoom at `el`: a screen pixel is 1 / zoom of the canvas's own. */
export function zoomAt(el: Element): number {
  const t = el.closest<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
  return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 1) || 1;
}

export interface ResizeZonesProps {
  /** The box when a drag starts, in canvas px; null refuses the drag. */
  start(): Box | null;
  limits: Limits | ((start: Box) => Limits);
  square?: boolean;
  /**
   * The new box, once a frame while the drag runs. `node` is the canvas node the zones sit in, taken when the drag
   * starts (null outside a canvas), so every callback can reach it even after the zones are gone.
   */
  onLive(box: Box, node: HTMLElement | null): void;
  /** Once, when the drag ends. */
  onDone(box: Box, start: Box, node: HTMLElement | null): void;
  /** The zones went away mid-drag (zoomed out, selection cleared): nothing is kept; the owner puts the box back. */
  onCancel?(start: Box, node: HTMLElement | null): void;
}

/**
 * The eight zones and the size readout. Pointer capture keeps the drag on the zone, so its listeners sit there
 * alone; release and unmount remove every one. React state changes only when a drag starts and ends.
 */
export function ResizeZones({ start, limits, square = false, onLive, onDone, onCancel }: ResizeZonesProps) {
  const [dragging, setDragging] = useState(false);
  const readout = useRef<HTMLSpanElement>(null);
  const stop = useRef<(() => void) | null>(null);
  // A layout-effect cleanup, so a drag cut short ends while the zones are still in the page.
  useLayoutEffect(() => () => stop.current?.(), []);

  const down = (dir: ResizeDir) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || stop.current) return;
    const from = start();
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
    const zone = e.currentTarget;
    const node = zone.closest<HTMLElement>(".react-flow__node");
    const id = e.pointerId;
    try {
      zone.setPointerCapture?.(id);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
    const lim = typeof limits === "function" ? limits(from) : limits;
    const zoom = zoomAt(zone);
    const sx = e.clientX;
    const sy = e.clientY;
    let box = from;
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (readout.current) readout.current.textContent = `${Math.round(box.w)} × ${Math.round(box.h)}`;
      onLive(box, node);
    };
    const move = (ev: PointerEvent) => {
      box = resizeBox(from, dir, (ev.clientX - sx) / zoom, (ev.clientY - sy) / zoom, lim, square);
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const cleanup = (live: boolean) => {
      zone.removeEventListener("pointermove", move);
      zone.removeEventListener("pointerup", end);
      zone.removeEventListener("pointercancel", end);
      zone.removeEventListener("lostpointercapture", end);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      try {
        if (zone.hasPointerCapture?.(id)) zone.releasePointerCapture(id);
      } catch {
        // Already released.
      }
      stop.current = null;
      if (live) setDragging(false);
    };
    function end() {
      cleanup(true);
      onDone(box, from!, node);
    }
    zone.addEventListener("pointermove", move);
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
    zone.addEventListener("lostpointercapture", end);
    stop.current = () => {
      cleanup(false);
      onCancel?.(from!, node);
    };
    if (readout.current) readout.current.textContent = `${Math.round(from.w)} × ${Math.round(from.h)}`;
    setDragging(true);
  };

  return (
    <>
      {RESIZE_DIRS.map((d) => (
        <span key={d} className={`rz-zone rz-${d} nodrag nopan${dragging ? " rz-dragging" : ""}`} data-dir={d} aria-hidden="true" onPointerDown={down(d)} />
      ))}
      <span ref={readout} className={dragging ? "rz-readout rz-readout-on" : "rz-readout"} aria-hidden="true" />
    </>
  );
}
