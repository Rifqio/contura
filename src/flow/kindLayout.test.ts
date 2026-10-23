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
