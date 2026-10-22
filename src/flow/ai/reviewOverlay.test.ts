import { describe, expect, test } from "vitest";
import type { FlowDoc } from "../../lang/flow/model";
import { parseFlow } from "../../lang/flow/parse";
import { reviewOverlay } from "./reviewOverlay";

const doc = (...ls: string[]): FlowDoc => {
  const r = parseFlow(`${ls.join("\n")}\n`);
  if (!r.doc) throw new Error(JSON.stringify(r.problems));
  return r.doc;
};

const CURRENT = doc(
  'diagram flow "x"',
  "Start [start]",
  "Kitchen {",
  "  Cook [step]",
  "  Pack",
  "}",
  "Done [end]",
  "Start > Cook: go",
  "Cook > Pack",
  "Pack > Done: out",
);

describe("reviewOverlay", () => {
  test("overlay_marks_added_and_removed", () => {
    const proposed = doc(
      'diagram flow "x"',
      "Start [start]",
      "Kitchen {",
      "  Cook [step]",
      "  Check [step]",
      "}",
      "Done [end]",
      "Start > Cook: go",
      "Cook > Check",
      "Check > Done: ok",
    );
    const o = reviewOverlay(CURRENT, proposed);
    expect([...o.added]).toEqual(["Check"]);
    expect([...o.removed]).toEqual(["Pack"]);
    // The drawing holds the proposed shapes and the removed one, which stays in its group.
    expect(o.draw.nodes.map((n) => n.name)).toEqual(["Start", "Done", "Cook", "Check", "Pack"]);
    expect(o.draw.groups[0].nodes).toEqual(["Cook", "Check", "Pack"]);
    // Links: the proposed ones first, then the removed ones; the sets index into draw.links.
    const key = (i: number) => `${o.draw.links[i].from}>${o.draw.links[i].to}`;
    expect([...o.addedLinks].map(key).sort()).toEqual(["Check>Done", "Cook>Check"]);
    expect([...o.removedLinks].map(key).sort()).toEqual(["Cook>Pack", "Pack>Done"]);
    expect(o.draw.links).toHaveLength(5);
    // The inputs are not changed.
    expect(CURRENT.groups[0].nodes).toEqual(["Cook", "Pack"]);
    expect(proposed.groups[0].nodes).toEqual(["Cook", "Check"]);
  });

  test("an_unchanged_doc_marks_nothing_and_a_moved_shape_is_not_added", () => {
    const same = reviewOverlay(CURRENT, CURRENT);
    expect([same.added.size, same.removed.size, same.addedLinks.size, same.removedLinks.size]).toEqual([0, 0, 0, 0]);
    expect(same.draw.links).toHaveLength(CURRENT.links.length);
    const moved = doc('diagram flow "x"', "Start [start]", "Cook [step]", "Pack", "Done [end]", "Start > Cook: go", "Cook > Pack", "Pack > Done: out");
    const o = reviewOverlay(CURRENT, moved);
    expect([o.added.size, o.removed.size]).toEqual([0, 0]);
  });

  test("a_group_that_goes_is_drawn_with_its_removed_shapes", () => {
    const proposed = doc('diagram flow "x"', "Start [start]", "Done [end]", "Start > Done");
    const o = reviewOverlay(CURRENT, proposed);
    expect([...o.removed].sort()).toEqual(["Cook", "Pack"]);
    expect(o.draw.groups.map((g) => [g.name, g.nodes])).toEqual([["Kitchen", ["Cook", "Pack"]]]);
    // A link with the same ends and a different label is another link.
    const relabelled = doc('diagram flow "x"', "A", "B", "A > B: new");
    const was = doc('diagram flow "x"', "A", "B", "A > B: old");
    const r = reviewOverlay(was, relabelled);
    expect([r.addedLinks.size, r.removedLinks.size]).toEqual([1, 1]);
  });
});
