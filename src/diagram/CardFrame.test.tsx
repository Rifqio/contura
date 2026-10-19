import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import CardFrame, { draggedWidth, MAX_CARD_WIDTH, MIN_CARD_WIDTH } from "./CardFrame";

test("item_25_a_right_corner_grows_right_and_a_left_corner_grows_left_within_bounds", () => {
  expect(draggedWidth(216, "se", 40)).toEqual({ width: 256, shift: 0 });
  expect(draggedWidth(216, "nw", -40)).toEqual({ width: 256, shift: -40 });
  expect(draggedWidth(216, "ne", -500).width).toBe(MIN_CARD_WIDTH);
  expect(draggedWidth(216, "sw", -900).width).toBe(MAX_CARD_WIDTH);
});

test("item_25_handles_show_only_where_they_resize", () => {
  const props = { kind: "table" as const, title: "orders", rows: null, count: 0, selected: true, width: 216 };
  const { container, rerender } = render(<CardFrame {...props} />);
  expect(container.querySelectorAll(".selbox i")).toHaveLength(0);
  expect(container.querySelector(".selbox")).toBeTruthy();
  rerender(<CardFrame {...props} onResize={() => {}} />);
  expect(container.querySelectorAll(".selbox i")).toHaveLength(4);
});
