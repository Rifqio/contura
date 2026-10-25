// Diagram step 11 (board DiagramColourLabels, ADR 0019 amendment): `label:` and the six-colour palette in the
// language, the writer and the canvas edits.
import { describe, expect, test } from "vitest";
import { writeFlow } from "../../flow/flowModel";
import type { TextEdit } from "../protocol";
import { applyFlowEdit, setAttr } from "./edits";
import { ATTR_KEYS, attrValue, isPaletteName, nodeStatement, PALETTE, shownName } from "./model";
import { parseFlow } from "./parse";
import { MESSAGES } from "./problems";
import { applyFlowBatch } from "./service";

const lines = (...ls: string[]) => `${ls.join("\n")}\n`;
const apply = (text: string, edits: TextEdit[]) =>
  [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
const errors = (text: string) => parseFlow(text).problems.filter((p) => p.severity === "error");
const ok = (text: string) => {
  const r = parseFlow(text);
  expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
  if (!r.doc) throw new Error("no doc");
  return r.doc;
};
const FLOW = 'diagram flow "F"';

describe("the attributes", () => {
  test("are id, icon, label, color and table, in that order", () => {
    expect(ATTR_KEYS).toEqual(["id", "icon", "label", "color", "table"]);
    expect(PALETTE).toEqual(["accent", "info", "success", "warning", "danger", "muted"]);
    expect(isPaletteName("danger")).toBe(true);
    expect(isPaletteName("red")).toBe(false);
  });

  test("a label is quoted by the name rule plus a comma", () => {
    expect(attrValue("label", "Retry")).toBe("Retry");
    expect(attrValue("label", "Yes, retry")).toBe('"Yes, retry"');
    expect(attrValue("label", "A > B")).toBe('"A > B"');
    expect(attrValue("label", "Pay: card")).toBe('"Pay: card"');
    expect(attrValue("color", "danger")).toBe("danger");
  });
});

describe("label:", () => {
  test("a shape shows its label; lines name it by its name", () => {
    const doc = ok(lines(FLOW, "Retry", "Retry 2 [step, label: Retry]", "Retry > Retry 2"));
    const two = doc.nodes[1];
    expect(two).toEqual({ name: "Retry 2", kind: "step", attrs: { label: "Retry" } });
    expect(shownName(two)).toBe("Retry");
    expect(shownName(doc.nodes[0])).toBe("Retry");
    expect(parseFlow(lines(FLOW, "Retry 2 [label: Retry]")).labels.get("Retry 2")).toBe("Retry");
  });

  test("a quoted label keeps its commas and line breaks", () => {
    const doc = ok(lines(FLOW, 'Ask 2 [label: "Paid, or\\nnot?"]'));
    expect(doc.nodes[0].attrs.label).toBe("Paid, or\nnot?");
  });

  test("a line end that matches one label says to write the name, with a fix", () => {
    const text = lines(FLOW, "Retry", "Charge", "Retry 2 [label: Again]", "Charge > Again");
    const [p] = errors(text);
    expect(p.message).toBe(MESSAGES.isLabel("Again", "Retry 2"));
    expect(p.message).toBe("Again is a label: lines name a shape by its name, so write Retry 2.");
    expect(p.fixes.map((f) => f.title)).toEqual(["Use Retry 2"]);
    expect(ok(apply(text, p.fixes[0].edits)).links[0]).toMatchObject({ from: "Charge", to: "Retry 2" });
  });

  test("a label several shapes show says so and offers each name", () => {
    const text = lines(FLOW, "Go", "Retry 2 [label: Again]", "Retry 3 [label: Again]", "Again > Go");
    const [p] = errors(text);
    expect(p.message).toBe("Several shapes show Again: a line names one by its name.");
    expect(p.fixes.map((f) => f.title)).toEqual(["Use Retry 2", "Use Retry 3"]);
  });

  test("sequence and class shapes take no label or colour", () => {
    const seq = errors(lines('diagram sequence "S"', "Shop [color: danger]"));
    expect(seq[0].message).toBe(MESSAGES.noAttrHere("color", "sequence"));
    expect(seq[0].message).toBe("A sequence diagram's shapes take no colour or label.");
    const cls = errors(lines('diagram class "C"', "Invoice [label: Bill]"));
    expect(cls[0].message).toBe("A class diagram's shapes take no colour or label.");
    expect(cls[0].fixes.map((f) => f.title)).toEqual(["Remove it"]);
  });

  test("mind map topics take them", () => {
    const doc = ok(lines('diagram mindmap "M"', "root Plan", "  Retry", "  Retry 2 [label: Retry, color: danger]"));
    expect(doc.nodes[2]).toMatchObject({ name: "Retry 2", kind: "topic", attrs: { label: "Retry", color: "danger" }, depth: 1 });
  });
});

describe("color:", () => {
  test("a palette name reads clean", () => {
    const r = parseFlow(lines(FLOW, "Retry [color: danger]"));
    expect(r.problems).toEqual([]);
    expect(r.doc?.nodes[0].attrs.color).toBe("danger");
  });

  test("a common colour word is a hint with the palette name it means", () => {
    const text = lines(FLOW, "Retry [color: red]");
    const r = parseFlow(text);
    expect(r.doc).not.toBeNull();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ severity: "hint", message: "red is not a Contura colour. Use danger: colours are named by what they mean." });
    expect(r.problems[0].fixes.map((f) => f.title)).toEqual(["Use danger"]);
    expect(apply(text, r.problems[0].fixes[0].edits)).toContain("Retry [color: danger]");
  });

  test("any other value lists the six", () => {
    const r = parseFlow(lines(FLOW, "Retry [color: #ff0000]"));
    expect(r.problems[0].message).toBe("#ff0000 is not a Contura colour. Use accent, info, success, warning, danger or muted.");
    expect(r.problems[0].fixes.map((f) => f.title)).toEqual(PALETTE.map((c) => `Use ${c}`));
  });

  test("groups take a colour beside their icon, but no label", () => {
    const doc = ok(lines(FLOW, "Dispatch [color: muted] {", "  Ship", "}"));
    expect(doc.groups[0]).toEqual({ name: "Dispatch", color: "muted", nodes: ["Ship"], groups: [] });
    const cloud = ok(lines('diagram cloud "C"', "VPC [icon: aws-vpc, color: info] {", "  API", "}"));
    expect(cloud.groups[0]).toMatchObject({ icon: "aws-vpc", color: "info" });
    expect(errors(lines(FLOW, "Dispatch [label: D] {", "}"))[0].message).toBe(MESSAGES.groupAttrs);
  });
});

