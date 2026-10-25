// Diagram step 9 (board DiagramGroups, F9): the text a group's own gestures write. Delete with contents takes the
// group's whole block and every line to what was in it; a group dragged into or out of another moves its block,
// re-indented. Each is one exact edit list; every other byte stays as it was.
import { describe, expect, test } from "vitest";
import { applyFlowEdit, type FlowEditOp } from "./edits";
import { parseFlow } from "./parse";

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const apply = (text: string, op: FlowEditOp) => {
  const r = applyFlowEdit(text, parseFlow(text), op);
  let out = text;
  for (const e of [...r.edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return { text: out, edits: r.edits };
};

const ORDERS = lines(
  'diagram flow "Order handling"',
  "Order in [start]",
  "Warehouse {",
  "  Check stock",
  "  // the feed",
  "  In stock? [decision]",
  "  Dispatch {",
  "    Ship order",
  "  }",
  "}",
  "Back-order",
  "",
  "Order in > Check stock",
  "Check stock > In stock? > Ship order",
  "In stock? > Back-order: no",
  "Back-order > Order in",
);

describe("deleteGroup: Delete with contents", () => {
  test("the block goes with every shape and group in it, and every line to them; other lines stay", () => {
    expect(apply(ORDERS, { op: "deleteGroup", name: "Warehouse" }).text).toBe(
      // Its comment stays (fix round 1, M4).
      lines('diagram flow "Order handling"', "Order in [start]", "// the feed", "Back-order", "", "Back-order > Order in"),
    );
  });

  test("an inner group goes alone; a chain keeps the links it still has", () => {
    expect(apply(ORDERS, { op: "deleteGroup", name: "Dispatch" }).text).toBe(
      lines(
        'diagram flow "Order handling"',
        "Order in [start]",
        "Warehouse {",
        "  Check stock",
        "  // the feed",
        "  In stock? [decision]",
        "}",
        "Back-order",
        "",
        "Order in > Check stock",
        "Check stock > In stock?",
        "In stock? > Back-order: no",
        "Back-order > Order in",
      ),
    );
  });

  test("a line to the group itself goes too; an unknown name or a node writes nothing", () => {
    const toGroup = lines('diagram flow "x"', "A", "Box {", "  B", "}", "", "A > Box");
    // The blank line before the lines stays, as a node's delete leaves it.
    expect(apply(toGroup, { op: "deleteGroup", name: "Box" }).text).toBe(lines('diagram flow "x"', "A", ""));
    expect(apply(ORDERS, { op: "deleteGroup", name: "Nobody" }).edits).toEqual([]);
    expect(apply(ORDERS, { op: "deleteGroup", name: "Back-order" }).edits).toEqual([]);
  });

  test("a CRLF file stays CRLF", () => {
    const crlf = ORDERS.replace(/\n/g, "\r\n");
    expect(apply(crlf, { op: "deleteGroup", name: "Dispatch" }).text).toBe(apply(ORDERS, { op: "deleteGroup", name: "Dispatch" }).text.replace(/\n/g, "\r\n"));
  });
});

describe("moveToGroup with a group: drag a group in or out", () => {
  const STATE = lines('diagram state "Invoice"', "Draft", "Open {", "  Sent", "  Late {", "    Overdue", "  }", "}", "Paid", "", "[*] > Draft", "Draft > Sent", "Overdue > Paid");

  test("out of its group: the block goes after the last shape outside every group, one level out", () => {
    expect(apply(STATE, { op: "moveToGroup", name: "Late", group: null }).text).toBe(
      lines('diagram state "Invoice"', "Draft", "Open {", "  Sent", "}", "Paid", "Late {", "  Overdue", "}", "", "[*] > Draft", "Draft > Sent", "Overdue > Paid"),
    );
  });

  test("into a group: the block goes before its }, one level in; an inner group comes with it", () => {
    const flat = lines('diagram flow "x"', "A", "Box {", "  B", "}", "Pack {", "  C", "  Inner {", "    D", "  }", "}");
    expect(apply(flat, { op: "moveToGroup", name: "Pack", group: "Box" }).text).toBe(
      lines('diagram flow "x"', "A", "Box {", "  B", "  Pack {", "    C", "    Inner {", "      D", "    }", "  }", "}"),
    );
  });

  test("a group never goes into itself or a group inside it; where it already is writes nothing", () => {
    expect(apply(STATE, { op: "moveToGroup", name: "Open", group: "Late" }).edits).toEqual([]);
    expect(apply(STATE, { op: "moveToGroup", name: "Open", group: "Open" }).edits).toEqual([]);
    expect(apply(STATE, { op: "moveToGroup", name: "Late", group: "Open" }).edits).toEqual([]);
  });

  test("a group left with nothing keeps its braces when its last group leaves it", () => {
    const only = lines('diagram flow "x"', "Outer {", "  Inner {", "    A", "  }", "}");
    expect(apply(only, { op: "moveToGroup", name: "Inner", group: null }).text).toBe(lines('diagram flow "x"', "Outer {", "}", "Inner {", "  A", "}"));
  });
});

test("old files parse as before: a group block written by the new ops reads back with its contents", () => {
  const moved = apply(ORDERS, { op: "moveToGroup", name: "Dispatch", group: null }).text;
  const doc = parseFlow(moved).doc!;
  expect(doc.groups.map((g) => [g.name, g.nodes, g.groups.map((x) => x.name)])).toEqual([
    ["Warehouse", ["Check stock", "In stock?"], []],
    ["Dispatch", ["Ship order"], []],
  ]);
  expect(parseFlow(moved).problems.filter((p) => p.severity === "error")).toEqual([]);
});

test("fix round 1, M4: Delete with contents keeps the lines and comments in the block that are not about what it removes", () => {
  const text = lines('diagram flow "x"', "D", "E", "G {", "  A", "  D > E", "  // keep me", "  A > D", "}", "", "E > A");
  expect(apply(text, { op: "deleteGroup", name: "G" }).text).toBe(lines('diagram flow "x"', "D", "E", "D > E", "// keep me", ""));
});

test("fix round 2, N6: Delete with contents keeps the part of a chain that does not touch what goes", () => {
  const text = lines('diagram flow "x"', "D", "E", "G {", "  A", "  D > E > A", "}");
  expect(apply(text, { op: "deleteGroup", name: "G" }).text).toBe(lines('diagram flow "x"', "D", "E", "D > E"));
});

test("fix round 2, N7: deleting a group's last shape keeps the group's braces", () => {
  const text = lines('diagram flow "x"', "B", "G {", "  A", "}", "", "B > A");
  expect(apply(text, { op: "deleteNode", name: "A" }).text).toBe(lines('diagram flow "x"', "B", "G {", "}", ""));
});
