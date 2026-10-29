// B4 Task 4 gates: the board composer at the limit (A5's board: 50 frames, 10,000 shapes, 15,000 links, with B1's
// sketch caps: 1,000 sketches, 50,000 pen points, 100,000 characters). Time, size, heap and the one-scene rule
// (Decisions 10 and 12, R14, R20, A9). Thresholds are provisional until Task 7 measures the release build, and are
// never raised. Run alone through `npm run test:perf`.
import { expect, test } from "vitest";
import { SVG_MAX_BYTES } from "../../../diagram/export/limits";
import { svgPreviewUrl } from "../../../diagram/export/png";
import type { ExportPalette } from "../../../diagram/export/palette";
import type { Scene } from "../../../diagram/export/scene";
import { NODE_TOKENS } from "../../../diagram/types";
import { splitFrames } from "../../../lang/flow/board";
import { board, FRAMES } from "../../../lang/flow/fixtures/bigBoard";
import { bigBoardLayout, FRAME_STEP, fullSketches, SKETCH_COUNT, SKETCH_POINTS, SKETCH_TEXT } from "../../../lang/flow/fixtures/bigBoardLayout";
import { parseFlow } from "../../../lang/flow/parse";
import { bestMedian } from "../../../lang/flow/perfGate";
import type { BoardLayout, Sketch } from "../boardLayout";
import type { BoardPublishInput, PublishFrame } from "./boardPublish";
import { boardSource, type ComposedBoard, composeBoard, composeHooks, composeSteps } from "./boardSvg";

const gc = (globalThis as unknown as { gc?: () => void }).gc;
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;
const MB = 1024 * 1024;
/** Prints a gate's measured number past Vitest's console capture, so it shows in every perf run (Task 7 re-measures). */
const report = (line: string) => (globalThis as unknown as { process: { stderr: { write(s: string): void } } }).process.stderr.write(`${line}\n`);
/** Node's WeakRef; the project's lib (ES2020) does not declare it. */
interface Weak<T> {
  deref(): T | undefined;
}
const WeakRefOf = (globalThis as unknown as { WeakRef: new <T extends object>(target: T) => Weak<T> }).WeakRef;

/** Every colour the export reads, as literals: node has no `document` to read the tokens from. */
const PALETTE: ExportPalette = {
  surface: "#ffffff",
  canvas: "#fafafa",
  text: "#1f2328",
  subtle: "#59636e",
  border: "#d1d9e0",
  type: "#0550ae",
  keyword: "#cf222e",
  nodes: Object.fromEntries(Object.keys(NODE_TOKENS).map((k) => [k, { fill: "#f6f8fa", stroke: "#d1d9e0" }])) as ExportPalette["nodes"],
  iconTile: "#ffffff",
  group: "#8c959f",
  groupTint: "#f6f8fa",
  strongBorder: "#8c959f",
  panel: "#f6f8fa",
  muted: "#3d444d",
  faint: "#818b98",
  keyMark: "#9a6700",
  colours: {
    accent: { fill: "#ddf4ff", stroke: "#0969da", text: "#1f2328" },
    info: { fill: "#ddf4ff", stroke: "#0969da", text: "#1f2328" },
    success: { fill: "#dafbe1", stroke: "#1a7f37", text: "#1f2328" },
    warning: { fill: "#fff8c5", stroke: "#9a6700", text: "#1f2328" },
    danger: { fill: "#ffebe9", stroke: "#d1242f", text: "#1f2328" },
    muted: { fill: "#f6f8fa", stroke: "#8c959f", text: "#59636e" },
  },
};

