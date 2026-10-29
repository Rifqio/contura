import { afterEach, expect, test } from "vitest";
import { KFC_MODEL } from "../../lang/dbml/fixtures";
import { exportSvg, schemaScene } from "../../schema/exportSvg";
import type { Layout } from "../../schema/layout";
import { CARD_WIDTH } from "../metrics";
import { NODE_TOKENS } from "../types";
import { exportPalette, type ExportPalette } from "./palette";
import { type Scene, sceneBounds } from "./scene";
import { hairlineId, iconRefs, sceneBody, sceneToSvg, type SvgOptions, svgDefs, wrapSvg } from "./svg";
import { defsOnlyHold, plainSvg } from "../../test/plainSvg";
import { flowScene } from "../../flow/flowScene";
import { erCardH, erMetrics } from "../../flow/kindLayout";
import { parseFlow } from "../../lang/flow/parse";
import { SOFT_CHAR_W } from "../canvasView";

const PALETTE: ExportPalette = {
  surface: "#010101",
  canvas: "#020202",
  text: "#030303",
  subtle: "#040404",
  border: "#050505",
  type: "#060606",
  keyword: "#070707",
  nodes: {
    ...(Object.fromEntries(Object.keys(NODE_TOKENS).map((k) => [k, { fill: "#0e0e0e", stroke: "#0f0f0f" }])) as ExportPalette["nodes"]),
    table: { fill: "#0a0a0a", stroke: "#0b0b0b" },
    view: { fill: "#0c0c0c", stroke: "#0d0d0d" },
    derived: { fill: "#0c0c0c", stroke: "#0d0d0d" },
    result: { fill: "#0c0c0c", stroke: "#0d0d0d" },
  },
  iconTile: "#101010",
  group: "#111111",
  groupTint: "#121212",
  strongBorder: "#131313",
  panel: "#141414",
  muted: "#151515",
  faint: "#161616",
  keyMark: "#171718",
};

const SCENE: Scene = {
  nodes: [
    { id: "a", kind: "table", x: 0, y: 0, w: 216, h: 80, title: "orders", subtitle: "sales", rows: [{ left: "id", right: "int", mark: "pk" }, { left: "store_id", right: "int", mark: "fk" }] },
    { id: "b", kind: "view", x: 400, y: 100, w: 216, h: 56, title: "stores", rows: [{ left: "id", right: "int", mark: "pk" }] },
    { id: "r", kind: "result", x: 800, y: 0, w: 268, h: 104, title: "Result", rows: [{ left: "city", right: "text" }], footer: ["WHERE total > 10", "LIMIT 100"] },
  ],
  edges: [
    { id: "e1", kind: "fk", points: [{ x: 216, y: 68 }, { x: 308, y: 68 }, { x: 308, y: 144 }, { x: 400, y: 144 }] },
    { id: "e2", kind: "join", label: "Inner join", points: [{ x: 216, y: 44 }, { x: 400, y: 44 }] },
    { id: "e3", kind: "lineage", points: [{ x: 616, y: 144 }, { x: 800, y: 56 }] },
  ],
};

const opts = { padding: 32, background: "theme" as const, mark: false };
const colours = (svg: string) => [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]).filter((c) => c !== "none");

let style: HTMLStyleElement | null = null;
afterEach(() => {
  style?.remove();
  style = null;
});

