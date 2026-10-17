// Canvas positions, kept in `<name>.dbml.layout.json` beside the DBML (ADR 0007).
import type { SchemaModel } from "../api/types";
import { tableKey } from "../lang/protocol";

export type Layout = {
  version: 1;
  /** Keyed by `tableKey`. */
  tables: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
};

export const EMPTY_LAYOUT: Layout = { version: 1, tables: {} };

/** The one card size: layout, canvas CSS and exports all use these (app.css `.table-card*` repeats them). */
export const CARD_WIDTH = 216;
export const CARD_HEADER = 32;
export const CARD_ROW = 24;
/** Below the rows: the column list's 4 px padding top and bottom (the card has no Add column row). */
export const CARD_FOOTER = 8;
export const cardHeight = (columns: number) => CARD_HEADER + CARD_ROW * columns + CARD_FOOTER;

function isPoint(v: unknown): v is { x: number; y: number } {
  return (
    typeof v === "object" && v !== null && Number.isFinite((v as { x: number }).x) && Number.isFinite((v as { y: number }).y)
  );
}

/** Never throws: anything unreadable becomes an empty layout. */
export function parseLayout(json: string): Layout {
  try {
    const raw = JSON.parse(json) as { version?: unknown; tables?: unknown; viewport?: unknown };
    if (raw.version !== 1 || typeof raw.tables !== "object" || raw.tables === null) return { version: 1, tables: {} };
    const tables: Layout["tables"] = {};
    for (const [k, v] of Object.entries(raw.tables)) if (isPoint(v)) tables[k] = { x: v.x, y: v.y };
    const vp = raw.viewport as Layout["viewport"];
    const viewport = vp && isPoint(vp) && Number.isFinite(vp.zoom) ? { x: vp.x, y: vp.y, zoom: vp.zoom } : undefined;
    return viewport ? { version: 1, tables, viewport } : { version: 1, tables };
  } catch {
    return { version: 1, tables: {} };
  }
}

/** Stable key order and 2-space JSON, so the file diffs well in git. */
export function serializeLayout(l: Layout): string {
  const tables = Object.fromEntries(Object.keys(l.tables).sort().map((k) => [k, l.tables[k]]));
  const out: Layout = l.viewport ? { version: 1, tables, viewport: l.viewport } : { version: 1, tables };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Moves a position to a renamed table's new key, so the card stays where it was.
 * A rename is one table key gone and one new key without a position; anything else returns `l` unchanged.
 */
export function followRenames(l: Layout, before: SchemaModel, after: SchemaModel): Layout {
  const was = new Set(before.tables.map(tableKey));
  const now = new Set(after.tables.map(tableKey));
  const gone = [...was].filter((k) => !now.has(k));
  const added = [...now].filter((k) => !was.has(k));
  if (gone.length !== 1 || added.length !== 1 || !l.tables[gone[0]] || l.tables[added[0]]) return l;
  const { [gone[0]]: pos, ...rest } = l.tables;
  return { ...l, tables: { ...rest, [added[0]]: pos } };
}

/** Places only the tables `existing` lacks, with dagre (loaded on first use). */
export async function autoLayout(model: SchemaModel, existing: Layout): Promise<Layout> {
  const missing = model.tables.filter((t) => !existing.tables[tableKey(t)]);
  if (missing.length === 0) return existing;
  const { default: dagre } = await import("@dagrejs/dagre");
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const t of model.tables) g.setNode(tableKey(t), { width: CARD_WIDTH, height: cardHeight(t.columns.length) });
  for (const r of model.refs) {
    const from = tableKey({ schema: r.from.schema, name: r.from.table });
    const to = tableKey({ schema: r.to.schema, name: r.to.table });
    if (g.hasNode(from) && g.hasNode(to)) g.setEdge(to, from);
  }
  dagre.layout(g);
  const tables = { ...existing.tables };
  // Shift new tables below anything already placed, so they never land on top of it.
  const placed = Object.values(existing.tables);
  const offsetY = placed.length ? Math.max(...placed.map((p) => p.y)) + 400 : 0;
  for (const t of missing) {
    const n = g.node(tableKey(t));
    tables[tableKey(t)] = { x: Math.round(n.x - CARD_WIDTH / 2), y: Math.round(n.y - n.height / 2 + offsetY) };
  }
  return { ...existing, tables };
}
