// A frame's name on its tab and for a screen reader, shared by the canvas (FrameNode.tsx) and Publish (boardSvg.ts),
// which must not import a React component. The one place an empty title reads "Untitled".
import { DIAGRAM_KIND_WORD } from "../diagramKinds";
import type { FrameBox } from "./boardScene";

/** The frame's name on its tab and for a screen reader: its kind word, then its title. */
export function frameName(box: Pick<FrameBox, "kind" | "title">): string {
  return `${DIAGRAM_KIND_WORD[box.kind ?? "unknown"]} ${box.title || "Untitled"}`;
}
