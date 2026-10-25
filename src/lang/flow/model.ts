// The .flow language (A2): the document the parser returns and the writer writes, and the one quoting rule both follow.

export type DiagramKind = "dfd" | "flow" | "cloud" | "sequence" | "state" | "class" | "mindmap" | "timeline";

/** Data flow kinds (Gane-Sarson). */
export type DfdKind = "entity" | "process" | "store";

/** Flowchart kinds; a flowchart node with no kind is a step. */
export type FlowKind = "start" | "end" | "step" | "decision" | "io" | "subprocess";

/** Step 12, item 19: the kinds of the newer diagrams. */
export type SequenceKind = "participant" | "actor";
export type StateKind = "state" | "choice" | "fork";
export type ClassKind = "class" | "interface" | "enum";
export type MindKind = "root" | "topic";
export type TimelineKind = "event" | "period" | "milestone";

/** Every node kind; a cloud node is a service, drawn with its icon. A note is a remark on the canvas. */
export type FlowNodeKind =
  | DfdKind
  | FlowKind
  | "service"
  | "document"
  | "database"
  | SequenceKind
  | StateKind
  | ClassKind
  | MindKind
  | TimelineKind
  | "note";

export const DIAGRAM_KINDS: readonly DiagramKind[] = ["dfd", "flow", "cloud", "sequence", "state", "class", "mindmap", "timeline"];

/**
 * The kind words each diagram takes in brackets, in the order the problems list them. Sequence, class, mind map
 * and timeline nodes are written with a leading word instead (`participant App`, `class Invoice`, `root Plan`,
 * `milestone v1.0`), so their lists are empty.
 */
export const KINDS: Record<DiagramKind, readonly FlowNodeKind[]> = {
  dfd: ["entity", "process", "store"],
  flow: ["start", "end", "step", "decision", "io", "subprocess", "document", "database"],
  cloud: ["service"],
  sequence: [],
  state: ["state", "choice", "fork"],
  class: [],
  mindmap: [],
  timeline: [],
};

/** The kinds that take `note: text` (the shape picker offers it there). */
export const NOTE_KINDS: ReadonlySet<DiagramKind> = new Set(["flow", "sequence", "state", "class", "mindmap"]);

/** The name of the start and end marker `[*]` of a state diagram, as two nodes the canvas draws. */
export const STATE_START = "[*] start";
export const STATE_END = "[*] end";

/**
 * diag-910 fix round 1 (I4): `[*]` written inside a composite's braces is that composite's own start or end, named
 * `[*] start in <Composite>`; outside every composite it is the diagram's, STATE_START or STATE_END.
 */
export function stateMarkerName(end: "start" | "end", group: string | null): string {
  const base = end === "start" ? STATE_START : STATE_END;
  return group === null ? base : `${base} in ${group}`;
}
export const isStateStart = (name: string) => name === STATE_START || name.startsWith(`${STATE_START} in `);
export const isStateEnd = (name: string) => name === STATE_END || name.startsWith(`${STATE_END} in `);
export const isStateMarker = (name: string) => isStateStart(name) || isStateEnd(name);

/** The attributes, in the order the writer writes them (step 11 adds `label`). */
export type FlowAttrKey = "id" | "icon" | "label" | "color" | "table";
export const ATTR_KEYS: readonly FlowAttrKey[] = ["id", "icon", "label", "color", "table"];

/**
 * Step 11 (PRODUCT.md principle 5): `color` is one of six theme colours named by what they mean, never a hex or a
 * free colour name. Each draws from theme tokens (ADR 0008), so dark, light and Publish draw it their own way.
 */
export const PALETTE = ["accent", "info", "success", "warning", "danger", "muted"] as const;
export type PaletteName = (typeof PALETTE)[number];
export const isPaletteName = (v: string | null | undefined): v is PaletteName => (PALETTE as readonly string[]).includes(v ?? "");

/** The words people type for a colour, and the palette name each means (a problem's quick fix). */
export const COLOUR_WORDS: Readonly<Record<string, PaletteName>> = {
  red: "danger",
  green: "success",
  blue: "info",
  cyan: "info",
  yellow: "warning",
  orange: "warning",
  amber: "warning",
  purple: "accent",
  violet: "accent",
  grey: "muted",
  gray: "muted",
};

/**
 * Step 11: the kinds whose shapes are written `Name [..]`, so they take `label:` and `color:`, and whose lines and
 * groups take `color:`. Sequence, class and timeline items are written with a word or a date and take neither in 1.0.
 */
