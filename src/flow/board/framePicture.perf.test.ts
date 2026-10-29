// Plan F Task 7 timing and memory (Decision 7, Decision 14's node gates): the pictures of B1's limit board (50 frames,
// 10,000 shapes, 15,000 links), in a literal palette with a fake icon loader. Run alone through `npm run test:perf`.
import { afterEach, expect, test, vi } from "vitest";
import type { ExportPalette } from "../../diagram/export/palette";
import { NODE_TOKENS } from "../../diagram/types";
import { board, FRAMES } from "../../lang/flow/fixtures/bigBoard";
import { bigBoardLayout } from "../../lang/flow/fixtures/bigBoardLayout";
import { createFlowService } from "../../lang/flow/service";
import { ER_BOARD_KEYS, ER_BOARD_TEXT, ER_FLOW_FRAMES, erPositions } from "../../lang/flow/fixtures/erBoard";
import { parseFlow } from "../../lang/flow/parse";
import { emptyPositions } from "../layout";
import type { BoardLayout } from "./boardLayout";
import { type DrawnForms, type FrameForm, PICTURE_SLICE_MS } from "./boardDetail";
import type { Node } from "@xyflow/react";
import { boardFrameId, createBoardScene, FRAME_PICTURE_TYPE, type FramePictureData } from "./boardScene";
import { createPictureStore, pictureHooks, type PictureRaster, type Rasteriser } from "./framePicture";
import { blankRasteriser } from "../../test/pictureRaster";

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

const KEYS = Array.from({ length: FRAMES }, (_, k) => `Area ${k}`);
const MB = 1024 * 1024;
const gc = () => (globalThis as unknown as { gc(): void }).gc();
const task = () => new Promise<void>((r) => setTimeout(r, 0));
/** Node's WeakRef; the project's lib (ES2020) does not declare it. */
type Weak<T extends object> = { deref(): T | undefined };
const WeakRefOf = (globalThis as unknown as { WeakRef: new <T extends object>(target: T) => Weak<T> }).WeakRef;

afterEach(() => {
  pictureHooks.onEntry = undefined;
  vi.restoreAllMocks();
});

const fakeRaster = blankRasteriser;

/**
 * Every picture node of a build is a PNG bitmap, `count` of them, and the store's bytes are their decoded pixels
 * (w x h x 4) and their PNG URLs: no SVG text and no canvas is held.
 */
function bitmapsOnly(nodes: readonly Node[], store: ReturnType<typeof createPictureStore>, count: number) {
  const pictures = nodes.filter((n) => n.type === FRAME_PICTURE_TYPE).map((n) => n.data as FramePictureData);
  expect(pictures).toHaveLength(count);
  let bytes = 0;
  for (const p of pictures) {
    expect(p.url).toBeUndefined();
    expect(p.raster!.url).toMatch(/^data:image\/png;base64,/);
    expect(Object.keys(p.raster!).sort()).toEqual(["h", "url", "w"]);
    bytes += p.raster!.w * p.raster!.h * 4 + p.raster!.url.length;
  }
  expect(store.bytes()).toBe(bytes);
}

/** Every frame of the limit board drawn as `form`. */
const every = (form: FrameForm): DrawnForms => ({ form: new Map(KEYS.map((_, k) => [k, form])), mounted: new Map() });

/** The limit board's scene with a store after open: every picture is asked for, then built in slices. */
function limitBoard(rasterise: Rasteriser = fakeRaster) {
  const r = createFlowService().parse("board", board());
  const b = bigBoardLayout();
  const scene = createBoardScene("modern");
  const onReady = vi.fn();
  const store = createPictureStore({ palette: () => LIGHT, loadIcons: async () => new Map(), onReady, rasterise, dpr: () => 1 });
  const build = (form: FrameForm) => scene.build(r.frames, b, KEYS, null, null, [], undefined, every(form), store);
  return { r, b, scene, store, onReady, build };
}

/** Runs the store's tasks until every frame's picture is in. */
async function allBuilt(store: ReturnType<typeof createPictureStore>, keys: readonly string[] = KEYS) {
  for (let i = 0; i < 10_000; i++) {
    if (keys.every((k) => store.ready(boardFrameId(k)))) return;
    await task();
  }
  throw new Error("pictures never finished");
}

/**
 * B3's ER limit board (Decision 14): A5's first 40 flowchart frames and one ERD of 2,000 tables of 20 columns with
 * 2,000 column relationships, every frame a picture.
 */
