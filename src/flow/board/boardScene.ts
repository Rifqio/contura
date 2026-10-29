// The board scene: every frame of a board on one canvas. The selected frame is live, and
// FlowTab draws its shapes with bare names; here it is only a box. Every other frame is static: a frame node with its
// shapes, group areas and lines as children, every id prefixed by the frame's key, in its own z band under the live
// frame. A static frame keeps its node objects while its doc and layout are the same objects, so a frame switch, a
// keystroke in another frame or a drag in the live one rebuilds nothing else (Task 0 (e): remounting about 400 nodes
// whose ids changed cost 203 ms).
import type { Edge, Node } from "@xyflow/react";
import { frameOf } from "../../diagram/export/svg";
import type { Positions } from "../../diagram/layout";
import { type DiagramKind, type FlowDoc, splitRow } from "../../lang/flow/model";
import type { FlowProblem } from "../../lang/flow/problems";
import type { FrameResult } from "../../lang/flow/service";
import { ringColumn } from "../ai/answerRefs";
import type { FrameReview } from "../ai/boardReview";
import type { Point } from "../interactions/geometry";
import { ER_MAX_ROWS } from "../kindLayout";
import type { RowState } from "../kindNodes";
import type { FlowLayout } from "../layout";
import type { NodeLook, NodeState } from "../nodes/parts";
import type { DrawnForms, FrameForm } from "./boardDetail";
import type { PictureImage, PictureInput, PictureRaster, PictureStore } from "./framePicture";
import { type BoardLayout, type ClashLayout, drawnBox, type ErNotation, type FrameLayout, frameGraph, type Sketch, TEXT_SCALE } from "./boardLayout";
import { withLineMark } from "../flowNodes";
import { emptyPositions } from "../layout";
import { drawsUnder, SKETCH_LAYER_ID, sketchNodeId } from "./sketches";
import { boardFrameId, clashInFrameId, duplicateFrameId, inFrameId } from "./staticIds";

export { TEXT_SCALE, type ClashLayout };

/** The height of a frame's title tab strip, drawn above the box's top-left corner. */
export const FRAME_TAB_H = 30;
/** The title pill inside the tab strip (flow-board.css `.board-frame-title`): its height, side padding and gap. */
export const TAB_PILL_H = 26;
export const TAB_PAD_X = 8;
export const TAB_GAP = 6;
/** The kind icon's size in the pill. */
export const TAB_ICON = 14;
/** The title's widest (`.board-frame-name` max-width), cut with dots past it. */
export const TAB_TITLE_MAX = 240;
/** About 7 px per character of the 13 px body font: the estimate the export sizes words by. */
export const TAB_CHAR_W = 7;
/** Each static frame's z band (30 wide as measured in the Task 0 spike). */
export const Z_BAND = 30;
export const Z_LIVE_BOX = 1_995;
export const Z_LIVE = 2_000;
/**
 * The live frame's anchor: a zero-size node at the live frame's `at` that every live shape hangs from, so
 * the live graph stays frame-local while the canvas is in board units. `canvasView.ts`'s `LIVE_ANCHOR` mirrors it.
 */
export const LIVE_ANCHOR_ID = "\u0000live";
/** The anchor's node type: it draws nothing (SketchNode's `SketchLayerNode`). */
export const LIVE_ANCHOR_TYPE = "liveAnchor";
/** The sketch layer node: under every frame, so its children's own z decides (ruling C14). */
export const Z_SKETCH_UNDER = -2;
/** Sections and box sketches: under every frame's box (frame 0's is at 0), above the layer node. */
export const Z_SKETCH_BOX = -1;
/** Pen, text, notes, lines and arrows: over the live frame. */
export const Z_SKETCH = 3_000;
/** Every sketch node's class; Sections and box sketches add `board-sketch-under` (FlowTab: a frame wins over them). */
export const SKETCH_CLASS = "board-sketch";
export const SKETCH_UNDER_CLASS = "board-sketch-under";

/** The own z a drawn thing may keep: group areas go down to -21, a loop's tab is +1. */
const OWN_MIN = -25;
const OWN_MAX = 3;
const clampOwn = (own: number) => Math.max(OWN_MIN, Math.min(OWN_MAX, own));

/** The z of a node or line with own z `own` in the static frame drawn k-th: `30k + 1` to `30k + 29`. */
export const staticZ = (k: number, own: number) => Z_BAND * k + 26 + clampOwn(own);
/** The z of a live node or line with own z `own`: 2,000 to 2,028, above every static frame and the live box. */
export const liveZ = (own: number) => Z_LIVE + 25 + clampOwn(own);

// Ids: the forms live in a leaf module (no imports), so the cards can read them without importing the scene.
export { boardFrameId, clashInFrameId, duplicateFrameId, inFrameId, isStaticId } from "./staticIds";

/** A frame's box on the board (board units, as the canvas draws it), with what its tab shows. */
export interface FrameBox {
  /** The layout key; null for a frame whose title an earlier frame has. */
  key: string | null;
  index: number;
  title: string;
  kind: DiagramKind | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The board's problems inside the frame's text. */
  problems: number;
  /** Its title is an earlier frame's: drawn faded, never live. */
  clash: boolean;
}

