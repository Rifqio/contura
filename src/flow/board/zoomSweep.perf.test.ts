// Plan F Task 9 (Decision 14): the release WebView's zoom sweep (Fit board at 10 percent, the zoom-in button to 400
// percent and back, 1.2 a step), replayed in node through what FlowTab runs for it: a plan for each step's view
// (`frameDraw`), then one `stepForms` step and one scene build an animation frame until the drawn forms are the plan,
// picture slices between them. Over B1's limit board (50 frames, 10,000 shapes, 1,000 sketches) and B3's ER limit
// board, both swept around their start as they open. Run alone through `npm run test:perf`.
import { afterEach, expect, test } from "vitest";
import type { ExportPalette } from "../../diagram/export/palette";
import { NODE_TOKENS } from "../../diagram/types";
import { board, FRAMES } from "../../lang/flow/fixtures/bigBoard";
import { bigBoardLayout, fullSketches } from "../../lang/flow/fixtures/bigBoardLayout";
import { ER_BOARD_KEYS, ER_BOARD_TEXT, ER_FLOW_FRAMES, erPositions } from "../../lang/flow/fixtures/erBoard";
import type { FrameResult } from "../../lang/flow/service";
import { createFlowService } from "../../lang/flow/service";
import type { BoardLayout, TextSize } from "./boardLayout";
import { type DrawnForms, type FrameDrawPlan, frameDraw, sketchesFar, stepForms, SWAP_BUDGET_SHAPES, withLiveReal } from "./boardDetail";
import { boardFrameId, type BoardSceneOut, createBoardScene } from "./boardScene";
import { createPictureStore, pictureHooks } from "./framePicture";
import { createSketchPictureStore, createSketchTiles } from "./sketchPicture";
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
const task = () => new Promise<void>((r) => setTimeout(r, 0));
const gc = () => (globalThis as unknown as { gc(): void }).gc();
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;
/** The canvas beside the code pane in a 1920 by 1080 window. */
const W = 1300;
const H = 850;
/** Animation frames a zoom step is given (the live sweep is a step each 0.5 s). */
const FRAMES_A_STEP = 30;

afterEach(() => {
  pictureHooks.onEntry = undefined;
});

/** The sweep's zooms: Fit board (10 percent), up by the zoom button's 1.2 to 400 percent, and back down to 10. */
function sweepZooms(): number[] {
  const up = [0.1];
  while (up[up.length - 1] < 4) up.push(Math.min(4, up[up.length - 1] * 1.2));
  return [...up, ...up.slice(0, -1).reverse()];
}

interface StepReading {
  zoom: number;
  /** The most static shapes and lines one animation frame mounted. */
  mounted: number;
  /** The longest plan, step and build of one animation frame, in ms. */
  ms: number;
}

/**
 * A board swept as FlowTab sweeps it, from its open at Fit board. `retained` reads what the scene and the pictures hold
 * at a point of the sweep.
 */
