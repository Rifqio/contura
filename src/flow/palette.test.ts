import { expect, test } from "vitest";
import { colourClass, colourStroke, colourStyle, colourVars, drawnColour, presetOf } from "./palette";

test("a_custom_colour_draws_outline_tint_and_theme_words", () => {
  expect(colourVars("#3b82f6")).toEqual({
    "--col-fill": "color-mix(in srgb, #3b82f6 18%, var(--c-bg-surface))",
    "--col-edge": "#3b82f6",
    "--col-words": "var(--c-text)",
  });
  expect(drawnColour("Teal")).toBe("#008080");
  expect(drawnColour("info")).toBe("info");
  expect(drawnColour("blurple")).toBeUndefined();
});

test("a_dark_custom_colour_keeps_readable_words", () => {
  expect(colourStyle("#111111").color).toBe("var(--c-text)");
});

test("a_preset_keeps_its_class_and_stroke_and_a_hex_has_neither_suffix", () => {
  expect(presetOf("danger")).toBe("danger");
  expect(presetOf("#3b82f6")).toBeUndefined();
  expect(presetOf(undefined)).toBeUndefined();
  expect(colourClass("danger")).toBe("is-col is-col-danger");
  expect(colourClass("#3b82f6")).toBe("is-col");
  expect(colourStroke("#3b82f6")).toBe("#3b82f6");
  expect(colourStroke("danger")).toMatch(/^var\(--/);
});
