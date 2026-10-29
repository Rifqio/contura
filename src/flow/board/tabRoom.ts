// A frame's title tab strip fits the room it has on screen (coordinator ruling on F1, 28 Oct): it never runs into the
// next frame's tab. Short of room, the kind word goes first (the icon still shows the kind, and the full name stays in
// the tab's accessible name and tooltip), then the frame's name ends in an ellipsis (Figma's frame label shows the
// frame's name); the selected frame's AI Chat and Code Editor hide only when even they do not fit, Code Editor last.
import { DIAGRAM_KIND_WORD } from "../diagramKinds";
import { tabHeight } from "./boardDetail";
import { MIN_ZOOM } from "../../diagram/canvasView";
import { FRAME_TAB_H, type FrameBox, TAB_CHAR_W, TAB_GAP, TAB_ICON, TAB_PAD_X, TAB_TITLE_MAX } from "./boardScene";

/** Another frame whose tab starts to the right of this one's: how far right (`dx`) and how far down (`dy`), board units. */
export interface TabNeighbour {
  dx: number;
  dy: number;
}

/** The boxes by their left edge, once per board build, for `tabNeighbours`. */
export function byLeft<T extends { x: number }>(boxes: readonly T[]): T[] {
  return [...boxes].sort((a, b) => a.x - b.x);
}

/** The farthest a tab row reaches at the least zoom: a tab further down or up never shares a row. */
const BAND_MAX = tabHeight(MIN_ZOOM);

/**
 * The frames whose tabs start to the right of `box`'s and can share its row at some zoom, nearest first, from boxes
 * sorted by `byLeft`. A farther tab that shares the row only when a nearer one does too is left out (it can never end
 * the room), so the list is a short staircase of ever smaller `|dy|`.
 */
export function tabNeighbours(box: Pick<FrameBox, "index" | "x" | "y">, sorted: readonly Pick<FrameBox, "index" | "x" | "y">[]): TabNeighbour[] {
  const out: TabNeighbour[] = [];
  let band = BAND_MAX;
  for (const b of sorted) {
    if (b.x <= box.x || b.index === box.index) continue;
    const dy = b.y - box.y;
    if (Math.abs(dy) >= band) continue;
    out.push({ dx: b.x - box.x, dy });
    band = Math.abs(dy);
    if (band < FRAME_TAB_H) break;
  }
  return out;
}

/**
 * The strip's room in board units at `zoom`: from its left edge to the nearest tab in the same row band (the strips'
 * heights overlap, Decision 5's `tabHeight`), never less than the frame's own width; Infinity when no tab is in the way.
 */
export function tabRoom(frameW: number, neighbours: readonly TabNeighbour[], zoom: number): number {
  const h = tabHeight(zoom);
  for (const n of neighbours) if (Math.abs(n.dy) < h) return Math.max(frameW, n.dx);
  return Infinity;
}

/** The strip's room in its own CSS px: below 100 percent it keeps its screen size, so CSS px are screen px. */
export const roomCss = (room: number, zoom: number) => room * Math.min(zoom, 1);

/** The gap between the strip's buttons, a pane button's padding, icon and gap, and the problems count's. */
const STRIP_GAP = 4;
const PANE_CHROME = 8 + 14 + 6 + 8;
const PENDING_W = 6 + 16;
const PROBLEMS_CHROME = 6 + 14 + 4 + 6;
/**
 * A cut title has no kind word (it goes first, and takes its gap with it); it keeps its icon and the name's first
 * character with the ellipsis after it ("R…", two characters' room).
 */
const CUT_MIN = TAB_PAD_X + TAB_ICON + TAB_GAP + 2 * TAB_CHAR_W + TAB_PAD_X;

/**
 * What the strip shows: everything, a cut title, the cut title and Code Editor, or the cut title alone. Only "all" shows
 * the kind word: a title short of room drops it before its name is cut.
 */
export type StripFit = "all" | "title" | "editor" | "none";

