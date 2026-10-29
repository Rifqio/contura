// The .flow language (A2): the document the parser returns and the writer writes, and the one quoting rule both follow.

export type DiagramKind = "dfd" | "flow" | "cloud" | "er" | "sequence" | "state" | "class" | "mindmap" | "timeline";

/** Data flow kinds (Gane-Sarson). */
export type DfdKind = "entity" | "process" | "store";

/** Flowchart kinds; a flowchart node with no kind is a step. */
export type FlowKind = "start" | "end" | "step" | "decision" | "io" | "subprocess";

/** Step 12, item 19: the kinds of the newer diagrams. An ER table's `entity` is a table (a data flow's is an outside party). */
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

/** Other names people write for a diagram kind, lowercase: a header using one gets a fix to the kind. */
export const KIND_ALIASES: ReadonlyMap<string, DiagramKind> = new Map<string, DiagramKind>([
  ["flowchart", "flow"],
  ["erd", "er"],
  ["entity", "er"],
  ["seq", "sequence"],
  ["mind map", "mindmap"],
  ["mind-map", "mindmap"],
  ["dataflow", "dfd"],
  ["data-flow", "dfd"],
  ["statechart", "state"],
  ["uml", "class"],
  ...DIAGRAM_KINDS.map((k) => [k, k] as [string, DiagramKind]),
]);

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
 * Step 11 (PRODUCT.md principle 5): `color` is one of six theme colours named by what they mean (a CSS colour name or
 * a hex is also read, see colours.ts). Each preset draws from theme tokens (ADR 0008), so dark, light and Publish draw it their own way.
 */
export const PALETTE = ["accent", "info", "success", "warning", "danger", "muted"] as const;
export type PaletteName = (typeof PALETTE)[number];
export const isPaletteName = (v: string | null | undefined): v is PaletteName => (PALETTE as readonly string[]).includes(v ?? "");

/**
 * The kinds whose shapes take `label:` and `color:`: those written `Name [..]`, and a sequence's participants, written
 * `participant Name [..]`. Class and timeline items are written with a word or a date and take neither.
 */
export const ATTR_DIAGRAMS: ReadonlySet<DiagramKind> = new Set(["flow", "dfd", "state", "cloud", "mindmap", "sequence", "er"]);

/** The kinds whose lines and groups take `color:`. A sequence colours its participants, not its messages. */
export const LINE_COLOUR_DIAGRAMS: ReadonlySet<DiagramKind> = new Set(["flow", "dfd", "state", "cloud", "mindmap", "er"]);

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
  /**
   * Rows written on their own lines, in the order they are written: an ER table's columns (`  email text` inside its
   * braces) as "email text", or "email" with no type; a class's members (`Invoice : + send()`) as "+ send()".
   */
  rows?: string[];
  /** An ER table's column flags, one list per row in `rows`, in COLUMN_FLAGS order. Absent when no column has any. */
  rowFlags?: ColumnFlag[][];
  /** An ER table's column comments (`id int pk // the key`), one per row in `rows`. Absent when no column has one. */
  rowComments?: (string | undefined)[];
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
 * `->` a sequence message (`-->` its reply); `<|--` inheritance, `*--` composition (class). `--` is a dotted line with no
 * head in every kind with lines, and the solid association in a class diagram. An ER relationship is `>` many to one,
 * `<` one to many, `-` one to one and `<>` many to many (DBML's operators).
 */
export type FlowArrow = ">" | "<" | "-" | "-->" | "<>" | "..>" | "->" | "--" | "<|--" | "*--";

/** What each ER line says about the rows at its ends, read from the first end to the second. */
export const erCardinality: Record<">" | "<" | "-" | "<>", "many-to-one" | "one-to-many" | "one-to-one" | "many-to-many"> = {
  ">": "many-to-one",
  "<": "one-to-many",
  "-": "one-to-one",
  "<>": "many-to-many",
};

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
  dfd: [">", "<>", "-->", "-", "--"],
  flow: [">", "<>", "-->", "-", "--"],
  cloud: [">", "<>", "-", "--", "-->", "..>"],
  er: [">", "<", "-", "<>"],
  sequence: ["->", "-->"],
  state: [">", "-->", "--"],
  class: ["<|--", "*--", "..>", "-->", "--", "-"],
  mindmap: [">", "-", "--"],
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
  /**
   * An ER relationship's column at each end (`orders.customer_id > customers.id`); `from` and `to` stay the tables, so
   * a line between columns draws and deletes as a line between tables does. Absent on a table-to-table line.
   */
  fromColumn?: string;
  toColumn?: string;
}

/**
 * A line end as .flow writes it: the node's name, then `.column` for an ER relationship's column. A table with a column
 * end never needs quotes: the edits refuse one that would (`ER_NOTES.quotedEnd`), and a pasted table's free name
 * keeps to SQL's letters.
 */
export function linkEndText(name: string, column?: string): string {
  return column === undefined ? flowName(name) : `${flowName(name)}.${column}`;
}

/** What an ER column says about itself after its type, in the order the writer writes them. */
export type ColumnFlag = "pk" | "not null" | "unique";
export const COLUMN_FLAGS: readonly ColumnFlag[] = ["pk", "not null", "unique"];

