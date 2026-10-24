// A drawn diagram (data flow, flowchart or cloud) as an export scene, for Publish (spec 6+ section 8): every
// placed node at its canvas place and size, the group areas, and the lines routed as the canvas routes them.
// Cloud icons come from the pack as images and go into the scene as data: image URLs, unchanged (ruling P9).
import type { Scene, SceneArea, SceneEdge, SceneNode, SceneRow } from "../diagram/export/scene";
import type { Positions } from "../diagram/layout";
import { routeOrthogonal, routeRows } from "../diagram/route";
import type { DrawnKind } from "../diagram/types";
import type { FlowArrow, FlowDoc, FlowGroup, FlowNode } from "../lang/flow/model";
import { drawnKind, familyOf, groupBoxes, nodeSize } from "./flowNodes";
import { erColumnRow, erRowY, fixedLayout } from "./kindLayout";
import { iconPlate, loadIcon } from "./icons";
import { linkBox } from "./interactions/geometry";
import type { NodeLook } from "./nodes/parts";

/** The kind in words, as the Modern card's second line says it (the step 12 shapes name theirs in KIND_WORD). */
const WORDS: Partial<Record<DrawnKind, string>> = {
  process: "Process",
  store: "Data store",
  external: "Outside party",
  start: "Start",
  end: "End",
  step: "Step",
  decision: "Decision",
  io: "Input or output",
  subprocess: "Subprocess",
  service: "Service",
};

const LINE: Partial<Record<FlowArrow, SceneEdge["line"]>> = { "-->": "dashed", "..>": "dotted" };
/** `>` and `-->` one way, `<>` both ways; `-` and the cloud's dotted "assumes" line have no head (frame 6+.5). */
const HEADS: Record<FlowArrow, NonNullable<SceneEdge["heads"]>> = {
  ">": "end",
  "-->": "end",
  "<>": "both",
  "-": "none",
  "..>": "none",
  // Step 12: a message has its head; the ER ends and the class marks are left out of the export's lines.
  "->": "end",
  "--": "none",
  "1--*": "none",
  "*--1": "none",
  "1--1": "none",
  "*--*": "none",
  "<|--": "start",
  "*--": "none",
};

/** The step 12 cards export as table cards with their rows. */
const CARD_KINDS: ReadonlySet<DrawnKind> = new Set(["erTable", "erWeak", "class", "interface", "enum"]);

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function eachGroup(groups: FlowGroup[], visit: (g: FlowGroup) => void) {
  const stack = [...groups];
  while (stack.length) {
    const g = stack.pop()!;
    visit(g);
    stack.push(...g.groups);
  }
}

/**
 * A card's rows in the export: an ER column as its name with its type on the right and its key marked, as the
 * canvas draws it (A5); a class member as written.
 */
function cardRows(n: FlowNode, kind: DrawnKind): SceneRow[] {
  const rows = n.rows ?? [];
  if (kind !== "erTable" && kind !== "erWeak") return rows.map((r) => ({ left: r }));
  return rows.map((r, i) => {
    const at = r.search(/\s/);
    const row: SceneRow = { left: at < 0 ? r : r.slice(0, at) };
    const type = at < 0 ? "" : r.slice(at + 1).trim();
    if (type) row.right = type;
    const flags = n.rowFlags?.[i] ?? [];
    if (flags.includes("pk")) row.mark = "pk";
    if (flags.includes("pk") || flags.includes("not null")) row.notNull = true;
    return row;
  });
}

/** Every icon name the diagram's services and groups ask for, once each. */
export function sceneIconNames(doc: FlowDoc): string[] {
  const names = new Set<string>();
  for (const n of doc.nodes) if (drawnKind(n.kind) === "service" && n.attrs.icon) names.add(n.attrs.icon);
  eachGroup(doc.groups, (g) => {
    if (g.icon) names.add(g.icon);
  });
  return [...names];
}

/**
 * An icon's image URL as a self-contained `data:image/svg+xml;base64,` URL, so other tools open the export;
 * null for anything that is not a data: image. The bytes are the pack's own, unchanged.
 */
