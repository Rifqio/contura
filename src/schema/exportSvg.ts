// The diagram as plain SVG built from the model and layout: rect, text and path
// elements only, no foreignObject and no web fonts, so other tools open it cleanly.
import type { SchemaModel } from "../api/types";
import { tableKey } from "../lang/protocol";
import { type ExportPalette, exportPalette } from "./exportPalette";
import { CARD_HEADER, CARD_ROW, CARD_WIDTH, type Layout } from "./layout";

const PAD = 40;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function exportSvg(model: SchemaModel, layout: Layout, palette: ExportPalette = exportPalette()): string {
  const pos = new Map(
    model.tables.map((t, i) => [
      tableKey(t),
      layout.tables[tableKey(t)] ?? { x: (i % 4) * 300, y: Math.floor(i / 4) * 320 },
    ]),
  );
  const height = (cols: number) => CARD_HEADER + CARD_ROW * cols;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const cards = model.tables.map((t) => {
    const p = pos.get(tableKey(t))!;
    const h = height(t.columns.length);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + CARD_WIDTH);
    maxY = Math.max(maxY, p.y + h);
    const rows = t.columns
      .map((c, i) => {
        const y = p.y + CARD_HEADER + CARD_ROW * i + 16;
        return `<text x="${p.x + 10}" y="${y}">${esc(c.name)}</text><text x="${p.x + CARD_WIDTH - 10}" y="${y}" text-anchor="end" fill="${palette.type}">${esc(c.typeName)}</text>`;
      })
      .join("");
    return `<g><rect x="${p.x}" y="${p.y}" width="${CARD_WIDTH}" height="${h}" rx="6" fill="${palette.surface}" stroke="${palette.stroke}"/><rect x="${p.x}" y="${p.y}" width="${CARD_WIDTH}" height="${CARD_HEADER}" rx="6" fill="${palette.fill}"/><line x1="${p.x}" y1="${p.y + CARD_HEADER}" x2="${p.x + CARD_WIDTH}" y2="${p.y + CARD_HEADER}" stroke="${palette.border}"/><text x="${p.x + 10}" y="${p.y + 21}" font-weight="600">${esc(t.name)}</text>${rows}</g>`;
  });
  const paths = model.refs.flatMap((r) => {
    const from = model.tables.find((t) => tableKey(t) === tableKey({ schema: r.from.schema, name: r.from.table }));
    const to = model.tables.find((t) => tableKey(t) === tableKey({ schema: r.to.schema, name: r.to.table }));
    if (!from || !to) return [];
    const a = pos.get(tableKey(from))!;
    const b = pos.get(tableKey(to))!;
    const ay = a.y + CARD_HEADER + CARD_ROW * Math.max(0, from.columns.findIndex((c) => c.name === r.from.columns[0])) + 12;
    const by = b.y + CARD_HEADER + CARD_ROW * Math.max(0, to.columns.findIndex((c) => c.name === r.to.columns[0])) + 12;
    const leftToRight = a.x <= b.x;
    const ax = leftToRight ? a.x + CARD_WIDTH : a.x;
    const bx = leftToRight ? b.x : b.x + CARD_WIDTH;
    const mid = (ax + bx) / 2;
    return [`<path d="M${ax} ${ay} C${mid} ${ay} ${mid} ${by} ${bx} ${by}" fill="none" stroke="${palette.subtle}" stroke-width="1.5"/>`];
  });
  if (model.tables.length === 0) minX = minY = maxX = maxY = 0;
  // Frame every card, wherever it was dragged, with the image at the frame's own size.
  const x = Math.floor(minX - PAD);
  const y = Math.floor(minY - PAD);
  const w = Math.ceil(maxX + PAD) - x;
  const h = Math.ceil(maxY + PAD) - y;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="${palette.text}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${palette.surface}"/>${paths.join("")}${cards.join("")}</svg>\n`;
}
