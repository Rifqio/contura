// Fan-out: commas separate the names at either end of an arrow, so one line makes several links.
import { expect, test } from "vitest";
import { copyLines, pasteLines } from "./clip";
import type { TextEdit } from "../protocol";
import { applyFlowEdit, type FlowEditOp, removeLinks } from "./edits";
import { flowName } from "./model";
import { parseFlow } from "./parse";
import { MESSAGES } from "./problems";
import { applyEdits } from "./service";

const links = (t: string) => parseFlow(`diagram flow "x"\n${t}\n`).links.map((l) => [l.from, l.arrow, l.to, l.label ?? null, l.color ?? null]);
const errors = (t: string) => parseFlow(t).problems.filter((p) => p.severity === "error").map((p) => p.message);

test("fan_out_and_fan_in", () => {
  expect(links("A > B, C")).toEqual([["A", ">", "B", null, null], ["A", ">", "C", null, null]]);
  expect(links("A, B > C: done [color: info]")).toEqual([["A", ">", "C", "done", "info"], ["B", ">", "C", "done", "info"]]);
  expect(links("A > B, C > D")).toEqual([["A", ">", "B", null, null], ["A", ">", "C", null, null], ["B", ">", "D", null, null], ["C", ">", "D", null, null]]);
});

test("each_end_has_its_own_span", () => {
  const t = 'diagram flow "x"\nA, B > C, D: go [color: info]\n';
  const p = parseFlow(t);
  const slice = (r: { from: number; to: number } | undefined) => (r ? t.slice(r.from, r.to) : null);
  expect(p.links.map((_, i) => [slice(p.span(`link:${i}`)?.fromName), slice(p.span(`link:${i}`)?.toName)])).toEqual([["A", "C"], ["A", "D"], ["B", "C"], ["B", "D"]]);
  expect(slice(p.span("link:1")?.toName)).toBe("D");
  const line = p.span("link:0")?.line;
  expect(slice(line)).toBe("A, B > C, D: go [color: info]");
  for (let i = 0; i < 4; i++) {
    expect(p.span(`link:${i}`)?.line).toEqual(line);
    expect(slice(p.span(`link:${i}`)?.label)).toBe("go");
    expect(slice(p.span(`link:${i}`)?.attrs)).toBe("[color: info]");
  }
  expect(p.links.some((l) => l.chained)).toBe(false);
});

test("a_fan_link_is_never_chained", () => {
  const p = parseFlow('diagram flow "x"\nA\nB\nC\nD\nA > B > C, D\n');
  expect(p.links.map((l) => !!l.chained)).toEqual([false, false, false]);
});

test("a_quoted_name_with_a_comma_is_one_end", () => {
  expect(links('"Pay, ship" > Done')).toEqual([["Pay, ship", ">", "Done", null, null]]);
});

test("a_node_line_keeps_its_comma_name", () => {
  expect(parseFlow('diagram flow "x"\nPay, ship [step]\n').doc!.nodes[0].name).toBe("Pay, ship");
});

test("an_old_comma_name_gets_a_quote_fix", () => {
  const t = 'diagram flow "x"\nPay, ship [step]\nDone\nPay, ship > Done\n';
  const p = parseFlow(t).problems.find((x) => x.message === "Pay is not defined.")!;
  expect(p.fixes[0].title).toBe('Use "Pay, ship"');
  expect(parseFlow(applyEdits(t, p.fixes[0].edits)).problems).toEqual([]);
});

test("a_trailing_comma_needs_a_name", () => {
  expect(errors('diagram flow "x"\nA\nB\nA > B,\n')).toEqual([MESSAGES.listName]);
});

test("a_fan_over_100_links_is_refused", () => {
  const names = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const defs = [...names(11, "A"), ...names(10, "B")].join("\n");
  const t = `diagram flow "x"\n${defs}\n${names(11, "A").join(", ")} > ${names(10, "B").join(", ")}\n`;
  const p = parseFlow(t);
  expect(errors(t)).toEqual([MESSAGES.fanTooBig]);
  expect(p.links).toEqual([]);
  // Exactly 100 is allowed.
  expect(parseFlow(`diagram flow "x"\n${defs}\n${names(10, "A").join(", ")} > ${names(10, "B").join(", ")}\n`).links).toHaveLength(100);
});

