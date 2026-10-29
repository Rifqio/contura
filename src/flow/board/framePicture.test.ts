// Plan F Task 7 (Decision 7): a tiny frame draws as a cached picture of itself, built by the Publish writer at its local
// box, and the store holds one picture a frame, drops them all on a theme switch and builds in time slices after open.
import type { Node } from "@xyflow/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ExportPalette, ExportTheme } from "../../diagram/export/palette";
import { exportPalette } from "../../diagram/export/palette";
import type { Scene } from "../../diagram/export/scene";
import { frameOf, sceneBody } from "../../diagram/export/svg";
import { NODE_TOKENS } from "../../diagram/types";
import { FIXED_KINDS, type FlowDoc, type FlowNode } from "../../lang/flow/model";
import { parseFlow } from "../../lang/flow/parse";
import type { SceneIcon } from "../flowScene";
import { PAY } from "../fixtures/paySequence";
import { emptyPositions } from "../layout";
import flowBoardCss from "../../styles/flow-board.css?raw";
import paletteSource from "../../diagram/export/palette.ts?raw";
import { drawnBox, type FrameLayout, frameGraph, TEXT_SCALE, type TextSize } from "./boardLayout";
import { erCardH, erMetrics } from "../kindLayout";
import { ErBars } from "../kindNodes";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { PICTURE_SLICE_MS } from "./boardDetail";
import {
  browserRasteriser,
  createPictureStore,
  nextBandRows,
  oncePerFrame,
  PICTURE_BAND_MIN_ROWS,
  PICTURE_BAND_PIXELS,
  PICTURE_MAX_PIXELS,
  PICTURE_MAX_SCALE,
  PICTURE_MAX_SIDE,
  type PictureImage,
  type PictureInput,
  type PictureRaster,
  pictureHooks,
  pictureRasterSize,
  type PictureStore,
  pictureSvg,
  PICTURE_PIECE_CHARS,
  type Rasteriser,
  svgPieceSteps,
} from "./framePicture";
import { perfStep } from "../../perf/perfRecorder";

// The perf log's step sums, watched: a picture left as SVG is logged (Task 9 fix 4).
vi.mock("../../perf/perfRecorder", async (load) => {
  const real = await load<typeof import("../../perf/perfRecorder")>();
  return { ...real, perfStep: vi.fn(real.perfStep) };
});

const palette = (p: string): ExportPalette => ({
  surface: `#${p}0101`,
  canvas: `#${p}0202`,
  text: `#${p}0303`,
  subtle: `#${p}0404`,
  border: `#${p}0505`,
  type: `#${p}0606`,
  keyword: `#${p}0707`,
  nodes: Object.fromEntries(Object.keys(NODE_TOKENS).map((k, i) => [k, { fill: `#${p}1${i.toString(16)}00`, stroke: `#${p}2${i.toString(16)}00` }])) as ExportPalette["nodes"],
  iconTile: `#${p}1010`,
  group: `#${p}1111`,
  groupTint: `#${p}1212`,
  strongBorder: `#${p}1313`,
  panel: `#${p}1414`,
  muted: `#${p}1515`,
  faint: `#${p}1616`,
  keyMark: `#${p}1717`,
  colours: {
    accent: { fill: `#${p}a100`, stroke: `#${p}a200`, text: `#${p}0303` },
    info: { fill: `#${p}a300`, stroke: `#${p}a400`, text: `#${p}0303` },
    success: { fill: `#${p}a500`, stroke: `#${p}a600`, text: `#${p}0303` },
    warning: { fill: `#${p}a700`, stroke: `#${p}a800`, text: `#${p}0303` },
    danger: { fill: `#${p}a900`, stroke: `#${p}aa00`, text: `#${p}0303` },
    muted: { fill: `#${p}ab00`, stroke: `#${p}ac00`, text: `#${p}ad00` },
  },
});
const LIGHT = palette("e1");
const DARK = palette("d1");
const PALETTES: Record<ExportTheme, ExportPalette> = { light: LIGHT, dark: DARK };

afterEach(() => {
  pictureHooks.onScene = undefined;
  pictureHooks.onEntry = undefined;
  vi.restoreAllMocks();
});

const doc = (text: string): FlowDoc => {
  const d = parseFlow(text).doc;
  expect(d, text).not.toBeNull();
  return d!;
};

const decode = (img: PictureImage) => {
  expect(typeof img).toBe("string");
  const url = img as string;
  expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
  return new TextDecoder().decode(Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0)));
};

/** Every kind, laid out as a board frame would be (the fixed kinds place themselves). */
const KINDS: { text: string; at: Record<string, { x: number; y: number }> }[] = [
  {
    text: ['diagram dfd "Checkout"', "Customer [entity]", "Checkout [process, id: 1.0]", "Orders [store, id: D1]", "Payments {", "  Charge card [process, id: 2.0]", "}", "Customer > Checkout: order", "Checkout > Orders"].join("\n"),
    at: { Customer: { x: 0, y: 0 }, Checkout: { x: 300, y: 0 }, Orders: { x: 600, y: 0 }, "Charge card": { x: 300, y: 200 } },
  },
  {
    text: ['diagram flow "Refund"', "Request in [start]", "Within 30 days? [decision]", "Read order [io]", "Refund [step, color: success]", "Done [end]", "Request in > Within 30 days?", "Within 30 days? > Refund: yes", "Refund > Done"].join("\n"),
    at: { "Request in": { x: 0, y: 0 }, "Within 30 days?": { x: 0, y: 140 }, "Read order": { x: 300, y: 140 }, Refund: { x: 0, y: 320 }, Done: { x: 0, y: 460 } },
  },
  {
    text: ['diagram cloud "Order API"', "AWS [icon: aws-cloud] {", "  API Gateway [icon: aws-api-gateway]", "  Queue [icon: aws-sqs]", "}", "Users [icon: users]", "Users > API Gateway: HTTPS", "API Gateway > Queue"].join("\n"),
    at: { "API Gateway": { x: 300, y: 0 }, Queue: { x: 600, y: 0 }, Users: { x: 0, y: 0 } },
  },
  {
    text: ['diagram state "Invoice"', "Draft", "Check [choice]", "Review {", "  Checking", "}", "[*] > Draft", "Draft > Check", "Check > Review", "Review > [*]"].join("\n"),
    at: { "[*]": { x: 0, y: 0 }, Draft: { x: 0, y: 100 }, Check: { x: 0, y: 220 }, Checking: { x: 0, y: 360 } },
  },
  {
    text: ['diagram class "Billing"', "interface Payable", "Payable : pay(amount)", "class Invoice", "Invoice : + id: int", "Invoice : + send()", "enum Status", "Status : DRAFT", "Payable <|-- Invoice"].join("\n"),
    at: { Payable: { x: 0, y: 0 }, Invoice: { x: 0, y: 200 }, Status: { x: 400, y: 0 } },
  },
  {
    text: ['diagram sequence "Pay"', "actor Customer", "participant Shop", "Customer -> Shop: place order", "loop retry {", "  Shop -> Customer: ask", "}", "Shop --> Customer: receipt"].join("\n"),
    at: {},
  },
  { text: ['diagram mindmap "Plan"', "root Q4 plan", "  Diagrams", "    New kinds", "  Redis"].join("\n"), at: {} },
  { text: ['diagram timeline "Release"', "section Making", "2026-09-01 to 2026-10-15: Build", "2026-10-19: Beta", "milestone Launch"].join("\n"), at: {} },
  {
    // A 30-row card: the canvas cuts it at 20 rows.
    text: ['diagram er "Long"', "wide {", ...Array.from({ length: 30 }, (_, i) => `  c${i} int${i === 0 ? " pk" : ""}`), "}", "other {", "  id int pk", "}", "other.id > wide.c25", "other.id > wide.c3"].join("\n"),
    at: { wide: { x: 400, y: 100 }, other: { x: 0, y: 0 } },
  },
];

