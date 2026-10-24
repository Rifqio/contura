// UX step 8 (security): the one SQL string literal the UI writes, the Core's `common.rs::sql_string` to the byte. Both
// are tested against one fixture, so they cannot drift.
import { expect, test } from "vitest";
import cases from "../../crates/contura-core/tests/fixtures/sql_string_cases.json";
import { filtersSql, quoteText } from "./rowFilters";
import { rowFiltersOf } from "./foreignKeys";
import { sqlString } from "./sqlString";

const DIALECTS = ["postgres", "mysql", "sqlite"] as const;

test("every_fixture_value_is_written_as_the_core_writes_it", () => {
  expect(cases.cases.length).toBeGreaterThan(8);
  for (const c of cases.cases) for (const d of DIALECTS) expect([d, c.value, sqlString(d, c.value)]).toEqual([d, c.value, c[d]]);
});

test("a_backslash_never_ends_a_literal", () => {
  // Postgres with standard_conforming_strings off reads \' as a quote: E'' doubles the backslash.
  expect(sqlString("postgres", "\\' OR 1=1 --")).toBe("E'\\\\'' OR 1=1 --'");
  // MySQL sends it as hex, so NO_BACKSLASH_ESCAPES on or off reads it the same.
  expect(sqlString("mysql", "\\' OR 1=1 --")).toBe("_utf8mb4 X'5c27204f5220313d31202d2d'");
  expect(sqlString("sqlite", "\\' OR 1=1 --")).toBe("'\\'' OR 1=1 --'");
});

test("the_filter_bar_writes_its_values_with_the_same_escaper", () => {
  for (const c of cases.cases) for (const d of DIALECTS) expect(quoteText(d, c.value)).toBe(c[d]);
});

test("a_key_cell_holding_a_breakout_filters_on_its_exact_text", () => {
  const key = rowFiltersOf([{ column: "email", value: "\\' OR 1=1 --" }]);
  const lit = (d: (typeof DIALECTS)[number]) => cases.cases.find((c) => c.value === "\\' OR 1=1 --")![d];
  expect(filtersSql("postgres", key, () => "text")).toBe(`"email" = ${lit("postgres")}`);
  expect(filtersSql("mysql", key, () => "text")).toBe(`\`email\` = ${lit("mysql")}`);
  expect(filtersSql("sqlite", key, () => "text")).toBe(`"email" = ${lit("sqlite")}`);
});
