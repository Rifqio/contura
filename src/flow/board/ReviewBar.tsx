// The review bar (Plan D Decision 11): one floating bar beside the frames an assistant proposal changes, as Figma's
// and Miro's AI results float a Keep or Discard bar by the canvas content they touch and Copilot Edits offers Keep and
// Undo with their keys. It sits REVIEW_GAP above the top right of the touched frames (below them when there is no
// room), follows pan and zoom, and stays inside the canvas, clear of its fixed chrome: the board toolbar at the top, the
// overview, the zoom control and the bottom stack (Miro's and FigJam's context bars never sit under fixed chrome). A WAI-ARIA toolbar: one tab stop, the arrow keys move along it; Ctrl+Enter accepts and
// Ctrl+Backspace rejects in it always, and elsewhere in the tab by `reviewKeys` (A8).
import { useStore } from "@xyflow/react";
import { type KeyboardEvent as ReactKeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import Kbd from "../../components/Kbd";
import type { Point } from "../interactions/geometry";
import { tabHeight } from "./boardDetail";

/** The gap between the bar and the frames' tabs, and the bar's least distance from the canvas's edges. */
export const REVIEW_GAP = 8;
/** How long the bar's words stay in the live region once announced (react-aria's announcer clears after 7 s). */
export const REVIEW_SAID_MS = 7000;

type Rect = { x: number; y: number; w: number; h: number };
type Size = { w: number; h: number };
type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented">;

/**
 * What a key does to the waiting changes (A8): Ctrl+Enter accepts and Ctrl+Backspace rejects. In the bar it always
 * acts; elsewhere only on an event no canvas key took (a selected ER column and a picked class member take Ctrl+Enter
 * first and prevent it) and never while typing in the composer or the code pane.
 */
export function reviewKeys(e: KeyLike, o: { inBar: boolean; typing: boolean }): "accept" | "reject" | null {
  if (!o.inBar && (o.typing || e.defaultPrevented)) return null;
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  return e.key === "Enter" ? "accept" : e.key === "Backspace" ? "reject" : null;
}

/** A key's target is a field the user types in: an input, a text area, or editable text such as the code pane. */
export function typingIn(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.closest) return false;
  return el.isContentEditable || !!el.closest("input, textarea, select, [contenteditable='true'], [contenteditable=''], .cm-editor");
}

const count = (n: number) => n.toLocaleString("en-US");

/** "<k> changes in <title> and <title>"; three frames or more: "in 3 diagrams". */
export function reviewText(titles: readonly string[], k: number): string {
  const names = titles.map((t) => t || "Untitled");
  const where = names.length >= 3 ? `${count(names.length)} diagrams` : names.join(" and ");
  return `${count(k)} ${k === 1 ? "change" : "changes"} in ${where}`;
}

/** The band of the canvas the bar may use, top to bottom, between the fixed chrome above and below (canvas pixels). */
export interface ReviewRoom {
  top: number;
  bottom: number;
}

/**
 * The bar's top-left in the canvas. Its right edge is on `at.x`, held REVIEW_GAP inside the canvas's sides. It sits
 * REVIEW_GAP above the frames' top (`at.y`); with no room there it flips REVIEW_GAP below their bottom (`bottom`, the
 * frames' bottom edge on the canvas); with room for neither it keeps to the top of the room. It never leaves `room`,
 * by default REVIEW_GAP inside the canvas.
 */
export function placeReviewBar(at: Point, size: Size, bounds: Size, bottom = at.y, room: ReviewRoom = { top: REVIEW_GAP, bottom: bounds.h - REVIEW_GAP }): Point {
  const x = Math.max(REVIEW_GAP, Math.min(at.x - size.w, bounds.w - REVIEW_GAP - size.w));
  const above = at.y - REVIEW_GAP - size.h;
  const last = room.bottom - size.h;
  let y: number;
  if (above >= room.top) y = Math.min(above, last);
  else {
    const below = Math.max(room.top, bottom + REVIEW_GAP);
    y = below <= last ? below : room.top;
  }
  return { x, y: Math.max(room.top, y) };
}

/** The top right of `rect` (board units) on the canvas, through React Flow's transform `[x, y, zoom]`. */
export function reviewAnchor(rect: Rect, transform: readonly [number, number, number]): Point {
  const [tx, ty, zoom] = transform;
  return { x: (rect.x + rect.w) * zoom + tx, y: rect.y * zoom + ty };
}

/** The canvas's fixed chrome the bar keeps clear of. The toolbar's slot is `display: contents`: the toolbar is measured. */
const CHROME = ".board-toolbar, .react-flow__minimap, .react-flow__panel.canvas-zoom, .board-bottom";

/**
 * The room between the chrome in the top half of the canvas and the chrome in the bottom half, measured from `box`
 * (the element the bar is placed in). Chrome not drawn (no size) is left out.
 */
