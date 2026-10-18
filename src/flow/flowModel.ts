// The smallest part of the .flow language (A2) that Mermaid import needs (ruling D1): the types and the writer.
// A2's parser must keep reading what this writes, in the grammar of the direction spec.

export type FlowKind = "start" | "end" | "step" | "decision" | "io" | "subprocess";

export interface FlowNode {
  name: string;
  kind: FlowKind;
  icon?: string;
}

export interface FlowLink {
  from: string;
  to: string;
  /** `>` one way, `-` no arrow, `-->` dashed, `<>` both ways. */
  arrow: ">" | "-" | "-->" | "<>";
  label?: string;
  /** Written on the same line as the link before it (`A > B > C`); set only when neither has a label. */
  chained?: boolean;
}

export interface FlowGroup {
  name: string;
  /** Node names, in the order they are written. */
  nodes: string[];
  groups: FlowGroup[];
}

export interface FlowDoc {
  title: string;
  /** `//` comments, written after the first line; `line` is where they came from. */
  comments: { line: number; text: string }[];
  /** Every node, grouped or not; the ones in no group are written first, in this order. */
  nodes: FlowNode[];
  links: FlowLink[];
  groups: FlowGroup[];
}

/**
 * Text .flow reads as syntax inside a name: brackets, braces, `:`, `>`, `<`, quotes, a backslash, a `//`
 * comment, a lone `-` (the no-arrow link) and `--` (the dashed link). A2's parser must read the same rule.
 */
const RESERVED = /[[\]{}:><"\\]|\/\/|(^|\s)-(\s|$)|--/;

/** True when the name has to be written in double quotes. */
export function needsQuotes(name: string): boolean {
  return RESERVED.test(name) || name !== name.trim() || name === "";
}

/** Double quotes, with `\` written `\\` and `"` written `\"`. */
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A node or group name as .flow writes it. */
export function flowName(name: string): string {
  return needsQuotes(name) ? quote(name) : name;
}

/** A link label runs to the end of the line, so only a comment mark, a quote or a backslash needs quotes. */
function flowLabel(label: string): string {
  return /\/\/|["\\]/.test(label) || label !== label.trim() ? quote(label) : label;
}

function nodeLine(n: FlowNode): string {
  return `${flowName(n.name)} [${n.icon ? `${n.kind}, icon: ${n.icon}` : n.kind}]`;
}

/** Recursive: the Mermaid converter caps nesting at 20 (MAX_GROUP_DEPTH), so the stack stays small. */
function groupLines(g: FlowGroup, byName: Map<string, FlowNode>, indent: string): string[] {
  const inner = `${indent}  `;
  const body = g.nodes.flatMap((name) => {
    const n = byName.get(name);
    return n ? [inner + nodeLine(n)] : [];
  });
  for (const child of g.groups) {
    if (body.length) body.push("");
    body.push(...groupLines(child, byName, inner));
  }
  return [`${indent}${flowName(g.name)} {`, ...body, `${indent}}`];
}

function grouped(groups: FlowGroup[], into: Set<string>) {
  for (const g of groups) {
    for (const n of g.nodes) into.add(n);
    grouped(g.groups, into);
  }
}

function linkLines(links: FlowLink[]): string[] {
  const lines: string[] = [];
  // The end of the last line while it can still take a chain link (it has no label).
  let open: string | null = null;
  for (const l of links) {
    if (l.chained && !l.label && open === l.from) {
      lines[lines.length - 1] += ` ${l.arrow} ${flowName(l.to)}`;
      open = l.to;
      continue;
    }
    const label = l.label ? `: ${flowLabel(l.label)}` : "";
    lines.push(`${flowName(l.from)} ${l.arrow} ${flowName(l.to)}${label}`);
    open = l.label ? null : l.to;
  }
  return lines;
}

/** The .flow text of `doc`: the diagram line, comments, ungrouped nodes, groups, then links, a blank line between parts. */
export function writeFlow(doc: FlowDoc): string {
  const byName = new Map(doc.nodes.map((n) => [n.name, n]));
  const inGroups = new Set<string>();
  grouped(doc.groups, inGroups);
  const parts: string[][] = [[`diagram flow ${quote(doc.title)}`]];
  if (doc.comments.length) parts.push(doc.comments.map((c) => (c.text ? `// ${c.text}` : "//")));
  const loose = doc.nodes.filter((n) => !inGroups.has(n.name)).map(nodeLine);
  if (loose.length) parts.push(loose);
  for (const g of doc.groups) parts.push(groupLines(g, byName, ""));
  if (doc.links.length) parts.push(linkLines(doc.links));
  return `${parts.map((p) => p.join("\n")).join("\n\n")}\n`;
}
