// Plan E Task 9 (Decision 16): the sequence restyle at the sequence limit (fixtures/bigSequence.ts: 2,000
// participants with icons and colours, 3,000 messages, 200 blocks 3 deep, 300 activations, numbering with a restart).
// Its layout, its canvas graph, its Publish, its heap under relayout and the measure cache; and, Plan F's way, the far
// picture of it (pieces of PICTURE_PIECE_CHARS, slices of PICTURE_SLICE_MS, the bitmap's bytes) and the limit board it
// sits on (40 flowchart frames and the sequence, 10,000 shapes). Run alone through `npm run test:perf` (it needs
// --expose-gc). Every budget is provisional until Task 10 measures the release build, and is never raised.
import type { Node } from "@xyflow/react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { ExportPalette } from "../diagram/export/palette";
import { iconRefs, sceneBody, svgDefs } from "../diagram/export/svg";
import { NODE_TOKENS } from "../diagram/types";
import { bigBoardLayout } from "../lang/flow/fixtures/bigBoardLayout";
import {
  bigSequence,
  SEQ_ACTIVATIONS,
  SEQ_BLOCKS,
  SEQ_BOARD_KEYS,
  SEQ_FLOW_FRAMES,
  SEQ_ICONS,
  SEQ_MESSAGES,
  SEQ_PARTICIPANTS,
  SEQ_TITLE,
  seqBoardText,
} from "../lang/flow/fixtures/bigSequence";
import { type FlowDoc, MAX_BOARD_SHAPES, shownName } from "../lang/flow/model";
import { parseFlow } from "../lang/flow/parse";
import { bestMedian } from "../lang/flow/perfGate";
import { MESSAGES } from "../lang/flow/problems";
import { createFlowService } from "../lang/flow/service";
import { type BoardLayout, drawnBox } from "./board/boardLayout";
import { type DrawnForms, PICTURE_SLICE_MS } from "./board/boardDetail";
import { boardFrameId, createBoardScene } from "./board/boardScene";
import { createPictureStore, PICTURE_MAX_SCALE, PICTURE_PIECE_CHARS, type PictureInput, type PictureRaster, pictureRasterSize, pictureSvgSteps, type Rasteriser, svgPieceSteps } from "./board/framePicture";
import { buildFlowGraph, drawnKind, nodeSize } from "./flowNodes";
import { flowScene, type SceneIcon } from "./flowScene";
import { fixedLayout, labelCacheSize, messageLabelW, setLabelMeasure } from "./kindLayout";
import { emptyPositions } from "./layout";
import { PALETTE as PRESETS } from "./palette";
import { SEQ_LINES, SEQ_THEME } from "./seqColour";
import { blankRasteriser } from "../test/pictureRaster";

const MB = 1024 * 1024;
const gc = () => (globalThis as unknown as { gc(): void }).gc();
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;
const task = () => new Promise<void>((r) => setTimeout(r, 0));

/** The light theme as the sequence draws it: SEQ_THEME's surface, canvas and text, SEQ_LINES' line colours. */
const T = SEQ_THEME.light;
const L = SEQ_LINES.light;
const PALETTE: ExportPalette = {
  surface: T.surface,
  canvas: T.canvas,
  text: T.text,
  subtle: L.muted,
  muted: L.muted,
  faint: L.muted,
  keyMark: L.warning,
  border: L.muted,
  type: L.warning,
  keyword: L.danger,
  nodes: { ...(Object.fromEntries(Object.keys(NODE_TOKENS).map((k) => [k, { fill: T.surface, stroke: L.muted }])) as ExportPalette["nodes"]), participant: { fill: T.surface, stroke: L.participant }, actor: { fill: T.surface, stroke: L.actor } },
  iconTile: T.surface,
  group: L.success,
  groupTint: T.canvas,
  strongBorder: L.muted,
  panel: T.canvas,
  colours: Object.fromEntries(PRESETS.map((p) => [p, { fill: T.surface, stroke: L[p], text: T.text }])) as ExportPalette["colours"],
};