/** The widths the strip's parts need, by the 7 px per character estimate the tab hit test uses. */
export function stripParts(box: Pick<FrameBox, "kind" | "title" | "problems">, pending: number) {
  const word = DIAGRAM_KIND_WORD[box.kind ?? "unknown"].length * TAB_CHAR_W;
  const name = Math.min((box.title || "Untitled").length * TAB_CHAR_W, TAB_TITLE_MAX);
  const chrome = TAB_PAD_X + TAB_ICON + TAB_GAP + word + TAB_GAP + TAB_PAD_X;
  const problems = box.problems > 0 ? STRIP_GAP + PROBLEMS_CHROME + box.problems.toLocaleString("en-US").length * TAB_CHAR_W : 0;
  return {
    title: chrome + name,
    // Without the kind word: the icon, the name's gap and as much of the name as fits, down to "R…".
    titleMin: Math.min(TAB_PAD_X + TAB_ICON + TAB_GAP + name + TAB_PAD_X, CUT_MIN),
    problems,
    assistant: STRIP_GAP + PANE_CHROME + "AI Chat".length * TAB_CHAR_W + (pending > 0 ? PENDING_W : 0),
    editor: STRIP_GAP + PANE_CHROME + "Code Editor".length * TAB_CHAR_W,
  };
}

/** What fits in `room` CSS px. Without the pane buttons (a frame not selected) only the title can be cut. */
export function stripFit(room: number, parts: ReturnType<typeof stripParts>, panes: boolean): StripFit {
  const fixed = parts.problems + (panes ? parts.assistant + parts.editor : 0);
  if (room >= parts.title + fixed) return "all";
  if (!panes || room >= parts.titleMin + fixed) return "title";
  if (room >= parts.titleMin + parts.problems + parts.editor) return "editor";
  return "none";
}

/**
 * The zooms at which a strip's room or what fits in it changes, ascending: where a neighbour's tab enters or leaves the
 * row band, and where the room on screen crosses a part's width. Between two of them both stay the same, so a frame
 * selects only which interval the zoom is in (`breakIndex`), and works out the strip from it (`stripAt`).
 */
export function stripBreaks(frameW: number, neighbours: readonly TabNeighbour[], parts: ReturnType<typeof stripParts>, panes: boolean): number[] {
  const out: number[] = [];
  // A tab |dy| away shares the row while tabHeight(zoom) > |dy|, that is below FRAME_TAB_H / |dy|.
  for (const n of neighbours) if (Math.abs(n.dy) >= FRAME_TAB_H) out.push(FRAME_TAB_H / Math.abs(n.dy));
  // The widths `stripFit` compares the room with.
  const needs = panes
    ? [parts.title + parts.problems + parts.assistant + parts.editor, parts.titleMin + parts.problems + parts.assistant + parts.editor, parts.titleMin + parts.problems + parts.editor]
    : [parts.title + parts.problems];
  for (const n of neighbours) {
    const room = Math.max(frameW, n.dx);
    // Below 100 percent the room on screen is room * zoom; at and above it, the room itself.
    for (const need of needs) if (need <= room) out.push(need / room);
  }
  return out.filter((z) => z > 0 && z <= 1).sort((a, b) => a - b);
}

/** Which interval of `breaks` the zoom is in: how many breaks are at or below it. Allocates nothing. */
export function breakIndex(breaks: readonly number[], zoom: number): number {
  let i = 0;
  while (i < breaks.length && breaks[i] <= zoom) i++;
  return i;
}

/** The strip in interval `i` of `breaks`: its room in board units and what fits, read at the interval's middle. */
export function stripAt(frameW: number, neighbours: readonly TabNeighbour[], parts: ReturnType<typeof stripParts>, panes: boolean, breaks: readonly number[], i: number): { room: number; fit: StripFit } {
  const lo = i === 0 ? 0 : breaks[i - 1];
  const hi = i === breaks.length ? 2 : breaks[i];
  const zoom = (lo + hi) / 2;
  const room = tabRoom(frameW, neighbours, zoom);
  return { room, fit: room === Infinity ? "all" : stripFit(roomCss(room, zoom), parts, panes) };
}
