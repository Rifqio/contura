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
import type { Node, ReactFlowInstance } from "@xyflow/react";
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon, { type IconName } from "../components/Icon";
import DiagramCanvas, { type CanvasMenuAt } from "../diagram/DiagramCanvas";
import type { MenuItem } from "../components/Menu";
import { PlacedMenu, type PlacedMenuState } from "./DiagramMenu";
import NodeEditor, { type NodeEdit, nodeEditOps } from "./NodeEditor";
import PublishDialog from "../diagram/export/PublishDialog";
import type { Box as SceneBox, Scene } from "../diagram/export/scene";
import { type MotionKey, motionMs } from "../diagram/motion";
import { routeOrthogonal } from "../diagram/route";
import type { Port } from "../diagram/types";
import type { Positions } from "../diagram/layout";
import CanvasToast from "./interactions/CanvasToast";
import { makeConnectionLine } from "./interactions/ConnectionLine";
import { type Box, ghostCell, groupAt, guidesFor, linkBox, magnetTarget, type Point, snapTo } from "./interactions/geometry";
import LabelBox from "./interactions/LabelBox";
import { CanvasOverlay, createOverlayStore } from "./interactions/overlay";
import QuickAdd, { quickItems } from "./interactions/QuickAdd";
import { glideFrames } from "./interactions/glide";
import { afterPaint, easeExit, tween } from "./interactions/tween";
import type { LivePositions } from "../diagram/livePositions";
import type { NodeState } from "./nodes/parts";
import type { TextEdit } from "../lang/protocol";
import { appLang } from "../lang/appLang";
import { insertionLine } from "../lang/insertionLine";
import type { LangClient } from "../lang/client";
import { flowLanguageWith } from "../lang/flow/cm";
import { defaultArrow, type DiagramKind, FIXED_KINDS, type FlowDoc, type FlowNode, type FlowNodeKind, STATE_END, STATE_START } from "../lang/flow/model";
import type { FlowProblem } from "../lang/flow/problems";
import { staleBanner } from "../lang/flow/problems";
import { buildFlowGraph, drawnKind, FLOW_EDGE_TYPES, FLOW_NODE_TYPES, FlowResizeContext, groupBoxes, layoutInput, nodeSize } from "./flowNodes";
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

const snap = snapTo;

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
}

