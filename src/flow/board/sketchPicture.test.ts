// Task 9 fix 2: the sketch layer's tiles, and their pictures drawn by Publish's sketch writer.
import { expect, test } from "vitest";
import type { ExportPalette } from "../../diagram/export/palette";
import { NODE_TOKENS } from "../../diagram/types";
import type { Sketch } from "./boardLayout";
import { createSketchPictureStore, createSketchTiles, SKETCH_TILE } from "./sketchPicture";

const LIGHT: ExportPalette = {
  surface: "#e10101",
  canvas: "#e10202",
  text: "#e10303",
  subtle: "#e10404",
  border: "#e10505",
  type: "#e10606",
  keyword: "#e10707",
  nodes: Object.fromEntries(Object.keys(NODE_TOKENS).map((k) => [k, { fill: "#e11000", stroke: "#e12000" }])) as ExportPalette["nodes"],
  iconTile: "#e11010",
  group: "#e11111",
  groupTint: "#e11212",
  strongBorder: "#e11313",
  panel: "#e11414",
  muted: "#e11515",
  faint: "#e11616",
  keyMark: "#e11717",
};

const pen = (id: string, x: number, y: number): Sketch => ({ id, kind: "pen", x, y, w: 200, h: 120, points: [[0, 0], [200, 120]] });
const rect = (id: string, x: number, y: number): Sketch => ({ id, kind: "rect", x, y, w: 200, h: 120 });

test("sketches_group_into_tiles_by_where_they_start_and_by_layer", () => {
  const sketches = [pen("a", 0, 0), rect("b", 100, 100), pen("c", 500, 300), pen("d", SKETCH_TILE + 10, 0), { ...rect("s", 0, 600), kind: "section" as const, text: "Q4" }];
  const tiles = createSketchTiles().of(sketches);
  const byId = Object.fromEntries(tiles.map((t) => [t.id, t]));
  expect(Object.keys(byId).sort()).toEqual(["o0,0", "o1,0", "u0,0"]);
  // In layout order; the box is what they draw (a Section's title above it included).
  expect(byId["o0,0"].sketches.map((s) => s.id)).toEqual(["a", "c"]);
  expect(byId["o0,0"].box).toEqual({ x: 0, y: 0, w: 700, h: 420 });
  expect(byId["u0,0"].under).toBe(true);
  expect(byId["u0,0"].sketches.map((s) => s.id)).toEqual(["b", "s"]);
  expect(byId["u0,0"].box.y).toBe(100);
  expect(byId["u0,0"].box.h).toBe(720 - 100);
});

test("an_edit_keys_only_its_own_tile_again", () => {
  const t = createSketchTiles();
  const before = [pen("a", 0, 0), pen("d", SKETCH_TILE + 10, 0)];
  const first = t.of(before);
  const keys = new Map(first.map((x) => [x.id, t.keyOf(x)]));
  // The same list: the same tiles. A list with one sketch moved: only its tile's key is new.
  expect(t.of(before)).toBe(first);
  const after = t.of([{ ...before[0], x: 40 }, before[1]]);
  const next = new Map(after.map((x) => [x.id, t.keyOf(x)]));
  expect(next.get("o0,0")).not.toBe(keys.get("o0,0"));
  expect(next.get("o1,0")).toBe(keys.get("o1,0"));
});

test("a_tile_picture_draws_its_sketches_in_the_palette", async () => {
  const store = createSketchPictureStore({ palette: () => LIGHT, loadIcons: async () => new Map(), onReady: () => {}, sync: true });
  const t = createSketchTiles();
  const [tile] = t.of([pen("a", 1_000, 2_000), { id: "n", kind: "note", x: 1_400, y: 2_000, w: 200, h: 120, text: "Ask legal" }]);
  const url = store.url(tile.id, t.keyOf(tile), tile) as string;
  const svg = atob(url.slice(url.indexOf(",") + 1));
  expect(svg).toContain('viewBox="1000 2000 600 120"');
  expect(svg).toContain('data-sketch="a"');
  expect(svg).toContain('data-sketch="n"');
  expect(svg).toContain(">Ask legal<");
  expect(svg).toContain(LIGHT.text);
  expect(store.bytes()).toBe(url.length);
});
