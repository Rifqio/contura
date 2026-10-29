// The board Ask's request (Plan D Decision 1): every frame from the worker's one `boardOutline` answer with its box on
// the canvas, the chips, the selection and the sketches read as notes (Decision 4). Pure: the Ask hands it the worker's
// answer and the scene, so the request is built and tested without a canvas.
import type { BoardInput, DiagramAskRequest, FrameSourceIn, SketchNote, TableLinkIn } from "../../api/types";
import { type DiagramKind, MAX_BOARD_FRAMES } from "../../lang/flow/model";
import type { BoardOutlineFrame, FlowResult } from "../../lang/flow/service";
import { type BoardLayout, MAX_SKETCHES, type Sketch } from "../board/boardLayout";
import type { BoardSceneOut, FrameBox, PartBox } from "../board/boardScene";

/** How far from a part an arrow's head may end and still point at it, and its tail start and still come from a note. */
export const POINT_AT_PX = 48;
/** The most `tableLinks` a request carries: the Core's `MAX_TABLE_LINKS`. Its own read of the text gates the rest. */
export const MAX_TABLE_LINKS = 500;
/** How far from a frame a note still reads as near it: the Core's NEIGHBOUR_GAP. */
export const NEAR_PX = 400;
/** The most selected shapes and sketches a request names (Decision 5's "selection names at most 200"). */
export const SELECTED_MAX = 200;

export type BoardSelected = BoardInput["selected"];
export type FollowUpReply = NonNullable<BoardInput["followUp"]>;

type Box = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };

/** The scene's frame boxes in board units: the canvas is in board units (Plan F Decision 11), so they are its own. */
export function onBoard(scene: Pick<BoardSceneOut, "boxes">): FrameBox[] {
  return scene.boxes;
}

/** The distance from `p` to `b`; 0 inside it. */
function gap(p: Point, b: Box): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

const inside = (p: Point, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** The words a sketch carries: its text, an icon's pack name (A12); empty for a pen stroke. */
function wordsOf(s: Sketch): string {
  if (s.kind === "pen") return "";
  if (s.kind === "icon") return s.icon ?? "";
  return s.text?.trim() ?? "";
}

/** An arrow's or line's tail and head in board units: its first and last points (the box's corners with none). */
function ends(s: Sketch): [Point, Point] {
  const pts = s.points && s.points.length > 0 ? s.points : ([[0, 0], [s.w, s.h]] as [number, number][]);
  const [tx, ty] = pts[0];
  const [hx, hy] = pts[pts.length - 1];
  return [
    { x: s.x + tx, y: s.y + ty },
    { x: s.x + hx, y: s.y + hy },
  ];
}

/** The frames a part search walks: each frame's parts with the box around them, so a far frame is passed over. */
type PartFrame = { title: string; parts: readonly PartBox[]; around: Box };

function partFrames(parts: ReadonlyMap<string, readonly PartBox[]>): PartFrame[] {
  const out: PartFrame[] = [];
  for (const [title, list] of parts) {
    if (list.length === 0) continue;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const p of list) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.w);
      y1 = Math.max(y1, p.y + p.h);
    }
    out.push({ title, parts: list, around: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  return out;
}

/** The part nearest `p` within POINT_AT_PX; a shape inside a group wins over the group (the smaller box on a tie). */
function nearestPart(p: Point, frames: readonly PartFrame[]): { frame: string; name: string } | null {
  let best: { frame: string; name: string } | null = null;
  let bestGap = POINT_AT_PX;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const f of frames) {
    if (gap(p, f.around) > bestGap) continue;
    for (const part of f.parts) {
      const d = gap(p, part);
      const area = part.w * part.h;
      if (d < bestGap || (d === bestGap && area < bestArea)) {
        best = { frame: f.title, name: part.name };
        bestGap = d;
        bestArea = area;
      }
    }
  }
  return best;
}

/** The kinds an arrow's tail can come from: notes and text, and shapes only while they carry words. */
const TAIL_KINDS: ReadonlySet<Sketch["kind"]> = new Set<Sketch["kind"]>(["text", "note", "rect", "ellipse", "diamond"]);

/**
 * The board's sketches as notes for the board Ask (Decision 4), in the sketches' order. An arrow or line points at the
 * frame part nearest its head within POINT_AT_PX and comes `from` the note, text or labelled rect, ellipse or diamond
 * nearest its tail within POINT_AT_PX (by sketch id; the Core prints its text). Text, notes, labelled shapes, icons (by
 * pack name, A12) and sections (by title) are notes `on` the frame holding their centre, else `near` the nearest frame
 * within NEAR_PX. Pen strokes, empty shapes and arrows that say nothing are left out. `boxes` and `parts` are in board
 * units (`onBoard`, `boardNodeBoxes`); a frame whose title an earlier frame has is never named.
 */
