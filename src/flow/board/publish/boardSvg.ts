// A board's own drawing as plain SVG (Plan B4 Decisions 3, 11 and 15): each frame's box and title tab, and every
// sketch, as the canvas draws them (FrameNode.tsx, SketchNode.tsx, flow-board.css). Only g, rect, text, path and use
// elements; every colour is read from the export palette, never written here (ADR 0008); words are cut by the 7 px
// estimate with "...", never clipped (R5). Sketch geometry comes from SketchNode.tsx, never retyped (R26).
import { SVG_MAX_BYTES } from "../../../diagram/export/limits";
import type { ExportPalette, ExportTheme } from "../../../diagram/export/palette";
import { type Box, type Scene, sceneEdges } from "../../../diagram/export/scene";
import { esc, glyph, hairlineId, type IconRefs, iconRefs, SAFE_IMAGE, sceneBody, sceneOutlined, svgDefs, useHref, wrapWords } from "../../../diagram/export/svg";
import { DIAGRAM_KIND_WORD } from "../../diagramKinds";
import { flowScene, type SceneIcon, sceneIconNames } from "../../flowScene";
import { drawnColour } from "../../palette";
import { FRAME_PAD, type Sketch, utf8Length } from "../boardLayout";
import { FRAME_TAB_H, TAB_CHAR_W, TAB_GAP, TAB_ICON, TAB_PAD_X, TAB_PILL_H, TAB_TITLE_MAX } from "../boardScene";
import { KIND_ICON } from "../chips";
import { frameName } from "../frameName";
import { headOf, NOTE_RX, OUTLINE, pathOf, RECT_RX, SECTION_DASH, SECTION_RX } from "../sketchGeometry";
import { drawsUnder } from "../sketches";
import { publishDrawn, type PublishNotes, type PublishSource } from "../../../diagram/export/source";
import { type BoardPart, type BoardPublishInput, defaultPart, frameExtent, join, partContent, partEnabled, type PublishFrame, SECTION_TITLE_ABOVE, selectionRegion, tabWidth } from "./boardPublish";

const num = (n: number) => String(Math.round(n * 100) / 100);

/** The body font's size and line height (`--font-body`); words sit 13 px below the top of their line. */
const FONT = 13;
const LINE = 18;
const BASELINE = 13;
const DOTS = "...";

/** `s`'s first `n` characters, by code points: a cut never splits a surrogate pair (final review minor 5). */
const firstChars = (s: string, n: number) => [...s].slice(0, n).join("");

/** `s` cut to at most `max` px by the estimate of `charW` px a character (a code point), ending "..." when cut. */
function cutToWidth(s: string, max: number, charW: number): string {
  const chars = [...s];
  if (chars.length * charW <= max) return s;
  const keep = Math.max(Math.floor(max / charW) - DOTS.length, 0);
  return `${chars.slice(0, keep).join("").trimEnd()}${DOTS}`;
}

const text = (x: number, y: number, body: string, attrs: string) => `<text x="${num(x)}" y="${num(y)}"${attrs}>${esc(body)}</text>`;

/**
 * A frame's box and its title tab (Decision 3, A6): the box a hairline in `border`, radius 8, no fill; the tab a pill
 * above the box's top-left corner holding the kind icon, the kind word and the title ("Untitled" when empty, cut at
 * TAB_TITLE_MAX). No selection ring, problem count or pane buttons: the image shows the drawing, not the work on it.
 */