/** One icon for every cloud service and icon sketch: a pack-sized SVG logo (about 3 KB) as a base64 data: image. */
const ICON = "aws-s3";
const LOGO = `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${'<path d="M8 8h48v48H8z" fill="#3f8624"/>'.repeat(70)}</svg>`)}`;
const ICONS = new Map([[ICON, { url: LOGO, outline: true }]]);

/** Cloud frame `k`: 167 services on the one icon, chained by 166 links. */
const CLOUD_SERVICES = 167;
function cloudFrame(k: number): string {
  const lines = [`diagram cloud "Area ${k}"`, ""];
  for (let i = 0; i < CLOUD_SERVICES; i++) lines.push(`Svc ${i} [icon: ${ICON}]`);
  for (let i = 1; i < CLOUD_SERVICES; i++) lines.push(`Svc ${i - 1} > Svc ${i}`);
  return `${lines.join("\n")}\n`;
}

/** The limit board as the composer gets it (R20, A9). */
function limitBoard(): { input: BoardPublishInput; shapes: number } {
  const sketches: Sketch[] = fullSketches();
  // Ten of the rectangles become icon sketches of the same icon: the counts stay at the caps.
  let turned = 0;
  for (const s of sketches) {
    if (turned === 10) break;
    if (s.kind !== "rect") continue;
    Object.assign(s, { kind: "icon", icon: ICON, w: 64, h: 64 });
    turned++;
  }
  const layout: BoardLayout = bigBoardLayout(sketches);
  const text = board();
  const slices = splitFrames(text);
  expect(slices).toHaveLength(FRAMES);
  const frames: PublishFrame[] = [];
  let shapes = 0;
  slices.forEach((slice, k) => {
    const key = `Area ${k}`;
    const cloud = k < 3;
    const doc = parseFlow(cloud ? cloudFrame(k) : text.slice(slice.from, slice.to)).doc!;
    expect(doc.title).toBe(key);
    const entry = layout.frames.get(key)!;
    if (cloud) {
      // The cloud frame's own entry on the fixture's 220 by 100 grid.
      const nodes = Object.create(null) as Record<string, { x: number; y: number }>;
      for (let i = 0; i < CLOUD_SERVICES; i++) nodes[`Svc ${i}`] = { x: (i % 10) * 220, y: Math.floor(i / 10) * 100 };
      layout.frames.set(key, { ...entry, nodes });
    }
    const e = layout.frames.get(key)!;
    shapes += doc.nodes.length + doc.groups.length;
    frames.push({
      key,
      index: k,
      title: key,
      kind: doc.kind,
      at: e.at,
      box: { x: e.at.x, y: e.at.y, w: FRAME_STEP - 400, h: 1200 },
      doc,
      layout: { version: 1, nodes: e.nodes, style: e.style, direction: e.direction },
      textScale: 1,
      notation: "crow",
      live: false,
    });
  });
  const input: BoardPublishInput = {
    frames,
    nothingDrawn: 0,
    clashing: 0,
    sketches: layout.sketches,
    iconTitles: new Map([[ICON, "Amazon S3"]]),
    frameIndex: null,
    shapes: [],
    sketchIds: [],
    onScreen: { x: 0, y: 0, w: 0, h: 0 },
  };
  return { input, shapes };
}

const compose = (input: BoardPublishInput) => composeBoard(input, "board", PALETTE, "light", ICONS, true);

test("the_limit_board_is_at_the_caps", () => {
  const { input, shapes } = limitBoard();
  expect(input.frames).toHaveLength(FRAMES);
  expect(shapes).toBeLessThanOrEqual(10_000);
  expect(shapes).toBeGreaterThan(9_800);
  expect(input.sketches).toHaveLength(SKETCH_COUNT);
  expect(input.sketches.reduce((n, s) => n + (s.points?.length ?? 0), 0)).toBe(SKETCH_POINTS);
  expect(input.sketches.reduce((n, s) => n + (s.text?.length ?? 0), 0)).toBe(SKETCH_TEXT);
  expect(input.sketches.filter((s) => s.kind === "icon")).toHaveLength(10);
  report(`[B4 Task 4] limit board: ${input.frames.length} frames, ${shapes} shapes, ${input.sketches.length} sketches`);
});

test("composes_and_writes_the_limit_board_under_300ms", () => {
  // Final review minor 3: the gate times what opening the dialog runs, the compose and the SVG written from it, as
  // the dialog draws it (`boardSource(...).draw`, then `svg`). The threshold is lowered from 600 ms to 300 ms after B4 Task 7 measured 66 to 68 ms, never raised.
  const { input } = limitBoard();
  const opts = { padding: 32, background: "theme" as const, mark: true };
  const open = () => {
    const drawn = boardSource(input, ICONS, "light").draw("board", PALETTE, true);
    return { drawn, svg: drawn.svg(opts) };
  };
  let out = open();
  const median = bestMedian(() => {
    out = open();
  }, 3, 5);
  // Not gated, and fewer runs so the test keeps its time limit: the compose alone, as the gate timed it before, and
  // the preview's data URL on top (TextEncoder, chunked btoa), for Task 7's RSS reading.
  const composeOnly = bestMedian(() => {
    compose(input);
  }, 1, 5);
  const withPreview = bestMedian(() => {
    svgPreviewUrl(open().svg);
  }, 1, 3);
  report(`[B4 Task 4] compose median ${composeOnly.toFixed(1)} ms; compose + SVG write ${median.toFixed(1)} ms; + preview URL ${withPreview.toFixed(1)} ms`);
  expect(out.drawn.frames).toBe(FRAMES);
  expect(out.drawn.tooLarge).toBe(false);
  expect(out.svg.length).toBeGreaterThan(1_000_000);
  expect(median).toBeLessThan(300);
});

test("the_limit_board_fits_the_svg_cap", () => {
  const { input } = limitBoard();
  const out = compose(input);
  report(`[B4 Task 4] limit board SVG ${out.bytes} bytes (${(out.bytes / MB).toFixed(2)} MB; body ${out.body.length} chars, defs ${out.defs.length} chars)`);
  expect(out.tooLarge).toBe(false);
  expect(out.frames).toBe(FRAMES);
  expect(out.bytes).toBeLessThan(SVG_MAX_BYTES);
  // The icon is drawn once per size it is drawn at (Decision 9's `icon-<h>-<size>`: 48 on a service, 40 on an icon
  // sketch), in the one <defs>, with the one hairline filter.
  const images = [...out.defs.matchAll(/<image id="([^"]+)" href="([^"]+)" width="(\d+)"/g)];
  expect(images.map((m) => m[3]).sort()).toEqual(["40", "48"]);
  for (const m of images) expect(m[2]).toBe(LOGO);
  expect(out.defs.match(/<defs>/g)).toHaveLength(1);
  expect(out.defs.match(/<filter\b/g)).toHaveLength(1);
  expect(out.body).not.toContain(LOGO);
  // 3 by 167 services and the 10 icon sketches use it.
  expect(out.body.match(/<use\b/g)).toHaveLength(3 * CLOUD_SERVICES + 10);
});

test("composing_does_not_grow_the_heap", () => {
  expect(typeof gc).toBe("function");
  const { input } = limitBoard();
  let out: ComposedBoard | null = null;
  for (let run = 0; run < 3; run++) out = compose(input);
  out = null;
  gc!();
  const warm = heapUsed();
  for (let run = 0; run < 20; run++) out = compose(input);
  out = null;
  gc!();
  const growth = heapUsed() - warm;
  report(`[B4 Task 4] retained growth after 20 composes ${(growth / MB).toFixed(2)} MB`);
  expect(out).toBeNull();
  expect(growth).toBeLessThan(2 * MB);
});

test("composing_holds_one_scene_at_a_time", async () => {
  expect(typeof gc).toBe("function");
  const { input } = limitBoard();
  const refs: Weak<Scene>[] = [];
  let during49 = 0;
  gc!();
  const before = heapUsed();
  composeHooks.onScene = (index, scene) => {
    refs[index] = new WeakRefOf(scene);
    if (index === FRAMES - 1) {
      gc!();
      during49 = heapUsed();
    }
  };
  let checked = false;
  try {
    const steps = composeSteps(input, "board", PALETTE, "light", ICONS, true);
    for (let r = steps.next(); !r.done; r = steps.next()) {
      // A macrotask between frames, so the WeakRefs made in this one may clear.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (r.value === FRAMES - 1) {
        gc!();
        for (let k = 0; k <= FRAMES - 3; k++) expect(refs[k].deref(), `frame ${k}'s scene`).toBeUndefined();
        checked = true;
      }
    }
  } finally {
    composeHooks.onScene = undefined;
  }
  expect(checked).toBe(true);
  expect(refs).toHaveLength(FRAMES);
  // A provisional extra: what the composer holds while frame 49's scene is alive (strings so far, edges, one scene).
  report(`[B4 Task 4] heap during frame 49 ${((during49 - before) / MB).toFixed(2)} MB over the board's input`);
});

test("a_dropped_board_source_is_collected", async () => {
  // B4 Task 5 (R15): the dialog lets go of its source and drawing on close; nothing else may hold them, so the
  // composed board (about 8 MB of strings at the limit) goes with them once the file is written.
  expect(typeof gc).toBe("function");
  const { input } = limitBoard();
  gc!();
  const before = heapUsed();
  const made = (() => {
    const source = boardSource(input, ICONS, "light");
    const drawn = source.draw("board", PALETTE, true);
    // As Save as does: the file's text, written and let go.
    const svg = drawn.svg({ padding: 32, background: "theme", mark: true });
    expect(svg.length).toBeGreaterThan(1_000_000);
    expect(drawn.tooLarge).toBe(false);
    return { source: new WeakRefOf(source), drawn: new WeakRefOf(drawn) };
  })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc!();
  expect(made.source.deref(), "the source").toBeUndefined();
  expect(made.drawn.deref(), "the drawing").toBeUndefined();
  const growth = heapUsed() - before;
  report(`[B4 Task 5] heap after a dropped board source ${(growth / MB).toFixed(2)} MB`);
  expect(growth).toBeLessThan(2 * MB);
});
