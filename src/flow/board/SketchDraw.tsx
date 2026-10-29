// Drawing loose sketches (Plan B Task 12, Decisions 18, 20 and 21). While a generic tool, Section or the note sketch
// is armed and the press is outside every frame (or the frame has no such shape), FlowTab hands the press here:
// Rectangle, Ellipse and Diamond drag a box (Shift keeps it square, a click places 120 by 80); Line and Arrow drag two
// points (Shift snaps to 45 degrees); Pen draws while pressed and is simplified on release; Text and the note click a
// point and open the in-place editor; Section drags a box titled "Section", "Section 2". The sketch draws as it will
// look while dragging, and one `doc.sketch` goes in on release. Esc cancels the drawing and disarms (Excalidraw, FigJam,
// Miro). Also here: the text field drawn on a sketch, and the small bar with Colour alone for selected sketches.
import { forwardRef, type KeyboardEvent, useEffect, useImperativeHandle, useRef, useState } from "react";
import Icon from "../../components/Icon";
import Menu, { type MenuItem } from "../../components/Menu";
import { colourMenuItem } from "../canvasMenus";
import InlineEdit, { type CommitHow } from "../interactions/InlineEdit";
import { drawnColour, type PaletteName } from "../palette";
import { MAX_PEN_POINTS, type Sketch, type SketchKind } from "./boardLayout";
import { type NewSketch, simplifyStroke, strokeBox } from "./sketches";
import { SketchDrawing, snap45 } from "./SketchNode";

type Pt = { x: number; y: number };

/** The tools that draw a sketch: each tool's id is its sketch kind. */
export const SKETCH_TOOLS: ReadonlySet<string> = new Set<SketchKind>(["rect", "ellipse", "diamond", "line", "arrow", "pen", "text", "note", "section"]);
/** A click with a box tool places this size around the press (Figma places a default size; the plan says 120 by 80). */
export const CLICK_BOX = { w: 120, h: 80 };
/** An icon sketch's box: the 40 px image sits in it with its title under. */
export const ICON_SKETCH_SIZE = { w: 64, h: 64 };
/** A note's sheet (FigJam and Miro stickies are square). */
export const NOTE_BOX = { w: 160, h: 160 };
/** A Section placed by a click. */
export const SECTION_BOX = { w: 400, h: 300 };
/** A Line or Arrow placed by Enter (the keyboard path) runs this far to the right. */
export const LINE_KEY = 120;
/** A press that moves less than this, in screen pixels, is a click. */
export const DRAG_PX = 4;
/** The points a pen keeps while drawing, before it is simplified: a very long stroke stops growing here. */
const RAW_PEN_MAX = 20_000;

/** The next free Section title: "Section", then "Section 2", "Section 3" (FigJam). */
export function sectionTitle(all: readonly Sketch[]): string {
  const taken = new Set(all.filter((s) => s.kind === "section").map((s) => s.text ?? "Section"));
  if (!taken.has("Section")) return "Section";
  let n = 2;
  while (taken.has(`Section ${n}`)) n++;
  return `Section ${n}`;
}

/** A text sketch's box for its words: about 8 px a character and 20 px a line, at least one short word. */
export function textBox(text: string): { w: number; h: number } {
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((l) => l.length));
  return { w: Math.min(800, Math.max(40, longest * 8 + 8)), h: lines.length * 20 + 8 };
}

