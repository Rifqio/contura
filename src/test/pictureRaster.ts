// A rasteriser for node tests (Task 9 fixes 2 and 3): node has no canvas and no SVG decode. It takes the WebView's
// steps (one decode wait, then bands of PICTURE_BAND_PIXELS each read back as blank pixels and deflated, the PNG
// written around them and one decode wait), so a store holds each picture as the WebView's does: a PNG data: URL of
// the bitmap's size, counted with its decoded pixels.
import { nextBandRows, PICTURE_BAND_PIXELS, type Rasteriser } from "../flow/board/framePicture";
import { base64Steps, createDeflate, pngFileSteps, scanlines } from "../flow/board/pngSteps";

export const blankRasteriser: Rasteriser = {
  *draw(_url, w, h) {
    yield Promise.resolve();
    const deflate = createDeflate();
    for (let y = 0, rows = nextBandRows(PICTURE_BAND_PIXELS, 0, w); y < h; y += rows) {
      const n = Math.min(rows, h - y);
      deflate.write(scanlines(new Uint8Array(w * n * 4), w, n));
      yield;
    }
    const got: { z?: Uint8Array } = {};
    yield deflate.done().then((z) => void (got.z = z));
    const url = yield* base64Steps("data:image/png;base64,", yield* pngFileSteps(w, h, got.z!));
    yield Promise.resolve();
    return { url, w, h };
  },
};
