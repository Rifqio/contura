// The review overlay: the proposed diagram drawn with what the proposal removes still in it, so the canvas can
// ring the new parts, ghost the removed ones and tint the changed ones; an ERD's columns are marked on their rows.
import { type FlowDoc, type FlowGroup, type FlowLink, type FlowNode, splitRow } from "../../lang/flow/model";
import { numberingOn, numberingOnAtEnd } from "../../lang/flow/numbering";

/** What the canvas draws for a proposal, and which of its parts are new, gone or changed. */
export interface ReviewOverlay {
  draw: FlowDoc;
  /** Whether numbering is on in the proposed doc: `draw` ends numbering before the removed messages, so it cannot say. */
  numbering: boolean;
  added: Set<string>;
  removed: Set<string>;
  changed: Set<string>;
  addedLinks: Set<number>;
  removedLinks: Set<number>;
  changedLinks: Set<number>;
  addedRows: Map<string, Set<string>>;
  removedRows: Map<string, Set<string>>;
  changedRows: Map<string, Set<string>>;
}

/** A line's ends, columns included: the same ends with another label or arrow is the same line, changed. */
const endsKey = (l: FlowLink) => `${l.from}\u0000${l.fromColumn ?? ""}\u0000${l.to}\u0000${l.toColumn ?? ""}`;
/** A line as a whole: its ends and columns, arrow and label. */
const linkKey = (l: FlowLink) => `${endsKey(l)}\u0000${l.arrow}\u0000${l.label ?? ""}`;

/** Pushes `value` onto the list at `key`. */
function push<K, V>(m: Map<K, V[]>, key: K, value: V) {
  const at = m.get(key);
  if (at) at.push(value);
  else m.set(key, [value]);
}

function addTo(m: Map<string, Set<string>>, key: string, value: string) {
  const s = m.get(key);
  if (s) s.add(value);
  else m.set(key, new Set([value]));
}

/** The group names from the top down to the one holding `name` (a node or group), or null when it is in none. */
function pathTo(groups: readonly FlowGroup[], name: string, trail: FlowGroup[] = []): FlowGroup[] | null {
  for (const g of groups) {
    if (g.nodes.includes(name)) return [...trail, g];
    const deeper = pathTo(g.groups, name, [...trail, g]);
    if (deeper) return deeper;
  }
  return null;
}

/** Each shape's group path, by name, read in one walk. */
function paths(groups: readonly FlowGroup[], rename: (name: string) => string = (n) => n): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (g: FlowGroup, trail: string) => {
    const here = `${trail}\u0000${rename(g.name)}`;
    for (const n of g.nodes) out.set(n, here);
    for (const c of g.groups) walk(c, here);
  };
  for (const g of groups) walk(g, "");
  return out;
}

/** Every group name, at any depth. */
const groupNames = (groups: readonly FlowGroup[]): string[] => groups.flatMap((g) => [g.name, ...groupNames(g.groups)]);

const isTable = (n: FlowNode) => n.kind === "entity" || n.kind === "weak";

/** A row as it is compared: its text, flags and comment. */
const rowSig = (n: FlowNode, i: number) => `${n.rows?.[i] ?? ""}\u0000${(n.rowFlags?.[i] ?? []).join(",")}\u0000${n.rowComments?.[i] ?? ""}`;

/** A table's columns, by name, to their row index. */
const columns = (n: FlowNode) => new Map((n.rows ?? []).map((r, i) => [splitRow(r).name, i]));

/**
 * `draw` is the proposed doc plus the removed shapes (each back in its group, which is drawn again when the
 * proposal removes it too), the removed links after the proposed ones, and in each ER table the removed columns back
 * where they were. `added`, `removed` and `changed` are shape names; the link sets index `draw.links`; the row maps
 * go from a table's proposed name to column names.
 *
 * `renames` maps a shape's (or group's) current name to its proposed one (accepted `rename_node`s): it is one shape,
 * drawn once under its new name and marked changed, and its lines are the same lines. A shape whose group path or kind
 * changed is changed too. `columnRenames` maps an ER table's proposed name to its renamed columns, current name to
 * proposed (accepted `set_column`s with a `name`): each is one changed row. `removedRows` names removed columns as
 * the current doc does, as their ghost rows show them. A line is the same line when its ends
 * (columns included), arrow and label are; one with the same ends and another label or arrow is changed. Neither doc
 * is changed.
 */
