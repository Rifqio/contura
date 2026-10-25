// Diagram steps 7 and 8 (boards DiagramMindMap and DiagramSequence): what a topic, message or participant drag draws
// over the canvas, in flow coordinates: the topic it would go under (outlined), the insertion line between siblings or
// rows, and a tag and a chip that follow the pointer. It renders only when the landing place changes; the pointer moves
// the tag and chip by their transform, with no render (memory is a requirement).
import { useEffect, useRef, useSyncExternalStore } from "react";
import { ARROW_MARKER } from "../../diagram/edges";
import { DROP, type FoldDot, type OrderDragStore } from "../orderDrag";
import type { Box } from "./geometry";
import type { HotStore } from "./HotHandles";

const px = (n: number) => `${n}px`;

interface Props {
  store: OrderDragStore;
  /** A topic's box by its index in the drag (for the outline of the topic it would go under). */
  topicBox(ref: number): Box | null;
}

export default function OrderDragLayer({ store, topicBox }: Props) {
  useSyncExternalStore(store.subscribe, store.version);
  const s = store.state;
  const follow = useRef<HTMLDivElement>(null);
  const preview = useRef<SVGPathElement>(null);
  useEffect(() => {
    if (s.mode === null) return;
    const place = (x: number, y: number) => {
      if (follow.current) follow.current.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
      // A message drawn off every lifeline: its free end follows the pointer with no render (fix round 1, I4).
      if (preview.current && s.mode === "draw" && s.kind === 0) preview.current.setAttribute("d", `M ${s.a} ${s.c} H ${x}`);
    };
    place(s.x, s.y);
    store.onPointer(place);
    return () => store.onPointer(null);
  }, [s.mode, store, s.x, s.y]);
  if (s.mode === null) return null;
  const bad = s.kind >= DROP.badChild;
  const outline = s.mode === "topic" && (s.kind === DROP.child || s.kind === DROP.badChild) ? topicBox(s.ref) : null;
  const line = s.mode === "topic" && s.kind !== DROP.none && s.kind !== DROP.child && s.kind !== DROP.badChild;
  return (
    <>
      {s.mode === "message" && s.kind === 1 && <div className="flow-drop-line" aria-hidden="true" style={{ left: px(s.a), top: px(s.c - 1), width: px(s.b - s.a) }} />}
      {s.mode === "participant" && s.kind === 1 && <div className="flow-drop-line is-vertical" aria-hidden="true" style={{ left: px(s.a - 1), top: px(s.b), height: px(s.c - s.b) }} />}
      {s.mode === "draw" && (
        <svg className="flow-overlay-svg" width="1" height="1" aria-hidden="true">
          <path ref={preview} className={s.kind === 1 ? "flow-msg-preview is-on" : "flow-msg-preview"} d={`M ${s.a} ${s.c} H ${s.kind === 1 ? s.b : s.x}`} markerEnd={`url(#${ARROW_MARKER})`} />
        </svg>
      )}
      {outline && (
        <div
          className={bad ? "flow-drop-target is-refused" : "flow-drop-target"}
          aria-hidden="true"
          style={{ left: px(outline.x - 4), top: px(outline.y - 4), width: px(outline.w + 8), height: px(outline.h + 8) }}
        />
      )}
      {line && <div className={bad ? "flow-drop-line is-refused" : "flow-drop-line"} aria-hidden="true" style={{ left: px(s.a), top: px(s.c - 1), width: px(s.b - s.a) }} />}
      <div ref={follow} className="flow-drag-follow" aria-hidden="true">
        {s.chip && <span className="flow-drag-chip">{s.chip}</span>}
        {s.tag && <span className={bad ? "flow-drop-tag is-refused" : "flow-drop-tag"}>{s.tag}</span>}
      </div>
    </>
  );
}


export function FoldDots({ dots, hot, selected, onToggle }: { dots: readonly FoldDot[]; hot: HotStore; selected: readonly string[]; onToggle(name: string): void }) {
  const over = useSyncExternalStore(hot.subscribe, hot.get);
  return (
    <>
      {dots
        .filter((d) => d.folded || d.name === over || selected.includes(d.name))
        .map((d) => (
          <button
            key={d.name}
            type="button"
            className={d.folded ? "flow-fold-dot nodrag nopan is-folded" : "flow-fold-dot nodrag nopan"}
            aria-label={d.folded ? `Unfold ${d.name}: ${d.count === 1 ? "1 subtopic" : `${d.count.toLocaleString("en-US")} subtopics`} hidden` : `Fold ${d.name}`}
            aria-expanded={!d.folded}
            style={{ left: px(d.x), top: px(d.y) }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(d.name);
            }}
          >
            {d.folded ? d.count.toLocaleString("en-US") : ""}
          </button>
        ))}
    </>
  );
}
