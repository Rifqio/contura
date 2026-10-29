// Reading a board frame's picture (Plan F Decision 7) in tests: the SVG behind its <img>, and where it draws each shape
// and group area on the board.
import type { Node } from "@xyflow/react";
import type { FramePictureData } from "../flow/board/boardScene";

type Rect = { x: number; y: number; w: number; h: number };

/** The SVG a picture node's data: URL holds. */
export function pictureSvgOf(n: Node): string {
  const url = (n.data as FramePictureData).url!;
  return new TextDecoder().decode(Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0)));
}

/**
 * The flow boxes a picture draws its group areas and boxed shapes at (each one's first rect), areas first, for the
 * frame box at `box`: the picture node sits in the box where its view box starts.
 */
export function pictureShapes(n: Node, box: { x: number; y: number }): Rect[] {
  const svg = pictureSvgOf(n);
  const vb = /viewBox="([-\d.]+) ([-\d.]+)/.exec(svg)!;
  const [vx, vy] = [Number(vb[1]), Number(vb[2])];
  const out: { area: boolean; r: Rect }[] = [];
  for (const part of svg.split("<g data-").slice(1)) {
    const area = part.startsWith("area=");
    if (!area && !part.startsWith("node=")) continue;
    const head = part.slice(0, part.indexOf("</g>") < 0 ? part.length : part.indexOf("</g>"));
    const m = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(head);
    if (!m) continue;
    out.push({ area, r: { x: box.x + n.position.x + Number(m[1]) - vx, y: box.y + n.position.y + Number(m[2]) - vy, w: Number(m[3]), h: Number(m[4]) } });
  }
  return [...out.filter((o) => o.area), ...out.filter((o) => !o.area)].map((o) => o.r);
}
