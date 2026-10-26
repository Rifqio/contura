// The diagram tab (spec 6+ section 3, frames 6+.2 to 6+.5): the .flow text on the left (420 px) and the drawing
// on the right. Selecting a node bands its line; clicking a line selects its node. Adds, connects, renames and
// deletes on the canvas rewrite the text through the worker's edits; moves, the look and the direction write
// only the layout file. One undo history covers both. Closing the tab frees the worker's state for it.
// Editing motion (spec section 4): drags show their landing cell and guides and settle on release, drawn flows
// lock onto nodes and take a label or "Add and connect", groups take a dropped node, Tidy and undo glide.
import { defaultKeymap, historyKeymap, indentWithTab, isolateHistory, redo, undo } from "@codemirror/commands";
import { type Diagnostic as CmDiagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, lineNumbers, WidgetType } from "@codemirror/view";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import { type ClipboardEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon, { type IconName } from "../components/Icon";
import DiagramCanvas, { type CanvasMenuAt } from "../diagram/DiagramCanvas";
import { PlacedMenu, type PlacedMenuState } from "./DiagramMenu";
import { type AlignHow, type ColourMenu, groupMenuItems, lineMenuItems, messageMenuItems, paneMenuItems, selectionMenuItems, shapeMenuItems } from "./canvasMenus";
import { labelNotice, planWords, takesLabel } from "./labels";
import { COLOUR_INFO, type DrawnColour, drawnColour, type PaletteName } from "./palette";
import { useFlowAssistMode, useFlowSidePanel } from "../prefs/usePrefs";
import SidePanel from "./SidePanel";
import DiagramAssistant from "./ai/DiagramAssistant";
import { useDiagramAsk } from "./ai/useDiagramAsk";
import { acceptLabel } from "./ai/ProposalCard";
import NodeEditor, { type NodeEdit, nodeEditOps } from "./NodeEditor";
import PublishDialog from "../diagram/export/PublishDialog";
import type { ExportTheme } from "../diagram/export/palette";
import type { Box as SceneBox, Scene } from "../diagram/export/scene";
import { type MotionKey, motionMs } from "../diagram/motion";
import { routeOrthogonal } from "../diagram/route";
import type { Port } from "../diagram/types";
import type { Positions } from "../diagram/layout";
import CanvasToast from "./interactions/CanvasToast";
import { makeConnectionLine } from "./interactions/ConnectionLine";
import { type Box, groupAt, linkBox, magnetTarget, type Point } from "./interactions/geometry";
import InlineEdit, { type CommitHow } from "./interactions/InlineEdit";
import HotHandles, { createHotStore } from "./interactions/HotHandles";
import AddHere from "./interactions/AddHere";
import { DIRS, freeSpotNear, layoutGap, placeNext, type Side } from "./addNext";
import type { Shape } from "./ShapePicker";
import { createKindEditStore, DATE_MESSAGES, type KindEdit, KindEditContext, MEMBER_MESSAGES } from "./kindEdit";
import { COLOUR_WHY, EDIT_MESSAGES, GROUP_WORD, groupNeedsName, MARKER_NOTE, MULTI_LINE, NO_COLOUR, NO_GROUPS, needsName, nounOf, oneLineHint, said, takenName } from "./editWords";
import { openAsDbml } from "./erToDbml";
import { CanvasOverlay, createOverlayStore } from "./interactions/overlay";
import QuickAdd, { quickItems } from "./interactions/QuickAdd";
import { glideFrames } from "./interactions/glide";
import { afterPaint, easeExit, tween } from "./interactions/tween";
import type { LivePositions } from "../diagram/livePositions";
import type { NodeState } from "./nodes/parts";
import type { TextEdit } from "../lang/protocol";
import { ER_NOTES, type FlowEditOp, LINK_NOTES, type LinkRef, linkRefOf } from "../lang/flow/edits";
import { LOOP_CUT } from "../lang/flow/orderEdits";
import { copyLines, nonEmptyLines, TOO_MANY_LINES } from "../lang/flow/clip";
import { isoToday, MAX_FLOW_NODES, overTextLimit, quote, sqlFreeName } from "../lang/flow/model";
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
import { buildFlowGraph, drawnKind, FLOW_EDGE_TYPES, FLOW_NODE_TYPES, type FlowEdgeData, FlowFitContext, FlowGroupSelContext, FlowResizeContext, GHOST_ID, groupBoxes, layoutInput, LineEndsContext, nodeSize } from "./flowNodes";
import { frameWord, mindTreeOf, seqGeometryOf, subtreeOf } from "./orderGestures";
import { groupDragEnd, groupDragFrame, groupDropAt, startGroupDrag } from "./groupDrag";
import { deletedWords, GroupAsk, groupContents } from "./groupGestures";
import { ER_REFUSED, headOf, isMermaid, kindWord, MERMAID_KINDS } from "./mermaidHead";
import { insertFlow, KIND_SHORT } from "../lang/flow/insert";
import { article } from "../format/article";
import { pasteFrame } from "../lang/flow/board";
import { parseFlow } from "../lang/flow/parse";
import { createOrderDragStore, drawAt, DROP, type FoldDot, foldDotsOf, laneIndex, nearestIndex, topicDropAt, type TopicDrop, type TopicIndex, topicIndex } from "./orderDrag";
import OrderDragLayer, { FoldDots } from "./interactions/OrderDragLayer";
import { SEQ_HEAD, SEQ_ROW } from "./kindLayout";
import FlowToolbar, { ADD_TOOLS, type AddTool, firstNodeHint } from "./FlowToolbar";
import { axisEnds, axisKey, emptyPositions, type FlowDirection } from "./layout";
import { kindOfText, type Parsed, useFlowDoc } from "./useFlowDoc";
import IconCredits from "./IconCredits";
import IconPicker from "./IconPicker";
import { sendIconNames } from "./icons";
import { flowScene, loadSceneIcons, sceneIconNames } from "./flowScene";

const KIND_TITLE: Record<DiagramKind, string> = {
  dfd: "Data flow",
  flow: "Flowchart",
  cloud: "Cloud",
  er: "Entity relationship",
  sequence: "Sequence",
  state: "State",
  class: "Class",
  mindmap: "Mind map",
  timeline: "Timeline",
};

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
 * The strip's words for one selected shape: an ER table in ER words (table, columns, relationships; A2), any other
 * shape as its kind and its lines.
 */
function selectionWords(kind: DiagramKind | null, node: FlowNode, lines: number): string {
  if (kind === "er" && (node.kind === "entity" || node.kind === "weak")) {
    return `${node.kind === "weak" ? "Weak table" : "Table"}, ${plural(node.rows?.length ?? 0, "column")}, ${plural(lines, "relationship")}`;
  }
  return `${NODE_WORD[node.kind]}, ${plural(lines, kind === "dfd" ? "flow" : "line")}`;
}

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
  if (kind === "er" && (node.kind === "entity" || node.kind === "weak")) return "table";
  return NODE_ICON[node.kind];
}

/** A set without `item` (a new set, for state). */
const without = <T,>(set: ReadonlySet<T>, item: T): ReadonlySet<T> => {
  const next = new Set(set);
  next.delete(item);
  return next;
};

/** The first item of a set, or null when it is empty. */
const firstOf = (set: ReadonlySet<string>): string | null => set.values().next().value ?? null;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "5 nodes, 5 flows" (frame 6+.2), "6 shapes, 7 lines" (6+.4), "9 services" (6+.5). */
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

/** Why Delete leaves a mind map branch (M3). */
const BRANCH_NOTE = "A branch comes from its topic's indent: move or delete the topic instead.";

/** A grid cell of a block of pasted shapes that had no place (text from outside): 13 by 7 steps of the 16 px grid. */
const PASTE_CELL = { w: 208, h: 112 };

/** How far a duplicate or a second paste lands from the shapes it copies: one grid step (draw.io's grid size). */
const PASTE_STEP = 16;

/**
 * The last copy on any diagram (one clipboard, as in draw.io): its .flow text, where its shapes were drawn and on
 * which diagram, and how many times it has been pasted there. Only this one text is kept; a new copy replaces it.
 */
let lastClip: { text: string; diagram: string; at: Positions; pastes: number } | null = null;

/** The text of a typing field, where the clipboard keys are the field's own. */
const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

const isArea = (id: string) => id.startsWith("\u0000");
const boxOfNode = (n: Node): Box => ({ x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 });
/** Where lines meet the node: its box, or a cloud service's 48 px tile. */
const lineBoxOf = (n: Node): Box => linkBox(n.type, boxOfNode(n));

const centre = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const NO_STATES: ReadonlyMap<string, NodeState> = new Map();
/** A flow let go this close to its own node was a click on a port, not a drawn flow. */
const RELEASE_ON_SELF_PX = 12;

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
  /** Step 6: a new shape drawn as a ghost with its name ready, written only when the name is kept. */
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
      /** Step 7: a mind map topic beside this one (Shift+Tab), after its branch. */
      after?: string;
      /** A + add: the axis its line keeps, and the guide drawn while the ghost lines up with its source. */
      axis?: "v" | "h";
      guide?: { x1: number; y1: number; x2: number; y2: number };
    }
  /** A sequence's loop around messages `from` to `to`, and a timeline's section around items. */
  | { kind: "newloop"; from: number; to: number; name: string; at: Point }
  /** Step 8: a loop's label, edited on its tab; the frame is named by its index and the label it had. */
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

/** A hovered fix, shown in grey where it would go (frame 6+.3): its new text, and the text it replaces struck. */
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

/** The plain sentence under "X is not defined." (frame 6+.3), read from the link's line. */
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
  /** Step 10: Mermaid pasted where you are typing, from `from` to `to`; the tab translates it. */
  onMermaidPaste?(text: string, from: number, to: number): void;
}

/** True when the line up to `pos` ends with `icon:` (the colon just typed) inside an open bracket list. */
export function atIconSlot(text: string, pos: number): boolean {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(start, pos);
  return /(?:\[|,)\s*icon:$/.test(before) && before.lastIndexOf("[") > before.lastIndexOf("]");
}

function FlowEditor({ initialText, doc, client, bandLines, ghost, onLineClick, onIconSlot, onHistory, onMermaidPaste }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ onLineClick, onIconSlot, onHistory, onMermaidPaste });
  latest.current = { onLineClick, onIconSlot, onHistory, onMermaidPaste };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
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
            if (u.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"))) latest.current.onHistory?.();
            if (u.selectionSet && !u.docChanged && u.transactions.some((tr) => tr.isUserEvent("select.pointer"))) {
              latest.current.onLineClick(u.state.doc.lineAt(u.state.selection.main.head).number);
            }
            // Typing `icon:` inside brackets opens the icon grid there (frame 6+.5, "after icon:").
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
    return () => {
      doc.attach(null);
      viewRef.current = null;
      view.destroy();
    };
    // The view is made once per open document; later changes are pushed in below.
  }, []);

  // Problems underline the text once their parse is for the text shown.
  const parsed = doc.parsed;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !parsed || parsed.text !== view.state.doc.toString()) return;
    const diagnostics = toCm(parsed.result.problems, view.state.doc.length, (edits) => doc.applyFix(edits, parsed.text));
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [parsed, doc]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const at = bandLines.filter((n) => n >= 1 && n <= view.state.doc.lines).map((n) => view.state.doc.line(n).from);
    view.dispatch({ effects: setBand.of(at) });
  }, [bandLines]);

  // A fix's preview only while its parse is for the text shown, so its offsets are right.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const edits = ghost && ghost.text === view.state.doc.toString() ? ghost.edits : [];
    view.dispatch({ effects: setGhost.of(edits) });
  }, [ghost]);

  return <div ref={host} className="flow-editor" />;
}