test("scene_svg_uses_token_values", () => {
  style = document.createElement("style");
  style.textContent =
    ".theme-light{--c-bg-surface:#111111;--c-bg-canvas:#121212;--c-text:#131313;--c-text-subtle:#141414;--c-border:#151515;--c-syn-type:#161616;--c-syn-keyword:#171717;--c-node-table-fill:#181818;--c-node-table-stroke:#191919;--c-node-view-fill:#1a1a1a;--c-node-view-stroke:#1b1b1b}" +
    ".theme-dark{--c-bg-surface:#211111;--c-bg-canvas:#221212;--c-text:#231313;--c-text-subtle:#241414;--c-border:#251515;--c-syn-type:#261616;--c-syn-keyword:#271717;--c-node-table-fill:#281818;--c-node-table-stroke:#291919;--c-node-view-fill:#2a1a1a;--c-node-view-stroke:#2b1b1b}";
  document.head.appendChild(style);
  const light = exportPalette();
  expect(light).toMatchObject({ surface: "#111111", canvas: "#121212", text: "#131313", subtle: "#141414", border: "#151515", type: "#161616", keyword: "#171717" });
  expect(light.nodes.table).toEqual({ fill: "#181818", stroke: "#191919" });
  expect(light.nodes.result).toEqual({ fill: "#1a1a1a", stroke: "#1b1b1b" });
  expect(exportPalette("dark").canvas).toBe("#221212");
  expect(document.querySelector(".theme-light, .theme-dark")).toBeNull();

  const svg = sceneToSvg(SCENE, light, { ...opts, mark: true });
  const allowed = new Set([...Object.values(light).filter((v) => typeof v === "string"), ...Object.values(light.nodes).flatMap((n) => [n.fill, n.stroke])]);
  expect(colours(svg).length).toBeGreaterThan(0);
  expect(colours(svg).filter((c) => !allowed.has(c))).toEqual([]);
  // No other `#` colour anywhere in the text.
  const hexes = svg.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
  expect(hexes.filter((h) => !allowed.has(h))).toEqual([]);
  expect(svg).toContain(">Made with Contura<");
});

test("palette_follows_the_drawn_kinds_and_the_icon_tile", () => {
  style = document.createElement("style");
  style.textContent =
    ".theme-light{--c-node-enum-fill:#311111;--c-node-enum-stroke:#321111;--c-node-datastore-fill:#331111;--c-node-datastore-stroke:#341111;--c-node-icon-tile:#351111}" +
    ".theme-dark{--c-node-enum-fill:#411111;--c-node-enum-stroke:#421111;--c-node-datastore-fill:#431111;--c-node-datastore-stroke:#441111;--c-node-icon-tile:#451111}";
  document.head.appendChild(style);
  const light = exportPalette("light");
  expect(Object.keys(light.nodes).sort()).toEqual(Object.keys(NODE_TOKENS).sort());
  expect(light.nodes.decision).toEqual({ fill: "#311111", stroke: "#321111" });
  expect(light.nodes.store).toEqual({ fill: "#331111", stroke: "#341111" });
  expect(light.iconTile).toBe("#351111");
  const dark = exportPalette("dark");
  expect(dark.nodes.decision).toEqual({ fill: "#411111", stroke: "#421111" });
  expect(dark.iconTile).toBe("#451111");
});

test("no_foreign_object", () => {
  const svg = sceneToSvg(SCENE, PALETTE, opts);
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).not.toContain("foreignObject");
  expect(svg).not.toMatch(/<(?!\/?(svg|rect|text|tspan|path|g)\b)[a-z]/i);
});

test("crop_sets_the_view_box", () => {
  const svg = sceneToSvg(SCENE, PALETTE, { ...opts, padding: 0, crop: { x: 10, y: 20, w: 300, h: 150 } });
  expect(svg).toMatch(/<svg[^>]* width="300" height="150" viewBox="10 20 300 150"/);
  const padded = sceneToSvg(SCENE, PALETTE, { ...opts, padding: 16, crop: { x: 10, y: 20, w: 300, h: 150 } });
  expect(padded).toMatch(/viewBox="-6 4 332 182"/);
});

test("transparent_background_has_no_background_rect", () => {
  const themed = sceneToSvg(SCENE, PALETTE, opts);
  const backdrop = `<rect x="-32" y="-32" width="1132" height="220" fill="${PALETTE.canvas}"/>`;
  expect(themed).toContain(backdrop);
  const clear = sceneToSvg(SCENE, PALETTE, { ...opts, background: "transparent" });
  expect(clear).not.toContain(backdrop);
  expect(clear).not.toContain('<rect x="-32"');
});

test("a_result_node_draws_with_the_view_palette", () => {
  const svg = sceneToSvg({ nodes: [SCENE.nodes[2]], edges: [] }, PALETTE, opts);
  expect(svg).toContain(`stroke="${PALETTE.nodes.result.stroke}"`);
  expect(svg).toContain(`fill="${PALETTE.nodes.result.fill}"`);
  expect(svg).not.toContain(PALETTE.nodes.table.stroke);
  expect(svg).toContain(`fill="${PALETTE.keyword}">WHERE<`);
});

