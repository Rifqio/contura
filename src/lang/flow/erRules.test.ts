// The ER rules the Core's diagram tool checks against (Plan D Decision 3): one fixture, read here and by
// `rust_rules_match_the_fixture`, so the two sides cannot drift.
import { expect, test } from "vitest";
import kinds from "../../../crates/contura-core/tests/fixtures/flow/kinds.json";
import rules from "../../../crates/contura-core/tests/fixtures/flow/er_rules.json";
import { COLUMN_FLAGS, COLUMN_NAME, DIAGRAM_KINDS, isColumnName, KINDS } from "./model";

test("er_rules_match_the_language", () => {
  expect([...COLUMN_FLAGS]).toEqual(rules.flags);
  expect([...DIAGRAM_KINDS]).toEqual(rules.kinds);
  expect(COLUMN_NAME.source).toBe(rules.name);
  expect(COLUMN_NAME.flags).toBe("");
  for (const name of ["id", "_x", "a1_b", "A", "", "1a", "a-b", "a b", "é", "a.b"]) expect(isColumnName(name)).toBe(new RegExp(rules.name).test(name));
});

test("shape_kinds_match_the_language", () => {
  // The Core fills a new frame's shape kinds from this fixture.
  expect(Object.keys(kinds)).toEqual([...DIAGRAM_KINDS]);
  expect(kinds).toEqual(Object.fromEntries(DIAGRAM_KINDS.map((k) => [k, [...KINDS[k]]])));
});
