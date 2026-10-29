// A scene as plain SVG: g, rect, text, tspan, path and (for cloud icons) image and use elements only, plus one <defs>, no
// foreignObject and no web fonts, so other tools open it cleanly. Each kind is drawn as the canvas draws it
// (flow-canvas.css, kindNodes.tsx). Every colour comes from the palette, read from the tokens. A cloud icon is an <image>
// of the pack's own bytes as a data: URL, never inline markup; a pale logo on light also takes the one
// hairline filter. The <defs> appears at most once and holds only that filter, made of filter primitives only, and
// each shared icon image once (`<image id href="data:image/...">`, drawn by `<use href="#id">`).
// The writer comes in parts: `sceneBody` draws a scene, `svgDefs` the shared defs and `wrapSvg` the head,
// background and mark round them; `sceneToSvg` is the three in a row.
import { iconPath, type IconName } from "../../components/Icon";
import { ER_FAR_ROW, SOFT_CHAR_W } from "../canvasView";
import { contrastRatio, FAINT, logoHex } from "../../flow/icons";
import { erMetrics, messageLabelW, SEQ_HEAD } from "../../flow/kindLayout";
import { seqColours } from "../../flow/seqColour";
import { ACT_W } from "../../flow/seqGeometry";
import { CARD_HEADER, CARD_ROW } from "../metrics";
import { roundedPath } from "../route";
import type { EdgeKind } from "../types";
import { type ExportPalette, type ExportTheme, sceneColour } from "./palette";
import { type Box, type Scene, type SceneArea, type SceneAxis, type SceneColour, type SceneEdge, type SceneFrame, type SceneMark, type SceneNode, type SceneSection, sceneBounds } from "./scene";

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

/** A crop handle: a corner or a side. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
/** The smallest crop, in scene units. */
export const MIN_CROP = 16;

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => String(Math.round(n * 100) / 100);

/** The image's frame in scene units: the crop (or `bounds`) with the padding round it, on whole units. */
export function frameOf(bounds: Box, opts: Pick<SvgOptions, "crop" | "padding">): Box {
  const base = opts.crop ?? bounds;
  const x = Math.floor(base.x - opts.padding);
  const y = Math.floor(base.y - opts.padding);
  return { x, y, w: Math.ceil(base.x + base.w + opts.padding) - x, h: Math.ceil(base.y + base.h + opts.padding) - y };
}

/** The image's frame for one scene: `frameOf` its bounds. */
export const svgFrame = (scene: Scene, opts: Pick<SvgOptions, "crop" | "padding">): Box => frameOf(opts.crop ?? sceneBounds(scene), opts);

/**
 * The crop with its dragged edges on the nearest node or group edge within `reach` scene units, so nothing is cut
 * in half (direction spec, Publish). A moved box keeps its size and takes the smaller of its two snaps per axis.
 */
export function snapCrop(box: Box, handle: Handle | "move", edges: { xs: number[]; ys: number[] }, reach: number): Box {
  const { xs, ys } = edges;
  /** The shift that puts `v` on the nearest edge in reach, or null. */
  const pull = (v: number, list: number[]): number | null => {
    let best: number | null = null;
    for (const t of list) if (Math.abs(t - v) <= reach && (best === null || Math.abs(t - v) < Math.abs(best))) best = t - v;
    return best;
  };
  let x0 = box.x;
  let y0 = box.y;
  let x1 = box.x + box.w;
  let y1 = box.y + box.h;
  if (handle === "move") {
    const pick = (a: number | null, b: number | null) => (a === null ? (b ?? 0) : b === null || Math.abs(a) <= Math.abs(b) ? a : b);
    const dx = pick(pull(x0, xs), pull(x1, xs));
    const dy = pick(pull(y0, ys), pull(y1, ys));
    return { ...box, x: box.x + dx, y: box.y + dy };
  }
  if (handle.includes("w")) x0 += pull(x0, xs) ?? 0;
  if (handle.includes("e")) x1 += pull(x1, xs) ?? 0;
  if (handle.includes("n")) y0 += pull(y0, ys) ?? 0;
  if (handle.includes("s")) y1 += pull(y1, ys) ?? 0;
  if (x1 - x0 < MIN_CROP || y1 - y0 < MIN_CROP) return box;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The xlink namespace, declared once on the root of an image that holds a `<use>` (`wrapSvg`). */
export const XLINK_NS = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const XLINK_HREF = " xlink:href=";
/**
 * A `<use>`'s reference to `id`, the shared image it draws: `href` for SVG 2 readers and `xlink:href` for SVG 1.1 ones
 * (Inkscape before 1.0, older librsvg and converters draw nothing without it). `id` is an icon id, word characters only.
 */
export const useHref = (id: string) => `href="#${id}"${XLINK_HREF}"#${id}"`;
/** True when `body` holds a `<use>` reference, so its image declares the xlink namespace. */
export const usesXlink = (body: string) => body.includes(XLINK_HREF);

/** Only a data: image is ever drawn; anything else (a link, a script URL) is left out. */
export const SAFE_IMAGE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[^"<>\s]*$/i;
/**
 * An icon at x, y, `size` px square: inline as an <image>, or, while `sceneBody` draws with icon references, a <use> of
 * the one shared image. An outlined one names the hairline filter either way.
 */
function imageSvg(url: string, x: number, y: number, size: number, outline?: boolean): string {
  if (!SAFE_IMAGE.test(url)) return "";
  const filter = outline ? ` filter="url(#${hairline})"` : "";
  if (refsInUse) return `<use ${useHref(refsInUse.ref(url, size))} x="${num(x)}" y="${num(y)}"${filter}/>`;
  return `<image href="${esc(url)}" x="${num(x)}" y="${num(y)}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"${filter}/>`;
}

/** The hairline a pale logo draws with on light (the canvas's `icon-hairline`): its shape grown half a unit, in the text colour, under it. */
const HAIRLINE = "icon-hairline";
/** The hairline filter's id: `icon-hairline` for one diagram, `icon-hairline-<theme>` on a board (L6). */
export const hairlineId = (theme?: ExportTheme): string => (theme ? `${HAIRLINE}-${theme}` : HAIRLINE);
const hairlineFilter = (palette: ExportPalette, id: string) =>
  `<filter id="${esc(id)}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">` +
  `<feMorphology in="SourceAlpha" operator="dilate" radius="0.5" result="grown"/><feFlood flood-color="${palette.text}"/>` +
  `<feComposite in2="grown" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

/** Icons drawn by reference: each distinct picture and size gets one stable id, its image drawn once in `<defs>`. */
export interface IconRefs {
  /** The id of `url` at `size`; call it only for a URL `SAFE_IMAGE` passes. */
  ref(url: string, size: number): string;
  /** Every id handed out, in first-seen order, with its picture: the live map, so it grows with later `ref` calls. */
  entries(): ReadonlyMap<string, { url: string; size: number }>;
}

/** The 32-bit FNV-1a hash of `s`'s UTF-16 code units. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Fresh icon references: `icon-<8-hex FNV-1a of the URL>-<size>`, the same in every export of the same picture. When
 * another URL took an id first, the next takes `-2`, then `-3` (R24). `hash` is for tests only.
 */
export function iconRefs(hash: (s: string) => number = fnv1a): IconRefs {
  const ids = new Map<string, Map<number, string>>();
  const taken = new Map<string, string[]>();
  const out = new Map<string, { url: string; size: number }>();
  return {
    ref(url, size) {
      let sizes = ids.get(url);
      const known = sizes?.get(size);
      if (known !== undefined) return known;
      const base = `icon-${(hash(url) >>> 0).toString(16).padStart(8, "0")}-${size}`;
      const urls = taken.get(base) ?? [];
      taken.set(base, urls);
      urls.push(url);
      const id = urls.length === 1 ? base : `${base}-${urls.length}`;
      if (!sizes) ids.set(url, (sizes = new Map()));
      sizes.set(size, id);
      out.set(id, { url, size });
      return id;
    },
    entries: () => out,
  };
}

/**
 * The one `<defs>`: the hairline filter when `hairline` names it, and each referenced icon image once. Empty when
 * there is nothing to share. A URL that is not a data: image never gets in.
 */
export function svgDefs(palette: ExportPalette, d: { hairline: string | null; icons: ReadonlyMap<string, { url: string; size: number }> }): string {
  let icons = "";
  for (const [id, { url, size }] of d.icons) {
    if (SAFE_IMAGE.test(url)) icons += `<image id="${esc(id)}" href="${esc(url)}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  if (!d.hairline && !icons) return "";
  return `<defs>${d.hairline ? hairlineFilter(palette, d.hairline) : ""}${icons}</defs>`;
}

/** One of the app's own outline icons at `size` px, top-left at x, y. */
export function glyph(name: IconName, x: number, y: number, size: number, stroke: string, part?: string): string {
  const k = size / 24;
  const tag = part ? ` data-part="${part}"` : "";
  return `<path${tag} d="${iconPath(name)}" transform="translate(${num(x)} ${num(y)}) scale(${num(k)})" fill="none" stroke="${stroke}" stroke-width="${num(1.5 / k)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

const text = (x: number, y: number, body: string, attrs = "") => `<text x="${num(x)}" y="${num(y)}"${attrs}>${esc(body)}</text>`;

/** About 7 px per character of the 13 px body font, as the canvas sizes nodes before it measures them. */
/**
 * The text size of the scene being drawn (`Scene.textScale`), set by `sceneBody` for the one synchronous draw: the
 * widths and heights estimated from words grow with the font, so a label never runs out of its pill.
 */
let textK = 1;
/** The icon references and the hairline id of the draw in progress, set by `sceneBody` with `textK`. */
let refsInUse: IconRefs | undefined;
let hairline = HAIRLINE;
/** The palette of a soft-text draw in progress (a frame picture), set with `textK`: ER rows are drawn as bars. */
let softPalette: ExportPalette | undefined;
const textWidth = (s: string) => s.length * 7 * textK;

/** A data flow node in Modern or the Classic Gane-Sarson shapes. */
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

/** A flowchart node: pills, steps, the slanted io step and the one diamond. */
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

/** A cloud service: the 48 px tile with the icon unchanged, the name under it. */
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
  } else if (!url) {
    // A service with no icon keeps its plain tile.
    parts.push(`<rect x="${num(tx)}" y="${y}" width="48" height="48" rx="6" fill="${palette.iconTile}" stroke="${palette.border}"/>`);
    if (url) parts.push(imageSvg(url, tx + 4, y + 4, 40));
  } else parts.push(imageSvg(url, tx, y, 48, n.iconOutline));
  parts.push(text(x + w / 2, y + 66, n.title, ` text-anchor="middle" font-size="12"`));
  if (n.tag) parts.push(text(tx + 54, y + 12, n.tag, ` font-size="11" fill="${palette.subtle}"`));
}

/**
 * A state diagram's shapes as the canvas draws them (diag-910): the start a filled dot, the end a ring
 * round a dot, a state a pill, a choice a small diamond with its name under it, and a fork a bar. Markers carry no name.
 */
function stateSvg(n: SceneNode, palette: ExportPalette, parts: string[]) {
  const { fill, stroke } = palette.nodes[n.kind];
  const { x, y, w, h } = n;
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (n.kind === "stateStart") {
    const r = Math.min(w, h) / 2;
    parts.push(`<rect data-part="dot" x="${num(cx - r)}" y="${num(cy - r)}" width="${num(2 * r)}" height="${num(2 * r)}" rx="${num(r)}" fill="${stroke}"/>`);
  } else if (n.kind === "stateEnd") {
    const r = Math.min(w, h) / 2 - 1;
    const d = r - 5;
    parts.push(
      `<rect data-part="ring" x="${num(cx - r)}" y="${num(cy - r)}" width="${num(2 * r)}" height="${num(2 * r)}" rx="${num(r)}" fill="${palette.surface}" stroke="${stroke}" stroke-width="2"/>`,
      `<rect data-part="dot" x="${num(cx - d)}" y="${num(cy - d)}" width="${num(2 * d)}" height="${num(2 * d)}" rx="${num(d)}" fill="${stroke}"/>`,
    );
  } else if (n.kind === "fork") {
    parts.push(`<rect data-part="bar" x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${stroke}"/>`);
  } else if (n.kind === "choice") {
    // The square inset 9 px and turned 45 degrees, its name under it, as the canvas draws it.
    const r = (Math.min(w, h) - 18) / Math.SQRT2;
    parts.push(`<path data-part="diamond" d="M${num(cx)} ${num(cy - r)} L${num(cx + r)} ${num(cy)} L${num(cx)} ${num(cy + r)} L${num(cx - r)} ${num(cy)} Z" fill="${fill}" stroke="${stroke}"/>`);
    parts.push(text(cx, y + h + 14, n.title, ` text-anchor="middle" font-size="12"`));
  } else {
    parts.push(`<rect data-part="pill" x="${x}" y="${y}" width="${w}" height="${h}" rx="${num(h / 2)}" fill="${fill}" stroke="${stroke}"/>`);
    parts.push(text(cx, cy + 5, n.title, ` text-anchor="middle" font-weight="600"`));
  }
}

