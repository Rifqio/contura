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
    // Relabelled, it is one line changed: drawn once, under its new label.
    expect([r.addedLinks.size, r.removedLinks.size, r.changedLinks.size]).toEqual([0, 0, 1]);
    expect(r.draw.links).toEqual([{ from: "A", to: "B", arrow: ">", label: "new" }]);
  });

  test("a_rename_is_changed_not_added", () => {
    const proposed = doc(
      'diagram flow "x"',
      "Start [start]",
      "Kitchen {",
      "  Chef [step]",
      "  Pack",
      "}",
      "Done [end]",
      "Start > Chef: go",
      "Chef > Pack",
      "Pack > Done: out",
    );
    const o = reviewOverlay(CURRENT, proposed, new Map([["Cook", "Chef"]]));
    expect([...o.changed]).toEqual(["Chef"]);
    expect([o.added.size, o.removed.size, o.addedLinks.size, o.removedLinks.size]).toEqual([0, 0, 0, 0]);
    // Drawn once, under its new name: no ghost of the old one.
    expect(o.draw.nodes.map((n) => n.name)).toEqual(["Start", "Done", "Chef", "Pack"]);
    expect(o.draw.groups[0].nodes).toEqual(["Chef", "Pack"]);
    // Without the rename it is one shape gone and another added.
    const plain = reviewOverlay(CURRENT, proposed);
    expect([[...plain.added], [...plain.removed], plain.changed.size]).toEqual([["Chef"], ["Cook"], 0]);
  });

  test("a_group_move_is_changed", () => {
    const proposed = doc('diagram flow "x"', "Start [start]", "Pack", "Kitchen {", "  Cook [step]", "}", "Done [end]", "Start > Cook: go", "Cook > Pack", "Pack > Done: out");
    const o = reviewOverlay(CURRENT, proposed);
    expect([...o.changed]).toEqual(["Pack"]);
    expect([o.added.size, o.removed.size, o.addedLinks.size, o.removedLinks.size, o.changedLinks.size]).toEqual([0, 0, 0, 0, 0]);
    expect(reviewOverlay(CURRENT, CURRENT).changed.size).toBe(0);
  });

  const ERD = doc('diagram er "Orders"', "customers {", "  id int pk", "  email text", "}", "orders {", "  id int pk", "  total int", "}", "orders > customers");

  test("an_added_column_is_marked_on_its_row", () => {
    const proposed = doc('diagram er "Orders"', "customers {", "  id int pk", "  email text", "  name text", "}", "orders {", "  id int pk", "  total bigint", "}", "orders > customers");
    const o = reviewOverlay(ERD, proposed);
    expect([...o.addedRows]).toEqual([["customers", new Set(["name"])]]);
    expect([...o.changedRows]).toEqual([["orders", new Set(["total"])]]);
    expect(o.removedRows.size).toBe(0);
    // The tables themselves are neither added, removed nor changed: only their rows.
    expect([o.added.size, o.removed.size, o.changed.size]).toEqual([0, 0, 0]);
    expect(o.draw.nodes.find((n) => n.name === "customers")!.rows).toEqual(["id int", "email text", "name text"]);
  });

  test("a_removed_column_is_drawn_and_marked", () => {
    const proposed = doc('diagram er "Orders"', "customers {", "  id int pk", "}", "orders {", "  id int pk", "  total int", "}", "orders > customers");
    const o = reviewOverlay(ERD, proposed);
    expect([...o.removedRows]).toEqual([["customers", new Set(["email"])]]);
    expect([o.addedRows.size, o.changedRows.size]).toEqual([0, 0]);
    // The removed column stays in the overlay's table, where it was, with its flags; the proposed doc is not changed.
    const t = o.draw.nodes.find((n) => n.name === "customers")!;
    expect(t.rows).toEqual(["id int", "email text"]);
    expect(t.rowFlags).toEqual([["pk"], []]);
    expect(proposed.nodes.find((n) => n.name === "customers")!.rows).toEqual(["id int"]);
  });

  test("a_renamed_column_is_changed_not_added", () => {
    const proposed = doc('diagram er "Orders"', "customers {", "  id int pk", "  mail text", "}", "orders {", "  id int pk", "  total int", "}", "orders > customers");
    const o = reviewOverlay(ERD, proposed, new Map(), new Map([["customers", new Map([["email", "mail"]])]]));
    expect([...o.changedRows]).toEqual([["customers", new Set(["mail"])]]);
    expect([o.addedRows.size, o.removedRows.size]).toEqual([0, 0]);
    // Drawn once, under its new name: no struck-through ghost row.
    expect(o.draw.nodes.find((n) => n.name === "customers")!.rows).toEqual(["id int", "mail text"]);
    // Without the rename it is one column gone and another added.
    const plain = reviewOverlay(ERD, proposed);
    expect([[...plain.addedRows], [...plain.removedRows], plain.changedRows.size]).toEqual([[["customers", new Set(["mail"])]], [["customers", new Set(["email"])]], 0]);
  });

  test("a_renamed_group_is_changed_and_its_shapes_are_not", () => {
    const proposed = doc('diagram flow "x"', "Start [start]", "Galley {", "  Cook [step]", "  Pack", "}", "Done [end]", "Start > Cook: go", "Cook > Pack", "Pack > Done: out");
    const o = reviewOverlay(CURRENT, proposed, new Map([["Kitchen", "Galley"]]));
    expect([...o.changed]).toEqual(["Galley"]);
    expect([o.added.size, o.removed.size]).toEqual([0, 0]);
  });

  test("a_column_line_is_added_not_same", () => {
    const proposed = doc('diagram er "Orders"', "customers {", "  id int pk", "  email text", "}", "orders {", "  id int pk", "  total int", "}", "orders.total > customers.id");
    const o = reviewOverlay(ERD, proposed);
    const key = (i: number) => `${o.draw.links[i].from}.${o.draw.links[i].fromColumn ?? ""}>${o.draw.links[i].to}.${o.draw.links[i].toColumn ?? ""}`;
    expect([...o.addedLinks].map(key)).toEqual(["orders.total>customers.id"]);
    expect([...o.removedLinks].map(key)).toEqual(["orders.>customers."]);
    expect(o.changedLinks.size).toBe(0);
  });
});

test("numbering_reads_the_proposed_doc_even_when_the_draw_turns_it_off", () => {
  const seq = (...ls: string[]): FlowDoc => {
    const r = parseFlow(`${['diagram sequence "S"', ...ls].join("\n")}\n`);
    if (!r.doc) throw new Error("no doc");
    return r.doc;
  };
  const current = seq("autonumber", "A -> B: one", "B -> A: two");
  const proposed = seq("autonumber", "A -> B: one");
  const o = reviewOverlay(current, proposed);
  expect(o.removedLinks.size).toBe(1);
  expect(o.draw.autonumber?.[o.draw.autonumber.length - 1]).toEqual({ from: 1, off: true });
  expect(o.numbering).toBe(true);
  expect(reviewOverlay(seq("autonumber", "A -> B: one"), seq("A -> B: one")).numbering).toBe(false);
});
