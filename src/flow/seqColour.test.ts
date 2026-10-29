import { beforeEach, expect, test, vi } from "vitest";
import type { CSSProperties } from "react";
import tokensCss from "../styles/tokens.css?raw";
import { routeInvoke } from "../test/invoke";
import type { ExportPalette } from "../diagram/export/palette";
import { mixHex } from "../lang/flow/colours";
import { PALETTE, type DrawnColour } from "./palette";
import { ICON_BG, ICON_INK, contrastRatio, loadIcon, logoHex, resetIcons } from "./icons";
import {
  SEQ_LINES,
  SEQ_SURFACE,
  SEQ_THEME,
  STRONG_TINT,
  WASH,
  type SeqWho,
  participantIconOutline,
  SEQ_VARS_MAX,
  seqColourVars,
  seqColourVarsCacheSize,
  seqColours,
  seqFillAmount,
  seqLine,
  seqTab,
} from "./seqColour";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

type Theme = "light" | "dark";
const THEMES: Theme[] = ["light", "dark"];

/** The body of the first block in tokens.css that opens with `head`. */
function block(head: string): string {
  const at = tokensCss.indexOf(`${head} {`);
  expect(at).toBeGreaterThanOrEqual(0);
  return tokensCss.slice(at, tokensCss.indexOf("}", at));
}
const BLOCKS: Record<Theme, string> = { light: block(":root, .theme-light"), dark: block(':root[data-theme="dark"], .theme-dark') };

/** Token `name`'s hex in theme `t`. */
function token(t: Theme, name: string): string {
  const m = BLOCKS[t].match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, "i"));
  expect(m, `${name} in ${t}`).not.toBeNull();
  return m![1].toLowerCase();
}

const STROKES: Record<string, string> = {
  accent: "--c-accent-text",
  info: "--c-info-text",
  success: "--c-success-text",
  warning: "--c-warning-text",
  danger: "--c-danger-text",
  muted: "--c-text-subtle",
  participant: "--c-node-table-stroke",
  actor: "--c-node-external-stroke",
};

test("seq_constants_match_tokens", () => {
  for (const t of THEMES) {
    expect(SEQ_SURFACE[t]).toBe(token(t, "--c-bg-surface"));
    expect(SEQ_THEME[t]).toEqual({ surface: SEQ_SURFACE[t], canvas: ICON_BG[t], text: ICON_INK[t] });
    expect(Object.keys(SEQ_LINES[t]).sort()).toEqual(Object.keys(STROKES).sort());
    for (const [k, name] of Object.entries(STROKES)) expect(SEQ_LINES[t][k as keyof (typeof SEQ_LINES)[Theme]], k).toBe(token(t, name));
  }
  expect(STRONG_TINT).toBe(0.34);
  expect(WASH).toBe(0.07);
});

test("participant_colours_pass_in_both_themes", () => {
  for (const t of THEMES) {
    const { surface, canvas, text } = SEQ_THEME[t];
    for (const k of [...PALETTE, "participant", "actor"] as const) {
      const line = SEQ_LINES[t][k];
      const fill = mixHex(line, surface, STRONG_TINT);
      expect(contrastRatio(text, fill), `${t} ${k} name`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(line, canvas), `${t} ${k} line`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(ICON_INK[t], fill), `${t} ${k} icon`).toBeGreaterThanOrEqual(3);
    }
  }
});

