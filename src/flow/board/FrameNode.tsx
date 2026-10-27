// A board frame on the canvas (Decisions 3, 4, 5 and 28): its box, and the title tab strip above its top-left corner.
// The strip is the frame's drag handle; its title button selects the frame and a double-click zooms to it. The
// selected frame's strip also opens the pane on its AI Chat or Code Editor; any frame's problem count opens the Code
// Editor on it. The box itself takes no clicks: FlowTab works out which frame and shape a click on the canvas is for,
// the frame on top first.
import type { Node, NodeProps } from "@xyflow/react";
import { memo } from "react";
import Icon from "../../components/Icon";
import { DIAGRAM_KIND_WORD } from "../diagramKinds";
import type { FrameBox } from "./boardScene";
import { KIND_ICON } from "./chips";

export type FramePane = "editor" | "assistant";

export interface FrameNodeData extends Record<string, unknown> {
  box: FrameBox;
  /** Drawn faded: its text has an error, or an earlier frame has its title. */
  faded?: boolean;
  selected: boolean;
  /** The pane open beside the canvas, for the selected frame's AI Chat and Code Editor buttons. */
  pane: FramePane | null;
  /** The assistant's changes waiting for review. */
  pending: number;
  onSelect(): void;
  onPane(tab: FramePane): void;
  /** Its problem count: the Code Editor opens on this frame (Decision 17). */
  onProblems(): void;
  onZoom(): void;
}

export type FrameNodeType = Node<FrameNodeData, "boardFrame">;


/** The frame's name on its tab and for a screen reader: its kind word, then its title. */
export function frameName(box: Pick<FrameBox, "kind" | "title">): string {
  return `${DIAGRAM_KIND_WORD[box.kind ?? "unknown"]} ${box.title || "Untitled"}`;
}

const count = (n: number) => n.toLocaleString("en-US");

function FrameNode({ data }: NodeProps<FrameNodeType>) {
  const { box, faded, selected, pane, pending } = data;
  const word = DIAGRAM_KIND_WORD[box.kind ?? "unknown"];
  const cls = ["board-frame", selected && "is-selected", faded && "is-faded"].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className="board-frame-tab">
        <button
          type="button"
          className="board-frame-title"
          aria-label={frameName(box)}
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
          <span className="board-frame-kind">{word}</span>
          <span className="board-frame-name">{box.title || "Untitled"}</span>
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
        {selected && (
          <>
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
          </>
        )}
      </div>
      <div className="board-frame-body" aria-hidden="true" />
    </div>
  );
}

export default memo(FrameNode);
