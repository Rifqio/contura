// A scene as plain SVG: rect, text, path and (for cloud icons) image elements only, no foreignObject and no web
// fonts, so other tools open it cleanly. Each kind is drawn as the canvas draws it (flow-canvas.css, kindNodes.tsx). Every colour comes from the palette, read from the tokens. A cloud icon
// is an <image> of the pack's own bytes as a data: URL, never inline markup (ruling P9); a pale logo on light also
// takes the one hairline filter, made of filter primitives only.
import { iconPath, type IconName } from "../../components/Icon";
import { CARD_HEADER, CARD_ROW } from "../metrics";
import { roundedPath } from "../route";
import type { EdgeKind } from "../types";
import { type ExportPalette, sceneColour } from "./palette";
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
const imageSvg = (url: string, x: number, y: number, size: number, outline?: boolean) =>
  SAFE_IMAGE.test(url)
    ? `<image href="${esc(url)}" x="${num(x)}" y="${num(y)}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"${outline ? ` filter="url(#${HAIRLINE})"` : ""}/>`
    : "";

/** The hairline a pale logo draws with on light (the canvas's `icon-hairline`): its shape grown half a unit, in the text colour, under it. */
const HAIRLINE = "icon-hairline";
const hairlineDefs = (palette: ExportPalette) =>
  `<defs><filter id="${HAIRLINE}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">` +
  `<feMorphology in="SourceAlpha" operator="dilate" radius="0.5" result="grown"/><feFlood flood-color="${palette.text}"/>` +
  `<feComposite in2="grown" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;

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
  } else if (!url) {
    // A service with no icon keeps its plain tile.
    parts.push(`<rect x="${num(tx)}" y="${y}" width="48" height="48" rx="6" fill="${palette.iconTile}" stroke="${palette.border}"/>`);
    if (url) parts.push(imageSvg(url, tx + 4, y + 4, 40));
  } else parts.push(imageSvg(url, tx, y, 48, n.iconOutline));
  parts.push(text(x + w / 2, y + 66, n.title, ` text-anchor="middle" font-size="12"`));
  if (n.tag) parts.push(text(tx + 54, y + 12, n.tag, ` font-size="11" fill="${palette.subtle}"`));
}

/**
 * A state diagram's shapes as the canvas draws them (diag-910 fix round 3, P1): the start a filled dot, the end a ring
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

/** `s` in lines of at most `max` characters, broken between words; a word longer than a line is cut. */
export function wrapWords(s: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > max) {
      if (line) lines.push(line);
      line = "";
      lines.push(w.slice(0, max));
      w = w.slice(max);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= max) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
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

/** A sequence participant: its head box on top (an actor with a person before its name), the dashed lifeline down the node, its activation bars. */
function participantSvg(n: SceneNode, palette: ExportPalette, parts: string[]) {
  const { fill, stroke } = palette.nodes[n.kind];
  const { x, y, w, h } = n;
  const cx = x + w / 2;
  parts.push(`<path data-part="lifeline" d="M${num(cx)} ${num(y + 40)} V${num(y + h)}" fill="none" stroke="${palette.strongBorder}" stroke-dasharray="4 3"/>`);
  for (const b of n.bars ?? []) {
    parts.push(`<rect data-part="activation" x="${num(cx - 5)}" y="${num(y + b.top)}" width="10" height="${num(b.height)}" rx="2" fill="${fill}" stroke="${stroke}"/>`);
  }
  parts.push(`<rect data-part="lifehead" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="40" rx="6" fill="${fill}" stroke="${stroke}"/>`);
  if (n.kind === "actor") {
    const left = cx - (20 + textWidth(n.title)) / 2;
    parts.push(glyph("user", left, y + 13, 14, stroke, "person"), text(left + 20, y + 25, n.title, ` font-weight="600"`));
  } else parts.push(text(cx, y + 25, n.title, ` text-anchor="middle" font-weight="600"`));
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

/** A drawn node: data flow, flowchart, cloud (frames 6+.2, 6+.4, 6+.5), state and the step 12 kinds, as the canvas draws them. */
function drawnSvg(n: SceneNode, given: ExportPalette): string {
  const parts: string[] = [];
  // Step 11: a coloured shape draws its palette colour's fill and border in place of its kind's, and its words.
  const c = coloured(given, n.color);
  const palette = c ? { ...given, nodes: { ...given.nodes, [n.kind]: { fill: c.fill, stroke: c.stroke } } } : given;
  if (n.kind === "process" || n.kind === "store" || n.kind === "external") dfdSvg(n, palette, parts);
  else if (n.kind === "service") serviceSvg(n, palette, parts);
  else if (STATE_KINDS.has(n.kind)) stateSvg(n, palette, parts);
  else if (n.kind === "note") noteSvg(n, palette, parts);
  else if (CLASS_KINDS.has(n.kind)) classSvg(n, palette, parts);
  else if (n.kind === "participant" || n.kind === "actor") participantSvg(n, palette, parts);
  else if (MIND_KINDS.has(n.kind)) mindSvg(n, palette, parts);
  else if (TIME_KINDS.has(n.kind)) timeSvg(n, palette, parts);
  else if (n.kind === "document" || n.kind === "database") documentSvg(n, palette, parts);
  else flowchartSvg(n, palette, parts);
  return `<g data-node="${esc(n.id)}"${c ? ` fill="${c.text}"` : ""}>${parts.join("")}</g>`;
}

/** A group: a tinted area with its name at the top left; groups inside groups have a solid edge. */
function areaSvg(a: SceneArea, palette: ExportPalette): string {
  const dash = a.depth === 0 ? ` stroke-dasharray="5 4"` : "";
  // Step 11: a coloured group takes its colour on its border, tint and title, as the canvas draws it.
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
  const len = Math.hypot(tip.x - from.x, tip.y - from.y);
  const ux = len === 0 ? 1 : (tip.x - from.x) / len;
  const uy = len === 0 ? 0 : (tip.y - from.y) / len;
  const bx = tip.x - ux * 6;
  const by = tip.y - uy * 6;
  return `<path data-marker="head" d="M${num(tip.x)} ${num(tip.y)} L${num(bx - uy * 3)} ${num(by + ux * 3)} L${num(bx + uy * 3)} ${num(by - ux * 3)} Z" fill="${fill}"/>`;
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
  if (mark === "open") return `<path${tag} data-marker="open" d="M${at(9, -4)} L${at(0, 0)} L${at(9, 4)}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`;
  // An ER end, as the canvas's markers draw it: a bar across the line 8 px in, or a crow's foot spreading onto the card.
  if (mark === "one") return `<path${tag} data-marker="bar" d="M${at(8, -5)} L${at(8, 5)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`;
  if (mark === "many") return `<path${tag} data-marker="crow" d="M${at(10, 0)} L${at(0, -5)} M${at(10, 0)} L${at(0, 5)} M${at(10, 0)} L${at(0, 0)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`;
  if (mark === "triangle") return `<path${tag} data-marker="triangle" d="M${at(0, 0)} L${at(11, 5)} L${at(11, -5)} Z" fill="${palette.canvas}" stroke="${stroke}" stroke-width="1.5"/>`;
  return `<path${tag} data-marker="diamond" d="M${at(0, 0)} L${at(7, 5)} L${at(14, 0)} L${at(7, -5)} Z" fill="${stroke}"/>`;
}