function erLimitBoard(rasterise: Rasteriser = fakeRaster) {
  const r = createFlowService().parse("board", ER_BOARD_TEXT);
  const b: BoardLayout = bigBoardLayout();
  for (let k = ER_FLOW_FRAMES; k < 50; k++) b.frames.delete(`Area ${k}`);
  b.frames.set("Schema", { at: { x: ER_FLOW_FRAMES * 5200, y: 0 }, nodes: erPositions(), style: "modern", direction: "TB" });
  const scene = createBoardScene("modern");
  const store = createPictureStore({ palette: () => LIGHT, loadIcons: async () => new Map(), onReady: () => {}, rasterise, dpr: () => 1 });
  const drawn: DrawnForms = { form: new Map(ER_BOARD_KEYS.map((_, k) => [k, "picture" as const])), mounted: new Map() };
  const build = () => scene.build(r.frames, b, ER_BOARD_KEYS, null, null, [], undefined, drawn, store);
  return { store, build };
}

/** Times every task the store runs with the real clock. */
function timeTasks(): number[] {
  const real = globalThis.setTimeout;
  const tasks: number[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    real(() => {
      const t0 = performance.now();
      fn();
      tasks.push(performance.now() - t0);
    }, ms)) as unknown as typeof setTimeout);
  return tasks;
}

test("a_picture_slice_stays_under_8ms", async () => {
  // Each task the store runs is timed with the real clock: no task builds for longer than PICTURE_SLICE_MS.
  const real = globalThis.setTimeout;
  const tasks: number[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    real(() => {
      const t0 = performance.now();
      fn();
      tasks.push(performance.now() - t0);
    }, ms)) as unknown as typeof setTimeout);
  const { store, build } = limitBoard();
  // Warm the writer's code paths once, then time a cold board's worth of pictures.
  build("picture");
  await allBuilt(store);
  store.prune(new Set());
  tasks.length = 0;
  build("picture");
  await allBuilt(store);
  const worst = Math.max(...tasks);
  const sorted = [...tasks].sort((a, b) => a - b);
  console.log(`picture slices on the limit board: ${tasks.length} tasks, median ${sorted[sorted.length >> 1].toFixed(2)} ms, worst ${worst.toFixed(2)} ms`);
  expect(tasks.length).toBeGreaterThan(1);
  expect(worst).toBeLessThan(PICTURE_SLICE_MS);
});

test("the_er_limit_board_builds_in_slices_under_8ms", async () => {
  // Its 2,000-table ERD is one frame: its build goes on across slices, so no task passes PICTURE_SLICE_MS.
  const tasks = timeTasks();
  const { store, build } = erLimitBoard();
  build();
  await allBuilt(store, ER_BOARD_KEYS);
  bitmapsOnly(build().nodes, store, ER_BOARD_KEYS.length);
  const worst = Math.max(...tasks);
  console.log(`picture slices on the ER limit board: ${tasks.length} tasks, worst ${worst.toFixed(2)} ms; ${(store.bytes() / MB).toFixed(2)} MB held`);
  expect(worst).toBeLessThan(PICTURE_SLICE_MS);
  // Under the node gate with the ERD's picture in: 13.58 MB in Task 9, so the provisional 16 MB is lowered to 15.
  expect(store.bytes()).toBeLessThan(15 * MB);
});

test("pictures_at_the_limit_hold_under_13MB", async () => {
  const { store, build, scene } = limitBoard();
  build("picture");
  await allBuilt(store);
  bitmapsOnly(build("picture").nodes, store, FRAMES);
  const soft = store.bytes();
  // Real words (past BOARD_SIMPLIFY_OVER) instead: still one picture a frame.
  for (let k = 0; k < FRAMES; k++) scene.pictureReady(k, "picture-text", store);
  await allBuilt(store);
  bitmapsOnly(build("picture-text").nodes, store, FRAMES);
  const words = store.bytes();
  console.log(`pictures held at the limit: ${(soft / MB).toFixed(2)} MB soft, ${(words / MB).toFixed(2)} MB with words`);
  expect(soft).toBeGreaterThan(0);
  // Decision 14's node gate, provisional 16 MB: 11.54 MB soft and 10.60 MB with words in Task 9, lowered to 13. Counted
  // as bitmaps since Task 9 fix 2 (PICTURE_MAX_SCALE).
  expect(soft).toBeLessThan(13 * MB);
  expect(words).toBeLessThan(13 * MB);
});

test("dropped_pictures_are_collected", async () => {
  // A WeakRef on the store's entry object (a string cannot be held weakly, P32): once pruned it is collected.
  const refs = new Map<string, Weak<object>>();
  pictureHooks.onEntry = (id, entry) => refs.set(id, new WeakRefOf(entry));
  const { store, build } = limitBoard();
  build("picture");
  await allBuilt(store);
  expect(refs.size).toBe(FRAMES);
  pictureHooks.onEntry = undefined;
  store.prune(new Set());
  expect(store.bytes()).toBe(0);
  await task();
  gc();
  await task();
  gc();
  for (const [id, ref] of refs) expect(ref.deref(), id).toBeUndefined();
});