const entryOf = (d: FlowDoc, at: Record<string, { x: number; y: number }>, textSize: TextSize, sizes?: FrameLayout["sizes"]): FrameLayout => ({
  at: { x: 900, y: 300 },
  nodes: FIXED_KINDS.has(d.kind) ? emptyPositions() : Object.assign(emptyPositions(), at),
  style: "modern",
  direction: "TB",
  textSize,
  ...(sizes ? { sizes } : {}),
});

/**
 * Shapes resized on the canvas (fix round 1): a step made bigger and one smaller; a 30-row card made shorter (it shows
 * the rows its height holds) and a 1-row card made taller than 20 rows (it stops at 20 rows, as the canvas stops it).
 */
const RESIZED: { text: string; at: Record<string, { x: number; y: number }>; sizes: FrameLayout["sizes"] }[] = [
  { ...KINDS[1], sizes: { Refund: { w: 260, h: 90 }, Done: { w: 80, h: 30 } } },
  { ...KINDS[8], sizes: { wide: { w: 250, h: 200 }, other: { w: 300, h: 900 } } },
];

/** A frame's picture input as the scene makes it: the children's box from the same graph. */
function inputOf(d: FlowDoc, e: FrameLayout, softText = true): { a: PictureInput; nodes: Node[] } {
  const g = frameGraph(e, d, e.style);
  const local = drawnBox(g.nodes);
  return { a: { doc: d, layout: e, textScale: TEXT_SCALE[e.textSize ?? "m"], notation: "crow", local, softText }, nodes: g.nodes };
}

/**
 * The canvas's far rows of an ER card (kindNodes `ErBars`, rendered), in the card's own units: its bars block is the
 * rows body's, which sits under the header inside the card's 1 px border. Name and type bars in row order, then keys.
 */
function farCanvasBars(n: FlowNode, count: number, w: number, k: number) {
  const { container, unmount } = render(createElement(ErBars, { rows: n.rows ?? [], flags: n.rowFlags, from: 0, to: count, count, w, k, ports: false }));
  const el = container.querySelector<HTMLElement>(".fkind-er-bars")!;
  const images = el.style.backgroundImage.split(/,\s*(?=linear-gradient)/);
  const sizes = el.style.backgroundSize.split(",").map((x) => x.trim().split(/\s+/).map(parseFloat));
  const places = el.style.backgroundPosition.split(",").map((x) => x.trim().split(/\s+/).map(parseFloat));
  unmount();
  const top = 1 + erMetrics(k).head;
  const rects = images.map((img, i) => ({ key: img.includes("--far-key"), r: { x: 1 + places[i][0], y: top + places[i][1], w: sizes[i][0], h: sizes[i][1] } }));
  return { bars: rects.filter((x) => !x.key).map((x) => x.r), keys: rects.filter((x) => x.key).map((x) => x.r) };
}

const sizeOf = (n: Node) => ({ w: Number(n.style?.width ?? n.initialWidth ?? 0), h: Number(n.style?.height ?? n.initialHeight ?? 0) });

