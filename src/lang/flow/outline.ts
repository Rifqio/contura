// The outline of a .flow text for the diagram assistant: what the Core checks a proposal against. It reads the
// parse, so it works while the text has errors; the ids and kinds come from the last good doc then.
import type { FlowOutline } from "../../api/types";
import { type FlowDoc, KINDS } from "./model";
import type { FlowParse } from "./parse";

/**
 * Nodes and groups in the order they are defined, each with its 1-based line (the parse's `defined` map) and the
 * group it is in; links with the line each is written on (`linkLines`). A node's id and kind come from
 * `parse.doc ?? last`, so a shape the last good doc does not know has none until the text parses again.
 */
export function flowOutline(parse: FlowParse, last: FlowDoc | null): FlowOutline {
  const doc = parse.doc ?? last;
  const byName = new Map(doc?.nodes.map((n) => [n.name, n]));
  const out: FlowOutline = { kind: parse.kind, kinds: parse.kind ? [...KINDS[parse.kind]] : [], nodes: [], groups: [], links: [] };
  for (const [name, line] of parse.defined) {
    const group = parse.parentOf(name) ?? null;
    if (parse.span(`group:${name}`)) {
      out.groups.push({ name, group, line });
      continue;
    }
    const node = byName.get(name);
    const table = node ? node.attrs.table !== undefined : !!parse.span(`node:${name}`)?.values?.table;
    out.nodes.push({ name, id: node?.attrs.id ?? null, kind: node?.kind ?? null, group, line, table });
  }
  parse.links.forEach((l, i) => out.links.push({ from: l.from, to: l.to, label: l.label ?? null, line: parse.linkLines[i] }));
  return out;
}