export interface BoardSceneOut {
  /** Each frame's box node, a static frame's box followed by its children. FlowTab adds the live frame's shapes. */
  nodes: Node[];
  edges: Edge[];
  boxes: FrameBox[];
  /** The live frame's box, one of `boxes`; null with nothing live. */
  live: FrameBox | null;
  /** Each static frame's shapes, groups and line holders by frame node id, drawn or not (a click's pick reads them). */
  children: ReadonlyMap<string, readonly Node[]>;
  /** Each static frame's line count by frame node id: with its shapes, what a frame turning real mounts (`mounted`). */
  lines: ReadonlyMap<string, number>;
  /**
   * The static frames drawn as a picture, by frame node id: their shapes are not drawn one by one,
   * so a double-click or a right-click there only selects.
   */
  pictured: ReadonlySet<string>;
  /**
   * The frames a waiting proposal adds, drawn at their proposed places; absent when there are none.
   * Not in `boxes`: they are not on the board yet, so no click, pick or fit reads them as its frames.
   */
  proposed?: FrameBox[];
}

/** A shape's or group's box in board units, named as the text names it. */
export type PartBox = { name: string; x: number; y: number; w: number; h: number };

export const GROUP_ID = "\u0000group:";
const sizeOf = (n: Node, side: "width" | "height", initial: number | undefined) => {
  const s = n.style?.[side];
  return n.measured?.[side] ?? n[side] ?? (typeof s === "number" ? s : undefined) ?? initial ?? 0;
};
/** The text's name of a frame's shape or group by its id within the frame; null for anything else drawn. */
export const partName = (id: string) => (id.startsWith(GROUP_ID) ? id.slice(GROUP_ID.length) : id.startsWith("\u0000") ? null : id);

/**
 * Each frame's shapes and groups in board units, by frame title (for the board Ask's sketch notes). A
 * static frame's are read from `children`, which holds them drawn or not, so a frame drawn as a picture or culled (Plan
 * F) gives the same boxes; the live frame's from `nodes`, which must then hold the
 * canvas's live nodes, frame-local, placed by the live anchor. Frames whose title an earlier frame
 * has are left out: they are never a target.
 */
export function boardNodeBoxes(scene: Pick<BoardSceneOut, "nodes" | "boxes" | "children">): Map<string, PartBox[]> {
  const out = new Map<string, PartBox[]>();
  const anchor = scene.nodes.find((n) => n.id === LIVE_ANCHOR_ID)?.position ?? { x: 0, y: 0 };
  for (const box of scene.boxes) {
    if (box.clash || box.key === null || out.has(box.title)) continue;
    const parts: PartBox[] = [];
    const kids = scene.children.get(boardFrameId(box.key));
    if (kids) {
      const prefix = inFrameId(box.key, "");
      for (const c of kids) {
        const name = c.id.startsWith(prefix) ? partName(c.id.slice(prefix.length)) : null;
        if (name !== null) parts.push({ name, x: box.x + c.position.x, y: box.y + c.position.y, w: sizeOf(c, "width", c.initialWidth), h: sizeOf(c, "height", c.initialHeight) });
      }
    } else {
      // The live frame: its nodes are frame-local, hung from the anchor at its place on the board.
      for (const n of scene.nodes) {
        const name = n.parentId === undefined || n.parentId === LIVE_ANCHOR_ID ? partName(n.id) : null;
        if (name !== null) parts.push({ name, x: n.position.x + anchor.x, y: n.position.y + anchor.y, w: sizeOf(n, "width", n.initialWidth), h: sizeOf(n, "height", n.initialHeight) });
      }
    }
    out.set(box.title, parts);
  }
  return out;
}

/** A static frame drawn as one picture of itself: its node type (FramePicture.tsx). */
export const FRAME_PICTURE_TYPE = "framePicture";
type Rect = { x: number; y: number; w: number; h: number };
/**
 * What a picture node draws: its bitmap's PNG (Task 9 fixes 2 and 3), or its SVG's data: URL until that is in. One
 * object while the image is the same, so the node draws nothing again.
 */
export interface FramePictureData extends Record<string, unknown> {
  url?: string;
  raster?: PictureRaster;
}

/** A picture of part of the sketch layer: its node type (SketchNode.tsx's `SketchLayerPicture`). */
export const SKETCH_PICTURE_TYPE = "sketchPicture";
/** The sketch layer's pictures' class (flow-board.css): no pointer events, as a frame's picture. */
const SKETCH_PICTURE_CLASS = "board-sketch-picture";

/**
 * The sketch layer drawn as pictures (Task 9 fix 2; FlowTab's `stepSketches`): each tile's picture at its box (board
 * units), under every frame or over them, and the first `mounted` sketches real over them while the layer turns real.
 */
export interface SketchLayerDraw {
  tiles: readonly { id: string; under: boolean; box: Rect; image: PictureImage }[];
  mounted: number;
}

/** A frame selection as `useFlowDoc` keeps it: its title, and its index as a tiebreak when titles repeat. */
export type BoardSelection = { title: string; index: number };

