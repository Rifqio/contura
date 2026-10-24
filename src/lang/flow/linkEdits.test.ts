// Diagram step 4 (F8, CL2) and ER step 2.4: a line's arrow, its direction and its ends change on the canvas. Each is
// one exact text edit; the rest of the text stays byte for byte, and a chain is split only when one of its links changes.
import { describe, expect, test } from "vitest";
import type { TextEdit } from "../protocol";
import { applyFlowEdit, reverseLink, setLinkArrow, setLinkEnd } from "./edits";
import { STATE_END, STATE_START } from "./model";
import { parseFlow } from "./parse";

function apply(text: string, edits: TextEdit[]): string {
  return [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
}
const lines = (...ls: string[]) => `${ls.join("\n")}\n`;
const run = (text: string, edit: (t: string, p: ReturnType<typeof parseFlow>) => TextEdit[]) => apply(text, edit(text, parseFlow(text)));
const clean = (text: string) => expect(parseFlow(text).problems.filter((p) => p.severity === "error")).toEqual([]);

const FLOW = lines('diagram flow "x"', "A", "B", '"Pay: card"', "// the main path", "A > B: go", "B > C", "C", "  A > B > C");

describe("setLinkArrow", () => {
  test("changes only the arrow, inside a chain too", () => {
    expect(run(FLOW, (t, p) => setLinkArrow(t, p, 0, "<>"))).toBe(FLOW.replace("A > B: go", "A <> B: go"));
    const out = run(FLOW, (t, p) => setLinkArrow(t, p, 3, "-->"));
    expect(out).toBe(FLOW.replace("  A > B > C", "  A > B --> C"));
    clean(out);
  });

  test("an arrow the kind does not draw, the same arrow, or no such line changes nothing", () => {
    expect(setLinkArrow(FLOW, parseFlow(FLOW), 0, "1--*")).toEqual([]);
    expect(setLinkArrow(FLOW, parseFlow(FLOW), 0, ">")).toEqual([]);
    expect(setLinkArrow(FLOW, parseFlow(FLOW), 9, "<>")).toEqual([]);
  });

  test("an ER relationship's cardinality and a class line's kind", () => {
    const er = lines('diagram er "b"', "customers", "invoices", "customers 1--* invoices : bills");
    expect(run(er, (t, p) => setLinkArrow(t, p, 0, "1--1"))).toBe(er.replace("1--*", "1--1"));
    const cls = lines('diagram class "c"', "class Animal", "class Dog", "Animal <|-- Dog");
    expect(run(cls, (t, p) => setLinkArrow(t, p, 0, "*--"))).toBe(cls.replace("<|--", "*--"));
  });
});

describe("reverseLink", () => {
  test("swaps the two names as written, label kept", () => {
    const t = lines('diagram flow "x"', "A", '"Step two"', 'A > "Step two": go');
    expect(run(t, (x, p) => reverseLink(x, p, 0))).toBe(lines('diagram flow "x"', "A", '"Step two"', '"Step two" > A: go'));
  });

  test("an ER relationship swaps its ends and keeps each table's end (board ER interactions)", () => {
    const er = lines('diagram er "b"', "customers", "invoices", "customers 1--* invoices : bills");
    const out = run(er, (t, p) => reverseLink(t, p, 0));
    expect(out).toBe(er.replace("customers 1--* invoices", "invoices *--1 customers"));
    clean(out);
  });

  test("a link in a chain splits the chain into one line per link, in order, with the same indent", () => {
    const out = run(FLOW, (t, p) => reverseLink(t, p, 2));
    expect(out).toBe(FLOW.replace("  A > B > C", "  B > A\n  B > C"));
    clean(out);
  });
});

describe("setLinkEnd", () => {
  test("reattaches either end to another shape, quoted when it needs it", () => {
    expect(run(FLOW, (t, p) => setLinkEnd(t, p, 0, "to", "Pay: card"))).toBe(FLOW.replace("A > B: go", 'A > "Pay: card": go'));
    expect(run(FLOW, (t, p) => setLinkEnd(t, p, 1, "from", "A"))).toBe(FLOW.replace("B > C\n", "A > C\n"));
  });

  test("in a chain only that link moves; the chain is split", () => {
    expect(run(FLOW, (t, p) => setLinkEnd(t, p, 2, "to", "Pay: card"))).toBe(FLOW.replace("  A > B > C", '  A > "Pay: card"\n  B > C'));
  });

  test("an unknown shape, the end it already has, or no such line changes nothing", () => {
    expect(setLinkEnd(FLOW, parseFlow(FLOW), 0, "to", "Nobody")).toEqual([]);
    expect(setLinkEnd(FLOW, parseFlow(FLOW), 0, "to", "B")).toEqual([]);
    expect(setLinkEnd(FLOW, parseFlow(FLOW), 9, "to", "A")).toEqual([]);
  });

  test("a state diagram's start and end markers are written [*], only where they can stand", () => {
    const st = lines('diagram state "s"', "[*] > Draft", "Draft > Sent", "Sent");
    expect(run(st, (t, p) => setLinkEnd(t, p, 1, "to", STATE_END))).toBe(st.replace("Draft > Sent", "Draft > [*]"));
    expect(setLinkEnd(st, parseFlow(st), 1, "to", STATE_START)).toEqual([]);
    expect(setLinkEnd(st, parseFlow(st), 1, "from", STATE_END)).toEqual([]);
  });

  test("the ops run through the editor entry", () => {
    const t = lines('diagram flow "x"', "A", "B", "C", "A > B");
    const link = { from: "A", to: "B", label: null, nth: 0 };
    expect(apply(t, applyFlowEdit(t, parseFlow(t), { op: "setLinkEnd", link, end: "to", node: "C" }).edits)).toBe(t.replace("A > B", "A > C"));
    expect(apply(t, applyFlowEdit(t, parseFlow(t), { op: "reverseLink", link }).edits)).toBe(t.replace("A > B", "B > A"));
    expect(apply(t, applyFlowEdit(t, parseFlow(t), { op: "setLinkArrow", link, arrow: "-" }).edits)).toBe(t.replace("A > B", "A - B"));
  });
});

// ---- Fix round 1 (I1, I2, M6): the canvas names a line by its ends, its label and which of those it is, never by an
// index into a drawing that may be stale; a line it cannot find, or a text with errors, is refused with the reason.
describe("a line named by its ends", () => {
  const ref = (from: string, to: string, label: string | null = null, nth = 0) => ({ from, to, label, nth });
  const edit = (t: string, op: Parameters<typeof applyFlowEdit>[2]) => applyFlowEdit(t, parseFlow(t), op);

  test("the right line is changed after lines were added above it", () => {
    const t = lines('diagram flow "x"', "A", "B", "C", "C > A", "A > B", "B > C");
    expect(apply(t, edit(t, { op: "reverseLink", link: ref("A", "B") }).edits)).toBe(t.replace("A > B", "B > A"));
    // The second of two equal lines.
    const two = lines('diagram flow "x"', "A", "B", "A > B", "A > B");
    const r = edit(two, { op: "setLinkArrow", link: ref("A", "B", null, 1), arrow: "<>" });
    expect(apply(two, r.edits)).toBe(lines('diagram flow "x"', "A", "B", "A > B", "A <> B"));
    // The label tells two lines between the same shapes apart.
    const labelled = lines('diagram flow "x"', "A", "B", "A > B: yes", "A > B: no");
    expect(apply(labelled, edit(labelled, { op: "setLinkEnd", link: ref("A", "B", "no"), end: "to", node: "A" }).edits)).toBe(labelled.replace("A > B: no", "A > A: no"));
  });

  test("a line no longer in the text, or a text with errors, is refused with the reason", () => {
    const t = lines('diagram flow "x"', "A", "B", "A > B");
    expect(edit(t, { op: "reverseLink", link: ref("B", "A") })).toEqual({ edits: [], note: "That line is no longer in the text, so nothing was changed." });
    const broken = `${t}A [nope\n`;
    expect(edit(broken, { op: "reverseLink", link: ref("A", "B") })).toEqual({ edits: [], note: "Fix the text first: the drawing is the last one without errors." });
  });

  test("the arrow it already has, a reverse of a loop or a drop on the same shape do nothing and say nothing", () => {
    const t = lines('diagram flow "x"', "A", "B", "A > B", "B > B");
    expect(edit(t, { op: "setLinkArrow", link: ref("A", "B"), arrow: ">" })).toEqual({ edits: [] });
    expect(edit(t, { op: "reverseLink", link: ref("B", "B") })).toEqual({ edits: [] });
    expect(edit(t, { op: "setLinkEnd", link: ref("A", "B"), end: "to", node: "B" })).toEqual({ edits: [] });
  });

  test("a state diagram's start and end markers keep their meaning: no reverse, no end on the wrong marker (M6)", () => {
    const st = lines('diagram state "s"', "Draft", "Sent", "[*] > Draft", "Draft > Sent");
    expect(edit(st, { op: "reverseLink", link: ref(STATE_START, "Draft") })).toEqual({
      edits: [],
      note: "A line from the start or to the end cannot be reversed: the start only begins a line and the end only ends one.",
    });
    expect(edit(st, { op: "setLinkEnd", link: ref("Draft", "Sent"), end: "to", node: STATE_START })).toEqual({
      edits: [],
      note: "The start only begins a line and the end only ends one.",
    });
    expect(edit(st, { op: "setLinkEnd", link: ref("Draft", "Sent"), end: "to", node: "Nobody" })).toEqual({ edits: [], note: "Nobody is not in the text." });
  });
});