/** A drawn diagram's or lineage's line: square with 8 px corners, 6 px heads, the label on a 6 px-radius chip. */
function flowEdgeSvg(e: SceneEdge, given: ExportPalette): string {
  const pts = e.points;
  // Step 11: a coloured line keeps its colour and its arrowheads; its label chip stays plain.
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
    const w = Math.ceil(e.label.length * 6.5 + 12);
    parts.push(
      `<rect data-part="chip" x="${num(cx - w / 2)}" y="${num(cy - 10)}" width="${w}" height="20" rx="6" fill="${palette.surface}" stroke="${palette.border}"/>`,
      text(cx, cy + 4, e.label, ` text-anchor="middle" font-size="11" fill="${given.subtle}"`),
    );
  }
  return `<g data-edge="${esc(e.id)}">${parts.join("")}</g>`;
}

/**
 * A sequence message as SeqEdge draws it: straight along its row from lifeline to lifeline (a message to itself loops
 * out right), dashed for a reply, its head at the target, its words above the line on the canvas colour.
 */
function messageSvg(e: SceneEdge, palette: ExportPalette): string {
  const pts = e.points;
  const stroke = palette.subtle;
  const dash = e.line === "dashed" ? ` stroke-dasharray="5 4"` : "";
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${num(p.x)} ${num(p.y)}`).join(" ");
  const parts = [`<path data-part="message" d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5"${dash}/>`];
  parts.push(markSvg(e.marks?.end ?? "arrow", pts[pts.length - 2], pts[pts.length - 1], palette, ` data-part="head"`));
  if (e.label) {
    const self = pts.length > 2;
    const w = textWidth(e.label) * 0.93 + 8;
    const left = self ? pts[0].x + 48 : (pts[0].x + pts[1].x) / 2 - w / 2;
    const bottom = self ? pts[0].y : pts[0].y - 10;
    parts.push(
      `<rect x="${num(left)}" y="${num(bottom - 16)}" width="${num(w)}" height="16" rx="3" fill="${palette.canvas}"/>`,
      text(left + 4, bottom - 4, e.label, ` font-size="12" fill="${palette.subtle}"`),
    );
  }
  return `<g data-edge="${esc(e.id)}">${parts.join("")}</g>`;
}