export function frameChromeSvg(f: PublishFrame, palette: ExportPalette): { box: string; tab: string } {
  const { x, y, w, h } = f.box;
  // Hairlines half a pixel in, as a CSS border draws inside its box.
  const box = `<rect data-frame-box="${f.index}" x="${num(x + 0.5)}" y="${num(y + 0.5)}" width="${num(Math.max(w - 1, 0))}" height="${num(Math.max(h - 1, 0))}" rx="8" fill="none" stroke="${palette.border}"/>`;
  const top = y - FRAME_TAB_H;
  const word = DIAGRAM_KIND_WORD[f.kind];
  // `frameName` is the one place an empty title reads "Untitled": the kind word, a space, then the title.
  const title = cutToWidth(frameName({ kind: f.kind, title: f.title }).slice(word.length + 1), TAB_TITLE_MAX, TAB_CHAR_W);
  const pw = tabWidth(f.title, f.kind);
  const base = top + TAB_PILL_H / 2 + 4.5;
  const wordX = x + TAB_PAD_X + TAB_ICON + TAB_GAP;
  const titleX = wordX + word.length * TAB_CHAR_W + TAB_GAP;
  const tab =
    `<g data-frame-tab="${f.index}" font-size="${FONT}">` +
    `<rect x="${num(x + 0.5)}" y="${num(top + 0.5)}" width="${num(pw - 1)}" height="${num(TAB_PILL_H - 1)}" rx="6" fill="${palette.surface}" stroke="${palette.strongBorder}"/>` +
    glyph(KIND_ICON[f.kind] ?? "square", x + TAB_PAD_X, top + (TAB_PILL_H - TAB_ICON) / 2, TAB_ICON, palette.muted, "kind-icon") +
    text(wordX, base, word, ` fill="${palette.subtle}"`) +
    text(titleX, base, title, ` fill="${palette.muted}" font-weight="600"`) +
    `</g>`;
  return { box, tab };
}

/** A sketch's stroke (`sketchStroke`'s rule): its preset's or hex's in this palette; anything else the theme's text. */
function strokeOf(s: Sketch, palette: ExportPalette): string {
  const c = drawnColour(s.color);
  if (!c) return palette.text;
  if (c[0] === "#") return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c) ? c : palette.text;
  return palette.colours?.[c as keyof NonNullable<ExportPalette["colours"]>]?.stroke ?? palette.text;
}

/**
 * Words wrapped inside a box `w` by `h` with `padX`, `padY` round them, a line per text element; lines past the box are
 * dropped and the last kept one ends "...". Lines kept apart by the writer stay apart, as `pre-wrap` keeps them.
 */
function wordsSvg(words: string, w: number, h: number, padX: number, padY: number, fill: string): string {
  const max = Math.floor((w - 2 * padX) / TAB_CHAR_W);
  const fit = Math.floor((h - 2 * padY) / LINE);
  if (max <= 0 || fit <= 0) return "";
  const lines = words.split("\n").flatMap((p) => wrapWords(p, max));
  const shown = lines.slice(0, fit);
  if (lines.length > fit) {
    const last = shown[fit - 1];
    shown[fit - 1] = `${firstChars(last, Math.max(max - DOTS.length, 0)).trimEnd()}${DOTS}`;
  }
  return shown.map((l, i) => (l ? text(padX, padY + i * LINE + BASELINE, l, ` font-size="${FONT}" fill="${fill}"`) : "")).join("");
}

/** The icon sketch's box, its image and title (A3, `flow-board.css` `.board-sketch-icon*`). */
const ICON_BOX = 64;
const ICON_SIZE = 40;
const ICON_TOP = 2;
const ICON_TITLE_SIZE = 11;
const ICON_TITLE_LINE = 16;

function iconSketchSvg(s: Sketch, palette: ExportPalette, icon?: { icons: ReadonlyMap<string, SceneIcon>; refs: IconRefs; titles: ReadonlyMap<string, string>; hairline?: string }): string {
  const name = s.icon ?? "";
  const loaded = icon?.icons.get(name);
  const x = (ICON_BOX - ICON_SIZE) / 2;
  let image: string;
  if (icon && loaded && SAFE_IMAGE.test(loaded.url)) {
    const filter = loaded.outline && icon.hairline ? ` filter="url(#${esc(icon.hairline)})"` : "";
    image = `<use ${useHref(icon.refs.ref(loaded.url, ICON_SIZE))} x="${x}" y="${ICON_TOP}"${filter}/>`;
  } else {
    // The canvas's dashed square for an icon the pack does not have, or one not loaded.
    const i = OUTLINE / 2;
    image = `<rect data-part="missing" x="${num(x + i)}" y="${num(ICON_TOP + i)}" width="${num(ICON_SIZE - OUTLINE)}" height="${num(ICON_SIZE - OUTLINE)}" fill="none" stroke="${palette.subtle}" stroke-width="${OUTLINE}" stroke-dasharray="4 3"/>`;
  }
  const title = cutToWidth(icon?.titles.get(name) ?? name, ICON_BOX, (TAB_CHAR_W * ICON_TITLE_SIZE) / FONT);
  const ty = ICON_TOP + ICON_SIZE + ICON_TITLE_LINE / 2 + 4;
  return image + (title ? text(ICON_BOX / 2, ty, title, ` text-anchor="middle" font-size="${ICON_TITLE_SIZE}" fill="${palette.muted}"`) : "");
}

