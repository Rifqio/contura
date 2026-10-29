// Tiny frames as cached pictures (Figma and Miro draw a far-out board as pictures and load detail
// in progressively). A static frame whose text is far draws as one picture of its SVG, made by B4's writer at the
// frame's local box from the same layout entry its real children use, in the canvas theme's palette, with soft text and
// ER cards cut at the canvas's 20 rows. The SVG is then drawn once into a bitmap at a capped scale, kept
// as a PNG: WebKit draws an <img> of an SVG as vector again at every new zoom, 500 parts a frame, while a bitmap
// only scales. The store keeps one picture a frame, its PNG (or, until that is in, the SVG's base64 URL) and nothing
// else: no canvas, no SVG text, no decoded SVG image; a theme switch
// drops every icon and builds every picture again; builds after the board's open run in time slices.
import { perfMark, perfMeasure, perfStep } from "../../perf/perfRecorder";
import type { ExportPalette, ExportTheme } from "../../diagram/export/palette";
import type { Scene } from "../../diagram/export/scene";
import { hairlineId, iconRefs, sceneBodySteps, sceneOutlined, svgDefs, wrapSvg } from "../../diagram/export/svg";
import type { FlowDoc } from "../../lang/flow/model";
import { flowSceneSteps, type SceneIcon, sceneIconNames } from "../flowScene";
import { ER_MAX_ROWS } from "../kindLayout";
import type { FlowLayout } from "../layout";
import type { ErNotation } from "./boardLayout";
import { BODY_PX, PICTURE_SLICE_MS, READABLE_PX } from "./boardDetail";
import { base64Steps, createDeflate, pngFileSteps, scanlines } from "./pngSteps";
import { frameOf } from "../../diagram/export/svg";

// The picture node's type (FramePicture.tsx) lives with the scene that makes the node, so the scene needs only types
// from here.
export { FRAME_PICTURE_TYPE } from "./boardScene";

/** What a frame's picture is drawn from: what its real children are built from, and its box (frame-local). */
export interface PictureInput {
  doc: FlowDoc;
  /** The frame's layout entry: its places, look, resized shapes and line axes. */
  layout: Pick<FlowLayout, "nodes" | "style" | "axes" | "sizes">;
  textScale: number;
  notation: ErNotation;
  /** The frame's drawn box relative to its `at`: the picture's view box, where its children are placed. */
  local: { x: number; y: number; w: number; h: number };
  /** Words as soft bars (text far); false keeps real words (`picture-text`, past BOARD_SIMPLIFY_OVER). */
  softText: boolean;
}

/** Test-only hooks: each picture's scene as it is built, and each stored entry as it is made. */
export const pictureHooks: { onScene?: (scene: Scene) => void; onEntry?: (frameId: string, entry: object) => void } = {};

/** Runs `steps` to its end. */
function drain<T>(steps: Generator<void, T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * A frame's picture as SVG text, in steps: its scene (`flowSceneSteps`, its resized shapes at their kept sizes and ER
 * rows cut at ER_MAX_ROWS as the canvas sizes and cuts them) drawn by the Publish writer, with a transparent background
 * and no mark, and a view box of `local`, so the image laid over the frame's box puts every shape where its real child
 * stands. It yields often, so one big frame (a 2,000-table ERD) is drawn across time slices.
 */
export function* pictureSvgSteps(a: PictureInput, palette: ExportPalette, icons: ReadonlyMap<string, SceneIcon>): Generator<void, string> {
  const scene = yield* flowSceneSteps(a.doc, a.layout.nodes, a.layout.style, icons, a.layout.axes, undefined, {
    textScale: a.textScale,
    notation: a.notation,
    rowCap: ER_MAX_ROWS,
    sizes: a.layout.sizes,
  });
  pictureHooks.onScene?.(scene);
  const refs = iconRefs();
  const hairline = hairlineId();
  const body = yield* sceneBodySteps(scene, palette, refs, hairline, { softText: a.softText, picture: true });
  yield;
  // The body's own check first: a scan of the text, where the scene's walks every participant's colours.
  const outlined = body.includes(`url(#${hairline})`) && sceneOutlined(scene, palette);
  const defs = svgDefs(palette, { hairline: outlined ? hairline : null, icons: refs.entries() });
  return wrapSvg(defs, body, a.local, palette, { padding: 0, background: "transparent", mark: false }, a.textScale);
}

/** `pictureSvgSteps` at once. */
export const pictureSvg = (a: PictureInput, palette: ExportPalette, icons: ReadonlyMap<string, SceneIcon>): string => drain(pictureSvgSteps(a, palette, icons));