/** A static frame's children as last built, and what they were built from. */
interface Built {
  doc: FlowDoc | null;
  lastValid: FlowDoc | null;
  positions: Positions | undefined;
  sizes: FlowLayout["sizes"];
  axes: FlowLayout["axes"];
  look: NodeLook;
  scale: number;
  notation: ErNotation;
  k: number;
  faded: boolean;
  /** Where its shapes stand (a clash frame's own row of unplaced ones included), for its picture. */
  placed: Positions;
  /** What its picture is keyed by: one object while the children are built from the same things. */
  content: object;
  /** The waiting proposal's review drawn in place of the doc: the children are kept while it is the same object. */
  review: FrameReview | undefined;
  /** The children's id for a shape id. */
  idOf: (id: string) => string;
  inKey: string;
  /** The bounds of what is drawn plus FRAME_PAD, at least FRAME_MIN, relative to the frame's `at`. */
  local: Rect;
  children: Node[];
  edges: Edge[];
  /** Its picture node, kept while the image and its z band are the same. */
  picture?: { url: PictureImage; node: Node };
}

/** A frame's box node as last built. */
interface BuiltBox {
  box: FrameBox;
  z: number;
  faded: boolean;
  pending: number | undefined;
  isNew: boolean;
  node: Node;
}

const FADED = "board-faded";
/** A frame's picture node (flow-board.css). */
const PICTURE_CLASS = "board-picture";
/** Every static frame's shape, group and line: nothing inside a static frame takes pointer events (flow-board.css). */
export const STATIC_CLASS = "board-static";

/** `useFlowDoc` keys a frame whose title an earlier frame has as `\u0000#<index>`. */
const isClashKey = (key: string | undefined) => key === undefined || key.startsWith("\u0000#");

const withClass = (cls: string | undefined, add: string) => (cls ? `${cls} ${add}` : add);
const staticClass = (cls: string | undefined, faded: boolean) => withClass(cls, faded ? `${STATIC_CLASS} ${FADED}` : STATIC_CLASS);

/** The review state of a shape: new, gone or changed. */
function reviewState(r: FrameReview, name: string): NodeState | undefined {
  if (r.added.has(name)) return "suggested";
  if (r.removed.has(name)) return "removed";
  if (r.changed.has(name)) return "changed";
  return undefined;
}

/**
 * Each row's review state on table `name`, for the rows a card draws: a static card its first ER_MAX_ROWS (B3 decision
 * 7, a static card never scrolls; a changed row past them is in the frame's count and the change list only), the
 * live card every row (it scrolls to the first marked one). Undefined when no drawn row is marked.
 */
export function rowStates(r: Pick<FrameReview, "addedRows" | "removedRows" | "changedRows">, name: string, rows: readonly string[] | undefined, max = ER_MAX_ROWS): (RowState | undefined)[] | undefined {
  const add = r.addedRows.get(name);
  const del = r.removedRows.get(name);
  const chg = r.changedRows.get(name);
  if (!rows || (!add && !del && !chg)) return undefined;
  const out: (RowState | undefined)[] = [];
  let any = false;
  for (let i = 0; i < Math.min(rows.length, max); i++) {
    const col = splitRow(rows[i]).name;
    const st: RowState | undefined = add?.has(col) ? "suggested" : del?.has(col) ? "removed" : chg?.has(col) ? "changed" : undefined;
    out.push(st);
    if (st) any = true;
  }
  return any ? out : undefined;
}

/**
 * The rows of an ER card with those named in `cols` flashing: `base` (the review's marks, which win) kept. A row a
 * landing added (`landed` holds its name) is "airing"; one an answer only named is "ringed". The same array when no
 * drawn row is named.
 */
export function airRows(
  rows: readonly string[] | undefined,
  cols: ReadonlySet<string>,
  base: readonly (RowState | undefined)[] | undefined,
  max = ER_MAX_ROWS,
  landed: (column: string) => boolean = () => true,
): readonly (RowState | undefined)[] | undefined {
  if (!rows) return base;
  const out: (RowState | undefined)[] = [];
  let any = false;
  for (let i = 0; i < Math.min(rows.length, max); i++) {
    const name = splitRow(rows[i]).name;
    const fresh = base?.[i] === undefined && cols.has(name);
    const st = base?.[i] ?? (fresh ? (landed(name) ? "airing" : "ringed") : undefined);
    out.push(st);
    if (fresh) any = true;
  }
  return any ? out : base;
}

/** The node with its review marks: its state, and on an ER table its rows' states. The same node when it has none. */
function marked(n: Node, r: FrameReview): Node {
  // A renamed group's area: its class carries the tint, and its state the note its name reads out.
  if (n.id.startsWith(GROUP_ID)) return r.changed.has(n.id.slice(GROUP_ID.length)) ? { ...n, className: withClass(n.className, "is-ai-changed"), data: { ...n.data, state: "changed" } } : n;
  if (n.id.startsWith("\u0000")) return n;
  const state = reviewState(r, n.id);
  const rows = rowStates(r, n.id, (n.data as { rows?: string[] }).rows);
  if (!state && !rows) return n;
  return { ...n, data: { ...n.data, ...(state ? { state } : {}), ...(rows ? { rowStates: rows } : {}) } };
}

