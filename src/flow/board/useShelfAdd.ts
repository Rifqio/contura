// The Shelf's add (B2 decisions 2, 7 and 9), moved out of FlowTab (Plan F Task 11, a pure move): a click or a drop of a
// Shelf item becomes frames, an icon node or sketch, a shape, or an opened field. It reads the tab's refs and actions
// through `ShelfAddDeps`, handed over fresh each render as the closures it came from were, so nothing here is stale.
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { DIAGRAM_KINDS, type DiagramKind, FIXED_KINDS, type FlowDoc, type FlowNodeKind } from "../../lang/flow/model";
import { blankText, DIAGRAM_KIND_WORD } from "../diagramKinds";
import { EDIT_MESSAGES } from "../editWords";
import type { CanvasNote } from "../interactions/CanvasToast";
import type { Point } from "../interactions/geometry";
import { iconTitleOf } from "../icons";
import { type Shape, shapesOf } from "../ShapePicker";
import type { Parsed, Rect, useFlowDoc } from "../useFlowDoc";
import { type FrameBox } from "./boardScene";
import type { Sketch } from "./boardLayout";
import { templateById } from "./catalog/templates";
import { shelfIconSource } from "./shelf/iconSource";
import type { ShelfCloseReason } from "./shelf/Shelf";
import { SHELF_DRAG_TYPE, type ShelfItem } from "./shelf/types";
import { frameAtPoint, ICON_NODE_KINDS } from "./shelfDrop";
import { draftSketch, ICON_SKETCH_SIZE } from "./SketchDraw";
import { type NewSketch, SKETCH_WORD } from "./sketches";

/** What an add from the Shelf came to: added (toasted now, or once its frames are selected), a field opened, refused, or nothing. */
export type ShelfOutcome = { added: string; later?: boolean } | { refused: string } | "field" | "none";

/** The shape an icon node is drawn as in each kind that takes one, for its size before it is drawn (B2 decision 7). */
const ICON_NODE_SHAPE: Partial<Record<DiagramKind, FlowNodeKind>> = {
  flow: "step",
  dfd: "process",
  state: "state",
  cloud: "service",
  mindmap: "topic",
};

/** A Shelf drag's payload read back (R11): null for anything that is not a whole Shelf item. */
function shelfItemOf(raw: string): ShelfItem | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => typeof o[k] === "string" && o[k] !== "";
  switch (o.kind) {
    case "diagram":
      return DIAGRAM_KINDS.includes(o.diagram as DiagramKind) ? (o as ShelfItem) : null;
    case "template":
      return str("id") ? (o as ShelfItem) : null;
    case "icon":
      return str("name") ? (o as ShelfItem) : null;
    case "sketch":
      return ["rect", "ellipse", "diamond", "note", "text"].includes(o.sketch as string) ? (o as ShelfItem) : null;
    case "shape":
      return DIAGRAM_KINDS.includes(o.frameKind as DiagramKind) && str("label") ? (o as ShelfItem) : null;
    default:
      return null;
  }
}