export function reviewOverlay(
  current: FlowDoc,
  proposed: FlowDoc,
  renames: ReadonlyMap<string, string> = new Map(),
  columnRenames: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
): ReviewOverlay {
  /** A current name as the proposal names it. */
  const now = (name: string) => renames.get(name) ?? name;
  const after = new Map(proposed.nodes.map((n) => [n.name, n]));
  const was = new Map<string, FlowNode>();
  for (const n of current.nodes) was.set(now(n.name), n);
  const added = new Set([...after.keys()].filter((n) => !was.has(n)));
  const removedNodes = current.nodes.filter((n) => !after.has(now(n.name)));
  const removed = new Set(removedNodes.map((n) => n.name));

  const changed = new Set<string>();
  const addedRows = new Map<string, Set<string>>();
  const removedRows = new Map<string, Set<string>>();
  const changedRows = new Map<string, Set<string>>();
  /** Proposed tables drawn with their removed columns back in. */
  const withRows = new Map<string, FlowNode>();
  const wasIn = paths(current.groups, now);
  const isIn = paths(proposed.groups);
  for (const [name, p] of after) {
    const c = was.get(name);
    if (!c) continue;
    if (c.name !== name || c.kind !== p.kind || (wasIn.get(c.name) ?? "") !== (isIn.get(name) ?? "")) changed.add(name);
    if (!isTable(c) || !isTable(p)) continue;
    // The current columns under their proposed names, so a renamed column meets itself.
    const renamedCols = columnRenames.get(name);
    const before = renamedCols ? new Map([...columns(c)].map(([col, j]) => [renamedCols.get(col) ?? col, j])) : columns(c);
    const next = columns(p);
    for (const [col, i] of next) {
      const j = before.get(col);
      if (j === undefined) addTo(addedRows, name, col);
      else if (rowSig(c, j) !== rowSig(p, i)) addTo(changedRows, name, col);
    }
    const gone = [...before].filter(([col]) => !next.has(col));
    if (gone.length === 0) continue;
    // Each removed column goes back where it was, after the rows that came before it; flags and comments with it.
    const rows = [...(p.rows ?? [])];
    const flags = c.rowFlags || p.rowFlags ? rows.map((_, i) => p.rowFlags?.[i] ?? []) : undefined;
    const notes = c.rowComments || p.rowComments ? rows.map((_, i) => p.rowComments?.[i]) : undefined;
    for (const [, j] of gone) {
      // A removed row is marked by its current name, the name its ghost row shows (a column renamed and then removed
      // by the same proposal is drawn and marked as the column it was).
      addTo(removedRows, name, splitRow(c.rows![j]).name);
      const at = Math.min(j, rows.length);
      rows.splice(at, 0, c.rows![j]);
      flags?.splice(at, 0, c.rowFlags?.[j] ?? []);
      notes?.splice(at, 0, c.rowComments?.[j]);
    }
    withRows.set(name, { ...p, rows, ...(flags ? { rowFlags: flags } : {}), ...(notes ? { rowComments: notes } : {}) });
  }

  // A renamed group is one group, changed (its shapes are not moved: their group paths go through `renames`).
  if (renames.size > 0) {
    const had = new Set(groupNames(current.groups));
    const has = new Set(groupNames(proposed.groups));
    for (const [from, to] of renames) if (from !== to && had.has(from) && has.has(to)) changed.add(to);
  }

  const groups: FlowGroup[] = structuredClone(proposed.groups);
  for (const node of removedNodes) {
    const path = pathTo(current.groups, node.name);
    if (!path) continue;
    // Walk the groups the node was in, making any that the proposal removed.
    let level = groups;
    let target: FlowGroup | undefined;
    for (const g of path) {
      const name = now(g.name);
      target = level.find((x) => x.name === name);
      if (!target) {
        target = { name, nodes: [], groups: [], ...(g.icon !== undefined ? { icon: g.icon } : {}) };
        level.push(target);
      }
      level = target.groups;
    }
    target?.nodes.push(node.name);
  }

  // The current lines under the proposal's names, so a renamed shape's lines are the same lines.
  const renamed = renames.size === 0 ? current.links : current.links.map((l) => ({ ...l, from: now(l.from), to: now(l.to) }));
  const addedLinks = new Set<number>();
  const removedLinks = new Set<number>();
  const changedLinks = new Set<number>();
  /** The current lines not yet met by a proposed one, in order. */
  const left = new Set(renamed.keys());
  const whole = new Map<string, number[]>();
  renamed.forEach((l, j) => push(whole, linkKey(l), j));
  const unmet: number[] = [];
  proposed.links.forEach((l, i) => {
    const j = whole.get(linkKey(l))?.shift();
    if (j === undefined) unmet.push(i);
    else left.delete(j);
  });
  if (unmet.length > 0) {
    // Then the same ends with another label or arrow: the line changed.
    const ends = new Map<string, number[]>();
    for (const j of left) push(ends, endsKey(renamed[j]), j);
    for (const i of unmet) {
      const j = ends.get(endsKey(proposed.links[i]))?.shift();
      if (j === undefined) addedLinks.add(i);
      else {
        changedLinks.add(i);
        left.delete(j);
      }
    }
  }
  const links: FlowLink[] = [...proposed.links];
  for (const j of left) {
    removedLinks.add(links.length);
    links.push(renamed[j]);
  }

  const nodes = withRows.size === 0 ? proposed.nodes : proposed.nodes.map((n) => withRows.get(n.name) ?? n);
  const draw: FlowDoc = { ...proposed, nodes: [...nodes, ...removedNodes], groups, links };
  // A sequence numbering on at its end stops before the removed messages, so they take no number and their ghosted
  // lines start on the lifeline: only the proposed messages are numbered, as they will be once accepted.
  if (left.size > 0 && numberingOnAtEnd(proposed)) draw.autonumber = [...(proposed.autonumber ?? []), { from: proposed.links.length, off: true }];
  return { draw, numbering: numberingOn(proposed), added, removed, changed, addedLinks, removedLinks, changedLinks, addedRows, removedRows, changedRows };
}
