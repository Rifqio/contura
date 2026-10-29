// Export colours are read from the tokens at export time, never written as literals (ADR 0008),
// so an image follows the theme the user picks in the Publish dialog, whatever the window shows.
import { mixHex } from "../../lang/flow/colours";
import type { SceneColour } from "./scene";
import { ICON_TILE_TOKEN, NODE_TOKENS, type NodeKind, PALETTE_TOKENS } from "../types";

export type ExportTheme = "light" | "dark";

export interface ExportPalette {
  surface: string;
  canvas: string;
  text: string;
  subtle: string;
  border: string;
  type: string;
  keyword: string;
  nodes: Record<NodeKind, { fill: string; stroke: string }>;
  /** The light tile behind a cloud service icon. */
  iconTile: string;
  /** A drawn diagram's group area: its edge and its tint. */
  group: string;
  groupTint: string;
  /** The dashed tile of an icon the pack does not have; a timeline's axis and a sequence frame's edge. */
  strongBorder: string;
  /** The tint of a sequence frame and a timeline section. */
  panel: string;
  /** Quieter words: a board frame's tab title, a Section's title and an icon sketch's title. */
  muted: string;
  /**
   * The faint words token (`--c-text-faint`): a frame picture's soft text bars draw in it at 45 percent, as the canvas's
   * far text does (flow-board.css).
   */
  faint: string;
  /** A far ER key row's mark (`--c-group-gold`, flow-board.css `--far-key`): a frame picture's far ER card draws it. */
  keyMark: string;
  /** The six palette colours (fill, border, words) a shape, group or line may take; uncoloured without them. */
  colours?: Record<keyof typeof PALETTE_TOKENS, { fill: string; stroke: string; text: string }>;
}

/** The fill, border and words a colour draws in this palette: a preset's own, or a custom hex as an outline over a soft tint. */
export function sceneColour(palette: ExportPalette, c: SceneColour): { fill: string; stroke: string; text: string } {
  if (c[0] === "#") return { fill: mixHex(c, palette.surface, 0.18), stroke: c, text: palette.text };
  return palette.colours?.[c as keyof typeof PALETTE_TOKENS] ?? { fill: palette.surface, stroke: palette.border, text: palette.text };
}

/** Reads the tokens from a hidden `.theme-light` or `.theme-dark` element, so a dark window can still export Alucard colours. */
export function exportPalette(theme: ExportTheme = "light"): ExportPalette {
  const probe = document.createElement("div");
  probe.className = `theme-${theme}`;
  probe.hidden = true;
  document.body.appendChild(probe);
  try {
    const css = getComputedStyle(probe);
    const read = (name: string) => css.getPropertyValue(name).trim();
    const nodes = Object.fromEntries(
      (Object.keys(NODE_TOKENS) as NodeKind[]).map((k) => [k, { fill: read(NODE_TOKENS[k].fill), stroke: read(NODE_TOKENS[k].stroke) }]),
    ) as ExportPalette["nodes"];
    return {
      surface: read("--c-bg-surface"),
      canvas: read("--c-bg-canvas"),
      text: read("--c-text"),
      subtle: read("--c-text-subtle"),
      border: read("--c-border"),
      type: read("--c-syn-type"),
      keyword: read("--c-syn-keyword"),
      nodes,
      iconTile: read(ICON_TILE_TOKEN),
      group: read("--c-group-teal"),
      groupTint: read("--c-group-teal-tint"),
      strongBorder: read("--c-border-strong"),
      panel: read("--c-bg-panel"),
      muted: read("--c-text-muted"),
      faint: read("--c-text-faint"),
      keyMark: read("--c-group-gold"),
      colours: Object.fromEntries(
        (Object.keys(PALETTE_TOKENS) as (keyof typeof PALETTE_TOKENS)[]).map((c) => [c, { fill: read(PALETTE_TOKENS[c].fill), stroke: read(PALETTE_TOKENS[c].stroke), text: read(PALETTE_TOKENS[c].text) }]),
      ) as NonNullable<ExportPalette["colours"]>,
    };
  } finally {
    probe.remove();
  }
}
