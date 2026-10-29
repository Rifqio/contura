// Task 9 fix 3 (Decision 14's node gates): the sketch layer's tile pictures at B1's limit (1,000 sketches at the caps:
// pens of 1,000 points, notes of 2,000 characters), in a literal palette, built in slices with the WebView's raster
// steps. Their pictures are counted as the frames' are (decoded pixels and PNG URLs), under a gate of their own.
// Run alone through `npm run test:perf`.
import { afterEach, expect, test, vi } from "vitest";
import type { ExportPalette } from "../../diagram/export/palette";
import { NODE_TOKENS } from "../../diagram/types";
import { fullSketches } from "../../lang/flow/fixtures/bigBoardLayout";
import { blankRasteriser } from "../../test/pictureRaster";
import { PICTURE_SLICE_MS } from "./boardDetail";
import { createSketchPictureStore, createSketchTiles, SKETCH_PICTURES_MAX_BYTES } from "./sketchPicture";

const LIGHT: ExportPalette = {
  surface: "#ffffff",
  canvas: "#f6f8fa",
  text: "#1f2328",
  subtle: "#59636e",
  border: "#d1d9e0",
  type: "#953800",
  keyword: "#cf222e",
  nodes: Object.fromEntries(Object.keys(NODE_TOKENS).map((k) => [k, { fill: "#f6f8fa", stroke: "#d1d9e0" }])) as ExportPalette["nodes"],
  iconTile: "#ffffff",
  group: "#1a7f37",
  groupTint: "#dafbe1",
  strongBorder: "#8c959f",
  panel: "#f6f8fa",
  muted: "#3d444d",
  faint: "#818b98",
  keyMark: "#9a6700",
};

const MB = 1024 * 1024;
const task = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

test("the_limit_sketch_layer_pictures_hold_under_their_gate_in_slices", async () => {
  const real = globalThis.setTimeout;
  const tasks: number[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    real(() => {
      const t0 = performance.now();
      fn();
      tasks.push(performance.now() - t0);
    }, ms)) as unknown as typeof setTimeout);
  const store = createSketchPictureStore({ palette: () => LIGHT, loadIcons: async () => new Map(), onReady: () => {}, rasterise: blankRasteriser, dpr: () => 1 });
  // Warm the writer's and the deflate's code paths once (as the frames' slice test does), then time a cold layer.
  const warm = createSketchPictureStore({ palette: () => LIGHT, loadIcons: async () => new Map(), onReady: () => {}, rasterise: blankRasteriser, dpr: () => 1 });
  const w = createSketchTiles();
  const few = w.of(fullSketches().slice(0, 120));
  few.forEach((x) => warm.url(x.id, w.keyOf(x), x));
  for (let i = 0; i < 10_000 && !few.every((x) => warm.ready(x.id)); i++) await task();
  tasks.length = 0;
  const t = createSketchTiles();
  const tiles = t.of(fullSketches());
  const ask = () => tiles.map((x) => store.url(x.id, t.keyOf(x), x));
  ask();
  for (let i = 0; i < 10_000 && !tiles.every((x) => store.ready(x.id)); i++) await task();
  const images = ask();
  expect(images.every((x) => x !== null && typeof x !== "string")).toBe(true);
  const worst = Math.max(...tasks);
  console.log(`sketch tiles at the limit: ${tiles.length} tiles, ${(store.bytes() / MB).toFixed(2)} MB held; ${tasks.length} tasks, worst ${worst.toFixed(2)} ms`);
  expect(store.bytes()).toBeLessThan(SKETCH_PICTURES_MAX_BYTES);
  expect(worst).toBeLessThan(PICTURE_SLICE_MS);
}, 120_000);
