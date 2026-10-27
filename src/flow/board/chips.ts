// The code pane's kind words (Decision 25): the header's name and line, read from the one kind-name source (`CARDS`),
// each kind's icon, and the footer's chips, which insert the language's own syntax where you are typing. Every chip is
// tested against the parser in its kind's sample (chips.test.ts), so a chip can never teach syntax the language lacks.
import type { IconName } from "../../components/Icon";
import { DIAGRAM_KINDS, type DiagramKind } from "../../lang/flow/model";
import { CARDS } from "../diagramKinds";

/** Each kind's name and one line, for the pane's header: `CARDS`, the one source of kind names. */
export const KIND_HEAD = Object.fromEntries(DIAGRAM_KINDS.map((k) => [k, { name: CARDS[k].title, line: CARDS[k].text }])) as Record<
  DiagramKind,
  { name: string; line: string }
>;

/** A kind's icon: on a frame's tab, in the add menu and in the pane's header. */
export const KIND_ICON: Record<DiagramKind, IconName> = {
  dfd: "flow",
  flow: "diamond",
  cloud: "cloud",
  sequence: "sequence",
  state: "state",
  class: "cards",
  mindmap: "mindmap",
  timeline: "timeline",
  er: "table",
};

export interface Chip {
  /** What the chip shows: the syntax it inserts. */
  op: string;
  /** What it is, for its name ("Insert <name>"). */
  name: string;
  /** The text to insert where you are typing, given the line's text before that point. */
  insert: (lineText: string) => string;
}

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];

/** A line between two names: a space before it unless one is there, and one after. */
const between =
  (arrow: string) =>
  (line: string): string =>
    `${line === "" || /\s$/.test(line) ? "" : " "}${arrow} `;

/** A label after a line: `: `. */
const colon = (): string => ": ";

/** A group's braces round a new empty line, after the name typed. */
const group = (word: string) => (line: string): string => {
  const ind = indentOf(line);
  return `${line.trim() === "" ? word : line.endsWith(" ") ? "" : " "}{\n${ind}  \n${ind}}`;
};

/** A bracket list after a shape's name, with a value to type over. */
const brackets = (inner: string) => (line: string): string => `${line.endsWith(" ") ? "" : " "}[${inner}]`;

/** A word that starts a line: on this line when it is empty, else on a new line at its indent. */
const lineStart = (word: string) => (line: string): string => (line.trim() === "" ? word : `\n${indentOf(line)}${word}`);

/** The chips each kind's footer shows (Decision 25). */
export const CHIPS: Record<DiagramKind, Chip[]> = {
  flow: [
    { op: ">", name: "arrow", insert: between(">") },
    { op: "{}", name: "group", insert: group("Group ") },
    { op: "[]", name: "icon", insert: brackets("icon: box") },
  ],
  er: [
    { op: ">", name: "many-to-one", insert: between(">") },
    { op: "-", name: "one-to-one", insert: between("-") },
    { op: "<>", name: "many-to-many", insert: between("<>") },
  ],
  sequence: [
    { op: "->", name: "message", insert: between("->") },
    { op: "-->", name: "reply", insert: between("-->") },
    { op: ":", name: "label", insert: colon },
  ],
  dfd: [
    { op: ">", name: "flow", insert: between(">") },
    { op: "[]", name: "kind", insert: brackets("process") },
    { op: "{}", name: "group", insert: group("Group ") },
  ],
  cloud: [
    { op: ">", name: "arrow", insert: between(">") },
    { op: "{}", name: "group", insert: group("Network ") },
    { op: "[]", name: "icon", insert: brackets("icon: server") },
  ],
  state: [
    { op: ">", name: "transition", insert: between(">") },
    { op: ":", name: "event", insert: colon },
    { op: "{}", name: "group", insert: group("Group ") },
  ],
  class: [
    { op: "<|--", name: "extends", insert: between("<|--") },
    { op: "-->", name: "uses", insert: between("-->") },
    { op: ":", name: "member", insert: (line) => `${/\s$/.test(line) ? "" : " "}: ` },
  ],
  mindmap: [
    // A child: a line break, the line's indent and two spaces.
    { op: "indent", name: "child", insert: (line) => `\n${indentOf(line)}  ` },
    { op: "[]", name: "icon", insert: brackets("icon: star") },
  ],
  timeline: [
    { op: "date:", name: "item", insert: lineStart("2026-01-01: ") },
    { op: "milestone", name: "milestone", insert: lineStart("milestone ") },
    { op: "section", name: "section", insert: lineStart("section ") },
  ],
};

/**
 * A sample frame each kind's chips are tested in (chips.test.ts): `‸<i>` marks where chip `i` is typed, a plain `‸`
 * where any chip without its own mark is; a line with another chip's mark is left out for that chip, and a line with
 * no mark is kept for every chip.
 */
export const CHIP_SAMPLE: Record<DiagramKind, string> = {
  flow: 'diagram flow "Sample"\nCart\nPay\nCart‸0Pay\nGroup‸1\nBox‸2',
  er: 'diagram er "Sample"\norders {\n  id int pk\n}\nusers {\n  id int pk\n}\norders.id‸users.id',
  sequence: 'diagram sequence "Sample"\nApp‸0Api\nApi‸1App\nApp -> Api‸2ok',
  dfd: 'diagram dfd "Sample"\nCustomer [entity]\nPay [process]\nCustomer‸0Pay\nStore‸1\nGroup‸2',
  cloud: 'diagram cloud "Sample"\nUsers [icon: users]\nWeb [icon: server]\nUsers‸0Web\nNetwork‸1\nDb‸2',
  state: 'diagram state "Sample"\nDraft\nSent\nDraft‸0Sent\nDraft > Sent‸1send\nGroup‸2',
  class: 'diagram class "Sample"\nclass Invoice\nclass Document\nInvoice‸0Document\nInvoice‸1Document\nInvoice‸2total',
  mindmap: 'diagram mindmap "Sample"\nroot Plan\n  Topic‸0Detail\n  Idea‸1',
  timeline: 'diagram timeline "Sample"\n‸0Launch\n‸1v1\n‸2Q1',
};