/** Nothing past ASCII: such text is its own UTF-8, so `btoa` takes it as it is. */
const ASCII = /^[\x00-\x7f]*$/;
/** Characters (and bytes) encoded between two yields: a multiple of 3, so the pieces' base64 joins into the whole's. */
const URL_CHUNK = 3 * 65_536;

/**
 * The picture as the base64 data: URL its <img> takes (`svgPreviewUrl`'s form), in steps of URL_CHUNK. Plain ASCII
 * (most pictures) goes to `btoa` as it is, with no copy through bytes; from the first piece that is not, the rest goes
 * through UTF-8 bytes.
 */
function* urlSteps(svg: string): Generator<void, string> {
  const out = ["data:image/svg+xml;base64,"];
  let i = 0;
  for (; i < svg.length; i += URL_CHUNK) {
    const piece = svg.slice(i, i + URL_CHUNK);
    if (!ASCII.test(piece)) break;
    if (i > 0) yield;
    out.push(btoa(piece));
  }
  if (i < svg.length) {
    yield;
    const bytes = new TextEncoder().encode(svg.slice(i));
    for (let j = 0; j < bytes.length; j += URL_CHUNK) {
      yield;
      const part = bytes.subarray(j, j + URL_CHUNK);
      let binary = "";
      for (let c = 0; c < part.length; c += 0x8000) binary += String.fromCharCode(...part.subarray(c, c + 0x8000));
      out.push(btoa(binary));
    }
  }
  return out.join("");
}

/** A picture's data: URL at once. */
export const pictureUrl = (svg: string): string => drain(urlSteps(svg));

/**
 * SVG text a bitmap is drawn from in one decode at most (Task 9 fixes 4 and 5). WebKit parses an SVG image when its
 * data arrives, in a task of its own the slices cannot time or cut: a picture's SVG longer than this (the 2,000-table
 * ERD's 3.4 M characters, parsed in one 173 ms frame live) is decoded and drawn in pieces of whole elements, each a
 * complete SVG with the picture's head, defs and view box, drawn one over another in order. An element longer than
 * this is a piece alone.
 *
 * Each piece is an SVG image of its own in WebKit (a page with its document and render tree), which its memory cache
 * keeps after the <img> lets it go, counted there by its encoded bytes only. Round 4's 32 K pieces made about 6
 * documents of each limit frame (181 K characters) and about 105 of the ERD: about +150 MB at Fit. At 256 K a limit
 * frame is one document, as in round 3, and the ERD about 14.
 */
export const PICTURE_PIECE_CHARS = 262_144;

