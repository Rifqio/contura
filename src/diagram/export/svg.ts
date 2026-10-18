// A scene as plain SVG: rect, text and path elements only, no foreignObject and no web fonts,
// so other tools open it cleanly. Every colour comes from the palette, read from the tokens.
import { CARD_HEADER, CARD_ROW } from "../metrics";
import type { EdgeKind } from "../types";
import type { ExportPalette } from "./palette";
import { type Box, type Scene, type SceneEdge, type SceneNode, sceneBounds } from "./scene";

export interface SvgOptions {
  /** The part of the scene to draw, in scene units; the whole scene when absent. */
  crop?: Box;
  /** Room around the crop, in scene units. */
  padding: number;
  background: "theme" | "transparent";
  /** "Made with Contura" in the bottom right corner. */
  mark: boolean;
}

export const MARK_TEXT = "Made with Contura";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => String(Math.round(n * 100) / 100);

/** The image's frame in scene units: the crop (or the whole scene) with the padding round it, on whole units. */
export function svgFrame(scene: Scene, opts: Pick<SvgOptions, "crop" | "padding">): Box {
  const base = opts.crop ?? sceneBounds(scene);
  const x = Math.floor(base.x - opts.padding);
  const y = Math.floor(base.y - opts.padding);
  return { x, y, w: Math.ceil(base.x + base.w + opts.padding) - x, h: Math.ceil(base.y + base.h + opts.padding) - y };
}

function nodeSvg(n: SceneNode, palette: ExportPalette): string {
  const colours = palette.nodes[n.kind];
  const r = 6;
  const { x, y, w, h } = n;
  const header = `M${x} ${y + CARD_HEADER} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + CARD_HEADER} Z`;
  const parts = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${palette.surface}" stroke="${colours.stroke}"/>`,
    `<path d="${header}" fill="${colours.fill}"/>`,
    `<path d="M${x} ${y + CARD_HEADER} H${x + w}" fill="none" stroke="${colours.stroke}"/>`,
    `<text x="${x + 10}" y="${y + 21}" font-weight="600">${esc(n.title)}</text>`,
  ];
  if (n.subtitle) parts.push(`<text x="${x + w - 10}" y="${y + 21}" text-anchor="end" font-size="12" fill="${palette.subtle}">${esc(n.subtitle)}</text>`);
  const marked = n.rows.some((row) => row.mark);
  const nameX = x + (marked ? 32 : 10);
  n.rows.forEach((row, i) => {
    const ty = y + CARD_HEADER + CARD_ROW * i + 16;
    if (row.mark) parts.push(`<text x="${x + 10}" y="${ty}" font-size="9" font-weight="600" fill="${palette.subtle}">${row.mark.toUpperCase()}</text>`);
    parts.push(`<text x="${nameX}" y="${ty}">${esc(row.left)}</text>`);
    if (row.right) parts.push(`<text x="${x + w - 10}" y="${ty}" text-anchor="end" fill="${palette.type}">${esc(row.right)}</text>`);
  });
  const footer = n.footer ?? [];
  if (footer.length > 0) {
    const top = y + CARD_HEADER + CARD_ROW * n.rows.length;
    if (n.rows.length > 0) parts.push(`<path d="M${x} ${top} H${x + w}" fill="none" stroke="${palette.border}"/>`);
    footer.forEach((line, j) => {
      const ty = top + CARD_ROW * j + 16;
      const space = line.indexOf(" ");
      const word = space < 0 ? line : line.slice(0, space);
      const rest = space < 0 ? "" : line.slice(space);
      parts.push(`<text x="${x + 10}" y="${ty}"><tspan fill="${palette.keyword}">${esc(word)}</tspan>${esc(rest)}</text>`);
    });
  }
  return `<g data-node="${esc(n.id)}">${parts.join("")}</g>`;
}

const DASH: Partial<Record<EdgeKind, string>> = { joinPending: "5 4", joinCross: "5 4", where: "1.5 3" };

