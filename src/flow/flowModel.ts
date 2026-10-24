// The .flow writer. The types and the quoting rule live with the parser in src/lang/flow/model.ts;
// the parser reads everything this writes (ruling P2).
import {
  type DiagramKind,
  type FlowDoc,
  type FlowGroup,
  type FlowLink,
  type FlowNode,
  flowLabel,
  flowName,
  flowValue,
  linkEndText,
  MAX_GROUP_DEPTH,
  quote,
} from "../lang/flow/model";

export type { DiagramKind, FlowArrow, FlowDoc, FlowGroup, FlowKind, FlowLink, FlowNode, FlowNodeKind } from "../lang/flow/model";
export { flowName, needsQuotes } from "../lang/flow/model";

function nodeLine(n: FlowNode, kind: DiagramKind): string {
  // A cloud node is always a service, so its kind is left unsaid.
  const parts = kind === "cloud" && n.kind === "service" ? [] : [n.kind as string];
  for (const [key, value] of Object.entries(n.attrs)) parts.push(`${key}: ${flowValue(value)}`);
  return parts.length ? `${flowName(n.name)} [${parts.join(", ")}]` : flowName(n.name);
}

/** Two spaces per level, no deeper than the parser allows, so a doc built in code cannot make the text huge. */
const indentAt = (depth: number) => "  ".repeat(Math.min(depth, MAX_GROUP_DEPTH));

/** A group and everything in it, walked with a stack (never recursion), a blank line before each inner group. */
function groupLines(root: FlowGroup, byName: Map<string, FlowNode>, kind: DiagramKind): string[] {
  const lines: string[] = [];
  type Frame = { g: FlowGroup; depth: number; child: number; body: boolean };
  const open = (g: FlowGroup, depth: number): Frame => {
    const icon = g.icon !== undefined ? ` [icon: ${flowValue(g.icon)}]` : "";
    lines.push(`${indentAt(depth)}${flowName(g.name)}${icon} {`);
    let body = false;
    for (const name of g.nodes) {
      const n = byName.get(name);
      if (!n) continue;
      lines.push(indentAt(depth + 1) + nodeLine(n, kind));
      body = true;
    }
    return { g, depth, child: 0, body };
  };
  const stack = [open(root, 0)];
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.child < f.g.groups.length) {
      const child = f.g.groups[f.child++];
      if (f.body) lines.push("");
      f.body = true;
      stack.push(open(child, f.depth + 1));
    } else {
      lines.push(`${indentAt(f.depth)}}`);
      stack.pop();
    }
  }
  return lines;
}

function grouped(groups: FlowGroup[], into: Set<string>) {
  const stack = [...groups];
  for (let g = stack.pop(); g; g = stack.pop()) {
    for (const n of g.nodes) into.add(n);
    stack.push(...g.groups);
  }
}

function linkLines(links: FlowLink[]): string[] {
  const lines: string[] = [];
  // The end of the last line while it can still take a chain link (it has no label).
  let open: string | null = null;
  for (const l of links) {
    // An ER relationship's ends carry their columns (ER build C).
    const from = linkEndText(l.from, l.fromColumn);
    const to = linkEndText(l.to, l.toColumn);
    if (l.chained && !l.label && open === from) {
      lines[lines.length - 1] += ` ${l.arrow} ${to}`;
      open = to;
      continue;
    }
    const label = l.label ? `: ${flowLabel(l.label)}` : "";
    lines.push(`${from} ${l.arrow} ${to}${label}`);
    open = l.label ? null : to;
  }
  return lines;
}

/** The .flow text of `doc`: the diagram line, comments, ungrouped nodes, groups, then links, a blank line between parts. */
export function writeFlow(doc: FlowDoc): string {
  const byName = new Map(doc.nodes.map((n) => [n.name, n]));
  const inGroups = new Set<string>();
  grouped(doc.groups, inGroups);
  const parts: string[][] = [[`diagram ${doc.kind} ${quote(doc.title)}`]];
  // A comment ends at the line end, so a line break inside one becomes a space.
  const comment = (text: string) => text.replace(/[\r\n]+/g, " ");
  if (doc.comments.length) parts.push(doc.comments.map((c) => (c.text ? `// ${comment(c.text)}` : "//")));
  const loose = doc.nodes.filter((n) => !inGroups.has(n.name)).map((n) => nodeLine(n, doc.kind));
  if (loose.length) parts.push(loose);
  for (const g of doc.groups) parts.push(groupLines(g, byName, doc.kind));
  if (doc.links.length) parts.push(linkLines(doc.links));
  return `${parts.map((p) => p.join("\n")).join("\n\n")}\n`;
}