function Problems({
  parsed,
  onFix,
  onLine,
  onHoverFix,
}: {
  parsed: Parsed;
  onFix(p: FlowProblem, i: number): void;
  onLine(line: number): void;
  onHoverFix(p: FlowProblem | null, i: number): void;
}) {
  const shown = parsed.result.problems.slice(0, 20);
  if (shown.length === 0) return null;
  return (
    <div className="flow-problems" role="region" aria-label="Problems">
      {shown.map((p, i) => (
        <div key={`${p.line}:${p.from}:${i}`} className={p.severity === "hint" ? "flow-problem is-hint" : "flow-problem"}>
          <div className="flow-problem-head">
            <Icon name={p.severity === "hint" ? "info" : "alert"} size={14} />
            <strong>{p.message}</strong>
            <button type="button" className="flow-line-chip" onClick={() => onLine(p.line)}>
              Line {p.line}
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

interface Props {
  /** The diagram's name: `<name>.flow` in Contura's diagrams folder. */
  name: string;
  /** The language engine; the app's shared one when absent. */
  client?: LangClient;
  /** The tab is on top of the window; false while another tab, such as Settings, is. */
  active?: boolean;
  /** Opens the AI settings at the tools table, from the assistant's tool-off note. */
  onOpenSettings?(): void;
  /** Step 10: the canvas's Mermaid... button opens the Mermaid dialog, with Insert into this diagram. */
  onMermaid?(insert: MermaidInsert): void;
  /** ADR 0030: an old ER diagram's "Open as DBML": the converted DBML, unsaved, in the Schema Builder. */
  onOpenModel?(name: string, dbml: string): void;
}

/** Step 10 (F28): what the Mermaid dialog inserts into: this diagram's kind and file, and the insert itself. */
export interface MermaidInsert {
  kind: DiagramKind;
  file: string;
  /** Writes the converted .flow text in, as one undo step, the new shapes selected; why it was refused, or null. */
  run(flow: string): Promise<string | null>;
}

export default function FlowTab({ name, client: given, active = true, onOpenSettings, onMermaid, onOpenModel }: Props) {
  const client = given ?? appLang().client;
  const doc = useFlowDoc(name, client);
  const [side, setSide] = useFlowSidePanel();
  const [assistMode, setAssistMode] = useFlowAssistMode();
  // The diagram assistant: while its Ask runs or its changes wait, the text is read-only and the canvas takes no edits.
  const ai = useDiagramAsk(name, doc, client, assistMode);
  const aiLock = useRef(false);
  aiLock.current = ai.locked;
  /** Lines "Show in the text" bands for the assistant's changes; a new Ask, a landing, Reject all and undo clear them. */
  const [aiBands, setAiBands] = useState<number[]>([]);
  const aiAsking = ai.working !== null;
  const aiWaits = ai.waiting !== null;
  useEffect(() => setAiBands([]), [aiAsking, aiWaits, ai.landed]);
  const { parsed, layout } = doc;
  const drawn = parsed?.drawn ?? null;
  const kind: DiagramKind | null = parsed?.result.kind ?? drawn?.kind ?? (doc.initialText !== null ? kindOfText(doc.initialText) : null);
  const look = layout.style;
  const stale = !!parsed && parsed.result.doc === null && drawn !== null;
  const staleRef = useRef(stale);
  staleRef.current = stale;

  const [selected, setSelected] = useState<string[]>([]);
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
   * Diagram step 3: the field drawn over a shape (F3), a group's title, or a new group's title (C1). Its error is why
   * the last try was refused; the field stays open with the typed text.
   */
  const [field, setFieldState] = useState<(FieldEdit & { error?: string; tries?: number }) | null>(null);
  const fieldRef = useRef(field);
  const setField = (f: typeof field) => {
    fieldRef.current = f;
    setFieldState(f);
  };
  /** Opens a field afresh: its own number keys it, so a field replacing another of its kind remounts (M1). */
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
  /** The Publish dialog, open on the scene built when it was asked for; closing it lets the scene go. */
  const [publishing, setPublishing] = useState<{ scene: Scene; onScreen: SceneBox } | null>(null);
  const chooseIcon = useRef<HTMLButtonElement>(null);
  const instance = useRef<ReactFlowInstance | null>(null);
  const canvasEl = useRef<HTMLDivElement>(null);
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
   * CL1 (fix round 1, I1): the picked member, drawn picked on its card, which Ctrl+Enter copies and Delete removes.
   * It lives in the card store, so what the keys act on is always what is drawn; any other pick lets it go.
   */
  const pickedMember = () => {
    const k = kindEdits.get();
    return k?.kind === "picked" ? k : null;
  };
  /** Each field opened gets its own number, so a field replacing another of its kind starts afresh (M1). */
  const fieldSeq = useRef(0);
  /** The shape the pointer is over, whose handles show (CL1 "+ member", F17 +). */
  const hot = useMemo(() => createHotStore(), []);
  useEffect(() => () => hot.dispose(), [hot]);
  /**
   * Step 7 (M3): the mind map topics folded. Folding is the view's alone: the text keeps every topic and it is no undo
   * step (XMind). The topics a drag is moving are drawn faded (M4).
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
    if (!parsed?.result.oldEr) setNoticeState((n) => (n === ER_NOTES.oldForm ? null : n));
  }, [parsed]);
  // Motion (spec section 4): positions drawn part of the way through a glide, nodes fading in or out, the
  // drag and draw overlay, the label box, "Add and connect" and the canvas note.
  const overlay = useMemo(() => createOverlayStore(), []);
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
  const [quick, setQuick] = useState<{ from: string; at: Point; screen: Point } | null>(null);
  const quickRef = useRef(quick);
  quickRef.current = quick;
  const [note, setNote] = useState<{ text: string; key: number } | null>(null);
  const drag = useRef<DragInfo | null>(null);
  const deleting = useRef(false);
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
        lastDraw.current = { from: draw.from, to: draw.end };
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
  // this text is parsed again so the unknown-icon problem shows (spec 6+ section 2).
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
    const input = layoutInput(shown, look);
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
  }, [shown, look, layout.nodes, layout.direction, client, doc.place, doc.placeProposed, reviewing]);

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
  // frames go to the canvas as live positions of the moving nodes only (ruling P20).
  // The assistant's marks join the motion states: its review's new and removed shapes, and the shapes it just added.
  const airing = ai.airing;
  const shownStates = useMemo(() => {
    if (!review && airing.size === 0) return states;
    const next = new Map(states);
    for (const n of airing) next.set(n, "airing");
    if (review) {
      for (const n of review.added) next.set(n, "suggested");
      for (const n of review.removed) next.set(n, "removed");
    }
    return next;
  }, [states, review, airing]);
  const marks = useMemo(() => {
    if (!review) return undefined;
    const m = new Map<number, "add" | "del">();
    for (const i of review.addedLinks) m.set(i, "add");
    for (const i of review.removedLinks) m.set(i, "del");
    return m;
  }, [review]);
  // A member being added grows its class by one row, so the new row is not scrolled out of sight.
  const growing = kindEdit?.kind === "draft" ? kindEdit.node : null;
  // Step 7: a new topic's ghost is laid out with the map (its parent, the sibling it follows, its size).
  const ghostParent =
    field?.kind === "new" && field.node === "topic" && shown?.kind === "mindmap"
      ? (field.under ?? (field.after !== undefined ? (shown.links.find((l) => l.tree && l.to === field.after)?.from ?? null) : null))
      : null;
  const ghostAfter = ghostParent !== null && field?.kind === "new" ? field.after : undefined;
  // The ghost is the size of the topic it will be (its level), and grows with the name typed (fix round 1).
  // Laid out at the name it opens with; the typed name widens the ghost alone (growGhost), not the layout (N5).
  const ghostName = field?.kind === "new" ? field.name : "";
  const ghostDepth = ghostParent !== null ? (shown?.nodes.find((n) => n.name === ghostParent)?.depth ?? 0) + 1 : 1;
  const ghostSize = ghostParent !== null ? nodeSize(drawnKind("topic", "mindmap", ghostName), look, ghostName || " ", undefined, { depth: ghostDepth }) : null;
  const ghostW = ghostSize ? ghostSize.w : field?.kind === "new" ? field.size.w : 0;
  const ghostH = ghostSize ? ghostSize.h : field?.kind === "new" ? field.size.h : 0;
  /**
   * The ghost widens with the typed name (fix round 1), measured alone: its shape's width is set on it, away from its
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
  /** Where the ghost was last drawn: its field stays there if the topic it was added to goes meanwhile (M10). */
  const keptGhost = useRef<{ open: number; box: Box } | null>(null);
  const graph = useMemo(() => {
    if (!shown) return { nodes: [], edges: [] };
    if (FIXED_KINDS.has(shown.kind))
      return buildFlowGraph(shown, layout.nodes, look, {
        states: shownStates,
        fresh: freshEdge,
        marks,
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
    });
  }, [shown, layout.nodes, layout.sizes, layout.axes, look, shownStates, freshEdge, marks, growing, folded, ghostParent, ghostAfter, ghostW, ghostH]);
  /** The latest Publish theme change, so a slower earlier one never overwrites it. */
  const publishInkSeq = useRef(0);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  /**
   * Publish: the drawing as it is now (the last one that worked while the text has an error), in its look, with
   * the cloud icons it uses loaded from the pack and embedded as images (ruling P9).
   */
  async function openPublish() {
    const d = drawnRef.current;
    if (!d) return;
    const { nodes, style, axes } = layoutRef.current;
    const icons = await loadSceneIcons(sceneIconNames(d), "light");
    let onScreen: SceneBox = { x: 0, y: 0, w: 0, h: 0 };
    const r = canvasEl.current?.getBoundingClientRect();
    const f = instance.current;
    if (r && f && r.width > 0 && r.height > 0) {
      const a = f.screenToFlowPosition({ x: r.x, y: r.y });
      const b = f.screenToFlowPosition({ x: r.x + r.width, y: r.y + r.height });
      onScreen = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    }
    // A folded topic publishes folded, as the canvas shows it.
    setPublishing({ scene: flowScene(d, nodes, style, icons, axes, folded), onScreen });
  }

  /** The Publish dialog's theme changed: the icons are inked again for it, and the scene is drawn with them. */
  async function repaintPublishIcons(theme: ExportTheme) {
    const d = drawnRef.current;
    if (!d) return;
    const mine = ++publishInkSeq.current;
    const { nodes, style, axes } = layoutRef.current;
    const icons = await loadSceneIcons(sceneIconNames(d), theme);
    if (mine !== publishInkSeq.current) return;
    setPublishing((p) => (p ? { ...p, scene: flowScene(d, nodes, style, icons, axes, folded) } : p));
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

  // Step 8: a selected loop is named by its index: a new drawing, or another pick, lets it go.
  useEffect(() => {
    setLoopSel(null);
    lastTab.current = null;
  }, [drawn]);
  useEffect(() => {
    if (selected.length > 0 || lines.length > 0) setLoopSel(null);
  }, [selected, lines]);
  // A line names a link by its index in one drawing: a new drawing lets the selected lines go.
  useEffect(() => setLines((prev) => (prev.length === 0 ? prev : [])), [drawn]);
  // Step 9: a shape or a line picked lets the selected group go, as does the group leaving the drawing.
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
    if (labelBox && parsed && parsed.result.version > labelBox.version) setLabelBox(null);
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

  // Undo and redo glide nodes back over a short move; undo says what it put back.
  useEffect(
    () =>
      doc.onHistoryMove(({ from, to, undo: undoing }) => {
        glideTo(from, to, "undo");
        if (!undoing) return;
        const moved = Object.keys(to).filter((k) => hasOwn(from, k) && (from[k].x !== to[k].x || from[k].y !== to[k].y));
        if (moved.length === 0) return;
        setNote({ text: moved.length === 1 ? `Moved ${moved[0]} back` : `Moved ${moved.length} nodes back`, key: Date.now() });
      }),
    [doc.onHistoryMove, glideTo],
  );

  /** A node just added fades in, unless motion is off. */
  const enter = useCallback((name: string) => {
    if (motionMs("enter") === 0) return;
    setStates((prev) => new Map(prev).set(name, "entering"));
  }, []);

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
      const names = drawnRef.current?.nodes.map((n) => n.name) ?? [];
      if (names.length === 0) return;
      const lines = await doc.linesOf(names);
      const hit = lines ? names.find((n) => lines[n] === line) : undefined;
      if (hit !== undefined) setSelected([hit]);
    },
    [doc.linesOf],
  );

  const drawnIds = useRef<ReadonlySet<string>>(new Set());
  drawnIds.current = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);
  const onSelect = useCallback((ids: string[]) => {
    const nodes = ids.filter((id) => !id.startsWith("\u0000"));
    // A Shapes item waiting for its shape takes this pick (step 6, draw.io's connect mode).
    pickForShapeRef.current(nodes);
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
      // An empty group (or one this node is alone in) keeps the area drawn now (I5).
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
  const cloneTo = useRef<(ids: string[], at: Positions) => void>(() => {});
  const flushMove = useCallback(() => {
    const p = pendingMove.current;
    pendingMove.current = null;
    const copies = dropCopies.current;
    dropCopies.current = false;
    const d = drag.current;
    drag.current = null;
    overlay.set({ hot: null });
    if (!p || aiLock.current) return;
    const snapped = emptyPositions();
    for (const k of Object.keys(p)) snapped[k] = { x: snap(p[k].x), y: snap(p[k].y) };
    const ids = Object.keys(p);
    // Ctrl+drag: the originals stay, copies land where the drag let go (draw.io).
    if (copies) {
      cloneTo.current(ids, snapped);
      return;
    }
    if (d && ids.length === 1 && ids[0] === d.lead && (d.groups.length > 0 || d.parent !== null)) {
      const target = groupAt(centre({ ...p[d.lead], ...d.size }), d.groups);
      if (target !== d.parent) {
        // The group it leaves empty stays drawn where it was (I5): its place is kept in the same undo step.
        const left = d.parent !== null ? findGroup(drawnRef.current?.groups ?? [], d.parent) : null;
        const keep = left && left.nodes.length === 1 && left.groups.length === 0 ? d.groups.find((g) => g.name === d.parent)?.box : undefined;
        const move = keep && d.parent !== null ? { ...snapped, [d.parent]: { x: keep.x, y: keep.y } } : snapped;
        void doc.run({ op: "moveToGroup", name: d.lead, group: target }, { move }).then((r) => {
          if (!r) doc.move(snapped);
          glideTo(p, snapped, "settle");
        });
        return;
      }
    }
    doc.move(snapped);
    glideTo(p, snapped, "settle");
  }, [doc.move, doc.run, overlay, glideTo]);
  const onMove = useCallback(
    (id: string, x: number, y: number, copy?: boolean) => {
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
    const at = instance.current && rect ? instance.current.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
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
   * A key or a tool opens the new shape with its name ready, written only when the name is kept. An ER table
   * is written at once under its free name (table_1) and selected; its name is edited in the text for now.
   */
  function add(tool: AddTool, at?: Point) {
    if (aiLock.current) return;
    if (!kind || tool.kind === "group") return;
    if (kind === "er") {
      // An old-form ER frame draws nothing and takes no edit until it is rewritten as table blocks.
      if (parsedRef.current?.result.oldEr) return setNotice(ER_NOTES.oldForm);
      return void addTable(tool.kind === "weak" ? "weak" : null, tool.base, at);
    }
    addShape(toolKind(tool), at);
  }

  async function addTable(tableKind: "weak" | null, base: string, at?: Point) {
    setNotice(null);
    // A refusal (an old-form frame waits for its rewrite) is said in the strip.
    const r = await doc.run({ op: "addNode", name: base, kind: tableKind, unique: true }, { onRefused: (why) => setNotice(why) });
    if (!r?.name) return;
    const shape = tableKind ?? "entity";
    const size = newSize(shape, r.name);
    doc.place({ [r.name]: at ? { x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2) } : viewCentre(shape, r.name) }, true);
    enter(r.name);
    setSelected([r.name]);
  }

  /** ER: a column at the end of `table`, under a free name (column_1) the text then renames. */
  function addColumnTo(table: string) {
    const t = (parsedRef.current?.result.doc ?? drawnRef.current)?.nodes.find((n) => n.name === table);
    if (!t) return;
    const rows = t.rows ?? [];
    const name = sqlFreeName("column", rows.map((r) => r.split(/\s/, 1)[0]), 1);
    void doc.run({ op: "addColumn", table, at: rows.length, before: null, name, type: "text" }, { onRefused: (why) => setNotice(why) });
  }

  /** "Open as DBML": the ER diagram's tables and relationships as an unsaved Schema Model under the diagram's name. */
  function openDbml() {
    const text = doc.view()?.state.doc.toString() ?? parsedRef.current?.text ?? null;
    const dbml = text === null ? null : openAsDbml(text, 0, name);
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

  // ----- step 6: add the next shape (board DiagramAddNext)

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
    // An ER table's free name is a plain SQL name, numbered from 1 (table_1), as the writer numbers one (I4).
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

  /** Ends a + drag under way with nothing written (I3); a no-op when none is. */
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
    // The titles are measured once here, not once per group (fix round 2, N10).
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
        // M3: Enter or Space on a focused + adds the next shape, as a click does.
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
          // I3: the pointer is captured, and a drag lost (cancelled, the capture gone, Esc, the tab closing) ends with
          // nothing written; only its own release adds or connects.
          try {
            button.setPointerCapture?.(pointerId);
          } catch {
            // A pointer that is already gone: the listeners below still end the drag.
          }
          const start = { x: e.clientX, y: e.clientY };
          let dragging = false;
          const toFlow = (x: number, y: number) => instance.current?.screenToFlowPosition({ x, y }) ?? { x, y };
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
  function addShape(asked: FlowNodeKind, at?: Point) {
    if (aiLock.current || !kind) return;
    // On a text with an error the new shape's line is still written (as a key always did); the faded drawing may not
    // show it until the text works again.
    const d = drawnRef.current;
    // A map with no central idea starts with it: its first topic is written `root <name>` (round 2, live check).
    const known = parsedRef.current?.result.doc ?? d;
    const nodeKind: FlowNodeKind = kind === "mindmap" && asked === "topic" && !known?.nodes.some((n) => n.kind === "root") ? "root" : asked;
    if (nodeKind === "root" && d?.nodes.some((n) => n.kind === "root")) {
      setNotice("A mind map has one central idea.");
      return;
    }
    const name = nodeKind === "note" ? "Note" : newName(nodeKind);
    const size = newSize(nodeKind, name);
    let spot: Point;
    if (at) spot = { x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2) };
    else {
      const rect = canvasEl.current?.getBoundingClientRect();
      const mid = instance.current && rect ? instance.current.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
      // Room for a name typed longer than the first one (board: 190 px). Clear of the group frames too, as of the shapes
      // (step 11 board note: a new shape had landed on a frame it was not added to).
      const frames = graphRef.current.nodes.filter((n) => isArea(n.id)).map(boxOfNode);
      const free = freeSpotNear(mid, { w: Math.max(size.w, 190), h: size.h + 12 }, [...placedBoxes().values(), ...frames]);
      spot = { x: free.x, y: free.y };
    }
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
    openNew({ node: nodeKind, at: spot, size, name, ...extra });
    // Where the axis gives no date, the strip says plainly which one the new item took.
    if (said) setNotice(said);
    ghostNotice.current = said ?? null;
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

  /** Step 6: the new shape's name kept: its line, its place and the line from its source, one undo step. */
  async function commitNew(e: Extract<NonNullable<typeof field>, { kind: "new" }>, value: string, how: CommitHow) {
    if (aiLock.current) return refuseField(e, EDIT_MESSAGES.locked);
    if (!kind) return;
    const note = e.node === "note";
    if (!value) return refuseField(e, needsName(e.node, kind));
    // A text opened with an error has no drawing to check names against: the writer refuses a taken name itself.
    const known = parsedRef.current?.result.doc ?? (e.from ? null : drawnRef.current);
    if (!known && e.from) return refuseField(e, LINK_NOTES.broken);
    // Step 11: a name another shape has keeps the new shape: the next free name, showing the words typed (label:).
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
    const r = await doc.run(ops.length === 1 ? ops[0] : { op: "batch", ops }, { ...(FIXED_KINDS.has(kind) ? {} : { move: { [placed]: { x: e.at.x, y: e.at.y } } }), ...(axes ? { axes } : {}), onRefused: (w) => (why = w) });
    if (!r) return refuseField(e, why ?? EDIT_MESSAGES.changed);
    if (fieldRef.current === e) setField(null);
    enter(placed);
    setSelected([placed]);
    if (label !== undefined) setNotice(labelNotice(words, value, "the new one"));
    // Only a data flow and a sequence ask for the new line's label, as its own undo step (F13, open question 2).
    if (e.from && (kind === "dfd" || kind === "sequence")) return void openLabel(e.from, value, r.at);
    if ((how === "enter" || how === "tab") && (e.node === "class" || e.node === "interface" || e.node === "enum")) return openMember(value, null);
    // A new service is written with the board's default icon and its icon is offered next (frame 6+.5); Esc keeps it.
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
    if (r && (kind === "dfd" || kind === "sequence")) void openLabel(from, to, r.at);
  }

  /** The Shapes item's prompt in the strip; the item waits for its pick as long as its prompt shows. */
  const shapePick = useRef<{ p: ShapePick; prompt: string } | null>(null);
  function setShapePick(p: ShapePick | null, prompt = "") {
    shapePick.current = p ? { p, prompt } : null;
    setNotice(p ? prompt : null);
  }

  /** A pick on the canvas while a Shapes item waits for one; true when the pick was the item's. */
  function pickForShape(ids: readonly string[]): boolean {
    const cur = shapePick.current;
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
    if (p.what === "line") {
      if (p.from === null) {
        const prompt = p.arrow === "<|--" ? `Now click the class ${id} inherits from.` : p.arrow === "*--" ? `Now click the class that owns ${id}.` : `Now click the ${kind === "mindmap" ? "topic" : "shape"} the ${p.label.toLowerCase()} goes to.`;
        setShapePick({ ...p, from: id }, prompt);
        return true;
      }
      setShapePick(null);
      void connectPicked(p.from, id, p.arrow);
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
      if (n.kind !== "entity" && n.kind !== "weak") return true;
      setShapePick(null);
      addColumnTo(id);
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

  /** Why a Shapes item cannot be used now, shown in its place; null when it can (board DiagramAddNext). */
  function shapeDisabled(sh: Shape): string | null {
    const sel = selectedRef.current;
    const d = drawnRef.current;
    if (sh.act.kind === "group" && sel.length === 0) return "Select shapes first";
    if (sh.act.kind === "section" && !sel.some((n) => d?.nodes.some((x) => x.name === n && (x.kind === "event" || x.kind === "period")))) return "Select events first";
    if (sh.act.kind === "node" && sh.act.node === "root" && d?.nodes.some((n) => n.kind === "root")) return "A mind map has one central idea";
    return null;
  }

  /** F18: a Shapes item (or an "Add here" pick at `at`) adds on the canvas. */
  function runShape(sh: Shape, at?: Point) {
    if (aiLock.current || !kind) return;
    const why = shapeDisabled(sh);
    if (why) {
      setNotice(`${sh.label}: ${why.charAt(0).toLowerCase()}${why.slice(1)}.`);
      return;
    }
    const sel = selectedRef.current;
    const d = drawnRef.current;
    const one = sel.length === 1 ? d?.nodes.find((n) => n.name === sel[0]) : undefined;
    const a = sh.act;
    switch (a.kind) {
      case "node":
        if (kind === "er" && sh.tool) return add(sh.tool, at);
        return addShape(a.node, at);
      case "line": {
        const from = sel.length === 1 ? sel[0] : null;
        const label = sh.label.toLowerCase();
        const prompt =
          a.arrow === "<|--"
            ? from
              ? `Click the class ${from} inherits from.`
              : "Click the class that inherits, then the one it inherits from."
            : a.arrow === "*--"
              ? from
                ? `Click the class that owns ${from}.`
                : "Click the part, then the class that owns it."
              : from
                ? `From ${said(from)}: click the shape the ${label} goes to.`
                : `Click the shape the ${label} starts from, then the one it goes to.`;
        setShapePick({ what: "line", arrow: a.arrow, from, label: sh.label }, prompt);
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
          if (parsedRef.current?.result.oldEr) return setNotice(ER_NOTES.oldForm);
          if (one && (one.kind === "entity" || one.kind === "weak")) return addColumnTo(one.name);
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

  /** D1: Ctrl+Shift+G (Miro, Figma, Lucidchart) or Ctrl+Shift+U (draw.io) takes the selected shape's group apart. */
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


  // ----- step 9: groups (board DiagramGroups, F9)

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
    // A composite's own [*] lines come out of its braces, where [*] is the diagram's: say so (fix round 2, N8).
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
        // A press right after a drag is a new press, not the second of a double press (fix round 1, M7).
        lastTitle.current = null;
        overlay.set({ hot: null });
        // An empty group moves by its kept place (I5).
        const after = drag.shapes > 0 ? groupDragEnd(drag, dx, dy) : { [name]: { x: Math.round(drag.box.x + dx), y: Math.round(drag.box.y + dy) } };
        const target = into >= 0 ? drag.targets[into] : null;
        // The group it leaves empty stays drawn where it was.
        const left = drag.parent !== null ? findGroup(drawnRef.current?.groups ?? [], drag.parent) : null;
        if (left && left.nodes.length === 0 && left.groups.length === 1 && target !== drag.parent && drag.parent !== null && parentIndex >= 0) {
          after[drag.parent] = { x: drag.targetBox[parentIndex * 4], y: drag.targetBox[parentIndex * 4 + 1] };
        }
        if (target !== drag.parent) {
          void doc.run({ op: "moveToGroup", name, group: target }, { move: after }).then((r) => {
            if (!r) doc.move(after);
            setGlide(null);
            setNotice(
              !r
                ? `Moved ${name} and the ${plural(count, "shape")} in it.`
                : target
                  ? `Put ${name} in ${target}. Its block moves inside ${target} { } in the text; the move and this are one undo step.`
                  : `Took ${name} out of ${drag.parent}. Its block moves out of the braces; one undo step.`,
            );
          });
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

  // ----- step 7: the mind map (board DiagramMindMap)

  /** The map's tree as drawn (orderGestures.ts). */
  const mindTree = () => mindTreeOf(drawnRef.current);
  /** The sequence as drawn (orderGestures.ts). */
  const seqGeometry = () => seqGeometryOf(drawnRef.current, graphRef.current);

  const isTopic = (name: string | null): name is string => !!name && !!drawnRef.current?.nodes.some((n) => n.name === name && (n.kind === "topic" || n.kind === "root"));

  /** M1: Tab opens a new subtopic, Shift+Tab the next topic beside the selected one (Mind42), each with its name ready. */
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

  /** M4: Ctrl or Alt+Up and Down move the selected topic among its siblings, with its subtopics (Mind42, Excalidraw Mindmap). */
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

  /** M4: the arrow keys select the next topic (Mind42): up and down its column, out to a subtopic, in to the parent. */
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

  /** M3: a topic's subtopics fold out of view and back (the branch dot, Ctrl+/); the text and the history keep them. */
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

  /** M2: Ctrl+Shift+L, then the topic it goes to, writes a relationship `A > B` (XMind); no label prompt. */
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
    // With no topic selected Tab moves focus on, out of the canvas (fix round 1, M11).
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
   * M4: a topic dragged onto another becomes its subtopic; between two siblings it goes there (XMind, Miro). The
   * dragged branch is drawn faded, a chip with its name follows the pointer, and its own subtopics refuse it. Esc
   * cancels; let go on empty canvas, nothing moves. The text moves the whole branch, re-indented, in one undo step.
   */
  /**
   * One pointer drag's listeners (steps 7 and 8). The pointer is captured; the release goes to `up`; Esc, a cancelled
   * pointer, a lost capture or a move with no button down (the button let go outside the window, fix round 1, M13)
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

  /** The drawn shapes and lines a drag is moving, faded by their class only, so the drawing is not built again (M6). */
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
    // Beside itself is where it is (fix round 1, I1).
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

  /** The branch dots (M3): on each topic with subtopics, on its outer side, with how many it holds; once per drawing (M4). */
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


  // ----- step 8: the sequence (board DiagramSequence)

  /** Screen to flow coordinates with the view as it is now, as two plain functions (no object per pointer frame). */
  function flowMapper(): { x(cx: number): number; y(cy: number): number } {
    const v = instance.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 };
    const r = canvasEl.current?.querySelector(".react-flow")?.getBoundingClientRect();
    const zoom = v.zoom || 1;
    const left = (r?.left ?? 0) + v.x;
    const top = (r?.top ?? 0) + v.y;
    return { x: (cx) => (cx - left) / zoom, y: (cy) => (cy - top) / zoom };
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
    const cur = await doc.current();
    const l = cur?.result.doc?.links[index];
    if (!cur || !l) return;
    const spans = await doc.spans(cur.result.version, [`link:${index}`]);
    const view = doc.view();
    const sp = spans?.[`link:${index}`];
    const line = sp && view ? view.state.doc.lineAt(Math.min(sp.from, view.state.doc.length)).number : undefined;
    setLabelBox({ index, version: cur.result.version, from: l.from, to: l.to, initial: l.label ?? "", fresh: true, ...(line !== undefined ? { line } : {}) });
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
    openField({ kind: "loop", index: f.index, was: frame.label, name, at: { x: frame.tab?.x ?? frame.box?.x ?? 0, y: (frame.tab?.y ?? frame.box?.y ?? 0) - 2 } });
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
    // On the loop: at its first message's row, by the participant it starts from (Visio's combined fragment).
    const edge = graphRef.current.edges.find((g) => g.id === `edge:${from}`);
    const src = edge ? graphRef.current.nodes.find((n) => n.id === edge.source) : undefined;
    const ed = edge?.data as { row?: number; y?: number } | undefined;
    const at = src && ed ? { x: Math.round(src.position.x), y: Math.round(src.position.y + (ed.y ?? SEQ_HEAD + ((ed.row ?? 0) + 0.5) * SEQ_ROW) - 22) } : viewCentre("participant", "every item");
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
    const tab = picking ? undefined : geo.frames.find((f) => within(f.tab));
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
    const onHead = p.y <= part.box.y + SEQ_HEAD;
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
      // The canvas is told only when the lifeline under the pointer changes (fix round 1, I4).
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
    if (!spans || !view) return;
    const lineOf = (i: number) => {
      const sp = spans[`link:${i}`];
      return sp ? view.state.doc.lineAt(Math.min(sp.from, view.state.doc.length)) : null;
    };
    const index = (at !== undefined ? candidates.find((i) => lineOf(i)?.from === at) : undefined) ?? candidates[candidates.length - 1];
    setLabelBox({ index, version, from, to, initial: "", fresh: true, line: lineOf(index)?.number });
  }

  /**
   * The label is kept, by a key, Escape or a click away (one edit, a new line's being its own undo step); an untouched
   * new label leaves the line unlabelled. Planned only on the box's own parse.
   */
  async function finishLabel(box: LabelBoxState, text: string, how: CommitHow) {
    if (aiLock.current) return;
    setLabelBox((cur) => (cur === box ? null : cur));
    if (how !== "blur") canvasEl.current?.focus();
    const label = text.trim();
    if (label === box.initial) return;
    await doc.run({ op: "setLinkLabel", index: box.index, label: label || null }, { version: box.version });
  }

  /** A double-clicked flow's label, in the box: only on the drawing of the current text. */
  const onEdgeDoubleClick = useCallback((id: string) => {
    if (aiLock.current) return;
    const p = parsedRef.current;
    const d = p?.result.doc;
    if (!p || !id.startsWith("edge:")) return;
    // The drawing is the last one without errors: its lines may not be the text's (I1).
    if (!d) {
      setNotice(LINK_NOTES.broken);
      return;
    }
    const index = Number(id.slice("edge:".length));
    const l = d.links[index];
    if (!l) return;
    // M2: a mind map branch is a topic's place under its parent, not a line with words (XMind).
    if (l.tree) {
      setNotice(`Branches carry no label: a branch is ${said(l.to)}'s place under ${said(l.from)}. Double-click the topic to rename it; Ctrl+Shift+L draws a labelled relationship.`);
      return;
    }
    setLabelBox({ index, version: p.result.version, from: l.from, to: l.to, initial: l.label ?? "", fresh: false });
  }, []);

  async function connect(from: Port, to: Port) {
    if (aiLock.current) return;
    setNotice(null);
    clearDrawGhost();
    if (from.node === to.node || from.node.startsWith("\u0000") || to.node.startsWith("\u0000")) return;
    // The faded drawing can hold a node the text no longer defines: a flow to it would only add a problem.
    if (stale) {
      const lines = await doc.linesOf([from.node, to.node]);
      const lost = lines ? [from.node, to.node].find((n) => lines[n] == null) : undefined;
      if (lost !== undefined) {
        setNotice(`${lost} is not defined.`);
        return;
      }
    }
    const r = await doc.run({ op: "addLink", from: from.node, to: to.node, arrow: defaultArrow(kind) });
    // F13: only a data flow's flows and a sequence's messages are named by definition (open question 2).
    if (r && (kind === "dfd" || kind === "sequence")) void openLabel(from.node, to.node, r.at);
  }

  /** A flow released on empty canvas: within 24 px of a node it goes there; else "Add and connect" opens. */
  function onConnectRelease(from: Port, at: Point) {
    clearDrawGhost();
    if (isArea(from.node)) return;
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
    const screen = instance.current?.flowToScreenPosition(at) ?? at;
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

  // While a drawn flow is locked onto a node, its new line shows in grey where it would be written (frame 6+.3).
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
    // let go, or beside its source from the shape menu (fix round 1).
    const nodeKind = toolKind(tool);
    const name = newName(nodeKind);
    const size = newSize(nodeKind, name);
    const spot = centred ? { x: Math.round(at.x - size.w / 2), y: Math.round(at.y - size.h / 2) } : { x: Math.round(at.x), y: Math.round(at.y - size.h / 2) };
    openNew({ node: nodeKind, at: spot, size, name, from });
  }
  /**
   * F3: the field on the shape is kept (a key, Escape or a click away): its name, or a note's text, with every line
   * that names it, as one undo step. A refused one stays open with the typed text and the reason (F4, I1).
   */
  async function rename(e: Extract<NonNullable<typeof field>, { kind: "label" }>, value: string, how: CommitHow) {
    const old = e.node;
    // Never dropped: under the Assistant's lock the field stays open with what was typed (I6).
    if (aiLock.current) return refuseField(e, EDIT_MESSAGES.locked);
    setNotice(null);
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    const n = known?.nodes.find((x) => x.name === old);
    const isNote = n?.kind === "note";
    const target = value;
    // Left by a key: focus back on the canvas, so F2 or Delete work at once (I4).
    const close = () => {
      if (fieldRef.current === e) setField(null);
      if (how !== "blur") canvasEl.current?.focus();
    };
    // A labelled shape edits the words it shows (step 11).
    if (target === (isNote ? (n?.text ?? "") : n ? shownName(n) : old)) return close();
    if (!target) return refuseField(e, needsName(n?.kind, kind));
    let plan: { ops: FlowEditOp[]; name: string; notice: string | null } = { ops: [{ op: "renameNode", old, next: target }], name: target, notice: null };
    if (!isNote) {
      const taken = await doc.linesOf([target]);
      const isTaken = !!taken && taken[target] != null && target !== old;
      // Step 11: the label rules (labels.ts): a taken name becomes the next free name plus label:, a labelled shape
      // keeps its name while its words are taken.
      const names = known ? namesOf(known) : new Set<string>();
      if (isTaken) names.add(target);
      else names.delete(target);
      const planned = n ? planWords(kind, n, target, names) : isTaken ? null : plan;
      // The field stays open with the reason, a click away included (I1).
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
    const r = await doc.run(op, Object.keys(axes).length ? { axes } : {});
    // A refused write keeps the field open with the reason (I6).
    if (!r) return refuseField(e, EDIT_MESSAGES.changed);
    close();
    if (isNote) return;
    if (plan.notice) setNotice(plan.notice);
    if (next === old) return;
    if (hasOwn(doc.layout.nodes, old)) doc.place({ [next]: doc.layout.nodes[old] }, true);
    if (folded.has(old)) setFolded((prev) => new Set([...without(prev, old), next]));
    setSelected([next]);
  }

  /** C1: a group's title kept (a rename), or a new group's (the group, its shapes moved in, one undo step). */
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
                // A group whose every shape and group went into the new one goes, as before (fix round 2, N2).
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
    const known = parsedRef.current?.result.doc;
    const owner = known?.nodes.find((n) => n.name === e.node);
    if (!owner || !known) return refuseKind(e, EDIT_MESSAGES.stale, e.kind === "draft" ? { value } : {});
    const rows = owner.rows ?? [];
    const same = (a: string, b: string) => a.replace(/\s/g, "") === b.replace(/\s/g, "");
    if (e.kind === "draft") {
      // An empty new row closes: nothing added (spreadsheets).
      if (!value) return closeKindEdit(e, how);
      if (rows.some((r) => same(r, value))) return refuseKind(e, MEMBER_MESSAGES.taken(value, e.node), { value });
      const r = await doc.run({ op: "addMember", owner: e.node, at: e.at, member: value });
      if (!r) return refuseKind(e, EDIT_MESSAGES.changed, { value });
      if (kindEdits.get() !== e) return;
      if (how === "enter" || how === "tab") return setKindEdit({ kind: "draft", node: e.node, at: e.at + 1 });
      return pickAfter(e, { kind: "picked", node: e.node, index: e.at, was: value }, how);
    }
    if (e.kind !== "member") return;
    if (!value) return refuseKind(e, MEMBER_MESSAGES.needsName);
    if (value === e.was) return pickAfter(e, { kind: "picked", node: e.node, index: e.index, was: value }, how);
    if (rows.some((r, i) => i !== e.index && same(r, value))) return refuseKind(e, MEMBER_MESSAGES.taken(value, e.node));
    const r = await doc.run({ op: "setMember", owner: e.node, index: e.index, was: e.was, member: value });
    if (!r) return refuseKind(e, EDIT_MESSAGES.changed);
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
    const r = await doc.run({ op: "setDate", name: e.node, date, ...(until !== undefined ? { until } : {}) });
    if (!r) return refuseKind(e, EDIT_MESSAGES.changed, { date, until, errorAt: undefined });
    closeKindEdit(e, how);
  }

  const kindEditCtx = useMemo(
    () => ({
      store: kindEdits,
      api: {
        commitMember: (e: KindEdit, v: string, how: CommitHow) => void kindApi.current.commitMember(e, v, how),
        commitDate: (e: KindEdit, d: string, u: string | undefined, how: CommitHow) => void kindApi.current.commitDate(e, d, u, how),
        cancel: (e: KindEdit) => closeKindEditRef.current(e, "cancel"),
        readOnly: ai.locked,
      },
    }),
    [kindEdits, ai.locked],
  );
  const kindApi = useRef({ commitMember, commitDate });
  kindApi.current = { commitMember, commitDate };
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
  const pickedMemberRef = useRef(pickedMember);
  pickedMemberRef.current = pickedMember;
  const setKindEditRef = useRef(setKindEdit);
  setKindEditRef.current = setKindEdit;

  /**
   * CL1 (I1): a press on a class member's row picks it, drawn picked; a press anywhere else lets it go. A press in an
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
   * One Delete is one edit list and one undo entry, all or nothing (ruling P16). The nodes and their lines fade
   * out first (120 ms exit), then the text loses them; at once with motion off. The edit is planned on the parse
   * of the text as it was when Delete was pressed, so a change during the fade makes it do nothing (ruling P20).
   */
  async function removeSelected() {
    if (aiLock.current) return;
    setNotice(null);
    const names = selectedRef.current;
    const picked = linesRef.current;
    if ((names.length === 0 && picked.length === 0) || deleting.current) return;
    deleting.current = true;
    // What fades out: the shapes that go, a mind map topic's subtopics with it (fix round 1, M8).
    let fading: readonly string[] = names;
    const unmark = () =>
      setStates((prev) => {
        const next = new Map(prev);
        for (const n of fading) if (next.get(n) === "leaving") next.delete(n);
        return next.size === prev.size ? prev : next;
      });
    try {
      const planned = await doc.current();
      if (!planned) return;
      // F1: the selected lines by index, last first, so each delete leaves the indexes before it as they were. A
      // mind map's branches come from the indents and are not lines in the text.
      const links = planned.result.doc?.links ?? [];
      const indexes = [...new Set(picked.map(linkIndex))].filter((i): i is number => i !== null && i < links.length && !links[i].tree).sort((a, b) => b - a);
      if (picked.length > 0 && indexes.length === 0 && names.length === 0) {
        // The drawing is the last one that worked: its lines do not name the text's. A mind map branch is no line.
        setNotice(planned.result.doc ? BRANCH_NOTE : "Fix the text first: the drawing is the last one without errors.");
        return;
      }
      // Shapes go, but lines of a drawing that is not the text's are left, and the strip says so (M7).
      const linesLeft = picked.length > 0 && indexes.length === 0 && !planned.result.doc;
      // A mind map topic goes with its subtopics and their relationships (step 7); one already inside another's branch
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
        setNotice("The central idea stays. F2 renames it.");
        return;
      }
      if (mind) fading = nodeOps.flatMap((o) => (o.op === "deleteTopic" ? [o.name, ...subtreeOf(o.name, mind.kids)] : o.op === "deleteNode" ? [o.name] : []));
      // A sequence keeps at least two participants (board DiagramSequence).
      const seq = planned.result.doc?.kind === "sequence" ? planned.result.doc : null;
      if (seq) {
        const parts = seq.nodes.filter((n) => n.kind === "participant" || n.kind === "actor");
        if (names.some((n) => parts.some((p) => p.name === n)) && parts.filter((p) => !names.includes(p.name)).length < 2) {
          setNotice("A sequence keeps at least two participants.");
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
      // A group whose last shapes go stays drawn where it was: its place in the same undo step (fix round 2, N7).
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
        ...(Object.keys(goneAxes).length ? { axes: goneAxes } : {}),
        ...(Object.keys(places).length ? { move: places } : {}),
      });
      if (r) {
        setSelected([]);
        setLines([]);
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
    const c = selectionClip();
    if (!c) return null;
    lastClip = { text: c.text, diagram: name, at: c.at, pastes: cut ? -1 : 0 };
    return c.text;
  }

  /** The pointer while it is over the canvas, else the middle of the view, in flow coordinates. */
  function pasteAnchor(): Point {
    const f = instance.current;
    const rect = canvasEl.current?.getBoundingClientRect();
    if (!f) return { x: 0, y: 0 };
    if (pointer.current) return f.screenToFlowPosition(pointer.current);
    return rect ? f.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
  }

  const shifted = (at: Positions, d: number): Positions => {
    const out = emptyPositions();
    for (const k of Object.keys(at)) out[k] = { x: at[k].x + d, y: at[k].y + d };
    return out;
  };

  /**
   * Writes .flow lines into the diagram as one edit and one undo entry, with free names, and selects what it wrote.
   * The shapes the text names are drawn at `at` (by the names they were copied under), moved so their top left is at
   * `anchor` when one is given; shapes with no place (text from outside) go in a row from the anchor. In a mind map
   * the paste goes under the one selected topic, or after `after` (a duplicate).
   */
  async function pasteText(text: string, place: { at?: Positions | null; anchor?: Point | null; after?: string }): Promise<boolean> {
    if (aiLock.current || !kind) return false;
    setNotice(null);
    // C1: over the limit nothing is sent to the worker at all.
    if (overTextLimit(text)) {
      setNotice("The clipboard text is larger than 1 MB, so nothing was pasted.");
      return false;
    }
    if (nonEmptyLines(text) > MAX_FLOW_NODES) {
      setNotice(TOO_MANY_LINES);
      return false;
    }
    const op: FlowPasteOp = { op: "paste", text };
    if (kind === "mindmap") {
      const sel = selectedRef.current;
      if (place.after !== undefined) op.after = place.after;
      else if (sel.length === 1) op.under = sel[0];
    }
    const refusal = { why: "" };
    const r = await doc.run(op, {
      onRefused: (why) => {
        refusal.why = why;
      },
    });
    if (!r) {
      setNotice(refusal.why || "The text changed while pasting, so nothing was pasted. Try again.");
      return false;
    }
    const names = r.names ?? {};
    const copied = Object.keys(names);
    if (!FIXED_KINDS.has(kind)) {
      const at = place.at ?? emptyPositions();
      const known = copied.filter((o) => hasOwn(at, o));
      const anchor = place.anchor ?? (known.length === copied.length ? null : pasteAnchor());
      let dx = 0;
      let dy = 0;
      if (anchor && known.length > 0) {
        dx = snap(anchor.x) - Math.min(...known.map((o) => at[o].x));
        dy = snap(anchor.y) - Math.min(...known.map((o) => at[o].y));
      }
      const out = emptyPositions();
      for (const o of known) out[names[o]] = { x: at[o].x + dx, y: at[o].y + dy };
      // Shapes with no place go in a compact block from the anchor, as near square as it can be (C1).
      const rest = copied.filter((o) => !hasOwn(out, names[o]));
      const cols = Math.max(1, Math.ceil(Math.sqrt(rest.length)));
      const ax = anchor ? snap(anchor.x) : 0;
      const ay = anchor ? snap(anchor.y) : 0;
      rest.forEach((o, i) => {
        out[names[o]] = { x: ax + (i % cols) * PASTE_CELL.w, y: ay + Math.floor(i / cols) * PASTE_CELL.h };
      });
      doc.place(out, true);
    }
    if (r.note) setNotice(r.note);
    const made = Object.values(names);
    for (const n of made) enter(n);
    setLines([]);
    setSelected(made);
    return true;
  }

  /** Ctrl+V (or its clipboard event): next to the originals on their own diagram, a step further each time (draw.io). */
  /**
   * Step 10 (user decision, 25 Oct): Mermaid pasted in the text (`where`, the selection) or on the canvas (after the last
   * line) is translated by the Mermaid importer. The Mermaid goes in at once, exactly as a plain paste would, so it is
   * never lost (fix round 1, I2); its translation then replaces it as a second undo step, so a second Ctrl+Z leaves the
   * Mermaid as pasted (VS Code's paste-then-undo). A kind this diagram does not take, and an ER diagram, are refused
   * before anything is pasted. Over the whole file, or into a file with no shapes, the paste sets the kind and keeps the
   * title (and the comments); elsewhere it never lands above the `diagram` line (I1). On a board all of this is about
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
    view.dispatch({ changes: { from: rawFrom, to: rawTo, insert: lead + raw }, selection: { anchor: rawFrom + lead.length + raw.length }, userEvent: "input.paste", annotations: isolateHistory.of("full") });
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
    // A selection that takes the `diagram` line but not the whole file leaves no line to keep the kind (fix round 2, N5).
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
    p.view.dispatch({ changes: { from: a, to: now.length - b, insert: final.slice(a, final.length - b) }, userEvent: "input.paste", annotations: isolateHistory.of("full") });
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

  function pasteFromKeys(text: string) {
    if (isMermaid(text)) return pasteMermaid(text, null);
    const c = lastClip && lastClip.text === text ? lastClip : null;
    // At the pointer while it is over the canvas, keeping the copied arrangement.
    if (pointer.current) return pasteText(text, { at: c?.at ?? null, anchor: pasteAnchor() });
    if (c && c.diagram === name) {
      c.pastes += 1;
      // A cut's first paste lands where the shapes were, but not over them when the cut was undone (M8).
      const drawnNow = new Set(drawnRef.current?.nodes.map((n) => n.name));
      if (c.pastes === 0 && Object.keys(c.at).some((k) => drawnNow.has(k))) c.pastes = 1;
      return pasteText(text, { at: shifted(c.at, PASTE_STEP * c.pastes) });
    }
    return pasteText(text, { at: c?.at ?? null, anchor: pasteAnchor() });
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

  cloneTo.current = (ids, at) => {
    const c = selectionClip(ids);
    if (c) void pasteText(c.text, { at });
  };

  function copyFromMenu(cut: boolean) {
    const text = copySelection(cut);
    if (!text) return;
    void writeClipboard(text);
    if (cut) void removeSelected();
  }

  /** The canvas menu's Paste: the clipboard's text where the menu was opened (draw.io's Paste here). */
  async function pasteFromMenu(at: Point) {
    const text = (await readClipboard()) || lastClip?.text || "";
    const c = lastClip && lastClip.text === text ? lastClip : null;
    await pasteText(text, { at: c?.at ?? null, anchor: at });
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
    // An empty clipboard (on Linux Contura keeps an empty offer, paste_guard.rs) pastes the last copy made here (I1).
    const text = e.clipboardData.getData("text/plain") || lastClip?.text;
    if (text) void pasteFromKeys(text);
  };

  /**
   * Every node glides to its laid-out place (answer 4A, 240 ms). With two or more nodes selected only they are
   * laid out, kept where the selection's top left corner was. One move, one undo entry; the text is unchanged.
   */
  async function tidy() {
    if (aiLock.current) return;
    const d = drawnRef.current;
    if (!d || d.nodes.length === 0 || FIXED_KINDS.has(d.kind)) return;
    const names = new Set(d.nodes.map((n) => n.name));
    const picked = selectedRef.current.filter((n) => names.has(n));
    const only = picked.length >= 2 ? new Set(picked) : null;
    const input = layoutInput(d, look);
    const req = only ? { nodes: input.nodes.filter((n) => only.has(n.id)), edges: input.edges.filter((e) => only.has(e.from) && only.has(e.to)) } : input;
    let p: Positions;
    try {
      p = await client.layout({ ...req, existing: {}, rankdir: layout.direction });
    } catch {
      // The worker restarted: the drawing stays as it is.
      return;
    }
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
   * A double-click on the empty canvas: on a group's title it renames the group (C1); anywhere else "Add here". The
   * title takes no presses of its own, so a box select or a pan started on it still works (fix round 1, M6).
   */
  function paneDoubleClick(p: { screen: Point; flow: Point }) {
    const group = groupTitleAt(p.flow);
    if (group !== null) return startGroupRename(group);
    setPaneAdd(p);
  }

  /**
   * The group whose title is at `at`, or null (N3): the title's own band, its icon and name plus a little padding, not
   * the group's whole width; the innermost group first. Area nodes take no presses, so the canvas finds the title.
   */
  /**
   * A title's band width: the title as drawn (its icon and name, at the zoom), with its inset and padding; the guess from
   * its letters only while it is not drawn (fix round 1, M10).
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
    if (aiLock.current) return;
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
    // F3: a state's start and end markers have no name (board DiagramEditInPlace).
    if (kind === "state" && isStateMarker(node)) {
      setNotice(MARKER_NOTE);
      return;
    }
    openField({ kind: "label", node });
  }
  /** C1: a group's title edited in place (a double-click on it). */
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
    if (n) doc.move(n.after, n.before);
  }
  /** Whether the open menu came from Shift+F10 or the Menu key. */
  const menuFromKeys = useRef(false);
  /**
   * Shift+F10 and the Menu key (Windows): the menu of what is selected, at it: several selected, one shape, one
   * line, else the canvas at the middle of the view (I5).
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
    } else if (picked.length === 1) {
      target = { node: null, line: picked[0] };
      const l = drawnRef.current?.links[linkIndex(picked[0]) ?? -1];
      const a = l ? centreOf(l.from) : null;
      const b = l ? centreOf(l.to) : null;
      flowAt = a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
    }
    const screen = flowAt && f ? f.flowToScreenPosition(flowAt) : middle;
    menuFromKeys.current = true;
    openMenu({ ...target, screen, flow: f ? f.screenToFlowPosition(screen) : { x: 0, y: 0 }, fit: () => void f?.fitView({ padding: 0.1 }) });
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

  const onCanvasKey = (e: KeyboardEvent) => {
    // Any other key ends a nudge burst first, so an undo right after it takes the whole burst back.
    if (!e.key.startsWith("Arrow")) endNudge();
    if (!aiLock.current && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.altKey))) {
      e.preventDefault();
      openKeyboardMenu();
      return;
    }
    const t = e.target as HTMLElement;
    if (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    // While the assistant holds the text the canvas takes no edits; undo works once it lets go. Copy still copies.
    if (aiLock.current && !((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "a" || e.key.toLowerCase() === "c"))) return;
    // A focused button, menu item or tab keeps its own Enter (I3): only the canvas or a shape takes it.
    if (e.key === "Enter" && t.closest("button, a[href], select, [role=menuitem], [role=menu], [role=option], [role=tab], [role=toolbar]")) return;
    // CL1: a picked class member takes Ctrl+Enter, Delete, Enter and F2 (draw.io's rows).
    if (memberKey(e)) return;
    // Step 7: the mind map's Tab, Shift+Tab, Ctrl+/, Ctrl+Shift+L and its arrow keys (board DiagramMindMap).
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
        // the last copy made here is pasted only when that gives no text (I1).
        pastePending.current = true;
        setTimeout(() => {
          if (!pastePending.current) return;
          pastePending.current = false;
          void readClipboard().then((t) => {
            const text = t || lastClip?.text;
            if (text) void pasteFromKeys(text);
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
        // D1: Ctrl+Shift+G (Miro, Figma, Lucidchart) and Ctrl+Shift+U (draw.io) take the group apart.
        e.preventDefault();
        if (kind && GROUP_WORD[kind]) ungroupSelected();
        else if (kind && NO_GROUPS[kind]) setNotice(`Nothing to take apart: ${NO_GROUPS[kind]}`);
      }
      return;
    }
    // Step 8: a selected loop takes F2, Enter and Delete (S4); M starts a message (S1).
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
    // Esc leaves a Shapes item's pick first (step 6).
    if (e.key === "Escape" && shapePick.current) {
      e.preventDefault();
      setShapePick(null);
      return;
    }
    if (e.key === "Escape" && (selectedRef.current.length > 0 || linesRef.current.length > 0)) {
      e.preventDefault();
      setSelected([]);
      setLines([]);
      return;
    }
    // F7: the arrow keys nudge the selection 1 px, Shift 16 px (Figma, draw.io); a held key's repeats are drawn at
    // once and kept as one move, one undo entry, when the key goes up (endNudge).
    if (nudgeKey(e, selectedRef.current)) return;
    // F2 and Enter edit the one selected shape's name on it (F6, draw.io). On a shape that is not selected yet,
    // Enter is React Flow's own pick: the selection here is still the one before it.
    if (e.key === "F2" || (e.key === "Enter" && !e.shiftKey)) {
      if (selectedRef.current.length === 1) {
        e.preventDefault();
        startRename(selectedRef.current[0]);
      } else if (selectedRef.current.length === 0 && linesRef.current.length === 1) {
        // A selected line's label is edited on it (the board's F2 and Enter on a relationship).
        e.preventDefault();
        onEdgeDoubleClick(linesRef.current[0]);
      }
      return;
    }
    // Delete and Backspace remove the selected shapes and lines (F1, F25).
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedRef.current.length > 0 || linesRef.current.length > 0) {
        e.preventDefault();
        void removeSelected();
      }
      return;
    }
    const tool = e.key.length === 1 ? tools.find((x) => x.key === e.key.toUpperCase()) : undefined;
    if (tool) {
      e.preventDefault();
      void (tool.kind === "group" ? groupSelected() : add(tool));
      return;
    }
    // N adds a note where the kind has notes, its text ready (Miro's N; board DiagramAddNext).
    if (e.key.toLowerCase() === "n" && !e.shiftKey && kind && NOTE_KINDS.has(kind)) {
      e.preventDefault();
      addShape("note");
    }
  };

  /** Opens the name and details panel beside a node (item 22). */
  function editNode(name: string) {
    if (aiLock.current) return;
    const d = drawnRef.current;
    if (!d?.nodes.some((n) => n.name === name) || isArea(name)) return;
    const n = instance.current?.getNode(name);
    const w = n?.measured?.width ?? n?.width ?? n?.initialWidth ?? 0;
    const flowAt = n ? { x: n.position.x + w + 12, y: n.position.y } : { x: 0, y: 0 };
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
    if (rename && rename.op === "renameNode" && node.kind !== "note") {
      const taken = await doc.linesOf([rename.next]);
      if (taken && taken[rename.next] != null) return setEditingNode({ ...open, problem: `${rename.next} is already used.` });
    }
    let why: string | null = null;
    const r = await doc.run(ops.length === 1 ? ops[0] : { op: "batch", ops }, { onRefused: (w) => (why = w) });
    if (!r) return setEditingNode({ ...open, problem: why ?? EDIT_MESSAGES.changed });
    setEditingNode(null);
    if (rename && rename.op === "renameNode" && node.kind !== "note") {
      const kept = doc.layout.nodes[node.name];
      if (kept) doc.place({ [rename.next]: kept }, true);
      setSelected([rename.next]);
    }
  }

  /** Moves the text to the line that defines `node` and gives it focus. */
  async function showInText(node: string) {
    const lines = await doc.linesOf([node]);
    const line = lines?.[node];
    const v = doc.view();
    if (!v || typeof line !== "number" || line > v.state.doc.lines) return;
    v.dispatch({ selection: { anchor: v.state.doc.line(line).from }, scrollIntoView: true });
    v.focus();
  }

  /** Moves the text to link `index`'s line and gives it focus. */
  async function showLine(index: number) {
    const cur = await doc.current();
    if (!cur?.result.doc) return;
    const spans = await doc.spans(cur.result.version, [`link:${index}`]);
    const sp = spans?.[`link:${index}`];
    const v = doc.view();
    if (!sp || !v) return;
    v.dispatch({ selection: { anchor: Math.min(sp.from, v.state.doc.length) }, scrollIntoView: true });
    v.focus();
  }

  /** A line's arrow or direction from its menu: one text edit, one undo step. */
  /**
   * A line op on the line `link` names (its ends, label and which of those it is, taken when the menu opened or the
   * end was dropped), never an index into a drawing that may be stale (I1). While the text has an error, or when the
   * line is gone, nothing changes and the strip says why (I2); an op that changes nothing says nothing.
   */
  function editLine(
    link: LinkRef | null,
    op: { op: "setLinkArrow"; arrow: FlowArrow } | { op: "reverseLink" } | { op: "setLinkEnd"; end: "from" | "to"; node: string } | { op: "setLinkColor"; color: string | null },
  ) {
    if (aiLock.current || !link) return;
    setNotice(null);
    if (!parsedRef.current?.result.doc) {
      setNotice(LINK_NOTES.broken);
      return;
    }
    void doc.run({ ...op, link }, { onRefused: (why) => setNotice(why) });
  }

  // ----- step 11: colour (board DiagramColourLabels; draw.io Fill, Miro, eraser.io `color`)

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

  // A Shapes item's pick lives as long as its prompt: any action that clears or replaces it ends the pick.
  useEffect(() => {
    if (shapePick.current && notice !== shapePick.current.prompt) shapePick.current = null;
    if (shapePick.current?.p.what !== "message") setSlotGuide((g) => (g?.pick ? null : g));
  }, [notice]);

  /** Item 20 and diagram step 4: a right-click offers what is under the pointer first. */
  function openMenu(at: CanvasMenuAt) {
    if (aiLock.current || !kind) return;
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
      // One shape in a box selection gets its own menu, not "1 selected" (M5).
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
        // change under the open menu (fix round 1, M2).
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
        "Line actions",
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
      if (kept && count > 1) return selectionMenu(count);
      const lined = kind === "dfd" || kind === "flow" || kind === "cloud" || kind === "state" || kind === "class";
      place(
        `${node} actions`,
        shapeMenuItems({
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
        empty: names.length === 0,
        drawn: !!d,
        add: (t) => add(t, at.flow),
        paste: () => void pasteFromMenu(at.flow),
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
  // Made once per drawing and selection, not on each frame of a drag (fix round 1, M6).
  const groupCount = useMemo(() => (groupSel !== null && drawn ? (groupContents(drawn, groupSel)?.shapes.length ?? null) : null), [drawn, groupSel]);
  const askContents = useMemo(() => (groupAsk !== null && drawn ? groupContents(drawn, groupAsk) : null), [drawn, groupAsk]);
  /** Delete's question opens under the group's title, on screen. */
  const askAt = (() => {
    if (groupAsk === null || !drawn) return null;
    const c = askContents;
    const a = graph.nodes.find((n) => n.id === `\u0000group:${groupAsk}`);
    if (!c || !a) return null;
    const f = instance.current;
    const p = f ? f.flowToScreenPosition({ x: a.position.x + 8, y: a.position.y + 28 }) : { x: a.position.x + 8, y: a.position.y + 28 };
    const r = canvasEl.current?.getBoundingClientRect();
    const left = r ? Math.max(4, Math.min(p.x - r.left, r.width - 304)) : p.x;
    const top = r ? Math.max(4, Math.min(p.y - r.top, r.height - 176)) : p.y;
    return { counts: { shapes: c.shapes.length, inner: c.inner.length, lines: c.lines }, at: { left, top } };
  })();
  const flowsOf = (n: string) => drawn?.links.filter((l) => l.from === n || l.to === n).length ?? 0;
  const errors = (parsed?.result.problems ?? []).filter((p) => p.severity === "error");
  const counted = parsed?.result.doc ?? drawn;

  // The selected nodes' lines, and the new flow's line while its label box is open.
  const newLine = labelBox?.fresh ? labelBox.line : undefined;
  const shownBands = useMemo(() => [...bandLines, ...aiBands, ...(newLine === undefined ? [] : [newLine])], [bandLines, aiBands, newLine]);

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
    const axis = (graph.edges.find((g) => g.id === `edge:${labelBox.index}`)?.data as FlowEdgeData | undefined)?.axis;
    const mid = routeOrthogonal(lineBoxOf(a), lineBoxOf(b), axis ? { axis } : {}).mid;
    const shapes = graph.nodes.filter((n) => !isArea(n.id)).map(boxOfNode);
    const covers = (x: number, y: number) => shapes.some((q) => x - 85 < q.x + q.w && x + 85 > q.x && y - 12 < q.y + q.h && y + 12 > q.y);
    for (let d = 0; d <= 240; d += 8) for (const [dx, dy] of d ? [[0, -d], [0, d], [-d, 0], [d, 0]] : [[0, 0]]) if (!covers(mid.x + dx, mid.y + dy)) return { x: mid.x + dx, y: mid.y + dy };
    return mid;
  }, [labelBox, graph, kind]);

  // F3's field sits over the shape's middle, as wide as the shape; a class's in its header. A group's title edits at
  // the top of its area; a new group's around its shapes (C1).
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
      // A participant's box is its whole lifeline: its name is on its head (I4).
      const head = t === "participant" || t === "actor";
      // A labelled shape edits the words it shows (step 11).
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
      // A mind map topic's ghost is laid out with the map: its field sits on it (step 7).
      const ghost = graph.nodes.find((g) => g.id === GHOST_ID);
      if (ghost) keptGhost.current = { open: field.open ?? 0, box: boxOfNode(ghost) };
      const kept = keptGhost.current?.open === (field.open ?? 0) ? keptGhost.current.box : null;
      const box = ghost ? boxOfNode(ghost) : (kept ?? { x: field.at.x, y: field.at.y, w: field.size.w, h: field.size.h });
      return { x: box.x, y: box.y + box.h / 2, w: Math.max(box.w, 120), box, note: field.node === "note", value: field.name };
    }
    if (field.kind === "newloop" || field.kind === "newsection" || field.kind === "loop") {
      const box = { x: field.at.x, y: field.at.y, w: 200, h: 24 };
      return { x: box.x, y: box.y + 12, w: 200, box, note: false, value: field.name };
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

  /** Where a hovered or selected shape is drawn, for its handles; none for markers, group areas and notes' +. */
  const hotBox = (id: string): Box | null => {
    const n = graphRef.current.nodes.find((g) => g.id === id);
    return n && !isArea(id) ? boxOfNode(n) : null;
  };

  /** F8: a line's end let go at `at`: onto the shape there (within the 24 px magnet), as one edit; elsewhere nothing. */
  const reattach = useCallback(
    (edge: string, end: "from" | "to", at: Point) => {
      const index = linkIndex(edge);
      if (aiLock.current || index === null) return;
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
      className="flow-tab"
      onKeyDown={(e) => {
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
          if (drawnRef.current) void openPublish();
          return;
        }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.defaultPrevented && ai.waiting?.step === "review") {
          e.preventDefault();
          ai.acceptAll();
          return;
        }
        // As the Schema Builder's Hide DBML: Ctrl+B hides the side panel and brings it back.
        if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
          e.preventDefault();
          setSide({ hidden: !side.hidden });
        }
      }}
    >
      <SidePanel
        tab={side.tab}
        hidden={side.hidden}
        pending={ai.pending}
        locked={ai.locked}
        working={ai.working !== null}
        onTab={(tab) => setSide({ tab })}
        onHide={() => setSide({ hidden: true })}
        onShow={(tab) => setSide(tab ? { hidden: false, tab } : { hidden: false })}
        editor={
          <>
          <div className="schema-pane-head flow-strip">
            <h2 className="schema-pane-title">{kind ? KIND_TITLE[kind] : ""}</h2>
            <span className="spacer" />
            {doc.save.kind === "saved" ? (
              <span className="schema-pane-saved flow-saved">
                <Icon name="check" size={14} />
                Saved
              </span>
            ) : doc.save.kind === "waiting" ? (
              <span className="schema-pane-saved">Not saved</span>
            ) : (
              <span className="schema-pane-saved flow-save-failed" role="alert">
                Not saved: {doc.save.message}
              </span>
            )}
          </div>
          {ai.working && (
            <div className="flow-ebar" role="status">
              <Icon name="lock" size={14} />
              <span className="flow-ebar-text">The assistant is editing. The text is read-only until it finishes.</span>
              <button type="button" className="btn pbtn2" onClick={ai.stop}>
                Stop
              </button>
            </div>
          )}
          {ai.waiting && ai.pending > 0 && (
            <div className="flow-ebar" role="status">
              <span className="flow-ebar-text">
                {ai.pending === 1 ? "1 change from the assistant is marked below." : `${ai.pending.toLocaleString("en-US")} changes from the assistant are marked below.`}
              </span>
              <button type="button" className="btn pbtn2" onClick={ai.rejectAll}>
                Reject all
              </button>
              {/* The remove question answers for itself in the Assistant; here only Reject all stands for Cancel. */}
              {ai.waiting.step === "review" && (
                <button type="button" className="btn pbtn2 pri" onClick={ai.acceptAll}>
                  {acceptLabel(ai.waiting.proposal.changes, ai.waiting.rejected)}
                </button>
              )}
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
              />
            )}
          </div>
          {parsed && (
            <Problems
              parsed={parsed}
              onFix={(p, j) => {
                if (aiLock.current) return;
                setGhost(null);
                doc.applyFix(p.fixes[j].edits, parsed.text);
              }}
              onHoverFix={(p, j) => setGhost(p ? { edits: p.fixes[j].edits, text: parsed.text } : null)}
              onLine={(line) => {
                const v = doc.view();
                if (!v || line > v.state.doc.lines) return;
                v.dispatch({ selection: { anchor: v.state.doc.line(line).from }, scrollIntoView: true });
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
          </>
        }
        assistant={
          <DiagramAssistant
            ai={ai}
            name={name}
            kind={kind}
            selected={selected}
            mode={assistMode}
            onMode={setAssistMode}
            onShowText={(lines) => {
              setAiBands(lines);
              setSide({ tab: "editor" });
            }}
            onUndo={() => {
              const v = doc.view();
              if (v) undo(v);
              setAiBands([]);
            }}
            active={active && side.tab === "assistant" && !side.hidden}
            onOpenSettings={onOpenSettings}
          />
        }
      />

      <section className="schema-island flow-pane-draw" aria-label={`${name} drawing`}>
        <div className="schema-pane-head flow-strip">
          {labelBox?.fresh ? (
            <span className="flow-selchip">{`New flow: ${labelBox.from} to ${labelBox.to}`}</span>
          ) : one ? (
            <>
              {/* A weak table's chip is dashed, as its card is. */}
              <span className={kind === "er" && one.kind === "weak" ? "flow-selchip is-weak" : "flow-selchip"}>
                {chipIcon(kind, one) && <Icon name={chipIcon(kind, one)!} size={14} />}
                {one.attrs.id && <span className="flow-selchip-id">{one.attrs.id}</span>}
                {/* A labelled shape: the words it shows, and the name lines use (step 11). */}
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
          {notice && (
            // A notice cut off by a narrow strip keeps its whole text in its tooltip.
            <span className="flow-notice" role="status" title={notice}>
              {notice}
            </span>
          )}
          <span className="spacer" />
          {kind === "flow" && (
            <span className="flow-seg" role="group" aria-label="Direction">
              {(["TB", "LR"] as FlowDirection[]).map((d) => (
                <button key={d} type="button" className="flow-seg-button" aria-pressed={layout.direction === d} onClick={() => doc.setDirection(d)}>
                  {d === "TB" ? "Top to bottom" : "Left to right"}
                </button>
              ))}
            </span>
          )}
          {kind === "cloud" && (
            <button type="button" className="button button-small button-quiet" onClick={() => setCredits(true)}>
              Icon credits
            </button>
          )}
          <button type="button" className="button button-small" disabled={!drawn} title="Publish image (Ctrl+Shift+E)" onClick={() => void openPublish()}>
            <Icon name="image" size={14} />
            Publish
          </button>
        </div>
        <div
          ref={canvasEl}
          className={`flow-canvas${stale ? " is-stale" : ""}${ai.working ? " is-ai-working" : ""}${kind && FIXED_KINDS.has(kind) ? " is-fixed" : ""}`}
          tabIndex={-1}
          onKeyDown={onCanvasKey}
          onKeyUp={(e) => {
            if (e.key.startsWith("Arrow")) endNudge();
          }}
          onBlur={endNudge}
          onCopy={onClipboardCopy}
          onCut={onClipboardCopy}
          onPaste={onClipboardPaste}
          onPointerDownCapture={(e) => {
            startGroupGesture(e);
            if (e.isPropagationStopped()) return;
            pressForMember(e.target);
            startTopicGesture(e);
            startSeqGesture(e);
          }}
          onContextMenuCapture={(e) => {
            // F9: a right-click on a group's title opens the group's own menu, not the canvas's.
            const t = e.target instanceof Element ? e.target : null;
            const title = t?.closest(".flow-area-name");
            const name = title?.closest(".flow-area")?.getAttribute("aria-label")?.replace(/^Group /, "");
            if (!name || !kind || !GROUP_WORD[kind]) return;
            e.preventDefault();
            e.stopPropagation();
            openGroupMenu(name, { x: e.clientX, y: e.clientY });
          }}
          onClickCapture={(e) => {
            if (!swallowClick.current) return;
            swallowClick.current = false;
            e.stopPropagation();
          }}
          onPointerMove={(e) => {
            pointer.current = { x: e.clientX, y: e.clientY };
            // The shape under the pointer shows its handles; on a handle it stays, elsewhere they go after a moment.
            const t = e.target instanceof Element ? e.target : null;
            // N3: over a group's title the cursor says it can be renamed by a double-click (draw.io's text cursor).
            const onTitle = !!t?.closest(".react-flow__pane") && !t.closest(".react-flow__node") && !!instance.current && groupTitleAt(instance.current.screenToFlowPosition({ x: e.clientX, y: e.clientY })) !== null;
            if (canvasEl.current && canvasEl.current.classList.contains("is-on-group-title") !== onTitle) canvasEl.current.classList.toggle("is-on-group-title", onTitle);
            if (t?.closest(".flow-hot")) hot.keep();
            else {
              const id = t?.closest(".react-flow__node")?.getAttribute("data-id");
              if (id && !isArea(id)) hot.set(id);
              else hot.leave();
            }
          }}
          onPointerLeave={() => {
            pointer.current = null;
            hot.leave();
          }}
        >
          <FlowResizeContext.Provider value={resize}>
          <FlowFitContext.Provider value={ai.locked ? null : doc.unsize}>
          <LineEndsContext.Provider value={ai.locked ? null : reattach}>
          <KindEditContext.Provider value={kindEditCtx}>
          <FlowGroupSelContext.Provider value={groupSel}>
          <DiagramCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={FLOW_NODE_TYPES}
            edgeTypes={FLOW_EDGE_TYPES}
            connectionMode="loose"
            // A timeline has no lines between items: its order is the dates.
            onConnectPorts={kind === "timeline" ? undefined : (from, to) => void connect(from, to)}
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
            selection={selected}
            lineSelection={lines}
            onLineSelect={setLines}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onContextMenu={openMenu}
            // F3: a double-click edits on the shape what is under the pointer (board DiagramEditInPlace): a label, a
            // class member's row or a new row in the card's empty space (CL1), an item's date (T1), a group's title (C1).
            onNodeDoubleClick={(n, target) => editAt(n, target ?? null)}
            // A double-click on the empty canvas offers the kind's shapes there.
            onPaneDoubleClick={kind && quickItems(kind).length > 0 ? paneDoubleClick : undefined}
            minimapJump
            boxSelect
            livePositions={glide}
            // The first shape the assistant just added comes into view, so its ring is seen (P11-34).
            reveal={firstOf(airing)}
            onInit={(i) => {
              instance.current = i;
            }}
            overlay={
              <CanvasOverlay store={overlay}>
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
                      // C1: the new group drawn around its shapes before its name is kept.
                      <div className="flow-group-new" aria-hidden="true" style={{ left: `${fieldAt.box.x}px`, top: `${fieldAt.box.y}px`, width: `${fieldAt.box.w}px`, height: `${fieldAt.box.h}px` }} />
                    )}
                    {field.kind === "new" && !graph.nodes.some((g) => g.id === GHOST_ID) && (
                      // Step 6: the new shape as a ghost, and its line from the source, until its name is kept.
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
                        void (field.kind === "label"
                          ? rename(field, v, how)
                          : field.kind === "new"
                            ? commitNew(field, v, how)
                            : field.kind === "newloop" || field.kind === "newsection" || field.kind === "loop"
                              ? commitFrame(field, v, how)
                              : commitGroup(field, v, how))
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
                {labelBox && labelAt && (
                  // A line's label on the line, a message's on its own row (S3), with the in-place editor's rules.
                  <InlineEdit
                    key={`${labelBox.version}:${labelBox.index}`}
                    value={labelBox.initial}
                    label={kind === "sequence" ? "Message label" : "Flow label"}
                    placeholder={labelBox.fresh ? "Type a label, Enter to keep" : "label"}
                    wrapClassName="flow-rename-inline flow-label-inline"
                    style={{ left: `${labelAt.x - 85}px`, top: `${labelAt.y}px`, width: "170px" }}
                    fresh={labelBox.fresh}
                    onCommit={(v, how) => void finishLabel(labelBox, v, how)}
                    onCancel={() => {
                      setLabelBox(null);
                      canvasEl.current?.focus();
                    }}
                  />
                )}
              </CanvasOverlay>
            }
          >
            {kind && (
              <FlowToolbar
                kind={kind}
                look={look}
                onAdd={(t) => void (t.kind === "group" ? groupSelected() : add(t))}
                onLook={doc.setStyle}
                onTidy={() => void tidy()}
                tidySelection={selected.length >= 2}
                onShape={(shape) => runShape(shape)}
                shapeDisabled={shapeDisabled}
                onMermaid={onMermaid && kind ? () => onMermaid({ kind, file: name, run: insertMermaid }) : undefined}
                onOpenAsDbml={kind === "er" && onOpenModel ? openDbml : undefined}
              />
            )}
            {ai.working && (
              <div className="flow-aipres" role="status">
                <span className="live" aria-hidden="true" />
                {`AI is editing ${drawn?.title || name}`}
              </div>
            )}
            {stale && parsed?.errorLine != null && (
              <div className="flow-stale" role="status">
                <Icon name="alert" size={14} />
                {staleBanner(parsed.errorLine)}
              </div>
            )}
            {kind && parsed?.result.doc && parsed.result.doc.nodes.length === 0 && !newItemOpen && tools[0] && (
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
                Or type <code>{FIRST_LINE[kind]}</code> on line {firstFreeLine(parsed.text)}
              </p>
            )}
          </DiagramCanvas>
          </FlowGroupSelContext.Provider>
          </KindEditContext.Provider>
          </LineEndsContext.Provider>
          </FlowFitContext.Provider>
          </FlowResizeContext.Provider>
          <CanvasToast note={note} />
          {groupAsk !== null && askAt && (
            <GroupAsk key={groupAsk} title={`Delete ${groupWord().toLowerCase()} ${groupAsk}?`} counts={askAt.counts} at={askAt.at} onAnswer={answerAsk} />
          )}
          {quick && kind && <QuickAdd kind={kind} at={quick.screen} onPick={(t) => void addAndConnect(t)} onCancel={cancelQuick} />}
          {paneAdd && kind && !quick && (
            // Step 6: "Add here", the kind's shapes at the double-click (draw.io); the pick lands there, its name ready.
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
      {menu && (
        <PlacedMenu
          menu={menu}
          onClose={() => {
            setMenu(null);
            // A menu opened from the keyboard gives focus back to the canvas (Shift+F10, I5).
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
            onSave={(e) => void saveNodeEdit(e)}
            onCancel={() => setEditingNode(null)}
          />,
          document.body,
        )}
      {publishing && (
        <PublishDialog
          scene={publishing.scene}
          fileName={name}
          selected={selected}
          onScreen={publishing.onScreen}
          onClose={() => setPublishing(null)}
          onSaved={() => setPublishing(null)}
          onTheme={(t) => void repaintPublishIcons(t)}
        />
      )}
    </div>
  );
}
