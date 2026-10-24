// The .flow language (A2): the document the parser returns and the writer writes, and the one quoting rule both follow.

export type DiagramKind = "dfd" | "flow" | "cloud" | "er" | "sequence" | "state" | "class" | "mindmap" | "timeline";

/** Data flow kinds (Gane-Sarson). */
export type DfdKind = "entity" | "process" | "store";

/** Flowchart kinds; a flowchart node with no kind is a step. */
export type FlowKind = "start" | "end" | "step" | "decision" | "io" | "subprocess";

/** Step 12, item 19: the kinds of the six newer diagrams. An ER file's `entity` is a table (a data flow's is an outside party). */
export type ErKind = "entity" | "weak";
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
  | ErKind
  | SequenceKind
  | StateKind
  | ClassKind
  | MindKind
  | TimelineKind
  | "note";

export const DIAGRAM_KINDS: readonly DiagramKind[] = ["dfd", "flow", "cloud", "er", "sequence", "state", "class", "mindmap", "timeline"];

/**
 * The kind words each diagram takes in brackets, in the order the problems list them. Sequence, class, mind map
 * and timeline nodes are written with a leading word instead (`participant App`, `class Invoice`, `root Plan`,
 * `milestone v1.0`), so their lists are empty.
 */
export const KINDS: Record<DiagramKind, readonly FlowNodeKind[]> = {
  dfd: ["entity", "process", "store"],
  flow: ["start", "end", "step", "decision", "io", "subprocess", "document", "database"],
  cloud: ["service"],
  er: ["entity", "weak"],
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

/** What an ER column says about itself in brackets, in the order the writer writes them. */
export type ColumnFlag = "pk" | "not null" | "unique";
export const COLUMN_FLAGS: readonly ColumnFlag[] = ["pk", "not null", "unique"];

/**
 * A column's flags as the writer writes them: ` [pk, not null, unique]` in that order, only those set, or nothing.
 * Each flag is written as it is, so toggling one never touches another (a key still means not null when read).
 */
export function columnFlagsText(flags: Iterable<ColumnFlag>): string {
  const set = new Set(flags);
  const out = COLUMN_FLAGS.filter((f) => set.has(f));
  return out.length ? ` [${out.join(", ")}]` : "";
}

/** A table whose column lines read back as `table.column`: a plain name with no dot that needs no quotes. */
export const columnsWritable = (table: string) => !table.includes(".") && !needsQuotes(table);

/** An ER column name the canvas writes: letters, digits and _ (board ER interactions). */
export const isColumnName = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/** A column type runs to the flags or the end of the line, so it may not hold what the line reads as syntax. */
export const isColumnType = (s: string) => s === "" || (s === s.trim() && !needsQuotes(s) && !s.includes(".."));

export type FlowAttrKey = "id" | "icon" | "color" | "table";
export const ATTR_KEYS: readonly FlowAttrKey[] = ["id", "icon", "color", "table"];

export function isFlowchartKind(kind: FlowNodeKind): kind is FlowKind {
  return (KINDS.flow as readonly string[]).includes(kind);
}

export interface FlowNode {
  name: string;
  kind: FlowNodeKind;
  /** `id`, `icon`, `color` (a theme token name) and `table` (`schema.table`), in the order they are written. */
  attrs: Record<string, string>;
  /**
   * Rows written on their own lines: an ER entity's columns (`customers.email text`) as "email text", a class's
   * members (`Invoice : + send()`) as "+ send()", in the order they are written.
   */
  rows?: string[];
  /**
   * An ER entity's column flags (`customers.id int [pk]`), one list per row in `rows`, written in COLUMN_FLAGS
   * order. Absent when no column of the entity has any.
   */
  rowFlags?: ColumnFlag[][];
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
 * `->` a sequence message (`-->` its reply); `--` an ER relationship, and `1--*`, `*--1`, `1--1`, `*--*` its ends;
 * `<|--` inheritance, `*--` composition (class).
 */
export type FlowArrow = ">" | "-" | "-->" | "<>" | "..>" | "->" | "--" | "1--*" | "*--1" | "1--1" | "*--*" | "<|--" | "*--";

/** The line a flow drawn on the canvas writes, by diagram kind. */
export function defaultArrow(kind: DiagramKind | null): FlowArrow {
  if (kind === "sequence") return "->";
  if (kind === "er") return "--";
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
  er: ["--", "1--*", "*--1", "1--1", "*--*"],
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
  /**
   * ER build C: an ER relationship's column at each end (`invoices.customer_id *--1 customers.id`); `from` and `to`
   * stay the tables, so a line between columns draws and deletes as a line between tables does. Absent on a
   * table-to-table line.
   */
  fromColumn?: string;
  toColumn?: string;
}

/** A line end as .flow writes it: the node's name, then `.column` for an ER relationship's column. */
export function linkEndText(name: string, column?: string): string {
  return column === undefined ? flowName(name) : `${flowName(name)}.${column}`;
}

export interface FlowGroup {
  name: string;
  icon?: string;
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
  if (diagram === "mindmap") return `${"  ".repeat(Math.max(1, node.depth ?? 1))}${name}`;
  if (diagram === "timeline") {
    const date = node.date ?? isoToday();
    return node.kind === "period" ? `${date} to ${node.until ?? date}: ${name}` : `${date}: ${name}`;
  }
  // A cloud node is always a service, and the default kind of the newer diagrams goes unsaid.
  const unsaid = (diagram === "cloud" && node.kind === "service") || (diagram === "state" && node.kind === "state") || (diagram === "er" && node.kind === "entity");
  const parts: string[] = unsaid ? [] : [node.kind];
  for (const [key, value] of Object.entries(node.attrs)) parts.push(`${key}: ${flowValue(value)}`);
  return parts.length ? `${name} [${parts.join(", ")}]` : name;
}

/**
 * An ER table's free name (fix round 1): `name` when no table has it in any case (SQL folds unquoted names), else
 * `name_2`, `name_3`. Only a trailing `_N` the app itself added counts on: `orders_2` exists because `orders` does,
 * so its copy is `orders_3`; `log_2024` is a name of its own, so its copy is `log_2024_2`. With `first`, the name is
 * always numbered, from `name_<first>` on.
 */
export function sqlFreeName(name: string, taken: Iterable<string>, first?: number): string {
  const lower = new Set<string>();
  for (const t of taken) lower.add(t.toLowerCase());
  // A numbered series (ER build C: a table added by double-click is table_1, table_2): never the bare name.
  if (first !== undefined) {
    for (let n = first; ; n++) if (!lower.has(`${name}_${n}`.toLowerCase())) return `${name}_${n}`;
  }
  if (!lower.has(name.toLowerCase())) return name;
  let base = name;
  let n = 2;
  const m = /^(.+)_(\d+)$/.exec(name);
  if (m && Number(m[2]) >= 2 && lower.has(m[1].toLowerCase())) {
    base = m[1];
    n = Number(m[2]) + 1;
  }
  for (; ; n++) if (!lower.has(`${base}_${n}`.toLowerCase())) return `${base}_${n}`;
}
