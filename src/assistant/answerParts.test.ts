import { expect, test } from "vitest";
import { answerParts } from "./answerParts";

test("fenced_sql_splits_out", () => {
  expect(answerParts("Use this:\n```sql\nSELECT 1\n```\nDone")).toEqual([
    { kind: "text", text: "Use this:" },
    { kind: "sql", sql: "SELECT 1" },
    { kind: "text", text: "Done" },
  ]);
});

test("untagged_fences_count_as_sql_and_other_languages_stay_text", () => {
  expect(answerParts("```\nSELECT 2\n```")).toEqual([{ kind: "sql", sql: "SELECT 2" }]);
  expect(answerParts("```json\n{}\n```")).toEqual([{ kind: "text", text: "```json\n{}\n```" }]);
});

test("text_without_fences_is_one_part", () => {
  expect(answerParts("Just words.")).toEqual([{ kind: "text", text: "Just words." }]);
});

test("an_unclosed_fence_stays_text", () => {
  expect(answerParts("Try\n```sql\nSELECT 1")).toEqual([{ kind: "text", text: "Try\n```sql\nSELECT 1" }]);
});
