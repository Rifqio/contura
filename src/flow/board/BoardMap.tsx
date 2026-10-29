import { Panel, useReactFlow, useStore } from "@xyflow/react";
import { useRef, useState } from "react";
import type { CanvasHandle } from "../../diagram/canvasView";
import type { FrameBox } from "./boardScene";

/** The map's size, the one the one-frame MiniMap has. */
const MAP_W = 200;
const MAP_H = 140;
/** A press that moves less than this many pixels is a click (a jump); more is a pan. */
const DRAG_PX = 3;

type World = { x: number; y: number; w: number; h: number };

/**
 * The frame-box overview (Miro's map beside the zoom control): one outline per frame box, the live
 * frame filled with the accent tokens, and the view as a rect. A click glides there through `glide`; a drag pans the
 * view with no duration. It draws boxes only, so its cost does not grow with the shapes on the board. The view comes
 * from React Flow's store; the map keeps no state of its own that outlives it (the toggle's is the zoom panel's).
 */
export default function BoardMap(p: { boxes: readonly FrameBox[]; live: number | null; glide: CanvasHandle["glideView"]; cancelGlide?: CanvasHandle["cancelGlide"] }) {
  const { setViewport } = useReactFlow();
  const tx = useStore((s) => s.transform[0]);
  const ty = useStore((s) => s.transform[1]);
  const zoom = useStore((s) => s.transform[2]);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const view = { x: -tx / zoom, y: -ty / zoom, w: width / zoom, h: height / zoom };

  // The world is the boxes and the view with a margin; a drag keeps the one it started with, so the map does not
  // rescale under the pointer as the view moves.
  const frozen = useRef<World | null>(null);
  const [dragging, setDragging] = useState(false);
  const world = frozen.current ?? worldOf(p.boxes, view);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const flowAt = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rw = r.width || MAP_W;
    const rh = r.height || MAP_H;
    const s = Math.min(rw / world.w, rh / world.h);
    return {
      x: world.x + (e.clientX - r.left - (rw - world.w * s) / 2) / s,
      y: world.y + (e.clientY - r.top - (rh - world.h * s) / 2) / s,
    };
  };
  const centreOn = (c: { x: number; y: number }) => void setViewport({ x: width / 2 - c.x * zoom, y: height / 2 - c.y * zoom, zoom });

  return (
    <Panel position="bottom-right" className="board-map">
      <svg
        className="board-map-svg"
        role="img"
        aria-label="Overview"
        width={MAP_W}
        height={MAP_H}
        viewBox={`${world.x} ${world.y} ${world.w} ${world.h}`}
        data-dragging={dragging || undefined}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          // A press ends a glide under way (Fit, a click on the map): the drag's views are reported at once.
          p.cancelGlide?.();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          press.current = { x: e.clientX, y: e.clientY, moved: false };
          frozen.current = world;
        }}
        onPointerMove={(e) => {
          const down = press.current;
          if (!down) return;
          if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < DRAG_PX) return;
          if (!down.moved) setDragging(true);
          down.moved = true;
          centreOn(flowAt(e));
        }}
        onPointerUp={(e) => {
          const down = press.current;
          press.current = null;
          frozen.current = null;
          setDragging(false);
          if (down && !down.moved) void p.glide({ center: flowAt(e), zoom });
        }}
        onPointerCancel={() => {
          press.current = null;
          frozen.current = null;
          setDragging(false);
        }}
      >
        {p.boxes.map((b) => (
          <rect key={b.index} className={b.index === p.live ? "board-map-box board-map-live" : "board-map-box"} x={b.x} y={b.y} width={b.w} height={b.h} />
        ))}
        <rect className="board-map-view" x={view.x} y={view.y} width={view.w} height={view.h} />
      </svg>
    </Panel>
  );
}

/** The boxes and the view, grown by a margin; a board with no boxes is the view. */
function worldOf(boxes: readonly FrameBox[], v: { x: number; y: number; w: number; h: number }): World {
  let x0 = v.x;
  let y0 = v.y;
  let x1 = v.x + v.w;
  let y1 = v.y + v.h;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  const m = Math.max(x1 - x0, y1 - y0, 1) * 0.05;
  return { x: x0 - m, y: y0 - m, w: Math.max(x1 - x0 + 2 * m, 1), h: Math.max(y1 - y0 + 2 * m, 1) };
}
