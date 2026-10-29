import { expect, test } from "vitest";
import type { DiagramOp, ProposedChange } from "../../api/types";
import { frameHeaders, parseBoard, splitFrames } from "../../lang/flow/board";
import { createFlowService } from "../../lang/flow/service";
import { emptyPositions } from "../layout";
import { createBoardScene, inFrameId } from "../board/boardScene";
import { boardReview } from "./boardReview";
import { type BoardPlan, isRefusal, planBoardLanding, touchedFrames } from "./proposal";

const parseFlowBoard = (text: string) => createFlowService().parse("board", text).frames;
const lines = (...l: string[]) => `${l.join("\n")}\n`;
const BOARD = lines(
  'diagram flow "Checkout"',
  "Cart",
  "Pay",
  "Cart > Pay: card",
  "",
  'diagram flow "Refund"',
  "Ask",
  "Refund it",
  "Ask > Refund it",
  "",
  'diagram flow "Shipping"',
  "Pack",
  "Send",
  "Pack > Send",
);

const inFrame = (frame: string, index: number, op: DiagramOp): ProposedChange => ({ index, op, status: { kind: "ok" }, dependsOn: [], frame });
const all = (changes: ProposedChange[]) => new Set(changes.map((c) => c.index));

function review(changes: ProposedChange[], accepted: ReadonlySet<number> = all(changes), board = BOARD) {
  const titles = frameHeaders(board).map((h) => h.title);
  const touched = touchedFrames(board, splitFrames(board), titles, changes);
  const plan = planBoardLanding(board, touched, changes, accepted, { titles, shapes: parseBoard(board).shapes });
  if (isRefusal(plan)) throw new Error(plan.message);
  return boardReview(touched, plan as BoardPlan, changes, accepted, { titles });
}

test("only_touched_frames_get_a_review", () => {
  const changes = [
    inFrame("Checkout", 0, { add_node: { name: "Receipt", frame: "Checkout" } }),
    inFrame("Checkout", 1, { add_flow: { from: "Pay", to: "Receipt", frame: "Checkout" } }),
    inFrame("Shipping", 2, { rename_node: { target: "Send", name: "Ship", frame: "Shipping" } }),
    inFrame("Shipping", 3, { relabel_flow: { from: "Pack", to: "Ship", label: "box", frame: "Shipping" } }),
  ];
  const r = review(changes);
  expect([...r.keys()]).toEqual(["Checkout", "Shipping"]);
  const checkout = r.get("Checkout")!;
  expect([...checkout.added]).toEqual(["Receipt"]);
  expect(checkout.addedLinks.size).toBe(1);
  expect([checkout.count, checkout.isNew]).toEqual([2, false]);
  // The accepted rename is a change, drawn once under its new name; the relabelled line is changed, not added.
  const shipping = r.get("Shipping")!;
  expect([...shipping.changed]).toEqual(["Ship"]);
  expect([shipping.added.size, shipping.removed.size, shipping.addedLinks.size, shipping.removedLinks.size, shipping.changedLinks.size]).toEqual([0, 0, 0, 0, 1]);
  expect(shipping.count).toBe(2);
  // A frame whose changes are all rejected has nothing to draw.
  const some = review(changes, new Set([0, 1]));
  expect([...some.keys()]).toEqual(["Checkout"]);
});

test("a_new_frame_review_is_new", () => {
  const changes = [
    { index: 0, op: { add_frame: { title: "Returns", kind: "flow" } }, status: { kind: "ok" }, dependsOn: [] } as ProposedChange,
    inFrame("Returns", 1, { add_node: { name: "Label", frame: "Returns" } }),
    inFrame("Returns", 2, { add_node: { name: "Drop off", frame: "Returns" } }),
    inFrame("Returns", 3, { add_flow: { from: "Label", to: "Drop off", frame: "Returns" } }),
  ];
  const r = review(changes);
  expect([...r.keys()]).toEqual(["Returns"]);
  const f = r.get("Returns")!;
  expect(f.isNew).toBe(true);
  expect([...f.added].sort()).toEqual(["Drop off", "Label"]);
  expect([f.addedLinks.size, f.removed.size, f.changed.size]).toEqual([1, 0, 0]);
  expect(f.draw.title).toBe("Returns");
  // The frame itself is one of its changes.
  expect(f.count).toBe(4);
});

