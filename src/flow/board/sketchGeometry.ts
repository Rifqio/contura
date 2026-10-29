// A sketch's drawn geometry, shared by the canvas (SketchNode.tsx) and Publish (boardSvg.ts), which must not import a
// React component: one set of numbers and one pair of path builders (B4 R26), never retyped.

/** A sketch's outline width; the geometry here is shared with Publish (B4 Task 3, R26), never retyped. */
export const OUTLINE = 1.5;
/** An arrowhead's length and half width. */
export const HEAD = 10;
export const HEAD_HALF = 5;
/** Corner radii: a rectangle, a Section (dashed by SECTION_DASH) and a note. */
export const RECT_RX = 4;
export const SECTION_RX = 8;
export const SECTION_DASH = "6 4";
export const NOTE_RX = 2;

/** A stroke through `points`, which are relative to the box. */
export const pathOf = (points: readonly [number, number][]) => points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join("");

/** The arrowhead at the last point, along the last segment that has a length. */
export function headOf(points: readonly [number, number][]): string | null {
  const n = points.length;
  if (n < 2) return null;
  const [x2, y2] = points[n - 1];
  let i = n - 2;
  while (i > 0 && points[i][0] === x2 && points[i][1] === y2) i--;
  const [x1, y1] = points[i];
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len === 0) return null;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const bx = x2 - ux * HEAD;
  const by = y2 - uy * HEAD;
  return `M${bx - uy * HEAD_HALF} ${by + ux * HEAD_HALF}L${x2} ${y2}L${bx + uy * HEAD_HALF} ${by - ux * HEAD_HALF}`;
}
