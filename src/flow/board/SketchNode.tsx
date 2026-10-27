// A loose sketch on the board canvas (Decision 21): an SVG at its box, in theme tokens only (ADR 0008). Outlines are
// 1.5 px in the sketch's colour (the theme's text colour when it has none); a note is a sheet in the warning tint;
// lines, arrows and pen strokes run through their points, which are relative to the box; a Section is a dashed box
// with its title above it. The node's box takes no pointer events: only what is drawn does (flow-board.css).
import type { NodeProps } from "@xyflow/react";
import { createContext, memo, type PointerEvent as ReactPointerEvent, useContext, useLayoutEffect, useRef, useState } from "react";
import { type Box, type Limits, ResizeZones, zoomAt } from "../../diagram/resize";
import { useIcon, useIconTitle } from "../icons";
import { colourStroke, drawnColour } from "../palette";
import type { Sketch } from "./boardLayout";
import { SKETCH_WORD } from "./sketches";

type Pt = { x: number; y: number };

/**
 * What a selected sketch's handles write (Task 12), in board coordinates: a box resized by its zones, a line's or
 * arrow's ends dragged. Null while nothing may be edited (the Assistant holds the board).
 */
export interface SketchEdit {
  resized(id: string, box: Box): void;
  ends(id: string, from: Pt, to: Pt): void;
}
export const SketchEditContext = createContext<SketchEdit | null>(null);

/** Sketches resized by their eight zones (draw.io, Excalidraw); lines and arrows take end handles instead. */
const SIZED: ReadonlySet<Sketch["kind"]> = new Set<Sketch["kind"]>(["rect", "ellipse", "diamond", "section", "note", "text"]);
const LIMITS: Limits = { minW: 8, maxW: 20_000, minH: 8, maxH: 20_000 };

/** Shift snaps a line's end to the nearest 45 degrees around its other end (Excalidraw, Figma). */
export function snap45(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return to;
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.round(Math.cos(a) * len), y: from.y + Math.round(Math.sin(a) * len) };
}

export type SketchNodeData = { sketch: Sketch };

const OUTLINE = 1.5;
/** How far a press may land from a stroke and still be on it. */
const HIT = 10;
/** An arrowhead's length and half width. */
const HEAD = 10;
const HEAD_HALF = 5;

/** The stroke a sketch's colour draws, as a CSS value. */
export function sketchStroke(color: string | undefined): string {
  const c = drawnColour(color);
  return c ? colourStroke(c) : "var(--c-text)";
}

/** The accessible name: the kind word, then the text (an icon sketch's title is read from the pack, see `IconSketch`). */
export const sketchLabel = (s: Sketch, title?: string) => {
  const words = s.kind === "icon" ? (title ?? s.icon) : s.text;
  return words ? `${SKETCH_WORD[s.kind]} sketch: ${words}` : `${SKETCH_WORD[s.kind]} sketch`;
};

const pathOf = (points: readonly [number, number][]) => points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join("");

/** The arrowhead at the last point, along the last segment that has a length. */
function headOf(points: readonly [number, number][]): string | null {
  const n = points.length;
  if (n < 2) return null;
  const [x2, y2] = points[n - 1];
  let i = n - 2;
  while (i > 0 && points[i][0] === x2 && points[i][1] === y2) i--;
  const [x1, y1] = points[i];
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len === 0) return null;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const bx = x2 - ux * HEAD;
  const by = y2 - uy * HEAD;
  return `M${bx - uy * HEAD_HALF} ${by + ux * HEAD_HALF}L${x2} ${y2}L${bx + uy * HEAD_HALF} ${by - ux * HEAD_HALF}`;
}

