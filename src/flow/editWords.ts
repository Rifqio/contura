// The words the in-place edits and the add gestures say (boards DiagramEditInPlace and DiagramAddNext): what a
// shape is called, why a name is refused, which kinds take a line break in a name, and why a kind has no groups.
import type { DiagramKind, FlowNodeKind } from "../lang/flow/model";

const NOUN: Partial<Record<FlowNodeKind, string>> = {
  start: "start or end",
  end: "start or end",
  step: "step",
  decision: "decision",
  io: "input or output",
  subprocess: "subprocess",
  document: "document",
  database: "database",
  note: "note",
  process: "process",
  store: "data store",
  entity: "outside party",
  weak: "weak table",
  state: "state",
  choice: "choice",
  fork: "fork or join",
  service: "service",
  class: "class",
  interface: "interface",
  enum: "enum",
  participant: "participant",
  actor: "actor",
  event: "event",
  period: "period",
  milestone: "milestone",
  root: "central idea",
  topic: "topic",
};

/** What a shape of `kind` is called in a sentence: "data store", "outside party"; an ER diagram's entity is a "table". */
export function nounOf(kind: FlowNodeKind | null | undefined, diagram?: DiagramKind | null): string {
  if (diagram === "er" && kind === "entity") return "table";
  return (kind && NOUN[kind]) || "shape";
}

const article = (noun: string) => (/^[aeiou]/.test(noun) ? "An" : "A");

/** "A data store needs a name.", "A note needs some text." */
export function needsName(kind: FlowNodeKind | null | undefined, diagram?: DiagramKind | null): string {
  if (kind === "note") return "A note needs some text.";
  const noun = nounOf(kind, diagram);
  return `${article(noun)} ${noun} needs a name.`;
}

/** A name someone typed, said on one line. */
export const said = (name: string) => name.replace(/\r?\n/g, " ");

export const takenName = (name: string) => `${said(name)} is already used.`;

/** The kinds whose names may hold a line break (written `\n` in quotes, ADR 0019 P5); a note's text always may. */
export const MULTI_LINE: ReadonlySet<DiagramKind> = new Set(["flow", "dfd", "state", "cloud", "mindmap"]);

const KIND_NAME: Record<DiagramKind, string> = {
  flow: "flowchart",
  dfd: "data flow",
  state: "state",
  sequence: "sequence",
  class: "class",
  timeline: "timeline",
  cloud: "cloud",
  mindmap: "mind map",
  er: "table",
};

/** What Shift+Enter says where a name stays on one line. */
export function oneLineHint(diagram: DiagramKind): string {
  return diagram === "class" || diagram === "sequence" || diagram === "timeline" ? `A ${KIND_NAME[diagram]} name stays on one line.` : "This name stays on one line.";
}

export const MARKER_NOTE = "The start and end markers have no name: they are written [*].";

/** What Ctrl+G makes in a kind: a group, a data flow's area, a state's composite; null where a kind has none. */
export const GROUP_WORD: Partial<Record<DiagramKind, string>> = { flow: "Group", dfd: "Area", cloud: "Group", state: "Composite", er: "Group" };

/** Why Ctrl+G groups nothing in a kind with no groups. */
export const NO_GROUPS: Partial<Record<DiagramKind, string>> = {
  class: "A class diagram has no groups.",
  sequence: "In a sequence, Shapes > Loop goes around the selected messages.",
  timeline: "In a timeline, Shapes > Section groups the selected items.",
  mindmap: "A mind map groups by its branches.",
};

export const groupNeedsName = (word: string) => `${article(word.toLowerCase())} ${word.toLowerCase()} needs a name.`;

/** Why a canvas edit did nothing, said the same way by every in-place editor. */
export const EDIT_MESSAGES = {
  changed: "The text changed meanwhile. Try again.",
  stale: "Fix the text first: the drawing is from the last text that worked.",
  locked: "The Assistant is working on the text. Your edit is kept until it finishes.",
  /** A frame switch while the Assistant holds the text (Task 13): its changes are for the frame shown. */
  lockedSwitch: "The Assistant is working on this diagram. Switch to another once it finishes.",
};

/** Step 11 (board DiagramColourLabels): why Colour is off. The kinds written with a word or a date take no brackets. */
export const NO_COLOUR: Partial<Record<DiagramKind, string>> = {
  sequence: "Colour a participant in the code, for example participant App [color: info].",
  class: "Classes are written with a word (class Invoice) and take no brackets, so no colour or label in 1.0.",
  timeline: "Timeline items start with a date and take no brackets, so no colour or label in 1.0.",
};
export const COLOUR_WHY = {
  note: "A note keeps the note colour: it is written note: text, with no brackets.",
  marker: "The start and end markers are written [*] and take no colour.",
  root: "The central idea is written root and its name, with no brackets, so it takes no colour in 1.0.",
  lines: "Lines here take no colour in 1.0.",
  none: "None of these shapes takes a colour.",
};