export function measureRoom(box: Element, scope: ParentNode, height: number): ReviewRoom {
  const origin = box.getBoundingClientRect();
  let top = REVIEW_GAP;
  let bottom = height - REVIEW_GAP;
  for (const el of scope.querySelectorAll(CHROME)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const y0 = r.top - origin.top;
    const y1 = r.bottom - origin.top;
    if ((y0 + y1) / 2 < height / 2) top = Math.max(top, y1 + REVIEW_GAP);
    else bottom = Math.min(bottom, y0 - REVIEW_GAP);
  }
  return { top, bottom };
}

interface Props {
  /** The touched frames' titles, in text order. */
  titles: string[];
  /** The changes that would land. */
  count: number;
  /** Accept's label: "Accept all" or "Accept <k>". */
  label: string;
  /** The top right of the touched frames on the canvas, their tabs included. */
  at: Point;
  /** The touched frames' bottom edge on the canvas: the bar flips below it when there is no room above. */
  bottom?: number;
  onAccept(): void;
  onReject(): void;
}

export default function ReviewBar({ titles, count: k, label, at, bottom, onAccept, onReject }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [room, setRoom] = useState<ReviewRoom | null>(null);
  // The bar's size and the chrome's room, measured when the canvas, the bar or the chrome change size: never on a
  // pan or zoom tick, which moves neither.
  useLayoutEffect(() => {
    const bar = ref.current;
    const box = bar?.parentElement;
    if (!bar || !box) return;
    const scope = bar.closest(".flow-canvas") ?? box;
    const measure = () => {
      const r = bar.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
      const next = measureRoom(box, scope, height);
      setRoom((was) => (was && was.top === next.top && was.bottom === next.bottom ? was : next));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(bar);
    for (const el of scope.querySelectorAll(CHROME)) watch.observe(el);
    // Chrome drawn or gone after the bar mounted (the overview of a one-frame board, a toast's stack) is measured as it
    // comes and goes; only additions or removals that are or hold chrome count, so the canvas's own nodes cost one check.
    const isChrome = (n: Node) => n instanceof Element && (n.matches(CHROME) || n.querySelector(CHROME) !== null);
    const added = new MutationObserver((records) => {
      let changed = false;
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!isChrome(n)) continue;
          changed = true;
          const el = n as Element;
          if (el.matches(CHROME)) watch.observe(el);
          for (const c of el.querySelectorAll(CHROME)) watch.observe(c);
        }
        for (const n of r.removedNodes) if (isChrome(n)) changed = true;
      }
      if (changed) measure();
    });
    added.observe(scope, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      added.disconnect();
    };
  }, [width, height]);
  const text = reviewText(titles, k);
  /** The one tab stop: 0 Reject, 1 Accept. */
  const [stop, setStop] = useState(0);
  const place = placeReviewBar(at, size, { w: width, h: height }, bottom ?? at.y, room ?? undefined);

  const onKey = (e: ReactKeyboardEvent) => {
    const act = reviewKeys(e, { inBar: true, typing: false });
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "ArrowRight" || e.key === "ArrowLeft" ? (i + 1) % 2 : e.key === "Home" ? 0 : e.key === "End" ? 1 : null;
    if (!act && (to === null || i < 0)) return;
    // The canvas would take these keys: a column's Ctrl+Enter, the arrows' nudge.
    e.preventDefault();
    e.stopPropagation();
    if (act === "accept") onAccept();
    else if (act === "reject") onReject();
    else if (to !== null) {
      setStop(to);
      buttons[to]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      className="board-review nodrag nopan"
      role="toolbar"
      aria-label="Assistant changes"
      style={{ left: `${place.x}px`, top: `${place.y}px` }}
      onKeyDown={onKey}
    >
      <span className="board-review-text">{text}</span>
      <button type="button" className="btn pbtn2" aria-keyshortcuts="Control+Backspace Meta+Backspace" tabIndex={stop === 0 ? 0 : -1} onFocus={() => setStop(0)} onClick={onReject}>
        Reject
      </button>
      <button type="button" className="btn pbtn2 pri" aria-keyshortcuts="Control+Enter Meta+Enter" tabIndex={stop === 1 ? 0 : -1} onFocus={() => setStop(1)} onClick={onAccept}>
        {label}
        <span aria-hidden="true">
          <Kbd keys="Ctrl+Enter" />
        </span>
      </button>
    </div>
  );
}

/**
 * The bar on the canvas over the frames' union `rect` (board units, their tabs left out): it follows the view's pan and
 * zoom. The tabs are added at the live zoom, as their strip keeps its screen height below 100 percent (Plan F Decision
 * 5), so the bar never covers a frame's title and AI Chat count. Inside the canvas's React Flow.
 */
export function ReviewBarOnCanvas({ rect, ...bar }: Omit<Props, "at" | "bottom"> & { rect: Rect }) {
  const transform = useStore((s) => s.transform);
  const tab = tabHeight(transform[2]);
  const withTabs = { x: rect.x, y: rect.y - tab, w: rect.w, h: rect.h + tab };
  return <ReviewBar {...bar} at={reviewAnchor(withTabs, transform)} bottom={(rect.y + rect.h) * transform[2] + transform[1]} />;
}