/** A column's flags as the writer writes them: ` pk not null unique` in that order, only those set, or nothing. */
export function columnFlagsText(flags: Iterable<ColumnFlag>): string {
  const set = new Set(flags);
  const out = COLUMN_FLAGS.filter((f) => set.has(f));
  return out.length ? ` ${out.join(" ")}` : "";
}

/**
 * A column type as the writer writes it: bare when it reads back as one token, else quoted. A token stops at white space
 * outside parentheses (`decimal(10, 2)` stays bare); a quote, a `//`, a brace, or a word that reads as a flag
 * (`pk`, `not`, `unique`) is quoted too.
 */
export function columnTypeText(type: string): string {
  if (type === "" || /["{}]|\/\//.test(type) || /^(pk|not|unique)$/i.test(type)) return quote(type);
  let depth = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(c)) return quote(type);
  }
  return type;
}

/** An ER column row's name and type: "customer_id int" is customer_id and int; a row with no type has none. */
export function splitRow(row: string): { name: string; type: string } {
  const at = row.search(/\s/);
  return at < 0 ? { name: row, type: "" } : { name: row.slice(0, at), type: row.slice(at + 1).trim() };
}

/**
 * An ER table's column `i` as one block line without its indent: `name type flags // comment`. `tableText` writes each
 * column with it and Ctrl+C copies it (`comment: false` leaves the row comment out), so the two never quote differently.
 */
export function columnLine(n: FlowNode, i: number, o: { comment?: boolean } = {}): string {
  const { name, type } = splitRow(n.rows?.[i] ?? "");
  const note = o.comment === false ? undefined : n.rowComments?.[i];
  // A comment ends at the line end, so a line break inside one becomes a space.
  const comment = note === undefined ? "" : note ? ` // ${note.replace(/[\r\n]+/g, " ")}` : " //";
  return `${name}${type ? ` ${columnTypeText(type)}` : ""}${columnFlagsText(n.rowFlags?.[i] ?? [])}${comment}`;
}

/** An ER table: its statement alone, or with its columns as a block, one `  name type flags` line each. */
export function tableText(n: FlowNode): string {
  const own = nodeStatement("er", n);
  if (!n.rows?.length) return own;
  return [`${own} {`, ...n.rows.map((_, i) => `  ${columnLine(n, i)}`), "}"].join("\n");
}

/** An ER column name the canvas writes: letters, digits and _ (board ER interactions). The Core's diagram tool checks
 * the same pattern (`crates/contura-core/tests/fixtures/flow/er_rules.json`). */
export const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isColumnName = (s: string) => COLUMN_NAME.test(s);

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
  frames?: { label: string; kind: string; from: number; to: number; depth: number; color?: string }[];
  activations?: { name: string; from: number; to: number }[];
  /** A sequence's `autonumber` directives in text order; absent when there are none. */
  autonumber?: SeqNumbering[];
  /** A timeline's sections, in order. */
  sections?: string[];
}

/** One `autonumber` directive: `from` is the index of the first message after it. */
export interface SeqNumbering {
  from: number;
  start?: number;
  off?: true;
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
 * comment, a lone `-` (the no-arrow link), `--` (the dashed link), a line break, and a comma (it separates the
 * ends of a fan-out link; a node line still reads a bare comma as part of its name). The parser reads the same rule.
 */
const RESERVED = /[[\]{}:><"\\,\r\n]|\/\/|(^|\s)-(\s|$)|--/;

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
  if (key === "color" && value.startsWith("#")) return quote(value);
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
  if (WORD_KINDS.has(node.kind)) {
    const items = node.kind === "participant" || node.kind === "actor" ? attrItems(node.attrs) : [];
    return `${node.kind} ${name}${items.length ? ` [${items.join(", ")}]` : ""}`;
  }
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
  const unsaid = (diagram === "cloud" && node.kind === "service") || (diagram === "state" && node.kind === "state") || (diagram === "er" && node.kind === "entity");
  const parts: string[] = unsaid ? [] : [node.kind];
  parts.push(...attrItems(node.attrs));
  return parts.length ? `${name} [${parts.join(", ")}]` : name;
}

/**
 * An ER table's free name: `name` when no table has it in any case (SQL folds unquoted names), else `name_2`,
 * `name_3`. Only a trailing `_N` the app itself added counts on: `orders_2` exists because `orders` does, so its copy
 * is `orders_3`; `log_2024` is a name of its own, so its copy is `log_2024_2`. With `first`, the name is always
 * numbered, from `name_<first>` on.
 */
export function sqlFreeName(name: string, taken: Iterable<string>, first?: number): string {
  const lower = new Set<string>();
  for (const t of taken) lower.add(t.toLowerCase());
  // A numbered series (a table added by double-click is table_1, table_2): never the bare name.
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

/** Caps for one board file: frames, shapes across all frames, and links one fan expands to. */
export const MAX_BOARD_FRAMES = 50;
export const MAX_BOARD_SHAPES = 10_000;
export const MAX_FAN_LINKS = 100;
