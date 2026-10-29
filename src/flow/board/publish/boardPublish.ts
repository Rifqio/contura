// What each part of a board publishes (Plan B4 Decisions 1, 2, 4 and 7), as plain data: the frames with their docs,
// layouts and settings in board units, the sketches, and the region. No DOM and no React: the composer (Task 4) draws
// from this, and the dialog (Task 5) reads the parts and the left-out counts.
import { type Box, type Scene, sceneBounds } from "../../../diagram/export/scene";
import { type DiagramKind, FIXED_KINDS, type FlowDoc } from "../../../lang/flow/model";
import type { FrameResult } from "../../../lang/flow/service";
import { DIAGRAM_KIND_WORD } from "../../diagramKinds";
import type { FlowLayout } from "../../layout";
import { type BoardLayout, type ErNotation, type FrameLayout, frameGraph, frameLayoutView, type Sketch, TEXT_SCALE } from "../boardLayout";
import { FRAME_TAB_H, type FrameBox, TAB_CHAR_W, TAB_GAP, TAB_ICON, TAB_PAD_X, TAB_TITLE_MAX } from "../boardScene";

export type BoardPart = "board" | "frame" | "selection" | "screen";

/** One frame as it publishes: its doc, layout and settings, placed in board units. */
export interface PublishFrame {
  key: string;
  index: number;
  /** As typed; the drawing says "Untitled" for an empty one. */
  title: string;
  kind: DiagramKind;
  at: { x: number; y: number };
  /** The canvas box in board units, the tab not included. */
  box: Box;
  doc: FlowDoc;
  layout: FlowLayout;
  textScale: number;
  notation?: ErNotation;
  folded?: ReadonlySet<string>;
  live: boolean;
}

export interface BoardPublishInput {
  /** The frames with something drawn, in text order. */
  frames: PublishFrame[];
  /** Frames left out with nothing drawn (Decision 4). */
  nothingDrawn: number;
  /** Frames left out because an earlier frame has their title (Decision 4). */
  clashing: number;
  sketches: readonly Sketch[];
  iconTitles: ReadonlyMap<string, string>;
  /** The live frame's index, null with none. */
  frameIndex: number | null;
  /** The live frame's selected shape names. */
  shapes: readonly string[];
  /** The selected sketches' ids. */
  sketchIds: readonly string[];
  /** The visible part of the canvas, in board units. */
  onScreen: Box;
}

/**
 * `useFlowDoc` keys a frame whose title an earlier frame has as `\u0000#<index>`. A missing key (keys shorter than
 * frames) is not a repeated title: such a frame is read with no layout entry, never counted in the clash note.
 */
const isClashKey = (key: string | undefined) => key !== undefined && key.startsWith("\u0000#");

/**
 * The doc a frame publishes: its own, else its last good one, never one that belongs to another frame. The last good
 * doc is the frame's own (the worker's `lastFor`, B4 Task 2b); as defence in depth one is still refused when its kind
 * is not the frame's, or when it is another frame's current doc.
 */
function publishedDoc(frames: readonly FrameResult[], i: number): FlowDoc | null {
  const f = frames[i];
  if (f.doc) return f.doc;
  const last = f.lastValid;
  if (!last) return null;
  if (f.kind !== null && last.kind !== f.kind) return null;
  for (let j = 0; j < frames.length; j++) {
    if (j === i) continue;
    const o = frames[j];
    if (o.doc === last || (f.lastValidId !== null && o.docId === f.lastValidId)) return null;
  }
  return last;
}