test("block_colours_pass_in_both_themes", () => {
  for (const t of THEMES) {
    const { surface, canvas, text } = SEQ_THEME[t];
    const subtle = token(t, "--c-text-subtle");
    for (const k of PALETTE) {
      const line = SEQ_LINES[t][k];
      const wash = mixHex(line, canvas, WASH);
      expect(contrastRatio(surface, line), `${t} ${k} tab ink`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(line, wash), `${t} ${k} tab on wash`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(subtle, wash), `${t} ${k} caption`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(text, wash), `${t} ${k} label`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

/** Every check Review Focus 2 asks of custom colour `hex` in theme `t`. */
function customChecks(t: Theme, hex: string) {
  const { surface, canvas, text } = SEQ_THEME[t];
  const subtle = token(t, "--c-text-subtle");
  const line = seqLine(hex, canvas, text);
  const amt = seqFillAmount(line, surface, text);
  const tab = seqTab(line, surface, canvas, text);
  const wash = mixHex(line, canvas, WASH);
  return {
    line,
    amt,
    tab,
    ratios: {
      line: contrastRatio(line, canvas),
      name: contrastRatio(text, mixHex(line, surface, amt)),
      tabInk: contrastRatio(tab.ink, tab.fill),
      tabOnWash: contrastRatio(tab.fill, wash),
      caption: contrastRatio(subtle, wash),
      label: contrastRatio(text, wash),
    },
  };
}

function expectReadable(t: Theme, hex: string) {
  const { ratios: r } = customChecks(t, hex);
  const at = `${t} ${hex}`;
  expect(r.line, `${at} line`).toBeGreaterThanOrEqual(3);
  expect(r.name, `${at} name`).toBeGreaterThanOrEqual(4.5);
  expect(r.tabInk, `${at} tab ink`).toBeGreaterThanOrEqual(4.5);
  expect(r.tabOnWash, `${at} tab on wash`).toBeGreaterThanOrEqual(3);
  expect(r.caption, `${at} caption`).toBeGreaterThanOrEqual(4.5);
  expect(r.label, `${at} label`).toBeGreaterThanOrEqual(4.5);
}

test("extreme_custom_colours_stay_readable_in_both_themes", () => {
  for (const t of THEMES) for (const hex of ["#ffffff", "#ffff00", "#000000", "#00008b", "#808080"]) expectReadable(t, hex);

  const rows: [Theme, string, string, string, string][] = [
    ["light", "#808080", "#808080", "#686868", "#fffbeb"],
    ["dark", "#000000", "#7c7c79", "#9b9b97", "#282a36"],
    ["dark", "#00008b", "#7c7cbf", "#9b9bcc", "#282a36"],
    ["dark", "#808080", "#808080", "#9e9e9d", "#282a36"],
  ];
  for (const [t, hex, line, fill, ink] of rows) {
    const got = customChecks(t, hex);
    expect([got.line, got.tab.fill, got.tab.ink], `${t} ${hex}`).toEqual([line, fill, ink]);
  }
  expect(seqFillAmount("#ffffff", SEQ_SURFACE.dark, ICON_INK.dark)).toBe(0.24);
});

test("every_custom_colour_finds_a_step", () => {
  // Decision 5's sweep: every colour at a 15 step, in both themes, passes without running out of steps.
  const steps = Array.from({ length: 18 }, (_, i) => (i * 15).toString(16).padStart(2, "0"));
  for (const t of THEMES)
    for (const r of steps)
      for (const g of steps)
        for (const b of steps) {
          const { ratios } = customChecks(t, `#${r}${g}${b}`);
          const worst = Math.min(ratios.line / 3, ratios.name / 4.5, ratios.tabInk / 4.5, ratios.tabOnWash / 3, ratios.caption / 4.5, ratios.label / 4.5);
          if (worst < 1) expectReadable(t, `#${r}${g}${b}`);
        }
});

/** A palette with only what the sequence reads, from SEQ_THEME and SEQ_LINES. */
function seqPalette(t: Theme, withColours = true): ExportPalette {
  const lines = SEQ_LINES[t];
  return {
    ...SEQ_THEME[t],
    subtle: lines.muted,
    muted: lines.muted,
    faint: "",
    keyMark: "",
    border: "",
    type: "",
    keyword: "",
    nodes: { participant: { fill: "", stroke: lines.participant }, actor: { fill: "", stroke: lines.actor } } as ExportPalette["nodes"],
    iconTile: "",
    group: "",
    groupTint: "",
    strongBorder: "",
    panel: "",
    colours: withColours ? (Object.fromEntries(PALETTE.map((p) => [p, { fill: "", stroke: lines[p], text: "" }])) as ExportPalette["colours"]) : undefined,
  };
}

/** What the CSS in flow-seq.css resolves `vars` to in theme `t`. */
function resolveVars(vars: CSSProperties, t: Theme) {
  const v = vars as Record<string, string | undefined>;
  const viaToken = (s: string | undefined) => {
    const m = s?.match(/^var\((--[a-z-]+)\)$/);
    return m ? token(t, m[1]) : s;
  };
  const line = v[`--seq-col-${t}`] ?? viaToken(v["--seq-col"]);
  const amt = parseFloat(v[`--seq-amt-${t}`] ?? "34%") / 100;
  return {
    line,
    fill: mixHex(line!, SEQ_SURFACE[t], amt),
    wash: mixHex(line!, ICON_BG[t], WASH),
    tab: v[`--seq-tab-${t}`] ?? line,
    tabInk: v[`--seq-ink-${t}`] ?? SEQ_SURFACE[t],
  };
}

test("vars_and_publish_agree", () => {
  const whos: (SeqWho | "block")[] = ["participant", "actor", "block"];
  const colours: (DrawnColour | undefined)[] = [undefined, "info", "warning", "#ff0000", "#808080", "#00008b", "#ffffff"];
  for (const t of THEMES)
    for (const who of whos)
      for (const c of colours) {
        const css = resolveVars(seqColourVars(c, who), t);
        const pub = seqColours(seqPalette(t), c, who);
        if (who === "block") expect(pub, `${t} ${who} ${c}`).toEqual(css);
        else expect({ ...pub, tab: css.tab, tabInk: css.tabInk }, `${t} ${who} ${c}`).toEqual(css);
      }
  // Presets fall back to the kind's own stroke when the palette has no colours.
  expect(seqColours(seqPalette("light", false), "info", "participant").line).toBe(SEQ_LINES.light.participant);
  expect(seqColours(seqPalette("light", false), "info", "actor").line).toBe(SEQ_LINES.light.actor);
  expect(seqColours(seqPalette("light", false), "info", "block").line).toBe(SEQ_LINES.light.muted);
  // A custom colour's percentage is a whole number, not 34.00000000000001%.
  expect((seqColourVars("#ff0000", "participant") as Record<string, string>)["--seq-amt-light"]).toBe("34%");
});

beforeEach(() => {
  resetIcons();
  routeInvoke({
    icon: () => `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
    icon_index: () => [
      { name: "database", set: "lucide", title: "database", licence: null },
      // A steel blue and a dark yellow that sink into the info and warning tints in Dark (under 1.5:1), not the muted one.
      { name: "brand-steel", set: "simple", title: "Steel", licence: null, aliasOf: null, hex: "#4682a0" },
      { name: "brand-mustard", set: "simple", title: "Mustard", licence: null, aliasOf: null, hex: "#8a8a1e" },
      { name: "brand-paper", set: "simple", title: "Paper", licence: null, aliasOf: null, hex: "#ffffff" },
    ],
  });
});

test("a_logo_is_outlined_against_the_participant_fill", async () => {
  expect(logoHex("brand-steel")).toBeNull();
  await loadIcon("database", "dark");
  expect(logoHex("brand-steel")).toBe("#4682a0");
  expect(logoHex("database")).toBeNull();

  const fill = (t: Theme, c: DrawnColour) => seqColours(seqPalette(t), c, "participant").fill;
  expect(participantIconOutline("brand-steel", fill("dark", "info"), "dark")).toBe(true);
  expect(participantIconOutline("brand-mustard", fill("dark", "warning"), "dark")).toBe(true);
  expect(participantIconOutline("brand-steel", fill("dark", "muted"), "dark")).toBe(false);
  expect(participantIconOutline("brand-mustard", fill("dark", "muted"), "dark")).toBe(false);
  // A pale logo on Light keeps Plan C's hairline whatever it sits on.
  expect(participantIconOutline("brand-paper", fill("light", "accent"), "light")).toBe(true);
  // A lucide icon has no colour of its own and is drawn in the theme ink.
  expect(participantIconOutline("database", fill("dark", "info"), "dark")).toBe(false);
});

test("seq_colour_vars_are_made_once_a_colour_and_kind", () => {
  // Plan E Task 9: every lane, bar, number circle and block of a colour shares one frozen variables object, so 2,000
  // lanes and 3,000 numbers make none per render; the cache is bounded, as custom colours come and go as they are typed.
  const whos: (SeqWho | "block")[] = ["participant", "actor", "block"];
  for (const who of whos)
    for (const c of [undefined, "info", "#ff0000"] as (DrawnColour | undefined)[]) {
      const a = seqColourVars(c, who);
      expect(seqColourVars(c, who), `${who} ${c}`).toBe(a);
      expect(Object.isFrozen(a), `${who} ${c}`).toBe(true);
    }
  expect(seqColourVars("info", "participant")).not.toBe(seqColourVars("info", "actor"));
  expect(seqColourVars("#ff0000", "participant")).not.toBe(seqColourVars("#ff0000", "block"));
  for (let i = 0; i < 2000; i++) seqColourVars(`#${i.toString(16).padStart(6, "0")}`, "participant");
  expect(seqColourVarsCacheSize()).toBeLessThanOrEqual(SEQ_VARS_MAX);
  // Still right after the cache was cleared.
  expect((seqColourVars("#ff0000", "participant") as Record<string, string>)["--seq-amt-light"]).toBe("34%");
});