function edgeSvg(e: SceneEdge, palette: ExportPalette): string {
  const pts = e.points;
  if (pts.length < 2) return "";
  const stroke = palette.subtle;
  const width = e.kind === "lineage" ? 1 : 1.5;
  const dash = DASH[e.kind] ? ` stroke-dasharray="${DASH[e.kind]}"` : "";
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${num(p.x)} ${num(p.y)}`).join(" ");
  const parts = [`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash}/>`];
  // The unit direction from a toward b, and its normal; a zero-length segment points right.
  const dir = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = len === 0 ? 1 : (b.x - a.x) / len;
    const uy = len === 0 ? 0 : (b.y - a.y) / len;
    return { ux, uy, nx: -uy, ny: ux };
  };
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (e.kind === "fk") {
    // Many side at the start: a crow's foot spreading onto the card edge.
    const s = dir(first, pts[1]);
    const q = { x: first.x + s.ux * 10, y: first.y + s.uy * 10 };
    parts.push(
      `<path data-marker="crow" d="M${num(q.x)} ${num(q.y)} L${num(first.x + s.nx * 5)} ${num(first.y + s.ny * 5)} M${num(q.x)} ${num(q.y)} L${num(first.x - s.nx * 5)} ${num(first.y - s.ny * 5)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`,
    );
    // One side at the end: a bar across the line.
    const t = dir(pts[pts.length - 2], last);
    const b = { x: last.x - t.ux * 8, y: last.y - t.uy * 8 };
    parts.push(
      `<path data-marker="bar" d="M${num(b.x + t.nx * 5)} ${num(b.y + t.ny * 5)} L${num(b.x - t.nx * 5)} ${num(b.y - t.ny * 5)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`,
    );
  } else if (e.kind === "lineage") {
    const t = dir(pts[pts.length - 2], last);
    const base = { x: last.x - t.ux * 6, y: last.y - t.uy * 6 };
    parts.push(
      `<path data-marker="arrow" d="M${num(last.x)} ${num(last.y)} L${num(base.x + t.nx * 3)} ${num(base.y + t.ny * 3)} L${num(base.x - t.nx * 3)} ${num(base.y - t.ny * 3)} Z" fill="${stroke}"/>`,
    );
  }
  if (e.label) {
    // On the middle segment, in a pill on the canvas colour.
    const i = Math.floor((pts.length - 1) / 2);
    const cx = (pts[i].x + pts[i + 1].x) / 2;
    const cy = (pts[i].y + pts[i + 1].y) / 2;
    const w = Math.ceil(e.label.length * 6.5 + 16);
    parts.push(
      `<rect x="${num(cx - w / 2)}" y="${num(cy - 9)}" width="${w}" height="18" rx="9" fill="${palette.canvas}" stroke="${palette.border}"/>`,
      `<text x="${num(cx)}" y="${num(cy + 4)}" text-anchor="middle" font-size="11" fill="${palette.subtle}">${esc(e.label)}</text>`,
    );
  }
  return `<g data-edge="${esc(e.id)}">${parts.join("")}</g>`;
}

export function sceneToSvg(scene: Scene, palette: ExportPalette, opts: SvgOptions): string {
  const f = svgFrame(scene, opts);
  const background = opts.background === "theme" ? `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" fill="${palette.canvas}"/>` : "";
  const mark = opts.mark
    ? `<text x="${f.x + f.w - 8}" y="${f.y + f.h - 8}" text-anchor="end" font-size="11" fill="${palette.subtle}">${MARK_TEXT}</text>`
    : "";
  const edges = scene.edges.map((e) => edgeSvg(e, palette)).join("");
  const nodes = scene.nodes.map((n) => nodeSvg(n, palette)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.w}" height="${f.h}" viewBox="${f.x} ${f.y} ${f.w} ${f.h}" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="${palette.text}">${background}${edges}${nodes}${mark}</svg>\n`;
}
