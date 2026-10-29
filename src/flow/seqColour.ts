// The colours a sequence draws, readable in both themes. A participant's line colour draws its
// head and foot outline, its lifeline and its activation bars, over a tint of that colour; a block (a sequence
// frame) draws an opaque wash, an outline and a side tab. Presets and kind tokens are pinned by tests; a custom
// colour is stepped per theme until each check holds, the same way on the canvas (CSS variables) and in Publish (hex).
import type { CSSProperties } from "react";
import type { ExportPalette } from "../diagram/export/palette";
import { NODE_TOKENS } from "../diagram/types";
import { mixHex } from "../lang/flow/colours";
import { FAINT, ICON_BG, ICON_INK, type IconTheme, contrastRatio, iconOutline, logoHex } from "./icons";
import { COLOUR_TOKENS, type DrawnColour, type PaletteName, presetOf } from "./palette";

/** How much of a participant's colour tints its head, foot and activation bars, over `--c-bg-surface`. */
export const STRONG_TINT = 0.34;
/** How much of a block's colour tints its wash, over `--c-bg-canvas`. */
export const WASH = 0.07;

/** `--c-bg-surface` in each theme (tokens.css; a test keeps them equal). */
export const SEQ_SURFACE = { light: "#fffbeb", dark: "#282a36" } as const;

/** What a custom colour is checked against in each theme: the surface, the canvas and the text colour. */
export const SEQ_THEME = {
  light: { surface: SEQ_SURFACE.light, canvas: ICON_BG.light, text: ICON_INK.light },
  dark: { surface: SEQ_SURFACE.dark, canvas: ICON_BG.dark, text: ICON_INK.dark },
} as const;

/** A sequence node that takes a colour of its own. */
export type SeqWho = "participant" | "actor";

/**
 * The line colour of each preset (its stroke token) and of each kind with no colour (its kind's stroke token), in
 * each theme (tokens.css; a test keeps them equal). For logo checks and tests; the canvas reads the tokens.
 */
export const SEQ_LINES: Record<"light" | "dark", Record<PaletteName | SeqWho, string>> = {
  light: {
    accent: "#5a41bf",
    info: "#02618a",
    success: "#14710a",
    warning: "#6e5a0d",
    danger: "#b02f20",
    muted: "#605a40",
    participant: "#478cc4",
    actor: "#868686",
  },
  dark: {
    accent: "#c9a6ff",
    info: "#8be9fd",
    success: "#50fa7b",
    warning: "#f1fa8c",
    danger: "#ff9494",
    muted: "#aeb1c7",
    participant: "#599fd8",
    actor: "#989898",
  },
};

const LINE_MIN = 3;
const TEXT_MIN = 4.5;

/** A custom colour's line: `hex` when it reaches 3:1 on `canvas`, else the first step toward `text` that does. */
export function seqLine(hex: string, canvas: string, text: string): string {
  if (contrastRatio(hex, canvas) >= LINE_MIN) return hex;
  let line = text;
  for (const a of [0.75, 0.5, 0.25, 0]) {
    line = mixHex(hex, text, a);
    if (contrastRatio(line, canvas) >= LINE_MIN) break;
  }
  return line;
}

/** How much of `line` tints a participant's fill: the first amount that keeps `text` at 4.5:1 (0.18 always does). */
export function seqFillAmount(line: string, surface: string, text: string): 0.34 | 0.24 | 0.18 {
  for (const a of [STRONG_TINT, 0.24] as const) if (contrastRatio(text, mixHex(line, surface, a)) >= TEXT_MIN) return a;
  return 0.18;
}

/**
 * A block's side tab: from the line colour, stepped toward `text` until the better of `surface` and
 * `text` reaches 4.5:1 on it and it reaches 3:1 on the block's wash; that better one is the tab's ink.
 */
export function seqTab(line: string, surface: string, canvas: string, text: string): { fill: string; ink: string } {
  const wash = mixHex(line, canvas, WASH);
  let tab = { fill: text, ink: surface };
  for (const a of [1, 0.75, 0.5, 0.25, 0]) {
    const fill = mixHex(line, text, a);
    const ink = contrastRatio(surface, fill) >= contrastRatio(text, fill) ? surface : text;
    tab = { fill, ink };
    if (contrastRatio(ink, fill) >= TEXT_MIN && contrastRatio(fill, wash) >= LINE_MIN) break;
  }
  return tab;
}

