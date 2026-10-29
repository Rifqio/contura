// The diagram tab: the .flow text on the left (420 px) and the drawing
// on the right. Selecting a node bands its line; clicking a line selects its node. Adds, connects, renames and
// deletes on the canvas rewrite the text through the worker's edits; moves, the look and the direction write
// only the layout file. One undo history covers both. Closing the tab frees the worker's state for it.
// Editing motion: drags show their landing cell and guides and settle on release, drawn flows
// lock onto nodes and take a label or "Add and connect", groups take a dropped node, Tidy and undo glide.
import { defaultKeymap, historyKeymap, indentWithTab, isolateHistory, redo, undo, undoDepth } from "@codemirror/commands";
import { type Diagnostic as CmDiagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorState, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType } from "@codemirror/view";
import { type Edge, type Node, type NodeTypes, type ReactFlowInstance } from "@xyflow/react";
import { type ClipboardEvent, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Icon, { type IconName } from "../components/Icon";
import DiagramCanvas, { type CanvasMenuAt } from "../diagram/DiagramCanvas";
import { PlacedMenu, type PlacedMenuState } from "./DiagramMenu";
import { type AlignHow, type ColourMenu, columnMenuItems, frameMoreItems, groupMenuItems, lineMenuItems, messageMenuItems, paneMenuItems, selectionMenuItems, shapeMenuItems } from "./canvasMenus";
import { labelNotice, planWords, takesLabel } from "./labels";
import { COLOUR_INFO, type DrawnColour, drawnColour, type PaletteName } from "./palette";
import { useFlowAssistMode, useFlowPaneOpen, useFlowSidePanel } from "../prefs/usePrefs";
import SidePanel from "./SidePanel";
import DiagramAssistant from "./ai/DiagramAssistant";
import { columnRing, docParts, type PartFrame, type PartLink, ringColumn } from "./ai/answerRefs";
import { boardInput, onBoard, sketchNotes } from "./ai/boardInput";
import type { FrameReview } from "./ai/boardReview";
import { AIRING_MS, type Airing, type BoardCanvasApi, useBoardAsk } from "./ai/useBoardAsk";
import { acceptLabel } from "./ai/ProposalCard";
import type { RowState } from "./kindNodes";
import NodeEditor, { type NodeEdit, nodeEditOps } from "./NodeEditor";
import PublishDialog from "../diagram/export/PublishDialog";
import { exportPalette, type ExportTheme } from "../diagram/export/palette";
import type { Box as SceneBox, Scene } from "../diagram/export/scene";
import type { PublishSource } from "../diagram/export/source";
import { type MotionKey, motionMs } from "../diagram/motion";
import { routeOrthogonal } from "../diagram/route";
import type { Port } from "../diagram/types";
import type { Positions } from "../diagram/layout";
import CanvasToast, { type CanvasNote } from "./interactions/CanvasToast";
import { makeConnectionLine } from "./interactions/ConnectionLine";
import { type Box, groupAt, linkBox, magnetTarget, type Point, portAt } from "./interactions/geometry";
import InlineEdit, { type CommitHow } from "./interactions/InlineEdit";
import HotHandles, { createHotStore } from "./interactions/HotHandles";
import AddHere from "./interactions/AddHere";
import { DIRS, freeSpotNear, layoutGap, placeNext, type Side } from "./addNext";
import { type Shape, shapesOf } from "./ShapePicker";
import { createKindEditStore, DATE_MESSAGES, type KindEdit, KindEditContext, MEMBER_MESSAGES } from "./kindEdit";
import { columnPasteLine, ER_MESSAGES, ER_TYPES, ErCanvasContext, erTypesOf, planColumnPaste, splitRow, useErCanvas } from "./erCanvas";
import { createErScrollStore, createErSoleStore, ErScrollContext, ErSoleContext } from "./erScroll";
import { type CardHit, erRefusal, isErTable, RELATE_MESSAGES } from "./erRelate";
import { labelScale } from "./textScale";
import { useErRelate } from "./useErRelate";
import { COLOUR_WHY, EDIT_MESSAGES, GROUP_WORD, groupNeedsName, MARKER_NOTE, MULTI_LINE, NO_COLOUR, NO_GROUPS, needsName, nounOf, oneLineHint, said, takenName } from "./editWords";
import { numberingOn } from "../lang/flow/numbering";
import { openAsDbml } from "./erToDbml";
import { CanvasOverlay, createOverlayStore } from "./interactions/overlay";
import QuickAdd, { quickItems } from "./interactions/QuickAdd";
import { glideFrames } from "./interactions/glide";
import { afterPaint, easeExit, tween } from "./interactions/tween";
import type { LivePositions } from "../diagram/livePositions";
import { kindStyle, type NodeState } from "./nodes/parts";
import type { TextEdit } from "../lang/protocol";
import { ER_NOTES, type FlowEditOp, LINK_NOTES, type LinkRef, linkRefOf } from "../lang/flow/edits";
import { LOOP_CUT } from "../lang/flow/orderEdits";
import { copyLines, nonEmptyLines, TOO_MANY_LINES } from "../lang/flow/clip";
import { isColumnName, isoToday, MAX_BOARD_FRAMES, MAX_FLOW_NODES, overTextLimit, quote, sqlFreeName } from "../lang/flow/model";
import type { FlowPasteOp } from "../lang/flow/service";
import { readClipboard, writeClipboard } from "../grid/clipboard";
import { appLang } from "../lang/appLang";
import { insertionLine } from "../lang/insertionLine";
import { editorTheme } from "../lang/editorTheme";
import { editingBasics } from "../lang/editingBasics";
import type { LangClient } from "../lang/client";
import { flowLanguageWith } from "../lang/flow/cm";
import {
  ATTR_DIAGRAMS,
  LINE_COLOUR_DIAGRAMS,
  defaultArrow,
  type DiagramKind,
  FIXED_KINDS,
  type FlowArrow,
  type FlowDoc,
  type FlowGroup,
  type FlowNode,
  type FlowNodeKind,
  isStateEnd,
  isStateMarker,
  isStateStart,
  NOTE_KINDS,
  shownName,
  STATE_END,
  STATE_START,
} from "../lang/flow/model";
import type { FlowProblem } from "../lang/flow/problems";
import { staleBanner } from "../lang/flow/problems";
import { buildFlowGraph, drawnKind, FLOW_EDGE_TYPES, FLOW_NODE_TYPES, type FlowEdgeData, FlowFitContext, FlowGroupSelContext, FlowResizeContext, GHOST_ID, groupBoxes, layoutInput, LineEndsContext, nodeLimits, nodeSize, rowRoute } from "./flowNodes";
import { frameWord, mindTreeOf, newLoopCaption, onParticipantBox, seqGeometryOf, subtreeOf } from "./orderGestures";
import { groupDragEnd, groupDragFrame, groupDropAt, startGroupDrag } from "./groupDrag";
import { deletedWords, GroupAsk, groupContents } from "./groupGestures";
import { ER_REFUSED, headOf, isMermaid, kindWord, MERMAID_KINDS } from "./mermaidHead";
import { insertFlow, KIND_SHORT } from "../lang/flow/insert";
import { article } from "../format/article";
import { pasteFrame } from "../lang/flow/board";
import { parseFlow } from "../lang/flow/parse";
import { createOrderDragStore, drawAt, DROP, type FoldDot, foldDotsOf, laneIndex, nearestIndex, topicDropAt, type TopicDrop, type TopicIndex, topicIndex } from "./orderDrag";
import OrderDragLayer, { FoldDots } from "./interactions/OrderDragLayer";
import { erCardH, erMetrics, KIND_ROW, SEQ_HEAD, SEQ_ROW } from "./kindLayout";
import { ADD_TOOLS, type AddTool } from "./FlowToolbar";
import BoardMap from "./board/BoardMap";
import FrameBar, { type FrameSettingPatch } from "./board/FrameBar";
import LineBar from "./board/LineBar";
import { FRAME_GAP, frameLayoutView, TEXT_SCALE } from "./board/boardLayout";
import { anyFrameDrawn, type BoardPart, type BoardPublishInput, boardPublishInput, tabWidth } from "./board/publish/boardPublish";
import { BoardFarContext } from "./board/BoardFar";
import { type DrawnForms, frameDraw, type FrameDrawPlan, type SketchForm, SKETCHES_REAL, sketchesFar, stepForms, stepSketches, swapBudget, SWAP_BUDGET_SHAPES, tabHeight, withLiveReal } from "./board/boardDetail";
import { type CanvasHandle, type CanvasView, MAX_ZOOM, MIN_ZOOM, type ViewTarget } from "../diagram/canvasView";
import type { TextSize } from "./board/boardLayout";
import { boardIconNames, boardSource } from "./board/publish/boardSvg";
import BoardToolbar from "./board/BoardToolbar";
import { REVIEW_SAID_MS, ReviewBarOnCanvas, reviewKeys, reviewText, typingIn } from "./board/ReviewBar";
import Shelf, { type ShelfCloseReason } from "./board/shelf/Shelf";
import { type ShelfOutcome, useShelfAdd } from "./board/useShelfAdd";
import { shelfIconSource } from "./board/shelf/iconSource";
import SpaceBox, { type SpaceBoxCloseReason, ViewMoved } from "./board/shelf/SpaceBox";
import { SHELF_DRAG_TYPE, type ShelfItem } from "./board/shelf/types";
import { addedDatabaseText, type ErFromModel } from "./board/catalog/fromDatabase";
import { firstNodeHint, GENERIC_TOOLS, genericInFrame, isKindTool, KIND_TOOLS, keyOfAddTool, kindToolFor, NOTE_TOOL_ID, PEN_TOOL_ID, SPACE_MOVE_PX, SPACE_TAP_MS } from "./board/kindTools";
import { axisEnds, axisKey, emptyPositions, type FlowDirection } from "./layout";
import { frameHeadsOf, type FrameSelection, isDup, kindOfText, type Parsed, type Rect, type RunResult, useFlowDoc } from "./useFlowDoc";
import { airRows, boardFrameId, boardNodeBoxes, clashInFrameId, createBoardScene, duplicateFrameId, FRAME_PICTURE_TYPE, FRAME_TAB_H, type FrameBox, GROUP_ID, inFrameId, isStaticId, LIVE_ANCHOR_ID, LIVE_ANCHOR_TYPE, liveZ, type PartBox, partName, rowStates, SKETCH_PICTURE_TYPE, SKETCH_UNDER_CLASS, type SketchLayerDraw, Z_LIVE, Z_LIVE_BOX } from "./board/boardScene";
import FrameNode, { type FrameNodeData, type FramePane } from "./board/FrameNode";
import { byLeft, tabNeighbours, tabRoom } from "./board/tabRoom";
import FramePicture, { SketchLayerPicture } from "./board/FramePicture";
import { createSketchPictureStore, createSketchTiles } from "./board/sketchPicture";
import { sketchExtent } from "./board/publish/boardPublish";
import { perfMark, perfMeasure, perfOn, perfStep } from "../perf/perfRecorder";
import { browserRasteriser, createPictureStore, oncePerFrame } from "./board/framePicture";
import { SketchLayerNode, SKETCH_NODE_TYPES } from "./board/SketchNode";
import type { FrameSource, Sketch, SketchKind } from "./board/boardLayout";
import { draftSketch, NOTE_BOX, SketchBar, SketchDraw, type SketchDrawHandle, SketchField, SKETCH_TOOLS, textBox } from "./board/SketchDraw";
import { type SketchEdit, SketchEditContext } from "./board/SketchNode";
import {
  addSketch,
  addSketches,
  changeSketch,
  drawsUnder,
  finiteSketch,
  isSketchNodeId,
  moveSketches,
  type NewSketch,
  readSketchClip,
  removeSketches,
  setSketchColour,
  setSketchText,
  type SketchChange,
  type SketchClip,
  sketchClipText,
  sketchesInside,
  sketchIdOf,
  sketchNodeId,
  strokeBox,
} from "./board/sketches";
import { normalizeSketch } from "./board/boardLayout";
import { useFrameSwitch } from "./board/useFrameSwitch";
import { canvasEdit, frameView, showFrame, shownRange } from "./board/frameView";
import CodePaneHead from "./board/CodePaneHead";
import SyntaxHelp from "./board/SyntaxHelp";
import { frameHeaders } from "../lang/flow/board";
import IconCredits from "./IconCredits";
import IconPicker from "./IconPicker";
import { iconTitleOf, sendIconNames, useIconTheme } from "./icons";
import { flowScene, loadSceneIcons, sceneIconNames } from "./flowScene";

const NODE_WORD: Record<FlowNodeKind, string> = {
  entity: "Outside party",
  process: "Process",
  store: "Data store",
  start: "Start",
  end: "End",
  step: "Step",
  decision: "Decision",
  io: "Input or output",
  subprocess: "Subprocess",
  service: "Service",
  document: "Document",
  database: "Database",
  weak: "Weak table",
  participant: "Participant",
  actor: "Actor",
  state: "State",
  choice: "Choice",
  fork: "Fork",
  class: "Class",
  interface: "Interface",
  enum: "Enum",
  root: "Central idea",
  topic: "Topic",
  event: "Event",
  period: "Period",
  milestone: "Milestone",
  note: "Note",
};

/** What a line is called in the strip, per kind (the counts' nouns). */
const LINE_WORD: Record<DiagramKind, string> = {
  dfd: "Flow",
  flow: "Line",
  cloud: "Line",
  er: "Relationship",
  sequence: "Message",
  state: "Transition",
  class: "Line",
  mindmap: "Link",
  timeline: "Line",
};

/**
 * The strip's words for one selected shape: an ER table in ER words (table, columns, relationships), any other
 * shape as its kind and its lines.
 */
function selectionWords(kind: DiagramKind | null, node: FlowNode, lines: number): string {
  if (kind === "er" && isErTable(node)) {
    return `${node.kind === "weak" ? "Weak table" : "Table"}, ${plural(node.rows?.length ?? 0, "column")}, ${plural(lines, "relationship")}`;
  }
  return `${NODE_WORD[node.kind]}, ${plural(lines, kind === "dfd" ? "flow" : "line")}`;
}

/** The strip's words while "Add relationship to..." waits for the table. */
const linkNotice = (table: string) => `Click the table ${table} refers to. Esc cancels.`;

/** A line's end as the strip names it: a state diagram's `[*]` markers are its start and end. */
const endName = (n: string) => (isStateStart(n) ? "Start" : isStateEnd(n) ? "End" : n);

/** The link index an edge id names (`edge:3`), or null. */
const linkIndex = (id: string): number | null => {
  if (!id.startsWith("edge:")) return null;
  const i = Number(id.slice("edge:".length));
  return Number.isInteger(i) && i >= 0 ? i : null;
};

const NODE_ICON: Partial<Record<FlowNodeKind, IconName>> = {
  entity: "user",
  process: "gear",
  store: "database",
  start: "pill",
  end: "pill",
  step: "square",
  subprocess: "square",
  decision: "diamond",
  io: "io",
  service: "cube",
};

/** The selection chip's icon, by diagram kind as its words are: an ER table shows the table icon of its card's header. */
function chipIcon(kind: DiagramKind | null, node: FlowNode): IconName | undefined {
  if (kind === "er" && isErTable(node)) return "table";
  return NODE_ICON[node.kind];
}

/** A set without `item` (a new set, for state). */
const without = <T,>(set: ReadonlySet<T>, item: T): ReadonlySet<T> => {
  const next = new Set(set);
  next.delete(item);
  return next;
};

/** The first item of a set, or null when it is empty. */
const NO_NAMES: ReadonlySet<string> = new Set();
/** A frame label's field box height (a loop's, a section's): its `at` is the box's top left, its text on the middle. */
const LOOP_FIELD_H = 24;
const NO_RING: Airing = new Map();
const firstOf = (set: ReadonlySet<string>): string | null => set.values().next().value ?? null;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "5 nodes, 5 flows", "6 shapes, 7 lines" (6+.4), "9 services" (6+.5). */
function countsOf(kind: DiagramKind, doc: FlowDoc): string {
  if (kind === "dfd") return `${plural(doc.nodes.length, "node")}, ${plural(doc.links.length, "flow")}`;
  if (kind === "flow") return `${plural(doc.nodes.length, "shape")}, ${plural(doc.links.length, "line")}`;
  if (kind === "cloud") return plural(doc.nodes.length, "service");
  // Step 12 kinds: their own nouns (the start and end markers and the indent branches are not counted).
  const shown = doc.nodes.filter((n) => !(doc.kind === "state" && isStateMarker(n.name))).length;
  const drawn = doc.links.filter((l) => !l.tree).length;
  if (kind === "er") return `${plural(shown, "table")}, ${plural(drawn, "relationship")}`;
  if (kind === "sequence") return `${plural(shown, "participant")}, ${plural(drawn, "message")}`;
  if (kind === "state") return `${plural(shown, "state")}, ${plural(drawn, "transition")}`;
  if (kind === "class") return `${plural(shown, "type")}, ${plural(drawn, "line")}`;
  if (kind === "mindmap") return plural(shown, "topic");
  return plural(shown, "item");
}

/** The next free id for a new process (`3.0`) or data store (`D2`), as the frames number them. */
function nextId(doc: FlowDoc | null, kind: FlowNodeKind): string | undefined {
  if (kind !== "process" && kind !== "store") return undefined;
  let max = 0;
  for (const n of doc?.nodes ?? []) {
    const id = n.attrs.id;
    if (!id || n.kind !== kind) continue;
    const m = kind === "process" ? /^(\d+)(?:\.\d+)?$/.exec(id) : /^D(\d+)$/i.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return kind === "process" ? `${max + 1}.0` : `D${max + 1}`;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The line a first node goes on: the empty last line, else the one after it. */
function firstFreeLine(text: string): number {
  const lines = text.split("\n");
  return lines[lines.length - 1].trim() === "" ? lines.length : lines.length + 1;
}

/** Places are whole pixels on no grid (F7, erd-ux-research decision 1): the canvas's guides line shapes up instead. */
const snap = (v: number) => Math.round(v);

/** Why Delete leaves a mind map branch. */
const BRANCH_NOTE = "A branch comes from its topic's indent: move or delete the topic instead.";

/** A grid cell of a block of pasted shapes that had no place (text from outside): 13 by 7 steps of the 16 px grid. */
const PASTE_CELL = { w: 208, h: 112 };

/** How far a duplicate or a second paste lands from the shapes it copies: one grid step (draw.io's grid size). */
const PASTE_STEP = 16;
const ORIGIN0 = { x: 0, y: 0 };
/** A frame box's node id: its key's, or its index's for a frame whose title an earlier frame has. */
const frameNodeId = (b: FrameBox) => (b.key === null ? duplicateFrameId(b.index) : boardFrameId(b.key));
/** Added to the rank of a frame the plan does not draw, so every frame in view builds its picture first. */
const RANK_OUT_OF_VIEW = 1e12;

/**
 * The last copy on any diagram (one clipboard, as in draw.io): its .flow text, where its shapes were drawn and on
 * which diagram, and how many times it has been pasted there. Only this one text is kept; a new copy replaces it.
 */
let lastClip: { text: string; diagram: string; at: Positions; pastes: number; column?: string } | null = null;

/** The text of a typing field, where the clipboard keys are the field's own. */
const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

const isArea = (id: string) => id.startsWith("\u0000");
/** The ERD's Relationship tool (A): its press and its clicks join columns, the arrow inferred (B3 decision 9, R10). */
const ER_RELATIONSHIP = "er.relationship";
/** An ER card with its rows' review states: every row, as the live card scrolls. The same node when none is marked. */
function withRowStates(n: Node, review: Pick<FrameReview, "addedRows" | "removedRows" | "changedRows">): Node {
  const rows = rowStates(review, n.id, (n.data as { rows?: string[] }).rows, Number.POSITIVE_INFINITY);
  return rows ? { ...n, data: { ...n.data, rowStates: rows } } : n;
}

/**
 * An ER card with the columns an answer named or a landing added ringing on their rows (`landed` holds the landing's
 * ring entries): the same node when none is drawn.
 */
function withAiredRows(n: Node, cols: ReadonlyMap<string, ReadonlySet<string>>, landed: ReadonlySet<string>): Node {
  const named = cols.get(n.id);
  if (!named) return n;
  const data = n.data as { rows?: string[]; rowStates?: readonly (RowState | undefined)[] };
  const rows = airRows(data.rows, named, data.rowStates, Number.POSITIVE_INFINITY, (col) => landed.has(columnRing(n.id, col)));
  return rows === data.rowStates ? n : { ...n, data: { ...n.data, rowStates: rows } };
}

const boxOfNode = (n: Node): Box => ({ x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 });
/** Where lines meet the node: its box, or a cloud service's 48 px tile. */
const lineBoxOf = (n: Node): Box => linkBox(n.type, boxOfNode(n));

/** The middle of line `id` as it is drawn (at its rows for a relationship between columns, ER build C), or null. */
function edgeMid(graph: { nodes: Node[]; edges: Edge[] }, id: string, scroll: (table: string) => number): Point | null {
  const e = graph.edges.find((x) => x.id === id);
  const a = e && graph.nodes.find((n) => n.id === e.source);
  const b = e && graph.nodes.find((n) => n.id === e.target);
  if (!e || !a || !b) return null;
  const data = e.data as FlowEdgeData | undefined;
  const ab = lineBoxOf(a);
  const bb = lineBoxOf(b);
  // A + line keeps its axis wherever it is routed (N1).
  if (data?.fromRow === undefined) return routeOrthogonal(ab, bb, data?.axis ? { axis: data.axis } : {}).mid;
  return rowRoute(ab, bb, data.fromRow, data.toRow ?? -1, e.source === e.target, scroll(e.source), scroll(e.target), data.textScale).mid;
}

const centre = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const NO_STATES: ReadonlyMap<string, NodeState> = new Map();
/**
 * A selected live shape's z: above every level the live band uses (2,000 to 2,028), under the sketches.
 * Manual z mode drops React Flow's own lift, so it is kept here, inside the live frame's band.
 */
const LIVE_LIFT = Z_LIVE + 29;
// The live anchor draws nothing, as the sketch layer does.
const BOARD_NODE_TYPES: NodeTypes = { ...FLOW_NODE_TYPES, boardFrame: FrameNode, [FRAME_PICTURE_TYPE]: FramePicture, [SKETCH_PICTURE_TYPE]: SketchLayerPicture, ...SKETCH_NODE_TYPES, [LIVE_ANCHOR_TYPE]: SketchLayerNode };
/** A flow let go this close to its own node was a click on a port, not a drawn flow. */
const RELEASE_ON_SELF_PX = 12;
/** A press with a shape tool that moves further than this, in screen pixels, sizes the shape. */
const DRAW_DRAG_PX = 4;
/** The generic tools that draw a frame's own shape when started inside a frame. */
const GENERIC_BOXES: ReadonlySet<string> = new Set(["rect", "ellipse", "diamond"]);

/** Each group's depth, 0 at the top, for `groupAt`. */
function groupDepths(groups: FlowDoc["groups"], depth = 0, out = new Map<string, number>()): Map<string, number> {
  for (const g of groups) {
    out.set(g.name, depth);
    groupDepths(g.groups, depth + 1, out);
  }
  return out;
}

/** The group that holds `name` directly, or null. */
function parentOf(groups: FlowDoc["groups"], name: string): string | null {
  const stack = [...groups];
  while (stack.length) {
    const g = stack.pop()!;
    if (g.nodes.includes(name)) return g.name;
    stack.push(...g.groups);
  }
  return null;
}

/** Every node and group name, so a new node's name is free. */
/** The groups `moved` leave with nothing in them: every shape and group they held is in `moved`. */
function emptiedBy(doc: FlowDoc | null | undefined, moved: readonly string[], into: string | null): string[] {
  if (!doc) return [];
  const gone = new Set(moved);
  // The new group goes inside `into`: it and the groups around it are never empty.
  for (let g: string | null = into; g; g = parentOf(doc.groups, g)) gone.add(g);
  const out: string[] = [];
  const stack = [...doc.groups];
  for (let g = stack.pop(); g; g = stack.pop()) {
    stack.push(...g.groups);
    if (gone.has(g.name) || g.nodes.length + g.groups.length === 0) continue;
    if (g.nodes.every((n) => gone.has(n)) && g.groups.every((c) => gone.has(c.name))) out.push(g.name);
  }
  return out;
}

/** The group `name` at any depth, or null. */
function findGroup(groups: FlowDoc["groups"], name: string): FlowDoc["groups"][number] | null {
  const stack = [...groups];
  for (let g = stack.pop(); g; g = stack.pop()) {
    if (g.name === name) return g;
    stack.push(...g.groups);
  }
  return null;
}

function namesOf(doc: FlowDoc): Set<string> {
  const out = new Set(doc.nodes.map((n) => n.name));
  const stack = [...doc.groups];
  while (stack.length) {
    const g = stack.pop()!;
    out.add(g.name);
    stack.push(...g.groups);
  }
  return out;
}

/** `base` when free, else `base 2`, `base 3` (as the worker names a quick add). */
function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A drag in progress: the node under the pointer, what it lines up with, and the groups it can join. */
interface DragInfo {
  lead: string;
  size: { w: number; h: number };
  moving: Set<string>;
  others: { id: string; box: Box }[];
  groups: { name: string; box: Box; depth: number }[];
  parent: string | null;
}

/** Diagram steps 3 and 6: what the field over the canvas edits. */
type FieldEdit = (
  | { kind: "label"; node: string }
  | { kind: "group"; name: string }
  | { kind: "newgroup"; members: string[]; parent: string | null; name: string; word: string; subgroups?: string[] }
  /** A new shape drawn as a ghost with its name ready, written only when the name is kept. */
  | {
      kind: "new";
      node: FlowNodeKind;
      at: Point;
      size: { w: number; h: number };
      name: string;
      from?: string;
      group?: string | null;
      before?: string;
      date?: string;
      until?: string;
      under?: string;
      /** A mind map topic beside this one (Shift+Tab), after its branch. */
      after?: string;
      /** A + add: the axis its line keeps, and the guide drawn while the ghost lines up with its source. */
      axis?: "v" | "h";
      /** Drawn by a drag: `size` is kept in the layout with its line. */
      sized?: boolean;
      guide?: { x1: number; y1: number; x2: number; y2: number };
    }
  /** A sequence's loop around messages `from` to `to`, and a timeline's section around items. */
  | { kind: "newloop"; from: number; to: number; name: string; at: Point }
  /** A loop's label, edited on its tab; the frame is named by its index and the label it had. */
  | { kind: "loop"; index: number; was: string; name: string; at: Point }
  | { kind: "newsection"; members: string[]; name: string; at: Point }
) & { open?: number };

/** Step 6, F18: a Shapes item waiting for the shape it works on (draw.io's connect mode, Visio's). */
type ShapePick =
  | { what: "line"; arrow: FlowArrow; from: string | null; label: string }
  | { what: "marker"; end: "start" | "end" }
  | { what: "member" }
  | { what: "sub" }
  | { what: "act" }
  /** Step 8 (S1): a message's first lifeline and the row it goes in, then the lifeline it goes to. */
  | { what: "message"; from: string | null; slot: number };

/** A group title's band: its height, and its width (left inset, icon, the name in the small font, padding). */
const TITLE_BAND = 30;
/**
 * Where a + tip goes (round 2, N-A): out past the + on its own side, so it grows away from the shape and never
 * covers it or the + (above a + above the shape, below a + below, right of a + on the right, left of one on the left).
 */
const TIP_PLACE: Record<Side, (p: Point) => { left: string; top: string; transform: string }> = {
  t: (p) => ({ left: `${p.x}px`, top: `${p.y - 14}px`, transform: "translate(-50%, -100%)" }),
  b: (p) => ({ left: `${p.x}px`, top: `${p.y + 14}px`, transform: "translate(-50%, 0%)" }),
  r: (p) => ({ left: `${p.x + 14}px`, top: `${p.y}px`, transform: "translate(0%, -50%)" }),
  l: (p) => ({ left: `${p.x - 14}px`, top: `${p.y}px`, transform: "translate(-100%, -50%)" }),
};

/** The + tip waits as long as a native tooltip does. */
const PLUS_TIP_MS = 500;
const titleWidth = (name: string, groupW: number) => Math.min(groupW, 12 + 22 + Math.ceil(name.length * 7.2) + 12);

/** The kinds a + adds the next shape in (board DiagramAddNext): the freely placed ones with lines. */
const PLUS_KINDS: ReadonlySet<DiagramKind> = new Set(["flow", "dfd", "state", "cloud"]);
const SIDE_WORD: Record<Side, string> = { t: "above", r: "to the right", b: "below", l: "to the left" };
const SIDES: readonly Side[] = ["t", "r", "b", "l"];
/** The name a new shape of each kind starts with. */
const BASE_NAME: Partial<Record<FlowNodeKind, string>> = { start: "Start", end: "End", subprocess: "Subprocess", document: "Document", database: "Database", root: "Central idea", note: "Note" };
const isoPlusDays = (d: string, days: number) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(t) ? d : new Date(t + days * 86400000).toISOString().slice(0, 10);
};

/** The label box: the link it names by index in the text of parse `version` (the box closes on a newer parse). */
interface LabelBoxState {
  index: number;
  version: number;
  from: string;
  to: string;
  /** The label it had; a new flow has none. */
  initial: string;
  fresh: boolean;
  /** The new flow's text line, banded while the box is open. */
  line?: number;
  /** The frame identity it was opened on: its label lands there or nowhere (`RunOptions.frame`). */
  frame?: number;
  /**
   * An ER relationship's line by its ends, columns and label (R9): the label lands on that line even after the text
   * changed, and a line gone from the text keeps the field open with the reason.
   */
  link?: LinkRef;
}

// ----- the text pane

/** The lines of the selected nodes; each gets a band. Kept as positions, so typing moves them with the text. */
const setBand = StateEffect.define<number[]>();
const bandLine = Decoration.line({ class: "cm-flow-band" });
const bandField = StateField.define<number[]>({
  create: () => [],
  update: (at, tr) => {
    const set = tr.effects.find((e) => e.is(setBand));
    if (set) return set.value;
    return tr.docChanged ? at.map((p) => tr.changes.mapPos(p, -1)) : at;
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const starts = [...new Set(state.field(f).map((p) => state.doc.lineAt(Math.min(p, state.doc.length)).from))].sort((a, b) => a - b);
      return Decoration.set(starts.map((p) => bandLine.range(p)));
    }),
});

/** A hovered fix, shown in grey where it would go: its new text, and the text it replaces struck. */
const setGhost = StateEffect.define<TextEdit[]>();
class GhostText extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostText) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-flow-ghost";
    span.textContent = this.text;
    return span;
  }
}
const ghostOld = Decoration.mark({ class: "cm-flow-ghost-old" });
const ghostField = StateField.define<TextEdit[]>({
  create: () => [],
  update: (edits, tr) => {
    const set = tr.effects.find((e) => e.is(setGhost));
    if (set) return set.value;
    return tr.docChanged ? [] : edits;
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const len = state.doc.length;
      const ranges = [];
      for (const e of [...state.field(f)].sort((a, b) => a.from - b.from)) {
        const from = Math.min(e.from, len);
        const to = Math.min(Math.max(e.to, from), len);
        if (to > from) ranges.push(ghostOld.range(from, to));
        if (e.insert) ranges.push(Decoration.widget({ widget: new GhostText(e.insert), side: 1 }).range(to));
      }
      return Decoration.set(ranges, true);
    }),
});

const ARROW = /<>|-->|\.\.>|>|\s-\s/g;
const unquote = (s: string) => {
  const t = s.trim();
  return t.length > 1 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};

/** The plain sentence under "X is not defined.", read from the link's line. */
export function explainProblem(p: FlowProblem, text: string): string | null {
  if (!p.message.endsWith(" is not defined.")) return null;
  const start = text.lastIndexOf("\n", p.from - 1) + 1;
  let end = text.indexOf("\n", p.from);
  if (end < 0) end = text.length;
  const line = text.slice(start, end).replace(/\r$/, "");
  const before = line.slice(0, p.from - start);
  const arrows = [...before.matchAll(ARROW)];
  if (arrows.length > 0) {
    const last = arrows[arrows.length - 1];
    const prev = arrows.length > 1 ? arrows[arrows.length - 2] : null;
    const from = unquote(before.slice(prev ? prev.index! + prev[0].length : 0, last.index));
    if (from) return `${from} sends a flow to a name that has no node, so that flow is left off the drawing.`;
    return null;
  }
  const after = line.slice(p.to - start);
  const next = [...after.matchAll(ARROW)];
  if (next.length === 0) return null;
  const rest = after.slice(next[0].index! + next[0][0].length);
  const stop = rest.search(/<>|-->|\.\.>|>|\s-\s|:/);
  const to = unquote(stop < 0 ? rest : rest.slice(0, stop));
  return to ? `A flow to ${to} comes from a name that has no node, so that flow is left off the drawing.` : null;
}

/** What to type on the empty flow's first free line, per diagram kind. */
const FIRST_LINE: Record<DiagramKind, string> = {
  dfd: "Customer [entity]",
  flow: "Request in [start]",
  cloud: "Users [icon: users]",
  er: "orders {",
  sequence: "participant App",
  state: "[*] > Draft",
  class: "class Invoice",
  mindmap: "root Q4 plan",
  timeline: "2026-10-19: Release",
};

function toCm(problems: FlowProblem[], length: number, applyFix: (edits: FlowProblem["fixes"][number]["edits"]) => void): CmDiagnostic[] {
  return problems.map((p) => ({
    from: Math.min(p.from, length),
    to: Math.min(Math.max(p.to, p.from), length),
    severity: p.severity === "hint" ? "info" : "error",
    message: p.message,
    actions: p.fixes.map((f) => ({ name: f.title, apply: () => applyFix(f.edits) })),
  }));
}

/** Each document's frame headers, read once per document and shared with `useFlowDoc`'s keys (the pane asks several times per keystroke). */
function headsOf(state: EditorState): ReturnType<typeof frameHeaders> {
  return frameHeadsOf(state.doc);
}

/** The selected frame's index in `state`'s text: by index while its title still matches, else by title; 0 with none. */
function shownIndexIn(state: EditorState, sel: FrameSelection | null): number {
  if (!sel) return 0;
  const heads = headsOf(state);
  if (heads[sel.index]?.title === sel.title) return sel.index;
  const i = heads.findIndex((h) => h.title === sel.title);
  return i < 0 ? Math.min(sel.index, heads.length - 1) : i;
}

/**
 * Frame `index`'s block as the pane shows it: from its start to the end of the line before the next
 * frame, so blank lines under a frame are its own and a line typed at its end stays in it; `line` is its first line.
 */
function frameBlock(state: EditorState, index: number): { from: number; to: number; line: number } {
  const heads = headsOf(state);
  const i = Math.max(0, Math.min(index, heads.length - 1));
  const from = heads[i]?.from ?? 0;
  const to = i + 1 < heads.length ? heads[i + 1].from - 1 : state.doc.length;
  return { from, to: Math.max(from, to), line: state.doc.lineAt(from).number };
}

/** The frame holding `pos`: its index and title among the frames read (null past the last one read). */
function frameAtPos(state: EditorState, pos: number): FrameSelection | null {
  const heads = headsOf(state);
  let i = 0;
  while (i + 1 < heads.length && heads[i + 1].from <= pos) i++;
  return i < MAX_BOARD_FRAMES ? { title: heads[i].title, index: i } : null;
}

/** Shows frame `index`'s block in the pane, unless it shows already. Never call it inside an update. */
function showBlock(view: EditorView, index: number) {
  const b = frameBlock(view.state, index);
  const cur = shownRange(view.state);
  if (cur && cur.from === b.from && cur.to === b.to && cur.line === b.line) return;
  view.dispatch({ effects: showFrame.of(b) });
}

/** Why an edit that reaches a frame the pane hides was not made. */
const HIDDEN_EDIT = "That edit reaches another diagram on this board, so it was not made. Edit that diagram with it shown.";

/** What the pane's frame-following asks the tab. */
interface PaneFollow {
  /** The selected frame's index in the text now; 0 with nothing selected. */
  shownIndex(state: EditorState): number;
  /**
   * The pane wants frame `to` shown and selected: a header typed in the shown frame, a jump into a hidden frame, or an
   * undo there. False when the switch is refused (the Assistant holds the text).
   */
  switchTo(to: FrameSelection, why: "typed" | "reveal"): boolean;
}

interface EditorProps {
  initialText: string;
  doc: ReturnType<typeof useFlowDoc>;
  client: LangClient;
  bandLines: number[];
  /** A hovered fix's edits, shown in grey; null for none. */
  ghost: { edits: TextEdit[]; text: string } | null;
  onLineClick(line: number): void;
  /** `icon:` was just typed inside brackets, ending at `pos` (the cloud picker opens there). */
  onIconSlot?(pos: number): void;
  /** An undo or redo ran in the text's history. */
  onHistory?(): void;
  /** Mermaid pasted where you are typing, from `from` to `to`; the tab translates it. */
  onMermaidPaste?(text: string, from: number, to: number): void;
  /** The selected frame, which the pane shows (frame 0 with none). */
  frame: FrameSelection | null;
  /** An edit reached a hidden frame and was not made (a Replace all, a Delete at the block's edge). */
  onDropped?(): void;
  follow: PaneFollow;
}

const typedTr = (tr: Transaction) =>
  tr.docChanged && !tr.annotation(canvasEdit) && (tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"));
const historyTr = (tr: Transaction) => tr.isUserEvent("undo") || tr.isUserEvent("redo");

/** True when the line up to `pos` ends with `icon:` (the colon just typed) inside an open bracket list. */
export function atIconSlot(text: string, pos: number): boolean {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(start, pos);
  return /(?:\[|,)\s*icon:$/.test(before) && before.lastIndexOf("[") > before.lastIndexOf("]");
}

function FlowEditor({ initialText, doc, client, bandLines, ghost, onLineClick, onIconSlot, onHistory, onMermaidPaste, frame, follow, onDropped }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ onLineClick, onIconSlot, onHistory, onMermaidPaste, follow, onDropped });
  latest.current = { onLineClick, onIconSlot, onHistory, onMermaidPaste, follow, onDropped };
  /** A frame typing went into, switched to by the next `resync`; the selection effect waits for it. */
  const typedTo = useRef<FrameSelection | null>(null);

  /**
   * After a text change, the pane shows exactly one frame's block again: the frame holding where you are after typing
   * or an undo (a header typed in the middle of the shown frame splits it, Review Focus 2), else the selected frame.
   * Scheduled: it dispatches, so it never runs inside an update (frameView's contract).
   */
  const resync = (view: EditorView, byCursor: boolean) =>
    queueMicrotask(() => {
      typedTo.current = null;
      if (viewRef.current !== view) return;
      const f = latest.current.follow;
      let index = f.shownIndex(view.state);
      if (byCursor) {
        const at = frameAtPos(view.state, view.state.selection.main.head);
        if (at && at.index !== index && f.switchTo(at, "typed")) index = at.index;
      }
      showBlock(view, index);
    });
  /** A jump or an undo into a hidden frame: that frame is selected and shown, unless the switch is refused. */
  const reveal = (view: EditorView, pos: number, why: "reveal") =>
    queueMicrotask(() => {
      if (viewRef.current !== view) return;
      const f = latest.current.follow;
      const at = frameAtPos(view.state, Math.min(pos, view.state.doc.length));
      if (at && at.index !== f.shownIndex(view.state) && f.switchTo(at, why)) return showBlock(view, at.index);
      // Refused or not a frame: the pane keeps its frame, and where you are goes back into it.
      const shown = shownRange(view.state);
      showBlock(view, f.shownIndex(view.state));
      const head = view.state.selection.main.head;
      const now = shownRange(view.state) ?? shown;
      if (now && (head < now.from || head > now.to)) view.dispatch({ selection: { anchor: now.from } });
    });

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          // The shown frame's block only, numbered from its header; it replaces the plain gutter.
          frameView(
            (pos) => {
              const v = viewRef.current;
              if (v) reveal(v, pos, "reveal");
            },
            () => latest.current.onDropped?.(),
          ),
          insertionLine(),
          editorTheme(),
          bandField,
          ghostField,
          lintGutter(),
          doc.extensions,
          flowLanguageWith(client, doc.docId),
          editingBasics(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ "aria-label": "Diagram text" }),
          // Step 10 (user decision, 25 Oct): Mermaid pasted here is translated by the importer; other text pastes as is.
          EditorView.domEventHandlers({
            paste(e, v) {
              const text = e.clipboardData?.getData("text/plain") ?? "";
              const take = latest.current.onMermaidPaste;
              if (!take || v.state.readOnly || !isMermaid(text)) return false;
              e.preventDefault();
              const sel = v.state.selection.main;
              take(text, sel.from, sel.to);
              return true;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const typed = u.transactions.some(typedTr);
              const history = u.transactions.some(historyTr);
              // Typing into another frame (a header typed mid-frame, Review Focus 2) switches in the microtask, never in
              // this update (frameView's contract); until then the canvas's selection does not move the pane.
              if (typed) perfMark("keystroke");
              if (typed) {
                const at = frameAtPos(u.state, u.state.selection.main.head);
                if (at && at.index !== latest.current.follow.shownIndex(u.state)) typedTo.current = at;
              }
              resync(u.view, typed || history);
            }
            if (u.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"))) latest.current.onHistory?.();
            if (u.selectionSet && !u.docChanged && u.transactions.some((tr) => tr.isUserEvent("select.pointer"))) {
              latest.current.onLineClick(u.state.doc.lineAt(u.state.selection.main.head).number);
            }
            // Typing `icon:` inside brackets opens the icon grid there ("after icon:").
            const slot = latest.current.onIconSlot;
            if (slot && u.docChanged && u.transactions.some((tr) => tr.isUserEvent("input.type"))) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              if (atIconSlot(line.text, head - line.from)) slot(head);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    doc.attach(view);
    showBlock(view, latest.current.follow.shownIndex(view.state));
    return () => {
      doc.attach(null);
      viewRef.current = null;
      view.destroy();
    };
    // The view is made once per open document; later changes are pushed in below.
  }, []);

  // The selected frame is the one shown (frame 0 with none): a switch from the canvas shows its block.
  const frameIndex = frame?.index ?? -1;
  const frameTitle = frame?.title;
  // The canvas paints first: the pane swaps its text in the frame after that paint. A switch meanwhile
  // cancels this one and schedules its own, so the pane settles on the frame selected last.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    return afterPaint(() => {
      if (viewRef.current === view && !typedTo.current) showBlock(view, latest.current.follow.shownIndex(view.state));
    });
  }, [frameIndex, frameTitle]);

  // Problems underline the text once their parse is for the text shown.
  // Once a parse: `doc` is a new object on every render (a frame switch is one), and each dispatch lays out the page.
  const parsed = doc.parsed;
  // A keystroke in the code pane ends at the canvas paint after its parse lands (the opt-in recorder; the mark is spent once).
  useEffect(() => {
    if (parsed && perfOn()) requestAnimationFrame(() => perfMeasure("keystroke_to_canvas", "keystroke"));
  }, [parsed]);
  const applyFix = useRef(doc.applyFix);
  applyFix.current = doc.applyFix;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !parsed || parsed.text !== view.state.doc.toString()) return;
    const diagnostics = toCm(parsed.result.problems, view.state.doc.length, (edits) => applyFix.current(edits, parsed.text));
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [parsed]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const at = bandLines.filter((n) => n >= 1 && n <= view.state.doc.lines).map((n) => view.state.doc.line(n).from);
    // The same bands make no update: a dispatch reads the page's selection, which lays out the whole page at once,
    // canvas and all (42 ms of a frame switch at the limit).
    const was = view.state.field(bandField);
    if (was.length === at.length && was.every((p, i) => p === at[i])) return;
    view.dispatch({ effects: setBand.of(at) });
  }, [bandLines]);

  // A fix's preview only while its parse is for the text shown, so its offsets are right.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // No preview shown and none to show: no update (as for the bands).
    if (!ghost && view.state.field(ghostField).length === 0) return;
    const edits = ghost && ghost.text === view.state.doc.toString() ? ghost.edits : [];
    view.dispatch({ effects: setGhost.of(edits) });
  }, [ghost]);

  return <div ref={host} className="flow-editor" />;
}

/**
 * The shown frame's problems, each naming its line counted from the frame's header:
 * `firstLine` is the header's line in the file.
 */
function Problems({
  parsed,
  problems,
  firstLine,
  onFix,
  onLine,
  onHoverFix,
}: {
  parsed: Parsed;
  problems: FlowProblem[];
  firstLine: number;
  onFix(p: FlowProblem, i: number): void;
  /** A frame-relative line. */
  onLine(line: number): void;
  onHoverFix(p: FlowProblem | null, i: number): void;
}) {
  const shown = problems.slice(0, 20);
  if (shown.length === 0) return null;
  return (
    <div className="flow-problems" role="region" aria-label="Problems">
      {shown.map((p, i) => (
        <div key={`${p.line}:${p.from}:${i}`} className={p.severity === "hint" ? "flow-problem is-hint" : "flow-problem"}>
          <div className="flow-problem-head">
            <Icon name={p.severity === "hint" ? "info" : "alert"} size={14} />
            <strong>{p.message}</strong>
            <button type="button" className="flow-line-chip" onClick={() => onLine(p.line - firstLine + 1)}>
              Line {p.line - firstLine + 1}
            </button>
          </div>
          {(() => {
            const why = explainProblem(p, parsed.text);
            return why ? <p className="flow-problem-why">{why}</p> : null;
          })()}
          {p.fixes.length > 0 && (
            <div className="flow-fixes">
              {p.fixes.map((f, j) => (
                <button
                  key={`${f.title}:${j}`}
                  type="button"
                  className="flow-fix"
                  onClick={() => onFix(p, j)}
                  onMouseEnter={() => onHoverFix(p, j)}
                  onMouseLeave={() => onHoverFix(null, j)}
                  onFocus={() => onHoverFix(p, j)}
                  onBlur={() => onHoverFix(null, j)}
                >
                  {f.title}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ----- the tab

/** The same frame: by index and title, null only with null. */
function sameFrame(a: FrameSelection | null, b: FrameSelection | null): boolean {
  return a === b || (!!a && !!b && a.index === b.index && a.title === b.title);
}

/** A key pressed on the canvas while a switch waits, kept to be pressed again on the frame picked. */
interface HeldKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}

/** Keys held while a switch waits; more are dropped. */
const HELD_KEYS_MAX = 8;
/** The longest a replayed key waits for the one before it to land, a paste's clipboard read included. */
const KEY_SETTLE_MS = 4_000;

/** A printable key typed into an open field as the field would take it: over its selected text. */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, ch: string) {
  const from = el.selectionStart ?? el.value.length;
  const to = el.selectionEnd ?? from;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // React tracks the value it set: the native setter makes the input event a change it sees.
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, el.value.slice(0, from) + ch + el.value.slice(to));
  el.setSelectionRange(from + ch.length, from + ch.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

interface Props {
  /** The diagram's name: `<name>.flow` in Contura's diagrams folder. */
  name: string;
  /** The language engine; the app's shared one when absent. */
  client?: LangClient;
  /** The tab is on top of the window; false while another tab, such as Settings, is. */
  active?: boolean;
  /** Opens the AI settings at the tools table, from the assistant's tool-off note. */
  onOpenSettings?(): void;
  /** The canvas's Mermaid... button opens the Mermaid dialog, with Insert into this diagram. */
  onMermaid?(insert: MermaidInsert): void;
  /** ADR 0030: an old ER diagram's "Open as DBML": the converted DBML, unsaved, in the Schema Builder. */
  onOpenModel?(name: string, dbml: string): void;
  /** B2 Task 10: the Shelf's "From my database" opens its dialog, with Add into this board. */
  onFromDatabase?(add: DatabaseAdd): void;
  /** B2 Task 9: the Shelf's "From Mermaid" opens the Mermaid dialog in add mode, with Add into this board. */
  onMermaidFrame?(add: MermaidAdd): void;
}

/** B2 Task 9: what the Mermaid dialog's add mode adds into: this board's file, and the add itself. */
export interface MermaidAdd {
  file: string;
  /** Adds the converted flow as a new frame in the middle of the view, in one undo; why it was refused, or null once added. */
  run(flow: string, direction: FlowDirection): Promise<string | null>;
}

/** B2 Task 10: what the From my database dialog adds into: this board's file, and the add itself. */
export interface DatabaseAdd {
  file: string;
  /**
   * Adds the schema as an ER frame in the middle of the view, in one undo; why it was refused, or null once added.
   * `source` is the Connection it was read from: the frame's layout entry keeps it, so the diagram Ask is gated there.
   */
  run(frame: ErFromModel, source: FrameSource): Promise<string | null>;
}

/** Step 10 (F28): what the Mermaid dialog inserts into: this diagram's kind and file, and the insert itself. */
export interface MermaidInsert {
  kind: DiagramKind;
  file: string;
  /** Writes the converted .flow text in, as one undo step, the new shapes selected; why it was refused, or null. */
  run(flow: string): Promise<string | null>;
}

const TEXT_SIZES: readonly TextSize[] = ["s", "m", "l"];
const NO_SIZES: ReadonlySet<TextSize> = new Set();

function sameFormMap<T>(a: ReadonlyMap<number, T>, b: ReadonlyMap<number, T>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
/** The same frames at the same places. */
function sameBoxes(a: readonly FrameBox[], b: readonly FrameBox[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (p.index !== q.index || p.x !== q.x || p.y !== q.y || p.w !== q.w || p.h !== q.h) return false;
  }
  return true;
}
function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/** The same drawn forms: every frame's form and every count mounted so far. */
const sameForms = (a: DrawnForms, b: DrawnForms) => sameFormMap(a.form, b.form) && sameFormMap(a.mounted, b.mounted);

export default function FlowTab({ name, client: given, active = true, onOpenSettings, onMermaid, onOpenModel, onFromDatabase, onMermaidFrame }: Props) {
  const client = given ?? appLang().client;
  const doc = useFlowDoc(name, client);
  // The pane's tab is the user's (kept in the prefs); open or closed is this tab's own.
  const [sideTab, setSideTab] = useFlowSidePanel();
  const [paneShown, setPaneShown] = useFlowPaneOpen(name);
  const side = { tab: sideTab, hidden: !paneShown };
  // Opening the pane glides the canvas that is left to fit the selected frame (the mockup's glide).
  const paneWas = useRef(paneShown);
  useEffect(() => {
    const opened = paneShown && !paneWas.current;
    paneWas.current = paneShown;
    if (!opened) return;
    const id = requestAnimationFrame(() => {
      const box = liveBoxRef.current;
      if (box) latestActs.current.fitFrame(box);
    });
    return () => cancelAnimationFrame(id);
    // liveBoxRef and latestActs are declared below; they are read when the frame runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneShown]);
  /** Shows or hides the pane and picks its tab; hiding hands focus to the canvas, as the pane leaves no rail. */
  const setSide = (p: { hidden?: boolean; tab?: "editor" | "assistant" }) => {
    if (p.tab !== undefined) setSideTab(p.tab);
    if (p.hidden === undefined) return;
    if (p.hidden && document.activeElement instanceof HTMLElement && document.activeElement.closest(".flow-side")) canvasEl.current?.focus({ preventScroll: true });
    setPaneShown(!p.hidden);
  };
  const [assistMode, setAssistMode] = useFlowAssistMode();
  /** What the board Ask reads from the canvas when it sends; set each render below, once the board scene is built. */
  const readBoard = useRef<BoardCanvasApi["input"]>(() => Promise.reject(new Error("The board is not drawn yet.")));
  /** The middle of the view in board coordinates, where the assistant's new frames go (as the Shelf adds them); set below. */
  const viewMiddleRef = useRef<() => Point>(() => ({ x: 0, y: 0 }));
  /** Fits the view to frames by layout key and to board rectangles of frames not drawn yet; set each render below. */
  const glideKeysRef = useRef<BoardCanvasApi["glideTo"]>(() => {});
  const canvasApi = useMemo<BoardCanvasApi>(
    () => ({
      input: () => readBoard.current(),
      centre: () => viewMiddleRef.current(),
      glideTo: (keys, extra) => glideKeysRef.current(keys, extra),
      ring: (parts) => ringRef.current(parts),
    }),
    [],
  );
  /** The parts an answer named, ringing for `AIRING_MS`: by frame layout key, a column as `columnRing`. */
  const [ringed, setRinged] = useState<Airing>(NO_RING);
  const ringTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(ringTimer.current), []);
  /** Rings the parts of the frames on screen; set each render below, once the view can be read. */
  const ringRef = useRef<BoardCanvasApi["ring"]>(() => {});
  // The diagram assistant: while its Ask runs or its changes wait, the text is read-only and the canvas takes no edits.
  const ai = useBoardAsk(name, doc, assistMode, canvasApi);
  const aiLock = useRef(false);
  aiLock.current = ai.locked;
  /** The identity of the frame the Assistant's run belongs to, from Ask to the end of its changes; null when none. */
  const aiFrame = useRef<number | null>(null);
  aiFrame.current = ai.heldFrame;
  /** Lines "Show in the text" bands for the assistant's changes; a new Ask, a landing, Reject all and undo clear them. */
  const [aiBands, setAiBands] = useState<number[]>([]);
  const aiAsking = ai.working !== null;
  const aiWaits = ai.waiting !== null;
  useEffect(() => setAiBands([]), [aiAsking, aiWaits, ai.landed]);
  const { parsed, layout } = doc;
  const drawn = parsed?.drawn ?? null;
  // A board with no frame selected has no live frame, so no kind's tools: the drawing tools show. A
  // one-frame board opens with its frame selected and lets it go as a board of several does (owner ruling, F2).
  const frameSel = doc.selected;
  const idleBoard = !!parsed && parsed.frame === null && (parsed.result.frames.length > 1 || (frameSel === null && parsed.result.frames.length === 1));
  const kind: DiagramKind | null = idleBoard ? null : (parsed?.result.kind ?? drawn?.kind ?? (doc.initialText !== null ? kindOfText(doc.initialText) : null));
  /** The kind of the frame the code pane shows: its header, chips and Syntax Help. */
  const paneKind: DiagramKind | null = parsed ? (parsed.result.frames[parsed.frame?.index ?? 0]?.kind ?? null) : kind;
  const look = layout.style;
  // The selected frame's own settings that FlowLayout does not carry: its text size and ER notation.
  const selFrameKey = frameSel ? doc.keys[frameSel.index] : undefined;
  const docKeys = useRef(doc.keys);
  docKeys.current = doc.keys;
  const selEntry = selFrameKey !== undefined ? doc.board.frames.get(selFrameKey) : undefined;
  const textSize = selEntry?.textSize ?? "m";
  const notation = selEntry?.notation ?? "crow";
  const textScale = TEXT_SCALE[textSize];
  const stale = !!parsed && parsed.result.doc === null && drawn !== null;
  const staleRef = useRef(stale);
  staleRef.current = stale;

  const [selected, setSelected] = useState<string[]>([]);
  /** The selected loose sketches by sketch id: board-wide, so a frame switch keeps them. */
  const [sketchSel, setSketchSel] = useState<string[]>([]);
  const sketchSelRef = useRef(sketchSel);
  sketchSelRef.current = sketchSel;
  /** Sketches let go by a drag, by sketch id, until the move is kept (with the shapes of the same drag). */
  const pendingSketchMove = useRef(new Map<string, { x: number; y: number }>());
  /** Each frame of a sketch drag, and the changes a drag's release keeps; set each render (they read the latest board). */
  const sketchDraggedRef = useRef<(id: string, x: number, y: number) => void>(() => {});
  const takeSketchMovesRef = useRef<(copies: boolean) => SketchChange[]>(() => []);
  /** Where sketches are drawn while a Section drag or a nudge runs (React Flow's own drag draws the dragged ones). */
  const [sketchLive, setSketchLive] = useState<LivePositions | null>(null);
  /**
   * Step 9 (F9): the group selected by a click on its title (Miro and Figma frames), and Delete's question about it.
   * A shape or a line picked lets it go.
   */
  const [groupSel, setGroupSelState] = useState<string | null>(null);
  const groupSelRef = useRef<string | null>(null);
  const setGroupSel = (g: string | null) => {
    groupSelRef.current = g;
    setGroupSelState(g);
  };
  const [groupAsk, setGroupAsk] = useState<string | null>(null);
  /** The last press on a group's title, so a second one soon after on the same title renames it. */
  const lastTitle = useRef<{ name: string; at: number } | null>(null);
  /** The selected lines, by edge id (F1); a new drawing lets them go, as their indexes may name other links. */
  const [lines, setLines] = useState<string[]>([]);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const [bandLines, setBandLines] = useState<number[]>([]);
  /**
   * Diagram step 3: the field drawn over a shape (F3), a group's title, or a new group's title. Its error is why
   * the last try was refused; the field stays open with the typed text.
   */
  const [field, setFieldState] = useState<(FieldEdit & { error?: string; tries?: number }) | null>(null);
  const fieldRef = useRef(field);
  const setField = (f: typeof field) => {
    fieldRef.current = f;
    setFieldState(f);
  };
  /** Opens a field afresh: its own number keys it, so a field replacing another of its kind remounts. */
  const openField = (f: FieldEdit) => setField({ ...f, open: ++fieldSeq.current });
  /** Item 22: the node whose name and details are being edited, and where its panel sits. */
  const [editingNode, setEditingNode] = useState<{ name: string; at: { left: number; top: number }; problem: string | null } | null>(null);
  /** Item 23: a double-click on empty canvas offers the kind's shapes there. */
  const [paneAdd, setPaneAdd] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null);
  /** The canvas's right-click menu (item 20), at the pointer. */
  const [menu, setMenu] = useState<PlacedMenuState | null>(null);
  /** Why the last canvas action did nothing, in the strip; cleared by the next action. */
  const [notice, setNoticeState] = useState<string | null>(null);
  /**
   * The text a notice about a written action was said about (fix rounds 3 and 4): once the text changes from it (an
   * undo, a redo, typing), that notice goes, so "Linked ...", "Added ..." or "Deleted ..." never outlive what they
   * say. Refusals, the lock and paste notes are not tied to the text and stay until the next canvas action (N2).
   * The editor's own document object is kept, never a copy.
   */
  const noticeDoc = useRef<unknown>(null);
  const viewOf = useRef<() => { state: { doc: unknown } } | null>(() => null);
  const setNotice = useCallback((text: string | null, written = false) => {
    noticeDoc.current = text !== null && written ? (viewOf.current()?.state.doc ?? null) : null;
    setNoticeState(text);
  }, []);
  const [ghost, setGhost] = useState<{ edits: TextEdit[]; text: string } | null>(null);
  /** The icon picker, open for one service, placed on the window under the strip. */
  const [picker, setPicker] = useState<{
    /** A service on the canvas, or a spot in the text just after `icon:`. */
    target: { node: string } | { pos: number };
    initial: string;
    at: { left: number; top: number };
  } | null>(null);
  const [credits, setCredits] = useState(false);
  /** Syntax Help open on this kind: the shown frame's when `<?>` was pressed. */
  const [helpKind, setHelpKind] = useState<DiagramKind | null>(null);
  /**
   * The Publish dialog: a board's source (with the input it was built from and the source made for each theme so far,
   * so a theme toggled back is the same source and draws nothing again), or one diagram's scene (with what a theme
   * change rebuilds it from). Closing it sets this to null, so every source and scene goes with it.
   */
  const [publishing, setPublishing] = useState<
    | { source: PublishSource; input: BoardPublishInput; part?: BoardPart; byTheme: Partial<Record<ExportTheme, PublishSource>> }
    | { scene: Scene; onScreen: SceneBox; names: string[]; build(icons: Awaited<ReturnType<typeof loadSceneIcons>>): Scene }
    | null
  >(null);
  const publishingRef = useRef(publishing);
  publishingRef.current = publishing;
  const chooseIcon = useRef<HTMLButtonElement>(null);
  const instance = useRef<ReactFlowInstance | null>(null);
  const canvasEl = useRef<HTMLDivElement>(null);
  /** The canvas's fit, Shift+1's: the menus' "Zoom to fit" is the same fit. */
  const canvasFit = useRef<() => boolean>(() => false);
  /** This tab's drawing pane: the keyboard pick's keys come from inside it only (N1). */
  const paneEl = useRef<HTMLElement>(null);
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;
  /** Refuses the open field's value: it stays open with the typed text and says why. */
  const refuseField = (e: NonNullable<typeof field>, error: string) => {
    if (fieldRef.current !== e) return;
    setField({ ...e, error, tries: (e.tries ?? 0) + 1 });
  };
  /** CL1 and T1: the member row or date field open on a card, in a store the cards read by name. */
  const kindEdits = useMemo(() => createKindEditStore(), []);
  const [kindEdit, setKindEditState] = useState<KindEdit | null>(null);
  const setKindEdit = (e: KindEdit | null) => {
    kindEdits.set(e);
    setKindEditState(e);
  };
  /**
   * CL1: the picked member, drawn picked on its card, which Ctrl+Enter copies and Delete removes.
   * It lives in the card store, so what the keys act on is always what is drawn; any other pick lets it go.
   */
  const pickedMember = () => {
    const k = kindEdits.get();
    return k?.kind === "picked" ? k : null;
  };
  /** Each field opened gets its own number, so a field replacing another of its kind starts afresh. */
  const fieldSeq = useRef(0);
  /** The shape the pointer is over, whose handles show (CL1 "+ member", F17 +). */
  const hot = useMemo(() => createHotStore(), []);
  useEffect(() => () => hot.dispose(), [hot]);
  /**
   * The mind map topics folded. Folding is the view's alone: the text keeps every topic and it is no undo
   * step (XMind). The topics a drag is moving are drawn faded.
   */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  /** Steps 7 and 8: a topic, message or participant drag's landing place, drawn over the canvas. */
  const orderDrag = useMemo(() => createOrderDragStore(), []);
  /** Step 8 (S4): the loop selected by its tab, by its index in the frames and its label. */
  const [loopSel, setLoopSel] = useState<{ index: number; label: string } | null>(null);
  const loopSelRef = useRef(loopSel);
  loopSelRef.current = loopSel;
  /** Step 8 (S1): the height a new message lands at, drawn across the lifelines while it is picked or drawn. */
  const [slotGuide, setSlotGuide] = useState<{ y: number; x1: number; x2: number; pick: boolean } | null>(null);
  /** A press on a lifeline is the message gesture's: the click after it does not select the participant. */
  const swallowClick = useRef(false);
  /** The last press on a loop's tab, so a second one soon after edits its label. */
  const lastTab = useRef<{ index: number; at: number } | null>(null);
  /** Ends a topic, message or participant drag under way with nothing written; a no-op when none is. */
  const endOrderDrag = useRef<() => void>(() => {});
  useEffect(() => () => endOrderDrag.current(), []);

  viewOf.current = () => doc.view() ?? null;
  useEffect(() => {
    if (noticeDoc.current !== null && viewOf.current()?.state.doc !== noticeDoc.current) {
      noticeDoc.current = null;
      setNoticeState(null);
    }
    // "Rewrite as table blocks first" is true only while the frame is old form: the rewrite takes it away.
    if (!parsed?.frame?.oldEr) setNoticeState((n) => (n === ER_NOTES.oldForm ? null : n));
  }, [parsed]);
  // Motion: positions drawn part of the way through a glide, nodes fading in or out, the
  // drag and draw overlay, the label box, "Add and connect" and the canvas note.
  const overlay = useMemo(() => createOverlayStore(), []);
  /**
   * One origin for the whole board: the canvas's flow positions are board positions, and the live
   * frame's shapes hang from an anchor at its `at`, so its graph, its drags and its overlay stay frame-local. A point the
   * canvas hands out is converted where it is used: `toBoard` for the board (frames, sketches, Shelf adds), `toLive` for
   * the live frame's own work; `fromLive` takes a frame-local point back to the board (to put it on screen).
   */
  const liveAtRef = useRef<Point>(ORIGIN0);
  const toBoard = (flow: Point): Point => flow;
  const toLive = (flow: Point): Point => ({ x: flow.x - liveAtRef.current.x, y: flow.y - liveAtRef.current.y });
  const fromLive = (local: Point): Point => ({ x: local.x + liveAtRef.current.x, y: local.y + liveAtRef.current.y });
  /** A glide's frame: only the moving nodes (and the group areas around them), drawn over the layout. */
  const [glide, setGlideState] = useState<LivePositions | null>(null);
  const glideRef = useRef<LivePositions | null>(null);
  const setGlide = useCallback((g: LivePositions | null) => {
    glideRef.current = g;
    setGlideState(g);
  }, []);
  const stopGlide = useRef<() => void>(() => {});
  const stopPull = useRef<() => void>(() => {});
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [states, setStates] = useState<ReadonlyMap<string, NodeState>>(NO_STATES);
  const [labelBox, setLabelBox] = useState<LabelBoxState | null>(null);
  /** The relationship label's last refusal, a new object each time, so a switch waiting for its commit can tell. */
  const labelRefused = useRef<{ text: string } | null>(null);
  /** Why the relationship label field's last commit was refused (R9), and a count so the same reason refocuses it. */
  const [labelError, setLabelError] = useState<{ text: string; key: number } | null>(null);
  const [quick, setQuick] = useState<{ from: string; at: Point; screen: Point } | null>(null);
  const quickRef = useRef(quick);
  quickRef.current = quick;
  const [note, setNote] = useState<CanvasNote | null>(null);
  /** The delete toast showing, with the history's depth right after the delete. */
  const undoToast = useRef<{ depth: number } | null>(null);
  // A text edit, a move, a setting or an undo since the delete changes the history's depth: the toast goes.
  useEffect(() => {
    const t = undoToast.current;
    const v = doc.view();
    if (t && (!v || undoDepth(v.state) !== t.depth)) dismissUndoToast();
    // The history is read from the editor whenever the text or the layout changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.parsed, doc.board]);
  const frameSettingsRef = useRef({ textSize, notation });
  frameSettingsRef.current = { textSize, notation };
  const drag = useRef<DragInfo | null>(null);
  const deleting = useRef(false);

  // ----- board frames
  /**
   * The selected frame's identity (`frame#<n>`), null with nothing selected. Keyed by identity, never by title: a rename
   * keeps the per-frame state (Figma keeps a page's selection), and only a switch to another frame resets it.
   */
  const frameKey = frameSel ? `frame#${doc.frameId}` : null;
  const frameSelRef = useRef<FrameSelection | null>(frameSel);
  frameSelRef.current = frameSel;
  /** The shapes a switch selects once it has happened (a click on a shape in another frame). */
  const pendingPick = useRef<string[] | null>(null);
  /**
   * A switch in two paints: the frame picked is drawn selected at once (its ring and its
   * tab), its shapes still static; `doc.select` runs after that paint, so `frameSel` and `liveSel` keep their meanings
   * and the live shapes come one paint later. Null with no switch waiting. `pendingRef` holds it with the shapes to pick.
   */
  const [pendingFrame, setPendingFrameState] = useState<FrameSelection | null>(null);
  const pendingRef = useRef<{ sel: FrameSelection; pick: string[] } | null>(null);
  /** The waiting switch's `doc.select` is scheduled; a newer number drops an earlier schedule. */
  const pendingSeq = useRef(0);
  const pendingScheduled = useRef(false);
  /** Keys pressed while a switch waits (at most 8, in order), replayed on the picked frame once it is live. */
  const heldKeys = useRef<HeldKey[]>([]);
  /** The switch just landed with keys held: they are replayed once this commit's effects have run. */
  const replayDue = useRef(false);
  /** A key's async work not yet with the doc (a paste reading the clipboard), for `keySettled`. */
  const keyWork = useRef(0);
  /** False once the tab is gone: a landing or a replay still scheduled then does nothing. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingSeq.current++;
    };
  }, []);
  /**
   * The one way to act after a frame switch ("select a frame, then run this once the switch has landed"): `run` goes on
   * the first render with frame `sel` live, with its box. A switch elsewhere first, Esc or a new press drops it, and a
   * frame selected but not live (a title an earlier frame has) drops it too, so it can never fire later at old points
   * (Review Focus 4). An action that does not draw (`live: false`: a glide, opening the pane) runs on the frame's box
   * once the board draws it, live or not, so a frame with an error still opens. A shape drawn into a frame that was not live, an added frame's glide, the
   * Code Editor or a problem count on a frame, and an undo in another frame (Review Focus 3) all wait here.
   */
  const openFromDatabase = useRef<(() => void) | null>(null);
  const openFromMermaid = useRef<(() => void) | null>(null);
  const afterSwitch = useRef<{ sel: FrameSelection; run: (box: FrameBox) => void; live: boolean } | null>(null);
  /** This render's actions, for a `run` made in an earlier render (it names the frame left, not the one landed on). */
  const latestActs = useRef({
    drawShape: (_tool: string, _from: Point, _to: Point) => {},
    glideToFrame: (_box: FrameBox) => {},
    fitFrame: (_box: FrameBox) => {},
    showFrameBox: (_box: FrameBox) => {},
  });
  /** This render's Shelf and menu actions, for a `run` made in an earlier render (set each render, below). */
  const lateActs = useRef<{
    openMenu(at: CanvasMenuAt): void;
    iconNode(title: string, icon: string, at?: Point): Promise<ShelfOutcome>;
    placeIcon(title: string, icon: string, p: Point, dropped: boolean): Promise<ShelfOutcome | null>;
    finishShelf(outcome: ShelfOutcome): void;
    fitBoard(boxes: readonly Rect[]): void;
  }>(null!);
  /** The commit of an open field under way: a switch waits for it, so it lands in its own frame. */
  const commitRef = useRef<Promise<void> | null>(null);
  const trackCommit = (p: Promise<unknown> | undefined) => {
    if (!p) return;
    const q: Promise<void> = p.then(
      () => {},
      () => {},
    );
    commitRef.current = q;
    void q.then(() => {
      if (commitRef.current === q) commitRef.current = null;
    });
  };
  // ----- ER editing on the cards (B3 decisions 2, 5, 6 and 8)
  /** The live frame's ER state is the frame's, by identity and kind: a switch or a kind change empties it (decision 8). */
  const erFrameKey: string | null = frameSel ? `${doc.frameId}:${kind}` : null;
  /** How far each live card's rows are scrolled, read by the card and the lines to its rows (decision 5). */
  const erScroll = useMemo(() => createErScrollStore(), []);
  /** What `erRefusal` reads for every ER gesture: the lock, an old-form frame, a text with an error (Review Focus 4). */
  const erGate = {
    locked: () => aiLock.current,
    oldForm: () => parsedRef.current?.frame?.oldEr === true,
    stale: () => staleRef.current,
  };
  const er = useErCanvas({
    doc: () => parsedRef.current?.result.doc ?? drawnRef.current,
    run: (op, opts) => {
      const p = doc.run(op, opts);
      // A column written from the card or its draft row bands its new line in the pane (decision 14).
      if (op.op === "addColumn" || op.op === "duplicateColumn") void p.then((r) => r && bandWritten(r.at));
      return p;
    },
    frame: () => doc.frameIdNow(),
    track: (p) => trackCommit(p),
    ...erGate,
    readOnly: ai.locked,
    onRenamed: (old, next) => {
      // A renamed table keeps how far its rows are scrolled, and the lines to them stay put.
      erScroll.move(old, next);
      if (hasOwn(doc.layout.nodes, old)) doc.place({ [next]: doc.layout.nodes[old] }, true);
      setSelected([next]);
    },
    onPick: (table) => {
      // "Add relationship to..." takes the table picked (draw.io's connect mode); anything else ends it.
      relRef.current?.pickWhileLinking([table]);
      setSelected((prev) => (prev.length === 1 && prev[0] === table ? prev : [table]));
    },
    // A press on a column or a header while "Make a relationship from here" is on is the pick's.
    intercept: (table, index) => relRef.current?.interceptPick(table, index) ?? false,
    selection: () => selectedRef.current,
    notice: setNotice,
    refocus: () => canvasEl.current?.focus({ preventScroll: true }),
    // Ctrl+C or Ctrl+X on a column: its block line is the clipboard's, and the paste knows it as a column (R20).
    copy: (text) => {
      lastClip = { text, diagram: name, at: emptyPositions(), pastes: 0, column: text };
      expectCopy(text);
    },
  });
  const erRef = useRef(er);
  erRef.current = er;
  /** `useErRelate`'s, for the card's picks, which `useErCanvas` takes before it exists. */
  const relRef = useRef<ReturnType<typeof useErRelate> | null>(null);
  /** The one table selected alone, whose ports show without a hover: a selection of many shows none. */
  const erSole = useMemo(() => createErSoleStore(), []);
  /**
   * Relationships drawn between columns: port drags, the Relationship tool and the Shapes lines, planned and
   * written in the frame the gesture started in (R4), never onto another frame's table (R12).
   */
  const rel = useErRelate({
    doc: () => parsedRef.current?.result.doc ?? null,
    drawn: () => drawnRef.current,
    run: (op, opts) => doc.run(op, opts),
    frame: () => doc.frameIdNow(),
    track: (p) => trackCommit(p),
    band: (at) => bandWritten(at),
    nodes: () => graphRef.current.nodes,
    // Its points are the live frame's (frame-local); the frames' boxes are the board's.
    frameAt: (p) => (staticFrameAt(fromLive(p)) ? { live: false } : frameAt(fromLive(p)) ? { live: true } : null),
    scroll: erScroll,
    store: er.value.store,
    ...erGate,
    notice: setNotice,
    pane: () => paneEl.current,
    canvas: () => canvasEl.current,
  });
  relRef.current = rel;
  /** The live ER card part the last press on the canvas landed on: a column's row or a header (a Shapes line's pick). */
  const erPress = useRef<CardHit>(null);
  /** The press on a live ER card has moved past a click's 3 px: what it selects is a drag's, never a line pick. */
  const erDragged = useRef(false);
  // The cards read why they take no edits (`blocked`) as they draw: an old-form frame draws its last good drawing,
  // which does not change as the frame turns old or is rewritten, so the context does (decision 3).
  const erOld = parsed?.frame?.oldEr === true;
  /** This tab's list of types for the type field: every tab stays mounted, so each has its own id (final review). */
  const erTypesId = `${useId()}er-types`;
  const erValue = useMemo(() => ({ ...(erOld ? { ...er.value, api: { ...er.value.api } } : er.value), types: erTypesId }), [er.value, erOld, erTypesId]);
  /**
   * The table a double-click, R, a Shapes Table or Add here is adding (decision 9, R13): a card-shaped field at the
   * point, not in the text until its name is kept, so Esc leaves nothing behind and no undo step (Figma, drawSQL).
   */
  const [newTable, setNewTableState] = useState<{ at: Point; kind: "weak" | null; name: string; error?: string; tries?: number } | null>(null);
  const newTableRef = useRef(newTable);
  const setNewTable = (t: typeof newTable) => {
    newTableRef.current = t;
    setNewTableState(t);
  };
  /**
   * The ER state lets go of the frame left (decision 8). An open card field was committed by the switch itself, in its
   * own frame: `switchFrame` and a tab drag blur it first and a switch waits for its write (R4, R26), so only the store
   * is left here, and nothing of the old frame is ever written into the new one.
   */
  // After each parse of the live ERD frame, a table no longer in it keeps no scroll (Task 5 fix round 1, memory
  // ruling): a table deleted, or a new one under a freed name, starts at its top. A tab drag parses nothing (R26).
  const parsedErDoc = kind === "er" ? (parsed?.result.doc ?? null) : null;
  useEffect(() => {
    if (parsedErDoc) erScroll.prune(new Set(parsedErDoc.nodes.map((n) => n.name)));
  }, [parsedErDoc, erScroll]);
  const erReset = () => {
    erRef.current.reset();
    // A line pick between its clicks ends with its prompt, which names a column of the frame left.
    if (shapePick.current?.p.what === "line" && kind === "er") setShapePick(null);
    else rel.reset();
    // The scroll store too: a same-named table of the frame selected starts at its top. A tab drag runs no reset (R26).
    erScroll.clear();
    if (newTableRef.current) setNewTable(null);
  };
  // A kind change under the same identity (the header retyped) empties it too.
  const erKeySeen = useRef(erFrameKey);
  useEffect(() => {
    if (erKeySeen.current === erFrameKey) return;
    erKeySeen.current = erFrameKey;
    erReset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erFrameKey]);
  const erSync = er.syncSelection;
  useEffect(() => erSync(selected), [selected, erSync]);
  useEffect(() => erSole.set(kind === "er" && selected.length === 1 ? selected[0] : null), [selected, kind, erSole]);
  /** A frame switch's fade: its number, so a switch soon after another starts the fade again. */
  const [fade, setFade] = useState<{ ms: number; n: number } | null>(null);
  const fadeSeq = useRef(0);
  // ----- the toolbar
  /** The armed tool's id; "select" when none is. */
  const [armed, setArmed] = useState("select");
  const armedRef = useRef(armed);
  armedRef.current = armed;
  /**
   * The add menu: where it opens on screen, the board point a pick places the frame at (null: beside the others), and
   * what opened it (Add, or a key on the canvas), where focus goes back when it closes.
   */
  /**
   * The Space box (B2 decision 19): `screen` the pointer it opened at, `at` that point on the board, where the pick
   * drops; `local` the pointer in the canvas's own coordinates and `bounds` the canvas's size, read once when it opens.
   */
  const [spaceBox, setSpaceBox] = useState<{ screen: Point; at: Point; local: Point; bounds: { w: number; h: number } } | null>(null);
  /**
   * The Shelf (B2 decision 2): the tab it opened on and what opened it (Add, More shapes, or `/` off the canvas),
   * where focus goes back when it closes (R16).
   */
  const [shelf, setShelf] = useState<{ tab: "diagrams" | "shapes"; query: string; from: "add" | "more" | "slash" | "template"; side?: "right" } | null>(null);
  /** What had focus when the assistant's Template opened the Shelf: it gets focus back when the Shelf closes. */
  const templateOpener = useRef<HTMLElement | null>(null);
  const shelfId = `${useId()}shelf`;
  /** A drag out of the Shelf is under way: the frame kind its Shapes list showed, held until the drag ends; undefined when none is. */
  const [shelfDrag, setShelfDrag] = useState<DiagramKind | null | undefined>(undefined);
  /** Space is held on the canvas: React Flow pans on a drag and the canvas shows the grab hand. */
  const [spaceHeld, setSpaceHeld] = useState(false);
  /** The toolbar's Add, which owns the add menu: its click toggles the menu (Figma, draw.io). */
  const addButton = useRef<HTMLElement | null>(null);
  /** The toolbar's slot: a press on it does not close the Shapes list it opened. */
  const toolbarSlot = useRef<HTMLDivElement>(null);
  /** The Space press under way: when it went down, where the pointer was, and whether the pointer moved or pressed since. */
  const space = useRef<{ t: number; p: Point | null; moved: boolean } | null>(null);
  /**
   * Frames just added (B2 decision 9): the first is selected once drawn, then one frame is glided into view and more
   * are fitted (`boxes`, board coordinates; empty for a frame placed by a board op). `toast` shows once selected, so
   * the switch does not end its Undo.
   */
  /** A Shelf or Space box add is running (`addFromShelf`). */
  const shelfAdding = useRef(false);
  /**
   * Frames just added, to select and show once drawn, with the history's depth right after the add: an undo or redo
   * before they are drawn changes it, and the entry goes, so a frame drawn later under the same title is left alone.
   */
  const addedFrame = useRef<{ titles: string[]; boxes: Rect[]; toast: string | null; depth: number | null } | null>(null);
  /** The history's depth now (null with no editor). */
  const historyDepth = () => {
    const v = doc.view();
    return v ? undoDepth(v.state) : null;
  };
  // Every per-frame thing resets in one place, before the effects that compare one doc with the next.
  useFrameSwitch(frameKey, () => {
    // The waiting switch has landed: the frame drawn selected is the live one, and the keys held go to it.
    const p = pendingRef.current;
    if (p && frameSel && sameFrame(frameSel, p.sel)) {
      pendingRef.current = null;
      pendingScheduled.current = false;
      setPendingFrameState(null);
      replayDue.current = heldKeys.current.length > 0;
      if (perfOn()) requestAnimationFrame(() => perfMeasure("select_live", "select_pick"));
    }
    // The strip's notice was about the frame left: "Linked ..." never follows a switch.
    setNotice(null);
    // A kind tool is its frame's; a drawing tool, the hand and the section stay armed.
    setArmed((a) => (isKindTool(a) ? "select" : a));
    // An action waits only for the frame it selected; a pick a tool started belongs to the frame left.
    const waits = afterSwitch.current?.sel;
    if (waits && !(frameSel && frameSel.index === waits.index && frameSel.title === waits.title)) afterSwitch.current = null;
    // Its prompt in the strip goes with it.
    toolPickSet.current = false;
    if (shapePick.current) setShapePick(null);
    stopGlide.current();
    setGlide(null);
    drag.current = null;
    overlay.set({ hot: null });
    setSelected(pendingPick.current ?? []);
    pendingPick.current = null;
    setLines([]);
    setBandLines([]);
    setField(null);
    setLabelBox(null);
    setEditingNode(null);
    setGroupSel(null);
    setGroupAsk(null);
    setLoopSel(null);
    lastTab.current = null;
    lastTitle.current = null;
    setKindEdit(null);
    // The card's field was committed by the switch, in its own frame (decision 8): the ER store lets the frame go.
    erReset();
    setPaneAdd(null);
    setQuick(null);
    setMenu(null);
    setSlotGuide(null);
    setStates(NO_STATES);
    setGhost(null);
    // The Assistant's review focus: its bands name lines of the frame left (Task 6 minor 4).
    setAiBands([]);
    setWritten(null);
    const ms = parsedRef.current ? motionMs("enter") : 0;
    setFade(ms > 0 ? { ms, n: ++fadeSeq.current } : null);
  });
  /** Where the pointer is over the canvas, on screen, for a paste of text copied elsewhere; null once it leaves. */
  const pointer = useRef<Point | null>(null);
  /** A copy whose clipboard event has not come yet, and a paste waiting for its event (the WebView may send none). */
  const copyPending = useRef<string | null>(null);
  const pastePending = useRef(false);
  /** The drop being written is a Ctrl+drag: the dragged shapes are cloned there (draw.io). */
  const dropCopies = useRef(false);
  /** Where the flow being drawn is, for the pull-back when Esc cancels it. */
  const lastDraw = useRef<{ from: Box; to: Point } | null>(null);
  /** The node a drawn flow is locked onto, whose new line shows in grey in the text before it is written. */
  const drawLock = useRef<string | null>(null);
  const onDrawRef = useRef<(fromId: string, lock: string | null) => void>(() => {});
  const connectionLine = useMemo(
    () =>
      makeConnectionLine((draw) => {
        // The connection line draws on the board; the pull-back draws in the live frame's overlay.
        const from = toLive(draw.from);
        lastDraw.current = { from: { ...draw.from, ...from }, to: toLive(draw.end) };
        onDrawRef.current(draw.fromId, draw.lock);
      }),
    [],
  );
  useEffect(
    () => () => {
      stopGlide.current();
      stopPull.current();
      clearTimeout(deleteTimer.current);
    },
    [],
  );

  // A cloud diagram checks its icon names against the pack: the worker gets the names once per session, then
  // this text is parsed again so the unknown-icon problem shows.
  const reparse = doc.reparse;
  useEffect(() => {
    if (kind !== "cloud") return;
    let live = true;
    void sendIconNames(client).then((ok) => {
      if (ok && live) reparse();
    });
    return () => {
      live = false;
    };
  }, [kind, client, reparse]);

  // While the assistant's changes wait, the canvas draws them over the drawing (new in green, removed in red).
  const review = ai.overlay;
  const shown = review?.draw ?? drawn;
  const reviewing = review !== null && review !== undefined;

  // Nodes with no position yet are placed by dagre in the worker, in the layout's direction.
  // Every node it asks about gets a position (the worker's, else a row below the drawing), so it never asks twice.
  useEffect(() => {
    // A sequence, mind map or timeline is laid out from its text every time; it keeps no positions.
    if (!shown || FIXED_KINDS.has(shown.kind)) return;
    const has = (n: string) => hasOwn(layout.nodes, n);
    if (shown.nodes.every((n) => has(n.name))) return;
    const input = layoutInput(shown, look, textScale);
    const existing = emptyPositions();
    for (const n of shown.nodes) if (has(n.name)) existing[n.name] = layout.nodes[n.name];
    let live = true;
    const place = (p: Positions | null) => {
      if (!live) return;
      const out = emptyPositions();
      const below = Object.values(existing).reduce((y, q) => Math.max(y, q.y), 0) + 200;
      let x = 0;
      for (const n of input.nodes) {
        if (has(n.id)) continue;
        const q = p && hasOwn(p, n.id) ? p[n.id] : null;
        if (q && Number.isFinite(q.x) && Number.isFinite(q.y)) out[n.id] = { x: q.x, y: q.y };
        else {
          out[n.id] = { x, y: below };
          x += n.w + 40;
        }
      }
      // Shapes only the review draws keep their place until the changes are decided.
      if (reviewing) doc.placeProposed(out);
      else doc.place(out);
    };
    client.layout({ ...input, existing, rankdir: layout.direction }).then(place, () => place(null));
    return () => {
      live = false;
    };
  }, [shown, look, layout.nodes, layout.direction, client, doc.place, doc.placeProposed, reviewing, textScale]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  /** Where a node is drawn now: part of the way through a glide, else at its layout place. */
  const drawnAt = (k: string): { x: number; y: number } | undefined => {
    const g = glideRef.current;
    if (g && hasOwn(g, k)) return { x: g[k].x, y: g[k].y };
    return hasOwn(layoutRef.current.nodes, k) ? layoutRef.current.nodes[k] : undefined;
  };

  // The new flow whose label box is open is drawn in accent (motion design, "Drawing a flow").
  const freshEdge = labelBox?.fresh ? labelBox.index : undefined;
  // Only placed nodes are drawn, so the first fit sees where everything is. A glide does not rebuild this: its
  // frames go to the canvas as live positions of the moving nodes only.
  // The assistant's marks join the motion states: its review's new and removed shapes, and the shapes it just added.
  // The live frame flashes what landed in it, by its layout key (a clashing title never flashes another frame).
  const airingKey = frameSel && parsed && parsed.result.frames[frameSel.index]?.title === frameSel.title ? parsed.keys[frameSel.index] : undefined;
  // The parts an answer named ring the same way; a column rings its row, a shape its box.
  const airingAll = useMemo(() => {
    if (ringed.size === 0) return ai.airing;
    const out = new Map(ai.airing);
    for (const [k, names] of ringed) out.set(k, new Set([...(out.get(k) ?? []), ...names]));
    return out;
  }, [ai.airing, ringed]);
  const airingNames = useMemo(() => (airingKey === undefined ? NO_NAMES : (airingAll.get(airingKey) ?? NO_NAMES)), [airingAll, airingKey]);
  const airing = useMemo(() => ([...airingNames].some((n) => ringColumn(n)) ? new Set([...airingNames].filter((n) => !ringColumn(n))) : airingNames), [airingNames]);
  /** The live frame's ringing columns, by table. */
  const airingRows = useMemo(() => {
    const rows = new Map<string, Set<string>>();
    for (const n of airingNames) {
      const c = ringColumn(n);
      if (c) rows.set(c.table, (rows.get(c.table) ?? new Set()).add(c.column));
    }
    return rows;
  }, [airingNames]);
  const landedNames = useMemo(() => (airingKey === undefined ? NO_NAMES : (ai.airing.get(airingKey) ?? NO_NAMES)), [ai.airing, airingKey]);
  const shownStates = useMemo(() => {
    if (!review && airing.size === 0) return states;
    const next = new Map(states);
    // What a landing added says so in its name; a part an answer only named rings with no note.
    for (const n of airing) next.set(n, landedNames.has(n) ? "airing" : "ringed");
    if (review) {
      for (const n of review.added) next.set(n, "suggested");
      for (const n of review.removed) next.set(n, "removed");
      for (const n of review.changed) next.set(n, "changed");
    }
    return next;
  }, [states, review, airing, landedNames]);
  const marks = useMemo(() => {
    if (!review) return undefined;
    const m = new Map<number, "add" | "del" | "changed">();
    for (const i of review.addedLinks) m.set(i, "add");
    for (const i of review.removedLinks) m.set(i, "del");
    for (const i of review.changedLinks) m.set(i, "changed");
    return m;
  }, [review]);
  // A member being added grows its class by one row, so the new row is not scrolled out of sight.
  // The card's own draft row (ER) grows its table the same way; the store tells the tab only when the open edit changes.
  const erStore = er.value.store;
  const erDraft = useSyncExternalStore(erStore.watchEdit, () => {
    const e = erStore.get().edit;
    return e?.kind === "draft" ? e.table : null;
  });
  const growing = kindEdit?.kind === "draft" ? kindEdit.node : erDraft;
  // a new topic's ghost is laid out with the map (its parent, the sibling it follows, its size).
  const ghostParent =
    field?.kind === "new" && field.node === "topic" && shown?.kind === "mindmap"
      ? (field.under ?? (field.after !== undefined ? (shown.links.find((l) => l.tree && l.to === field.after)?.from ?? null) : null))
      : null;
  const ghostAfter = ghostParent !== null && field?.kind === "new" ? field.after : undefined;
  // The ghost is the size of the topic it will be (its level), and grows with the name typed.
  // Laid out at the name it opens with; the typed name widens the ghost alone (growGhost), not the layout (N5).
  const ghostName = field?.kind === "new" ? field.name : "";
  const ghostDepth = ghostParent !== null ? (shown?.nodes.find((n) => n.name === ghostParent)?.depth ?? 0) + 1 : 1;
  const ghostSize = ghostParent !== null ? nodeSize(drawnKind("topic", "mindmap", ghostName), look, ghostName || " ", undefined, { depth: ghostDepth }) : null;
  const ghostW = ghostSize ? ghostSize.w : field?.kind === "new" ? field.size.w : 0;
  const ghostH = ghostSize ? ghostSize.h : field?.kind === "new" ? field.size.h : 0;
  /**
   * The ghost widens with the typed name, measured alone: its shape's width is set on it, away from its
   * parent on the left side, with no new layout or drawing per key (round 2, N5).
   */
  const growGhost = (text: string) => {
    const el = canvasEl.current?.querySelector<HTMLElement>(".flow-ghost-topic");
    const node = graphRef.current.nodes.find((g) => g.id === GHOST_ID);
    if (!el || !node) return;
    const w0 = node.initialWidth ?? 0;
    const w = nodeSize(drawnKind("topic", "mindmap", text), look, text || " ", undefined, { depth: ghostDepth }).w;
    const root = graphRef.current.nodes.find((g) => g.id === drawnRef.current?.nodes.find((n) => n.kind === "root")?.name);
    const left = !!root && node.position.x + w0 / 2 < root.position.x + (root.initialWidth ?? 0) / 2;
    el.style.width = `${Math.max(w, w0)}px`;
    el.style.marginLeft = left ? `${w0 - Math.max(w, w0)}px` : "";
  };
  /** Where the ghost was last drawn: its field stays there if the topic it was added to goes meanwhile. */
  const keptGhost = useRef<{ open: number; box: Box } | null>(null);
  /** The live frame's nodes and lines, before the review's ER row marks. */
  const baseGraph = useMemo(() => {
    if (!shown) return { nodes: [], edges: [] };
    if (FIXED_KINDS.has(shown.kind))
      return buildFlowGraph(shown, layout.nodes, look, {
        states: shownStates,
        fresh: freshEdge,
        marks,
        ...(textScale !== 1 ? { textScale } : {}),
        ...(shown.kind === "mindmap" && folded.size ? { folded } : {}),
        ...(ghostParent !== null ? { ghost: { parent: ghostParent, ...(ghostAfter !== undefined ? { after: ghostAfter } : {}), size: { w: ghostW, h: ghostH } } } : {}),
      });
    const placed = shown.nodes.filter((n) => hasOwn(layout.nodes, n.name));
    return buildFlowGraph(placed.length === shown.nodes.length ? shown : { ...shown, nodes: placed }, layout.nodes, look, {
      states: shownStates,
      fresh: freshEdge,
      sizes: layout.sizes,
      ...(layout.axes ? { axes: layout.axes } : {}),
      marks,
      ...(growing !== null ? { grow: { [growing]: 1 } } : {}),
      ...(textScale !== 1 ? { textScale } : {}),
      ...(notation !== "crow" ? { notation } : {}),
    });
  }, [shown, layout.nodes, layout.sizes, layout.axes, look, shownStates, freshEdge, marks, growing, folded, ghostParent, ghostAfter, ghostW, ghostH, textScale, notation]);
  // The live ER card marks every row the review adds, removes or changes, and scrolls to the first.
  const graph = useMemo(() => {
    let g = baseGraph;
    if (review && (review.addedRows.size > 0 || review.removedRows.size > 0 || review.changedRows.size > 0)) g = { ...g, nodes: g.nodes.map((n) => withRowStates(n, review)) };
    // A renamed group's area, as a static frame draws it: tinted by class, and its name says so.
    if (review && review.changed.size > 0) g = { ...g, nodes: g.nodes.map((n) => (n.id.startsWith(GROUP_ID) && review.changed.has(n.id.slice(GROUP_ID.length)) ? { ...n, className: n.className ? `${n.className} is-ai-changed` : "is-ai-changed", data: { ...n.data, state: "changed" } } : n)) };
    if (airing.size > 0) g = { ...g, nodes: g.nodes.map((n) => (n.id.startsWith(GROUP_ID) && airing.has(n.id.slice(GROUP_ID.length)) ? { ...n, className: n.className ? `${n.className} is-ai-airing` : "is-ai-airing" } : n)) };
    if (airingRows.size > 0) g = { ...g, nodes: g.nodes.map((n) => withAiredRows(n, airingRows, landedNames)) };
    return g;
  }, [baseGraph, review, airingRows, airing, landedNames]);
  /** The latest Publish theme change, so a slower earlier one never overwrites it. */
  const publishInkSeq = useRef(0);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // The board: every frame on one canvas. The selected frame is live (FlowTab's own graph, bare names); every other
  // frame is static, from the board scene.
  const scene = useMemo(() => createBoardScene("modern"), []);
  /** The live frame's tab is being dragged: it is drawn static until it is let go. */
  const [frameDragLive, setFrameDragLive] = useState(false);
  // The drawn-live index: `frameSel`, never a frame still waiting for its paint, so a frame picked stays
  // static in the first paint (what Task 6 passes as `FrameDrawInput.live`).
  const liveSel = frameDragLive ? null : frameSel;
  /**
   * Tiny frames' pictures, in the theme on screen. At open every static frame is pictured at once,
   * before the first paint, so a board opening at its fit never mounts a static shape; after open pictures build in
   * time slices, and each slice that built one draws the board again.
   */
  const iconTheme = useIconTheme();
  const [pictureTick, setPictureTick] = useState(0);
  /** When the last picture redraw was asked for: its render and commit go to the perf log as `picture_redraw`. */
  const pictureRedrawAt = useRef(0);
  /** Both stores' `onReady`: the board is drawn again once an animation frame at most, however many slices built. */
  const picturesReady = useMemo(
    () =>
      oncePerFrame(() => {
        pictureRedrawAt.current = performance.now();
        setPictureTick((t) => t + 1);
      }),
    [],
  );
  useLayoutEffect(() => {
    if (pictureRedrawAt.current === 0) return;
    perfStep("picture_redraw", performance.now() - pictureRedrawAt.current);
    pictureRedrawAt.current = 0;
  }, [pictureTick]);
  /**
   * Which picture builds first: the frames the plan draws, nearest the view's centre, then the rest. In
   * the WebView, where pictures are bitmaps, nothing is built at open: each frame is its box until its bitmap is in, so
   * the first paint holds no SVG to draw as vector and no 50 SVG builds in one task (round 3 measured 118 to 164 ms of
   * them in the open frame). Where nothing draws bitmaps (jsdom) the SVG is the picture, built at open as before.
   */
  const pictureRank = (id: string): number => {
    const b = boardRef.current;
    const box = b?.boxes.find((x) => frameNodeId(x) === id);
    if (!box) return Number.MAX_VALUE;
    const v = viewRef.current;
    if (!v) return box.index;
    const plan = frameDrawRef.current.plan;
    const d = (box.x + box.w / 2 - (v.x + v.w / 2)) ** 2 + (box.y + box.h / 2 - (v.y + v.h / 2)) ** 2;
    return plan && !plan.form.has(box.index) ? RANK_OUT_OF_VIEW + d : d;
  };
  const pictureRankRef = useRef(pictureRank);
  pictureRankRef.current = pictureRank;
  const pictures = useMemo(() => {
    const rasterise = browserRasteriser();
    return createPictureStore({ palette: exportPalette, loadIcons: loadSceneIcons, onReady: picturesReady, sync: !rasterise, rasterise, rank: (id) => pictureRankRef.current(id) });
  }, [picturesReady]);
  /**
   * The frames in view and how each is drawn: `plan` is kept only when its key changes (a
   * crossing), `drawn` steps toward it each animation frame. Null until the canvas reports its first view: every frame
   * draws real then.
   */
  const [frameDrawState, setFrameDrawState] = useState<{ plan: FrameDrawPlan | null; drawn: DrawnForms | null }>({ plan: null, drawn: null });
  const frameDrawRef = useRef(frameDrawState);
  frameDrawRef.current = frameDrawState;
  /**
   * When the last step of the drawn forms was set: its render and commit go to the perf log as `form_step` (Task 9 fix
   * 4), so a long glide frame shows how much of it was React's work for the step and how much the WebView's own.
   */
  const formStepAt = useRef(0);
  useLayoutEffect(() => {
    if (formStepAt.current === 0) return;
    perfStep("form_step", performance.now() - formStepAt.current);
    formStepAt.current = 0;
  }, [frameDrawState]);
  const plan = frameDrawState.plan;
  /** The text sizes far at this zoom, as "s m l", from the plan: changed only by a crossing. */
  const farKey = useMemo(() => (plan ? TEXT_SIZES.filter((t) => plan.far.has(t)).join(" ") : ""), [plan]);
  const far = useMemo(() => new Set(farKey.split(" ").filter(Boolean) as TextSize[]) as ReadonlySet<TextSize>, [farKey]);
  // The tab counts what the foot counts: the errors.
  const boardErrors = useMemo(() => (parsed?.result.problems ?? []).filter((p) => p.severity === "error"), [parsed]);
  /**
   * The sketch layer pictured when far: its tiles' pictures, built in slices as the frames' are, and how
   * the layer is drawn now (`stepSketches`). Pictured only while body text is far, no sketch is picked and no sketch
   * tool is armed: those work on real sketches, so the layer turns real at once for them.
   */
  const sketchTiles = useMemo(() => createSketchTiles(), []);
  /** The sketch tiles build nearest the view's centre first, as the frames do. */
  const tileRank = (id: string): number => {
    const t = sketchTiles.of(boardLayoutRef.current.sketches).find((x) => x.id === id);
    const v = viewRef.current;
    if (!t || !v) return 0;
    return (t.box.x + t.box.w / 2 - (v.x + v.w / 2)) ** 2 + (t.box.y + t.box.h / 2 - (v.y + v.h / 2)) ** 2;
  };
  const tileRankRef = useRef(tileRank);
  tileRankRef.current = tileRank;
  const sketchPictures = useMemo(
    () => createSketchPictureStore({ palette: exportPalette, loadIcons: loadSceneIcons, onReady: picturesReady, rasterise: browserRasteriser(), rank: (id) => tileRankRef.current(id) }),
    [picturesReady],
  );
  // A closed tab stops building its queued pictures (final review M2). No prune: the stores are this tab's alone, so
  // its pictures go with it, and a prune would empty them under React's development re-mount while the board still
  // draws from them. That re-mount draws the board once more, so it asks again for the builds dropped here.
  const disposedPictures = useRef(false);
  useEffect(() => {
    if (disposedPictures.current) {
      disposedPictures.current = false;
      setPictureTick((t) => t + 1);
    }
    return () => {
      pictures.dispose();
      sketchPictures.dispose();
      disposedPictures.current = true;
    };
  }, [pictures, sketchPictures]);
  const [sketchForm, setSketchForm] = useState<SketchForm>(SKETCHES_REAL);
  const sketchFormRef = useRef(sketchForm);
  sketchFormRef.current = sketchForm;
  const sketchBusy = sketchSel.length > 0 || SKETCH_TOOLS.has(armed);
  /**
   * The canvas has keyboard focus (final review I2, controller ruling): focus came into it by a key, not a press. The
   * sketch layer is real meanwhile (over the swap budget), so Tab reaches every sketch at any zoom, as on main; it is
   * pictured again once focus leaves the canvas. A pointer-only session keeps the pictures.
   */
  const [keyFocus, setKeyFocus] = useState(false);
  /** The last input was a key, not a press (what `:focus-visible` goes by). */
  const lastByKey = useRef(false);
  useEffect(() => {
    const key = () => {
      lastByKey.current = true;
    };
    const press = () => {
      lastByKey.current = false;
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("mousedown", press, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("mousedown", press, true);
    };
  }, []);
  const wantSketchPictures = doc.board.sketches.length > 0 && sketchesFar(plan?.far ?? NO_SIZES, sketchBusy || keyFocus);
  /** Each tile's picture so far (asked for when it is not built), and whether every one is built for its sketches now. */
  const sketchTileImages = (): { draw: SketchLayerDraw["tiles"]; ready: boolean } => {
    const tiles = sketchTiles.of(doc.board.sketches);
    sketchPictures.prune(new Set(tiles.map((t) => t.id)));
    const draw: SketchLayerDraw["tiles"][number][] = [];
    let ready = true;
    for (const t of tiles) {
      const image = sketchPictures.url(t.id, sketchTiles.keyOf(t), t);
      if (image === null) ready = false;
      else draw.push({ id: t.id, under: t.under, box: t.box, image });
      if (!sketchPictures.ready(t.id)) ready = false;
    }
    return { draw, ready };
  };
  const aiReview = ai.review;
  const aiProposedAt = ai.proposedAt;
  const board = useMemo(
    () => {
      // A theme switch drops every picture: the board draws them again in the new theme (Review Focus 4).
      pictures.setTheme(iconTheme);
      sketchPictures.setTheme(iconTheme);
      const sketchDraw: SketchLayerDraw | null = sketchForm.pictured ? { tiles: sketchTileImages().draw, mounted: sketchForm.mounted } : null;
      return parsed
        ? // The parse's own keys, never the header keys, which run ahead of the parse (Task 5 carry).
          // The waiting proposal draws on every frame it touches and its new frames at their places.
          scene.build(
            parsed.result.frames,
            doc.board,
            parsed.keys,
            liveSel,
            liveSel ? { nodes: graph.nodes } : null,
            boardErrors,
            doc.clashLayouts,
            frameDrawState.drawn,
            pictures,
            sketchDraw,
            aiReview ?? undefined,
            aiProposedAt,
            airingAll,
            ai.airing,
          )
        : null;
    },
    // pictureTick: a slice of pictures is built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, parsed, doc.board, liveSel, graph, boardErrors, doc.clashLayouts, frameDrawState.drawn, pictures, iconTheme, pictureTick, sketchForm, aiReview, aiProposedAt, airingAll, ai.airing],
  );
  /** The board's frames for the Assistant's `/` list and chips. */
  const assistFrames = useMemo(
    () => parsed?.result.frames.map((f, i) => ({ title: f.title, kind: f.kind, clash: isDup(parsed.keys[i] ?? ""), key: parsed.keys[i] })),
    [parsed],
  );
  /** What each frame holds now, by place: the names an answer's backticks can link to. */
  const assistParts = useMemo<PartFrame[] | undefined>(() => parsed?.result.frames.map((f, i) => ({ ...docParts(f.title, f.doc ?? f.lastValid), clash: isDup(parsed.keys[i] ?? "") })), [parsed]);
  /** A frame whose AI Chat was opened without selecting it: the Assistant adds its chip. A new object each time. */
  const [frameChip, setFrameChip] = useState<{ title: string; index: number } | null>(null);
  const assistFrame = useMemo(() => (frameSel ? { title: frameSel.title, index: frameSel.index, key: parsed?.keys[frameSel.index] } : null), [frameSel, parsed]);
  const boardRef = useRef(board);
  boardRef.current = board;
  const boardLayoutRef = useRef(doc.board);
  boardLayoutRef.current = doc.board;
  /** The view the canvas last reported (board units), and its handle for glides. */
  const viewRef = useRef<CanvasView | null>(null);
  /** The flow point a wheel zoom was around, until a view that did not come from the wheel replaces it (fill toward it). */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const canvasHandle = useRef<CanvasHandle | null>(null);
  /** Every view move that glides goes through the canvas's `glideView`, which reports where it lands first. */
  const glideView = (to: ViewTarget) => void canvasHandle.current?.glideView(to);
  /**
   * Each frame's text size, shape count, parts (shapes and lines: what turning real mounts) and centre by frame index,
   * for the plan and its steps.
   */
  const frameFacts = (b: NonNullable<typeof board>) => {
    const n = b.boxes.reduce((m, x) => Math.max(m, x.index + 1), 0);
    const sizes: TextSize[] = new Array(n).fill("m");
    const shapes: number[] = new Array(n).fill(0);
    const parts: number[] = new Array(n).fill(0);
    const centres: Point[] = new Array(n).fill(ORIGIN0);
    for (const x of b.boxes) {
      if (x.key !== null) sizes[x.index] = boardLayoutRef.current.frames.get(x.key)?.textSize ?? "m";
      const id = x.key === null ? duplicateFrameId(x.index) : boardFrameId(x.key);
      shapes[x.index] = b.children.get(id)?.length ?? 0;
      parts[x.index] = shapes[x.index] + (b.lines.get(id) ?? 0);
      centres[x.index] = { x: x.x + x.w / 2, y: x.y + x.h / 2 };
    }
    return { sizes, shapes, parts, centres };
  };
  /**
   * The swap budget by animation frame (Task 9 fix 3, `swapBudget`): read once a frame from how long the frame before
   * took, by the frames' step and the sketch layer's alike. A step after a pause (no step for 100 ms) starts afresh.
   */
  const swapClock = useRef({ t: -1, last: 0, next: SWAP_BUDGET_SHAPES, now: SWAP_BUDGET_SHAPES });
  const swapBudgetAt = (t: number): number => {
    const c = swapClock.current;
    if (t === c.t) return c.now;
    const dt = c.last > 0 && t - c.last < 100 ? t - c.last : 16;
    const b = swapBudget(c.next, dt, SWAP_BUDGET_SHAPES);
    swapClock.current = { t, last: t, next: b.next, now: b.now };
    return b.now;
  };
  /** One step of the drawn forms toward `target`; the same object when nothing changes. */
  const stepDrawn = (target: FrameDrawPlan, from: DrawnForms | null, budget = swapClock.current.next): DrawnForms | null => {
    const b = boardRef.current;
    const v = viewRef.current;
    if (!b || !v) return from;
    const facts = frameFacts(b);
    // Before the first plan every static frame was a picture, and the live one real.
    const live = b.live?.index ?? null;
    // The live frame is always real in the drawn forms (`withLiveReal`): when it stops being live it waits for a new
    // picture, never keeping one from before it went live.
    const base = withLiveReal(from ?? { form: new Map(b.boxes.map((x) => [x.index, x.index === live ? ("real" as const) : ("picture" as const)])), mounted: new Map() }, live);
    // A frame turns into a picture once its picture is built (asked for here when it is not).
    const ready = (i: number) => {
      const want = target.form.get(i);
      return want === undefined || want === "real" || scene.pictureReady(i, want, pictures);
    };
    const next = stepForms(target, base, ready, facts.parts, facts.centres, pointerRef.current ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 }, budget);
    return sameForms(next, base) ? base : next;
  };
  /** The wheel's pointer only steers the swap the wheel started: once the drawn forms are the plan, it is let go. */
  const letGoPointerWhenSettled = () => {
    const { plan, drawn } = frameDrawRef.current;
    if (!plan || (drawn && drawn.mounted.size === 0 && sameFormMap(drawn.form, plan.form))) pointerRef.current = null;
  };
  /** What the last plan was made from. */
  const planned = useRef<{ boxes: readonly FrameBox[]; view: CanvasView; live: number | null; sizes: readonly TextSize[]; shapes: readonly number[] } | null>(null);
  /** Plans again for the view and the board's boxes now; kept only when its key changes. */
  const replan = () => {
    const b = boardRef.current;
    const v = viewRef.current;
    if (!b || !v) return;
    // A build that only changed what is drawn hands back the same frames at the same places, with the same text sizes
    // and shape counts: nothing to plan. A text size changed alone (a box clamped to FRAME_MIN keeps its size) plans.
    const facts = frameFacts(b);
    const last = planned.current;
    planned.current = { boxes: b.boxes, view: v, live: b.live?.index ?? null, sizes: facts.sizes, shapes: facts.shapes };
    if (
      last &&
      last.view === v &&
      last.live === planned.current.live &&
      sameBoxes(last.boxes, b.boxes) &&
      sameList(last.sizes, facts.sizes) &&
      sameList(last.shapes, facts.shapes)
    )
      return;
    const was = frameDrawRef.current;
    // A frame dragged by its tab keeps the form it has, and is never culled while dragged.
    const dragging = frameDrag.current?.index ?? null;
    const next = frameDraw({
      boxes: b.boxes,
      sizes: facts.sizes,
      shapes: facts.shapes,
      live: b.live?.index ?? null,
      dragging,
      dragForm: dragging === null ? null : (was.drawn?.form.get(dragging) ?? null),
      view: v,
      wasFar: was.plan?.far ?? NO_SIZES,
    });
    if (was.plan && was.plan.key === next.key) return;
    // The first step now, with the plan, so a crossing builds the scene once.
    const state = { plan: next, drawn: stepDrawn(next, was.drawn) };
    frameDrawRef.current = state;
    formStepAt.current = performance.now();
    setFrameDrawState(state);
  };
  // An edit can grow a frame into view, and a live drag tick moves the live box: the plan is made again.
  useLayoutEffect(() => {
    replan();
    // replan reads the board through its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board?.boxes]);
  // While the drawn forms differ from the plan, they step toward it once per animation frame.
  useEffect(() => {
    const { plan: target, drawn } = frameDrawState;
    if (!target || (drawn && drawn.mounted.size === 0 && sameFormMap(drawn.form, target.form))) return;
    let id = 0;
    const tick = (t: number) => {
      const cur = frameDrawRef.current;
      if (!cur.plan) return;
      const budget = swapBudgetAt(t);
      const next = stepDrawn(cur.plan, cur.drawn, budget);
      // A frame that mounts nothing to let the WebView catch up steps again at the next.
      if (next === cur.drawn) {
        if (budget === 0) id = requestAnimationFrame(tick);
        return;
      }
      const state = { plan: cur.plan, drawn: next };
      frameDrawRef.current = state;
      formStepAt.current = performance.now();
      setFrameDrawState(state);
      letGoPointerWhenSettled();
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
    // stepDrawn reads the board and the view through refs; a slice of pictures may let a frame turn into one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameDrawState, pictureTick]);
  // The sketch layer steps toward its wanted form once per animation frame, as the frames do: into its
  // pictures once they are built, real over them by the swap budget the frames leave (none while a frame turns real),
  // and real at once for a sketch picked or a sketch tool armed.
  useEffect(() => {
    if (!sketchForm.pictured && !wantSketchPictures) return;
    if (sketchForm.pictured && !wantSketchPictures && sketchBusy) {
      setSketchForm(SKETCHES_REAL);
      return;
    }
    let id = 0;
    const tick = (t: number) => {
      const ready = wantSketchPictures ? sketchTileImages().ready : true;
      const framesTurning = (frameDrawRef.current.drawn?.mounted.size ?? 0) > 0;
      const was = sketchFormRef.current;
      const budget = framesTurning ? 0 : swapBudgetAt(t);
      const next = stepSketches(wantSketchPictures, was, ready, doc.board.sketches.length, budget, false);
      if (next !== was) setSketchForm(next);
      // A frame that mounts nothing for the WebView to catch up steps again at the next (frames turning real step
      // the frames' effect, which runs this one again).
      else if (budget === 0 && !framesTurning && !wantSketchPictures && was.pictured) id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
    // sketchTileImages reads the board's sketches; a slice of pictures may let the layer turn into them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantSketchPictures, sketchBusy, sketchForm, frameDrawState, pictureTick, doc.board.sketches]);
  // The live frame's `at`, where the scene hangs its anchor (the same entry and key the scene read).
  liveAtRef.current = (board?.live?.key != null ? doc.board.frames.get(board.live.key)?.at : undefined) ?? ORIGIN0;
  // The board Ask's board: every frame's outline and problems of the text as it is now, each box in
  // board units, the sketches as notes, and the selection. The focus is the composer's chips, so it is left empty here.
  readBoard.current = async () => {
    for (let i = 0; i < 3; i++) {
      const cur = await doc.current();
      if (!cur) break;
      const o = await client.boardOutline(doc.docId, cur.result.version).catch(() => ({ stale: true as const }));
      if (o.stale) continue;
      const scene = boardRef.current;
      const boxes = scene ? onBoard(scene) : [];
      // The live frame's shapes are FlowTab's own nodes: the scene's `nodes` leave them out.
      const parts = scene ? boardNodeBoxes({ ...scene, nodes: [...scene.nodes, ...graphRef.current.nodes] }) : new Map<string, PartBox[]>();
      const sel = doc.selected;
      const live = scene?.live && sel && scene.live.index === sel.index ? selectedRef.current : [];
      const shapes = live.flatMap((id) => {
        const n = partName(id);
        return n === null ? [] : [n];
      });
      const { followUp: _f, attachment: _a, create: _c, ...board } = boardInput({
        frames: o.frames,
        boxes,
        focus: [],
        selected: { frame: sel?.title ?? null, shapes, sketches: sketchSelRef.current },
        notes: sketchNotes(doc.board.sketches, boxes, parts),
        create: null,
        followUp: null,
        attachment: null,
      });
      return board;
    }
    throw new Error("The text changed while the board was read.");
  };
  /** Publish is on when some frame has something drawn: Ctrl+Shift+E, the menus and the strip button. */
  const publishable = useMemo(
    () => !!parsed && anyFrameDrawn({ frames: parsed.result.frames, board: doc.board, keys: parsed.keys, frameIndex: board?.live?.index ?? null, liveLayout: board?.live ? layout : null }),
    [parsed, doc.board, board, layout],
  );
  /** Publish frame... is on when the live frame itself has something drawn, by the same rule (no dead row). */
  const liveDrawable = useMemo(
    () => !!parsed && !!board?.live && anyFrameDrawn({ frames: parsed.result.frames, board: doc.board, keys: parsed.keys, frameIndex: board.live.index, liveLayout: layout, only: board.live.index }),
    [parsed, doc.board, board, layout],
  );
  const publishableRef = useRef(publishable);
  publishableRef.current = publishable;
  /** The live frame's box; null with nothing live (nothing selected, a title an earlier frame has, a tab drag). */
  const liveBox = board?.live ?? null;
  const liveBoxRef = useRef(liveBox);
  liveBoxRef.current = liveBox;
  /** The one selected line in the live frame, for the line bar; null with none, two or a shape too. */
  const soleLine = useMemo(() => {
    if (!liveBox || lines.length !== 1 || selected.length > 0) return null;
    const i = linkIndex(lines[0]);
    const d = parsed?.result.doc ?? drawn;
    const link = i === null ? undefined : d?.links[i];
    const ref = link && d ? linkRefOf(d.links, i!) : null;
    return link && ref ? { link, ref } : null;
  }, [liveBox, lines, selected, parsed, drawn]);
  // An action waiting for a switch runs on the first render with its frame live, or never (see `afterSwitch`).
  useEffect(() => {
    const a = afterSwitch.current;
    if (!a || !frameSel) return;
    // Until the switch lands (it may wait for an open field's commit); a switch elsewhere drops it in the reset.
    if (frameSel.index !== a.sel.index || frameSel.title !== a.sel.title) return;
    if (!a.live) {
      const box = liveBox?.index === a.sel.index ? liveBox : board?.boxes.find((b) => b.index === a.sel.index && b.title === a.sel.title);
      // Until the board draws the frame (a frame just typed waits for its parse).
      if (!box) return;
      afterSwitch.current = null;
      a.run(box);
      return;
    }
    afterSwitch.current = null;
    if (!liveBox || liveBox.index !== a.sel.index || !parsed) return;
    a.run(liveBox);
  }, [frameSel, liveBox, kind, parsed, board]);
  // Keys held while the switch waited for its paint go to the frame now live, after the action waiting for it.
  useEffect(() => {
    if (pendingFrame !== null || !replayDue.current) return;
    replayDue.current = false;
    const keys = heldKeys.current;
    heldKeys.current = [];
    void replayHeldKeys(keys);
    // Only the landing of a switch replays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFrame]);
  const frameCount = board?.boxes.length ?? 0;
  /** The live frame's shapes and lines in the live band, set in this one place. */
  const liveBase = useMemo(
    () => ({
      // Each carries its frame's text size, so flow-board.css fades its text at that size's zoom.
      // Each hangs from the live anchor at the frame's `at`, so its position stays frame-local.
      nodes: graph.nodes.map((n) => ({ ...n, parentId: LIVE_ANCHOR_ID, zIndex: liveZ(n.zIndex ?? 0), className: n.className ? `${n.className} board-ts-${textSize}` : `board-ts-${textSize}` })),
      edges: graph.edges.map((e) => ({ ...e, zIndex: liveZ(e.zIndex ?? 0) })),
    }),
    [graph, textSize],
  );
  // Manual z drops React Flow's own lift of a selected shape: it is lifted here, above the live band's own levels and
  // still under the sketches.
  const liveNodes = useMemo(() => {
    if (selected.length === 0) return liveBase.nodes;
    const picked = new Set(selected);
    return liveBase.nodes.map((n) => (picked.has(n.id) ? { ...n, zIndex: LIVE_LIFT } : n));
  }, [liveBase, selected]);
  const paneOpen: FramePane | null = side.hidden ? null : side.tab === "assistant" ? "assistant" : "editor";
  const frameActs = useRef({ select: (_b: FrameBox) => {}, pane: (_t: FramePane, _b?: FrameBox) => {}, problems: (_b: FrameBox) => {}, zoom: (_b: FrameBox) => {} });
  /**
   * Each frame's wrapped box node as last made, by id: the same object while the scene's box node and what its tab
   * shows are the same, so a keystroke in one frame hands React Flow 49 unchanged frame nodes.
   */
  const frameNodeMemo = useRef(
    new Map<string, { src: Node; selected: boolean; pane: FramePane | null; pending: number; draggable: boolean; near: string; node: Node }>(),
  );
  const pendingByKey = ai.pendingByKey;
  /** Each frame's box node with what its tab needs; its title tab drags it. */
  const frameNodes = useMemo(() => {
    const memo = frameNodeMemo.current;
    if (!board) {
      memo.clear();
      return [];
    }
    const seen = new Set<string>();
    // The boxes by their left edge, once per build: each frame's tab neighbours are read from it (`tabNeighbours`).
    const byX = byLeft(board.boxes);
    const out = board.nodes.map((n) => {
      if (n.type !== "boardFrame") return n;
      seen.add(n.id);
      const box = (n.data as { box: FrameBox }).box;
      // A frame picked and waiting for its paint is drawn selected at once.
      const shown = pendingFrame ?? frameSel;
      const selected = !!shown && shown.index === box.index && shown.title === box.title;
      // The only frame of a sequence, mind map or timeline keeps no positions: a drag would move nothing.
      const draggable = !ai.locked && box.key !== null && !(board.boxes.length === 1 && !!box.kind && FIXED_KINDS.has(box.kind));
      // The tabs to its right, which end its strip's room (coordinator ruling on F1); kept while they stay put.
      const neighbours = tabNeighbours(box, byX);
      const near = neighbours.map((t) => `${t.dx},${t.dy}`).join(" ");
      // Each frame's own waiting count on its AI Chat tab: a board frame's by its key, a new frame's from the scene.
      const pending = box.key !== null ? (pendingByKey.get(box.key) ?? 0) : ((n.data as { pending?: number }).pending ?? 0);
      const was = memo.get(n.id);
      if (was && was.src === n && was.selected === selected && was.pane === paneOpen && was.pending === pending && was.draggable === draggable && was.near === near)
        return was.node;
      const data: FrameNodeData = {
        ...(n.data as { box: FrameBox; faded?: boolean }),
        selected,
        pane: paneOpen,
        pending,
        neighbours: was?.near === near ? (was.node.data as FrameNodeData).neighbours : neighbours,
        onSelect: () => frameActs.current.select(box),
        onPane: (tab) => frameActs.current.pane(tab, box),
        onProblems: () => frameActs.current.problems(box),
        onZoom: () => frameActs.current.zoom(box),
      };
      const node: Node = {
        ...n,
        data,
        dragHandle: ".board-frame-tab",
        draggable,
        // The box takes no clicks; its tab does (FrameNode). FlowTab says which frame a click on the canvas is for.
        style: { ...n.style, pointerEvents: "none" as const },
      };
      memo.set(n.id, { src: n, selected, pane: paneOpen, pending, draggable, near, node });
      return node;
    });
    if (memo.size > seen.size) for (const id of memo.keys()) if (!seen.has(id)) memo.delete(id);
    return out;
  }, [board, frameSel, pendingFrame, paneOpen, pendingByKey, ai.locked]);
  /**
   * The review bar's frames: the touched frames' titles in text order, their union on the board (the bar
   * adds their tabs at the live zoom), and the sum of their counts, which Ask shows. Null when nothing
   * would land.
   */
  const reviewed = useMemo(() => {
    const review = ai.review;
    if (!review) return null;
    const titles = [...review].filter(([, r]) => r.count > 0).map(([t]) => t);
    const sum = [...review.values()].reduce((n, r) => n + r.count, 0);
    const boxes = frameNodes.flatMap((n) => (n.type === "boardFrame" && (n.data as FrameNodeData).pending > 0 ? [(n.data as FrameNodeData).box] : []));
    if (boxes.length === 0) return { titles, sum, rect: null };
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const rect = { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
    return { titles, sum, rect };
  }, [ai.review, frameNodes]);
  const reviewSum = reviewed?.sum ?? null;
  // The review bar's words, announced once as a review starts, in a polite region that stays in the page (one put in
  // with its words is often missed); cleared after a while so browse mode does not read them twice (react-aria's
  // announcer).
  const [reviewSaid, setReviewSaid] = useState("");
  const reviewedRef = useRef(reviewed);
  reviewedRef.current = reviewed;
  const reviewStart = ai.waiting?.step === "review" && (reviewed?.sum ?? 0) > 0 ? ai.waiting.messageAt : null;
  useEffect(() => {
    const r = reviewedRef.current;
    if (reviewStart === null || !r) {
      setReviewSaid("");
      return;
    }
    setReviewSaid(reviewText(r.titles, r.sum));
    const t = setTimeout(() => setReviewSaid(""), REVIEW_SAID_MS);
    return () => clearTimeout(t);
  }, [reviewStart]);
  /** Accept or Reject from the bar: the focused button goes with the bar, so focus goes back to the canvas (Figma). */
  const fromBar = (act: () => void) => () => {
    const back = !!(document.activeElement as Element | null)?.closest?.(".board-review");
    act();
    if (back) canvasEl.current?.focus({ preventScroll: true });
  };
  const canvasNodes = useMemo(() => (liveBox ? [...frameNodes, ...liveNodes] : frameNodes), [frameNodes, liveNodes, liveBox]);
  const canvasEdges = useMemo(() => (liveBox ? [...(board?.edges ?? []), ...liveBase.edges] : (board?.edges ?? [])), [board, liveBase, liveBox]);

  /**
   * Publish: a board of several frames, or with sketches, opens on its source, on `part` when
   * that part is on, else on the part the selection asks for; a board of one frame and no sketch publishes as one
   * diagram did, from its live drawing or, with nothing selected, from frame 0's doc and layout entry. Cloud icons
   * are loaded from the pack and embedded as images; the icon sketches' titles are read once here.
   */
  async function openPublish(part?: BoardPart) {
    // Publish is another action: a pick ends with no write (N1).
    rel.endModes(true);
    const p = parsedRef.current;
    const b = boardRef.current;
    if (!p || !b) return;
    const mine = ++publishInkSeq.current;
    // The visible part of the canvas, in board units.
    let screenBox: SceneBox = { x: 0, y: 0, w: 0, h: 0 };
    const r = canvasEl.current?.getBoundingClientRect();
    const f = instance.current;
    if (r && f && r.width > 0 && r.height > 0) {
      const a = f.screenToFlowPosition({ x: r.x, y: r.y });
      const c = f.screenToFlowPosition({ x: r.x + r.width, y: r.y + r.height });
      screenBox = { x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y };
    }
    const board = doc.board;
    const frames = p.result.frames;
    if (frames.length > 1 || board.sketches.length > 0) {
      const live = b.live !== null;
      const lay = layoutRef.current;
      const input = boardPublishInput({
        frames,
        board,
        keys: p.keys,
        boxes: b.boxes,
        frameIndex: b.live?.index ?? null,
        live: live ? { layout: lay, folded, textScale: TEXT_SCALE[frameSettingsRef.current.textSize], notation: frameSettingsRef.current.notation } : null,
        shapes: live ? selectedRef.current : [],
        sketchIds: sketchSelRef.current,
        onScreen: screenBox,
      });
      if (input.frames.length === 0 && input.sketches.length === 0) return;
      const iconSketches = [...new Set(input.sketches.flatMap((k) => (k.kind === "icon" && k.icon ? [k.icon] : [])))];
      const [titles, icons] = await Promise.all([Promise.all(iconSketches.map(async (n) => [n, await iconTitleOf(n)] as const)), loadSceneIcons(boardIconNames(input), "light")]);
      if (mine !== publishInkSeq.current) return;
      const full: BoardPublishInput = { ...input, iconTitles: new Map(titles) };
      const source = boardSource(full, icons, "light", part);
      setPublishing({ source, input: full, ...(part ? { part } : {}), byTheme: { light: source } });
      return;
    }
    // One frame and no sketch: one diagram's scene, as before boards.
    const d = drawnRef.current;
    let build: (icons: Awaited<ReturnType<typeof loadSceneIcons>>) => Scene;
    let names: string[];
    // The scene is in the live frame's own units.
    let onScreen = { ...screenBox, ...toLive(screenBox) };
    if (d && b.live) {
      const { nodes, style, axes } = layoutRef.current;
      const shut = folded;
      const opts = sceneOpts();
      // A folded topic publishes folded, as the canvas shows it; the frame's text size and notation as drawn.
      build = (icons) => flowScene(d, nodes, style, icons, axes, shut, opts);
      names = sceneIconNames(d);
    } else {
      // Nothing live (Esc or a click outside): frame 0's drawing, from its doc (or its last good one) and its entry.
      const f0 = frames[0];
      const d0 = f0 ? (f0.doc ?? f0.lastValid) : null;
      if (!d0) return;
      const key = p.keys[0];
      if (key === undefined) return;
      const view = frameLayoutView(board, key, d0.kind);
      const e = board.frames.get(key);
      const k = TEXT_SCALE[e?.textSize ?? "m"];
      const opts = { ...(k !== 1 ? { textScale: k } : {}), ...(e?.notation === "arrow" ? { notation: "arrow" as const } : {}) };
      build = (icons) => flowScene(d0, view.nodes, view.style, icons, view.axes, undefined, opts);
      names = sceneIconNames(d0);
      // The scene is in the frame's own units: the board less the frame's place.
      const at = e?.at ?? { x: 0, y: 0 };
      onScreen = { ...screenBox, x: screenBox.x - at.x, y: screenBox.y - at.y };
    }
    const icons = await loadSceneIcons(names, "light");
    if (mine !== publishInkSeq.current) return;
    setPublishing({ scene: build(icons), onScreen, names, build });
  }

  /**
   * The Publish dialog's theme changed: the icons are inked again for it, and the drawing is made with them. On a board
   * a theme already made gives its source back (a toggle back is the dialog's cached drawing); the latest choice wins.
   */
  async function repaintPublishIcons(theme: ExportTheme) {
    const p = publishingRef.current;
    if (!p) return;
    const mine = ++publishInkSeq.current;
    if ("source" in p) {
      const made = p.byTheme[theme];
      if (made) {
        setPublishing((q) => (q && "source" in q && q.input === p.input ? { ...q, source: made } : q));
        return;
      }
      const icons = await loadSceneIcons(boardIconNames(p.input), theme);
      if (mine !== publishInkSeq.current) return;
      const source = boardSource(p.input, icons, theme, p.part);
      setPublishing((q) => (q && "source" in q && q.input === p.input ? { ...q, source, byTheme: { ...q.byTheme, [theme]: source } } : q));
      return;
    }
    const icons = await loadSceneIcons(p.names, theme);
    if (mine !== publishInkSeq.current) return;
    setPublishing((q) => (q && "scene" in q && q.build === p.build ? { ...q, scene: p.build(icons) } : q));
  }

  /** The selected frame's text size and ER notation, for Publish. */
  function sceneOpts(): { textScale?: number; notation?: "arrow" } {
    const s = frameSettingsRef.current;
    return { ...(TEXT_SCALE[s.textSize] !== 1 ? { textScale: TEXT_SCALE[s.textSize] } : {}), ...(s.notation === "arrow" ? { notation: "arrow" as const } : {}) };
  }

  // A name the drawing does not hold (an add on broken text, a node removed by typing) is not kept selected,
  // so the strip and Delete never act on a node you cannot see. A node that faded out for a delete lets go
  // of its fade once it is gone.
  useEffect(() => {
    if (!drawn) return;
    const names = new Set(drawn.nodes.map((n) => n.name));
    setSelected((prev) => (prev.every((n) => names.has(n)) ? prev : prev.filter((n) => names.has(n))));
    setStates((prev) => {
      const gone = [...prev].filter(([n, s]) => s === "leaving" && !names.has(n));
      if (gone.length === 0) return prev;
      const next = new Map(prev);
      for (const [n] of gone) next.delete(n);
      return next;
    });
    // Each parse, not only a new drawing: a faded drawing stays the same object while the text changes.
  }, [drawn, parsed]);

  // N-B: a line typed away from the text takes its kept axis with it (outside the history), so a line drawn again
  // between the same shapes starts with none. Canvas deletes drop theirs in their own undo step.
  useEffect(() => {
    const links = parsed?.result.doc?.links;
    const axes = layoutRef.current.axes;
    if (!links || !axes) return;
    const live = new Set(links.map((l) => axisKey(l.from, l.to)));
    const gone = Object.keys(axes).filter((k) => !live.has(k));
    if (gone.length) doc.dropAxes(gone);
  }, [parsed, doc.dropAxes]);

  // a selected loop is named by its index: a new drawing, or another pick, lets it go.
  useEffect(() => {
    setLoopSel(null);
    lastTab.current = null;
  }, [drawn]);
  useEffect(() => {
    if (selected.length > 0 || lines.length > 0) setLoopSel(null);
  }, [selected, lines]);
  // A line names a link by its index in one drawing: a new drawing lets the selected lines go.
  // The line bar's own edits keep their line selected, so its next pick lands on the same line.
  const keepLine = useRef<string | null>(null);
  useEffect(() => {
    const keep = keepLine.current;
    keepLine.current = null;
    setLines((prev) => (prev.length === 0 || (keep !== null && prev.length === 1 && prev[0] === keep) ? prev : []));
  }, [drawn]);
  // a shape or a line picked lets the selected group go, as does the group leaving the drawing.
  useEffect(() => {
    if (selected.length > 0 || lines.length > 0) setGroupSel(null);
  }, [selected, lines]);
  useEffect(() => {
    const g = groupSelRef.current;
    if (g !== null && drawn && !groupContents(drawn, g)) {
      setGroupSel(null);
      setGroupAsk(null);
    }
  }, [drawn]);

  // A new node is drawn at 96 percent and transparent, then let go after it has painted, so it fades in.
  useEffect(() => {
    const ready = [...states].filter(([n, s]) => s === "entering" && graph.nodes.some((g) => g.id === n)).map(([n]) => n);
    if (ready.length === 0) return;
    return afterPaint(() =>
      setStates((prev) => {
        const next = new Map(prev);
        for (const n of ready) if (next.get(n) === "entering") next.delete(n);
        return next;
      }),
    );
  }, [graph, states]);

  // The label box names a link by its index in one parse's text: a newer parse closes it (Task 6 carry).
  useEffect(() => {
    if (labelBox && !labelBox.link && parsed && parsed.result.version > labelBox.version) setLabelBox(null);
  }, [parsed, labelBox]);

  /** Glides nodes from where they are drawn to their new places over the motion's duration (a jump at 0). */
  const glideTo = useCallback((from: Positions, to: Positions, key: MotionKey) => {
    stopGlide.current();
    stopGlide.current = () => {};
    const a = emptyPositions();
    const b = emptyPositions();
    for (const k of Object.keys(to)) {
      if (!hasOwn(from, k) || (from[k].x === to[k].x && from[k].y === to[k].y)) continue;
      a[k] = from[k];
      b[k] = to[k];
    }
    const ms = motionMs(key);
    if (ms === 0 || Object.keys(b).length === 0) {
      setGlide(null);
      return;
    }
    const frame = glideFrames(a, b, drawnRef.current?.groups ?? [], graphRef.current.nodes);
    setGlide(frame(0));
    stopGlide.current = tween(
      ms,
      (p) => setGlide(frame(p)),
      () => {
        stopGlide.current = () => {};
        setGlide(null);
      },
    );
  }, [setGlide]);

  // Undo and redo glide nodes back over a short move; undo says what it put back. A move in another frame selects
  // and shows that frame, and the canvas glides to it (Review Focus 3).
  useEffect(
    () =>
      doc.onHistoryMove(({ from, to, undo: undoing, frame }) => {
        const sel = doc.selection();
        const selKey = sel ? docKeys.current[sel.index] : undefined;
        if (frame !== selKey) {
          const box = boardRef.current?.boxes.find((b) => b.key === frame);
          if (box) switchFrame({ title: box.title, index: box.index }, [], (live) => latestActs.current.glideToFrame(live));
          return;
        }
        glideTo(from, to, "undo");
        if (!undoing) return;
        const moved = Object.keys(to).filter((k) => hasOwn(from, k) && (from[k].x !== to[k].x || from[k].y !== to[k].y));
        if (moved.length === 0) return;
        setNote({ text: moved.length === 1 ? `Moved ${moved[0]} back` : `Moved ${moved.length} nodes back`, key: Date.now() });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.onHistoryMove, glideTo],
  );

  /** A node just added fades in, unless motion is off. */
  const enter = useCallback((name: string) => {
    if (motionMs("enter") === 0) return;
    setStates((prev) => new Map(prev).set(name, "entering"));
  }, []);

  /**
   * The band seam for canvas edits: the line an edit wrote, by its offset, banded in the pane until the text
   * changes again, the selection changes or the frame does. Selected shapes band their own lines below.
   */
  const [written, setWritten] = useState<{ line: number; doc: unknown } | null>(null);
  const bandWritten = (at: number | undefined) => {
    const v = doc.view();
    if (!v || at === undefined) return;
    setWritten({ line: v.state.doc.lineAt(Math.min(at, v.state.doc.length)).number, doc: v.state.doc });
  };
  useEffect(() => setWritten(null), [selected]);

  // Selecting nodes bands their lines in the current text.
  useEffect(() => {
    if (selected.length === 0) {
      setBandLines([]);
      return;
    }
    let live = true;
    void doc.linesOf(selected).then((lines) => {
      if (!live || !lines) return;
      setBandLines(selected.map((n) => lines[n]).filter((l): l is number => typeof l === "number"));
    });
    return () => {
      live = false;
    };
  }, [selected, parsed, doc.linesOf]);

  /** A click on a line selects the node defined there; a line with no node leaves the selection. */
  const onLineClick = useCallback(
    async (line: number) => {
      // A pick in the text never makes the relationship: it ends the mode.
      relRef.current?.endModes(true);
      const names = drawnRef.current?.nodes.map((n) => n.name) ?? [];
      if (names.length === 0) return;
      const at = doc.frameIdNow();
      const lines = await doc.linesOf(names);
      // A switch meanwhile: the names were the frame left's.
      if (doc.frameIdNow() !== at) return;
      const hit = lines ? names.find((n) => lines[n] === line) : undefined;
      if (hit !== undefined) setSelected([hit]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.linesOf],
  );

  const drawnIds = useRef<ReadonlySet<string>>(new Set());
  drawnIds.current = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);
  const onSelect = useCallback((ids: string[]) => {
    // Sketches are picked with the shapes (a click, Shift or Ctrl + click, a box); they are held apart, by sketch id.
    const sketches = ids.filter(isSketchNodeId).map((id) => sketchIdOf(id)!);
    setSketchSel((prev) => (prev.length === sketches.length && prev.every((p, i) => p === sketches[i]) ? prev : sketches));
    const nodes = ids.filter((id) => !id.startsWith("\u0000"));
    const r = relRef.current;
    r?.pickWhileLinking(nodes);
    // A pick of nothing or of several ends "Make a relationship from here"; one table's press is the card's to take.
    if (r?.pick && nodes.length !== 1) r.endModes(true);
    // A Shapes item waiting for its shape takes this pick (draw.io's connect mode); a card the pointer began to
    // drag selects itself at the drag's start, and that is a move, not a pick (the click that ends it is swallowed).
    if (!erDragged.current) pickForShapeRef.current(nodes);
    const pm = pickedMemberRef.current();
    if (pm && !(nodes.length === 1 && nodes[0] === pm.node)) setKindEditRef.current(null);
    setSelected((prev) => {
      if (prev.length === nodes.length && prev.every((p, i) => p === nodes[i])) return prev;
      // A node just added or renamed is selected before it is drawn: the canvas cannot hold it yet, so its
      // report without it is not a new pick.
      const dropped = prev.filter((p) => !nodes.includes(p));
      if (nodes.every((n) => prev.includes(n)) && dropped.every((d) => !drawnIds.current.has(d))) return prev;
      return nodes;
    });
  }, []);

  /** The start of a drag: what the dragged node can line up with, and the group areas around the others. */
  const startDrag = useCallback((id: string): DragInfo => {
    const nodes = graphRef.current.nodes.filter((n) => !isArea(n.id));
    const me = nodes.find((n) => n.id === id);
    const others = nodes.filter((n) => n.id !== id).map((n) => ({ id: n.id, box: boxOfNode(n) }));
    const d = drawnRef.current;
    let groups: DragInfo["groups"] = [];
    let parent: string | null = null;
    if (d && d.groups.length > 0) {
      const without = new Map(others.map((o) => [o.id, o.box] as const));
      // A group the node is alone in keeps its area where it was, so a small drag does not leave it.
      const withMe = new Map(without);
      if (me) withMe.set(id, boxOfNode(me));
      // An empty group (or one this node is alone in) keeps the area drawn now.
      const drawnArea = (name: string) => {
        const a = graphRef.current.nodes.find((n) => n.id === `\u0000group:${name}`);
        return a ? boxOfNode(a) : undefined;
      };
      const alone = groupBoxes(d.groups, withMe, drawnArea);
      const rest = new Map(groupBoxes(d.groups, without, drawnArea).map((g) => [g.name, g]));
      groups = alone.map((g) => rest.get(g.name) ?? g);
      parent = parentOf(d.groups, id);
    }
    return { lead: id, size: { w: me?.initialWidth ?? 0, h: me?.initialHeight ?? 0 }, moving: new Set([id]), others, groups, parent };
  }, []);

  // Each frame of a drag: the group it would join (the canvas draws the alignment guides).
  const onDrag = useCallback(
    (id: string, x: number, y: number) => {
      if (isSketchNodeId(id)) return sketchDraggedRef.current(id, x, y);
      if (isArea(id)) return;
      const d = drag.current ?? (drag.current = startDrag(id));
      if (id !== d.lead) {
        d.moving.add(id);
        return;
      }
      const at = { x, y, ...d.size };
      const hot = d.moving.size === 1 ? groupAt(centre(at), d.groups) : null;
      overlay.set({ hot: hot === null ? null : (d.groups.find((g) => g.name === hot)?.box ?? null) });
    },
    [overlay, startDrag],
  );

  // A drag reports each moved node at once: they are one move, one undo entry. Released, the nodes settle into
  // their grid cells; a node let go over another group joins it, and outside its own leaves it (one entry too).
  const pendingMove = useRef<Positions | null>(null);
  /** Ctrl+drag's clone, set each render (it pastes through the latest state). */
  const cloneTo = useRef<(ids: string[], at: Positions, sketches?: SketchChange[]) => void>(() => {});
  const flushMove = useCallback(() => {
    const p = pendingMove.current;
    pendingMove.current = null;
    const copies = dropCopies.current;
    dropCopies.current = false;
    const d = drag.current;
    drag.current = null;
    overlay.set({ hot: null });
    // The sketches let go in the same drag: the same transaction as the shapes, one undo entry.
    const sk = takeSketchMovesRef.current(copies);
    if (!p && sk.length > 0) doc.move({}, undefined, sk);
    if (!p || aiLock.current) return;
    // A Ctrl+drag of shapes and sketches is one copy: the sketch copies ride the shapes' paste, one undo entry.
    const sketchCopies = copies ? sk : [];
    const snapped = emptyPositions();
    for (const k of Object.keys(p)) snapped[k] = { x: snap(p[k].x), y: snap(p[k].y) };
    const ids = Object.keys(p);
    // Ctrl+drag: the originals stay, copies land where the drag let go (draw.io).
    if (copies) {
      cloneTo.current(ids, snapped, sketchCopies);
      return;
    }
    if (d && ids.length === 1 && ids[0] === d.lead && (d.groups.length > 0 || d.parent !== null)) {
      const target = groupAt(centre({ ...p[d.lead], ...d.size }), d.groups);
      if (target !== d.parent) {
        // The group it leaves empty stays drawn where it was: its place is kept in the same undo step.
        const left = d.parent !== null ? findGroup(drawnRef.current?.groups ?? [], d.parent) : null;
        const keep = left && left.nodes.length === 1 && left.groups.length === 0 ? d.groups.find((g) => g.name === d.parent)?.box : undefined;
        const move = keep && d.parent !== null ? { ...snapped, [d.parent]: { x: keep.x, y: keep.y } } : snapped;
        const started = doc.frameIdNow();
        // An awaited commit: a frame switch meanwhile waits for it, so the drop lands in its own frame.
        trackCommit(
          doc.run({ op: "moveToGroup", name: d.lead, group: target }, { frame: started, move, sketches: sk }).then((r) => {
            // Refused, the move is kept alone; dropped because another frame was selected, nothing is written there.
            if (!r && doc.frameIdNow() === started) doc.move(snapped, undefined, sk);
            glideTo(p, snapped, "settle");
          }),
        );
        return;
      }
    }
    doc.move(snapped, undefined, sk);
    glideTo(p, snapped, "settle");
  }, [doc.move, doc.run, overlay, glideTo]);
  const onMove = useCallback(
    (id: string, x: number, y: number, copy?: boolean) => {
      if (isSketchNodeId(id)) {
        if (copy) dropCopies.current = true;
        pendingSketchMove.current.set(sketchIdOf(id)!, { x, y });
        if (!pendingMove.current && pendingSketchMove.current.size === 1) queueMicrotask(flushMove);
        return;
      }
      if (id.startsWith("\u0000")) return;
      if (copy) dropCopies.current = true;
      // Released: the group's "drop here" goes at once.
      overlay.set({ hot: null });
      if (!pendingMove.current) {
        pendingMove.current = emptyPositions();
        queueMicrotask(flushMove);
      }
      pendingMove.current[id] = { x, y };
    },
    [flushMove, overlay],
  );
  // Closing the tab mid-move keeps the move: layout cleanups run before the document's save-on-close.
  useLayoutEffect(() => () => flushMove(), [flushMove]);

  /** Where a new node goes: the middle of the view, on the grid. */
  function viewCentre(kindOfNode: FlowNodeKind, nodeName: string): { x: number; y: number } {
    const s = nodeSize(drawnKind(kindOfNode, kind), look, nodeName);
    const rect = canvasEl.current?.getBoundingClientRect();
    const at = instance.current && rect ? toLive(instance.current.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })) : { x: 0, y: 0 };
    return { x: snap(at.x - s.w / 2), y: snap(at.y - s.h / 2) };
  }

  /**
   * S5: the participant a new one added at `at` goes before, so it lands in the nearest gap between participants (as
   * Software Ideas Modeler); undefined past the last one.
   */
  function participantAfter(at: Point): string | undefined {
    const lifelines = new Set(drawnRef.current?.nodes.filter((d) => d.kind === "participant" || d.kind === "actor").map((d) => d.name));
    const placed = graphRef.current.nodes
      .filter((n) => lifelines.has(n.id))
      .map((n) => ({ id: n.id, mid: n.position.x + (n.initialWidth ?? 0) / 2 }))
      .sort((a, b) => a.mid - b.mid);
    return placed.find((p) => p.mid > at.x)?.id;
  }

  /**
   * A key or a tool opens the new shape with its name ready, written only when the name is kept. False when nothing
   * was opened (refused with its note in the strip). An ER table opens its own field at `at`, else in the middle of the
   * view (B3 decision 9, R13): every ER table add comes through here.
   */
  function add(tool: AddTool, at?: Point): boolean | Promise<boolean> {
    if (aiLock.current) return false;
    if (!kind || tool.kind === "group") return false;
    // An ER table opens its field, which refuses as every ER gesture does (`erRefusal`): an old-form frame takes no
    // edit until it is rewritten as table blocks.
    if (kind === "er") return openNewTable(at ?? viewMiddleFlow(), tool.kind === "weak" ? "weak" : null);
    return addShape(toolKind(tool), at);
  }

  /** The middle of the view, in the live frame's units. */
  function viewMiddleFlow(): Point {
    const rect = canvasEl.current?.getBoundingClientRect();
    return instance.current && rect ? toLive(instance.current.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })) : { x: 0, y: 0 };
  }

  /**
   * B3 decision 9 (R13, R14): the new table's field at `at` (its header's middle under it, on whole pixels), under the
   * next free name. True once it is open: nothing is written until the name is kept.
   */
  function openNewTable(at: Point, tableKind: "weak" | null): boolean {
    // The lock in an add's words, then an old-form frame before the stale note: an old-form frame whose rewrite was
    // undone still draws its last good drawing (final review I3).
    const no = erRefusal(erGate, { locked: ER_MESSAGES.lockedAdd });
    if (no) {
      setNotice(no.note);
      return false;
    }
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    setNotice(null);
    setSelected([]);
    setLines([]);
    setNewTable({ at: { x: Math.round(at.x - 92), y: Math.round(at.y - 16) }, kind: tableKind, name: sqlFreeName(tableKind ?? "table", known ? namesOf(known) : [], 1) });
    return true;
  }

  /** The new table's name is kept: its line and its place are one edit; Enter or Tab goes on to its first column. */
  async function commitNewTable(e: NonNullable<typeof newTable>, value: string, how: CommitHow) {
    const refuse = (error: string) => {
      if (newTableRef.current === e) setNewTable({ ...e, name: value, error, tries: (e.tries ?? 0) + 1 });
    };
    if (newTableRef.current !== e) return;
    // A click away from the name as it was offered adds nothing (decision 9: an untouched click away writes nothing).
    if (how === "blur" && value === e.name && !e.error) {
      setNewTable(null);
      return;
    }
    if (aiLock.current) return refuse(EDIT_MESSAGES.locked);
    if (staleRef.current) return refuse(EDIT_MESSAGES.stale);
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    const other = known?.nodes.find((n) => n.name.toLowerCase() === value.toLowerCase());
    const bad = !value ? ER_MESSAGES.tableNeedsName : !isColumnName(value) ? ER_MESSAGES.plainName : other ? (other.name === value ? ER_MESSAGES.tableTaken(value) : ER_NOTES.caseTaken(other.name)) : "";
    if (bad) return refuse(bad);
    const g = gestureFrame();
    let why: string | null = null;
    const r = await doc.run({ op: "addNode", name: value, kind: e.kind }, { move: { [value]: e.at }, onRefused: (w) => (why = w), frame: g.frame });
    // Another frame was selected meanwhile: its reset closed the field, and this frame keeps nothing.
    if (!g.still()) return;
    if (!r) return refuse(why ?? EDIT_MESSAGES.changed);
    if (newTableRef.current === e) setNewTable(null);
    bandWritten(r.at);
    setSelected([value]);
    if (how === "enter" || how === "tab") er.value.api.firstColumn(value);
    else if (how !== "blur") canvasEl.current?.focus({ preventScroll: true });
  }

  /** "Open as DBML": the ER diagram's tables and relationships as an unsaved Schema Model under the diagram's name. */
  function openDbml() {
    const text = doc.view()?.state.doc.toString() ?? parsedRef.current?.text ?? null;
    const dbml = text === null ? null : openAsDbml(text, frameSelRef.current?.index ?? 0, name);
    if (dbml === null) return setNotice(EDIT_MESSAGES.stale);
    onOpenModel?.(name, dbml);
  }

  /** Opens the icon picker for a service, under the strip's Choose icon button (or the top of the canvas). */
  function openPicker(node: string) {
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    const current = known?.nodes.find((n) => n.name === node)?.attrs.icon ?? "";
    const anchor = chooseIcon.current?.getBoundingClientRect() ?? canvasEl.current?.getBoundingClientRect();
    const width = 292;
    const left = anchor ? Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)) : 8;
    const top = anchor ? (chooseIcon.current ? anchor.bottom + 4 : anchor.top + 56) : 8;
    setPicker({ target: { node }, initial: current, at: { left, top } });
  }

  /** Opens the icon picker in the text, under the `icon:` just typed at `pos`. */
  function openTextPicker(pos: number) {
    const view = doc.view();
    let c: { left: number; bottom: number } | null = null;
    try {
      c = view?.coordsAtPos(pos) ?? null;
    } catch {
      c = null;
    }
    const width = 292;
    const left = c ? Math.max(8, Math.min(c.left, window.innerWidth - width - 8)) : 8;
    setPicker({ target: { pos }, initial: "", at: { left, top: c ? c.bottom + 4 : 8 } });
  }

  /** Focus goes back where the picker was opened from: the text, or the canvas. */
  function closePicker() {
    const p = picker;
    setPicker(null);
    if (p && "pos" in p.target) doc.view()?.focus();
    else canvasEl.current?.focus();
  }

  /**
   * The picked icon: on the canvas it goes into the service's brackets (one text edit, one undo entry); in the text
   * it is written after `icon:`, over a name already there, and typing goes on after it.
   */
  async function pickIcon(icon: string) {
    const p = picker;
    closePicker();
    if (!p || aiLock.current) return;
    setNotice(null);
    if ("node" in p.target) {
      await doc.run({ op: "setAttr", name: p.target.node, key: "icon", value: icon });
      return;
    }
    const view = doc.view();
    if (!view) return;
    const s = view.state.doc.toString();
    const pos = Math.min(p.target.pos, s.length);
    let to = pos;
    while (to < s.length && s[to] === " ") to++;
    while (to < s.length && /[A-Za-z0-9-]/.test(s[to])) to++;
    const insert = `${s[pos - 1] === ":" ? " " : ""}${icon}`;
    view.dispatch({ changes: { from: pos, to, insert }, selection: { anchor: pos + insert.length }, userEvent: "input.complete" });
    view.focus();
  }

  /**
   * C1 (board DiagramEditInPlace; Windows Explorer's New folder, Figma): G or Ctrl+G on the selection draws the new
   * group with its name selected. Nothing is written until the name is kept; then the group's lines and each shape
   * moved in are one batch, one undo step. Esc on the untouched name groups nothing.
   */
  function groupSelected() {
    if (aiLock.current || !kind) return;
    setNotice(null);
    const word = GROUP_WORD[kind];
    if (!word) return;
    if (staleRef.current) {
      setNotice(kind === "cloud" ? "Couldn't group these services. Fix the text first." : LINK_NOTES.broken);
      return;
    }
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    const names = known ? selectedRef.current.filter((n) => known.nodes.some((x) => x.name === n && x.kind !== "note")) : [];
    if (!known || names.length === 0) {
      setNotice(kind === "cloud" ? "Select the services to group first." : `Select the shapes to put in the ${word.toLowerCase()} first (drag a box or Shift+click), then Ctrl+G.`);
      return;
    }
    const parents = new Set(names.map((n) => parentOf(known.groups, n)));
    const parent = parents.size === 1 ? [...parents][0] : null;
    openField({ kind: "newgroup", members: names, parent, name: freeName(word, namesOf(known)), word });
  }

  // ----- Add the next shape (board DiagramAddNext)

  /** The kind a tool adds: a flowchart's start, or its end once it has a start. */
  function toolKind(tool: AddTool): FlowNodeKind {
    if (tool.kind !== "terminal") return tool.kind as FlowNodeKind;
    return drawnRef.current?.nodes.some((n) => n.kind === "start") ? "end" : "start";
  }

  /** The name a new shape of `nodeKind` starts with: `Step`, then `Step 2`. */
  function newName(nodeKind: FlowNodeKind): string {
    const tool = kind ? ADD_TOOLS[kind].find((t) => t.kind === nodeKind || (t.kind === "terminal" && (nodeKind === "start" || nodeKind === "end"))) : undefined;
    const base = nodeKind === "end" ? "End" : (tool?.base ?? BASE_NAME[nodeKind] ?? nounOf(nodeKind).replace(/^./, (c) => c.toUpperCase()));
    if (nodeKind === "note") return base;
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    // An ER table's free name is a plain SQL name, numbered from 1 (table_1), as the writer numbers one.
    if (kind === "er") return sqlFreeName(base, known ? namesOf(known) : [], 1);
    return freeName(base, known ? namesOf(known) : new Set());
  }

  /** How big a new shape is drawn with its first name. */
  function newSize(nodeKind: FlowNodeKind, name: string): { w: number; h: number } {
    return nodeSize(drawnKind(nodeKind, kind, name), look, name, nextId(drawnRef.current, nodeKind), nodeKind === "note" ? { text: name } : nodeKind === "topic" ? { depth: 1 } : undefined);
  }

  /** The shapes drawn now, by name (group areas aside). */
  function placedBoxes(): Map<string, Box> {
    const out = new Map<string, Box>();
    for (const n of graphRef.current.nodes) if (!isArea(n.id)) out.set(n.id, boxOfNode(n));
    return out;
  }

  /** A ghost of a new shape with its name selected; nothing is written until the name is kept (Esc adds nothing). */
  function openNew(spec: Omit<Extract<FieldEdit, { kind: "new" }>, "kind">) {
    setNotice(null);
    setLines([]);
    setSelected([]);
    openField({ kind: "new", ...spec });
  }

  /**
   * F17: the next shape from `src` on side `dir` (a + click, or Alt+Shift+arrow): of the same kind, one layout gap
   * away and centred on it, or the first free spot along that side (placeNext).
   */
  function addNext(src: string, dir: Side) {
    if (aiLock.current || !kind || !PLUS_KINDS.has(kind)) return;
    if (staleRef.current) {
      setNotice(LINK_NOTES.broken);
      return;
    }
    const d = drawnRef.current;
    const n = d?.nodes.find((x) => x.name === src);
    const boxes = placedBoxes();
    const from = boxes.get(src);
    if (!d || !n || !from) return;
    if (n.kind === "note" || isStateEnd(src)) {
      setNotice(n.kind === "note" ? "A note takes no lines." : "The end takes no lines out of it.");
      return;
    }
    const nodeKind: FlowNodeKind = isStateStart(src) ? "state" : n.kind;
    const name = newName(nodeKind);
    const size = newSize(nodeKind, name);
    const pairs: [Box, Box][] = [];
    for (const l of d.links) {
      const a = boxes.get(l.from);
      const b = boxes.get(l.to);
      if (a && b) pairs.push([a, b]);
    }
    const [, vy] = DIRS[dir];
    const gap = layoutGap(pairs, vy ? "v" : "h");
    // A group the new shape will not join is kept clear, so it never looks inside it.
    const mine = new Set<string>();
    for (let g = parentOf(d.groups, src); g; g = parentOf(d.groups, g)) mine.add(g);
    const avoid = groupBoxes(d.groups, boxes)
      .filter((g) => !mine.has(g.name))
      .map((g) => g.box);
    const at = placeNext({ src: from, dir, size, gap, boxes: [...boxes.values()], avoid });
    if (!at) {
      setNotice(`No room on that side for another ${nounOf(nodeKind, kind)}.`);
      return;
    }
    // Lined up with its source (not slid): the alignment guide through both middles (board DiagramAddNext).
    const lined = at.slid === 0 && at.out === 0;
    const guide = !lined
      ? undefined
      : vy
        ? { x1: from.x + from.w / 2, x2: from.x + from.w / 2, y1: Math.min(from.y, at.y) - 8, y2: Math.max(from.y + from.h, at.y + size.h) + 8 }
        : { y1: from.y + from.h / 2, y2: from.y + from.h / 2, x1: Math.min(from.x, at.x) - 8, x2: Math.max(from.x + from.w, at.x + size.w) + 8 };
    openNew({ node: nodeKind, at: { x: at.x, y: at.y }, size, name, from: src, group: parentOf(d.groups, src), axis: vy ? "v" : "h", ...(guide ? { guide } : {}) });
  }

  /** F17: a + dragged and let go at `at`: onto another shape a line to it, onto empty canvas a new connected shape. */
  function dropPlus(src: string, at: Point) {
    if (aiLock.current || !kind) return;
    let hit: string | null = null;
    for (const [id, b] of placedBoxes()) if (at.x >= b.x && at.x <= b.x + b.w && at.y >= b.y && at.y <= b.y + b.h) hit = id;
    if (hit === src) {
      setNotice("No line made: drop on another shape, or on empty canvas.");
      return;
    }
    if (hit !== null) {
      void connect({ node: src, port: "" }, { node: hit, port: "" });
      return;
    }
    const n = drawnRef.current?.nodes.find((x) => x.name === src);
    if (!n || n.kind === "note" || isStateEnd(src)) return;
    const nodeKind: FlowNodeKind = isStateStart(src) ? "state" : n.kind;
    const name = newName(nodeKind);
    const size = newSize(nodeKind, name);
    openNew({ node: nodeKind, at: { x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2) }, size, name, from: src });
  }

  /** What the strip said about the open ghost (its date), so cancelling it takes only that notice (N-G). */
  const ghostNotice = useRef<string | null>(null);

  /** Ends a + drag under way with nothing written; a no-op when none is. */
  const endPlusDrag = useRef<() => void>(() => {});
  useEffect(() => () => endPlusDrag.current(), []);

  /** The + on each side of a hovered or selected shape: a click adds the next shape, a drag draws a line. */
  function plusSides(node: string, b: Box) {
    if (!kind || !PLUS_KINDS.has(kind) || ai.locked || field !== null) return null;
    const n = drawnRef.current?.nodes.find((x) => x.name === node);
    if (!n || n.kind === "note" || isStateEnd(node)) return null;
    const noun = nounOf(isStateStart(node) ? "state" : n.kind, kind);
    const spot: Record<Side, Point> = { t: { x: b.x + b.w / 2, y: b.y - 16 }, r: { x: b.x + b.w + 16, y: b.y + b.h / 2 }, b: { x: b.x + b.w / 2, y: b.y + b.h + 16 }, l: { x: b.x - 16, y: b.y + b.h / 2 } };
    const exit: Record<Side, Point> = { t: { x: b.x + b.w / 2, y: b.y }, r: { x: b.x + b.w, y: b.y + b.h / 2 }, b: { x: b.x + b.w / 2, y: b.y + b.h }, l: { x: b.x, y: b.y + b.h / 2 } };
    const tipText = `Click: add the next ${noun} here, connected. Drag: draw a line.`;
    // F9: a + never covers a group's title, which selects, drags and renames the group: that side's + is left out.
    const bands: Box[] = [];
    // The titles are measured once here, not once per group (N10).
    const widths = titleWidths();
    for (const g of graphRef.current.nodes) {
      if (!g.id.startsWith("\u0000group:")) continue;
      const a = boxOfNode(g);
      bands.push({ x: a.x, y: a.y, w: titleBand(g.id.slice("\u0000group:".length), a.w, widths), h: TITLE_BAND });
    }
    const PLUS_HALF = 12;
    const onTitle = (p: Point) => bands.some((t) => p.x + PLUS_HALF > t.x && p.x - PLUS_HALF < t.x + t.w && p.y + PLUS_HALF > t.y && p.y - PLUS_HALF < t.y + t.h);
    // The tip shows after a moment, as a native tooltip does, beside the + and away from the shape (live check):
    // right of a + above or below, under a + left or right.
    const tipAt = plusTip && plusTip.node === node ? plusTip.dir : null;
    const tip =
      tipAt === null ? null : (
        <span
          key="tip"
          className="flow-plus-tip"
          role="tooltip"
          style={TIP_PLACE[tipAt](spot[tipAt])}
        >
          {tipText}
        </span>
      );
    return [
      ...SIDES.filter((dir) => !onTitle(spot[dir])).map((dir) => (
      <button
        key={dir}
        type="button"
        className="flow-plus nodrag nopan"
        data-side={dir}
        aria-label={`Add the next ${noun} ${SIDE_WORD[dir]}`}
        aria-description={tipText}
        style={{ left: `${spot[dir].x}px`, top: `${spot[dir].y}px` }}
        onPointerEnter={(e) => showPlusTip(node, dir, e.currentTarget)}
        onPointerLeave={hidePlusTip}
        // Enter or Space on a focused + adds the next shape, as a click does.
        onClick={(e) => {
          if (e.detail === 0) addNext(node, dir);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          hidePlusTip();
          endPlusDrag.current();
          const button = e.currentTarget;
          const pointerId = e.pointerId;
          // the pointer is captured, and a drag lost (cancelled, the capture gone, Esc, the tab closing) ends with
          // nothing written; only its own release adds or connects.
          try {
            button.setPointerCapture?.(pointerId);
          } catch {
            // A pointer that is already gone: the listeners below still end the drag.
          }
          const start = { x: e.clientX, y: e.clientY };
          let dragging = false;
          // In the live frame's units: the pending line draws in its overlay, and the drop adds there.
          const toFlow = (x: number, y: number) => (instance.current ? toLive(instance.current.screenToFlowPosition({ x, y })) : { x, y });
          const move = (ev: PointerEvent) => {
            if (!dragging && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 5) return;
            dragging = true;
            const q = toFlow(ev.clientX, ev.clientY);
            overlay.set({ pending: { d: `M ${exit[dir].x} ${exit[dir].y} L ${Math.round(q.x)} ${Math.round(q.y)}`, pulling: false } });
          };
          const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", stop);
            window.removeEventListener("keydown", esc, true);
            button.removeEventListener("lostpointercapture", stop);
            endPlusDrag.current = () => {};
            overlay.set({ pending: null });
          };
          const up = (ev: PointerEvent) => {
            stop();
            if (!dragging) addNext(node, dir);
            else dropPlus(node, toFlow(ev.clientX, ev.clientY));
          };
          const esc = (ev: globalThis.KeyboardEvent) => {
            if (ev.key !== "Escape") return;
            ev.preventDefault();
            ev.stopPropagation();
            stop();
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
          window.addEventListener("pointercancel", stop);
          window.addEventListener("keydown", esc, true);
          button.addEventListener("lostpointercapture", stop);
          endPlusDrag.current = stop;
        }}
      >
        <Icon name="plus" size={14} />
      </button>
      )),
      tip,
    ];
  }

  /** The + tip: shown after the native tooltip's moment over a +, gone on leaving it or pressing it. */
  const [plusTip, setPlusTip] = useState<{ node: string; dir: Side } | null>(null);
  const plusTipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function showPlusTip(node: string, dir: Side, el: Element) {
    clearTimeout(plusTipTimer.current);
    // A + gone meanwhile (the pointer left its shape) shows no tip.
    plusTipTimer.current = setTimeout(() => {
      if (el.isConnected) setPlusTip({ node, dir });
    }, PLUS_TIP_MS);
  }
  function hidePlusTip() {
    clearTimeout(plusTipTimer.current);
    setPlusTip(null);
  }
  useEffect(() => () => clearTimeout(plusTipTimer.current), []);
  // A + can go with the pointer still on it (a field opens, the shape goes): no pointerleave comes, so the tip goes
  // with the hot shape or any field (N-H).
  useEffect(() => hot.subscribe(() => hidePlusTip()), [hot]);
  useEffect(() => {
    if (field !== null) hidePlusTip();
  }, [field]);

  /**
   * FC1 and F18: a new shape from the Shapes list, "Add here" or a key, as a ghost with its name ready: where the
   * canvas was double-clicked (`at`, its middle), else in a free spot near the middle of the view. A sequence's new
   * participant goes in the nearest gap (S5); a timeline's item takes its date from where it was double-clicked; a mind
   * map topic goes under the selected topic, else under the central idea.
   */
  function addShape(asked: FlowNodeKind, at?: Point, opts: { box?: Box; group?: string | null } = {}): boolean {
    if (aiLock.current || !kind) return false;
    // On a text with an error the new shape's line is still written (as a key always did); the faded drawing may not
    // show it until the text works again.
    const d = drawnRef.current;
    // A map with no central idea starts with it: its first topic is written `root <name>` (round 2, live check).
    const known = parsedRef.current?.result.doc ?? d;
    const nodeKind: FlowNodeKind = kind === "mindmap" && asked === "topic" && !known?.nodes.some((n) => n.kind === "root") ? "root" : asked;
    if (nodeKind === "root" && d?.nodes.some((n) => n.kind === "root")) {
      setNotice("A mind map has one central idea.");
      return false;
    }
    const name = nodeKind === "note" ? "Note" : newName(nodeKind);
    // A drag drew its box: the shape takes it.
    const size = opts.box ? { w: opts.box.w, h: opts.box.h } : newSize(nodeKind, name);
    let spot: Point;
    if (opts.box) spot = { x: opts.box.x, y: opts.box.y };
    else if (at) spot = { x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2) };
    else spot = freeSpotInView(size);
    const extra: Partial<Extract<FieldEdit, { kind: "new" }>> = {};
    if (kind === "sequence" && at && nodeKind !== "note") extra.before = participantAfter(at);
    let said: string | undefined;
    if (kind === "timeline" && nodeKind !== "note") {
      // A milestone too goes where it was double-clicked: before the item to its right.
      const when: { date: string; before?: string; said?: string } = at ? dateAt(at) : { date: isoToday() };
      if (nodeKind !== "milestone") {
        extra.date = when.date;
        if (nodeKind === "period") extra.until = isoPlusDays(when.date, 21);
        said = when.said;
      }
      if (when.before) extra.before = when.before;
    }
    if (kind === "mindmap" && nodeKind === "topic") {
      // A sibling of the selected topic (board DiagramAddNext); under the central idea when it is selected or nothing is.
      const nodes = d?.nodes ?? [];
      const i = selectedRef.current.length === 1 ? nodes.findIndex((n) => n.name === selectedRef.current[0]) : -1;
      const sel = i >= 0 ? nodes[i] : undefined;
      const root = nodes.find((n) => n.kind === "root");
      let parent = root?.name;
      if (sel?.kind === "topic") {
        for (let j = i - 1; j >= 0; j--) {
          if (nodes[j].kind !== "note" && (nodes[j].depth ?? 0) < (sel.depth ?? 1)) {
            parent = nodes[j].name;
            break;
          }
        }
      }
      extra.under = parent;
    }
    if (opts.box) extra.sized = true;
    if (opts.group) extra.group = opts.group;
    openNew({ node: nodeKind, at: spot, size, name, ...extra });
    // Where the axis gives no date, the strip says plainly which one the new item took.
    if (said) setNotice(said);
    ghostNotice.current = said ?? null;
    return true;
  }

  /** A free spot near the middle of the view for a new shape of `size`, in flow coordinates. */
  function freeSpotInView(size: { w: number; h: number }): Point {
    const rect = canvasEl.current?.getBoundingClientRect();
    const mid = instance.current && rect ? toLive(instance.current.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })) : { x: 0, y: 0 };
    // Room for a name typed longer than the first one (board: 190 px). Clear of the group frames too, as of the shapes
    // (step 11 board note: a new shape had landed on a frame it was not added to).
    const frames = graphRef.current.nodes.filter((n) => isArea(n.id)).map(boxOfNode);
    const free = freeSpotNear(mid, { w: Math.max(size.w, 190), h: size.h + 12 }, [...placedBoxes().values(), ...frames]);
    return { x: free.x, y: free.y };
  }

  /** The date a timeline item double-clicked at `at` takes: between its neighbours' dates, and the item it goes before. */
  function dateAt(at: Point): { date: string; before?: string; said?: string } {
    const d = drawnRef.current;
    const items = (d?.nodes ?? []).filter((n) => n.kind === "event" || n.kind === "period" || n.kind === "milestone");
    const boxes = placedBoxes();
    const placed = items.map((n) => ({ n, b: boxes.get(n.name) })).filter((x): x is { n: FlowNode; b: Box } => !!x.b);
    const nextAt = placed.findIndex((x) => x.b.x + x.b.w / 2 > at.x);
    const prev = (nextAt < 0 ? placed[placed.length - 1] : placed[nextAt - 1]) ?? null;
    const next = nextAt >= 0 ? placed[nextAt] : null;
    const day = (x: { n: FlowNode } | null) => (x?.n.date && /^\d{4}-\d{2}-\d{2}$/.test(x.n.date) ? x.n.date : null);
    const a = day(prev);
    const b = day(next);
    let date = a ?? b ?? isoToday();
    if (a && b && prev && next) {
      const t = Math.max(0, Math.min(1, (at.x - (prev.b.x + prev.b.w / 2)) / Math.max(1, next.b.x + next.b.w / 2 - (prev.b.x + prev.b.w / 2))));
      const span = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
      date = isoPlusDays(a, Math.round(span * t));
    }
    // Past the last item or before the first, the axis (in written order) has no date there: say which one it took.
    const from = !(a && b) ? (a ? prev : b ? next : null) : null;
    const said = !(a && b) ? (from ? `The axis has no date there: the new item takes ${date}, the date of ${from.n.name}. Double-click its date to change it.` : `The axis has no date there: the new item takes today, ${date}. Double-click its date to change it.`) : undefined;
    return { date, ...(next ? { before: next.n.name } : {}), ...(said ? { said } : {}) };
  }

  /** The new shape's name kept: its line, its place and the line from its source, one undo step. */
  async function commitNew(e: Extract<NonNullable<typeof field>, { kind: "new" }>, value: string, how: CommitHow) {
    if (aiLock.current) return refuseField(e, EDIT_MESSAGES.locked);
    if (!kind) return;
    const note = e.node === "note";
    if (!value) return refuseField(e, needsName(e.node, kind));
    // A text opened with an error has no drawing to check names against: the writer refuses a taken name itself.
    const known = parsedRef.current?.result.doc ?? (e.from ? null : drawnRef.current);
    if (!known && e.from) return refuseField(e, LINK_NOTES.broken);
    // a name another shape has keeps the new shape: the next free name, showing the words typed (label:).
    const words = value;
    let label: string | undefined;
    if (known && !note && namesOf(known).has(words)) {
      if (!takesLabel(kind, e.node)) return refuseField(e, takenName(words));
      value = freeName(words, namesOf(known));
      label = words;
    }
    const id = nextId(known, e.node);
    const attrs: Record<string, string> = {
      ...(id ? { id } : {}),
      ...(kind === "cloud" && e.node === "service" ? { icon: "aws-lambda" } : {}),
      ...(label !== undefined ? { label } : {}),
    };
    const add: FlowEditOp = {
      op: "addNode",
      name: value,
      kind: kind === "cloud" ? null : e.node,
      ...(Object.keys(attrs).length ? { attrs } : {}),
      ...(e.group ? { group: e.group } : {}),
      ...(e.before !== undefined ? { before: e.before } : {}),
      ...(e.date !== undefined ? { date: e.date } : {}),
      ...(e.until !== undefined ? { until: e.until } : {}),
      ...(e.under !== undefined ? { under: e.under } : {}),
      ...(e.after !== undefined ? { after: e.after } : {}),
    };
    const ops: FlowEditOp[] = e.from ? [add, { op: "addLink", from: e.from, to: value, arrow: defaultArrow(kind) }] : [add];
    // A note is named by its place among the notes: the new one is the last.
    const placed = note ? `Note ${(known?.nodes ?? []).filter((n) => n.kind === "note").length + 1}` : value;
    let why: string | null = null;
    // The + line keeps the side it was drawn on, in the same undo step as the shape and the line (N2).
    const axes = e.from && e.axis ? { [axisKey(e.from, value)]: e.axis } : undefined;
    // A shape drawn by a drag keeps its size in the same undo step; fixed kinds take none.
    const sizes = e.sized && !FIXED_KINDS.has(kind) ? { [placed]: { w: e.size.w, h: e.size.h } } : undefined;
    const r = await doc.run(ops.length === 1 ? ops[0] : { op: "batch", ops }, { ...(FIXED_KINDS.has(kind) ? {} : { move: { [placed]: { x: e.at.x, y: e.at.y } } }), ...(axes ? { axes } : {}), ...(sizes ? { sizes } : {}), onRefused: (w) => (why = w) });
    if (!r) return refuseField(e, why ?? EDIT_MESSAGES.changed);
    if (fieldRef.current === e) setField(null);
    enter(placed);
    setSelected([placed]);
    if (label !== undefined) setNotice(labelNotice(words, value, "the new one"));
    // Only a data flow and a sequence ask for the new line's label, as its own undo step (F13, open question 2).
    if (e.from && (kind === "dfd" || kind === "sequence")) return void openLabel(e.from, value, r.at);
    if ((how === "enter" || how === "tab") && (e.node === "class" || e.node === "interface" || e.node === "enum")) return openMember(value, null);
    // A new service is written with the board's default icon and its icon is offered next; Esc keeps it.
    if (kind === "cloud" && e.node === "service" && !e.from) return openPicker(value);
    if (how !== "blur") canvasEl.current?.focus();
  }

  /** F18: a sequence's loop or a timeline's section, named; one undo step. */
  async function commitFrame(e: Extract<NonNullable<typeof field>, { kind: "newloop" | "newsection" | "loop" }>, value: string, how: CommitHow) {
    if (aiLock.current) return refuseField(e, EDIT_MESSAGES.locked);
    if (!value) return refuseField(e, e.kind === "newsection" ? "A section needs a name." : "A loop needs a label, such as \"every item\".");
    if (e.kind === "loop") {
      const close = () => {
        if (fieldRef.current === e) setField(null);
        if (how !== "blur") canvasEl.current?.focus();
      };
      if (value === e.name) return close();
      let why: string | null = null;
      const r = await doc.run({ op: "setFrameLabel", index: e.index, was: e.was, label: value }, { onRefused: (w) => (why = w) });
      if (!r) return refuseField(e, why ?? EDIT_MESSAGES.changed);
      return close();
    }
    if (e.kind === "newsection" && (drawnRef.current?.sections ?? []).includes(value)) return refuseField(e, takenName(value));
    let why: string | null = null;
    const r = await doc.run(e.kind === "newloop" ? { op: "addLoop", label: value, from: e.from, to: e.to } : { op: "addSection", name: value, members: e.members }, { onRefused: (w) => (why = w) });
    if (!r) return refuseField(e, why ?? EDIT_MESSAGES.changed);
    if (fieldRef.current === e) setField(null);
    if (how !== "blur") canvasEl.current?.focus();
  }

  /** ST1: the start dot before a state or the end after it, joined by a line, placed clear of the shapes; one undo step. */
  async function addMarker(end: "start" | "end", state: string) {
    if (aiLock.current || kind !== "state") return;
    const boxes = placedBoxes();
    const p = boxes.get(state);
    const marker = end === "start" ? STATE_START : STATE_END;
    let move: Positions | undefined;
    if (p && !boxes.has(marker)) {
      const s = end === "start" ? 22 : 26;
      const cands =
        end === "start"
          ? [[p.x - 60, p.y + p.h / 2 - s / 2], [p.x + p.w / 2 - s / 2, p.y - 60], [p.x - 50, p.y - 50], [p.x + p.w / 2 - s / 2, p.y + p.h + 40]]
          : [[p.x + p.w + 40, p.y + p.h / 2 - s / 2], [p.x + p.w / 2 - s / 2, p.y + p.h + 40], [p.x + p.w + 34, p.y + p.h + 30], [p.x + p.w / 2 - s / 2, p.y - 60]];
      // Clear of the shapes and of the lines (board DiagramAddNext), 6 px around the lines.
      const segments: [Point, Point][] = [];
      for (const l of drawnRef.current?.links ?? []) {
        const la = boxes.get(l.from);
        const lb = boxes.get(l.to);
        if (!la || !lb) continue;
        const axis = layoutRef.current.axes?.[axisKey(l.from, l.to)];
        const pts = routeOrthogonal(la, lb, axis ? { axis } : {}).points;
        for (let i = 1; i < pts.length; i++) segments.push([pts[i - 1], pts[i]]);
      }
      const onLine = (x: number, y: number) =>
        segments.some(([p, q]) => Math.min(p.x, q.x) - 6 < x + s && Math.max(p.x, q.x) + 6 > x && Math.min(p.y, q.y) - 6 < y + s && Math.max(p.y, q.y) + 6 > y);
      const clear = ([x, y]: number[]) => !onLine(x, y) && [...boxes.values()].every((b) => x + s + 8 <= b.x || x >= b.x + b.w + 8 || y + s + 8 <= b.y || y >= b.y + b.h + 8);
      const [x, y] = cands.find(clear) ?? cands[0];
      move = { [marker]: { x: Math.round(x), y: Math.round(y) } };
    }
    setNotice(null);
    let why: string | null = null;
    const r = await doc.run(end === "start" ? { op: "addLink", from: STATE_START, to: state, arrow: ">" } : { op: "addLink", from: state, to: STATE_END, arrow: ">" }, { ...(move ? { move } : {}), onRefused: (w) => (why = w) });
    if (!r) setNotice(why ?? EDIT_MESSAGES.changed);
  }

  /**
   * A line from a Shapes item, between the two shapes picked (draw.io's connect mode). Inheritance and composition are
   * drawn from the child or part to the parent or owner, and written parent first (`Payable <|-- Customer`).
   */
  async function connectPicked(a: string, b: string, arrow: FlowArrow) {
    if (aiLock.current || !kind) return;
    if (a === b) {
      setNotice("No line made: pick two different shapes.");
      return;
    }
    if (kind === "state" && (isStateEnd(a) || isStateStart(b))) {
      setNotice("The start only begins a line and the end only ends one.");
      return;
    }
    const swap = arrow === "<|--" || arrow === "*--";
    const from = swap ? b : a;
    const to = swap ? a : b;
    if (kind === "mindmap" && drawnRef.current?.links.some((l) => !l.tree && l.from === from && l.to === to)) {
      setNotice(`${said(from)} already has a relationship to ${said(to)}.`);
      return;
    }
    const r = await doc.run({ op: "addLink", from, to, arrow });
    // The label box bands the new line while it is open; elsewhere the pane bands the line the edit wrote.
    if (r && (kind === "dfd" || kind === "sequence")) void openLabel(from, to, r.at);
    else bandWritten(r?.at);
  }

  /** The Shapes item's prompt in the strip; the item waits for its pick as long as its prompt shows. */
  const shapePick = useRef<{ p: ShapePick; prompt: string } | null>(null);
  function setShapePick(p: ShapePick | null, prompt = "") {
    // A pick given up, done or started afresh (A pressed again, another line tool, a Shapes line item) ends the two-click
    // line it held, so an earlier first click never becomes half of a new line (B3). The first click
    // of an ER line keeps it: `erLinePick` sets its prompt directly.
    rel.reset();
    shapePick.current = p ? { p, prompt } : null;
    setNotice(p ? prompt : null);
  }

  /** A pick on the canvas while a Shapes item waits for one; true when the pick was the item's. */
  function pickForShape(ids: readonly string[]): boolean {
    // An armed line or Column tool waits for its pick as the Shapes item does, even after a click on nothing.
    const cur = shapePick.current ?? toolPick(armedRef.current);
    if (!cur) return false;
    if (ids.length !== 1) {
      if (ids.length === 0) setShapePick(null);
      return false;
    }
    const id = ids[0];
    const d = drawnRef.current;
    const n = d?.nodes.find((x) => x.name === id);
    if (!n) return false;
    const p = cur.p;
    // The message pick takes its lifelines from the sequence's own pointer handling.
    if (p.what === "message") return false;
    if (p.what === "line" && kind === "er") return erLinePick(p, n);
    if (p.what === "line") {
      if (p.from === null) {
        const prompt = p.arrow === "<|--" ? `Now click the class ${id} inherits from.` : p.arrow === "*--" ? `Now click the class that owns ${id}.` : `Now click the ${kind === "mindmap" ? "topic" : "shape"} the ${p.label.toLowerCase()} goes to.`;
        setShapePick({ ...p, from: id }, prompt);
        return true;
      }
      setShapePick(null);
      void connectPicked(p.from, id, p.arrow);
      pickDone();
      return true;
    }
    if (p.what === "marker") {
      if (n.kind !== "state" && n.kind !== "choice" && n.kind !== "fork") {
        setNotice("Click a state.");
        shapePick.current = { p, prompt: "Click a state." };
        return true;
      }
      setShapePick(null);
      void addMarker(p.end, id);
      return true;
    }
    if (p.what === "member" && kind === "er") {
      if (!isErTable(n)) return true;
      setShapePick(null);
      er.value.api.addColumn(id);
      pickDone();
      return true;
    }
    if (p.what === "member") {
      if (n.kind !== "class" && n.kind !== "interface" && n.kind !== "enum") return true;
      setShapePick(null);
      openMember(id, null);
      return true;
    }
    if (p.what === "sub") {
      if (n.kind !== "topic" && n.kind !== "root") return true;
      setShapePick(null);
      const name = newName("topic");
      openNew({ node: "topic", at: viewCentre("topic", name), size: newSize("topic", name), name, under: id });
      return true;
    }
    if (n.kind === "note") return true;
    setShapePick(null);
    void doc.run({ op: "addActivation", name: id });
    return true;
  }
  const pickForShapeRef = useRef(pickForShape);
  pickForShapeRef.current = pickForShape;

  /**
   * ER: one click of a line pick, on a table (B3 decision 9, R10): the column row or header the press landed on,
   * else the table. The armed Relationship tool infers the arrow from the keys; a Shapes line forces its own.
   */
  function erLinePick(p: Extract<ShapePick, { what: "line" }>, n: FlowNode): boolean {
    if (!isErTable(n)) return true;
    const press = erPress.current;
    const hit = press && press.table === n.name ? press : { table: n.name, column: null };
    const arrow = armedRef.current === ER_RELATIONSHIP ? null : p.arrow;
    // With no prompt of its own (another notice took its place) this click starts the line afresh (final review).
    if (!rel.toolClick(hit, arrow, shapePick.current === null)) {
      const from = hit.column === null ? hit.table : `${hit.table}.${hit.column}`;
      const prompt = hit.column === null ? `From ${from}: click the table it refers to.` : `From ${from}: click the column or table it refers to.`;
      // Not through setShapePick, which ends the first click just kept.
      shapePick.current = { p: { ...p, from: n.name }, prompt };
      setNotice(prompt);
      return true;
    }
    shapePick.current = null;
    pickDone();
    return true;
  }

  /**
   * A click on a live ER card while a line pick waits: it is the pick's, never a column selection or a canvas pick. Only
   * a click on a column's row or a header picks (the press rule, `erHitOf`): one on a card's empty body is swallowed and
   * picks nothing, and the click that ends a card drag is not a click (draw.io's 3 px).
   */
  function erLinePickClick(e: ReactMouseEvent): boolean {
    if (kind !== "er") return false;
    const cur = shapePick.current ?? toolPick(armedRef.current);
    erDragged.current = false;
    if (cur?.p.what !== "line" || !(e.target instanceof Element)) return false;
    const id = liveShapeAt(e.target);
    if (id === null) return false;
    const down = pressAt.current;
    // The click that ends a drag of the card: swallowed, it picks nothing (nor selects, which the drag did).
    if (down && Math.hypot(down.x - e.clientX, down.y - e.clientY) > 3) return true;
    if (erPress.current?.table !== id) return true;
    return pickForShape([id]);
  }

  /** The live ER card part under a press: a column's row, the header, or null elsewhere (a card's empty body, not a card). */
  function erHitOf(target: EventTarget | null): CardHit {
    const t = target instanceof Element ? target : null;
    const id = t && kind === "er" ? liveShapeAt(t) : null;
    if (!t || id === null) return null;
    const table = drawnRef.current?.nodes.find((n) => n.name === id && isErTable(n));
    if (!table) return null;
    const row = t.closest("[data-er-row]");
    if (row) {
      const r = table.rows?.[Number(row.getAttribute("data-er-row"))];
      return r === undefined ? null : { table: id, column: splitRow(r).name };
    }
    return t.closest(".fkind-head") ? { table: id, column: null } : null;
  }

  /** Why a Shapes item cannot be used now, shown in its place; null when it can (board DiagramAddNext). */
  function shapeDisabled(sh: Shape): string | null {
    const sel = selectedRef.current;
    const d = drawnRef.current;
    if (sh.act.kind === "group" && sel.length === 0) return "Select shapes first";
    if (sh.act.kind === "section" && !sel.some((n) => d?.nodes.some((x) => x.name === n && (x.kind === "event" || x.kind === "period")))) return "Select events first";
    if (sh.act.kind === "node" && sh.act.node === "root" && d?.nodes.some((n) => n.kind === "root")) return "A mind map has one central idea";
    return null;
  }

  /** What the strip asks while a line waits for its shapes: from `from` when it has one. */
  function linePrompt(arrow: FlowArrow, from: string | null, label: string): string {
    const word = label.toLowerCase();
    if (arrow === "<|--") return from ? `Click the class ${from} inherits from.` : "Click the class that inherits, then the one it inherits from.";
    if (arrow === "*--") return from ? `Click the class that owns ${from}.` : "Click the part, then the class that owns it.";
    return from ? `From ${said(from)}: click the shape the ${word} goes to.` : `Click the shape the ${word} starts from, then the one it goes to.`;
  }

  /**
   * The pick an armed kind tool waits for: a line tool its two shapes, by two clicks; an ERD's Column the
   * table it goes in. Null for the tools that draw where they are pressed.
   */
  function toolPick(id: string): { p: ShapePick; prompt: string } | null {
    const t = kind ? KIND_TOOLS[kind].find((x) => x.id === id) : undefined;
    const a = t?.shape.act;
    if (!t || !a) return null;
    if (a.kind === "line") return { p: { what: "line", arrow: a.arrow, from: null, label: t.name }, prompt: linePrompt(a.arrow, null, t.name) };
    if (a.kind === "member" && kind === "er") return { p: { what: "member" }, prompt: "Click the table to add a column to." };
    return null;
  }

  /** ER: the one selected table's new column row, opened at its end (B3 decision 9); false with no table selected alone. */
  function draftOnSelected(): boolean {
    const sel = selectedRef.current;
    const one = sel.length === 1 ? drawnRef.current?.nodes.find((n) => n.name === sel[0] && isErTable(n)) : undefined;
    if (!one) return false;
    er.value.api.addColumn(one.name);
    return true;
  }

  /** A pick made with an armed tool is its one use. */
  function pickDone() {
    if (isKindTool(armedRef.current)) toolUsed();
  }

  /** F18: a Shapes item (or an "Add here" pick at `at`) adds on the canvas. */
  function runShape(sh: Shape, at?: Point, place: { box?: Box; group?: string | null } = {}): boolean | Promise<boolean> {
    if (aiLock.current || !kind) return false;
    // An old-form ER frame takes no shape until it is rewritten as table blocks: every one says so in the strip.
    if (kind === "er" && parsedRef.current?.frame?.oldEr) {
      setNotice(ER_NOTES.oldForm);
      return false;
    }
    const why = shapeDisabled(sh);
    if (why) {
      setNotice(`${sh.label}: ${why.charAt(0).toLowerCase()}${why.slice(1)}.`);
      return false;
    }
    // A shape's own add may still refuse it (a mind map's second central idea, an old-form ER frame).
    if (sh.act.kind === "node") return kind === "er" && sh.tool ? add(sh.tool, at) : addShape(sh.act.node, at, place);
    shapeAct(sh);
    return true;
  }

  /** What a Shapes item other than a shape does once it can be used: a line, a group, a marker, a member... */
  function shapeAct(sh: Shape) {
    if (!kind) return;
    const sel = selectedRef.current;
    const d = drawnRef.current;
    const one = sel.length === 1 ? d?.nodes.find((n) => n.name === sel[0]) : undefined;
    const a = sh.act;
    switch (a.kind) {
      case "line": {
        // An ERD's line starts with nothing picked: its first click names the column.
        const from = sel.length === 1 && kind !== "er" ? sel[0] : null;
        setShapePick({ what: "line", arrow: a.arrow, from, label: sh.label }, linePrompt(a.arrow, from, sh.label));
        return;
      }
      case "group":
        return groupSelected();
      case "marker":
        if (one && (one.kind === "state" || one.kind === "choice" || one.kind === "fork") && !isStateMarker(one.name)) return void addMarker(a.end, one.name);
        setShapePick({ what: "marker", end: a.end }, a.end === "start" ? "Click the first state: the start dot goes before it." : "Click the last state: the end goes after it.");
        return;
      case "member":
        if (kind === "er") {
          if (parsedRef.current?.frame?.oldEr) return setNotice(ER_NOTES.oldForm);
          if (draftOnSelected()) return;
          setShapePick({ what: "member" }, "Click the table to add a column to.");
          return;
        }
        if (one && (one.kind === "class" || one.kind === "interface" || one.kind === "enum")) return openMember(one.name, null);
        setShapePick({ what: "member" }, "Click the class to add a member to.");
        return;
      case "sub":
        if (one && (one.kind === "topic" || one.kind === "root")) {
          const name = newName("topic");
          return openNew({ node: "topic", at: viewCentre("topic", name), size: newSize("topic", name), name, under: one.name });
        }
        setShapePick({ what: "sub" }, "Click the topic to add a subtopic under.");
        return;
      case "act":
        if (one && (one.kind === "participant" || one.kind === "actor")) return void doc.run({ op: "addActivation", name: one.name });
        setShapePick({ what: "act" }, "Click the participant that becomes active.");
        return;
      case "loop": {
        // Around the selected messages and every row between them (S4); with none, around the last one.
        const links = d?.links ?? [];
        const picked = linesRef.current.map(linkIndex).filter((i): i is number => i !== null);
        return loopAround(picked.length ? picked : links.length ? [links.length - 1] : []);
      }
      case "section": {
        const members = sel.filter((n) => d?.nodes.some((x) => x.name === n && (x.kind === "event" || x.kind === "period")));
        const boxes = placedBoxes();
        const first = boxes.get(members[0]);
        setNotice(null);
        openField({ kind: "newsection", members, name: freeName("Section", new Set(d?.sections ?? [])), at: first ? { x: first.x, y: first.y - 40 } : viewCentre("event", "Section") });
        return;
      }
    }
  }

  /** Ctrl+Shift+G (Miro, Figma, Lucidchart) or Ctrl+Shift+U (draw.io) takes the selected shape's group apart. */
  function ungroupSelected() {
    if (aiLock.current || !kind) return;
    const d = parsedRef.current?.result.doc;
    if (!d) {
      setNotice(LINK_NOTES.broken);
      return;
    }
    const group = selectedRef.current.map((n) => parentOf(d.groups, n)).find((g): g is string => !!g);
    if (!group) {
      setNotice("Nothing to take apart: select a shape in a group, area or composite.");
      return;
    }
    setNotice(null);
    void doc.run({ op: "ungroup", name: group }, { onRefused: (w) => setNotice(w) });
  }


  // ----- Groups (board DiagramGroups, F9)

  /** What group `name` holds now, in the drawing. */
  const contentsOf = (name: string) => (drawnRef.current ? groupContents(drawnRef.current, name) : null);
  const groupWord = () => (kind ? (GROUP_WORD[kind] ?? "Group") : "Group");

  /** A click on a group's title selects the group (Miro and Figma frames): its shapes and lines are let go. */
  function selectGroup(name: string) {
    const c = contentsOf(name);
    if (!c) return;
    setSelected([]);
    setLines([]);
    setLoopSel(null);
    setGroupSel(name);
    setNotice(null);
  }

  /** Ctrl+Shift+G, Ctrl+Shift+U, the menu and Delete's first answer: the group's braces go, what it held stays. */
  function ungroupGroup(name: string) {
    if (aiLock.current) return;
    setGroupAsk(null);
    setGroupSel(null);
    setNotice(null);
    // A composite's own [*] lines come out of its braces, where [*] is the diagram's: say so (N8).
    const ownMarkers = kind === "state" && !!findGroup(drawnRef.current?.groups ?? [], name)?.nodes.some((n) => isStateMarker(n));
    void doc.run({ op: "ungroup", name }, { onRefused: (w) => setNotice(w) }).then((r) => {
      if (r && ownMarkers) setNotice(`Ungrouped ${name}: its own start and end are now the diagram's start and end.`);
    });
  }

  /** Delete with contents (Visio, Figma): the block with every shape, group and line in or to it, one undo step. */
  function deleteGroupDeep(name: string) {
    if (aiLock.current) return;
    const c = contentsOf(name);
    setGroupAsk(null);
    setGroupSel(null);
    if (!c) return;
    void doc.run({ op: "deleteGroup", name }, { onRefused: (w) => setNotice(w) }).then((r) => {
      setNotice(r ? deletedWords(name, { shapes: c.shapes.length, inner: c.inner.length, lines: c.lines }) : LINK_NOTES.gone);
    });
  }

  /** Delete on a group asks first (F9): Ungroup or Delete with contents; Esc keeps everything. */
  function askDelete(name: string) {
    if (aiLock.current || !contentsOf(name)) return;
    setGroupAsk(name);
  }

  function answerAsk(i: 0 | 1 | 2) {
    const name = groupAsk;
    setGroupAsk(null);
    canvasEl.current?.focus();
    if (name === null) return;
    if (i === 0) ungroupGroup(name);
    else if (i === 1) deleteGroupDeep(name);
    else setNotice(`Kept ${name} as it was.`);
  }

  /** A right-click on a group's title: the group's own menu (target-first, draw.io and Figma). */
  function openGroupMenu(name: string, at: Point) {
    if (aiLock.current) return;
    const c = contentsOf(name);
    if (!c) return;
    selectGroup(name);
    setMenu({
      x: at.x,
      y: at.y,
      label: `${groupWord()} ${name}`,
      items: groupMenuItems({
        count: plural(c.shapes.length, "shape"),
        rename: () => startGroupRename(name),
        selectShapes: () => {
          setGroupSel(null);
          setSelected(contentsOf(name)?.shapes ?? []);
        },
        ungroup: () => ungroupGroup(name),
        remove: () => deleteGroupDeep(name),
        colour: groupColourRow(name),
      }),
    });
  }

  /**
   * A press on a group's title (F9; draw.io containers, Miro and Figma frames): it selects the group; dragged, the group
   * moves with everything in it, and let go inside another group it goes in there (out of its own when let go outside
   * it). The shapes are drawn moved as the pointer goes (groupDrag.ts); the release is one undo step. A second press
   * soon after on the same title renames the group. Esc puts everything back.
   */
  function startGroupGesture(e: ReactPointerEvent) {
    const t = e.target instanceof Element ? e.target : null;
    const title = t?.closest(".flow-area-name");
    if (!title) {
      // A press on the empty canvas lets the selected group go.
      if (groupSelRef.current !== null && t?.closest(".react-flow__pane")) setGroupSel(null);
      return;
    }
    if (!kind || !GROUP_WORD[kind]) return;
    const name = title.closest(".flow-area")?.getAttribute("aria-label")?.replace(/^Group /, "");
    if (!name || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    swallowClick.current = true;
    canvasEl.current?.focus();
    const again = lastTitle.current !== null && lastTitle.current.name === name && Date.now() - lastTitle.current.at < 450;
    lastTitle.current = again ? null : { name, at: Date.now() };
    selectGroup(name);
    if (again) return startGroupRename(name);
    const d = drawnRef.current;
    if (aiLock.current || !d) return;
    const drag = startGroupDrag(name, d.groups, graphRef.current.nodes);
    if (!drag) return;
    const map = flowMapper();
    const sx = map.x(e.clientX);
    const sy = map.y(e.clientY);
    const count = drag.shapes;
    let moved = false;
    let dx = 0;
    let dy = 0;
    let into: number = -2;
    const parentIndex = drag.parent === null ? -1 : drag.targets.indexOf(drag.parent);
    const words = (i: number) =>
      i === parentIndex
        ? `Moving ${name} with everything in it.`
        : i >= 0
          ? `Let go to put ${name} in ${drag.targets[i]}.`
          : `Let go to take ${name} out of ${drag.parent}.`;
    followPointer(e, {
      move(ev) {
        dx = map.x(ev.clientX) - sx;
        dy = map.y(ev.clientY) - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!moved) {
          moved = true;
          stopGlide.current();
          hot.set(null);
          hidePlusTip();
        }
        // Shift keeps the move on one axis (Figma, draw.io).
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        setGlide(groupDragFrame(drag, dx, dy));
        const i = groupDropAt(drag, dx, dy);
        if (i === into) return;
        into = i;
        overlay.set({ hot: i >= 0 && i !== parentIndex ? { x: drag.targetBox[i * 4], y: drag.targetBox[i * 4 + 1], w: drag.targetBox[i * 4 + 2], h: drag.targetBox[i * 4 + 3] } : null });
        setNotice(words(i));
      },
      up() {
        if (!moved) return;
        // A press right after a drag is a new press, not the second of a double press.
        lastTitle.current = null;
        overlay.set({ hot: null });
        // An empty group moves by its kept place.
        const after = drag.shapes > 0 ? groupDragEnd(drag, dx, dy) : { [name]: { x: Math.round(drag.box.x + dx), y: Math.round(drag.box.y + dy) } };
        const target = into >= 0 ? drag.targets[into] : null;
        // The group it leaves empty stays drawn where it was.
        const left = drag.parent !== null ? findGroup(drawnRef.current?.groups ?? [], drag.parent) : null;
        if (left && left.nodes.length === 0 && left.groups.length === 1 && target !== drag.parent && drag.parent !== null && parentIndex >= 0) {
          after[drag.parent] = { x: drag.targetBox[parentIndex * 4], y: drag.targetBox[parentIndex * 4 + 1] };
        }
        if (target !== drag.parent) {
          const started = doc.frameIdNow();
          // An awaited commit, as the node drag's drop on a group.
          trackCommit(doc.run({ op: "moveToGroup", name, group: target }, { frame: started, move: after }).then((r) => {
            // Refused, the move is kept alone; dropped because another frame was selected, nothing is written there.
            const still = doc.frameIdNow() === started;
            if (!r && still) doc.move(after);
            setGlide(null);
            if (!r && !still) return;
            setNotice(
              !r
                ? `Moved ${name} and the ${plural(count, "shape")} in it.`
                : target
                  ? `Put ${name} in ${target}. Its block moves inside ${target} { } in the text; the move and this are one undo step.`
                  : `Took ${name} out of ${drag.parent}. Its block moves out of the braces; one undo step.`,
            );
          }));
          return;
        }
        doc.move(after);
        setGlide(null);
        setNotice(`Moved ${name} and the ${plural(count, "shape")} in it. One undo step; the layout file changes, the text does not.`);
      },
      cancel(esc) {
        overlay.set({ hot: null });
        if (!moved) return;
        setGlide(null);
        setNotice(esc ? `Moving ${name} cancelled: everything is back where it was.` : null);
      },
    });
  }

  // ----- The mind map (board DiagramMindMap)

  /** The map's tree as drawn (orderGestures.ts). */
  const mindTree = () => mindTreeOf(drawnRef.current);
  /** The sequence as drawn (orderGestures.ts). */
  const seqGeometry = () => seqGeometryOf(drawnRef.current, graphRef.current);

  const isTopic = (name: string | null): name is string => !!name && !!drawnRef.current?.nodes.some((n) => n.name === name && (n.kind === "topic" || n.kind === "root"));

  /** Tab opens a new subtopic, Shift+Tab the next topic beside the selected one (Mind42), each with its name ready. */
  function addTopicKey(one: string | null, how: "child" | "sibling") {
    if (aiLock.current) return;
    if (!isTopic(one)) {
      setNotice(how === "child" ? "Select a topic first: Tab adds a subtopic under it." : "Select a topic first: Shift+Tab adds the next topic beside it.");
      return;
    }
    const root = drawnRef.current?.nodes.find((n) => n.kind === "root")?.name;
    if (how === "sibling" && one === root) {
      setNotice("The central idea has no siblings. Tab adds a topic to it.");
      return;
    }
    // Tab on a folded topic unfolds it first, so the new subtopic is seen.
    if (how === "child" && folded.has(one)) setFolded((prev) => without(prev, one));
    const name = newName("topic");
    openNew({ node: "topic", at: { x: 0, y: 0 }, size: newSize("topic", name), name, ...(how === "child" ? { under: one } : { after: one }) });
  }

  /** Ctrl or Alt+Up and Down move the selected topic among its siblings, with its subtopics (Mind42, Excalidraw Mindmap). */
  function moveAmong(one: string | null, dir: -1 | 1) {
    if (aiLock.current) return;
    const { parent, kids } = mindTree();
    const p = one ? parent.get(one) : undefined;
    if (!one || p === undefined) {
      setNotice("Select a topic to move it among its siblings.");
      return;
    }
    const sibs = kids.get(p) ?? [];
    const i = sibs.indexOf(one);
    if (i + dir < 0 || i + dir >= sibs.length) {
      setNotice(`${said(one)} is already the ${dir < 0 ? "first" : "last"} under ${said(p)}.`);
      return;
    }
    setNotice(null);
    void doc.run({ op: "moveTopic", name: one, parent: p, index: i + dir });
  }

  /** The arrow keys select the next topic (Mind42): up and down its column, out to a subtopic, in to the parent. */
  function navigateTopic(one: string, key: string) {
    const { parent, kids, root } = mindTree();
    const boxes = placedBoxes();
    const me = boxes.get(one);
    const r = root ? boxes.get(root) : undefined;
    if (!me || !r) return;
    const mid = (b: Box) => b.x + b.w / 2;
    const sideOf = (n: string) => (n === root ? 0 : Math.sign(mid(boxes.get(n) ?? r) - mid(r)));
    const depth = (n: string) => {
      let k = 0;
      for (let p = parent.get(n); p !== undefined; p = parent.get(p)) k++;
      return k;
    };
    let to: string | undefined;
    if (key === "ArrowUp" || key === "ArrowDown") {
      const side = sideOf(one);
      const level = depth(one);
      let best = Number.POSITIVE_INFINITY;
      for (const [n, b] of boxes) {
        if (n === one || !isTopic(n) || sideOf(n) !== side || depth(n) !== level) continue;
        const dy = key === "ArrowUp" ? me.y - b.y : b.y - me.y;
        if (dy > 0 && dy < best) {
          best = dy;
          to = n;
        }
      }
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      const right = key === "ArrowRight";
      const side = sideOf(one);
      const outward = side === 0 || side > 0 === right;
      to = outward ? (kids.get(one) ?? []).find((k) => boxes.has(k) && (side !== 0 || sideOf(k) > 0 === right)) : parent.get(one);
    }
    if (to !== undefined) setSelected([to]);
  }

  /** A topic's subtopics fold out of view and back (the branch dot, Ctrl+/); the text and the history keep them. */
  function toggleFold(name: string | null) {
    const { kids, root } = mindTree();
    if (!isTopic(name) || name === root) {
      setNotice("The central idea does not fold. Select a topic with subtopics.");
      return;
    }
    const count = subtreeOf(name, kids).length;
    if (count === 0) {
      setNotice(`${said(name)} has no subtopics to fold.`);
      return;
    }
    const folding = !folded.has(name);
    setFolded((prev) => (folding ? new Set(prev).add(name) : without(prev, name)));
    if (folding) {
      const hidden = new Set(subtreeOf(name, kids));
      setSelected((prev) => (prev.some((n) => hidden.has(n)) ? [name] : prev));
    }
    setNotice(folding ? `Folded ${said(name)}: ${plural(count, "subtopic")} hidden. The text keeps them; folding changes the view only, so there is nothing to undo.` : `Unfolded ${said(name)}.`);
  }

  /** Ctrl+Shift+L, then the topic it goes to, writes a relationship `A > B` (XMind); no label prompt. */
  function startRelationship(one: string | null) {
    if (aiLock.current) return;
    const from = isTopic(one) ? one : null;
    setShapePick({ what: "line", arrow: ">", from, label: "Relationship" }, from ? `Relationship from ${said(from)}: click the topic it goes to.` : "Relationship: click the topic it starts from, then the one it goes to.");
  }

  /** The mind map's own keys (board DiagramMindMap); true when the key was one of them. */
  function mindKey(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    const sel = selectedRef.current;
    const one = sel.length === 1 && linesRef.current.length === 0 ? sel[0] : null;
    if (ctrl && e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      startRelationship(one);
      return true;
    }
    // With no topic selected Tab moves focus on, out of the canvas.
    if (e.key === "Tab" && !ctrl && !e.altKey && (sel.length > 0 || linesRef.current.length > 0)) {
      e.preventDefault();
      addTopicKey(one, e.shiftKey ? "sibling" : "child");
      return true;
    }
    if (ctrl && !e.shiftKey && !e.altKey && (e.key === "/" || e.code === "Slash")) {
      e.preventDefault();
      if (one) toggleFold(one);
      else setNotice("Select a topic first: Ctrl+/ folds its subtopics.");
      return true;
    }
    if ((e.altKey || ctrl) && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveAmong(one, e.key === "ArrowUp" ? -1 : 1);
      return true;
    }
    if (!ctrl && !e.altKey && !e.shiftKey && one && e.key.startsWith("Arrow")) {
      e.preventDefault();
      navigateTopic(one, e.key);
      return true;
    }
    return false;
  }

  /** The topic drag under way: its index, for the outline of the topic it would go under. */
  const topicDrag = useRef<TopicIndex | null>(null);

  /**
   * A topic dragged onto another becomes its subtopic; between two siblings it goes there (XMind, Miro). The
   * dragged branch is drawn faded, a chip with its name follows the pointer, and its own subtopics refuse it. Esc
   * cancels; let go on empty canvas, nothing moves. The text moves the whole branch, re-indented, in one undo step.
   */
  /**
   * One pointer drag's listeners (steps 7 and 8). The pointer is captured; the release goes to `up`; Esc, a cancelled
   * pointer, a lost capture or a move with no button down (the button let go outside the window)
   * end it with nothing written. Returns the function that ends it.
   */
  function followPointer(e: ReactPointerEvent, h: { move(ev: PointerEvent): void; up(ev: PointerEvent): void; cancel(esc: boolean): void }): () => void {
    endOrderDrag.current();
    const el = e.target instanceof Element ? e.target : null;
    const id = e.pointerId;
    try {
      el?.setPointerCapture?.(id);
    } catch {
      // A pointer already gone: the listeners below still end the drag.
    }
    let live = true;
    const off = () => {
      if (!live) return;
      live = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", lost);
      window.removeEventListener("keydown", esc, true);
      el?.removeEventListener("lostpointercapture", lost);
      try {
        if (el?.hasPointerCapture?.(id)) el.releasePointerCapture(id);
      } catch {
        // Nothing held.
      }
      endOrderDrag.current = () => {};
    };
    const move = (ev: PointerEvent) => {
      if (ev.buttons === 0) return lost();
      h.move(ev);
    };
    const up = (ev: PointerEvent) => {
      off();
      h.up(ev);
    };
    const lost = () => {
      if (!live) return;
      off();
      h.cancel(false);
    };
    const esc = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      off();
      h.cancel(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", lost);
    window.addEventListener("keydown", esc, true);
    el?.addEventListener("lostpointercapture", lost);
    endOrderDrag.current = lost;
    return off;
  }

  /** The drawn shapes and lines a drag is moving, faded by their class only, so the drawing is not built again. */
  function fadeSources(nodes: readonly string[], edges: readonly string[], on: boolean) {
    const root = canvasEl.current;
    if (!root) return;
    for (const n of nodes) root.querySelector(`.react-flow__node[data-id="${CSS.escape(n)}"]`)?.classList.toggle("is-drag-source", on);
    for (const id of edges) root.querySelector(`.react-flow__edge[data-id="${CSS.escape(id)}"]`)?.classList.toggle("is-drag-source", on);
  }

  /**
   * The element a press landed on, looking under a box selection's frame (React Flow draws it over the selected
   * shapes): on a map, sequence or timeline nothing moves with the frame, so the shape under it is what was meant.
   */
  function underSelectionFrame(e: ReactPointerEvent): Element | null {
    const t = e.target instanceof Element ? e.target : null;
    if (!t?.closest(".react-flow__nodesselection")) return t;
    return document.elementsFromPoint?.(e.clientX, e.clientY).find((x) => !x.closest(".react-flow__nodesselection") && x.closest(".react-flow__node")) ?? t;
  }

  function startTopicGesture(e: ReactPointerEvent) {
    if (kind !== "mindmap" || e.button !== 0 || aiLock.current || fieldRef.current || e.shiftKey || e.ctrlKey || e.metaKey || shapePick.current) return;
    const t = underSelectionFrame(e);
    if (!t || t.closest(".react-flow__handle, .flow-fold-dot, .inline-edit-wrap, .flow-hot")) return;
    const id = t.closest(".react-flow__node")?.getAttribute("data-id");
    if (!isTopic(id ?? null) || !id) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const out: TopicDrop = { kind: DROP.none, ref: -1, x1: 0, x2: 0, y: 0 };
    let ix: TopicIndex | null = null;
    let started = false;
    let faded: { nodes: string[]; edges: string[] } = { nodes: [], edges: [] };
    let map: ReturnType<typeof flowMapper> | null = null;
    const words = () => {
      if (!ix || out.kind === DROP.none) return "";
      if (out.kind >= DROP.badChild) return "A topic cannot go under its own subtopic.";
      const ref = ix.names[out.ref];
      return out.kind === DROP.child ? `Drop: subtopic of ${said(ref)}` : `Drop: ${out.kind === DROP.before ? "before" : "after"} ${said(ref)}`;
    };
    const aim = (cx: number, cy: number) => {
      if (!ix || !map) return;
      const x = map.x(cx);
      const y = map.y(cy);
      topicDropAt(ix, x, y, out);
      orderDrag.pointer(x, y);
      if (orderDrag.target(out.kind, out.ref, out.x1, out.x2, out.y)) {
        const tag = words();
        orderDrag.setTag(tag);
        canvasEl.current?.classList.toggle("is-drop-refused", out.kind >= DROP.badChild);
        // The board's status line for the drag.
        setNotice(out.kind === DROP.none ? "Drag onto a topic to make it the parent, or between two topics to place it there." : out.kind >= DROP.badChild ? tag : `${tag}. Release to move it with its subtopics; Esc cancels.`);
      }
    };
    const begin = () => {
      const d = drawnRef.current;
      const root = d?.nodes.find((n) => n.kind === "root")?.name;
      if (!d || id === root) {
        setNotice("The central idea stays in the middle. Drag a topic to give it another parent.");
        return false;
      }
      const { parent, kids } = mindTree();
      const boxes = placedBoxes();
      const topics: { name: string; parent: string | null; box: Box }[] = [];
      for (const n of d.nodes) {
        const b = boxes.get(n.name);
        if (b && (n.kind === "topic" || n.kind === "root")) topics.push({ name: n.name, parent: parent.get(n.name) ?? null, box: b });
      }
      ix = topicIndex(topics, id);
      topicDrag.current = ix;
      map = flowMapper();
      orderDrag.begin("topic", said(id));
      setNotice("Drag onto a topic to make it the parent, or between two topics to place it there.");
      const branch = [id, ...subtreeOf(id, kids)];
      const inBranch = new Set(branch);
      faded = { nodes: branch, edges: d.links.flatMap((l, i) => (l.tree && inBranch.has(l.to) ? [`edge:${i}`] : [])) };
      fadeSources(faded.nodes, faded.edges, true);
      return true;
    };
    const end = () => {
      topicDrag.current = null;
      orderDrag.end();
      canvasEl.current?.classList.remove("is-drop-refused");
      if (started) fadeSources(faded.nodes, faded.edges, false);
    };
    const off = followPointer(e, {
      move(ev) {
        if (!started) {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
          started = true;
          if (!begin()) {
            off();
            end();
            return;
          }
        }
        aim(ev.clientX, ev.clientY);
      },
      up(ev) {
        if (!started || !ix) return end();
        aim(ev.clientX, ev.clientY);
        const at = { kind: out.kind, ref: ix.names[out.ref] ?? null };
        end();
        void dropTopic(id, at.kind, at.ref);
      },
      cancel(esc) {
        const was = started && !!ix;
        end();
        if (was) setNotice(esc ? "Drag cancelled: nothing moved." : "The drag ended outside the canvas: nothing moved.");
      },
    });
  }

  /** A topic let go: under the topic it was over, or between the siblings it was between; one undo step. */
  async function dropTopic(name: string, kindOfDrop: number, ref: string | null) {
    if (kindOfDrop === DROP.none || ref === null) {
      setNotice("Dropped on empty canvas: nothing moved.");
      return;
    }
    if (kindOfDrop >= DROP.badChild) {
      setNotice("A topic cannot go under its own subtopic. Nothing moved.");
      return;
    }
    // Beside itself is where it is.
    if (ref === name) {
      setNotice("Dropped where it was: nothing moved.");
      return;
    }
    const { parent, kids } = mindTree();
    const p = kindOfDrop === DROP.child ? ref : parent.get(ref);
    if (p === undefined) return;
    const sibs = (kids.get(p) ?? []).filter((k) => k !== name);
    const index = kindOfDrop === DROP.child ? sibs.length : sibs.indexOf(ref) + (kindOfDrop === DROP.after ? 1 : 0);
    if (index < 0) return;
    if (kindOfDrop === DROP.child && folded.has(p)) setFolded((prev) => without(prev, p));
    setNotice(null);
    const r = await doc.run({ op: "moveTopic", name, parent: p, index });
    if (!r) {
      setNotice("Dropped where it was: nothing moved.");
      return;
    }
    setSelected([name]);
  }

  /** The branch dots: on each topic with subtopics, on its outer side, with how many it holds; once per drawing. */
  const foldDots = useMemo<FoldDot[]>(() => {
    if (kind !== "mindmap" || !drawn) return [];
    const root = drawn.nodes.find((n) => n.kind === "root")?.name;
    if (!root) return [];
    const boxes = new Map(graph.nodes.map((n) => [n.id, n] as const));
    return foldDotsOf(drawn.links, (n) => {
      const g = boxes.get(n);
      return g ? boxOfNode(g) : undefined;
    }, root, folded);
  }, [kind, drawn, graph, folded]);


  // ----- The sequence (board DiagramSequence)

  /**
   * Screen to the live frame's own units with the view as it is now, as two plain functions (no object per pointer
   * frame). Every caller is live-frame work against its frame-local graph (the mind map's topic drag, the sequence's
   * gestures), so the live frame's place on the board comes off (`toLive`).
   */
  function flowMapper(): { x(cx: number): number; y(cy: number): number } {
    const v = instance.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 };
    const r = canvasEl.current?.querySelector(".react-flow")?.getBoundingClientRect();
    const zoom = v.zoom || 1;
    const at = liveAtRef.current;
    const left = (r?.left ?? 0) + v.x;
    const top = (r?.top ?? 0) + v.y;
    return { x: (cx) => (cx - left) / zoom - at.x, y: (cy) => (cy - top) / zoom - at.y };
  }

  /** "row 3", the row a slot puts a message on. */
  const rowWord = (slot: number) => `row ${(slot + 1).toLocaleString("en-US")}`;

  /** M (Visio, draw.io's connect): a lifeline at the height the message goes, then the lifeline it goes to. */
  function startMessagePick() {
    if (aiLock.current) return;
    setLoopSel(null);
    setShapePick({ what: "message", from: null, slot: 0 }, "Message: click a lifeline at the height the message goes, then the lifeline it goes to.");
  }

  /** S1: the message from `from` to `to` written at `slot`, then its label opened on its row (its own undo step). */
  async function addMessageAt(from: string, to: string, slot: number) {
    if (aiLock.current) return;
    setShapePick(null);
    setSlotGuide(null);
    let why: string | null = null;
    const r = await doc.run({ op: "addMessage", from, to, at: slot }, { onRefused: (w) => (why = w) });
    if (!r) {
      setNotice(why ?? EDIT_MESSAGES.changed);
      return;
    }
    await openLabelAt(slot);
  }

  /** The label field of message `index` in the newest text, on its row, ready for a new message's label. */
  async function openLabelAt(index: number) {
    const g = gestureFrame();
    const cur = await doc.current();
    const l = cur?.result.doc?.links[index];
    if (!cur || !l || !g.still()) return;
    const spans = await doc.spans(cur.result.version, [`link:${index}`]);
    if (!g.still()) return;
    const view = doc.view();
    const sp = spans?.[`link:${index}`];
    const line = sp && view ? view.state.doc.lineAt(Math.min(sp.from, view.state.doc.length)).number : undefined;
    setLabelBox({ index, version: cur.result.version, from: l.from, to: l.to, initial: l.label ?? "", fresh: true, frame: g.frame, ...(line !== undefined ? { line } : {}) });
  }

  /** S4: a loop selected by its tab (Visio's frame): F2 or a second press edits its label, Delete takes it apart. */
  function selectLoop(f: { index: number; label: string }) {
    setSelected([]);
    setLines([]);
    setLoopSel({ index: f.index, label: f.label });
    canvasEl.current?.focus();
    setNotice(`Selected the ${frameWord(f.label)}. Double-click its label or press F2 to change it; Delete removes the frame and keeps the messages.`);
  }

  /** The loop's label in its field on the tab, without its kind word. */
  function editLoop(f: { index: number; label: string }) {
    if (aiLock.current) return;
    const geo = seqGeometry();
    const frame = geo.frames.find((x) => x.index === f.index);
    if (!frame) return;
    const name = frame.label.slice(frame.kind.length).trim();
    setNotice(null);
    // On the caption: the field's left edge on the caption's, its middle on the caption's middle.
    const cap = frame.tab ?? frame.box;
    openField({ kind: "loop", index: f.index, was: frame.label, name, at: { x: cap?.x ?? 0, y: (cap ? cap.y + cap.h / 2 : 0) - LOOP_FIELD_H / 2 } });
  }

  /** Delete on a selected loop: its frame goes, its messages stay (an unwrap). One undo step. */
  async function unwrapLoop(f: { index: number; label: string }) {
    if (aiLock.current) return;
    setLoopSel(null);
    let why: string | null = null;
    const r = await doc.run({ op: "unwrapFrame", index: f.index, was: f.label }, { onRefused: (w) => (why = w) });
    const rest = f.label.indexOf(" ") < 0 ? "" : f.label.slice(f.label.indexOf(" ") + 1);
    if (r) setNotice(`Removed the ${frameWord(f.label)}${rest ? ` "${rest}"` : ""}; its messages stay.`, true);
    else setNotice(why ?? EDIT_MESSAGES.changed);
  }

  /** S4: a loop around the selected messages and every row between them, its label ready; one across another is refused. */
  function loopAround(indexes: readonly number[]) {
    if (aiLock.current) return;
    const d = drawnRef.current;
    const links = d?.links ?? [];
    if (links.length === 0) {
      setNotice("Draw a message first: a loop goes around messages.");
      return;
    }
    const picked = indexes.filter((i) => i >= 0 && i < links.length);
    if (picked.length === 0) {
      setNotice("Select the messages to repeat first (Shift+click adds one), then Loop.");
      return;
    }
    const from = Math.min(...picked);
    const to = Math.max(...picked);
    const cut = (d?.frames ?? []).find((f) => f.to >= f.from && ((f.from < from && f.to >= from && f.to < to) || (f.from > from && f.from <= to && f.to > to)));
    if (cut) {
      setNotice(LOOP_CUT(cut.label));
      return;
    }
    setNotice(null);
    // On the caption the loop will have: its field's middle on the caption's middle (18 px chip, 3 down).
    const cap = d ? newLoopCaption(d, seqGeometry(), from, to) : null;
    const at = cap ? { x: cap.x, y: cap.y + 3 + 9 - LOOP_FIELD_H / 2 } : viewCentre("participant", "every item");
    openField({ kind: "newloop", from, to, name: "every item", at });
  }

  /** S4: Request or Reply on every selected message, as one undo step. */
  function setMessageArrows(indexes: readonly number[], arrow: FlowArrow) {
    const links = drawnRef.current?.links ?? [];
    const ops: FlowEditOp[] = [];
    for (const i of indexes) {
      const ref = links[i] && links[i].arrow !== arrow ? linkRefOf(links, i) : null;
      if (ref) ops.push({ op: "setLinkArrow", link: ref, arrow });
    }
    if (ops.length === 0) return;
    setNotice(null);
    void doc.run(ops.length === 1 ? ops[0] : { op: "batch", ops }, { onRefused: (w) => setNotice(w) });
  }

  /** S4: Reverse on every selected message, as one undo step. */
  function reverseMessages(indexes: readonly number[]) {
    const links = drawnRef.current?.links ?? [];
    const ops: FlowEditOp[] = [];
    for (const i of indexes) {
      const ref = links[i] && links[i].from !== links[i].to ? linkRefOf(links, i) : null;
      if (ref) ops.push({ op: "reverseLink", link: ref });
    }
    if (ops.length === 0) return;
    setNotice(null);
    void doc.run(ops.length === 1 ? ops[0] : { op: "batch", ops }, { onRefused: (w) => setNotice(w) });
  }

  /** S4: a reply to message `index` on the next row, dashed, back the other way, in the frames of the message (Visio). */
  async function addReply(index: number) {
    if (aiLock.current) return;
    const l = drawnRef.current?.links[index];
    if (!l) return;
    let why: string | null = null;
    const r = await doc.run({ op: "addMessage", from: l.to, to: l.from, at: index + 1, arrow: "-->", inside: true }, { onRefused: (w) => (why = w) });
    if (!r) {
      setNotice(why ?? EDIT_MESSAGES.changed);
      return;
    }
    await openLabelAt(index + 1);
  }

  /**
   * The sequence's pointer gestures (board DiagramSequence): a loop's tab selects the loop; a message drags up or down
   * (S1); a lifeline clicked or dragged from adds a message at that height (S1); a participant's head drags sideways
   * (S2). A message's or a head's plain click still selects it.
   */
  function startSeqGesture(e: ReactPointerEvent) {
    swallowClick.current = false;
    if (kind !== "sequence" || e.button !== 0 || aiLock.current || fieldRef.current) return;
    const t = underSelectionFrame(e);
    if (!t || t.closest(".react-flow__handle, .inline-edit-wrap, .flow-hot, .react-flow__minimap, .react-flow__panel, button, input, textarea")) return;
    const map = flowMapper();
    const p = { x: map.x(e.clientX), y: map.y(e.clientY) };
    const geo = seqGeometry();
    const picking = shapePick.current?.p.what === "message" ? (shapePick.current.p as Extract<ShapePick, { what: "message" }>) : null;
    const within = (b: Box | null) => !!b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    const tab = picking ? undefined : geo.frames.find((f) => within(f.tab) || within(f.side));
    if (tab) {
      e.stopPropagation();
      e.preventDefault();
      swallowClick.current = true;
      const again = lastTab.current && lastTab.current.index === tab.index && Date.now() - lastTab.current.at < 450;
      lastTab.current = { index: tab.index, at: Date.now() };
      if (again) return editLoop(tab);
      return selectLoop(tab);
    }
    if (loopSelRef.current) setLoopSel(null);
    const edgeId = t.closest(".react-flow__edge")?.getAttribute("data-id") ?? null;
    const index = edgeId ? linkIndex(edgeId) : null;
    if (index !== null && !picking) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      return startMessageDrag(e, index, geo, map);
    }
    const nodeId = t.closest(".react-flow__node")?.getAttribute("data-id");
    const part = geo.parts.find((x) => x.name === nodeId);
    if (!part) return;
    const onHead = onParticipantBox(part.box, p.y);
    if (!picking && onHead) return startParticipantDrag(e, part, geo, map);
    e.stopPropagation();
    e.preventDefault();
    swallowClick.current = true;
    canvasEl.current?.focus();
    const slot = nearestIndex(laneIndex(geo.slots), p.y);
    if (picking) {
      if (picking.from === null) {
        setShapePick({ what: "message", from: part.name, slot }, `From ${said(part.name)} at ${rowWord(slot)}: click the lifeline it goes to.`);
        setSlotGuide({ y: geo.slots[slot], x1: geo.left, x2: geo.right, pick: true });
        return;
      }
      if (picking.from === part.name) {
        shapePick.current = { p: picking, prompt: "Pick another lifeline: the message goes to someone else." };
        setNotice("Pick another lifeline: the message goes to someone else.");
        return;
      }
      void addMessageAt(picking.from, part.name, picking.slot);
      return;
    }
    lifelineDrag(e, part, slot, geo, map);
  }

  /** A press on a lifeline: a click starts the message pick there, a drag to another lifeline draws the message. */
  function lifelineDrag(e: ReactPointerEvent, part: { name: string; cx: number }, slot: number, geo: ReturnType<typeof seqGeometry>, map: ReturnType<typeof flowMapper>) {
    const sx = e.clientX;
    const sy = e.clientY;
    const lane = laneIndex(geo.parts.map((x) => x.cx));
    const from = geo.parts.findIndex((x) => x.name === part.name);
    const y = geo.slots[slot];
    let started = false;
    let to = -1;
    let toldOf = -2;
    const aim = (ev: PointerEvent) => {
      // The canvas is told only when the lifeline under the pointer changes.
      to = drawAt(orderDrag, lane, from, map.x(ev.clientX), map.y(ev.clientY), y);
      if (to === toldOf) return;
      toldOf = to;
      setNotice(to < 0 ? "Drag to another lifeline. The message lands on the line shown." : `Release on ${said(geo.parts[to].name)}: the message lands at ${rowWord(slot)}, on the line shown.`);
    };
    const end = () => {
      orderDrag.end();
      if (started) setSlotGuide(null);
    };
    followPointer(e, {
      move(ev) {
        if (!started) {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
          started = true;
          orderDrag.begin("draw");
          setSlotGuide({ y, x1: geo.left, x2: geo.right, pick: false });
        }
        aim(ev);
      },
      up(ev) {
        if (started) aim(ev);
        const target = to;
        const was = started;
        end();
        if (!was) {
          setShapePick({ what: "message", from: part.name, slot }, `From ${said(part.name)} at ${rowWord(slot)}, between the messages around the line shown: click the lifeline it goes to.`);
          setSlotGuide({ y, x1: geo.left, x2: geo.right, pick: true });
          return;
        }
        if (target < 0) {
          setNotice("Not dropped on a lifeline: no message added.");
          return;
        }
        void addMessageAt(part.name, geo.parts[target].name, slot);
      },
      cancel(esc) {
        const was = started;
        end();
        if (was) setNotice(esc ? "Drag cancelled: nothing added." : "The drag ended outside the canvas: nothing added.");
      },
    });
  }

  /** S1: a message dragged up or down; an insertion line shows the row it goes to (Visio, RAD Studio). One undo step. */
  function startMessageDrag(e: ReactPointerEvent, index: number, geo: ReturnType<typeof seqGeometry>, map: ReturnType<typeof flowMapper>) {
    const l = drawnRef.current?.links[index];
    if (!l) return;
    const sy = e.clientY;
    const slots = laneIndex(geo.slots);
    const edge = [`edge:${index}`];
    let started = false;
    let slot = index;
    const aim = (ev: PointerEvent) => {
      const y = map.y(ev.clientY);
      slot = nearestIndex(slots, y);
      const same = slot === index || slot === index + 1;
      orderDrag.pointer(map.x(ev.clientX), y);
      if (orderDrag.target(same ? 0 : 1, slot, geo.left - 16, geo.right + 16, slots[slot])) {
        orderDrag.setTag(same ? "That is where it is now." : "");
        setNotice(same ? "That is where it is now." : `Release to put it on the line shown, as ${rowWord(slot > index ? slot - 1 : slot)}.`);
      }
    };
    const end = () => {
      orderDrag.end();
      if (started) fadeSources([], edge, false);
    };
    followPointer(e, {
      move(ev) {
        if (!started) {
          if (Math.abs(ev.clientY - sy) < 5) return;
          started = true;
          orderDrag.begin("message", l.label ? said(l.label) : `${said(l.from)} to ${said(l.to)}`);
          fadeSources([], edge, true);
        }
        aim(ev);
      },
      up(ev) {
        if (!started) return end();
        aim(ev);
        const at = slot;
        end();
        if (at === index || at === index + 1) {
          setNotice("Dropped where it was: nothing moved.");
          return;
        }
        setNotice(null);
        void doc.run({ op: "moveMessage", index, at }, { onRefused: (w) => setNotice(w) });
      },
      cancel(esc) {
        const was = started;
        end();
        if (was) setNotice(esc ? "Drag cancelled: nothing moved." : "The drag ended outside the canvas: nothing moved.");
      },
    });
  }

  /** S2: a participant's head dragged sideways; a line shows the gap it goes to. Only the participant lines reorder. */
  function startParticipantDrag(e: ReactPointerEvent, part: { name: string; cx: number }, geo: ReturnType<typeof seqGeometry>, map: ReturnType<typeof flowMapper>) {
    const sx = e.clientX;
    const n = geo.parts.length;
    const i = geo.parts.findIndex((x) => x.name === part.name);
    const gaps = laneIndex(Array.from({ length: n + 1 }, (_, j) => (j === 0 ? geo.parts[0].cx - 100 : j === n ? geo.parts[n - 1].cx + 100 : (geo.parts[j - 1].cx + geo.parts[j].cx) / 2)));
    let started = false;
    let slot = i;
    const aim = (ev: PointerEvent) => {
      const x = map.x(ev.clientX);
      slot = nearestIndex(gaps, x);
      const same = slot === i || slot === i + 1;
      orderDrag.pointer(x, map.y(ev.clientY));
      if (orderDrag.target(same ? 0 : 1, slot, gaps[slot], geo.top, geo.bottom)) {
        orderDrag.setTag(same ? "That is where it is now." : "");
        setNotice(same ? "That is where it is now." : `Release to put ${said(part.name)} on the line shown.`);
      }
    };
    const end = () => {
      orderDrag.end();
      if (started) fadeSources([part.name], [], false);
    };
    followPointer(e, {
      move(ev) {
        if (!started) {
          if (Math.abs(ev.clientX - sx) < 5) return;
          started = true;
          orderDrag.begin("participant", said(part.name));
          fadeSources([part.name], [], true);
        }
        aim(ev);
      },
      up(ev) {
        if (!started) return end();
        aim(ev);
        const at = slot;
        end();
        if (at === i || at === i + 1) {
          setNotice("Dropped where it was: nothing moved.");
          return;
        }
        setNotice(null);
        void doc.run({ op: "moveParticipant", name: part.name, before: at < n ? geo.parts[at].name : null }, { onRefused: (w) => setNotice(w) });
      },
      cancel(esc) {
        const was = started;
        end();
        if (was) setNotice(esc ? "Drag cancelled: nothing moved." : "The drag ended outside the canvas: nothing moved.");
      },
    });
  }

  /**
   * The label box on the flow from `from` to `to` just written (its line starts at `at`), once the parse of the
   * text with it is in. Among identical unlabelled flows it is the one on that line; its line is banded.
   */
  async function openLabel(from: string, to: string, at?: number) {
    const g = gestureFrame();
    const cur = await doc.current();
    const links = cur?.result.doc?.links;
    // While the text has an error the drawing is the last good one: its flows do not index the text.
    if (!cur || !links) return;
    const candidates: number[] = [];
    links.forEach((l, i) => {
      if (l.from === from && l.to === to && l.arrow === ">" && !l.label) candidates.push(i);
    });
    if (candidates.length === 0) return;
    const version = cur.result.version;
    const spans = await doc.spans(version, candidates.map((i) => `link:${i}`));
    const view = doc.view();
    // A switch meanwhile: the label box would name the other frame's line.
    if (!spans || !view || !g.still()) return;
    const lineOf = (i: number) => {
      const sp = spans[`link:${i}`];
      return sp ? view.state.doc.lineAt(Math.min(sp.from, view.state.doc.length)) : null;
    };
    const index = (at !== undefined ? candidates.find((i) => lineOf(i)?.from === at) : undefined) ?? candidates[candidates.length - 1];
    setLabelBox({ index, version, from, to, initial: "", fresh: true, line: lineOf(index)?.number, frame: g.frame });
  }

  /**
   * The label is kept, by a key, Escape or a click away (one edit, a new line's being its own undo step); an untouched
   * new label leaves the line unlabelled. Planned only on the box's own parse.
   */
  async function finishLabel(box: LabelBoxState, text: string, how: CommitHow) {
    if (aiLock.current) return;
    const label = text.trim();
    if (box.link) {
      // A relationship's label is planned on the line its ref names, on the text as it is now: a refusal (the line
      // gone, an error in the text) keeps the field open with what was typed and why (the card fields' rule).
      if (label === box.initial) {
        setLabelBox((cur) => (cur === box ? null : cur));
        setLabelError(null);
        if (how !== "blur") canvasEl.current?.focus();
        return;
      }
      let why: string | null = null;
      const r = await doc.run({ op: "setLinkLabel", index: box.index, label: label || null, link: box.link }, { onRefused: (n) => (why = n), ...(box.frame !== undefined ? { frame: box.frame } : {}) });
      // Refused: kept open with the reason (the worker's note, else that the text changed: a crash or restart of the
      // worker, a text that kept changing, a frame gone), and a switch or a tab drag waiting for this commit holds on it
      // (`refusedSince`). The commit is tracked, so the frame it was typed in is still the selected one here.
      if (!r) {
        const said: string = why ?? EDIT_MESSAGES.changed;
        labelRefused.current = { text: said };
        setLabelError((e) => ({ text: said, key: (e?.key ?? 0) + 1 }));
        return;
      }
      setLabelBox((cur) => (cur === box ? null : cur));
      setLabelError(null);
      if (how !== "blur") canvasEl.current?.focus();
      return;
    }
    setLabelBox((cur) => (cur === box ? null : cur));
    if (how !== "blur") canvasEl.current?.focus();
    if (label === box.initial) return;
    await doc.run({ op: "setLinkLabel", index: box.index, label: label || null }, { version: box.version, ...(box.frame !== undefined ? { frame: box.frame } : {}) });
  }

  /** A double-clicked flow's label, in the box: only on the drawing of the current text. */
  const onEdgeDoubleClick = useCallback((id: string) => {
    if (aiLock.current) return;
    const p = parsedRef.current;
    const d = p?.result.doc;
    if (!p || !id.startsWith("edge:")) return;
    // The drawing is the last one without errors: its lines may not be the text's.
    if (!d) {
      setNotice(LINK_NOTES.broken);
      return;
    }
    const index = Number(id.slice("edge:".length));
    const l = d.links[index];
    if (!l) return;
    // a mind map branch is a topic's place under its parent, not a line with words (XMind).
    if (l.tree) {
      setNotice(`Branches carry no label: a branch is ${said(l.to)}'s place under ${said(l.from)}. Double-click the topic to rename it; Ctrl+Shift+L draws a labelled relationship.`);
      return;
    }
    // An ERD's relationship is named by its ref, so a change to the text under the open field neither closes it nor
    // moves the label to another line (R9).
    const link = d.kind === "er" ? linkRefOf(d.links, index) : null;
    setLabelError(null);
    setLabelBox({ index, version: p.result.version, from: l.from, to: l.to, initial: l.label ?? "", fresh: false, frame: doc.frameIdNow(), ...(link ? { link } : {}) });
  }, []);

  async function connect(from: Port, to: Port, at?: Point) {
    if (aiLock.current) return;
    setNotice(null);
    clearDrawGhost();
    if (kind === "er") {
      // A drag from a column's port joins columns, a loop on its own table included.
      if (rel.onPortConnect(from, to, at)) return;
      // A table's own port onto another table: a new column that refers to its key (the board's "refers to").
      const isTable = (name: string) => !!drawnRef.current?.nodes.some((n) => n.name === name && isErTable(n));
      if (from.node !== to.node && isTable(from.node) && isTable(to.node)) return void (await rel.reference(from.node, to.node));
    }
    if (from.node === to.node || from.node.startsWith("\u0000") || to.node.startsWith("\u0000")) return;
    const g = gestureFrame();
    // The faded drawing can hold a node the text no longer defines: a flow to it would only add a problem.
    if (stale) {
      const lines = await doc.linesOf([from.node, to.node]);
      const lost = lines ? [from.node, to.node].find((n) => lines[n] == null) : undefined;
      if (lost !== undefined) {
        setNotice(`${lost} is not defined.`);
        return;
      }
    }
    const r = await doc.run({ op: "addLink", from: from.node, to: to.node, arrow: defaultArrow(kind) }, { frame: g.frame });
    // F13: only a data flow's flows and a sequence's messages are named by definition (open question 2). The label box
    // bands the new line while it is open; elsewhere the pane bands the line the edit wrote.
    if (r && (kind === "dfd" || kind === "sequence")) void openLabel(from.node, to.node, r.at);
    else bandWritten(r?.at);
  }

  /** A flow released on empty canvas (board point `flow`): within 24 px of a node it goes there; else "Add and connect" opens. */
  function onConnectRelease(from: Port, flow: Point) {
    clearDrawGhost();
    if (isArea(from.node)) return;
    // The live frame's shapes and overlay are frame-local; the frames' boxes and the screen are the board's.
    const at = toLive(flow);
    if (kind === "er") {
      // A column's drag: its row, header or nothing under the release decides.
      if (rel.onPortRelease(from, at)) return;
      // Over another frame nothing is added, before the magnet search: no "Add and connect" there (R12).
      if (staticFrameAt(toBoard(flow))) {
        setNotice(RELATE_MESSAGES.otherFrame);
        return;
      }
    }
    const nodes = graphRef.current.nodes.filter((n) => !isArea(n.id));
    const hit = magnetTarget(
      at,
      nodes.filter((n) => n.id !== from.node).map((n) => ({ id: n.id, box: lineBoxOf(n) })),
    );
    if (hit) {
      void connect(from, { node: hit.id, port: hit.side });
      return;
    }
    const source = nodes.find((n) => n.id === from.node);
    if (!source || !kind) return;
    // Let go on its own node (a click on a port): nothing to add.
    if (magnetTarget(at, [{ id: source.id, box: lineBoxOf(source) }], RELEASE_ON_SELF_PX)) return;
    stopPull.current();
    overlay.set({ pending: { d: routeOrthogonal(lineBoxOf(source), { ...at, w: 0, h: 0 }, { toPoint: true }).d, pulling: false } });
    const screen = instance.current?.flowToScreenPosition(toBoard(flow)) ?? flow;
    setQuick({ from: from.node, at, screen });
  }

  /** The drawn line goes back into its port over the pull-back's duration, then goes (at once with motion off). */
  const pullBack = useCallback(
    (from: Box, end: Point) => {
      stopPull.current();
      const home = end.x < from.x ? { x: from.x, y: from.y + from.h / 2 } : { x: from.x + from.w, y: from.y + from.h / 2 };
      const draw = (q: Point) => routeOrthogonal(from, { ...q, w: 0, h: 0 }, { toPoint: true }).d;
      overlay.set({ pending: { d: draw(end), pulling: true } });
      stopPull.current = tween(
        motionMs("pullBack"),
        (p) => overlay.set({ pending: { d: draw({ x: end.x + (home.x - end.x) * p, y: end.y + (home.y - end.y) * p }), pulling: true } }),
        () => {
          stopPull.current = () => {};
          overlay.set({ pending: null });
        },
        easeExit,
      );
    },
    [overlay],
  );

  /** Esc or a click away from "Add and connect": nothing is added and the line pulls back. */
  function cancelQuick() {
    const q = quickRef.current;
    setQuick(null);
    const source = q ? graphRef.current.nodes.find((n) => n.id === q.from) : undefined;
    if (q && source) pullBack(lineBoxOf(source), q.at);
    else overlay.set({ pending: null });
  }

  /** Esc while a flow is still being drawn (locked onto a node or not) pulls it back from where it was. */
  const onDragCancel = useCallback(() => {
    const last = lastDraw.current;
    lastDraw.current = null;
    clearDrawGhost();
    if (last) pullBack(last.from, last.to);
  }, [pullBack]);

  /** The grey preview of a locked flow's line goes when the drag ends or unlocks. */
  function clearDrawGhost() {
    if (drawLock.current === null) return;
    drawLock.current = null;
    setGhost(null);
  }

  // While a drawn flow is locked onto a node, its new line shows in grey where it would be written.
  onDrawRef.current = (fromId, lock) => {
    if (lock === drawLock.current) return;
    drawLock.current = lock;
    if (lock === null) {
      setGhost(null);
      return;
    }
    void doc.plan({ op: "addLink", from: fromId, to: lock, arrow: defaultArrow(kind) }).then((g) => {
      if (drawLock.current === lock) setGhost(g);
    });
  };

  /** "Add and connect": the node where the line ended, on the grid, and the flow to it, as one edit. */
  async function addAndConnect(tool: AddTool) {
    if (aiLock.current) return;
    const q = quickRef.current;
    setQuick(null);
    stopPull.current();
    overlay.set({ pending: null });
    if (!q) return;
    await addConnectedAt(q.from, q.at, tool, true);
  }

  /** A new shape of `tool`'s kind with its left side at `at` (centred on it), and the line from `from` to it, as one edit. */
  async function addConnectedAt(from: string, at: Point, tool: AddTool, centred = false) {
    if (aiLock.current || !kind || tool.kind === "group") return;
    setNotice(null);
    // The new shape opens with its name ready and is written only when the name is kept, centred where the line was
    // let go, or beside its source from the shape menu.
    const nodeKind = toolKind(tool);
    const name = newName(nodeKind);
    const size = newSize(nodeKind, name);
    const spot = centred ? { x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2) } : { x: Math.round(at.x), y: Math.round(at.y - size.h / 2) };
    openNew({ node: nodeKind, at: spot, size, name, from });
  }
  /**
   * F3: the field on the shape is kept (a key, Escape or a click away): its name, or a note's text, with every line
   * that names it, as one undo step. A refused one stays open with the typed text and the reason (F4).
   */
  async function rename(e: Extract<NonNullable<typeof field>, { kind: "label" }>, value: string, how: CommitHow) {
    const old = e.node;
    // Never dropped: under the Assistant's lock the field stays open with what was typed.
    if (aiLock.current) return refuseField(e, EDIT_MESSAGES.locked);
    setNotice(null);
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    const n = known?.nodes.find((x) => x.name === old);
    const isNote = n?.kind === "note";
    const target = value;
    // Left by a key: focus back on the canvas, so F2 or Delete work at once.
    const close = () => {
      if (fieldRef.current === e) setField(null);
      if (how !== "blur") canvasEl.current?.focus();
    };
    // A labelled shape edits the words it shows.
    if (target === (isNote ? (n?.text ?? "") : n ? shownName(n) : old)) return close();
    if (!target) return refuseField(e, needsName(n?.kind, kind));
    const g = gestureFrame();
    let plan: { ops: FlowEditOp[]; name: string; notice: string | null } = { ops: [{ op: "renameNode", old, next: target }], name: target, notice: null };
    if (!isNote) {
      const taken = await doc.linesOf([target]);
      const isTaken = !!taken && taken[target] != null && target !== old;
      // the label rules (labels.ts): a taken name becomes the next free name plus label:, a labelled shape
      // keeps its name while its words are taken.
      const names = known ? namesOf(known) : new Set<string>();
      if (isTaken) names.add(target);
      else names.delete(target);
      const planned = n ? planWords(kind, n, target, names) : isTaken ? null : plan;
      // The field stays open with the reason, a click away included.
      if (!planned) {
        setNotice(takenName(target));
        return refuseField(e, takenName(target));
      }
      if (planned.ops.length === 0) return close();
      plan = planned;
    }
    const next = isNote ? target : plan.name;
    // The axes of its + lines follow the new name, in the same undo step (N2).
    const axes: Record<string, "v" | "h" | null> = {};
    for (const [k, v] of Object.entries(doc.layout.axes ?? {})) {
      const ends = axisEnds(k);
      if (!ends) continue;
      const [from, to] = ends;
      if (from !== old && to !== old) continue;
      if (next === old) continue;
      axes[k] = null;
      axes[axisKey(from === old ? next : from, to === old ? next : to)] = v;
    }
    const op: FlowEditOp | { op: "batch"; ops: FlowEditOp[] } = isNote ? { op: "renameNode", old, next: target } : plan.ops.length === 1 ? plan.ops[0] : { op: "batch", ops: plan.ops };
    const r = await doc.run(op, { frame: g.frame, ...(Object.keys(axes).length ? { axes } : {}) });
    // A refused write keeps the field open with the reason.
    if (!r) return refuseField(e, EDIT_MESSAGES.changed);
    close();
    if (isNote) return;
    if (plan.notice) setNotice(plan.notice);
    if (next === old) return;
    if (hasOwn(doc.layout.nodes, old)) doc.place({ [next]: doc.layout.nodes[old] }, true, r.frame ?? null);
    if (folded.has(old)) setFolded((prev) => new Set([...without(prev, old), next]));
    setSelected([next]);
  }

  /** A group's title kept (a rename), or a new group's (the group, its shapes moved in, one undo step). */
  async function commitGroup(e: Extract<NonNullable<typeof field>, { kind: "group" | "newgroup" }>, value: string, how: CommitHow) {
    if (aiLock.current) return refuseField(e, EDIT_MESSAGES.locked);
    setNotice(null);
    const close = () => {
      if (fieldRef.current === e) setField(null);
      if (how !== "blur") canvasEl.current?.focus();
    };
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    const word = e.kind === "newgroup" ? e.word : (GROUP_WORD[kind ?? "flow"] ?? "Group");
    if (e.kind === "group" && value === e.name) return close();
    if (!value) return refuseField(e, groupNeedsName(word));
    if (known && namesOf(known).has(value)) return refuseField(e, takenName(value));
    let why: string | null = null;
    const r =
      e.kind === "group"
        ? await doc.run({ op: "renameNode", old: e.name, next: value }, { onRefused: (w) => (why = w) })
        : await doc.run(
            {
              op: "batch",
              ops: [
                { op: "addGroup", name: value, group: e.parent },
                // A cloud group is drawn with its frame's icon (board DiagramAddNext).
                ...(kind === "cloud" ? [{ op: "setAttr" as const, name: value, key: "icon" as const, value: "aws-vpc" }] : []),
                ...e.members.map((n) => ({ op: "moveToGroup" as const, name: n, group: value })),
                ...(e.subgroups ?? []).map((n) => ({ op: "moveToGroup" as const, name: n, group: value })),
                // A group whose every shape and group went into the new one goes, as before (N2).
                ...emptiedBy(known, [...e.members, ...(e.subgroups ?? [])], e.parent).map((name) => ({ op: "deleteGroup" as const, name })),
              ],
            },
            { onRefused: (w) => (why = w) },
          );
    if (!r) return refuseField(e, why ?? EDIT_MESSAGES.changed);
    close();
  }

  /** CL1 and T1: the member row or date field on a card is closed; a key sends focus back to the canvas. */
  function closeKindEdit(e: KindEdit, how: CommitHow | "cancel") {
    if (kindEdits.get() === e) setKindEdit(null);
    if (how !== "blur") canvasEl.current?.focus();
  }
  const refuseKind = (e: KindEdit, error: string, more: Partial<KindEdit> = {}) => {
    if (kindEdits.get() !== e) return;
    setKindEdit({ ...e, ...more, error, tries: (e.tries ?? 0) + 1 } as KindEdit);
  };

  /** CL1: a member row kept. A new row writes its line; Enter or Tab opens the next row (draw.io). */
  async function commitMember(e: KindEdit, value: string, how: CommitHow) {
    if (aiLock.current) return refuseKind(e, EDIT_MESSAGES.locked);
    const g = gestureFrame();
    const known = parsedRef.current?.result.doc;
    const owner = known?.nodes.find((n) => n.name === e.node);
    if (!owner || !known) return refuseKind(e, EDIT_MESSAGES.stale, e.kind === "draft" ? { value } : {});
    const rows = owner.rows ?? [];
    const same = (a: string, b: string) => a.replace(/\s/g, "") === b.replace(/\s/g, "");
    if (e.kind === "draft") {
      // An empty new row closes: nothing added (spreadsheets).
      if (!value) return closeKindEdit(e, how);
      if (rows.some((r) => same(r, value))) return refuseKind(e, MEMBER_MESSAGES.taken(value, e.node), { value });
      const r = await doc.run({ op: "addMember", owner: e.node, at: e.at, member: value }, { frame: g.frame });
      // Another frame selected meanwhile: the row is that frame's no more, so nothing reopens in the new one.
      if (!r) return g.still() ? refuseKind(e, EDIT_MESSAGES.changed, { value }) : undefined;
      if (kindEdits.get() !== e) return;
      if (how === "enter" || how === "tab") return setKindEdit({ kind: "draft", node: e.node, at: e.at + 1 });
      return pickAfter(e, { kind: "picked", node: e.node, index: e.at, was: value }, how);
    }
    if (e.kind !== "member") return;
    if (!value) return refuseKind(e, MEMBER_MESSAGES.needsName);
    if (value === e.was) return pickAfter(e, { kind: "picked", node: e.node, index: e.index, was: value }, how);
    if (rows.some((r, i) => i !== e.index && same(r, value))) return refuseKind(e, MEMBER_MESSAGES.taken(value, e.node));
    const r = await doc.run({ op: "setMember", owner: e.node, index: e.index, was: e.was, member: value }, { frame: g.frame });
    if (!r) return g.still() ? refuseKind(e, EDIT_MESSAGES.changed) : undefined;
    pickAfter(e, { kind: "picked", node: e.node, index: e.index, was: value }, how);
  }

  /** A member row kept: the member stays picked, drawn so, and a key sends focus back to the canvas. */
  function pickAfter(e: KindEdit, picked: KindEdit, how: CommitHow) {
    if (kindEdits.get() === e) setKindEdit(picked);
    if (how !== "blur") canvasEl.current?.focus();
  }

  /** T1: an item's date, or a period's two, kept in place; the item moves along the axis, one undo step. */
  async function commitDate(e: KindEdit, date: string, until: string | undefined, how: CommitHow) {
    if (e.kind !== "date") return;
    if (aiLock.current) return refuseKind(e, EDIT_MESSAGES.locked, { date, until, errorAt: undefined });
    const n = (parsedRef.current?.result.doc ?? drawnRef.current)?.nodes.find((x) => x.name === e.node);
    const good = (d: string | undefined) => !!d && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d);
    // The refusal goes back to the field at fault (N5).
    if (!good(date)) return refuseKind(e, DATE_MESSAGES.pick, { date, until, errorAt: "from" });
    if (until !== undefined && !good(until)) return refuseKind(e, DATE_MESSAGES.pickEnd, { date, until, errorAt: "until" });
    const key = (d: string) => (d.length === 4 ? `${d}-01-01` : d.length === 7 ? `${d}-01` : d);
    if (until !== undefined && key(until) < key(date)) return refuseKind(e, DATE_MESSAGES.endBeforeStart, { date, until, errorAt: "until" });
    if (n && date === n.date && until === n.until) return closeKindEdit(e, how);
    const g = gestureFrame();
    const r = await doc.run({ op: "setDate", name: e.node, date, ...(until !== undefined ? { until } : {}) }, { frame: g.frame });
    if (!r) return g.still() ? refuseKind(e, EDIT_MESSAGES.changed, { date, until, errorAt: undefined }) : undefined;
    closeKindEdit(e, how);
  }

  const kindEditCtx = useMemo(
    () => ({
      store: kindEdits,
      api: {
        // Tracked: a frame switch waits for the commit (a blur on the switch), so it lands in its own frame.
        commitMember: (e: KindEdit, v: string, how: CommitHow) => kindApi.current.track(kindApi.current.commitMember(e, v, how)),
        commitDate: (e: KindEdit, d: string, u: string | undefined, how: CommitHow) => kindApi.current.track(kindApi.current.commitDate(e, d, u, how)),
        cancel: (e: KindEdit) => closeKindEditRef.current(e, "cancel"),
        readOnly: ai.locked,
      },
    }),
    [kindEdits, ai.locked],
  );
  const kindApi = useRef({ commitMember, commitDate, track: trackCommit });
  kindApi.current = { commitMember, commitDate, track: trackCommit };
  const closeKindEditRef = useRef(closeKindEdit);
  closeKindEditRef.current = closeKindEdit;

  /** CL1: a member row opens on a class: a member's own text, or a new row before `at` (at the end by default). */
  function openMember(node: string, index: number | null) {
    if (aiLock.current) return;
    const n = (parsedRef.current?.result.doc ?? drawnRef.current)?.nodes.find((x) => x.name === node);
    if (!n) return;
    setNotice(null);
    setSelected([node]);
    if (index === null) {
      setKindEdit({ kind: "draft", node, at: (n.rows ?? []).length });
      return;
    }
    const was = n.rows?.[index];
    if (was === undefined) return;
    setKindEdit({ kind: "member", node, index, was });
  }

  /** T1: the date field opens on an event or a period. */
  function openDate(node: string) {
    if (aiLock.current) return;
    setNotice(null);
    setSelected([node]);
    setKindEdit({ kind: "date", node });
  }

  /** CL1 keys on the picked member: Ctrl+Enter copies it below, Delete removes it, Enter or F2 edits it. */
  function memberKey(e: KeyboardEvent): boolean {
    const m = pickedMember();
    if (!m || kind !== "class" || selectedRef.current.length !== 1 || selectedRef.current[0] !== m.node) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Enter" && ctrl && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void doc.run({ op: "duplicateMember", owner: m.node, index: m.index, was: m.was });
      return true;
    }
    if (ctrl || e.altKey) return false;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setKindEdit(null);
      void doc.run({ op: "deleteMember", owner: m.node, index: m.index, was: m.was });
      return true;
    }
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      openMember(m.node, m.index);
      return true;
    }
    if (e.key === "Escape") {
      setKindEdit(null);
      return false;
    }
    return false;
  }
  /** A selected ER column or a picked class member, which takes Ctrl+Enter as its Duplicate (B3 decision 10, CL1). */
  function ownsCtrlEnter(): boolean {
    const sel = selectedRef.current;
    if (sel.length !== 1) return false;
    if (kind === "er") return er.selected()?.table === sel[0];
    return kind === "class" && pickedMember()?.node === sel[0];
  }
  const pickedMemberRef = useRef(pickedMember);
  pickedMemberRef.current = pickedMember;
  const setKindEditRef = useRef(setKindEdit);
  setKindEditRef.current = setKindEdit;

  /**
   * CL1: a press on a class member's row picks it, drawn picked; a press anywhere else lets it go. A press in an
   * open field is the field's.
   */
  function pressForMember(target: EventTarget | null) {
    const t = target instanceof Element ? target : null;
    if (!t || t.closest(".inline-edit-wrap")) return;
    const open = kindEdits.get();
    if (open && open.kind !== "picked") return;
    const row = kind === "class" ? t.closest(".fkind-row[data-row]") : null;
    const node = row?.closest(".react-flow__node")?.getAttribute("data-id");
    const was = node ? (parsedRef.current?.result.doc ?? drawnRef.current)?.nodes.find((n) => n.name === node)?.rows?.[Number(row!.getAttribute("data-row"))] : undefined;
    if (node && was !== undefined && !aiLock.current) {
      setKindEdit({ kind: "picked", node, index: Number(row!.getAttribute("data-row")), was });
      setSelected((prev) => (prev.length === 1 && prev[0] === node ? prev : [node]));
      return;
    }
    if (open) setKindEdit(null);
  }

  /**
   * One Delete is one edit list and one undo entry, all or nothing. The nodes and their lines fade
   * out first (120 ms exit), then the text loses them; at once with motion off. The edit is planned on the parse
   * of the text as it was when Delete was pressed, so a change during the fade makes it do nothing.
   */
  async function removeSelected() {
    if (aiLock.current) return;
    setNotice(null);
    const names = selectedRef.current;
    const picked = linesRef.current;
    // The selected sketches go in the same undo entry as the shapes and lines; alone, they go at once.
    const goneSketches = removeSketches(sketchList.current, sketchSelRef.current);
    /** A refusal of the shapes' half keeps the sketches too (all or none): the note says so. */
    const refusedWith = (why: string) => (goneSketches.length > 0 ? `${why} Nothing was deleted, the selected sketches included.` : why);
    if (names.length === 0 && picked.length === 0 && goneSketches.length > 0 && !deleting.current) {
      sketchOp(goneSketches);
      setSketchSel([]);
      return;
    }
    if ((names.length === 0 && picked.length === 0) || deleting.current) return;
    deleting.current = true;
    // What fades out: the shapes that go, a mind map topic's subtopics with it.
    let fading: readonly string[] = names;
    const unmark = () =>
      setStates((prev) => {
        const next = new Map(prev);
        for (const n of fading) if (next.get(n) === "leaving") next.delete(n);
        return next.size === prev.size ? prev : next;
      });
    const g = gestureFrame();
    try {
      const planned = await doc.current();
      if (!planned) return;
      // F1: the selected lines by index, last first, so each delete leaves the indexes before it as they were. A
      // mind map's branches come from the indents and are not lines in the text.
      const links = planned.result.doc?.links ?? [];
      const indexes = [...new Set(picked.map(linkIndex))].filter((i): i is number => i !== null && i < links.length && !links[i].tree).sort((a, b) => b - a);
      if (picked.length > 0 && indexes.length === 0 && names.length === 0) {
        // The drawing is the last one that worked: its lines do not name the text's. A mind map branch is no line.
        setNotice(refusedWith(planned.result.doc ? BRANCH_NOTE : "Fix the text first: the drawing is the last one without errors."));
        return;
      }
      // Shapes go, but lines of a drawing that is not the text's are left, and the strip says so.
      const linesLeft = picked.length > 0 && indexes.length === 0 && !planned.result.doc;
      // A mind map topic goes with its subtopics and their relationships; one already inside another's branch
      // goes with that one, and the central idea stays.
      const mind = planned.result.doc?.kind === "mindmap" ? mindTree() : null;
      const under = (n: string) => {
        // The central idea stays, so a topic under it is not taken with it.
        for (let p = mind?.parent.get(n); p !== undefined; p = mind?.parent.get(p)) if (p !== mind?.root && names.includes(p)) return true;
        return false;
      };
      const nodeOps: FlowEditOp[] = mind
        ? names.filter((n) => n !== mind.root && !under(n)).map((n) => (isTopic(n) ? { op: "deleteTopic" as const, name: n } : { op: "deleteNode" as const, name: n }))
        : names.map((n) => ({ op: "deleteNode" as const, name: n }));
      if (mind && names.length > 0 && nodeOps.length === 0 && indexes.length === 0) {
        setNotice(refusedWith("The central idea stays. F2 renames it."));
        return;
      }
      if (mind) fading = nodeOps.flatMap((o) => (o.op === "deleteTopic" ? [o.name, ...subtreeOf(o.name, mind.kids)] : o.op === "deleteNode" ? [o.name] : []));
      // A sequence keeps at least two participants (board DiagramSequence).
      const seq = planned.result.doc?.kind === "sequence" ? planned.result.doc : null;
      if (seq) {
        const parts = seq.nodes.filter((n) => n.kind === "participant" || n.kind === "actor");
        if (names.some((n) => parts.some((p) => p.name === n)) && parts.filter((p) => !names.includes(p.name)).length < 2) {
          setNotice(refusedWith("A sequence keeps at least two participants."));
          return;
        }
      }
      const ops: FlowEditOp[] = [...indexes.map((index) => ({ op: "deleteLink" as const, index })), ...nodeOps];
      const ms = fading.length > 0 ? motionMs("exit") : 0;
      if (ms > 0) {
        setStates((prev) => {
          const next = new Map(prev);
          for (const n of fading) next.set(n, "leaving");
          return next;
        });
        await new Promise((r) => {
          deleteTimer.current = setTimeout(r, ms);
        });
      }
      // The axes of the lines that go, in the same undo step: undo brings them back with their lines (N-B).
      const kept = doc.layout.axes ?? {};
      const goneAxes: Record<string, null> = {};
      const goneNames = new Set(names);
      links.forEach((l, i) => {
        const k = axisKey(l.from, l.to);
        if (Object.prototype.hasOwnProperty.call(kept, k) && (indexes.includes(i) || goneNames.has(l.from) || goneNames.has(l.to))) goneAxes[k] = null;
      });
      // A group whose last shapes go stays drawn where it was: its place in the same undo step (N7).
      const places = emptyPositions();
      const walk = [...(drawnRef.current?.groups ?? [])];
      for (let g = walk.pop(); g; g = walk.pop()) {
        walk.push(...g.groups);
        if (g.groups.length > 0 || g.nodes.length === 0 || !g.nodes.every((n) => goneNames.has(n))) continue;
        const a = graphRef.current.nodes.find((n) => n.id === `\u0000group:${g.name}`);
        if (a) places[g.name] = { x: Math.round(a.position.x), y: Math.round(a.position.y) };
      }
      const r = await doc.run(ops.length === 1 ? ops[0] : { op: "batch", ops }, {
        version: planned.result.version,
        frame: g.frame,
        ...(Object.keys(goneAxes).length ? { axes: goneAxes } : {}),
        ...(Object.keys(places).length ? { move: places } : {}),
        ...(goneSketches.length ? { sketches: goneSketches } : {}),
      });
      if (r) {
        setSelected([]);
        setLines([]);
        if (goneSketches.length) setSketchSel([]);
        if (linesLeft) setNotice("The selected lines were left: fix the text first, the drawing is the last one without errors.");
        // The central idea was selected too and stays: the strip says so (round 2, N2).
        else if (mind && mind.root !== null && names.includes(mind.root)) setNotice("The central idea stays. F2 renames it.");
        // The fade lets go once the next parse lands, whatever it holds: an undo before it, or a faded drawing
        // that still has the node, must not leave it drawn invisible.
        await doc.current();
      }
      unmark();
    } finally {
      deleting.current = false;
    }
  }

  // ----- copy, paste and duplicate (diagram-ux-research F2)

  /** The shapes' .flow lines (with the lines between them) and where they are drawn; null when none is named. */
  function selectionClip(names: readonly string[] = selectedRef.current): { text: string; at: Positions } | null {
    const d = parsedRef.current?.result.doc ?? drawnRef.current;
    if (!d || names.length === 0) return null;
    const text = copyLines(d, names);
    if (!text) return null;
    // Keyed by the names the clipboard's own parse gives: a note is `Note N` by its place among the copied notes.
    const at = emptyPositions();
    const picked = new Set(names);
    let note = 0;
    for (const n of d.nodes) {
      if (!picked.has(n.name)) continue;
      const key = n.kind === "note" ? `Note ${++note}` : n.name;
      const q = drawnAt(n.name);
      if (q) at[key] = { x: q.x, y: q.y };
    }
    return { text, at };
  }

  /** Copies the selection as the clipboard's text; a cut's first paste lands where the shapes were. */
  function copySelection(cut: boolean): string | null {
    // Sketches go on the clipboard as JSON, with the shapes' lines beside them.
    const sk = sketchCopy(cut);
    if (sk) return sk;
    const c = selectionClip();
    if (!c) return null;
    lastClip = { text: c.text, diagram: name, at: c.at, pastes: cut ? -1 : 0 };
    return c.text;
  }

  /** The pointer while it is over the canvas, else the middle of the view, in the live frame's units. */
  function pasteAnchor(): Point {
    const f = instance.current;
    const rect = canvasEl.current?.getBoundingClientRect();
    if (!f) return { x: 0, y: 0 };
    if (pointer.current) return toLive(f.screenToFlowPosition(pointer.current));
    return rect ? toLive(f.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })) : { x: 0, y: 0 };
  }

  const shifted = (at: Positions, d: number): Positions => {
    const out = emptyPositions();
    for (const k of Object.keys(at)) out[k] = { x: at[k].x + d, y: at[k].y + d };
    return out;
  };

  /**
   * Writes .flow lines into the diagram as one edit and one undo entry, with free names, and selects what it wrote.
   * The shapes the text names are drawn at `at` (by the names they were copied under), moved so their top left is at
   * `anchor` when one is given; shapes with no place (text from outside) go in a row from the anchor. A mixed paste's
   * shapes are already placed by its one shared offset: `rest` is its anchor, where only the shapes with no
   * place go. In a mind map the paste goes under the one selected topic, or after `after` (a duplicate).
   * It is for the frame selected when it starts (or `frame`, the gesture's): another frame selected before the worker
   * answers, it writes nothing, quietly. Null when nothing was pasted.
   */
  async function pasteText(
    text: string,
    place: { at?: Positions | null; anchor?: Point | null; rest?: Point; after?: string; sketches?: SketchChange[]; frame?: number },
  ): Promise<RunResult | null> {
    if (aiLock.current || !kind) return null;
    const frame = place.frame ?? doc.frameIdNow();
    setNotice(null);
    // over the limit nothing is sent to the worker at all.
    if (overTextLimit(text)) {
      setNotice("The clipboard text is larger than 1 MB, so nothing was pasted.");
      return null;
    }
    if (nonEmptyLines(text) > MAX_FLOW_NODES) {
      setNotice(TOO_MANY_LINES);
      return null;
    }
    const op: FlowPasteOp = { op: "paste", text };
    if (kind === "mindmap") {
      const sel = selectedRef.current;
      if (place.after !== undefined) op.after = place.after;
      else if (sel.length === 1) op.under = sel[0];
    }
    const refusal = { why: "" };
    const r = await doc.run(op, {
      frame,
      // Sketches pasted with the shapes go in the same undo entry.
      ...(place.sketches && place.sketches.length > 0 ? { sketches: place.sketches } : {}),
      onRefused: (why) => {
        refusal.why = why;
      },
    });
    if (!r) {
      // Another frame selected meanwhile: that is the user's doing, not a failure to say.
      if (doc.frameIdNow() === frame) setNotice(refusal.why || "The text changed while pasting, so nothing was pasted. Try again.");
      return null;
    }
    const names = r.names ?? {};
    const copied = Object.keys(names);
    if (!FIXED_KINDS.has(kind)) {
      const at = place.at ?? emptyPositions();
      const known = copied.filter((o) => hasOwn(at, o));
      const anchor = place.rest ? null : (place.anchor ?? (known.length === copied.length ? null : pasteAnchor()));
      let dx = 0;
      let dy = 0;
      if (anchor && known.length > 0) {
        dx = snap(anchor.x) - Math.min(...known.map((o) => at[o].x));
        dy = snap(anchor.y) - Math.min(...known.map((o) => at[o].y));
      }
      const out = emptyPositions();
      for (const o of known) out[names[o]] = { x: at[o].x + dx, y: at[o].y + dy };
      // Shapes with no place go in a compact block from the anchor, as near square as it can be.
      const rest = copied.filter((o) => !hasOwn(out, names[o]));
      const cols = Math.max(1, Math.ceil(Math.sqrt(rest.length)));
      const from = place.rest ?? anchor;
      const ax = from ? snap(from.x) : 0;
      const ay = from ? snap(from.y) : 0;
      rest.forEach((o, i) => {
        out[names[o]] = { x: ax + (i % cols) * PASTE_CELL.w, y: ay + Math.floor(i / cols) * PASTE_CELL.h };
      });
      // In the frame the paste went to, never the one selected now.
      doc.place(out, true, r.frame ?? null);
    }
    if (r.note) setNotice(r.note);
    const made = Object.values(names);
    for (const n of made) enter(n);
    setLines([]);
    setSelected(made);
    return r;
  }

  /** Ctrl+V (or its clipboard event): next to the originals on their own diagram, a step further each time (draw.io). */
  /**
   * Step 10 (user decision, 25 Oct): Mermaid pasted in the text (`where`, the selection) or on the canvas (after the last
   * line) is translated by the Mermaid importer. The Mermaid goes in at once, exactly as a plain paste would, so it is
   * never lost; its translation then replaces it as a second undo step, so a second Ctrl+Z leaves the
   * Mermaid as pasted (VS Code's paste-then-undo). A kind this diagram does not take, and an ER diagram, are refused
   * before anything is pasted. Over the whole file, or into a file with no shapes, the paste sets the kind and keeps the
   * title (and the comments); elsewhere it never lands above the `diagram` line. On a board all of this is about
   * the frame that holds the paste, frame 0 (the one drawn) for a paste on the canvas.
   */
  function pasteMermaid(raw: string, where: { from: number; to: number } | null) {
    if (aiLock.current) return setNotice("The Assistant is working on the text, so nothing was pasted. Paste again once it finishes.");
    const view = doc.view();
    if (!view) return;
    const full = view.state.doc.toString();
    const word = kindWord(headOf(raw.split(/\r?\n/, 400)).head);
    if (word === null) return;
    if (word === "erDiagram") return setNotice(ER_REFUSED);
    const theirs = MERMAID_KINDS[word];
    const whole = !!where && where.from === 0 && where.to === full.length && full.length > 0;
    // On a board the Mermaid goes into one frame, read and written as a diagram of its own.
    const frame = whole ? { from: 0, to: full.length } : pasteFrame(full, where);
    if (!frame) return setNotice("The selection takes more than one diagram, so nothing was pasted. Select inside one diagram.");
    const text = full.slice(frame.from, frame.to);
    const here = (/^\uFEFF?[ \t]*diagram[ \t]+(\w+)/.exec(text)?.[1] ?? null) as DiagramKind | null;
    const shapeless = text.split(/\r?\n/).slice(here ? 1 : 0).every((l) => l.trim() === "" || l.trim().startsWith("//"));
    if (!whole && !shapeless && here && theirs !== here) {
      return setNotice(`The pasted Mermaid is ${article(KIND_SHORT[theirs])} and this is ${article(KIND_SHORT[here])}, so nothing was pasted. New diagram > From Mermaid makes it a diagram of its own.`);
    }
    const title = frame.from === 0 ? (parsedRef.current?.result.doc?.title ?? drawnRef.current?.title ?? name) : parseFlow(text).title || name;
    const rawFrom = where ? where.from : frame.to;
    const rawTo = where ? where.to : frame.to;
    const lead = !where && text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    // Pasted as it is until it is translated: not typing, so the pane does not follow the Mermaid as a frame of its own.
    view.dispatch({ changes: { from: rawFrom, to: rawTo, insert: lead + raw }, selection: { anchor: rawFrom + lead.length + raw.length }, userEvent: "input.paste", annotations: [isolateHistory.of("full"), canvasEdit.of(true)] });
    const own = where && { from: where.from - frame.from, to: where.to - frame.from };
    void translateMermaid({ raw, full, frame, text, where: own, pasted: view.state.doc, view, title, whole, shapeless });
  }

  /**
   * The second half of a Mermaid paste: the translation over the Mermaid as pasted, or the reason it stays. `text` is
   * the frame's span `frame` of the file `full` as it was before the paste, and `where` is relative to it.
   */
  async function translateMermaid(p: {
    raw: string;
    full: string;
    frame: { from: number; to: number };
    text: string;
    where: { from: number; to: number } | null;
    pasted: unknown;
    view: EditorView;
    title: string;
    whole: boolean;
    shapeless: boolean;
  }) {
    const stays = (why: string) => setNotice(why);
    let r;
    try {
      r = await client.mermaid(p.raw, p.title, { keepUnread: true });
    } catch (e) {
      return stays(`The Mermaid could not be translated (${e instanceof Error ? e.message : String(e)}), so it stays as pasted.`);
    }
    if (doc.view() !== p.view || p.view.state.doc !== p.pasted) return stays("The text changed while the Mermaid was translated, so it stays as pasted.");
    if (aiLock.current) return stays("The Assistant started on the text, so the Mermaid stays as pasted.");
    if (!r.flow) return stays(`${r.errors[0]?.text ?? "The Mermaid did not convert."} It stays as pasted.`);
    const text = p.text;
    const headEnd = /^\uFEFF?[ \t]*diagram[ \t]/.test(text) ? (text.indexOf("\n") < 0 ? text.length : text.indexOf("\n") + 1) : 0;
    const header = `diagram ${r.kind} ${quote(p.title)}`;
    const body = r.flow.slice(r.flow.indexOf("\n") + 1);
    // A selection that takes the `diagram` line but not the whole file leaves no line to keep the kind (N5).
    if (!p.whole && p.where && headEnd > 0 && p.where.from < headEnd && p.where.to > p.where.from) {
      return stays("The selection takes the diagram's first line, so the Mermaid stays as pasted. Select from line 2, or the whole file, to translate it.");
    }
    let final: string;
    if (p.whole) final = `${header}\n${body}`;
    else if (p.shapeless) {
      // The kind from the Mermaid; the title and the comments not selected stay (M12; fix round 2, N4).
      const sel = p.where && p.where.from >= headEnd ? p.where : null;
      const kept = sel ? text.slice(headEnd, sel.from) + text.slice(sel.to) : text.slice(headEnd);
      final = `${header}\n${kept}${kept && !kept.endsWith("\n") ? "\n" : ""}${body}`;
    } else {
      const sel = p.where ?? { from: text.length, to: text.length };
      const rest = text.slice(0, sel.from) + text.slice(sel.to);
      let at: number | undefined;
      if (p.where) {
        at = Math.max(sel.from, headEnd);
        if (at > 0 && at < rest.length && rest[at - 1] !== "\n") at = rest.indexOf("\n", at) < 0 ? rest.length : rest.indexOf("\n", at) + 1;
        if (at === rest.length && rest.length > 0 && !rest.endsWith("\n")) at = undefined;
      }
      const ins = insertFlow(rest, parseFlow(rest), r.flow, at);
      if (ins.edits.length === 0) return stays(`${ins.note ?? "The Mermaid could not go in here."} It stays as pasted.`);
      final = ins.edits.slice().sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), rest);
    }
    final = p.full.slice(0, p.frame.from) + final + p.full.slice(p.frame.to);
    const now = p.view.state.doc.toString();
    let a = 0;
    while (a < now.length && a < final.length && now[a] === final[a]) a++;
    let b = 0;
    while (b < now.length - a && b < final.length - a && now[now.length - 1 - b] === final[final.length - 1 - b]) b++;
    // The tab's own rewrite of what was pasted: the pane may hide part of it while the Mermaid reads as a frame of its own.
    p.view.dispatch({ changes: { from: a, to: now.length - b, insert: final.slice(a, final.length - b) }, userEvent: "input.paste", annotations: [isolateHistory.of("full"), canvasEdit.of(true)] });
    setNotice("Pasted Mermaid as flow text.");
  }

  /**
   * Insert from the Mermaid dialog (draw.io's Arrange > Insert > Mermaid): the converted text goes in as one undo step,
   * taken names come in free, and the new shapes are selected.
   */
  async function insertMermaid(flow: string): Promise<string | null> {
    if (aiLock.current) return "The Assistant is working on the text. Insert again once it finishes.";
    let why: string | null = null;
    const r = await doc.run({ op: "insert", text: flow }, { onRefused: (w) => (why = w) });
    if (!r) return why ?? "The diagram changed meanwhile, so nothing was inserted.";
    setGroupSel(null);
    setLines([]);
    setSelected(Object.values(r.names ?? {}));
    setNotice(`Inserted from Mermaid into ${name}, selected. One undo step.${r.note ? ` ${r.note}` : ""}`);
    return null;
  }

  /** From my database (decision 9, R23): the schema's ER frame in the middle of the view, selected, with an Undo toast. */
  async function addDatabaseFrame(frame: ErFromModel, source: FrameSource): Promise<string | null> {
    if (aiLock.current) {
      setNote({ text: EDIT_MESSAGES.locked, key: Date.now() });
      return EDIT_MESSAGES.locked;
    }
    const r = await doc.addFrames([{ text: frame.text, source }], viewMiddle());
    if ("refused" in r) return r.refused || EDIT_MESSAGES.changed;
    // The title it got: a taken one is made free ("shop 2").
    addedFrame.current = { titles: r.titles, boxes: r.boxes, toast: addedDatabaseText({ ...frame, title: r.titles[0] }), depth: historyDepth() };
    return null;
  }

  // The Shelf's From my database item opens the dialog through this (set each render; the Shelf reads it on click).
  openFromDatabase.current = onFromDatabase ? () => onFromDatabase({ file: name, run: addDatabaseFrame }) : null;

  /** From Mermaid (decision 9, R23): the converted flow as a frame in the middle of the view, selected, with an Undo toast. */
  async function addMermaidFrame(flow: string, direction: FlowDirection): Promise<string | null> {
    if (aiLock.current) {
      setNote({ text: EDIT_MESSAGES.locked, key: Date.now() });
      return EDIT_MESSAGES.locked;
    }
    const r = await doc.addFrames([{ text: flow, direction }], viewMiddle());
    if ("refused" in r) return r.refused || EDIT_MESSAGES.changed;
    addedFrame.current = { titles: r.titles, boxes: r.boxes, toast: `Added ${r.titles[0]}.`, depth: historyDepth() };
    return null;
  }

  openFromMermaid.current = onMermaidFrame ? () => onMermaidFrame({ file: name, run: addMermaidFrame }) : null;

  // ----- the Shelf (B2 decisions 2, 7 and 9)

  /** The middle of the view on the board: where a click in the Shelf adds (decision 7). */
  function viewMiddle(): Point {
    const rect = canvasEl.current?.getBoundingClientRect();
    return boardPointAt(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 });
  }
  viewMiddleRef.current = viewMiddle;

  /**
   * Opens the Shelf (Add, More shapes, `/` off the canvas, Tab in the Space box with its search): an armed tool is
   * disarmed and the Space box closes (Figma's insert).
   */
  function openShelf(from: "add" | "more" | "slash" | "template", tab: "diagrams" | "shapes" = "diagrams", query = "", side?: "right") {
    setSpaceBox(null);
    arm("select");
    setShelf({ tab, query, from, side });
  }

  /** Closes the Shelf. If it held focus, focus goes back to what opened it (R16); a press elsewhere keeps its own. */
  function closeShelf(reason: ShelfCloseReason) {
    const from = shelf?.from;
    if (reason !== "outside") {
      // After an add the keys go to the canvas (a text or note field opened by it takes them next).
      const opener = reason === "add" || from === "slash" ? canvasEl.current : from === "more" ? toolbarSlot.current?.querySelector<HTMLElement>('[data-tool="more"]') : from === "template" ? templateOpener.current : addButton.current;
      refocusAfterMenu(opener);
    }
    setShelf(null);
    // An add from the Space box ends it as one from the Shelf does.
    if (reason === "add") setSpaceBox(null);
    // A drag ends with the Shelf too: when an add closes it mid-drag, its tile is gone before the browser's dragend.
    setShelfDrag(undefined);
  }

  /** Why a Shelf item cannot be added now: a shape of the live frame that needs a selection (as the old Shapes list showed). */
  function shelfDisabled(item: ShelfItem): string | null {
    if (item.kind !== "shape" || !kind || item.frameKind !== kind) return null;
    // An old-form ER frame shows every ER shape disabled with the rewrite note.
    if (kind === "er" && parsed?.frame?.oldEr) return ER_NOTES.oldForm;
    const sh = shapesOf(kind).find((x) => x.label === item.label);
    return sh ? shapeDisabled(sh) : null;
  }

  /**
   * I4 (decision 11): one ER column pasted on the one selected table becomes its column, after the selected column or
   * at the end, through `planColumnPaste` and `run` in the paste's frame, tracked across a switch (R4). With no table
   * selected it says so. False when the text is not a column, so it pastes as shapes.
   */
  function pasteColumn(text: string, frame?: number): boolean {
    const d = parsedRef.current?.result.doc ?? null;
    const copied = lastClip?.column ?? null;
    // An old-form frame has errors, so its tables are the drawing's: a column line of one is still a column paste.
    if (!columnPasteLine(text, d ?? drawnRef.current, copied)) return false;
    // Refused with the reason, as every card gesture is, whatever is selected: the lock (R23), an old-form frame
    // (Review Focus 4), a text with an error. Never a shape paste then: the worker would write the column's line as a
    // top-level line of the diagram (final review I2).
    const no = erRefusal({ ...erGate, stale: () => !d });
    if (no || !d) {
      setNotice(no?.note ?? EDIT_MESSAGES.stale);
      return true;
    }
    const sel = selectedRef.current;
    const table = sel.length === 1 ? d.nodes.find((n) => n.name === sel[0] && isErTable(n)) : undefined;
    if (!table) {
      setNotice("Select a table to paste the column into.");
      return true;
    }
    const picked = er.selected();
    const count = (table.rows ?? []).length;
    const at = picked && picked.table === table.name && picked.index < count ? picked.index + 1 : count;
    const op = planColumnPaste(text, d, table, at, copied);
    if (!op) return false;
    const f = frame ?? doc.frameIdNow();
    let note: string | null = null;
    setNotice(null);
    const p = doc.run(op, { onRefused: (n) => (note = n), frame: f });
    trackCommit(p);
    const store = er.value.store;
    void p.then((r) => {
      if (doc.frameIdNow() !== f) return;
      if (!r) return setNotice(note ?? EDIT_MESSAGES.changed);
      bandWritten(r.at);
      // The pasted column is the selected one (draw.io, Figma), as a duplicate's copy is.
      store.set({ selected: { table: table.name, index: at } });
    });
    return true;
  }

  /** Ctrl+V, the paste event and the menu's Paste: a column on an ER table first (decision 11), true when it took the text. */
  const pastedAsColumn = (text: string, frame?: number) => kind === "er" && pasteColumn(text, frame);

  function pasteFromKeys(text: string, frame?: number) {
    if (pastedAsColumn(text, frame)) return;
    const sketches = readSketchClip(text);
    if (sketches) return pasteSketchClip(text, sketches, frame);
    if (isMermaid(text)) return pasteMermaid(text, null);
    const c = lastClip && lastClip.text === text ? lastClip : null;
    // At the pointer while it is over the canvas, keeping the copied arrangement.
    if (pointer.current) return pasteText(text, { at: c?.at ?? null, anchor: pasteAnchor(), frame });
    if (c && c.diagram === name) {
      c.pastes += 1;
      // A cut's first paste lands where the shapes were, but not over them when the cut was undone.
      const drawnNow = new Set(drawnRef.current?.nodes.map((n) => n.name));
      if (c.pastes === 0 && Object.keys(c.at).some((k) => drawnNow.has(k))) c.pastes = 1;
      return pasteText(text, { at: shifted(c.at, PASTE_STEP * c.pastes), frame });
    }
    return pasteText(text, { at: c?.at ?? null, anchor: pasteAnchor(), frame });
  }

  /** Ctrl+D: copies of the selection one step away; the clipboard is left as it is (draw.io). */
  async function duplicate() {
    if (aiLock.current) return;
    const names = selectedRef.current;
    const c = selectionClip(names);
    if (!c) return;
    // A mind map's copies go after the first selected topic's branch, as its siblings.
    const after = kind === "mindmap" ? drawnRef.current?.nodes.find((n) => names.includes(n.name) && n.kind !== "note")?.name : undefined;
    await pasteText(c.text, { at: shifted(c.at, PASTE_STEP), ...(after !== undefined ? { after } : {}) });
  }

  cloneTo.current = (ids, at, sketches) => {
    const c = selectionClip(ids);
    const copies = sketches ?? [];
    // Never half a copy: with no shape lines to paste the sketch copies are written alone; a refused paste writes
    // neither, and the copies it would have selected are let go.
    if (!c) {
      if (copies.length > 0) doc.sketch(copies);
      return;
    }
    void pasteText(c.text, { at, frame: doc.frameIdNow(), ...(copies.length > 0 ? { sketches: copies } : {}) }).then((r) => {
      if (copies.length === 0) return;
      // The copies' ids, picked again when a sketch drawn meanwhile took one.
      setSketchSel(r ? (r.sketchIds ?? []) : []);
    });
  };

  function copyFromMenu(cut: boolean) {
    const text = copySelection(cut);
    if (!text) return;
    void writeClipboard(text);
    if (cut) void removeSelected();
  }

  /** The canvas menu's Paste: the clipboard's text where the menu was opened (draw.io's Paste here). */
  async function pasteFromMenu(at: Point) {
    const g = gestureFrame();
    const text = (await readClipboard()) || lastClip?.text || "";
    if (!g.still()) return;
    if (pastedAsColumn(text, g.frame)) return;
    const sketches = readSketchClip(text);
    if (sketches) return pasteSketchClip(text, sketches, g.frame);
    const c = lastClip && lastClip.text === text ? lastClip : null;
    await pasteText(text, { at: c?.at ?? null, anchor: at, frame: g.frame });
  }

  /** A copy whose clipboard event should follow; when the WebView sends none, the text is written there directly. */
  function expectCopy(text: string) {
    copyPending.current = text;
    setTimeout(() => {
      if (copyPending.current !== text) return;
      copyPending.current = null;
      void writeClipboard(text);
    });
  }

  /** The copy and cut events: the selection's lines go on the system clipboard, for other apps and the text side. */
  const onClipboardCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (isField(e.target)) return;
    const text = copyPending.current ?? copySelection(false);
    copyPending.current = null;
    if (!text) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  };
  const onClipboardPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (isField(e.target)) return;
    pastePending.current = false;
    e.preventDefault();
    // An empty clipboard (on Linux Contura keeps an empty offer, paste_guard.rs) pastes the last copy made here.
    const text = e.clipboardData.getData("text/plain") || lastClip?.text;
    // The paste is for the frame selected now: a switch before the worker answers writes nothing.
    if (text) void pasteFromKeys(text, gestureFrame().frame);
  };

  /**
   * Every node glides to its laid-out place (answer 4A, 240 ms). With two or more nodes selected only they are
   * laid out, kept where the selection's top left corner was. One move, one undo entry; the text is unchanged.
   */
  /**
   * Tidy: two or more selected shapes are laid out among themselves, else the whole frame. `scope` "frame" is the frame
   * bar's Reset layout (the whole frame whatever is selected); "selection" is Tidy selection (nothing with fewer than two).
   */
  async function tidy(scope?: "frame" | "selection") {
    if (aiLock.current) return;
    const d = drawnRef.current;
    if (!d || d.nodes.length === 0 || FIXED_KINDS.has(d.kind)) return;
    const names = new Set(d.nodes.map((n) => n.name));
    const picked = scope === "frame" ? [] : selectedRef.current.filter((n) => names.has(n));
    if (scope === "selection" && picked.length < 2) return;
    const only = picked.length >= 2 ? new Set(picked) : null;
    const input = layoutInput(d, look, textScale);
    const req = only ? { nodes: input.nodes.filter((n) => only.has(n.id)), edges: input.edges.filter((e) => only.has(e.from) && only.has(e.to)) } : input;
    let p: Positions;
    const g = gestureFrame();
    try {
      p = await client.layout({ ...req, existing: {}, rankdir: layout.direction });
    } catch {
      // The worker restarted: the drawing stays as it is.
      return;
    }
    // Another frame selected meanwhile: these places are the frame left's (`move` writes the selected frame).
    if (!g.still()) return;
    const now = emptyPositions();
    for (const n of req.nodes) {
      const q = drawnAt(n.id);
      if (q) now[n.id] = q;
    }
    const target = emptyPositions();
    for (const n of req.nodes) if (hasOwn(p, n.id)) target[n.id] = { x: snap(p[n.id].x), y: snap(p[n.id].y) };
    const keys = Object.keys(target);
    if (keys.length === 0) return;
    if (only) {
      const placed = keys.filter((k) => hasOwn(now, k));
      if (placed.length > 0) {
        const dx = Math.min(...placed.map((k) => now[k].x)) - Math.min(...keys.map((k) => target[k].x));
        const dy = Math.min(...placed.map((k) => now[k].y)) - Math.min(...keys.map((k) => target[k].y));
        for (const k of keys) target[k] = { x: target[k].x + dx, y: target[k].y + dy };
      }
    }
    const from = emptyPositions();
    for (const k of keys) if (hasOwn(now, k)) from[k] = now[k];
    doc.move(target);
    glideTo(from, target, "tidy");
  }

  const tools = kind ? ADD_TOOLS[kind] : [];
  /**
   * A double-click on the empty canvas: on a group's title it renames the group; anywhere else "Add here". The
   * title takes no presses of its own, so a box select or a pan started on it still works.
   */
  function paneDoubleClick(p: { screen: Point; flow: Point }) {
    // A static ERD card's table or column: its frame is selected and that field opens there (R2).
    const hit = staticErHit(toBoard(p.flow));
    if (hit) return void editStaticEr(hit);
    // A static frame's space is not the live frame's: its clicks select it, nothing is added there.
    if (staticFrameAt(toBoard(p.flow))) return;
    // The rest is the live frame's, in its own units.
    const local = toLive(p.flow);
    const group = groupTitleAt(local);
    if (group !== null) return startGroupRename(group);
    // With an ERD live, a double-click adds a table at the pointer, in its frame or outside every frame (R14).
    if (kind === "er") return void openNewTable(local, null);
    setPaneAdd({ screen: p.screen, flow: local });
  }

  /**
   * B3 decision 5 (R2): what a double-click on a static ERD frame's card at a flow point meant, by position: the frame,
   * its table (`staticShapeAt`), the row (`erRowY` at scroll 0: static cards do not scroll) and the field, read from the
   * static card's `[data-er-field]` rects (measured under `pointer-events: none` too). Row null with a `name` field is
   * the card's empty space under its rows (a new column there). Null off every static ER card.
   */
  function staticErHit(p: Point): { frame: FrameBox; table: string; row: number | null; field: "head" | "name" | "type" } | null {
    const frame = staticFrameAt(p);
    const b = boardRef.current;
    if (!frame || !b || parsed?.result.frames[frame.index]?.kind !== "er") return null;
    const table = staticShapeAt(frame, p);
    if (table === null) return null;
    const id = frame.key === null ? clashInFrameId(frame.index, table) : inFrameId(frame.key, table);
    const frameNode = b.nodes.find((n) => n.type === "boardFrame" && (n.data as { box: FrameBox }).box.index === frame.index);
    const n = frameNode ? b.children.get(frameNode.id)?.find((x) => x.id === id) : undefined;
    if (!n) return null;
    const kindOf = (n.data as { kind?: string } | undefined)?.kind;
    if (kindOf !== "erTable" && kindOf !== "erWeak") return null;
    const top = frame.y + n.position.y;
    const h = n.initialHeight ?? 0;
    const y = p.y - top;
    // The card's geometry at its frame's text size.
    const m = erMetrics((n.data as { textScale?: number }).textScale ?? 1);
    const rowsTop = m.mid - m.row / 2;
    // Above the rows (the header and its border) is the table's name.
    if (y < rowsTop) return { frame, table, row: null, field: "head" };
    const rows = (n.data as { rows?: string[] }).rows ?? [];
    const row = Math.floor((y - rowsTop) / m.row);
    // The card's empty space below its rows adds a column there, as on the live card (row null, a new name).
    if (row < 0 || row >= rows.length || y > h) return { frame, table, row: null, field: "name" };
    // The field under the pointer, from the card as drawn (a pictured frame has none: it is one image).
    const card = [...(canvasEl.current?.querySelectorAll<HTMLElement>(".react-flow__node") ?? [])].find((e) => e.getAttribute("data-id") === id);
    const s = instance.current?.flowToScreenPosition(p);
    let field: "name" | "type" = "name";
    if (card && s) {
      const type = card.querySelector(`[data-er-row="${row}"] [data-er-field="type"]`)?.getBoundingClientRect();
      if (type && type.width > 0 && s.x >= type.left && s.x <= type.right && s.y >= type.top && s.y <= type.bottom) field = "type";
    }
    return { frame, table, row, field };
  }

  /** Selects a static ERD frame with its table, then opens the field the double-click meant on the now-live card (R3). */
  function editStaticEr(hit: NonNullable<ReturnType<typeof staticErHit>>) {
    const sel = { title: hit.frame.title, index: hit.frame.index };
    // A pictured frame is one image with no card drawn: the frame and the table are only selected.
    if (boardRef.current?.pictured.has(frameNodeId(hit.frame))) return switchFrame(sel, [hit.table]);
    return switchFrame(
      sel,
      [hit.table],
      () => {
        const api = erRef.current.value.api;
        if (hit.field === "head") api.editTable(hit.table);
        else if (hit.row === null) api.addColumn(hit.table);
        else api.editColumn(hit.table, hit.row, hit.field);
      },
      true,
    );
  }

  /**
   * The group whose title is at `at`, or null (N3): the title's own band, its icon and name plus a little padding, not
   * the group's whole width; the innermost group first. Area nodes take no presses, so the canvas finds the title.
   */
  /**
   * A title's band width: the title as drawn (its icon and name, at the zoom), with its inset and padding; the guess from
   * its letters only while it is not drawn.
   */
  function titleBand(name: string, groupW: number, widths: ReadonlyMap<string, number> = titleWidths()): number {
    const w = widths.get(name) ?? 0;
    return w > 0 ? Math.min(groupW, 12 + w + 12) : titleWidth(name, groupW);
  }

  /** Each drawn group title's width in flow units, read in one pass over the drawn areas. */
  function titleWidths(): Map<string, number> {
    const out = new Map<string, number>();
    const zoom = instance.current?.getViewport().zoom || 1;
    for (const a of canvasEl.current?.querySelectorAll<HTMLElement>(".flow-area") ?? []) {
      const name = a.getAttribute("aria-label")?.replace(/^Group /, "");
      const w = a.querySelector(".flow-area-name")?.getBoundingClientRect().width ?? 0;
      if (name !== undefined && w > 0) out.set(name, w / zoom);
    }
    return out;
  }

  function groupTitleAt(at: Point): string | null {
    const nodes = graphRef.current.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!n.id.startsWith("\u0000group:")) continue;
      const name = n.id.slice("\u0000group:".length);
      const b = boxOfNode(n);
      if (at.x >= b.x && at.x <= b.x + titleBand(name, b.w) && at.y >= b.y && at.y <= b.y + TITLE_BAND) return name;
    }
    return null;
  }

  /** F3: what a double-click on shape `n` edits, by the part it landed on. */
  function editAt(n: string, target: EventTarget | null) {
    // A sketch is never a live shape: its own double-click.
    if (isSketchNodeId(n)) return sketchDoubleClick(sketchIdOf(n)!, target);
    if (aiLock.current || isStaticId(n)) return;
    if (isArea(n)) {
      // F9: a double-click on a group's title renames it there (draw.io, Figma, Miro); the rest of its area is canvas.
      const group = n.slice("\u0000group:".length);
      const open = fieldRef.current;
      if (target instanceof Element && target.closest(".flow-area-name") && !(open?.kind === "group" && open.name === group)) {
        selectGroup(group);
        startGroupRename(group);
      }
      return;
    }
    const node = drawnRef.current?.nodes.find((x) => x.name === n);
    if (!node) return;
    const part = target instanceof Element ? target : null;
    if (node.kind === "class" || node.kind === "interface" || node.kind === "enum") {
      const row = part?.closest("[data-row]");
      if (row) return openMember(n, Number(row.getAttribute("data-row")));
      if (part?.closest(".fkind-head")) return startRename(n);
      return openMember(n, null);
    }
    if ((node.kind === "event" || node.kind === "period") && part?.closest('[data-part="date"]')) return openDate(n);
    setSelected([n]);
    startRename(n);
  }
  /** F2 edits the one selected shape's name in place. */
  function startRename(node: string) {
    if (aiLock.current) return;
    // An ER table's name is edited in its card's header (ER build A).
    if (kind === "er" && drawnRef.current?.nodes.some((n) => n.name === node && isErTable(n))) {
      er.value.api.editTable(node);
      return;
    }
    // F3: a state's start and end markers have no name (board DiagramEditInPlace).
    if (kind === "state" && isStateMarker(node)) {
      setNotice(MARKER_NOTE);
      return;
    }
    openField({ kind: "label", node });
  }
  /** A group's title edited in place (a double-click on it). */
  function startGroupRename(name: string) {
    if (aiLock.current) return;
    setNotice(null);
    openField({ kind: "group", name });
  }
  /** A nudge burst under way: where its shapes were before the first press, and where they are now. */
  const nudging = useRef<{ before: Positions; after: Positions } | null>(null);
  /** Keeps a nudge burst as one move and one undo entry. */
  function endNudge() {
    const n = nudging.current;
    nudging.current = null;
    // The sketches of the same burst go in the same move.
    const sk = takeSketchNudge();
    if (n || sk.length > 0) doc.move(n?.after ?? emptyPositions(), n?.before, sk);
  }
  /** Whether the open menu came from Shift+F10 or the Menu key. */
  const menuFromKeys = useRef(false);
  /**
   * Shift+F10 and the Menu key (Windows): the menu of what is selected, at it: several selected, one shape, one
   * line, else the canvas at the middle of the view.
   */
  function openKeyboardMenu() {
    const f = instance.current;
    const rect = canvasEl.current?.getBoundingClientRect();
    const middle = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 };
    const centreOf = (id: string): Point | null => {
      const g = graphRef.current.nodes.find((n) => n.id === id);
      const p = drawnAt(id) ?? g?.position;
      return g && p ? { x: p.x + (g.initialWidth ?? 0) / 2, y: p.y + (g.initialHeight ?? 0) / 2 } : null;
    };
    const sel = selectedRef.current;
    const picked = linesRef.current;
    let target: Pick<CanvasMenuAt, "node" | "line" | "selection"> = { node: null };
    let flowAt: Point | null = null;
    if (sel.length + picked.length > 1) {
      target = { node: null, selection: true };
      flowAt = sel[0] ? centreOf(sel[0]) : null;
    } else if (sel.length === 1) {
      target = { node: sel[0] };
      flowAt = centreOf(sel[0]);
      // A selected ER column: its own menu, as a right-click on it opens.
      const col = er.selected();
      if (kind === "er" && col && col.table === sel[0]) er.value.api.pointColumn(col.table, col.index);
    } else if (picked.length === 1) {
      target = { node: null, line: picked[0] };
      const l = drawnRef.current?.links[linkIndex(picked[0]) ?? -1];
      const a = l ? centreOf(l.from) : null;
      const b = l ? centreOf(l.to) : null;
      flowAt = a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
    }
    // The shape's centre is frame-local: on the board it is that plus the live frame's place.
    const screen = flowAt && f ? f.flowToScreenPosition(fromLive(flowAt)) : middle;
    menuFromKeys.current = true;
    openMenu({ ...target, screen, flow: f ? f.screenToFlowPosition(screen) : { x: 0, y: 0 }, fit: () => void canvasFit.current() });
  }

  /**
   * F7: the arrow keys nudge `names` 1 px, Shift 16 px (Figma, draw.io); a held key's repeats are drawn at once and
   * kept as one move, one undo entry, when the key goes up (endNudge).
   */
  function nudgeKey(e: KeyboardEvent, names: readonly string[]): boolean {
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!nudge || names.length === 0 || !drawnRef.current || FIXED_KINDS.has(drawnRef.current.kind)) return false;
    e.preventDefault();
    const step = e.shiftKey ? 16 : 1;
    if (!e.repeat) endNudge();
    const after = emptyPositions();
    for (const n of names) {
      const p = drawnAt(n);
      if (p) after[n] = { x: p.x + nudge[0] * step, y: p.y + nudge[1] * step };
    }
    if (!nudging.current) {
      const before = emptyPositions();
      for (const n of Object.keys(after)) before[n] = drawnAt(n)!;
      nudging.current = { before, after };
    } else nudging.current.after = { ...nudging.current.after, ...after };
    doc.place(after, true);
    return true;
  }

  /**
   * Step 9 (F9): a selected group's keys. Delete and Backspace ask what to keep; F2 and Enter rename it on its title;
   * Ctrl+Shift+G and Ctrl+Shift+U ungroup it at once; Ctrl+G puts it in a new group; the arrows nudge it with everything
   * in it; Esc lets it go.
   */
  function groupKey(e: KeyboardEvent): boolean {
    const g = groupSelRef.current;
    if (g === null || e.altKey || selectedRef.current.length > 0 || linesRef.current.length > 0) return false;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (e.shiftKey && (k === "g" || k === "u")) {
        e.preventDefault();
        ungroupGroup(g);
        return true;
      }
      if (!e.shiftKey && k === "g") {
        e.preventDefault();
        nestGroup(g);
        return true;
      }
      return false;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      askDelete(g);
      return true;
    }
    if (e.key === "F2" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      startGroupRename(g);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setGroupSel(null);
      setNotice(null);
      return true;
    }
    return nudgeKey(e, contentsOf(g)?.shapes ?? []);
  }

  /** Ctrl+G on a selected group: a new group around it, its name in edit (groups nest: draw.io, Figma). */
  function nestGroup(g: string) {
    if (aiLock.current || !kind) return;
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    const word = GROUP_WORD[kind];
    if (!known || !word) return;
    openField({ kind: "newgroup", members: [], subgroups: [g], parent: parentOf(known.groups, g), name: freeName(word, namesOf(known)), word });
  }

  // ----- frames: select, move, zoom to

  /**
   * The frame a gesture starts on: `frame` goes in `RunOptions.frame`, so a `doc.run` after an await does
   * nothing once another frame was selected meanwhile, and `still()` says whether the gesture's frame is still selected.
   */
  function gestureFrame() {
    const frame = doc.frameIdNow();
    return { frame, still: () => doc.frameIdNow() === frame };
  }

  /**
   * Selects a frame (null: none), with `pick` its shapes selected once it is live, then `then` once the switch has
   * landed (`afterSwitch`). An open field commits first, in its own frame, as a blur does; a move or a nudge under way
   * is kept first. While the Assistant holds the text a switch is refused with the lock note, as canvas edits are: its
   * changes are for the frame shown. False when refused.
   */
  function switchFrame(sel: FrameSelection | null, pick: string[] = [], then?: (box: FrameBox) => void, live = false, typed = false): boolean {
    const cur = doc.selection();
    const waiting = pendingRef.current;
    // The frame already picked and waiting for its paint: the last pick on it wins, and its action (one slot).
    if (waiting && sel && sameFrame(waiting.sel, sel)) {
      waiting.pick = pick;
      afterSwitch.current = then ? { sel, run: then, live } : null;
      return true;
    }
    // Another frame, none, or back to the live one: the waiting switch goes. Keys held for it go with it unless another
    // frame takes its place (they were meant for the frame picked, never the one left).
    // A header typed in the pane switches at once (the canvas gains nothing from two paints while you type there).
    if (waiting) dropPendingSwitch(sel === null || typed || sameFrame(cur, sel));
    const same = sameFrame(cur, sel);
    /** A refused switch: no key held for the frame it named may ever replay on another frame. */
    const refuse = () => {
      heldKeys.current = [];
      return false;
    };
    // The Assistant's run is one frame's from Ask to its last step (pick, broken and review included): the canvas, a
    // tab or a right-click cannot leave it. Typing always wins (the text is free in pick and broken): a header typed in
    // the pane switches, and the waiting changes go stale.
    const held = aiFrame.current !== null && doc.frameIdNow() === aiFrame.current;
    if (!same && typed && held) ai.frameLeft();
    else if (!same && (aiLock.current || held)) {
      setNote({ text: EDIT_MESSAGES.lockedSwitch, key: Date.now() });
      return refuse();
    }
    // Picking a frame or its shapes lets the sketches go (a sketch picked outside every frame lets the frame go).
    if (sel !== null && sketchSelRef.current.length > 0) setSketchSel([]);
    if (same) {
      setSelected(pick);
      setLines([]);
      const box = liveBoxRef.current ?? (sel ? boardRef.current?.boxes.find((b) => b.index === sel.index && b.title === sel.title) : undefined);
      if (then && box && (!live || box === liveBoxRef.current)) then(box);
      return true;
    }
    dismissUndoToast();
    // A field whose commit is refused keeps the frame, as a spreadsheet keeps a cell with an invalid entry: the switch
    // is refused with the field's reason in the strip, and the field keeps what was typed (Review Focus 1).
    const was = fieldsNow();
    const refused = blurField();
    if (refused !== null) {
      setNotice(refused);
      return refuse();
    }
    flushMove();
    endNudge();
    afterSwitch.current = then && sel ? { sel, run: then, live } : null;
    // A frame picked is drawn selected now; it goes live after that paint. None selected, or a header typed
    // in the pane, goes at once.
    const entry = sel && !typed ? { sel, pick } : null;
    if (entry) {
      pendingRef.current = entry;
      perfMark("select_pick");
      setPendingFrameState(sel);
    }
    const go = () => {
      if (!entry) {
        pendingPick.current = pick;
        doc.select(sel);
      } else if (pendingRef.current === entry) schedulePendingSwitch();
    };
    const pending = commitRef.current;
    if (pending)
      void pending.then(() => {
        // Refused by the worker while the switch waited: held as a refusal made at once is (Task 3 carry, Review
        // Focus 2), the field open with what was typed and its reason in the strip.
        const late = refusedSince(was);
        if (late !== null) {
          if (afterSwitch.current?.sel === sel) afterSwitch.current = null;
          if (entry && pendingRef.current === entry) dropPendingSwitch(true);
          heldKeys.current = [];
          setNotice(late);
          return;
        }
        go();
      });
    else go();
    return true;
  }

  /**
   * A press on the live frame's own shapes or lines while another frame waits for its paint: the frame
   * left takes no gesture, so it is swallowed whole (press, click, double-click). True when it was.
   */
  function pressOnLeftFrame(e: { target: EventTarget; preventDefault(): void; stopPropagation(): void }): boolean {
    if (!pendingRef.current || !(e.target instanceof Element)) return false;
    const el = e.target.closest(".react-flow__node, .react-flow__edge");
    // Only the live frame's own shapes, group areas and lines (its graph); frames, static shapes and sketches pass.
    const id = el?.getAttribute("data-id") ?? null;
    const g = graphRef.current;
    if (id === null || !(g.nodes.some((n) => n.id === id) || g.edges.some((x) => x.id === id))) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  /** Drops the switch waiting for its paint: the frame drawn selected is `frameSel` again. */
  function dropPendingSwitch(dropKeys: boolean) {
    // Keys kept here are only for the switch that takes this one's place at once; a refusal there clears them.
    pendingRef.current = null;
    pendingScheduled.current = false;
    pendingSeq.current++;
    setPendingFrameState(null);
    if (dropKeys) heldKeys.current = [];
  }

  /**
   * After the paint that shows the picked frame selected (an animation frame, then a task), it goes live: `doc.select`
   * with the picked shapes, the last frame picked meanwhile winning. One schedule at a time, so quick picks land together.
   */
  function schedulePendingSwitch() {
    if (pendingScheduled.current) return;
    pendingScheduled.current = true;
    const n = ++pendingSeq.current;
    const land = () => {
      if (pendingSeq.current !== n || !mounted.current) return;
      pendingScheduled.current = false;
      const p = pendingRef.current;
      if (!p) return;
      pendingPick.current = p.pick;
      if (!sameFrame(doc.selection(), p.sel)) {
        doc.select(p.sel);
        return;
      }
      // Already the selected frame (a header typed meanwhile): no switch to wait for.
      pendingPick.current = null;
      pendingRef.current = null;
      setSelected(p.pick);
      replayDue.current = heldKeys.current.length > 0;
      setPendingFrameState(null);
    };
    const later = () => void setTimeout(land, 0);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(later);
    else later();
  }

  /**
   * Waits until a replayed key's work has landed: a delete's fade and write, a field's commit, a paste, a duplicate, a
   * group or any other canvas write (`doc.busy`). Bounded at KEY_SETTLE_MS.
   */
  async function keySettled() {
    await new Promise<void>((r) => setTimeout(r, 0));
    const busy = () => deleting.current || commitRef.current !== null || pastePending.current || keyWork.current > 0 || doc.busy();
    for (let i = 0; i < KEY_SETTLE_MS / 16 && mounted.current && busy(); i++) await new Promise<void>((r) => setTimeout(r, 16));
  }

  /**
   * The keys held while a switch waited, pressed again in order on the frame now live, each once the one
   * before has landed. A key goes to the field it opened (F2 then a letter), else where it was pressed, else the canvas.
   * A switch elsewhere meanwhile drops the rest.
   */
  async function replayHeldKeys(keys: HeldKey[]) {
    const frame = doc.frameIdNow();
    for (const k of keys) {
      await keySettled();
      const root = canvasEl.current;
      if (!mounted.current || !root || doc.frameIdNow() !== frame || pendingRef.current) return;
      const active = document.activeElement;
      const field = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && root.contains(active) ? active : null;
      if (field && k.key.length === 1 && !k.ctrlKey && !k.metaKey && !k.altKey) {
        typeInto(field, k.key);
        continue;
      }
      const at = field ?? (k.target instanceof Element && k.target.isConnected && root.contains(k.target) ? k.target : root);
      at.dispatchEvent(new KeyboardEvent("keydown", { key: k.key, code: k.code, ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey, metaKey: k.metaKey, bubbles: true, cancelable: true }));
    }
  }

  /** The open fields as they are now, to tell a refusal that comes back later (`refusedSince`). */
  function fieldsNow() {
    return { card: erRef.current.value.store.get().edit, table: newTableRef.current, label: labelRefused.current };
  }

  /** The reason a card field, the new table or a relationship label was refused since `was`, or null. */
  function refusedSince(was: ReturnType<typeof fieldsNow>): string | null {
    const card = erRef.current.value.store.get().edit;
    if (card && card !== was.card && card.error) return card.error;
    const table = newTableRef.current;
    if (table && table !== was.table && table.error) return table.error;
    const label = labelRefused.current;
    if (label && label !== was.label) return label.text;
    return null;
  }

  /**
   * Blurs an open field on the canvas, so its commit runs now, in its own frame (decision 8). The reason when a card
   * field's or the new table's commit was refused at once (it stays open with what was typed); else null.
   */
  function blurField(): string | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement && canvasEl.current?.contains(active) && active.closest(".inline-edit-wrap"))) return null;
    const was = fieldsNow();
    active.blur();
    // A refusal sets a new edit with its reason; a write under way keeps the same one.
    return refusedSince(was);
  }

  /** Glides to a frame (as `glideToFrame`, over `motionMs`) only when it and its tab are not wholly on screen. */
  function showFrameBox(box: FrameBox) {
    const f = instance.current;
    const r = canvasEl.current?.getBoundingClientRect();
    if (!f || !r) return;
    // The tab strip keeps its screen height: in board units it is taller below 100 percent.
    const a = f.flowToScreenPosition({ x: box.x, y: box.y - tabHeight(f.getViewport().zoom) });
    const b = f.flowToScreenPosition({ x: box.x + box.w, y: box.y + box.h });
    const inside = r.width > 0 && r.height > 0 && a.x >= r.left && a.y >= r.top && b.x <= r.right && b.y <= r.bottom;
    if (!inside) glideToFrame(box);
  }

  /** Zooms to a frame with its title tab, as Shift+2 does with no shape selected. */
  function zoomToFrame(box: FrameBox) {
    // The tab at the zoom the fit lands on: taller in board units below 100 percent.
    const tab = tabHeight(fitZoomOf(box));
    // React Flow's fit (padding 0.1); bounds too big for the least zoom open at their start (`fitFromStart`).
    glideView({ bounds: { x: box.x, y: box.y - tab, width: box.w, height: box.h + tab }, padding: 0.1 });
  }

  /**
   * The zoom a fit of a frame and its tab lands on (React Flow's `fitBounds` with padding 0.1, within the canvas's zoom
   * range), the tab sized at that zoom; 1 while the canvas has no size.
   */
  function fitZoomOf(box: { w: number; h: number }): number {
    const r = canvasEl.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return 1;
    let z = 1;
    // The tab grows as the zoom falls: a few steps settle it.
    for (let i = 0; i < 3; i++) z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, r.width / (box.w * 1.1), r.height / ((box.h + tabHeight(z)) * 1.1)));
    return z;
  }

  /**
   * Brings a frame into view (Figma and Miro show new content): the view centres on it, zoomed out only
   * as far as it needs to fit.
   */
  function glideToFrame(box: FrameBox) {
    const f = instance.current;
    if (!f) return;
    const { zoom } = f.getViewport();
    const r = canvasEl.current?.getBoundingClientRect();
    const fitsAt = (tab: number) => (r && r.width > 0 && r.height > 0 ? Math.min(r.width / (box.w * 1.2), r.height / ((box.h + tab) * 1.2)) : zoom);
    // The tab at the zoom it lands on.
    const fits = fitsAt(tabHeight(Math.min(zoom, fitsAt(FRAME_TAB_H))));
    glideView({ center: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, zoom: Math.min(zoom, fits) });
  }

  // ----- the toolbar: arming, the add menu, Space and Ask

  /** Arms a toolbar tool (V, H, F, a letter or a click). */
  function arm(id: string) {
    // Column with one table selected opens its new column row at once (B3 decision 9); with none it waits for a pick.
    if (kind === "er" && id === "er.column" && draftOnSelected()) {
      setArmed("select");
      if (toolPickSet.current) {
        toolPickSet.current = false;
        if (shapePick.current) setShapePick(null);
      }
      return;
    }
    setArmed(id);
    // A line or Column tool says what to click; arming anything else ends a pick an earlier tool started.
    const pick = toolPick(id);
    if (pick) {
      toolPickSet.current = true;
      setShapePick(pick.p, pick.prompt);
    } else if (toolPickSet.current) {
      toolPickSet.current = false;
      if (shapePick.current) setShapePick(null);
    }
  }
  /** The pick in the strip was started by arming a tool, so arming another ends it. */
  const toolPickSet = useRef(false);

  /** A tool was used once: it goes back to Select, except Pen, which stays armed until Esc or V. */
  function toolUsed() {
    setArmed((a) => (a === PEN_TOOL_ID ? a : "select"));
  }

  /**
   * The tool is used once its add went in (Task 18a item 1): a refused add leaves it armed, whether it is refused at
   * once or (an ER table) when the worker answers. A tool armed meanwhile is left alone.
   */
  function toolUsedIf(added: boolean | Promise<boolean>) {
    if (added === true) return toolUsed();
    if (added === false) return;
    const was = armedRef.current;
    void added.then((ok) => {
      if (ok) setArmed((a) => (a !== was || a === PEN_TOOL_ID ? a : "select"));
    });
  }

  // ----- loose sketches: drawn, picked, moved, edited; the layout file only

  /** The board's sketches now. */
  const sketchList = useRef<readonly Sketch[]>([]);
  sketchList.current = doc.board.sketches;
  const sketchDraw = useRef<SketchDrawHandle>(null);
  /** A sketch's text being typed: a new text or note at a board point, or an existing sketch's text or Section title. */
  const [sketchField, setSketchField] = useState<
    { mode: "new"; kind: "text" | "note"; at: Point } | { mode: "edit"; id: string; kind: "text" | "note" | "section" } | null
  >(null);

  /** The canvas's selection: the shapes, then the sketches' nodes. */
  const canvasSelection = useMemo(() => (sketchSel.length === 0 ? selected : [...selected, ...sketchSel.map(sketchNodeId)]), [selected, sketchSel]);
  /** A glide's positions, with the sketches a Section drag or a nudge is moving. */
  const livePositions = useMemo(() => (sketchLive ? { ...(glide ?? {}), ...sketchLive } : glide), [glide, sketchLive]);
  /** Only sketches are selected: the bottom bar is theirs, with Colour alone. */
  const onlySketches = sketchSel.length > 0 && selected.length === 0 && lines.length === 0;
  /** Where the sketch field sits, in board units (the canvas's), and what it opens with. */
  const sketchFieldAt = useMemo(() => {
    const f = sketchField;
    if (!f) return null;
    if (f.mode === "new") return { at: { x: f.at.x, y: f.at.y - (f.kind === "note" ? NOTE_BOX.h / 2 : 14) }, width: f.kind === "note" ? NOTE_BOX.w : 200, value: "" };
    const s = doc.board.sketches.find((x) => x.id === f.id);
    if (!s) return null;
    const y = f.kind === "section" ? s.y - 28 : s.y;
    return { at: { x: s.x, y }, width: Math.max(f.kind === "section" ? 160 : 120, s.w), value: s.text ?? (f.kind === "section" ? "Section" : "") };
  }, [sketchField, doc.board.sketches]);

  /** A screen point on the board. */
  function boardPointAt(p: Point): Point {
    const f = instance.current;
    return f ? toBoard(f.screenToFlowPosition(p)) : p;
  }

  /** Sketch changes as one undo entry; a refusal's note goes to the strip. */
  function sketchOp(changes: SketchChange[]) {
    if (changes.length > 0) doc.sketch(changes);
  }

  /**
   * Adds one sketch, selected unless it is a pen stroke. Refused when the board is full: its note goes to `onRefused`
   * (the Shelf's toast, B2 controller question 4), else to the strip.
   */
  function addOneSketch(s: NewSketch, onRefused?: (why: string) => void): string | null {
    // A point from a view with no size is NaN: nothing is drawn, and `addSketch` never sees it.
    if (!finiteSketch(s)) return null;
    const r = addSketch(sketchList.current, s);
    if ("refused" in r) {
      if (r.refused) (onRefused ?? setNotice)(r.refused);
      return null;
    }
    doc.sketch([r.change]);
    // Excalidraw and FigJam select what was just drawn; a pen keeps drawing.
    if (s.kind !== "pen") {
      setSelected([]);
      setLines([]);
      setSketchSel([r.change.id]);
    }
    return r.change.id;
  }

  /** The press of a sketch tool (SketchDraw) let go, Esc'd or clicked. */
  const sketchDrawProps = {
    toBoard: boardPointAt,
    sketches: () => sketchList.current,
    onDrawn(s: NewSketch, tool: SketchKind) {
      addOneSketch(s);
      if (tool !== "pen") toolUsed();
    },
    onPoint(tool: "text" | "note", at: Point) {
      toolUsed();
      setSketchField({ mode: "new", kind: tool, at });
    },
    onCancel() {
      arm("select");
    },
    onReleased() {
      // The click that follows belongs to the press; it is let go after this task (a browser sends it straight after).
      drawClick.current = true;
      setTimeout(() => (drawClick.current = false), 0);
    },
  };

  /** Enter with a sketch tool armed (the keyboard path): its default sketch in the middle of the view. */
  function placeSketchTool(tool: SketchKind) {
    const rect = canvasEl.current?.getBoundingClientRect();
    const mid = boardPointAt(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 });
    if (tool === "text" || tool === "note") {
      toolUsed();
      setSketchField({ mode: "new", kind: tool, at: mid });
      return;
    }
    if (tool === "pen") return;
    // As a click at that point places it.
    const s = draftSketch(tool, mid, mid, { click: true, keyboard: true, all: sketchList.current });
    if (s) addOneSketch(s);
    toolUsed();
  }

  /** A sketch's text kept from its field: a new text or note goes in, an edit changes it (one undo entry each). */
  function commitSketchField(v: string) {
    const f = sketchField;
    setSketchField(null);
    canvasEl.current?.focus({ preventScroll: true });
    if (!f) return;
    if (f.mode === "new") {
      if (v === "") return;
      const size = f.kind === "text" ? textBox(v) : NOTE_BOX;
      // Text starts at the click (Excalidraw); a note is centred on it, as a click places a box.
      const at = f.kind === "text" ? { x: Math.round(f.at.x), y: Math.round(f.at.y - size.h / 2) } : { x: Math.round(f.at.x - size.w / 2), y: Math.round(f.at.y - size.h / 2) };
      addOneSketch({ kind: f.kind, ...at, ...size, text: v });
      return;
    }
    // A text emptied goes (Excalidraw); a note or a Section keeps its sheet or its box.
    if (v === "" && f.kind === "text") {
      sketchOp(removeSketches(sketchList.current, [f.id]));
      setSketchSel((sel) => sel.filter((x) => x !== f.id));
      return;
    }
    const r = setSketchText(sketchList.current, f.id, v);
    if (!r) return;
    if ("refused" in r) return setNotice(r.refused);
    const c = r.change;
    // A text sketch's box follows its words.
    const after = c.after && c.after.kind === "text" ? normalizeSketch({ ...c.after, ...textBox(c.after.text ?? "") }) : c.after;
    sketchOp([{ ...c, after }]);
  }

  /** Opens the text of a text sketch, a note or a Section's title in place (double-click, F2 or Enter). */
  function editSketchText(id: string): boolean {
    const s = sketchList.current.find((x) => x.id === id);
    if (!s || (s.kind !== "text" && s.kind !== "note" && s.kind !== "section")) return false;
    setSketchField({ mode: "edit", id, kind: s.kind });
    return true;
  }

  /**
   * A double-click on a sketch: a text or a note is edited, a Section's title renamed; a Section's inside, and a Section or
   * box sketch under a frame, is the canvas there ("Add here", FigJam; the frame wins).
   */
  function sketchDoubleClick(id: string, target: EventTarget | null) {
    const s = sketchList.current.find((x) => x.id === id);
    if (!s || aiLock.current) return;
    const t = target instanceof Element ? target : null;
    const f = instance.current;
    const flow = f && pointer.current ? f.screenToFlowPosition(pointer.current) : null;
    const underFrame = !!flow && frameAt(flow) !== null && (s.kind === "section" || s.kind === "rect" || s.kind === "ellipse" || s.kind === "diamond");
    if (s.kind === "section" && t?.closest(".board-sketch-title") && !underFrame) return void editSketchText(id);
    if ((s.kind === "section" || underFrame) && flow && pointer.current && kind && quickItems(kind).length > 0) return paneDoubleClick({ screen: pointer.current, flow });
    if (s.kind === "text" || s.kind === "note") editSketchText(id);
  }

  /** Each frame of a sketch drag: a Section's sketches wholly inside it, taken at the drag's start, follow it. */
  const sketchDrag = useRef<{ followers: Map<string, string[]> } | null>(null);
  sketchDraggedRef.current = (nodeId, x, y) => {
    const id = sketchIdOf(nodeId)!;
    const all = sketchList.current;
    const s = all.find((k) => k.id === id);
    if (!s || s.kind !== "section") return;
    const d = sketchDrag.current ?? (sketchDrag.current = { followers: new Map() });
    if (!d.followers.has(id)) {
      const dragged = new Set(sketchSelRef.current);
      dragged.add(id);
      d.followers.set(
        id,
        sketchesInside(all, s).filter((k) => !dragged.has(k)),
      );
    }
    const follow = d.followers.get(id)!;
    if (follow.length === 0) return;
    const dx = Math.round(x - s.x);
    const dy = Math.round(y - s.y);
    const byId = new Map(all.map((k) => [k.id, k] as const));
    const live: LivePositions = {};
    for (const k of follow) {
      const f = byId.get(k);
      if (f) live[sketchNodeId(k)] = { x: f.x + dx, y: f.y + dy };
    }
    setSketchLive((prev) => ({ ...(prev ?? {}), ...live }));
  };

  /** The sketches a drag let go: their moves (a Section's followers with it), or their copies on a Ctrl+drag. */
  takeSketchMovesRef.current = (copies) => {
    const moved = pendingSketchMove.current;
    pendingSketchMove.current = new Map();
    const d = sketchDrag.current;
    sketchDrag.current = null;
    setSketchLive(null);
    if (moved.size === 0) return [];
    const all = sketchList.current;
    const byId = new Map(all.map((k) => [k.id, k] as const));
    const deltas = new Map<string, { dx: number; dy: number }>();
    for (const [id, p] of moved) {
      const s = byId.get(id);
      if (!s) continue;
      const dx = Math.round(p.x - s.x);
      const dy = Math.round(p.y - s.y);
      deltas.set(id, { dx, dy });
      const follow = d?.followers.get(id) ?? (s.kind === "section" ? sketchesInside(all, s) : []);
      for (const k of follow) if (!moved.has(k) && !deltas.has(k)) deltas.set(k, { dx, dy });
    }
    if (copies) {
      // Ctrl+drag (draw.io): the originals stay, the copies land where the drag let go, selected.
      const list: NewSketch[] = [];
      for (const [id, { dx, dy }] of deltas) {
        const { id: _id, ...rest } = byId.get(id)!;
        list.push({ ...rest, x: rest.x + dx, y: rest.y + dy });
      }
      const r = addSketches(all, list);
      if ("refused" in r) {
        setNotice(r.refused);
        return [];
      }
      // Written by the caller: alone, or with the shapes' copies in their paste (one undo entry).
      setSketchSel(r.changes.map((c) => c.id));
      return r.changes;
    }
    const out: SketchChange[] = [];
    for (const [id, { dx, dy }] of deltas) out.push(...moveSketches(all, [id], dx, dy));
    return out;
  };

  /** A nudge burst's sketches: where they were when it started and how far it has gone. */
  const sketchNudge = useRef<{ base: Map<string, Sketch>; dx: number; dy: number } | null>(null);
  /** The arrow keys move the selected sketches 1 px, Shift 16 px; a held key's repeats are one move (F7). */
  function nudgeSketches(e: KeyboardEvent, endFirst: boolean): boolean {
    const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    const ids = sketchSelRef.current;
    if (!dir || ids.length === 0) return false;
    e.preventDefault();
    if (endFirst && !e.repeat) endNudge();
    const step = e.shiftKey ? 16 : 1;
    if (!sketchNudge.current) {
      const want = new Set(ids);
      sketchNudge.current = { base: new Map(sketchList.current.filter((s) => want.has(s.id)).map((s) => [s.id, s] as const)), dx: 0, dy: 0 };
    }
    const n = sketchNudge.current;
    n.dx += dir[0] * step;
    n.dy += dir[1] * step;
    const live: LivePositions = {};
    for (const [id, s] of n.base) live[sketchNodeId(id)] = { x: s.x + n.dx, y: s.y + n.dy };
    setSketchLive(live);
    return true;
  }
  /** The sketch half of a nudge burst, as changes for the burst's one move. */
  function takeSketchNudge(): SketchChange[] {
    const n = sketchNudge.current;
    sketchNudge.current = null;
    if (!n) return [];
    setSketchLive(null);
    return moveSketches(sketchList.current, n.base.keys(), n.dx, n.dy);
  }

  /** What a selected sketch's handles write: a resize, or a line's new ends (one undo entry each). */
  const sketchEditRef = useRef<SketchEdit>({ resized() {}, ends() {} });
  sketchEditRef.current = {
    resized(id, box) {
      const c = changeSketch(sketchList.current, id, { x: box.x, y: box.y, w: box.w, h: box.h });
      if (c) sketchOp([c]);
    },
    ends(id, a, b) {
      const c = changeSketch(sketchList.current, id, strokeBox([a, b]));
      if (c) sketchOp([c]);
    },
  };
  const sketchEdit = useMemo<SketchEdit>(() => ({ resized: (id, box) => sketchEditRef.current.resized(id, box), ends: (id, a, b) => sketchEditRef.current.ends(id, a, b) }), []);

  /** The selected sketches' one colour: "" with none, null when they differ. */
  function sketchColour(): string | null {
    const want = new Set(sketchSel);
    const cs = new Set(sketchList.current.filter((s) => want.has(s.id)).map((s) => s.color ?? ""));
    return cs.size === 1 ? [...cs][0] : null;
  }

  /** The selected sketches as clipboard JSON, with the selected shapes' lines when there are some. */
  function sketchCopy(cut: boolean): string | null {
    const want = new Set(sketchSelRef.current);
    if (want.size === 0) return null;
    const list = sketchList.current.filter((s) => want.has(s.id));
    if (list.length === 0) return null;
    const shapes = selectedRef.current.length > 0 ? selectionClip() : null;
    // The shapes' top lefts on the board, so a paste keeps them where they were beside the sketches.
    const at: Record<string, { x: number; y: number }> = {};
    if (shapes) for (const k of Object.keys(shapes.at)) at[k] = fromLive(shapes.at[k]);
    const text = sketchClipText(list, shapes?.text, shapes ? at : undefined);
    lastClip = { text, diagram: name, at: shapes?.at ?? emptyPositions(), pastes: cut ? -1 : 0 };
    return text;
  }

  /**
   * A sketch copy pasted (the app's clipboard, as JSON), with fresh ids, selected; no diagram file is written.
   * - Sketches alone go as shapes do: at the pointer while it is over the canvas, else one step from where they were for
   *   each paste, and a cut's first paste where they were.
   * - Sketches with shapes are one group (Figma): its top left goes to the pointer, or the middle of the view, and both
   *   halves keep their places to each other. They go in one run, one undo entry; with no diagram selected to take the
   *   shapes nothing is pasted.
   */
  function pasteSketchClip(text: string, clip: SketchClip, frame = doc.frameIdNow()) {
    if (aiLock.current) return;
    const mixed = !!clip.text;
    if (mixed && !kind) {
      setNotice("Nothing was pasted. Select a diagram to paste its shapes into, then paste again.");
      return;
    }
    const xs = clip.sketches.map((s) => s.x);
    const ys = clip.sketches.map((s) => s.y);
    const shapeAt = clip.at ?? {};
    for (const k of Object.keys(shapeAt)) {
      xs.push(shapeAt[k].x);
      ys.push(shapeAt[k].y);
    }
    let dx = PASTE_STEP;
    let dy = PASTE_STEP;
    let anchor: Point | null = null;
    if (mixed || pointer.current) {
      const rect = canvasEl.current?.getBoundingClientRect();
      anchor = boardPointAt(pointer.current ?? (rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 }));
      dx = xs.length > 0 ? Math.round(anchor.x - Math.min(...xs)) : 0;
      dy = ys.length > 0 ? Math.round(anchor.y - Math.min(...ys)) : 0;
    } else if (lastClip && lastClip.text === text) {
      lastClip.pastes += 1;
      // A cut's first paste lands where the sketches were, unless they are back (the cut was undone).
      if (lastClip.pastes === 0 && clip.sketches.some((c) => sketchList.current.some((s) => s.kind === c.kind && s.x === c.x && s.y === c.y && s.w === c.w && s.h === c.h))) lastClip.pastes = 1;
      dx = dy = PASTE_STEP * lastClip.pastes;
    }
    const r = addSketches(sketchList.current, clip.sketches.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy })));
    if ("refused" in r) {
      setNotice(r.refused);
      return;
    }
    const changes = r.changes;
    const ids = changes.map((c) => c.id);
    if (clip.text) {
      // The shapes at their copied places moved by the same step, in the live frame's coordinates; the sketches ride
      // the paste's run.
      const at = emptyPositions();
      for (const k of Object.keys(shapeAt)) at[k] = toLive({ x: shapeAt[k].x + dx, y: shapeAt[k].y + dy });
      // A shape with no place (a clip from before Task 12, or a shape not drawn when copied) goes at the group's anchor.
      const rest = anchor ? toLive(anchor) : undefined;
      void pasteText(clip.text, { at, sketches: changes, frame, ...(rest ? { rest } : {}) }).then((r) => {
        const made = r?.sketchIds ?? ids;
        if (r && made.length > 0) setSketchSel(made);
      });
      return;
    }
    if (changes.length > 0) {
      doc.sketch(changes);
      setSelected([]);
      setLines([]);
      setSketchSel(ids);
    }
  }

  /** A press on a Section or box sketch inside a frame is the frame's (ruling C14): frames win wherever they overlap. */
  function frameWinsAt(e: { target: EventTarget; clientX: number; clientY: number }): boolean {
    const t = e.target instanceof Element ? e.target : null;
    if (!t?.closest(`.${SKETCH_UNDER_CLASS}`) || t.closest(".rz-zone")) return false;
    const f = instance.current;
    return !!f && frameAt(f.screenToFlowPosition({ x: e.clientX, y: e.clientY })) !== null;
  }

  /**
   * The sketch at a flow point while the layer is pictured, of those its pictures stand for: the last
   * drawn on top, a pen, text, note, line or arrow over every frame first, then a box sketch outside every frame (a
   * frame wins over it, ruling C14), by its box and 4 screen px around it. A Section is `sectionAt`'s.
   */
  function pictureSketchAt(p: Point): string | null {
    const form = sketchFormRef.current;
    if (!form.pictured) return null;
    const { x, y } = toBoard(p);
    const slack = 4 / (instance.current?.getViewport().zoom || 1);
    const all = sketchList.current;
    const on = (s: Sketch) => x >= s.x - slack && x <= s.x + s.w + slack && y >= s.y - slack && y <= s.y + s.h + slack;
    for (let i = all.length - 1; i >= form.mounted; i--) if (!drawsUnder(all[i].kind) && on(all[i])) return all[i].id;
    if (frameAt(p)) return null;
    for (let i = all.length - 1; i >= form.mounted; i--) if (drawsUnder(all[i].kind) && all[i].kind !== "section" && on(all[i])) return all[i].id;
    return null;
  }

  /** The press that picked a pictured sketch: its click picks nothing more. */
  const pressedPictured = useRef(false);
  /**
   * A press on a pictured sketch: it is picked at once (the layer turns real for it), with the sketches
   * already picked when it is one of them, and a drag from there moves them (draw.io, Figma: a press on a shape and a
   * drag move it). The move shows on the real sketches as a drag's does, and is written once when the press ends (one
   * undo entry). True when the press was on one.
   */
  function pressPicturedSketch(e: { clientX: number; clientY: number }): boolean {
    const f = instance.current;
    if (!f) return false;
    const start = f.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id = pictureSketchAt(start);
    if (id === null) return false;
    pressedPictured.current = true;
    if (!frameAt(start)) switchFrame(null);
    const picked = sketchSelRef.current.includes(id) ? sketchSelRef.current : [id];
    if (picked !== sketchSelRef.current) setSketchSel(picked);
    const want = new Set(picked);
    const base = new Map(sketchList.current.filter((s) => want.has(s.id)).map((s) => [s.id, s] as const));
    let moved = false;
    let dx = 0;
    let dy = 0;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) <= 3) return;
      moved = true;
      const q = f.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      dx = Math.round(q.x - start.x);
      dy = Math.round(q.y - start.y);
      const live: LivePositions = {};
      for (const [k, s] of base) live[sketchNodeId(k)] = { x: s.x + dx, y: s.y + dy };
      setSketchLive(live);
    };
    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (ev.type === "pointerup") move(ev);
      if (!moved) return;
      setSketchLive(null);
      if (ev.type === "pointerup") sketchOp(moveSketches(sketchList.current, base.keys(), dx, dy));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return true;
  }

  /**
   * A box drawn on the canvas while the sketch layer is pictured: the sketches its pictures stand for
   * that the box meets are picked too, as React Flow's partial box picks sketch nodes.
   */
  function boxPicksPictured(e: { clientX: number; clientY: number }) {
    const from = boxFrom.current;
    boxFrom.current = null;
    const f = instance.current;
    const form = sketchFormRef.current;
    if (!from || !f || !form.pictured || Math.hypot(from.x - e.clientX, from.y - e.clientY) <= 3) return;
    const a = toBoard(f.screenToFlowPosition(from));
    const b = toBoard(f.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    const all = sketchList.current;
    const hits: string[] = [];
    for (let i = form.mounted; i < all.length; i++) {
      const r = sketchExtent(all[i]);
      if (r.x <= box.x + box.w && box.x <= r.x + r.w && r.y <= box.y + box.h && box.y <= r.y + r.h) hits.push(all[i].id);
    }
    if (hits.length > 0) setSketchSel((sel) => [...sel, ...hits.filter((id) => !sel.includes(id))]);
  }

  /** The Section whose inside is at a flow point, the one drawn last on top; null with none. */
  function sectionAt(p: Point): string | null {
    const { x, y } = toBoard(p);
    const all = sketchList.current;
    for (let i = all.length - 1; i >= 0; i--) {
      const s = all[i];
      if (s.kind === "section" && x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s.id;
    }
    return null;
  }

  /** Enter with a kind tool armed: its shape goes in as its key added it before (an add tool's own add, else the Shape picker's), and the tool is used. */
  function placeArmed(sh: Shape) {
    // A group goes around the selection, or says what it needs, as the G key always did.
    const beside = sh.act.kind === "node" && kind !== "er" ? besideSelection(sh.act.node) : null;
    let added: boolean | Promise<boolean> = true;
    if (sh.act.kind === "group") groupSelected();
    else if (beside && sh.act.kind === "node") added = addShape(sh.act.node, beside.at, { group: beside.group });
    else if (sh.tool) added = add(sh.tool);
    else added = runShape(sh);
    // A refused add (its note in the strip) leaves the tool armed, as a refused draw does.
    toolUsedIf(added);
  }

  /**
   * Enter with one shape selected: the new shape goes next to it, one layout gap away along the frame's
   * direction, or the first free spot along that side (`placeNext`), in the selection's group. Null with no single
   * placed shape selected, in a fixed kind, or with no room on that side.
   */
  function besideSelection(nodeKind: FlowNodeKind): { at: Point; group: string | null } | null {
    const d = drawnRef.current;
    if (!kind || FIXED_KINDS.has(kind) || !d || selectedRef.current.length !== 1) return null;
    const src = selectedRef.current[0];
    const boxes = placedBoxes();
    const from = boxes.get(src);
    if (!from) return null;
    const dir: Side = layout.direction === "LR" ? "r" : "b";
    const size = newSize(nodeKind, newName(nodeKind));
    const pairs: [Box, Box][] = [];
    for (const l of d.links) {
      const a = boxes.get(l.from);
      const b = boxes.get(l.to);
      if (a && b) pairs.push([a, b]);
    }
    const gap = layoutGap(pairs, dir === "b" ? "v" : "h");
    const spot = placeNext({ src: from, dir, size, gap, boxes: [...boxes.values()], avoid: [] });
    if (!spot) return null;
    return { at: { x: spot.x + size.w / 2, y: spot.y + size.h / 2 }, group: parentOf(d.groups, src) };
  }

  // ----- drawing into frames (Review Focus 5)

  /**
   * A press with a shape tool under way: the tool, where it went down on screen, the static frame it selects on release
   * (a generic tool there draws that frame's shape), for a line tool the shape it starts from, and `selectOnly` for a
   * kind tool pressed in another frame, which only selected it.
   */
  const drawPress = useRef<{ tool: string; from: Point; frame: FrameBox | null; line?: string; selectOnly?: boolean } | null>(null);
  /** The click that ends a tool's press is the press's own: it picks nothing. */
  const drawClick = useRef(false);
  /** The box a shape tool's drag has drawn so far, on screen: outlined until release or Esc (Figma, Excalidraw, draw.io). */
  const [drawBox, setDrawBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  /** A line tool's press-drag: today's drawing line, to the pointer or locked onto the shape it would end on. */
  const [lineDraw, setLineDraw] = useState<{ d: string; ring: Box | null } | null>(null);
  // Window listeners for the press, each calling this render's handler.
  const drawUpRef = useRef<(e: PointerEvent) => void>(() => {});
  drawUpRef.current = endDraw;
  const drawMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  drawMoveRef.current = moveDraw;
  const onDrawUp = useCallback((e: PointerEvent) => drawUpRef.current(e), []);
  const onDrawMove = useCallback((e: PointerEvent) => drawMoveRef.current(e), []);
  /** Esc or a cancelled pointer drops the press: nothing is drawn. */
  const onDrawCancel = useCallback((e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== "Escape") return;
    drawCancelRef.current();
  }, []);
  const drawCancelRef = useRef<() => void>(() => {});
  drawCancelRef.current = () => {
    if (!drawPress.current) return;
    drawPress.current = null;
    // The Relationship tool's drag aims a row: Esc lets it go with the line.
    rel.reset();
    stopDrawListening();
  };
  function stopDrawListening() {
    window.removeEventListener("pointerup", onDrawUp);
    window.removeEventListener("pointermove", onDrawMove);
    window.removeEventListener("pointercancel", onDrawCancel);
    window.removeEventListener("keydown", onDrawCancel, true);
    setDrawBox(null);
    setLineDraw(null);
  }
  useEffect(
    () => () => {
      window.removeEventListener("pointerup", onDrawUp);
      window.removeEventListener("pointermove", onDrawMove);
      window.removeEventListener("pointercancel", onDrawCancel);
      window.removeEventListener("keydown", onDrawCancel, true);
    },
    [onDrawUp, onDrawMove, onDrawCancel],
  );

  /** The live shape a press landed on, or null (a static frame's shapes are never the live frame's). */
  function liveShapeAt(t: Element): string | null {
    const el = t.closest(".react-flow__node");
    const id = el?.getAttribute("data-id");
    if (!el || !id || id.startsWith("\u0000") || el.closest(".board-static")) return null;
    return id;
  }

  /**
   * A press on the canvas with a shape or line tool armed. It is for the frame on top under it (the live
   * one, else the later in text order, as a click is: `frameAt`, `staticFrameAt`). A kind tool pressed in another frame
   * selects that frame and disarms; elsewhere it draws into the live frame, which grows to fit. A generic Rectangle,
   * Ellipse or Diamond draws the frame's own shape (`genericInFrame`), selecting the frame first; outside every frame,
   * or where the frame has no such shape, it is a loose sketch, drawn by `SketchDraw`, as every other
   * drawing tool, Section and the note sketch are. A line tool pressed on a shape starts a line. True when the press is the tool's: React Flow then neither pans, box-selects
   * nor drags.
   */
  function startDraw(e: ReactPointerEvent): boolean {
    const id = armedRef.current;
    if (e.button !== 0 || aiLock.current || space.current || fieldRef.current) return false;
    const t = e.target instanceof Element ? e.target : null;
    if (!t?.closest(".react-flow__pane") || t.closest("button, input, textarea, [contenteditable=true], .react-flow__handle, .board-frame-tab, .flow-hot")) return false;
    const f = instance.current;
    if (!f) return false;
    const tool = kind ? KIND_TOOLS[kind].find((x) => x.id === id) : undefined;
    if (!tool && !SKETCH_TOOLS.has(id)) return false;
    const from = { x: e.clientX, y: e.clientY };
    const at = toBoard(f.screenToFlowPosition(from));
    const other = staticFrameAt(at);
    if (tool) {
      // A selected frame that is not live (a title an earlier frame has) takes no drawing: it is fixed in the code.
      if (!liveBoxRef.current) return false;
      if (other) {
        // Nothing is drawn: the frame is selected and its own tools show.
        begin(e, { tool: id, from, frame: null, selectOnly: true });
        switchFrame({ title: other.title, index: other.index });
        setArmed("select");
        return true;
      }
      const act = tool.shape.act.kind;
      if (act === "line") {
        const shape = liveShapeAt(t);
        if (shape === null) return false;
        // The Relationship tool starts on a column's row or a header, no port needed (B3 decision 9, R11).
        if (kind === "er" && id === ER_RELATIONSHIP) {
          const hit = erHitOf(t);
          if (!hit) return false;
          rel.toolPress(hit);
        }
        begin(e, { tool: id, from, frame: null, line: shape });
        return true;
      }
      if (act !== "node") return false;
      begin(e, { tool: id, from, frame: null });
      return true;
    }
    const hit = frameAt(at);
    if (GENERIC_BOXES.has(id) && hit?.kind && genericInFrame(hit.kind, id)) {
      begin(e, { tool: id, from, frame: other });
      return true;
    }
    // Outside every frame, or where the frame has no such shape: a loose sketch. Pen, text, notes, lines and
    // arrows draw over frames too.
    e.stopPropagation();
    e.preventDefault();
    sketchDraw.current?.start(id as SketchKind, from, boardPointAt(from));
    return true;
  }

  function begin(e: ReactPointerEvent, press: NonNullable<typeof drawPress.current>) {
    e.stopPropagation();
    e.preventDefault();
    drawPress.current = press;
    window.addEventListener("pointerup", onDrawUp);
    window.addEventListener("pointermove", onDrawMove);
    window.addEventListener("pointercancel", onDrawCancel);
    window.addEventListener("keydown", onDrawCancel, true);
  }

  /** The press moved: a shape's box is outlined past the click threshold; a line is drawn to the pointer or its lock. */
  function moveDraw(e: PointerEvent) {
    const p = drawPress.current;
    if (!p || p.selectOnly) return;
    const to = { x: e.clientX, y: e.clientY };
    if (p.line !== undefined) {
      setLineDraw(lineFeedback(p.line, to));
      return;
    }
    const dx = to.x - p.from.x;
    const dy = to.y - p.from.y;
    setDrawBox(Math.hypot(dx, dy) > DRAW_DRAG_PX ? { left: Math.min(p.from.x, to.x), top: Math.min(p.from.y, to.y), width: Math.abs(dx), height: Math.abs(dy) } : null);
  }

  /** The tool's press let go: a click places, a drag over 4 px sizes; into a frame not live, once its press selected it. */
  function endDraw(e: PointerEvent) {
    stopDrawListening();
    const p = drawPress.current;
    drawPress.current = null;
    if (!p) return;
    // The click that follows belongs to the press; it is let go after this task (a browser sends it straight after).
    drawClick.current = true;
    setTimeout(() => (drawClick.current = false), 0);
    if (p.selectOnly) return;
    const to = { x: e.clientX, y: e.clientY };
    if (p.line !== undefined) return lineDrawn(p.tool, p.line, p.from, to);
    if (p.frame) {
      const { tool, from } = p;
      // The render with the frame live draws it, with that render's kind and tools.
      switchFrame({ title: p.frame.title, index: p.frame.index }, [], () => latestActs.current.drawShape(tool, from, to), true);
      return;
    }
    drawShape(p.tool, p.from, to);
  }

  /**
   * The armed tool's shape drawn into the live frame, from screen `from` to `to`, through `runShape` as a Shapes item:
   * its line written as the kind's add writes it (its name ready, then one undo step), inside the group under it. A drag
   * sizes it in the same step, held to the kind's resize limits; a drag with a side under the minimum places the default
   * size at the press, as a click does (Figma, draw.io). Fixed kinds take no size: the order places them.
   */
  function drawShape(id: string, from: Point, to: Point) {
    const f = instance.current;
    if (!f || !kind || aiLock.current) return;
    const shape = KIND_TOOLS[kind].find((x) => x.id === id)?.shape ?? genericInFrame(kind, id);
    if (!shape || shape.act.kind !== "node") return;
    // In the live frame's units: its graph and the add are frame-local.
    const a = toLive(f.screenToFlowPosition(from));
    const b = toLive(f.screenToFlowPosition(to));
    let box: Box | undefined;
    // An ER table is sized by its columns (drawSQL, dbdiagram): its drag is a click at the press (R13).
    const table = kind === "er" && isErTable({ kind: shape.act.node });
    if (!table && !FIXED_KINDS.has(kind) && Math.hypot(to.x - from.x, to.y - from.y) > DRAW_DRAG_PX) {
      const lim = nodeLimits(drawnKind(shape.act.node, kind));
      const w = snap(Math.abs(b.x - a.x));
      const h = snap(Math.abs(b.y - a.y));
      if (w >= lim.minW && h >= lim.minH) {
        // Capped, the box keeps the press's corner (Figma, draw.io): dragged up or left, it gives up the far side.
        const cw = Math.min(w, lim.maxW);
        const ch = Math.min(h, lim.maxH);
        box = { x: snap(Math.min(a.x, b.x)) + (b.x < a.x ? w - cw : 0), y: snap(Math.min(a.y, b.y)) + (b.y < a.y ? h - ch : 0), w: cw, h: ch };
      }
    }
    const at = box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : a;
    toolUsedIf(runShape(shape, at, { ...(box ? { box } : {}), group: groupUnder(at) }));
  }

  /** The innermost group of the live frame under a point in its own units, or null. */
  function groupUnder(p: Point): string | null {
    const d = drawnRef.current;
    if (!d || d.groups.length === 0) return null;
    const depth = groupDepths(d.groups);
    const groups = graphRef.current.nodes
      .filter((n) => n.id.startsWith("\u0000group:"))
      .map((n) => {
        const name = n.id.slice("\u0000group:".length);
        return { name, box: boxOfNode(n), depth: depth.get(name) ?? 0 };
      });
    return groupAt(p, groups);
  }

  /** Where a line from `from` would end with the pointer at screen `to`: today's line-end lock (`magnetTarget`). */
  function lineEndAt(from: string, to: Point): { at: Point; lock: { id: string; side: Side; box: Box } | null } | null {
    const f = instance.current;
    if (!f) return null;
    const at = toLive(f.screenToFlowPosition(to));
    const nodes = graphRef.current.nodes.filter((n) => !isArea(n.id) && n.id !== from);
    const hit = magnetTarget(
      at,
      nodes.map((n) => ({ id: n.id, box: lineBoxOf(n) })),
    );
    const n = hit ? nodes.find((x) => x.id === hit.id) : undefined;
    return { at, lock: hit && n ? { ...hit, box: lineBoxOf(n) } : null };
  }

  /** Today's drawing line for a line tool's press-drag: from its shape's side towards the pointer, solid with a ring when locked. */
  function lineFeedback(from: string, to: Point): { d: string; ring: Box | null } | null {
    // The Relationship tool's line leaves at the pressed row and aims the row or header under the pointer.
    if (kind === "er" && armedRef.current === ER_RELATIONSHIP) {
      const f = instance.current;
      return f ? rel.toolMove(toLive(f.screenToFlowPosition(to))) : null;
    }
    const src = graphRef.current.nodes.find((n) => n.id === from);
    const end = lineEndAt(from, to);
    if (!src || !end) return null;
    const box = lineBoxOf(src);
    const p = end.lock ? portAt(end.lock.box, end.lock.side) : end.at;
    const dx = p.x - (box.x + box.w / 2);
    const dy = p.y - (box.y + box.h / 2);
    const side: Side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "r" : "l") : dy >= 0 ? "b" : "t";
    const route = routeOrthogonal(box, { x: p.x, y: p.y, w: 0, h: 0 }, { toPoint: true, from: side });
    return { d: route.d, ring: end.lock?.box ?? null };
  }

  /**
   * A line tool's press from shape `from` let go at screen `to`: where today's line end locks (on a shape or just off its
   * edge, a lifeline included) the line is written there (a press-drag, as Excalidraw, Figma and Miro connect); on the
   * same spot it was the first of two clicks.
   */
  function lineDrawn(id: string, from: string, down: Point, to: Point) {
    const tool = kind ? KIND_TOOLS[kind].find((x) => x.id === id) : undefined;
    if (!tool || tool.shape.act.kind !== "line") return;
    if (Math.hypot(to.x - down.x, to.y - down.y) <= DRAW_DRAG_PX) {
      pickForShape([from]);
      return;
    }
    // The Relationship tool's drag: let go on a row, a header or nothing, as a port's drag is.
    if (kind === "er" && id === ER_RELATIONSHIP) {
      const press = erPress.current;
      const f = instance.current;
      setShapePick(null);
      if (press && f) rel.relateAt(press.table, press.column, toLive(f.screenToFlowPosition(to)));
      toolUsed();
      return;
    }
    const lock = lineEndAt(from, to)?.lock;
    if (!lock) return;
    setShapePick(null);
    void connectPicked(from, lock.id, tool.shape.act.arrow);
    toolUsed();
  }

  /**
   * Opens the Space box at a point on screen (a Space tap, `/` over the canvas; B2 decision 19), where a pick drops.
   * The Shelf closes (ending any drag from it), and an armed tool is disarmed (R26). It opens under the Assistant's
   * lock too (decision 22: browsing is allowed); its add is refused there, as the Shelf's is (R23).
   */
  function openSpaceBox(screen: Point) {
    // Another action: "Make a relationship from here" and "Add relationship to..." end with nothing written.
    rel.endModes(true);
    if (shelf) closeShelf("outside");
    arm("select");
    const at = boardPointAt(screen);
    // The canvas is read once per open: where the box and its crosshair are drawn, and what it stays inside.
    const r = canvasEl.current?.getBoundingClientRect();
    setSpaceBox({
      screen,
      at: { x: Math.round(at.x), y: Math.round(at.y) },
      local: r ? { x: screen.x - r.left, y: screen.y - r.top } : screen,
      bounds: { w: r?.width ?? 0, h: r?.height ?? 0 },
    });
  }

  /**
   * The Space box closed: Esc, or the view or the canvas changing under it ("view"), give focus back to the canvas
   * (R16); a press elsewhere keeps the focus it gives.
   */
  function closeSpaceBox(reason: SpaceBoxCloseReason | "view") {
    if (reason !== "outside") refocusAfterMenu(canvasEl.current);
    setSpaceBox(null);
  }

  /**
   * A toolbar menu closed. If it held focus (Esc, Tab, a pick), focus goes back to `to`, the control that opened it,
   * else the canvas (WAI-ARIA menu button); a press elsewhere keeps the focus it gives.
   */
  function refocusAfterMenu(to: HTMLElement | null | undefined) {
    const a = document.activeElement;
    // The Shelf and the Space box are dialogs, not menus (R16).
    if (a && a !== document.body && !a.closest("[role=menu], .flow-shelf, .flow-space-box")) return;
    (to ?? canvasEl.current)?.focus({ preventScroll: true });
  }

  // ----- the frame bar

  /** Renames the selected frame from the bar: why it could not ("" for no change), or null once renamed. */
  async function renameFromBar(title: string): Promise<string | null> {
    const box = liveBoxRef.current;
    if (!box) return "";
    if (aiLock.current) {
      setNote({ text: EDIT_MESSAGES.locked, key: Date.now() });
      return EDIT_MESSAGES.locked;
    }
    let why: string | null = null;
    const r = await doc.frameOp({ op: "renameFrame", frameIndex: box.index, title }, undefined, (w) => (why = w));
    if (r) return null;
    // The same name with spaces round it changes nothing, and says nothing.
    if (why === null && title.trim() === box.title) return "";
    const said = why ?? EDIT_MESSAGES.changed;
    setNote({ text: said, key: Date.now() });
    return said;
  }

  /**
   * The Numbering toggle's state: read from the document the frame will have, so a waiting proposal that removes the last
   * messages still shows numbering on (the drawn copy ends it there). Off while the text has an error or the proposal waits.
   */
  function numberingFromBar(kind: DiagramKind, title: string): { on: boolean; why: string | null } | undefined {
    if (kind !== "sequence") return undefined;
    const proposed = aiReview?.get(title);
    if (proposed) return { on: proposed.numbering, why: EDIT_MESSAGES.locked };
    const d = parsed?.result.doc ?? null;
    return { on: d ? numberingOn(d) : false, why: d ? (ai.locked ? EDIT_MESSAGES.locked : null) : "Fix the problems in this diagram first." };
  }

  /** A setting from the bar on the selected frame: one undo entry each. */
  function settingFromBar(patch: FrameSettingPatch) {
    const key = liveBoxRef.current?.key;
    if (aiLock.current || !key) return;
    doc.setFrameSetting(key, patch);
  }

  /** Where a copy of `box` goes: right of it, top aligned, past any frame in the way (Figma's duplicate). */
  function besideFrame(box: FrameBox): Point {
    const others = boardRef.current?.boxes ?? [];
    let x = box.x + box.w + FRAME_GAP;
    for (let moved = true; moved; ) {
      moved = false;
      for (const o of others) {
        if (x < o.x + o.w && x + box.w > o.x && box.y < o.y + o.h && box.y + box.h > o.y) {
          x = o.x + o.w + FRAME_GAP;
          moved = true;
        }
      }
    }
    // Boxes and entries move together: the copy's entry is the frame's, moved by as much as its box.
    const at = (box.key !== null ? doc.board.frames.get(box.key)?.at : undefined) ?? { x: 0, y: 0 };
    return { x: at.x + (x - box.x), y: at.y };
  }

  /** Duplicate frame: a copy beside it, selected and glided to, as an added frame is. */
  async function duplicateFrame() {
    const box = liveBoxRef.current;
    if (!box || aiLock.current) return;
    let why: string | null = null;
    const r = await doc.frameOp({ op: "duplicateFrame", frameIndex: box.index }, besideFrame(box), (w) => (why = w));
    if (r?.name !== undefined) addedFrame.current = { titles: [r.name], boxes: [], toast: null, depth: historyDepth() };
    else setNote({ text: why ?? EDIT_MESSAGES.changed, key: Date.now() });
  }

  /** Delete frame asks nothing: one undo entry and a toast with Undo (Figma, Miro). */
  async function deleteFrame() {
    const box = liveBoxRef.current;
    if (!box || aiLock.current || (boardRef.current?.boxes.length ?? 0) < 2) return;
    let why: string | null = null;
    const r = await doc.frameOp({ op: "deleteFrame", frameIndex: box.index }, undefined, (w) => (why = w));
    if (!r) return setNote({ text: why ?? EDIT_MESSAGES.changed, key: Date.now() });
    undoableToast(`Deleted ${box.title || "Untitled"}.`);
  }

  /**
   * A toast with an Undo that takes back the edit just made, and only it: the history is that deep while the toast
   * shows (Gmail, Figma). Any further edit or a frame switch ends it (`dismissUndoToast`).
   */
  function undoableToast(text: string) {
    const v = doc.view();
    if (!v) return;
    const toast = { depth: undoDepth(v.state) };
    undoToast.current = toast;
    setNote({
      text,
      key: Date.now(),
      action: {
        label: "Undo",
        run: () => {
          // As Ctrl+Z on the canvas: nothing while the Assistant holds the text.
          if (aiLock.current) return;
          const now = doc.view();
          if (now && undoToast.current === toast && undoDepth(now.state) === toast.depth) undo(now);
          undoToast.current = null;
        },
      },
    });
  }

  /** Any further edit or a frame switch ends the delete's toast at once, so its Undo never takes back something else. */
  function dismissUndoToast() {
    if (!undoToast.current) return;
    undoToast.current = null;
    setNote((n) => (n?.action ? null : n));
  }

  /** Ask (Ctrl+J): the Assistant opens beside the canvas with its prompt ready. */
  function openAsk() {
    setSide({ hidden: false, tab: "assistant" });
    requestAnimationFrame(() => {
      const pane = canvasEl.current?.closest(".flow-tab")?.querySelector<HTMLElement>("[data-side-pane='assistant']");
      pane?.querySelector<HTMLElement>("textarea, [contenteditable=true]")?.focus();
    });
  }

  /**
   * Space let go: a short press with the pointer still is a tap, which opens the Space box at the pointer (Decision 26,
   * B2 decision 19); with the pointer never over the canvas (the keyboard's way in), the Shelf, as `/` there. Both
   * open under the Assistant's lock (decision 22).
   */
  function endSpace() {
    const sp = space.current;
    space.current = null;
    setSpaceHeld(false);
    if (!sp || sp.moved || Date.now() - sp.t >= SPACE_TAP_MS) return;
    const p = sp.p ?? pointer.current;
    if (p) openSpaceBox(p);
    else openShelf("slash");
  }
  const closeSpaceRef = useRef(closeSpaceBox);
  closeSpaceRef.current = closeSpaceBox;
  const endSpaceRef = useRef(endSpace);
  endSpaceRef.current = endSpace;

  frameActs.current = {
    select: (box) => void switchFrame({ title: box.title, index: box.index }),
    pane: (tab, box) => {
      // AI Chat on a frame that is not selected adds that frame's chip by hand. It cannot select it: the Assistant's
      // review holds the frame it asked from, and a frame has AI Chat unselected only while it has changes waiting.
      if (tab === "assistant" && box && !(frameSel && frameSel.index === box.index && frameSel.title === box.title)) {
        setFrameChip({ title: box.title, index: box.index });
        setSide({ hidden: false, tab });
        return;
      }
      if (!side.hidden && side.tab === tab) setSide({ hidden: true });
      else setSide({ hidden: false, tab });
    },
    // A frame's problem count opens the Code Editor on it, once it is selected.
    problems: (box) => void switchFrame({ title: box.title, index: box.index }, [], () => setSide({ hidden: false, tab: "editor" })),
    // The box as drawn now: an edit since the tab was drawn may have moved or grown it.
    zoom: (box) => {
      const now = boardRef.current?.boxes.find((b) => b.index === box.index && b.title === box.title);
      if (now) zoomToFrame(now);
    },
  };

  latestActs.current = { drawShape, glideToFrame, fitFrame: zoomToFrame, showFrameBox };
  const { iconNode, placeIcon, finishShelf, addFromShelf, dropShelf } = useShelfAdd({
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
  });
  /** This render's actions for a run made in an earlier one (a Shelf add or a menu waiting for its frame to go live). */
  lateActs.current = {
    openMenu,
    iconNode,
    placeIcon,
    finishShelf,
    fitBoard(boxes) {
      // The union of board boxes, with the frames' tabs at the zoom the fit lands on (as `zoomToFrame`); the canvas is in board units.
      if (boxes.length === 0) return;
      const x0 = Math.min(...boxes.map((b) => b.x));
      const y0 = Math.min(...boxes.map((b) => b.y));
      const x1 = Math.max(...boxes.map((b) => b.x + b.w));
      const y1 = Math.max(...boxes.map((b) => b.y + b.h));
      const tab = tabHeight(fitZoomOf({ w: x1 - x0, h: y1 - y0 }));
      glideView({ bounds: { x: x0, y: y0 - tab, width: x1 - x0, height: y1 - y0 + tab }, padding: 0.1 });
    },
  };

  // The assistant's glide: one fit of the union of the frames' boxes and the rectangles of frames not drawn yet. This is
  // the one place the board Ask moves the view, so it is the one call to route through the canvas's glide.
  /** Rings `parts` now, for `AIRING_MS` (a part the user asked to be shown, or the ones an answer named). */
  function ringNow(parts: Airing) {
    clearTimeout(ringTimer.current);
    setRinged(parts);
    ringTimer.current = setTimeout(() => setRinged(NO_RING), AIRING_MS);
  }
  // When an answer ends, the parts it named that are on screen ring once (Miro and Figma AI mark what they name); a
  // frame whose title an earlier frame has (no layout key) is drawn faded and never rings.
  ringRef.current = (parts) => {
    const f = instance.current;
    const el = canvasEl.current;
    const b = boardRef.current;
    if (!f || !el || !b || parts.size === 0) return;
    const { x, y, zoom } = f.getViewport();
    const view = { x: -x / zoom, y: -y / zoom, w: el.offsetWidth / zoom, h: el.offsetHeight / zoom };
    const seen = new Map<string, ReadonlySet<string>>();
    for (const box of b.boxes) {
      const names = box.key === null ? undefined : parts.get(box.key);
      if (box.key === null || !names) continue;
      if (box.x < view.x + view.w && box.x + box.w > view.x && box.y - FRAME_TAB_H < view.y + view.h && box.y + box.h > view.y) seen.set(box.key, names);
    }
    if (seen.size > 0) ringNow(seen);
  };

  /**
   * A part button in an answer was pressed: the frame is selected, the view glides to it and the part
   * rings, by the frame's layout key (a title may repeat). A frame whose title an earlier frame has is not selectable,
   * so the view only goes to it.
   */
  function showPart(frame: string, name: string, column: string | null) {
    const p = parsed;
    const index = p ? p.keys.indexOf(frame) : -1;
    if (!p || index < 0) return;
    if (isDup(frame)) {
      const box = boardRef.current?.boxes.find((x) => x.index === index);
      if (box) latestActs.current.glideToFrame(box);
      return;
    }
    const parts: Airing = new Map([[frame, new Set([column === null ? name : columnRing(name, column)])]]);
    switchFrame({ title: p.result.frames[index].title, index }, [], () => {
      canvasApi.glideTo([frame]);
      ringNow(parts);
    });
  }
  const showPartRef = useRef(showPart);
  showPartRef.current = showPart;
  const onShowPart = useCallback((l: PartLink) => {
    const key = parsedRef.current?.keys[l.at];
    if (key !== undefined) showPartRef.current(key, l.name, l.column);
  }, []);

  // The assistant's glide fits the frames as the canvas draws them once what moved them is laid out (live check L2): a
  // proposal's review shapes drawn in its frames, a landing's text parsed with its shapes in place. Fitting at the call
  // fitted the frames at their old size, so a part placed at a frame's growing edge landed off screen. One glide per
  // call: a call made while another still waits (Auto-apply lands in the tick its proposal arrives) runs that one first,
  // on the frames as they are, and then waits itself.
  const pendingGlide = useRef<{ keys: readonly string[]; extra: readonly Rect[] } | null>(null);
  const [glideAsked, setGlideAsked] = useState(0);
  const fitGlide = (g: { keys: readonly string[]; extra: readonly Rect[] }) => {
    // The canvas is in board units, and `fitBoard` glides through the canvas's `glideView`.
    const rects: Rect[] = (boardRef.current?.boxes ?? []).filter((x) => x.key !== null && g.keys.includes(x.key)).map((x) => ({ x: x.x, y: x.y, w: x.w, h: x.h }));
    lateActs.current.fitBoard([...rects, ...g.extra]);
  };
  glideKeysRef.current = (keys, extra = []) => {
    const was = pendingGlide.current;
    pendingGlide.current = { keys, extra };
    if (was) fitGlide(was);
    setGlideAsked((n) => n + 1);
  };
  useEffect(() => {
    const g = pendingGlide.current;
    // Wait for the parse of the text the editor holds: until then the boxes are the old text's.
    const text = doc.view()?.state.doc.toString();
    if (!g || !boardRef.current || !parsed || (text !== undefined && parsed.text !== text)) return;
    // And for every shape of the frames to have its place: a shape with none is not drawn, so its frame is not grown
    // yet (the live frame's places come from the worker, another frame's from its layout, both after the parse).
    for (const key of g.keys) {
      const i = parsed.keys.indexOf(key);
      const f = i < 0 ? undefined : parsed.result.frames[i];
      const places = doc.board.frames.get(key)?.nodes;
      const d = i === liveSel?.index ? shown : (f?.doc ?? f?.lastValid ?? null);
      if (!f || !places || isDup(key) || !d || FIXED_KINDS.has(d.kind)) continue;
      if (d.nodes.some((n) => !hasOwn(places, n.name))) return;
    }
    pendingGlide.current = null;
    fitGlide(g);
    // fitGlide reads the refs of this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glideAsked, board, parsed, doc, shown, liveSel]);

  /** The pane following the canvas and the canvas following the pane. */
  const paneFollow: PaneFollow = {
    shownIndex: (state) => shownIndexIn(state, doc.selection()),
    // A jump or an undo into another frame glides the canvas to it; a frame made by typing a header comes into view
    // only when it is not already on screen (Figma scrolls a new frame into view).
    switchTo: (to, why) =>
      switchFrame(to, [], (box) => (why === "typed" ? latestActs.current.showFrameBox(box) : latestActs.current.glideToFrame(box)), false, why === "typed"),
  };

  /** A tab drag under way: the frame's key, where its box started on the board, its `at` then, and whether it was live. */
  const frameDrag = useRef<{ id: string; key: string; index: number; start: Point; at: Point; live: boolean; held?: boolean; was?: ReturnType<typeof fieldsNow> } | null>(null);
  /**
   * A frame dragged by its title tab: a live frame is drawn static while it moves; on release its `at` is
   * written as one undo entry and it is live again where it was let go.
   */
  function onFrameDrag(id: string, at: Point | null, done: boolean) {
    const b = boardRef.current;
    if (!b) return;
    let d = frameDrag.current;
    let was: ReturnType<typeof fieldsNow> | undefined;
    if (!d || d.id !== id) {
      const node = b.nodes.find((n) => n.id === id);
      const box = node ? (node.data as { box: FrameBox }).box : null;
      if (!node || !box || box.key === null || aiLock.current) return;
      if (node.zIndex === Z_LIVE_BOX) {
        // Drawn static meanwhile: an open card field is kept first, in its frame, as a switch does (R26); a refused
        // one keeps the frame where it is, with its reason in the strip.
        was = fieldsNow();
        const held = blurField();
        if (held !== null) {
          setNotice(held);
          frameDrag.current = { id, key: box.key, index: box.index, start: { x: 0, y: 0 }, at: { x: 0, y: 0 }, live: false, held: true };
          return;
        }
      }
      d = { id, key: box.key, index: box.index, start: { x: box.x, y: box.y }, at: doc.board.frames.get(box.key)?.at ?? { x: 0, y: 0 }, live: node.zIndex === Z_LIVE_BOX, ...(was ? { was } : {}) };
      frameDrag.current = d;
      if (d.live) {
        flushMove();
        setFrameDragLive(true);
      }
    }
    if (!done) return;
    frameDrag.current = null;
    // A drag a refused field held: nothing moves.
    if (d.held) return;
    // Esc: nothing is written, and a live frame is live again where it was.
    if (!at) {
      if (d.live) setFrameDragLive(false);
      return;
    }
    // A field the worker refused while the drag went on holds the drag as a refusal made at once does: nothing
    // moves, the frame is live again where it was, and the strip says why.
    const pending = d.was ? commitRef.current : null;
    if (pending) {
      const drag = d;
      void pending.then(() => {
        const late = drag.was ? refusedSince(drag.was) : null;
        if (late !== null) {
          if (drag.live) setFrameDragLive(false);
          setNotice(late);
          return;
        }
        moveDragged(drag, at, b);
      });
      return;
    }
    moveDragged(d, at, b);
  }

  /** A frame let go by its tab at `at`: it moves there, as one edit; a live frame is live again. */
  function moveDragged(d: NonNullable<typeof frameDrag.current>, at: Point, b: NonNullable<typeof boardRef.current>) {
    // The box node is in board units, as `start` is: a live frame drawn static meanwhile stays where it was drawn.
    const dx = Math.round(toBoard(at).x - d.start.x);
    const dy = Math.round(toBoard(at).y - d.start.y);
    if (dx !== 0 || dy !== 0) {
      if (b.boxes.length === 1) {
        // Moving the only frame shifts its shapes and leaves `at` alone, so the file stays version 1. Its
        // entry, not the selected frame's layout: the only frame may have been let go.
        const kept = doc.board.frames.get(d.key)?.nodes ?? emptyPositions();
        const after = emptyPositions();
        for (const k of Object.keys(kept)) after[k] = { x: kept[k].x + dx, y: kept[k].y + dy };
        if (Object.keys(after).length > 0) doc.move(after, undefined, undefined, { index: d.index, key: d.key });
      } else doc.moveFrame(d.key, { x: d.at.x + dx, y: d.at.y + dy });
    }
    if (d.live) setFrameDragLive(false);
  }

  /** Where the last press on the canvas was, so a click that ends a drag or a box selection is not a pick. */
  const pressAt = useRef<Point | null>(null);
  /** Where a press on the bare canvas with Select armed began: a box drawn from there may pick pictured sketches. */
  const boxFrom = useRef<Point | null>(null);

  /**
   * A click on the empty canvas (Review Focus 5): it is for the frame on top there, the live one, else the
   * later in text order. On a static frame's shape it selects the shape and its frame; on a static frame's empty space
   * the frame; on the live frame's empty space it keeps the frame (React Flow lets the shapes go); outside every frame
   * it selects nothing, on a one-frame board too (owner ruling, F2: the drawing tools come back).
   */
  function onBoardClick(e: { target: EventTarget; clientX: number; clientY: number }) {
    const t = e.target instanceof Element ? e.target : null;
    // The Hand only pans (Figma, Excalidraw).
    if (armedRef.current === "hand") return;
    // The pane, or (where pointer events are not honoured) anything inside a static frame, which takes none; or a
    // sketch, which React Flow has picked (a Section or box sketch inside a frame never gets here: `frameWinsAt`).
    const onSketch = !!t?.closest(".board-sketch-node");
    if (!t?.classList.contains("react-flow__pane") && !t?.closest(".board-static") && !onSketch) return;
    const down = pressAt.current;
    pressAt.current = null;
    if (pressedPictured.current) {
      pressedPictured.current = false;
      return;
    }
    if (down && Math.hypot(down.x - e.clientX, down.y - e.clientY) > 3) return;
    const f = instance.current;
    if (!f) return;
    const p = f.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // The sketch layer pictured: a click on a sketch there picks it, as a click on its node does.
    const pictured = onSketch ? null : pictureSketchAt(p);
    if (pictured !== null) {
      if (!frameAt(p)) switchFrame(null);
      setSketchSel([pictured]);
      return;
    }
    if (onSketch) {
      // A sketch outside every frame is picked alone: the frames let go, as a click on the canvas there does.
      if (!frameAt(p)) switchFrame(null);
      return;
    }
    pickAt(p);
    // A Section's inside is the canvas until it is selected (FigJam): outside every frame, a click there selects it.
    const section = frameAt(p) ? null : sectionAt(p);
    if (section !== null) setSketchSel([section]);
  }

  /** The frame on top at a flow position (the live one, else the later in text order); null outside every frame. */
  function frameAt(p: Point): FrameBox | null {
    const b = boardRef.current;
    if (!b) return null;
    const inside = (r: { x: number; y: number; w: number; h: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    const live = liveBoxRef.current;
    if (live && inside(live)) return live;
    let hit: FrameBox | null = null;
    for (const box of b.boxes) if (box.index !== live?.index && inside(box)) hit = box;
    return hit;
  }

  /**
   * At a flow position, a static frame (not the live one); null on the live frame or outside every frame. The live
   * frame dragged by its tab is drawn static meanwhile, but it is still the live one: a pick there is not another frame's.
   */
  function staticFrameAt(p: Point): FrameBox | null {
    const hit = frameAt(p);
    if (!hit || hit.index === liveBoxRef.current?.index) return null;
    const d = frameDrag.current;
    return d?.live && hit.key === d.key ? null : hit;
  }

  /**
   * The frame whose title tab is at a flow position, off every frame's box; the later in text order on top. The tab keeps
   * its screen size, so below 100 percent its title pill is larger in board units.
   */
  function tabAt(p: Point): FrameBox | null {
    const b = boardRef.current;
    const f = instance.current;
    if (!b || !f) return null;
    const h = tabHeight(f.getViewport().zoom);
    const k = h / FRAME_TAB_H;
    let hit: FrameBox | null = null;
    const byX = byLeft(b.boxes);
    for (const box of b.boxes) {
      // A frame with no kind yet says "Diagram" on its tab; a flowchart's word is as long. Never past its room: the
      // strip ends before the next tab in its row (coordinator ruling on F1).
      const w = Math.min(tabWidth(box.title, box.kind ?? "flow") * k, tabRoom(box.w, tabNeighbours(box, byX), f.getViewport().zoom) * k * Math.min(f.getViewport().zoom, 1));
      if (p.x >= box.x && p.x <= box.x + w && p.y >= box.y - h && p.y < box.y) hit = box;
    }
    return hit;
  }

  /** What a click at a flow position picks, as `onBoardClick` says. */
  function pickAt(p: Point) {
    if (!boardRef.current) return;
    const live = liveBoxRef.current;
    const hit = frameAt(p);
    // A click on a frame's title tab picks the frame, as its title button does.
    const tab = hit ? null : tabAt(p);
    if (tab) {
      // Back on the live frame's tab while another waits for its paint: the waiting switch goes.
      if (live?.index !== tab.index || pendingRef.current) switchFrame({ title: tab.title, index: tab.index }, []);
      return;
    }
    if (!hit) {
      switchFrame(null);
      return;
    }
    if (live && hit.index === live.index && pendingRef.current) {
      switchFrame({ title: live.title, index: live.index }, []);
      return;
    }
    if (live && hit.index === live.index) {
      setSelected([]);
      setLines([]);
      return;
    }
    const shape = staticShapeAt(hit, p);
    switchFrame({ title: hit.title, index: hit.index }, shape === null ? [] : [shape]);
  }

  /** The shape on top of static frame `hit` at a flow position, as built (drawn or not: a pictured frame is one image); null on empty frame space. */
  function staticShapeAt(hit: FrameBox, p: Point): string | null {
    const b = boardRef.current;
    if (!b) return null;
    const inside = (r: { x: number; y: number; w: number; h: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    const frameNode = b.nodes.find((n) => n.type === "boardFrame" && (n.data as { box: FrameBox }).box.index === hit.index);
    if (!frameNode) return null;
    const prefix = hit.key === null ? clashInFrameId(hit.index, "") : inFrameId(hit.key, "");
    let shape: string | null = null;
    let top = -Infinity;
    for (const n of b.children.get(frameNode.id) ?? []) {
      if (!n.id.startsWith(prefix)) continue;
      const name = n.id.slice(prefix.length);
      if (name.startsWith("\u0000")) continue;
      const r = { x: hit.x + n.position.x, y: hit.y + n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 };
      if (inside(r) && (n.zIndex ?? 0) >= top) {
        top = n.zIndex ?? 0;
        shape = name;
      }
    }
    return shape;
  }

  /**
   * A right-click in static frame `hit` (C3, Figma): on a shape, the frame is selected with that shape and the shape's
   * menu opens once the frame is live, at the same board point; on empty frame space it only selects the frame.
   */
  function menuInStaticFrame(hit: FrameBox, screen: Point, flow: Point) {
    // A pictured frame is one image, its shapes not drawn one by one: the frame alone is selected.
    const shape = boardRef.current?.pictured.has(frameNodeId(hit)) ? null : staticShapeAt(hit, flow);
    const sel = { title: hit.title, index: hit.index };
    if (shape === null) return void switchFrame(sel);
    // The same board point once the frame is live: a switch moves nothing on the canvas.
    const board = toBoard(flow);
    switchFrame(sel, [shape], () => lateActs.current.openMenu({ node: shape, screen, flow: board, fit: () => void canvasFit.current() }), true);
  }

  const onCanvasKey = (e: KeyboardEvent) => {
    // The Space box's and the Shelf's searches keep their keys, the menu keys included; only the root's shortcuts
    // (Ctrl+J) pass them.
    if ((e.target as Element).closest?.(".flow-space-box, .flow-shelf")) return;
    // Esc drops a drawing still waiting for its frame.
    if (e.key === "Escape") afterSwitch.current = null;
    // A switch waiting for its paint: the key is for the frame picked, never the one still live. It is
    // held, in order, and pressed again once that frame is live. Space (the hand, held across frames) and a key in a
    // field pass.
    const into = e.target as HTMLElement;
    if (pendingRef.current && e.key !== " " && !(into.isContentEditable || into.tagName === "INPUT" || into.tagName === "TEXTAREA")) {
      e.preventDefault();
      e.stopPropagation();
      if (heldKeys.current.length < HELD_KEYS_MAX)
        heldKeys.current.push({ key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, target: e.target });
      return;
    }
    // Esc leaves "Add relationship to..." first.
    if (e.key === "Escape" && rel.linking !== null) {
      e.preventDefault();
      rel.endModes(true);
      return;
    }
    // Any other key ends a nudge burst first, so an undo right after it takes the whole burst back.
    if (!e.key.startsWith("Arrow")) endNudge();
    if (!aiLock.current && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.altKey))) {
      e.preventDefault();
      openKeyboardMenu();
      return;
    }
    const t = e.target as HTMLElement;
    if (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    if (toolKey(e, t)) return;
    // Shift+2 with no shape or line selected zooms to the selected frame (Figma); with some, the canvas's own zoom to
    // the selection takes it.
    const shiftOnly = e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (shiftOnly && (e.code === "Digit2" || e.key === "@" || e.key === "2") && selectedRef.current.length === 0 && linesRef.current.length === 0) {
      const box = liveBoxRef.current ?? boardRef.current?.boxes.find((b) => frameSelRef.current && b.index === frameSelRef.current.index) ?? null;
      if (box) {
        e.preventDefault();
        zoomToFrame(box);
        return;
      }
    }
    // Under the lock a selected ER column (B3 decision 10) and a picked class member (CL1) still own Ctrl+Enter.
    // Neither writes while the assistant holds the text, but the key is theirs, so the review does not land on it.
    if (aiLock.current && e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && ownsCtrlEnter()) {
      e.preventDefault();
      return;
    }
    // While the assistant holds the text the canvas takes no edits; undo works once it lets go. Copy still copies.
    if (aiLock.current && !((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "a" || e.key.toLowerCase() === "c"))) return;
    // A focused button, menu item or tab keeps its own Enter: only the canvas or a shape takes it.
    if (e.key === "Enter" && t.closest("button, a[href], select, [role=menuitem], [role=menu], [role=option], [role=tab], [role=toolbar]")) return;
    // Enter on another table's card is React Flow's pick of it: neither the selected column's edit nor a rename of the
    // table selected (an ER table's rename selects it again).
    const enterOnOther = kind === "er" && e.key === "Enter" && (t.closest(".react-flow__node")?.getAttribute("data-id") ?? selectedRef.current[0]) !== selectedRef.current[0];
    // Enter places the armed kind tool's shape: today's add, in the middle of the view.
    const armedTool = kind && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey ? KIND_TOOLS[kind].find((x) => x.id === armedRef.current) : undefined;
    if (armedTool) {
      e.preventDefault();
      placeArmed(armedTool.shape);
      return;
    }
    // Enter with a sketch tool armed places its sketch in the middle of the view (the keyboard path).
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && SKETCH_TOOLS.has(armedRef.current) && armedRef.current !== "pen") {
      e.preventDefault();
      placeSketchTool(armedRef.current as SketchKind);
      return;
    }
    // A selected ER column takes Tab, Enter, F2, K, N, Ctrl+Enter, Ctrl+D, Delete, Backspace, Esc and the clipboard
    // keys (decision 10, erd-ux-research 5.8): after the tool keys and the armed tools' Enter, so Space, `/`, Esc
    // disarming and Enter placing a tool come first, and C stays the Column tool (R21).
    if (kind === "er" && !enterOnOther && er.onKey(e, selectedRef.current)) return;
    // CL1: a picked class member takes Ctrl+Enter, Delete, Enter and F2 (draw.io's rows).
    if (memberKey(e)) return;
    // the mind map's Tab, Shift+Tab, Ctrl+/, Ctrl+Shift+L and its arrow keys (board DiagramMindMap).
    if (kind === "mindmap" && mindKey(e)) return;
    if (groupKey(e)) return;
    // The one history: Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z work on the canvas as in the text.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const view = doc.view();
      const k = e.key.toLowerCase();
      if (view && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(view);
        else undo(view);
      } else if (view && k === "y" && !e.shiftKey) {
        e.preventDefault();
        redo(view);
      } else if (k === "a" && !e.shiftKey) {
        // Item 23: select every node, as every canvas tool does.
        e.preventDefault();
        setSelected(drawnRef.current?.nodes.map((n) => n.name) ?? []);
      } else if ((k === "c" || k === "x") && !e.shiftKey) {
        // The copy or cut event that follows puts the lines on the clipboard; when the WebView sends none, they
        // are written there directly. A cut then deletes the shapes as one undo step.
        const text = copySelection(k === "x");
        if (!text) return;
        expectCopy(text);
        if (k === "x") void removeSelected();
      } else if (k === "v" && !e.shiftKey) {
        // The paste event that follows brings the clipboard's text. With none, the system clipboard is read, and
        // the last copy made here is pasted only when that gives no text.
        pastePending.current = true;
        // Until the paste is written, a key replayed after a switch waits for it (`keySettled`), and never longer than
        // a key ever waits: a clipboard that never answers lets go after KEY_SETTLE_MS.
        keyWork.current++;
        let held = true;
        const letGo = () => {
          if (!held) return;
          held = false;
          keyWork.current--;
        };
        const cap = setTimeout(letGo, KEY_SETTLE_MS);
        setTimeout(() => {
          if (!pastePending.current) {
            clearTimeout(cap);
            letGo();
            return;
          }
          pastePending.current = false;
          const g = gestureFrame();
          void readClipboard()
            .then(async (t) => {
              const text = t || lastClip?.text;
              // The paste was for the frame shown when Ctrl+V was pressed.
              if (text && g.still()) await pasteFromKeys(text, g.frame);
            })
            .finally(() => {
              clearTimeout(cap);
              letGo();
            });
        });
      } else if (k === "d" && !e.shiftKey) {
        e.preventDefault();
        void duplicate();
      } else if (k === "g" && !e.shiftKey) {
        // C1 and D1: Ctrl+G groups the selection, its name in edit (draw.io, Miro, Figma, Lucidchart); a kind with no
        // groups says why.
        e.preventDefault();
        if (kind && GROUP_WORD[kind]) groupSelected();
        else if (kind && NO_GROUPS[kind]) setNotice(`Nothing grouped: ${NO_GROUPS[kind]}`);
      } else if ((k === "g" || k === "u") && e.shiftKey) {
        // Ctrl+Shift+G (Miro, Figma, Lucidchart) and Ctrl+Shift+U (draw.io) take the group apart.
        e.preventDefault();
        if (kind && GROUP_WORD[kind]) ungroupSelected();
        else if (kind && NO_GROUPS[kind]) setNotice(`Nothing to take apart: ${NO_GROUPS[kind]}`);
      }
      return;
    }
    // a selected loop takes F2, Enter and Delete (S4); M starts a message (S1).
    if (kind === "sequence" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const loop = loopSelRef.current;
      if (loop && (e.key === "F2" || e.key === "Enter")) {
        e.preventDefault();
        editLoop(loop);
        return;
      }
      if (loop && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        void unwrapLoop(loop);
        return;
      }
      if (loop && e.key === "Escape") {
        e.preventDefault();
        setLoopSel(null);
        setNotice(null);
        return;
      }
      if (e.key.toLowerCase() === "m" && !e.shiftKey) {
        e.preventDefault();
        startMessagePick();
        return;
      }
    }
    // F17: Alt+Shift+arrow clones and connects from the one selected shape (draw.io).
    const side = ({ ArrowUp: "t", ArrowRight: "r", ArrowDown: "b", ArrowLeft: "l" } as const)[e.key as "ArrowUp"];
    if (e.altKey && e.shiftKey && side && selectedRef.current.length === 1) {
      e.preventDefault();
      addNext(selectedRef.current[0], side);
      return;
    }
    if (e.altKey) return;
    // Esc leaves a Shapes item's pick first.
    if (e.key === "Escape" && shapePick.current) {
      e.preventDefault();
      setShapePick(null);
      return;
    }
    if (e.key === "Escape" && (selectedRef.current.length > 0 || linesRef.current.length > 0 || sketchSelRef.current.length > 0)) {
      e.preventDefault();
      setSelected([]);
      setLines([]);
      setSketchSel([]);
      return;
    }
    // Esc goes up one level: shape, frame, nothing, on a one-frame board too (owner ruling, F2). An Esc
    // that closed a menu (More shapes' list) has done its level.
    if (e.key === "Escape" && frameSelRef.current && !e.defaultPrevented && !t.closest("[role=menu]")) {
      e.preventDefault();
      switchFrame(null);
      return;
    }
    // F7: the arrow keys nudge the selection 1 px, Shift 16 px (Figma, draw.io); a held key's repeats are drawn at
    // once and kept as one move, one undo entry, when the key goes up (endNudge).
    const shapesNudged = nudgeKey(e, selectedRef.current);
    if (nudgeSketches(e, !shapesNudged) || shapesNudged) return;
    // F2 and Enter on the one selected sketch, with nothing else selected, edit its text or a Section's title.
    if ((e.key === "F2" || (e.key === "Enter" && !e.shiftKey)) && selectedRef.current.length === 0 && linesRef.current.length === 0 && sketchSelRef.current.length === 1) {
      if (editSketchText(sketchSelRef.current[0])) {
        e.preventDefault();
        return;
      }
    }
    // F2 and Enter edit the one selected shape's name on it (F6, draw.io). On a shape that is not selected yet,
    // Enter is React Flow's own pick: the selection here is still the one before it.
    if (e.key === "F2" || (e.key === "Enter" && !e.shiftKey)) {
      if (selectedRef.current.length === 1 && !enterOnOther) {
        e.preventDefault();
        startRename(selectedRef.current[0]);
      } else if (selectedRef.current.length === 0 && linesRef.current.length === 1) {
        // A selected line's label is edited on it (the board's F2 and Enter on a relationship).
        e.preventDefault();
        onEdgeDoubleClick(linesRef.current[0]);
      } else if (e.key === "Enter" && selectedRef.current.length === 0 && linesRef.current.length === 0 && liveBoxRef.current && !t.closest(".react-flow__node")) {
        // Enter on a selected frame goes in: its first shape. On a shape, Enter is React Flow's own pick.
        const first = drawnRef.current?.nodes[0]?.name;
        if (first !== undefined) {
          e.preventDefault();
          setSelected([first]);
        }
      }
      return;
    }
    // Delete and Backspace remove the selected shapes and lines (F1, F25).
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedRef.current.length > 0 || linesRef.current.length > 0 || sketchSelRef.current.length > 0) {
        e.preventDefault();
        void removeSelected();
      }
      return;
    }
    // A letter arms its tool: the selected frame's kind tools, else the drawing tools.
    if (e.key.length !== 1 || e.shiftKey || e.ctrlKey || e.metaKey) return;
    const tool = kind ? kindToolFor(kind, e.key) : GENERIC_TOOLS.find((x) => x.key === e.key.toUpperCase());
    if (tool) {
      e.preventDefault();
      arm(tool.id);
      return;
    }
    // N adds a note where the kind has notes, its text ready (Miro's N; board DiagramAddNext); elsewhere it arms the
    // note sketch.
    if (e.key.toLowerCase() === "n") {
      e.preventDefault();
      if (kind && NOTE_KINDS.has(kind)) addShape("note");
      else arm(NOTE_TOOL_ID);
    }
  };

  /**
   * The toolbar's fixed keys on the canvas, before anything else takes them: Esc disarms, V,
   * H and F arm Select, Hand and Section, `/` opens the add menu and Space starts a hold. True when the key was taken.
   */
  function toolKey(e: KeyboardEvent, t: HTMLElement): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    // A menu's rows keep every key: its letters and Esc are its own.
    if (t.closest("[role=menu]")) return false;
    // A focused button, menu item or tab keeps its own Space.
    const own = !!t.closest("button, a[href], select, [role=menuitem], [role=menu], [role=option], [role=tab]");
    if (e.key === " ") {
      if (own) return false;
      e.preventDefault();
      if (!e.repeat && !space.current) {
        space.current = { t: Date.now(), p: pointer.current, moved: false };
        setSpaceHeld(true);
      }
      return true;
    }
    if (e.key === "Escape" && armedRef.current !== "select") {
      e.preventDefault();
      // arm closes More shapes' list too, so one Esc does both.
      arm("select");
      return true;
    }
    // `/` takes Shift on some keyboards.
    if (e.key === "/") {
      e.preventDefault();
      // Off the canvas `/` opens the Shelf, as Add does; over it, the Space box (browsing is allowed under the
      // Assistant's lock, decision 22).
      if (!pointer.current) openShelf("slash");
      else openSpaceBox(pointer.current);
      return true;
    }
    if (e.shiftKey) return false;
    const k = e.key.toLowerCase();
    if (k === "v" || k === "h" || k === "f") {
      e.preventDefault();
      arm(k === "v" ? "select" : k === "h" ? "hand" : "section");
      return true;
    }
    return false;
  }

  /** Opens the name and details panel beside a node (item 22). */
  function editNode(name: string) {
    if (aiLock.current) return;
    const d = drawnRef.current;
    if (!d?.nodes.some((n) => n.name === name) || isArea(name)) return;
    const n = instance.current?.getNode(name);
    const w = n?.measured?.width ?? n?.width ?? n?.initialWidth ?? 0;
    // The node's position is frame-local (it hangs from the live anchor): on the board it is that plus the frame's place.
    const flowAt = n ? fromLive({ x: n.position.x + w + 12, y: n.position.y }) : { x: 0, y: 0 };
    const screen = instance.current?.flowToScreenPosition(flowAt) ?? { x: 120, y: 120 };
    const left = Math.max(8, Math.min(screen.x, window.innerWidth - 300));
    const top = Math.max(8, Math.min(screen.y, window.innerHeight - 280));
    setSelected([name]);
    setEditingNode({ name, at: { left, top }, problem: null });
  }

  /** Saves the panel: the attributes, then the name, as one batch and one undo entry. */
  async function saveNodeEdit(edit: NodeEdit) {
    if (aiLock.current) return;
    const open = editingNode;
    const d = drawnRef.current;
    const node = d?.nodes.find((n) => n.name === open?.name);
    if (!open || !d || !node) return setEditingNode(null);
    const ops = nodeEditOps(d.kind, node, edit);
    if (ops.length === 0) return setEditingNode(null);
    const rename = ops.find((o) => o.op === "renameNode");
    const g = gestureFrame();
    if (rename && rename.op === "renameNode" && node.kind !== "note") {
      const taken = await doc.linesOf([rename.next]);
      if (taken && taken[rename.next] != null) return setEditingNode({ ...open, problem: `${rename.next} is already used.` });
    }
    let why: string | null = null;
    const r = await doc.run(ops.length === 1 ? ops[0] : { op: "batch", ops }, { frame: g.frame, onRefused: (w) => (why = w) });
    // Another frame selected meanwhile: nothing reopens on a same-named shape there.
    if (!r) return g.still() ? setEditingNode({ ...open, problem: why ?? EDIT_MESSAGES.changed }) : undefined;
    setEditingNode(null);
    if (rename && rename.op === "renameNode" && node.kind !== "note") {
      const kept = doc.layout.nodes[node.name];
      if (kept) doc.place({ [rename.next]: kept }, true, r.frame ?? null);
      setSelected([rename.next]);
    }
  }

  /** Moves the text to the line that defines `node` and gives it focus. */
  async function showInText(node: string) {
    const g = gestureFrame();
    const lines = await doc.linesOf([node]);
    if (!g.still()) return;
    const line = lines?.[node];
    const v = doc.view();
    if (!v || typeof line !== "number" || line > v.state.doc.lines) return;
    v.dispatch({ selection: { anchor: v.state.doc.line(line).from }, scrollIntoView: true });
    v.focus();
  }

  /** Moves the text to link `index`'s line and gives it focus. */
  async function showLine(index: number) {
    const g = gestureFrame();
    const cur = await doc.current();
    if (!cur?.result.doc) return;
    const spans = await doc.spans(cur.result.version, [`link:${index}`]);
    if (!g.still()) return;
    const sp = spans?.[`link:${index}`];
    const v = doc.view();
    if (!sp || !v) return;
    v.dispatch({ selection: { anchor: Math.min(sp.from, v.state.doc.length) }, scrollIntoView: true });
    v.focus();
  }

  /**
   * Moves the text to the line of `table`'s `index`-th column and gives it focus (decision 13): the worker's `row:`
   * span in the selected frame, which the pane already shows.
   */
  async function showColumn(table: string, index: number) {
    const g = gestureFrame();
    const cur = await doc.current();
    if (!cur) return;
    const key = `row:${table}:${index}`;
    const spans = await doc.spans(cur.result.version, [key]);
    if (!g.still()) return;
    const sp = spans?.[key];
    const v = doc.view();
    if (!sp || !v) return;
    v.dispatch({ selection: { anchor: Math.min(sp.from, v.state.doc.length) }, scrollIntoView: true });
    v.focus();
  }

  /** A line's arrow or direction from its menu: one text edit, one undo step. */
  /**
   * A line op on the line `link` names (its ends, label and which of those it is, taken when the menu opened or the
   * end was dropped), never an index into a drawing that may be stale. While the text has an error, or when the
   * line is gone, nothing changes and the strip says why; an op that changes nothing says nothing.
   */
  function editLine(
    link: LinkRef | null,
    op: { op: "setLinkArrow"; arrow: FlowArrow } | { op: "reverseLink" } | { op: "setLinkEnd"; end: "from" | "to"; node: string } | { op: "setLinkColor"; color: string | null },
    /** The line to keep selected once this edit has gone in (the line bar's): armed only when the edit is dispatched. */
    keep: string | null = null,
  ) {
    if (aiLock.current || !link) return;
    setNotice(null);
    if (!parsedRef.current?.result.doc) {
      setNotice(LINK_NOTES.broken);
      return;
    }
    keepLine.current = keep;
    void doc.run(
      { ...op, link },
      {
        onRefused: (why) => {
          keepLine.current = null;
          setNotice(why);
        },
      },
    );
  }

  // ----- Colour (board DiagramColourLabels; draw.io Fill, Miro, eraser.io `color`)

  /** Why `n` takes no colour (its kind is written with a word, a note, a marker, the central idea); null when it does. */
  function colourWhy(n: FlowNode | undefined): string | null {
    if (kind === "sequence") return NO_COLOUR.sequence ?? COLOUR_WHY.lines;
    if (!kind || !ATTR_DIAGRAMS.has(kind)) return (kind && NO_COLOUR[kind]) ?? COLOUR_WHY.lines;
    if (!n) return null;
    if (n.kind === "note") return COLOUR_WHY.note;
    if (kind === "state" && isStateMarker(n.name)) return COLOUR_WHY.marker;
    if (n.kind === "root") return COLOUR_WHY.root;
    return null;
  }

  /** A group by name, at any depth. */
  function groupNamed(d: FlowDoc | null | undefined, name: string): FlowGroup | null {
    const stack = [...(d?.groups ?? [])];
    for (let g = stack.pop(); g; g = stack.pop()) {
      if (g.name === name) return g;
      stack.push(...g.groups);
    }
    return null;
  }

  /** The Colour row for shapes and lines picked together: one colour for all, one edit list and one undo step. */
  function colourRow(shapes: readonly string[], lines: readonly string[]): ColourMenu {
    const d = parsedRef.current?.result.doc ?? drawnRef.current;
    const nodes = shapes.map((s) => d?.nodes.find((n) => n.name === s)).filter((n): n is FlowNode => !!n && colourWhy(n) === null);
    const links = lines
      .map((l) => linkIndex(l))
      .filter((i): i is number => i !== null && !!d?.links[i] && !d.links[i].tree)
      .map((i) => ({ i, l: d!.links[i] }));
    const lineWhy = kind && LINE_COLOUR_DIAGRAMS.has(kind) ? null : COLOUR_WHY.lines;
    const now = new Set([...nodes.map((n) => drawnColour(n.attrs.color) ?? ""), ...(lineWhy ? [] : links.map((x) => drawnColour(x.l.color) ?? ""))]);
    const current = now.size === 1 ? ([...now][0] as DrawnColour | "") : now.size === 0 ? "" : null;
    const one = shapes.length === 1 && lines.length === 0 ? d?.nodes.find((n) => n.name === shapes[0]) : undefined;
    const why =
      nodes.length === 0 && (links.length === 0 || lineWhy !== null)
        ? one
          ? colourWhy(one)
          : shapes.length === 0
            ? (lineWhy ?? COLOUR_WHY.lines)
            : (colourWhy(undefined) ?? COLOUR_WHY.none)
        : null;
    const refs = links.map((x) => linkRefOf(d?.links ?? [], x.i)).filter((r): r is LinkRef => r !== null);
    return { current, why, pick: (c) => void colourPicked(nodes, lineWhy ? [] : refs, c, shapes.length - nodes.length) };
  }

  /** Writes colour `c` (null clears it) on the shapes and lines, as one edit list; says what it did. */
  async function colourPicked(nodes: FlowNode[], refs: LinkRef[], c: PaletteName | null, skipped: number) {
    if (aiLock.current) return;
    setNotice(null);
    const name = c ? COLOUR_INFO[c].label : "";
    const changing = nodes.filter((n) => (drawnColour(n.attrs.color) ?? null) !== c || (c === null && n.attrs.color !== undefined));
    const lineOps = refs.filter((r) => {
      const l = drawnRef.current?.links.find((x) => x.from === r.from && x.to === r.to && (x.label ?? null) === r.label);
      return (l?.color ?? null) !== c;
    });
    const ops: FlowEditOp[] = [
      ...changing.map((n) => ({ op: "setAttr" as const, name: n.name, key: "color" as const, value: c })),
      ...lineOps.map((link) => ({ op: "setLinkColor" as const, link, color: c })),
    ];
    const what = nodes.length + refs.length === 1 ? (nodes[0] ? said(shownName(nodes[0])) : "the line") : `${(nodes.length + refs.length).toLocaleString("en-US")} items`;
    if (ops.length === 0) return setNotice(`${what.replace(/^./, (x) => x.toUpperCase())} ${nodes.length + refs.length === 1 ? "is" : "are"} ${c ? name : "uncoloured"} already.`);
    let why: string | null = null;
    const r = await doc.run(ops.length === 1 ? ops[0] : { op: "batch", ops }, { onRefused: (w) => (why = w) });
    if (!r) return setNotice(why ?? EDIT_MESSAGES.changed);
    const kept = skipped > 0 ? ` ${skipped === 1 ? "One shape" : `${skipped.toLocaleString("en-US")} shapes`} kept their colour: notes, markers and the central idea take none.` : "";
    setNotice(
      (c
        ? `Coloured ${what} ${name}: ${ops.length === 1 ? `its line gains color: ${c}` : `${ops.length.toLocaleString("en-US")} lines gain color: ${c}`}`
        : `Cleared the colour of ${what}: color: leaves ${ops.length === 1 ? "its line" : `${ops.length.toLocaleString("en-US")} lines`}, and the kind's own colours come back`) +
        (ops.length > 1 ? ", in one undo step." : ". One undo step.") +
        kept,
    );
  }

  /** A group's Colour row: its border and title. */
  function groupColourRow(group: string): ColourMenu {
    const g = groupNamed(parsedRef.current?.result.doc ?? drawnRef.current, group);
    const current = drawnColour(g?.color) ?? "";
    return {
      current,
      why: null,
      pick: (c) => {
        if (aiLock.current) return;
        if (current === (c ?? "") && (c !== null || g?.color === undefined)) return setNotice(`${group} is ${c ? COLOUR_INFO[c].label : "uncoloured"} already.`);
        void doc.run({ op: "setAttr", name: group, key: "color", value: c }, { onRefused: (w) => setNotice(w) }).then((r) => {
          if (r) setNotice(c ? `Coloured ${group} ${COLOUR_INFO[c].label}: its border and title. One undo step.` : `Cleared the colour of ${group}. One undo step.`);
        });
      },
    };
  }

  /** The selected shapes' boxes, where they are drawn now. */
  function selectedBoxes(): { n: string; x: number; y: number; w: number; h: number }[] {
    const out: { n: string; x: number; y: number; w: number; h: number }[] = [];
    for (const n of selectedRef.current) {
      const g = graphRef.current.nodes.find((x) => x.id === n);
      const p = drawnAt(n);
      if (g && p) out.push({ n, x: p.x, y: p.y, w: g.initialWidth ?? 0, h: g.initialHeight ?? 0 });
    }
    return out;
  }

  /** Align (F12, draw.io's Arrange): the selected shapes line up on the selection's edge or middle, one move. */
  function align(how: AlignHow) {
    const boxes = selectedBoxes();
    if (aiLock.current || boxes.length < 2 || !kind || FIXED_KINDS.has(kind)) return;
    const x0 = Math.min(...boxes.map((b) => b.x));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const after = emptyPositions();
    for (const b of boxes) {
      let { x, y } = b;
      if (how === "left") x = x0;
      else if (how === "right") x = x1 - b.w;
      else if (how === "centre") x = Math.round((x0 + x1) / 2 - b.w / 2);
      else if (how === "top") y = y0;
      else if (how === "bottom") y = y1 - b.h;
      else y = Math.round((y0 + y1) / 2 - b.h / 2);
      after[b.n] = { x, y };
    }
    arrangeTo(boxes, after);
  }

  /** Distribute (F12): the first and last shapes stay, and the gaps between the boxes become equal, one move. */
  function distribute(axis: "x" | "y") {
    const boxes = selectedBoxes();
    if (aiLock.current || boxes.length < 3 || !kind || FIXED_KINDS.has(kind)) return;
    const pos = (b: (typeof boxes)[number]) => (axis === "x" ? b.x : b.y);
    const size = (b: (typeof boxes)[number]) => (axis === "x" ? b.w : b.h);
    const sorted = [...boxes].sort((a, b) => pos(a) - pos(b));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const span = pos(last) + size(last) - pos(first);
    const gap = (span - sorted.reduce((t, b) => t + size(b), 0)) / (sorted.length - 1);
    const after = emptyPositions();
    let at = pos(first);
    for (const b of sorted) {
      const p = b === last ? pos(last) : Math.round(at);
      after[b.n] = axis === "x" ? { x: p, y: b.y } : { x: b.x, y: p };
      at += size(b) + gap;
    }
    arrangeTo(boxes, after);
  }

  function arrangeTo(boxes: { n: string; x: number; y: number }[], after: Positions) {
    const from = emptyPositions();
    for (const b of boxes) from[b.n] = { x: b.x, y: b.y };
    doc.move(after);
    glideTo(from, after, "settle");
  }

  // A Shapes item's pick lives as long as its prompt: any action that clears or replaces it ends the pick. So do
  // "Add relationship to..." and "Make a relationship from here".
  useEffect(() => {
    if (shapePick.current && notice !== shapePick.current.prompt) shapePick.current = null;
    if (shapePick.current?.p.what !== "message") setSlotGuide((g) => (g?.pick ? null : g));
    if ((rel.linking !== null && notice !== linkNotice(rel.linking)) || (rel.pick !== null && notice !== RELATE_MESSAGES.pick)) rel.endModes(false);
  }, [notice, rel]);
  // The drawing changed under a pick (an undo, typing): its aim follows its column, or goes when the column has.
  useEffect(() => {
    relRef.current?.syncPick();
  }, [drawn]);
  // A tab put behind another ends them too, and takes their prompt from the strip (N2).
  useEffect(() => {
    if (!active) relRef.current?.endModes(true);
  }, [active]);

  /** Item 20 and diagram step 4: a right-click offers what is under the pointer first. */
  function openMenu(at: CanvasMenuAt) {
    // A sketch has no menu of its own yet: a right-click on one is the canvas's there.
    if (at.node !== null && isSketchNodeId(at.node)) at = { ...at, node: null };
    // A right-click on a static frame selects it; its menu is the frame bar's, never the live frame's.
    if (!at.line && !at.selection && (at.node === null || isStaticId(at.node))) {
      const hit = staticFrameAt(toBoard(at.flow));
      if (hit) return menuInStaticFrame(hit, at.screen, at.flow);
    }
    // Paste and Add here land in the live frame, in its own units.
    const local = toLive(at.flow);
    if (aiLock.current) return;
    if (!kind) {
      // No frame selected: the canvas's own actions, with nothing to add, select or tidy; Publish opens on the board
      //.
      if (!parsedRef.current) return;
      rel.endModes(true);
      setMenu({
        x: at.screen.x,
        y: at.screen.y,
        label: "Canvas actions",
        items: paneMenuItems({
          tools: [],
          empty: true,
          drawn: publishableRef.current,
          add: () => {},
          paste: () => void pasteFromMenu(local),
          selectAll: () => {},
          tidy: () => {},
          fit: at.fit,
          publish: () => void openPublish(),
        }),
      });
      return;
    }
    // A menu is another action: "Make a relationship from here" and "Add relationship to..." end.
    rel.endModes(true);
    const d = drawnRef.current;
    const names = d?.nodes.map((n) => n.name) ?? [];
    const place = (label: string, items: ReturnType<typeof paneMenuItems>) => setMenu({ x: at.screen.x, y: at.screen.y, label, items });
    const selectionMenu = (count: number) => {
      const shapes = selectedRef.current.length;
      place(
        `${count.toLocaleString("en-US")} selected`,
        selectionMenuItems({
          count,
          shapes,
          movable: !FIXED_KINDS.has(kind),
          service: kind === "cloud" && shapes > 0,
          align,
          distribute,
          cut: () => copyFromMenu(true),
          copy: () => copyFromMenu(false),
          duplicate: () => void duplicate(),
          tidy: () => void tidy(),
          group: () => void groupSelected(),
          remove: () => void removeSelected(),
          colour: colourRow(selectedRef.current, linesRef.current),
        }),
      );
    };
    // A right-click on the box around a box selection (F11).
    if (at.selection) {
      const count = selectedRef.current.length + linesRef.current.length;
      // One shape in a box selection gets its own menu, not "1 selected".
      if (count === 1 && selectedRef.current.length === 1) return openMenu({ ...at, selection: false, node: selectedRef.current[0] });
      if (count > 0) selectionMenu(count);
      return;
    }
    if (at.line) {
      const line = at.line;
      const kept = linesRef.current.includes(line);
      if (!kept) {
        setLines([line]);
        setSelected([]);
      }
      const count = linesRef.current.length + selectedRef.current.length;
      // S4: a sequence message's own menu, for it or for every selected message (board DiagramSequence).
      if (kind === "sequence" && linkIndex(line) !== null && (!kept || selectedRef.current.length === 0)) {
        const indexes = (kept ? linesRef.current : [line]).map(linkIndex).filter((i): i is number => i !== null && !!d?.links[i]);
        const last = linkIndex(line)!;
        // The messages are named by their ends, label and place among their likes, taken as the menu opens: the text may
        // change under the open menu.
        const links = d?.links ?? [];
        const refs = indexes.map((i) => linkRefOf(links, i)).filter((r): r is LinkRef => r !== null);
        const lastRef = linkRefOf(links, last);
        const at = (ref: LinkRef | null): number | null => {
          const now = drawnRef.current?.links ?? [];
          if (!ref) return null;
          for (let i = 0; i < now.length; i++) {
            const r = linkRefOf(now, i);
            if (r && r.from === ref.from && r.to === ref.to && r.label === ref.label && r.nth === ref.nth) return i;
          }
          return null;
        };
        const nowAll = () => refs.map(at).filter((i): i is number => i !== null);
        place(
          "Message actions",
          messageMenuItems({
            count: indexes.length,
            request: indexes.every((i) => d?.links[i]?.arrow === "->"),
            reply: indexes.every((i) => d?.links[i]?.arrow === "-->"),
            editLabel: () => {
              const i = at(lastRef);
              if (i !== null) onEdgeDoubleClick(`edge:${i}`);
              else setNotice(LINK_NOTES.gone);
            },
            setArrow: (arrow) => setMessageArrows(nowAll(), arrow),
            addReply: () => {
              const i = at(lastRef);
              if (i !== null) void addReply(i);
              else setNotice(LINK_NOTES.gone);
            },
            reverse: () => reverseMessages(nowAll()),
            loop: () => loopAround(nowAll()),
            showInText: () => {
              const i = at(lastRef);
              if (i !== null) void showLine(i);
            },
            remove: () => {
              const now = nowAll().sort((a, b) => b - a);
              if (now.length === 0) return setNotice(LINK_NOTES.gone);
              setNotice(null);
              void doc.run(now.length === 1 ? { op: "deleteLink", index: now[0] } : { op: "batch", ops: now.map((index) => ({ op: "deleteLink" as const, index })) });
            },
          }),
        );
        return;
      }
      if (kept && count > 1) return selectionMenu(count);
      const index = linkIndex(line);
      const link = index !== null ? d?.links[index] : undefined;
      if (index === null || !link) return;
      // Which line this is, by its ends and label, as the menu opens: the text may change under the open menu.
      const ref = linkRefOf(d?.links ?? [], index);
      place(
        kind === "er" ? "Relationship actions" : "Line actions",
        lineMenuItems({
          kind,
          arrow: link.arrow,
          branch: link.tree ? BRANCH_NOTE : null,
          editLabel: () => onEdgeDoubleClick(line),
          setArrow: (arrow) => editLine(ref, { op: "setLinkArrow", arrow }),
          reverse: () => editLine(ref, { op: "reverseLink" }),
          showInText: () => void showLine(index),
          remove: () => void removeSelected(),
          colour: {
            current: drawnColour(link.color) ?? "",
            why: LINE_COLOUR_DIAGRAMS.has(kind) ? null : COLOUR_WHY.lines,
            pick: (color) => {
              if ((link.color ?? null) === color) return setNotice(`The line is ${color ? COLOUR_INFO[color].label : "uncoloured"} already.`);
              editLine(ref, { op: "setLinkColor", color });
            },
          },
        }),
      );
      return;
    }
    if (at.node !== null && !isArea(at.node) && names.includes(at.node)) {
      const node = at.node;
      const kept = selectedRef.current.includes(node);
      if (!kept) {
        setSelected([node]);
        setLines([]);
      }
      const count = selectedRef.current.length + linesRef.current.length;
      // An ER table's or column's own menu (decision 12): a right-click on a column row named it just before.
      const t = kind === "er" ? d?.nodes.find((n) => n.name === node && isErTable(n)) : undefined;
      const column = t ? er.takeMenuColumn(node) : null;
      if (kept && count > 1) return selectionMenu(count);
      const row = column ? t?.rows?.[column.index] : undefined;
      if (t && column && row !== undefined) {
        const { index } = column;
        const api = er.value.api;
        place(
          `${node}.${splitRow(row).name} actions`,
          columnMenuItems({
            flags: t.rowFlags?.[index] ?? [],
            blocked: api.blocked(node),
            rename: () => api.editColumn(node, index, "name"),
            editType: () => api.editColumn(node, index, "type"),
            toggle: (flag) => api.toggleFlag(node, index, flag),
            insert: (where) => api.addColumn(node, where === "above" ? index : index + 1),
            duplicate: () => api.duplicateColumn(node, index),
            relate: () => rel.startPick({ table: node, column: splitRow(row).name }),
            showInText: () => void showColumn(node, index),
            remove: () => api.deleteColumn(node, index),
          }),
        );
        return;
      }
      const lined = kind === "dfd" || kind === "flow" || kind === "cloud" || kind === "state" || kind === "class";
      place(
        `${node} actions`,
        shapeMenuItems({
          ...(t
            ? {
                table: true,
                addColumn: () => er.value.api.addColumn(node),
                addRelationship: () => {
                  rel.startLinking(node);
                  setNotice(linkNotice(node));
                },
              }
            : {}),
          sized: !!layoutRef.current.sizes && hasOwn(layoutRef.current.sizes, node),
          connect: lined ? tools.filter((t) => t.kind !== "group") : [],
          service: kind === "cloud",
          rename: () => startRename(node),
          details: () => editNode(node),
          cut: () => copyFromMenu(true),
          copy: () => copyFromMenu(false),
          duplicate: () => void duplicate(),
          addConnected: (tool) => {
            const g = graphRef.current.nodes.find((x) => x.id === node);
            const p = drawnAt(node);
            if (g && p) void addConnectedAt(node, { x: p.x + (g.initialWidth ?? 0) + 80, y: p.y + (g.initialHeight ?? 0) / 2 }, tool);
          },
          chooseIcon: () => openPicker(node),
          group: () => void groupSelected(),
          fit: () => doc.unsize(node),
          showInText: () => void showInText(node),
          remove: () => void removeSelected(),
          colour: colourRow([node], []),
        }),
      );
      return;
    }
    place(
      "Canvas actions",
      paneMenuItems({
        tools,
        keyOf: (t) => (kind ? keyOfAddTool(kind, t.label) : undefined),
        empty: names.length === 0,
        drawn: publishableRef.current,
        add: (t) => add(t, local),
        paste: () => void pasteFromMenu(local),
        selectAll: () => setSelected(names),
        tidy: () => void tidy(),
        fit: at.fit,
        publish: () => void openPublish(),
      }),
    );
  }

  const nodeOf = (n: string): FlowNode | undefined => drawn?.nodes.find((x) => x.name === n);
  const one = selected.length === 1 && lines.length === 0 ? nodeOf(selected[0]) : undefined;
  // The one selected line (F1): its ends and its label, in the strip.
  const oneLine = (() => {
    if (selected.length > 0 || lines.length !== 1) return undefined;
    const i = linkIndex(lines[0]);
    return i === null ? undefined : drawn?.links[i];
  })();
  const picked = selected.length + lines.length;
  // Made once per drawing and selection, not on each frame of a drag.
  const groupCount = useMemo(() => (groupSel !== null && drawn ? (groupContents(drawn, groupSel)?.shapes.length ?? null) : null), [drawn, groupSel]);
  const askContents = useMemo(() => (groupAsk !== null && drawn ? groupContents(drawn, groupAsk) : null), [drawn, groupAsk]);
  /** Delete's question opens under the group's title, on screen. */
  const askAt = (() => {
    if (groupAsk === null || !drawn) return null;
    const c = askContents;
    const a = graph.nodes.find((n) => n.id === `\u0000group:${groupAsk}`);
    if (!c || !a) return null;
    const f = instance.current;
    const p = f ? f.flowToScreenPosition(fromLive({ x: a.position.x + 8, y: a.position.y + 28 })) : { x: a.position.x + 8, y: a.position.y + 28 };
    const r = canvasEl.current?.getBoundingClientRect();
    const left = r ? Math.max(4, Math.min(p.x - r.left, r.width - 304)) : p.x;
    const top = r ? Math.max(4, Math.min(p.y - r.top, r.height - 176)) : p.y;
    return { counts: { shapes: c.shapes.length, inner: c.inner.length, lines: c.lines }, at: { left, top } };
  })();
  const flowsOf = (n: string) => drawn?.links.filter((l) => l.from === n || l.to === n).length ?? 0;
  /**
   * The shown frame in the parse (frame 0 with none selected): its first line, its problems, and the board's problems
   * outside every frame read (past the 50th), which a banner on the canvas shows.
   */
  const paneFrame = useMemo(() => {
    if (!parsed) return null;
    const frames = parsed.result.frames;
    const i = parsed.frame?.index ?? 0;
    const heads = frames.length >= MAX_BOARD_FRAMES ? frameHeaders(parsed.text) : [];
    const unread = heads.length > MAX_BOARD_FRAMES ? heads[MAX_BOARD_FRAMES].from : Number.POSITIVE_INFINITY;
    const f = frames[i];
    const from = f?.from ?? 0;
    const end = i + 1 < frames.length ? frames[i + 1].from : unread;
    return {
      line: f?.line ?? 1,
      problems: parsed.result.problems.filter((p) => p.from >= from && p.from < end),
      outside: parsed.result.problems.filter((p) => p.from >= unread),
    };
  }, [parsed]);
  const errors = (paneFrame?.problems ?? []).filter((p) => p.severity === "error");
  const counted = parsed?.result.doc ?? drawn;

  // The selected nodes' lines, and the new flow's line while its label box is open.
  const newLine = labelBox?.fresh ? labelBox.line : undefined;
  const wroteLine = written && doc.view()?.state.doc === written.doc ? written.line : undefined;
  const shownBands = useMemo(
    () => [...bandLines, ...aiBands, ...(newLine === undefined ? [] : [newLine]), ...(wroteLine === undefined ? [] : [wroteLine])],
    [bandLines, aiBands, newLine, wroteLine],
  );

  // The label box sits on the middle of its flow's middle run, once both ends are drawn; a sequence message's on
  // its own row, just above the line (S3, Visio).
  const labelAt = useMemo(() => {
    if (!labelBox) return null;
    const a = graph.nodes.find((n) => n.id === labelBox.from);
    const b = graph.nodes.find((n) => n.id === labelBox.to);
    if (!a || !b) return null;
    if (kind === "sequence") {
      const d = graph.edges.find((g) => g.id === `edge:${labelBox.index}`)?.data as { row?: number; y?: number } | undefined;
      if (d) {
        const y = a.position.y + (d.y ?? SEQ_HEAD + ((d.row ?? 0) + 0.5) * SEQ_ROW) - 10;
        const x = (a.position.x + (a.initialWidth ?? 0) / 2 + b.position.x + (b.initialWidth ?? 0) / 2) / 2;
        return { x, y };
      }
    }
    // Kept off the shapes (board DiagramAddNext): the nearest spot along the line's middle where the field covers none.
    // At its rows, as far as its cards are scrolled, for a relationship between columns (R9).
    const mid = edgeMid(graph, `edge:${labelBox.index}`, erScroll.get) ?? routeOrthogonal(lineBoxOf(a), lineBoxOf(b)).mid;
    const shapes = graph.nodes.filter((n) => !isArea(n.id)).map(boxOfNode);
    const covers = (x: number, y: number) => shapes.some((q) => x - 85 < q.x + q.w && x + 85 > q.x && y - 12 < q.y + q.h && y + 12 > q.y);
    for (let d = 0; d <= 240; d += 8) for (const [dx, dy] of d ? [[0, -d], [0, d], [-d, 0], [d, 0]] : [[0, 0]]) if (!covers(mid.x + dx, mid.y + dy)) return { x: mid.x + dx, y: mid.y + dy };
    return mid;
  }, [labelBox, graph, kind, erScroll]);

  // F3's field sits over the shape's middle, as wide as the shape; a class's in its header. A group's title edits at
  // the top of its area; a new group's around its shapes.
  const fieldAt = useMemo(() => {
    if (!field) return null;
    if (field.kind === "label") {
      const n = graph.nodes.find((g) => g.id === field.node);
      if (!n) return null;
      const b = boxOfNode(n);
      const t = (n.data as { kind?: string } | undefined)?.kind;
      const header = t === "class" || t === "interface" || t === "enum";
      const node = drawn?.nodes.find((x) => x.name === field.node);
      const note = node?.kind === "note";
      // A participant's box is its whole lifeline: its name is on its head.
      const head = t === "participant" || t === "actor";
      // A labelled shape edits the words it shows.
      return { x: b.x, y: header ? b.y + 16 : head ? b.y + SEQ_HEAD / 2 : b.y + b.h / 2, w: Math.max(b.w, 120), box: b, note, value: note ? (node?.text ?? "") : node ? shownName(node) : field.node };
    }
    if (field.kind === "group") {
      const n = graph.nodes.find((g) => g.id === `\u0000group:${field.name}`);
      if (!n) return null;
      const b = boxOfNode(n);
      // Exactly over the title (12, 8 in its area, 16 px tall): the 24 px field centred on it, its text where the
      // title's is; the title hides while it is edited.
      return { x: b.x + 8, y: b.y + 4, w: Math.max(160, Math.min(b.w - 16, 260)), box: b, note: false, value: field.name };
    }
    if (field.kind === "new") {
      // A mind map topic's ghost is laid out with the map: its field sits on it.
      const ghost = graph.nodes.find((g) => g.id === GHOST_ID);
      if (ghost) keptGhost.current = { open: field.open ?? 0, box: boxOfNode(ghost) };
      const kept = keptGhost.current?.open === (field.open ?? 0) ? keptGhost.current.box : null;
      const box = ghost ? boxOfNode(ghost) : (kept ?? { x: field.at.x, y: field.at.y, w: field.size.w, h: field.size.h });
      return { x: box.x, y: box.y + box.h / 2, w: Math.max(box.w, 120), box, note: field.node === "note", value: field.name };
    }
    if (field.kind === "newloop" || field.kind === "newsection" || field.kind === "loop") {
      const box = { x: field.at.x, y: field.at.y, w: 200, h: LOOP_FIELD_H };
      return { x: box.x, y: box.y + LOOP_FIELD_H / 2, w: 200, box, note: false, value: field.name };
    }
    // The shapes it takes, and the groups it takes (Ctrl+G on a selected group nests it).
    const ids = [...field.members, ...(field.subgroups ?? []).map((g) => `\u0000group:${g}`)];
    const boxes = ids.map((m) => graph.nodes.find((g) => g.id === m)).filter((n): n is Node => !!n).map(boxOfNode);
    if (boxes.length === 0) return null;
    const x0 = Math.min(...boxes.map((b) => b.x)) - 16;
    const y0 = Math.min(...boxes.map((b) => b.y)) - 40;
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + 16;
    const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + 16;
    const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    return { x: x0 + 8, y: y0 + 14, w: Math.max(160, Math.min(box.w - 16, 260)), box, note: false, value: field.name };
  }, [field, graph, drawn]);

  /** The field's accessible name: what it names. */
  function fieldLabel(f: NonNullable<typeof field>, note: boolean): string {
    if (f.kind === "label") return note ? "Edit the note" : `Rename ${said(f.node)}`;
    if (f.kind === "new") return f.node === "note" ? "Note text" : `Name the new ${nounOf(f.node, kind)}`;
    if (f.kind === "newloop") return "Loop label";
    if (f.kind === "loop") return `${f.was.split(" ")[0].replace(/^./, (c) => c.toUpperCase())} label`;
    if (f.kind === "newsection") return "Section name";
    return `${f.kind === "newgroup" ? f.word : (GROUP_WORD[kind ?? "flow"] ?? "Group")} name`;
  }
  // The new shape's line from its source, drawn with the ghost.
  const ghostLine = useMemo(() => {
    if (field?.kind !== "new" || !field.from) return null;
    const src = graph.nodes.find((n) => n.id === field.from);
    return src ? routeOrthogonal(lineBoxOf(src), { x: field.at.x, y: field.at.y, w: field.size.w, h: field.size.h }, field.axis ? { axis: field.axis } : {}).d : null;
  }, [field, graph]);

  // A new item's field is open: the empty diagram's first-node hint steps aside (N-G).
  const newItemOpen = !!field && field.kind !== "label" && field.kind !== "group" && field.kind !== "loop";
  // The types offered while an ER column's type is typed: the common ones, then those the live frame uses.
  const erTypes = useMemo(() => (kind !== "er" || !drawn ? ER_TYPES : erTypesOf(drawn.nodes)), [kind, drawn]);
  // The pick's words in the strip, beside its prompt: how to leave it, or what Enter links to.
  const pickWords = rel.pick
    ? [
        rel.pick.at === -1 ? "Esc cancels." : "",
        rel.pick.at === -2 ? "Aim first with the arrow keys." : "",
        rel.pick.aim ? (rel.pick.aim.column === null ? `Aim: key of ${rel.pick.aim.table}` : `Aim: ${rel.pick.aim.table}.${rel.pick.aim.column}`) : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  // The group title being renamed hides under its field, so the old name never shows behind the new one.
  const renamingGroup = field?.kind === "group" ? field.name : null;
  useLayoutEffect(() => {
    if (renamingGroup === null) return;
    const area = [...(canvasEl.current?.querySelectorAll(".flow-area") ?? [])].find((a) => a.getAttribute("aria-label") === `Group ${renamingGroup}`);
    const title = area?.querySelector<HTMLElement>(".flow-area-name");
    if (!title) return;
    title.style.visibility = "hidden";
    return () => {
      title.style.visibility = "";
    };
  }, [renamingGroup, graph]);

  // The Space box closes when the canvas is resized under it (a window resize, Ctrl+J's Assistant pane): its place and
  // crosshair were read when it opened (Figma, Miro). A ResizeObserver's first call is the size it opened at.
  const spaceOpen = spaceBox !== null;
  useEffect(() => {
    const el = canvasEl.current;
    if (!spaceOpen || !el) return;
    let first: { w: number; h: number } | null = null;
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r) return;
      if (!first) first = { w: r.width, h: r.height };
      else if (r.width !== first.w || r.height !== first.h) closeSpaceRef.current("view");
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [spaceOpen]);

  // Space's release is caught wherever focus went meanwhile; a lost window focus ends the hold with no tap. A layout
  // effect, so a quick tap's keyup cannot land before the listener is there.
  useLayoutEffect(() => {
    if (!spaceHeld) return;
    const up = (e: globalThis.KeyboardEvent) => {
      if (e.key === " ") endSpaceRef.current();
    };
    const lost = () => {
      space.current = null;
      setSpaceHeld(false);
    };
    window.addEventListener("keyup", up);
    window.addEventListener("blur", lost);
    return () => {
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", lost);
    };
  }, [spaceHeld]);

  // Frames just added: once drawn the first is selected; once live one frame glides into view and more are fitted
  // (B2 decision 9). The toast shows after the switch, which would end its Undo.
  useEffect(() => {
    const added = addedFrame.current;
    if (!added || !board) return;
    // Undone or redone before it was drawn: not this add's frame any more.
    if (added.depth !== historyDepth()) {
      addedFrame.current = null;
      return;
    }
    const first = added.titles[0];
    const box = board.boxes.find((b) => b.title === first && b.key === first);
    if (!box) return;
    addedFrame.current = null;
    const boxes = added.boxes;
    switchFrame({ title: box.title, index: box.index }, [], (live) => (boxes.length > 1 ? lateActs.current.fitBoard(boxes) : latestActs.current.glideToFrame(live)));
    if (added.toast) undoableToast(added.toast);
    // Runs when the board is drawn again; the helpers read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, liveBox]);

  /** Where a hovered or selected shape is drawn, for its handles; none for markers, group areas and notes' +. */
  const hotBox = (id: string): Box | null => {
    const n = graphRef.current.nodes.find((g) => g.id === id);
    return n && !isArea(id) ? boxOfNode(n) : null;
  };

  /** F8: a line's end let go at board point `flow`: onto the shape there (within the 24 px magnet), as one edit; elsewhere nothing. */
  const reattach = useCallback(
    (edge: string, end: "from" | "to", flow: Point) => {
      const at = toLive(flow);
      const index = linkIndex(edge);
      if (aiLock.current || index === null) return;
      // A relationship between columns keeps the rules of a new drop.
      if (relRef.current?.reattachColumn(index, end, at)) return;
      const nodes = graphRef.current.nodes.filter((n) => !isArea(n.id));
      const hit = magnetTarget(at, nodes.map((n) => ({ id: n.id, box: lineBoxOf(n) })));
      // Let go away from every shape: the end goes back where it was.
      if (!hit) return;
      editLineRef.current(linkRefOf(drawnRef.current?.links ?? [], index), { op: "setLinkEnd", end, node: hit.id });
    },
    [],
  );

  const editLineRef = useRef(editLine);
  editLineRef.current = editLine;

  /** Item 21's resize, refused while the assistant holds the text. */
  const resize = (n: string, box: { x: number; y: number; w: number; h: number }) => {
    if (!aiLock.current) doc.resize(n, box);
  };

  if (doc.readError) {
    return (
      <div className="flow-tab">
        <p className="state-panel muted" role="alert">
          {doc.readError}
        </p>
      </div>
    );
  }
  return (
    <div
      className={side.hidden ? "flow-tab is-pane-closed" : "flow-tab"}
      onKeyDown={(e) => {
        // A key typed inside a dialog (Syntax Help, Icon credits, Publish image) is the dialog's own: the board's
        // shortcuts never act under it. The dialog closes itself on Esc.
        if ((e.target as Element).closest?.("[role=dialog][aria-modal=true]")) return;
        // Esc anywhere in the tab, the text included, ends "Add relationship to...".
        if (e.key === "Escape" && rel.linking !== null) rel.endModes(true);
        // Esc stops the assistant's Ask from the Assistant pane only (F20, as VS Code's chat): elsewhere it closes
        // the local thing, such as a completion list or the canvas selection. Ctrl+Enter lands the changes waiting.
        if (e.key === "Escape" && ai.working && (e.target as Element).closest?.("[data-side-pane='assistant']")) {
          e.preventDefault();
          ai.stop();
          return;
        }
        // F29: Ctrl+Shift+E publishes the drawing as an image (draw.io, Figma and Excalidraw's export key).
        if (e.key.toLowerCase() === "e" && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && !e.defaultPrevented) {
          e.preventDefault();
          if (publishableRef.current) void openPublish();
          return;
        }
        // Ctrl+Enter lands the changes waiting and Ctrl+Backspace drops them, on an event no canvas key took and
        // not while typing; the review bar handles its own.
        const review = ai.waiting?.step === "review" ? reviewKeys(e, { inBar: false, typing: typingIn(e.target) }) : null;
        if (review) {
          e.preventDefault();
          if (review === "accept") ai.acceptAll();
          else ai.rejectAll();
          return;
        }
        // Ctrl+J opens the Assistant on the selected frame, as Ask does.
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
          e.preventDefault();
          openAsk();
          return;
        }
        // As the Schema Builder's Hide DBML: Ctrl+B hides the side panel and brings it back.
        if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
          e.preventDefault();
          setSide({ hidden: !side.hidden });
        }
      }}
    >
      <span className="visually-hidden" aria-live="polite" data-review-said="">
        {reviewSaid}
      </span>
      <SidePanel
        tab={side.tab}
        hidden={side.hidden}
        pending={ai.pending}
        locked={ai.locked}
        working={ai.working !== null}
        rail={false}
        onTab={(tab) => setSide({ tab })}
        onHide={() => setSide({ hidden: true })}
        onShow={(tab) => setSide(tab ? { hidden: false, tab } : { hidden: false })}
        editor={
          <CodePaneHead
            kind={paneKind}
            onHelp={paneKind ? () => setHelpKind(paneKind) : undefined}
            disabled={ai.locked}
            save={doc.save}
            lineBefore={() => {
              const v = doc.view();
              if (!v) return "";
              const head = v.state.selection.main.head;
              const line = v.state.doc.lineAt(head);
              return line.text.slice(0, head - line.from);
            }}
            onChip={(text) => {
              const v = doc.view();
              if (!v || v.state.readOnly) return;
              const sel = v.state.selection.main;
              // A group's braces leave you on the empty line inside them (VS Code and draw.io snippets); else after it.
              const open = text.indexOf("{\n");
              const caret = open >= 0 ? text.indexOf("\n", open + 2) : text.length;
              v.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + caret }, userEvent: "input", scrollIntoView: true });
              v.focus();
            }}
          >
          {ai.working && (
            <div className="flow-ebar" role="status">
              <Icon name="lock" size={14} />
              <span className="flow-ebar-text">The assistant is editing. The text is read-only until it finishes.</span>
              <button type="button" className="btn pbtn2" onClick={ai.stop}>
                Stop
              </button>
            </div>
          )}
          <div className={ai.working ? "schema-text is-locked" : "schema-text"}>
            {doc.initialText !== null && (
              <FlowEditor
                initialText={doc.initialText}
                doc={doc}
                client={client}
                bandLines={shownBands}
                ghost={ai.ghost ?? ghost}
                onLineClick={(l) => void onLineClick(l)}
                onHistory={() => {
                  setAiBands([]);
                  const v = doc.view();
                  if (v) ai.historyMoved(v.state.doc.toString());
                }}
                onIconSlot={kind === "cloud" ? openTextPicker : undefined}
                onMermaidPaste={(text, from, to) => pasteMermaid(text, { from, to })}
                frame={frameSel}
                follow={paneFollow}
                onDropped={() => setNotice(HIDDEN_EDIT)}
              />
            )}
          </div>
          {parsed && paneFrame && (
            <Problems
              parsed={parsed}
              problems={paneFrame.problems}
              firstLine={paneFrame.line}
              onFix={(p, j) => {
                if (aiLock.current) return;
                setGhost(null);
                doc.applyFix(p.fixes[j].edits, parsed.text);
              }}
              onHoverFix={(p, j) => setGhost(p ? { edits: p.fixes[j].edits, text: parsed.text } : null)}
              onLine={(line) => {
                const v = doc.view();
                const at = line + paneFrame.line - 1;
                if (!v || at < 1 || at > v.state.doc.lines) return;
                v.dispatch({ selection: { anchor: v.state.doc.line(at).from }, scrollIntoView: true });
                v.focus();
              }}
            />
          )}
          <div className="schema-pane-foot flow-foot">
            {errors.length === 0 ? (
              <span className="schema-problems">
                <Icon name="check" size={14} />
                No problems
              </span>
            ) : (
              <span className="flow-problem-count">{plural(errors.length, "problem")}</span>
            )}
            <span className="spacer" />
            {kind && counted && <span>{countsOf(kind, counted)}</span>}
          </div>
          </CodePaneHead>
        }
        assistant={
          <DiagramAssistant
            ai={ai}
            name={name}
            kind={kind}
            selected={selected}
            sketches={sketchSel}
            frames={assistFrames}
            parts={assistParts}
            onShowPart={onShowPart}
            selectedFrame={assistFrame}
            frameChip={frameChip}
            mode={assistMode}
            onMode={setAssistMode}
            onShowText={(lines) => {
              const show = () => {
                setAiBands(lines);
                setSide({ tab: "editor" });
              };
              // The lines are the Ask's frame's: a landing seen after a switch shows that frame first.
              const target = ai.waiting?.frameIndex ?? ai.landed?.frameIndex;
              const v = doc.view();
              const head = target !== undefined && v ? headsOf(v.state)[target] : undefined;
              if (head && target !== (doc.selection()?.index ?? 0)) void switchFrame({ title: head.title, index: target! }, [], show);
              else show();
            }}
            onUndo={() => {
              const v = doc.view();
              if (v) undo(v);
              setAiBands([]);
            }}
            active={active && side.tab === "assistant" && !side.hidden}
            onOpenSettings={onOpenSettings}
            onTemplate={() => {
              // The board Shelf on its templates side; Esc gives focus back to the Template button.
              templateOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              openShelf("template", "diagrams", "", "right");
            }}
          />
        }
      />

      <section ref={paneEl} className="schema-island flow-pane-draw" aria-label={`${name} drawing`}>
        <div className="schema-pane-head flow-strip">
          {/* While a pick is on the strip is about the pick: its prompt and its aim, with room for both. */}
          {rel.pick ? null : labelBox?.fresh ? (
            <span className="flow-selchip">{`New flow: ${labelBox.from} to ${labelBox.to}`}</span>
          ) : one ? (
            <>
              {/* A weak table's chip is dashed, as its card is. */}
              <span className={kind === "er" && one.kind === "weak" ? "flow-selchip is-weak" : "flow-selchip"}>
                {chipIcon(kind, one) && <Icon name={chipIcon(kind, one)!} size={14} />}
                {one.attrs.id && <span className="flow-selchip-id">{one.attrs.id}</span>}
                {/* A labelled shape: the words it shows, and the name lines use. */}
                <span>{one.attrs.label !== undefined && one.kind !== "note" ? `${said(shownName(one))}, named ${said(one.name)}` : one.name}</span>
              </span>
              <span className="flow-quiet">{selectionWords(kind, one, flowsOf(one.name))}</span>
              {one.kind === "service" && (
                <button ref={chooseIcon} type="button" className="button button-small button-quiet" onClick={() => openPicker(one.name)}>
                  Choose icon
                </button>
              )}
            </>
          ) : groupSel !== null && picked === 0 && groupCount !== null ? (
            <>
              <span className="flow-selchip">
                <Icon name="square" size={14} />
                <span>{`${kind ? (GROUP_WORD[kind] ?? "Group") : "Group"} ${groupSel}`}</span>
              </span>
              <span className="flow-quiet">{`${plural(groupCount, "shape")}. Drag the title to move it with everything in it, double-click it to rename, Delete asks what to keep.`}</span>
            </>
          ) : oneLine && kind ? (
            <>
              <span className="flow-selchip">{`${endName(oneLine.from)} to ${endName(oneLine.to)}`}</span>
              <span className="flow-quiet">{`${oneLine.tree ? "Branch" : LINE_WORD[kind]}${oneLine.label ? `: ${oneLine.label}` : ""}`}</span>
            </>
          ) : (
            <span className="flow-quiet">{picked > 1 ? `${picked} selected` : "Nothing selected"}</span>
          )}
          {/*
            One live region, always mounted, so a screen reader hears each message as it comes: a region inserted
            together with its words is often not read (WebKit). Only what is inside it comes and goes (Task 11 fix
            round 1, as DataGrid's order note).
          */}
          <span className="flow-live" role="status">
            {notice && (
              // A notice cut off by a narrow strip keeps its whole text in its tooltip.
              <span className="flow-notice" title={notice}>
                {notice}
              </span>
            )}
            {pickWords && (
              // Before anything is aimed the strip says how to leave; the prompt keeps to one line at 1024 px (fix
              // round 4). Once aimed, what Enter links to, read out as it moves.
              <span className="flow-quiet flow-aim">{pickWords}</span>
            )}
          </span>
          <span className="spacer" />
          {kind === "cloud" && (
            <button type="button" className="button button-small button-quiet" onClick={() => setCredits(true)}>
              Icon credits
            </button>
          )}
          <button type="button" className="button button-small" disabled={!publishable} title="Publish image (Ctrl+Shift+E)" onClick={() => void openPublish()}>
            <Icon name="image" size={14} />
            Publish
          </button>
        </div>
        <div
          ref={canvasEl}
          className={`flow-canvas${armed === "hand" ? " is-hand" : ""}${spaceHeld ? " is-space-held" : ""}${stale ? " is-stale" : ""}${ai.working ? " is-ai-working" : ""}${kind && FIXED_KINDS.has(kind) ? " is-fixed" : ""}${fade ? ` is-frame-switch is-switch-${fade.n % 2}` : ""}`}
          data-switch-ms={fade ? String(fade.ms) : undefined}
          // The text sizes drawn as soft lines: flow-board.css keys on it with board-ts-*.
          data-far={farKey}
          style={fade ? ({ "--board-switch-ms": `${fade.ms}ms` } as CSSProperties) : undefined}
          onAnimationEnd={(e) => {
            if (fade && e.animationName.startsWith("board-frame-switch")) setFade(null);
          }}
          onClick={onBoardClick}
          onPointerUp={boxPicksPictured}
          tabIndex={-1}
          onKeyDown={onCanvasKey}
          onKeyUp={(e) => {
            if (e.key.startsWith("Arrow")) endNudge();
          }}
          onFocus={() => {
            if (lastByKey.current) setKeyFocus(true);
          }}
          onBlur={(e) => {
            endNudge();
            if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setKeyFocus(false);
          }}
          onCopy={onClipboardCopy}
          onCut={onClipboardCopy}
          onPaste={onClipboardPaste}
          onPointerDownCapture={(e) => {
            if (pressOnLeftFrame(e)) return;
            pressAt.current = { x: e.clientX, y: e.clientY };
            pressedPictured.current = false;
            boxFrom.current =
              armedRef.current === "select" && !space.current && e.button === 0 && e.target instanceof Element && e.target.classList.contains("react-flow__pane") ? { x: e.clientX, y: e.clientY } : null;
            // A press on a pictured sketch picks it and a drag moves it, as on a real one: no box.
            if (boxFrom.current && pressPicturedSketch(e)) {
              boxFrom.current = null;
              e.stopPropagation();
              return;
            }
            erPress.current = erHitOf(e.target);
            erDragged.current = false;
            // A press while Space is held is a pan, never a tap.
            if (space.current) space.current.moved = true;
            // A new press ends a drawing still waiting for its frame; an armed shape or line tool draws.
            afterSwitch.current = null;
            if (startDraw(e)) return;
            // A Section or box sketch inside a frame takes no press: the frame wins (ruling C14).
            if (frameWinsAt(e)) {
              e.stopPropagation();
              return;
            }
            // A static frame's shapes and titles are never the live frame's: no gesture starts there.
            if (e.target instanceof Element && e.target.closest(".board-static")) return;
            startGroupGesture(e);
            if (e.isPropagationStopped()) return;
            pressForMember(e.target);
            startTopicGesture(e);
            startSeqGesture(e);
          }}
          onContextMenuCapture={(e) => {
            // The frame left takes no right-click while another waits for its paint.
            if (pressOnLeftFrame(e)) return;
            // F9: a right-click on a group's title opens the group's own menu, not the canvas's.
            const t = e.target instanceof Element ? e.target : null;
            // Inside a static frame: no menu of the live frame's; the right-click selects that frame.
            if (t?.closest(".board-static")) {
              e.preventDefault();
              e.stopPropagation();
              const f = instance.current;
              const flow = f ? f.screenToFlowPosition({ x: e.clientX, y: e.clientY }) : null;
              const hit = flow ? staticFrameAt(flow) : null;
              if (hit && flow) menuInStaticFrame(hit, { x: e.clientX, y: e.clientY }, flow);
              return;
            }
            const title = t?.closest(".flow-area-name");
            const name = title?.closest(".flow-area")?.getAttribute("aria-label")?.replace(/^Group /, "");
            if (!name || !kind || !GROUP_WORD[kind]) return;
            e.preventDefault();
            e.stopPropagation();
            openGroupMenu(name, { x: e.clientX, y: e.clientY });
          }}
          onDoubleClickCapture={(e) => void pressOnLeftFrame(e)}
          onClickCapture={(e) => {
            if (pressOnLeftFrame(e)) return;
            if (drawClick.current) {
              drawClick.current = false;
              e.stopPropagation();
              return;
            }
            if (swallowClick.current) {
              swallowClick.current = false;
              e.stopPropagation();
              return;
            }
            // An ER line pick takes a click on a card as its pick, the row or header pressed.
            if (erLinePickClick(e)) {
              e.stopPropagation();
              return;
            }
            // A Section or box sketch inside a frame: the frame wins the click (ruling C14), and the sketch is not picked.
            if (frameWinsAt(e)) {
              e.stopPropagation();
              const down = pressAt.current;
              pressAt.current = null;
              const f = instance.current;
              if (f && armedRef.current !== "hand" && !(down && Math.hypot(down.x - e.clientX, down.y - e.clientY) > 3)) {
                setSketchSel([]);
                pickAt(f.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
              }
            }
          }}
          onMouseDownCapture={(e) => {
            if (pressOnLeftFrame(e)) return;
            // No drag of a sketch a frame covers (React Flow drags on mousedown).
            if (frameWinsAt(e)) e.stopPropagation();
          }}
          onPointerMove={(e) => {
            pointer.current = { x: e.clientX, y: e.clientY };
            const down = pressAt.current;
            if (erPress.current && down && Math.hypot(down.x - e.clientX, down.y - e.clientY) > 3) erDragged.current = true;
            const sp = space.current;
            if (sp && !sp.p) sp.p = pointer.current;
            else if (sp?.p && Math.hypot(e.clientX - sp.p.x, e.clientY - sp.p.y) >= SPACE_MOVE_PX) sp.moved = true;
            // The shape under the pointer shows its handles; on a handle it stays, elsewhere they go after a moment.
            const t = e.target instanceof Element ? e.target : null;
            // N3: over a group's title the cursor says it can be renamed by a double-click (draw.io's text cursor).
            const onTitle = !!t?.closest(".react-flow__pane") && !t.closest(".react-flow__node") && !!instance.current && groupTitleAt(toLive(instance.current.screenToFlowPosition({ x: e.clientX, y: e.clientY }))) !== null;
            if (canvasEl.current && canvasEl.current.classList.contains("is-on-group-title") !== onTitle) canvasEl.current.classList.toggle("is-on-group-title", onTitle);
            if (t?.closest(".flow-hot")) hot.keep();
            else {
              const id = t?.closest(".react-flow__node")?.getAttribute("data-id");
              if (id && !isArea(id) && !isSketchNodeId(id)) hot.set(id);
              else hot.leave();
            }
          }}
          onPointerLeave={() => {
            pointer.current = null;
            hot.leave();
          }}
        >
          <SketchEditContext.Provider value={ai.locked ? null : sketchEdit}>
          <FlowResizeContext.Provider value={resize}>
          <FlowFitContext.Provider value={ai.locked ? null : doc.unsize}>
          <LineEndsContext.Provider value={ai.locked ? null : reattach}>
          <KindEditContext.Provider value={kindEditCtx}>
          {/* Around the whole canvas: each card reads it only when it is the live frame's (decision 5). */}
          <ErCanvasContext.Provider value={kind === "er" ? erValue : null}>
          <ErScrollContext.Provider value={erScroll}>
          <ErSoleContext.Provider value={erSole}>
          <FlowGroupSelContext.Provider value={groupSel}>
          <BoardFarContext.Provider value={far}>
          <DiagramCanvas
            fitRef={canvasFit}
            nodes={canvasNodes}
            edges={canvasEdges}
            nodeTypes={BOARD_NODE_TYPES}
            edgeTypes={FLOW_EDGE_TYPES}
            // The board: fixed z bands, one origin for the whole board, real
            // shapes at every zoom and count, and the overview only while the board has one frame.
            zIndexMode="manual"
            // Only a drag from the Shelf rings and drops (R11, controller question 3).
            onDropObject={dropShelf}
            dropType={SHELF_DRAG_TYPE}
            detailPolicy="board"
            showMiniMap={frameCount < 2}
            mapSlot={
              frameCount > 1 && board ? <BoardMap boxes={board.boxes} live={board.live?.index ?? null} glide={(to) => canvasHandle.current?.glideView(to) ?? Promise.resolve()} cancelGlide={() => canvasHandle.current?.cancelGlide()} /> : undefined
            }
            onFrameDrag={onFrameDrag}
            connectionMode="loose"
            // A timeline has no lines between items: its order is the dates.
            onConnectPorts={kind === "timeline" ? undefined : (from, to, _shift, at) => void connect(from, to, at && toLive(at))}
            onConnectRelease={kind === "timeline" ? undefined : onConnectRelease}
            onDragCancel={onDragCancel}
            connectionLineComponent={connectionLine}
            ownerNudges
            onArrowKey={onCanvasKey}
            onMoveCancel={() => {
              drag.current = null;
              overlay.set({ hot: null });
            }}
            readOnly={ai.locked}
            onDrag={onDrag}
            onMove={onMove}
            onSelect={onSelect}
            selection={canvasSelection}
            lineSelection={lines}
            onLineSelect={(ids) => {
              keepLine.current = null;
              setLines(ids);
            }}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onContextMenu={openMenu}
            // F3: a double-click edits on the shape what is under the pointer (board DiagramEditInPlace): a label, a
            // class member's row or a new row in the card's empty space (CL1), an item's date (T1), a group's title.
            onNodeDoubleClick={(n, target) => editAt(n, target ?? null)}
            // A double-click on the empty canvas offers the kind's shapes there.
            onPaneDoubleClick={kind && quickItems(kind).length > 0 ? paneDoubleClick : undefined}
            minimapJump
            boxSelect
            // The Hand tool pans with the left button; holding Space pans with any.
            hand={armed === "hand"}
            panKey="Space"
            livePositions={livePositions}
            // The first shape the assistant just added comes into view, so its ring is seen.
            reveal={firstOf(landedNames)}
            onInit={(i) => {
              instance.current = i;
            }}
            onCanvasReady={(h) => {
              canvasHandle.current = h;
            }}
            smoothWheel
            onViewChange={(v, _landing, pointer) => {
              viewRef.current = v;
              pointerRef.current = pointer ?? null;
              replan();
              letGoPointerWhenSettled();
            }}
            overlay={
              <CanvasOverlay
                store={overlay}
                // The live frame's overlay hangs from its place on the board; the sketches' are the board's.
                at={liveAtRef.current}
                board={
                  <>
                    <SketchDraw ref={sketchDraw} {...sketchDrawProps} />
                    {sketchFieldAt && sketchField && (
                      <SketchField
                        key={sketchField.mode === "edit" ? `edit:${sketchField.id}` : `new:${sketchField.at.x},${sketchField.at.y}`}
                        kind={sketchField.kind}
                        value={sketchFieldAt.value}
                        at={sketchFieldAt.at}
                        width={sketchFieldAt.width}
                        fresh={sketchField.mode === "new"}
                        onCommit={(v) => commitSketchField(v)}
                        onCancel={() => {
                          setSketchField(null);
                          canvasEl.current?.focus({ preventScroll: true });
                        }}
                      />
                    )}
                  </>
                }
              >
                {lineDraw && (
                  <svg className="flow-overlay-svg" width="1" height="1" aria-hidden="true">
                    <g className={lineDraw.ring ? "flow-drawing is-locked" : "flow-drawing"}>
                      <path className="flow-drawing-line" d={lineDraw.d} fill="none" />
                      {lineDraw.ring && <rect className="flow-lock-ring" x={lineDraw.ring.x - 3} y={lineDraw.ring.y - 3} width={lineDraw.ring.w + 6} height={lineDraw.ring.h + 6} rx={10} />}
                    </g>
                  </svg>
                )}
                <OrderDragLayer store={orderDrag} topicBox={(ref) => {
                  const ix = topicDrag.current;
                  return ix && ref >= 0 && ref < ix.n ? { x: ix.box[ref * 4], y: ix.box[ref * 4 + 1], w: ix.box[ref * 4 + 2], h: ix.box[ref * 4 + 3] } : null;
                }} />
                {slotGuide && <div className="flow-slot-guide" aria-hidden="true" style={{ left: `${slotGuide.x1 - 16}px`, top: `${slotGuide.y}px`, width: `${slotGuide.x2 - slotGuide.x1 + 32}px` }} />}
                {loopSel &&
                  (() => {
                    const n = graph.nodes.find((g) => g.id === `\u0000frame:${loopSel.index}`);
                    const b = n ? boxOfNode(n) : null;
                    return b ? <div className="flow-loop-selected" aria-hidden="true" style={{ left: `${b.x - 3}px`, top: `${b.y - 3}px`, width: `${b.w + 6}px`, height: `${b.h + 6}px` }} /> : null;
                  })()}
                {kind === "mindmap" && foldDots.length > 0 && (
                  <span className="flow-hot flow-fold-dots">
                    <FoldDots dots={foldDots} hot={hot} selected={selected} onToggle={(n) => {
                      toggleFold(n);
                      canvasEl.current?.focus();
                    }} />
                  </span>
                )}
                {field && fieldAt && (
                  <>
                    {field.kind === "newgroup" && (
                      // the new group drawn around its shapes before its name is kept.
                      <div className="flow-group-new" aria-hidden="true" style={{ left: `${fieldAt.box.x}px`, top: `${fieldAt.box.y}px`, width: `${fieldAt.box.w}px`, height: `${fieldAt.box.h}px` }} />
                    )}
                    {field.kind === "new" && !graph.nodes.some((g) => g.id === GHOST_ID) && (
                      // the new shape as a ghost, and its line from the source, until its name is kept.
                      <>
                        {/* A topic's ghost whose anchor left the text stays where it was drawn (round 2, N1). */}
                        <div className="flow-ghost" aria-hidden="true" style={{ left: `${fieldAt.box.x}px`, top: `${fieldAt.box.y}px`, width: `${fieldAt.box.w}px`, height: `${fieldAt.box.h}px` }} />
                        {(ghostLine || field.guide) && (
                          <svg className="flow-overlay-svg" width="1" height="1" aria-hidden="true">
                            {field.guide && <line className="flow-ghost-guide" x1={field.guide.x1} y1={field.guide.y1} x2={field.guide.x2} y2={field.guide.y2} />}
                            {ghostLine && <path className="flow-pending" d={ghostLine} />}
                          </svg>
                        )}
                      </>
                    )}
                    <InlineEdit
                      key={`${field.kind}:${field.open ?? 0}`}
                      value={fieldAt.value}
                      label={fieldLabel(field, fieldAt.note)}
                      onInput={field.kind === "new" && kind === "mindmap" ? growGhost : undefined}
                      wrapClassName={field.kind === "label" || field.kind === "new" ? "flow-rename-inline" : "flow-rename-inline flow-group-title-edit"}
                      style={{ left: `${fieldAt.x}px`, top: `${fieldAt.y}px`, width: `${fieldAt.w}px` }}
                      multiline={(field.kind === "label" || field.kind === "new") && (fieldAt.note || (!!kind && MULTI_LINE.has(kind)))}
                      oneLine={kind ? oneLineHint(kind) : undefined}
                      fresh={field.kind !== "label" && field.kind !== "group" && field.kind !== "loop"}
                      error={field.error ?? null}
                      errorKey={field.tries}
                      onCommit={(v, how) =>
                        // A frame switch waits for this commit, so it lands in its own frame.
                        trackCommit(
                          field.kind === "label"
                            ? rename(field, v, how)
                            : field.kind === "new"
                              ? commitNew(field, v, how)
                              : field.kind === "newloop" || field.kind === "newsection" || field.kind === "loop"
                                ? commitFrame(field, v, how)
                                : commitGroup(field, v, how),
                        )
                      }
                      onCancel={() => {
                        // A new item dropped takes what the strip said about it (its date) with it (N4).
                        if (field.kind === "new" && ghostNotice.current !== null && notice === ghostNotice.current) setNotice(null);
                        ghostNotice.current = null;
                        setField(null);
                        canvasEl.current?.focus();
                      }}
                    />
                  </>
                )}
                {kind && (
                  <HotHandles
                    store={hot}
                    selected={selected.length === 1 && lines.length === 0 ? selected[0] : null}
                    boxOf={hotBox}
                    hasMembers={(n) => !ai.locked && kind === "class" && (kindEdit === null || kindEdit.kind === "picked") && !!drawnRef.current?.nodes.some((x) => x.name === n && (x.kind === "class" || x.kind === "interface" || x.kind === "enum"))}
                    onAddMember={(n) => openMember(n, null)}
                    sides={plusSides}
                  />
                )}
                {newTable && (
                  <div
                    className={`fnode fnode-kind fnode-${newTable.kind === "weak" ? "erWeak" : "erTable"} fnode-${look} fnode-selected fkind-new-table${labelScale(textScale).cls}`}
                    role="group"
                    aria-label="New table"
                    style={{ ...kindStyle(newTable.kind === "weak" ? "erWeak" : "erTable"), ...labelScale(textScale).style, left: `${newTable.at.x}px`, top: `${newTable.at.y}px`, width: `${Math.round(184 * textScale)}px`, height: `${erCardH(1, textScale)}px` }}
                  >
                    <span className="fkind-inside">
                      <span className="fkind-head">
                        <Icon name={newTable.kind === "weak" ? "layers" : "table"} size={14} />
                        <InlineEdit
                          key="new-table"
                          value={newTable.name}
                          label="Table name"
                          fresh
                          className="fkind-ed fkind-ed-head"
                          error={newTable.error ?? null}
                          errorKey={newTable.tries}
                          // A frame switch waits for this commit, so it lands in its own frame (R4).
                          onCommit={(v, how) => trackCommit(commitNewTable(newTable, v, how))}
                          onCancel={() => {
                            setNewTable(null);
                            canvasEl.current?.focus({ preventScroll: true });
                          }}
                        />
                      </span>
                      <div className="fkind-er-body">
                        <ul className="fkind-rows fkind-er-rows">
                          {/* A picture of the row to come: a screen reader hears the field's name only (Minor 5). */}
                          <li className="fkind-row fkind-er-row is-new" style={{ height: KIND_ROW * textScale }} aria-hidden="true">
                            <span className="fkind-gut" aria-hidden="true" />
                            <span className="fkind-col fkind-placeholder">column_name</span>
                            <span className="fkind-type fkind-placeholder">type</span>
                            <span className="fkind-nn" aria-hidden="true" />
                          </li>
                        </ul>
                      </div>
                    </span>
                  </div>
                )}
                {labelBox && labelAt && (
                  // A line's label on the line, a message's on its own row (S3), with the in-place editor's rules.
                  <InlineEdit
                    key={`${labelBox.version}:${labelBox.index}`}
                    value={labelBox.initial}
                    label={kind === "sequence" ? "Message label" : labelBox.link ? "Relationship label" : "Flow label"}
                    placeholder={labelBox.fresh ? "Type a label, Enter to keep" : "label"}
                    wrapClassName="flow-rename-inline flow-label-inline"
                    style={{ left: `${labelAt.x - 85}px`, top: `${labelAt.y}px`, width: "170px" }}
                    fresh={labelBox.fresh}
                    error={labelBox.link ? (labelError?.text ?? null) : null}
                    errorKey={labelError?.key}
                    onCommit={(v, how) => trackCommit(finishLabel(labelBox, v, how))}
                    onCancel={() => {
                      setLabelBox(null);
                      setLabelError(null);
                      canvasEl.current?.focus();
                    }}
                  />
                )}
              </CanvasOverlay>
            }
          >
            <div
              ref={(el) => {
                toolbarSlot.current = el;
                addButton.current = el?.querySelector<HTMLElement>('[data-tool="add"]') ?? null;
              }}
              className="board-toolbar-slot"
            >
              <BoardToolbar
                kind={kind}
                armed={armed}
                pending={reviewSum ?? ai.pending}
                onArm={(id, pointer) => {
                  // The Note button in a frame with notes adds that diagram's note, as N does there.
                  if (id === NOTE_TOOL_ID && kind && NOTE_KINDS.has(kind) && !aiLock.current) addShape("note");
                  else arm(id);
                  // A click hands the keys back to the canvas (Figma); a key press on the toolbar stays on it (WAI-ARIA).
                  if (pointer) canvasEl.current?.focus({ preventScroll: true });
                }}
                // Add again closes the Shelf (Figma's insert, draw.io).
                // From More shapes, Add switches the Shelf to Diagrams (Figma's insert panel).
                onAdd={() => (shelf && shelf.from !== "more" ? closeShelf("toggle") : openShelf("add"))}
                onAsk={openAsk}
                onMoreShapes={() => (shelf?.from === "more" ? closeShelf("toggle") : openShelf("more", "shapes"))}
                addOpen={shelf !== null && shelf.from !== "more"}
                moreOpen={shelf?.from === "more"}
                shelfId={shelf ? shelfId : undefined}
              />
            </div>
            {/* After the board toolbar, so it is the next tab stop while it shows; hidden while the remove question is open. */}
            {ai.waiting?.step === "review" && reviewed?.rect && reviewed.sum > 0 && (
              <ReviewBarOnCanvas
                key={ai.waiting.messageAt}
                rect={reviewed.rect}
                titles={reviewed.titles}
                count={reviewed.sum}
                label={acceptLabel(ai.waiting.proposal.changes, ai.waiting.rejected)}
                onAccept={fromBar(ai.acceptAll)}
                onReject={fromBar(ai.rejectAll)}
              />
            )}
            {ai.working && (
              <div className="flow-aipres" role="status">
                <span className="live" aria-hidden="true" />
                {`AI is editing ${drawn?.title || name}`}
              </div>
            )}
            {spaceBox && <ViewMoved key={`${spaceBox.screen.x},${spaceBox.screen.y}`} onMoved={() => closeSpaceBox("view")} />}
            {paneFrame && paneFrame.outside.length > 0 && (
              <div className="flow-board-banner" role="status">
                <Icon name="alert" size={14} />
                {paneFrame.outside[0].message}
              </div>
            )}
            {stale && parsed?.errorLine != null && (
              <div className="flow-stale" role="status">
                <Icon name="alert" size={14} />
                {staleBanner(parsed.errorLine - (parsed.frame?.line ?? 1) + 1)}
              </div>
            )}
            {kind && parsed?.result.doc && parsed.result.doc.nodes.length === 0 && !newItemOpen && !newTable && tools[0] && (
              <button type="button" className="flow-first-node" onClick={() => void add(tools[0])}>
                <span className="flow-first-node-tile">
                  <Icon name="plus" />
                </span>
                <span className="flow-first-node-text">
                  <strong>Add the first node</strong>
                  <small>{firstNodeHint(kind)}</small>
                </span>
              </button>
            )}
            {kind && parsed?.result.doc && parsed.result.doc.nodes.length === 0 && !newItemOpen && (
              <p className="flow-first-node-line">
                Or type <code>{FIRST_LINE[kind]}</code> on line {firstFreeLine(parsed.frame ? parsed.text.slice(parsed.frame.from, parsed.frame.to) : parsed.text)}
              </p>
            )}
          </DiagramCanvas>
          </BoardFarContext.Provider>
          </FlowGroupSelContext.Provider>
          </ErSoleContext.Provider>
          </ErScrollContext.Provider>
          </ErCanvasContext.Provider>
          </KindEditContext.Provider>
          </LineEndsContext.Provider>
          </FlowFitContext.Provider>
          </FlowResizeContext.Provider>
          </SketchEditContext.Provider>
          {drawBox && <div className="board-draw-outline" aria-hidden="true" style={{ left: `${drawBox.left}px`, top: `${drawBox.top}px`, width: `${drawBox.width}px`, height: `${drawBox.height}px` }} />}
          {kind === "er" && (
            <datalist id={erTypesId}>
              {erTypes.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          )}
          <div className="board-bottom">
            <CanvasToast note={note} />
            {onlySketches && (
              <SketchBar
                color={sketchColour()}
                disabled={ai.locked}
                onColour={(color) => sketchOp(setSketchColour(sketchList.current, sketchSelRef.current, color))}
                onLeave={() => canvasEl.current?.focus({ preventScroll: true })}
              />
            )}
            {liveBox && kind && soleLine && sketchSel.length === 0 && (
              <LineBar
                kind={kind}
                link={soleLine.link}
                disabled={ai.locked}
                onColour={(color) => {
                  if ((soleLine.link.color ?? null) === color) return setNotice(`The line is ${color ? COLOUR_INFO[color].label : "uncoloured"} already.`);
                  editLine(soleLine.ref, { op: "setLinkColor", color }, linesRef.current[0] ?? null);
                }}
                onArrow={(arrow) => {
                  editLine(soleLine.ref, { op: "setLinkArrow", arrow }, linesRef.current[0] ?? null);
                }}
                onLeave={() => canvasEl.current?.focus({ preventScroll: true })}
              />
            )}
            {liveBox && kind && !(soleLine && sketchSel.length === 0) && !onlySketches && (
              <FrameBar
                frame={{ title: liveBox.title, kind: liveBox.kind, index: liveBox.index }}
                layout={{ direction: layout.direction, style: layout.style, notation, textSize }}
                selectedShapes={selected.length}
                frames={frameCount}
                numbering={numberingFromBar(kind, liveBox.title)}
                onNumbering={(on) => void doc.run({ op: "setNumbering", on })}
                onReset={() => void tidy("frame")}
                onRename={renameFromBar}
                onSetting={settingFromBar}
                onColour={() => colourRow(selectedRef.current, [])}
                onMore={() =>
                  frameMoreItems({
                    drawn: liveDrawable,
                    publishable,
                    movable: !FIXED_KINDS.has(kind),
                    selected: selected.length,
                    deletable: frameCount > 1,
                    publish: () => void openPublish("frame"),
                    publishBoard: () => void openPublish("board"),
                    ...(onMermaid ? { mermaid: () => onMermaid({ kind, file: name, run: insertMermaid }) } : {}),
                    tidySelection: () => void tidy("selection"),
                    duplicate: () => void duplicateFrame(),
                    ...(kind === "er" && onOpenModel ? { openAsDbml: openDbml } : {}),
                    remove: () => void deleteFrame(),
                  })
                }
                onLeave={() => canvasEl.current?.focus({ preventScroll: true })}
              />
            )}
          </div>
          {groupAsk !== null && askAt && (
            <GroupAsk key={groupAsk} title={`Delete ${groupWord().toLowerCase()} ${groupAsk}?`} counts={askAt.counts} at={askAt.at} onAnswer={answerAsk} />
          )}
          {shelf && (
            // A layer the canvas's size, so the Shelf's height can leave the zoom control clear (flow-shelf.css).
            <div className="flow-shelf-layer">
              <Shelf
                key={`${shelf.from}:${shelf.tab}:${shelf.side ?? "left"}`}
                id={shelfId}
                host="board"
                frameKind={shelfDrag !== undefined ? shelfDrag : (kind ?? null)}
                initialTab={shelf.tab}
                initialSide={shelf.side}
                initialQuery={shelf.query}
                onAdd={(item, at) => void addFromShelf(item, at)}
                // While a drag runs, its Shapes list holds still (a drop may select another frame).
                onDragStart={() => setShelfDrag(kind ?? null)}
                onDragEnd={() => setShelfDrag(undefined)}
                onClose={closeShelf}
                disabled={shelfDisabled}
              />
            </div>
          )}
          {spaceBox && (
            <SpaceBox
              key={`${spaceBox.screen.x},${spaceBox.screen.y}`}
              at={spaceBox.local}
              bounds={spaceBox.bounds}
              icons={shelfIconSource}
              onPick={(item) => void addFromShelf(item, spaceBox.at)}
              onShelf={(query) => openShelf("slash", "diagrams", query)}
              onClose={closeSpaceBox}
            />
          )}
          {quick && kind && <QuickAdd kind={kind} at={quick.screen} onPick={(t) => void addAndConnect(t)} onCancel={cancelQuick} />}
          {paneAdd && kind && !quick && (
            // "Add here", the kind's shapes at the double-click (draw.io); the pick lands there, its name ready.
            <AddHere
              kind={kind}
              at={paneAdd.screen}
              inside={canvasEl.current?.getBoundingClientRect()}
              disabled={shapeDisabled}
              onPick={(sh) => {
                const at = paneAdd.flow;
                setPaneAdd(null);
                runShape(sh, at);
              }}
              onCancel={() => {
                setPaneAdd(null);
                canvasEl.current?.focus();
              }}
            />
          )}
        </div>
      </section>
      {picker &&
        createPortal(
          <IconPicker
            key={"node" in picker.target ? `node:${picker.target.node}` : `text:${picker.target.pos}`}
            initial={picker.initial}
            style={{ left: picker.at.left, top: picker.at.top }}
            onPick={(icon) => void pickIcon(icon)}
            onCancel={closePicker}
          />,
          document.body,
        )}
      {credits && <IconCredits onClose={() => setCredits(false)} />}
      {helpKind && <SyntaxHelp kind={helpKind} onClose={() => setHelpKind(null)} />}
      {menu && (
        <PlacedMenu
          menu={menu}
          onClose={() => {
            setMenu(null);
            // A menu opened from the keyboard gives focus back to the canvas (Shift+F10).
            if (menuFromKeys.current) canvasEl.current?.focus();
            menuFromKeys.current = false;
          }}
        />
      )}
      {editingNode && kind && drawn?.nodes.some((n) => n.name === editingNode.name) &&
        createPortal(
          <NodeEditor
            key={editingNode.name}
            diagram={kind}
            node={drawn.nodes.find((n) => n.name === editingNode.name)!}
            at={editingNode.at}
            problem={editingNode.problem}
            // Tracked: a frame switch (a press outside saves it) waits for the save, so it lands in its own frame.
            onSave={(e) => trackCommit(saveNodeEdit(e))}
            onCancel={() => setEditingNode(null)}
          />,
          document.body,
        )}
      {publishing &&
        ("source" in publishing ? (
          <PublishDialog
            source={publishing.source}
            fileName={name}
            onClose={() => setPublishing(null)}
            onSaved={() => setPublishing(null)}
            onTheme={(t) => void repaintPublishIcons(t)}
          />
        ) : (
          <PublishDialog
            scene={publishing.scene}
            fileName={name}
            selected={selected}
            onScreen={publishing.onScreen}
            onClose={() => setPublishing(null)}
            onSaved={() => setPublishing(null)}
            onTheme={(t) => void repaintPublishIcons(t)}
          />
        ))}
    </div>
  );
}