/** What the Shelf's add reads of the tab: its refs, its setters and the actions it calls. */
export interface ShelfAddDeps {
  doc: Pick<ReturnType<typeof useFlowDoc>, "addFrames" | "run" | "frameIdNow" | "place">;
  kind: DiagramKind | null;
  aiLock: { current: boolean };
  /** A Shelf or Space box add is running. */
  shelfAdding: { current: boolean };
  addedFrame: MutableRefObject<{ titles: string[]; boxes: Rect[]; toast: string | null; depth: number | null } | null>;
  historyDepth: () => number | null;
  setNote: Dispatch<SetStateAction<CanvasNote | null>>;
  closeShelf: (reason: ShelfCloseReason) => void;
  undoableToast: (text: string) => void;
  viewMiddle: () => Point;
  openFromDatabase: { current: (() => void) | null };
  openFromMermaid: { current: (() => void) | null };
  /** The tab's own latest closures: an icon placed after its frame switch is this render's, not the one that asked. */
  lateActs: { current: { iconNode: (title: string, icon: string, at?: Point) => Promise<ShelfOutcome>; placeIcon: (title: string, icon: string, p: Point, dropped: boolean) => Promise<ShelfOutcome | null>; finishShelf: (outcome: ShelfOutcome) => void } };
  boardRef: { current: { boxes: Parameters<typeof frameAtPoint>[0] } | null | undefined };
  liveBoxRef: { current: FrameBox | null | undefined };
  parsedRef: { current: Parsed | null | undefined };
  drawnRef: { current: FlowDoc | null | undefined };
  selectedRef: { current: readonly string[] };
  sketchList: { current: readonly Sketch[] };
  setLines: (lines: string[]) => void;
  setSelected: (names: string[]) => void;
  setSketchSel: (ids: string[]) => void;
  setSketchField: (f: { mode: "new"; kind: "text" | "note"; at: Point }) => void;
  addOneSketch: (s: NewSketch, onRefused?: (why: string) => void) => string | null;
  freeName: (base: string, taken: Set<string>) => string;
  namesOf: (doc: FlowDoc) => Set<string>;
  freeSpotInView: (size: { w: number; h: number }) => Point;
  groupUnder: (p: Point) => string | null;
  newSize: (kind: FlowNodeKind, name: string) => { w: number; h: number };
  runShape: (sh: Shape, at?: Point, place?: { group?: string | null }) => boolean | Promise<boolean>;
  shapeDisabled: (sh: Shape) => string | null;
  switchFrame: (sel: { title: string; index: number } | null, pick?: string[], then?: (box: FrameBox) => void, live?: boolean) => boolean;
  toBoard: (flow: Point) => Point;
  toLive: (flow: Point) => Point;
  trackCommit: (p: Promise<unknown> | undefined) => void;
}

