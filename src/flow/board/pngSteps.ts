// A PNG file written in steps (Task 9 fix 3). A picture's bitmap is drawn band by band on one scratch canvas and
// leaves the page as an <img> of a PNG: a <canvas> on the page is a compositing layer of its own in WebKit, with its
// own backing store and texture beside the pixels. The pixels go through the platform's deflate stream as each band is
// read back, and the file around them (chunks, CRCs, base64) is written here a bounded piece a step.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Deflated bytes in one IDAT chunk, its CRC one step. */
export const PNG_IDAT_PIECE = 256 * 1024;
/** Bytes turned into base64 in one step: a multiple of 3, so the pieces join into the whole's base64. */
const BASE64_PIECE = 3 * 65_536;

let table: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** The CRC-32 PNG puts after each chunk, over `parts` one after another. */
export function crc32(parts: readonly Uint8Array[]): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = t[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32([out.subarray(4, 8 + data.length)]));
  return out;
}

/** `rows` rows of `w` RGBA pixels as PNG scanlines: each row its filter byte (0, none), then its pixels. */
export function scanlines(px: Uint8ClampedArray | Uint8Array, w: number, rows: number): Uint8Array<ArrayBuffer> {
  const stride = w * 4;
  const out = new Uint8Array(rows * (stride + 1));
  for (let r = 0; r < rows; r++) out.set(px.subarray(r * stride, (r + 1) * stride), r * (stride + 1) + 1);
  return out;
}

/** The platform's zlib stream (CompressionStream "deflate", which is what IDAT holds): written a band at a time. */
export interface Deflate {
  write(bytes: Uint8Array<ArrayBuffer>): void;
  /** Ends the stream: its bytes once the platform has deflated them all. */
  done(): Promise<Uint8Array>;
  /** Drops the stream, for a band that could not be read. */
  abort(): void;
}

export function createDeflate(): Deflate {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  // Read as it is written, so a write never waits for room.
  const out = new Response(cs.readable).arrayBuffer();
  out.catch(() => {});
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  return {
    write: (bytes) => quiet(writer.write(bytes)),
    done: () => {
      quiet(writer.close());
      return out.then((b) => new Uint8Array(b));
    },
    abort: () => quiet(writer.abort()),
  };
}

/** The PNG file of a `w` by `h` RGBA image from its deflated scanlines `z`: one IDAT chunk of PNG_IDAT_PIECE a step. */
export function* pngFileSteps(w: number, h: number, z: Uint8Array): Generator<void, Uint8Array> {
  const head = new Uint8Array(13);
  const view = new DataView(head.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  head[8] = 8; // bits a channel
  head[9] = 6; // RGBA
  const parts: Uint8Array[] = [Uint8Array.from(SIGNATURE), chunk("IHDR", head)];
  for (let i = 0; i < z.length || i === 0; i += PNG_IDAT_PIECE) {
    if (i > 0) yield;
    parts.push(chunk("IDAT", z.subarray(i, i + PNG_IDAT_PIECE)));
  }
  parts.push(chunk("IEND", new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `prefix` and the base64 of `bytes`, a BASE64_PIECE of bytes a step. */
export function* base64Steps(prefix: string, bytes: Uint8Array): Generator<void, string> {
  const out = [prefix];
  for (let i = 0; i < bytes.length; i += BASE64_PIECE) {
    if (i > 0) yield;
    const part = bytes.subarray(i, i + BASE64_PIECE);
    let binary = "";
    for (let c = 0; c < part.length; c += 0x8000) binary += String.fromCharCode(...part.subarray(c, c + 0x8000));
    out.push(btoa(binary));
  }
  return out.join("");
}
