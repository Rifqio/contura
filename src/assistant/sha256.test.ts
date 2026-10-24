import { expect, test } from "vitest";
import shared from "../../crates/contura-core/tests/fixtures/ai/answer_fences.json";
import { sha256Hex } from "./sha256";

test("sha256Hex matches the Core's hash of a block body", () => {
  // The same pairs the Core's `each_block_carries_the_hash_of_the_body_it_checked` reads.
  for (const [text, hex] of shared.sha256) expect(sha256Hex(text), JSON.stringify(text)).toBe(hex);
  // The standard vector, and a text over one 64-byte block with multi-byte characters.
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex("ü".repeat(100))).toHaveLength(64);
});
