// What the Publish dialog publishes (B4 Task 5): a source names its parts, its notes and draws a part once into a
// drawing whose head (crop, padding, background, mark) is written on demand, so a crop never draws the body again
// (Decision 12). `sceneSource` is one diagram's scene with today's presets and words; a board's source is
// `boardSource` (flow/board/publish/boardSvg.ts). Each string of the diagram column of Decision 14 lives here (L8).
import { utf8Length } from "../../flow/board/boardLayout";
import { SVG_MAX_BYTES } from "./limits";
import type { ExportPalette, ExportTheme } from "./palette";
import { type Box, type Scene, sceneBounds, sceneEdges } from "./scene";
import { hairlineId, sceneBody, sceneOutlined, svgDefs, type SvgOptions, usesXlink, wrapSvg } from "./svg";

/** A part drawn: its region, snap edges, and the image written round it for any options. */
export interface PublishDrawn {
  /** The part's region, in the source's units: the crop starts as this. */
  bounds: Box;
  edges: { xs: number[]; ys: number[] };
  /** The image's size in UTF-8 bytes for `opts`, without writing it. */
  bytes(opts: SvgOptions): number;
  /** The image; empty of drawing when `tooLarge`. */
  svg(opts: SvgOptions): string;
  /** Past `SVG_MAX_BYTES`: nothing is kept, and Copy and Save as are off (Decision 10). */
  tooLarge: boolean;
  /** How many frames the drawing holds, on a board; the Frame titles switch shows only when it is above 0. */
  frames?: number;
}

/** A source's words (Decision 14): the part label, why an off part is off, and the limit notes. */
export interface PublishNotes {
  partLabel: string;
  /** By part value. */
  offReason: Record<string, string>;
  scaleLimited(n: number): string;
  pngOff: string;
  tooLarge: string;
  /** What the source leaves out and counts, or null. */
  leftOut: string | null;
}

export interface PublishSource {
  parts: { value: string; label: string; disabled?: boolean }[];
  initial: string;
  /** The Frame titles switch's start; null hides it. */
  titles: boolean | null;
  /** The theme the source's icons are inked for; the dialog waits for the source of the theme it shows. */
  inkedFor?: ExportTheme;
  notes: PublishNotes;
  draw(part: string, palette: ExportPalette, titles: boolean): PublishDrawn;
}

/**
 * A drawing of `body` and `defs` round `bounds`: the head is written per options (`wrapSvg`), the body once. Past the
 * cap the body is dropped at once, so a refusal never holds a near-cap string (ADR 0003).
 */
export function publishDrawn(d: {
  bounds: Box;
  body: string;
  defs: string;
  /** The size of body and defs in UTF-8 bytes. */
  bytes: number;
  edges: { xs: number[]; ys: number[] };
  palette: ExportPalette;
  textScale?: number;
  tooLarge?: boolean;
  frames?: number;
}): PublishDrawn {
  const { bounds, edges, palette, textScale = 1, frames } = d;
  const tooLarge = d.tooLarge ?? false;
  const body = tooLarge ? "" : d.body;
  const defs = tooLarge ? "" : d.defs;
  const size = d.bytes;
  // Read once, so the size said and the image written declare the xlink namespace alike.
  const xlink = usesXlink(body);
  const drawn: PublishDrawn = {
    bounds,
    edges,
    tooLarge,
    bytes: (opts) => utf8Length(wrapSvg("", "", bounds, palette, opts, textScale, xlink)) + size,
    svg: (opts) => wrapSvg(defs, body, bounds, palette, opts, textScale, xlink),
  };
  if (frames !== undefined) drawn.frames = frames;
  return drawn;
}

/** The diagram column of Decision 14: never "frame" (I3). */
export const DIAGRAM_NOTES: PublishNotes = {
  partLabel: "Part of the diagram",
  offReason: { selected: "Select nodes to publish them." },
  scaleLimited: (n) => `Scale is limited to ${n}x for this drawing.`,
  pngOff: "This drawing is too large for PNG. Save as SVG, or publish the selected nodes.",
  tooLarge: "This drawing is too large to publish as one image. Publish the selected nodes.",
  leftOut: null,
};

/**
 * One diagram's scene as a source, with today's parts: Whole diagram, What's on screen, and Selected nodes, off when
 * no selected node is drawn. Output is `sceneToSvg`'s, byte for byte.
 */
export function sceneSource(scene: Scene, selected: string[], onScreen: Box): PublishSource {
  // Only selected nodes the scene draws count: one selected in the text but not yet placed is not in it.
  const drawnIds = new Set(scene.nodes.map((n) => n.id));
  const chosen = selected.filter((id) => drawnIds.has(id));
  /** The body of the latest palette drawn, kept for the other parts; a new palette replaces it. */
  let made: { palette: ExportPalette; body: string; defs: string; bytes: number; tooLarge: boolean; edges: { xs: number[]; ys: number[] } } | null = null;
  return {
    parts: [
      { value: "whole", label: "Whole diagram" },
      { value: "screen", label: "What's on screen" },
      { value: "selected", label: "Selected nodes", disabled: chosen.length === 0 },
    ],
    initial: "whole",
    titles: null,
    notes: DIAGRAM_NOTES,
    draw(part, palette) {
      const bounds = part === "screen" ? onScreen : part === "selected" && chosen.length > 0 ? sceneBounds(scene, chosen) : sceneBounds(scene);
      // Only the region differs between parts: every part of one palette shares one body string (ADR 0003).
      if (made?.palette !== palette) {
        const defs = svgDefs(palette, { hairline: sceneOutlined(scene, palette) ? hairlineId() : null, icons: new Map() });
        const body = sceneBody(scene, palette);
        const bytes = utf8Length(body) + utf8Length(defs);
        const tooLarge = bytes > SVG_MAX_BYTES;
        made = { palette, body: tooLarge ? "" : body, defs: tooLarge ? "" : defs, bytes, tooLarge, edges: sceneEdges(scene) };
      }
      const m = made;
      return publishDrawn({ bounds, body: m.body, defs: m.defs, bytes: m.bytes, edges: m.edges, palette, textScale: scene.textScale ?? 1, tooLarge: m.tooLarge });
    },
  };
}
