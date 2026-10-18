// The Schema Builder's diagram as an export scene, drawn by the engine's sceneToSvg.
import type { SchemaModel } from "../api/types";
import { CARD_HEADER, CARD_ROW, CARD_WIDTH, cardHeight } from "../diagram/metrics";
import { type ExportPalette, exportPalette } from "../diagram/export/palette";
import type { Scene, SceneEdge, SceneNode } from "../diagram/export/scene";
import { sceneToSvg } from "../diagram/export/svg";
import { tableKey } from "../lang/protocol";
import type { Layout } from "./layout";

/** The Schema Builder's own exports: the light colours, 40 px round the cards, no mark. */
export const SCHEMA_EXPORT = { padding: 40, background: "theme", mark: false } as const;

/** Each table as a card at its layout position, and each Ref as an orthogonal edge from its many side to its one side. */
export function schemaScene(model: SchemaModel, layout: Layout): Scene {
  const fk = new Map<string, Set<string>>();
  for (const r of model.refs) {
    const k = tableKey({ schema: r.from.schema, name: r.from.table });
    const set = fk.get(k) ?? new Set<string>();
    for (const c of r.from.columns) set.add(c);
    fk.set(k, set);
  }
  const nodes: SceneNode[] = model.tables.map((t, i) => {
    const key = tableKey(t);
    const p = layout.tables[key] ?? { x: (i % 4) * 300, y: Math.floor(i / 4) * 320 };
    const pkIndex = new Set(t.indexes.filter((x) => x.pk).flatMap((x) => x.columns));
    return {
      id: key,
      kind: "table",
      x: p.x,
      y: p.y,
      w: CARD_WIDTH,
      h: cardHeight(t.columns.length),
      title: t.alias ? `${t.name} as ${t.alias}` : t.name,
      subtitle: t.schema ?? undefined,
      rows: t.columns.map((c) => ({
        left: c.name,
        right: c.typeName,
        mark: c.pk || pkIndex.has(c.name) ? "pk" : fk.get(key)?.has(c.name) ? "fk" : undefined,
      })),
    };
  });
  const byKey = new Map(nodes.map((n) => [n.id, n]));
  const rowOf = (t: SchemaModel["tables"][number] | undefined, col: string) => Math.max(0, t?.columns.findIndex((c) => c.name === col) ?? 0);
  const edges: SceneEdge[] = model.refs.flatMap((r, i) => {
    const fromKey = tableKey({ schema: r.from.schema, name: r.from.table });
    const toKey = tableKey({ schema: r.to.schema, name: r.to.table });
    const a = byKey.get(fromKey);
    const b = byKey.get(toKey);
    if (!a || !b) return [];
    const ay = a.y + CARD_HEADER + CARD_ROW * rowOf(model.tables.find((t) => tableKey(t) === fromKey), r.from.columns[0]) + 12;
    const by = b.y + CARD_HEADER + CARD_ROW * rowOf(model.tables.find((t) => tableKey(t) === toKey), r.to.columns[0]) + 12;
    // Each end leaves by the side facing the other card; cards above one another both use their right side (as on the canvas).
    let points;
    if (a.x + a.w <= b.x || b.x + b.w <= a.x) {
      const ltr = a.x + a.w <= b.x;
      const ax = ltr ? a.x + a.w : a.x;
      const bx = ltr ? b.x : b.x + b.w;
      const mid = Math.round((ax + bx) / 2);
      points = [
        { x: ax, y: ay },
        { x: mid, y: ay },
        { x: mid, y: by },
        { x: bx, y: by },
      ];
    } else {
      const ax = a.x + a.w;
      const bx = b.x + b.w;
      const out = Math.max(ax, bx) + 24;
      points = [
        { x: ax, y: ay },
        { x: out, y: ay },
        { x: out, y: by },
        { x: bx, y: by },
      ];
    }
    return [{ id: `ref-${i}`, kind: "fk" as const, points }];
  });
  return { nodes, edges };
}

export function exportSvg(model: SchemaModel, layout: Layout, palette: ExportPalette = exportPalette("light")): string {
  return sceneToSvg(schemaScene(model, layout), palette, SCHEMA_EXPORT);
}
