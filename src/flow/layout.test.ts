import { expect, test } from "vitest";
import { parseFlowLayout, serializeFlowLayout } from "./layout";

test("a_missing_or_unreadable_layout_gets_every_default", () => {
  for (const json of [null, "", "{", "[]", '{"version":2}']) {
    expect(parseFlowLayout(json, "dfd")).toEqual({ version: 1, nodes: {}, style: "modern", direction: "LR" });
  }
  // A flowchart runs top to bottom unless its layout says otherwise (answer 7A).
  expect(parseFlowLayout(null, "flow").direction).toBe("TB");
  expect(parseFlowLayout(null, null).direction).toBe("TB");
});

test("the_layout_file_keeps_style_direction_viewport_and_positions", () => {
  const json = JSON.stringify({
    version: 1,
    nodes: { b: { x: 2, y: 3 }, a: { x: 0, y: 1 }, bad: { x: "no" } },
    viewport: { x: 1, y: 2, zoom: 0.5 },
    style: "classic",
    direction: "LR",
  });
  const l = parseFlowLayout(json, "flow");
  expect(l).toEqual({ version: 1, nodes: { a: { x: 0, y: 1 }, b: { x: 2, y: 3 } }, viewport: { x: 1, y: 2, zoom: 0.5 }, style: "classic", direction: "LR" });
  expect(parseFlowLayout(serializeFlowLayout(l), "flow")).toEqual(l);
  // Stable key order, sorted positions and a final line break, so the file diffs well.
  expect(serializeFlowLayout(l)).toBe(
    `${JSON.stringify({ version: 1, nodes: { a: { x: 0, y: 1 }, b: { x: 2, y: 3 } }, viewport: { x: 1, y: 2, zoom: 0.5 }, style: "classic", direction: "LR" }, null, 2)}\n`,
  );
  // Unknown values fall back to the defaults.
  expect(parseFlowLayout('{"version":1,"nodes":{},"style":"fancy","direction":"RL"}', "flow")).toEqual({
    version: 1,
    nodes: {},
    style: "modern",
    direction: "TB",
  });
});

test("positions_named___proto___are_plain_keys", () => {
  const l = parseFlowLayout('{"version":1,"nodes":{"__proto__":{"x":1,"y":2},"constructor":{"x":3,"y":4}}}', "dfd");
  expect(Object.keys(l.nodes).sort()).toEqual(["__proto__", "constructor"]);
  expect(l.nodes["__proto__"]).toEqual({ x: 1, y: 2 });
  expect(serializeFlowLayout(l)).toContain('"__proto__"');
});
