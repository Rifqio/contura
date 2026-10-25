import type { DiagramKind } from "../api/types";

/** A diagram's kind in words, as Recent lists say it (frame 6+.6). */
export const DIAGRAM_KIND_WORD: Record<DiagramKind, string> = {
  dfd: "Data flow",
  flow: "Flowchart",
  cloud: "Cloud",
  sequence: "Sequence",
  state: "State",
  class: "Class",
  mindmap: "Mind map",
  timeline: "Timeline",
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