/** A path stroked as the canvas strokes a sketch's outline. */
const stroked = (part: string, d: string, stroke: string) =>
  `<path data-part="${part}" d="${d}" fill="none" stroke="${stroke}" stroke-width="${OUTLINE}" stroke-linecap="round" stroke-linejoin="round"/>`;

/**
 * One sketch as `SketchDrawing` draws it (Decision 15), in a group at its place: `<g data-sketch="<id>"
 * transform="translate(x y)">`, its points written as stored (relative to the box). Ellipse and diamond are one path
 * each (A4). An icon sketch draws its loaded image through `icon.refs` (an outlined one with `icon.hairline`), else the
 * dashed square, with its title from `icon.titles` (its name without one).
 */
export function sketchSvg(
  s: Sketch,
  palette: ExportPalette,
  icon?: { icons: ReadonlyMap<string, SceneIcon>; refs: IconRefs; titles: ReadonlyMap<string, string>; hairline?: string },
): string {
  const w = Math.max(s.w, 0);
  const h = Math.max(s.h, 0);
  const inset = OUTLINE / 2;
  const iw = Math.max(w - OUTLINE, 0);
  const ih = Math.max(h - OUTLINE, 0);
  const stroke = strokeOf(s, palette);
  const outline = ` fill="none" stroke="${stroke}" stroke-width="${OUTLINE}"`;
  let body = "";
  switch (s.kind) {
    case "rect":
      body = `<rect x="${num(inset)}" y="${num(inset)}" width="${num(iw)}" height="${num(ih)}" rx="${RECT_RX}"${outline}/>`;
      break;
    case "ellipse": {
      const rx = iw / 2;
      const ry = ih / 2;
      const cx = w / 2;
      const cy = h / 2;
      body = `<path data-part="ellipse" d="M${num(cx - rx)} ${num(cy)}A${num(rx)} ${num(ry)} 0 1 0 ${num(cx + rx)} ${num(cy)}A${num(rx)} ${num(ry)} 0 1 0 ${num(cx - rx)} ${num(cy)}Z"${outline}/>`;
      break;
    }
    case "diamond":
      body = `<path data-part="diamond" d="M${num(w / 2)} ${num(inset)}L${num(w - inset)} ${num(h / 2)}L${num(w / 2)} ${num(h - inset)}L${num(inset)} ${num(h / 2)}Z"${outline} stroke-linejoin="round"/>`;
      break;
    case "section":
      body =
        `<rect x="${num(inset)}" y="${num(inset)}" width="${num(iw)}" height="${num(ih)}" rx="${SECTION_RX}"${outline} stroke-dasharray="${SECTION_DASH}"/>` +
        // The title above the box, in its 4 px gap: one line, cut at the box's width; the region counts it.
        text(0, -SECTION_TITLE_ABOVE + BASELINE, cutToWidth(s.text || "Section", w, TAB_CHAR_W), ` font-size="${FONT}" font-weight="600" fill="${palette.muted}"`);
      break;
    case "note":
      body =
        `<rect x="${num(inset)}" y="${num(inset)}" width="${num(iw)}" height="${num(ih)}" rx="${NOTE_RX}" fill="${palette.colours?.warning.fill ?? palette.surface}" stroke="${palette.subtle}" stroke-width="1"/>` +
        (s.text ? wordsSvg(s.text, w, h, 10, 8, palette.text) : "");
      break;
    case "text":
      body = s.text ? wordsSvg(s.text, w, h, 0, 0, stroke) : "";
      break;
    case "line":
    case "arrow":
    case "pen": {
      const points =
        s.points && s.points.length > 0
          ? s.points
          : ([
              [0, 0],
              [w, h],
            ] as [number, number][]);
      const head = s.kind === "arrow" ? headOf(points) : null;
      body = stroked("stroke", pathOf(points), stroke) + (head ? stroked("head", head, stroke) : "");
      break;
    }
    case "icon":
      body = iconSketchSvg(s, palette, icon);
      break;
  }
  return `<g data-sketch="${esc(s.id)}" transform="translate(${num(s.x)} ${num(s.y)})">${body}</g>`;
}

