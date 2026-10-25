// A drawn diagram as an export scene, for Publish (spec 6+ section 8): every placed node at its canvas place and
// size, the group areas, and the lines routed as the canvas routes them. A sequence, mind map or timeline is placed
// from its text as the canvas places it, with its frames, activations, sections and axis (publish-parity).
// Cloud icons come from the pack as images and go into the scene as data: image URLs, unchanged (ruling P9).
import type { Scene, SceneArea, SceneEdge, SceneNode } from "../diagram/export/scene";
import type { Positions } from "../diagram/layout";
import { routeOrthogonal } from "../diagram/route";
import { axisKey } from "./layout";
import type { DrawnKind } from "../diagram/types";
import { type DiagramKind, type FlowArrow, type FlowDoc, type FlowGroup, shownName } from "../lang/flow/model";
import { drawnKind, familyOf, groupBoxes, nodeSize } from "./flowNodes";
import { fixedLayout, SEQ_HEAD, SEQ_ROW } from "./kindLayout";
import { iconPlate, loadIcon } from "./icons";
import { linkBox } from "./interactions/geometry";
import { drawnColour } from "./palette";
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
  // Step 12: a message has its head; the class marks are left out of the export's lines.
  "->": "end",
  "--": "none",
  "<|--": "start",
  "*--": "none",
};