describe("a line's attributes", () => {
  test("come after the label", () => {
    const doc = ok(lines(FLOW, "Paid?", "Retry", "Paid? > Retry: no [color: warning]"));
    expect(doc.links[0]).toEqual({ from: "Paid?", to: "Retry", arrow: ">", label: "no", color: "warning" });
  });

  test("or straight after the end with no label", () => {
    const doc = ok(lines(FLOW, "A", "B", "A > B [color: success]"));
    expect(doc.links[0]).toEqual({ from: "A", to: "B", arrow: ">", color: "success" });
  });

  test("after a quoted label", () => {
    const doc = ok(lines(FLOW, "A", "B", 'A > B: "x, y" [color: info]'));
    expect(doc.links[0]).toMatchObject({ label: "x, y", color: "info" });
  });

  test("a trailing [..] with a key that is no attribute stays label text", () => {
    expect(ok(lines(FLOW, "A", "B", "A > B: see [note 1]")).links[0]).toEqual({ from: "A", to: "B", arrow: ">", label: "see [note 1]" });
    expect(ok(lines(FLOW, "A", "B", "A > B: retry [x: 2]")).links[0].label).toBe("retry [x: 2]");
    expect(ok(lines(FLOW, "A", "B", "A > B: [1, 2]")).links[0].label).toBe("[1, 2]");
  });

  test("in a chain the colour is the last link's", () => {
    const doc = ok(lines(FLOW, "A", "B", "C", "A > B > C [color: danger]"));
    expect(doc.links[0].color).toBeUndefined();
    expect(doc.links[1].color).toBe("danger");
  });

  test("a line takes only a colour", () => {
    const text = lines(FLOW, "A", "B", "A > B: go [color: info, id: 3]");
    const [p] = errors(text);
    expect(p.message).toBe(MESSAGES.lineAttrs);
    expect(ok(apply(text, p.fixes[0].edits)).links[0]).toMatchObject({ label: "go", color: "info" });
  });

  test("a sequence message takes no colour", () => {
    const [p] = errors(lines('diagram sequence "S"', "A -> B: hi [color: info]"));
    expect(p.message).toBe("A sequence diagram's lines take no colour.");
  });

  test("an off-palette line colour is a hint", () => {
    const r = parseFlow(lines(FLOW, "A", "B", "A > B [color: green]"));
    expect(r.problems.map((p) => p.message)).toEqual(["green is not a Contura colour. Use success: colours are named by what they mean."]);
  });

  test("the span of a line with attributes covers them", () => {
    const text = lines(FLOW, "A", "B", "A > B: no [color: warning]");
    const r = parseFlow(text);
    const sp = r.span("link:0")!;
    expect(text.slice(sp.line!.from, sp.line!.to)).toBe("A > B: no [color: warning]");
    expect(text.slice(sp.attrs!.from, sp.attrs!.to)).toBe("[color: warning]");
    expect(text.slice(sp.label!.from, sp.label!.to)).toBe("no");
  });
});