/** The live layout as a frame entry: its places, sizes and axes over the entry's place and settings. */
function liveEntry(e: FrameLayout | undefined, l: FlowLayout): FrameLayout {
  const out: FrameLayout = { ...(e ?? { at: { x: 0, y: 0 } }), nodes: l.nodes, style: l.style, direction: l.direction };
  if (l.sizes) out.sizes = l.sizes;
  else delete out.sizes;
  if (l.axes) out.axes = l.axes;
  else delete out.axes;
  return out;
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * True when the frame draws something: `frameGraph(entry, doc).nodes.length > 0`, the graph and test the canvas draws
 * with (Decision 4, R2), answered without building that graph whenever a shape is sure to be drawn (final review I2:
 * the Publish guards run on every keystroke). A sequence or timeline draws every shape from its text; a mind map draws
 * from its root; any other kind draws each shape its entry places. Otherwise (no such shape) the graph is built, which
 * is cheap then: it holds only group areas, a loop box or an axis. `the_cheap_guard_agrees_with_frame_graph` checks the
 * two answers agree.
 */
export function frameDraws(entry: FrameLayout | undefined, doc: FlowDoc): boolean {
  if (doc.kind === "sequence" || doc.kind === "timeline") {
    if (doc.nodes.length > 0) return true;
  } else if (doc.kind === "mindmap") {
    if (doc.nodes.some((n) => n.kind === "root")) return true;
  } else if (!FIXED_KINDS.has(doc.kind)) {
    const at = entry?.nodes;
    if (at && doc.nodes.some((n) => own(at, n.name))) return true;
  }
  return frameGraph(entry, doc, entry?.style ?? "modern").nodes.length > 0;
}

/**
 * The publish input of a board as FlowTab holds it (R8): `frames` and `keys` are the pair FlowTab's `board` was built
 * from (`parsed.result.frames`, `parsed.keys`); `boxes` and `frameIndex` come from that `board`; `live` is the
 * live frame's layout, folds and settings. The canvas is in board units (Plan F Decision 11), so its boxes are taken
 * as they are.
 */
export function boardPublishInput(a: {
  frames: readonly FrameResult[];
  board: BoardLayout;
  keys: readonly string[];
  boxes: readonly FrameBox[];
  frameIndex: number | null;
  live: { layout: FlowLayout; folded: ReadonlySet<string>; textScale: number; notation: ErNotation } | null;
  shapes: readonly string[];
  sketchIds: readonly string[];
  iconTitles?: ReadonlyMap<string, string>;
  onScreen: Box;
}): BoardPublishInput {
  const frames: PublishFrame[] = [];
  let nothingDrawn = 0;
  let clashing = 0;
  const boxOf = new Map<number, FrameBox>();
  for (const b of a.boxes) boxOf.set(b.index, b);
  a.frames.forEach((f, i) => {
    const given: string | undefined = a.keys[i];
    if (isClashKey(given)) {
      clashing++;
      return;
    }
    const key = given ?? "";
    const e = given === undefined ? undefined : a.board.frames.get(key);
    const doc = publishedDoc(a.frames, i);
    const isLive = i === a.frameIndex && a.live !== null;
    // The live frame is drawn from its live layout, so "nothing drawn" reads that, not a board entry behind it.
    const drawnFrom: FrameLayout | undefined = isLive && a.live ? liveEntry(e, a.live.layout) : e;
    if (!doc || !frameDraws(drawnFrom, doc)) {
      nothingDrawn++;
      return;
    }
    const at = e?.at ?? { x: 0, y: 0 };
    const cb = boxOf.get(i);
    const box: Box = cb ? { x: cb.x, y: cb.y, w: cb.w, h: cb.h } : { x: at.x, y: at.y, w: 0, h: 0 };
    const out: PublishFrame = isLive
      ? { key, index: i, title: f.title, kind: doc.kind, at, box, doc, layout: a.live!.layout, textScale: a.live!.textScale, notation: a.live!.notation, folded: a.live!.folded, live: true }
      : {
          key,
          index: i,
          title: f.title,
          kind: doc.kind,
          at,
          box,
          doc,
          layout: given === undefined ? frameLayoutView({ frames: new Map(), sketches: [] }, key, doc.kind) : frameLayoutView(a.board, key, doc.kind),
          textScale: TEXT_SCALE[e?.textSize ?? "m"],
          notation: e?.notation ?? "crow",
          live: false,
        };
    frames.push(out);
  });
  return {
    frames,
    nothingDrawn,
    clashing,
    sketches: a.board.sketches,
    iconTitles: a.iconTitles ?? new Map(),
    frameIndex: a.frameIndex,
    shapes: a.shapes,
    sketchIds: a.sketchIds,
    onScreen: a.onScreen,
  };
}

/**
 * True when some frame has something drawn (Decision 4), by the same rule `boardPublishInput` leaves frames out with:
 * Publish's entry points are on. Stops at the first frame that draws; the live frame reads its live layout. With
 * `only`, that one frame is asked about (Publish frame...), so the row and the publish input never disagree.
 */
export function anyFrameDrawn(a: { frames: readonly FrameResult[]; board: BoardLayout; keys: readonly string[]; frameIndex: number | null; liveLayout: FlowLayout | null; only?: number }): boolean {
  for (let i = a.only ?? 0; i < (a.only === undefined ? a.frames.length : Math.min(a.only + 1, a.frames.length)); i++) {
    const given: string | undefined = a.keys[i];
    if (isClashKey(given)) continue;
    const doc = publishedDoc(a.frames, i);
    if (!doc) continue;
    const e = given === undefined ? undefined : a.board.frames.get(given);
    const from = i === a.frameIndex && a.liveLayout ? liveEntry(e, a.liveLayout) : e;
    if (frameDraws(from, doc)) return true;
  }
  return false;
}

const liveFrame = (i: BoardPublishInput) => i.frames.find((f) => f.live) ?? null;

/**
 * True when at least one selected name is drawn in the live frame: in its doc and placed (a sequence, mind map or
 * timeline places every node from its text), as `flowScene` draws it. Names left from a deleted node are stale and
 * never enable Selection, which would publish an empty picture.
 */
function hasDrawnShape(i: BoardPublishInput): boolean {
  const live = liveFrame(i);
  if (!live || i.shapes.length === 0) return false;
  const names = new Set(live.doc.nodes.map((n) => n.name));
  const fixed = FIXED_KINDS.has(live.doc.kind);
  return i.shapes.some((s) => names.has(s) && (fixed || Object.prototype.hasOwnProperty.call(live.layout.nodes, s)));
}
const hasSelectedSketch = (i: BoardPublishInput) => {
  if (i.sketchIds.length === 0) return false;
  const ids = new Set(i.sketchIds);
  return i.sketches.some((s) => ids.has(s.id));
};

/** Whether part `p` has what it needs: something on the board, a live frame, or a selection. */
export function partEnabled(i: BoardPublishInput, p: BoardPart): boolean {
  switch (p) {
    case "board":
    case "screen":
      return i.frames.length > 0 || i.sketches.length > 0;
    case "frame":
      return liveFrame(i) !== null;
    case "selection":
      return hasDrawnShape(i) || hasSelectedSketch(i);
  }
}

/** The part the dialog opens on (Decision 2, Figma and Miro): the selection, else the selected frame, else the board. */
export function defaultPart(i: BoardPublishInput): BoardPart {
  if (partEnabled(i, "selection")) return "selection";
  if (partEnabled(i, "frame")) return "frame";
  return "board";
}

export const sketchBox = (s: Sketch): Box => ({ x: s.x, y: s.y, w: s.w, h: s.h });

/** The room a Section's title takes above its box: one 18 px line in its 4 px gap (SketchNode, `sketchSvg`). */
export const SECTION_TITLE_ABOVE = 22;

/** What a sketch draws: its box, and a Section's title line above it (as a frame's extent counts its tab). */
export const sketchExtent = (s: Sketch): Box => (s.kind === "section" ? { x: s.x, y: s.y - SECTION_TITLE_ABOVE, w: s.w, h: s.h + SECTION_TITLE_ABOVE } : sketchBox(s));

/** True when the two boxes meet; a touching edge counts, so a flat line sketch meets the box it lies in. */
export function intersects(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

const inside = (outer: Box, b: Box) => b.x >= outer.x && b.y >= outer.y && b.x + b.w <= outer.x + outer.w && b.y + b.h <= outer.y + outer.h;

export function join(a: Box | null, b: Box): Box {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const EMPTY: Box = { x: 0, y: 0, w: 0, h: 0 };

/**
 * The selection's region in board units: the live frame's selected shapes (`sceneBounds` of the live scene, moved by
 * its `at`) joined with the selected sketches' extents (a Section's title counted); null when neither holds anything.
 */
export function selectionRegion(i: BoardPublishInput, liveScene: Scene | null): Box | null {
  let out: Box | null = null;
  const live = liveFrame(i);
  if (live && liveScene && i.shapes.length > 0) {
    const pick = new Set(i.shapes);
    // sceneBounds gives an all-zero box when nothing matches: only a shape the scene holds counts.
    if (liveScene.nodes.some((n) => pick.has(n.id))) {
      const b = sceneBounds(liveScene, [...i.shapes]);
      out = { x: b.x + live.at.x, y: b.y + live.at.y, w: b.w, h: b.h };
    }
  }
  if (i.sketchIds.length > 0) {
    const ids = new Set(i.sketchIds);
    for (const s of i.sketches) if (ids.has(s.id)) out = join(out, sketchExtent(s));
  }
  return out;
}

/**
 * The estimated width of a frame's title pill (R21): padding, the 14 px kind icon, a gap, the kind word, a gap, the
 * title ("Untitled" when empty, at most TAB_TITLE_MAX), padding; words by the 7 px per character estimate.
 */
export function tabWidth(title: string, kind: DiagramKind): number {
  const word = DIAGRAM_KIND_WORD[kind].length * TAB_CHAR_W;
  const name = Math.min((title || "Untitled").length * TAB_CHAR_W, TAB_TITLE_MAX);
  return TAB_PAD_X + TAB_ICON + TAB_GAP + word + TAB_GAP + name + TAB_PAD_X;
}

/** A frame's extent: its box, plus its tab strip above it (as wide as the tab when that is wider) with titles on. */
export function frameExtent(f: PublishFrame, titles: boolean): Box {
  if (!titles) return f.box;
  return { x: f.box.x, y: f.box.y - FRAME_TAB_H, w: Math.max(f.box.w, tabWidth(f.title, f.kind)), h: f.box.h + FRAME_TAB_H };
}

/**
 * What part `p` draws (Decision 1). Whole board: every frame and sketch, the region round them all. Selected frame: the
 * live frame alone (an overlapping frame is left out, as Figma exports) with the sketches wholly on its box, the region
 * its extent. Selection and What's on screen: every frame and sketch that meets `region`.
 */
export function partContent(i: BoardPublishInput, p: BoardPart, region: Box | null, titles: boolean): { frames: PublishFrame[]; sketches: Sketch[]; region: Box } {
  if (p === "board") {
    let r: Box | null = null;
    for (const f of i.frames) r = join(r, frameExtent(f, titles));
    for (const s of i.sketches) r = join(r, sketchExtent(s));
    return { frames: [...i.frames], sketches: [...i.sketches], region: r ?? { ...EMPTY } };
  }
  if (p === "frame") {
    const f = liveFrame(i);
    if (!f) return { frames: [], sketches: [], region: { ...EMPTY } };
    return { frames: [f], sketches: i.sketches.filter((s) => inside(f.box, sketchBox(s))), region: frameExtent(f, titles) };
  }
  if (!region) return { frames: [], sketches: [], region: { ...EMPTY } };
  return {
    frames: i.frames.filter((f) => intersects(frameExtent(f, titles), region)),
    sketches: i.sketches.filter((s) => intersects(sketchExtent(s), region)),
    region,
  };
}
