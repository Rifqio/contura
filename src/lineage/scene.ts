// Where lineage draws each card: the table in the middle, the tables it uses on the
// left, the tables using it on the right, one column per Foreign Key step, and diagrams or views below.
import type { FlowTableAccess, Lineage, LineageTable, ObjectPath } from "../api/types";
import type { Scene, SceneEdge, SceneNode } from "../diagram/export/scene";
import { CARD_FOOTER, CARD_HEADER, CARD_ROW } from "../diagram/metrics";
import { routeOrthogonal } from "../diagram/route";

/** Lineage cards are 214 px. */
export const LINEAGE_CARD_WIDTH = 214;
/** A diagram or view card below the table. */
export const REF_HEIGHT = 56;
/** From one column of cards to the next: the card and a 90 px lane for the lines. */
const PITCH = LINEAGE_CARD_WIDTH + 90;
const GAP = 32;
const REF_GAP = 36;
const REF_DROP = 64;

export const tableId = (p: ObjectPath) => `t:${JSON.stringify([p.database, p.schema ?? null, p.name])}`;
export const refId = (i: number) => `ref:${i}`;

/** Columns the card leaves out: it shows only key, Foreign Key and pointed-to columns. */
export const moreColumns = (t: LineageTable) => (t.unreadable ? 0 : Math.max(0, t.columnCount - t.columns.length));

export function cardRows(t: LineageTable): number {
  return Math.max(1, t.columns.length + (moreColumns(t) > 0 ? 1 : 0) + (t.unreadable ? 1 : 0));
}

export const cardHeightOf = (t: LineageTable) => CARD_HEADER + CARD_ROW * cardRows(t) + CARD_FOOTER;

export type Positions = Record<string, { x: number; y: number }>;

/** Each card's top-left corner; the center card's is 0, 0. `refs` cards sit in one row under everything. */
export function layoutLineage(lineage: Lineage, refs: number): Positions {
  const out: Positions = {};
  const columns = new Map<number, LineageTable[]>();
  for (const t of lineage.tables) columns.set(t.distance, [...(columns.get(t.distance) ?? []), t]);
  const middle = lineage.tables[0] ? cardHeightOf(lineage.tables[0]) / 2 : 0;
  let bottom = 0;
  for (const [distance, tables] of columns) {
    const total = tables.reduce((sum, t) => sum + cardHeightOf(t), 0) + GAP * (tables.length - 1);
    let y = Math.round(middle - total / 2);
    for (const t of tables) {
      out[tableId(t.path)] = { x: distance * PITCH, y };
      y += cardHeightOf(t) + GAP;
    }
    bottom = Math.max(bottom, y - GAP);
  }
  const width = refs * LINEAGE_CARD_WIDTH + Math.max(0, refs - 1) * REF_GAP;
  const left = Math.round(LINEAGE_CARD_WIDTH / 2 - width / 2);
  for (let i = 0; i < refs; i++) out[refId(i)] = { x: left + i * (LINEAGE_CARD_WIDTH + REF_GAP), y: bottom + REF_DROP };
  return out;
}

/** A diagram or view card below the table, as Publish draws it. */
export interface SceneRef {
  kind: "flow" | "view";
  title: string;
  file: string;
  access: FlowTableAccess;
}

const samePlace = (a: ObjectPath, b: ObjectPath) => a.database === b.database && (a.schema ?? null) === (b.schema ?? null) && a.name === b.name;

/** Where a column's row sits on a card, or the card's middle for a column it does not show. */
function rowY(n: SceneNode, t: LineageTable, column: string | undefined): number {
  const i = column === undefined ? -1 : t.columns.findIndex((c) => c.name === column);
  return i < 0 ? n.y + n.h / 2 : n.y + CARD_HEADER + CARD_ROW * i + CARD_ROW / 2;
}

