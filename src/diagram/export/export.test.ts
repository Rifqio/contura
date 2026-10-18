import { afterEach, expect, test } from "vitest";
import { KFC_MODEL } from "../../lang/dbml/fixtures";
import { exportSvg, schemaScene } from "../../schema/exportSvg";
import type { Layout } from "../../schema/layout";
import { CARD_WIDTH } from "../metrics";
import { exportPalette, type ExportPalette } from "./palette";
import { type Scene, sceneBounds } from "./scene";
import { sceneToSvg } from "./svg";

const PALETTE: ExportPalette = {
  surface: "#010101",
  canvas: "#020202",
  text: "#030303",
  subtle: "#040404",
  border: "#050505",
  type: "#060606",
  keyword: "#070707",
  nodes: {
    table: { fill: "#0a0a0a", stroke: "#0b0b0b" },
    view: { fill: "#0c0c0c", stroke: "#0d0d0d" },
    derived: { fill: "#0c0c0c", stroke: "#0d0d0d" },
    result: { fill: "#0c0c0c", stroke: "#0d0d0d" },
  },
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
