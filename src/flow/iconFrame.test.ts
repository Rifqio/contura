// @vitest-environment node
import { expect, test } from "vitest";
import { frameRoot, rootTag } from "../../scripts/icon-frame.mjs";
import { unsafeReason } from "../../scripts/svg-check.mjs";

const enc = (s: string) => new TextEncoder().encode(s);
const byteAt = (svg: string, at: number) => new TextDecoder().decode(enc(svg).subarray(at, at + 1));

const LUCIDE = `<!-- @license lucide-static v1.61.0 - ISC -->\n<svg\n  class="lucide lucide-database"\n  xmlns="http://www.w3.org/2000/svg"\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  stroke="currentColor"\n  stroke-width="2"\n  stroke-linecap="round"\n  stroke-linejoin="round"\n>\n  <ellipse cx="12" cy="5" rx="9" ry="3" />\n</svg>\n`;

test("lucide_gets_stroke_1_5_and_keeps_its_box", () => {
  const out = frameRoot(LUCIDE, { pad: 0, stroke: "1.5", ink: "outline" });
  if ("refused" in out) throw new Error(out.refused);
  const tag = rootTag(out.svg)!;
  expect(Object.fromEntries(tag.attrs)).toMatchObject({ width: "24", height: "24", viewBox: "0 0 24 24", "stroke-width": "1.5", stroke: "currentColor" });
  expect(out.svg.slice(0, tag.start)).toBe(LUCIDE.slice(0, rootTag(LUCIDE)!.start)); // licence comment kept
  expect(out.svg.slice(tag.end)).toBe(LUCIDE.slice(rootTag(LUCIDE)!.end)); // drawing byte for byte
  expect(byteAt(out.svg, out.inkAt!)).toBe(">");
});

test("a_logo_gets_currentColor_fill_and_a_20_of_24_fit", () => {
  const out = frameRoot(`<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>X</title><path d="M0 0h24v24H0z"/></svg>`, { pad: 1 / 12, ink: "mono" });
  if ("refused" in out) throw new Error(out.refused);
  expect(Object.fromEntries(rootTag(out.svg)!.attrs)).toMatchObject({ viewBox: "-2.4 -2.4 28.8 28.8", fill: "currentColor", role: "img" });
});

test("vendor_roots_of_every_shape_fit_the_frame", () => {
  const box = (svg: string, pad = 0) => {
    const out = frameRoot(svg, { pad });
    if ("refused" in out) throw new Error(out.refused);
    expect(out.inkAt).toBeNull();
    return Object.fromEntries(rootTag(out.svg)!.attrs);
  };
  expect(box(`<?xml version="1.0" encoding="UTF-8"?>\n<svg width="80px" height="80px" viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><g/></svg>`)).toMatchObject({ width: "24", height: "24", viewBox: "0 0 80 80" });
  expect(box(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g/></svg>`, 1 / 12).viewBox).toBe("-51.2 -51.2 614.4 614.4");
  expect(box(`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><g/></svg>`).viewBox).toBe("0 0 18 18");
  expect(box(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><g/></svg>`).viewBox).toBe("0 -25 100 100");
  expect(box(`<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 18.035 17.5"><g/></svg>`).viewBox).toBe("0 -0.2675 18.035 18.035");
});

test("roots_the_framer_cannot_fit_are_refused", () => {
  expect(frameRoot(`<g/>`, { pad: 0 })).toMatchObject({ refused: "no root svg" });
  expect(frameRoot(`<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>`, { pad: 0 })).toEqual({ refused: "no size" });
  expect(frameRoot(`<svg width="100%" height="100%"><g/></svg>`, { pad: 0 })).toEqual({ refused: "relative size" });
  expect(frameRoot(`<svg viewBox="0 0 2 1" preserveAspectRatio="none"><g/></svg>`, { pad: 0 })).toEqual({ refused: "aspect ratio" });
  expect(frameRoot(`<svg viewBox="0 0 24 24" data-name='a"b'><g/></svg>`, { pad: 0 })).toEqual({ refused: "quote in a value" });
  expect(frameRoot(`<svg viewBox="0 0 24 24" stroke-width="2"><path stroke-width="3"/></svg>`, { pad: 0, stroke: "1.5" })).toEqual({ refused: "stroke width inside" });
});

test("framed_and_inked_icons_pass_the_allow_list", () => {
  const out = frameRoot(LUCIDE, { pad: 0, stroke: "1.5", ink: "outline" });
  if ("refused" in out) throw new Error(out.refused);
  const bytes = enc(out.svg);
  const inked = new Uint8Array([...bytes.subarray(0, out.inkAt!), ...enc(' color="#f8f8f2"'), ...bytes.subarray(out.inkAt!)]);
  expect(unsafeReason(bytes)).toBeNull();
  expect(unsafeReason(inked)).toBeNull(); // passes once Task 3 lists `color`
});