test("edges_are_orthogonal_paths_with_drawn_markers_and_labels", () => {
  const svg = sceneToSvg(SCENE, PALETTE, opts);
  expect(svg).toContain('d="M216 68 L308 68 L308 144 L400 144"');
  expect(svg).toContain('data-marker="crow"');
  expect(svg).toContain('data-marker="bar"');
  expect(svg).toContain('data-marker="arrow"');
  expect(svg).toContain(">Inner join<");
  expect(svg).not.toContain("<marker");
});

test("scene_bounds_cover_every_node_or_the_chosen_ones", () => {
  expect(sceneBounds(SCENE)).toEqual({ x: 0, y: 0, w: 1068, h: 156 });
  expect(sceneBounds(SCENE, ["b"])).toEqual({ x: 400, y: 100, w: 216, h: 56 });
  expect(sceneBounds({ nodes: [], edges: [] })).toEqual({ x: 0, y: 0, w: 0, h: 0 });
});

test("schema_builder_export_holds_every_table_and_column_at_its_frame_size", () => {
  const layout: Layout = { version: 1, tables: { "public.stores": { x: -200, y: -50 }, "public.orders": { x: 400, y: 0 } } };
  const scene = schemaScene(KFC_MODEL, layout);
  expect(scene.nodes.map((n) => n.kind)).toEqual(KFC_MODEL.tables.map(() => "table"));
  expect(scene.edges).toHaveLength(KFC_MODEL.refs.length);
  const svg = exportSvg(KFC_MODEL, layout, PALETTE);
  for (const t of KFC_MODEL.tables) {
    expect(svg).toContain(`>${t.name}<`);
    for (const c of t.columns) expect(svg).toContain(`>${c.name}<`);
  }
  const attr = (n: string) => new RegExp(`<svg[^>]* ${n}="([^"]+)"`).exec(svg)![1];
  const [vx, vy, vw, vh] = attr("viewBox").split(" ").map(Number);
  expect([vx, vy]).toEqual([-240, -90]);
  expect(Number(attr("width"))).toBe(vw);
  expect(Number(attr("height"))).toBe(vh);
  expect(vx + vw).toBe(400 + CARD_WIDTH + 40);
  expect(svg).not.toContain("Made with Contura");
});

// ----- B4 Task 1: the writer in parts. The golden holds today's `sceneToSvg` for every scene fixture of this file and
// publishKinds.test.ts, in two literal palettes and at text size 1.15, captured before the split (R17).

interface Golden {
  palettes: Record<"a" | "b", ExportPalette>;
  entries: { name: string; palette: "a" | "b"; opts: SvgOptions; scene: Scene; svg: string }[];
}
const goldens = import.meta.glob("./__golden__/scenes.json", { eager: true, import: "default" }) as Record<string, Golden>;

test("scene_to_svg_is_unchanged_by_the_split", () => {
  const golden = goldens["./__golden__/scenes.json"];
  expect(golden, "src/diagram/export/__golden__/scenes.json").toBeDefined();
  expect(golden.entries.length).toBeGreaterThan(100);
  for (const e of golden.entries) expect(sceneToSvg(e.scene, golden.palettes[e.palette], e.opts), e.name).toBe(e.svg);
});

test("scene_body_alone_draws_a_scaled_scene_at_its_size", () => {
  const scaled: Scene = { ...SCENE, textScale: 1.15 };
  const body = sceneBody(scaled, PALETTE);
  const whole = sceneToSvg(scaled, PALETTE, { ...opts, background: "transparent" });
  // The body is everything between the head and the end: nothing else draws it.
  expect(whole).toBe(`${/^<svg[^>]*>/.exec(whole)![0]}${body}</svg>\n`);
  const pills = (s: string) => [...s.matchAll(/data-part="label-pill"[^>]* width="([^"]+)"/g)].map((m) => m[1]);
  const sizes = (s: string) => [...s.matchAll(/ font-size="([^"]+)"/g)].map((m) => m[1]);
  expect(pills(body)).toEqual([String(Math.ceil("Inner join".length * 6.5 * 1.15 + 16))]);
  expect(sizes(body)).toEqual(sizes(whole).slice(1));
  expect(sizes(body)).toContain("12.65");
  // The scale lives only for the one draw.
  expect(pills(sceneBody(SCENE, PALETTE))).toEqual([String(Math.ceil("Inner join".length * 6.5 + 16))]);
  expect(sizes(sceneBody(SCENE, PALETTE))).not.toContain("12.65");
});

