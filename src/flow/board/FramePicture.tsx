// A static frame drawn as one picture of itself (as Figma and Miro draw a far-out board): an <img>
// of its bitmap's PNG (Task 9 fixes 2 and 3), or of its SVG until that is in, over the frame's box where its shapes
// would stand. No <canvas>: in WebKit each is a compositing layer of its own. It takes no pointer events; a click there
// picks the frame as its box does, and a pick of a shape reads the frame's children as built.
import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { FramePictureData } from "./boardScene";

function Picture({ data, className }: { data: FramePictureData; className: string }) {
  return <img className={className} src={data.raster?.url ?? data.url} alt="" draggable={false} decoding="async" />;
}

function FramePicture({ data }: NodeProps) {
  return <Picture data={data as FramePictureData} className="board-picture-img" />;
}

/** A tile of the sketch layer pictured when far, drawn as a frame's picture is. */
function SketchPicture({ data }: NodeProps) {
  return <Picture data={data as FramePictureData} className="board-sketch-picture-img" />;
}

// Each draws from its data alone: the data is one object while the image is, so a move or a switch draws nothing again.
export const SketchLayerPicture = memo(SketchPicture, (a, b) => a.data === b.data);
export default memo(FramePicture, (a, b) => a.data === b.data);