export function useShelfAdd(d: ShelfAddDeps) {
  const {
    doc,
    kind,
    aiLock,
    shelfAdding,
    addedFrame,
    historyDepth,
    setNote,
    closeShelf,
    undoableToast,
    viewMiddle,
    openFromDatabase,
    openFromMermaid,
    lateActs,
    boardRef,
    liveBoxRef,
    parsedRef,
    drawnRef,
    selectedRef,
    sketchList,
    setLines,
    setSelected,
    setSketchSel,
    setSketchField,
    addOneSketch,
    freeName,
    namesOf,
    freeSpotInView,
    groupUnder,
    newSize,
    runShape,
    shapeDisabled,
    switchFrame,
    toBoard,
    toLive,
    trackCommit,
  } = d;

  /** Frames from text through `addFrames`, centred on `at` (decisions 8 and 9). */
  async function addShelfFrames(frames: { text: string }[], at: Point, name: (titles: string[]) => string): Promise<ShelfOutcome> {
    const r = await doc.addFrames(frames, at);
    // "" is a silent no-op (the tab closed, the text kept changing): nothing to say (T1).
    if ("refused" in r) return r.refused ? { refused: r.refused } : "none";
    const said = `Added ${name(r.titles)}.`;
    addedFrame.current = { titles: r.titles, boxes: r.boxes, toast: said, depth: historyDepth() };
    return { added: said, later: true };
  }

  /** A Shelf add's end: an add closes the Shelf with its Undo toast; a refusal keeps it open with its note, no Undo (R10). */
  function finishShelf(outcome: ShelfOutcome) {
    if (outcome === "none") return;
    if (outcome === "field") return closeShelf("add");
    if ("refused" in outcome) return void setNote({ text: outcome.refused, key: Date.now() });
    if (!outcome.later) undoableToast(outcome.added);
    closeShelf("add");
  }

  /** One sketch from the Shelf; a full board's refusal goes to the toast (R10). */
  function shelfSketch(s: NewSketch | null, word: string): ShelfOutcome {
    if (!s) return "none";
    let why: string | null = null;
    const id = addOneSketch(s, (w) => (why = w));
    if (id) return { added: `Added ${word}.` };
    return why ? { refused: why } : "none";
  }

  /**
   * An icon as a node of the live frame (decision 7): named by its title, unique; at `at` (flow) or, without it, where
   * a new shape goes. A mind map's goes under the selected topic or the central idea.
   */
  async function iconNode(title: string, icon: string, at?: Point): Promise<ShelfOutcome> {
    if (aiLock.current || !kind || !ICON_NODE_KINDS.has(kind)) return "none";
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    const nodes = known?.nodes ?? [];
    const name = known ? freeName(title, namesOf(known)) : title;
    // A data flow node needs its kind said (R28); the other kinds leave it unsaid.
    let nodeKind: FlowNodeKind | null = kind === "dfd" ? "process" : null;
    let under: string | undefined;
    if (kind === "mindmap") {
      const root = nodes.find((n) => n.kind === "root");
      nodeKind = root ? "topic" : "root";
      const sel = selectedRef.current.length === 1 ? nodes.find((n) => n.name === selectedRef.current[0]) : undefined;
      under = sel && (sel.kind === "topic" || sel.kind === "root") ? sel.name : root?.name;
    }
    const size = newSize(nodeKind ?? ICON_NODE_SHAPE[kind] ?? "process", name);
    const spot = at ? { x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2) } : freeSpotInView(size);
    const group = at && kind !== "mindmap" ? groupUnder(at) : null;
    const fixed = FIXED_KINDS.has(kind);
    let why: string | null = null;
    const started = doc.frameIdNow();
    const run = doc.run(
      { op: "addNode", name, kind: nodeKind, attrs: { icon }, unique: true, ...(group ? { group } : {}), ...(under !== undefined && nodeKind === "topic" ? { under } : {}) },
      { frame: started, ...(fixed ? {} : { move: { [name]: spot } }), onRefused: (w) => (why = w) },
    );
    // An awaited commit (as C1): a frame switch meanwhile waits for it, so the node lands in its own frame.
    trackCommit(run);
    const r = await run;
    if (!r?.name) return why ? { refused: why } : "none";
    // `unique` chose another name after all: place that one.
    if (!fixed && r.name !== name) doc.place({ [r.name]: spot }, true, r.frame ?? null);
    // Selected unless another frame was selected meanwhile.
    if (doc.frameIdNow() === started) {
      setSketchSel([]);
      setLines([]);
      setSelected([r.name]);
    }
    return { added: `Added ${title}.` };
  }

  /** An icon from the Shelf: a node in the frame under the point (or the selected frame, for a click) when its kind takes icons, else an icon sketch. */
  async function shelfIcon(icon: string, p: Point, dropped: boolean): Promise<ShelfOutcome | null> {
    const title = await iconTitleOf(icon);
    // The frame may have changed while the title loaded: the rest is this render's (`lateActs`).
    return lateActs.current.placeIcon(title, icon, p, dropped);
  }

  /** `shelfIcon` once the icon's title is known. */
  async function placeIcon(title: string, icon: string, p: Point, dropped: boolean): Promise<ShelfOutcome | null> {
    if (aiLock.current) return { refused: EDIT_MESSAGES.locked };
    const live = liveBoxRef.current;
    const b = boardRef.current;
    const hit = dropped ? (b ? frameAtPoint(b.boxes, toBoard(p), live?.key ?? null) : null) : live;
    const remember = (r: ShelfOutcome) => {
      if (typeof r === "object" && "added" in r) shelfIconSource.remember(icon);
      return r;
    };
    if (hit && hit.kind && ICON_NODE_KINDS.has(hit.kind) && !hit.clash) {
      if (live && hit.index === live.index) return remember(await iconNode(title, icon, dropped ? toLive(p) : undefined));
      // Another frame: it is selected, and the node goes in once it is live, at the same board point (R24), read in
      // that frame's units then.
      switchFrame(
        { title: hit.title, index: hit.index },
        [],
        () => {
          void lateActs.current.iconNode(title, icon, toLive(p)).then((r) => lateActs.current.finishShelf(remember(r)));
        },
        true,
      );
      return null;
    }
    const size = ICON_SKETCH_SIZE;
    return remember(shelfSketch({ kind: "icon", x: Math.round(p.x - size.w / 2), y: Math.round(p.y - size.h / 2), w: size.w, h: size.h, icon }, title));
  }

  /** A kind shape from the Shelf (decision 7, B1 decision 19). */
  function shelfShape(item: Extract<ShelfItem, { kind: "shape" }>, at?: Point): ShelfOutcome | Promise<ShelfOutcome> {
    const live = liveBoxRef.current;
    const sh = shapesOf(item.frameKind).find((x) => x.label === item.label);
    if (!sh) return "none";
    const refuse = { refused: `Drop ${item.label} inside its diagram.` };
    let local: Point | undefined;
    if (at) {
      const b = boardRef.current;
      const hit = b ? frameAtPoint(b.boxes, toBoard(at), live?.key ?? null) : null;
      if (!hit) return refuse;
      // Another frame: it is selected, and nothing is added (B1 decision 19).
      if (!live || hit.index !== live.index) {
        switchFrame({ title: hit.title, index: hit.index });
        return "none";
      }
      local = toLive(at);
    }
    if (!live || kind !== item.frameKind) return refuse;
    const why = shapeDisabled(sh);
    if (why) return { refused: `${sh.label}: ${why.charAt(0).toLowerCase()}${why.slice(1)}.` };
    const r = local ? runShape(sh, local, { group: groupUnder(local) }) : runShape(sh);
    // A shape opens with its name ready, written once the name is kept: no Added toast until then (as R9's fields).
    if (r === true) return "field";
    if (r === false) return "none";
    return r.then((ok) => (ok ? { added: `Added ${sh.label}.` } : "none"));
  }

  /**
   * Adds a Shelf item (decisions 7 and 9): `at` is a board point (a drop); without it the add lands in the middle of
   * the view. Under the Assistant's lock every add is refused (R23).
   */
  async function addFromShelf(item: ShelfItem, at?: Point) {
    if (aiLock.current) return setNote({ text: EDIT_MESSAGES.locked, key: Date.now() });
    if (item.kind === "fromDatabase" || item.kind === "fromMermaid") {
      // Not draggable: a drop of one does nothing.
      if (at) return;
      const open = item.kind === "fromDatabase" ? openFromDatabase.current : openFromMermaid.current;
      closeShelf("add");
      open?.();
      return;
    }
    // One add at a time: a double-click or a held Enter while the Shelf or the Space box is still open adds once.
    if (shelfAdding.current) return;
    shelfAdding.current = true;
    try {
      await addShelfItem(item, at);
    } finally {
      shelfAdding.current = false;
    }
  }

  async function addShelfItem(item: Exclude<ShelfItem, { kind: "fromDatabase" | "fromMermaid" }>, at?: Point) {
    const p = at ?? viewMiddle();
    let outcome: ShelfOutcome | null = "none";
    switch (item.kind) {
      case "diagram":
        outcome = await addShelfFrames([{ text: blankText(item.diagram, DIAGRAM_KIND_WORD[item.diagram]) }], p, (t) => t[0]);
        break;
      case "template": {
        const t = templateById(item.id);
        if (!t) break;
        outcome = await addShelfFrames("frames" in t ? t.frames.map((text) => ({ text })) : [{ text: t.text }], p, () => t.name);
        break;
      }
      case "icon":
        outcome = await shelfIcon(item.name, p, !!at);
        break;
      case "sketch":
        if (item.sketch === "text" || item.sketch === "note") {
          // Nothing is added until text is typed (R9).
          setSketchField({ mode: "new", kind: item.sketch, at: p });
          outcome = "field";
        } else outcome = shelfSketch(draftSketch(item.sketch, p, p, { click: true, all: sketchList.current }), SKETCH_WORD[item.sketch]);
        break;
      case "shape":
        outcome = await shelfShape(item, at);
        break;
    }
    if (outcome) lateActs.current.finishShelf(outcome);
  }

  /** A drop on the board's canvas (R11): only a Shelf item, at the board point; a bad payload does nothing. */
  function dropShelf(data: DataTransfer, flowAt: Point) {
    const item = shelfItemOf(data.getData(SHELF_DRAG_TYPE));
    if (!item || !Number.isFinite(flowAt.x) || !Number.isFinite(flowAt.y)) return;
    void addFromShelf(item, toBoard(flowAt));
  }

  return { iconNode, placeIcon, finishShelf, addFromShelf, dropShelf };
}
