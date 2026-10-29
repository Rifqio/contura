// Diagram steps 7 and 8 (boards DiagramMindMap and DiagramSequence): the text each new mind map and sequence gesture
// writes. A topic added beside another, moved under another parent or among its siblings, or deleted with its
// subtopics; a message put at a row, moved to another row, a participant moved sideways, a loop renamed, nested or
// taken apart. Each is one exact edit list; every other byte of the text stays as it was.
import { describe, expect, test } from "vitest";
import { applyFlowEdit, type FlowEditOp } from "./edits";
import { parseFlow } from "./parse";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const apply = (text: string, op: FlowEditOp) => {
  const r = applyFlowEdit(text, parseFlow(text), op);
  let out = text;
  for (const e of [...r.edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return { text: out, edits: r.edits, note: r.note };
};

const MAP = lines(
  'diagram mindmap "Q4 plan"',
  "root Q4 plan",
  "  Diagrams",
  "    New kinds",
  "    Inline editing",
  "  Redis",
  "    Pub/Sub",
  "    Key browser",
  "  Release",
  "    Docs",
  "    Installer",
  "  Servers",
  "",
  "Installer > Servers",
);

describe("M1 Shift+Tab adds the next topic below, after the selected one's branch", () => {
  test("after a topic with subtopics, at its indent", () => {
    expect(apply(MAP, { op: "addNode", name: "Topic", kind: "topic", after: "Redis" }).text).toBe(MAP.replace("    Key browser\n", "    Key browser\n  Topic\n"));
  });
  test("after a subtopic, at its indent", () => {
    expect(apply(MAP, { op: "addNode", name: "Topic", kind: "topic", after: "Docs" }).text).toBe(MAP.replace("    Docs\n", "    Docs\n    Topic\n"));
  });
  test("a taken name and the central idea are refused", () => {
    expect(apply(MAP, { op: "addNode", name: "Docs", kind: "topic", after: "Redis" }).edits).toEqual([]);
    expect(apply(MAP, { op: "addNode", name: "Topic", kind: "topic", after: "Q4 plan" }).edits).toEqual([]);
  });
});

describe("M4 a topic moves with its subtopics, re-indented, as one edit", () => {
  test("onto another topic: it becomes that topic's subtopic, before or after its children", () => {
    const first = apply(MAP, { op: "moveTopic", name: "Redis", parent: "Release", index: 0 }).text;
    expect(first).toBe(lines('diagram mindmap "Q4 plan"', "root Q4 plan", "  Diagrams", "    New kinds", "    Inline editing", "  Release", "    Redis", "      Pub/Sub", "      Key browser", "    Docs", "    Installer", "  Servers", "", "Installer > Servers"));
    const last = apply(MAP, { op: "moveTopic", name: "Redis", parent: "Release", index: 2 }).text;
    expect(last).toBe(lines('diagram mindmap "Q4 plan"', "root Q4 plan", "  Diagrams", "    New kinds", "    Inline editing", "  Release", "    Docs", "    Installer", "    Redis", "      Pub/Sub", "      Key browser", "  Servers", "", "Installer > Servers"));
  });

  test("a topic with no subtopics yet takes them one step in", () => {
    expect(apply(MAP, { op: "moveTopic", name: "Servers", parent: "Docs", index: 0 }).text).toBe(MAP.replace("    Docs\n", "    Docs\n      Servers\n").replace("  Servers\n\n", "\n"));
  });

  test("a subtopic moves up a level", () => {
    expect(apply(MAP, { op: "moveTopic", name: "Pub/Sub", parent: "Q4 plan", index: 4 }).text).toBe(MAP.replace("    Pub/Sub\n", "").replace("  Servers\n", "  Servers\n  Pub/Sub\n"));
  });

  test("among its siblings: Ctrl+Up and Ctrl+Down", () => {
    expect(apply(MAP, { op: "moveTopic", name: "Redis", parent: "Q4 plan", index: 0 }).text).toBe(
      lines('diagram mindmap "Q4 plan"', "root Q4 plan", "  Redis", "    Pub/Sub", "    Key browser", "  Diagrams", "    New kinds", "    Inline editing", "  Release", "    Docs", "    Installer", "  Servers", "", "Installer > Servers"),
    );
    expect(apply(MAP, { op: "moveTopic", name: "Docs", parent: "Release", index: 1 }).text).toBe(MAP.replace("    Docs\n    Installer\n", "    Installer\n    Docs\n"));
  });

  test("where it already is, under its own subtopic, the central idea and an unknown parent are refused", () => {
    expect(apply(MAP, { op: "moveTopic", name: "Redis", parent: "Q4 plan", index: 1 }).edits).toEqual([]);
    expect(apply(MAP, { op: "moveTopic", name: "Redis", parent: "Pub/Sub", index: 0 }).edits).toEqual([]);
    expect(apply(MAP, { op: "moveTopic", name: "Redis", parent: "Redis", index: 0 }).edits).toEqual([]);
    expect(apply(MAP, { op: "moveTopic", name: "Q4 plan", parent: "Redis", index: 0 }).edits).toEqual([]);
    expect(apply(MAP, { op: "moveTopic", name: "Redis", parent: "Nobody", index: 0 }).edits).toEqual([]);
  });

  test("the last line with no line break, a CRLF file and a comment inside the branch", () => {
    const bare = lines('diagram mindmap "M"', "root M", "  A", "  B", "    C").replace(/\n$/, "");
    expect(apply(bare, { op: "moveTopic", name: "B", parent: "M", index: 0 }).text).toBe(lines('diagram mindmap "M"', "root M", "  B", "    C", "  A").replace(/\n$/, ""));
    const crlf = lines('diagram mindmap "M"', "root M", "  A", "  B", "    // why", "    C").replace(/\n/g, "\r\n");
    expect(apply(crlf, { op: "moveTopic", name: "B", parent: "A", index: 0 }).text).toBe(lines('diagram mindmap "M"', "root M", "  A", "    B", "      // why", "      C").replace(/\n/g, "\r\n"));
  });
});

describe("Delete takes a topic, its subtopics and every relationship that touches them", () => {
  test("one edit list", () => {
    expect(apply(MAP, { op: "deleteTopic", name: "Release" }).text).toBe(lines('diagram mindmap "Q4 plan"', "root Q4 plan", "  Diagrams", "    New kinds", "    Inline editing", "  Redis", "    Pub/Sub", "    Key browser", "  Servers", ""));
    expect(apply(MAP, { op: "deleteTopic", name: "Docs" }).text).toBe(MAP.replace("    Docs\n", ""));
  });
  test("the central idea stays", () => {
    expect(apply(MAP, { op: "deleteTopic", name: "Q4 plan" }).edits).toEqual([]);
  });
});

const SEQ = lines(
  'diagram sequence "Checkout"',
  "actor Customer",
  "participant Shop",
  "participant Stock",
  "participant Payments",
  "",
  "Customer -> Shop: place order",
  "Shop -> Stock: reserve items",
  "Stock --> Shop: reserved",
  "Shop -> Payments: charge card",
  "Payments --> Shop: approved",
  "Shop --> Customer: receipt",
);

const LOOPED = lines(
  'diagram sequence "Checkout"',
  "actor Customer",
  "participant Shop",
  "participant Stock",
  "",
  "Customer -> Shop: place order",
  "loop every item {",
  "  Shop -> Stock: reserve items",
  "  Stock --> Shop: reserved",
  "}",
  "Shop --> Customer: receipt",
);

describe("S1 a message goes in at the row where it was drawn", () => {
  test("between two messages, first and last", () => {
    expect(apply(SEQ, { op: "addMessage", from: "Customer", to: "Payments", at: 2 }).text).toBe(SEQ.replace("Stock --> Shop: reserved\n", "Customer -> Payments\nStock --> Shop: reserved\n"));
    expect(apply(SEQ, { op: "addMessage", from: "Stock", to: "Shop", at: 0 }).text).toBe(SEQ.replace("Customer -> Shop: place order\n", "Stock -> Shop\nCustomer -> Shop: place order\n"));
    expect(apply(SEQ, { op: "addMessage", from: "Stock", to: "Shop", at: 6 }).text).toBe(`${SEQ}Stock -> Shop\n`);
  });

  test("a loop holds a new message only between two of its own", () => {
    expect(apply(LOOPED, { op: "addMessage", from: "Customer", to: "Stock", at: 1 }).text).toBe(LOOPED.replace("loop every item {\n", "Customer -> Stock\nloop every item {\n"));
    expect(apply(LOOPED, { op: "addMessage", from: "Customer", to: "Stock", at: 2 }).text).toBe(LOOPED.replace("  Stock --> Shop", "  Customer -> Stock\n  Stock --> Shop"));
    expect(apply(LOOPED, { op: "addMessage", from: "Customer", to: "Stock", at: 3 }).text).toBe(LOOPED.replace("}\n", "}\nCustomer -> Stock\n"));
  });

  test("a reply goes on the next row, dashed, inside the loop of the message it answers", () => {
    expect(apply(LOOPED, { op: "addMessage", from: "Shop", to: "Stock", at: 3, arrow: "-->", inside: true }).text).toBe(LOOPED.replace("  Stock --> Shop: reserved\n", "  Stock --> Shop: reserved\n  Shop --> Stock\n"));
  });

  test("an unknown participant, a row out of range and an arrow a sequence does not draw are refused", () => {
    expect(apply(SEQ, { op: "addMessage", from: "Nobody", to: "Shop", at: 0 }).edits).toEqual([]);
    expect(apply(SEQ, { op: "addMessage", from: "Shop", to: "Stock", at: 9 }).edits).toEqual([]);
    expect(apply(SEQ, { op: "addMessage", from: "Shop", to: "Stock", at: 1, arrow: ">" }).edits).toEqual([]);
  });

  test("a sequence with no messages yet takes the first after its participants", () => {
    const bare = lines('diagram sequence "P"', "participant A", "participant B");
    expect(apply(bare, { op: "addMessage", from: "A", to: "B", at: 0 }).text).toBe(`${bare}\nA -> B\n`);
  });
});

describe("S1 a message dragged to another row moves its line", () => {
  test("down, up and to the end; where it already is does nothing", () => {
    expect(apply(SEQ, { op: "moveMessage", index: 0, at: 3 }).text).toBe(SEQ.replace("Customer -> Shop: place order\n", "").replace("Stock --> Shop: reserved\n", "Stock --> Shop: reserved\nCustomer -> Shop: place order\n"));
    expect(apply(SEQ, { op: "moveMessage", index: 4, at: 1 }).text).toBe(SEQ.replace("Payments --> Shop: approved\n", "").replace("Shop -> Stock", "Payments --> Shop: approved\nShop -> Stock"));
    expect(apply(SEQ, { op: "moveMessage", index: 0, at: 6 }).text).toBe(`${SEQ.replace("Customer -> Shop: place order\n", "")}Customer -> Shop: place order\n`);
    expect(apply(SEQ, { op: "moveMessage", index: 2, at: 2 }).edits).toEqual([]);
    expect(apply(SEQ, { op: "moveMessage", index: 2, at: 3 }).edits).toEqual([]);
    expect(apply(SEQ, { op: "moveMessage", index: 9, at: 0 }).edits).toEqual([]);
  });

  test("into a loop between two of its messages, and out of it", () => {
    expect(apply(LOOPED, { op: "moveMessage", index: 3, at: 2 }).text).toBe(LOOPED.replace("Shop --> Customer: receipt\n", "").replace("  Stock --> Shop", "  Shop --> Customer: receipt\n  Stock --> Shop"));
    expect(apply(LOOPED, { op: "moveMessage", index: 2, at: 4 }).text).toBe(LOOPED.replace("  Stock --> Shop: reserved\n", "").replace("Shop --> Customer: receipt\n", "Shop --> Customer: receipt\nStock --> Shop: reserved\n"));
    expect(apply(LOOPED, { op: "moveMessage", index: 1, at: 0 }).text).toBe(LOOPED.replace("  Shop -> Stock: reserve items\n", "").replace("Customer -> Shop", "Shop -> Stock: reserve items\nCustomer -> Shop"));
  });

  test("a loop its only message leaves goes too", () => {
    const one = lines('diagram sequence "P"', "participant A", "participant B", "A -> B: one", "loop retry {", "  B -> A: two", "}", "A -> B: three");
    expect(apply(one, { op: "moveMessage", index: 1, at: 3 }).text).toBe(lines('diagram sequence "P"', "participant A", "participant B", "A -> B: one", "A -> B: three", "B -> A: two"));
  });
});

describe("S2 a participant dragged sideways reorders the participant lines only", () => {
  test("declared participants: one line moves", () => {
    expect(apply(SEQ, { op: "moveParticipant", name: "Payments", before: "Shop" }).text).toBe(SEQ.replace("participant Payments\n", "").replace("participant Shop\n", "participant Payments\nparticipant Shop\n"));
    expect(apply(SEQ, { op: "moveParticipant", name: "Customer", before: null }).text).toBe(SEQ.replace("actor Customer\n", "").replace("participant Payments\n", "participant Payments\nactor Customer\n"));
    expect(apply(SEQ, { op: "moveParticipant", name: "Shop", before: "Stock" }).edits).toEqual([]);
    expect(apply(SEQ, { op: "moveParticipant", name: "Nobody", before: null }).edits).toEqual([]);
  });

  test("participants named only by their messages are written out, in the new order", () => {
    const loose = lines('diagram sequence "P"', "participant Shop", "Customer -> Shop: order", "Shop -> Stock: reserve");
    expect(apply(loose, { op: "moveParticipant", name: "Stock", before: "Shop" }).text).toBe(lines('diagram sequence "P"', "participant Stock", "participant Shop", "participant Customer", "Customer -> Shop: order", "Shop -> Stock: reserve"));
  });
});

describe("S4 a loop renamed, taken apart, nested; its messages stay", () => {
  test("the label changes in place", () => {
    expect(apply(LOOPED, { op: "setFrameLabel", index: 0, was: "loop every item", label: "each line" }).text).toBe(LOOPED.replace("loop every item {", "loop each line {"));
    expect(apply(LOOPED, { op: "setFrameLabel", index: 0, was: "loop other", label: "each line" }).edits).toEqual([]);
    expect(apply(LOOPED, { op: "setFrameLabel", index: 0, was: "loop every item", label: "a { b" }).edits).toEqual([]);
  });

  test("Delete on a loop removes its two lines and takes its messages out one level", () => {
    expect(apply(LOOPED, { op: "unwrapFrame", index: 0, was: "loop every item" }).text).toBe(LOOPED.replace("loop every item {\n", "").replace("}\n", "").replace(/ {2}(Shop|Stock)/g, "$1"));
    expect(apply(LOOPED, { op: "unwrapFrame", index: 0, was: "loop gone" }).edits).toEqual([]);
  });

  test("a loop around messages that start or end another goes outside it; one inside nests", () => {
    const outer = apply(LOOPED, { op: "addLoop", label: "until paid", from: 1, to: 3 }).text;
    expect(outer).toBe(lines('diagram sequence "Checkout"', "actor Customer", "participant Shop", "participant Stock", "", "Customer -> Shop: place order", "loop until paid {", "  loop every item {", "    Shop -> Stock: reserve items", "    Stock --> Shop: reserved", "  }", "  Shop --> Customer: receipt", "}"));
    const inner = apply(LOOPED, { op: "addLoop", label: "twice", from: 2, to: 2 }).text;
    expect(inner).toBe(LOOPED.replace("  Stock --> Shop: reserved\n", "  loop twice {\n    Stock --> Shop: reserved\n  }\n"));
    const same = apply(LOOPED, { op: "addLoop", label: "twice", from: 1, to: 2 }).text;
    expect(same).toBe(LOOPED.replace("  Shop -> Stock: reserve items\n  Stock --> Shop: reserved\n", "  loop twice {\n    Shop -> Stock: reserve items\n    Stock --> Shop: reserved\n  }\n"));
  });

  test("a loop that would cut across another is refused, and says why", () => {
    const r = apply(LOOPED, { op: "addLoop", label: "x", from: 2, to: 3 });
    expect(r.edits).toEqual([]);
    expect(r.note).toBe('A loop holds whole frames: this one would cut across "loop every item". Select from its first to its last message, or inside it.');
  });

  test("deleting a loop's only message takes the empty loop with it", () => {
    const one = lines('diagram sequence "P"', "participant A", "participant B", "A -> B: one", "loop retry {", "  B -> A: two", "}", "A -> B: three");
    expect(apply(one, { op: "deleteLink", index: 1 }).text).toBe(lines('diagram sequence "P"', "participant A", "participant B", "A -> B: one", "A -> B: three"));
  });
});

// ----- Fix round 1 (diag-78-build-review.md)

describe("fix round 1: the writer", () => {
  test("M1 a comment after a branch's last subtopic, indented under it, moves with the branch", () => {
    const text = lines('diagram mindmap "x"', "root Plan", "  A", "    A1", "    // about A", "  B");
    expect(apply(text, { op: "moveTopic", name: "A", parent: "B", index: 0 }).text).toBe(lines('diagram mindmap "x"', "root Plan", "  B", "    A", "      A1", "      // about A"));
    // A comment at the branch's own level or shallower stays where it is.
    const own = lines('diagram mindmap "x"', "root Plan", "  A", "    A1", "  // about the next", "  B");
    expect(apply(own, { op: "moveTopic", name: "A", parent: "B", index: 0 }).text).toBe(lines('diagram mindmap "x"', "root Plan", "  // about the next", "  B", "    A", "      A1"));
  });

  test("M5 a message added between two links of a chained line splits the line there, so it lands on its row", () => {
    const text = lines('diagram sequence "s"', "participant A", "participant B", "participant C", "A -> B -> C", "C -> A");
    expect(apply(text, { op: "addMessage", from: "A", to: "C", at: 1 }).text).toBe(lines('diagram sequence "s"', "participant A", "participant B", "participant C", "A -> B", "A -> C", "B -> C", "C -> A"));
  });

  test("I3 a message on a chained line refuses a move and says why", () => {
    const text = lines('diagram sequence "s"', "participant A", "participant B", "participant C", "A -> B -> C", "C -> A");
    const r = apply(text, { op: "moveMessage", index: 1, at: 3 });
    expect(r.edits).toEqual([]);
    expect(r.note).toBe("This message shares its line with others (A -> B -> C). Split the line in the text to move it on its own.");
  });
});

describe("a coloured sequence frame", () => {
  test("renaming_a_coloured_block_keeps_its_colour", () => {
    const text = lines('diagram sequence "S"', "participant A", "participant B", "opt a [color: info] {", "  A -> B: hi", "}");
    expect(apply(text, { op: "setFrameLabel", index: 0, was: "opt a", label: "b" }).text).toBe(text.replace("opt a [", "opt b ["));
    const bare = text.replace("opt a [color: info] {", "opt [color: info] {");
    expect(apply(bare, { op: "setFrameLabel", index: 0, was: "opt", label: "b" }).text).toBe(bare.replace("opt [", "opt b ["));
  });

  test("a_label_ending_in_attribute_brackets_is_refused_not_read_as_attributes", () => {
    const text = lines('diagram sequence "S"', "participant A", "participant B", "loop retry {", "  A -> B: hi", "}");
    for (const label of ["retry [color: red]", "see [label: x]"]) {
      const r = apply(text, { op: "setFrameLabel", index: 0, was: "loop retry", label });
      expect(r.edits, label).toEqual([]);
      expect(r.note, label).toBe("Brackets at the end of a frame's label read as its colour. Write the colour in code, for example opt card saved [color: warning] {.");
    }
    // A UML guard in brackets stays words.
    expect(apply(text, { op: "setFrameLabel", index: 0, was: "loop retry", label: "each [n > 0]" }).text).toBe(text.replace("loop retry {", "loop each [n > 0] {"));
  });
});
