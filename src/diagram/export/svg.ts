// A scene as plain SVG: rect, text, path and (for cloud icons) image elements only, no foreignObject and no web
// fonts, so other tools open it cleanly. Every colour comes from the palette, read from the tokens. A cloud icon
// is an <image> of the pack's own bytes as a data: URL, never inline markup (ruling P9).
import { iconPath, type IconName } from "../../components/Icon";
import { CARD_HEADER, CARD_ROW } from "../metrics";
import { roundedPath } from "../route";
import type { EdgeKind } from "../types";
import type { ExportPalette } from "./palette";
import { type Box, type Scene, type SceneArea, type SceneEdge, type SceneNode, sceneBounds } from "./scene";

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

/** Only a data: image is ever drawn; anything else (a link, a script URL) is left out. */
const SAFE_IMAGE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[^"<>\s]*$/i;
const imageSvg = (url: string, x: number, y: number, size: number) =>
  SAFE_IMAGE.test(url) ? `<image href="${esc(url)}" x="${num(x)}" y="${num(y)}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>` : "";

/** One of the app's own outline icons at `size` px, top-left at x, y. */
function glyph(name: IconName, x: number, y: number, size: number, stroke: string, part?: string): string {
  const k = size / 24;
  const tag = part ? ` data-part="${part}"` : "";
  return `<path${tag} d="${iconPath(name)}" transform="translate(${num(x)} ${num(y)}) scale(${num(k)})" fill="none" stroke="${stroke}" stroke-width="${num(1.5 / k)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

const text = (x: number, y: number, body: string, attrs = "") => `<text x="${num(x)}" y="${num(y)}"${attrs}>${esc(body)}</text>`;

/** About 7 px per character of the 13 px body font, as the canvas sizes nodes before it measures them. */
const textWidth = (s: string) => s.length * 7;

/** A data flow node in Modern or the Classic Gane-Sarson shapes (frame 6+.2). */
function dfdSvg(n: SceneNode, palette: ExportPalette, parts: string[]) {
  const { fill, stroke } = palette.nodes[n.kind];
  const { x, y, w, h } = n;
  const cy = y + h / 2;
  const subtle = ` font-size="11" fill="${palette.subtle}"`;
  if (n.look === "classic") {
    if (n.kind === "process") {
      // The id band on top, then the name.
      parts.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}"/>`,
        `<path data-part="band" d="M${x} ${y + 24} H${x + w}" fill="none" stroke="${stroke}"/>`,
        glyph("gear", x + 8, y + 5, 14, stroke),
      );
      if (n.tag) parts.push(text(x + 28, y + 16, n.tag, subtle));
      parts.push(text(x + w / 2, y + 24 + (h - 24) / 2 + 5, n.title, ` text-anchor="middle" font-weight="600"`));
    } else if (n.kind === "store") {
      // Open on the right, with the id cell on the left even before the store has an id.
      parts.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="none"/>`,
        `<path data-part="open-store" d="M${x + w} ${y} H${x + 6} Q${x} ${y} ${x} ${y + 6} V${y + h - 6} Q${x} ${y + h} ${x + 6} ${y + h} H${x + w}" fill="none" stroke="${stroke}"/>`,
        `<path data-part="id-cell" d="M${x + 40} ${y} V${y + h}" fill="none" stroke="${stroke}"/>`,
      );
      if (n.tag) parts.push(text(x + 20, cy + 4, n.tag, ` text-anchor="middle"${subtle}`));
      parts.push(text(x + 50, n.linked ? cy - 2 : cy + 5, n.title, ` font-weight="600"`));
      if (n.linked && n.sub) parts.push(glyph("link", x + 50, cy + 3, 11, stroke, "link"), text(x + 64, cy + 13, n.sub, subtle));
    } else {
      // An outside party: a heavy top-left edge.
      parts.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}"/>`,
        `<path data-part="heavy-edge" d="M${x + 1.5} ${y + h} V${y + 1.5} H${x + w}" fill="none" stroke="${stroke}" stroke-width="3"/>`,
        glyph("user", x + 14, cy - 7, 14, stroke),
        text(x + 34, cy + 5, n.title, ` font-weight="600"`),
      );
      if (n.tag) parts.push(text(x + w - 12, cy + 4, n.tag, ` text-anchor="end"${subtle}`));
    }
    return;
  }
  if (n.kind === "store") {
    // A dashed right edge.
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="none"/>`,
      `<path d="M${x + w} ${y} H${x + 8} Q${x} ${y} ${x} ${y + 8} V${y + h - 8} Q${x} ${y + h} ${x + 8} ${y + h} H${x + w}" fill="none" stroke="${stroke}"/>`,
      `<path data-part="open-edge" d="M${x + w} ${y} V${y + h}" fill="none" stroke="${stroke}" stroke-dasharray="4 3"/>`,
    );
  } else {
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}"/>`);
    // An outside party: a double edge.
    if (n.kind === "external") parts.push(`<rect data-part="double-edge" x="${x - 3}" y="${y - 3}" width="${w + 6}" height="${h + 6}" rx="11" fill="none" stroke="${stroke}"/>`);
  }
  const icon: IconName = n.kind === "process" ? "gear" : n.kind === "store" ? "database" : "user";
  parts.push(
    `<rect x="${x + 8}" y="${cy - 16}" width="32" height="32" rx="6" fill="${palette.surface}" stroke="${stroke}"/>`,
    glyph(icon, x + 16, cy - 8, 16, stroke),
    text(x + 50, cy - 3, n.title, ` font-weight="600"`),
  );
  if (n.sub) {
    if (n.linked) parts.push(glyph("link", x + 50, cy + 3, 11, stroke, "link"), text(x + 64, cy + 13, n.sub, subtle));
    else parts.push(text(x + 50, cy + 13, n.sub, subtle));
  }
  if (n.tag) parts.push(text(x + w - 12, cy + 4, n.tag, ` text-anchor="end"${subtle}`));
}

