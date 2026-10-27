import { afterAll, afterEach, describe, expect, it } from "vitest";
import { exportPalette } from "../../../diagram/export/palette";
import { KIND_HEAD } from "../chips";
import { SHELF_KINDS } from "./kinds";
import { matchRank, searchKinds, searchTemplates } from "./search";
import { boardPreviewUrls, previewCacheSize, previewStringsHeld } from "./preview";
import { BOARD_TEMPLATES, SINGLE_TEMPLATES } from "./templates";

/** Gives each theme class its own tokens, which the stylesheet does in the app. */
function themeStyles() {
  const style = document.createElement("style");
  const vars = (tint: string) =>
    ["--c-bg-surface", "--c-bg-canvas", "--c-text", "--c-text-subtle", "--c-border", "--c-syn-type", "--c-syn-keyword", "--c-group-teal", "--c-group-teal-tint"]
      .map((v, i) => `${v}:#${tint}${i}${i}${i}${i}`)
      .join(";");
  style.textContent = `.theme-light{${vars("a")}}.theme-dark{${vars("d")}}`;
  document.head.appendChild(style);
  return style;
}

describe("catalog search", () => {
  it("an_empty_query_lists_everything_in_order", () => {
    expect(searchKinds("")).toEqual(SHELF_KINDS);
    expect(searchKinds("   ")).toEqual(SHELF_KINDS);
    const all = searchTemplates("", "all");
    expect(all.boards).toEqual(BOARD_TEMPLATES);
    expect(all.singles).toEqual(SINGLE_TEMPLATES);
  });

  it("name_starts_rank_first", () => {
    expect(matchRank("sequence calls", "seq")).toBe(0);
    expect(matchRank("user sequence", "seq")).toBe(1);
    expect(matchRank("consequence", "seq")).toBe(2);
    expect(matchRank("flow", "x")).toBe(-1);
    const found = searchKinds("s");
    const first = found.findIndex((k) => !KIND_HEAD[k].name.toLowerCase().startsWith("s"));
    const lastStart = found.map((k) => KIND_HEAD[k].name.toLowerCase().startsWith("s")).lastIndexOf(true);
    expect(first === -1 || lastStart < first).toBe(true);
  });

  it("erd_finds_the_er_kind_and_er_templates", () => {
    expect(searchKinds("erd")).toContain("er");
    const r = searchTemplates("erd", "all");
    expect(r.singles.length).toBeGreaterThan(0);
    expect(r.singles.every((s) => s.kind === "er")).toBe(true);
  });

  it("a_board_is_found_by_a_frame_title", () => {
    const r = searchTemplates("triage", "all");
    expect(r.boards.map((b) => b.name)).toEqual(["Support desk"]);
    expect(r.singles.map((t) => t.name)).toContain("Incident triage");
  });

  it("filters_pick_kinds_and_boards", () => {
    const boards = searchTemplates("", "boards");
    expect(boards.boards).toEqual(BOARD_TEMPLATES);
    expect(boards.singles).toEqual([]);
    for (const kind of ["er", "flow", "cloud", "sequence"] as const) {
      const r = searchTemplates("", kind);
      expect(r.boards).toEqual([]);
      expect(r.singles).toEqual(SINGLE_TEMPLATES.filter((s) => s.kind === kind));
      expect(r.singles.length).toBeGreaterThan(0);
    }
  });
});

describe("catalog shape and combined search", () => {
  it("every_frame_starts_with_a_diagram_header", () => {
    for (const b of BOARD_TEMPLATES) for (const f of b.frames) expect(f, b.name).toMatch(/^diagram \w+ "[^"]+"/);
    for (const t of SINGLE_TEMPLATES) expect(t.text, t.name).toMatch(/^diagram \w+ "[^"]+"/);
  });

  it("a_filter_and_a_query_combine", () => {
    const boards = searchTemplates("triage", "boards");
    expect(boards.boards.map((b) => b.name)).toEqual(["Support desk"]);
    expect(boards.singles).toEqual([]);
    const flow = searchTemplates("triage", "flow");
    expect(flow.boards).toEqual([]);
    expect(flow.singles.every((s) => s.kind === "flow")).toBe(true);
    const er = searchTemplates("erd", "flow");
    expect(er.singles).toEqual([]);
  });
});

describe("board previews", () => {
  const style = themeStyles();
  afterAll(() => style.remove());
  afterEach(() => boardPreviewUrls(BOARD_TEMPLATES[0].id, "light"));
  /** A preview URL's SVG markup. */
  const svgOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

  it("previews_draw_each_frame_once_per_theme", () => {
    const b = BOARD_TEMPLATES[0];
    const a = boardPreviewUrls(b.id, "light");
    expect(a).toHaveLength(b.frames.length);
    expect(a.every((url) => url.startsWith("data:image/svg+xml") && svgOf(url).startsWith("<svg"))).toBe(true);
    expect(boardPreviewUrls(b.id, "light")).toBe(a);
    const dark = boardPreviewUrls(b.id, "dark");
    expect(dark).not.toBe(a);
    expect(previewCacheSize()).toBe(1);
    expect(boardPreviewUrls(b.id, "dark")).toBe(dark);
    expect(boardPreviewUrls(b.id, "light")).not.toBe(a);
  });

  it("a_preview_uses_its_themes_palette", () => {
    const id = BOARD_TEMPLATES[0].id;
    const light = boardPreviewUrls(id, "light").map(svgOf).join("");
    const dark = boardPreviewUrls(id, "dark").map(svgOf).join("");
    const colour = exportPalette("dark").border;
    expect(colour).toMatch(/^#d/);
    expect(dark).toContain(colour);
    expect(light).not.toContain(colour);
  });

  it("the_cache_keeps_one_string_per_frame", () => {
    // The URLs only: the SVG markup they encode is not kept beside them (final review, Minor 5).
    for (const b of BOARD_TEMPLATES) boardPreviewUrls(b.id, "dark");
    expect(previewStringsHeld()).toBe(BOARD_TEMPLATES.reduce((n, b) => n + b.frames.length, 0));
  });
});
