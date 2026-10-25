import { describe, expect, test } from "vitest";
import type { DiagramOp, FlowOutline, ProposedChange } from "../../api/types";
import { flowOutline } from "../../lang/flow/outline";
import { parseFlow } from "../../lang/flow/parse";
import { changeEditOp, changeLine, changeMark, landedSummary, planLanding, removalCount, withDependents, wouldBreak } from "./proposal";

const FIXTURES = import.meta.glob("../../lang/flow/fixtures/*.flow", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const fixture = (name: string) => FIXTURES[`../../lang/flow/fixtures/${name}`];
const ORDER = fixture("order-flow.flow");

const ok = (index: number, op: DiagramOp, dependsOn: number[] = []): ProposedChange => ({ index, op, status: { kind: "ok" }, dependsOn });
const all = (changes: ProposedChange[]) => new Set(changes.map((c) => c.index));

const ADD_CUSTOMS: DiagramOp = { add_node: { name: "Customs check", kind: "io", id: "2.1", group: "Kitchen" } };

describe("changeEditOp", () => {
  test("edit_op_per_change", () => {
    const parse = parseFlow(ORDER);
    const op = (o: DiagramOp) => changeEditOp(ok(0, o), parse, "flow");
    expect(op(ADD_CUSTOMS)).toEqual({ op: "addNode", name: "Customs check", kind: "io", attrs: { id: "2.1" }, group: "Kitchen" });
    expect(op({ add_node: { name: "Audit" } })).toEqual({ op: "addNode", name: "Audit", kind: null, attrs: {}, group: null });
    expect(op({ remove_node: { target: "Cook" } })).toEqual({ op: "deleteNode", name: "Cook" });
    expect(op({ rename_node: { target: "Cook", name: "Fry" } })).toEqual({ op: "renameNode", old: "Cook", next: "Fry" });
    expect(op({ add_flow: { from: "Cook", to: "Handed over", label: "done" } })).toEqual({ op: "addLink", from: "Cook", to: "Handed over", arrow: ">", label: "done" });
    expect(op({ add_flow: { from: "Cook", to: "Handed over" } })).toEqual({ op: "addLink", from: "Cook", to: "Handed over", arrow: ">", label: undefined });
    // The index is the link in this parse, found by its ends and label.
    expect(op({ remove_flow: { from: "Paid?", to: "Cook", label: "yes" } })).toEqual({ op: "deleteLink", index: 1 });
    expect(op({ remove_flow: { from: "Pack order", to: "Label bag" } })).toEqual({ op: "deleteLink", index: 5 });
    expect(op({ remove_flow: { from: "Paid?", to: "Cook", label: "no" } })).toBeNull();
    expect(op({ relabel_flow: { from: "Paid?", to: "Ask for payment", label: "declined" } })).toEqual({ op: "setLinkLabel", index: 2, label: "declined" });
    expect(op({ relabel_flow: { from: "Cook", to: "Handed over", label: "x" } })).toBeNull();
    expect(op({ move_to_group: { target: "Label bag", group: "Kitchen" } })).toEqual({ op: "moveToGroup", name: "Label bag", group: "Kitchen" });
    expect(op({ move_to_group: { target: "Label bag", group: null } })).toEqual({ op: "moveToGroup", name: "Label bag", group: null });
    // A change that is not Ok has no op.
    expect(changeEditOp({ index: 0, op: ADD_CUSTOMS, status: { kind: "dropped", reason: "unknownGroup", message: "x" }, dependsOn: [] }, parse, "flow")).toBeNull();
  });

  test("the_line_arrow_follows_the_diagram", () => {
    const cls = parseFlow('diagram class "x"\nclass A\nclass B\n');
    expect(changeEditOp(ok(0, { add_flow: { from: "A", to: "B" } }), cls, "class")).toMatchObject({ arrow: "-->" });
    expect(changeLine(ok(0, { add_flow: { from: "A", to: "B" } }), "class")).toBe("A --> B");
  });
});

describe("changeLine and changeMark", () => {
  test("change_lines_as_the_board_lists_them", () => {
    const line = (o: DiagramOp) => changeLine(ok(0, o), "flow");
    expect(line({ add_node: { name: "Customs check", kind: "process", id: "2.1" } })).toBe("Customs check [process, id: 2.1]");
    expect(line({ add_node: { name: "Audit" } })).toBe("Audit");
    expect(line({ add_flow: { from: "Pick and pack", to: "Customs check", label: "overseas orders" } })).toBe("Pick and pack > Customs check: overseas orders");
    expect(line({ remove_flow: { from: "Pick and pack", to: "Warehouse", label: "pick list" } })).toBe("Pick and pack > Warehouse: pick list");
    expect(line({ remove_flow: { from: "A", to: "B" } })).toBe("A > B");
    expect(line({ relabel_flow: { from: "A", to: "B", label: "new" } })).toBe("A > B: new");
    expect(line({ remove_node: { target: "Cook" } })).toBe("Cook");
    expect(line({ rename_node: { target: "Cook", name: "Fry cook" } })).toBe("Fry cook");
    expect(line({ move_to_group: { target: "Cook", group: "Kitchen" } })).toBe("Cook");
    // Names that need quotes are written as the file would write them, labels too.
    expect(line({ add_flow: { from: "a > b", to: "C", label: 'say "hi"' } })).toBe('"a > b" > C: "say \\"hi\\""');
  });

  test("marks", () => {
    const mark = (o: DiagramOp) => changeMark(ok(0, o));
    expect(mark(ADD_CUSTOMS)).toBe("+");
    expect(mark({ add_flow: { from: "A", to: "B" } })).toBe("+");
    expect(mark({ remove_node: { target: "A" } })).toBe("-");
    expect(mark({ remove_flow: { from: "A", to: "B" } })).toBe("-");
    expect(mark({ rename_node: { target: "A", name: "B" } })).toBe("~");
    expect(mark({ relabel_flow: { from: "A", to: "B", label: "x" } })).toBe("~");
    expect(mark({ move_to_group: { target: "A", group: null } })).toBe("~");
    expect(changeMark({ index: 0, op: ADD_CUSTOMS, status: { kind: "dropped", reason: "nameTaken", message: "x" }, dependsOn: [] })).toBe("!");
  });
});

describe("planLanding", () => {
  test("reserved_names_write_quoted_one_line", () => {
    const parse = parseFlow(ORDER);
    const plan = planLanding(ORDER, parse, [ok(0, { add_node: { name: "Customs > check [x]" } })], new Set([0]), "flow");
    expect(plan).not.toBeNull();
    const after = plan?.text ?? "";
    const before = ORDER.split("\n");
    const out = after.split("\n");
    // One new line, quoted; every other line is there byte for byte and in order.
    expect(out).toHaveLength(before.length + 1);
    expect(out.filter((l) => !before.includes(l))).toEqual(['"Customs > check [x]"']);
    expect(out.filter((l) => before.includes(l))).toEqual(before);
    const reparsed = parseFlow(after);
    expect(reparsed.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(reparsed.doc?.nodes.map((n) => n.name)).toContain("Customs > check [x]");
    // Other awkward names and labels stay on one line each.
    for (const name of ["a // b", 'say "hi"', "back\\slash", "x -- y", "  padded  ".trim() + " -", "} brace {"]) {
      const p = planLanding(ORDER, parse, [ok(0, { add_node: { name } })], new Set([0]), "flow");
      expect(p?.text.split("\n")).toHaveLength(before.length + 1);
      expect(parseFlow(p?.text ?? "").doc?.nodes.map((n) => n.name)).toContain(name);
    }
  });

  test("landing_is_one_edit", () => {
    const changes = [
      ok(0, ADD_CUSTOMS),
      ok(1, { add_flow: { from: "Cook", to: "Customs check", label: "overseas" } }, [0]),
      ok(2, { add_flow: { from: "Customs check", to: "Handed over", label: "cleared" } }, [0]),
      ok(3, { remove_flow: { from: "Paid?", to: "Cook", label: "yes" } }),
    ];
    const plan = planLanding(ORDER, parseFlow(ORDER), changes, all(changes), "flow");
    expect(plan?.edits).toHaveLength(1);
    const { from, to, insert } = plan?.edits[0] ?? { from: 0, to: 0, insert: "" };
    expect(ORDER.slice(0, from) + insert + ORDER.slice(to)).toBe(plan?.text);
    const doc = parseFlow(plan?.text ?? "").doc;
    expect(doc?.nodes.map((n) => n.name)).toContain("Customs check");
    expect(doc?.links.map((l) => `${l.from}>${l.to}`)).toEqual(expect.arrayContaining(["Cook>Customs check", "Customs check>Handed over"]));
    expect(doc?.links.find((l) => l.from === "Paid?" && l.to === "Cook")).toBeUndefined();
  });

  test("link_indexes_follow_earlier_changes", () => {
    // Deleting the first link moves every index; the second change still finds its own link.
    const changes = [ok(0, { remove_flow: { from: "Order placed", to: "Paid?" } }), ok(1, { relabel_flow: { from: "Paid?", to: "Ask for payment", label: "declined" } })];
    const plan = planLanding(ORDER, parseFlow(ORDER), changes, all(changes), "flow");
    expect(plan?.text).toContain("Paid? > Ask for payment: declined");
    expect(plan?.text).not.toContain("Order placed > Paid?");
  });

  test("only_the_accepted_changes_land_and_a_miss_gives_null", () => {
    const changes = [ok(0, ADD_CUSTOMS), ok(1, { remove_node: { target: "Cook" } })];
    const parse = parseFlow(ORDER);
    const one = planLanding(ORDER, parse, changes, new Set([1]), "flow");
    expect(one?.text).not.toContain("Customs check");
    expect(one?.text).not.toContain("Cook [step");
    expect(planLanding(ORDER, parse, changes, new Set(), "flow")).toBeNull();
    // A name that is taken, an unknown group and a change that is not Ok do not apply.
    expect(planLanding(ORDER, parse, [ok(0, { add_node: { name: "Cook" } })], new Set([0]), "flow")).toBeNull();
    expect(planLanding(ORDER, parse, [ok(0, { add_node: { name: "X", group: "Nowhere" } })], new Set([0]), "flow")).toBeNull();
    const dropped: ProposedChange = { index: 0, op: ADD_CUSTOMS, status: { kind: "dropped", reason: "unknownGroup", message: "m" }, dependsOn: [] };
    expect(planLanding(ORDER, parse, [dropped], new Set([0]), "flow")).toBeNull();
  });

  test("crlf_text_keeps_its_line_breaks", () => {
    const crlf = ORDER.replace(/\n/g, "\r\n");
    const plan = planLanding(crlf, parseFlow(crlf), [ok(0, { add_node: { name: "Audit" } })], new Set([0]), "flow");
    expect(plan?.text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(plan?.text).toContain("Audit\r\n");
  });
});

describe("wouldBreak", () => {
  test("would_break_names_the_line", () => {
    const before = parseFlow(ORDER);
    // A cloud arrow in a flowchart is an error the before text did not have.
    const bad = ORDER.replace("Cook > Pack order > Label bag", "Cook ..> Pack order > Label bag");
    const found = wouldBreak(before, parseFlow(bad), bad);
    expect(found).not.toBeNull();
    expect(found?.line).toBe(21);
    expect(found?.lineText).toBe("Cook ..> Pack order > Label bag");
    expect(found?.message).toMatch(/\.\.>/);
    // A clean set gives null, and so does an error the before text already had.
    const clean = planLanding(ORDER, before, [ok(0, ADD_CUSTOMS)], new Set([0]), "flow");
    expect(wouldBreak(before, parseFlow(clean?.text ?? ""), clean?.text ?? "")).toBeNull();
    const withError = `${ORDER}Cook ..> Cook\n`;
    const pre = parseFlow(withError);
    const more = `${withError}\n// note\n`;
    expect(wouldBreak(pre, parseFlow(more), more)).toBeNull();
    // Hints and warnings are not breaks.
    expect(wouldBreak(before, parseFlow(`${ORDER}Floating\n`), `${ORDER}Floating\n`)).toBeNull();
  });
});

describe("withDependents", () => {
  test("dependents_follow", () => {
    const changes = [
      ok(0, ADD_CUSTOMS),
      ok(1, { add_flow: { from: "Cook", to: "Customs check" } }, [0]),
      ok(2, { relabel_flow: { from: "Cook", to: "Customs check", label: "x" } }, [1]),
      ok(3, { remove_node: { target: "Label bag" } }),
    ];
    expect([...withDependents(changes, 0)].sort()).toEqual([0, 1, 2]);
    expect([...withDependents(changes, 1)].sort()).toEqual([1, 2]);
    expect([...withDependents(changes, 2)]).toEqual([2]);
    expect([...withDependents(changes, 3)]).toEqual([3]);
  });
});

describe("landedSummary", () => {
  const add = (name: string) => ok(0, { add_node: { name } });
  const line = (a: string, b: string) => ok(0, { add_flow: { from: a, to: b } });
  const number = (cs: ProposedChange[]) => cs.map((c, index) => ({ ...c, index }));

  test("landed_summary_texts", () => {
    const board = number([add("Customs check"), line("A", "Customs check"), line("Customs check", "B"), ok(0, { remove_flow: { from: "A", to: "B" } })]);
    expect(landedSummary(board, all(board))).toBe(
      "Done. I added Customs check and 2 lines and removed 1 line, as one undo step. The new parts are ringed on the canvas for a moment.",
    );
    // Only what was accepted counts; one of each is singular.
    expect(landedSummary(board, new Set([0, 1]))).toBe("Done. I added Customs check and 1 line, as one undo step. The new parts are ringed on the canvas for a moment.");
    const many = number([add("A"), add("B"), add("C"), add("D"), add("E")]);
    expect(landedSummary(many, all(many))).toBe("Done. I added A, B, C and 2 more shapes, as one undo step. The new parts are ringed on the canvas for a moment.");
    const one = number([add("Solo")]);
    expect(landedSummary(one, all(one))).toBe("Done. I added Solo, as one undo step. The new parts are ringed on the canvas for a moment.");
    const edits = number([ok(0, { rename_node: { target: "A", name: "B" } }), ok(0, { rename_node: { target: "C", name: "D" } }), ok(0, { move_to_group: { target: "E", group: null } })]);
    expect(landedSummary(edits, all(edits))).toBe("Done. I renamed 2 shapes and moved 1 shape, as one undo step. The new parts are ringed on the canvas for a moment.");
    const gone = number([ok(0, { remove_node: { target: "A" } }), ok(0, { remove_node: { target: "B" } })]);
    expect(landedSummary(gone, all(gone))).toBe("Done. I removed A and B, as one undo step.");
    const relabel = number([ok(0, { relabel_flow: { from: "A", to: "B", label: "x" } })]);
    expect(landedSummary(relabel, all(relabel))).toBe("Done. I relabelled 1 line, as one undo step. The new parts are ringed on the canvas for a moment.");
    expect(landedSummary(board, new Set())).toBe("Done. Nothing changed.");
  });
});

describe("removalCount", () => {
  const outline: FlowOutline = flowOutline(parseFlow(fixture("checkout.flow")), null);

  test("removal_count_includes_attached_lines", () => {
    // Orders has a table and two lines (Checkout > Orders, Orders --> Checkout).
    const orders = [ok(0, { remove_node: { target: "Orders" } })];
    expect(removalCount(orders, all(orders), outline)).toEqual({ shapes: ["Orders"], lines: 2, tables: ["Orders"] });
    // A line removed directly, and one of the lines attached to a removed shape, count once.
    const both = [ok(0, { remove_node: { target: "Orders" } }), ok(1, { remove_flow: { from: "Checkout", to: "Orders" } }), ok(2, { remove_flow: { from: "Customer", to: "Checkout" } })];
    expect(removalCount(both, all(both), outline)).toEqual({ shapes: ["Orders"], lines: 3, tables: ["Orders"] });
    // A shape with no table, and a rejected removal that counts nothing.
    const card = [ok(0, { remove_node: { target: "Card network" } }), ok(1, { remove_node: { target: "Orders" } })];
    expect(removalCount(card, new Set([0]), outline)).toEqual({ shapes: ["Card network"], lines: 1, tables: [] });
    expect(removalCount(card, new Set(), outline)).toEqual({ shapes: [], lines: 0, tables: [] });
    // Adds and renames remove nothing.
    const adds = [ok(0, ADD_CUSTOMS)];
    expect(removalCount(adds, all(adds), outline)).toEqual({ shapes: [], lines: 0, tables: [] });
  });
});