/** A class line's ends, as the canvas marks them (flowNodes `markers`); a sequence reply's open head. */
function marksOf(arrow: FlowArrow, kind: DiagramKind): SceneEdge["marks"] | undefined {
  if (kind === "class") {
    if (arrow === "<|--") return { start: "triangle" };
    if (arrow === "*--") return { start: "diamond" };
    if (arrow === "..>") return { end: "open" };
    if (arrow === "-->") return { end: "arrow" };
    return undefined;
  }
  return undefined;
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function eachGroup(groups: FlowGroup[], visit: (g: FlowGroup) => void) {
  const stack = [...groups];
  while (stack.length) {
    const g = stack.pop()!;
    visit(g);
    stack.push(...g.groups);
  }
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
export function flowScene(
  doc: FlowDoc,
  given: Positions,
  look: NodeLook,
  icons: ReadonlyMap<string, string>,
  axes?: Readonly<Record<string, "v" | "h">>,
  folded?: ReadonlySet<string>,
): Scene {
  const placed = new Map<string, { x: number; y: number; w: number; h: number }>();
  const types = new Map<string, string>();
  const nodes: SceneNode[] = [];
  // A sequence, mind map or timeline is placed from its text, as the canvas places it.
  // A folded topic's subtopics are left out, as the canvas leaves them out (M3).
  const fixed = fixedLayout(doc, (n) => nodeSize(drawnKind(n.kind, doc.kind, n.name), look, shownName(n), n.attrs.id, n), folded?.size ? { folded } : {});
  const positions = fixed ? fixed.positions : given;
  // A participant's activation bars run from the top of its first message row to the bottom of its last (fixedGraph).
  const bars = new Map<string, { top: number; height: number }[]>();
  const rowY = (i: number) => fixed?.rows?.[i] ?? SEQ_HEAD + (i + 0.5) * SEQ_ROW;
  for (const a of doc.kind === "sequence" ? (doc.activations ?? []) : []) {
    const top = rowY(a.from) - SEQ_ROW / 2 + 6;
    bars.set(a.name, [...(bars.get(a.name) ?? []), { top, height: Math.max(SEQ_ROW - 12, rowY(Math.max(a.from, a.to)) + SEQ_ROW / 2 - 6 - top) }]);
  }
  for (const n of doc.nodes) {
    if (!own(positions, n.name)) continue;
    const kind = drawnKind(n.kind, doc.kind, n.name);
    const p = positions[n.name];
    const size = fixed?.sizes.get(n.name) ?? nodeSize(kind, look, shownName(n), n.attrs.id, n);
    placed.set(n.name, { x: p.x, y: p.y, ...size });
    types.set(n.name, familyOf(kind));
    // A labelled shape publishes the words it shows (step 11).
    const node: SceneNode = { id: n.name, kind, x: p.x, y: p.y, w: size.w, h: size.h, title: n.kind === "note" ? (n.text ?? n.name) : shownName(n), rows: (n.rows ?? []).map((r) => ({ left: r })), look };
    const colour = n.kind === "note" ? undefined : drawnColour(n.attrs.color);
    if (colour) node.color = colour;
    if (kind === "topic") node.depth = n.depth ?? 1;
    const active = bars.get(n.name);
    if (active) node.bars = active;
    if (n.attrs.id !== undefined) node.tag = n.attrs.id;
    if (n.attrs.table !== undefined) {
      node.sub = n.attrs.table;
      node.linked = true;
    } else if (familyOf(kind) === "dfd") node.sub = WORDS[kind];
    else if (kind === "milestone") node.sub = "Milestone";
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
  const groupColours = new Map<string, NonNullable<SceneArea["color"]>>();
  eachGroup(doc.groups, (g) => {
    const url = g.icon ? icons.get(g.icon) : undefined;
    if (url !== undefined) groupIcons.set(g.name, url);
    const colour = drawnColour(g.color);
    if (colour) groupColours.set(g.name, colour);
  });
  const areas: SceneArea[] = groupBoxes(doc.groups, placed)
    .sort((a, b) => a.depth - b.depth)
    .map(({ name, box, depth }) => {
      const area: SceneArea = { name, ...box, depth };
      const icon = groupIcons.get(name);
      if (icon !== undefined) area.icon = icon;
      const colour = groupColours.get(name);
      if (colour) area.color = colour;
      return area;
    });

  // A line meets a cloud service at its 48 px tile.
  const edges: SceneEdge[] = [];
  // A line to or from a group ends on its area, as on the canvas (fix round 2, L1).
  const areaBox = new Map(areas.map((a) => [a.name, { x: a.x, y: a.y, w: a.w, h: a.h }] as const));
  const centre = (b: { x: number; w: number }) => b.x + b.w / 2;
  doc.links.forEach((l, i) => {
    const a = placed.get(l.from) ?? areaBox.get(l.from);
    const b = placed.get(l.to) ?? areaBox.get(l.to);
    if (!a || !b) return;
    if (doc.kind === "sequence") {
      // A message along its row, lifeline to lifeline (SeqEdge); a reply dashed with an open head.
      const y = a.y + (fixed?.rows?.[i] ?? SEQ_HEAD + (i + 0.5) * SEQ_ROW);
      const x1 = centre(a);
      const points = l.from === l.to ? [{ x: x1, y: y - 8 }, { x: x1 + 40, y: y - 8 }, { x: x1 + 40, y: y + 8 }, { x: x1, y: y + 8 }] : [{ x: x1, y }, { x: centre(b), y }];
      const reply = l.arrow === "-->";
      const edge: SceneEdge = { id: `edge:${i}`, kind: "message", points, marks: { end: reply ? "open" : "arrow" } };
      if (reply) edge.line = "dashed";
      if (l.label) edge.label = l.label;
      edges.push(edge);
      return;
    }
    if (l.tree) {
      // A mind map branch: from the side of the parent that faces the child, a curve with no head (MindEdge).
      const right = centre(b) >= centre(a);
      edges.push({
        id: `edge:${i}`,
        kind: "branch",
        points: [
          { x: right ? a.x + a.w : a.x, y: a.y + a.h / 2 },
          { x: right ? b.x : b.x + b.w, y: b.y + b.h / 2 },
        ],
      });
      return;
    }
    const ab = linkBox(types.get(l.from), a);
    const bb = linkBox(types.get(l.to), b);
    const route = routeOrthogonal(ab, bb, axes?.[axisKey(l.from, l.to)] ? { axis: axes[axisKey(l.from, l.to)] } : {});
    const edge: SceneEdge = { id: `edge:${i}`, kind: "flow", points: route.points, heads: HEADS[l.arrow] };
    // A line between topics of a mind map is dashed on the canvas (fixedGraph).
    const line = fixed ? "dashed" : LINE[l.arrow];
    if (line) edge.line = line;
    const marks = marksOf(l.arrow, doc.kind);
    if (marks) edge.marks = marks;
    if (l.label) edge.label = l.label;
    const colour = drawnColour(l.color);
    if (colour) edge.color = colour;
    edges.push(edge);
  });
  const scene: Scene = { nodes, edges, areas };
  if (fixed?.frames?.length) scene.frames = fixed.frames.map((f) => ({ label: f.label, depth: f.depth, ...f.box }));
  if (fixed?.sections?.length) scene.sections = fixed.sections.map((sec) => ({ name: sec.name, ...sec.box }));
  if (fixed?.axis) {
    const ticks = doc.nodes.flatMap((n) => {
      const t = fixed.ticks?.get(n.name);
      return t ? [{ x: t.x, milestone: n.kind === "milestone" }] : [];
    });
    scene.axis = { x: fixed.axis.x, y: fixed.axis.y + fixed.axis.h / 2, w: fixed.axis.w, ticks };
  }
  return scene;

}
