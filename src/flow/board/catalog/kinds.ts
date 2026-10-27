// The Shelf's kind list (Decision 12 and the spec): the order the kinds show in, and extra words a search matches.
// A kind's name and line come from `KIND_HEAD` (which reads `CARDS`); nothing here names a kind.
import type { DiagramKind } from "../../../lang/flow/model";

/** The order the Shelf lists the kinds in. An order only: names come from `KIND_HEAD`. */
export const SHELF_KINDS: readonly DiagramKind[] = ["flow", "er", "sequence", "cloud", "dfd", "state", "class", "mindmap", "timeline"];

/** Extra words a search finds a kind by. Never names. */
export const KIND_WORDS: Record<DiagramKind, string> = {
  flow: "flowchart flow process steps decision",
  er: "erd er entity relationship table database schema columns",
  sequence: "sequence calls messages request reply api",
  cloud: "cloud architecture infrastructure aws gcp azure kubernetes services",
  dfd: "data flow dfd process store external",
  state: "state machine states events transitions lifecycle",
  class: "class uml types fields methods inheritance",
  mindmap: "mind map ideas branches brainstorm outline",
  timeline: "timeline dates schedule milestones roadmap",
};