describe("the writer", () => {
  test("writes labels, colours, group colours and line colours that read back", () => {
    const text = lines(
      FLOW,
      "",
      'Retry 2 [step, label: "Yes, retry", color: danger]',
      "",
      "Dispatch [color: muted] {",
      "  Ship [step]",
      "}",
      "",
      "Ship > Retry 2: no [color: warning]",
      "Retry 2 > Ship",
    );
    const doc = ok(text);
    expect(writeFlow(doc)).toBe(text);
  });

  test("puts the attributes in the order id, icon, label, color, table", () => {
    const text = writeFlow({ kind: "dfd", title: "D", comments: [], nodes: [{ name: "Orders 2", kind: "store", attrs: { table: "shop.orders", color: "info", label: "Orders", id: "D1" } }], links: [], groups: [] });
    expect(text).toContain("Orders 2 [store, id: D1, label: Orders, color: info, table: shop.orders]");
  });

  test("a coloured line is never chained", () => {
    const text = writeFlow({
      kind: "flow",
      title: "F",
      comments: [],
      nodes: ["A", "B", "C"].map((name) => ({ name, kind: "step", attrs: {} })),
      links: [
        { from: "A", to: "B", arrow: ">" },
        { from: "B", to: "C", arrow: ">", chained: true, color: "info" },
      ],
      groups: [],
    });
    expect(text).toContain("A > B\nB > C [color: info]");
  });

  test("a mind map topic keeps its attributes", () => {
    const doc = ok(lines('diagram mindmap "M"', "root Plan", "  Retry", "  Retry 2 [label: Retry, color: danger]"));
    expect(nodeStatement("mindmap", doc.nodes[2])).toBe("  Retry 2 [label: Retry, color: danger]");
    expect(nodeStatement("mindmap", doc.nodes[1])).toBe("  Retry");
  });
});

describe("the edits", () => {
  const run = (text: string, op: Parameters<typeof applyFlowEdit>[2]) => apply(text, applyFlowEdit(text, parseFlow(text), op).edits);

  test("setAttr puts a new key in its place in the order", () => {
    const text = lines('diagram dfd "D"', "Orders [store, id: D1, table: shop.orders]");
    expect(apply(text, setAttr(text, parseFlow(text), "Orders", "color", "info"))).toContain("Orders [store, id: D1, color: info, table: shop.orders]");
    expect(apply(text, setAttr(text, parseFlow(text), "Orders", "label", "Orders, old"))).toContain('Orders [store, id: D1, label: "Orders, old", table: shop.orders]');
  });

  test("setAttr colours and clears a group", () => {
    const text = lines(FLOW, "Dispatch {", "  Ship", "}");
    const coloured = run(text, { op: "setAttr", name: "Dispatch", key: "color", value: "muted" });
    expect(coloured).toContain("Dispatch [color: muted] {");
    expect(run(coloured, { op: "setAttr", name: "Dispatch", key: "color", value: null })).toBe(text);
  });

  test("setLinkColor colours, recolours and clears a line by its ref", () => {
    const text = lines(FLOW, "Paid?", "Retry", "Paid? > Retry: no");
    const link = { from: "Paid?", to: "Retry", label: "no", nth: 0 };
    const a = run(text, { op: "setLinkColor", link, color: "warning" });
    expect(a).toContain("Paid? > Retry: no [color: warning]");
    const b = run(a, { op: "setLinkColor", link, color: "danger" });
    expect(b).toContain("Paid? > Retry: no [color: danger]");
    expect(run(b, { op: "setLinkColor", link, color: null })).toBe(text);
    const bare = lines(FLOW, "A", "B", "A > B");
    expect(run(bare, { op: "setLinkColor", link: { from: "A", to: "B", label: null, nth: 0 }, color: "info" })).toContain("A > B [color: info]");
  });

  test("setLinkColor splits a chain so only that link is coloured", () => {
    const text = lines(FLOW, "A", "B", "C", "A > B > C");
    const out = run(text, { op: "setLinkColor", link: { from: "A", to: "B", label: null, nth: 0 }, color: "info" });
    const doc = ok(out);
    expect(doc.links.map((l) => l.color)).toEqual(["info", undefined]);
  });

  test("a label added to a coloured line goes before its attributes", () => {
    const text = lines(FLOW, "A", "B", "A > B [color: info]");
    const out = run(text, { op: "setLinkLabel", index: 0, label: "go" });
    expect(out).toContain("A > B: go [color: info]");
    expect(run(out, { op: "setLinkLabel", index: 0, label: null })).toBe(text);
  });

  test("reversing a coloured line in a chain keeps its colour", () => {
    const text = lines(FLOW, "A", "B", "C", "A > B > C [color: danger]");
    const out = run(text, { op: "reverseLink", link: { from: "A", to: "B", label: null, nth: 0 } });
    const doc = ok(out);
    expect(doc.links.find((l) => l.from === "C" || l.to === "C")?.color).toBe("danger");
  });

  test("a rename and a label change are one batch", () => {
    const text = lines(FLOW, "Retry", "Retry 2 [label: Retry]", "Retry 2 > Retry");
    const r = applyFlowBatch(text, parseFlow(text), [
      { op: "renameNode", old: "Retry 2", next: "Again" },
      { op: "setAttr", name: "Again", key: "label", value: null },
    ]);
    expect(apply(text, r.edits)).toBe(lines(FLOW, "Retry", "Again", "Again > Retry"));
  });
});