test("a_sequence_message_goes_to_one_participant", () => {
  expect(errors('diagram sequence "x"\nA -> B, C\n')).toEqual([MESSAGES.oneParticipant]);
});

test("names_with_commas_are_written_quoted", () => {
  expect(flowName("Pay, ship")).toBe('"Pay, ship"');
});

test("a_leading_comma_needs_a_name_before_it", () => {
  const t = 'diagram flow "x"\nA\nB\n, A > B\n';
  const p = parseFlow(t);
  expect(errors(t)).toEqual([MESSAGES.listNameBefore]);
  const e = p.problems.find((x) => x.message === MESSAGES.listNameBefore)!;
  expect(t.slice(e.from, e.to)).toBe(",");
  expect(p.links).toEqual([]);
});

test("a_double_comma_needs_a_name_at_the_first_comma", () => {
  const t = 'diagram flow "x"\nA\nB\nC\nA,, B > C\n';
  const p = parseFlow(t);
  expect(errors(t)).toEqual([MESSAGES.listName]);
  const e = p.problems.find((x) => x.message === MESSAGES.listName)!;
  expect(e.from).toBe(t.indexOf(","));
  expect(e.to).toBe(t.indexOf(",") + 1);
  expect(p.links).toEqual([]);
});

test("a_dangling_comma_before_an_arrow_needs_a_name", () => {
  const t = 'diagram flow "x"\nA\nB\nA, > B\n';
  const p = parseFlow(t);
  expect(errors(t)).toEqual([MESSAGES.listName]);
  const e = p.problems.find((x) => x.message === MESSAGES.listName)!;
  expect(t.slice(e.from, e.to)).toBe(",");
  expect(p.links).toEqual([]);
});

test("the_label_goes_on_the_last_segment_only", () => {
  expect(links("A > B, C > D: x")).toEqual([["A", ">", "B", null, null], ["A", ">", "C", null, null], ["B", ">", "D", "x", null], ["C", ">", "D", "x", null]]);
});

test("the_one_participant_error_offers_no_fix", () => {
  const p = parseFlow('diagram sequence "x"\nA -> B, C\n').problems.find((x) => x.message === MESSAGES.oneParticipant)!;
  expect(p.fixes).toEqual([]);
});

// ----- canvas edits on a fan line change only the link they target

const flowText = (...body: string[]) => `${['diagram flow "x"', ...body].join("\n")}\n`;
const NODES = ["A", "B", "C", "D"];
const ref = (from: string, to: string, label: string | null = null) => ({ from, to, label, nth: 0 });
function edit(text: string, op: FlowEditOp): string {
  const r = applyFlowEdit(text, parseFlow(text), op);
  expect(r.edits.length).toBeGreaterThan(0);
  const out = applyEdits(text, r.edits);
  expect(errors(out)).toEqual([]);
  return out;
}
const linkIndex = (text: string, from: string, to: string) => parseFlow(text).links.findIndex((l) => l.from === from && l.to === to);

test("delete_one_fan_link", () => {
  const t = flowText(...NODES, "A > B, C");
  expect(edit(t, { op: "deleteLink", index: linkIndex(t, "A", "C") })).toBe(flowText(...NODES, "A > B"));
  expect(edit(t, { op: "deleteLink", index: linkIndex(t, "A", "B") })).toBe(flowText(...NODES, "A > C"));
});

