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

  test("groups take a colour beside their icon, but no label", () => {
    const doc = ok(lines(FLOW, "Dispatch [color: muted] {", "  Ship", "}"));
    expect(doc.groups[0]).toEqual({ name: "Dispatch", color: "muted", nodes: ["Ship"], groups: [] });
    const cloud = ok(lines('diagram cloud "C"', "VPC [icon: aws-vpc, color: info] {", "  API", "}"));
    expect(cloud.groups[0]).toMatchObject({ icon: "aws-vpc", color: "info" });
    expect(errors(lines(FLOW, "Dispatch [label: D] {", "}"))[0].message).toBe(MESSAGES.groupAttrs);
  });

  test("groups and lines take a CSS name or a hex too", () => {
    const doc = ok(lines(FLOW, "Dispatch [color: #3B82F6] {", "  Ship", "  Pack", "}", "Ship > Pack [color: teal]", 'Pack > Ship [color: "#fff8"]'));
    expect(doc.groups[0].color).toBe("#3B82F6");
    expect(doc.links.map((l) => l.color)).toEqual(["teal", "#fff8"]);
    // A value that is no colour is a hint on a group and on a line, as on a shape.
    for (const text of [lines(FLOW, "Dispatch [color: blurple] {", "  Ship", "}"), lines(FLOW, "A", "B", "A > B [color: #12345]")]) {
      expect(parseFlow(text).problems.map((p) => p.severity)).toEqual(["hint"]);
    }
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

  test("colour_values_at_the_edges", () => {
    const ok = ["red", "Teal", "rebeccapurple", "#FFF", "#ffffff80", '"#3B82F6"', "warning"];
    for (const v of ok) expect(parseFlow(`diagram flow "x"\nA [color: ${v}]\n`).problems, v).toEqual([]);
    for (const v of ["#12345", "transparent", "currentColor", '""', "blurple"]) {
      const ps = parseFlow(`diagram flow "x"\nA [color: ${v}]\n`).problems;
      expect(ps.map((p) => p.severity), v).toEqual(["hint"]);
    }
    expect(parseFlow('diagram flow "x"\nA [color: rgb(1, 2, 3)]\n').problems.length).toBeGreaterThan(0);
  });

  test("a_misspelt_colour_offers_the_name_then_the_presets", () => {
    const p = parseFlow('diagram flow "x"\nA [color: gren]\n').problems[0];
    expect(p.message).toBe("gren is not a colour. Did you mean green?");
    expect(p.fixes.map((f) => f.title)).toEqual(["Use green", "Use accent", "Use info", "Use success", "Use warning", "Use danger", "Use muted"]);
  });

  test("set_attr_writes_a_hex_quoted", () => {
    const run = (t: string, op: Parameters<typeof applyFlowEdit>[2]) => apply(t, applyFlowEdit(t, parseFlow(t), op).edits);
    const text = lines(FLOW, "A");
    const hex = run(text, { op: "setAttr", name: "A", key: "color", value: "#3B82F6" });
    expect(hex).toContain('A [color: "#3B82F6"]');
    expect(parseFlow(hex).problems).toEqual([]);
    expect(run(text, { op: "setAttr", name: "A", key: "color", value: "blurple" })).toBe(text);
    const linked = lines(FLOW, "A", "B", "A > B");
    expect(run(linked, { op: "setLinkColor", link: { from: "A", to: "B", label: null, nth: 0 }, color: "teal" })).toContain("A > B [color: teal]");
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

describe("participants take attributes", () => {
  const SEQ = 'diagram sequence "S"';

  test("participant_attributes", () => {
    const doc = ok(lines(SEQ, 'participant App [icon: aws-lambda, color: info, label: "Mobile app"]', "App -> API"));
    expect(doc.nodes[0]).toEqual({ name: "App", kind: "participant", attrs: { icon: "aws-lambda", color: "info", label: "Mobile app" } });
    expect(parseFlow(lines(SEQ, "participant App [color: info]", "actor Ann [label: Ann B]", "App -> Ann")).problems).toEqual([]);
    for (const bad of ["participant App [process]", "participant App [id: 2]", "participant App [table: t]"]) {
      const found = errors(lines(SEQ, bad, "App -> API"));
      expect(found).toHaveLength(1);
      expect(found[0].message).toBe(MESSAGES.participantAttrs);
    }
    expect(MESSAGES.participantAttrs).toBe("A participant takes an icon, a label and a colour, for example [icon: aws-lambda, color: info].");
  });

  test("participant_order", () => {
    const doc = ok(lines(SEQ, "A -> B", "participant C", "C -> A"));
    expect(doc.nodes.map((n) => n.name)).toEqual(["C", "A", "B"]);
  });

  test("set_attr_on_a_participant", () => {
    const text = lines(SEQ, "participant App", "App -> API");
    const out = apply(text, setAttr(text, parseFlow(text), "App", "color", "warning"));
    expect(out).toBe(lines(SEQ, "participant App [color: warning]", "App -> API"));
    expect(apply(out, setAttr(out, parseFlow(out), "App", "color", null))).toBe(text);
  });

  test("sequence_messages_still_take_no_colour", () => {
    const [p] = errors(lines(SEQ, "A -> B [color: info]"));
    expect(p.message).toBe(MESSAGES.noLineColour("sequence"));
  });

  test("a participant is written with its attributes", () => {
    expect(nodeStatement("sequence", { name: "App", kind: "participant", attrs: { color: "info", icon: "aws-lambda" } })).toBe("participant App [icon: aws-lambda, color: info]");
    expect(nodeStatement("sequence", { name: "App", kind: "actor", attrs: {} })).toBe("actor App");
  });
});

describe("participants with brackets", () => {
  const SEQ = 'diagram sequence "S"';
  const set = (text: string, key: "icon" | "label" | "color", value: string | null) => apply(text, setAttr(text, parseFlow(text), "App", key, value));

  test("setAttr inserts, replaces and removes inside the brackets", () => {
    const text = lines(SEQ, "participant App [icon: users, label: Mobile]", "App -> API");
    expect(set(text, "color", "info")).toBe(lines(SEQ, "participant App [icon: users, label: Mobile, color: info]", "App -> API"));
    expect(set(lines(SEQ, "participant App [color: info, label: Mobile]", "App -> API"), "icon", "users")).toBe(
      lines(SEQ, "participant App [icon: users, color: info, label: Mobile]", "App -> API"),
    );
    expect(set(text, "label", "Phone")).toBe(lines(SEQ, "participant App [icon: users, label: Phone]", "App -> API"));
    expect(set(text, "icon", null)).toBe(lines(SEQ, "participant App [label: Mobile]", "App -> API"));
  });

  test("a bad colour is the colour hint and an unknown icon the icon problem", () => {
    const colour = parseFlow(lines(SEQ, "participant App [color: nope]", "App -> API"));
    expect(colour.problems).toHaveLength(1);
    expect(colour.problems[0].severity).toBe("hint");
    expect(colour.problems[0].message).toMatch(/is not a colour/);
    const icon = parseFlow(lines(SEQ, "participant App [icon: aws-lamda]", "App -> API"), { icons: new Set(["aws-lambda", "users"]) });
    expect(icon.problems.map((p) => p.message)).toEqual([MESSAGES.notAnIcon("aws-lamda", "aws-lambda")]);
  });

  test("an unclosed bracket still checks the rest of the line", () => {
    const found = parseFlow(lines(SEQ, "participant App [color: info", "App -> API")).problems.filter((p) => p.severity === "error");
    expect(found.map((p) => p.message)).toEqual([MESSAGES.openList]);
  });
});