/** The stroke token a preset, or a node with no colour, draws its line in. */
function lineToken(c: DrawnColour | undefined, who: SeqWho | "block"): string {
  const p = presetOf(c);
  if (p) return COLOUR_TOKENS[p].stroke;
  return who === "block" ? COLOUR_TOKENS.muted.stroke : NODE_TOKENS[who].stroke;
}

/** A custom colour's line, fill amount and tab in one theme. */
function customIn(hex: string, t: { surface: string; canvas: string; text: string }) {
  const line = seqLine(hex, t.canvas, t.text);
  return { line, amount: seqFillAmount(line, t.surface, t.text), tab: seqTab(line, t.surface, t.canvas, t.text) };
}

/** Most colour and kind pairs `seqColourVars` keeps; past it the cache starts again (custom colours come and go). */
export const SEQ_VARS_MAX = 256;
const varsMade = new Map<string, CSSProperties>();

/** How many variables objects `seqColourVars` keeps (tests). */
export const seqColourVarsCacheSize = (): number => varsMade.size;

/**
 * The custom properties `.fkind-seq` (flow-seq.css) reads. A preset or no colour: `--seq-col` as its stroke token.
 * A custom colour: the adjusted line and fill amount per theme, and for a block its tab and the tab's ink. Made once a
 * colour and kind and shared, frozen: every lane, bar and number circle of a colour takes the same one.
 */
export function seqColourVars(c: DrawnColour | undefined, who: SeqWho | "block"): CSSProperties {
  const key = `${who}\u0000${c ?? ""}`;
  let vars = varsMade.get(key);
  if (!vars) {
    if (varsMade.size >= SEQ_VARS_MAX) varsMade.clear();
    vars = Object.freeze(makeVars(c, who));
    varsMade.set(key, vars);
  }
  return vars;
}

function makeVars(c: DrawnColour | undefined, who: SeqWho | "block"): CSSProperties {
  if (c === undefined || presetOf(c)) return { "--seq-col": `var(${lineToken(c, who)})` } as CSSProperties;
  const vars: Record<string, string> = {};
  for (const t of ["light", "dark"] as const) {
    const { line, amount, tab } = customIn(c, SEQ_THEME[t]);
    vars[`--seq-col-${t}`] = line;
    vars[`--seq-amt-${t}`] = `${Math.round(amount * 100)}%`;
    if (who === "block") {
      vars[`--seq-tab-${t}`] = tab.fill;
      vars[`--seq-ink-${t}`] = tab.ink;
    }
  }
  return vars as CSSProperties;
}

/** The concrete colours Publish draws for a sequence colour in palette `p`, the same as `seqColourVars` on the canvas. */
export function seqColours(
  p: ExportPalette,
  c: DrawnColour | undefined,
  who: SeqWho | "block",
): { line: string; fill: string; wash: string; tab: string; tabInk: string } {
  const wash = (line: string) => mixHex(line, p.canvas, WASH);
  if (c !== undefined && !presetOf(c)) {
    const { line, amount, tab } = customIn(c, p);
    return { line, fill: mixHex(line, p.surface, amount), wash: wash(line), tab: tab.fill, tabInk: tab.ink };
  }
  const preset = presetOf(c);
  const kindLine = who === "block" ? p.subtle : p.nodes[who].stroke;
  const line = preset && p.colours ? p.colours[preset].stroke : kindLine;
  return { line, fill: mixHex(line, p.surface, STRONG_TINT), wash: wash(line), tab: line, tabInk: p.surface };
}

/**
 * Whether participant icon `name` draws with the icon hairline: when the canvas asks for it, or when the
 * logo's own colour is under 1.5:1 on the participant's `fill`.
 */
export function participantIconOutline(name: string, fill: string, t: IconTheme): boolean {
  if (iconOutline(name, t)) return true;
  const hex = logoHex(name);
  return hex !== null && contrastRatio(hex, fill) < FAINT;
}
