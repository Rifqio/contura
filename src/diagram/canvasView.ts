// What the canvas and the board's detail policy share about the view. `src/diagram/` imports nothing from
// `src/flow/`; the board reads these from here.
import { getViewportForBounds } from "@xyflow/react";

/** Zoom goes down to 10 percent. */
export const MIN_ZOOM = 0.1;
/** Zoom goes to 400 percent (Figma and draw.io go further than React Flow's 200). */
export const MAX_ZOOM = 4;
/**
 * A board's live anchor: the zero-size node the live frame's shapes hang from, at the live frame's
 * place on the board. Mirrors `LIVE_ANCHOR_ID` in src/flow/board/boardScene.ts (diagram/ does not import flow/);
 * DiagramCanvas.test.tsx checks the two are equal.
 */
export const LIVE_ANCHOR = "\u0000live";
/** The 13 px per-character width estimate the board's tab text and the soft bars use. */
export const SOFT_CHAR_W = 7;
/**
 * A far ER card's rows as bars, in px inside the card's rows body; drawn by the canvas (kindNodes
 * `ErBars`) and a frame picture (svg.ts) alike, so a row does not jump when a frame turns from picture to real. `h` is
 * a bar's height (times the text size); the name bar starts `from` in (10 px padding, the 18 px gutter, 6 px gap) and
 * the type bar ends `to` before the right (the 8 px not-null mark and its 6 px gap); a key row's mark is a `key` px
 * square centred `keyMid` in, in the gutter.
 */
export const ER_FAR_ROW = { h: 8, from: 34, to: 24, key: 6, keyMid: 19 } as const;

/** The visible rect in flow units, with the zoom that shows it. */
export interface CanvasView {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
}

/**
 * Where a glide lands: a box to fit with padding (opening at its start where it overflows, `fitFromStart`; `maxZoom`
 * caps the fit below the canvas's own), or a centre at a zoom.
 */
export type ViewTarget =
  | { bounds: { x: number; y: number; width: number; height: number }; padding: number; maxZoom?: number }
  | { center: { x: number; y: number }; zoom: number };

export interface CanvasHandle {
  /** Glides to the target, reporting the landing view once first. */
  glideView(to: ViewTarget): Promise<void>;
  /**
   * Ends the glide under way, as a pan or zoom the user starts does: for a move that comes with no event (the board
   * map's drag), so its views are reported as they come.
   */
  cancelGlide(): void;
}

/**
 * A fit's view for bounds that may not fit even at the least zoom: on each side they overflow, their start (left or
 * top edge) sits a margin in from the view's instead of their middle at the view's middle, so the drawing opens at its
 * start (a page larger than the window opens at its top left, as draw.io and every document viewer do). A side that
 * fits keeps the fit's centring. `padding` is the fit's (React Flow's fraction of the bounds); the margin is half of it.
 */
export function fitFromStart(
  v: { x: number; y: number; zoom: number },
  b: { x: number; y: number; width: number; height: number },
  w: number,
  h: number,
  padding: number,
): { x: number; y: number; zoom: number } {
  return {
    zoom: v.zoom,
    x: b.width * v.zoom > w ? (w * padding) / 2 - b.x * v.zoom : v.x,
    y: b.height * v.zoom > h ? (h * padding) / 2 - b.y * v.zoom : v.y,
  };
}

/** React Flow's fit of bounds `b` in a `w` by `h` view, opening at its start where it overflows (`fitFromStart`). */
export function fitBoundsView(
  b: { x: number; y: number; width: number; height: number },
  w: number,
  h: number,
  minZoom: number,
  maxZoom: number,
  padding: number,
): { x: number; y: number; zoom: number } {
  return fitFromStart(getViewportForBounds(b, w, h, minZoom, maxZoom, padding), b, w, h, padding);
}

/** The view a React Flow viewport shows in a `w` by `h` pane, in flow units. */
export function viewOf(vp: { x: number; y: number; zoom: number }, w: number, h: number): CanvasView {
  return { x: 0 - vp.x / vp.zoom, y: 0 - vp.y / vp.zoom, w: w / vp.zoom, h: h / vp.zoom, zoom: vp.zoom };
}

/** `deltaY` of a wheel event in pixels: lines (`deltaMode` 1) are 16 px, pages (2) the view's height. */
export function wheelDy(e: { deltaY: number; deltaMode: number }, viewH: number): number {
  return e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * viewH : e.deltaY;
}

/**
 * The view after one Ctrl+wheel or pinch event: the zoom times `exp(-dy * 0.002)`, the event's
 * factor held to [0.5, 2] and the zoom to [MIN_ZOOM, MAX_ZOOM]; the point `at` (pane pixels) stays where it is.
 */
export function wheelZoom(
  v: { x: number; y: number; zoom: number },
  at: { x: number; y: number },
  dy: number,
): { x: number; y: number; zoom: number } {
  const factor = Math.max(0.5, Math.min(2, Math.exp(-dy * 0.002)));
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor));
  const k = zoom / v.zoom;
  return { x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k, zoom };
}
