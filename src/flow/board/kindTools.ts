// The board's tools and their keys (Decisions 18 and 19): the one source of every tool key, read by the toolbar,
// FlowTab's keys and the Shape picker's hints. A kind tool carries the Shape picker's own shape, so FlowTab adds it
// through `runShape` as the picker does.
import type { IconName } from "../../components/Icon";
import type { DiagramKind } from "../../lang/flow/model";
import { NO_GROUPS } from "../editWords";
import { type Shape, shapesOf } from "../ShapePicker";

/** A toolbar tool: its id while armed, its name, its key and its icon. */
export type Tool = { id: string; name: string; key: string; icon: IconName };

/** A tool of one diagram kind: the shape it adds, as the Shape picker has it (M7). */
export type KindTool = Tool & { shape: Shape };

/** A Space press released within this is a tap, not a hold to pan (Decision 26). */
export const SPACE_TAP_MS = 250;
/** A Space tap moves the pointer less than this, in screen pixels. */
export const SPACE_MOVE_PX = 4;

export const SELECT_TOOL: Tool = { id: "select", name: "Select", key: "V", icon: "select" };
export const HAND_TOOL: Tool = { id: "hand", name: "Hand", key: "H", icon: "hand" };
/** F draws a Section, a titled sketch container (owner answer 3). */
export const SECTION_TOOL: Tool = { id: "section", name: "Section", key: "F", icon: "section" };
/** N off a note-taking frame arms the note sketch (Miro's N); its button sits beside Section and shows N's pressed state. */
export const NOTE_TOOL_ID = "note";
export const NOTE_TOOL: Tool = { id: NOTE_TOOL_ID, name: "Note", key: "N", icon: "stickyNote" };
/** The only tool that stays armed after a use (owner answer 7). */
export const PEN_TOOL_ID = "pen";

/** The drawing tools with nothing selected (Excalidraw's and Figma's shape keys). */
export const GENERIC_TOOLS: Tool[] = [
  { id: "rect", name: "Rectangle", key: "R", icon: "square" },
  { id: "ellipse", name: "Ellipse", key: "O", icon: "circle" },
  { id: "diamond", name: "Diamond", key: "D", icon: "diamond" },
  { id: "arrow", name: "Arrow", key: "A", icon: "arrowRight" },
  { id: "line", name: "Line", key: "L", icon: "slash" },
  { id: PEN_TOOL_ID, name: "Pen", key: "P", icon: "pen" },
  { id: "text", name: "Text", key: "T", icon: "type" },
];

/** Each kind's tools: name, key, the picker shape's label in `shapesOf`, and an icon where the shape's own would repeat another tool's. */
const SPEC: Record<DiagramKind, [name: string, key: string, shape: string, icon?: IconName][]> = {
  flow: [
    ["Start or end", "O", "Start or end"],
    ["Step", "R", "Step"],
    ["Decision", "D", "Decision"],
    ["Input or output", "P", "Input or output"],
    ["Arrow", "A", "Line"],
    ["Group", "G", "Group", "arrange"],
  ],
  er: [
    ["Table", "R", "Table"],
    ["Column", "C", "Column"],
    ["Relationship", "A", "Many to one"],
  ],
  // Block is the loop act, not a group: NO_GROUPS.sequence does not hide it (C13).
  sequence: [
    ["Participant", "R", "Participant"],
    ["Message", "A", "Message"],
    ["Reply", "Y", "Reply"],
    ["Block", "G", "Loop"],
  ],
  dfd: [
    ["Process", "R", "Process"],
    ["Data store", "S", "Data store"],
    ["Outside party", "E", "Outside party"],
    ["Arrow", "A", "Flow"],
  ],
  cloud: [
    ["Service", "R", "Service"],
    ["Arrow", "A", "Line"],
    ["Group", "G", "Group", "arrange"],
  ],
  state: [
    ["State", "R", "State"],
    ["Choice", "D", "Choice"],
    ["Fork", "K", "Fork or join"],
    ["Arrow", "A", "Transition"],
    ["Group", "G", "Composite", "arrange"],
  ],
  class: [
    ["Class", "R", "Class"],
    ["Interface", "I", "Interface"],
    ["Enum", "E", "Enum"],
    ["Arrow", "A", "Inheritance", "arrowRight"],
  ],
  mindmap: [["Topic", "R", "Topic"]],
  timeline: [
    ["Event", "R", "Event"],
    ["Milestone", "D", "Milestone"],
    ["Period", "P", "Period"],
  ],
};

