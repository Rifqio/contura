// Canvas positions, kept in `<name>.dbml.layout.json` beside the DBML (ADR 0007).
import type { SchemaModel } from "../api/types";
import { type LayoutRequest, layoutMissing, parseLayoutFile, type Positions, serializeLayoutFile } from "../diagram/layout";
import { CARD_WIDTH, cardHeight } from "../diagram/metrics";
import { tableKey } from "../lang/protocol";

/** The Schema Builder's file keeps its `tables` key. */
const TABLES = "tables";

export type Layout = {
  version: 1;
  /** Keyed by `tableKey`. */
  tables: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
};

export const EMPTY_LAYOUT: Layout = { version: 1, tables: {} };

export { CARD_FOOTER, CARD_HEADER, CARD_ROW, CARD_WIDTH, cardHeight } from "../diagram/metrics";

/** Never throws: anything unreadable becomes an empty layout. */
export function parseLayout(json: string): Layout {
  const { nodes: tables, viewport } = parseLayoutFile(json, TABLES);
  return viewport ? { version: 1, tables, viewport } : { version: 1, tables };
}

/** Stable key order and 2-space JSON, so the file diffs well in git. */
export function serializeLayout(l: Layout): string {
  return serializeLayoutFile({ version: 1, nodes: l.tables, viewport: l.viewport }, TABLES);
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

/** Places only the tables `existing` lacks; `run` is the language worker's layout when there is a client. */
export async function autoLayout(
  model: SchemaModel,
  existing: Layout,
  run: (r: LayoutRequest) => Promise<Positions> = layoutMissing,
): Promise<Layout> {
  if (model.tables.every((t) => existing.tables[tableKey(t)])) return existing;
  const edges = model.refs.map((r) => ({
    from: tableKey({ schema: r.to.schema, name: r.to.table }),
    to: tableKey({ schema: r.from.schema, name: r.from.table }),
  }));
  const tables = await run({
    nodes: model.tables.map((t) => ({ id: tableKey(t), w: CARD_WIDTH, h: cardHeight(t.columns.length) })),
    edges,
    existing: existing.tables,
    rankdir: "LR",
  });
  return { ...existing, tables };
}
