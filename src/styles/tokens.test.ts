import { expect, test } from "vitest";
import tokensCss from "./tokens.css?raw";
import designNext from "../../DESIGN-NEXT.md?raw";

/** The DN token families that the theme blocks must carry exactly. */
const DN_NAME = /^--(c-|db-|syn-|on-accent|win-)/;

type Decls = Map<string, string>;

function declarations(body: string): Decls {
  const out: Decls = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (DN_NAME.test(m[1])) out.set(m[1], m[2].trim());
  }
  return out;
}

/** The text between the `{` after `start` and its matching `}`. */
function blockAfter(text: string, start: string): string {
  const at = text.indexOf(start);
  if (at < 0) throw new Error(`no block starting with ${start}`);
  const open = text.indexOf("{", at + start.length - 1);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unclosed block ${start}`);
}

/** The css code block under a DN heading. */
function dnBlock(heading: string): Decls {
  const at = designNext.indexOf(heading);
  if (at < 0) throw new Error(`no heading ${heading}`);
  const fence = designNext.indexOf("```css", at);
  const end = designNext.indexOf("```", fence + 6);
  return declarations(designNext.slice(fence + 6, end));
}

const css = tokensCss.replace(/\/\*[\s\S]*?\*\//g, "");
const light = () => declarations(blockAfter(css, ":root, .theme-light {"));
const DARK_OPEN = ':root[data-theme="dark"], .theme-dark {';
const dark = () => declarations(blockAfter(css, DARK_OPEN));
const media = () =>
  declarations(
    blockAfter(blockAfter(css, "@media (prefers-color-scheme: dark) {"), ':root:not([data-theme="light"]) {'),
  );

test("light_and_dark_blocks_equal_dn_section_3", () => {
  const dnLight = dnBlock("### 3.2 Light: Alucard");
  const dnDark = dnBlock("### 3.3 Dark: Dracula");
  expect(dnLight.size).toBe(98);
  // Dracula alone carries the brighter comment colour (PR33).
  expect(dnDark.size).toBe(99);
  expect(Object.fromEntries(light())).toEqual(Object.fromEntries(dnLight));
  expect(Object.fromEntries(dark())).toEqual(Object.fromEntries(dnDark));
});

test("media_block_equals_dark_block", () => {
  expect(Object.fromEntries(media())).toEqual(Object.fromEntries(dark()));
  expect(blockAfter(blockAfter(css, "@media (prefers-color-scheme: dark) {"), ":root:not(")).toMatch(
    /color-scheme:\s*dark/,
  );
});

test("light_and_dark_hold_the_same_names", () => {
  const darkOnly = (n: string) => n !== "--c-syn-comment-bright";
  expect([...light().keys()].sort()).toEqual([...dark().keys()].filter(darkOnly).sort());
  expect(blockAfter(css, ":root, .theme-light {")).toMatch(/color-scheme:\s*light/);
  expect(blockAfter(css, DARK_OPEN)).toMatch(/color-scheme:\s*dark/);
});

test("dark_block_answers_to_theme_dark", () => {
  // The Settings theme cards draw Dracula inside an Alucard window, and the other way round (PR14).
  expect(css).toContain(DARK_OPEN);
  expect(css).toContain(":root, .theme-light {");
});

test("brighter_comment_token_matches_dn", () => {
  expect(dnBlock("### 3.3 Dark: Dracula").get("--c-syn-comment-bright")).toBe("#939fcb");
  expect(dark().get("--c-syn-comment-bright")).toBe("#939fcb");
  expect(media().get("--c-syn-comment-bright")).toBe("#939fcb");
  expect(light().has("--c-syn-comment-bright")).toBe(false);
  // The swap lives only under Dracula: the chosen theme, Follow Windows on a dark Windows and the dark cards.
  const swaps = [...css.matchAll(/([^{}]*\[data-brighter-comments\][^{}]*)\{([^{}]*)\}/g)];
  expect(swaps.length).toBeGreaterThan(0);
  for (const [, selector, body] of swaps) {
    expect(body).toMatch(/--c-syn-comment:\s*var\(--c-syn-comment-bright\)/);
    for (const part of selector.split(",").map((x) => x.trim())) {
      expect(part).toMatch(/data-theme="dark"|:not\(\[data-theme="light"\]\)|\.theme-dark/);
    }
  }
});

/** Relative luminance of a #rrggbb colour (WCAG 2.x). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("node_icon_tile_is_light_in_both_themes", () => {
  // Lucide and Simple Icons draw black inside an <img>, so a service tile stays light under Dracula too.
  for (const block of [light(), dark(), media()]) {
    const tile = block.get("--c-node-icon-tile");
    expect(tile).toMatch(/^#[0-9a-f]{6}$/);
    expect(luminance(tile as string)).toBeGreaterThan(0.85);
  }
});

// Item 49: tinted grid rows (new, edited, deleted) keep their column dividers in dark mode; light stays as it was.
test("tinted_grid_rows_have_a_divider_token_that_shows_in_dark_and_matches_light", () => {
  const all = (body: string) => new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const lightValue = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => all(m[1]).get("--grid-tint-divider")).find(Boolean);
  expect(lightValue).toBe("color-mix(in srgb, var(--c-border) 60%, transparent)");
  const darkValue = all(blockAfter(css, DARK_OPEN)).get("--grid-tint-divider");
  const mediaValue = all(blockAfter(blockAfter(css, "@media (prefers-color-scheme: dark) {"), ':root:not([data-theme="light"]) {')).get("--grid-tint-divider");
  expect(darkValue).toBeTruthy();
  expect(mediaValue).toBe(darkValue);
  // Drawn from the strong border, not the faint one the tint swallows.
  expect(darkValue).toContain("var(--c-border-strong)");
});

// Item 43: Schema Compare colours its differences like Git decorations, with the board's values in both themes.
test("diff_status_tokens_are_set_in_light_dark_and_follow_windows", () => {
  const all = (body: string) => new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const names = ["--diff-added", "--diff-added-tint", "--diff-removed", "--diff-removed-tint", "--diff-changed", "--diff-changed-tint"];
  const pick = (body: string) => Object.fromEntries(names.map((n) => [n, all(body).get(n)]));
  expect(pick(blockAfter(css, ":root, .theme-light {"))).toEqual({
    "--diff-added": "#0f5f08",
    "--diff-added-tint": "#e1ecc9",
    "--diff-removed": "#9c2717",
    "--diff-removed-tint": "#fbe3dc",
    "--diff-changed": "#7a4600",
    "--diff-changed-tint": "#f8e1c9",
  });
  const darkValues = pick(blockAfter(css, DARK_OPEN));
  expect(darkValues).toEqual({
    "--diff-added": "#50fa7b",
    "--diff-added-tint": "#233b2c",
    "--diff-removed": "#ffa0a0",
    "--diff-removed-tint": "#43272e",
    "--diff-changed": "#ffb86c",
    "--diff-changed-tint": "#45372b",
  });
  expect(pick(blockAfter(blockAfter(css, "@media (prefers-color-scheme: dark) {"), ':root:not([data-theme="light"]) {'))).toEqual(darkValues);
});

// Item 48: the tab divider and the soft hover fill, from the board, in both themes.
test("tab_divider_and_hover_fill_tokens_in_light_dark_and_follow_windows", () => {
  const all = (body: string) => new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const pick = (body: string) => ({ divider: all(body).get("--tab-divider"), hover: all(body).get("--tab-hover-fill") });
  expect(pick(blockAfter(css, ":root, .theme-light {"))).toEqual({ divider: "#bdb9a8", hover: "#e2deca" });
  expect(pick(blockAfter(css, DARK_OPEN))).toEqual({ divider: "#44475a", hover: "#2a2c38" });
  expect(pick(blockAfter(blockAfter(css, "@media (prefers-color-scheme: dark) {"), ':root:not([data-theme="light"]) {'))).toEqual({ divider: "#44475a", hover: "#2a2c38" });
});

// Item 39: the row separators of the Visual Query's bordered grids, from board B1, in both themes.
test("panel_rowline_token_in_light_dark_and_follow_windows", () => {
  const get = (body: string) => new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])).get("--panel-rowline");
  expect(get(blockAfter(css, ":root, .theme-light {"))).toBe("#e6e2d2");
  expect(get(blockAfter(css, DARK_OPEN))).toBe("#323443");
  expect(get(blockAfter(blockAfter(css, "@media (prefers-color-scheme: dark) {"), ':root:not([data-theme="light"]) {'))).toBe("#323443");
});