function SketchShape({ s, stroke }: { s: Sketch; stroke: string }) {
  const w = Math.max(s.w, 0);
  const h = Math.max(s.h, 0);
  const inset = OUTLINE / 2;
  const iw = Math.max(w - OUTLINE, 0);
  const ih = Math.max(h - OUTLINE, 0);
  switch (s.kind) {
    case "rect":
      return <rect className="board-sketch-shape is-box" x={inset} y={inset} width={iw} height={ih} rx={4} fill="none" stroke={stroke} strokeWidth={OUTLINE} />;
    case "ellipse":
      return <ellipse className="board-sketch-shape is-box" cx={w / 2} cy={h / 2} rx={iw / 2} ry={ih / 2} fill="none" stroke={stroke} strokeWidth={OUTLINE} />;
    case "diamond":
      return (
        <polygon
          className="board-sketch-shape is-box"
          points={`${w / 2},${inset} ${w - inset},${h / 2} ${w / 2},${h - inset} ${inset},${h / 2}`}
          fill="none"
          stroke={stroke}
          strokeWidth={OUTLINE}
          strokeLinejoin="round"
        />
      );
    case "section":
      return <rect className="board-sketch-shape is-box" x={inset} y={inset} width={iw} height={ih} rx={8} fill="none" stroke={stroke} strokeWidth={OUTLINE} strokeDasharray="6 4" />;
    case "note":
      return <rect className="board-sketch-paper is-box" x={inset} y={inset} width={iw} height={ih} rx={2} fill="var(--c-warning-subtle)" stroke="var(--c-text-subtle)" strokeWidth={1} />;
    case "text":
      return <rect className="board-sketch-hit is-box" x={0} y={0} width={w} height={h} fill="none" />;
    case "line":
    case "arrow":
    case "pen": {
      const points = s.points && s.points.length > 0 ? s.points : ([[0, 0], [w, h]] as [number, number][]);
      const d = pathOf(points);
      const head = s.kind === "arrow" ? headOf(points) : null;
      return (
        <>
          <path className="board-sketch-hit is-stroke" d={d} fill="none" stroke="transparent" strokeWidth={HIT} strokeLinecap="round" strokeLinejoin="round" />
          <path className="board-sketch-shape is-stroke" d={d} fill="none" stroke={stroke} strokeWidth={OUTLINE} strokeLinecap="round" strokeLinejoin="round" />
          {head && <path className="board-sketch-head is-stroke" d={head} fill="none" stroke={stroke} strokeWidth={OUTLINE} strokeLinecap="round" strokeLinejoin="round" />}
        </>
      );
    }
  }
}

/** An icon sketch: the pack's image 40 px in the box, its title under it in one line. */
function IconSketch({ name, title }: { name: string; title: string }) {
  const { url, missing, outline } = useIcon(name);
  return (
    <>
      {missing ? (
        <div className="board-sketch-icon-missing" aria-hidden="true" />
      ) : (
        url && <img className={`board-sketch-icon${outline ? " icon-hairline" : ""}`} src={url} alt="" width={40} height={40} draggable={false} />
      )}
      <div className="board-sketch-icon-title" aria-hidden="true">
        {title}
      </div>
    </>
  );
}

/** A sketch's drawing alone (its shape, words and title), for the node and for the preview while it is drawn. */
export function SketchDrawing({ s, iconTitle }: { s: Sketch; iconTitle?: string }) {
  if (s.kind === "icon" && s.icon) return <IconSketch name={s.icon} title={iconTitle ?? s.icon} />;
  const stroke = sketchStroke(s.color);
  const words = s.kind === "text" || s.kind === "note" ? s.text : undefined;
  return (
    <>
      <svg className="board-sketch-svg" width={Math.max(s.w, 0)} height={Math.max(s.h, 0)} aria-hidden="true">
        <SketchShape s={s} stroke={stroke} />
      </svg>
      {words && (
        <div className="board-sketch-words" aria-hidden="true" style={s.kind === "text" ? { color: stroke } : undefined}>
          {words}
        </div>
      )}
      {s.kind === "section" && (
        <div className="board-sketch-title" aria-hidden="true">
          {s.text || "Section"}
        </div>
      )}
    </>
  );
}

