// Fix round 1 (diag-78-build-review.md): where a dragged topic may land (I1, I2), a drawn message's frame that tells
// the canvas only when its lifeline changes (I4), and the branch dots counted once per drawing (M4).
import { expect, test } from "vitest";
import { createOrderDragStore, drawAt, DROP, foldDotsOf, laneIndex, topicDropAt, topicIndex, type TopicDrop } from "./orderDrag";

const box = (x: number, y: number) => ({ x, y, w: 100, h: 32 });
const out = (): TopicDrop => ({ kind: DROP.none, ref: -1, x1: 0, x2: 0, y: 0 });

test("I1 a last sibling dragged just below itself lands nowhere", () => {
  const ix = topicIndex([{ name: "Plan", parent: null, box: box(-50, 100) }, { name: "A", parent: "Plan", box: box(150, 0) }, { name: "B", parent: "Plan", box: box(150, 60) }], "B");
  const o = out();
  topicDropAt(ix, 200, 60 + 32 + 10, o);
  expect(o.kind).toBe(DROP.none);
  topicDropAt(ix, 200, 60 - 6, o);
  // Just above itself is between A and B: before B is itself, so nothing either.
  expect(o.kind === DROP.none || ix.names[o.ref] !== "B").toBe(true);
});

test("I2 the foot of the right side offers no 'after' among main topics: that place is the top of the left side", () => {
  const topics = [
    { name: "Plan", parent: null, box: box(-50, 100) },
    { name: "A", parent: "Plan", box: box(150, 40) },
    { name: "B", parent: "Plan", box: box(150, 100) },
    { name: "C", parent: "Plan", box: box(-250, 40) },
    { name: "D", parent: "Plan", box: box(-250, 100) },
  ];
  const ix = topicIndex(topics, "D");
  const o = out();
  topicDropAt(ix, 200, 100 + 32 + 10, o);
  expect(o.kind).toBe(DROP.none);
  // At the foot of the left side "after" still goes last.
  const ic = topicIndex(topics, "A");
  topicDropAt(ic, -200, 100 + 32 + 10, o);
  expect([o.kind, ic.names[o.ref]]).toEqual([DROP.after, "D"]);
});

test("I4 a drawn message off every lifeline tells the canvas once, however the pointer moves", () => {
  const store = createOrderDragStore();
  store.begin("draw");
  let told = 0;
  store.subscribe(() => told++);
  const lane = laneIndex([100, 300, 500]);
  expect(drawAt(store, lane, 0, 180, 50, 120)).toBe(-1);
  told = 0;
  for (let x = 181; x < 230; x++) drawAt(store, lane, 0, x, 50, 120);
  expect(told).toBe(0);
  expect(drawAt(store, lane, 0, 290, 50, 120)).toBe(1);
  expect(told).toBe(1);
});

test("M4 the branch dots count every topic under each one, once", () => {
  const links = [
    { from: "Plan", to: "A", tree: true },
    { from: "A", to: "A1", tree: true },
    { from: "A1", to: "A11", tree: true },
    { from: "Plan", to: "B", tree: true },
    { from: "A", to: "B", tree: false },
  ];
  const boxes = new Map([["Plan", box(0, 0)], ["A", box(200, 0)], ["A1", box(400, 0)], ["A11", box(600, 0)], ["B", box(-200, 0)]]);
  const dots = foldDotsOf(links, (n) => boxes.get(n), "Plan", new Set(["A1"]));
  expect(dots.map((d) => [d.name, d.count, d.folded])).toEqual([["A", 2, false], ["A1", 1, true]]);
});