test("a_picture_lines_up_with_the_real_shapes", () => {
  for (const { text, at, sizes } of [...KINDS, ...RESIZED] as { text: string; at: Record<string, { x: number; y: number }>; sizes?: FrameLayout["sizes"] }[]) {
    const d = doc(text);
    for (const size of ["s", "m", "l"] as TextSize[]) {
      let scene: Scene | null = null;
      pictureHooks.onScene = (s) => (scene = s);
      const { a, nodes } = inputOf(d, entryOf(d, at, size, sizes));
      const svg = pictureSvg(a, LIGHT, new Map());
      const where = `${d.kind} ${size}${sizes ? " resized" : ""}`;
      // The view box is the frame's local box on whole units (`frameOf`), where the scene lays the image: each shape
      // lands on its child.
      const box = frameOf(a.local, { padding: 0 });
      expect(svg, where).toContain(`viewBox="${box.x} ${box.y} ${box.w} ${box.h}"`);
      expect(Math.abs(box.x - a.local.x) + Math.abs(box.y - a.local.y), where).toBeLessThan(2);
      expect(scene, where).not.toBeNull();
      const drawn = new Map(scene!.nodes.map((n) => [n.id, n]));
      const shapes = nodes.filter((n) => !n.id.startsWith("\u0000"));
      expect(shapes.length, where).toBeGreaterThan(0);
      for (const n of shapes) {
        const s = drawn.get(n.id);
        expect(s, `${where} ${n.id}`).toBeDefined();
        const { w, h } = sizeOf(n);
        for (const [got, want] of [
          [s!.x, n.position.x],
          [s!.y, n.position.y],
          [s!.w, w],
          [s!.h, h],
        ])
          expect(Math.abs(got - want), `${where} ${n.id}`).toBeLessThanOrEqual(1);
      }
      // Group areas too.
      for (const n of nodes.filter((n) => n.id.startsWith("\u0000group:"))) {
        const area = scene!.areas?.find((x) => `\u0000group:${x.name}` === n.id);
        expect(area, `${where} ${n.id}`).toBeDefined();
        expect(Math.abs(area!.x - n.position.x) + Math.abs(area!.y - n.position.y), `${where} ${n.id}`).toBeLessThanOrEqual(2);
      }
      if (d.kind === "er") {
        // Each card in the image is the canvas card's size: the 30-row card 20 rows tall, a resized one its kept size.
        for (const id of ["wide", "other"]) {
          const n = nodes.find((x) => x.id === id)!;
          const card = new RegExp(`data-node="${id}">(?:<g[^>]*>)?<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`).exec(svg)!;
          expect(Math.abs(Number(card[3]) - sizeOf(n).w), `${where} ${id}`).toBeLessThanOrEqual(1);
          expect(Math.abs(Number(card[4]) - sizeOf(n).h), `${where} ${id}`).toBeLessThanOrEqual(1);
          expect(Math.abs(Number(card[2]) - n.position.y), `${where} ${id}`).toBeLessThanOrEqual(1);
        }
        // A card shows only the rows its height holds: none drawn past its bottom.
        const wide = scene!.nodes.find((x) => x.id === "wide")!;
        expect(erCardH(wide.rows.length, TEXT_SCALE[size]), where).toBeLessThanOrEqual(wide.h + 1);
        // Its far rows are the canvas's far card's (kindNodes `ErBars`) within 1 px: each name and type bar, and the key
        // row's square in the key colour, so no row jumps when the frame turns from picture to real.
        const canvasBars = farCanvasBars(d.nodes.find((x) => x.name === "wide")!, wide.rows.length, sizeOf(nodes.find((x) => x.id === "wide")!).w, TEXT_SCALE[size]);
        const part = new RegExp(`data-node="wide">[\\s\\S]*?</g>`).exec(svg)![0];
        const rects = (tag: string) => {
          const d = new RegExp(`data-part="${tag}"[^>]* d="([^"]+)"`).exec(part)?.[1] ?? "";
          return [...d.matchAll(/M([-\d.]+) ([-\d.]+)h([-\d.]+)v([-\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
        };
        const near = (a: { x: number; y: number; w: number; h: number }[], b: typeof a, what: string) => {
          expect(a.length, `${where} ${what}`).toBe(b.length);
          a.forEach((r, i) => {
            for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(r[k] - b[i][k]), `${where} ${what} ${i} ${k}`).toBeLessThanOrEqual(1);
          });
        };
        near(rects("soft-rows"), canvasBars.bars, "bars");
        near(rects("soft-keys"), canvasBars.keys, "keys");
        expect(canvasBars.keys.length, where).toBe(1);
        expect(part, where).toContain(`fill="${LIGHT.keyMark}"`);
        expect(part, where).toMatch(/data-part="soft-rows"[^>]*fill-opacity="0.45"/);
      }
    }
  }
});

const LOGO = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z" fill="#3f8624"/></svg>')}`;
const CLOUD = KINDS[2];
const FLOW = KINDS[1];

test("a_picture_keeps_shapes_colours_and_icons", () => {
  const cloud = doc(CLOUD.text);
  const icons = new Map<string, SceneIcon>([["aws-sqs", { url: LOGO }]]);
  const svg = pictureSvg(inputOf(cloud, entryOf(cloud, CLOUD.at, "m")).a, DARK, icons);
  // The icon is drawn, once, through the shared defs.
  expect(svg).toContain("<use ");
  expect(svg.match(/<image /g)).toHaveLength(1);
  expect(svg).toContain('data-node="Queue"');
  expect(svg).toContain('data-area="AWS"');
  // The flowchart's coloured step keeps its colour; every colour is the theme's.
  const flow = doc(FLOW.text);
  const f = pictureSvg(inputOf(flow, entryOf(flow, FLOW.at, "m")).a, DARK, new Map());
  expect(f).toContain(DARK.colours!.success.fill);
  expect(f).toContain(DARK.colours!.success.stroke);
  for (const n of ["Request in", "Within 30 days?", "Read order", "Refund", "Done"]) expect(f).toContain(`data-node="${n}"`);
  const used = [...f.matchAll(/(?:fill|stroke)="(#[0-9a-f]+)"/gi)].map((m) => m[1]);
  expect(used.length).toBeGreaterThan(0);
  for (const c of used) expect(c.startsWith("#d1"), c).toBe(true);
  // Soft text: no words, the bars in the faint token.
  expect(f).not.toContain("<text");
  expect(f).toContain(`fill="${DARK.faint}" fill-opacity="0.45"`);
  // Real words when asked (picture-text).
  expect(pictureSvg({ ...inputOf(flow, entryOf(flow, FLOW.at, "m")).a, softText: false }, DARK, new Map())).toContain(">Refund<");
});

test("a_far_sequence_picture_has_no_words", () => {
  // Plan E: the sequence look pictured far. Names, labels and the caption are bars, the digits go (as the canvas's far
  // numbers), and the block's turned kind word, which a bar could not follow, is left out.
  const pay = doc(PAY);
  for (const size of ["s", "m", "l"] as TextSize[]) {
    const { a } = inputOf(pay, entryOf(pay, {}, size));
    const svg = pictureSvg(a, LIGHT, new Map());
    expect(svg, size).not.toContain("<text");
    expect(svg, size).toContain('data-frame="0"');
    expect(svg, size).toContain('data-part="chip"');
    expect(svg, size).toContain(`fill="${LIGHT.faint}" fill-opacity="0.45"`);
    // Near, the words are real, the kind word turned.
    const near = pictureSvg({ ...a, softText: false }, LIGHT, new Map());
    expect(near, size).toMatch(/<text transform="rotate\(-90 [^"]+\)"[^>]*>opt<\/text>/);
    expect(near, size).toContain(">card saved<");
  }
});

test("a_sequence_picture_draws_each_style_as_one_path_where_publish_draws_it", () => {
  // Plan E Task 9: in a frame picture a sequence's parts of one style are one path (PictureSequence): the same boxes,
  // bars, chips and pills as Publish's elements of the same scene, in a handful of paths, no element a participant or a
  // message; far the words are bars, with words (picture-text) one group of runs a kind.
  const pay = doc(PAY);
  const { a } = inputOf(pay, entryOf(pay, {}, "m"));
  let scene: Scene | null = null;
  pictureHooks.onScene = (s) => (scene = s);
  const far = pictureSvg(a, LIGHT, new Map());
  const words = pictureSvg({ ...a, softText: false }, LIGHT, new Map());
  pictureHooks.onScene = undefined;
  const near = sceneBody(scene!, LIGHT);
  for (const svg of [far, words]) {
    expect(svg).not.toContain("data-node=");
    expect(svg).not.toContain("data-edge=");
  }
  const num = (v: string) => Math.round(Number(v) * 100) / 100;
  /** Each `<rect data-part="part">` of `svg` as x y w h. */
  const rectsOf = (svg: string, part: string) =>
    [...svg.matchAll(new RegExp(`<rect data-part="${part}" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`, "g"))].map((m) => [1, 2, 3, 4].map((i) => num(m[i])).join(" "));
  /** Each rectangle of every `<path data-part="part">` of `svg` as x y w h, and how many such paths there are. */
  const pathRects = (svg: string, part: string) => {
    const paths = [...svg.matchAll(new RegExp(`<path data-part="${part}" d="([^"]*)"`, "g"))].map((m) => m[1]);
    const rects = paths.flatMap((d) => [...d.matchAll(/M([-\d.]+) ([-\d.]+)h([-\d.]+)v([-\d.]+)/g)].map((m) => [1, 2, 3, 4].map((i) => num(m[i])).join(" ")));
    return { paths: paths.length, rects };
  };
  const sorted = (xs: string[]) => [...xs].sort();
  for (const [elem, path] of [
    ["lifehead", "lifeheads"],
    ["activation", "activations"],
    ["chip", "chip"],
    ["number", "numbers"],
  ]) {
    const want = rectsOf(near, elem);
    expect(want.length, elem).toBeGreaterThan(0);
    for (const svg of [far, words]) {
      const got = pathRects(svg, path);
      expect(sorted(got.rects), elem).toEqual(sorted(want));
      // One path a colour at most: five participants in five colours.
      expect(got.paths, elem).toBeLessThanOrEqual(5);
    }
  }
  // One lifeline path a line colour: five participants in five colours.
  const lanes = [...far.matchAll(/<path data-part="lifelines" d="([^"]*)" fill="none" stroke="([^"]+)"/g)];
  expect(lanes).toHaveLength(5);
  expect(lanes.reduce((n, m) => n + (m[1].match(/M/g) ?? []).length, 0)).toBe(5);
  // Every message line and head in four paths: calls, replies and their two kinds of head.
  for (const part of ["messages", "replies", "heads", "open-heads"]) expect(far.match(new RegExp(`data-part="${part}"`, "g")), part).toHaveLength(1);
  // A bar for each name in its head and foot and for each label, each label's bar centred on its chip.
  expect(pathRects(far, "soft-names").rects).toHaveLength(10);
  const labels = pathRects(far, "soft-labels").rects.map((r) => r.split(" ").map(Number));
  const chips = pathRects(far, "chip").rects.map((r) => r.split(" ").map(Number));
  expect(labels).toHaveLength(chips.length);
  const centres = (rs: number[][]) => rs.map(([x, , w]) => Math.round(x + w / 2)).sort((p, q) => p - q);
  expect(centres(labels)).toEqual(centres(chips));
  // With words: Publish's runs of words, each where Publish puts it, in one group a kind.
  const runs = (svg: string) => sorted([...svg.matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`));
  expect(runs(words)).toEqual(runs(near));
  // Ten names (head and foot of five), ten labels, ten numbers and the opt block's caption.
  expect(runs(words)).toHaveLength(31);
  for (const part of ["names", "labels", "number-texts"]) expect(words.match(new RegExp(`<g data-part="${part}"`, "g")), part).toHaveLength(1);
});

/** A store over the two literal palettes with a fake icon loader the test resolves. */
function storeWith(over: Partial<Parameters<typeof createPictureStore>[0]> = {}) {
  const loads: { names: string[]; theme: ExportTheme; resolve(m: ReadonlyMap<string, SceneIcon>): void }[] = [];
  const onReady = vi.fn();
  const store = createPictureStore({
    palette: (t) => PALETTES[t],
    loadIcons: (names, theme) => new Promise((resolve) => loads.push({ names, theme, resolve })),
    onReady,
    ...over,
  }) as PictureStore<string>;
  return { store, loads, onReady };
}

const task = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 20; i++) await task();
}

test("a_frame_with_icons_swaps_once", async () => {
  const { store, loads, onReady } = storeWith({ sync: true });
  const cloud = doc(CLOUD.text);
  const { a } = inputOf(cloud, entryOf(cloud, CLOUD.at, "m"));
  const key = {};
  const first = store.url("f", key, a)!;
  // Pictured at once, without its icons: the dashed tiles.
  expect(first).not.toBeNull();
  expect(decode(first)).not.toContain("<use ");
  expect(store.ready("f")).toBe(true);
  expect(loads).toHaveLength(1);
  expect(loads[0].names.sort()).toEqual(["aws-api-gateway", "aws-cloud", "aws-sqs", "users"]);
  loads[0].resolve(new Map([["aws-sqs", { url: LOGO }]]));
  await settle();
  // One new picture with the icon, and one ready.
  expect(onReady).toHaveBeenCalledTimes(1);
  const second = store.url("f", key, a)!;
  expect(second).not.toBe(first);
  expect(decode(second)).toContain("<use ");
  await settle();
  expect(store.url("f", key, a)).toBe(second);
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(loads).toHaveLength(1);
});

test("a_frame_waiting_on_two_loads_swaps_once", async () => {
  // Two frames: one asks for aws-sqs, then one asks for aws-sqs and users, so its icons come by two loads. It is built
  // again once, when the second of them is in.
  const { store, loads, onReady } = storeWith({ sync: true });
  const one = doc('diagram cloud "One"\nQueue [icon: aws-sqs]\n');
  const two = doc('diagram cloud "Two"\nQueue [icon: aws-sqs]\nUsers [icon: users]\n');
  const a1 = inputOf(one, entryOf(one, { Queue: { x: 0, y: 0 } }, "m")).a;
  const a2 = inputOf(two, entryOf(two, { Queue: { x: 0, y: 0 }, Users: { x: 300, y: 0 } }, "m")).a;
  const [k1, k2] = [{}, {}];
  store.url("one", k1, a1);
  const first = store.url("two", k2, a2)!;
  expect(loads.map((l) => l.names)).toEqual([["aws-sqs"], ["users"]]);
  const urls = new Set([first]);
  loads[0].resolve(new Map([["aws-sqs", { url: LOGO }]]));
  await settle();
  urls.add(store.url("two", k2, a2)!);
  // Still waiting on users: not built again yet.
  expect(urls.size).toBe(1);
  loads[1].resolve(new Map([["users", { url: LOGO }]]));
  await settle();
  urls.add(store.url("two", k2, a2)!);
  expect(urls.size).toBe(2);
  expect((decode(store.url("two", k2, a2)!).match(/<use /g) ?? []).length).toBe(2);
  // "One" swapped after the first load, "two" after the second: two readies in all.
  expect(onReady).toHaveBeenCalledTimes(2);
});

test("icons_arriving_mid_build_are_drawn", async () => {
  // A build spans slices (a fake clock: every step runs alone); the icon load answers between two of its slices. The
  // frame is built once more with its icon, not left without it.
  let clock = 0;
  const { store, loads, onReady } = storeWith({ now: () => (clock += 5) });
  const cloud = doc(CLOUD.text);
  const { a } = inputOf(cloud, entryOf(cloud, CLOUD.at, "m"));
  const key = {};
  expect(store.url("f", key, a)).toBeNull();
  // The first slice starts the build and asks for the icons.
  await task();
  expect(loads).toHaveLength(1);
  expect(store.ready("f")).toBe(false);
  loads[0].resolve(new Map([["aws-sqs", { url: LOGO }]]));
  await settle();
  await settle();
  const url = store.url("f", key, a)!;
  expect(decode(url)).toContain("<use ");
  expect(store.ready("f")).toBe(true);
  expect(onReady.mock.calls.length).toBeGreaterThanOrEqual(1);
});

test("a_frame_without_icons_is_pictured_at_once", async () => {
  const { store, loads, onReady } = storeWith({ sync: true });
  const flow = doc(FLOW.text);
  const { a } = inputOf(flow, entryOf(flow, FLOW.at, "m"));
  const url = store.url("f", {}, a);
  expect(url).not.toBeNull();
  expect(store.ready("f")).toBe(true);
  await settle();
  expect(loads).toHaveLength(0);
  expect(onReady).not.toHaveBeenCalled();
});

test("canvas_and_picture_bars_share_one_colour", () => {
  // The canvas's far text rule and the picture's bars read one token at one strength.
  expect(flowBoardCss).toContain("background: color-mix(in srgb, var(--c-text-faint) 45%, transparent);");
  expect(paletteSource).toContain('faint: read("--c-text-faint")');
  const style = document.createElement("style");
  style.textContent = ".theme-dark{--c-text-faint:#5c5c66}";
  document.head.appendChild(style);
  try {
    const p = exportPalette("dark");
    expect(p.faint).toBe("#5c5c66");
    const flow = doc(FLOW.text);
    const svg = pictureSvg(inputOf(flow, entryOf(flow, FLOW.at, "m")).a, p, new Map());
    const bars = [...svg.matchAll(/<rect data-part="soft"[^>]*>/g)].map((m) => m[0]);
    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) expect(b).toContain('fill="#5c5c66" fill-opacity="0.45"');
  } finally {
    style.remove();
  }
});

test("the_store_holds_one_picture_per_frame", async () => {
  const { store } = storeWith({ sync: true });
  const flow = doc(FLOW.text);
  const { a } = inputOf(flow, entryOf(flow, FLOW.at, "m"));
  const first = store.url("f", {}, a)!;
  expect(store.bytes()).toBe(first.length);
  await settle();
  // An edit: a new key. The old picture shows until the new one is built, then it goes.
  const edited = doc(FLOW.text.replace("Done [end]", "All done [end]").replace("Refund > Done", "Refund > All done"));
  const b = inputOf(edited, entryOf(edited, { ...FLOW.at, "All done": FLOW.at.Done }, "m")).a;
  const k2 = {};
  expect(store.url("f", k2, b)).toBe(first);
  expect(store.ready("f")).toBe(false);
  await settle();
  const second = store.url("f", k2, b)!;
  expect(second).not.toBe(first);
  expect(store.ready("f")).toBe(true);
  expect(store.bytes()).toBe(second.length);
  // Another frame adds its own; a frame gone is dropped.
  const kg = {};
  expect(store.url("g", kg, a)).toBeNull();
  await settle();
  const g = store.url("g", kg, a)!;
  expect(store.bytes()).toBe(second.length + g.length);
  store.prune(new Set(["f"]));
  expect(store.bytes()).toBe(second.length);
  expect(store.ready("g")).toBe(false);
});

test("a_theme_switch_keeps_each_picture_until_its_replacement", async () => {
  const { store, loads } = storeWith({ sync: true });
  store.setTheme("dark");
  const flow = doc(FLOW.text);
  const cloud = doc(CLOUD.text);
  const fa = inputOf(flow, entryOf(flow, FLOW.at, "m")).a;
  const ca = inputOf(cloud, entryOf(cloud, CLOUD.at, "m")).a;
  const [kf, kc] = [{}, {}];
  expect(decode(store.url("f", kf, fa)!)).toMatch(/#d1/);
  store.url("c", kc, ca);
  loads[0].resolve(new Map([["aws-sqs", { url: LOGO }]]));
  await settle();
  expect(store.bytes()).toBeGreaterThan(0);
  const dark = { f: store.url("f", kf, fa)!, c: store.url("c", kc, ca)! };
  const held0 = store.bytes();
  store.setTheme("light");
  // Controller ruling (fix round 1): every Dark picture stays on screen until its Light one replaces it, so no frame
  // blanks; none counts as ready, and the icons and queued builds are gone.
  expect(store.ready("f")).toBe(false);
  expect(store.ready("c")).toBe(false);
  expect(store.url("f", kf, fa)).toBe(dark.f);
  expect(store.url("c", kc, ca)).toBe(dark.c);
  expect(store.bytes()).toBe(held0);
  await settle();
  // Then each is replaced in place: one picture a frame, every one Light.
  const f = decode(store.url("f", kf, fa)!);
  expect(f).toMatch(/#e1/);
  expect(f).not.toMatch(/#d1/);
  expect(store.ready("f")).toBe(true);
  loads[1].resolve(new Map([["aws-sqs", { url: LOGO }]]));
  await settle();
  const c = store.url("c", kc, ca)!;
  expect(decode(c)).not.toMatch(/#d1/);
  expect(store.bytes()).toBe(store.url("f", kf, fa)!.length + c.length);
  // The icons are asked again, for Light.
  expect(loads.map((l) => l.theme)).toEqual(["dark", "light"]);
  // Asking again for the same theme drops nothing.
  const held = store.bytes();
  store.setTheme("light");
  expect(store.bytes()).toBe(held);
});

test("pictures_build_in_slices", async () => {
  // A fake clock: each build takes 3 ms. A task never builds for more than PICTURE_SLICE_MS.
  let clock = 0;
  pictureHooks.onScene = () => {
    clock += 3;
  };
  const real = globalThis.setTimeout;
  let longest = 0;
  let tasks = 0;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    real(() => {
      const t0 = clock;
      fn();
      tasks++;
      longest = Math.max(longest, clock - t0);
    }, ms)) as unknown as typeof setTimeout);
  const { store, onReady } = storeWith({ now: () => clock });
  const flow = doc(FLOW.text);
  const { a } = inputOf(flow, entryOf(flow, FLOW.at, "m"));
  const ids = Array.from({ length: 10 }, (_, i) => `f${i}`);
  const keys = ids.map(() => ({}));
  // After open, nothing is built while it is asked for.
  for (let i = 0; i < ids.length; i++) expect(store.url(ids[i], keys[i], a)).toBeNull();
  expect(clock).toBe(0);
  await settle();
  for (let i = 0; i < ids.length; i++) expect(store.url(ids[i], keys[i], a), ids[i]).not.toBeNull();
  expect(longest).toBeGreaterThan(0);
  expect(longest).toBeLessThanOrEqual(PICTURE_SLICE_MS);
  // More than one task, each ending with a ready.
  expect(tasks).toBeGreaterThan(1);
  expect(onReady.mock.calls.length).toBeGreaterThan(1);
});

/**
 * A rasteriser that draws nothing (Task 9 fixes 2 and 3): the decode is one wait, each band of 64 rows one step, and
 * its bitmap a PNG URL of the size asked. `decoded` holds each decode's resolver while `hold` is set.
 */
function fakeRasteriser(o: { hold?: boolean } = {}) {
  const drawn: { url: string; w: number; h: number }[] = [];
  const decoded: (() => void)[] = [];
  const r: Rasteriser = {
    *draw(url, w, h) {
      drawn.push({ url, w, h });
      yield o.hold ? new Promise<void>((resolve) => decoded.push(resolve)) : Promise.resolve();
      for (let y = 0; y < h; y += 64) yield;
      return { url: `data:image/png;base64,${w}x${h}`, w, h };
    },
  };
  return { r, drawn, decoded };
}

/** A store that draws bitmaps with `r`. */
function rasterStore(r: Rasteriser, sync = false) {
  const { store, onReady } = storeWith({ sync, rasterise: r });
  return { store: store as unknown as PictureStore, onReady };
}

const isRaster = (img: PictureImage | null): img is PictureRaster => img !== null && typeof img !== "string";

test("dispose_drops_the_queued_builds_and_keeps_the_pictures", async () => {
  // Final review M2: a closed board tab stops building its queued pictures. The pictures built stay (React's
  // development re-mount draws from them), and the next ask queues again.
  const { r, drawn, decoded } = fakeRasteriser({ hold: true });
  const { store, onReady } = rasterStore(r);
  const flow = doc(FLOW.text);
  const { a } = inputOf(flow, entryOf(flow, FLOW.at, "m"));
  const kept = {};
  store.url("e", kept, a);
  await settle();
  decoded.shift()!();
  await settle();
  const built = store.url("e", kept, a);
  expect(isRaster(built)).toBe(true);
  // Three queued; the first is under way, waiting for its decode.
  const keys = { f: {}, g: {}, h: {} };
  for (const [id, key] of Object.entries(keys)) store.url(id, key, a);
  await settle();
  expect(drawn).toHaveLength(2);
  store.dispose();
  decoded.shift()!();
  await settle();
  // Nothing more is drawn, nothing new is ready, and the picture built is still there.
  expect(drawn).toHaveLength(2);
  expect(onReady).toHaveBeenCalledTimes(1);
  for (const id of Object.keys(keys)) expect(store.ready(id)).toBe(false);
  expect(store.url("e", kept, a)).toBe(built);
  // Asked again: built again.
  store.url("g", keys.g, a);
  await settle();
  expect(drawn).toHaveLength(3);
  decoded.shift()!();
  await settle();
  expect(isRaster(store.url("g", keys.g, a))).toBe(true);
});

test("an_icon_load_after_dispose_queues_nothing", async () => {
  const { store, loads, onReady } = storeWith({ sync: true });
  const cloud = doc(CLOUD.text);
  const { a } = inputOf(cloud, entryOf(cloud, CLOUD.at, "m"));
  const key = {};
  const first = store.url("f", key, a)!;
  expect(loads).toHaveLength(1);
  store.dispose();
  loads[0].resolve(new Map([["aws-sqs", { url: LOGO }]]));
  await settle();
  // The frame built without its icons is not built again for a closed tab.
  expect(onReady).not.toHaveBeenCalled();
  expect(store.url("f", key, a)).toBe(first);
});

test("a_picture_becomes_a_bitmap_at_a_capped_scale", async () => {
  // Task 9 fix 2: WebKit draws an <img> of an SVG as vector again at each zoom; a picture is drawn once into a bitmap.
  const { r, drawn } = fakeRasteriser();
  const { store } = rasterStore(r, true);
  const flow = doc(FLOW.text);
  const { a } = inputOf(flow, entryOf(flow, FLOW.at, "m"));
  // At open the frame is pictured at once from its SVG, until its bitmap is in.
  const first = store.url("f", {}, a) as PictureImage;
  expect(typeof first).toBe("string");
  expect(store.ready("f")).toBe(true);
  await settle();
  const img = store.url("f", {}, a);
  // A new key is a new picture; ask with the same one.
  expect(img).not.toBeNull();
  const key = {};
  store.url("g", key, a);
  await settle();
  const bitmap = store.url("g", key, a);
  expect(isRaster(bitmap)).toBe(true);
  const size = pictureRasterSize(a.local, a.textScale, 1);
  expect(bitmap).toMatchObject(size);
  // Drawn from the frame's SVG, and counted at its real size.
  expect(drawn[drawn.length - 1].url).toMatch(/^data:image\/svg\+xml;base64,/);
  store.prune(new Set(["g"]));
  expect(store.bytes()).toBe(size.w * size.h * 4 + (bitmap as PictureRaster).url.length);
  expect(store.ready("g")).toBe(true);
});

test("a_picture_at_open_turns_into_its_bitmap_in_place", async () => {
  const { r } = fakeRasteriser();
  const { store, onReady } = rasterStore(r, true);
  const flow = doc(FLOW.text);
  const { a } = inputOf(flow, entryOf(flow, FLOW.at, "m"));
  const key = {};
  const svg = store.url("f", key, a) as unknown as string;
  expect(store.bytes()).toBe(svg.length);
  // Asking again while the bitmap is drawn keeps the drawing going and the frame ready.
  store.url("f", key, a);
  expect(store.ready("f")).toBe(true);
  await settle();
  const bitmap = store.url("f", key, a);
  expect(isRaster(bitmap)).toBe(true);
  // The SVG text is let go once the bitmap is in: only the bitmap is held, its decoded pixels and its PNG.
  const { w, h, url } = bitmap as PictureRaster;
  expect(url).toMatch(/^data:image\/png;base64,/);
  expect(store.bytes()).toBe(w * h * 4 + url.length);
  expect(onReady).toHaveBeenCalled();
});

test("raster_sizes_are_capped", () => {
  // The on-screen size where the frame turns real, times the device pixel ratio, capped at PICTURE_MAX_SCALE device
  // pixels a board unit, PICTURE_MAX_SIDE a side and PICTURE_MAX_PIXELS in all.
  const limit = pictureRasterSize({ x: 0, y: 0, w: 4_800, h: 1_100 }, 1, 1);
  expect(limit).toEqual({ w: Math.floor(4_800 * PICTURE_MAX_SCALE), h: Math.floor(1_100 * PICTURE_MAX_SCALE) });
  expect(pictureRasterSize({ x: 0, y: 0, w: 4_800, h: 1_100 }, 1, 2)).toEqual(limit);
  const erd = pictureRasterSize({ x: 0, y: 0, w: 60_000, h: 45_000 }, 1, 1);
  expect(Math.max(erd.w, erd.h)).toBeLessThanOrEqual(PICTURE_MAX_SIDE);
  expect(erd.w * erd.h).toBeLessThanOrEqual(PICTURE_MAX_PIXELS);
  const tall = pictureRasterSize({ x: 0, y: 0, w: 300, h: 90_000 }, 1, 1);
  expect(tall.h).toBeLessThanOrEqual(PICTURE_MAX_SIDE);
  expect(pictureRasterSize({ x: 0, y: 0, w: 3, h: 2 }, 1, 1)).toEqual({ w: 1, h: 1 });
});

test("a_bitmap_waits_for_its_decode_without_spinning", async () => {
  const { r, decoded } = fakeRasteriser({ hold: true });
  const real = globalThis.setTimeout;
  let tasks = 0;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    real(() => {
      // The store's own slices, not the test's waits.
      if (fn.name === "slice") tasks++;
      fn();
    }, ms)) as unknown as typeof setTimeout);
  const { store } = rasterStore(r);
  const flow = doc(FLOW.text);
  const { a } = inputOf(flow, entryOf(flow, FLOW.at, "m"));
  const key = {};
  expect(store.url("f", key, a)).toBeNull();
  await settle();
  // The SVG is built and the decode asked for; while it decodes, no task runs.
  expect(decoded).toHaveLength(1);
  const waiting = tasks;
  expect(waiting).toBeGreaterThan(0);
  await settle();
  expect(tasks).toBe(waiting);
  expect(store.ready("f")).toBe(false);
  decoded[0]();
  await settle();
  expect(isRaster(store.url("f", key, a))).toBe(true);
  expect(store.ready("f")).toBe(true);
});

test("a_theme_switch_keeps_each_bitmap_until_its_replacement", async () => {
  const { r } = fakeRasteriser();
  const { store } = rasterStore(r);
  const flow = doc(FLOW.text);
  const { a } = inputOf(flow, entryOf(flow, FLOW.at, "m"));
  const key = {};
  store.url("f", key, a);
  await settle();
  const light = store.url("f", key, a);
  expect(isRaster(light)).toBe(true);
  store.setTheme("dark");
  expect(store.url("f", key, a)).toBe(light);
  expect(store.ready("f")).toBe(false);
  await settle();
  const dark = store.url("f", key, a);
  expect(isRaster(dark)).toBe(true);
  expect(dark).not.toBe(light);
  const { w, h, url } = dark as PictureRaster;
  expect(store.bytes()).toBe(w * h * 4 + url.length);
  // A frame gone lets its bitmap go.
  store.prune(new Set());
  expect(store.bytes()).toBe(0);
});

/**
 * The WebView's image and canvas, mocked (jsdom has neither a decode nor a 2D context): every decode resolves, the SVG
 * is 4,800 by 1,600, and the 2D context records each band it draws and reads back.
 */
function mockWebView() {
  const draws: number[][] = [];
  const contexts: unknown[] = [];
  const created: HTMLCanvasElement[] = [];
  const make = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, opts?: ElementCreationOptions) => {
    const el = make(tag, opts);
    if (tag === "canvas") created.push(el as HTMLCanvasElement);
    return el;
  }) as typeof document.createElement);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, _id: string, settings?: unknown) {
    contexts.push(settings);
    const canvas = this;
    return {
      canvas,
      clearRect() {},
      drawImage: (...a: unknown[]) => void draws.push((a.slice(1) as number[]).map((v) => Math.round(v))),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(7) }),
    } as unknown as RenderingContext;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  const proto = HTMLImageElement.prototype;
  const kept = ["decode", "naturalWidth", "naturalHeight"].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
  Object.defineProperty(proto, "decode", { configurable: true, value: () => Promise.resolve() });
  Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => 4_800 });
  Object.defineProperty(proto, "naturalHeight", { configurable: true, get: () => 1_600 });
  const restore = () => {
    for (const [k, d] of kept) {
      if (d) Object.defineProperty(proto, k, d);
      else delete (proto as unknown as Record<string, unknown>)[k];
    }
  };
  return { draws, contexts, created, restore };
}

/** Runs a rasteriser's steps to the end, waiting where it waits: its bitmap, and its waits and bands. */
async function run(steps: Generator<Promise<unknown> | void, PictureRaster | null>) {
  let waits = 0;
  let bands = 0;
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done) return { raster: step.value, waits, bands };
    if (step.value) {
      waits++;
      await step.value;
    } else bands++;
  }
}

test("the_browser_rasteriser_draws_bands_on_one_scratch_canvas_into_a_png", async () => {
  // Task 9 fix 3: no <canvas> is kept. Each band is drawn on one scratch canvas kept in memory (read back, so WebKit
  // draws it when asked, in its step), deflated, and the bitmap is a PNG decoded once before it is shown.
  expect(browserRasteriser()).toBeUndefined();
  const m = mockWebView();
  try {
    const r = browserRasteriser()!;
    expect(r).toBeDefined();
    const { raster, waits, bands } = await run(r.draw("data:image/svg+xml;base64,PHN2Zy8+", 480, 160));
    expect(raster).not.toBeNull();
    expect(raster!.url).toMatch(/^data:image\/png;base64,/);
    expect(raster).toMatchObject({ w: 480, h: 160 });
    expect(Object.keys(raster!).sort()).toEqual(["h", "url", "w"]);
    // The SVG's decode, the deflate, the PNG's decode.
    expect(waits).toBe(3);
    // Bands of PICTURE_BAND_PIXELS (68 rows at 480), each a source rect of the SVG, scaled from its own size.
    const rows = Math.floor(PICTURE_BAND_PIXELS / 480);
    expect(m.draws).toHaveLength(Math.ceil(160 / rows));
    expect(bands).toBeGreaterThanOrEqual(m.draws.length);
    expect(m.draws[1]).toEqual([0, rows * 10, 4_800, rows * 10, 0, 0, 480, rows]);
    // The PNG holds the pixels read back: 160 rows of 480 pixels.
    const png = Uint8Array.from(atob(raster!.url.slice(raster!.url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    expect(new DataView(png.buffer).getUint32(16)).toBe(480);
    expect(new DataView(png.buffer).getUint32(20)).toBe(160);
    // A second picture draws on the same canvas: one scratch canvas, in memory, and none on the page.
    await run(r.draw("data:image/svg+xml;base64,PHN2Zy8+", 100, 40));
    expect(m.created).toHaveLength(1);
    expect(m.contexts).toEqual([{ willReadFrequently: true }]);
    expect(m.created[0].isConnected).toBe(false);
    expect(m.created[0].width * m.created[0].height).toBe(1);
  } finally {
    m.restore();
  }
});

test("an_abandoned_bitmap_lets_go_of_its_deflate_stream_and_image", async () => {
  // Final review M1: the store ends a build part way with `return()` (replaced, pruned, a theme switch). That runs the
  // rasteriser's `finally`, not its `catch`: the deflate stream is aborted and the SVG image let go there too.
  const m = mockWebView();
  const writer = Object.getPrototypeOf(new CompressionStream("deflate").writable.getWriter()) as WritableStreamDefaultWriter;
  const abort = vi.spyOn(writer, "abort");
  const src = vi.spyOn(HTMLImageElement.prototype, "src", "set");
  /** `n` steps of a build, waiting where it waits. */
  const stepsOf = async (steps: Generator<Promise<unknown> | void, PictureRaster | null>, n: number) => {
    for (let i = 0; i < n; i++) {
      const step = steps.next();
      expect(step.done).toBe(false);
      if (step.value) await step.value;
    }
  };
  try {
    const r = browserRasteriser()!;
    // `draw`: its decode, then one band deflated; abandoned there.
    const one = r.draw("data:image/svg+xml;base64,PHN2Zy8+", 480, 160);
    await stepsOf(one, 2);
    expect(abort).not.toHaveBeenCalled();
    one.return(null);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(src.mock.calls[src.mock.calls.length - 1]).toEqual([""]);
    // `drawPieces`: two pieces (a decode and a draw each), then one band deflated; abandoned there.
    src.mockClear();
    const two = r.drawPieces!(["data:image/svg+xml;base64,PHN2Zy8+", "data:image/svg+xml;base64,PHN2Zy8+"], 480, 160);
    await stepsOf(two, 5);
    two.return(null);
    expect(abort).toHaveBeenCalledTimes(2);
    expect(src.mock.calls[src.mock.calls.length - 1]).toEqual([""]);
    // Abandoned in its first decode, before any deflate: its image is let go.
    src.mockClear();
    const early = r.draw("data:image/svg+xml;base64,PHN2Zy8+", 480, 160);
    await stepsOf(early, 1);
    early.return(null);
    expect(abort).toHaveBeenCalledTimes(2);
    expect(src.mock.calls[src.mock.calls.length - 1]).toEqual([""]);
    // A build run to its end aborts nothing.
    await run(r.draw("data:image/svg+xml;base64,PHN2Zy8+", 100, 40));
    expect(abort).toHaveBeenCalledTimes(2);
  } finally {
    abort.mockRestore();
    src.mockRestore();
    m.restore();
  }
});

test("bands_follow_the_time_they_take", () => {
  // A band over half a slice halves the next; one under an eighth doubles it, up to PICTURE_BAND_PIXELS and never
  // under PICTURE_BAND_MIN_ROWS.
  const most = Math.floor(PICTURE_BAND_PIXELS / 512);
  expect(nextBandRows(PICTURE_BAND_PIXELS, 0, 512)).toBe(most);
  expect(nextBandRows(64, PICTURE_SLICE_MS, 512)).toBe(32);
  expect(nextBandRows(PICTURE_BAND_MIN_ROWS, PICTURE_SLICE_MS, 512)).toBe(PICTURE_BAND_MIN_ROWS);
  expect(nextBandRows(16, 0.5, 512)).toBe(32);
  expect(nextBandRows(most, 0.5, 512)).toBe(most);
  expect(nextBandRows(20, PICTURE_SLICE_MS / 4, 512)).toBe(20);
  // A bitmap wider than PICTURE_BAND_PIXELS still draws PICTURE_BAND_MIN_ROWS a band.
  expect(nextBandRows(PICTURE_BAND_PIXELS, 0, 8_192)).toBe(PICTURE_BAND_MIN_ROWS);
});

test("pictures_built_in_one_frame_draw_the_board_once", () => {
  // Task 9 fix 3: slices run back to back between two frames; each that built a picture drew the whole board again
  // (a FlowTab render each). The board is drawn once an animation frame at most, after the slices of that frame.
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((f) => frames.push(f));
  const draw = vi.fn();
  const ready = oncePerFrame(draw);
  ready();
  ready();
  ready();
  expect(draw).not.toHaveBeenCalled();
  expect(frames).toHaveLength(1);
  frames[0](0);
  expect(draw).toHaveBeenCalledTimes(1);
  ready();
  expect(frames).toHaveLength(2);
  frames[1](16);
  expect(draw).toHaveBeenCalledTimes(2);
});

test("a_normal_picture_never_falls_back_to_its_svg", async () => {
  // Task 9 fix 4: the WebView's rasteriser draws a frame's picture into a PNG; only a drawing that fails leaves the
  // SVG on the page (vector again at every zoom), and that is logged as `picture_fallback` for the live run to see.
  const steps = vi.mocked(perfStep);
  steps.mockClear();
  const m = mockWebView();
  try {
    const { store } = rasterStore(browserRasteriser()!);
    const flow = doc(FLOW.text);
    const { a } = inputOf(flow, entryOf(flow, FLOW.at, "m"));
    const key = {};
    expect(store.url("f", key, a)).toBeNull();
    for (let i = 0; i < 20 && !store.ready("f"); i++) await settle();
    const img = store.url("f", key, a);
    expect(isRaster(img)).toBe(true);
    expect((img as PictureRaster).url).toMatch(/^data:image\/png;base64,/);
    expect(steps.mock.calls.map((c) => c[0])).not.toContain("picture_fallback");
  } finally {
    m.restore();
  }
  // A drawing that fails (a band that cannot be read back): the SVG stays, and the fallback is logged once.
  const failing: Rasteriser = {
    *draw() {
      yield Promise.resolve();
      return null;
    },
  };
  const { store } = rasterStore(failing);
  const flow = doc(FLOW.text);
  const { a } = inputOf(flow, entryOf(flow, FLOW.at, "m"));
  const key = {};
  store.url("f", key, a);
  await settle();
  expect(store.url("f", key, a)).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(steps.mock.calls.filter((c) => c[0] === "picture_fallback")).toHaveLength(1);
});

test("builds_run_one_at_a_time_nearest_first", async () => {
  // Task 9 fix 4: round 3 started every queued build at once, so 50 SVG decodes (parsed by WebKit in tasks the slices
  // cannot time) landed back to back between two frames. One build runs at a time, the best ranked first (FlowTab
  // ranks the frames in view by their distance from the view's centre).
  const { r, drawn, decoded } = fakeRasteriser({ hold: true });
  const rank: Record<string, number> = { far: 9, near: 1, mid: 4 };
  const { store } = storeWith({ rasterise: r, rank: (id) => rank[id] });
  const input = (name: string) => {
    const d = doc(`diagram flow "F"\n${name}\n`);
    return inputOf(d, entryOf(d, { [name]: { x: 0, y: 0 } }, "m"), false).a;
  };
  const ids = ["far", "near", "mid"];
  const keys = ids.map(() => ({}));
  ids.forEach((id, i) => expect(store.url(id, keys[i], input(`Shape ${id}`))).toBeNull());
  for (let i = 0; i < ids.length; i++) {
    await settle();
    // Only the build under way has asked for its decode; the others wait their turn.
    expect(decoded).toHaveLength(i + 1);
    decoded[i]();
  }
  await settle();
  const drewFor = drawn.map((d) => ids.find((id) => decode(d.url).includes(`Shape ${id}`)));
  expect(drewFor).toEqual(["near", "mid", "far"]);
  ids.forEach((id, i) => expect(isRaster(store.url(id, keys[i], input(`Shape ${id}`)))).toBe(true));
});

/** Runs a generator to its end. */
function drainAll<T>(g: Generator<unknown, T>): { value: T; steps: number } {
  let steps = 0;
  for (;;) {
    const r = g.next();
    if (r.done) return { value: r.value, steps };
    steps++;
  }
}

/** Steps of a flowchart whose picture's SVG is over twice PICTURE_PIECE_CHARS (about 640 K characters). */
const LONG = 1100;

/** A flowchart of `n` steps in a column: its picture's SVG is long. */
function longFlow(n: number): PictureInput {
  const names = Array.from({ length: n }, (_, i) => `Step number ${i}`);
  const d = doc([`diagram flow "Long"`, ...names, ...names.slice(1).map((m, i) => `${names[i]} > ${m}: next`)].join("\n"));
  return inputOf(d, entryOf(d, Object.fromEntries(names.map((m, i) => [m, { x: (i % 10) * 220, y: Math.floor(i / 10) * 100 }])), "m"), false).a;
}

test("a_long_svg_splits_into_whole_svgs_of_bounded_size", () => {
  // Task 9 fix 4: WebKit parses an SVG image in a task the slices cannot cut. A long picture is decoded in pieces:
  // each a whole SVG with the picture's head (root and defs), whole top-level elements in order, at most
  // PICTURE_PIECE_CHARS of them unless one element is longer alone.
  const svg = pictureSvg(longFlow(LONG), LIGHT, new Map());
  expect(svg.length).toBeGreaterThan(2 * PICTURE_PIECE_CHARS);
  const { value: pieces, steps } = drainAll(svgPieceSteps(svg));
  expect(pieces.length).toBeGreaterThan(2);
  expect(steps).toBe(pieces.length - 1);
  const close = svg.lastIndexOf("</svg>");
  const headEnd = svg.indexOf(">") + 1;
  const head = svg.slice(0, headEnd);
  const bodies = pieces.map((p) => {
    expect(p.startsWith(head)).toBe(true);
    expect(p.endsWith(svg.slice(close))).toBe(true);
    const parsed = new DOMParser().parseFromString(p, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    return p.slice(headEnd, p.lastIndexOf("</svg>"));
  });
  for (const b of bodies) expect(b.length).toBeLessThanOrEqual(PICTURE_PIECE_CHARS);
  // Drawn one over another in order, they are the picture.
  expect(bodies.join("")).toBe(svg.slice(headEnd, close));
  // A short SVG is one piece, itself; an element longer than a piece is a piece alone.
  expect(drainAll(svgPieceSteps(pictureSvg(longFlow(3), LIGHT, new Map()))).value).toHaveLength(1);
  const big = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9"><defs><filter id="h"/></defs><g>${"<rect/>".repeat(40)}</g><path d="${"M0 0".repeat(10)}"/><g a="x>y"><rect/></g></svg>\n`;
  const split = drainAll(svgPieceSteps(big, 100)).value;
  expect(split.map((p) => p.slice(p.indexOf("</defs>") + 7, p.lastIndexOf("</svg>")))).toEqual([`<g>${"<rect/>".repeat(40)}</g>`, `<path d="${"M0 0".repeat(10)}"/><g a="x>y"><rect/></g>`]);
});

test("a_picture_in_pieces_draws_each_piece_once_onto_its_bitmap", async () => {
  // Each piece is decoded alone (its parse bounded), drawn whole over the ones before it on a canvas of the bitmap's
  // size kept in memory, and the bitmap is read back in bands into the PNG; the canvas lets its pixels go at the end.
  const m = mockWebView();
  const proto = HTMLImageElement.prototype;
  const decodes: string[] = [];
  Object.defineProperty(proto, "decode", {
    configurable: true,
    value(this: HTMLImageElement) {
      decodes.push(this.src);
      return Promise.resolve();
    },
  });
  try {
    const svg = pictureSvg(longFlow(LONG), LIGHT, new Map());
    const pieces = drainAll(svgPieceSteps(svg)).value;
    const r = browserRasteriser()!;
    const { raster } = await run(r.drawPieces!(pieces.map((p) => `data:image/svg+xml;base64,${btoa(p)}`), 480, 160));
    expect(raster).toMatchObject({ w: 480, h: 160 });
    expect(raster!.url).toMatch(/^data:image\/png;base64,/);
    // One decode a piece, then the PNG's; each piece drawn whole, once, at the bitmap's size.
    expect(decodes.filter((u) => u.startsWith("data:image/svg"))).toHaveLength(pieces.length);
    expect(m.draws).toEqual(pieces.map(() => [0, 0, 480, 160]));
    const png = Uint8Array.from(atob(raster!.url.slice(raster!.url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    expect(new DataView(png.buffer).getUint32(16)).toBe(480);
    expect(new DataView(png.buffer).getUint32(20)).toBe(160);
    expect(m.created).toHaveLength(1);
    expect(m.created[0].isConnected).toBe(false);
    expect(m.created[0].width * m.created[0].height).toBe(1);
  } finally {
    m.restore();
  }
});

test("a_limit_frame_is_one_svg_document", async () => {
  // Task 9 fix 5: every SVG WebKit decodes is an SVG image of its own (a page with its document and render tree), kept
  // in its memory cache after the <img> lets it go. Round 4 cut a limit frame's 181 K characters into about 6 pieces:
  // about +150 MB at Fit live. A picture up to PICTURE_PIECE_CHARS (a limit frame, a sketch tile) is one document,
  // drawn by `draw` in bands as in round 3; only one far longer (a 2,000-table ERD, 3.4 M characters) is cut.
  const m = mockWebView();
  const proto = HTMLImageElement.prototype;
  const decodes: string[] = [];
  Object.defineProperty(proto, "decode", {
    configurable: true,
    value(this: HTMLImageElement) {
      decodes.push(this.src);
      return Promise.resolve();
    },
  });
  try {
    const a = longFlow(300);
    const svg = pictureSvg(a, LIGHT, new Map());
    expect(svg.length).toBeGreaterThan(170_000);
    expect(drainAll(svgPieceSteps(svg)).value).toEqual([svg]);
    const { store } = rasterStore(browserRasteriser()!);
    const key = {};
    store.url("f", key, a);
    for (let i = 0; i < 20 && !store.ready("f"); i++) await settle();
    expect(isRaster(store.url("f", key, a))).toBe(true);
    expect(decodes.filter((u) => u.startsWith("data:image/svg"))).toHaveLength(1);
  } finally {
    m.restore();
  }
});

test("the_store_draws_a_long_picture_in_pieces", async () => {
  // Through the store: a long frame's SVG is decoded a bounded piece at a time, never whole.
  const m = mockWebView();
  const proto = HTMLImageElement.prototype;
  const decodes: string[] = [];
  Object.defineProperty(proto, "decode", {
    configurable: true,
    value(this: HTMLImageElement) {
      decodes.push(this.src);
      return Promise.resolve();
    },
  });
  try {
    const { store } = rasterStore(browserRasteriser()!);
    const a = longFlow(LONG);
    const key = {};
    store.url("f", key, a);
    for (let i = 0; i < 20 && !store.ready("f"); i++) await settle();
    expect(isRaster(store.url("f", key, a))).toBe(true);
    const svgs = decodes.filter((u) => u.startsWith("data:image/svg"));
    expect(svgs.length).toBeGreaterThan(2);
    // The pieces `svgPieceSteps` makes of its SVG, each body at most PICTURE_PIECE_CHARS, in order.
    expect(svgs.map((u) => atob(u.slice(u.indexOf(",") + 1)))).toEqual(drainAll(svgPieceSteps(pictureSvg(a, LIGHT, new Map()))).value);
  } finally {
    m.restore();
  }
});