export function embeddedIcon(url: string): string | null {
  const plain = /^data:image\/svg\+xml;charset=utf-8,/.exec(url);
  if (plain) {
    const bytes = new TextEncoder().encode(decodeURIComponent(url.slice(plain[0].length)));
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/svg+xml;base64,${btoa(binary)}`;
  }
  return /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(url) ? url : null;
}

/**
 * Loads only the icons `names` lists, through the same cache the canvas uses. An icon the pack does not have,
 * or one that could not be read, is left out, and the export draws the dashed cube tile for it.
 */
export async function loadSceneIcons(names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    names.map((name) =>
      loadIcon(name).then(
        (url) => {
          const data = url && embeddedIcon(url);
          if (data) out.set(name, data);
        },
        () => {},
      ),
    ),
  );
  return out;
}

/** The scene of `doc` at `positions`; a node without a place is left out, as the canvas leaves it out. */
export function flowScene(doc: FlowDoc, given: Positions, look: NodeLook, icons: ReadonlyMap<string, string>): Scene {
  const placed = new Map<string, { x: number; y: number; w: number; h: number }>();
  const types = new Map<string, string>();
  const nodes: SceneNode[] = [];
  // A sequence, mind map or timeline is placed from its text, as the canvas places it.
  const fixed = fixedLayout(doc, (n) => nodeSize(drawnKind(n.kind, doc.kind, n.name), look, n.name, n.attrs.id, n));
  const positions = fixed ? fixed.positions : given;
  for (const n of doc.nodes) {
    if (!own(positions, n.name)) continue;
    const kind = drawnKind(n.kind, doc.kind, n.name);
    const p = positions[n.name];
    const size = fixed?.sizes.get(n.name) ?? nodeSize(kind, look, n.name, n.attrs.id, n);
    placed.set(n.name, { x: p.x, y: p.y, ...size });
    types.set(n.name, familyOf(kind));
    if (CARD_KINDS.has(kind)) {
      nodes.push({ id: n.name, kind: "table", x: p.x, y: p.y, w: size.w, h: size.h, title: n.name, rows: cardRows(n, kind) });
      continue;
    }
    const node: SceneNode = { id: n.name, kind, x: p.x, y: p.y, w: size.w, h: size.h, title: n.kind === "note" ? (n.text ?? n.name) : n.name, rows: [], look };
    if (n.attrs.id !== undefined) node.tag = n.attrs.id;
    if (n.attrs.table !== undefined) {
      node.sub = n.attrs.table;
      node.linked = true;
    } else if (familyOf(kind) === "dfd") node.sub = WORDS[kind];
    else if (n.date) node.sub = n.until ? `${n.date} to ${n.until}` : n.date;
    if (kind === "service") {
      const name = n.attrs.icon;
      if (name) {
        node.iconName = name;
        node.plate = iconPlate(name);
        const url = icons.get(name);
        if (url !== undefined) node.icon = url;
      } else node.plate = true;
    }
    nodes.push(node);
  }

  const groupIcons = new Map<string, string>();
  eachGroup(doc.groups, (g) => {
    const url = g.icon ? icons.get(g.icon) : undefined;
    if (url !== undefined) groupIcons.set(g.name, url);
  });
  const areas: SceneArea[] = groupBoxes(doc.groups, placed)
    .sort((a, b) => a.depth - b.depth)
    .map(({ name, box, depth }) => {
      const area: SceneArea = { name, ...box, depth };
      const icon = groupIcons.get(name);
      if (icon !== undefined) area.icon = icon;
      return area;
    });

  // Lines between nodes only, as the canvas draws them; a line meets a cloud service at its 48 px tile.
  const edges: SceneEdge[] = [];
  const rowsOf = new Map(doc.nodes.map((n) => [n.name, n.rows ?? []]));
  doc.links.forEach((l, i) => {
    const a = placed.get(l.from);
    const b = placed.get(l.to);
    if (!a || !b) return;
    const ab = linkBox(types.get(l.from), a);
    const bb = linkBox(types.get(l.to), b);
    // A relationship between columns meets each card at its column's row, as on the canvas (ER build C).
    const rows = l.fromColumn !== undefined || l.toColumn !== undefined;
    const route = rows
      ? routeRows(ab, erRowY(ab.y, ab.h, erColumnRow(rowsOf.get(l.from) ?? [], l.fromColumn)), bb, erRowY(bb.y, bb.h, erColumnRow(rowsOf.get(l.to) ?? [], l.toColumn)), l.from === l.to)
      : routeOrthogonal(ab, bb);
    const edge: SceneEdge = { id: `edge:${i}`, kind: "flow", points: route.points, heads: HEADS[l.arrow] };
    const line = LINE[l.arrow];
    if (line) edge.line = line;
    if (l.label) edge.label = l.label;
    edges.push(edge);
  });
  return { nodes, edges, areas };
}