test("a_complete_picture_lets_its_doc_go", async () => {
  // A picture keeps what it was built from only while it waits for icons. One complete build, never built again: its
  // entry stays in the store, and the doc it was built from is collected (it would not be if the entry kept it).
  const store = createPictureStore({ palette: () => LIGHT, loadIcons: async () => new Map(), onReady: () => {}, sync: true });
  const key = {};
  const old = (() => {
    const d = parseFlow('diagram flow "F"\nA\nB\nA > B: one\n').doc!;
    const input = { doc: d, layout: { nodes: Object.assign(emptyPositions(), { A: { x: 0, y: 0 }, B: { x: 0, y: 140 } }), style: "modern" as const }, textScale: 1, notation: "crow" as const, local: { x: -40, y: -40, w: 300, h: 300 }, softText: true };
    expect(store.url("f", key, input)).not.toBeNull();
    return new WeakRefOf(d);
  })();
  await task();
  gc();
  await task();
  gc();
  // The picture is still held, and so is the store; only the doc is gone.
  expect(store.bytes()).toBeGreaterThan(0);
  expect(store.ready("f")).toBe(true);
  expect(old.deref()).toBeUndefined();
});

test("a_theme_switch_lets_every_picture_go", async () => {
  const refs: Weak<object>[] = [];
  pictureHooks.onEntry = (_, entry) => refs.push(new WeakRefOf(entry));
  const { store, build } = limitBoard();
  build("picture");
  await allBuilt(store);
  pictureHooks.onEntry = undefined;
  store.setTheme("dark");
  // Each Light picture stays until its Dark one replaces it (fix round 1); then the Light ones are collected.
  build("picture");
  await allBuilt(store);
  await task();
  gc();
  await task();
  gc();
  expect(refs.filter((r) => r.deref() !== undefined)).toHaveLength(0);
});

/**
 * The node rasteriser, counting what the WebView's would hold: each SVG it decodes is one document (WebKit makes an SVG
 * image of its own, a page with its document and render tree, for each data: URL it decodes, and keeps it in its memory
 * cache after the <img> lets go), whether a whole picture (`draw`) or a piece of one (`drawPieces`), and how many
 * pictures are being drawn at once.
 */
function countingRasteriser() {
  const seen = { documents: 0, pictures: 0, cut: 0, busy: 0, most: 0 };
  function* counted(docs: number, run: Generator<Promise<unknown> | void, PictureRaster | null>) {
    seen.documents += docs;
    seen.pictures++;
    if (docs > 1) seen.cut++;
    seen.busy++;
    seen.most = Math.max(seen.most, seen.busy);
    try {
      return yield* run;
    } finally {
      seen.busy--;
    }
  }
  const r: Rasteriser = {
    draw: (url, w, h) => counted(1, fakeRaster.draw(url, w, h)),
    drawPieces: (urls, w, h) => counted(urls.length, fakeRaster.draw(urls[0], w, h)),
  };
  return { r, seen };
}

test("each_picture_is_one_svg_document_drawn_one_at_a_time", async () => {
  // Task 9 fix 5. Round 4 decoded a limit frame's SVG (181 K characters) as about 6 whole SVGs and the ERD's as about
  // 105, each its own SVG image in WebKit's memory cache: about +150 MB at Fit live. Round 3 started all 50 decodes at
  // once. Now a limit frame is one SVG document, only the ERD (3.4 M characters) is cut, into pieces of
  // PICTURE_PIECE_CHARS, and one picture is drawn at a time.
  const big = countingRasteriser();
  const limit = limitBoard(big.r);
  limit.build("picture");
  await allBuilt(limit.store);
  console.log(`limit board: ${big.seen.documents} SVG documents for ${FRAMES} frames, ${big.seen.most} at once`);
  expect(big.seen.pictures).toBe(FRAMES);
  expect(big.seen.documents).toBe(FRAMES);
  expect(big.seen.most).toBe(1);
  const er = countingRasteriser();
  const erBoard = erLimitBoard(er.r);
  erBoard.build();
  await allBuilt(erBoard.store, ER_BOARD_KEYS);
  console.log(`ER limit board: ${er.seen.documents} SVG documents for ${ER_BOARD_KEYS.length} frames, ${er.seen.most} at once`);
  expect(er.seen.pictures).toBe(ER_BOARD_KEYS.length);
  // The ERD alone is cut: 3.4 M characters in pieces of 256 K, about 14.
  expect(er.seen.cut).toBe(1);
  expect(er.seen.documents).toBeLessThanOrEqual(ER_BOARD_KEYS.length - 1 + 16);
  expect(er.seen.most).toBe(1);
});