/** The class a line takes from the review, by its index in the drawn doc (`edge:<i>`). */
function lineMark(r: FrameReview, id: string): string {
  if (!id.startsWith("edge:")) return "";
  const i = Number(id.slice(5));
  if (r.addedLinks.has(i)) return " is-ai-add";
  if (r.removedLinks.has(i)) return " is-ai-del";
  if (r.changedLinks.has(i)) return " is-ai-changed";
  return "";
}

/** Each frame's problem count: those that start inside its text (up to the next frame; the last up to its end). */
function problemCounts(frames: readonly FrameResult[], problems: readonly FlowProblem[]): number[] {
  const out = frames.map(() => 0);
  for (const p of problems) {
    let lo = 0;
    let hi = frames.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].from <= p.from) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (at < 0 || (at === frames.length - 1 && p.from > frames[at].to)) continue;
    out[at]++;
  }
  return out;
}

/** The selected frame's index: by index while its title still matches, else the first frame with the title. */
function selectedIndex(frames: readonly FrameResult[], sel: BoardSelection | null): number | null {
  if (!sel) return null;
  if (frames[sel.index]?.title === sel.title) return sel.index;
  const i = frames.findIndex((f) => f.title === sel.title);
  return i < 0 ? null : i;
}

function sameBox(a: FrameBox, b: FrameBox): boolean {
  return (
    a.key === b.key &&
    a.index === b.index &&
    a.title === b.title &&
    a.kind === b.kind &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.problems === b.problems &&
    a.clash === b.clash
  );
}

/**
 * The scene builder for one canvas. It holds each static frame's built children and each frame's box node between
 * builds; entries for frames the board no longer has are dropped on every build. `look` is the look of a frame that
 * has no layout entry yet; a frame with one draws in its own.
 */
