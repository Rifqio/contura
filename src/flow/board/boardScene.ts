// The board scene: every frame of a board on one canvas (Decisions 1, 2, 4 and 5). The selected frame is live, and
// FlowTab draws its shapes with bare names; here it is only a box. Every other frame is static: a frame node with its
// shapes, group areas and lines as children, every id prefixed by the frame's key, in its own z band under the live
// frame. A static frame keeps its node objects while its doc and layout are the same objects, so a frame switch, a
// keystroke in another frame or a drag in the live one rebuilds nothing else (Task 0 (e): remounting about 400 nodes
// whose ids changed cost 203 ms).
import type { Edge, Node } from "@xyflow/react";
import type { Positions } from "../../diagram/layout";
import type { DiagramKind, FlowDoc } from "../../lang/flow/model";
import type { FlowProblem } from "../../lang/flow/problems";
import type { FrameResult } from "../../lang/flow/service";
import type { FlowLayout } from "../layout";
import type { NodeLook } from "../nodes/parts";
import { type BoardLayout, type ClashLayout, drawnBox, type ErNotation, type FrameLayout, frameGraph, type Sketch, TEXT_SCALE } from "./boardLayout";
import { drawsUnder, SKETCH_LAYER_ID, sketchNodeId } from "./sketches";
import { boardFrameId, clashInFrameId, duplicateFrameId, inFrameId } from "./staticIds";

export { TEXT_SCALE, type ClashLayout };

/** The height of a frame's title tab strip, drawn above the box's top-left corner (Decision 4). */
export const FRAME_TAB_H = 30;
/** Each static frame's z band (Decision 5, 30 wide as measured in the Task 0 spike). */
export const Z_BAND = 30;
export const Z_LIVE_BOX = 1_995;
export const Z_LIVE = 2_000;
/** The sketch layer node: under every frame, so its children's own z decides (Decision 5, ruling C14). */
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

/** A frame's box on the canvas (origin-relative), with what its tab shows. */
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
  /** Its title is an earlier frame's: drawn faded, never live (Decision 9). */
  clash: boolean;
}

export interface BoardSceneOut {
  /** Each frame's box node, a static frame's box followed by its children. FlowTab adds the live frame's shapes. */
  nodes: Node[];
  edges: Edge[];
  boxes: FrameBox[];
  /** The live frame's box, one of `boxes`; null with nothing live. */
  live: FrameBox | null;
  /** The live frame's `at`; (0, 0) with nothing live. Canvas positions are board positions minus this. */
  origin: { x: number; y: number };
  /** Each static frame's shapes, groups and line holders by frame node id, drawn or not (a click's pick reads them). */
  children: ReadonlyMap<string, readonly Node[]>;
}

/** A static frame drawn as one node below BOX_BELOW (Task 18b, Figma and Miro): its node type. */
export const FRAME_PREVIEW_TYPE = "framePreview";
type Rect = { x: number; y: number; w: number; h: number };
/**
 * What a frame's preview draws, frame-local as its shapes are: each group area and each shape at the box the full
 * frame gives it, and each line as one straight segment from shape centre to shape centre.
 */
export interface FramePreviewData extends Record<string, unknown> {
  areas: Rect[];
  shapes: Rect[];
  lines: [number, number, number, number][];
  faded: boolean;
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
  /** The children's id for a shape id. */
  idOf: (id: string) => string;
  inKey: string;
  /** The bounds of what is drawn plus FRAME_PAD, at least FRAME_MIN, relative to the frame's `at`. */
  local: Rect;
  children: Node[];
  edges: Edge[];
  /** The frame as one node, made the first time it is drawn below BOX_BELOW and kept with the children. */
  preview?: Node;
}

/** A frame's box node as last built. */
interface BuiltBox {
  box: FrameBox;
  z: number;
  faded: boolean;
  node: Node;
}

const FADED = "board-faded";
/** Every static frame's shape, group and line: nothing inside a static frame takes pointer events (flow-board.css). */
export const STATIC_CLASS = "board-static";

/** `useFlowDoc` keys a frame whose title an earlier frame has as `\u0000#<index>`. */
const isClashKey = (key: string | undefined) => key === undefined || key.startsWith("\u0000#");