/** A line's or arrow's two end handles: a drag moves that end, Shift snaps it to 45 degrees, Esc puts it back. */
function EndHandles({ s, edit, onLive }: { s: Sketch; edit: SketchEdit; onLive(points: [number, number][] | null): void }) {
  const pts = s.points && s.points.length >= 2 ? s.points : ([[0, 0], [s.w, s.h]] as [number, number][]);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const stop = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => stop.current?.(), []);
  const down = (end: 0 | 1) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || stop.current) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const id = e.pointerId;
    try {
      el.setPointerCapture?.(id);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
    const zoom = zoomAt(el);
    const sx = e.clientX;
    const sy = e.clientY;
    const fixed = end === 0 ? last : first;
    const moving = end === 0 ? first : last;
    let at: [number, number] = moving;
    const place = (ev: PointerEvent) => {
      const raw = { x: moving[0] + (ev.clientX - sx) / zoom, y: moving[1] + (ev.clientY - sy) / zoom };
      const p = ev.shiftKey ? snap45({ x: fixed[0], y: fixed[1] }, raw) : raw;
      at = [Math.round(p.x), Math.round(p.y)];
      onLive(end === 0 ? [at, fixed] : [fixed, at]);
    };
    const cleanup = () => {
      el.removeEventListener("pointermove", place);
      el.removeEventListener("pointerup", done);
      el.removeEventListener("pointercancel", done);
      window.removeEventListener("keydown", key, true);
      try {
        if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
      } catch {
        // Already released.
      }
      stop.current = null;
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      cleanup();
      onLive(null);
    };
    function done(ev: PointerEvent) {
      place(ev);
      cleanup();
      onLive(null);
      const a = end === 0 ? at : fixed;
      const b = end === 0 ? fixed : at;
      if (a[0] === first[0] && a[1] === first[1] && b[0] === last[0] && b[1] === last[1]) return;
      edit.ends(s.id, { x: s.x + a[0], y: s.y + a[1] }, { x: s.x + b[0], y: s.y + b[1] });
    }
    el.addEventListener("pointermove", place);
    el.addEventListener("pointerup", done);
    el.addEventListener("pointercancel", done);
    window.addEventListener("keydown", key, true);
    stop.current = () => {
      cleanup();
      onLive(null);
    };
  };
  return (
    <>
      {[first, last].map(([x, y], i) => (
        <span
          key={i}
          className="board-sketch-end nodrag nopan"
          data-end={i}
          aria-hidden="true"
          style={{ left: `${x}px`, top: `${y}px` }}
          onPointerDown={down(i as 0 | 1)}
        />
      ))}
    </>
  );
}

function SketchNodeView({ data, selected }: NodeProps) {
  const s = (data as SketchNodeData).sketch;
  const iconTitle = useIconTitle(s.kind === "icon" && s.icon ? s.icon : null);
  const edit = useContext(SketchEditContext);
  /** A resize or an end drag under way: drawn here, kept only on release. */
  const [live, setLive] = useState<{ box?: Box; points?: [number, number][] } | null>(null);
  let shown = s;
  if (live?.box) shown = { ...s, w: Math.round(live.box.w), h: Math.round(live.box.h) };
  if (live?.points && live.points.length >= 2) {
    const [[ax, ay], [bx, by]] = live.points;
    const x0 = Math.min(ax, bx);
    const y0 = Math.min(ay, by);
    shown = { ...s, w: Math.abs(bx - ax), h: Math.abs(by - ay), points: [[ax - x0, ay - y0], [bx - x0, by - y0]] };
  }
  const shift = live?.box ? { x: live.box.x - s.x, y: live.box.y - s.y } : live?.points ? { x: Math.min(live.points[0][0], live.points[1][0]), y: Math.min(live.points[0][1], live.points[1][1]) } : null;
  return (
    <div className={`board-sketch-node is-${s.kind}${selected ? " is-selected" : ""}`} role="img" aria-label={sketchLabel(s, s.kind === "icon" ? iconTitle : undefined)}>
      <div className="board-sketch-draw" style={shift ? { transform: `translate(${shift.x}px, ${shift.y}px)`, width: `${shown.w}px`, height: `${shown.h}px` } : undefined}>
        <SketchDrawing s={shown} iconTitle={iconTitle} />
      </div>
      {selected && edit && SIZED.has(s.kind) && (
        <ResizeZones
          start={() => ({ x: s.x, y: s.y, w: s.w, h: s.h })}
          limits={LIMITS}
          onLive={(box) => setLive({ box })}
          onDone={(box, start) => {
            setLive(null);
            const r = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
            if (r.x !== start.x || r.y !== start.y || r.w !== start.w || r.h !== start.h) edit.resized(s.id, r);
          }}
          onCancel={() => setLive(null)}
        />
      )}
      {selected && edit && (s.kind === "line" || s.kind === "arrow") && <EndHandles s={s} edit={edit} onLive={(points) => setLive(points ? { points } : null)} />}
    </div>
  );
}

/**
 * The `sketch` node type. It draws from its data and selection alone, so a new place (every sketch's, when a frame
 * switch moves the layer, Decision 21) draws nothing again: React Flow moves the node (Task 18b).
 */
export const SketchNode = memo(SketchNodeView, (a, b) => a.data === b.data && a.selected === b.selected);

/** The `sketchLayer` node type: the zero-size parent of every sketch node draws nothing itself. */
export function SketchLayerNode() {
  return null;
}

export const SKETCH_NODE_TYPES = { sketch: SketchNode, sketchLayer: SketchLayerNode };
