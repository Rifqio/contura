// The .flow language (A2): the document the parser returns and the writer writes, and the one quoting rule both follow.

export type DiagramKind = "dfd" | "flow" | "cloud";

/** Data flow kinds (Gane-Sarson). */
export type DfdKind = "entity" | "process" | "store";

/** Flowchart kinds; a flowchart node with no kind is a step. */
export type FlowKind = "start" | "end" | "step" | "decision" | "io" | "subprocess";

/** Every node kind; a cloud node is a service, drawn with its icon. */
export type FlowNodeKind = DfdKind | FlowKind | "service";

export const DIAGRAM_KINDS: readonly DiagramKind[] = ["dfd", "flow", "cloud"];

/** The kinds each diagram allows, in the order the problems list them. */
export const KINDS: Record<DiagramKind, readonly FlowNodeKind[]> = {
  dfd: ["entity", "process", "store"],
  flow: ["start", "end", "step", "decision", "io", "subprocess"],
  cloud: ["service"],
};

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
}

/** `>` one way, `-` no arrow, `-->` dashed, `<>` both ways, `..>` dotted one way (cloud only). */
export type FlowArrow = ">" | "-" | "-->" | "<>" | "..>";

export interface FlowLink {
  /** A node or group name. */
  from: string;
  to: string;
  arrow: FlowArrow;
  label?: string;
  /** Written on the same line as the link before it (`A > B > C`); set only when neither has a label. */
  chained?: boolean;
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