export function sketchNotes(sketches: readonly Sketch[], boxes: readonly FrameBox[], parts: ReadonlyMap<string, readonly PartBox[]>): SketchNote[] {
  const frames = boxes.filter((b) => !b.clash);
  const targets = partFrames(parts);
  const tails = sketches.filter((s) => TAIL_KINDS.has(s.kind) && wordsOf(s) !== "");
  /** The frame holding `p` (the smallest when frames overlap), else the nearest within NEAR_PX. */
  const place = (p: Point): { on: string | null; near: string | null } => {
    let on: FrameBox | null = null;
    let near: FrameBox | null = null;
    let nearGap = NEAR_PX;
    for (const b of frames) {
      if (inside(p, b)) {
        if (!on || b.w * b.h < on.w * on.h) on = b;
        continue;
      }
      const d = gap(p, b);
      if (d <= nearGap && (!near || d < nearGap)) {
        near = b;
        nearGap = d;
      }
    }
    return on ? { on: on.title, near: null } : { on: null, near: near?.title ?? null };
  };
  const out: SketchNote[] = [];
  for (const s of sketches) {
    if (s.kind === "pen") continue;
    const text = wordsOf(s);
    const at = { x: Math.round(s.x + s.w / 2), y: Math.round(s.y + s.h / 2) };
    if (s.kind === "arrow" || s.kind === "line") {
      const [tail, head] = ends(s);
      const pointsAt = nearestPart(head, targets);
      let from: string | null = null;
      let fromGap = POINT_AT_PX;
      for (const t of tails) {
        const d = gap(tail, t);
        if (d <= fromGap && (from === null || d < fromGap)) {
          from = t.id;
          fromGap = d;
        }
      }
      if (!pointsAt && from === null && text === "") continue;
      out.push({ id: s.id, kind: s.kind, text, at, from, pointsAt, ...place(at) });
      continue;
    }
    if (text === "") continue;
    out.push({ id: s.id, kind: s.kind, text, at, from: null, pointsAt: null, ...place(at) });
  }
  return out;
}

/**
 * The board Ask's `board` (Decision 1): every frame from the worker's answer with its box in whole board units and its
 * clash from the canvas; the chips kept to titles an unclashed frame has, once each, in chip order; the selection with
 * sketches as ids.
 */
export function boardInput(o: {
  frames: BoardOutlineFrame[];
  boxes: readonly FrameBox[];
  focus: readonly string[];
  selected: BoardSelected;
  notes: SketchNote[];
  create: DiagramKind | null;
  followUp: FollowUpReply | null;
  attachment: string | null;
}): BoardInput {
  const byIndex = new Map(o.boxes.map((b) => [b.index, b]));
  // The board's limits: the Core reads at most these, and a request never carries more.
  const shown = o.frames.length > MAX_BOARD_FRAMES ? o.frames.slice(0, MAX_BOARD_FRAMES) : o.frames;
  const frames = shown.map((f) => {
    const b = byIndex.get(f.index);
    const box = b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) } : { x: 0, y: 0, w: 0, h: 0 };
    return { index: f.index, title: f.title, kind: f.kind, from: f.from, to: f.to, line: f.line, outline: f.outline, problems: f.problems, box, clash: b?.clash ?? false };
  });
  const targets = new Set(frames.filter((f) => !f.clash).map((f) => f.title));
  const focus: string[] = [];
  for (const t of o.focus) if (targets.has(t) && !focus.includes(t)) focus.push(t);
  return {
    frames,
    focus,
    selected: { frame: o.selected.frame, shapes: o.selected.shapes.slice(0, SELECTED_MAX), sketches: o.selected.sketches.slice(0, SELECTED_MAX) },
    sketches: o.notes.length > MAX_SKETCHES ? o.notes.slice(0, MAX_SKETCHES) : o.notes,
    create: o.create,
    followUp: o.followUp,
    attachment: o.attachment,
  };
}

/**
 * Each frame's recorded Connection by its title, then every source kept from frames that lost their title to a clash
 * (Task 4b): each holds the diagram Ask. Shared by the one-frame and the board request.
 */
export function frameSources(cur: { result: Pick<FlowResult, "frames">; keys: readonly string[] }, board: Pick<BoardLayout, "frames" | "held">): FrameSourceIn[] {
  const sources: FrameSourceIn[] = [];
  cur.result.frames.forEach((f, i) => {
    const key = cur.keys[i];
    const source = key === undefined ? undefined : board.frames.get(key)?.source;
    if (source) sources.push({ frame: f.title, ...source });
  });
  for (const h of board.held ?? []) sources.push({ frame: h.frame, ...h.source });
  return sources;
}

/**
 * What the Core gates a board Ask on (Task 4b): each frame's recorded Connection by its title and every held source,
 * and the `table:` links of every frame (not only the selected one), at most MAX_TABLE_LINKS.
 */
export function boardGateFields(cur: { result: Pick<FlowResult, "frames">; keys: readonly string[] }, board: Pick<BoardLayout, "frames" | "held">, frames: readonly Pick<BoardOutlineFrame, "title" | "outline">[]): Pick<DiagramAskRequest, "sources" | "tableLinks"> {
  const sources = frameSources(cur, board);
  // A one-frame file names no frame, as the Core's own read of the text does.
  const named = frames.length > 1;
  const tableLinks: TableLinkIn[] = [];
  links: for (const f of frames) {
    for (const n of f.outline.nodes) {
      if (tableLinks.length === MAX_TABLE_LINKS) break links;
      if (n.tableValue) tableLinks.push({ frame: named ? f.title : null, node: n.name, table: n.tableValue });
    }
  }
  return { ...(sources.length ? { sources } : {}), ...(tableLinks.length ? { tableLinks } : {}) };
}