async function sweep(frames: readonly FrameResult[], layout: BoardLayout, keys: readonly string[]) {
  const scene = createBoardScene("modern");
  // The WebView's picture path (Task 9 fix 3): bitmaps kept as PNGs, and the sketch layer's tiles while body text is far.
  const store = createPictureStore({ palette: () => LIGHT, loadIcons: async () => new Map(), onReady: () => {}, sync: true, rasterise: blankRasteriser, dpr: () => 1 });
  const sketchStore = createSketchPictureStore({ palette: () => LIGHT, loadIcons: async () => new Map(), onReady: () => {}, rasterise: blankRasteriser, dpr: () => 1 });
  const tiler = createSketchTiles();
  const askTiles = () => {
    const tiles = tiler.of(layout.sketches);
    sketchStore.prune(new Set(tiles.map((t) => t.id)));
    for (const t of tiles) sketchStore.url(t.id, tiler.keyOf(t), t);
  };
  let built = 0;
  // Frames only: the tiles are not the frames' pictures.
  pictureHooks.onEntry = (id) => {
    if (id.startsWith("\u0000board:")) built++;
  };
  // The open: no view yet, every static frame pictured at once.
  let out: BoardSceneOut = scene.build(frames, layout, keys, null, null, [], undefined, null, store);
  const openPictures = built;
  let plan: FrameDrawPlan | null = null;
  let drawn: DrawnForms | null = null;
  const facts = () => {
    const sizes: TextSize[] = out.boxes.map((b) => (b.key === null ? "m" : (layout.frames.get(b.key)?.textSize ?? "m")));
    const id = (k: number) => boardFrameId(out.boxes[k].key!);
    const shapes = out.boxes.map((_, k) => out.children.get(id(k))?.length ?? 0);
    const parts = out.boxes.map((_, k) => shapes[k] + (out.lines.get(id(k)) ?? 0));
    const centres = out.boxes.map((b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 }));
    return { sizes, shapes, parts, centres };
  };
  /** Static shapes and lines drawn now (the frames' boxes and pictures, the sketches and the layer are not counted). */
  const staticParts = (o: BoardSceneOut) => o.nodes.filter((n) => n.id.startsWith("\u0000in:") && !n.id.endsWith("\u0000picture")).length + o.edges.length;
  const retained = () => ({
    memo: scene.memoSize(),
    boxes: scene.boxMemoSize(),
    sketches: scene.sketchMemoSize(),
    pictureBytes: store.bytes(),
    tileBytes: sketchStore.bytes(),
    nodes: out.nodes.length,
    edges: out.edges.length,
  });
  // Fit board opens at the board's start (`fitFromStart`), a margin in: zoom steps go around the view's centre.
  const centre = { x: -300 + W / 2 / 0.1, y: 550 };
  const viewAt = (zoom: number) => ({ x: centre.x - W / 2 / zoom, y: centre.y - H / 2 / zoom, w: W / zoom, h: H / zoom, zoom });
  /** Every picture and tile built as far as it goes: the bitmaps of the open's pictures included. */
  const settled = async () => {
    for (let i = 0; i < 20_000; i++) {
      const tiles = tiler.of(layout.sketches);
      if (out.boxes.every((b) => store.ready(boardFrameId(b.key!))) && tiles.every((t) => sketchStore.ready(t.id))) break;
      await task();
    }
    // Their bitmaps after them (the open's pictures are drawn in place): until what the stores hold stops changing.
    for (let i = 0, still = 0, last = -1; i < 20_000 && still < 100; i++) {
      const now = store.bytes() + sketchStore.bytes();
      still = now === last ? still + 1 : 0;
      last = now;
      await task();
    }
  };
  const readings: StepReading[] = [];
  let atFit: ReturnType<typeof retained> | null = null;
  let fitHeap = 0;
  for (const zoom of sweepZooms()) {
    const reading: StepReading = { zoom, mounted: 0, ms: 0 };
    const f = facts();
    const t0 = performance.now();
    const next = frameDraw({ boxes: out.boxes, sizes: f.sizes, shapes: f.shapes, live: null, dragging: null, dragForm: null, view: viewAt(zoom), wasFar: plan?.far ?? new Set() });
    let first = performance.now() - t0;
    if (sketchesFar(next.far, false)) askTiles();
    if (!plan || plan.key !== next.key) {
      plan = next;
      for (let frame = 0; frame < FRAMES_A_STEP; frame++) {
        const t1 = performance.now();
        const base = withLiveReal(drawn ?? { form: new Map(out.boxes.map((b) => [b.index, "picture" as const])), mounted: new Map() }, null);
        const target: FrameDrawPlan = plan;
        const ready = (i: number) => {
          const want = target.form.get(i);
          return want === undefined || want === "real" || scene.pictureReady(i, want, store);
        };
        const g = facts();
        drawn = stepForms(plan, base, ready, g.parts, g.centres, centre, SWAP_BUDGET_SHAPES);
        const before = staticParts(out);
        out = scene.build(frames, layout, keys, null, null, [], undefined, drawn, store);
        reading.ms = Math.max(reading.ms, performance.now() - t1 + first);
        first = 0;
        reading.mounted = Math.max(reading.mounted, staticParts(out) - before);
        await task();
      }
    }
    readings.push(reading);
    if (atFit === null) {
      await settled();
      atFit = retained();
      await task();
      gc();
      fitHeap = heapUsed();
    }
  }
  await settled();
  gc();
  return { readings, atFit: atFit!, fitHeap, back: retained(), backHeap: heapUsed(), openPictures, rebuilt: built - openPictures, plan: plan!, out };
}

