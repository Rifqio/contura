import type { DiagramKind } from "../api/types";
import { flowName, quote } from "../lang/flow/model";

/** A kind a frame can have: every file kind but a board and an unknown file. */
type FrameKind = Exclude<DiagramKind, "board" | "unknown">;

/** A diagram's kind in words, as Recent lists say it. */
export const DIAGRAM_KIND_WORD: Record<DiagramKind, string> = {
  dfd: "Data flow",
  flow: "Flowchart",
  cloud: "Cloud",
  sequence: "Sequence",
  state: "State",
  class: "Class",
  mindmap: "Mind map",
  timeline: "Timeline",
  er: "ER diagram",
  board: "Board",
  unknown: "Diagram",
};

/** The diagram name a field holds: trimmed, with one typed `.flow` (any case) dropped, since the Core adds it. */
export function typedDiagramName(value: string): string {
  return value.trim().replace(/\.flow$/i, "");
}

/** The first name of the series that is free, ignoring case: "Untitled diagram", then "Untitled diagram 2" (VS Code). */
export function freeDiagramName(base: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!lower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/**
 * Each kind's name and one line: the one source of kind names (Decision 25), read by the Shelf, the
 * Space box, the code pane's header and Syntax Help.
 */
export const CARDS: Record<FrameKind, { title: string; text: string }> = {
  dfd: { title: "Data flow", text: "Processes, data stores and outside parties. Stores can link to tables." },
  flow: { title: "Flowchart", text: "Steps, decisions, input and output, start and end." },
  cloud: { title: "Cloud architecture", text: "Services as provider icons, grouped by network or layer." },
  er: { title: "ER diagram", text: "Tables with their columns and the relationships between them." },
  sequence: { title: "Sequence", text: "Who calls whom, in order: requests, replies and waits." },
  state: { title: "State", text: "States and the events that move between them." },
  class: { title: "Class", text: "Types with their fields and methods, and how they extend each other." },
  mindmap: { title: "Mind map", text: "One idea in the middle, branches out from it." },
  timeline: { title: "Timeline", text: "Dated events and periods along one line." },
};

/** The new file's text: only the first line, which names the kind and the title. */
export function newDiagramText(kind: DiagramKind, name: string): string {
  return `diagram ${kind} ${quote(name)}\n`;
}

/** A blank start (draw.io's Blank Diagram): the first line; a mind map keeps its central idea, the diagram's name. */
export function blankText(kind: DiagramKind, name: string): string {
  return kind === "mindmap" ? `${newDiagramText(kind, name)}root ${flowName(name)}\n` : newDiagramText(kind, name);
}
