// A `color:` value: any CSS colour name or hex beside the six presets.
import { describe, expect, test } from "vitest";
import { CSS_COLOURS, isColourValue, mixHex, readColour } from "./colours";

describe("colours", () => {
  test("css_names_are_the_148", () => {
    expect(CSS_COLOURS.size).toBe(148);
    expect(CSS_COLOURS.get("teal")).toBe("#008080");
    expect(CSS_COLOURS.get("rebeccapurple")).toBe("#663399");
    expect(CSS_COLOURS.get("grey")).toBe(CSS_COLOURS.get("gray"));
    expect(CSS_COLOURS.has("transparent")).toBe(false);
  });

  test("read_colour", () => {
    expect(readColour("Teal")).toEqual({ hex: "#008080" });
    expect(readColour("#FFF")).toEqual({ hex: "#ffffff" });
    expect(readColour("#ffffff80")).toEqual({ hex: "#ffffff80" });
    expect(readColour("info")).toEqual({ preset: "info" });
    expect(readColour("Info")).toBeNull();
    expect(readColour(undefined)).toBeNull();
    expect(readColour("#12345")).toBeNull();
    // Short hex with alpha grows to #rrggbbaa, and a hex is written in lower case.
    expect(readColour("#fff8")).toEqual({ hex: "#ffffff88" });
    expect(readColour("#FFFFFF80")).toEqual({ hex: "#ffffff80" });
    // CSS keywords that are not colours of their own are not read.
    expect(readColour("transparent")).toBeNull();
    expect(readColour("currentColor")).toBeNull();
    expect(isColourValue("red")).toBe(true);
    expect(isColourValue("blurple")).toBe(false);
  });

  test("mix_hex", () => {
    expect(mixHex("#000000", "#ffffff", 0.18)).toBe("#d1d1d1");
    expect(mixHex("#ff0000", "#000000", 0.5)).toBe("#800000");
    // An alpha pair is dropped.
    expect(mixHex("#000000cc", "#ffffff", 0.18)).toBe("#d1d1d1");
  });

  test("mix_hex_never_makes_nan", () => {
    // A surface that is not #rrggbb (a short hex, rgb(), color-mix()) leaves the colour as it is.
    for (const over of ["#fff", "rgb(255, 255, 255)", "color-mix(in srgb, red, blue)", ""]) expect(mixHex("#3b82f6", over, 0.18)).toBe("#3b82f6");
    expect(mixHex("#3b82f6cc", "#fff", 0.18)).toBe("#3b82f6");
    // A colour that is not #rrggbb comes back unchanged.
    expect(mixHex("#abc", "#ffffff", 0.18)).toBe("#abc");
    expect(mixHex("#zzzzzz", "#ffffff", 0.18)).toBe("#zzzzzz");
  });
});
