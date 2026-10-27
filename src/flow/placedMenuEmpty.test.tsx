import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { PlacedMenu } from "./DiagramMenu";

test("a_placed_menu_with_no_items_renders_nothing_even_after_a_resize", () => {
  render(<PlacedMenu menu={{ x: 10, y: 10, label: "Shape", items: [] }} onClose={() => {}} />);
  window.dispatchEvent(new Event("resize"));
  expect(document.body.querySelector(".tree-menu, .menu")).toBeNull();
});
