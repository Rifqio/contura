import { expect, test } from "vitest";
import { applyEdits } from "../../lang/flow/service";
import { ghostEdits } from "./useDiagramAsk";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

test("ghost_edits_mark_only_the_changed_lines", () => {
  const before = lines("diagram flow", "A", "B", "C", "A > B", "B > C");
  const after = lines("diagram flow", "A", "B", "New", "C", "A > B", "B > New");
  const edits = ghostEdits(before, after);
  // Applied, they give the new text; each covers only its own lines.
  expect(applyEdits(before, edits)).toBe(after);
  expect(edits).toEqual([
    { from: before.indexOf("C\n"), to: before.indexOf("C\n"), insert: "New\n" },
    { from: before.indexOf("B > C"), to: before.indexOf("B > C") + "B > C\n".length, insert: "B > New\n" },
  ]);
  expect(ghostEdits(before, before)).toEqual([]);
  // A text without a last line break still works.
  expect(applyEdits("A\nB", ghostEdits("A\nB", "A\nC"))).toBe("A\nC");
});
