// The review overlay: the proposed diagram drawn with what the proposal removes still in it, so the canvas can
// ring the new parts and ghost the removed ones.
import type { FlowDoc, FlowGroup, FlowLink } from "../../lang/flow/model";

const linkKey = (l: FlowLink) => `${l.from}\u0000${l.arrow}\u0000${l.to}\u0000${l.label ?? ""}`;

/** How many of each link `doc` has. */
function linkCounts(links: readonly FlowLink[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of links) m.set(linkKey(l), (m.get(linkKey(l)) ?? 0) + 1);
  return m;
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

/**
 * `draw` is the proposed doc plus the removed shapes (each back in its group, which is drawn again when the
 * proposal removes it too) and the removed links, after the proposed ones. `added` and `removed` are shape names;
 * `addedLinks` and `removedLinks` index `draw.links`. A link is the same link when its ends, arrow and label are.
 * Neither doc is changed.
 */
export function reviewOverlay(
  current: FlowDoc,
  proposed: FlowDoc,
): { draw: FlowDoc; added: Set<string>; removed: Set<string>; addedLinks: Set<number>; removedLinks: Set<number> } {
  const before = new Set(current.nodes.map((n) => n.name));
  const after = new Set(proposed.nodes.map((n) => n.name));
  const added = new Set([...after].filter((n) => !before.has(n)));
  const removedNodes = current.nodes.filter((n) => !after.has(n.name));
  const removed = new Set(removedNodes.map((n) => n.name));

  const groups: FlowGroup[] = structuredClone(proposed.groups);
  for (const node of removedNodes) {
    const path = pathTo(current.groups, node.name);
    if (!path) continue;
    // Walk the groups the node was in, making any that the proposal removed.
    let level = groups;
    let target: FlowGroup | undefined;
    for (const g of path) {
      target = level.find((x) => x.name === g.name);
      if (!target) {
        target = { name: g.name, nodes: [], groups: [], ...(g.icon !== undefined ? { icon: g.icon } : {}) };
        level.push(target);
      }
      level = target.groups;
    }
    target?.nodes.push(node.name);
  }

  const addedLinks = new Set<number>();
  const removedLinks = new Set<number>();
  const links: FlowLink[] = [...proposed.links];
  const had = linkCounts(current.links);
  proposed.links.forEach((l, i) => {
    const n = had.get(linkKey(l)) ?? 0;
    if (n > 0) had.set(linkKey(l), n - 1);
    else addedLinks.add(i);
  });
  const kept = linkCounts(proposed.links);
  for (const l of current.links) {
    const n = kept.get(linkKey(l)) ?? 0;
    if (n > 0) {
      kept.set(linkKey(l), n - 1);
      continue;
    }
    removedLinks.add(links.length);
    links.push(l);
  }

  const draw: FlowDoc = { ...proposed, nodes: [...proposed.nodes, ...removedNodes], groups, links };
  return { draw, added, removed, addedLinks, removedLinks };
}
