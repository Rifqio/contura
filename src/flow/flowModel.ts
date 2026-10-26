// The .flow writer. The types and the quoting rule live with the parser in src/lang/flow/model.ts;
// the parser reads everything this writes (ruling P2).
import {
  type DiagramKind,
  type FlowDoc,
  type FlowGroup,
  type FlowLink,
  type FlowNode,
  attrItems,
  flowLabel,
  flowName,
  flowValue,
  MAX_GROUP_DEPTH,
  isStateMarker,
  linkEndText,
  nodeStatement,
  quote,
  tableText,
} from "../lang/flow/model";

export type { DiagramKind, FlowArrow, FlowDoc, FlowGroup, FlowKind, FlowLink, FlowNode, FlowNodeKind } from "../lang/flow/model";
export { flowName, needsQuotes } from "../lang/flow/model";

function nodeLine(n: FlowNode, kind: DiagramKind): string {
  if (kind === "er") return tableText(n);
  // Step 10: the newer kinds write their own statement (`interface Payable`, `Check [choice]`, `note: text`), and a
  // class's members follow on their own lines.
  if (kind !== "dfd" && kind !== "flow" && kind !== "cloud") {
    const own = nodeStatement(kind, n);
    return kind === "class" && n.rows?.length ? [own, ...n.rows.map((r) => `${flowName(n.name)} : ${r}`)].join("\n") : own;
  }
  // A cloud node is always a service, so its kind is left unsaid.
  const parts = kind === "cloud" && n.kind === "service" ? [] : [n.kind as string];
  parts.push(...attrItems(n.attrs));
  return parts.length ? `${flowName(n.name)} [${parts.join(", ")}]` : flowName(n.name);
}

/** Two spaces per level, no deeper than the parser allows, so a doc built in code cannot make the text huge. */
const indentAt = (depth: number) => "  ".repeat(Math.min(depth, MAX_GROUP_DEPTH));

/** A group and everything in it, walked with a stack (never recursion), a blank line before each inner group. */
function groupLines(root: FlowGroup, byName: Map<string, FlowNode>, kind: DiagramKind, own: Map<string, FlowLink[]> = new Map()): string[] {
  const lines: string[] = [];
  type Frame = { g: FlowGroup; depth: number; child: number; body: boolean };
  const open = (g: FlowGroup, depth: number): Frame => {
    // A group takes an icon and a colour (step 11), in the attribute order.
    const items = [...(g.icon !== undefined ? [`icon: ${flowValue(g.icon)}`] : []), ...(g.color !== undefined ? [`color: ${flowValue(g.color)}`] : [])];
    // An ER group says so (`group Billing {`): a block of tables would otherwise read as a table.
    lines.push(`${indentAt(depth)}${kind === "er" ? "group " : ""}${flowName(g.name)}${items.length ? ` [${items.join(", ")}]` : ""} {`);
    let body = false;
    for (const name of g.nodes) {
      const n = byName.get(name);
      // A composite's own start and end are written only by its `[*]` lines (I4).
      if (!n || (kind === "state" && isStateMarker(name))) continue;
      // Every line of a node written on several lines (a table's columns, a class's members) takes the indent.
      for (const line of nodeLine(n, kind).split("\n")) lines.push(indentAt(depth + 1) + line);
      body = true;
    }
    // The lines to and from its own [*], inside its braces, so they read back as its own.
    for (const l of linkLines(own.get(g.name) ?? [])) {
      lines.push(indentAt(depth + 1) + l);
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
    // A state diagram's start and end markers are both written [*].
    // An ER relationship's ends carry their columns.
    const from = isStateMarker(l.from) ? "[*]" : linkEndText(l.from, l.fromColumn);
    const to = isStateMarker(l.to) ? "[*]" : linkEndText(l.to, l.toColumn);
    // A coloured line is written on its own (step 11): its colour goes after it, so nothing chains on.
    if (l.chained && !l.label && l.color === undefined && open === from) {
      lines[lines.length - 1] += ` ${l.arrow} ${to}`;
      open = to;
      continue;
    }
    const label = l.label ? `: ${flowLabel(l.label)}` : "";
    const color = l.color !== undefined ? ` [color: ${flowValue(l.color)}]` : "";
    lines.push(`${from} ${l.arrow} ${to}${label}${color}`);
    open = l.label || l.color !== undefined ? null : to;
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
  const loose = doc.nodes.filter((n) => !inGroups.has(n.name) && !(doc.kind === "state" && isStateMarker(n.name))).map((n) => nodeLine(n, doc.kind));
  if (loose.length) parts.push(loose);
  // A state composite's own [*] lines go inside its braces (I4); every other line after the groups.
  const own = new Map<string, FlowLink[]>();
  const rest: FlowLink[] = [];
  for (const l of doc.links) {
    const m = doc.kind === "state" ? [l.from, l.to].find((n) => isStateMarker(n) && n.includes(" in ")) : undefined;
    const g = m ? m.slice(m.indexOf(" in ") + 4) : null;
    if (g === null) rest.push(l);
    else own.set(g, [...(own.get(g) ?? []), l]);
  }
  for (const g of doc.groups) parts.push(groupLines(g, byName, doc.kind, own));
  if (rest.length) parts.push(linkLines(rest));
  return `${parts.map((p) => p.join("\n")).join("\n\n")}\n`;
}

/** A board's .flow text: each diagram written by `writeFlow`, one blank line between; one doc is exactly `writeFlow(doc)`. */
export function writeBoard(docs: readonly FlowDoc[]): string {
  return docs.map(writeFlow).join("\n");
}