export function createBoardScene(look: NodeLook) {
  /** Static frames' children, by frame node id. */
  const memo = new Map<string, Built>();
  /** Every frame's box node, by frame node id. */
  const boxMemo = new Map<string, BuiltBox>();
  /** Each sketch's node, by sketch id, while the sketch is the same object (a change replaces it). */
  const sketchMemo = new Map<string, { sketch: Sketch; node: Node }>();
  /** The layer node: made once, at (0, 0) for good. */
  let layerMemo: Node | null = null;
  /** Each sketch tile's picture node, while its image, box and layer are the same. */
  const tileMemo = new Map<string, Node>();
  /** The live anchor, while the live frame's `at` is the same. */
  let anchorMemo: { x: number; y: number; node: Node } | null = null;

  /** A sketch's node at its board place, a child of the layer: the same object while the sketch is. */
  function sketchNode(s: Sketch): Node {
    const was = sketchMemo.get(s.id);
    if (was && was.sketch === s) return was.node;
    const under = drawsUnder(s.kind);
    const node: Node = {
      id: sketchNodeId(s.id),
      type: "sketch",
      parentId: SKETCH_LAYER_ID,
      position: { x: s.x, y: s.y },
      initialWidth: s.w,
      initialHeight: s.h,
      // The box takes no pointer events; what the sketch draws does (SketchNode), so a stroke over a shape covers
      // only its own line.
      style: { width: s.w, height: s.h, pointerEvents: "none" },
      data: { sketch: s },
      className: under ? `${SKETCH_CLASS} ${SKETCH_UNDER_CLASS}` : SKETCH_CLASS,
      zIndex: under ? Z_SKETCH_BOX : Z_SKETCH,
      // Select picks, drags and box-selects sketches as shapes; FlowTab routes their ids to the layout file.
      selectable: true,
      draggable: true,
      connectable: false,
      focusable: true,
      deletable: false,
    };
    sketchMemo.set(s.id, { sketch: s, node });
    return node;
  }

  /** The zero-size layer at the board's (0, 0): a switch never moves it. */
  function layerNode(): Node {
    if (layerMemo) return layerMemo;
    const node: Node = {
      id: SKETCH_LAYER_ID,
      type: "sketchLayer",
      position: { x: 0, y: 0 },
      width: 0,
      height: 0,
      style: { width: 0, height: 0, pointerEvents: "none" },
      data: {},
      zIndex: Z_SKETCH_UNDER,
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      deletable: false,
    };
    layerMemo = node;
    return node;
  }

  /** A tile of the sketch layer as one picture, at its box, in the sketches' z band: the same object while it is. */
  function tileNode(t: SketchLayerDraw["tiles"][number]): Node {
    const was = tileMemo.get(t.id);
    const data = was?.data as FramePictureData | undefined;
    const same = (d: FramePictureData | undefined) => d !== undefined && (typeof t.image === "string" ? d.url === t.image : d.raster === t.image);
    if (was && same(data) && was.position.x === t.box.x && was.position.y === t.box.y && was.initialWidth === t.box.w && was.initialHeight === t.box.h && was.zIndex === (t.under ? Z_SKETCH_BOX : Z_SKETCH)) return was;
    const node: Node = {
      id: `${SKETCH_LAYER_ID}\u0000tile:${t.id}`,
      type: SKETCH_PICTURE_TYPE,
      position: { x: t.box.x, y: t.box.y },
      initialWidth: t.box.w,
      initialHeight: t.box.h,
      style: { width: t.box.w, height: t.box.h, pointerEvents: "none" },
      data: (typeof t.image === "string" ? { url: t.image } : { raster: t.image }) satisfies FramePictureData,
      zIndex: t.under ? Z_SKETCH_BOX : Z_SKETCH,
      className: SKETCH_PICTURE_CLASS,
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      deletable: false,
    };
    tileMemo.set(t.id, node);
    return node;
  }

  /** The live frame's anchor at `at`: zero size, no pointer events, in the live band. */
  function anchorNode(at: { x: number; y: number }): Node {
    if (anchorMemo && anchorMemo.x === at.x && anchorMemo.y === at.y) return anchorMemo.node;
    const node: Node = {
      id: LIVE_ANCHOR_ID,
      type: LIVE_ANCHOR_TYPE,
      position: { x: at.x, y: at.y },
      initialWidth: 0,
      initialHeight: 0,
      style: { width: 0, height: 0, pointerEvents: "none" },
      data: {},
      zIndex: Z_LIVE,
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      deletable: false,
    };
    anchorMemo = { x: at.x, y: at.y, node };
    return node;
  }

  /**
   * The frame's children with the named shapes flashing; the frame itself (and its memo) is left as it was. Those in
   * `landed` were added by a landing ("airing"); the rest an answer only named ("ringed", no note in their names).
   */
  function withAiring(built: Built, names: ReadonlySet<string> | undefined, landed: ReadonlySet<string> | undefined): Built {
    if (!names || names.size === 0) return built;
    const ids = new Set<string>();
    const cols = new Map<string, Set<string>>();
    const groups = new Set<string>();
    for (const n of names) {
      const c = ringColumn(n);
      if (!c) {
        ids.add(built.idOf(n));
        groups.add(built.idOf(GROUP_ID + n));
      } else {
        const id = built.idOf(c.table);
        cols.set(id, (cols.get(id) ?? new Set()).add(c.column));
      }
    }
    if (!built.children.some((c) => ids.has(c.id) || cols.has(c.id) || groups.has(c.id))) return built;
    const landedIds = new Set<string>();
    const landedCols = new Map<string, Set<string>>();
    for (const n of landed ?? []) {
      const c = ringColumn(n);
      if (!c) landedIds.add(built.idOf(n));
      else landedCols.set(built.idOf(c.table), (landedCols.get(built.idOf(c.table)) ?? new Set()).add(c.column));
    }
    return {
      ...built,
      children: built.children.map((c) => {
        // A group's area rings by its class, as a renamed group is tinted.
        if (groups.has(c.id)) return { ...c, className: withClass(c.className, "is-ai-airing") };
        const rows = cols.get(c.id);
        const data = c.data as { rows?: string[]; rowStates?: (RowState | undefined)[] };
        const aired = rows ? airRows(data.rows, rows, data.rowStates, ER_MAX_ROWS, (col) => !!landedCols.get(c.id)?.has(col)) : undefined;
        // A shape the review marks keeps its mark (and its name's note): a ring never reads a removal as an add.
        const ring = ids.has(c.id) && !(c.data as { state?: string }).state;
        if (!ring && (!aired || aired === data.rowStates)) return c;
        return { ...c, data: { ...c.data, ...(ring ? { state: landedIds.has(c.id) ? "airing" : "ringed" } : {}), ...(aired && aired !== data.rowStates ? { rowStates: aired } : {}) } };
      }),
    };
  }

  /** A static frame's children, reused while what they are drawn from is the same. */
  function staticFrame(
    frameId: string,
    inKey: string,
    f: Pick<FrameResult, "doc" | "lastValid">,
    e: FrameLayout | undefined,
    k: number,
    clash: boolean,
    review?: FrameReview,
  ): Built {
    const idOf = clash ? (id: string) => clashInFrameId(k, id) : (id: string) => inFrameId(inKey, id);
    const positions = e?.nodes;
    const sizes = e?.sizes;
    const axes = e?.axes;
    const lk = e?.style ?? look;
    const scale = TEXT_SCALE[e?.textSize ?? "m"];
    // Its text size on every child, so flow-board.css fades its text at that size's zoom.
    const ts = `board-ts-${e?.textSize ?? "m"}`;
    // Each frame's own ER line ends, read by `frameGraph` from its entry.
    const notation = e?.notation ?? "crow";
    // A frame with an error draws its last good doc faded, as does one whose title an earlier frame has.
    const faded = !f.doc || clash;
    const was = memo.get(frameId);
    if (
      was &&
      was.doc === f.doc &&
      was.lastValid === f.lastValid &&
      was.positions === positions &&
      was.sizes === sizes &&
      was.axes === axes &&
      was.look === lk &&
      was.scale === scale &&
      was.notation === notation &&
      was.k === k &&
      was.faded === faded &&
      was.inKey === inKey &&
      was.review === review
    )
      return was;
    // Only its place in the text moved (a frame added or deleted above it): the same children in another z band, so
    // a band shift of 49 frames makes no graph (rebuilding them cost 18.6 ms).
    if (
      was &&
      !clash &&
      was.k !== k &&
      was.doc === f.doc &&
      was.lastValid === f.lastValid &&
      was.positions === positions &&
      was.sizes === sizes &&
      was.axes === axes &&
      was.look === lk &&
      was.scale === scale &&
      was.notation === notation &&
      was.faded === faded &&
      was.inKey === inKey &&
      was.review === review
    ) {
      const dz = Z_BAND * (k - was.k);
      const shifted: Built = {
        ...was,
        k,
        children: was.children.map((c) => ({ ...c, zIndex: (c.zIndex ?? 0) + dz })),
        edges: was.edges.map((e) => ({ ...e, zIndex: (e.zIndex ?? 0) + dz })),
        picture: was.picture && { url: was.picture.url, node: { ...was.picture.node, zIndex: (was.picture.node.zIndex ?? 0) + dz } },
      };
      memo.set(frameId, shifted);
      return shifted;
    }
    const built: Built = {
      doc: f.doc,
      lastValid: f.lastValid,
      positions,
      sizes,
      axes,
      look: lk,
      scale,
      notation,
      k,
      faded,
      review,
      placed: positions ?? emptyPositions(),
      content: {},
      idOf,
      inKey,
      local: drawnBox([]),
      children: [],
      edges: [],
    };
    // Under review the frame draws the review's doc: the proposal with what it removes still in it.
    const doc = review?.draw ?? f.doc ?? f.lastValid;
    if (doc) {
      // The same graph and box `frameBounds` measures. A clash frame is never an empty box: until its layout comes
      // back, its unplaced shapes stand in a row; so do a review's proposed shapes until their places come.
      const g = frameGraph(e, doc, lk, clash || !!review);
      if (review) {
        g.nodes = g.nodes.map((n) => marked(n, review));
        g.edges = g.edges.map((ed) => {
          const mark = lineMark(review, ed.id);
          // A sequence message's chip and number circle are drawn apart from its line, so its data takes the mark.
          return mark ? withLineMark(ed, mark.slice(7) as "add" | "del" | "changed") : ed;
        });
      }
      const local = drawnBox(g.nodes);
      built.local = local;
      if (clash || review) {
        // Its picture stands its shapes where the graph placed them (a review's proposed shapes too).
        const at = emptyPositions();
        for (const n of g.nodes) if (!n.id.startsWith("\u0000")) at[n.id] = n.position;
        built.placed = at;
      }
      built.children = g.nodes.map((n) => {
        const c: Node = {
          ...n,
          id: idOf(n.id),
          parentId: frameId,
          position: { x: n.position.x - local.x, y: n.position.y - local.y },
          selectable: false,
          draggable: false,
          connectable: false,
          focusable: false,
          deletable: false,
          zIndex: staticZ(k, n.zIndex ?? 0),
          className: staticClass(withClass(n.className, ts), faded),
        };
        return c;
      });
      built.edges = g.edges.map((ed) => {
        const c: Edge = {
          ...ed,
          id: idOf(ed.id),
          source: idOf(ed.source),
          target: idOf(ed.target),
          selectable: false,
          focusable: false,
          deletable: false,
          zIndex: staticZ(k, ed.zIndex ?? 0),
          className: staticClass(ed.className, faded),
        };
        return c;
      });
    }
    memo.set(frameId, built);
    return built;
  }

  /** What a static frame's picture is drawn from: the things its children are built from. */
  function pictureInput(built: Built, softText: boolean): PictureInput | null {
    const doc = built.doc ?? built.lastValid;
    if (!doc || built.children.length === 0) return null;
    return {
      doc,
      layout: { nodes: built.placed, style: built.look, axes: built.axes, sizes: built.sizes },
      textScale: built.scale,
      notation: built.notation,
      local: built.local,
      softText,
    };
  }

  /**
   * A static frame as one picture of itself, over its box where its children would stand: the image
   * is the frame's local box on whole units (`frameOf`, as the writer frames it). Kept while the image and band are.
   */
  function pictureNode(frameId: string, built: Built, url: PictureImage): Node {
    const z = staticZ(built.k, 0);
    if (built.picture && built.picture.url === url && built.picture.node.zIndex === z) return built.picture.node;
    const box = frameOf(built.local, { padding: 0 });
    const data: FramePictureData = typeof url === "string" ? { url } : { raster: url };
    const node: Node = {
      id: built.idOf("\u0000picture"),
      type: FRAME_PICTURE_TYPE,
      parentId: frameId,
      position: { x: box.x - built.local.x, y: box.y - built.local.y },
      initialWidth: box.w,
      initialHeight: box.h,
      style: { width: box.w, height: box.h, pointerEvents: "none" },
      data,
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      deletable: false,
      zIndex: z,
      className: staticClass(PICTURE_CLASS, built.faded),
    };
    built.picture = { url, node };
    return node;
  }

  /**
   * A frame's box node, the same object while its box, z, fade and review marks are. `pending` is the frame's waiting
   * count (FrameNode's `pending`); `isNew` draws a frame the proposal adds dashed, its tab marked "New".
   */
  function boxNode(frameId: string, box: FrameBox, z: number, faded: boolean, pending?: number, isNew = false): Node {
    const was = boxMemo.get(frameId);
    if (was && was.z === z && was.faded === faded && was.pending === pending && was.isNew === isNew && sameBox(was.box, box)) return was.node;
    const node: Node = {
      id: frameId,
      type: "boardFrame",
      position: { x: box.x, y: box.y },
      initialWidth: box.w,
      initialHeight: box.h,
      style: { width: box.w, height: box.h },
      data: { box, faded, ...(pending !== undefined ? { pending } : {}), ...(isNew ? { isNew } : {}) },
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      deletable: false,
      zIndex: z,
    };
    boxMemo.set(frameId, { box, z, faded, pending, isNew, node });
    return node;
  }

  return {
    /**
     * The canvas of `frames` (the newest parse's), placed by `board` under `keys`. `keys` must be that parse's own
     * (`Parsed.keys`), never `useFlowDoc`'s header keys: those run ahead of the parse while a header edit waits for it,
     * and would put a frame on another frame's entry and id. Everything is in board units: a static
     * frame's children and box node keep their objects across a switch, and so do the sketch layer and its sketches;
     * only the two frames that change hands and the live anchor are new. The selected frame is live unless its title is
     * an earlier frame's; `live` is its nodes as FlowTab draws them, frame-local, hanging from the anchor at its `at`.
     */
    build(
      frames: readonly FrameResult[],
      board: BoardLayout,
      keys: readonly string[],
      selected: BoardSelection | null,
      live: { nodes: Node[] } | null,
      problems: readonly FlowProblem[],
      /** `useFlowDoc`'s layouts of frames whose title an earlier frame has, by frame index; never saved. */
      clashLayouts?: ReadonlyMap<number, ClashLayout>,
      /**
       * The static frames drawn and how: a frame absent from `form` pushes its box node only,
       * one turning real pushes its first `mounted` parts, children then lines (over its picture, if it has one). Null
       * before the canvas has a view: every static frame is a picture with `pictures` (none is mounted real at open),
       * real without.
       */
      drawn: DrawnForms | null = null,
      /** Where pictures come from; without it a picture form draws the box alone. */
      pictures?: PictureStore,
      /** The sketch layer as pictures; null or absent draws every sketch real. */
      sketchDraw: SketchLayerDraw | null = null,
      /**
       * The waiting proposal's review of each frame it touches, by title. A static frame with one draws
       * its review (real, never as a picture, while it is in view:); a new frame draws at its `proposedAt` place.
       */
      review?: ReadonlyMap<string, FrameReview>,
      /** Each new frame's place on the board, by title. */
      proposedAt?: ReadonlyMap<string, Point>,
      /**
       * The shapes a landing just added or changed and the parts an answer named, by frame layout key;
       * a static frame draws them flashing.
       */
      airing?: ReadonlyMap<string, ReadonlySet<string>>,
      /** Of those, the ones a landing added: their names say ", added by AI"; the others are only named. */
      landed?: ReadonlyMap<string, ReadonlySet<string>>,
    ): BoardSceneOut {
      const si = selectedIndex(frames, selected);
      const li = si === null || isClashKey(keys[si]) ? null : si;
      const liveAt = li === null ? null : (board.frames.get(keys[li])?.at ?? { x: 0, y: 0 });
      const counts = problemCounts(frames, problems);
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      const boxes: FrameBox[] = [];
      const children = new Map<string, readonly Node[]>();
      const lines = new Map<string, number>();
      const pictured = new Set<string>();
      let liveBox: FrameBox | null = null;
      const seen = new Set<string>();
      // The sketch layer first: a parent comes before its children. Pictured, its tiles stand for the sketches not yet
      // real; each sketch's node is kept, so turning real hands back the same objects.
      if (board.sketches.length > 0) {
        const real = sketchDraw ? Math.min(sketchDraw.mounted, board.sketches.length) : board.sketches.length;
        if (sketchDraw) for (const t of sketchDraw.tiles) nodes.push(tileNode(t));
        if (real > 0) nodes.push(layerNode());
        const ids = new Set<string>();
        for (let i = 0; i < board.sketches.length; i++) {
          const s = board.sketches[i];
          ids.add(s.id);
          if (i < real) nodes.push(sketchNode(s));
        }
        if (sketchMemo.size > ids.size) for (const id of sketchMemo.keys()) if (!ids.has(id)) sketchMemo.delete(id);
      } else sketchMemo.clear();
      if (tileMemo.size > 0) {
        const live = new Set(sketchDraw && board.sketches.length > 0 ? sketchDraw.tiles.map((t) => t.id) : []);
        for (const id of tileMemo.keys()) if (!live.has(id)) tileMemo.delete(id);
      }
      frames.forEach((f, i) => {
        const key = keys[i];
        const clash = isClashKey(key);
        const frameId = clash ? duplicateFrameId(i) : boardFrameId(key);
        seen.add(frameId);
        if (i === li && liveAt) {
          // `at` plus the live nodes' drawn box (frame-local): a drag tick touches no static frame.
          const r = drawnBox(live?.nodes ?? []);
          const box: FrameBox = { key, index: i, title: f.title, kind: f.kind, x: liveAt.x + r.x, y: liveAt.y + r.y, w: r.w, h: r.h, problems: counts[i], clash: false };
          boxes.push(box);
          liveBox = box;
          nodes.push(boxNode(frameId, box, Z_LIVE_BOX, false));
          // FlowTab hangs the live shapes from it; a parent comes before its children, and they come last.
          nodes.push(anchorNode(liveAt));
          return;
        }
        const laid = clash ? clashLayouts?.get(i) : undefined;
        const e = clash ? (laid?.title === f.title ? laid.entry : undefined) : board.frames.get(key);
        // A frame whose title an earlier frame has is never a proposal's target.
        const rv = clash ? undefined : review?.get(f.title);
        const built = withAiring(staticFrame(frameId, clash ? `\u0000#${i}` : key, f, e, i, clash, rv), clash ? undefined : airing?.get(key), landed?.get(key));
        const at = e?.at ?? { x: 0, y: 0 };
        const r = built.local;
        const box: FrameBox = {
          key: clash ? null : key,
          index: i,
          title: f.title,
          kind: f.kind,
          x: at.x + r.x,
          y: at.y + r.y,
          w: r.w,
          h: r.h,
          problems: counts[i],
          clash,
        };
        boxes.push(box);
        nodes.push(boxNode(frameId, box, Z_BAND * i, built.faded, rv?.count));
        children.set(frameId, built.children);
        lines.set(frameId, built.edges.length);
        const planned: FrameForm | undefined = drawn ? drawn.form.get(i) : pictures ? "picture" : "real";
        // A frame under review or flashing draws real while it is in view, for as long as that lasts, then returns to
        // its planned form: its marks and rings are on its shapes, which a picture does not draw.
        const marked = !clash && (!!rv || !!airing?.get(key)?.size);
        const form: FrameForm | undefined = marked && planned !== undefined ? "real" : planned;
        const mounted = form === "real" ? 0 : (drawn?.mounted.get(i) ?? 0);
        if (form === undefined && mounted === 0) return;
        if (form === "real") {
          for (const c of built.children) nodes.push(c);
          for (const c of built.edges) edges.push(c);
          return;
        }
        if (form !== undefined) {
          // A picture: its shapes are not drawn one by one. Until its image is built it is its box alone.
          pictured.add(frameId);
          const a = pictures ? pictureInput(built, form === "picture") : null;
          const url = a ? pictures!.url(frameId, built.content, a) : null;
          if (url) nodes.push(pictureNode(frameId, built, url));
        }
        // Turning real: its first parts so far, over its picture: its children, then its lines (each line's ends are in
        // before it), so its lines take their share of the swap budget too.
        const kids = built.children.length;
        for (let c = 0; c < mounted && c < kids; c++) nodes.push(built.children[c]);
        for (let c = 0; c < mounted - kids && c < built.edges.length; c++) edges.push(built.edges[c]);
      });
      // The frames the proposal adds, after every frame of the board: dashed at their proposed places.
      let proposed: FrameBox[] | undefined;
      if (review && proposedAt) {
        const titles = new Set(frames.map((f) => f.title));
        for (const [title, rv] of review) {
          const at = proposedAt.get(title);
          if (!rv.isNew || !at || titles.has(title)) continue;
          const k = frames.length + (proposed?.length ?? 0);
          const key = `\u0000new:${title}`;
          const frameId = boardFrameId(key);
          seen.add(frameId);
          const built = staticFrame(frameId, key, { doc: rv.draw, lastValid: rv.draw }, undefined, k, false, rv);
          const r = built.local;
          const box: FrameBox = { key: null, index: k, title, kind: rv.draw.kind, x: at.x + r.x, y: at.y + r.y, w: r.w, h: r.h, problems: 0, clash: false };
          (proposed ??= []).push(box);
          nodes.push(boxNode(frameId, box, Z_BAND * k, false, rv.count, true));
          for (const c of built.children) nodes.push(c);
          for (const c of built.edges) edges.push(c);
        }
      }
      for (const id of memo.keys()) if (!seen.has(id)) memo.delete(id);
      for (const id of boxMemo.keys()) if (!seen.has(id)) boxMemo.delete(id);
      pictures?.prune(seen);
      return { nodes, edges, boxes, live: liveBox, children, lines, pictured, ...(proposed ? { proposed } : {}) };
    },
    /**
     * Whether static frame `index` can be drawn as `form` now (`stepForms`' `ready`): its picture for its
     * children as last built is in `pictures`, asked for here when it is not. A frame with nothing to picture is ready.
     */
    pictureReady(index: number, form: Exclude<FrameForm, "real">, pictures: PictureStore): boolean {
      for (const [frameId, built] of memo) {
        if (built.k !== index) continue;
        const a = pictureInput(built, form === "picture");
        return !a || (pictures.url(frameId, built.content, a) !== null && pictures.ready(frameId));
      }
      return true;
    },
    /** How many static frames' children are held, for the memory tests. */
    memoSize: () => memo.size,
    /** How many box nodes are held, for the memory tests. */
    boxMemoSize: () => boxMemo.size,
    /** How many sketch nodes are held, for the memory tests. */
    sketchMemoSize: () => sketchMemo.size,
  };
}
