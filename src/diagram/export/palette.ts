// Export colours are read from the tokens at export time, never written as literals (ADR 0008),
// so an image follows the theme the user picks in the Publish dialog, whatever the window shows.
import { NODE_TOKENS, type NodeKind } from "../types";

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
    };
  } finally {
    probe.remove();
  }
}