/** A mind map branch as MindEdge draws it: a curve from the parent's side to the child's, with no head. */
function branchSvg(e: SceneEdge, palette: ExportPalette): string {
  const a = e.points[0];
  const b = e.points[e.points.length - 1];
  const mx = (a.x + b.x) / 2;
  return `<g data-edge="${esc(e.id)}"><path d="M${num(a.x)} ${num(a.y)} C ${num(mx)} ${num(a.y)}, ${num(mx)} ${num(b.y)}, ${num(b.x)} ${num(b.y)}" fill="none" stroke="${palette.subtle}" stroke-width="1.5"/></g>`;
}

/** A sequence frame's box over its rows, on a light tint of the panel. */
const frameSvg = (f: SceneFrame, i: number, palette: ExportPalette) =>
  `<g data-frame="${i}"><rect x="${num(f.x)}" y="${num(f.y)}" width="${num(f.w)}" height="${num(f.h)}" rx="6" fill="${palette.panel}" fill-opacity="0.4" stroke="${palette.strongBorder}"/></g>`;

/** A frame's label in its tab at the frame's top left, drawn over the participants as the canvas draws it. */
function frameTabSvg(f: SceneFrame, i: number, palette: ExportPalette): string {
  const w = f.label.length * 7 + 18;
  const { x, y } = f;
  const d = `M${num(x)} ${num(y + 21)} V${num(y + 6)} Q${num(x)} ${num(y)} ${num(x + 6)} ${num(y)} H${num(x + w)} V${num(y + 15)} Q${num(x + w)} ${num(y + 21)} ${num(x + w - 6)} ${num(y + 21)} Z`;
  return `<g data-frame-tab="${i}"><path data-part="tab" d="${d}" fill="${palette.surface}" stroke="${palette.strongBorder}"/>${text(x + 8, y + 15, f.label, ` font-size="12" font-weight="600" fill="${palette.subtle}"`)}</g>`;
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
  // Step 11: a coloured ER table draws its colour's border and header in place of its kind's.
  const c = coloured(palette, n.color);
  const colours = c ? { fill: c.fill, stroke: c.stroke } : palette.nodes[n.kind];
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
  // An ER card's not-null marks, as the canvas draws them: a filled diamond, an outline for a nullable column (M11).
  const nulls = n.rows.some((row) => row.notNull !== undefined);
  const typeX = x + w - (nulls ? 24 : 10);
  n.rows.forEach((row, i) => {
    const ty = y + CARD_HEADER + CARD_ROW * i + 16;
    if (row.mark) parts.push(`<text x="${x + 10}" y="${ty}" font-size="9" font-weight="600" fill="${palette.subtle}">${row.mark.toUpperCase()}</text>`);
    parts.push(`<text x="${nameX}" y="${ty}">${esc(row.left)}</text>`);
    if (row.right) parts.push(`<text x="${typeX}" y="${ty}" text-anchor="end" fill="${palette.type}">${esc(row.right)}</text>`);
    if (nulls) {
      const cx = x + w - 14;
      const cy = ty - 4;
      const d = `M${cx} ${cy - 4} L${cx + 4} ${cy} L${cx} ${cy + 4} L${cx - 4} ${cy} Z`;
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

function edgeSvg(e: SceneEdge, palette: ExportPalette): string {
  const pts = e.points;
  if (pts.length < 2) return "";
  if (e.kind === "flow") return flowEdgeSvg(e, palette);
  if (e.kind === "message") return messageSvg(e, palette);
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
  const sections = (scene.sections ?? []).map((sec) => sectionSvg(sec, palette)).join("");
  const areas = (scene.areas ?? []).map((a) => areaSvg(a, palette)).join("");
  const frames = (scene.frames ?? []).map((fr, i) => frameSvg(fr, i, palette)).join("");
  const axis = scene.axis ? axisSvg(scene.axis, palette) : "";
  // Messages go over the lifelines and activation bars, and a frame's tab over everything, as on the canvas.
  const edges = scene.edges.filter((e) => e.kind !== "message").map((e) => edgeSvg(e, palette)).join("");
  const nodes = scene.nodes.map((n) => nodeSvg(n, palette)).join("");
  const messages = scene.edges.filter((e) => e.kind === "message").map((e) => edgeSvg(e, palette)).join("");
  const tabs = (scene.frames ?? []).map((fr, i) => frameTabSvg(fr, i, palette)).join("");
  // The hairline filter is defined once, and only when an outlined logo is drawn.
  const outlined = scene.nodes.some((n) => n.iconOutline && n.icon) || (scene.areas ?? []).some((a) => a.iconOutline && a.icon);
  const defs = outlined ? hairlineDefs(palette) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.w}" height="${f.h}" viewBox="${f.x} ${f.y} ${f.w} ${f.h}" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="${palette.text}">${defs}${background}${sections}${areas}${frames}${axis}${edges}${nodes}${messages}${tabs}${mark}</svg>\n`;
}