const LOGO = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;
const OTHER = `data:image/png;base64,${btoa("png")}`;
const service = (id: string, x: number, icon: string, outline?: boolean): Scene["nodes"][number] => ({
  id,
  kind: "service",
  look: "modern",
  x,
  y: 0,
  w: 104,
  h: 72,
  title: id,
  rows: [],
  icon,
  iconName: id,
  ...(outline ? { iconOutline: true } : {}),
});
const CLOUD: Scene = { nodes: [service("Users", 0, LOGO, true), service("Admins", 200, LOGO)], edges: [] };

test("refs_draw_each_icon_once_in_defs", () => {
  const refs = iconRefs();
  const body = sceneBody(CLOUD, PALETTE, refs);
  const id = refs.ref(LOGO, 48);
  expect(id).toMatch(/^icon-[0-9a-f]{8}-48$/);
  expect([...refs.entries().keys()]).toEqual([id]);
  const uses = [...body.matchAll(/<use [^>]*>/g)].map((m) => m[0]);
  expect(uses).toHaveLength(2);
  for (const u of uses) expect(u).toContain(`href="#${id}"`);
  expect(uses.filter((u) => u.includes(`filter="url(#${hairlineId()})"`))).toHaveLength(1);
  expect(body).not.toContain("<image");
  const defs = svgDefs(PALETTE, { hairline: hairlineId(), icons: refs.entries() });
  expect(defs.match(/<image /g)).toHaveLength(1);
  expect(defs).toContain(`<image id="${id}" href="${LOGO}"`);
  expect(defs.match(/<filter /g)).toHaveLength(1);
  // Stable across exports, different for another picture.
  expect(iconRefs().ref(LOGO, 48)).toBe(id);
  expect(iconRefs().ref(OTHER, 48)).not.toBe(id);
  expect(hairlineId()).toBe("icon-hairline");
  expect(hairlineId("dark")).toBe("icon-hairline-dark");
  // A named hairline is the one the uses name.
  const dark = sceneBody(CLOUD, PALETTE, iconRefs(), hairlineId("dark"));
  expect(dark).toContain(`filter="url(#icon-hairline-dark)"`);
});

test("a_hash_clash_takes_the_next_suffix", () => {
  const refs = iconRefs(() => 0xabc);
  expect(refs.ref(LOGO, 48)).toBe("icon-00000abc-48");
  expect(refs.ref(OTHER, 48)).toBe("icon-00000abc-48-2");
  expect(refs.ref(LOGO, 48)).toBe("icon-00000abc-48");
  expect(refs.ref(`${OTHER}x`, 48)).toBe("icon-00000abc-48-3");
  expect(refs.ref(OTHER, 16)).toBe("icon-00000abc-16");
  expect([...refs.entries()]).toEqual([
    ["icon-00000abc-48", { url: LOGO, size: 48 }],
    ["icon-00000abc-48-2", { url: OTHER, size: 48 }],
    ["icon-00000abc-48-3", { url: `${OTHER}x`, size: 48 }],
    ["icon-00000abc-16", { url: OTHER, size: 16 }],
  ]);
});

test("board_defs_hold_only_the_filter_and_data_images", () => {
  const scene: Scene = {
    nodes: [...CLOUD.nodes, service("Bad", 400, "javascript:alert(1)"), service("Far", 600, "https://example.com/x.svg", true)],
    edges: [],
    areas: [{ name: "AWS", x: -20, y: -40, w: 800, h: 140, depth: 0, icon: OTHER, iconOutline: true }],
  };
  const refs = iconRefs();
  const body = sceneBody(scene, PALETTE, refs, hairlineId("light"));
  const defs = svgDefs(PALETTE, { hairline: hairlineId("light"), icons: refs.entries() });
  const svg = wrapSvg(defs, body, sceneBounds(scene), PALETTE, { ...opts, mark: true });
  defsOnlyHold(svg);
  plainSvg(svg);
  expect(svg.match(/<defs>/g)).toHaveLength(1);
  expect(svg).not.toContain("javascript:");
  expect(svg).not.toContain("example.com");
  // Two pictures: the logo (48) and the group's (16); three uses.
  expect(defs.match(/<image /g)).toHaveLength(2);
  expect(body.match(/<use /g)).toHaveLength(3);
  expect(svg.indexOf("<defs>")).toBeLessThan(svg.indexOf(`fill="${PALETTE.canvas}"`));
  expect(svg).toContain(">Made with Contura<");
});