/** A flowchart node (frame 6+.4): pills, steps, the slanted io step and the one diamond. */
function flowchartSvg(n: SceneNode, palette: ExportPalette, parts: string[]) {
  const { fill, stroke } = palette.nodes[n.kind];
  const { x, y, w, h } = n;
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (n.kind === "decision") {
    // The 80 px square turned 45 degrees: 57 px from the middle to each point.
    const r = 57;
    parts.push(`<path data-part="diamond" d="M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z" fill="${fill}" stroke="${stroke}"/>`);
  } else if (n.kind === "io") {
    // Slanted 14 degrees, as the canvas skews it.
    const o = Math.round(h * Math.tan((14 * Math.PI) / 180));
    parts.push(`<path data-part="slant" d="M${x + o} ${y} H${x + w} L${x + w - o} ${y + h} H${x} Z" fill="${fill}" stroke="${stroke}"/>`);
  } else {
    const rx = n.kind === "start" || n.kind === "end" ? h / 2 : 6;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${num(rx)}" fill="${fill}" stroke="${stroke}"/>`);
    if (n.kind === "subprocess") parts.push(`<path data-part="sub-bars" d="M${x + 8} ${y} V${y + h} M${x + w - 8} ${y} V${y + h}" fill="none" stroke="${stroke}"/>`);
  }
  const link = n.kind === "io" && n.linked ? 18 : 0;
  const ty = n.tag ? cy : cy + 5;
  if (link) parts.push(glyph("link", cx - textWidth(n.title) / 2 - link / 2 - 4, ty - 10, 12, stroke, "link"));
  parts.push(text(cx + link / 2, ty, n.title, ` text-anchor="middle" font-weight="600"`));
  if (n.tag) parts.push(text(cx, ty + 14, n.tag, ` text-anchor="middle" font-size="11" fill="${palette.subtle}"`));
}

/** A cloud service (frame 6+.5): the 48 px tile with the icon unchanged, the name under it. */
function serviceSvg(n: SceneNode, palette: ExportPalette, parts: string[]) {
  const { x, y, w } = n;
  const tx = x + (w - 48) / 2;
  const url = n.icon && SAFE_IMAGE.test(n.icon) ? n.icon : null;
  if (n.iconName && !url) {
    // An icon the pack does not have, or one that could not be read: the dashed cube tile.
    parts.push(
      `<rect x="${num(tx)}" y="${y}" width="48" height="48" rx="6" fill="${palette.surface}" stroke="${palette.strongBorder}" stroke-dasharray="4 3"/>`,
      glyph("cube", tx + 14, y + 14, 20, palette.subtle),
    );
  } else if (n.plate !== false || !url) {
    // General and brand icons draw black, so they sit on the light plate in both themes.
    parts.push(`<rect x="${num(tx)}" y="${y}" width="48" height="48" rx="6" fill="${palette.iconTile}" stroke="${palette.border}"/>`);
    if (url) parts.push(imageSvg(url, tx + 4, y + 4, 40));
  } else parts.push(imageSvg(url, tx, y, 48));
  parts.push(text(x + w / 2, y + 66, n.title, ` text-anchor="middle" font-size="12"`));
  if (n.tag) parts.push(text(tx + 54, y + 12, n.tag, ` font-size="11" fill="${palette.subtle}"`));
}

