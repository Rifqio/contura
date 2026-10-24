// The diagram tab (spec 6+ section 3, frames 6+.2 to 6+.5): the .flow text on the left (420 px) and the drawing
// on the right. Selecting a node bands its line; clicking a line selects its node. Adds, connects, renames and
// deletes on the canvas rewrite the text through the worker's edits; moves, the look and the direction write
// only the layout file. One undo history covers both. Closing the tab frees the worker's state for it.
// Editing motion (spec section 4): drags show their landing cell and guides and settle on release, drawn flows
// lock onto nodes and take a label or "Add and connect", groups take a dropped node, Tidy and undo glide.
import { defaultKeymap, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { type Diagnostic as CmDiagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, lineNumbers, WidgetType } from "@codemirror/view";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { type ClipboardEvent, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon, { type IconName } from "../components/Icon";
import DiagramCanvas, { type CanvasMenuAt } from "../diagram/DiagramCanvas";
import { PlacedMenu, type PlacedMenuState } from "./DiagramMenu";
import { type AlignHow, columnMenuItems, lineMenuItems, paneMenuItems, selectionMenuItems, shapeMenuItems } from "./canvasMenus";
import { useFlowAssistMode, useFlowSidePanel } from "../prefs/usePrefs";
import SidePanel from "./SidePanel";
import DiagramAssistant from "./ai/DiagramAssistant";
import { useDiagramAsk } from "./ai/useDiagramAsk";
import { acceptLabel } from "./ai/ProposalCard";
import NodeEditor, { type NodeEdit, nodeEditOps } from "./NodeEditor";
import PublishDialog from "../diagram/export/PublishDialog";
import type { Box as SceneBox, Scene } from "../diagram/export/scene";
import { type MotionKey, motionMs } from "../diagram/motion";
import { routeOrthogonal } from "../diagram/route";
import type { Port } from "../diagram/types";
import type { Positions } from "../diagram/layout";
import CanvasToast from "./interactions/CanvasToast";
import { makeConnectionLine } from "./interactions/ConnectionLine";
import { type Box, groupAt, linkBox, magnetTarget, type Point } from "./interactions/geometry";
import InlineEdit, { type CommitHow } from "./interactions/InlineEdit";
import LabelBox from "./interactions/LabelBox";
import { ER_MESSAGES, ER_TYPES, ErCanvasContext, splitRow, useErCanvas } from "./erCanvas";
import { hitRow, joinRefusal, keyOf, type PickTarget, pickTargets, planReference, planRelationship, portColumn, RELATE_MESSAGES, type RelatePlan } from "./erRelate";
import { createErScrollStore, createErSoleStore, ErScrollContext, ErSoleContext } from "./erScroll";
import { CanvasOverlay, createOverlayStore } from "./interactions/overlay";
import QuickAdd, { quickItems } from "./interactions/QuickAdd";
import { glideFrames } from "./interactions/glide";
import { afterPaint, easeExit, tween } from "./interactions/tween";
import type { LivePositions } from "../diagram/livePositions";
import type { NodeState } from "./nodes/parts";
import type { TextEdit } from "../lang/protocol";
import { type FlowEditOp, LINK_NOTES, type LinkRef, linkRefOf } from "../lang/flow/edits";
import { copyLines, nonEmptyLines, TOO_MANY_LINES } from "../lang/flow/clip";
import { type ColumnFlag, COLUMN_FLAGS, isColumnName, MAX_FLOW_NODES, overTextLimit, sqlFreeName } from "../lang/flow/model";
import type { FlowPasteOp } from "../lang/flow/service";
import { readClipboard, writeClipboard } from "../grid/clipboard";
import { appLang } from "../lang/appLang";
import { insertionLine } from "../lang/insertionLine";
import { editorTheme } from "../lang/editorTheme";
import { editingBasics } from "../lang/editingBasics";
import type { LangClient } from "../lang/client";
import { flowLanguageWith } from "../lang/flow/cm";
import { defaultArrow, type DiagramKind, FIXED_KINDS, type FlowArrow, type FlowDoc, type FlowNode, type FlowNodeKind, STATE_END, STATE_START } from "../lang/flow/model";
import type { FlowProblem } from "../lang/flow/problems";
import { staleBanner } from "../lang/flow/problems";
import { buildFlowGraph, drawnKind, FLOW_EDGE_TYPES, FLOW_NODE_TYPES, type FlowEdgeData, FlowFitContext, FlowResizeContext, groupBoxes, layoutInput, LineEndsContext, nodeSize, rowRoute } from "./flowNodes";
import { ER_CARD_CHROME, KIND_ROW } from "./kindLayout";
import { kindStyle } from "./nodes/parts";
import FlowToolbar, { ADD_TOOLS, type AddTool, firstNodeHint } from "./FlowToolbar";
import { emptyPositions, type FlowDirection } from "./layout";
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
  weak: "Weak entity",
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
    return `${node.kind === "weak" ? "Weak entity" : "Table"}, ${plural(node.rows?.length ?? 0, "column")}, ${plural(lines, "relationship")}`;
  }
  return `${NODE_WORD[node.kind]}, ${plural(lines, kind === "dfd" ? "flow" : "line")}`;
}

/** The strip's words while "Add relationship to..." waits for the table. */
const linkNotice = (table: string) => `Click the table ${table} refers to. Esc cancels.`;

/** A line's end as the strip names it: a state diagram's `[*]` markers are its start and end. */
const endName = (n: string) => (n === STATE_START ? "Start" : n === STATE_END ? "End" : n);

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

/** The first item of a set, or null when it is empty. */
const firstOf = (set: ReadonlySet<string>): string | null => set.values().next().value ?? null;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "5 nodes, 5 flows" (frame 6+.2), "6 shapes, 7 lines" (6+.4), "9 services" (6+.5). */
function countsOf(kind: DiagramKind, doc: FlowDoc): string {
  if (kind === "dfd") return `${plural(doc.nodes.length, "node")}, ${plural(doc.links.length, "flow")}`;
  if (kind === "flow") return `${plural(doc.nodes.length, "shape")}, ${plural(doc.links.length, "line")}`;
  if (kind === "cloud") return plural(doc.nodes.length, "service");
  // Step 12 kinds: their own nouns (the start and end markers and the indent branches are not counted).
  const shown = doc.nodes.filter((n) => n.name !== STATE_START && n.name !== STATE_END).length;
  const drawn = doc.links.filter((l) => !l.tree).length;
  if (kind === "er") return `${plural(shown, "entity", "entities")}, ${plural(drawn, "relationship")}`;
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
let lastClip: { text: string; diagram: string; at: Positions; pastes: number; column?: boolean } | null = null;

/** The text of a typing field, where the clipboard keys are the field's own. */
const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

const isArea = (id: string) => id.startsWith("\u0000");
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
  if (data?.fromRow === undefined) return routeOrthogonal(ab, bb).mid;
  return rowRoute(ab, bb, data.fromRow, data.toRow ?? -1, e.source === e.target, scroll(e.source), scroll(e.target)).mid;
}
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
  er: "customers [entity]",
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
}

