// Diagram step 11 (board DiagramColourLabels, ADR 0019): the six colours a shape, group or line can take, each a
// trio of theme tokens (ADR 0008, PALETTE_TOKENS), so dark, light and Publish each draw it from their own theme.
import type { CSSProperties } from "react";
import { PALETTE_TOKENS } from "../diagram/types";
import { readColour } from "../lang/flow/colours";
import { PALETTE, type PaletteName } from "../lang/flow/model";

export { PALETTE, type PaletteName };

/** Fill, border (also a line and a group title) and words, as token names. */
export const COLOUR_TOKENS: Record<PaletteName, { fill: string; stroke: string; text: string }> = PALETTE_TOKENS;

/** Each colour's name in a menu and what it means (the board's Colour submenu). */
export const COLOUR_INFO: Record<PaletteName, { label: string; means: string }> = {
  accent: { label: "Accent", means: "The main path: what to read first" },
  info: { label: "Info", means: "A reference: outside system, lookup" },
  success: { label: "Success", means: "Done or OK: the happy path" },
  warning: { label: "Warning", means: "Needs a look: slow, manual, waiting" },
  danger: { label: "Danger", means: "Failure, error, data at risk" },
  muted: { label: "Muted", means: "Out of scope, later, legacy" },
};

/** What a `color:` draws: a preset's tokens, or a custom colour's hex (`#rrggbb`). */
export type DrawnColour = PaletteName | `#${string}`;

/** The colour a `color:` value draws (a preset name, or the hex of a CSS name or hex), or undefined (the kind's own colours). */
export function drawnColour(value: string | undefined): DrawnColour | undefined {
  const c = readColour(value);
  if (!c) return undefined;
  return "preset" in c ? c.preset : (c.hex as DrawnColour);
}

/** The preset a drawn colour is, or undefined for a custom one. */
export const presetOf = (c: DrawnColour | undefined): PaletteName | undefined => (c !== undefined && c[0] !== "#" ? (c as PaletteName) : undefined);

/** The class a coloured group, line or swatch carries: `is-col`, and the preset's own for a preset. */
export const colourClass = (c: DrawnColour): string => (presetOf(c) ? `is-col is-col-${c}` : "is-col");

/** The stroke of a coloured line, as a CSS value. */
export const colourStroke = (c: DrawnColour): string => {
  const p = presetOf(c);
  return p ? `var(${COLOUR_TOKENS[p].stroke})` : c;
};

/** The outline and soft tint of a custom colour: its hex over the theme's surface; words stay the theme's text. */
const customFill = (hex: string) => `color-mix(in srgb, ${hex} 18%, var(--c-bg-surface))`;

/** A coloured shape's custom properties: its fill, its border and its words. */
export function colourStyle(c: DrawnColour): CSSProperties {
  const p = presetOf(c);
  if (!p) return { "--fnode-fill": customFill(c), "--fnode-stroke": c, color: "var(--c-text)" } as CSSProperties;
  const t = COLOUR_TOKENS[p];
  return { "--fnode-fill": `var(${t.fill})`, "--fnode-stroke": `var(${t.stroke})`, color: `var(${t.text})` } as CSSProperties;
}

/** The custom properties a coloured group area or line reads (`--col-fill`, `--col-edge`). */
export function colourVars(c: DrawnColour): CSSProperties {
  const p = presetOf(c);
  if (!p) return { "--col-fill": customFill(c), "--col-edge": c, "--col-words": "var(--c-text)" } as CSSProperties;
  const t = COLOUR_TOKENS[p];
  return { "--col-fill": `var(${t.fill})`, "--col-edge": `var(${t.stroke})`, "--col-words": `var(${t.text})` } as CSSProperties;
}