const slug = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, "-");

function kindTools(kind: DiagramKind): KindTool[] {
  const shapes = shapesOf(kind);
  return SPEC[kind].flatMap(([name, key, label, icon]) => {
    const shape = shapes.find((s) => s.label === label);
    if (!shape) throw new Error(`No ${label} shape in ${kind}`);
    // Group appears only where the kind has groups.
    if (shape.act.kind === "group" && NO_GROUPS[kind]) return [];
    return [{ id: `${kind}.${slug(name)}`, name, key, icon: icon ?? shape.icon, shape }];
  });
}

// Built at load from `shapesOf`, which reads FlowToolbar's ADD_TOOLS across the ShapePicker <-> FlowToolbar import cycle.
// It works because nothing FlowToolbar imports reaches this module; FlowToolbar must never import it.
export const KIND_TOOLS: Record<DiagramKind, KindTool[]> = {
  flow: kindTools("flow"),
  er: kindTools("er"),
  sequence: kindTools("sequence"),
  dfd: kindTools("dfd"),
  cloud: kindTools("cloud"),
  state: kindTools("state"),
  class: kindTools("class"),
  mindmap: kindTools("mindmap"),
  timeline: kindTools("timeline"),
};

const KIND_TOOL_IDS: ReadonlySet<string> = new Set(Object.values(KIND_TOOLS).flatMap((ts) => ts.map((t) => t.id)));

/** Whether `id` is a kind tool's, which belongs to its frame and disarms when another is selected. */
export function isKindTool(id: string): boolean {
  return KIND_TOOL_IDS.has(id);
}

/** The kind tool armed by `key` (any case), or undefined. */
export function kindToolFor(kind: DiagramKind, key: string): KindTool | undefined {
  const k = key.toUpperCase();
  return KIND_TOOLS[kind].find((t) => t.key === k);
}

/** The key a picker shape is armed with in its kind (its kind tool's), else its own (N for a note). */
export function keyOfShape(kind: DiagramKind, shape: Shape): string | undefined {
  return KIND_TOOLS[kind].find((t) => t.shape.label === shape.label)?.key ?? shape.key;
}

/** The key of the kind tool that adds through the add tool labelled `label`, for the "Add and connect" menu. */
export function keyOfAddTool(kind: DiagramKind, label: string): string | undefined {
  return KIND_TOOLS[kind].find((t) => t.shape.tool?.label === label)?.key;
}

/**
 * What a generic Rectangle, Ellipse or Diamond started inside a frame of `kind` writes (Decision 19): the rectangle its
 * R tool, the diamond its D tool where it has one, the ellipse a flowchart's start or end, a state or a mind map's
 * topic. Null: it draws a loose sketch.
 */
export function genericInFrame(kind: DiagramKind, tool: string): Shape | null {
  const by = (key: string) => kindToolFor(kind, key)?.shape ?? null;
  if (tool === "rect") return by("R");
  if (tool === "diamond") return by("D");
  if (tool === "ellipse" && kind === "flow") return by("O");
  if (tool === "ellipse" && (kind === "state" || kind === "mindmap")) return by("R");
  return null;
}

/**
 * "Press O, R, D or P and click where it goes, or click here" for an empty diagram's card: the keys of the kind's shape
 * tools. A key only arms its tool; the click places the shape (Decision 18), and the card's own click adds the first.
 */
export function firstNodeHint(kind: DiagramKind): string {
  const keys = KIND_TOOLS[kind].filter((t) => t.shape.act.kind === "node").map((t) => t.key);
  const list = keys.length < 2 ? keys.join("") : `${keys.slice(0, -1).join(", ")} or ${keys[keys.length - 1]}`;
  return `Press ${list} and click where it goes, or click here`;
}