/** A data flow node, flowchart node or cloud service, as frames 6+.2, 6+.4 and 6+.5 draw them. */
function drawnSvg(n: SceneNode, palette: ExportPalette): string {
  const parts: string[] = [];
  if (n.kind === "process" || n.kind === "store" || n.kind === "external") dfdSvg(n, palette, parts);
  else if (n.kind === "service") serviceSvg(n, palette, parts);
  else flowchartSvg(n, palette, parts);
  return `<g data-node="${esc(n.id)}">${parts.join("")}</g>`;
}

/** A group: a tinted area with its name at the top left; groups inside groups have a solid edge. */
function areaSvg(a: SceneArea, palette: ExportPalette): string {
  const dash = a.depth === 0 ? ` stroke-dasharray="5 4"` : "";
  const parts = [
    `<rect x="${num(a.x)}" y="${num(a.y)}" width="${num(a.w)}" height="${num(a.h)}" rx="10" fill="${palette.groupTint}" fill-opacity="0.7" stroke="${palette.group}"${dash}/>`,
  ];
  const icon = a.icon ? imageSvg(a.icon, a.x + 12, a.y + 8, 16) : "";
  parts.push(icon || `<rect x="${num(a.x + 12)}" y="${num(a.y + 8)}" width="16" height="16" rx="3" fill="${palette.group}"/>`);
  parts.push(text(a.x + 34, a.y + 21, a.name, ` font-size="12" font-weight="600"`));
  return `<g data-area="${esc(a.name)}">${parts.join("")}</g>`;
}

/** A 6 px arrowhead at `tip`, pointing away from `from`. */
function head(from: { x: number; y: number }, tip: { x: number; y: number }, fill: string): string {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y);
  const ux = len === 0 ? 1 : (tip.x - from.x) / len;
  const uy = len === 0 ? 0 : (tip.y - from.y) / len;
  const bx = tip.x - ux * 6;
  const by = tip.y - uy * 6;
  return `<path data-marker="head" d="M${num(tip.x)} ${num(tip.y)} L${num(bx - uy * 3)} ${num(by + ux * 3)} L${num(bx + uy * 3)} ${num(by - ux * 3)} Z" fill="${fill}"/>`;
}

/** A drawn diagram's or lineage's line: square with 8 px corners, 6 px heads, the label on a 6 px-radius chip. */
function flowEdgeSvg(e: SceneEdge, palette: ExportPalette): string {
  const pts = e.points;
  const stroke = palette.subtle;
  const dash = e.line === "dashed" ? ` stroke-dasharray="5 4"` : e.line === "dotted" ? ` stroke-dasharray="1 4" stroke-linecap="round"` : "";
  const parts = [`<path d="${roundedPath(pts)}" fill="none" stroke="${stroke}" stroke-width="1.5"${dash}/>`];
  const heads = e.heads ?? "end";
  if (heads === "end" || heads === "both") parts.push(head(pts[pts.length - 2], pts[pts.length - 1], stroke));
  if (heads === "start" || heads === "both") parts.push(head(pts[1], pts[0], stroke));
  if (e.label) {
    const i = Math.floor((pts.length - 1) / 2);
    const cx = (pts[i].x + pts[i + 1].x) / 2;
    const cy = (pts[i].y + pts[i + 1].y) / 2;
    const w = Math.ceil(e.label.length * 6.5 + 12);
    parts.push(
      `<rect data-part="chip" x="${num(cx - w / 2)}" y="${num(cy - 10)}" width="${w}" height="20" rx="6" fill="${palette.surface}" stroke="${palette.border}"/>`,
      text(cx, cy + 4, e.label, ` text-anchor="middle" font-size="11" fill="${palette.subtle}"`),
    );
  }
  return `<g data-edge="${esc(e.id)}">${parts.join("")}</g>`;
}

function nodeSvg(n: SceneNode, palette: ExportPalette): string {
  if (n.look) return drawnSvg(n, palette);
  const colours = palette.nodes[n.kind];
  const r = 6;
  const { x, y, w, h } = n;
  const header = `M${x} ${y + CARD_HEADER} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + CARD_HEADER} Z`;
  const parts = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${palette.surface}" stroke="${colours.stroke}"${n.dashed ? ` stroke-dasharray="5 4"` : ""}/>`,
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
  if (e.kind === "flow") return flowEdgeSvg(e, palette);
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
  const areas = (scene.areas ?? []).map((a) => areaSvg(a, palette)).join("");
  const edges = scene.edges.map((e) => edgeSvg(e, palette)).join("");
  const nodes = scene.nodes.map((n) => nodeSvg(n, palette)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.w}" height="${f.h}" viewBox="${f.x} ${f.y} ${f.w} ${f.h}" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="${palette.text}">${background}${areas}${edges}${nodes}${mark}</svg>\n`;
}