const STATE_KINDS: ReadonlySet<string> = new Set(["state", "choice", "fork", "stateStart", "stateEnd"]);

/** Code small, as the canvas draws class members and dates; a system font, never a web font. */
const MONO = ` font-family="Cascadia Mono, Consolas, Menlo, monospace"`;
/** A rounded box's top band down to `depth`, as a path, for a name band in the kind's fill. */
const band = (x: number, y: number, w: number, depth: number, r: number) =>
  `M${num(x)} ${num(y + depth)} V${num(y + r)} Q${num(x)} ${num(y)} ${num(x + r)} ${num(y)} H${num(x + w - r)} Q${num(x + w)} ${num(y)} ${num(x + w)} ${num(y + r)} V${num(y + depth)} Z`;

/**
 * `s` in lines of at most `max` characters, broken between words; a word longer than a line is cut. Characters are
 * code points, so a cut never splits a surrogate pair (an emoji would be written as U+FFFD).
 */
export function wrapWords(s: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  let lineLen = 0;
  for (const word of s.split(/\s+/).filter(Boolean)) {
    let w = [...word];
    while (w.length > max) {
      if (line) lines.push(line);
      line = "";
      lineLen = 0;
      lines.push(w.slice(0, max).join(""));
      w = w.slice(max);
    }
    const ws = w.join("");
    if (!line) {
      line = ws;
      lineLen = w.length;
    } else if (lineLen + 1 + w.length <= max) {
      line += ` ${ws}`;
      lineLen += 1 + w.length;
    } else {
      lines.push(line);
      line = ws;
      lineLen = w.length;
    }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

/** A note: the sticky note in the note pair, with square corners, its words wrapped from the top left. */
function noteSvg(n: SceneNode, palette: ExportPalette, parts: string[]) {
  const { fill, stroke } = palette.nodes.note;
  const { x, y, w, h } = n;
  parts.push(`<rect data-part="note" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="2" fill="${fill}" stroke="${stroke}"/>`);
  wrapWords(n.title, 26).forEach((line, i) => parts.push(text(x + 10, y + 22 + i * 18, line, ` font-size="12"`)));
}

/**
 * A class card: the name band in the kind's fill (an interface or enum says so above its name), then the fields and,
 * ruled off, the methods (members with brackets) in Code small; an enum lists its values. An interface is dashed.
 */
function classSvg(n: SceneNode, palette: ExportPalette, parts: string[]) {
  const { fill, stroke } = palette.nodes[n.kind];
  const { x, y, w, h } = n;
  const head = n.kind === "class" ? 32 : 46;
  const cx = x + w / 2;
  parts.push(
    `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="6" fill="${palette.surface}"/>`,
    `<path data-part="band" d="${band(x, y, w, head, 6)}" fill="${fill}"/>`,
    `<path d="M${num(x)} ${num(y + head)} H${num(x + w)}" fill="none" stroke="${stroke}"/>`,
  );
  if (n.kind !== "class") {
    parts.push(text(cx, y + 18, `«${n.kind}»`, ` text-anchor="middle" font-size="12" fill="${palette.subtle}"`));
    parts.push(text(cx, y + 36, n.title, ` text-anchor="middle" font-weight="600"`));
  } else parts.push(text(cx, y + 21, n.title, ` text-anchor="middle" font-weight="600"`));
  const rows = n.rows.map((r) => r.left);
  const method = (r: string) => r.includes("(");
  const lists = n.kind === "enum" ? [rows] : [rows.filter((r) => !method(r)), rows.filter(method)];
  let top = y + head;
  lists.forEach((list, i) => {
    if (i > 0) parts.push(`<path data-part="divider" d="M${num(x)} ${num(top)} H${num(x + w)}" fill="none" stroke="${stroke}"/>`);
    top += 3;
    for (const r of list) {
      parts.push(text(x + 10, top + 15, r, `${MONO} font-size="12"`));
      top += 22;
    }
    top += 3;
  });
  const dash = n.kind === "interface" ? ` stroke-dasharray="5 4"` : "";
  parts.push(`<rect data-part="outline" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="6" fill="none" stroke="${stroke}"${dash}/>`);
}

/**
 * Whether a sequence participant's icon draws with the hairline: when the canvas asks for it, or when
 * its logo's own colour is under 1.5:1 (`FAINT`) on the participant's `fill`.
 */
function participantOutline(n: SceneNode, fill: string): boolean {
  if (n.iconOutline) return true;
  const hex = n.iconName ? logoHex(n.iconName) : null;
  return hex !== null && contrastRatio(hex, fill) < FAINT;
}

const SEQ_WHO: ReadonlySet<string> = new Set(["participant", "actor"]);
const whoOf = (n: SceneNode) => (n.kind === "actor" ? "actor" : "participant");

/**
 * A sequence participant as SeqParticipant and SeqLanes draw it: its solid lane in its line
 * colour, its activation bars, then its head box on top and its foot box at `foot`, each filled with the tint of its
 * colour and outlined in it, with its icon (or the dashed cube tile for one the pack lacks; an actor with no icon a
 * person) and its words in the text colour, the pair centred.
 */
function participantSvg(n: SceneNode, palette: ExportPalette): string {
  const p = participantParts(n, palette);
  const parts = [`<path data-part="lifeline" d="M${num(p.lane.x)} ${num(p.lane.top)} V${num(p.lane.bottom)}" fill="none" stroke="${p.line}" stroke-width="1.5"/>`];
  for (const b of p.bars) {
    parts.push(`<rect data-part="activation" x="${num(b.x)}" y="${num(b.y)}" width="${ACT_W}" height="${num(b.h)}" rx="2" fill="${p.fill}" stroke="${p.line}"/>`);
  }
  p.boxes.forEach((b, i) => {
    parts.push(`<rect data-part="lifehead" x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${SEQ_HEAD}" rx="7" fill="${p.fill}" stroke="${p.line}" stroke-width="1.5"/>`);
    parts.push(p.marks[i]);
    const t = p.names[i];
    parts.push(text(t.x, t.y, n.title, `${t.anchor ? ` text-anchor="${t.anchor}"` : ""} font-weight="600"`));
  });
  return `<g data-node="${esc(n.id)}">${parts.join("")}</g>`;
}

/**
 * A participant's geometry and colours, shared by `participantSvg` and a frame picture's `PictureSequence`: its lane, its
 * bars, its head and foot boxes, the icon (or tile, or person) drawn in each, and each one's words, their baseline
 * and anchor (13 px, bold).
 */
function participantParts(n: SceneNode, palette: ExportPalette) {
  const { line, fill } = seqColours(palette, n.color, whoOf(n));
  const { x, y, w } = n;
  const cx = x + w / 2;
  const foot = n.foot ?? n.h - SEQ_HEAD;
  const bars = (n.bars ?? []).map((b) => ({ x: cx - ACT_W / 2, y: y + b.top, h: b.height }));
  const url = n.icon && SAFE_IMAGE.test(n.icon) ? n.icon : null;
  const outline = url !== null && participantOutline(n, fill);
  // An 18 px icon slot and a 6 px gap before the words.
  const slot = url || n.iconName || n.kind === "actor" ? 24 : 0;
  const left = cx - (slot + messageLabelW(n.title, "state", textK)) / 2;
  const boxes: { x: number; y: number; w: number }[] = [];
  const marks: string[] = [];
  const names: { x: number; y: number; anchor?: "middle" }[] = [];
  for (const top of [y, y + foot]) {
    const iy = top + (SEQ_HEAD - 18) / 2;
    boxes.push({ x, y: top, w });
    if (url) marks.push(imageSvg(url, left, iy, 18, outline));
    else if (n.iconName) {
      marks.push(
        `<rect data-part="icon-tile" x="${num(left)}" y="${num(iy)}" width="18" height="18" rx="3" fill="${palette.surface}" stroke="${palette.strongBorder}" stroke-dasharray="3 2"/>` +
          glyph("cube", left + 2, iy + 2, 14, palette.subtle),
      );
    } else if (n.kind === "actor") marks.push(glyph("user", left + 1, iy + 1, 16, palette.text, "person"));
    else marks.push("");
    names.push(slot ? { x: left + slot, y: top + SEQ_HEAD / 2 + 4.5 * textK } : { x: cx, y: top + SEQ_HEAD / 2 + 4.5 * textK, anchor: "middle" });
  }
  return { line, fill, lane: { x: cx, top: y + SEQ_HEAD, bottom: y + foot }, bars, boxes, marks, names };
}

/** A mind map's central idea, a stronger pill; a branch topic, a pill; a deeper topic, plain words on a line. */
function mindSvg(n: SceneNode, palette: ExportPalette, parts: string[]) {
  const { fill, stroke } = palette.nodes[n.kind];
  const { x, y, w, h } = n;
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (n.kind === "root") {
    parts.push(`<rect data-part="pill" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    parts.push(text(cx, cy + 5, n.title, ` text-anchor="middle" font-size="15" font-weight="600"`));
  } else if ((n.depth ?? 1) <= 1) {
    parts.push(`<rect data-part="pill" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(h / 2)}" fill="${fill}" stroke="${stroke}"/>`);
    parts.push(text(cx, cy + 5, n.title, ` text-anchor="middle" font-weight="600"`));
  } else {
    parts.push(`<path data-part="underline" d="M${num(x)} ${num(y + h)} H${num(x + w)}" fill="none" stroke="${stroke}"/>`);
    parts.push(text(cx, cy + 5, n.title, ` text-anchor="middle"`));
  }
}

/** A timeline item: an event card, a period pill or a milestone with a heavier edge; its date over its name. */
function timeSvg(n: SceneNode, palette: ExportPalette, parts: string[]) {
  const { fill, stroke } = palette.nodes[n.kind];
  const { x, y, w, h } = n;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = n.kind === "period" ? h / 2 : 6;
  const heavy = n.kind === "milestone" ? ` stroke-width="2"` : "";
  parts.push(`<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(rx)}" fill="${fill}" stroke="${stroke}"${heavy}/>`);
  if (n.sub) parts.push(text(cx, cy - 3, n.sub, ` text-anchor="middle"${MONO} font-size="10" fill="${palette.subtle}"`));
  parts.push(text(cx, n.sub ? cy + 13 : cy + 5, n.title, ` text-anchor="middle" font-weight="600"`));
}

/** A flowchart document with its curved foot, or a database as a rounded cylinder, each with its glyph before the name. */
function documentSvg(n: SceneNode, palette: ExportPalette, parts: string[]) {
  const { fill, stroke } = palette.nodes[n.kind];
  const { x, y, w, h } = n;
  if (n.kind === "database") {
    parts.push(`<rect data-part="cylinder" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(w / 2)}" ry="10" fill="${fill}" stroke="${stroke}"/>`);
  } else {
    // The canvas's corners: 6 px on top, 40 percent by 12 px bottom right, 10 percent by 6 px bottom left.
    const d = `M${num(x + 6)} ${num(y)} H${num(x + w - 6)} Q${num(x + w)} ${num(y)} ${num(x + w)} ${num(y + 6)} V${num(y + h - 12)} Q${num(x + w)} ${num(y + h)} ${num(x + w * 0.6)} ${num(y + h)} H${num(x + w * 0.1)} Q${num(x)} ${num(y + h)} ${num(x)} ${num(y + h - 6)} V${num(y + 6)} Q${num(x)} ${num(y)} ${num(x + 6)} ${num(y)} Z`;
    parts.push(`<path data-part="document" d="${d}" fill="${fill}" stroke="${stroke}"/>`);
  }
  const left = x + w / 2 - (20 + textWidth(n.title)) / 2;
  const cy = y + h / 2;
  parts.push(glyph(n.kind === "database" ? "database" : "fileQuery", left, cy - 7, 14, stroke), text(left + 20, cy + 5, n.title, ` font-weight="600"`));
}

const CLASS_KINDS: ReadonlySet<string> = new Set(["class", "interface", "enum"]);
const MIND_KINDS: ReadonlySet<string> = new Set(["root", "topic"]);
const TIME_KINDS: ReadonlySet<string> = new Set(["event", "period", "milestone"]);

/** A colour's drawn values; a preset needs the palette to carry the presets, a custom hex never does. */
const coloured = (palette: ExportPalette, c: SceneColour | undefined) => (c && (c[0] === "#" || palette.colours) ? sceneColour(palette, c) : undefined);

/** A drawn node: data flow, flowchart, cloud (6+.5), state and the step 12 kinds, as the canvas draws them. */
function drawnSvg(n: SceneNode, given: ExportPalette): string {
  // A participant takes the sequence colours, never a preset's fill.
  if (SEQ_WHO.has(n.kind)) return participantSvg(n, given);
  const parts: string[] = [];
  // a coloured shape draws its palette colour's fill and border in place of its kind's, and its words.
  const c = coloured(given, n.color);
  const palette = c ? { ...given, nodes: { ...given.nodes, [n.kind]: { fill: c.fill, stroke: c.stroke } } } : given;
  if (n.kind === "process" || n.kind === "store" || n.kind === "external") dfdSvg(n, palette, parts);
  else if (n.kind === "service") serviceSvg(n, palette, parts);
  else if (STATE_KINDS.has(n.kind)) stateSvg(n, palette, parts);
  else if (n.kind === "note") noteSvg(n, palette, parts);
  else if (CLASS_KINDS.has(n.kind)) classSvg(n, palette, parts);
  else if (MIND_KINDS.has(n.kind)) mindSvg(n, palette, parts);
  else if (TIME_KINDS.has(n.kind)) timeSvg(n, palette, parts);
  else if (n.kind === "document" || n.kind === "database") documentSvg(n, palette, parts);
  else flowchartSvg(n, palette, parts);
  return `<g data-node="${esc(n.id)}"${c ? ` fill="${c.text}"` : ""}>${parts.join("")}</g>`;
}

/** A group: a tinted area with its name at the top left; groups inside groups have a solid edge. */
function areaSvg(a: SceneArea, palette: ExportPalette): string {
  const dash = a.depth === 0 ? ` stroke-dasharray="5 4"` : "";
  // a coloured group takes its colour on its border, tint and title, as the canvas draws it.
  const c = coloured(palette, a.color);
  const edge = c ? c.stroke : palette.group;
  const tint = c ? `fill="${c.fill}" fill-opacity="0.55"` : `fill="${palette.groupTint}" fill-opacity="0.7"`;
  const parts = [`<rect x="${num(a.x)}" y="${num(a.y)}" width="${num(a.w)}" height="${num(a.h)}" rx="10" ${tint} stroke="${edge}"${dash}/>`];
  const icon = a.icon ? imageSvg(a.icon, a.x + 12, a.y + 8, 16, a.iconOutline) : "";
  parts.push(icon || `<rect x="${num(a.x + 12)}" y="${num(a.y + 8)}" width="16" height="16" rx="3" fill="${edge}"/>`);
  parts.push(text(a.x + 34, a.y + 21, a.name, ` font-size="12" font-weight="600"${c ? ` fill="${a.color![0] === "#" ? c.text : c.stroke}"` : ""}`));
  return `<g data-area="${esc(a.name)}">${parts.join("")}</g>`;
}

/** A 6 px arrowhead at `tip`, pointing away from `from`. */
function head(from: { x: number; y: number }, tip: { x: number; y: number }, fill: string): string {
  return `<path data-marker="head" d="${headD(from, tip)}" fill="${fill}"/>`;
}

/** The 6 px filled head's outline at `tip`, pointing away from `from`. */
function headD(from: { x: number; y: number }, tip: { x: number; y: number }): string {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y);
  const ux = len === 0 ? 1 : (tip.x - from.x) / len;
  const uy = len === 0 ? 0 : (tip.y - from.y) / len;
  const bx = tip.x - ux * 6;
  const by = tip.y - uy * 6;
  return `M${num(tip.x)} ${num(tip.y)} L${num(bx - uy * 3)} ${num(by + ux * 3)} L${num(bx + uy * 3)} ${num(by - ux * 3)} Z`;
}

/** The 10 px open head's stroke at `tip`, pointing away from `from`. */
function openD(from: { x: number; y: number }, tip: { x: number; y: number }): string {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y);
  const ux = len === 0 ? 1 : (tip.x - from.x) / len;
  const uy = len === 0 ? 0 : (tip.y - from.y) / len;
  const at = (back: number, side: number) => `${num(tip.x - ux * back - uy * side)} ${num(tip.y - uy * back + ux * side)}`;
  return `M${at(9, -4)} L${at(0, 0)} L${at(9, 4)}`;
}

/**
 * A line end as the canvas's markers draw it (diagram/edges.tsx), its tip at `tip`, pointing away from `from`: the 6 px
 * filled head, the 10 px open head, the 12 px hollow triangle on the canvas colour and the 14 px filled diamond.
 */
function markSvg(mark: SceneMark, from: { x: number; y: number }, tip: { x: number; y: number }, palette: ExportPalette, tag = ""): string {
  if (mark === "arrow") return head(from, tip, palette.subtle).replace("<path ", `<path${tag} `).replace('data-marker="head"', 'data-marker="arrow"');
  const len = Math.hypot(tip.x - from.x, tip.y - from.y);
  const ux = len === 0 ? 1 : (tip.x - from.x) / len;
  const uy = len === 0 ? 0 : (tip.y - from.y) / len;
  const at = (back: number, side: number) => `${num(tip.x - ux * back - uy * side)} ${num(tip.y - uy * back + ux * side)}`;
  const stroke = palette.subtle;
  if (mark === "open") return `<path${tag} data-marker="open" d="${openD(from, tip)}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`;
  // An ER end, as the canvas's markers draw it: a bar across the line 8 px in, or a crow's foot spreading onto the card.
  if (mark === "one") return `<path${tag} data-marker="bar" d="M${at(8, -5)} L${at(8, 5)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`;
  if (mark === "many") return `<path${tag} data-marker="crow" d="M${at(10, 0)} L${at(0, -5)} M${at(10, 0)} L${at(0, 5)} M${at(10, 0)} L${at(0, 0)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`;
  if (mark === "triangle") return `<path${tag} data-marker="triangle" d="M${at(0, 0)} L${at(11, 5)} L${at(11, -5)} Z" fill="${palette.canvas}" stroke="${stroke}" stroke-width="1.5"/>`;
  return `<path${tag} data-marker="diamond" d="M${at(0, 0)} L${at(7, 5)} L${at(14, 0)} L${at(7, -5)} Z" fill="${stroke}"/>`;
}

/** A drawn diagram's or lineage's line: square with 8 px corners, 6 px heads, the label on a 6 px-radius chip. */
function flowEdgeSvg(e: SceneEdge, given: ExportPalette): string {
  const pts = e.points;
  // a coloured line keeps its colour and its arrowheads; its label chip stays plain.
  const c = coloured(given, e.color);
  const palette = c ? { ...given, subtle: c.stroke } : given;
  const stroke = palette.subtle;
  const dash = e.line === "dashed" ? ` stroke-dasharray="5 4"` : e.line === "dotted" ? ` stroke-dasharray="1 4" stroke-linecap="round"` : "";
  const parts = [`<path d="${roundedPath(pts)}" fill="none" stroke="${stroke}" stroke-width="1.5"${dash}/>`];
  if (e.marks) {
    if (e.marks.end) parts.push(markSvg(e.marks.end, pts[pts.length - 2], pts[pts.length - 1], palette));
    if (e.marks.start) parts.push(markSvg(e.marks.start, pts[1], pts[0], palette));
  } else {
    const heads = e.heads ?? "end";
    if (heads === "end" || heads === "both") parts.push(head(pts[pts.length - 2], pts[pts.length - 1], stroke));
    if (heads === "start" || heads === "both") parts.push(head(pts[1], pts[0], stroke));
  }
  if (e.label) {
    const i = Math.floor((pts.length - 1) / 2);
    const cx = (pts[i].x + pts[i + 1].x) / 2;
    const cy = (pts[i].y + pts[i + 1].y) / 2;
    const w = Math.ceil(e.label.length * 6.5 * textK + 12);
    const h = 20 * textK;
    parts.push(
      `<rect data-part="chip" x="${num(cx - w / 2)}" y="${num(cy - h / 2)}" width="${w}" height="${num(h)}" rx="6" fill="${palette.surface}" stroke="${palette.border}"/>`,
      text(cx, cy + 4, e.label, ` text-anchor="middle" font-size="11" fill="${given.subtle}"`),
    );
  }
  return `<g data-edge="${esc(e.id)}">${parts.join("")}</g>`;
}

/**
 * A sequence message as SeqEdge draws it: the drawing's path with the gap at its label,
 * dashed for a reply, its head on the last segment; then its label's chip in the canvas's colour or its block's wash, the
 * label on it at its measured width (`textLength`, so every viewer breaks the line where the canvas does); then its
 * number on the sender's lifeline. Far (a soft picture) the digits go, as the canvas's far numbers do.
 */
function messageSvg(e: SceneEdge, palette: ExportPalette, frames: readonly SceneFrame[]): string {
  const m = messageParts(e, palette, frames);
  const stroke = palette.subtle;
  const dash = m.dashed ? ` stroke-dasharray="5 4"` : "";
  const parts = [`<path data-part="message" d="${m.d}" fill="none" stroke="${stroke}" stroke-width="1.5"${dash}/>`];
  parts.push(markSvg(m.mark, m.from, m.tip, palette, ` data-part="head"`));
  if (m.chip) {
    const c = m.chip;
    const fit = e.labelW !== undefined ? ` textLength="${num(e.labelW)}" lengthAdjust="spacingAndGlyphs"` : "";
    parts.push(
      `<rect data-part="chip" x="${num(c.x)}" y="${num(c.y)}" width="${num(c.w)}" height="${num(c.h)}" rx="3" fill="${c.bg}"/>`,
      text(c.x + c.w / 2, c.y + c.h / 2 + 4 * textK, e.label!, ` text-anchor="middle" font-size="12"${fit}`),
    );
  }
  const nb = m.number;
  if (nb) {
    parts.push(`<rect data-part="number" x="${num(nb.x)}" y="${num(nb.y)}" width="${num(nb.w)}" height="${num(nb.h)}" rx="${num(nb.h / 2)}" fill="${palette.surface}" stroke="${nb.line}" stroke-width="1.5"/>`);
    if (!softPalette) parts.push(text(nb.cx, nb.cy + 4 * textK, String(nb.n), ` data-part="number-text" text-anchor="middle" font-size="11" font-weight="600"`));
  }
  return `<g data-edge="${esc(e.id)}">${parts.join("")}</g>`;
}

/**
 * A message's geometry and colours, shared by `messageSvg` and a frame picture's `PictureSequence`: its path, dashed for a
 * reply, its end mark, its label's chip in its colour (the label centred on it, 12 px) and its number's pill.
 */
function messageParts(e: SceneEdge, palette: ExportPalette, frames: readonly SceneFrame[]) {
  const pts = e.points;
  const d = e.path ?? pts.map((p, i) => `${i === 0 ? "M" : "L"}${num(p.x)} ${num(p.y)}`).join(" ");
  const chip =
    e.label && e.chip ? { ...e.chip, bg: typeof e.chipBg === "number" ? seqColours(palette, frames[e.chipBg]?.color, "block").wash : palette.canvas } : null;
  const nb = e.number;
  const k = textK;
  const number = nb ? { n: nb.n, cx: nb.x, cy: nb.y, x: nb.x - nb.w / 2, y: nb.y - 10 * k, w: nb.w, h: 20 * k, line: seqColours(palette, nb.color, nb.who).line } : null;
  return { d, dashed: e.line === "dashed", mark: e.marks?.end ?? "arrow", from: pts[pts.length - 2], tip: pts[pts.length - 1], chip, number };
}

/** A rectangle as path commands, one of many in a path. */
const rectD = (x: number, y: number, w: number, h: number) => `M${num(x)} ${num(y)}h${num(w)}v${num(h)}h${num(-w)}z`;

/**
 * A sequence in a frame picture. At the sequence limit (2,000 participants, 3,000
 * messages) one element a part made 3.7 M characters of SVG with soft text (4 M with words): 15 and 16 pieces of
 * PICTURE_PIECE_CHARS, each an SVG document WebKit keeps. In a picture every part of one style is one subpath of one
 * path, as F's far ER rows are: the lifelines of a colour, the bars and the boxes of a colour, the message lines,
 * their heads, the chips of a colour and the number pills of a colour; soft words are one path of bars, real words
 * (`picture-text`) one group of runs a kind. Boxes, bars and pills lose their round corners (7 units at most: under a
 * pixel at PICTURE_MAX_SCALE). Participants paint lanes, bars, boxes, icons, words; messages lines, heads, chips,
 * pills, words: what overlaps keeps its order, as no two participants' parts and no two messages' parts meet.
 */
class PictureSequence {
  private readonly lanes = new Map<string, string[]>();
  private readonly bars = new Map<string, string[]>();
  private readonly boxes = new Map<string, string[]>();
  private marks: string[] = [];
  private names: string[] = [];
  private solid: string[] = [];
  private dashed: string[] = [];
  private arrows: string[] = [];
  private opens: string[] = [];
  private readonly chips = new Map<string, string[]>();
  private labels: string[] = [];
  private readonly numbers = new Map<string, string[]>();
  private digits: string[] = [];

  /** `soft`: words as bars (text far); else the words themselves. */
  constructor(private readonly soft: boolean) {}

  private static add(m: Map<string, string[]>, key: string, d: string) {
    const list = m.get(key);
    if (list) list.push(d);
    else m.set(key, [d]);
  }

  participant(n: SceneNode, palette: ExportPalette) {
    const p = participantParts(n, palette);
    PictureSequence.add(this.lanes, p.line, `M${num(p.lane.x)} ${num(p.lane.top)}V${num(p.lane.bottom)}`);
    const style = `${p.fill}|${p.line}`;
    for (const b of p.bars) PictureSequence.add(this.bars, style, rectD(b.x, b.y, ACT_W, b.h));
    const len = [...n.title].length;
    p.boxes.forEach((b, i) => {
      PictureSequence.add(this.boxes, style, rectD(b.x, b.y, b.w, SEQ_HEAD));
      if (p.marks[i]) this.marks.push(p.marks[i]);
      const t = p.names[i];
      if (!this.soft) this.names.push(text(t.x, t.y, n.title, t.anchor ? ` text-anchor="${t.anchor}"` : ""));
      else if (len) {
        const r = softBar(t.x, t.y, len, 13 * textK, n.w, t.anchor);
        this.names.push(rectD(r.x, r.y, r.w, r.h));
      }
    });
  }

  message(e: SceneEdge, palette: ExportPalette, frames: readonly SceneFrame[]) {
    const m = messageParts(e, palette, frames);
    (m.dashed ? this.dashed : this.solid).push(m.d);
    if (m.mark === "open") this.opens.push(openD(m.from, m.tip));
    else this.arrows.push(headD(m.from, m.tip));
    if (m.chip) {
      const c = m.chip;
      PictureSequence.add(this.chips, c.bg, rectD(c.x, c.y, c.w, c.h));
      const len = [...e.label!].length;
      const y = c.y + c.h / 2 + 4 * textK;
      if (!this.soft) this.labels.push(text(c.x + c.w / 2, y, e.label!, e.labelW !== undefined ? ` textLength="${num(e.labelW)}" lengthAdjust="spacingAndGlyphs"` : ""));
      else if (len) {
        const r = softBar(c.x + c.w / 2, y, len, 12 * textK, Infinity, "middle");
        this.labels.push(rectD(r.x, r.y, r.w, r.h));
      }
    }
    const nb = m.number;
    if (nb) {
      PictureSequence.add(this.numbers, nb.line, rectD(nb.x, nb.y, nb.w, nb.h));
      // Far, the digits go, as the canvas's far numbers do.
      if (!this.soft) this.digits.push(text(nb.cx, nb.cy + 4 * textK, String(nb.n)));
    }
  }

  /** The words of one kind: soft, one path of bars; else one group of runs sharing `attrs`. */
  private words(list: string[], palette: ExportPalette, part: string, attrs: string): string {
    if (!list.length) return "";
    return this.soft ? `<path data-part="soft-${part}" d="${list.join("")}" fill="${palette.faint}" fill-opacity="0.45"/>` : `<g data-part="${part}"${attrs}>${list.join("")}</g>`;
  }

  /** The participants' layers, in paint order; they are let go. */
  participantsSvg(palette: ExportPalette): string {
    const out: string[] = [];
    for (const [line, ds] of this.lanes) out.push(`<path data-part="lifelines" d="${ds.join("")}" fill="none" stroke="${line}" stroke-width="1.5"/>`);
    for (const [style, ds] of this.bars) {
      const [fill, line] = style.split("|");
      out.push(`<path data-part="activations" d="${ds.join("")}" fill="${fill}" stroke="${line}"/>`);
    }
    for (const [style, ds] of this.boxes) {
      const [fill, line] = style.split("|");
      out.push(`<path data-part="lifeheads" d="${ds.join("")}" fill="${fill}" stroke="${line}" stroke-width="1.5"/>`);
    }
    out.push(...this.marks, this.words(this.names, palette, "names", ` font-weight="600"`));
    this.lanes.clear();
    this.bars.clear();
    this.boxes.clear();
    this.marks = [];
    this.names = [];
    return out.join("");
  }

  /** The messages' layers, in paint order; they are let go. */
  messagesSvg(palette: ExportPalette): string {
    const stroke = palette.subtle;
    const out: string[] = [];
    if (this.solid.length) out.push(`<path data-part="messages" d="${this.solid.join(" ")}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
    if (this.dashed.length) out.push(`<path data-part="replies" d="${this.dashed.join(" ")}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
    if (this.arrows.length) out.push(`<path data-part="heads" d="${this.arrows.join(" ")}" fill="${stroke}"/>`);
    if (this.opens.length) out.push(`<path data-part="open-heads" d="${this.opens.join(" ")}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`);
    for (const [bg, ds] of this.chips) out.push(`<path data-part="chip" d="${ds.join("")}" fill="${bg}"/>`);
    out.push(this.words(this.labels, palette, "labels", ` text-anchor="middle" font-size="12"`));
    for (const [line, ds] of this.numbers) out.push(`<path data-part="numbers" d="${ds.join("")}" fill="${palette.surface}" stroke="${line}" stroke-width="1.5"/>`);
    if (this.digits.length) out.push(`<g data-part="number-texts" text-anchor="middle" font-size="11" font-weight="600">${this.digits.join("")}</g>`);
    this.solid = [];
    this.dashed = [];
    this.arrows = [];
    this.opens = [];
    this.chips.clear();
    this.labels = [];
    this.numbers.clear();
    this.digits = [];
    return out.join("");
  }
}

/** A mind map branch as MindEdge draws it: a curve from the parent's side to the child's, with no head. */
function branchSvg(e: SceneEdge, palette: ExportPalette): string {
  const a = e.points[0];
  const b = e.points[e.points.length - 1];
  const mx = (a.x + b.x) / 2;
  return `<g data-edge="${esc(e.id)}"><path d="M${num(a.x)} ${num(a.y)} C ${num(mx)} ${num(a.y)}, ${num(mx)} ${num(b.y)}, ${num(b.x)} ${num(b.y)}" fill="none" stroke="${palette.subtle}" stroke-width="1.5"/></g>`;
}

/** Each block kind's glyph on its side tab (as seqNodes `BLOCK_GLYPH`). */
const BLOCK_GLYPH: Record<string, IconName> = { loop: "repeat", alt: "split", opt: "branch", par: "columns", critical: "warning" };

/**
 * A block (a sequence frame) as SeqFrame draws it: its opaque wash outlined in its line colour, and
 * down its left edge the side tab in its tab colour with its kind's glyph and, when there is room, its kind word turned a
 * quarter counter-clockwise, in the tab's ink.
 */
function frameSvg(f: SceneFrame, i: number, palette: ExportPalette): string {
  const { line, wash, tab, tabInk } = seqColours(palette, f.color, "block");
  const t = f.tab;
  const r = 6;
  const parts = [
    `<rect data-part="wash" x="${num(f.x)}" y="${num(f.y)}" width="${num(f.w)}" height="${num(f.h)}" rx="${r}" fill="${wash}" stroke="${line}" stroke-width="1.5"/>`,
    `<path data-part="tab" d="M${num(t.x + t.w)} ${num(t.y)} H${num(t.x + r)} Q${num(t.x)} ${num(t.y)} ${num(t.x)} ${num(t.y + r)} V${num(t.y + t.h - r)} Q${num(t.x)} ${num(t.y + t.h)} ${num(t.x + r)} ${num(t.y + t.h)} H${num(t.x + t.w)} Z" fill="${tab}"/>`,
    glyph(BLOCK_GLYPH[f.kind] ?? "repeat", t.x + 3, t.y + 5, 18, tabInk, "glyph"),
  ];
  if (f.word) {
    // Under the glyph (5 + 18 + 8 down), centred on the tab, reading upward.
    const cx = t.x + t.w / 2;
    const cy = t.y + 31 + f.wordW / 2;
    parts.push(`<text transform="rotate(-90 ${num(cx)} ${num(cy)})" x="${num(cx)}" y="${num(cy + 4 * textK)}" text-anchor="middle" font-size="11" font-weight="600" fill="${tabInk}">${esc(f.kind)}</text>`);
  }
  return `<g data-frame="${i}">${parts.join("")}</g>`;
}

/** A block's caption (its label after the kind word) on a chip of its wash, drawn over the participants; none without one. */
function frameTabSvg(f: SceneFrame, i: number, palette: ExportPalette): string {
  const c = f.captionBox;
  if (!c) return "";
  const { wash } = seqColours(palette, f.color, "block");
  const words = text(c.x + 6, c.y + c.h / 2 + 4 * textK, f.caption, ` font-size="12" fill="${palette.subtle}" textLength="${num(c.w - 12)}" lengthAdjust="spacingAndGlyphs"`);
  return `<g data-frame-tab="${i}"><rect data-part="caption" x="${num(c.x)}" y="${num(c.y)}" width="${num(c.w)}" height="${num(c.h)}" rx="3" fill="${wash}"/>${words}</g>`;
}

/** A timeline section: a quiet dashed band, named at the top. */
const sectionSvg = (sec: SceneSection, palette: ExportPalette) =>
  `<g data-section="${esc(sec.name)}"><rect x="${num(sec.x)}" y="${num(sec.y)}" width="${num(sec.w)}" height="${num(sec.h)}" rx="10" fill="${palette.panel}" fill-opacity="0.5" stroke="${palette.border}" stroke-dasharray="4 3"/>${text(sec.x + 12, sec.y + 21, sec.name, ` font-size="12" font-weight="600" fill="${palette.subtle}"`)}</g>`;

/** A timeline's line with a ring where each item meets it, and a diamond for a milestone. */
function axisSvg(a: SceneAxis, palette: ExportPalette): string {
  const parts = [`<rect data-part="axis" x="${num(a.x)}" y="${num(a.y - 1)}" width="${num(a.w)}" height="2" rx="1" fill="${palette.strongBorder}"/>`];
  for (const t of a.ticks) {
    if (t.milestone) {
      const r = 8;
      parts.push(`<path data-part="tick-milestone" d="M${num(t.x)} ${num(a.y - r)} L${num(t.x + r)} ${num(a.y)} L${num(t.x)} ${num(a.y + r)} L${num(t.x - r)} ${num(a.y)} Z" fill="${palette.canvas}" stroke="${palette.nodes.milestone.stroke}" stroke-width="2" stroke-linejoin="round"/>`);
    } else parts.push(`<rect data-part="tick" x="${num(t.x - 6)}" y="${num(a.y - 6)}" width="12" height="12" rx="6" fill="${palette.canvas}" stroke="${palette.nodes.event.stroke}" stroke-width="2"/>`);
  }
  return `<g data-axis="time">${parts.join("")}</g>`;
}

function nodeSvg(n: SceneNode, palette: ExportPalette): string {
  if (n.look) return drawnSvg(n, palette);
  // a coloured ER table draws its colour's border and header in place of its kind's.
  const c = coloured(palette, n.color);
  const colours = c ? { fill: c.fill, stroke: c.stroke } : palette.nodes[n.kind];
  const r = 6;
  const { x, y, w, h } = n;
  // An ER card (its rows carry not-null marks; only flowScene's ER cards set them) draws the canvas card's geometry at
  // the scene's text size, where its lines meet its rows (`erMetrics`, `erRowY`; B4). Other cards
  // keep the schema card's header and row pitch.
  const er = n.rows.some((row) => row.notNull !== undefined);
  const m = erMetrics(er ? textK : 1);
  const at = (v: number) => (er ? num(v) : String(v));
  const head = er ? m.head : CARD_HEADER;
  const titleY = at(y + (er ? 21 * textK : 21));
  const header = `M${x} ${at(y + head)} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${at(y + head)} Z`;
  const parts = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${palette.surface}" stroke="${colours.stroke}"${n.dashed ? ` stroke-dasharray="5 4"` : ""}/>`,
    `<path d="${header}" fill="${colours.fill}"/>`,
    `<path d="M${x} ${at(y + head)} H${x + w}" fill="none" stroke="${colours.stroke}"/>`,
    `<text x="${x + 10}" y="${titleY}" font-weight="600">${esc(n.title)}</text>`,
  ];
  if (n.subtitle) parts.push(`<text x="${x + w - 10}" y="${titleY}" text-anchor="end" font-size="12" fill="${palette.subtle}">${esc(n.subtitle)}</text>`);
  const marked = n.rows.some((row) => row.mark);
  const nameX = x + (marked ? 32 : 10);
  // An ER card's not-null marks, as the canvas draws them: a filled diamond, an outline for a nullable column.
  const nulls = er;
  const typeX = x + w - (nulls ? 24 : 10);
  // A soft-text ER card (a far frame picture) draws its rows as the canvas's far card does (kindNodes
  // `ErBars`), from the one `ER_FAR_ROW`: on each row's middle a name bar `from` into the rows body and a
  // type bar ending `to` before its right, `h` times the text size tall, at most 0.55 and 0.3 of the card, in the faint
  // token at 45 percent; a key row's square in the key colour in the gutter; no not-null marks. The rows body sits
  // inside the card's 1 px border. All bars are one path, and the key marks another, in the card's own units: one path
  // a card keeps a 2,000-table picture small.
  if (er && softPalette) {
    const inset = 1;
    const bh = ER_FAR_ROW.h * textK;
    const bar = (left: number, top: number, bw: number, h: number) => `M${num(left)} ${num(top)}h${num(bw)}v${num(h)}h${num(-bw)}z`;
    let d = "";
    let keys = "";
    n.rows.forEach((row, i) => {
      const mid = m.mid + m.row * i;
      const nameW = Math.min(row.left.length * SOFT_CHAR_W * textK, 0.55 * w);
      if (nameW > 0) d += bar(inset + ER_FAR_ROW.from, mid - bh / 2, nameW, bh);
      const typeW = row.right ? Math.min(row.right.length * SOFT_CHAR_W * textK, 0.3 * w) : 0;
      if (typeW > 0) d += bar(inset + w - ER_FAR_ROW.to - typeW, mid - bh / 2, typeW, bh);
      if (row.mark === "pk") keys += bar(inset + ER_FAR_ROW.keyMid - ER_FAR_ROW.key / 2, mid - ER_FAR_ROW.key / 2, ER_FAR_ROW.key, ER_FAR_ROW.key);
    });
    if (d) parts.push(`<path data-part="soft-rows" transform="translate(${x} ${y})" d="${d}" fill="${softPalette.faint}" fill-opacity="0.45"/>`);
    if (keys) parts.push(`<path data-part="soft-keys" transform="translate(${x} ${y})" d="${keys}" fill="${softPalette.keyMark}"/>`);
  }
  if (!(er && softPalette)) n.rows.forEach((row, i) => {
    // An ER row's words sit 4 px (at the text size) under its middle, the diamond on it; others on the card's pitch.
    const mid = y + m.mid + m.row * i;
    const ty = at(er ? mid + 4 * textK : y + CARD_HEADER + CARD_ROW * i + 16);
    if (row.mark) parts.push(`<text x="${x + 10}" y="${ty}" font-size="9" font-weight="600" fill="${palette.subtle}">${row.mark.toUpperCase()}</text>`);
    parts.push(`<text x="${nameX}" y="${ty}">${esc(row.left)}</text>`);
    if (row.right) parts.push(`<text x="${typeX}" y="${ty}" text-anchor="end" fill="${palette.type}">${esc(row.right)}</text>`);
    if (nulls) {
      const cx = x + w - 14;
      const cy = mid;
      const d = `M${cx} ${num(cy - 4)} L${cx + 4} ${num(cy)} L${cx} ${num(cy + 4)} L${cx - 4} ${num(cy)} Z`;
      parts.push(
        row.notNull
          ? `<path data-marker="not-null" d="${d}" fill="${palette.subtle}"/>`
          : `<path data-marker="nullable" d="${d}" fill="none" stroke="${palette.subtle}" stroke-width="1.5"/>`,
      );
    }
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

function edgeSvg(e: SceneEdge, palette: ExportPalette, frames: readonly SceneFrame[] = []): string {
  const pts = e.points;
  if (pts.length < 2) return "";
  if (e.kind === "flow") return flowEdgeSvg(e, palette);
  if (e.kind === "message") return messageSvg(e, palette, frames);
  if (e.kind === "branch") return branchSvg(e, palette);
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
    const w = Math.ceil(e.label.length * 6.5 * textK + 16);
    const h = 18 * textK;
    parts.push(
      `<rect data-part="label-pill" x="${num(cx - w / 2)}" y="${num(cy - h / 2)}" width="${w}" height="${num(h)}" rx="${num(h / 2)}" fill="${palette.canvas}" stroke="${palette.border}"/>`,
      `<text x="${num(cx)}" y="${num(cy + 4)}" text-anchor="middle" font-size="11" fill="${palette.subtle}">${esc(e.label)}</text>`,
    );
  }
  return `<g data-edge="${esc(e.id)}">${parts.join("")}</g>`;
}

/** Every `font-size` attribute in `svg` times `k`. Words are escaped (`esc`), so only attributes match. */
function scaleFonts(svg: string, k: number): string {
  return k === 1 ? svg : svg.replace(/ font-size="([\d.]+)"/g, (_, n: string) => ` font-size="${num(Number(n) * k)}"`);
}

/**
 * Whether the scene draws a pale logo that takes the hairline filter (an outlined icon on a node or a group). A
 * sequence participant's logo also takes it when faint on the participant's fill in `palette`; without the palette any
 * participant's logo counts, so a filter the drawing names is always defined.
 */
export function sceneOutlined(scene: Scene, palette?: ExportPalette): boolean {
  const outlined = (n: SceneNode) => {
    if (!n.icon) return false;
    if (n.iconOutline) return true;
    if (!SEQ_WHO.has(n.kind) || !n.iconName) return false;
    return palette ? participantOutline(n, seqColours(palette, n.color, whoOf(n)).fill) : logoHex(n.iconName) !== null;
  };
  return scene.nodes.some(outlined) || (scene.areas ?? []).some((a) => a.iconOutline && a.icon);
}

/** One run of words: a `<text>` element, its attributes and what it holds (tspans included). */
const TEXT_RUN = /<text([^>]*)>([\s\S]*?)<\/text>/g;
const RUN_ATTR = { x: / x="([^"]*)"/, y: / y="([^"]*)"/, size: / font-size="([^"]*)"/, anchor: / text-anchor="([^"]*)"/ };
const attrOf = (attrs: string, name: keyof typeof RUN_ATTR) => RUN_ATTR[name].exec(attrs)?.[1];
const ENTITY: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' };

/**
 * Every run of words in `svg` as one soft bar (as the canvas draws far text): a
 * `<rect rx="2">` on the run's line, `min(len * SOFT_CHAR_W * fontPx / 13, cap)` wide from the run's anchor, in
 * `palette.faint` at 45 percent. `fontPx` is the run's own size at the scene's text size; `cap` is the width of the
 * shape, group or band the run sits in.
 */
function softRuns(svg: string, cap: number, palette: ExportPalette): string {
  return svg.replace(TEXT_RUN, (_, attrs: string, inner: string) => {
    // A turned run (a block's kind word) is left out: a bar could not follow it, and turned 11 px words far are unreadable.
    if (/\stransform=/.test(attrs)) return "";
    const words = inner.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot);/g, (m) => ENTITY[m]);
    const len = [...words].length;
    if (len === 0) return "";
    // A run with no size of its own takes the image's: 13 px times the scene's text size (`wrapSvg`'s root font-size;
    // no group in a body sets one), the canvas's body size.
    const px = Number(attrOf(attrs, "size") ?? 13) * textK;
    const b = softBar(Number(attrOf(attrs, "x") ?? 0), Number(attrOf(attrs, "y") ?? 0), len, px, cap, attrOf(attrs, "anchor"));
    return `<rect data-part="soft" x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(px)}" rx="2" fill="${palette.faint}" fill-opacity="0.45"/>`;
  });
}

/**
 * The soft bar of a run of `len` characters at `fontPx` (already times the text size) whose anchor is at (x, y), its
 * baseline: `min(len * SOFT_CHAR_W * fontPx / 13, cap)` wide, one em tall from the words' ascent above the baseline.
 */
function softBar(x: number, y: number, len: number, px: number, cap: number, anchor: string | undefined): { x: number; y: number; w: number; h: number } {
  const w = Math.min((len * SOFT_CHAR_W * px) / 13, cap);
  const left = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  return { x: left, y: y - 0.8 * px, w, h: px };
}

/**
 * Everything a scene draws between the background and the mark, at its own text size (`Scene.textScale`, R1). With
 * `refs`, icons are `<use>`s of shared images (`svgDefs` draws them); an outlined one names `hairline`. With
 * `opts.softText` every run of words is a soft bar instead (`softRuns`, a frame picture whose text is far); without
 * `opts` the body is as it always was.
 */
export function sceneBody(scene: Scene, palette: ExportPalette, refs?: IconRefs, hairlineName: string = hairlineId(), opts?: BodyOptions): string {
  const steps = sceneBodySteps(scene, palette, refs, hairlineName, opts);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * How a body is drawn: `softText`, every run of words a soft bar; `picture`, a frame picture, where a sequence's parts
 * of one style are one path each (`PictureSequence`).
 */
export interface BodyOptions {
  softText?: boolean;
  picture?: boolean;
}

/** Parts drawn between two yields of `sceneBodySteps`. */
const BODY_STEP = 64;

/**
 * `sceneBody` in steps: it yields after every BODY_STEP parts (a shape, a line, a group...), so a frame picture of a
 * big diagram is drawn across time slices. The draw's text size, icon references and hairline are
 * set for each batch and put back before each yield, so another draw may run in between. Drained, it is `sceneBody`.
 */
export function* sceneBodySteps(
  scene: Scene,
  palette: ExportPalette,
  refs?: IconRefs,
  hairlineName: string = hairlineId(),
  opts?: BodyOptions,
): Generator<void, string> {
  const k = scene.textScale ?? 1;
  const softly = opts?.softText === true;
  // Each part softened inside its own width, before the fonts are scaled (bars carry no font size).
  const soft = softly ? (svg: string, cap: number) => softRuns(svg, cap, palette) : (svg: string) => svg;
  // Messages go over the lifelines and activation bars, and a frame's tab over everything, as on the canvas. A line's
  // label sits in its own pill, which is wider than the label's bar. A sequence paints in this order:
  // blocks, each participant (lane, bars, head, foot), messages with their chips and numbers, then captions.
  const draws: (() => string)[] = [];
  for (const sec of scene.sections ?? []) draws.push(() => soft(sectionSvg(sec, palette), sec.w));
  for (const a of scene.areas ?? []) draws.push(() => soft(areaSvg(a, palette), a.w));
  const frames = scene.frames ?? [];
  frames.forEach((fr, i) => draws.push(() => soft(frameSvg(fr, i, palette), fr.w)));
  const axis = scene.axis;
  if (axis) draws.push(() => axisSvg(axis, palette));
  for (const e of scene.edges) if (e.kind !== "message") draws.push(() => soft(edgeSvg(e, palette), Infinity));
  // In a frame picture a sequence's participants and messages are gathered into a few paths (`PictureSequence`),
  // drawn after the last of each.
  const seq = opts?.picture ? new PictureSequence(softly) : null;
  const seqNode = (n: SceneNode) => seq !== null && n.look !== undefined && SEQ_WHO.has(n.kind);
  for (const n of scene.nodes)
    if (seqNode(n))
      draws.push(() => {
        seq!.participant(n, palette);
        return "";
      });
  if (seq && scene.nodes.some(seqNode)) draws.push(() => seq.participantsSvg(palette));
  for (const n of scene.nodes) if (!seqNode(n)) draws.push(() => soft(nodeSvg(n, palette), n.w));
  for (const e of scene.edges)
    if (e.kind === "message")
      draws.push(
        seq && e.points.length >= 2
          ? () => {
              seq.message(e, palette, frames);
              return "";
            }
          : () => soft(edgeSvg(e, palette, frames), Infinity),
      );
  if (seq && scene.edges.some((e) => e.kind === "message")) draws.push(() => seq.messagesSvg(palette));
  frames.forEach((fr, i) => draws.push(() => soft(frameTabSvg(fr, i, palette), fr.w)));
  const parts: string[] = [];
  for (let i = 0; i < draws.length; i += BODY_STEP) {
    if (i > 0) yield;
    textK = k;
    refsInUse = refs;
    hairline = hairlineName;
    softPalette = softly ? palette : undefined;
    try {
      let chunk = "";
      for (let j = i; j < Math.min(i + BODY_STEP, draws.length); j++) chunk += draws[j]();
      // The frame's text size scales every label of the drawing, as on the canvas.
      parts.push(scaleFonts(chunk, k));
    } finally {
      textK = 1;
      refsInUse = undefined;
      hairline = HAIRLINE;
      softPalette = undefined;
    }
  }
  return parts.join("");
}

/**
 * The image round a drawn body: the head (its root `font-size` 13 times `textScale`), `defs`, the background, the body
 * and the mark, which keeps its own size. A board passes 1 and puts each frame's size on its group (R1).
 */
export function wrapSvg(defs: string, body: string, bounds: Box, palette: ExportPalette, opts: SvgOptions, textScale = 1, xlink = usesXlink(body)): string {
  const f = frameOf(bounds, opts);
  const background = opts.background === "theme" ? `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" fill="${palette.canvas}"/>` : "";
  const mark = opts.mark
    ? `<text x="${f.x + f.w - 8}" y="${f.y + f.h - 8}" text-anchor="end" font-size="11" fill="${palette.subtle}">${MARK_TEXT}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg"${xlink ? ` ${XLINK_NS}` : ""} width="${f.w}" height="${f.h}" viewBox="${f.x} ${f.y} ${f.w} ${f.h}" font-family="Segoe UI, Arial, sans-serif" font-size="${num(13 * textScale)}" fill="${palette.text}">${defs}${background}${body}${mark}</svg>\n`;
}

const NO_ICONS: ReadonlyMap<string, { url: string; size: number }> = new Map();

/** One scene as an SVG image; the hairline filter is defined once, and only when an outlined logo is drawn. */
export function sceneToSvg(scene: Scene, palette: ExportPalette, opts: SvgOptions): string {
  const defs = svgDefs(palette, { hairline: sceneOutlined(scene, palette) ? hairlineId() : null, icons: NO_ICONS });
  return wrapSvg(defs, sceneBody(scene, palette), opts.crop ?? sceneBounds(scene), palette, opts, scene.textScale ?? 1);
}