test("the_root_is_found_through_a_bom_comments_a_doctype_and_odd_quoting", () => {
  const text = `﻿<?xml version='1.0'?>\n<!-- <svg viewBox="0 0 1 1"> -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [ <!ENTITY a "b>"> ]>\n  <svg\n\tviewBox = '0 0 10 10'\n  stroke-width\n=\n"3"\n data-note='a > b'>\n<g/></svg>`;
  const tag = rootTag(text)!;
  expect(tag.attrs).toEqual([["viewBox", "0 0 10 10"], ["stroke-width", "3"], ["data-note", "a > b"]]);
  expect(text.slice(tag.end)).toBe("\n<g/></svg>");
  const out = frameRoot(text, { pad: 0, stroke: "1.5", ink: "mono" });
  if ("refused" in out) throw new Error(out.refused);
  expect(out.svg.slice(0, tag.start)).toBe(text.slice(0, tag.start));
  expect(Object.fromEntries(rootTag(out.svg)!.attrs)).toMatchObject({ "stroke-width": "1.5", "data-note": "a > b", fill: "currentColor", viewBox: "0 0 10 10" });
  expect(byteAt(out.svg, out.inkAt!)).toBe(">");
});

test("attributes_in_any_order_keep_their_place_and_a_stroke_is_appended_when_absent", () => {
  const out = frameRoot(`<svg viewBox="0 0 8 8" stroke="currentColor" data-a="1"><g/></svg>`, { pad: 0, stroke: "1.5", ink: "outline" });
  if ("refused" in out) throw new Error(out.refused);
  expect(rootTag(out.svg)!.attrs.map(([n]) => n)).toEqual(["stroke", "data-a", "stroke-width", "width", "height", "viewBox"]);
});

test("roots_that_cannot_be_read_with_certainty_are_not_found", () => {
  for (const bad of [`<svg viewBox=0>`, `<svg a="1" a="2">`, `<svg a="1"b="2">`, `<svg a="1"/>`, `<svg a="1`, `<!-- open <svg>`, `<html><svg></svg></html>`, `<svgx viewBox="0 0 1 1">`, ``]) {
    expect(rootTag(bad)).toBeNull();
    expect(frameRoot(bad, { pad: 0 })).toMatchObject({ refused: "no root svg" });
  }
});

test("sizes_are_read_strictly", () => {
  expect(frameRoot(`<svg viewBox="0 0 0 5"/>`.replace("/>", "><g/></svg>"), { pad: 0 })).toEqual({ refused: "no size" });
  expect(frameRoot(`<svg width="2em" height="2em"><g/></svg>`, { pad: 0 })).toEqual({ refused: "no size" });
  expect(frameRoot(`<svg viewBox="0 0 2 1" preserveAspectRatio="xMidYMid  meet"><g/></svg>`, { pad: 0 })).toMatchObject({ svg: expect.any(String) });
  expect(frameRoot(`<svg viewBox="0 0 2 1" preserveAspectRatio="xMinYMin"><g/></svg>`, { pad: 0 })).toEqual({ refused: "aspect ratio" });
});

test("a_pad_outside_0_to_under_half_is_a_script_error", () => {
  for (const pad of [-0.01, 0.5, 0.7, NaN, Infinity]) expect(() => frameRoot(`<svg viewBox="0 0 1 1"><g/></svg>`, { pad })).toThrow(/pad/);
});

test("non_finite_or_degenerate_viewBox_and_sizes_are_refused", () => {
  for (const vb of ["0 0 1e999 5", "0 0 1e-7 5", "0 0 5 1e-7", "0 0 5 0", "0 0 -3 3", "1e999 0 5 5"]) {
    expect(frameRoot(`<svg viewBox="${vb}"><g/></svg>`, { pad: 0 })).toEqual({ refused: "no size" });
  }
  expect(frameRoot(`<svg width="1e-7" height="4"><g/></svg>`, { pad: 0 })).toEqual({ refused: "no size" });
  expect(frameRoot(`<svg width="1e999" height="4"><g/></svg>`, { pad: 0 })).toEqual({ refused: "no size" });
  expect(frameRoot(`<svg viewBox="0 0 0.0001 0.0001"><g/></svg>`, { pad: 0 })).toMatchObject({ svg: expect.any(String) });
});

test("a_root_with_its_own_color_records_no_ink_position", () => {
  const out = frameRoot(`<svg viewBox="0 0 8 8" color="red"><g/></svg>`, { pad: 0, ink: "outline" });
  if ("refused" in out) throw new Error(out.refused);
  expect(out.inkAt).toBeNull();
  expect(Object.fromEntries(rootTag(out.svg)!.attrs)).toMatchObject({ color: "red" });
  const mono = frameRoot(`<svg viewBox="0 0 8 8" color="red"><g/></svg>`, { pad: 0, ink: "mono" });
  expect(mono).toMatchObject({ inkAt: null });
});

test("a_mono_root_with_its_own_fill_keeps_it_and_still_records_ink", () => {
  const out = frameRoot(`<svg viewBox="0 0 8 8" fill="#123"><g/></svg>`, { pad: 0, ink: "mono" });
  if ("refused" in out) throw new Error(out.refused);
  expect(Object.fromEntries(rootTag(out.svg)!.attrs).fill).toBe("#123");
  expect(out.inkAt).not.toBeNull();
});

test("a_missing_root_refusal_carries_the_first_80_characters_for_the_log", () => {
  const text = "x".repeat(200);
  expect(frameRoot(text, { pad: 0 })).toEqual({ refused: "no root svg", head: "x".repeat(80) });
});