/** A box from two corners; Shift keeps it square, on the side the pointer went. */
export function dragBox(a: Pt, b: Pt, square: boolean): { x: number; y: number; w: number; h: number } {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

/**
 * The sketch a press makes, in board coordinates: `click` when it hardly moved. Text and the note have none (their
 * editor opens first); a pen takes the points it went through, simplified.
 */
export function draftSketch(
  tool: SketchKind,
  from: Pt,
  to: Pt,
  o: { click: boolean; shift?: boolean; points?: readonly Pt[]; all?: readonly Sketch[]; simplify?: boolean; keyboard?: boolean },
): NewSketch | null {
  switch (tool) {
    case "rect":
    case "ellipse":
    case "diamond":
    case "section": {
      const size = tool === "section" ? SECTION_BOX : CLICK_BOX;
      const box = o.click ? { x: from.x - size.w / 2, y: from.y - size.h / 2, ...size } : dragBox(from, to, !!o.shift);
      const r = { kind: tool, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
      return tool === "section" ? { ...r, text: sectionTitle(o.all ?? []) } : r;
    }
    case "line":
    case "arrow": {
      // A line is two points dragged (Excalidraw): a click draws none. Enter places one in the view (Decision 18).
      if (o.click && !o.keyboard) return null;
      const end = o.click ? { x: from.x + LINE_KEY, y: from.y } : o.shift ? snap45(from, to) : to;
      return { kind: tool, ...strokeBox([from, end]) };
    }
    case "pen": {
      const raw = o.points && o.points.length > 0 ? o.points : [from];
      const pts = raw.length === 1 ? [raw[0], raw[0]] : raw;
      const rounded = pts.map((p) => [Math.round(p.x), Math.round(p.y)] as [number, number]);
      // Ramer-Douglas-Peucker at 1 px on release, raised until it fits (Decision 21).
      const kept = o.simplify === false ? rounded : simplifyStroke(rounded, MAX_PEN_POINTS);
      return { kind: "pen", ...strokeBox(kept.map(([x, y]) => ({ x, y }))) };
    }
    case "text":
    case "note":
    case "icon":
      return null;
  }
}

/** The press under way: the tool, where it went down (screen and board), where it is now, the pen's points. */
type Press = { tool: SketchKind; screen: Pt; from: Pt; to: Pt; at: Pt; shift: boolean; points: Pt[]; moved: boolean };

export interface SketchDrawHandle {
  /** A press with sketch tool `tool` at screen `screen` (board `from`); listens until release or Esc. */
  start(tool: SketchKind, screen: Pt, from: Pt): void;
  /** Whether a press is under way. */
  busy(): boolean;
}

interface DrawProps {
  /** A screen point in board coordinates. */
  toBoard(p: Pt): Pt;
  /** The board's sketches now (a Section's title counts them). */
  sketches(): readonly Sketch[];
  /** A box, line, arrow, pen stroke or Section was drawn. */
  onDrawn(s: NewSketch, tool: SketchKind): void;
  /** Text or the note was clicked at board `at`: its editor opens there. */
  onPoint(tool: "text" | "note", at: Pt): void;
  /** Esc stopped the drawing: nothing is kept and the tool disarms. */
  onCancel(): void;
  /** The press let go: the click that follows belongs to it. */
  onReleased(): void;
}

/** The press handler and the preview of the sketch being drawn, in flow coordinates (inside the canvas's overlay). */
export const SketchDraw = forwardRef<SketchDrawHandle, DrawProps>(function SketchDraw(props, ref) {
  const press = useRef<Press | null>(null);
  const [preview, setPreview] = useState<NewSketch | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const frame = useRef(0);

  const draw = () => {
    frame.current = 0;
    const p = press.current;
    if (!p || !p.moved) return setPreview(null);
    setPreview(draftSketch(p.tool, p.from, p.to, { click: false, shift: p.shift, points: p.points, all: latest.current.sketches(), simplify: false }));
  };
  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  };

  const listeners = useRef<{ move(e: PointerEvent): void; up(e: PointerEvent): void; key(e: globalThis.KeyboardEvent): void; cancel(): void } | null>(null);
  const stop = () => {
    const l = listeners.current;
    if (!l) return;
    window.removeEventListener("pointermove", l.move);
    window.removeEventListener("pointerup", l.up);
    window.removeEventListener("pointercancel", l.cancel);
    window.removeEventListener("keydown", l.key, true);
    listeners.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    press.current = null;
    setPreview(null);
  };
  useEffect(() => stop, []);

  useImperativeHandle(ref, () => ({
    busy: () => press.current !== null,
    start(tool, screen, from) {
      stop();
      press.current = { tool, screen, from, to: from, at: screen, shift: false, points: [from], moved: false };
      const move = (e: PointerEvent) => {
        const p = press.current;
        if (!p) return;
        p.at = { x: e.clientX, y: e.clientY };
        p.to = latest.current.toBoard(p.at);
        p.shift = e.shiftKey;
        if (!p.moved && Math.hypot(p.at.x - p.screen.x, p.at.y - p.screen.y) > DRAG_PX) p.moved = true;
        if (p.tool === "pen" && p.points.length < RAW_PEN_MAX) p.points.push(p.to);
        if (p.tool !== "text" && p.tool !== "note") schedule();
      };
      const up = (e: PointerEvent) => {
        const p = press.current;
        if (!p) return;
        move(e);
        stop();
        latest.current.onReleased();
        if (p.tool === "text" || p.tool === "note") return latest.current.onPoint(p.tool, p.from);
        const s = draftSketch(p.tool, p.from, p.to, { click: !p.moved, shift: p.shift, points: p.points, all: latest.current.sketches() });
        if (s) latest.current.onDrawn(s, p.tool);
      };
      const cancel = () => {
        if (!press.current) return;
        stop();
        latest.current.onReleased();
        latest.current.onCancel();
      };
      const key = (e: globalThis.KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        cancel();
      };
      listeners.current = { move, up, key, cancel };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", key, true);
    },
  }));

  if (!preview) return null;
  const s: Sketch = { id: "preview", ...preview };
  return (
    <div
      className={`board-sketch-preview board-sketch-node is-${s.kind}`}
      aria-hidden="true"
      style={{ left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px` }}
    >
      <div className="board-sketch-draw">
        <SketchDrawing s={s} />
      </div>
    </div>
  );
});

/** Each sketch field's accessible name. */
export const SKETCH_FIELD_LABEL: Record<"text" | "note" | "section", string> = { text: "Text sketch", note: "Note sketch", section: "Section title" };

interface FieldProps {
  kind: "text" | "note" | "section";
  value: string;
  /** Where the field sits, in flow coordinates. */
  at: Pt;
  width: number;
  /** A new sketch: Escape with nothing typed drops it. */
  fresh: boolean;
  onCommit(value: string, how: CommitHow): void;
  onCancel(): void;
}

/** The in-place editor on a text sketch, a note or a Section's title (Excalidraw, FigJam). */
export function SketchField({ kind, value, at, width, fresh, onCommit, onCancel }: FieldProps) {
  return (
    <InlineEdit
      value={value}
      label={SKETCH_FIELD_LABEL[kind]}
      placeholder={kind === "section" ? "Section" : "Type, Enter to keep"}
      wrapClassName={`flow-rename-inline board-sketch-field is-${kind}`}
      style={{ left: `${at.x}px`, top: `${at.y}px`, width: `${width}px` }}
      multiline={kind !== "section"}
      fresh={fresh}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
}

interface BarProps {
  /** The selected sketches' one colour; "" with none, null when they differ. */
  color: string | null;
  onColour(color: PaletteName | null): void;
  /** The Assistant holds the board: nothing here writes. */
  disabled?: boolean;
  /** Esc on the bar: the keys go back to the canvas. */
  onLeave?(): void;
}

/** With only sketches selected, the bottom bar holds Colour alone (Task 12); the line bar's keys and tokens. */
/** Why Colour is off while the Assistant holds the board. */
export const SKETCH_BAR_LOCKED = "The Assistant is editing. Colour is off until it finishes.";

export function SketchBar({ color, onColour, disabled, onLeave }: BarProps) {
  const bar = useRef<HTMLDivElement>(null);
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (e.key === "Escape" && !e.defaultPrevented && !t.closest("[role=menu]")) {
      e.stopPropagation();
      onLeave?.();
      return;
    }
    // Ctrl and Cmd keys go on (undo): the tab's own handlers take them.
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  }
  const current = color === null ? null : (drawnColour(color) ?? "");
  const items: MenuItem[] = colourMenuItem({ current, why: null, pick: onColour }).submenu ?? [];
  return (
    <div ref={bar} className="frame-bar nodrag nopan" role="toolbar" aria-label="Sketch settings" onKeyDown={onKey}>
      {disabled ? (
        <button type="button" className="flow-tool" aria-label="Colour" disabled title={SKETCH_BAR_LOCKED}>
          <Icon name="paint" />
        </button>
      ) : (
      <Menu
        label="Colour"
        compact
        items={items}
        trigger={(t) => (
          <button type="button" className="flow-tool" aria-label="Colour" {...t}>
            <Icon name="paint" />
            <span className="flow-hint" aria-hidden="true">
              Colour
            </span>
          </button>
        )}
      />
      )}
    </div>
  );
}
