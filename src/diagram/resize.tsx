// Board B2 (items 25, 41, 51): resizing on the canvas by pointer zones, not square handles. A selected node or card
// has eight invisible zones: 8 px along each edge (4 in, 4 out) and a 12 px square on each corner, each with its
// resize pointer. A drag is live: the owner draws the new box once a frame. The zones sit under the ports, so a
// port wins at an edge's middle.
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from "react";
import { useZoomVar } from "./zoomVar";

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

/** The usual resize modifiers (F26, draw.io and Figma): Shift keeps the proportions, Alt resizes around the centre. */
export interface ResizeMods {
  ratio?: boolean;
  centre?: boolean;
}

/**
 * The box a drag of `dir` by (dx, dy) canvas px makes: the far edges stay put; `square` keeps a diamond's shape.
 * With `ratio` the box keeps its proportions (an edge drag grows the other side about its middle); with `centre`
 * the opposite edges move too, so the centre stays. Nothing is rounded or snapped here: the box follows the pointer
 * exactly, the limits are hard stops, and the owner rounds the size it keeps.
 */
export function resizeBox(start: Box, dir: ResizeDir, dx: number, dy: number, lim: Limits, square = false, mods: ResizeMods = {}): Box {
  const k = mods.centre ? 2 : 1;
  const horiz = dir.includes("e") || dir.includes("w");
  const vert = dir.includes("n") || dir.includes("s");
  let w = start.w;
  let h = start.h;
  if (dir.includes("e")) w = start.w + dx * k;
  if (dir.includes("w")) w = start.w - dx * k;
  if (dir.includes("s")) h = start.h + dy * k;
  if (dir.includes("n")) h = start.h - dy * k;
  if (mods.ratio && start.w > 0 && start.h > 0) {
    let scale = horiz && vert ? Math.max(w / start.w, h / start.h) : horiz ? w / start.w : h / start.h;
    // Both sides stop together at the caps, so the proportions hold there too (M9).
    scale = Math.min(Math.max(scale, lim.minW / start.w, lim.minH / start.h), lim.maxW / start.w, lim.maxH / start.h);
    w = start.w * scale;
    h = start.h * scale;
  }
  w = clamp(w, lim.minW, lim.maxW);
  h = clamp(h, lim.minH, lim.maxH);
  if (square) {
    const side = dir.length === 2 ? Math.max(w, h) : dir === "e" || dir === "w" ? w : h;
    w = h = clamp(side, Math.max(lim.minW, lim.minH), Math.min(lim.maxW, lim.maxH));
  }
  // Which way each side grows: from the centre (Alt, or the side a Shift edge drag grows), else away from the far edge.
  const midX = mods.centre || (mods.ratio && !horiz);
  const midY = mods.centre || (mods.ratio && !vert);
  const x = midX ? start.x + (start.w - w) / 2 : dir.includes("w") ? start.x + start.w - w : start.x;
  const y = midY ? start.y + (start.h - h) / 2 : dir.includes("n") ? start.y + start.h - h : start.y;
  return { x, y, w, h };
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
  /** The zones went away mid-drag (zoomed out, selection cleared) or Esc was pressed: nothing is kept; the owner puts the box back. */
  onCancel?(start: Box, node: HTMLElement | null): void;
  /** A double-click on an edge or corner: the box fits its content again (draw.io; erd-ux-research 5.5). */
  onFit?(): void;
}

/**
 * The eight zones and the size readout. Pointer capture keeps the drag on the zone, so its listeners sit there
 * alone; release and unmount remove every one. React state changes only when a drag starts and ends.
 */
export function ResizeZones({ start, limits, square = false, onLive, onDone, onCancel, onFit }: ResizeZonesProps) {
  const [dragging, setDragging] = useState(false);
  const readout = useRef<HTMLSpanElement>(null);
  // Each zone keeps its screen size by the zoom, given to the zones alone (Task 9 fix 2).
  const zoomVar = useZoomVar<HTMLSpanElement>();
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
      box = resizeBox(from, dir, (ev.clientX - sx) / zoom, (ev.clientY - sy) / zoom, lim, square, { ratio: ev.shiftKey, centre: ev.altKey });
      if (!frame) frame = requestAnimationFrame(paint);
    };
    // Esc puts the box back where it was (F26).
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      cleanup(true);
      onCancel?.(from!, node);
    };
    const cleanup = (live: boolean) => {
      zone.removeEventListener("pointermove", move);
      zone.removeEventListener("pointerup", end);
      zone.removeEventListener("pointercancel", end);
      zone.removeEventListener("lostpointercapture", end);
      window.removeEventListener("keydown", key, true);
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
    window.addEventListener("keydown", key, true);
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
        <span key={d} ref={zoomVar} className={`rz-zone rz-${d} nodrag nopan${dragging ? " rz-dragging" : ""}`} data-dir={d} aria-hidden="true" onPointerDown={down(d)} onDoubleClick={onFit && ((e) => {
          e.stopPropagation();
          onFit();
        })} />
      ))}
      <span ref={readout} className={dragging ? "rz-readout rz-readout-on" : "rz-readout"} aria-hidden="true" />
    </>
  );
}