test("defs_is_empty_with_nothing_to_share", () => {
  expect(svgDefs(PALETTE, { hairline: null, icons: new Map() })).toBe("");
  expect(svgDefs(PALETTE, { hairline: null, icons: iconRefs().entries() })).toBe("");
  expect(sceneToSvg(SCENE, PALETTE, opts)).not.toContain("<defs");
  expect(svgDefs(PALETTE, { hairline: "icon-hairline", icons: new Map() })).toMatch(/^<defs><filter id="icon-hairline" [^]*<\/filter><\/defs>$/);
});

test("plain_svg_allows_use_and_defs_only_beyond_today", () => {
  const XL = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
  const ok = `<svg ${XL}><defs><filter id="f"><feFlood flood-color="#000"/></filter><image id="i" href="${LOGO}"/></defs><g><rect/><text><tspan>a</tspan></text><path/><use href="#i" xlink:href="#i" x="1" y="2"/><image href="${LOGO}"/></g></svg>`;
  expect(() => plainSvg(ok)).not.toThrow();
  expect(() => defsOnlyHold(ok)).not.toThrow();
  for (const bad of [
    "<marker/>",
    "<clipPath/>",
    "<ellipse/>",
    "<foreignObject/>",
    "<script/>",
    '<use href="https://example.com/x.svg#a" xlink:href="https://example.com/x.svg#a"/>',
    '<image href="https://example.com/x.png"/>',
    // Final review minor 4: a <use> carries both references, to the same id; xlink:href nowhere else.
    '<use href="#i"/>',
    '<use href="#i" xlink:href="https://example.com/x.svg#a"/>',
    '<use href="#i" xlink:href="#j"/>',
    '<image href="data:image/png;base64,AA" xlink:href="https://example.com/x.png"/>',
  ]) {
    expect(() => plainSvg(`<svg ${XL}><g>${bad}</g></svg>`), bad).toThrow();
  }
  // The namespace is declared once, on the root, when a <use> is there.
  expect(() => plainSvg('<svg><g><use href="#i" xlink:href="#i"/></g></svg>')).toThrow();
  expect(() => plainSvg(`<svg ${XL}><g ${XL}><use href="#i" xlink:href="#i"/></g></svg>`)).toThrow();
  for (const bad of ['<defs><script/></defs>', '<defs><image id="i" href="https://example.com/x.png"/></defs>', '<defs><linearGradient id="g"/></defs>', "<defs></defs><defs></defs>"]) {
    expect(() => defsOnlyHold(`<svg>${bad}</svg>`), bad).toThrow();
  }
});

// ----- Plan F Task 7 (Decision 7): a frame picture's soft text and its ER cards cut at the canvas's 20 rows.

test("soft_text_draws_bars_and_no_text", () => {
  for (const k of [1, 1.15]) {
    const scene: Scene = { ...SCENE, textScale: k };
    const plain = sceneBody(scene, PALETTE);
    const body = sceneBody(scene, PALETTE, undefined, undefined, { softText: true });
    expect(body).not.toContain("<text");
    expect(body).not.toContain("orders");
    const bars = [...body.matchAll(/<rect data-part="soft" ([^>]*)\/>/g)].map((m) => m[1]);
    // One bar a run of words.
    expect(bars).toHaveLength((plain.match(/<text/g) ?? []).length);
    for (const b of bars) {
      expect(b).toContain('rx="2"');
      expect(b).toContain(`fill="${PALETTE.faint}"`);
      expect(b).toContain('fill-opacity="0.45"');
    }
    const attr = (b: string, n: string) => Number(new RegExp(` ?${n}="([^"]+)"`).exec(b)![1]);
    // The title "orders" (6 characters at 13 px) starts at the card's left plus 10, as its words did.
    const title = bars.find((b) => attr(b, "x") === 10 && Math.abs(attr(b, "width") - 6 * SOFT_CHAR_W * k) < 0.01);
    expect(title, `k ${k}`).toBeDefined();
    // "Inner join" at 11 px, centred on its pill.
    const label = 10 * SOFT_CHAR_W * ((11 * k) / 13);
    const pill = bars.find((b) => Math.abs(attr(b, "width") - label) < 0.01);
    expect(pill, `k ${k}`).toBeDefined();
    expect(attr(pill!, "x") + attr(pill!, "width") / 2).toBeCloseTo(308, 1);
    // A bar never runs past its shape.
    const long: Scene = { nodes: [{ ...SCENE.nodes[0], id: "w", title: "x".repeat(80) }], edges: [], textScale: k };
    const widths = [...sceneBody(long, PALETTE, undefined, undefined, { softText: true }).matchAll(/data-part="soft"[^>]* width="([^"]+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...widths)).toBe(216);
  }
});