test("delete_first_middle_and_last_of_a_list", () => {
  const t = flowText(...NODES, "A > B, C, D: go [color: info] // keep");
  const del = (to: string) => edit(t, { op: "deleteLink", index: linkIndex(t, "A", to) });
  expect(del("B")).toBe(flowText(...NODES, "A > C, D: go [color: info] // keep"));
  expect(del("C")).toBe(flowText(...NODES, "A > B, D: go [color: info] // keep"));
  expect(del("D")).toBe(flowText(...NODES, "A > B, C: go [color: info] // keep"));
  const fanIn = flowText(...NODES, "A,B ,  C > D");
  expect(edit(fanIn, { op: "deleteLink", index: linkIndex(fanIn, "B", "D") })).toBe(flowText(...NODES, "A ,  C > D"));
});

test("delete_a_node_in_a_fan", () => {
  const t = flowText("A", "B", "C", "A > B, C");
  expect(edit(t, { op: "deleteNode", name: "C" })).toBe(flowText("A", "B", "A > B"));
  expect(edit(t, { op: "deleteNode", name: "A" })).toBe(flowText("B", "C"));
});

test("rename_into_a_fan", () => {
  const t = flowText("A", "B", "C", "A > B, C");
  expect(edit(t, { op: "renameNode", old: "C", next: "C, D" })).toBe(flowText("A", "B", '"C, D"', 'A > B, "C, D"'));
});

test("label_one_fan_link", () => {
  const t = flowText(...NODES, "A > B, C");
  expect(edit(t, { op: "setLinkLabel", index: -1, label: "yes", link: ref("A", "C") })).toBe(flowText(...NODES, "A > B", "A > C: yes"));
  const labelled = flowText(...NODES, "A > B, C: go");
  expect(edit(labelled, { op: "setLinkLabel", index: -1, label: null, link: ref("A", "C", "go") })).toBe(flowText(...NODES, "A > B: go", "A > C"));
});

test("colour_one_fan_link", () => {
  const t = flowText(...NODES, "A > B, C");
  expect(edit(t, { op: "setLinkColor", link: ref("A", "C"), color: "info" })).toBe(flowText(...NODES, "A > B", "A > C [color: info]"));
  // A labelled fan's link keeps its label when it is coloured on its own.
  const labelled = flowText(...NODES, "A > B, C: yes");
  expect(edit(labelled, { op: "setLinkColor", link: ref("A", "C", "yes"), color: "info" })).toBe(flowText(...NODES, "A > B: yes", "A > C: yes [color: info]"));
  const coloured = flowText(...NODES, "A > B, C: go [color: info]");
  expect(edit(coloured, { op: "setLinkColor", link: ref("A", "B", "go"), color: null })).toBe(flowText(...NODES, "A > C: go [color: info]", "A > B: go"));
});

test("reverse_one_fan_link", () => {
  const t = flowText(...NODES, "A > B, C");
  expect(edit(t, { op: "reverseLink", link: ref("A", "C") })).toBe(flowText(...NODES, "A > B", "C > A"));
});

test("drop_from_a_two_arrow_fan", () => {
  const t = flowText(...NODES, "A, B > C, D");
  expect(edit(t, { op: "deleteLink", index: linkIndex(t, "A", "D") })).toBe(flowText(...NODES, "A > C", "B > C", "B > D"));
  const twoArrows = flowText(...NODES, "A > B, C > D");
  expect(edit(twoArrows, { op: "deleteLink", index: linkIndex(twoArrows, "C", "D") })).toBe(flowText(...NODES, "A > B", "A > C", "B > D"));
});

test("a_fan_in_a_group_with_crlf_keeps_its_indent_and_line_breaks", () => {
  const t = flowText("G {", ...NODES.map((n) => `  ${n}`), "  A > B, C", "}").replace(/\n/g, "\r\n");
  expect(edit(t, { op: "reverseLink", link: ref("A", "C") })).toBe(flowText("G {", ...NODES.map((n) => `  ${n}`), "  A > B", "  C > A", "}").replace(/\n/g, "\r\n"));
  expect(edit(t, { op: "deleteLink", index: linkIndex(t, "A", "B") })).toBe(flowText("G {", ...NODES.map((n) => `  ${n}`), "  A > C", "}").replace(/\n/g, "\r\n"));
});