/** A board part drawn: the region, the body and the one `<defs>`, their UTF-8 size, and the snap edges (board units). */
export interface ComposedBoard {
  bounds: Box;
  body: string;
  defs: string;
  bytes: number;
  edges: { xs: number[]; ys: number[] };
  /** How many frames were drawn: fewer than the part holds when the image passed the cap. */
  frames: number;
  tooLarge: boolean;
}

/** Test-only hooks (R13, R14): each frame's scene as it is built, each compose run, and a lower SVG cap. */
export const composeHooks: { onScene?: (index: number, scene: Scene) => void; onCompose?: () => void; maxBytes?: number } = {};

const EMPTY_DEFS_BYTES = utf8Length("<defs></defs>");

/** A frame's scene, as the canvas draws it: its layout, folds, text size and notation (Decision 6, R9). */
const frameScene = (f: PublishFrame, icons: ReadonlyMap<string, SceneIcon>): Scene =>
  flowScene(f.doc, f.layout.nodes, f.layout.style, icons, f.layout.axes, f.folded, { textScale: f.textScale, notation: f.notation });

/**
 * The frame's box grown to hold what its scene draws (final review I1): the canvas caps an ER card at 20 rows and its
 * box with it, while Publish draws every row. Where a shape, group area, loop box or section of the scene (moved by
 * `at`) passes an edge of the canvas box, that edge moves out to it plus FRAME_PAD, as the canvas pads its box; every
 * other edge stays, so a frame the canvas fits keeps its box exactly.
 */
