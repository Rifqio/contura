// The sequence layout's spacing: the first message clears the participant boxes, and a frame's tab gets a row
// of its own above the frame's first message.
import { describe, expect, test } from "vitest";
import { parseFlow } from "../lang/flow/parse";
import { fixedLayout, SEQ_HEAD, SEQ_ROW } from "./kindLayout";

const layout = (...l: string[]) => {
  const doc = parseFlow(`${l.join("\n")}\n`).doc!;
  return fixedLayout(doc, () => ({ w: 120, h: 40 }))!;
};
/** A message label is 16 px tall and sits 10 px above its line. */
const labelTop = (y: number) => y - 10 - 16;

describe("sequence layout", () => {
  test("the first message's label clears the participant boxes", () => {
    const lay = layout('diagram sequence "x"', "participant A", "participant B", "A -> B : hello");
    expect(labelTop(lay.rows![0])).toBeGreaterThanOrEqual(SEQ_HEAD + 8);
  });

  test("a frame's tab sits above its first message, not on it", () => {
    const lay = layout('diagram sequence "x"', "participant A", "participant B", "A -> B : one", "opt ok {", "  A -> B : two", "}", "B --> A : three");
    const frame = lay.frames![0].box;
    // The tab (21 px) ends above the label of the frame's first message.
    expect(frame.y + 21).toBeLessThanOrEqual(labelTop(lay.rows![1]));
    // and the frame starts below the message before it.
    expect(frame.y).toBeGreaterThan(lay.rows![0]);
    // The frame ends before the next message's label.
    expect(frame.y + frame.h).toBeLessThanOrEqual(labelTop(lay.rows![2]));
    // Rows still run SEQ_ROW apart outside frames, and the lifeline runs past the last row.
    expect(lay.lifeline!).toBeGreaterThanOrEqual(lay.rows![2] + SEQ_ROW / 2);
  });

  test("nested frames opening on one row stack their tabs, the outer one highest", () => {
    const lay = layout('diagram sequence "x"', "participant A", "participant B", "loop outer {", "  opt inner {", "    A -> B : one", "  }", "}");
    const [outer, inner] = [...lay.frames!].sort((a, b) => a.depth - b.depth).map((f) => f.box);
    expect(outer.y + 21).toBeLessThanOrEqual(inner.y);
    expect(inner.y + 21).toBeLessThanOrEqual(labelTop(lay.rows![0]));
    expect(outer.y + outer.h).toBeGreaterThan(inner.y + inner.h);
  });
});

// Step 7 (board DiagramMindMap, ruling of 25 Oct): main topics fill the right side first, then the left, each side
// top to bottom, so a new topic lands beside its neighbour; a folded topic's subtopics take no room.
describe("mind map layout", () => {
  const map = (...topics: string[]) => layout('diagram mindmap "x"', "root Plan", ...topics);
  const side = (lay: ReturnType<typeof layout>, n: string) => (lay.positions[n].x > lay.positions.Plan.x ? "right" : "left");

  test("the first half of the main topics go on the right, the rest on the left, each side top to bottom", () => {
    const lay = map("  A", "  B", "  C", "  D", "  E");
    expect(["A", "B", "C", "D", "E"].map((n) => side(lay, n))).toEqual(["right", "right", "right", "left", "left"]);
    expect(lay.positions.A.y).toBeLessThan(lay.positions.B.y);
    expect(lay.positions.B.y).toBeLessThan(lay.positions.C.y);
    expect(lay.positions.D.y).toBeLessThan(lay.positions.E.y);
  });

  test("a topic added after the second of four lands beside it, and at most one topic changes side", () => {
    const before = map("  A", "  B", "  C", "  D");
    const after = map("  A", "  B", "  New", "  C", "  D");
    expect(side(after, "New")).toBe("right");
    expect(after.positions.New.y).toBeGreaterThan(after.positions.B.y);
    const moved = ["A", "B", "C", "D"].filter((n) => side(before, n) !== side(after, n));
    expect(moved.length).toBeLessThanOrEqual(1);
  });

  test("subtopics sit beside their topic, on its side, and nothing overlaps", () => {
    const lay = map("  A", "    A1", "    A2", "  B", "    B1");
    expect(side(lay, "A1")).toBe("right");
    expect(side(lay, "B1")).toBe("left");
    expect(lay.positions.A1.x).toBeGreaterThan(lay.positions.A.x);
    expect(lay.positions.B1.x).toBeLessThan(lay.positions.B.x);
    const names = ["Plan", "A", "A1", "A2", "B", "B1"];
    for (const a of names)
      for (const b of names) {
        if (a >= b) continue;
        const p = lay.positions[a];
        const q = lay.positions[b];
        expect(p.x + 120 <= q.x || q.x + 120 <= p.x || p.y + 40 <= q.y || q.y + 40 <= p.y).toBe(true);
      }
  });

  test("a folded topic's subtopics take no place and no room", () => {
    const doc = parseFlow(`${['diagram mindmap "x"', "root Plan", "  A", "    A1", "    A2", "      A21", "  B"].join("\n")}\n`).doc!;
    const lay = fixedLayout(doc, () => ({ w: 120, h: 40 }), { folded: new Set(["A"]) })!;
    expect(lay.positions.A).toBeDefined();
    expect(lay.positions.A1).toBeUndefined();
    expect(lay.positions.A21).toBeUndefined();
    const open = fixedLayout(doc, () => ({ w: 120, h: 40 }))!;
    expect(open.positions.A21).toBeDefined();
  });
});

describe("diag-910 fix round 2, L2: a state is as wide as its name is drawn, up to the most", () => {
  test("the drawn name sets the width, with the pill's padding; a long name stops at 280", async () => {
    const { kindSize, setLabelMeasure } = await import("./kindLayout");
    setLabelMeasure((s) => (s === "Published" ? 100 : s.length * 9));
    expect(kindSize("state", { name: "Published" })).toEqual({ w: 144, h: 40 });
    expect(kindSize("state", { name: "Checking" })!.w).toBe(8 * 9 + 44);
    expect(kindSize("state", { name: "x".repeat(60) })!.w).toBe(280);
    expect(kindSize("state", { name: "A" })!.w).toBe(100);
    setLabelMeasure(null);
  });

  test("with nothing to measure with, the guess leaves room for wide letters", async () => {
    const { kindSize } = await import("./kindLayout");
    // 8.2 px a letter, as the bold UI font at 13 px draws at its widest common letters.
    expect(kindSize("state", { name: "Published" })!.w).toBe(Math.ceil(9 * 8.2) + 44);
  });
});