const withClass = (cls: string | undefined, add: string) => (cls ? `${cls} ${add}` : add);
const staticClass = (cls: string | undefined, faded: boolean) => withClass(cls, faded ? `${STATIC_CLASS} ${FADED}` : STATIC_CLASS);

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
  /** The layer node, while the origin is the same. */
  let layerMemo: { x: number; y: number; node: Node } | null = null;

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
      // Select picks, drags and box-selects sketches as shapes (Task 12); FlowTab routes their ids to the layout file.
      selectable: true,
      draggable: true,
      connectable: false,
      focusable: true,
      deletable: false,
    };
    sketchMemo.set(s.id, { sketch: s, node });
    return node;
  }

  /** The zero-size layer at `-origin`: an origin shift moves this one node (Decision 21). */
  function layerNode(origin: { x: number; y: number }): Node {
    if (layerMemo && layerMemo.x === origin.x && layerMemo.y === origin.y) return layerMemo.node;
    const node: Node = {
      id: SKETCH_LAYER_ID,
      type: "sketchLayer",
      position: { x: 0 - origin.x, y: 0 - origin.y },
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
    layerMemo = { x: origin.x, y: origin.y, node };
    return node;
  }

  /** A static frame's children, reused while what they are drawn from is the same. */
  function staticFrame(frameId: string, inKey: string, f: FrameResult, e: FrameLayout | undefined, k: number, clash: boolean): Built {
    const idOf = clash ? (id: string) => clashInFrameId(k, id) : (id: string) => inFrameId(inKey, id);
    const positions = e?.nodes;
    const sizes = e?.sizes;
    const axes = e?.axes;
    const lk = e?.style ?? look;
    const scale = TEXT_SCALE[e?.textSize ?? "m"];
    // Each frame's own ER line ends (Decision 22), read by `frameGraph` from its entry.
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
      was.inKey === inKey
    )
      return was;
    // Only its place in the text moved (a frame added or deleted above it): the same children in another z band, so
    // a band shift of 49 frames makes no graph (Task 15: rebuilding them cost 18.6 ms).
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
      was.inKey === inKey
    ) {
      const dz = Z_BAND * (k - was.k);
      const shifted: Built = {
        ...was,
        k,
        children: was.children.map((c) => ({ ...c, zIndex: (c.zIndex ?? 0) + dz })),
        edges: was.edges.map((e) => ({ ...e, zIndex: (e.zIndex ?? 0) + dz })),
        preview: was.preview && { ...was.preview, zIndex: (was.preview.zIndex ?? 0) + dz },
      };
      memo.set(frameId, shifted);
      return shifted;
    }
    const built: Built = { doc: f.doc, lastValid: f.lastValid, positions, sizes, axes, look: lk, scale, notation, k, faded, idOf, inKey, local: drawnBox([]), children: [], edges: [] };
    const doc = f.doc ?? f.lastValid;
    if (doc) {
      // The same graph and box `frameBounds` measures. A clash frame is never an empty box: until its layout comes
      // back, its unplaced shapes stand in a row.
      const g = frameGraph(e, doc, lk, clash);
      const local = drawnBox(g.nodes);
      built.local = local;
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
          className: staticClass(n.className, faded),
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

  /** A static frame as one node (Task 18b): made once from its children and lines, then kept while they are. */
  function previewNode(frameId: string, built: Built): Node {
    if (built.preview) return built.preview;
    const areas: Rect[] = [];
    const shapes: Rect[] = [];
    const at = new Map<string, Rect>();
    for (const c of built.children) {
      const r = { x: c.position.x, y: c.position.y, w: c.initialWidth ?? 0, h: c.initialHeight ?? 0 };
      at.set(c.id, r);
      (c.type === "area" ? areas : shapes).push(r);
    }
    const lines: [number, number, number, number][] = [];
    for (const e of built.edges) {
      const a = at.get(e.source);
      const b = at.get(e.target);
      if (a && b) lines.push([a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y + b.h / 2]);
    }
    const data: FramePreviewData = { areas, shapes, lines, faded: built.faded };
    built.preview = {
      id: built.idOf("\u0000preview"),
      type: FRAME_PREVIEW_TYPE,
      parentId: frameId,
      position: { x: 0, y: 0 },
      initialWidth: built.local.w,
      initialHeight: built.local.h,
      style: { width: built.local.w, height: built.local.h, pointerEvents: "none" },
      data,
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      deletable: false,
      zIndex: staticZ(built.k, 0),
      className: staticClass(undefined, built.faded),
    };
    return built.preview;
  }

  /** A frame's box node, the same object while its box, z and fade are. */
  function boxNode(frameId: string, box: FrameBox, z: number, faded: boolean): Node {
    const was = boxMemo.get(frameId);
    if (was && was.z === z && was.faded === faded && sameBox(was.box, box)) return was.node;
    const node: Node = {
      id: frameId,
      type: "boardFrame",
      position: { x: box.x, y: box.y },
      initialWidth: box.w,
      initialHeight: box.h,
      style: { width: box.w, height: box.h },
      data: { box, faded },
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      deletable: false,
      zIndex: z,
    };
    boxMemo.set(frameId, { box, z, faded, node });
    return node;
  }

  return {
    /**
     * The canvas of `frames` (the newest parse's), placed by `board` under `keys`. `keys` must be that parse's own
     * (`Parsed.keys`), never `useFlowDoc`'s header keys: those run ahead of the parse while a header edit waits for it,
     * and would put a frame on another frame's entry and id. A static frame's children keep their objects across a
     * switch; its box node is a new object when the origin moves (same id, so nothing remounts).
     * The selected frame is live unless its title is an earlier frame's; `live` is its nodes as FlowTab draws them.
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
      /** Below BOX_BELOW (Task 18b): each static frame draws as one preview node and no lines. */
      preview = false,
    ): BoardSceneOut {
      const si = selectedIndex(frames, selected);
      const li = si === null || isClashKey(keys[si]) ? null : si;
      const liveAt = li === null ? null : board.frames.get(keys[li])?.at;
      const origin = { x: liveAt?.x ?? 0, y: liveAt?.y ?? 0 };
      const counts = problemCounts(frames, problems);
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      const boxes: FrameBox[] = [];
      const children = new Map<string, readonly Node[]>();
      let liveBox: FrameBox | null = null;
      const seen = new Set<string>();
      // The sketch layer first: a parent comes before its children.
      if (board.sketches.length > 0) {
        nodes.push(layerNode(origin));
        const ids = new Set<string>();
        for (const s of board.sketches) {
          ids.add(s.id);
          nodes.push(sketchNode(s));
        }
        if (sketchMemo.size > ids.size) for (const id of sketchMemo.keys()) if (!ids.has(id)) sketchMemo.delete(id);
      } else sketchMemo.clear();
      frames.forEach((f, i) => {
        const key = keys[i];
        const clash = isClashKey(key);
        const frameId = clash ? duplicateFrameId(i) : boardFrameId(key);
        seen.add(frameId);
        if (i === li) {
          // From the live nodes alone (frame-local, so already origin-relative): a drag tick touches no static frame.
          const r = drawnBox(live?.nodes ?? []);
          const box: FrameBox = { key, index: i, title: f.title, kind: f.kind, ...r, problems: counts[i], clash: false };
          boxes.push(box);
          liveBox = box;
          nodes.push(boxNode(frameId, box, Z_LIVE_BOX, false));
          return;
        }
        const laid = clash ? clashLayouts?.get(i) : undefined;
        const e = clash ? (laid?.title === f.title ? laid.entry : undefined) : board.frames.get(key);
        const built = staticFrame(frameId, clash ? `\u0000#${i}` : key, f, e, i, clash);
        const at = e?.at ?? { x: 0, y: 0 };
        const r = built.local;
        const box: FrameBox = {
          key: clash ? null : key,
          index: i,
          title: f.title,
          kind: f.kind,
          x: at.x + r.x - origin.x,
          y: at.y + r.y - origin.y,
          w: r.w,
          h: r.h,
          problems: counts[i],
          clash,
        };
        boxes.push(box);
        nodes.push(boxNode(frameId, box, Z_BAND * i, built.faded));
        children.set(frameId, built.children);
        if (preview) {
          if (built.children.length > 0) nodes.push(previewNode(frameId, built));
        } else {
          for (const c of built.children) nodes.push(c);
          for (const c of built.edges) edges.push(c);
        }
      });
      for (const id of memo.keys()) if (!seen.has(id)) memo.delete(id);
      for (const id of boxMemo.keys()) if (!seen.has(id)) boxMemo.delete(id);
      return { nodes, edges, boxes, live: liveBox, origin, children };
    },
    /** How many static frames' children are held, for the memory tests. */
    memoSize: () => memo.size,
    /** How many box nodes are held, for the memory tests. */
    boxMemoSize: () => boxMemo.size,
    /** How many sketch nodes are held, for the memory tests. */
    sketchMemoSize: () => sketchMemo.size,
  };
}