function grownBox(f: PublishFrame, scene: Scene): Box {
  const b = f.box;
  let [x0, y0, x1, y1] = [b.x, b.y, b.x + b.w, b.y + b.h];
  for (const n of [...scene.nodes, ...(scene.areas ?? []), ...(scene.frames ?? []), ...(scene.sections ?? [])]) {
    const [l, t, r, d] = [n.x + f.at.x, n.y + f.at.y, n.x + n.w + f.at.x, n.y + n.h + f.at.y];
    if (l < b.x) x0 = Math.min(x0, l - FRAME_PAD);
    if (t < b.y) y0 = Math.min(y0, t - FRAME_PAD);
    if (r > b.x + b.w) x1 = Math.max(x1, r + FRAME_PAD);
    if (d > b.y + b.h) y1 = Math.max(y1, d + FRAME_PAD);
  }
  if (x0 === b.x && y0 === b.y && x1 === b.x + b.w && y1 === b.y + b.h) return b;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Draws part `p` of the board one frame at a time (Decisions 3, 7, 9, 10 and 12): the under-sketches (Section,
 * rectangle, ellipse, diamond), then each frame in text order, then every other sketch, each layer in layout order
 * (R3). Each frame is a group `<g data-board-frame="<index>" transform="translate(at)" font-size="<13 times its text
 * size>">` holding its box, its scene's body and its tab (box and tab only with `titles`). A frame's scene is dropped
 * before the next is built, and the generator yields the frame's index, so only one scene is alive at a time (R14);
 * for Selection the live frame's scene is built first for the region and used again at its turn. `<defs>` holds the
 * hairline filter, only when an outlined logo is drawn, and each icon image once; its size counts. Past the SVG cap
 * the compose stops at the frame or sketch that passed it and sets `tooLarge`. A frame's box grows to hold its scene
 * (`grownBox`), and so do the Whole board and Selected frame regions; a Selection or screen region is the user's.
 */
export function* composeSteps(
  i: BoardPublishInput,
  p: BoardPart,
  palette: ExportPalette,
  theme: ExportTheme,
  icons: ReadonlyMap<string, SceneIcon>,
  titles: boolean,
): Generator<number, ComposedBoard> {
  composeHooks.onCompose?.();
  const cap = composeHooks.maxBytes ?? SVG_MAX_BYTES;
  const hairline = hairlineId(theme);
  const refs = iconRefs();
  const sketchIcons = { icons, refs, titles: i.iconTitles, hairline };

  let liveScene: Scene | null = null;
  let region: Box | null = null;
  if (p === "selection") {
    const live = i.frames.find((f) => f.live);
    liveScene = live ? frameScene(live, icons) : null;
    region = selectionRegion(i, liveScene);
  } else if (p === "screen") region = i.onScreen;
  const part = partContent(i, p, region, titles);
  // A live frame the part leaves out never needs its scene: drop it now, so one scene is alive at a time.
  if (liveScene && !part.frames.some((f) => f.live)) liveScene = null;

  const parts: string[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  let bodyBytes = 0;
  // The <defs> size so far: the images handed out by `refs`, counted as they appear, and the filter once.
  let outlined = false;
  let defsBytes = 0;
  let imagesCounted = 0;
  const countDefs = () => {
    const entries = refs.entries();
    if (entries.size > imagesCounted) {
      let k = 0;
      for (const [id, e] of entries) {
        if (k++ < imagesCounted) continue;
        // `svgDefs` leaves out a URL that is not a data: image, so it adds nothing here either.
        if (!SAFE_IMAGE.test(e.url)) continue;
        defsBytes += utf8Length(svgDefs(palette, { hairline: null, icons: new Map([[id, e]]) })) - EMPTY_DEFS_BYTES;
      }
      imagesCounted = entries.size;
    }
  };
  const outline = () => {
    if (outlined) return;
    outlined = true;
    defsBytes += utf8Length(svgDefs(palette, { hairline, icons: new Map() })) - EMPTY_DEFS_BYTES;
  };
  const push = (s: string) => {
    parts.push(s);
    bodyBytes += utf8Length(s);
    countDefs();
  };
  const over = () => bodyBytes + (defsBytes > 0 ? defsBytes + EMPTY_DEFS_BYTES : 0) > cap;
  let drawn = 0;
  // Whole board and Selected frame grow with each frame's grown extent (I1); the other parts keep their region.
  let bounds: Box = part.region;
  const grows = p === "board" || p === "frame";
  const finish = (tooLarge: boolean): ComposedBoard => {
    // Past the cap nothing is drawn or written: the parts go at once, and only the size reached and the frames drawn
    // are kept, so a refusal never holds a body near the cap (ADR 0003).
    if (tooLarge) {
      parts.length = 0;
      return { bounds, body: "", defs: "", bytes: bodyBytes + (defsBytes > 0 ? defsBytes + EMPTY_DEFS_BYTES : 0), edges: { xs: [], ys: [] }, frames: drawn, tooLarge };
    }
    const defs = svgDefs(palette, { hairline: outlined ? hairline : null, icons: refs.entries() });
    const body = parts.join("");
    return { bounds, body, defs, bytes: bodyBytes + utf8Length(defs), edges: { xs, ys }, frames: drawn, tooLarge };
  };
  const filterRef = `url(#${hairline})`;
  const sketch = (s: Sketch) => {
    const svg = sketchSvg(s, palette, sketchIcons);
    if (svg.includes(filterRef)) outline();
    push(svg);
    xs.push(s.x, s.x + s.w);
    ys.push(s.y, s.y + s.h);
  };

  for (const s of part.sketches) {
    if (!drawsUnder(s.kind)) continue;
    sketch(s);
    if (over()) return finish(true);
  }

  for (const f of part.frames) {
    let scene: Scene | null;
    if (f.live && liveScene) {
      scene = liveScene;
      liveScene = null;
    } else scene = frameScene(f, icons);
    composeHooks.onScene?.(f.index, scene);
    const { x, y } = f.at;
    const k = scene.textScale ?? 1;
    const box = grownBox(f, scene);
    if (grows && box !== f.box) bounds = join(bounds, frameExtent({ ...f, box }, titles));
    let svg = `<g data-board-frame="${f.index}" transform="translate(${num(x)} ${num(y)})" font-size="${num(13 * k)}">`;
    // The chrome in the frame's own units, so the whole frame moves by its one transform.
    const chrome = titles ? frameChromeSvg({ ...f, box: { ...box, x: box.x - x, y: box.y - y } }, palette) : null;
    if (chrome) svg += chrome.box;
    const body = sceneBody(scene, palette, refs, hairline);
    svg += body;
    if (chrome) svg += chrome.tab;
    svg += "</g>";
    // Only a logo actually drawn names the filter (an unsafe URL draws nothing).
    if (sceneOutlined(scene, palette) && body.includes(filterRef)) outline();
    const e = sceneEdges(scene);
    for (const v of e.xs) xs.push(v + x);
    for (const v of e.ys) ys.push(v + y);
    if (titles) {
      xs.push(box.x, box.x + box.w);
      ys.push(box.y, box.y + box.h);
    }
    // Dropped before the yield, so the suspended generator never holds it (R14).
    scene = null;
    push(svg);
    drawn++;
    if (over()) return finish(true);
    yield f.index;
  }
  liveScene = null;

  for (const s of part.sketches) {
    if (drawsUnder(s.kind)) continue;
    sketch(s);
    if (over()) return finish(true);
  }
  return finish(false);
}

/** `composeSteps` drained: the one path every Publish of a board draws through, so the gates test it. */
export function composeBoard(
  i: BoardPublishInput,
  p: BoardPart,
  palette: ExportPalette,
  theme: ExportTheme,
  icons: ReadonlyMap<string, SceneIcon>,
  titles: boolean,
): ComposedBoard {
  const steps = composeSteps(i, p, palette, theme, icons, titles);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** Every icon the board's frames and icon sketches ask for, once each (R25): what a theme loads for Publish. */
export function boardIconNames(i: BoardPublishInput): string[] {
  const names = new Set<string>();
  for (const f of i.frames) for (const n of sceneIconNames(f.doc)) names.add(n);
  for (const s of i.sketches) if (s.kind === "icon" && s.icon) names.add(s.icon);
  return [...names];
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** The left-out counts of Decision 4 as the note says them (Decision 14), or null when nothing is left out. */
function leftOutNote(i: BoardPublishInput): string | null {
  const said: string[] = [];
  if (i.nothingDrawn === 1) said.push("1 frame with nothing drawn yet is left out.");
  else if (i.nothingDrawn > 1) said.push(`${fmt(i.nothingDrawn)} frames with nothing drawn yet are left out.`);
  if (i.clashing === 1) said.push("1 frame with a repeated title is left out.");
  else if (i.clashing > 1) said.push(`${fmt(i.clashing)} frames with repeated titles are left out.`);
  return said.length > 0 ? said.join(" ") : null;
}

/** The board column of Decision 14. */
function boardNotes(i: BoardPublishInput): PublishNotes {
  return {
    partLabel: "Part of the board",
    offReason: { frame: "Select a frame to publish it.", selection: "Select shapes or sketches to publish them." },
    scaleLimited: (n) => `Scale is limited to ${n}x for this image.`,
    pngOff: "Too large for PNG. Save as SVG, or publish a frame or the selection.",
    tooLarge: "Too large to publish as one image. Publish a frame or the selection.",
    leftOut: leftOutNote(i),
  };
}

const PARTS: { value: BoardPart; label: string }[] = [
  { value: "board", label: "Whole board" },
  { value: "frame", label: "Selected frame" },
  { value: "selection", label: "Selection" },
  { value: "screen", label: "What's on screen" },
];

/**
 * A board as a Publish source (Decisions 1, 2, 5 and 14): the four parts, off without what they need; the part the
 * selection asks for (or `initial`, when it is on); the Frame titles switch, on; icons inked for `theme`. Each draw
 * composes the part frame by frame (`composeBoard`) and keeps only its strings; nothing is held past the drawing.
 */
export function boardSource(i: BoardPublishInput, icons: ReadonlyMap<string, SceneIcon>, theme: ExportTheme, initial?: BoardPart): PublishSource {
  return {
    parts: PARTS.map((p) => ({ ...p, disabled: !partEnabled(i, p.value) })),
    initial: initial !== undefined && partEnabled(i, initial) ? initial : defaultPart(i),
    titles: true,
    inkedFor: theme,
    notes: boardNotes(i),
    draw(part, palette, titles) {
      const c = composeBoard(i, part as BoardPart, palette, theme, icons, titles);
      return publishDrawn({ bounds: c.bounds, body: c.body, defs: c.defs, bytes: c.bytes, edges: c.edges, palette, tooLarge: c.tooLarge, frames: c.frames });
    },
  };
}
