import type { CanvasView } from "../../diagram/canvasView";
import { type TextSize, TEXT_SCALE } from "./boardLayout";
import { FRAME_TAB_H, type FrameBox } from "./boardScene";

// The board's own detail policy, pure: every board threshold lives here.

export type { CanvasView as BoardView } from "../../diagram/canvasView";

/** The body type token (`--font-body-size`), pinned by a stylesheet test. */
export const BODY_PX = 13;
/** Text smaller than this on screen is far: drawn as soft lines. */
export const READABLE_PX = 6;
/** Far text is readable again only at the threshold times this, so a wheel jitter flips it once. */
export const FAR_HYSTERESIS = 1.08;
/** The view grows by this fraction of its width and height on each side before frames are culled. */
export const OVERSCAN = 0.5;
/** Past this many static shapes drawn real in view, every static frame in view draws as a picture. */
export const BOARD_SIMPLIFY_OVER = 3_000;
/**
 * Shapes and lines a frame swap may mount in one animation frame (only lowered). A frame's lines count: they mount in
 * chunks after its shapes (Task 9: all 300 of a frame's labelled lines came with its last shape). Set in Task 9 from
 * the limit board's zoom across the readable line (43 to 52 percent; React's own render and commit of each step, in
 * jsdom): the worst step took 54.9 ms at 80, 49.9 ms at 40 and 22.7 ms at 20, against the 50 ms frame gate before the
 * WebView lays out and paints. At 20 a limit frame (198 shapes, 300 lines) is real in 25 frames, its picture under it.
 */
export const SWAP_BUDGET_SHAPES = 20;
/** The least the swap budget falls to while frames run long. */
export const SWAP_BUDGET_MIN = 5;
/** A frame longer than this halves the swap budget; one over the 50 ms frame gate also mounts nothing. */
export const SWAP_FRAME_MS = 33;
/** A frame shorter than this (one 60 Hz frame and a bit) doubles the swap budget back toward SWAP_BUDGET_SHAPES. */
const SWAP_QUICK_MS = 20;

/**
 * The swap budget of one animation frame, from the budget left by the last step and how long the frame
 * it follows took: what the WebView's own layout and paint cost is not known to the plan, so the step reads it off the
 * frames. On the release WebView a mid zoom on B1's frames (1,000 parts turning real from 52 percent) ran 51 to 94 ms
 * frames at a flat 20 parts. Over 50 ms: nothing is mounted this frame and the budget halves; over SWAP_FRAME_MS it
 * halves; under SWAP_QUICK_MS it doubles; between, it holds. Never past `most` (SWAP_BUDGET_SHAPES), never under
 * SWAP_BUDGET_MIN unless `most` is.
 */
export function swapBudget(was: number, frameMs: number, most: number = SWAP_BUDGET_SHAPES): { now: number; next: number } {
  if (frameMs > SWAP_FRAME_MS) {
    const next = Math.min(most, Math.max(SWAP_BUDGET_MIN, Math.floor(was / 2)));
    return { now: frameMs > 50 ? 0 : next, next };
  }
  const next = Math.min(most, frameMs < SWAP_QUICK_MS ? was * 2 : was);
  return { now: next, next };
}

/** Longest a picture build may hold one task, in ms. */
export const PICTURE_SLICE_MS = 8;

const SIZES: readonly TextSize[] = ["s", "m", "l"];

/** The zoom below which text of this size is far. */
export function textFarBelow(size: TextSize): number {
  return READABLE_PX / (BODY_PX * TEXT_SCALE[size]);
}

/** The sizes whose text is far at this zoom; a size already far stays far until the hysteresis band is crossed. */
export function farSizes(zoom: number, was: ReadonlySet<TextSize>): ReadonlySet<TextSize> {
  const out = new Set<TextSize>();
  for (const s of SIZES) {
    const t = textFarBelow(s);
    if (zoom < (was.has(s) ? t * FAR_HYSTERESIS : t)) out.add(s);
  }
  return out;
}

/** A frame's tab strip in board units: it keeps its screen height below 100 percent. */
export function tabHeight(zoom: number): number {
  return FRAME_TAB_H / Math.min(zoom, 1);
}

export type FrameForm = "real" | "picture" | "picture-text";

export interface FrameDrawInput {
  boxes: readonly FrameBox[];
  sizes: readonly TextSize[];
  shapes: readonly number[];
  /** The drawn-live frame's index. */
  live: number | null;
  dragging: number | null;
  dragForm: FrameForm | null;
  view: CanvasView;
  wasFar: ReadonlySet<TextSize>;
}

export interface FrameDrawPlan {
  far: ReadonlySet<TextSize>;
  /** Each drawn frame's target form; an index absent is not drawn. */
  form: ReadonlyMap<number, FrameForm>;
  key: string;
}

function inView(b: FrameBox, v: CanvasView, tab: number): boolean {
  const mx = v.w * OVERSCAN;
  const my = v.h * OVERSCAN;
  return b.x + b.w >= v.x - mx && b.x <= v.x + v.w + mx && b.y + b.h >= v.y - my && b.y - tab <= v.y + v.h + my;
}

