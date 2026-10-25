// Diagram step 9 (F9): what a group's title drag moves and where it may be dropped.
import { expect, test } from "vitest";
import { parseFlow } from "../lang/flow/parse";
import { buildFlowGraph } from "./flowNodes";
import { groupDragEnd, groupDragFrame, groupDropAt, startGroupDrag } from "./groupDrag";

const doc = parseFlow(
  ['diagram state "Invoice"', "Draft", "Open {", "  Sent", "  Late {", "    Overdue", "  }", "}", "Paid {", "  Done", "}", ""].join("\n"),
).doc!;
const at = { Draft: { x: 0, y: 0 }, Sent: { x: 200, y: 100 }, Overdue: { x: 200, y: 300 }, Done: { x: 800, y: 100 } };
const graph = buildFlowGraph(doc, at, "modern");

test("the outer group moves its shapes and every area in it; the inner one only its own", () => {
  const outer = startGroupDrag("Open", doc.groups, graph.nodes)!;
  expect([...outer.ids].sort()).toEqual(["\u0000group:Late", "\u0000group:Open", "Overdue", "Sent"]);
  expect(outer.shapes).toBe(2);
  const live = groupDragFrame(outer, 30, -10);
  expect(live.Sent).toEqual({ x: 230, y: 90 });
  const area = graph.nodes.find((n) => n.id === "\u0000group:Late")!;
  expect(live["\u0000group:Late"]).toEqual({ x: area.position.x + 30, y: area.position.y - 10, w: area.initialWidth, h: area.initialHeight });
  // A new record each frame, from the two kept for the drag.
  const next = groupDragFrame(outer, 31, -10);
  expect(next).not.toBe(live);
  expect(groupDragFrame(outer, 32, -10)).toBe(live);
  expect(groupDragEnd(outer, 30.4, -9.6)).toEqual({ Sent: { x: 230, y: 90 }, Overdue: { x: 230, y: 290 } });
  const inner = startGroupDrag("Late", doc.groups, graph.nodes)!;
  expect([...inner.ids]).toEqual(["Overdue", "\u0000group:Late"]);
  expect(inner.parent).toBe("Open");
});

test("a drop lands in the deepest other group under the dragged group's centre, never in itself or one inside it", () => {
  const late = startGroupDrag("Late", doc.groups, graph.nodes)!;
  expect(late.targets).not.toContain("Late");
  // Where it is: inside Open.
  expect(late.targets[groupDropAt(late, 0, 0)]).toBe("Open");
  // Over Paid's box.
  const paid = graph.nodes.find((n) => n.id === "\u0000group:Paid")!;
  const dx = paid.position.x + (paid.initialWidth ?? 0) / 2 - (late.box.x + late.box.w / 2);
  const dy = paid.position.y + (paid.initialHeight ?? 0) / 2 - (late.box.y + late.box.h / 2);
  expect(late.targets[groupDropAt(late, dx, dy)]).toBe("Paid");
  // Far away: no group.
  expect(groupDropAt(late, 5000, 5000)).toBe(-1);
  const open = startGroupDrag("Open", doc.groups, graph.nodes)!;
  expect(open.targets).toEqual(["Paid"]);
});

test("a group that is not drawn has no drag", () => {
  expect(startGroupDrag("Nobody", doc.groups, graph.nodes)).toBeNull();
});