/** True when the line up to `pos` ends with `icon:` (the colon just typed) inside an open bracket list. */
export function atIconSlot(text: string, pos: number): boolean {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(start, pos);
  return /(?:\[|,)\s*icon:$/.test(before) && before.lastIndexOf("[") > before.lastIndexOf("]");
}

function FlowEditor({ initialText, doc, client, bandLines, ghost, onLineClick, onIconSlot, onHistory }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ onLineClick, onIconSlot, onHistory });
  latest.current = { onLineClick, onIconSlot, onHistory };

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
}

export default function FlowTab({ name, client: given, active = true, onOpenSettings }: Props) {
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
  /** The selected lines, by edge id (F1); a new drawing lets them go, as their indexes may name other links. */
  const [lines, setLines] = useState<string[]>([]);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const [bandLines, setBandLines] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Item 22: the node whose name and details are being edited, and where its panel sits. */
  const [editingNode, setEditingNode] = useState<{ name: string; at: { left: number; top: number }; problem: string | null } | null>(null);
  /** Item 23: a double-click on empty canvas offers the kind's shapes there. */
  const [paneAdd, setPaneAdd] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null);
  /** The canvas's right-click menu (item 20), at the pointer. */
  const [menu, setMenu] = useState<PlacedMenuState | null>(null);
  /** An ER table's "Add relationship to...": the next table picked gets the relationship from it (draw.io's connect mode). */
  const [linking, setLinkingState] = useState<string | null>(null);
  const linkingRef = useRef<string | null>(null);
  const setLinking = (from: string | null) => {
    linkingRef.current = from;
    setLinkingState(from);
  };
  /**
   * A pick on the canvas while "Add relationship to..." is on: another single table gets the relationship (one
   * edit); a pick of anything else ends the mode (draw.io's connect mode). True when the pick made the line.
   */
  const pickWhileLinking = (ids: readonly string[]): boolean => {
    const from = linkingRef.current;
    if (from === null) return false;
    if (ids.length === 1 && ids[0] === from) return false;
    setLinking(null);
    setNotice(null);
    if (ids.length !== 1 || !isTableNameRef.current(ids[0])) return false;
    void connectRef.current({ node: from, port: "" }, { node: ids[0], port: "" });
    return true;
  };
  /**
   * Fix round 2, I1: "Make a relationship from here" (board ER interactions): the column it starts from, and where
   * the keyboard is among every column (arrows or Tab move, Enter picks). It lives as long as its prompt, as
   * "Add relationship to..." does.
   */
  const [relPick, setRelPickState] = useState<{ from: { table: string; column: string }; at: number } | null>(null);
  const relPickRef = useRef(relPick);
  const setRelPick = (p: typeof relPick) => {
    relPickRef.current = p;
    setRelPickState(p);
  };
  /**
   * The pick's keys (fix rounds 3 and 4): arrows or Tab move the aim, Enter picks, Esc leaves. They are taken on the
   * window before anything else, but only from this tab's drawing pane, or from the page itself when the WebView
   * left focus nowhere after the menu closed; a key from a dialog, the tree, a select or anything else outside the
   * pane goes on untouched (N1). A text field or a menu inside the pane keeps its own keys.
   */
  useEffect(() => {
    if (!relPick) return;
    const inPane = (t: EventTarget | null) => t instanceof Node && !!paneEl.current?.contains(t);
    const onKey = (e: globalThis.KeyboardEvent) => {
      const p = relPickRef.current;
      if (!p || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (!(t === document.body || inPane(t))) return;
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.closest?.('[role="menu"]'))) return;
      const targets = pickTargetsRef.current();
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey) ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 0;
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
        if (canvasEl.current && document.activeElement !== canvasEl.current) canvasEl.current.focus();
      };
      if (step !== 0 && targets.length > 0) {
        take();
        const at = p.at < 0 ? (step > 0 ? 0 : targets.length - 1) : (p.at + step + targets.length) % targets.length;
        setRelPick({ ...p, at });
      } else if (e.key === "Enter") {
        take();
        const c = p.at >= 0 ? targets[p.at] : undefined;
        if (c) finishPick(c.table, c.column);
        // Nothing aimed yet: the strip says what to do, and the pick stays (N6).
        else setRelPick({ ...p, at: -2 });
      } else if (e.key === "Escape") {
        take();
        setRelPick(null);
        setNotice(null);
      }
    };
    // Focus going outside the pane (a dialog, the tree, a field elsewhere) ends the pick, as a menu does (N1).
    const onFocus = (e: FocusEvent) => {
      const t = e.target;
      if (!relPickRef.current || t === document.body || inPane(t) || (t instanceof Element && t.closest('[role="menu"]'))) return;
      setRelPick(null);
      setNotice(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("focusin", onFocus, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("focusin", onFocus, true);
    };
  }, [relPick !== null]);
  /** The pick lands on a column, or on a table's header or body for its key; the relationship follows the drop rules. */
  const finishPick = (table: string, column: string | null) => {
    const p = relPickRef.current;
    if (!p) return;
    setRelPick(null);
    void relateRef.current(p.from.table, p.from.column, { table, column });
  };
  const relateRef = useRef<(table: string, column: string, to: { table: string; column: string | null }) => Promise<void>>(async () => {});
  /** This tab's drawing pane: the pick's keys come from inside it only (N1). */
  const paneEl = useRef<HTMLElement>(null);
  /** The pick's places, built once per pick and again only when the drawing changes (N3). */
  const pickTargetsRef = useRef<() => PickTarget[]>(() => []);
  const isTableNameRef = useRef<(n: string) => boolean>(() => false);
  const pickWhileLinkingRef = useRef(pickWhileLinking);
  const connectRef = useRef<(from: Port, to: Port) => Promise<void>>(async () => {});
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
  /** Why the F2 field's last commit was refused (a taken name); the field stays open. */
  const [renameError, setRenameErrorText] = useState<string | null>(null);
  /** Counts refusals, so the same reason again still brings focus back into the field. */
  const [renameTries, setRenameTries] = useState(0);
  const setRenameError = (text: string | null) => {
    setRenameErrorText(text);
    if (text) setRenameTries((n) => n + 1);
  };

  /** How far each ER card's rows are scrolled, so lines to its rows follow them (fix round 1). */
  const erScroll = useMemo(() => createErScrollStore(), []);
  const erScrollRef = useRef(erScroll);
  /** The one table selected alone, whose column ports show (fix round 2, I5). */
  const erSole = useMemo(() => createErSoleStore(), []);
  // ER build A: tables and columns are edited in place on their cards.
  // The pick's places for this pick and this drawing (N3): built once, not on every render or key.
  const pickFrom = relPick?.from ?? null;
  const pickList = useMemo(() => (pickFrom && drawn ? pickTargets(drawn, pickFrom) : []), [pickFrom, drawn]);
  pickTargetsRef.current = () => pickList;
  const relAim = relPick && relPick.at >= 0 ? (pickList[relPick.at] ?? null) : null;
  // The aim the cards draw keeps its identity while it stays on one place, so the ER context stays still (N3).
  const aimTable = relAim?.table ?? null;
  const aimIndex = relAim?.index ?? null;
  const relAimKey = useMemo(() => (aimTable === null || aimIndex === null ? null : { table: aimTable, index: aimIndex }), [aimTable, aimIndex]);
  viewOf.current = () => doc.view() ?? null;
  useEffect(() => {
    if (noticeDoc.current !== null && viewOf.current()?.state.doc !== noticeDoc.current) {
      noticeDoc.current = null;
      setNoticeState(null);
    }
  }, [parsed]);
  const er = useErCanvas({
    doc: () => parsedRef.current?.result.doc ?? drawnRef.current,
    run: (op) => doc.run(op),
    locked: () => aiLock.current,
    stale: () => staleRef.current,
    readOnly: ai.locked,
    onRenamed: (old, next) => {
      // Its rows stay scrolled where they were (fix round 2, M8).
      erScrollRef.current.move(old, next);
      if (hasOwn(doc.layout.nodes, old)) doc.place({ [next]: doc.layout.nodes[old] }, true);
      setSelected([next]);
    },
    onPick: (table) => {
      pickWhileLinking([table]);
      setSelected((prev) => (prev.length === 1 && prev[0] === table ? prev : [table]));
    },
    selection: () => selectedRef.current,
    notice: setNotice,
    intercept: (table, index) => {
      if (!relPickRef.current) return false;
      const row = index === null ? undefined : drawnRef.current?.nodes.find((n) => n.name === table)?.rows?.[index];
      finishPick(table, row === undefined ? null : splitRow(row).name);
      return true;
    },
    aim: relAimKey,
    refocus: () => canvasEl.current?.focus(),
    copy: (text) => {
      lastClip = { text, diagram: name, at: emptyPositions(), pastes: 0, column: true };
      expectCopy(text);
    },
  });
  const erSync = er.syncSelection;
  useEffect(() => erSole.set(selected.length === 1 ? selected[0] : null), [selected, erSole]);
  useEffect(() => erSync(selected), [selected, erSync]);

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
  /**
   * ER build C: a relationship's label edited in place (erd-ux-research 5.4), with the in-card editor's rules: Enter
   * keeps it, Esc leaves it, and a refusal keeps the field open with what was typed. The line is named by its ref.
   */
  /**
   * ER build C (erd-ux-research 5.7): the table a double-click on the empty canvas is adding. It is not in the text
   * until its name is kept, so Esc leaves nothing behind and no undo step (draw.io, board ER interactions).
   */
  const [newTable, setNewTable] = useState<{ at: Point; name: string; error?: string; tries?: number } | null>(null);
  const [relLabel, setRelLabel] = useState<{ edge: string; ref: LinkRef; initial: string; at: Point | null; error?: string; tries?: number } | null>(null);
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
  // A column being added grows its table by one row, so the new row is not scrolled out of sight.
  const growing = er.edit?.kind === "draft" ? er.edit.table : null;
  const graph = useMemo(() => {
    if (!shown) return { nodes: [], edges: [] };
    if (FIXED_KINDS.has(shown.kind)) return buildFlowGraph(shown, layout.nodes, look, { states: shownStates, fresh: freshEdge, marks });
    const placed = shown.nodes.filter((n) => hasOwn(layout.nodes, n.name));
    return buildFlowGraph(placed.length === shown.nodes.length ? shown : { ...shown, nodes: placed }, layout.nodes, look, {
      states: shownStates,
      fresh: freshEdge,
      sizes: layout.sizes,
      marks,
      ...(growing !== null ? { grow: { [growing]: 1 } } : {}),
    });
  }, [shown, layout.nodes, layout.sizes, look, shownStates, freshEdge, marks, growing]);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  /**
   * Publish: the drawing as it is now (the last one that worked while the text has an error), in its look, with
   * the cloud icons it uses loaded from the pack and embedded as images (ruling P9).
   */
  async function openPublish() {
    // Publish is another action: a pick ends with no write (N1).
    if (relPickRef.current !== null) {
      setRelPick(null);
      setNotice(null);
    }
    const d = drawnRef.current;
    if (!d) return;
    const { nodes, style } = layoutRef.current;
    const icons = await loadSceneIcons(sceneIconNames(d));
    let onScreen: SceneBox = { x: 0, y: 0, w: 0, h: 0 };
    const r = canvasEl.current?.getBoundingClientRect();
    const f = instance.current;
    if (r && f && r.width > 0 && r.height > 0) {
      const a = f.screenToFlowPosition({ x: r.x, y: r.y });
      const b = f.screenToFlowPosition({ x: r.x + r.width, y: r.y + r.height });
      onScreen = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    }
    setPublishing({ scene: flowScene(d, nodes, style, icons), onScreen });
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

  // A line names a link by its index in one drawing: a new drawing lets the selected lines go.
  useEffect(() => setLines((prev) => (prev.length === 0 ? prev : [])), [drawn]);

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
      // A pick in the text never makes the relationship: it ends the mode (I3).
      if (relPickRef.current !== null) {
        setRelPick(null);
        setNotice(null);
      }
      if (linkingRef.current !== null) {
        setLinking(null);
        setNotice(null);
      }
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
    pickWhileLinkingRef.current(nodes);
    // A pick of nothing or of several ends "Make a relationship from here"; one table's press is the card's to take.
    if (relPickRef.current && nodes.length !== 1) {
      setRelPick(null);
      setNotice(null);
    }
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
      const alone = groupBoxes(d.groups, withMe);
      const rest = new Map(groupBoxes(d.groups, without).map((g) => [g.name, g]));
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
        void doc.run({ op: "moveToGroup", name: d.lead, group: target }, { move: snapped }).then((r) => {
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
    const s = nodeSize(drawnKind(kindOfNode), look, nodeName);
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

  async function add(tool: AddTool, at?: Point): Promise<string | undefined> {
    if (aiLock.current) return;
    if (!kind || tool.kind === "group") return;
    const before = kind === "sequence" && at ? participantAfter(at) : undefined;
    let nodeKind: FlowNodeKind = tool.kind === "terminal" ? "start" : tool.kind;
    let base = tool.base;
    if (tool.kind === "terminal" && drawnRef.current?.nodes.some((n) => n.kind === "start")) {
      nodeKind = "end";
      base = "End";
    }
    const id = nextId(drawnRef.current, nodeKind);
    setNotice(null);
    const r = await doc.run({
      op: "addNode",
      name: base,
      kind: kind === "cloud" ? null : nodeKind,
      ...(id ? { attrs: { id } } : {}),
      unique: true,
      ...(before !== undefined ? { before } : {}),
    });
    if (!r?.name) return;
    doc.place({ [r.name]: at ? { x: snap(at.x), y: snap(at.y) } : viewCentre(nodeKind, r.name) }, true);
    enter(r.name);
    setSelected([r.name]);
    // A new service gets its icon next (frame 6+.5, "from the toolbar"); Esc leaves it without one.
    if (kind === "cloud") openPicker(r.name);
    return r.name;
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
   * Group (cloud): a new group around the selected services, in the group they share, as one batch (one undo
   * entry): the group's lines, then each service moved in.
   */
  async function groupSelected() {
    if (aiLock.current) return;
    setNotice(null);
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    const names = known ? selectedRef.current.filter((n) => known.nodes.some((x) => x.name === n)) : [];
    if (!known || names.length === 0) {
      setNotice("Select the services to group first.");
      return;
    }
    const parents = new Set(names.map((n) => parentOf(known.groups, n)));
    const parent = parents.size === 1 ? [...parents][0] : null;
    const group = freeName("Group", namesOf(known));
    const r = await doc.run({
      op: "batch",
      ops: [{ op: "addGroup", name: group, group: parent }, ...names.map((n) => ({ op: "moveToGroup" as const, name: n, group }))],
    });
    // Nothing written: the text no longer has a selected service, or the name was taken meanwhile.
    if (!r) setNotice("Couldn't group these services. Fix the text first.");
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

  /** Enter keeps the label (one edit), Esc leaves the flow as it is. Planned only on the box's own parse. */
  async function finishLabel(box: LabelBoxState, keep: boolean, text: string) {
    if (aiLock.current) return;
    setLabelBox((cur) => (cur === box ? null : cur));
    const label = text.trim();
    if (!keep || label === box.initial) return;
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
    const ref = d.kind === "er" ? linkRefOf(d.links, index) : null;
    if (ref) setRelLabel({ edge: id, ref, initial: l.label ?? "", at: edgeMid(graphRef.current, id, erScrollRef.current.get) });
    else setLabelBox({ index, version: p.result.version, from: l.from, to: l.to, initial: l.label ?? "", fresh: false });
  }, []);

  /** A double-click on the empty ER canvas: a new table at the pointer (its header's middle under it), on whole pixels. */
  function addTableAt(p: { flow: Point }) {
    // Said, not silent, as every other ER gesture under the lock (fix round 2, M4).
    if (aiLock.current) {
      setNotice(ER_MESSAGES.lockedAdd);
      return;
    }
    if (staleRef.current) {
      setNotice(ER_MESSAGES.stale);
      return;
    }
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    setNotice(null);
    setSelected([]);
    setLines([]);
    setNewTable({ at: { x: Math.round(p.flow.x - 92), y: Math.round(p.flow.y - 16) }, name: sqlFreeName("table", known ? namesOf(known) : [], 1) });
  }

  /** The new table's name is kept: its line and its place are one edit; Enter or Tab goes on to its first column. */
  async function commitNewTable(e: NonNullable<typeof newTable>, value: string, how: CommitHow) {
    const refuse = (error: string) => setNewTable((cur) => (cur === e ? { ...e, name: value, error, tries: (e.tries ?? 0) + 1 } : cur));
    if (aiLock.current) return refuse(ER_MESSAGES.locked);
    if (staleRef.current) return refuse(ER_MESSAGES.stale);
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    const taken = known?.nodes.some((n) => n.name.toLowerCase() === value.toLowerCase());
    const bad = !value ? ER_MESSAGES.tableNeedsName : !isColumnName(value) ? ER_MESSAGES.plainName : taken ? ER_MESSAGES.tableTaken(value) : "";
    if (bad) return refuse(bad);
    let why: string | null = null;
    const r = await doc.run({ op: "addNode", name: value, kind: "entity" }, { move: { [value]: e.at }, onRefused: (w) => (why = w) });
    if (!r) return refuse(why ?? ER_MESSAGES.changed);
    setNewTable((cur) => (cur === e ? null : cur));
    setSelected([value]);
    if (how === "enter" || how === "tab") er.value.firstColumn(value);
    else if (how !== "blur") canvasEl.current?.focus();
  }

  /** The relationship label's field closes: a key sends focus back to the canvas; a refusal keeps it open with why. */
  async function commitRelLabel(e: NonNullable<typeof relLabel>, value: string, how: CommitHow) {
    const refuse = (error: string) => setRelLabel((cur) => (cur === e ? { ...e, error, tries: (e.tries ?? 0) + 1 } : cur));
    if (aiLock.current) return refuse(ER_MESSAGES.locked);
    const label = value.trim();
    const close = () => {
      setRelLabel((cur) => (cur === e ? null : cur));
      if (how !== "blur") canvasEl.current?.focus();
    };
    if (label === e.initial) return close();
    setNotice(null);
    let why: string | null = null;
    const r = await doc.run({ op: "setLinkLabel", index: -1, link: e.ref, label: label || null }, { onRefused: (w) => (why = w) });
    if (!r) return refuse(why ?? ER_MESSAGES.changed);
    close();
  }

  // Where the relationship label's field sits: the middle of its line, as the chip is drawn. A line gone from the
  // drawing meanwhile leaves the field where it was, with what was typed.
  const relLabelAt = useMemo(() => (relLabel ? (edgeMid(graph, relLabel.edge, erScroll.get) ?? relLabel.at) : null), [relLabel, graph, erScroll]);

  async function connect(from: Port, to: Port, at?: Point) {
    if (aiLock.current) return;
    setNotice(null);
    clearDrawGhost();
    // ER build C: a drag from a column's port joins columns (a loop on its own table included).
    const fromColumn = kind === "er" ? portColumn(from.port) : null;
    if (fromColumn !== null) {
      const column = portColumn(to.port);
      // Where it was let go decides (a row, the header, or nothing), never a port React Flow snapped to from bounds
      // that rows may have scrolled under since (fix round 2, I6). Let go off every card, the port it reached stands.
      if (at) return relateAt(from.node, fromColumn, at, column !== null ? { table: to.node, column } : null);
      return relate(from.node, fromColumn, { table: to.node, column });
    }
    // A drag from a table's own port onto another table, or "Add relationship to...": a new column that refers to
    // its key (the board's "refers to"; rulings 1 and 1b).
    if (kind === "er" && from.node !== to.node && isTableNameRef.current(from.node) && isTableNameRef.current(to.node)) {
      return reference(from.node, to.node);
    }
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
    if (r) void openLabel(from.node, to.node, r.at);
  }

  /**
   * ER build C (erd-ux-research 5.4, decision 4): the relationship a column's drag makes, at once, with the
   * cardinality the keys give; one batch, so one undo step. The strip says what was made, or why nothing was.
   */
  async function relate(table: string, column: string, to: { table: string; column: string | null }) {
    const known = parsedRef.current?.result.doc;
    if (staleRef.current || !known) {
      setNotice(ER_MESSAGES.stale);
      return;
    }
    await runPlan(planRelationship(known, { table, column }, to));
  }

  /** A drag from table `from`'s own port onto table `to`: the key column that refers to `to`, and its line. */
  async function reference(from: string, to: string) {
    const known = parsedRef.current?.result.doc;
    if (staleRef.current || !known) {
      setNotice(ER_MESSAGES.stale);
      return;
    }
    await runPlan(planReference(known, from, to));
  }

  async function runPlan(plan: RelatePlan) {
    if ("refuse" in plan) {
      setNotice(plan.refuse);
      return;
    }
    let why: string | null = null;
    const r = await doc.run(plan.ops.length === 1 ? plan.ops[0] : { op: "batch", ops: plan.ops }, { onRefused: (w) => (why = w) });
    if (r) setNotice(plan.message, true);
    else setNotice(why ?? ER_MESSAGES.changed);
  }

  /** A column's drag let go at `at`: on a table's row joins that column, on its header adds the key column, else nothing. */
  function relateAt(table: string, column: string, at: Point, snapped: { table: string; column: string } | null = null) {
    const d = parsedRef.current?.result.doc ?? drawnRef.current;
    const nodes = graphRef.current.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (isArea(n.id)) continue;
      const b = boxOfNode(n);
      if (at.x < b.x || at.x > b.x + b.w || at.y < b.y || at.y > b.y + b.h) continue;
      const t = d?.nodes.find((x) => x.name === n.id && (x.kind === "entity" || x.kind === "weak"));
      const hit = t ? hitRow(t, b.y, at.y, erScroll.get(n.id)) : null;
      if (hit) return relate(table, column, hit);
      setNotice(RELATE_MESSAGES.nowhere);
      return;
    }
    if (snapped) return relate(table, column, snapped);
    setNotice(RELATE_MESSAGES.nowhere);
  }

  /** A flow released on empty canvas: within 24 px of a node it goes there; else "Add and connect" opens. */
  function onConnectRelease(from: Port, at: Point) {
    clearDrawGhost();
    if (isArea(from.node)) return;
    const fromColumn = kind === "er" ? portColumn(from.port) : null;
    if (fromColumn !== null) {
      if (!aiLock.current) void relateAt(from.node, fromColumn, at);
      return;
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
    await addConnectedAt(q.from, q.at, tool);
  }

  /** A new shape of `tool`'s kind with its left side at `at` (centred on it), and the line from `from` to it, as one edit. */
  async function addConnectedAt(from: string, at: Point, tool: AddTool) {
    if (aiLock.current || !kind || tool.kind === "group") return;
    setNotice(null);
    const q = { from, at };
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    let nodeKind: FlowNodeKind = tool.kind === "terminal" ? "start" : tool.kind;
    let base = tool.base;
    if (tool.kind === "terminal" && known?.nodes.some((n) => n.kind === "start")) {
      nodeKind = "end";
      base = "End";
    }
    // An ER table's free name is a plain SQL name (table_2), the one rule every other path uses (I4).
    const taken = known ? namesOf(known) : new Set<string>();
    const name = kind === "er" ? sqlFreeName(base, taken) : freeName(base, taken);
    const id = nextId(drawnRef.current, nodeKind);
    const r = await doc.run({
      op: "batch",
      ops: [
        { op: "addNode", name, kind: kind === "cloud" ? null : nodeKind, ...(id ? { attrs: { id } } : {}) },
        { op: "addLink", from: q.from, to: name, arrow: defaultArrow(kind) },
      ],
    });
    if (!r) return;
    const s = nodeSize(drawnKind(nodeKind), look, name, id);
    doc.place({ [name]: { x: snap(q.at.x), y: snap(q.at.y - s.h / 2) } }, true);
    enter(name);
    void openLabel(q.from, name, r.at);
  }

  /** F2's field on the shape: a key or a click away keeps the name; a taken one stays open with why (F4, I1). */
  async function rename(old: string, next: string, how: CommitHow) {
    // Never dropped: under the Assistant's lock the field stays open with what was typed (I6).
    if (aiLock.current) {
      setRenameError(ER_MESSAGES.locked);
      return;
    }
    setNotice(null);
    const target = next.trim();
    // Left by a key: focus back on the canvas, so F2 or Delete work at once (I4).
    const back = () => {
      if (how !== "blur") canvasEl.current?.focus();
    };
    if (!target || target === old) {
      setRenaming(null);
      back();
      return;
    }
    const taken = await doc.linesOf([target]);
    if (taken && taken[target] != null) {
      // The field stays open with the reason, a click away included; only Escape discards (I1).
      setNotice(`${target} is already used.`);
      setRenameError(`${target} is already used.`);
      return;
    }
    const r = await doc.run({ op: "renameNode", old, next: target });
    // A refused write keeps the field open with the reason (I6).
    if (!r) {
      setRenameError(ER_MESSAGES.changed);
      return;
    }
    setRenaming(null);
    back();
    if (hasOwn(doc.layout.nodes, old)) doc.place({ [target]: doc.layout.nodes[old] }, true);
    setSelected([target]);
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
    const unmark = () =>
      setStates((prev) => {
        const next = new Map(prev);
        for (const n of names) if (next.get(n) === "leaving") next.delete(n);
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
      const ops: FlowEditOp[] = [...indexes.map((index) => ({ op: "deleteLink" as const, index })), ...names.map((n) => ({ op: "deleteNode" as const, name: n }))];
      const ms = names.length > 0 ? motionMs("exit") : 0;
      if (ms > 0) {
        setStates((prev) => {
          const next = new Map(prev);
          for (const n of names) next.set(n, "leaving");
          return next;
        });
        await new Promise((r) => {
          deleteTimer.current = setTimeout(r, ms);
        });
      }
      const r = await doc.run(ops.length === 1 ? ops[0] : { op: "batch", ops }, { version: planned.result.version });
      if (r) {
        setSelected([]);
        setLines([]);
        if (linesLeft) setNotice("The selected lines were left: fix the text first, the drawing is the last one without errors.");
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
    if (kind === "er" && (await pasteColumn(text))) return true;
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
  function pasteFromKeys(text: string) {
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

  /**
   * I4: one ER column's line pasted on a selected table becomes its column, after the selected column or at the end,
   * named `name_copy` when the name is taken (as Ctrl+Enter). False when the text is not one column line.
   */
  async function pasteColumn(text: string): Promise<boolean> {
    const m = /^([^\s.][^.\n]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]+([^\[\n]*?))?[ \t]*(?:\[([^\]\n]*)\])?[ \t]*$/.exec(text.trim());
    const d = parsedRef.current?.result.doc;
    if (!m || !d) return false;
    // A column line of a table this diagram has, or a column copied on the canvas (of any diagram's table); text
    // that only has a dot in it (example.com) is not one (N1).
    const isTable = (n: FlowNode) => n.kind === "entity" || n.kind === "weak";
    const copied = !!lastClip?.column && lastClip.text.trim() === text.trim();
    if (!copied && !d.nodes.some((n) => n.name === m[1] && isTable(n))) return false;
    const sel = selectedRef.current;
    const table = sel.length === 1 ? d.nodes.find((n) => n.name === sel[0] && isTable(n)) : undefined;
    if (!table) {
      setNotice("Select a table to paste the column into.");
      return true;
    }
    const rows = (table.rows ?? []).map((r) => splitRow(r).name);
    const lower = new Set(rows.map((r) => r.toLowerCase()));
    let col = m[2];
    if (lower.has(col.toLowerCase())) {
      col = `${m[2]}_copy`;
      for (let n = 2; lower.has(col.toLowerCase()); n++) col = `${m[2]}_copy${n}`;
    }
    const flags = (m[4] ?? "")
      .split(",")
      .map((f) => f.trim().toLowerCase().split(/\s+/).join(" "))
      .filter((f): f is ColumnFlag => (COLUMN_FLAGS as readonly string[]).includes(f));
    const picked = er.value.selected;
    const at = picked && picked.table === table.name ? picked.index + 1 : rows.length;
    const r = await doc.run({ op: "addColumn", table: table.name, at, before: rows[at] ?? null, name: col, type: (m[3] ?? "").trim(), flags });
    if (!r) setNotice(`Couldn't add ${col} to ${table.name}. Fix the text first.`);
    return true;
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
    void pasteFromKeys(e.clipboardData.getData("text/plain"));
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
  /** F2 edits the one selected shape's name on the shape: an ER table in its header, any other in place. */
  function startRename(node: string) {
    if (aiLock.current) return;
    if (kind === "er" && drawnRef.current?.nodes.some((n) => n.name === node && (n.kind === "entity" || n.kind === "weak"))) {
      er.value.editTable(node);
      return;
    }
    setRenameError(null);
    setRenaming(node);
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
   * Shift+F10 and the Menu key (Windows): the menu of what is selected, at it: several selected, one shape (an ER
   * column when one is picked), one line, else the canvas at the middle of the view (I5).
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
      const col = er.value.selected;
      if (col && col.table === sel[0]) er.value.pointColumn(col.table, col.index);
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
    // A selected ER column takes Enter, F2, Ctrl+Enter, Delete, K and N first (erd-ux-research 5.8), and the
    // clipboard keys: Ctrl+C and Ctrl+X copy or cut the column's line, Ctrl+D duplicates it (I4).
    if (kind === "er" && er.onKey(e, selectedRef.current)) return;
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
      }
      return;
    }
    if (e.altKey) return;
    // Esc leaves "Add relationship to..." first.
    if (e.key === "Escape" && linking !== null) {
      e.preventDefault();
      setLinking(null);
      setNotice(null);
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
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (nudge && selectedRef.current.length > 0 && drawnRef.current && !FIXED_KINDS.has(drawnRef.current.kind)) {
      e.preventDefault();
      const step = e.shiftKey ? 16 : 1;
      if (!e.repeat) endNudge();
      const after = emptyPositions();
      for (const n of selectedRef.current) {
        const p = drawnAt(n);
        if (p) after[n] = { x: p.x + nudge[0] * step, y: p.y + nudge[1] * step };
      }
      if (!nudging.current) {
        const before = emptyPositions();
        for (const n of Object.keys(after)) before[n] = drawnAt(n)!;
        nudging.current = { before, after };
      } else nudging.current.after = { ...nudging.current.after, ...after };
      doc.place(after, true);
      return;
    }
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
    }
  };

  /** Writes a shape's line at the end of the text, selected, with focus in the text, ready to fill in. */
  function writeTemplate(template: string) {
    if (aiLock.current) return;
    const v = doc.view();
    if (!v) return;
    const text = v.state.doc.toString();
    const lead = text === "" || text.endsWith("\n") ? "" : "\n";
    const from = text.length + lead.length;
    v.dispatch({ changes: { from: text.length, insert: `${lead}${template}\n` }, selection: { anchor: from, head: from + template.length }, scrollIntoView: true, userEvent: "input" });
    v.focus();
  }

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
    const r = await doc.run(ops.length === 1 ? ops[0] : { op: "batch", ops });
    if (!r) return setEditingNode({ ...open, problem: "The text changed meanwhile. Try again." });
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

  /** Moves the text to an ER table's column line (its `index`-th `table.` line) and gives it focus. */
  async function showColumn(table: string, index: number) {
    // A column line comes after its table's own line; a stray one above it is an error, not a row (M8).
    const own = (await doc.linesOf([table]))?.[table];
    const v = doc.view();
    if (!v || typeof own !== "number") return;
    let n = 0;
    for (let i = own + 1; i <= v.state.doc.lines; i++) {
      const line = v.state.doc.line(i);
      if (!line.text.trimStart().startsWith(`${table}.`)) continue;
      if (n++ < index) continue;
      v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      v.focus();
      return;
    }
  }

  /** A line's arrow or direction from its menu: one text edit, one undo step. */
  /**
   * A line op on the line `link` names (its ends, label and which of those it is, taken when the menu opened or the
   * end was dropped), never an index into a drawing that may be stale (I1). While the text has an error, or when the
   * line is gone, nothing changes and the strip says why (I2); an op that changes nothing says nothing.
   */
  function editLine(link: LinkRef | null, op: { op: "setLinkArrow"; arrow: FlowArrow } | { op: "reverseLink" } | { op: "setLinkEnd"; end: "from" | "to"; node: string }) {
    if (aiLock.current || !link) return;
    setNotice(null);
    if (!parsedRef.current?.result.doc) {
      setNotice(LINK_NOTES.broken);
      return;
    }
    void doc.run({ ...op, link }, { onRefused: (why) => setNotice(why) });
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

  const isTableName = (n: string) => kind === "er" && !!drawnRef.current?.nodes.some((x) => x.name === n && (x.kind === "entity" || x.kind === "weak"));
  isTableNameRef.current = isTableName;
  connectRef.current = connect;
  relateRef.current = relate;
  pickWhileLinkingRef.current = pickWhileLinking;

  // "Add relationship to..." lives as long as its notice: any action that clears or replaces it ends the mode (I3).
  useEffect(() => {
    if (linking !== null && notice !== linkNotice(linking)) setLinking(null);
    if (relPick !== null && notice !== RELATE_MESSAGES.pick) setRelPick(null);
  }, [notice, linking, relPick]);
  // A tab put behind another ends it too.
  useEffect(() => {
    if (!active && relPickRef.current !== null) {
      setRelPick(null);
      setNotice(null);
    }
    if (!active && linkingRef.current !== null) {
      setLinking(null);
      // Its prompt goes with it (N2).
      setNotice(null);
    }
  }, [active]);

  /** Item 20, ER step 2.4 and diagram step 4: a right-click offers what is under the pointer first. */
  function openMenu(at: CanvasMenuAt) {
    if (aiLock.current || !kind) return;
    // A menu is another action: "Make a relationship from here" and "Add relationship to..." end.
    if (relPickRef.current !== null) {
      setRelPick(null);
      setNotice(null);
    }
    if (linkingRef.current !== null) {
      setLinking(null);
      setNotice(null);
    }
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
      const table = isTableName(node);
      const column = table ? er.takeMenuColumn(node) : null;
      if (kept && count > 1) return selectionMenu(count);
      if (table && column) {
        const t = d?.nodes.find((n) => n.name === node);
        const row = t?.rows?.[column.index];
        if (row === undefined) return;
        const { index } = column;
        place(
          `${node}.${splitRow(row).name} actions`,
          columnMenuItems({
            flags: t?.rowFlags?.[index] ?? [],
            blocked: er.value.blocked(node),
            rename: () => er.value.editColumn(node, index, "name"),
            editType: () => er.value.editColumn(node, index, "type"),
            toggle: (flag) => er.value.toggleFlag(node, index, flag),
            insert: (where) => er.value.addColumn(node, where === "above" ? index : index + 1),
            duplicate: () => er.value.duplicateColumn(node, index),
            relate: () => {
              // Nothing is aimed until a key is pressed; the first key aims the first or last place (fix round 3).
              setRelPick({ from: { table: node, column: splitRow(row).name }, at: -1 });
              setNotice(RELATE_MESSAGES.pick);
              // The keyboard goes on from the canvas, however the menu was chosen.
              requestAnimationFrame(() => canvasEl.current?.focus());
            },
            showInText: () => void showColumn(node, index),
            remove: () => er.value.deleteColumn(node, index),
          }),
        );
        return;
      }
      const lined = kind === "dfd" || kind === "flow" || kind === "cloud" || kind === "state" || kind === "class";
      place(
        `${node} actions`,
        shapeMenuItems({
          kind,
          table,
          sized: !!layoutRef.current.sizes && hasOwn(layoutRef.current.sizes, node),
          connect: lined ? tools.filter((t) => t.kind !== "group") : [],
          service: kind === "cloud",
          rename: () => startRename(node),
          details: () => editNode(node),
          addColumn: () => er.value.addColumn(node),
          addRelationship: () => {
            setLinking(node);
            setNotice(linkNotice(node));
          },
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
        }),
      );
      return;
    }
    place(
      "Canvas actions",
      paneMenuItems({
        kind,
        tools,
        empty: names.length === 0,
        drawn: !!d,
        // Add table here opens the new table's name (erd-ux-research 5.6).
        add: (t) =>
          void add(t, at.flow).then((made) => {
            if (made && kind === "er") er.value.editTable(made);
          }),
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
  const flowsOf = (n: string) => drawn?.links.filter((l) => l.from === n || l.to === n).length ?? 0;
  const errors = (parsed?.result.problems ?? []).filter((p) => p.severity === "error");
  const counted = parsed?.result.doc ?? drawn;

  // The selected nodes' lines, and the new flow's line while its label box is open.
  const newLine = labelBox?.fresh ? labelBox.line : undefined;
  const shownBands = useMemo(() => [...bandLines, ...aiBands, ...(newLine === undefined ? [] : [newLine])], [bandLines, aiBands, newLine]);

  // The label box sits on the middle of its flow's middle run, once both ends are drawn.
  const labelAt = useMemo(() => {
    if (!labelBox) return null;
    const a = graph.nodes.find((n) => n.id === labelBox.from);
    const b = graph.nodes.find((n) => n.id === labelBox.to);
    return a && b ? routeOrthogonal(lineBoxOf(a), lineBoxOf(b)).mid : null;
  }, [labelBox, graph]);

  // F2's field sits over the shape's middle, as wide as the shape.
  const renameAt = useMemo(() => {
    if (renaming === null) return null;
    const n = graph.nodes.find((g) => g.id === renaming);
    if (!n) return null;
    const b = boxOfNode(n);
    return { x: b.x, y: b.y + b.h / 2, w: Math.max(b.w, 120) };
  }, [renaming, graph]);

  // The types offered while an ER column's type is typed: the common ones, then those the diagram uses.
  const erTypes = useMemo(() => {
    if (kind !== "er" || !drawn) return ER_TYPES;
    const out = new Set(ER_TYPES);
    for (const n of drawn.nodes) for (const r of n.rows ?? []) if (splitRow(r).type) out.add(splitRow(r).type);
    return [...out];
  }, [kind, drawn]);

  /** F8: a line's end let go at `at`: onto the shape there (within the 24 px magnet), as one edit; elsewhere nothing. */
  const reattach = useCallback(
    (edge: string, end: "from" | "to", at: Point) => {
      const index = linkIndex(edge);
      if (aiLock.current || index === null) return;
      if (reattachColumnRef.current(index, end, at)) return;
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

  /**
   * Fix round 1 (ruling 5): an ER relationship between columns keeps the rules of a new drop when an end is dragged.
   * On a column it joins that column; on a header, that table's key; a table with no key, or its body below the
   * rows, leaves the end on the whole table and the strip says so. Away from every card it goes back. True when
   * the line was such a relationship.
   */
  function reattachColumn(index: number, end: "from" | "to", at: Point): boolean {
    const drawnNow = drawnRef.current;
    const link = drawnNow?.links[index];
    if (!drawnNow || drawnNow.kind !== "er" || !link || (link.fromColumn === undefined && link.toColumn === undefined)) return false;
    const nodes = graphRef.current.nodes;
    let card: { t: FlowNode; box: Box } | null = null;
    for (let i = nodes.length - 1; i >= 0 && !card; i--) {
      const n = nodes[i];
      const b = boxOfNode(n);
      if (isArea(n.id) || at.x < b.x || at.x > b.x + b.w || at.y < b.y || at.y > b.y + b.h) continue;
      const t = drawnNow.nodes.find((x) => x.name === n.id && (x.kind === "entity" || x.kind === "weak"));
      if (t) card = { t, box: b };
    }
    if (!card) return true;
    const known = parsedRef.current?.result.doc;
    setNotice(null);
    if (staleRef.current || !known) {
      setNotice(LINK_NOTES.broken);
      return true;
    }
    const hit = hitRow(card.t, card.box.y, at.y, erScroll.get(card.t.name));
    let column: string | undefined;
    let whole: string | null = null;
    if (hit && hit.column !== null) column = hit.column;
    else if (hit) {
      const key = keyOf(card.t);
      if (key) column = key.name;
      else whole = RELATE_MESSAGES.wholeTable(card.t.name, "key");
    } else whole = RELATE_MESSAGES.wholeTable(card.t.name, "body");
    const other = end === "from" ? { table: link.to, column: link.toColumn } : { table: link.from, column: link.fromColumn };
    if (column !== undefined && other.column !== undefined) {
      const why = joinRefusal(known, { table: card.t.name, column }, { table: other.table, column: other.column }, index);
      if (why) {
        setNotice(why);
        return true;
      }
    }
    const ref = linkRefOf(drawnNow.links, index);
    if (!ref) return true;
    void doc.run({ op: "setLinkEnd", link: ref, end, node: card.t.name, ...(column !== undefined ? { column } : {}) }, { onRefused: (w) => setNotice(w) }).then((r) => {
      if (r && whole) setNotice(whole, true);
    });
    return true;
  }
  const reattachColumnRef = useRef(reattachColumn);
  reattachColumnRef.current = reattachColumn;

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
        // Esc anywhere in the tab, the text included, ends "Add relationship to...".
        if (e.key === "Escape" && linkingRef.current !== null) {
          setLinking(null);
          setNotice(null);
        }
        if (e.key === "Escape" && relPickRef.current !== null) {
          e.preventDefault();
          setRelPick(null);
          setNotice(null);
        }
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

      <section ref={paneEl} className="schema-island flow-pane-draw" aria-label={`${name}.flow drawing`}>
        <div className="schema-pane-head flow-strip">
          {/* While a pick is on the strip is about the pick: its prompt and its aim, with room for both (fix round 4). */}
          {relPick ? null : labelBox?.fresh ? (
            <span className="flow-selchip">{`New flow: ${labelBox.from} to ${labelBox.to}`}</span>
          ) : one ? (
            <>
              <span className="flow-selchip">
                {NODE_ICON[one.kind] && <Icon name={NODE_ICON[one.kind]!} size={14} />}
                {one.attrs.id && <span className="flow-selchip-id">{one.attrs.id}</span>}
                <span>{one.name}</span>
              </span>
              <span className="flow-quiet">{selectionWords(kind, one, flowsOf(one.name))}</span>
              {one.kind === "service" && (
                <button ref={chooseIcon} type="button" className="button button-small button-quiet" onClick={() => openPicker(one.name)}>
                  Choose icon
                </button>
              )}
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
          {relPick && relPick.at === -1 && (
            // Before anything is aimed the strip says how to leave; the prompt keeps to one line at 1024 px (fix round 4).
            <span className="flow-quiet flow-aim">Esc cancels.</span>
          )}
          {relPick && relPick.at === -2 && (
            <span className="flow-quiet flow-aim" aria-live="polite">
              Aim first with the arrow keys.
            </span>
          )}
          {relAim && (
            // What Enter links to while a pick is aimed (fix round 3), read out as it moves.
            <span className="flow-quiet flow-aim" aria-live="polite">
              {relAim.column === null ? `Aim: key of ${relAim.table}` : `Aim: ${relAim.table}.${relAim.column}`}
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
          className={`flow-canvas${stale ? " is-stale" : ""}${ai.working ? " is-ai-working" : ""}`}
          tabIndex={-1}
          onKeyDown={onCanvasKey}
          onKeyUp={(e) => {
            if (e.key.startsWith("Arrow")) endNudge();
          }}
          onBlur={endNudge}
          onCopy={onClipboardCopy}
          onCut={onClipboardCopy}
          onPaste={onClipboardPaste}
          onPointerMove={(e) => {
            pointer.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerLeave={() => {
            pointer.current = null;
          }}
        >
          <FlowResizeContext.Provider value={resize}>
          <FlowFitContext.Provider value={ai.locked ? null : doc.unsize}>
          <LineEndsContext.Provider value={ai.locked ? null : reattach}>
          <ErCanvasContext.Provider value={kind === "er" ? er.value : null}>
          <ErScrollContext.Provider value={erScroll}>
          <ErSoleContext.Provider value={erSole}>
          <DiagramCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={FLOW_NODE_TYPES}
            edgeTypes={FLOW_EDGE_TYPES}
            connectionMode="loose"
            // A timeline has no lines between items: its order is the dates.
            onConnectPorts={kind === "timeline" ? undefined : (from, to, _shift, at) => void connect(from, to, at)}
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
            // An ER card takes its own double-clicks: the part under the pointer is the intent (ER build A).
            onNodeDoubleClick={(n) => {
              if (kind !== "er") editNode(n);
            }}
            // A double-click on the empty ER canvas adds a table there at once (erd-ux-research 5.7); other kinds offer their shapes.
            onPaneDoubleClick={kind === "er" ? addTableAt : kind && quickItems(kind).length > 0 ? setPaneAdd : undefined}
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
                {renaming !== null && renameAt && (
                  <InlineEdit
                    key={renaming}
                    value={renaming}
                    label={`Rename ${renaming}`}
                    wrapClassName="flow-rename-inline"
                    style={{ left: `${renameAt.x}px`, top: `${renameAt.y}px`, width: `${renameAt.w}px` }}
                    error={renameError}
                    errorKey={renameTries}
                    onCommit={(v, how) => void rename(renaming, v, how)}
                    onCancel={() => {
                      setRenaming(null);
                      canvasEl.current?.focus();
                    }}
                  />
                )}
                {newTable && (
                  <div
                    className={`fnode fnode-kind fnode-erTable fnode-${look} fnode-selected fkind-new-table`}
                    role="group"
                    aria-label="New table"
                    style={{ ...kindStyle("erTable"), left: `${newTable.at.x}px`, top: `${newTable.at.y}px`, width: "184px", height: `${ER_CARD_CHROME + KIND_ROW}px` }}
                  >
                    <span className="fkind-inside">
                      <span className="fkind-head">
                        <Icon name="table" size={14} />
                        <InlineEdit
                          key="new-table"
                          value={newTable.name}
                          label="Table name"
                          className="fkind-ed fkind-ed-head"
                          error={newTable.error ?? null}
                          errorKey={newTable.tries}
                          onCommit={(v, how) => void commitNewTable(newTable, v, how)}
                          onCancel={() => {
                            setNewTable(null);
                            canvasEl.current?.focus();
                          }}
                        />
                      </span>
                      <div className="fkind-er-body">
                        <ul className="fkind-rows fkind-er-rows">
                          <li className="fkind-row fkind-er-row is-new" style={{ height: KIND_ROW }}>
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
                {relLabel && relLabelAt && (
                  <InlineEdit
                    key={relLabel.edge}
                    value={relLabel.initial}
                    label="Relationship label"
                    placeholder="label"
                    wrapClassName="flow-rename-inline"
                    style={{ left: `${relLabelAt.x - 80}px`, top: `${relLabelAt.y}px`, width: "160px" }}
                    error={relLabel.error ?? null}
                    errorKey={relLabel.tries}
                    onCommit={(v, how) => void commitRelLabel(relLabel, v, how)}
                    onCancel={() => {
                      setRelLabel(null);
                      canvasEl.current?.focus();
                    }}
                  />
                )}
                {labelBox && labelAt && (
                  <LabelBox
                    key={`${labelBox.version}:${labelBox.index}`}
                    at={labelAt}
                    initial={labelBox.initial}
                    onDone={(keep, text) => void finishLabel(labelBox, keep, text)}
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
                onShape={(shape) => {
                  if (shape.tool) void (shape.tool.kind === "group" ? groupSelected() : add(shape.tool));
                  else if (shape.template) writeTemplate(shape.template);
                }}
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
            {kind && parsed?.result.doc && parsed.result.doc.nodes.length === 0 && tools[0] && (
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
            {kind && parsed?.result.doc && parsed.result.doc.nodes.length === 0 && (
              <p className="flow-first-node-line">
                Or type <code>{FIRST_LINE[kind]}</code> on line {firstFreeLine(parsed.text)}
              </p>
            )}
          </DiagramCanvas>
          </ErSoleContext.Provider>
          </ErScrollContext.Provider>
          </ErCanvasContext.Provider>
          </LineEndsContext.Provider>
          </FlowFitContext.Provider>
          </FlowResizeContext.Provider>
          {kind === "er" && (
            <datalist id="er-types">
              {erTypes.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          )}
          <CanvasToast note={note} />
          {quick && kind && <QuickAdd kind={kind} at={quick.screen} onPick={(t) => void addAndConnect(t)} onCancel={cancelQuick} />}
          {paneAdd && kind && !quick && (
            <QuickAdd
              kind={kind}
              at={paneAdd.screen}
              onPick={(t) => {
                const at = paneAdd.flow;
                setPaneAdd(null);
                void add(t, at);
              }}
              onCancel={() => setPaneAdd(null)}
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
        />
      )}
    </div>
  );
}
