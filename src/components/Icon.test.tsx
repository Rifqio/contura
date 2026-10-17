import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import Icon from "./Icon";

/** H4, Q3: the "..." icons draw three r=1 rings (Lucide ellipsis), not zero-length segments that render as 1 px specks. */
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