export const ATTR_DIAGRAMS: ReadonlySet<DiagramKind> = new Set(["flow", "dfd", "state", "cloud", "mindmap"]);

export function isFlowchartKind(kind: FlowNodeKind): kind is FlowKind {
  return (KINDS.flow as readonly string[]).includes(kind);
}

export interface FlowNode {
  name: string;
  kind: FlowNodeKind;
  /**
   * `id`, `icon`, `label` (the words the shape shows in place of its name), `color` (a PALETTE name) and `table`
   * (`schema.table`), in the order they are written.
   */
  attrs: Record<string, string>;
  /** Rows written on their own lines: a class's members (`Invoice : + send()`) as "+ send()", in the order they are written. */
  rows?: string[];
  /** A mind map topic's depth: 1 for a topic, 2 for a subtopic, and so on (the root is 0). */
  depth?: number;
  /** A timeline item's date (`2026-10-19`, `2026-10`), and a period's end. */
  date?: string;
  until?: string;
  /** The timeline section the item is in. */
  section?: string;
  /** A note's text. */
  text?: string;
}

/**
 * `>` one way, `-` no arrow, `-->` dashed, `<>` both ways, `..>` dotted one way (cloud and class). Step 12 adds:
 * `->` a sequence message (`-->` its reply); `--` an association, `<|--` inheritance, `*--` composition (class).
 */
export type FlowArrow = ">" | "-" | "-->" | "<>" | "..>" | "->" | "--" | "<|--" | "*--";

/** The line a flow drawn on the canvas writes, by diagram kind. */
export function defaultArrow(kind: DiagramKind | null): FlowArrow {
  if (kind === "sequence") return "->";
  if (kind === "class") return "-->";
  return ">";
}

/** The kinds the canvas lays out from the text alone (time, the indent tree, the date order): nodes are not dragged. */
export const FIXED_KINDS: ReadonlySet<DiagramKind> = new Set(["sequence", "mindmap", "timeline"]);

/** The lines each diagram kind draws; any other arrow is a problem with a fix to the first. */
export const ARROWS: Record<DiagramKind, readonly FlowArrow[]> = {
  dfd: [">", "<>", "-->", "-"],
  flow: [">", "<>", "-->", "-"],
  cloud: [">", "<>", "-", "-->", "..>"],
  sequence: ["->", "-->"],
  state: [">", "-->"],
  class: ["<|--", "*--", "..>", "-->", "--", "-"],
  mindmap: [">", "-"],
  timeline: [],
};

export interface FlowLink {
  /** A node or group name. */
  from: string;
  to: string;
  arrow: FlowArrow;
  label?: string;
  /** A mind map branch the indents make: drawn, never written. */
  tree?: boolean;
  /** Written on the same line as the link before it (`A > B > C`); set only when neither has a label. */
  chained?: boolean;
  /** Step 11: `A > B: label [color: warning]`, a PALETTE name (eraser.io's connection colour). */
  color?: string;
}

export interface FlowGroup {
  name: string;
  icon?: string;
  /** Step 11: `Dispatch [color: muted] {`, a PALETTE name: its border and title. */
  color?: string;
  /** Node names, in the order they are written. */
  nodes: string[];
  groups: FlowGroup[];
}

export interface FlowDoc {
  kind: DiagramKind;
  title: string;
  /** `//` comments, written after the first line; `line` is where they came from. */
  comments: { line: number; text: string }[];
  /** Every node, grouped or not; the ones in no group are written first, in this order. */
  nodes: FlowNode[];
  links: FlowLink[];
  groups: FlowGroup[];
  /**
   * A sequence diagram's frames (`loop label { ... }`) and activations (`activate Name`), by the index of the
   * first and last message (link) they cover; -1 last when a frame is empty.
   */
  frames?: { label: string; kind: string; from: number; to: number; depth: number }[];
  activations?: { name: string; from: number; to: number }[];
  /** A timeline's sections, in order. */
  sections?: string[];
}

/**
 * The most text a canvas paste or a Mermaid import reads (1 MB), and the most shapes a diagram they write may hold:
 * past them the drawing, the layout and the editor would no longer stay light (memory is a requirement).
 */
export const MAX_FLOW_TEXT = 1024 * 1024;
export const MAX_FLOW_NODES = 2000;

/** True when `text` is over MAX_FLOW_TEXT, in characters or in UTF-8 bytes. */
export function overTextLimit(text: string): boolean {
  return text.length > MAX_FLOW_TEXT || (text.length * 3 > MAX_FLOW_TEXT && new TextEncoder().encode(text).length > MAX_FLOW_TEXT);
}