export function frameDraw(i: FrameDrawInput): FrameDrawPlan {
  const far = farSizes(i.view.zoom, i.wasFar);
  const tab = tabHeight(i.view.zoom);
  const form = new Map<number, FrameForm>();
  const readable: number[] = [];
  let shapesReal = 0;
  for (let n = 0; n < i.boxes.length; n++) {
    const index = i.boxes[n].index;
    if (index === i.live) {
      form.set(index, "real");
    } else if (index === i.dragging) {
      form.set(index, i.dragForm ?? "real");
    } else if (inView(i.boxes[n], i.view, tab)) {
      if (far.has(i.sizes[index])) {
        form.set(index, "picture");
      } else {
        form.set(index, "real");
        readable.push(index);
        shapesReal += i.shapes[index];
      }
    }
  }
  if (shapesReal > BOARD_SIMPLIFY_OVER) for (const index of readable) form.set(index, "picture-text");
  const pairs = [...form.keys()].sort((a, b) => a - b).map((k) => `${k}:${form.get(k)}`);
  return { far, form, key: `${SIZES.filter((s) => far.has(s)).join("")}|${pairs.join(",")}` };
}

export interface DrawnForms {
  form: ReadonlyMap<number, FrameForm>;
  /** Parts (children, then lines) mounted so far for a frame turning real. */
  mounted: ReadonlyMap<number, number>;
}

/**
 * One animation frame of Decision 7: moves the drawn forms toward the plan. A frame leaving the view goes at once; one
 * turning into a picture waits for `ready`; one turning real mounts at most `budget` parts in all this step (nearest
 * `toward` first) and keeps its form until its last part is in. `parts` is each frame's shapes plus its lines.
 */
export function stepForms(
  target: FrameDrawPlan,
  drawn: DrawnForms,
  ready: (index: number) => boolean,
  parts: readonly number[],
  centres: readonly { x: number; y: number }[],
  toward: { x: number; y: number },
  budget: number,
): DrawnForms {
  const form = new Map<number, FrameForm>();
  const mounted = new Map<number, number>();
  const turningReal: number[] = [];
  for (const [index, want] of target.form) {
    const have = drawn.form.get(index);
    if (want === "real") {
      if (have === "real") form.set(index, "real");
      else {
        if (have) form.set(index, have);
        turningReal.push(index);
      }
    } else if (have === want || ready(index)) form.set(index, want);
    else if (have) form.set(index, have);
  }
  const dist = (n: number) => (centres[n].x - toward.x) ** 2 + (centres[n].y - toward.y) ** 2;
  turningReal.sort((a, b) => dist(a) - dist(b) || a - b);
  let left = budget;
  for (const index of turningReal) {
    const total = parts[index];
    const so = drawn.mounted.get(index) ?? 0;
    const now = Math.min(total, so + Math.max(0, left));
    left -= now - so;
    if (now >= total) form.set(index, "real");
    else if (now > 0) mounted.set(index, now);
  }
  return { form, mounted };
}

/**
 * `drawn` with the live frame real. The live frame draws its own shapes, so in the drawn forms it
 * is real: when it stops being live and the plan pictures it, `stepForms` waits for its new picture (`ready`) instead
 * of keeping a picture form left from before it went live, whose image is from before any edit made while live.
 */
export function withLiveReal(drawn: DrawnForms, live: number | null): DrawnForms {
  if (live === null || (drawn.form.get(live) === "real" && !drawn.mounted.has(live))) return drawn;
  const form = new Map(drawn.form);
  form.set(live, "real");
  const mounted = new Map(drawn.mounted);
  mounted.delete(live);
  return { form, mounted };
}

/**
 * How the sketch layer is drawn: `pictured` while its tile pictures show, with its first `mounted`
 * sketches real over them while it turns real; every sketch real once `pictured` is false.
 */
export interface SketchForm {
  pictured: boolean;
  mounted: number;
}

export const SKETCHES_REAL: SketchForm = { pictured: false, mounted: 0 };

/**
 * Whether the sketch layer is wanted as pictures: while body text is far (the plan's own far sizes, so it flips with
 * the frames' hysteresis), and never while a sketch is picked or a sketch tool is armed (they work on real sketches).
 */
export const sketchesFar = (far: ReadonlySet<TextSize>, busy: boolean): boolean => !busy && far.has("m");

/**
 * One animation frame of the sketch layer toward `want` (pictured or not), as `stepForms` moves frames: it turns into
 * its pictures once they are `ready`, and turns real `budget` sketches a frame over them (real once the last is in).
 * `budget` is what the frames left this frame; `now` turns it real at once (a sketch picked, a sketch tool armed).
 */
export function stepSketches(want: boolean, was: SketchForm, ready: boolean, total: number, budget: number, now: boolean): SketchForm {
  if (want) {
    if (was.pictured && was.mounted === 0) return was;
    return ready ? { pictured: true, mounted: 0 } : was;
  }
  if (!was.pictured) return was;
  if (now) return SKETCHES_REAL;
  const mounted = Math.min(total, was.mounted + Math.max(0, budget));
  if (mounted >= total) return SKETCHES_REAL;
  return mounted === was.mounted ? was : { pictured: true, mounted };
}
