// Where a Shelf add lands on the board (B2 decision 7): the kinds whose nodes take an icon, and the frame under a board
// point. Kept outside `shelf/` while Task 6 edits that folder; `shelf/place.ts` is its planned home.
import type { DiagramKind } from "../../lang/flow/model";
import type { FrameBox } from "./boardScene";

type Point = { x: number; y: number };

/** The kinds an icon becomes a node in (`[icon: name]`); anywhere else it is an icon sketch (R28). */
export const ICON_NODE_KINDS: ReadonlySet<DiagramKind> = new Set(["flow", "dfd", "state", "cloud", "mindmap"]);

/**
 * The frame on top at board point `p`: each canvas box read as `box + origin` (R1, M1). The live frame (keyed
 * `liveKey`) first, else the later frame in text order, as B1's overlap rule picks; sketches never count.
 */
export function frameAtPoint(boxes: readonly FrameBox[], origin: Point, p: Point, liveKey: string | null): FrameBox | null {
  const inside = (b: FrameBox) => p.x >= b.x + origin.x && p.x <= b.x + origin.x + b.w && p.y >= b.y + origin.y && p.y <= b.y + origin.y + b.h;
  let hit: FrameBox | null = null;
  for (const b of boxes) {
    if (!inside(b)) continue;
    if (liveKey !== null && b.key === liveKey) return b;
    hit = b;
  }
  return hit;
}
