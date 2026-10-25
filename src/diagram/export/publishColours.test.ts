// Diagram step 11 (ADR 0019): Publish draws the palette colours and labels as the canvas draws them, every colour read
// from the theme the Publish dialog picks (light or dark), never a literal.
import { afterEach, expect, test, vi } from "vitest";
import { flowScene } from "../../flow/flowScene";
import { parseFlow } from "../../lang/flow/parse";
import { NODE_TOKENS, PALETTE_TOKENS } from "../types";
import { exportPalette, type ExportPalette } from "./palette";
import { sceneToSvg } from "./svg";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const opts = { padding: 32, background: "theme" as const, mark: false };

const BASE: ExportPalette = {
  surface: "#010101",
  canvas: "#020202",
  text: "#030303",
  subtle: "#040404",
  border: "#050505",
  type: "#060606",
  keyword: "#070707",
  nodes: Object.fromEntries(Object.keys(NODE_TOKENS).map((k, i) => [k, { fill: `#1${i.toString(16)}0000`, stroke: `#2${i.toString(16)}0000` }])) as ExportPalette["nodes"],
  iconTile: "#101010",
  group: "#111111",
  groupTint: "#121212",
  strongBorder: "#131313",
  panel: "#141414",
  colours: {
    accent: { fill: "#a10000", stroke: "#a20000", text: "#030303" },
    info: { fill: "#a30000", stroke: "#a40000", text: "#030303" },
    success: { fill: "#a50000", stroke: "#a60000", text: "#030303" },
    warning: { fill: "#a70000", stroke: "#a80000", text: "#030303" },
    danger: { fill: "#a90000", stroke: "#aa0000", text: "#030303" },
    muted: { fill: "#ab0000", stroke: "#ac0000", text: "#ad0000" },
  },
};

const TEXT = [
  'diagram flow "Orders"',
  "Charge card",
  "Retry",
  "Retry 2 [step, label: Retry, color: danger]",
  "Dispatch [color: muted] {",
  "  Ship",
  "}",
  "Charge card > Retry 2: no [color: warning]",
  "Charge card > Ship",
].join("\n");
const AT = { "Charge card": { x: 0, y: 0 }, Retry: { x: 0, y: 200 }, "Retry 2": { x: 300, y: 0 }, Ship: { x: 600, y: 0 } };

let style: HTMLStyleElement | null = null;
afterEach(() => {
  style?.remove();
  style = null;
});

test("a coloured shape, group and line publish in their palette colours, and a label publishes its words", () => {
  const doc = parseFlow(TEXT).doc!;
  const scene = flowScene(doc, AT, "modern", new Map());
  const two = scene.nodes.find((n) => n.id === "Retry 2")!;
  expect(two).toMatchObject({ title: "Retry", color: "danger" });
  expect(scene.areas?.[0]).toMatchObject({ name: "Dispatch", color: "muted" });
  expect(scene.edges[0]).toMatchObject({ color: "warning" });
  expect(scene.edges[1].color).toBeUndefined();

  const svg = sceneToSvg(scene, BASE, opts);
  const node = /<g data-node="Retry 2"[^]*?<\/g>/.exec(svg)![0];
  expect(node).toContain('fill="#a90000"');
  expect(node).toContain('stroke="#aa0000"');
  expect(node).toContain(">Retry<");
  const area = /<g data-area="Dispatch">[^]*?<\/g>/.exec(svg)![0];
  expect(area).toContain('stroke="#ac0000"');
  expect(area).toContain('fill="#ab0000"');
  const edge = /<g data-edge="edge:0">[^]*?<\/g>/.exec(svg)![0];
  expect(edge).toContain('stroke="#a80000"');
  // Its arrowhead keeps the colour.
  expect(edge).toMatch(/data-marker="head"[^>]*fill="#a80000"/);
  const plain = /<g data-edge="edge:1">[^]*?<\/g>/.exec(svg)![0];
  expect(plain).not.toContain("#a80000");
});

test("the palette is read from the theme Publish picks, light or dark", () => {
  style = document.createElement("style");
  const vars = (prefix: string) =>
    Object.values(PALETTE_TOKENS)
      .flatMap((t) => [t.fill, t.stroke, t.text])
      .map((name, i) => `${name}:#${prefix}${i.toString(16).padStart(4, "0")}`)
      .join(";");
  style.textContent = `.theme-light{${vars("e1")}}.theme-dark{${vars("d1")}}`;
  document.head.appendChild(style);
  const light = exportPalette("light");
  const dark = exportPalette("dark");
  expect(light.colours?.danger.fill).toMatch(/^#e1/);
  expect(dark.colours?.danger.fill).toMatch(/^#d1/);
  expect(light.colours?.danger.fill).not.toBe(dark.colours?.danger.fill);
  expect(Object.keys(light.colours ?? {})).toEqual(["accent", "info", "success", "warning", "danger", "muted"]);
});