test("a_fan_on_the_last_line_without_a_break_splits_cleanly", () => {
  const t = flowText(...NODES, "A > B, C").slice(0, -1);
  expect(edit(t, { op: "setLinkLabel", index: -1, label: "yes", link: ref("A", "B") })).toBe(flowText(...NODES, "A > C", "A > B: yes").slice(0, -1));
});

test("an_arrow_change_on_a_fan_link_splits_it_off", () => {
  const t = flowText(...NODES, "A > B, C");
  expect(edit(t, { op: "setLinkArrow", link: ref("A", "C"), arrow: "-->" })).toBe(flowText(...NODES, "A > B", "A --> C"));
});

test("each_fan_op_is_one_change", () => {
  const t = flowText(...NODES, "A, B > C, D");
  const ops: FlowEditOp[] = [
    { op: "reverseLink", link: ref("A", "D") },
    { op: "setLinkLabel", index: -1, label: "yes", link: ref("A", "D") },
    { op: "setLinkColor", link: ref("A", "D"), color: "info" },
    { op: "setLinkArrow", link: ref("A", "D"), arrow: "-->" },
    { op: "deleteLink", index: linkIndex(t, "A", "D") },
  ];
  for (const op of ops) expect(applyFlowEdit(t, parseFlow(t), op).edits, op.op).toHaveLength(1);
});

test("a_link_split_from_a_two_arrow_fan_keeps_its_place", () => {
  const t = flowText(...NODES, "A > B, C > D: x");
  expect(edit(t, { op: "setLinkColor", link: ref("A", "B"), color: "info" })).toBe(flowText(...NODES, "A > B [color: info]", "A > C", "B > D: x", "C > D: x"));
  expect(edit(t, { op: "reverseLink", link: ref("C", "D", "x") })).toBe(flowText(...NODES, "A > B", "A > C", "B > D: x", "D > C: x"));
});

test("copy_a_fan_pastes_one_line_per_link", () => {
  const t = flowText("A", "B", "C", "A > B, C");
  const clip = copyLines(parseFlow(t).doc!, ["A", "B", "C"]);
  const r = pasteLines(t, parseFlow(t), clip);
  const out = applyEdits(t, r.edits);
  expect(errors(out)).toEqual([]);
  expect(out).toBe(flowText("A", "B", "C", "A 2", "B 2", "C 2", "A > B, C", "A 2 > B 2", "A 2 > C 2"));
});

test("names_dropped_from_both_lists_come_out_in_place", () => {
  const t = flowText(...NODES, "A, B > C, D");
  const edits: TextEdit[] = [];
  removeLinks(t, parseFlow(t), (l) => l.from === "A" || l.to === "D", edits, "\n");
  expect(edits).toHaveLength(1);
  expect(applyEdits(t, edits)).toBe(flowText(...NODES, "B > C"));
});

test("an_undefined_name_in_a_fan_is_reported_once", () => {
  const t = 'diagram flow "x"\nCart > Pay, Mail -- Audit\n';
  const p = parseFlow(t).problems;
  expect(p.map((x) => x.message)).toEqual(["Cart", "Pay", "Mail", "Audit"].map(MESSAGES.notDefined));
  expect(p.map((x) => t.slice(x.from, x.to))).toEqual(["Cart", "Pay", "Mail", "Audit"]);
  expect(p[0].fixes.map((f) => f.title)).toEqual(["Add Cart as a step"]);
  // A single link still reports each end, a loop's two ends included.
  expect(errors('diagram flow "x"\nA > B\n')).toEqual([MESSAGES.notDefined("A"), MESSAGES.notDefined("B")]);
  expect(errors('diagram flow "x"\nA > A\n')).toEqual([MESSAGES.notDefined("A"), MESSAGES.notDefined("A")]);
});

test("a_decision_fanning_out_without_labels_gets_one_hint", () => {
  const p = parseFlow('diagram flow "x"\nD [decision]\nA [step]\nB [step]\nD > A, B\n').problems;
  expect(p.map((x) => x.message)).toEqual([MESSAGES.decisionLabels]);
});
