// Diagram steps 3 and 6 (boards DiagramEditInPlace and DiagramAddNext): the text each new canvas gesture writes.
// Class members as rows (CL1), an item's dates (T1), ungroup (D1) and the state markers (ST1). Each is one exact
// edit list; every other byte of the text stays as it was.
import { describe, expect, test } from "vitest";
import { applyFlowEdit, type FlowEditOp } from "./edits";
import { parseFlow } from "./parse";
import { applyFlowBatch } from "./service";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const apply = (text: string, op: FlowEditOp) => {
  const r = applyFlowEdit(text, parseFlow(text), op);
  let out = text;
  for (const e of [...r.edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return { text: out, edits: r.edits, note: r.note };
};

const CLASS = lines('diagram class "Billing"', "class Invoice", "Invoice : + total: decimal", "Invoice : + send()", "class LineItem", "LineItem : + qty: int", "", "Invoice *-- LineItem");

describe("CL1 class members as rows", () => {
  test("a new member goes after the last one, or after the class line when it has none", () => {
    expect(apply(CLASS, { op: "addMember", owner: "Invoice", at: 2, member: "+ due: date" }).text).toBe(CLASS.replace("Invoice : + send()\n", "Invoice : + send()\nInvoice : + due: date\n"));
    expect(apply(CLASS, { op: "addMember", owner: "Invoice", at: 1, member: "+ due: date" }).text).toBe(CLASS.replace("Invoice : + send()\n", "Invoice : + due: date\nInvoice : + send()\n"));
    const bare = lines('diagram class "B"', "class Payable", "class Customer");
    expect(apply(bare, { op: "addMember", owner: "Payable", at: 0, member: "+ pay()" }).text).toBe(lines('diagram class "B"', "class Payable", "Payable : + pay()", "class Customer"));
  });

  test("a member the class already has (spaces aside) is refused, as is an empty one", () => {
    expect(apply(CLASS, { op: "addMember", owner: "LineItem", at: 1, member: "+ qty:int" }).edits).toEqual([]);
    expect(apply(CLASS, { op: "addMember", owner: "LineItem", at: 1, member: " " }).edits).toEqual([]);
    expect(apply(CLASS, { op: "addMember", owner: "Nobody", at: 0, member: "+ x" }).edits).toEqual([]);
  });

  test("a member changes in place, by its place and the text the canvas saw there", () => {
    expect(apply(CLASS, { op: "setMember", owner: "Invoice", index: 1, was: "+ send()", member: "+ send(to: Email)" }).text).toBe(CLASS.replace("+ send()", "+ send(to: Email)"));
    // The text moved under the canvas: nothing changes.
    expect(apply(CLASS, { op: "setMember", owner: "Invoice", index: 0, was: "+ send()", member: "+ x" }).edits).toEqual([]);
    expect(apply(CLASS, { op: "setMember", owner: "Invoice", index: 1, was: "+ send()", member: "+ total: decimal" }).edits).toEqual([]);
  });

  test("Ctrl+Enter copies a member below it as name_copy, then name_copy2", () => {
    const once = apply(CLASS, { op: "duplicateMember", owner: "LineItem", index: 0, was: "+ qty: int" }).text;
    expect(once).toBe(CLASS.replace("LineItem : + qty: int\n", "LineItem : + qty: int\nLineItem : + qty_copy: int\n"));
    const twice = apply(once, { op: "duplicateMember", owner: "LineItem", index: 0, was: "+ qty: int" }).text;
    expect(twice).toBe(CLASS.replace("LineItem : + qty: int\n", "LineItem : + qty: int\nLineItem : + qty_copy2: int\nLineItem : + qty_copy: int\n"));
  });

  test("Delete removes the member's line only", () => {
    expect(apply(CLASS, { op: "deleteMember", owner: "Invoice", index: 0, was: "+ total: decimal" }).text).toBe(CLASS.replace("Invoice : + total: decimal\n", ""));
  });
});

const TIME = lines('diagram timeline "Launch"', "2026-10-01: Kickoff", "2026-10-05 to 2026-10-20: Build", "milestone v1.0");

describe("T1 an item's dates", () => {
  test("an event's date and a period's two dates are written in place", () => {
    expect(apply(TIME, { op: "setDate", name: "Kickoff", date: "2026-10-03" }).text).toBe(TIME.replace("2026-10-01: Kickoff", "2026-10-03: Kickoff"));
    expect(apply(TIME, { op: "setDate", name: "Build", date: "2026-10-06", until: "2026-10-27" }).text).toBe(TIME.replace("2026-10-05 to 2026-10-20", "2026-10-06 to 2026-10-27"));
  });

  test("an end before the start, a bad date or a milestone writes nothing", () => {
    expect(apply(TIME, { op: "setDate", name: "Build", date: "2026-10-20", until: "2026-10-05" }).edits).toEqual([]);
    expect(apply(TIME, { op: "setDate", name: "Kickoff", date: "Oct 3" }).edits).toEqual([]);
    expect(apply(TIME, { op: "setDate", name: "v1.0", date: "2026-10-03" }).edits).toEqual([]);
  });
});

describe("D1 ungroup", () => {
  const FLOW = lines('diagram flow "Orders"', "Start [start]", "Review {", "  Check stock", "  Back-order", "}", "Done [end]", "", "Start > Check stock", "Check stock > Back-order");

  test("the group's braces go and its shapes move out to where the group was, one level up", () => {
    expect(apply(FLOW, { op: "ungroup", name: "Review" }).text).toBe(lines('diagram flow "Orders"', "Start [start]", "Check stock", "Back-order", "Done [end]", "", "Start > Check stock", "Check stock > Back-order"));
  });

  test("a nested group keeps its own braces, one level out; a cloud group's icon goes with its line", () => {
    const cloud = lines('diagram cloud "App"', "AWS [icon: aws-cloud] {", "  VPC [icon: aws-vpc] {", "    Api [icon: aws-lambda]", "  }", "}");
    expect(apply(cloud, { op: "ungroup", name: "AWS" }).text).toBe(lines('diagram cloud "App"', "VPC [icon: aws-vpc] {", "  Api [icon: aws-lambda]", "}"));
  });

  test("a line to the group itself goes with it; an unknown group writes nothing", () => {
    const linked = lines('diagram flow "x"', "A", "G {", "  B", "}", "", "A > G");
    expect(apply(linked, { op: "ungroup", name: "G" }).text).toBe(lines('diagram flow "x"', "A", "B", ""));
    expect(apply(FLOW, { op: "ungroup", name: "Nope" }).edits).toEqual([]);
  });
});

describe("Ctrl+G group and the state markers", () => {
  test("a new group around shapes in one batch writes `Name {`, the shapes, `}`", () => {
    const text = lines('diagram dfd "Orders"', "Take order [process, id: 1.0]", "Bill [process, id: 2.0]", "orders [store, id: D1]");
    const r = applyFlowBatch(text, parseFlow(text), [
      { op: "addGroup", name: "Billing" },
      { op: "moveToGroup", name: "Take order", group: "Billing" },
      { op: "moveToGroup", name: "Bill", group: "Billing" },
    ]);
    let out = text;
    for (const e of [...r!.edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
    expect(out).toBe(lines('diagram dfd "Orders"', "orders [store, id: D1]", "Billing {", "  Take order [process, id: 1.0]", "  Bill [process, id: 2.0]", "}"));
  });

  test("a start or end marker's line is written [*]", () => {
    const text = lines('diagram state "Invoice"', "Draft", "Sent", "", "Draft > Sent : send");
    expect(apply(text, { op: "addLink", from: "[*] start", to: "Draft", arrow: ">" }).text).toBe(`${text}[*] > Draft\n`);
    expect(apply(text, { op: "addLink", from: "Sent", to: "[*] end", arrow: ">" }).text).toBe(`${text}Sent > [*]\n`);
  });
});

test("old files parse unchanged: the new ops add no syntax", () => {
  for (const t of [CLASS, TIME]) expect(parseFlow(t).problems.filter((p) => p.severity === "error")).toEqual([]);
});

describe("step 6: the Shapes items that are not plain shapes", () => {
  const SEQ = lines('diagram sequence "Pay"', "participant App", "participant Api", "", "App -> Api: charge", "Api --> App: ok", "note: retries");

  test("Activation writes `activate Name` after the last message", () => {
    expect(apply(SEQ, { op: "addActivation", name: "Api" }).text).toBe(SEQ.replace("Api --> App: ok\n", "Api --> App: ok\nactivate Api\n"));
  });

  test("Loop goes around the messages it is given, their lines indented one level", () => {
    expect(apply(SEQ, { op: "addLoop", label: "every item", from: 1, to: 1 }).text).toBe(SEQ.replace("Api --> App: ok\n", "loop every item {\n  Api --> App: ok\n}\n"));
    expect(apply(SEQ, { op: "addLoop", label: "retry", from: 0, to: 1 }).text).toBe(SEQ.replace("App -> Api: charge\nApi --> App: ok\n", "loop retry {\n  App -> Api: charge\n  Api --> App: ok\n}\n"));
    expect(apply(SEQ, { op: "addLoop", label: "", from: 0, to: 0 }).edits).toEqual([]);
  });

  test("Section takes the items it is given under `section Name`, after the items in no section", () => {
    const TL = lines('diagram timeline "Launch"', "2026-10-01: Kickoff", "2026-10-05: Build", "milestone v1.0");
    expect(apply(TL, { op: "addSection", name: "Phase 1", members: ["Kickoff", "Build"] }).text).toBe(lines('diagram timeline "Launch"', "milestone v1.0", "section Phase 1", "  2026-10-01: Kickoff", "  2026-10-05: Build"));
    expect(apply(TL, { op: "addSection", name: "Phase 1", members: [] }).edits).toEqual([]);
  });

  test("a timeline item takes the date it is given; a mind map topic goes under its parent, one level in", () => {
    const TL = lines('diagram timeline "Launch"', "2026-10-01: Kickoff", "2026-10-20: Ship");
    expect(apply(TL, { op: "addNode", name: "Review", kind: "event", date: "2026-10-10", before: "Ship" }).text).toBe(lines('diagram timeline "Launch"', "2026-10-01: Kickoff", "2026-10-10: Review", "2026-10-20: Ship"));
    expect(apply(TL, { op: "addNode", name: "Beta", kind: "period", date: "2026-10-21", until: "2026-11-11" }).text).toBe(`${TL}2026-10-21 to 2026-11-11: Beta\n`);
    const MIND = lines('diagram mindmap "Plan"', "root Launch", "  Docs", "    Guide", "  Build");
    expect(apply(MIND, { op: "addNode", name: "API", kind: "topic", under: "Docs" }).text).toBe(lines('diagram mindmap "Plan"', "root Launch", "  Docs", "    Guide", "    API", "  Build"));
    expect(apply(MIND, { op: "addNode", name: "Ops", kind: "topic", under: "Launch" }).text).toBe(lines('diagram mindmap "Plan"', "root Launch", "  Docs", "    Guide", "  Build", "  Ops"));
  });
});

test("fix round 1, M4: a new mind map child takes the indent its siblings use", () => {
  const MIND = lines('diagram mindmap "Plan"', "root Launch", "    Docs", "        Guide", "    Build");
  expect(apply(MIND, { op: "addNode", name: "API", kind: "topic", under: "Docs" }).text).toBe(lines('diagram mindmap "Plan"', "root Launch", "    Docs", "        Guide", "        API", "    Build"));
  // A parent with no child yet: one step of the file's own indent further in.
  expect(apply(MIND, { op: "addNode", name: "CI", kind: "topic", under: "Build" }).text).toBe(`${MIND}        CI\n`);
});
