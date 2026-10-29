import { describe, expect, test, vi } from "vitest";
import type { DiagramOp, FlowOutline, ProposedChange } from "../../api/types";
import { frameHeaders, parseBoard, splitFrames } from "../../lang/flow/board";
import { MAX_BOARD_FRAMES, MAX_BOARD_SHAPES } from "../../lang/flow/model";
import { flowOutline } from "../../lang/flow/outline";
import { parseFlow } from "../../lang/flow/parse";
import { MESSAGES } from "../../lang/flow/problems";
import { ER_NOTES } from "../../lang/flow/edits";
import { applyEdits } from "../../lang/flow/service";
import {
  type BoardPlan,
  boardRemovalCount,
  boardWouldBreak,
  changeEditOp,
  changeLine,
  changeMark,
  fixQuestion,
  isRefusal,
  landedSummary,
  NO_FIT,
  planBoardLanding,
  removalCount,
  touchedFrames,
  withDependents,
  wouldBreak,
} from "./proposal";

// Every parse goes through a spy, so a test can see which texts were parsed.
vi.mock("../../lang/flow/parse", async (actual) => {
  const real = await actual<typeof import("../../lang/flow/parse")>();
  return { ...real, parseFlow: vi.fn(real.parseFlow) };
});

const FIXTURES = import.meta.glob("../../lang/flow/fixtures/*.flow", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const fixture = (name: string) => FIXTURES[`../../lang/flow/fixtures/${name}`];
const ORDER = fixture("order-flow.flow");

const ok = (index: number, op: DiagramOp, dependsOn: number[] = []): ProposedChange => ({ index, op, status: { kind: "ok" }, dependsOn });
const all = (changes: ProposedChange[]) => new Set(changes.map((c) => c.index));
/** A change checked in frame `frame` of a board. */
const inFrame = (frame: string, index: number, op: DiagramOp, dependsOn: number[] = []): ProposedChange => ({ ...ok(index, op, dependsOn), frame });

/** The board's titles in frame order, as the Ask reads them off the headers. */
const titlesOf = (text: string) => frameHeaders(text).map((h) => h.title);

/** The touched frames and the landing of `accepted` on `text`, as the board Ask plans it: a plan or why not. */
function attempt(text: string, changes: ProposedChange[], accepted: ReadonlySet<number> = all(changes)) {
  const titles = titlesOf(text);
  const touched = touchedFrames(text, splitFrames(text), titles, changes);
  return planBoardLanding(text, touched, changes, accepted, { titles, shapes: parseBoard(text).shapes });
}

/** The plan `attempt` makes; null when it was refused. */
function land(text: string, changes: ProposedChange[], accepted: ReadonlySet<number> = all(changes)): BoardPlan | null {
  const plan = attempt(text, changes, accepted);
  return isRefusal(plan) ? null : plan;
}

/** A refusal with no note of its own. */
const noFit = (index: number | null, frame: string | null) => ({ refused: true, index, frame, message: NO_FIT });

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const ERD = lines('diagram er "Orders ERD"', "customers {", "  id int pk", "  email text", "}", "invoices {", "  id int pk", "}");
const TWO = lines('diagram flow "A"', "Pay", "Done", "Pay > Done", "", 'diagram flow "B"', "Pay", "Done", "Pay > Done");

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

describe("changeEditOp for ER frames", () => {
  const ER = lines('diagram er "Orders ERD"', "customers {", "  id int pk", "  email text", "}", "invoices {", "  id int pk", "  customer_id int", "}", "invoices.customer_id > customers.id: bills", "invoices > customers: owes");
  const parse = parseFlow(ER);
  const op = (o: DiagramOp) => changeEditOp(ok(0, o), parse, "er", ER);

  test("column_ops_map_to_column_edits", () => {
    expect(op({ add_column: { table: "customers", name: "phone" } })).toEqual({ op: "addColumn", table: "customers", at: 2, before: null, name: "phone", type: "", flags: [] });
    expect(op({ add_column: { table: "customers", name: "code", type: "char(3)", flags: ["unique", "not null"] } })).toEqual({
      op: "addColumn",
      table: "customers",
      at: 2,
      before: null,
      name: "code",
      type: "char(3)",
      flags: ["unique", "not null"],
    });
    expect(op({ set_column: { table: "customers", column: "email", name: "mail", type: null } })).toEqual({ op: "setColumn", table: "customers", index: 1, column: "email", name: "mail" });
    expect(op({ set_column: { table: "customers", column: "email", type: "varchar(80)" } })).toEqual({ op: "setColumn", table: "customers", index: 1, column: "email", type: "varchar(80)" });
    expect(op({ remove_column: { table: "invoices", column: "customer_id" } })).toEqual({ op: "deleteColumn", table: "invoices", index: 1, column: "customer_id" });
    // A column the table does not have, and a new frame (it lands through appendFrames), have no edit here.
    expect(op({ remove_column: { table: "invoices", column: "nope" } })).toBeNull();
    expect(op({ add_frame: { title: "Refund", kind: "flow" } })).toBeNull();
  });

  test("er_line_ends_name_columns", () => {
    expect(op({ add_flow: { from: "invoices.id", to: "customers.id", label: "x" } })).toEqual({
      op: "addLink",
      from: "invoices",
      to: "customers",
      arrow: ">",
      label: "x",
      fromColumn: "id",
      toColumn: "id",
    });
    expect(op({ add_flow: { from: "invoices", to: "customers.id" } })).toEqual({ op: "addLink", from: "invoices", to: "customers", arrow: ">", label: undefined, toColumn: "id" });
    // A line named by its columns is that line only; one named by its tables is any line between them.
    expect(op({ remove_flow: { from: "invoices.customer_id", to: "customers.id" } })).toEqual({ op: "deleteLink", index: 0 });
    expect(op({ remove_flow: { from: "invoices.id", to: "customers.id" } })).toBeNull();
    expect(op({ remove_flow: { from: "invoices", to: "customers", label: "owes" } })).toEqual({ op: "deleteLink", index: 1 });
    expect(op({ relabel_flow: { from: "invoices.customer_id", to: "customers.id", label: "pays" } })).toEqual({ op: "setLinkLabel", index: 0, label: "pays" });
  });

  test("column_changes_list_their_lines", () => {
    const line = (o: DiagramOp) => changeLine(ok(0, o), "er");
    expect(line({ add_column: { table: "customers", name: "phone" } })).toBe("customers.phone");
    expect(line({ add_column: { table: "customers", name: "code", type: "char(3)", flags: ["pk"] } })).toBe("customers.code char(3) pk");
    expect(line({ set_column: { table: "customers", column: "email", name: "mail" } })).toBe("customers.mail");
    expect(line({ remove_column: { table: "customers", column: "email" } })).toBe("customers.email");
    expect(line({ add_flow: { from: "invoices.customer_id", to: "customers.id" } })).toBe("invoices.customer_id > customers.id");
    expect(line({ add_frame: { title: "Refund", kind: "flow" } })).toBe('diagram flow "Refund"');
    expect(changeMark(ok(0, { add_column: { table: "t", name: "c" } }))).toBe("+");
    expect(changeMark(ok(0, { remove_column: { table: "t", column: "c" } }))).toBe("-");
    expect(changeMark(ok(0, { set_column: { table: "t", column: "c", name: "d" } }))).toBe("~");
    expect(changeMark(ok(0, { add_frame: { title: "R", kind: "flow" } }))).toBe("+");
  });
});

describe("planBoardLanding on one frame", () => {
  test("reserved_names_write_quoted_one_line", () => {
    const plan = land(ORDER, [ok(0, { add_node: { name: "Customs > check [x]" } })]);
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
      const p = land(ORDER, [ok(0, { add_node: { name } })]);
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
    const plan = land(ORDER, changes);
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
    const plan = land(ORDER, changes);
    expect(plan?.text).toContain("Paid? > Ask for payment: declined");
    expect(plan?.text).not.toContain("Order placed > Paid?");
  });

  test("only_the_accepted_changes_land_and_a_miss_gives_null", () => {
    const changes = [ok(0, ADD_CUSTOMS), ok(1, { remove_node: { target: "Cook" } })];
    const one = land(ORDER, changes, new Set([1]));
    expect(one?.text).not.toContain("Customs check");
    expect(one?.text).not.toContain("Cook [step");
    expect(attempt(ORDER, changes, new Set())).toEqual(noFit(null, null));
    // A name that is taken, an unknown group and a change that is not Ok do not apply: the edit's note says why.
    expect(attempt(ORDER, [ok(0, { add_node: { name: "Cook" } })])).toMatchObject({ refused: true, index: 0, frame: titlesOf(ORDER)[0] });
    expect(land(ORDER, [ok(0, { add_node: { name: "X", group: "Nowhere" } })])).toBeNull();
    const dropped: ProposedChange = { index: 0, op: ADD_CUSTOMS, status: { kind: "dropped", reason: "unknownGroup", message: "m" }, dependsOn: [] };
    expect(attempt(ORDER, [dropped], new Set([0]))).toEqual(noFit(0, null));
  });

  test("on_a_board_changes_land_in_their_frame_only", () => {
    // Both frames define Pay and Done; changes checked in frame A land in frame A.
    const second = 'diagram flow "B"\nPay\nDone\nPay > Done\n';
    const add = land(TWO, [inFrame("A", 0, { add_node: { name: "X" } })]);
    const at = add?.text.indexOf("\nX\n") ?? -1;
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(add?.text.indexOf('diagram flow "B"') ?? 0);
    expect(add?.text.endsWith(second)).toBe(true);
    expect(applyEdits(TWO, add?.edits ?? [])).toBe(add?.text);
    // Not refused as "defined twice": only frame A's Pay is renamed.
    const rename = land(TWO, [inFrame("A", 0, { rename_node: { target: "Pay", name: "Charge" } })]);
    expect(rename?.text).toBe(`diagram flow "A"\nCharge\nDone\nCharge > Done\n\n${second}`);
    expect(applyEdits(TWO, rename?.edits ?? [])).toBe(rename?.text);
    expect(rename?.touched).toEqual(["A"]);
    expect(rename?.added).toEqual([]);
  });

  test("crlf_text_keeps_its_line_breaks", () => {
    const crlf = ORDER.replace(/\n/g, "\r\n");
    const plan = land(crlf, [ok(0, { add_node: { name: "Audit" } })]);
    expect(plan?.text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(plan?.text).toContain("Audit\r\n");
  });

  test("an_er_ask_lands_a_column_and_a_column_link", () => {
    // A one-diagram ER file: the Ask adds a column, then a line from it to another table's column.
    const changes = [
      ok(0, { add_column: { table: "invoices", name: "customer_id", type: "int" } }),
      ok(1, { add_flow: { from: "invoices.customer_id", to: "customers.id", label: "bills" } }, [0]),
    ];
    const plan = land(ERD, changes);
    expect(plan?.text).toBe(
      lines('diagram er "Orders ERD"', "customers {", "  id int pk", "  email text", "}", "invoices {", "  id int pk", "  customer_id int", "}", "", "invoices.customer_id > customers.id: bills"),
    );
    expect(parseFlow(plan?.text ?? "").problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(applyEdits(ERD, plan?.edits ?? [])).toBe(plan?.text);
  });
});

describe("planBoardLanding across frames", () => {
  test("same_names_in_two_frames_land_in_the_named_frame", () => {
    const plan = land(TWO, [inFrame("B", 0, { rename_node: { target: "Pay", name: "Charge" } })]);
    expect(plan?.text).toBe(lines('diagram flow "A"', "Pay", "Done", "Pay > Done", "", 'diagram flow "B"', "Charge", "Done", "Charge > Done"));
    expect(plan?.touched).toEqual(["B"]);
    expect(plan?.after.get("B")?.text).toBe(lines('diagram flow "B"', "Charge", "Done", "Charge > Done"));
    expect(plan?.after.has("A")).toBe(false);
  });

  test("changes_in_two_frames_make_one_edit_list_in_order", () => {
    // B's change comes first in the proposal; the edits still go in text order, one per frame.
    const changes = [inFrame("B", 0, { add_node: { name: "Refund" } }), inFrame("A", 1, { add_node: { name: "Audit" } }), inFrame("B", 2, { add_flow: { from: "Done", to: "Refund" } }, [0])];
    const plan = land(TWO, changes);
    expect(plan?.edits).toHaveLength(2);
    expect(plan!.edits[0].to).toBeLessThanOrEqual(plan!.edits[1].from);
    expect(applyEdits(TWO, plan?.edits ?? [])).toBe(plan?.text);
    expect(plan?.text).toBe(lines('diagram flow "A"', "Pay", "Done", "Audit", "Pay > Done", "", 'diagram flow "B"', "Pay", "Done", "Refund", "Pay > Done", "Done > Refund"));
    expect(plan?.touched).toEqual(["A", "B"]);
  });

  test("only_touched_frames_are_parsed", () => {
    const three = `${TWO}\n${lines('diagram flow "C"', "Pay", "Done")}`;
    const changes = [inFrame("A", 0, { add_node: { name: "Audit" } }), inFrame("A", 1, { add_flow: { from: "Done", to: "Audit" } }, [0])];
    const titles = titlesOf(three);
    const calls = vi.mocked(parseFlow).mock.calls;
    const start = calls.length;
    const touched = touchedFrames(three, splitFrames(three), titles, changes);
    expect(touched.map((t) => [t.title, t.index])).toEqual([["A", 0]]);
    expect(calls.length - start).toBe(1);
    const plan = planBoardLanding(three, touched, changes, all(changes), { titles, shapes: 6 });
    expect(isRefusal(plan) ? null : plan.touched).toEqual(["A"]);
    const parsed = calls.slice(start).map((c) => c[0]);
    expect(parsed.length).toBeGreaterThan(1);
    for (const t of parsed) {
      expect(t).not.toContain('diagram flow "B"');
      expect(t).not.toContain('diagram flow "C"');
    }
  });

  test("a_new_frame_is_appended_with_its_shapes", () => {
    const changes = [
      ok(0, { add_frame: { title: "Refund", kind: "flow" } }),
      inFrame("Refund", 1, { add_node: { name: "Ask" } }, [0]),
      inFrame("Refund", 2, { add_node: { name: "Pay back" } }, [0]),
      inFrame("Refund", 3, { add_flow: { from: "Ask", to: "Pay back" } }, [1, 2]),
      inFrame("A", 4, { add_node: { name: "Audit" } }),
    ];
    const touched = touchedFrames(TWO, splitFrames(TWO), titlesOf(TWO), changes);
    expect(touched.map((t) => [t.title, t.index])).toEqual([
      ["A", 0],
      ["Refund", null],
    ]);
    const plan = land(TWO, changes);
    expect(plan?.text).toBe(
      lines('diagram flow "A"', "Pay", "Done", "Audit", "Pay > Done", "", 'diagram flow "B"', "Pay", "Done", "Pay > Done", "", 'diagram flow "Refund"', "Ask", "Pay back", "", "Ask > Pay back"),
    );
    expect(applyEdits(TWO, plan?.edits ?? [])).toBe(plan?.text);
    expect(plan?.touched).toEqual(["A"]);
    expect(plan?.added).toEqual(["Refund"]);
    expect(plan?.after.get("Refund")?.text).toBe(lines('diagram flow "Refund"', "Ask", "Pay back", "", "Ask > Pay back"));
    // An empty new frame is appended too; CRLF boards get CRLF frames.
    const crlf = TWO.replace(/\n/g, "\r\n");
    const empty = land(crlf, [ok(0, { add_frame: { title: "Later", kind: "er" } })]);
    expect(empty?.text).toBe(`${crlf}\r\ndiagram er "Later"\r\n`);
    // A change in a new frame whose frame is not accepted does not land.
    expect(attempt(TWO, changes, new Set([1]))).toEqual(noFit(1, "Refund"));
  });

  test("a_title_appendFrames_would_change_refuses_the_plan", () => {
    // appendFrames would write "Refund 2" next to the board's Refund: the plan is refused with the board's own message.
    const board = `${TWO}\n${lines('diagram flow "Refund"', "Old")}`;
    const changes = [ok(0, { add_frame: { title: "Refund", kind: "flow" } })];
    const touched = touchedFrames(board, splitFrames(board), titlesOf(board), changes);
    expect(planBoardLanding(board, touched, changes, all(changes), { titles: titlesOf(board), shapes: 5 })).toEqual({
      refused: true,
      index: 0,
      frame: "Refund",
      message: MESSAGES.frameTwice("Refund"),
    });
    expect(land(TWO, changes)?.added).toEqual(["Refund"]);
  });

  test("two_new_frames_with_one_title_refuse", () => {
    const changes = [ok(0, { add_frame: { title: "Refund", kind: "flow" } }), ok(1, { add_frame: { title: "Refund", kind: "er" } })];
    expect(attempt(TWO, changes)).toEqual({ refused: true, index: 1, frame: "Refund", message: MESSAGES.frameTwice("Refund") });
  });

  test("new_frames_past_the_board_caps_refuse_with_the_board_message", () => {
    // A real board already at MAX_BOARD_FRAMES: one more frame is refused, named.
    const full = Array.from({ length: MAX_BOARD_FRAMES }, (_, k) => lines(`diagram flow "F${k}"`, "X")).join("\n");
    const more = [ok(0, { add_frame: { title: "Refund", kind: "flow" } })];
    expect(attempt(full, more)).toEqual({ refused: true, index: 0, frame: "Refund", message: MESSAGES.tooManyFrames });
    // A board one shape under the cap: a new frame with two shapes is refused on that frame.
    const big = `${lines('diagram flow "A"', ...Array.from({ length: MAX_BOARD_SHAPES - 2 }, (_, i) => `N ${i}`))}\n${lines('diagram flow "B"', "X")}`;
    expect(parseBoard(big).shapes).toBe(MAX_BOARD_SHAPES - 1);
    const shapes = [ok(0, { add_frame: { title: "Refund", kind: "flow" } }), inFrame("Refund", 1, { add_node: { name: "Ask" } }, [0]), inFrame("Refund", 2, { add_node: { name: "Back" } }, [0])];
    expect(attempt(big, shapes)).toEqual({ refused: true, index: 0, frame: "Refund", message: MESSAGES.tooManyShapes });
    // One new shape fits exactly.
    expect(land(big, shapes, new Set([0, 1]))?.added).toEqual(["Refund"]);
  });

  test("an_append_after_an_edit_at_the_board_end_is_one_edit", () => {
    // B's new line goes before the board's trailing blank lines, which the append replaces: the two become one edit.
    const trailing = `${TWO}\n\n`;
    const changes = [ok(0, { add_frame: { title: "Refund", kind: "flow" } }), inFrame("B", 1, { add_flow: { from: "Done", to: "Pay" } })];
    const plan = land(trailing, changes);
    expect(plan?.edits).toHaveLength(1);
    expect(plan?.text).toBe(`${TWO.replace(/\n$/, "")}\nDone > Pay\n\ndiagram flow "Refund"\n`);
    expect(applyEdits(trailing, plan?.edits ?? [])).toBe(plan?.text);
  });

  test("a_column_end_on_a_quoted_table_refuses_with_why", () => {
    const quoted = lines('diagram er "Orders ERD"', '"crm:people" {', "  id int", "}", "orders {", "  t_id int", "}");
    const changes = [ok(0, { add_node: { name: "audit" } }), ok(1, { add_flow: { from: "orders.t_id", to: "crm:people.id" } })];
    expect(attempt(quoted, changes)).toEqual({ refused: true, index: 1, frame: "Orders ERD", message: ER_NOTES.quotedEnd("crm:people") });
  });

  test("one_change_that_does_not_apply_refuses_the_whole_set", () => {
    const changes = [inFrame("A", 0, { add_node: { name: "Audit" } }), inFrame("B", 1, { add_node: { name: "Pay" } })];
    expect(attempt(TWO, changes)).toMatchObject({ refused: true, index: 1, frame: "B" });
    expect(land(TWO, changes, new Set([0]))?.touched).toEqual(["A"]);
    // A change for a frame the board does not have does not land either.
    expect(attempt(TWO, [inFrame("Nowhere", 0, { add_node: { name: "X" } })])).toEqual(noFit(0, "Nowhere"));
  });

  test("column_ops_write_table_blocks", () => {
    const board = `${lines('diagram flow "Checkout flow"', "Pay")}\n${ERD}`;
    const changes = [
      inFrame("Orders ERD", 0, { add_column: { table: "customers", name: "phone" } }),
      inFrame("Orders ERD", 1, { add_column: { table: "invoices", name: "total", type: "numeric(10,2)", flags: ["not null"] } }),
      inFrame("Orders ERD", 2, { set_column: { table: "customers", column: "email", name: "mail", type: "varchar(80)" } }),
      inFrame("Orders ERD", 3, { remove_column: { table: "invoices", column: "id" } }),
    ];
    const plan = land(board, changes);
    expect(plan?.text).toBe(
      `${lines('diagram flow "Checkout flow"', "Pay")}\n${lines('diagram er "Orders ERD"', "customers {", "  id int pk", "  mail varchar(80)", "  phone", "}", "invoices {", "  total numeric(10,2) not null", "}")}`,
    );
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
    const clean = land(ORDER, [ok(0, ADD_CUSTOMS)]);
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
      "Done. I added Customs check and 2 lines and removed a line, as one undo step. The new parts are ringed on the canvas for a moment.",
    );
    // Only what was accepted counts; one of each is singular.
    expect(landedSummary(board, new Set([0, 1]))).toBe("Done. I added Customs check and a line, as one undo step. The new parts are ringed on the canvas for a moment.");
    const many = number([add("A"), add("B"), add("C"), add("D"), add("E")]);
    expect(landedSummary(many, all(many))).toBe("Done. I added A, B, C and 2 more shapes, as one undo step. The new parts are ringed on the canvas for a moment.");
    const one = number([add("Solo")]);
    expect(landedSummary(one, all(one))).toBe("Done. I added Solo, as one undo step. The new parts are ringed on the canvas for a moment.");
    const edits = number([ok(0, { rename_node: { target: "A", name: "B" } }), ok(0, { rename_node: { target: "C", name: "D" } }), ok(0, { move_to_group: { target: "E", group: null } })]);
    expect(landedSummary(edits, all(edits))).toBe("Done. I renamed 2 shapes and moved a shape, as one undo step. The new parts are ringed on the canvas for a moment.");
    const gone = number([ok(0, { remove_node: { target: "A" } }), ok(0, { remove_node: { target: "B" } })]);
    expect(landedSummary(gone, all(gone))).toBe("Done. I removed A and B, as one undo step.");
    const relabel = number([ok(0, { relabel_flow: { from: "A", to: "B", label: "x" } })]);
    expect(landedSummary(relabel, all(relabel))).toBe("Done. I relabelled a line, as one undo step. The new parts are ringed on the canvas for a moment.");
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

describe("boardWouldBreak", () => {
  test("would_break_names_the_frame_and_its_line", () => {
    const changes = [inFrame("A", 0, { add_node: { name: "Audit" } }), inFrame("B", 1, { add_node: { name: "Refund" } })];
    const titles = titlesOf(TWO);
    const touched = touchedFrames(TWO, splitFrames(TWO), titles, changes);
    const plan = land(TWO, changes) as BoardPlan;
    const counts = { titles, frames: 2, shapes: 4 };
    expect(boardWouldBreak(touched, plan, counts)).toBeNull();
    // Frame B's text after the landing gains an error on its fourth line (a flowchart takes no ..> arrow).
    const bad = lines('diagram flow "B"', "Pay", "Done", "Pay ..> Done", "Refund");
    const broken: BoardPlan = { ...plan, after: new Map([...plan.after, ["B", { parse: parseFlow(bad), text: bad }]]) };
    expect(boardWouldBreak(touched, broken, counts)).toEqual({ frame: "B", line: 4, lineText: "Pay ..> Done", message: expect.stringMatching(/\.\.>/) });
    // A new frame is checked against no problems at all.
    const added = [ok(0, { add_frame: { title: "Refund", kind: "flow" } })];
    const newTouched = touchedFrames(TWO, splitFrames(TWO), titles, added);
    const newPlan = land(TWO, added) as BoardPlan;
    expect(boardWouldBreak(newTouched, newPlan, counts)).toBeNull();
    const newBad = lines('diagram flow "Refund"', "A ..> B");
    const newBroken: BoardPlan = { ...newPlan, after: new Map([["Refund", { parse: parseFlow(newBad), text: newBad }]]) };
    expect(boardWouldBreak(newTouched, newBroken, counts)).toMatchObject({ frame: "Refund", line: 2, lineText: "A ..> B" });
  });

  test("would_break_sees_the_board_shape_cap_from_counts", () => {
    const titles = titlesOf(TWO);
    // The shape cap, from the count and the touched frames' shapes alone (new frames past a cap never plan).
    const one = [inFrame("B", 0, { add_node: { name: "Refund" } })];
    const t2 = touchedFrames(TWO, splitFrames(TWO), titles, one);
    const p2 = land(TWO, one) as BoardPlan;
    expect(boardWouldBreak(t2, p2, { titles, frames: 2, shapes: MAX_BOARD_SHAPES - 1 })).toBeNull();
    expect(boardWouldBreak(t2, p2, { titles, frames: 2, shapes: MAX_BOARD_SHAPES })).toEqual({ frame: "B", line: 1, lineText: 'diagram flow "B"', message: MESSAGES.tooManyShapes });
  });
});

describe("boardRemovalCount", () => {
  test("removals_are_counted_across_frames", () => {
    const er = lines('diagram er "Orders ERD"', "customers {", "  id int pk", "  email text", "}", "invoices {", "  id int pk", "  customer_id int", "}", "invoices.customer_id > customers.id", "invoices > customers: owes");
    const frames = [
      { title: "Checkout", outline: flowOutline(parseFlow(fixture("checkout.flow")), null) },
      { title: "Orders ERD", outline: flowOutline(parseFlow(er), null, er) },
    ];
    const changes = [
      inFrame("Checkout", 0, { remove_node: { target: "Orders" } }),
      inFrame("Orders ERD", 1, { remove_column: { table: "invoices", column: "customer_id" } }),
      inFrame("Orders ERD", 2, { remove_flow: { from: "invoices", to: "customers", label: "owes" } }),
      inFrame("Orders ERD", 3, { remove_column: { table: "customers", column: "email" } }),
      inFrame("Checkout", 4, { add_node: { name: "Ship" } }),
    ];
    // Orders takes its 2 lines; the customer_id column takes the line that ends on it; owes is removed directly.
    expect(boardRemovalCount(changes, all(changes), frames)).toEqual({
      shapes: ["Orders"],
      columns: ["invoices.customer_id", "customers.email"],
      lines: 4,
      tables: ["Orders"],
      frames: ["Checkout", "Orders ERD"],
    });
    // A line named by its columns counts once, with the column it ends on.
    const both = [inFrame("Orders ERD", 0, { remove_flow: { from: "invoices.customer_id", to: "customers.id" } }), inFrame("Orders ERD", 1, { remove_column: { table: "invoices", column: "customer_id" } })];
    expect(boardRemovalCount(both, all(both), frames)).toEqual({ shapes: [], columns: ["invoices.customer_id"], lines: 1, tables: [], frames: ["Orders ERD"] });
    // A column of a table that needs quotes is written as the file writes it.
    const quoted = lines('diagram er "People"', '"crm:people" {', "  id int", "}");
    const gone = [inFrame("People", 0, { remove_column: { table: "crm:people", column: "id" } })];
    expect(boardRemovalCount(gone, all(gone), [{ title: "People", outline: flowOutline(parseFlow(quoted), null, quoted) }]).columns).toEqual(['"crm:people".id']);
    expect(boardRemovalCount(changes, new Set([4]), frames)).toEqual({ shapes: [], columns: [], lines: 0, tables: [], frames: [] });
  });
});

describe("landedSummary and fixQuestion on boards", () => {
  test("the_summary_names_each_frame", () => {
    const changes = [inFrame("Checkout flow", 0, { add_node: { name: "Ship" } }), inFrame("Orders ERD", 1, { add_column: { table: "customers", name: "phone" } })];
    expect(landedSummary(changes, all(changes))).toBe("Done. In Checkout flow I added Ship; in Orders ERD I added a column, as one undo step. The new parts are ringed on the canvas for a moment.");
    // One frame keeps the one-diagram wording; columns are counted there too.
    const one = [inFrame("Orders ERD", 0, { add_column: { table: "a", name: "b" } }), inFrame("Orders ERD", 1, { add_column: { table: "a", name: "c" } }), inFrame("Orders ERD", 2, { remove_column: { table: "a", column: "d" } })];
    expect(landedSummary(one, all(one))).toBe("Done. I added 2 columns and removed a column, as one undo step. The new parts are ringed on the canvas for a moment.");
    const changed = [ok(0, { set_column: { table: "a", column: "b", name: "c" } })];
    expect(landedSummary(changed, all(changed))).toBe("Done. I changed a column, as one undo step. The new parts are ringed on the canvas for a moment.");
    // A new frame is named by its title, and an empty one says so.
    const fresh = [ok(0, { add_frame: { title: "Refund", kind: "flow" } }), inFrame("Refund", 1, { add_node: { name: "Ask" } }, [0]), ok(2, { add_frame: { title: "Later", kind: "er" } })];
    expect(landedSummary(fresh, all(fresh))).toBe("Done. In Refund I added Ask; in Later I added an empty diagram, as one undo step. The new parts are ringed on the canvas for a moment.");
    const removed = [inFrame("A", 0, { remove_node: { target: "X" } }), inFrame("B", 1, { remove_flow: { from: "Y", to: "Z" } })];
    expect(landedSummary(removed, all(removed))).toBe("Done. In A I removed X; in B I removed a line, as one undo step.");
  });

  test("fix_question_on_a_board_says_board", () => {
    expect(fixQuestion(["Pay is taken.", "No table x"], true)).toBe("Some changes could not be used: Pay is taken; No table x. Propose them again so they fit this board.");
    expect(fixQuestion(["Pay is taken."], false)).toBe("Some changes could not be used: Pay is taken. Propose them again so they fit this diagram.");
  });
});