/** Where the tag opened at `lt` ends (its `>`), past quoted attribute values; -1 when it does not. */
function tagEnd(svg: string, lt: number): number {
  let quote = "";
  for (let i = lt + 1; i < svg.length; i++) {
    const c = svg[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/**
 * A picture's SVG (`wrapSvg`'s form) as whole SVGs of at most `most` characters of body each, in steps: one a step.
 * Each keeps the head (the root tag and the defs) and the closing tag, and a body of whole top-level elements in their
 * order, so drawing them one over another draws the picture. One SVG when it is short enough, or not of that form.
 */
export function* svgPieceSteps(svg: string, most: number = PICTURE_PIECE_CHARS): Generator<void, string[]> {
  const open = svg.startsWith("<svg") ? tagEnd(svg, 0) : -1;
  const close = svg.lastIndexOf("</svg>");
  if (open < 0 || close < open) return [svg];
  let start = open + 1;
  if (svg.startsWith("<defs>", start)) {
    const defsEnd = svg.indexOf("</defs>", start);
    if (defsEnd < 0) return [svg];
    start = defsEnd + "</defs>".length;
  }
  if (close - start <= most) return [svg];
  const head = svg.slice(0, start);
  const tail = svg.slice(close);
  const pieces: string[] = [];
  let from = start;
  /** The end of the last whole top-level element at or before the piece's limit. */
  let cut = start;
  let depth = 0;
  for (let i = start; i < close; ) {
    const lt = svg.indexOf("<", i);
    if (lt < 0 || lt >= close) break;
    let end: number;
    if (svg.startsWith("<!--", lt)) {
      const c = svg.indexOf("-->", lt);
      end = c < 0 ? close - 1 : c + 2;
    } else {
      end = tagEnd(svg, lt);
      if (end < 0) return [svg];
      if (svg[lt + 1] === "/") depth--;
      else if (svg[end - 1] !== "/") depth++;
    }
    i = end + 1;
    if (depth !== 0) continue;
    if (i - from > most && cut > from) {
      pieces.push(head + svg.slice(from, cut) + tail);
      from = cut;
      yield;
    }
    cut = i;
    if (i - from > most) {
      // One element longer than a piece: a piece alone.
      pieces.push(head + svg.slice(from, i) + tail);
      from = cut = i;
      yield;
    }
  }
  if (close > from) pieces.push(head + svg.slice(from, close) + tail);
  return pieces;
}

/**
 * Most device pixels a picture's bitmap gives one board unit. The bitmaps count at their real size
 * (width x height x 4) in the store's bytes, under Decision 14's node gates (13 MB on B1's limit board, 15 MB on the ER
 * limit board). The cap the task asked for, the frame's size on screen where it turns real (about 0.46 for body text)
 * times the device pixel ratio, is 4.6 times this a side: about 200 MB for the limit board's 50 frames of about 4,700 by
 * 1,100. So the scale is lowered until the gate holds: 0.1, the board's least zoom (MIN_ZOOM), where a far board is
 * seen most and the bitmap is drawn one to one: 9.58 MB on the limit board, 11.66 MB on the ER limit board.
 */
export const PICTURE_MAX_SCALE = 0.1;
/** Most pixels a side of a picture's bitmap, and in all (4 MB of pixels): an ERD of 2,000 tables included. */
export const PICTURE_MAX_SIDE = 2048;
export const PICTURE_MAX_PIXELS = 1024 * 1024;
/**
 * Pixels of a bitmap drawn from its SVG and read back in one step at most: a band of as many whole rows
 * as fit, never fewer than PICTURE_BAND_MIN_ROWS. A band that took longer than half of PICTURE_SLICE_MS halves the
 * next; one under an eighth of it doubles the next, up to this.
 */
export const PICTURE_BAND_PIXELS = 32_768;
export const PICTURE_BAND_MIN_ROWS = 8;

/** The next band's rows after one of `rows` took `ms`, for a bitmap `w` wide. */
export function nextBandRows(rows: number, ms: number, w: number): number {
  const most = Math.max(PICTURE_BAND_MIN_ROWS, Math.floor(PICTURE_BAND_PIXELS / w));
  if (ms > PICTURE_SLICE_MS / 2) return Math.max(PICTURE_BAND_MIN_ROWS, Math.floor(rows / 2));
  if (ms < PICTURE_SLICE_MS / 8) return Math.min(most, rows * 2);
  return Math.min(most, rows);
}

/**
 * A picture drawn into a bitmap, kept as a PNG's data: URL `w` by `h` pixels: it is
 * shown by an <img>, which WebKit paints into the canvas's own layer, where a <canvas> on the page is a compositing
 * layer of its own (a backing store and a texture beside its pixels), and every node drawn over one becomes a layer too.
 */
export interface PictureRaster {
  readonly url: string;
  readonly w: number;
  readonly h: number;
}

/** A frame's picture: its bitmap, or the SVG's data: URL until the bitmap is in (or where nothing can draw one). */
export type PictureImage = string | PictureRaster;

/**
 * Draws a picture's SVG into a bitmap, in steps. A step that yields a promise waits for it (a decode, the deflate);
 * every other step is bounded work on the main thread (a band, a piece of the file). Null when this system cannot
 * draw it.
 */
export interface Rasteriser {
  draw(url: string, w: number, h: number): Generator<Promise<unknown> | void, PictureRaster | null>;
  /**
   * The same bitmap from a picture in pieces (`svgPieceSteps`, each a data: URL), drawn one over another in order.
   * Without it a picture in pieces is drawn from its whole SVG.
   */
  drawPieces?(urls: readonly string[], w: number, h: number): Generator<Promise<unknown> | void, PictureRaster | null>;
}

/**
 * A picture's bitmap size for its local box: its size on screen at the zoom where text of `textScale` turns readable,
 * times `dpr`, capped at PICTURE_MAX_SCALE, PICTURE_MAX_SIDE and PICTURE_MAX_PIXELS; never under one pixel.
 */
export function pictureRasterSize(local: { x: number; y: number; w: number; h: number }, textScale: number, dpr: number): { w: number; h: number } {
  const box = frameOf(local, { padding: 0 });
  const real = READABLE_PX / (BODY_PX * textScale);
  const scale = Math.min(real * dpr, PICTURE_MAX_SCALE, PICTURE_MAX_SIDE / box.w, PICTURE_MAX_SIDE / box.h, Math.sqrt(PICTURE_MAX_PIXELS / (box.w * box.h)));
  return { w: Math.max(1, Math.floor(box.w * scale)), h: Math.max(1, Math.floor(box.h * scale)) };
}

/** The one canvas every bitmap is drawn on, a band at a time: never on the page, its pixels read back each band. */
let scratch: CanvasRenderingContext2D | null | undefined;
function scratchContext(): CanvasRenderingContext2D | null {
  if (scratch !== undefined) return scratch;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  // Read back every band: WebKit keeps such a canvas in memory, not on the GPU, so a band is drawn when it is asked
  // for (and timed as its step), not later in a frame the slices cannot see.
  scratch = canvas.getContext("2d", { willReadFrequently: true });
  return scratch;
}

/**
 * The WebView's rasteriser. The SVG is decoded by an <img> (the app's CSP allows data: images, not
 * blob:); then, a band a step on the one scratch canvas, its rows are drawn (a source rect of the SVG, so WebKit
 * paints only the parts in it), read back and handed to the platform's deflate stream; the PNG file is written around
 * the deflated pixels and decoded once before it is shown. Every step is timed (`perfStep`) and the bands follow the
 * time they take (`nextBandRows`). No canvas is kept: the bitmap is the PNG. Undefined where images cannot be decoded
 * (jsdom) or there is no deflate stream: the store keeps the SVG. Null for a picture whose band cannot be read back.
 */
export function browserRasteriser(): Rasteriser | undefined {
  if (
    typeof document === "undefined" ||
    typeof HTMLImageElement === "undefined" ||
    typeof HTMLImageElement.prototype.decode !== "function" ||
    typeof CompressionStream === "undefined"
  )
    return undefined;
  return {
    *draw(url, w, h) {
      const img = new Image();
      let ctx: CanvasRenderingContext2D | null = null;
      let deflate: ReturnType<typeof createDeflate> | null = null;
      // Every band deflated: anything short of that (a failure, or the store abandoning the build with `return()`,
      // which runs `finally` and not `catch`) drops the stream and lets the image go (final review M1).
      let banded = false;
      try {
        let ok = true;
        img.src = url;
        yield img.decode().catch(() => {
          ok = false;
        });
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        ctx = scratchContext();
        if (!ok || iw === 0 || ih === 0 || !ctx) return null;
        deflate = createDeflate();
        const sy = ih / h;
        let rows = nextBandRows(PICTURE_BAND_PIXELS, 0, w);
        for (let y = 0; y < h; ) {
          const n = Math.min(rows, h - y);
          const t0 = performance.now();
          const c = ctx.canvas;
          if (c.width !== w || c.height !== n) {
            c.width = w;
            c.height = n;
          } else ctx.clearRect(0, 0, w, n);
          ctx.drawImage(img, 0, y * sy, iw, n * sy, 0, 0, w, n);
          deflate.write(scanlines(ctx.getImageData(0, 0, w, n).data, w, n));
          const took = performance.now() - t0;
          perfStep("picture_band", took);
          rows = nextBandRows(rows, took, w);
          y += n;
          yield;
        }
        banded = true;
      } catch {
        // A band that cannot be read back (a canvas the SVG tainted): the store keeps the SVG.
        return null;
      } finally {
        if (!banded) deflate?.abort();
        img.src = "";
        // The scratch canvas keeps one pixel between bitmaps.
        if (ctx) {
          ctx.canvas.width = 1;
          ctx.canvas.height = 1;
        }
      }
      if (!deflate) return null;
      return yield* pngSteps(deflate, w, h);
    },
    *drawPieces(urls, w, h) {
      // Its own canvas of the bitmap's size, in memory (read back), its pixels let go when it ends however it ends.
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const img = new Image();
      let deflate: ReturnType<typeof createDeflate> | null = null;
      // As in `draw`: short of every band deflated (a failure or an abandon), the stream is dropped.
      let banded = false;
      try {
        if (!ctx) return null;
        for (const url of urls) {
          let ok = true;
          img.src = url;
          // The piece's parse: bounded by PICTURE_PIECE_CHARS.
          yield img.decode().catch(() => {
            ok = false;
          });
          if (!ok || img.naturalWidth === 0 || img.naturalHeight === 0) return null;
          // Its layout and paint, over the pieces before it; one pixel read back makes WebKit draw it now, in this step.
          const t0 = performance.now();
          ctx.drawImage(img, 0, 0, w, h);
          ctx.getImageData(0, 0, 1, 1);
          perfStep("picture_piece", performance.now() - t0);
          img.src = "";
          yield;
        }
        deflate = createDeflate();
        let rows = nextBandRows(PICTURE_BAND_PIXELS, 0, w);
        for (let y = 0; y < h; ) {
          const n = Math.min(rows, h - y);
          const t0 = performance.now();
          deflate.write(scanlines(ctx.getImageData(0, y, w, n).data, w, n));
          const took = performance.now() - t0;
          perfStep("picture_band", took);
          rows = nextBandRows(rows, took, w);
          y += n;
          yield;
        }
        banded = true;
      } catch {
        // A piece that cannot be read back (a canvas an SVG tainted): the store keeps the SVG.
        return null;
      } finally {
        if (!banded) deflate?.abort();
        img.src = "";
        canvas.width = 1;
        canvas.height = 1;
      }
      return yield* pngSteps(deflate, w, h);
    },
  };
}

/** The PNG of the pixels deflated so far, in steps: the deflate's end, the file, its URL and one decode before it shows. */
function* pngSteps(deflate: ReturnType<typeof createDeflate>, w: number, h: number): Generator<Promise<unknown> | void, PictureRaster | null> {
  const deflated: { z?: Uint8Array } = {};
  yield deflate.done().then(
    (z) => {
      deflated.z = z;
    },
    () => {},
  );
  if (!deflated.z) return null;
  const t0 = performance.now();
  const png = yield* pngFileSteps(w, h, deflated.z);
  const pngUrl = yield* base64Steps("data:image/png;base64,", png);
  perfStep("picture_png", performance.now() - t0);
  // Decoded before it is shown (off the main thread where WebKit can), so its first paint does not decode it.
  const shown = new Image();
  shown.src = pngUrl;
  yield shown.decode().catch(() => {});
  return { url: pngUrl, w, h };
}

/**
 * `fn` at most once an animation frame: a store's `onReady`. Its slices run back to back between two
 * frames, and each that built a picture drew the whole board again; now the board is drawn once, at the next frame.
 */
export function oncePerFrame(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

export interface ImageStore<In, I extends PictureImage = PictureImage> {
  /**
   * Frame `frameId`'s picture for `key` (the object its children were built from): its bitmap, or its SVG's data: URL
   * until that is in. At open (`sync`) it is built at once (the SVG; its bitmap is drawn in slices after); after open a
   * picture not built for `key` (or for this theme) yet is queued and the one held so far is handed back (null with
   * none) until its replacement is built.
   */
  url(frameId: string, key: object, a: In): I | null;
  /** Whether the frame's picture is built for the last key asked, in this theme. */
  ready(frameId: string): boolean;
  /**
   * The canvas theme: a change drops every icon and every queued build. Each picture stays on screen until its
   * replacement in the new theme is built (controller ruling, Task 7), so the board never blanks.
   */
  setTheme(t: ExportTheme): void;
  /** Drops the pictures and queued builds of frames not in `live`. */
  prune(live: ReadonlySet<string>): void;
  /**
   * Drops every queued build, ending the one under way, and keeps the pictures (a closed tab, final review M2). An icon
   * load that comes in afterwards queues nothing; the next `url` queues again (React's development re-mount).
   */
  dispose(): void;
  /** The pictures held: each bitmap's pixels (width x height x 4), each SVG URL's length. */
  bytes(): number;
}

/** A frame's pictures. */
export type PictureStore<I extends PictureImage = PictureImage> = ImageStore<PictureInput, I>;

/** How an image store draws one kind of thing (a frame, a tile of the sketch layer) as SVG and sizes its bitmap. */
export interface ImageKind<In> {
  /** Its steps' name in the perf log: `<name>_step`. */
  name: string;
  svgSteps(a: In, palette: ExportPalette, icons: ReadonlyMap<string, SceneIcon>): Generator<void, string>;
  iconNames(a: In): readonly string[];
  /** Its bitmap's size for a device pixel ratio. */
  size(a: In, dpr: number): { w: number; h: number };
  /** What else, besides its key, tells two of its pictures apart (a frame's soft or real words). */
  variant(a: In): unknown;
}

export interface ImageStoreOptions {
  palette(t: ExportTheme): ExportPalette;
  loadIcons(names: string[], t: ExportTheme): Promise<ReadonlyMap<string, SceneIcon>>;
  onReady(): void;
  now?: () => number;
  sync?: boolean;
  /** Draws each picture into a bitmap; without one the store keeps the SVG URLs. */
  rasterise?: Rasteriser;
  /** The device pixel ratio the bitmaps are sized for. */
  dpr?: () => number;
  /**
   * Which queued build starts next: the least rank first (Task 9 fix 4: the frames in view, nearest the view's centre,
   * before the rest). Without it, the order asked.
   */
  rank?: (id: string) => number;
}

interface Entry<In> {
  key: object;
  variant: unknown;
  /** The theme generation it was built in. */
  gen: number;
  image: PictureImage;
  /** Built while some of its icons were still loading: built once more when they arrive. */
  partial: boolean;
  /** What it was built from, kept only while `partial`, for that second build. */
  a: In | null;
}

interface Job<In> {
  key: object;
  a: In;
  gen: number;
  /** The build under way, kept across slices; with it, whether it lacks some icons. */
  steps?: Generator<Promise<unknown> | void, PictureImage>;
  partial?: boolean;
  /** Drawing the bitmap of the entry held now (built at open as SVG): the entry stays current meanwhile. */
  upgrade?: boolean;
  /** Waiting for a decode: skipped by the slices until it is done. */
  waiting?: boolean;
  /** An upgrade's SVG (built at open), drawn into its bitmap when the job starts. */
  svg?: string;
}

/** A picture's bytes: an SVG URL's length; a bitmap's decoded pixels (width x height x 4) and its PNG URL's length. */
const imageBytes = (img: PictureImage) => (typeof img === "string" ? img.length : img.w * img.h * 4 + img.url.length);

/** A frame's picture: B4's writer at its local box, its bitmap sized by `pictureRasterSize`. */
const FRAME_KIND: ImageKind<PictureInput> = {
  name: "picture",
  svgSteps: pictureSvgSteps,
  iconNames: (a) => sceneIconNames(a.doc),
  size: (a, dpr) => pictureRasterSize(a.local, a.textScale, dpr),
  variant: (a) => a.softText,
};

export function createPictureStore(o: ImageStoreOptions): PictureStore {
  return createImageStore(FRAME_KIND, o);
}

/**
 * Pictures of one kind of thing, one an id, built in time slices after open (at open at once, `sync`), each drawn into a
 * bitmap when the store has a rasteriser. Each stays until its replacement is built, a theme switch included.
 */
export function createImageStore<In>(kind: ImageKind<In>, o: ImageStoreOptions): ImageStore<In> {
  const now = o.now ?? (() => performance.now());
  const dpr = o.dpr ?? (() => (typeof window !== "undefined" && window.devicePixelRatio) || 1);
  let theme: ExportTheme = "light";
  let palette: ExportPalette | null = null;
  const entries = new Map<string, Entry<In>>();
  /** Builds waiting for a slice, in the order asked; the first may be part way through. */
  const jobs = new Map<string, Job<In>>();
  /** This theme's icons by name: null for one the pack does not have. */
  let icons = new Map<string, SceneIcon | null>();
  const loading = new Set<string>();
  /** Bumped by a theme switch: a load for the old theme is dropped, and every picture is built again. */
  let generation = 0;
  /** At open every picture is built at once; the open ends with the task that first asked. */
  let opening = o.sync === true;
  let openEnds = false;
  let sliceQueued = false;
  let held = 0;
  /** Disposed, and nothing asked since: an icon load coming in builds nothing again. */
  let quiet = false;

  const paletteNow = () => (palette ??= o.palette(theme));
  const stepName = `${kind.name}_step`;
  const fallbackName = `${kind.name}_fallback`;

  function loadMissing(names: readonly string[]) {
    const missing = names.filter((n) => !icons.has(n) && !loading.has(n));
    if (missing.length === 0) return;
    for (const n of missing) loading.add(n);
    const gen = generation;
    const done = (got: ReadonlyMap<string, SceneIcon>) => {
      if (gen !== generation) return;
      for (const n of missing) {
        loading.delete(n);
        icons.set(n, got.get(n) ?? null);
      }
      if (quiet) return;
      // Each frame built without some icons is built once more when the last of them is in: one swap, however many
      // loads its icons came by.
      for (const [id, e] of entries) {
        if (!e.partial || !e.a || e.gen !== generation || (jobs.has(id) && !jobs.get(id)!.upgrade)) continue;
        const names = kind.iconNames(e.a);
        if (names.some((n) => missing.includes(n)) && names.every((n) => icons.has(n))) setJob(id, { key: e.key, a: e.a, gen: generation });
      }
      schedule();
    };
    o.loadIcons(missing, theme).then(done, () => done(new Map()));
  }

  /**
   * The bitmap of a picture's SVG URL, in steps; the URL itself where nothing draws bitmaps or the drawing fails. A
   * failed drawing leaves the SVG on the page, which WebKit draws as vector again at every zoom: it is logged as
   * `<name>_fallback`, so a live run shows it.
   */
  function* rasterSteps(svg: string, a: In): Generator<Promise<unknown> | void, PictureImage> {
    if (!o.rasterise) return yield* urlSteps(svg);
    const size = kind.size(a, dpr());
    const t0 = now();
    // A long SVG is decoded and drawn in pieces of bounded size, one a step.
    const pieces = o.rasterise.drawPieces ? yield* svgPieceSteps(svg) : [svg];
    const urls: string[] = [];
    for (const p of pieces) {
      if (urls.length > 0) yield;
      urls.push(yield* urlSteps(p));
    }
    const raster = urls.length > 1 ? yield* o.rasterise.drawPieces!(urls, size.w, size.h) : yield* o.rasterise.draw(urls[0], size.w, size.h);
    if (raster) return raster;
    perfStep(fallbackName, now() - t0);
    return urls.length > 1 ? yield* urlSteps(svg) : urls[0];
  }

  /** The SVG of a job's picture, with the icons in now, asking for the others. */
  function svgSteps(job: Job<In>): Generator<void, string> {
    const names = kind.iconNames(job.a);
    const have = new Map<string, SceneIcon>();
    let partial = false;
    for (const n of names) {
      const icon = icons.get(n);
      if (icon) have.set(n, icon);
      else if (icon === undefined) partial = true;
    }
    if (partial) loadMissing(names);
    job.partial = partial;
    return kind.svgSteps(job.a, paletteNow(), have);
  }

  /** Starts a job's build: its SVG, then its bitmap (an upgrade: the bitmap of the SVG built at open). */
  function start(job: Job<In>): Generator<Promise<unknown> | void, PictureImage> {
    const svg = job.svg;
    job.svg = undefined;
    const steps =
      svg !== undefined
        ? rasterSteps(svg, job.a)
        : (function* () {
            return yield* rasterSteps(yield* svgSteps(job), job.a);
          })();
    job.steps = steps;
    return steps;
  }

  /** A build let go part way (replaced, pruned, a theme switch): its steps end now, so it lets go what it holds. */
  function abandon(job: Job<In> | undefined) {
    if (!job?.steps) return;
    const steps = job.steps;
    job.steps = undefined;
    try {
      steps.return(undefined as unknown as PictureImage);
    } catch {
      // A rasteriser's clean-up that throws changes nothing here: the job is gone.
    }
  }

  /** Puts `job` in for `id`, ending the build it replaces. */
  function setJob(id: string, job: Job<In>) {
    const was = jobs.get(id);
    if (was && was !== job) abandon(was);
    jobs.set(id, job);
  }

  function dropJob(id: string) {
    abandon(jobs.get(id));
    jobs.delete(id);
  }

  /**
   * The build to run next: the one under way while it is not waiting, else, with none under way, the
   * best ranked. One build at a time: each holds its SVG decode, its scratch pixels and its PNG while it runs, and the
   * WebView parses an SVG in a task the slices cannot time, so 50 builds started at once (round 3) parsed 50 SVGs back
   * to back between two frames. Undefined when the one under way waits, or nothing is queued.
   */
  function nextJob(): string | undefined {
    let best: string | undefined;
    let bestRank = Infinity;
    for (const [id, job] of jobs) {
      if (job.steps) return job.waiting ? undefined : id;
      const r = o.rank ? o.rank(id) : 0;
      if (best === undefined || r < bestRank) {
        best = id;
        bestRank = r;
      }
    }
    return best;
  }

  function drop(img: PictureImage) {
    held -= imageBytes(img);
  }

  /** A finished build replaces the frame's picture: one picture a frame. */
  function keep(frameId: string, job: Job<In>, image: PictureImage) {
    const was = entries.get(frameId);
    // The bitmap of the picture held: drawn in place, the entry otherwise as it is.
    if (job.upgrade) {
      if (!was || was.key !== job.key || was.gen !== job.gen || typeof was.image !== "string") return;
      held += imageBytes(image) - imageBytes(was.image);
      was.image = image;
      return;
    }
    if (was) held -= imageBytes(was.image);
    const partial = job.partial === true;
    const entry: Entry<In> = { key: job.key, variant: kind.variant(job.a), gen: job.gen, image, partial, a: partial ? job.a : null };
    entries.set(frameId, entry);
    held += imageBytes(image);
    pictureHooks.onEntry?.(frameId, entry);
    // Its icons came in while it was being built (a build may span slices): built once more now, with them.
    if (partial && job.gen === generation && kind.iconNames(job.a).every((n) => icons.has(n))) {
      setJob(frameId, { key: job.key, a: job.a, gen: job.gen });
      schedule();
    }
  }

  /** The longest step of late, fading slowly (2 percent a step), so one long step keeps the next slices short. */
  let slowest = 0;
  /**
   * One task of build steps: at least one, and another only while twice the slowest step of late still fits in half
   * of PICTURE_SLICE_MS. The other half is room for a step that runs long (a collection, a big string joined), which
   * no estimate sees coming: packing to the edge passed 8 ms on the ER limit board. A big frame's build goes on in
   * the next task where it stopped; one waiting for its image's decode is passed over until the decode is done.
   */
  function slice() {
    sliceQueued = false;
    const begin = now();
    let ran = 0;
    let finished = 0;
    outer: for (let id = nextJob(); id !== undefined; id = nextJob()) {
      const job = jobs.get(id)!;
      const steps = job.steps ?? start(job);
      for (;;) {
        if (ran > 0 && now() - begin + 2 * slowest > PICTURE_SLICE_MS / 2) break outer;
        const t0 = now();
        const r = steps.next();
        const took = now() - t0;
        slowest = Math.max(took, slowest * 0.98);
        perfStep(stepName, took);
        ran++;
        if (r.done) {
          jobs.delete(id);
          keep(id, job, r.value);
          finished++;
          break;
        }
        if (r.value) {
          job.waiting = true;
          const go = () => {
            job.waiting = false;
            schedule();
          };
          r.value.then(go, go);
          break;
        }
      }
    }
    schedule();
    if (building && jobs.size === 0) {
      building = false;
      perfMeasure("pictures_settled", "pictures_queued");
    }
    if (finished > 0) o.onReady();
  }

  /** The recorder's mark for a build started from idle, ended when the queue is empty again. */
  let building = false;
  function schedule() {
    if (sliceQueued || jobs.size === 0) return;
    // The build under way waits on a decode: the decode's end schedules the next slice.
    for (const j of jobs.values()) if (j.waiting) return;
    sliceQueued = true;
    if (!building) {
      building = true;
      perfMark("pictures_queued");
    }
    // WebKit has no requestIdleCallback to rely on: a chain of tasks.
    setTimeout(slice, 0);
  }

  const current = (e: Entry<In> | undefined, key: object, a: In) => e !== undefined && e.key === key && e.variant === kind.variant(a) && e.gen === generation;
  /** A queued build that replaces the entry (not one drawing its bitmap). */
  const replacing = (id: string) => {
    const j = jobs.get(id);
    return j !== undefined && !j.upgrade;
  };

  return {
    url(frameId, key, a) {
      quiet = false;
      const e = entries.get(frameId);
      if (current(e, key, a)) {
        if (replacing(frameId)) dropJob(frameId);
        return e!.image;
      }
      if (opening) {
        if (!openEnds) {
          openEnds = true;
          setTimeout(() => {
            opening = false;
          }, 0);
        }
        dropJob(frameId);
        const job: Job<In> = { key, a, gen: generation };
        const t0 = now();
        const svg = drain(svgSteps(job));
        const url = drain(urlSteps(svg));
        perfStep(`${kind.name}_open`, now() - t0);
        keep(frameId, job, url);
        // Its bitmap is drawn in slices from here; the SVG shows until it is in.
        if (o.rasterise && !jobs.has(frameId)) {
          setJob(frameId, { key, a, gen: generation, upgrade: true, svg });
          schedule();
        }
        return entries.get(frameId)!.image;
      }
      // A build for the same picture keeps going where it is; another replaces it.
      const j = jobs.get(frameId);
      if (!(j && !j.upgrade && j.key === key && kind.variant(j.a) === kind.variant(a) && j.gen === generation)) setJob(frameId, { key, a, gen: generation });
      schedule();
      return e?.image ?? null;
    },
    ready(frameId) {
      const e = entries.get(frameId);
      return e !== undefined && e.gen === generation && !replacing(frameId);
    },
    setTheme(t) {
      if (t === theme) return;
      theme = t;
      palette = null;
      generation++;
      icons = new Map();
      loading.clear();
      for (const id of [...jobs.keys()]) dropJob(id);
    },
    prune(live) {
      for (const id of [...entries.keys()]) {
        if (live.has(id)) continue;
        drop(entries.get(id)!.image);
        entries.delete(id);
      }
      for (const id of [...jobs.keys()]) if (!live.has(id)) dropJob(id);
    },
    dispose() {
      quiet = true;
      for (const id of [...jobs.keys()]) dropJob(id);
    },
    bytes: () => held,
  };
}