/** True when the line up to `pos` ends with `icon:` (the colon just typed) inside an open bracket list. */
export function atIconSlot(text: string, pos: number): boolean {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(start, pos);
  return /(?:\[|,)\s*icon:$/.test(before) && before.lastIndexOf("[") > before.lastIndexOf("]");
}

function FlowEditor({ initialText, doc, client, bandLines, ghost, onLineClick, onIconSlot }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ onLineClick, onIconSlot });
  latest.current = { onLineClick, onIconSlot };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          insertionLine(),
          bandField,
          ghostField,
          lintGutter(),
          doc.extensions,
          flowLanguageWith(client, doc.docId),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ "aria-label": "Diagram text" }),
          EditorView.updateListener.of((u) => {
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
}

export default function FlowTab({ name, client: given }: Props) {
  const client = given ?? appLang().client;
  const doc = useFlowDoc(name, client);
  const { parsed, layout } = doc;
  const drawn = parsed?.drawn ?? null;
  const kind: DiagramKind | null = parsed?.result.kind ?? drawn?.kind ?? (doc.initialText !== null ? kindOfText(doc.initialText) : null);
  const look = layout.style;
  const stale = !!parsed && parsed.result.doc === null && drawn !== null;

  const [selected, setSelected] = useState<string[]>([]);
  const [bandLines, setBandLines] = useState<number[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Item 22: the node whose name and details are being edited, and where its panel sits. */
  const [editingNode, setEditingNode] = useState<{ name: string; at: { left: number; top: number }; problem: string | null } | null>(null);
  /** Item 23: a double-click on empty canvas offers the kind's shapes there. */
  const [paneAdd, setPaneAdd] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null);
  /** The canvas's right-click menu (item 20), at the pointer. */
  const [menu, setMenu] = useState<PlacedMenuState | null>(null);
  /** Why the last canvas action did nothing, in the strip; cleared by the next action. */
  const [notice, setNotice] = useState<string | null>(null);
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

  // Nodes with no position yet are placed by dagre in the worker, in the layout's direction.
  // Every node it asks about gets a position (the worker's, else a row below the drawing), so it never asks twice.
  useEffect(() => {
    // A sequence, mind map or timeline is laid out from its text every time; it keeps no positions.
    if (!drawn || FIXED_KINDS.has(drawn.kind)) return;
    const has = (n: string) => hasOwn(layout.nodes, n);
    if (drawn.nodes.every((n) => has(n.name))) return;
    const input = layoutInput(drawn, look);
    const existing = emptyPositions();
    for (const n of drawn.nodes) if (has(n.name)) existing[n.name] = layout.nodes[n.name];
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
      doc.place(out);
    };
    client.layout({ ...input, existing, rankdir: layout.direction }).then(place, () => place(null));
    return () => {
      live = false;
    };
  }, [drawn, look, layout.nodes, layout.direction, client, doc.place]);

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
  const graph = useMemo(() => {
    if (!drawn) return { nodes: [], edges: [] };
    if (FIXED_KINDS.has(drawn.kind)) return buildFlowGraph(drawn, layout.nodes, look, { states, fresh: freshEdge });
    const placed = drawn.nodes.filter((n) => hasOwn(layout.nodes, n.name));
    return buildFlowGraph(placed.length === drawn.nodes.length ? drawn : { ...drawn, nodes: placed }, layout.nodes, look, {
      states,
      fresh: freshEdge,
      sizes: layout.sizes,
    });
  }, [drawn, layout.nodes, layout.sizes, look, states, freshEdge]);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  /**
   * Publish: the drawing as it is now (the last one that worked while the text has an error), in its look, with
   * the cloud icons it uses loaded from the pack and embedded as images (ruling P9).
   */
  async function openPublish() {
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

  // Each frame of a drag: the dashed landing cell, the 4 px guides, and the group it would join.
  const onDrag = useCallback(
    (id: string, x: number, y: number) => {
      if (isArea(id)) return;
      const d = drag.current ?? (drag.current = startDrag(id));
      if (id !== d.lead) {
        d.moving.add(id);
        return;
      }
      const at = { x, y, ...d.size };
      const cell = ghostCell(at);
      const guides = guidesFor(
        cell,
        d.others.filter((o) => !d.moving.has(o.id)).map((o) => o.box),
      );
      const hot = d.moving.size === 1 ? groupAt(centre(at), d.groups) : null;
      overlay.set({ ghost: cell, guides, hot: hot === null ? null : (d.groups.find((g) => g.name === hot)?.box ?? null) });
    },
    [overlay, startDrag],
  );

  // A drag reports each moved node at once: they are one move, one undo entry. Released, the nodes settle into
  // their grid cells; a node let go over another group joins it, and outside its own leaves it (one entry too).
  const pendingMove = useRef<Positions | null>(null);
  const flushMove = useCallback(() => {
    const p = pendingMove.current;
    pendingMove.current = null;
    const d = drag.current;
    drag.current = null;
    overlay.set({ ghost: null, guides: [], hot: null });
    if (!p) return;
    const snapped = emptyPositions();
    for (const k of Object.keys(p)) snapped[k] = { x: snap(p[k].x), y: snap(p[k].y) };
    const ids = Object.keys(p);
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
    (id: string, x: number, y: number) => {
      if (id.startsWith("\u0000")) return;
      // Released: the landing cell and guides go at once.
      overlay.set({ ghost: null, guides: [], hot: null });
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

  async function add(tool: AddTool, at?: Point) {
    if (!kind || tool.kind === "group") return;
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
    });
    if (!r?.name) return;
    doc.place({ [r.name]: at ? { x: snap(at.x), y: snap(at.y) } : viewCentre(nodeKind, r.name) }, true);
    enter(r.name);
    setSelected([r.name]);
    // A new service gets its icon next (frame 6+.5, "from the toolbar"); Esc leaves it without one.
    if (kind === "cloud") openPicker(r.name);
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
    if (!p) return;
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
    setLabelBox((cur) => (cur === box ? null : cur));
    const label = text.trim();
    if (!keep || label === box.initial) return;
    await doc.run({ op: "setLinkLabel", index: box.index, label: label || null }, { version: box.version });
  }

  /** A double-clicked flow's label, in the box: only on the drawing of the current text. */
  const onEdgeDoubleClick = useCallback((id: string) => {
    const p = parsedRef.current;
    const d = p?.result.doc;
    if (!p || !d || !id.startsWith("edge:")) return;
    const index = Number(id.slice("edge:".length));
    const l = d.links[index];
    if (l) setLabelBox({ index, version: p.result.version, from: l.from, to: l.to, initial: l.label ?? "", fresh: false });
  }, []);

  async function connect(from: Port, to: Port) {
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
    if (r) void openLabel(from.node, to.node, r.at);
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
    const q = quickRef.current;
    setQuick(null);
    stopPull.current();
    overlay.set({ pending: null });
    if (!q || !kind || tool.kind === "group") return;
    setNotice(null);
    const known = parsedRef.current?.result.doc ?? drawnRef.current;
    let nodeKind: FlowNodeKind = tool.kind === "terminal" ? "start" : tool.kind;
    let base = tool.base;
    if (tool.kind === "terminal" && known?.nodes.some((n) => n.kind === "start")) {
      nodeKind = "end";
      base = "End";
    }
    const name = freeName(base, known ? namesOf(known) : new Set());
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

  async function rename(old: string, next: string) {
    setRenaming(null);
    setNotice(null);
    const target = next.trim();
    if (!target || target === old) return;
    const taken = await doc.linesOf([target]);
    if (taken && taken[target] != null) {
      setNotice(`${target} is already used.`);
      return;
    }
    const r = await doc.run({ op: "renameNode", old, next: target });
    if (!r) return;
    if (hasOwn(doc.layout.nodes, old)) doc.place({ [target]: doc.layout.nodes[old] }, true);
    setSelected([target]);
  }

  /**
   * One Delete is one edit list and one undo entry, all or nothing (ruling P16). The nodes and their lines fade
   * out first (120 ms exit), then the text loses them; at once with motion off. The edit is planned on the parse
   * of the text as it was when Delete was pressed, so a change during the fade makes it do nothing (ruling P20).
   */
  async function removeSelected() {
    setNotice(null);
    const names = selectedRef.current;
    if (names.length === 0 || deleting.current) return;
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
      const ms = motionMs("exit");
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
      const r = await doc.run(
        names.length === 1 ? { op: "deleteNode", name: names[0] } : { op: "batch", ops: names.map((n) => ({ op: "deleteNode" as const, name: n })) },
        { version: planned.result.version },
      );
      if (r) {
        setSelected([]);
        // The fade lets go once the next parse lands, whatever it holds: an undo before it, or a faded drawing
        // that still has the node, must not leave it drawn invisible.
        await doc.current();
      }
      unmark();
    } finally {
      deleting.current = false;
    }
  }

  /**
   * Every node glides to its laid-out place (answer 4A, 240 ms). With two or more nodes selected only they are
   * laid out, kept where the selection's top left corner was. One move, one undo entry; the text is unchanged.
   */
  async function tidy() {
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
  const onCanvasKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
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
      }
      return;
    }
    if (e.altKey) return;
    if (e.key === "Escape" && selectedRef.current.length > 0) {
      e.preventDefault();
      setSelected([]);
      return;
    }
    // Item 23: the arrow keys nudge the selection a grid cell (Shift: a quarter of one), one undo entry a press.
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (nudge && selectedRef.current.length > 0 && drawnRef.current && !FIXED_KINDS.has(drawnRef.current.kind)) {
      e.preventDefault();
      const step = e.shiftKey ? 4 : 16;
      const after = emptyPositions();
      for (const n of selectedRef.current) {
        const p = drawnAt(n);
        if (p) after[n] = { x: p.x + nudge[0] * step, y: p.y + nudge[1] * step };
      }
      doc.move(after);
      return;
    }
    if (e.key === "F2") {
      if (selectedRef.current.length === 1) {
        e.preventDefault();
        setRenaming(selectedRef.current[0]);
      }
      return;
    }
    if (e.key === "Delete") {
      if (selectedRef.current.length > 0) {
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

  /** Item 20: right-click on the canvas gives its actions; on a node, that node's (frame Diagram, menus). */
  function openMenu(at: CanvasMenuAt) {
    const names = drawnRef.current?.nodes.map((n) => n.name) ?? [];
    if (at.node !== null && !isArea(at.node) && names.includes(at.node)) {
      const node = at.node;
      if (!selectedRef.current.includes(node)) setSelected([node]);
      const many = selectedRef.current.includes(node) && selectedRef.current.length > 1;
      const items: MenuItem[] = [
        { key: "details", label: "Edit name and details...", icon: <Icon name="edit" />, disabled: many, onSelect: () => editNode(node) },
        { key: "rename", label: "Rename", icon: <Icon name="edit" />, shortcut: "F2", disabled: many, onSelect: () => setRenaming(node) },
        { key: "text", label: "Show in the text", icon: <Icon name="fileCode" />, onSelect: () => void showInText(node) },
        {
          key: "delete",
          label: many ? `Delete ${selectedRef.current.length} nodes` : "Delete",
          icon: <Icon name="trash" />,
          shortcut: "Delete",
          danger: true,
          separatorBefore: true,
          onSelect: () => void removeSelected(),
        },
      ];
      setMenu({ x: at.screen.x, y: at.screen.y, label: `${node} actions`, items });
      return;
    }
    const adders: MenuItem[] = tools
      .filter((t) => t.kind !== "group")
      .map((t) => ({ key: `add:${t.label}`, label: t.label, icon: <Icon name={t.icon} />, shortcut: t.key, onSelect: () => void add(t, at.flow) }));
    const items: MenuItem[] = [
      ...adders,
      { key: "all", label: "Select all", icon: <Icon name="select" />, separatorBefore: true, disabled: names.length === 0, onSelect: () => setSelected(names) },
      { key: "tidy", label: "Tidy", icon: <Icon name="tidy" />, disabled: names.length === 0, onSelect: () => void tidy() },
      { key: "fit", label: "Zoom to fit", icon: <Icon name="fit" />, shortcut: "Shift+1", onSelect: at.fit },
      { key: "publish", label: "Publish image...", icon: <Icon name="image" />, separatorBefore: true, disabled: !drawnRef.current, onSelect: () => void openPublish() },
    ];
    setMenu({ x: at.screen.x, y: at.screen.y, label: "Canvas actions", items });
  }

  const nodeOf = (n: string): FlowNode | undefined => drawn?.nodes.find((x) => x.name === n);
  const one = selected.length === 1 ? nodeOf(selected[0]) : undefined;
  const flowsOf = (n: string) => drawn?.links.filter((l) => l.from === n || l.to === n).length ?? 0;
  const errors = (parsed?.result.problems ?? []).filter((p) => p.severity === "error");
  const counted = parsed?.result.doc ?? drawn;

  // The selected nodes' lines, and the new flow's line while its label box is open.
  const newLine = labelBox?.fresh ? labelBox.line : undefined;
  const shownBands = useMemo(() => (newLine === undefined ? bandLines : [...bandLines, newLine]), [bandLines, newLine]);

  // The label box sits on the middle of its flow's middle run, once both ends are drawn.
  const labelAt = useMemo(() => {
    if (!labelBox) return null;
    const a = graph.nodes.find((n) => n.id === labelBox.from);
    const b = graph.nodes.find((n) => n.id === labelBox.to);
    return a && b ? routeOrthogonal(lineBoxOf(a), lineBoxOf(b)).mid : null;
  }, [labelBox, graph]);

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
    <div className="flow-tab">
      <section className="schema-island flow-pane-text" aria-label={`${name}.flow text`}>
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
            <span className="schema-pane-saved flow-save-failed" role="alert" title={doc.save.message}>
              Not saved: {doc.save.message}
            </span>
          )}
        </div>
        <div className="schema-text">
          {doc.initialText !== null && (
            <FlowEditor
              initialText={doc.initialText}
              doc={doc}
              client={client}
              bandLines={shownBands}
              ghost={ghost}
              onLineClick={(l) => void onLineClick(l)}
              onIconSlot={kind === "cloud" ? openTextPicker : undefined}
            />
          )}
        </div>
        {parsed && (
          <Problems
            parsed={parsed}
            onFix={(p, j) => {
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
      </section>

      <section className="schema-island flow-pane-draw" aria-label={`${name}.flow drawing`}>
        <div className="schema-pane-head flow-strip">
          {renaming !== null ? (
            <input
              className="input flow-rename"
              aria-label={`Rename ${renaming}`}
              defaultValue={renaming}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void rename(renaming, e.currentTarget.value);
                else if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={() => setRenaming(null)}
            />
          ) : labelBox?.fresh ? (
            <span className="flow-selchip">{`New flow: ${labelBox.from} to ${labelBox.to}`}</span>
          ) : one ? (
            <>
              <span className="flow-selchip">
                {NODE_ICON[one.kind] && <Icon name={NODE_ICON[one.kind]!} size={14} />}
                {one.attrs.id && <span className="flow-selchip-id">{one.attrs.id}</span>}
                <span>{one.name}</span>
              </span>
              <span className="flow-quiet">{`${NODE_WORD[one.kind]}, ${plural(flowsOf(one.name), kind === "dfd" ? "flow" : "line")}`}</span>
              {one.kind === "service" && (
                <button ref={chooseIcon} type="button" className="button button-small button-quiet" onClick={() => openPicker(one.name)}>
                  Choose icon
                </button>
              )}
            </>
          ) : (
            <span className="flow-quiet">{selected.length > 1 ? `${selected.length} selected` : "Nothing selected"}</span>
          )}
          {notice && (
            <span className="flow-notice" role="status">
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
          <button type="button" className="button button-small" disabled={!drawn} onClick={() => void openPublish()}>
            <Icon name="image" size={14} />
            Publish
          </button>
        </div>
        <div ref={canvasEl} className={stale ? "flow-canvas is-stale" : "flow-canvas"} tabIndex={-1} onKeyDown={onCanvasKey}>
          <FlowResizeContext.Provider value={doc.resize}>
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
            snapWhileDragging={false}
            onDrag={onDrag}
            onMove={onMove}
            onSelect={onSelect}
            selection={selected}
            onEdgeDoubleClick={onEdgeDoubleClick}
            onContextMenu={openMenu}
            onNodeDoubleClick={editNode}
            onPaneDoubleClick={kind && quickItems(kind).length > 0 ? setPaneAdd : undefined}
            minimapJump
            boxSelect
            livePositions={glide}
            onInit={(i) => {
              instance.current = i;
            }}
            overlay={
              <CanvasOverlay store={overlay}>
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
          </FlowResizeContext.Provider>
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
      {menu && <PlacedMenu menu={menu} onClose={() => setMenu(null)} />}
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
