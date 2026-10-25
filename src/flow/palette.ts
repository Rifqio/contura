// Diagram step 11 (board DiagramColourLabels, ADR 0019): the six colours a shape, group or line can take, each a
// trio of theme tokens (ADR 0008, PALETTE_TOKENS), so dark, light and Publish each draw it from their own theme.
import type { CSSProperties } from "react";
import { PALETTE_TOKENS } from "../diagram/types";
import { isPaletteName, PALETTE, type PaletteName } from "../lang/flow/model";

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

/** The palette colour a `color:` value draws, or undefined (a value off the palette draws the kind's own colours). */
export const drawnColour = (value: string | undefined): PaletteName | undefined => (isPaletteName(value) ? value : undefined);

/** A coloured shape's custom properties: its fill, its border and its words. */
export function colourStyle(c: PaletteName): CSSProperties {
  const t = COLOUR_TOKENS[c];
  return { "--fnode-fill": `var(${t.fill})`, "--fnode-stroke": `var(${t.stroke})`, color: `var(${t.text})` } as CSSProperties;
}

/** The custom properties a coloured group area or line reads (`--col-fill`, `--col-edge`). */
export function colourVars(c: PaletteName): CSSProperties {
  const t = COLOUR_TOKENS[c];
  return { "--col-fill": `var(${t.fill})`, "--col-edge": `var(${t.stroke})`, "--col-words": `var(${t.text})` } as CSSProperties;
}
