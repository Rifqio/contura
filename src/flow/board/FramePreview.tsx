// A static frame below BOX_BELOW (Task 18b, as Figma and Miro draw a far-out board): one svg over the frame's box with
// its group areas, its shapes as boxes and its lines as straight segments, in theme tokens (flow-board.css). It takes
// no pointer events; a click there picks the frame as its box does.
import type { NodeProps } from "@xyflow/react";
import { memo, useMemo } from "react";
import type { FramePreviewData } from "./boardScene";

type Rect = { x: number; y: number; w: number; h: number };

const rects = (rs: readonly Rect[]) => rs.map((r) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`).join("");

function FramePreview({ data }: NodeProps) {
  const d = data as FramePreviewData;
  // The data is one object while the frame is unchanged (boardScene keeps it), so the paths are made once.
  const paths = useMemo(
    () => ({
      areas: rects(d.areas),
      shapes: rects(d.shapes),
      lines: d.lines.map(([x1, y1, x2, y2]) => `M${x1} ${y1}L${x2} ${y2}`).join(""),
    }),
    [d],
  );
  return (
    <svg className="board-preview" width="100%" height="100%" aria-hidden="true">
      {paths.areas && <path className="board-preview-area" d={paths.areas} />}
      {paths.lines && <path className="board-preview-line" d={paths.lines} />}
      {paths.shapes && <path className="board-preview-shape" d={paths.shapes} />}
    </svg>
  );
}

// It draws from its data alone: a frame switch's new place moves the node and draws nothing again (Task 18b).
export default memo(FramePreview, (a, b) => a.data === b.data);
