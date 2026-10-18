// The query diagram as an export scene, for Publish: the cards, the Result and every line, where they are drawn.
import type { Scene, SceneEdge, SceneNode } from "../diagram/export/scene";
import type { Positions } from "../diagram/layout";
import { CARD_HEADER, CARD_ROW, QUERY_CARD_WIDTH, RESULT_WIDTH } from "../diagram/metrics";
import type { EdgeKind } from "../diagram/types";
import { type QueryShape, resultHeader, type ShapeJoin, type ShapeTable } from "../lang/sql/queryShape";
import { RESULT_ID } from "./ResultNode";
import { shapeKind } from "./ShapeCard";

/** The scene's edge kind of a query diagram line. */
export function lineKind(j: ShapeJoin): EdgeKind {
  return j.kind === "cross" ? "joinCross" : j.kind === "where" ? "where" : j.kind === "condition" ? "condition" : "join";
}

/** Rows as the export draws them: the columns, then "N more columns" and "Not in the schema". */
function cardRows(t: ShapeTable): SceneNode["rows"] {
  return [
    ...t.columns.map((c) => ({ left: c.name, ...(c.type ? { right: c.type } : {}), ...(c.pk ? { mark: "pk" as const } : {}) })),
    ...(t.more > 0 ? [{ left: `${t.more} more ${t.more === 1 ? "column" : "columns"}` }] : []),
    ...(t.kind === "unknown" ? [{ left: "Not in the schema" }] : []),
  ];
}

/** An orthogonal route between two points, leaving by the sides facing each other (both right when they overlap). */
function route(a: SceneNode, ay: number, b: SceneNode, by: number) {
  if (a.x + a.w <= b.x || b.x + b.w <= a.x) {
    const ltr = a.x + a.w <= b.x;
    const ax = ltr ? a.x + a.w : a.x;
    const bx = ltr ? b.x : b.x + b.w;
    const mid = Math.round((ax + bx) / 2);
    return [
      { x: ax, y: ay },
      { x: mid, y: ay },
      { x: mid, y: by },
      { x: bx, y: by },
    ];
  }
  const ax = a.x + a.w;
  const bx = b.x + b.w;
  const out = Math.max(ax, bx) + 24;
  return [
    { x: ax, y: ay },
    { x: out, y: ay },
    { x: out, y: by },
    { x: bx, y: by },
  ];
}

const rowY = (n: SceneNode, index: number) => n.y + CARD_HEADER + CARD_ROW * index + CARD_ROW / 2;

export function toScene(shape: QueryShape, positions: Positions): Scene {
  const at = (id: string, i: number) => positions[id] ?? { x: i * (QUERY_CARD_WIDTH + 80), y: 0 };
  const cards: SceneNode[] = shape.tables.map((t, i) => {
    const rows = cardRows(t);
    return {
      id: t.key,
      kind: shapeKind(t),
      ...at(t.key, i),
      w: QUERY_CARD_WIDTH,
      h: CARD_HEADER + CARD_ROW * rows.length + 8,
      title: t.alias && t.alias !== t.name ? `${t.name} ${t.alias}` : t.name,
      ...(t.schema ? { subtitle: t.schema } : {}),
      rows,
    };
  });
  const r = shape.result;
  const resultRows = [
    ...r.columns.map((c) => ({ left: c.source !== c.name ? `${c.name}  ${c.source}` : c.name, ...(c.type ? { right: c.type } : {}) })),
    ...(r.more > 0 ? [{ left: `${r.more} more ${r.more === 1 ? "column" : "columns"}` }] : []),
  ];
  const footer = r.clauses.map((c) => (c.text ? `${c.keyword} ${c.text}` : c.keyword));
  const result: SceneNode = {
    id: RESULT_ID,
    kind: "result",
    ...at(RESULT_ID, shape.tables.length),
    w: RESULT_WIDTH,
    h: CARD_HEADER + CARD_ROW * (resultRows.length + footer.length) + 8,
    title: "Result",
    subtitle: resultHeader(shape),
    rows: resultRows,
    ...(footer.length ? { footer } : {}),
  };

  const byId = new Map(cards.map((n) => [n.id, n]));
  const tableOf = new Map(shape.tables.map((t) => [t.key, t]));
  const portY = (key: string, column: string) => {
    const n = byId.get(key)!;
    const i = tableOf.get(key)?.columns.findIndex((c) => c.name === column) ?? -1;
    // A column not shown as a row (past the first 30) leaves from the header.
    return i < 0 ? n.y + CARD_HEADER / 2 : rowY(n, i);
  };

  const edges: SceneEdge[] = [];
  shape.joins.forEach((j, i) => {
    const a = byId.get(j.from);
    const b = byId.get(j.to);
    if (!a || !b) return;
    // One line per ON pair, as on the canvas; the first carries the label.
    const pairs = j.ports?.length ? j.ports : [null];
    pairs.forEach((pair, k) => {
      const ay = pair ? portY(j.from, pair.from.port) : a.y + CARD_HEADER / 2;
      const by = pair ? portY(j.to, pair.to.port) : b.y + CARD_HEADER / 2;
      edges.push({ id: `join-${i}-${k}`, kind: lineKind(j), points: route(a, ay, b, by), ...(k === 0 ? { label: j.label } : {}) });
    });
  });
  r.columns.forEach((c, i) => {
    if (i >= result.rows.length) return;
    c.from.forEach((p, k) => {
      const a = byId.get(p.node);
      if (!a) return;
      edges.push({ id: `lineage-${i}-${k}`, kind: "lineage", points: route(a, portY(p.node, p.port), result, rowY(result, i)) });
    });
  });
  return { nodes: [...cards, result], edges };
}
