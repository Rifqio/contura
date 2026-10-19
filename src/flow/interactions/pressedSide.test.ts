import { expect, test } from "vitest";
import { pressedSide } from "./ConnectionLine";

test("item_18_the_pressed_handle_names_the_side", () => {
  expect(pressedSide("r", "left")).toBe("r");
  expect(pressedSide("t", "right")).toBe("t");
  expect(pressedSide(null, "bottom")).toBe("b");
  expect(pressedSide(undefined, "left")).toBe("l");
});