/** Square from the left card's right side to the right card's left side; round the right of both when they overlap. */
function rowRoute(a: SceneNode, ay: number, b: SceneNode, by: number): { x: number; y: number }[] {
  if (a.x + a.w <= b.x) {
    const mid = Math.round((a.x + a.w + b.x) / 2);
    return [
      { x: a.x + a.w, y: ay },
      { x: mid, y: ay },
      { x: mid, y: by },
      { x: b.x, y: by },
    ];
  }
  const out = Math.max(a.x + a.w, b.x + b.w) + 24;
  return [
    { x: a.x + a.w, y: ay },
    { x: out, y: ay },
    { x: out, y: by },
    { x: b.x + b.w, y: by },
  ];
}

/**
 * Lineage as an export scene, for Publish: the 214 px table cards with their key rows, the diagram or view cards
 * below as dashed cards, each Foreign Key as a line whose arrow points at the key's table, and the dashed lines
 * to the diagrams (into the table for a write, out of it for a read). `at` is where the canvas draws each card.
 */
export function lineageScene(lineage: Lineage, refs: SceneRef[], at: Positions): Scene {
  const place = (id: string) => (Object.prototype.hasOwnProperty.call(at, id) ? at[id] : { x: 0, y: 0 });
  const cards = new Map<string, { node: SceneNode; table: LineageTable }>();
  const nodes: SceneNode[] = lineage.tables.map((t) => {
    const id = tableId(t.path);
    const more = moreColumns(t);
    const node: SceneNode = {
      id,
      kind: "table",
      ...place(id),
      w: LINEAGE_CARD_WIDTH,
      h: cardHeightOf(t),
      title: t.path.name,
      subtitle: t.path.schema ?? t.path.database,
      rows: [
        ...t.columns.map((c) => ({
          left: c.name,
          right: c.nullable ? `${c.ty} ?` : c.ty,
          ...(c.pk ? { mark: "pk" as const } : c.fk ? { mark: "fk" as const } : {}),
        })),
        ...(more > 0 ? [{ left: `${more} more ${more === 1 ? "column" : "columns"}` }] : []),
        ...(t.unreadable ? [{ left: t.unreadable }] : []),
      ],
    };
    if (t.unreadable) node.dashed = true;
    cards.set(id, { node, table: t });
    return node;
  });
  refs.forEach((r, i) => {
    const id = refId(i);
    nodes.push({ id, kind: "view", ...place(id), w: LINEAGE_CARD_WIDTH, h: REF_HEIGHT, title: r.title, rows: [{ left: r.file }], dashed: true });
  });

  const edges: SceneEdge[] = [];
  lineage.links.forEach((l, i) => {
    const holder = cards.get(tableId(l.from));
    const key = cards.get(tableId(l.to));
    if (!holder || !key) return;
    // As the canvas draws it: from the card on the left; the arrow always points at the key's table.
    const holderLeft = holder.node.x <= key.node.x;
    const [a, ac, b, bc] = holderLeft ? [holder, l.fromColumns[0], key, l.toColumns[0]] : [key, l.toColumns[0], holder, l.fromColumns[0]];
    edges.push({
      id: `link:${i}`,
      kind: "flow",
      points: rowRoute(a.node, rowY(a.node, a.table, ac), b.node, rowY(b.node, b.table, bc)),
      heads: holderLeft ? "end" : "start",
    });
  });
  const center = cards.get(tableId(lineage.center)) ?? [...cards.values()].find((c) => samePlace(c.table.path, lineage.center));
  if (center) {
    refs.forEach((r, i) => {
      const card = nodes.find((n) => n.id === refId(i))!;
      edges.push({
        id: refId(i),
        kind: "flow",
        line: "dashed",
        points: routeOrthogonal(card, center.node).points,
        // Writes point into the table, reads out of it into the diagram or view.
        heads: r.access === "both" ? "both" : r.access === "writes" ? "end" : "start",
      });
    });
  }
  return { nodes, edges };
}
