// Where the Shelf's adds land, in board coordinates (B2 decision 7).
import type { Point } from "../../interactions/geometry";
import { FRAME_GAP } from "../boardLayout";

type Size = { w: number; h: number };

/** The top-left that centres a box of `size` on `centre`, in whole units. */
export function centredAt(centre: Point, size: Size): Point {
  return { x: Math.round(centre.x - size.w / 2), y: Math.round(centre.y - size.h / 2) };
}

/** Boxes of `sizes` in one row, `gap` apart and top-aligned, the row's box centred on `centre`: each box's top-left. */
export function placeFrames(sizes: readonly Size[], centre: Point, gap = FRAME_GAP): Point[] {
  if (sizes.length === 0) return [];
  let w = gap * (sizes.length - 1);
  let h = 0;
  for (const s of sizes) {
    w += s.w;
    h = Math.max(h, s.h);
  }
  const at = centredAt(centre, { w, h });
  const out: Point[] = [];
  let x = at.x;
  for (const s of sizes) {
    out.push({ x: Math.round(x), y: at.y });
    x += s.w + gap;
  }
  return out;
}