/** Each of the eight icon names as a fake data: URL. */
const ICONS = new Map<string, SceneIcon>(SEQ_ICONS.map((n) => [n, { url: `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>${n}</title><path d="M3 3h18v18H3z"/></svg>`)}` }]));

const TEXT = bigSequence();
let DOC: FlowDoc;
const size = (doc: FlowDoc) => (n: FlowDoc["nodes"][number]) => nodeSize(drawnKind(n.kind, doc.kind, n.name), "modern", shownName(n), n.attrs.id, n, 1);

beforeAll(() => {
  // A fixed measure: 7 px a letter in every font, as no canvas measures in node.
  setLabelMeasure((s) => s.length * 7);
  const r = parseFlow(TEXT);
  DOC = r.doc!;
});
afterAll(() => setLabelMeasure(null));
afterEach(() => vi.restoreAllMocks());

const graphOf = (doc: FlowDoc) => buildFlowGraph(doc, emptyPositions(), "modern", { textScale: 1 });

test("the_sequence_fixture_is_at_its_limit_and_parses_clean", () => {
  const r = parseFlow(TEXT);
  expect(r.problems).toEqual([]);
  const d = r.doc!;
  expect(d.kind).toBe("sequence");
  expect(d.nodes).toHaveLength(SEQ_PARTICIPANTS);
  expect(d.nodes.every((n) => n.attrs.icon && n.attrs.color)).toBe(true);
  expect(new Set(d.nodes.map((n) => n.attrs.icon)).size).toBe(8);
  expect(new Set(d.nodes.map((n) => n.attrs.color)).size).toBe(8);
  expect(d.links).toHaveLength(SEQ_MESSAGES);
  const lens = d.links.map((l) => l.label?.length ?? 0);
  expect(Math.min(...lens)).toBe(4);
  expect(Math.max(...lens)).toBe(40);
  expect(d.links.filter((l) => l.from === l.to)).toHaveLength(SEQ_MESSAGES / 50);
  const lane = new Map(d.nodes.map((n, i) => [n.name, i]));
  expect(d.links.filter((l) => Math.abs(lane.get(l.to)! - lane.get(l.from)!) >= 5).length).toBeGreaterThanOrEqual(SEQ_MESSAGES / 40 - SEQ_MESSAGES / 200);
  expect(d.frames).toHaveLength(SEQ_BLOCKS);
  expect(Math.max(...d.frames!.map((f) => f.depth))).toBe(2);
  expect(d.frames!.every((f) => f.color)).toBe(true);
  expect(d.activations).toHaveLength(SEQ_ACTIVATIONS);
  expect(d.autonumber).toHaveLength(2);
  const lay = fixedLayout(d, size(d), { textScale: 1 })!;
  const numbers = lay.seq!.messages.map((m) => m.number?.n);
  expect(numbers[0]).toBe(1);
  expect(numbers[SEQ_MESSAGES / 2]).toBe(500);
  expect(numbers[SEQ_MESSAGES - 1]).toBe(500 + SEQ_MESSAGES / 2 - 1);
});

test("layout_at_the_limit_under_40ms", () => {
  const median = bestMedian(() => fixedLayout(DOC, size(DOC), { textScale: 1 }));
  console.log(`sequence layout at the limit: ${median.toFixed(2)} ms`);
  expect(median).toBeLessThan(40);
});

test("graph_at_the_limit_under_80ms", () => {
  const g = graphOf(DOC);
  // Plan F's budget counts shapes (nodes) and parts (nodes and lines): one lanes node for every lifeline and bar, one
  // box and one caption a block, one node a participant; one line a message.
  expect(g.nodes.filter((n) => n.id === "\u0000lanes")).toHaveLength(1);
  expect(g.nodes).toHaveLength(SEQ_PARTICIPANTS + SEQ_BLOCKS + SEQ_BLOCKS + 1);
  expect(g.edges).toHaveLength(SEQ_MESSAGES);
  const median = bestMedian(() => graphOf(DOC));
  console.log(`sequence graph at the limit: ${median.toFixed(2)} ms, ${g.nodes.length} nodes, ${g.edges.length} lines`);
  expect(median).toBeLessThan(80);
});

test("publish_at_the_limit_under_150ms_and_8_MB", () => {
  let body = "";
  let defs = "";
  const median = bestMedian(
    () => {
      const scene = flowScene(DOC, {}, "modern", ICONS);
      const refs = iconRefs();
      body = sceneBody(scene, PALETTE, refs);
      defs = svgDefs(PALETTE, { hairline: null, icons: refs.entries() });
    },
    3,
    6,
  );
  const bytes = new TextEncoder().encode(defs + body).length;
  console.log(`sequence publish at the limit: ${median.toFixed(2)} ms, ${(bytes / MB).toFixed(2)} MB`);
  // Each participant's icon in its head and its foot, every one a <use> of the eight images in the defs.
  expect(body.match(/<use\b/g)).toHaveLength(2 * SEQ_PARTICIPANTS);
  expect(defs.match(/<image\b/g)).toHaveLength(8);
  expect(median).toBeLessThan(150);
  expect(bytes).toBeLessThan(8 * MB);
});

test("relayout_does_not_grow_the_heap", () => {
  // One label changed per run, as typing in it would: the text parsed, laid out and drawn again, 100 times.
  const at = TEXT.indexOf(": m7 ") + 2;
  let kept: unknown = null;
  let at10 = 0;
  for (let run = 1; run <= 100; run++) {
    const text = `${TEXT.slice(0, at)}r${run} ${TEXT.slice(at)}`;
    const doc = parseFlow(text).doc!;
    kept = [fixedLayout(doc, size(doc), { textScale: 1 }), graphOf(doc)];
    if (run === 10) {
      gc();
      at10 = heapUsed();
    }
  }
  gc();
  const growth = heapUsed() - at10;
  console.log(`sequence relayout heap growth, run 10 to 100: ${(growth / MB).toFixed(2)} MB`);
  expect(kept).not.toBeNull();
  expect(growth).toBeLessThan(2 * MB);
}, 60_000);

test("the_measure_cache_stays_bounded", () => {
  for (let i = 0; i < 5000; i++) messageLabelW(`label ${i}`, "message");
  expect(labelCacheSize("message")).toBeLessThanOrEqual(4000);
});

// ----- Plan F's far picture of the sequence (rebase checkpoint 3.4).

/** The sequence's picture input: what the board's picture store draws it from, at its drawn box. */
function pictureInput(softText: boolean): PictureInput {
  const local = drawnBox(graphOf(DOC).nodes as Node[]);
  return { doc: DOC, layout: { nodes: emptyPositions(), style: "modern" }, textScale: 1, notation: "crow", local, softText };
}

/** Runs `steps` to its end, timing each step; its result and the longest step in ms. */
function timedSteps<T>(steps: Generator<void, T>): { value: T; worst: number; count: number } {
  let worst = 0;
  let count = 0;
  for (;;) {
    const t0 = performance.now();
    const r = steps.next();
    worst = Math.max(worst, performance.now() - t0);
    count++;
    if (r.done) return { value: r.value, worst, count };
  }
}

/**
 * Most pieces of PICTURE_PIECE_CHARS the sequence's picture is cut into: each an SVG document WebKit keeps. One element
 * a part made 15 (soft, 3.7 M characters) and 16 (words, 4 M); a path a style (PictureSequence) makes 6 (1.33 M) and 8
 * (1.77 M). Provisional until Task 10's live run, never raised.
 */
const PIECES = { soft: 6, words: 8 };

test("the_sequence_picture_is_few_pieces_in_short_steps", () => {
  // Warm the writer's code paths once.
  timedSteps(pictureSvgSteps(pictureInput(true), PALETTE, ICONS));
  for (const softText of [true, false]) {
    const a = pictureInput(softText);
    // The best of three builds' longest step (ruling P8: noise, a collection most of all, only ever adds time).
    const runs = [0, 1, 2].map(() => timedSteps(pictureSvgSteps(a, PALETTE, ICONS)));
    const svg = runs.reduce((best, r) => (r.worst < best.worst ? r : best));
    const pieces = timedSteps(svgPieceSteps(svg.value));
    const px = pictureRasterSize(a.local, 1, 1);
    const bitmap = px.w * px.h * 4;
    console.log(
      `sequence picture, ${softText ? "soft" : "words"}: ${(svg.value.length / 1000).toFixed(0)} K characters in ${pieces.value.length} pieces of ${PICTURE_PIECE_CHARS}; ` +
        `${svg.count} steps, worst ${svg.worst.toFixed(2)} ms (pieces worst ${pieces.worst.toFixed(2)} ms); bitmap ${px.w} x ${px.h}, ${(bitmap / MB).toFixed(2)} MB at most ${PICTURE_MAX_SCALE} a unit`,
    );
    expect(svg.worst).toBeLessThan(PICTURE_SLICE_MS);
    expect(pieces.worst).toBeLessThan(PICTURE_SLICE_MS);
    expect(pieces.value.length).toBeLessThanOrEqual(PIECES[softText ? "soft" : "words"]);
    expect(bitmap).toBeLessThanOrEqual(4 * MB);
  }
});

// ----- The sequence's limit board: 40 flowchart frames of A5's board and the sequence, every frame a picture.

/** The board's layout in memory: A5's first 40 frames, and the sequence to their right. */
function seqBoardLayout(): BoardLayout {
  const b = bigBoardLayout();
  for (let k = SEQ_FLOW_FRAMES; k < 50; k++) b.frames.delete(`Area ${k}`);
  b.frames.set(SEQ_TITLE, { at: { x: SEQ_FLOW_FRAMES * 5200, y: 0 }, nodes: emptyPositions(), style: "modern", direction: "TB" });
  return b;
}

/** Counts what the WebView would decode (framePicture.perf.test.ts `countingRasteriser`). */
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
    draw: (url, w, h) => counted(1, blankRasteriser.draw(url, w, h)),
    drawPieces: (urls, w, h) => counted(urls.length, blankRasteriser.draw(urls[0], w, h)),
  };
  return { r, seen };
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

test("the_sequence_limit_board_is_at_the_limit", () => {
  const r = createFlowService().parse("board", seqBoardText());
  expect(r.frames.map((f) => f.title)).toEqual(SEQ_BOARD_KEYS);
  const shapes = r.frames.reduce((n, f) => n + (f.doc?.nodes.length ?? 0) + (f.doc?.groups.length ?? 0), 0);
  expect(shapes).toBe(MAX_BOARD_SHAPES);
  expect(r.problems.filter((p) => p.message === MESSAGES.tooManyShapes)).toEqual([]);
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
});

test("the_sequence_limit_board_builds_in_slices_one_picture_at_a_time", async () => {
  const tasks = timeTasks();
  const counting = countingRasteriser();
  const r = createFlowService().parse("board", seqBoardText());
  const b = seqBoardLayout();
  const scene = createBoardScene("modern");
  const store = createPictureStore({ palette: () => PALETTE, loadIcons: async () => ICONS, onReady: () => {}, rasterise: counting.r, dpr: () => 1 });
  const drawn: DrawnForms = { form: new Map(SEQ_BOARD_KEYS.map((_, k) => [k, "picture" as const])), mounted: new Map() };
  const build = () => scene.build(r.frames, b, SEQ_BOARD_KEYS, null, null, [], undefined, drawn, store);
  const allBuilt = async () => {
    for (let i = 0; i < 20_000 && !SEQ_BOARD_KEYS.every((k) => store.ready(boardFrameId(k))); i++) await task();
    expect(SEQ_BOARD_KEYS.every((k) => store.ready(boardFrameId(k)))).toBe(true);
  };
  // Warm the writer's and the rasteriser's code paths once (as framePicture.perf.test.ts does), then time a cold
  // board's worth of pictures.
  build();
  await allBuilt();
  store.prune(new Set());
  tasks.length = 0;
  counting.seen.documents = counting.seen.pictures = counting.seen.cut = counting.seen.most = 0;
  build();
  await allBuilt();
  build();
  const worst = Math.max(...tasks);
  console.log(
    `sequence limit board pictures: ${tasks.length} tasks, worst ${worst.toFixed(2)} ms; ${counting.seen.documents} SVG documents for ${SEQ_BOARD_KEYS.length} frames ` +
      `(${counting.seen.cut} cut), ${counting.seen.most} at once; ${(store.bytes() / MB).toFixed(2)} MB held`,
  );
  expect(worst).toBeLessThan(PICTURE_SLICE_MS);
  expect(counting.seen.pictures).toBe(SEQ_BOARD_KEYS.length);
  expect(counting.seen.most).toBe(1);
  // The flowchart frames are one document each; the sequence alone may be cut, into at most PIECES.soft.
  expect(counting.seen.documents).toBeLessThanOrEqual(SEQ_FLOW_FRAMES + PIECES.soft);
  // Plan F's node gate for the limit board (13 MB; 11.68 MB measured here).
  expect(store.bytes()).toBeLessThan(13 * MB);
}, 60_000);