test("scene_body_without_options_is_unchanged", () => {
  // B4's golden, through the body alone: no options and empty options draw what the golden holds.
  const golden = goldens["./__golden__/scenes.json"];
  for (const e of golden.entries) {
    const p = golden.palettes[e.palette];
    const body = sceneBody(e.scene, p);
    expect(sceneBody(e.scene, p, undefined, undefined, {}), e.name).toBe(body);
    expect(sceneBody(e.scene, p, undefined, undefined, { softText: false }), e.name).toBe(body);
    expect(e.svg, e.name).toContain(body);
  }
});

const longEr = (n: number, target: number) =>
  parseFlow(['diagram er "Long"', "wide {", ...Array.from({ length: n }, (_, i) => `  c${i} int${i === 0 ? " pk" : ""}`), "}", "other {", "  id int pk", "}", `other.id > wide.c${target}`, "other.id > wide.c3"].join("\n")).doc!;
const AT_WIDE = { wide: { x: 400, y: 100 }, other: { x: 0, y: 0 } };

test("a_row_cap_draws_20_rows_and_ends_lines_at_the_edge", () => {
  for (const k of [0.88, 1, 1.15]) {
    const scene = flowScene(longEr(30, 25), AT_WIDE, "modern", new Map(), undefined, undefined, { textScale: k, rowCap: 20 });
    const wide = scene.nodes.find((x) => x.id === "wide")!;
    // As tall as the canvas draws a 30-row card: its first 20 rows.
    expect(wide.h, `k ${k}`).toBe(erCardH(20, k));
    expect(wide.rows.map((r) => r.left)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i}`));
    // A line to row 25 ends on the card's bottom edge; one to row 3 at its row.
    const [toLate, toEarly] = scene.edges;
    expect(toLate.points[toLate.points.length - 1].y, `k ${k}`).toBeCloseTo(wide.y + wide.h, 9);
    expect(toEarly.points[toEarly.points.length - 1].y, `k ${k}`).toBeCloseTo(wide.y + erMetrics(k).mid + 3 * erMetrics(k).row, 9);
    const svg = sceneToSvg(scene, PALETTE, opts);
    expect(svg).toContain(">c19<");
    expect(svg).not.toContain(">c20<");
  }
  // A card with fewer rows than the cap is drawn whole.
  const short = flowScene(longEr(5, 4), AT_WIDE, "modern", new Map(), undefined, undefined, { rowCap: 20 });
  expect(short.nodes.find((x) => x.id === "wide")!.h).toBe(erCardH(5, 1));
});

test("publish_output_is_unchanged_without_a_row_cap", () => {
  for (const k of [0.88, 1, 1.15]) {
    const doc = longEr(30, 25);
    const without = flowScene(doc, AT_WIDE, "modern", new Map(), undefined, undefined, { textScale: k });
    const wide = without.nodes.find((x) => x.id === "wide")!;
    expect(wide.h).toBe(erCardH(30, k));
    expect(wide.rows).toHaveLength(30);
    expect(flowScene(doc, AT_WIDE, "modern", new Map(), undefined, undefined, { textScale: k, rowCap: undefined })).toEqual(without);
    expect(sceneToSvg(without, PALETTE, opts)).toContain(">c29<");
  }
});