/** Groups nest at most this deep, as Mermaid import caps them, so the parser, writer and canvas stay small. */
export const MAX_GROUP_DEPTH = 20;

/**
 * Text .flow reads as syntax inside a name: brackets, braces, `:`, `>`, `<`, quotes, a backslash, a `//`
 * comment, a lone `-` (the no-arrow link), `--` (the dashed link) and a line break. The parser reads the same rule.
 */
const RESERVED = /[[\]{}:><"\\\r\n]|\/\/|(^|\s)-(\s|$)|--/;

/** True when the name has to be written in double quotes. */
export function needsQuotes(name: string): boolean {
  return RESERVED.test(name) || name !== name.trim() || name === "";
}

/** Double quotes, with `\` written `\\`, `"` written `\"` and line breaks written `\n` and `\r`. */
export const quote = (s: string) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;

/** A node or group name as .flow writes it. */
export function flowName(name: string): string {
  return needsQuotes(name) ? quote(name) : name;
}

/** A link label runs to the end of the line, so only a comment mark, a quote, a backslash or a line break needs quotes. */
export function flowLabel(label: string): string {
  return /\/\/|["\\\r\n]/.test(label) || label !== label.trim() ? quote(label) : label;
}

/** An attribute value runs to the next `,` or `]`. */
export function flowValue(value: string): string {
  return /[,\]"\\\r\n]|\/\//.test(value) || value !== value.trim() || value === "" ? quote(value) : value;
}

/**
 * An attribute value as the writer writes it. A label (step 11) is quoted by the name rule (RESERVED) and also when it
 * holds a comma, so the words a shape shows read the same as a name would.
 */
export function attrValue(key: string, value: string): string {
  if (key === "label") return needsQuotes(value) || value.includes(",") ? quote(value) : value;
  return flowValue(value);
}

/** The words a shape shows: its `label:` when it has one, else its name (step 11). */
export const shownName = (n: Pick<FlowNode, "name" | "attrs">): string => n.attrs.label ?? n.name;

/** `key: value` items in the writer's order (ATTR_KEYS), whatever order `attrs` holds them in. */
export function attrItems(attrs: Record<string, string>): string[] {
  const keys = Object.keys(attrs).sort((a, b) => order(a) - order(b));
  return keys.map((k) => `${k}: ${attrValue(k, attrs[k])}`);
}
const order = (k: string) => {
  const i = (ATTR_KEYS as readonly string[]).indexOf(k);
  return i < 0 ? ATTR_KEYS.length : i;
};

/** The kinds written with a leading word (`participant App`, `class Invoice`, `milestone v1.0`), not in brackets. */
const WORD_KINDS: ReadonlySet<FlowNodeKind> = new Set(["participant", "actor", "class", "interface", "enum", "root", "milestone"]);

/** Today as YYYY-MM-DD, for a timeline event added from the canvas. */
export function isoToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * The statement that writes `node` in a `diagram` file: a leading word for the kinds that take one, the date
 * form on a timeline, an indent per level in a mind map, `note: text` for a note, else `Name [kind, attrs]`.
 */
export function nodeStatement(diagram: DiagramKind | null, node: Pick<FlowNode, "name" | "kind" | "attrs"> & Partial<FlowNode>): string {
  const name = flowName(node.name);
  if (node.kind === "note") return `note: ${flowLabel(node.text ?? node.name)}`;
  if (WORD_KINDS.has(node.kind)) return `${node.kind} ${name}`;
  if (diagram === "mindmap") {
    // A topic takes `label:` and `color:` (step 11).
    const items = attrItems(node.attrs);
    return `${"  ".repeat(Math.max(1, node.depth ?? 1))}${name}${items.length ? ` [${items.join(", ")}]` : ""}`;
  }
  if (diagram === "timeline") {
    const date = node.date ?? isoToday();
    return node.kind === "period" ? `${date} to ${node.until ?? date}: ${name}` : `${date}: ${name}`;
  }
  // A cloud node is always a service, and the default kind of the newer diagrams goes unsaid.
  const unsaid = (diagram === "cloud" && node.kind === "service") || (diagram === "state" && node.kind === "state");
  const parts: string[] = unsaid ? [] : [node.kind];
  parts.push(...attrItems(node.attrs));
  return parts.length ? `${name} [${parts.join(", ")}]` : name;
}