function limitBoard() {
  const r = createFlowService().parse("board", board());
  return { frames: r.frames, layout: bigBoardLayout(fullSketches()), keys: KEYS };
}

function erLimitBoard() {
  const r = createFlowService().parse("board", ER_BOARD_TEXT);
  const layout = bigBoardLayout();
  for (let k = ER_FLOW_FRAMES; k < FRAMES; k++) layout.frames.delete(`Area ${k}`);
  layout.frames.set("Schema", { at: { x: ER_FLOW_FRAMES * 5200, y: 0 }, nodes: erPositions(), style: "modern", direction: "TB" });
  return { frames: r.frames, layout, keys: ER_BOARD_KEYS };
}

function report(name: string, s: Awaited<ReturnType<typeof sweep>>) {
  const worst = s.readings.reduce((a, b) => (b.ms > a.ms ? b : a));
  const most = s.readings.reduce((a, b) => (b.mounted > a.mounted ? b : a));
  console.log(
    `${name} sweep: ${s.readings.length} steps; worst frame's plan, step and build ${worst.ms.toFixed(2)} ms at ${(worst.zoom * 100).toFixed(0)}%; ` +
      `most parts mounted in a frame ${most.mounted} at ${(most.zoom * 100).toFixed(0)}%; pictures ${s.openPictures} at open, ${s.rebuilt} rebuilt; ` +
      `at Fit ${JSON.stringify(s.atFit)} heap ${(s.fitHeap / MB).toFixed(1)} MB; back ${JSON.stringify(s.back)} heap ${(s.backHeap / MB).toFixed(1)} MB`,
  );
}

for (const [name, make] of [
  ["limit board", limitBoard],
  ["ER limit board", erLimitBoard],
] as const) {
  test(`a_zoom_sweep_of_the_${name.replace(/ /g, "_")}_stays_in_its_frame_budget_and_returns_to_its_fit_memory`, async () => {
    const b = make();
    const s = await sweep(b.frames, b.layout, b.keys);
    report(name, s);
    // Every animation frame mounts at most the swap budget of static shapes and lines (lines once came all at once with
    // a frame's last shape: 300 labelled lines in one frame at the crossing).
    for (const r of s.readings) expect(r.mounted, `${(r.zoom * 100).toFixed(0)}%`).toBeLessThanOrEqual(SWAP_BUDGET_SHAPES);
    // Readable frames were drawn real on the way (the sweep crossed the line), and none is left real at Fit.
    expect(s.readings.some((r) => r.mounted > 0)).toBe(true);
    expect([...s.plan.form.values()].every((f) => f === "picture")).toBe(true);
    // The plan's own work per animation frame stays far under one 60 Hz frame (the gate's 50 ms is the whole frame's).
    for (const r of s.readings) expect(r.ms, `${(r.zoom * 100).toFixed(0)}%`).toBeLessThan(8);
    // No picture is built again in a sweep: every one was built at open and nothing it shows changed.
    expect(s.rebuilt).toBe(0);
    // Back at Fit, what the scene and the pictures hold is what they held at Fit: memos, picture bytes, nodes, lines.
    expect(s.back).toEqual(s.atFit);
    // And the heap after a collection is back within 2 MB of its Fit reading.
    expect(s.backHeap - s.fitHeap).toBeLessThan(2 * MB);
  }, 300_000);
}
