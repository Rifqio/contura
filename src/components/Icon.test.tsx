import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import Icon from "./Icon";

/** The "..." icons draw three r=1 rings (Lucide ellipsis), not zero-length segments that render as 1 px specks. */
test.each([
  ["moreHorizontal", [["4", "12"], ["11", "12"], ["18", "12"]]],
  ["more", [["11", "5"], ["11", "12"], ["11", "19"]]],
] as const)("%s_draws_clear_dots", (name, starts) => {
  const { container } = render(<Icon name={name} />);
  const d = container.querySelector("path")!.getAttribute("d")!;
  expect(d).not.toMatch(/h\.01|v\.01/);
  const moves = [...d.matchAll(/M([\d.]+) ([\d.]+)a1 1 0 1 0 2 0a1 1 0 1 0 -2 0z/g)].map((m) => [m[1], m[2]]);
  expect(moves).toEqual(starts);
});

/** A sequence frame's kind glyphs and the Numbering toggle's, drawn on the same 24 px grid. */
test.each(["repeat", "split", "branch", "numbering"] as const)("%s_is_drawn_on_the_grid", (name) => {
  const { container } = render(<Icon name={name} />);
  const svg = container.querySelector("svg")!;
  expect(svg.getAttribute("data-icon")).toBe(name);
  expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  const d = container.querySelector("path")!.getAttribute("d")!;
  expect(d.length).toBeGreaterThan(10);
  // Every absolute move stays on the grid.
  for (const m of d.matchAll(/M([-\d.]+) ([-\d.]+)/g)) {
    expect(Number(m[1])).toBeGreaterThanOrEqual(0);
    expect(Number(m[1])).toBeLessThanOrEqual(24);
    expect(Number(m[2])).toBeGreaterThanOrEqual(0);
    expect(Number(m[2])).toBeLessThanOrEqual(24);
  }
});

test("numbering_is_a_circle_with_a_one", () => {
  const { container } = render(<Icon name="numbering" />);
  const d = container.querySelector("path")!.getAttribute("d")!;
  // A full circle (two half arcs), then the 1's flag and its stem.
  expect(d).toMatch(/^M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0z/);
  expect(d).toMatch(/V16/);
});