test("a_renamed_column_is_one_changed_row", () => {
  const board = `${BOARD}\n${lines('diagram er "Orders ERD"', "customers {", "  id int pk", "  email text", "}")}`;
  const changes = [
    inFrame("Orders ERD", 0, { set_column: { table: "customers", column: "email", name: "mail", frame: "Orders ERD" } }),
    // Then the table itself is renamed: the row is found under the table's new name.
    inFrame("Orders ERD", 1, { rename_node: { target: "customers", name: "clients", frame: "Orders ERD" } }),
  ];
  const f = review(changes, all(changes), board).get("Orders ERD")!;
  expect([...f.changedRows]).toEqual([["clients", new Set(["mail"])]]);
  expect([f.addedRows.size, f.removedRows.size]).toEqual([0, 0]);
  expect([...f.changed]).toEqual(["clients"]);
  expect(f.draw.nodes.find((n) => n.name === "clients")!.rows).toEqual(["id int", "mail text"]);
  // Rejected, the rename is not drawn as anything.
  expect(review(changes, new Set([1]), board).get("Orders ERD")!.changedRows.size).toBe(0);
});

test("a_column_renamed_then_removed_is_one_removed_row_under_its_old_name", () => {
  const board = `${BOARD}\n${lines('diagram er "Orders ERD"', "customers {", "  id int pk", "  email text", "}")}`;
  const changes = [
    inFrame("Orders ERD", 0, { set_column: { table: "customers", column: "email", name: "mail", frame: "Orders ERD" } }),
    inFrame("Orders ERD", 1, { remove_column: { table: "customers", column: "mail", frame: "Orders ERD" } }),
  ];
  const f = review(changes, all(changes), board).get("Orders ERD")!;
  // The ghost row is the column as it is now, and its mark names it so.
  expect([...f.removedRows]).toEqual([["customers", new Set(["email"])]]);
  expect([f.addedRows.size, f.changedRows.size]).toEqual([0, 0]);
  expect(f.draw.nodes.find((n) => n.name === "customers")!.rows).toEqual(["id int", "email text"]);
  // So the scene marks that drawn row removed.
  const scene = createBoardScene("modern").build(
    parseFlowBoard(board),
    { frames: new Map([["Orders ERD", { at: { x: 0, y: 0 }, nodes: Object.assign(emptyPositions(), { customers: { x: 0, y: 0 } }), style: "modern", direction: "TB" }]]), sketches: [] },
    frameHeaders(board).map((h) => h.title),
    null,
    null,
    [],
    undefined,
    null,
    undefined,
    null,
    new Map([["Orders ERD", f]]),
  );
  const card = scene.nodes.find((n) => n.id === inFrameId("Orders ERD", "customers"))!;
  expect((card.data as { rowStates?: (string | undefined)[] }).rowStates).toEqual([undefined, "removed"]);
});

test("a_column_removed_then_renamed_is_refused", () => {
  const board = `${BOARD}\n${lines('diagram er "Orders ERD"', "customers {", "  id int pk", "  email text", "}")}`;
  const changes = [
    inFrame("Orders ERD", 0, { remove_column: { table: "customers", column: "email", frame: "Orders ERD" } }),
    inFrame("Orders ERD", 1, { set_column: { table: "customers", column: "email", name: "mail", frame: "Orders ERD" } }),
  ];
  const titles = frameHeaders(board).map((h) => h.title);
  const touched = touchedFrames(board, splitFrames(board), titles, changes);
  const plan = planBoardLanding(board, touched, changes, all(changes), { titles, shapes: parseBoard(board).shapes });
  // The rename names a column the removal already took: the landing is refused, naming that change and frame.
  expect(isRefusal(plan) && [plan.index, plan.frame]).toEqual([1, "Orders ERD"]);
  // Accepting the removal alone is a plain removed row.
  const f = review(changes, new Set([0]), board).get("Orders ERD")!;
  expect([...f.removedRows]).toEqual([["customers", new Set(["email"])]]);
});
