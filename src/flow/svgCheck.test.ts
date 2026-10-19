import { expect, test } from "vitest";
import fixtures from "../../crates/contura-core/tests/fixtures/svg-check.json";
import { unsafeReason } from "../../scripts/svg-check.mjs";

// The pack script's SVG check against the list the Core's `unsafe_reason` is tested with
// (crates/contura-core/tests/icons.rs), so both give the same answer (Ruling P9).

const bytes = (text: string) => new TextEncoder().encode(text);

test("the_script_check_refuses_the_shared_list_with_the_core_reasons", () => {
  for (const { svg, why } of fixtures.refused) expect(unsafeReason(bytes(svg)), svg).toBe(why);
});

test("the_script_check_keeps_the_shared_list", () => {
  for (const svg of fixtures.kept) expect(unsafeReason(bytes(svg)), svg).toBeNull();
});

test("the_script_check_refuses_256_kb_and_more_and_non_utf8", () => {
  const under = `<svg>${" ".repeat(256 * 1024 - 12)}</svg>`;
  expect(unsafeReason(bytes(under))).toBeNull();
  expect(unsafeReason(bytes(`<svg>${" ".repeat(256 * 1024 - 11)}</svg>`))).toBe("over 256 KB");

  const text = "<svg><script/></svg>";
  const utf16 = new Uint8Array(2 + text.length * 2);
  utf16.set([0xff, 0xfe]);
  for (let i = 0; i < text.length; i++) utf16[2 + i * 2] = text.charCodeAt(i);
  expect(unsafeReason(utf16)).toBe("not UTF-8");
});
