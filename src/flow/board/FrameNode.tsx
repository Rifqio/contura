// A board frame on the canvas (Decisions 3, 4, 5 and 28): its box, and the title tab strip above its top-left corner.
// The strip is the frame's drag handle; its title button selects the frame and a double-click zooms to it. The
// selected frame's strip also opens the pane on its AI Chat or Code Editor; any frame's problem count opens the Code
// Editor on it. The box itself takes no clicks: FlowTab works out which frame and shape a click on the canvas is for,
// the frame on top first.
import { type Node, type NodeProps, useStore } from "@xyflow/react";
import { type CSSProperties, memo, useMemo } from "react";
import Icon from "../../components/Icon";
import { useZoomVar } from "../../diagram/zoomVar";
import { DIAGRAM_KIND_WORD } from "../diagramKinds";
import type { FrameBox } from "./boardScene";
import { KIND_ICON } from "./chips";
import { frameName } from "./frameName";
import { breakIndex, stripAt, stripBreaks, stripParts, type TabNeighbour } from "./tabRoom";

export type FramePane = "editor" | "assistant";

export interface FrameNodeData extends Record<string, unknown> {
  box: FrameBox;
  /** Drawn faded: its text has an error, or an earlier frame has its title. */
  faded?: boolean;
  selected: boolean;
  /** The pane open beside the canvas, for the selected frame's AI Chat and Code Editor buttons. */
  pane: FramePane | null;
  /** The assistant's changes waiting for review in this frame: a frame with some shows its AI Chat, selected or not. */
  pending: number;
  /** The frames whose tabs start to the right of this one's, nearest first: the strip's room ends at the first in its row. */
  neighbours: readonly TabNeighbour[];
  /** A frame the waiting proposal adds (Plan D Task 8): drawn dashed, its tab marked "New". */
  isNew?: boolean;
  onSelect(): void;
  onPane(tab: FramePane): void;
  /** Its problem count: the Code Editor opens on this frame (Decision 17). */
  onProblems(): void;
  onZoom(): void;
}

export type FrameNodeType = Node<FrameNodeData, "boardFrame">;


export { frameName };

const count = (n: number) => n.toLocaleString("en-US");

function FrameNode({ data }: NodeProps<FrameNodeType>) {
  const { box, faded, selected, pane, pending, isNew } = data;
  const word = DIAGRAM_KIND_WORD[box.kind ?? "unknown"];
  const cls = ["board-frame", selected && "is-selected", faded && "is-faded", isNew && "is-new"].filter(Boolean).join(" ");
  // The strip's room in board units and what fits in it change only at a few zooms (`stripBreaks`, worked out once per
  // frame and neighbours): a pan or zoom tick selects which interval the zoom is in, one number and no allocation, and
  // a frame re-renders only when it crosses one.
  const { neighbours } = data;
  // A frame with changes waiting shows its AI Chat selected or not (Plan D); Code Editor only when it is selected, so a
  // frame that is not takes no room for it.
  const panes = selected || pending > 0;
  const parts = useMemo(() => {
    const p = stripParts({ kind: box.kind, title: box.title, problems: box.problems }, pending);
    return selected ? p : { ...p, editor: 0 };
  }, [box.kind, box.title, box.problems, pending, selected]);
  const breaks = useMemo(() => stripBreaks(box.w, neighbours, parts, panes), [box.w, neighbours, parts, panes]);
  const level = useStore((st) => breakIndex(breaks, st.transform[2] || 1));
  const { room, fit } = useMemo(() => stripAt(box.w, neighbours, parts, panes, breaks, level), [box.w, neighbours, parts, panes, breaks, level]);
  const style = room === Infinity ? undefined : ({ "--board-tab-room": room } as CSSProperties);
  // The strip keeps its screen size by the zoom, given to it alone and only up to 100 percent, past which it is drawn
  // as it is (Task 9 fix 2).
  const zoomVar = useZoomVar<HTMLDivElement>(1);
  return (
    <div className={cls} style={style}>
      <div ref={zoomVar} className={room === Infinity ? "board-frame-tab" : "board-frame-tab has-room"} data-fit={fit}>
        <button
          type="button"
          className="board-frame-title"
          aria-label={isNew ? `${frameName(box)}, new, suggested by AI` : frameName(box)}
          aria-current={selected || undefined}
          title={`${frameName(box)}. Drag to move, double-click to zoom to it.`}
          onClick={(e) => {
            e.stopPropagation();
            data.onSelect();
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            data.onZoom();
          }}
        >
          <Icon name={box.kind ? KIND_ICON[box.kind] : "square"} size={14} />
          {/* Short of room the kind word goes first (the icon still shows the kind); the name is cut only after it. */}
          {fit === "all" && <span className="board-frame-kind">{word}</span>}
          <span className="board-frame-name">{box.title || "Untitled"}</span>
          {isNew && (
            <span className="board-frame-new" aria-hidden="true">
              New
            </span>
          )}
        </button>
        {box.problems > 0 && (
          <button
            type="button"
            className="board-frame-problems nodrag"
            aria-label={`${count(box.problems)} ${box.problems === 1 ? "problem" : "problems"}`}
            aria-description="Opens the Code Editor on this diagram"
            onClick={(e) => {
              e.stopPropagation();
              data.onProblems();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Icon name="alert" size={14} />
            {count(box.problems)}
          </button>
        )}
        {panes && fit !== "none" && (
          <>
            {fit !== "editor" && (
              <button
                type="button"
                className="board-frame-pane nodrag"
                aria-pressed={pane === "assistant"}
                onClick={(e) => {
                  e.stopPropagation();
                  data.onPane("assistant");
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Icon name="msg" size={14} />
                AI Chat
                {pending > 0 && <span className="board-frame-pending">{count(pending)}</span>}
              </button>
            )}
            {selected && (
              <button
                type="button"
                className="board-frame-pane nodrag"
                aria-pressed={pane === "editor"}
                onClick={(e) => {
                  e.stopPropagation();
                  data.onPane("editor");
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Icon name="code" size={14} />
                Code Editor
              </button>
            )}
          </>
        )}
      </div>
      <div className="board-frame-body" aria-hidden="true" />
    </div>
  );
}

export default memo(FrameNode);
