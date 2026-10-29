// The sketch layer pictured when far (Task 9 fix 2; Plan F Decision 7 as frames are, Figma and Miro draw a far board
// as pictures). Below the readable zoom the board's sketches draw as a few bitmaps instead of one node each: WebKit
// paints a thousand sketches (pens of 1,000 points, notes of 2,000 characters) as vector again at every new zoom. The
// sketches are grouped into tiles by where they start on a SKETCH_TILE grid, Sections and box sketches (under every
// frame) apart from the rest (over the live frame), and each tile is drawn by Publish's own sketch writer, so a tile
// shows what the canvas shows, in the canvas theme's palette.
import type { ExportPalette } from "../../diagram/export/palette";
import type { Box } from "../../diagram/export/scene";
import { hairlineId, iconRefs, svgDefs, wrapSvg } from "../../diagram/export/svg";
import type { SceneIcon } from "../flowScene";
import type { Sketch } from "./boardLayout";
import { createImageStore, type ImageKind, type ImageStore, type ImageStoreOptions, pictureRasterSize } from "./framePicture";
import { sketchSvg } from "./publish/boardSvg";
import { sketchExtent } from "./publish/boardPublish";
import { drawsUnder } from "./sketches";

/** A tile's side on the grid, in board units: 1,024 px at PICTURE_MAX_SCALE. */
export const SKETCH_TILE = 10_240;
/**
 * The node gate on the tile pictures held at B1's limit, counted as the frames' are (decoded pixels and PNG URLs;
 * Task 9 fix 3, only lowered): 6.34 MB in node for the 1,000 sketches at the caps, in 4 tiles.
 */
export const SKETCH_PICTURES_MAX_BYTES = 7 * 1024 * 1024;
/** Sketches written between two yields of a tile's build. */
const SKETCHES_A_STEP = 25;

/** One picture of the sketch layer: the sketches that start in one grid cell, under the frames or over them. */
export interface SketchTile {
  id: string;
  under: boolean;
  /** What its sketches draw, in board units: the union of their extents. */
  box: Box;
  /** In layout order, which is the order they are drawn in. */
  sketches: readonly Sketch[];
}

const NO_TITLES: ReadonlyMap<string, string> = new Map();

/** A tile drawn as SVG with its view box on `box`; icon sketches through the shared defs. */
function* tileSvgSteps(t: SketchTile, palette: ExportPalette, icons: ReadonlyMap<string, SceneIcon>): Generator<void, string> {
  const refs = iconRefs();
  const hairline = hairlineId();
  const parts: string[] = [];
  for (let i = 0; i < t.sketches.length; i++) {
    if (i > 0 && i % SKETCHES_A_STEP === 0) yield;
    parts.push(sketchSvg(t.sketches[i], palette, { icons, refs, titles: NO_TITLES, hairline }));
  }
  const body = parts.join("");
  const defs = svgDefs(palette, { hairline: body.includes(`url(#${hairline})`) ? hairline : null, icons: refs.entries() });
  return wrapSvg(defs, body, t.box, palette, { padding: 0, background: "transparent", mark: false });
}

const TILE_KIND: ImageKind<SketchTile> = {
  name: "tile",
  svgSteps: tileSvgSteps,
  iconNames: (t) => t.sketches.filter((s) => s.kind === "icon" && s.icon).map((s) => s.icon!),
  // Sketch text is body text: the layer turns real where body text does.
  size: (t, dpr) => pictureRasterSize(t.box, 1, dpr),
  variant: () => 0,
};

/** The sketch layer's tile pictures, as the frames' pictures are kept: one a tile, each until its replacement is in. */
export const createSketchPictureStore = (o: ImageStoreOptions): ImageStore<SketchTile> => createImageStore(TILE_KIND, o);

/**
 * The tiles of a sketch list, and each tile's key for its picture: the same key object while the tile holds the very
 * same sketch objects in the same order, so an edit draws only the tiles it touched again.
 */
export function createSketchTiles() {
  let last: readonly Sketch[] | null = null;
  let tiles: SketchTile[] = [];
  let keys = new Map<string, { sketches: readonly Sketch[]; key: object }>();
  return {
    of(sketches: readonly Sketch[]): readonly SketchTile[] {
      if (sketches === last) return tiles;
      last = sketches;
      const cells = new Map<string, { under: boolean; sketches: Sketch[]; box: { x0: number; y0: number; x1: number; y1: number } }>();
      for (const s of sketches) {
        const e = sketchExtent(s);
        const under = drawsUnder(s.kind);
        const id = `${under ? "u" : "o"}${Math.floor(e.x / SKETCH_TILE)},${Math.floor(e.y / SKETCH_TILE)}`;
        let c = cells.get(id);
        if (!c) {
          c = { under, sketches: [], box: { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + e.h } };
          cells.set(id, c);
        }
        c.sketches.push(s);
        c.box.x0 = Math.min(c.box.x0, e.x);
        c.box.y0 = Math.min(c.box.y0, e.y);
        c.box.x1 = Math.max(c.box.x1, e.x + e.w);
        c.box.y1 = Math.max(c.box.y1, e.y + e.h);
      }
      const nextKeys = new Map<string, { sketches: readonly Sketch[]; key: object }>();
      tiles = [];
      for (const [id, c] of cells) {
        const was = keys.get(id);
        const same = was && was.sketches.length === c.sketches.length && was.sketches.every((s, i) => s === c.sketches[i]);
        nextKeys.set(id, same ? was : { sketches: c.sketches, key: {} });
        tiles.push({ id, under: c.under, box: { x: c.box.x0, y: c.box.y0, w: Math.max(c.box.x1 - c.box.x0, 1), h: Math.max(c.box.y1 - c.box.y0, 1) }, sketches: c.sketches });
      }
      keys = nextKeys;
      return tiles;
    },
    /** A tile's picture key: the same object while its sketches are. */
    keyOf: (t: SketchTile): object => keys.get(t.id)!.key,
  };
}
