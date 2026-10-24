import { describe, expect, it, test } from "vitest";
import {
  filterForValue,
  filterCondition,
  filterProblem,
  filterSentence,
  filtersSql,
  filterWords,
  quickDays,
  type RowFilter,
  sortWords,
  valueKind,
} from "./rowFilters";

const f = (column: string, op: RowFilter["op"], value = "", value2?: string): RowFilter => ({ id: "x", column, op, value, value2 });

test("a_column_type_picks_how_it_is_filtered", () => {
  expect(valueKind("int unsigned")).toBe("number");
  expect(valueKind("numeric(10,2)")).toBe("number");
  expect(valueKind("timestamptz")).toBe("date");
  expect(valueKind("datetime")).toBe("date");
  expect(valueKind("boolean")).toBe("boolean");
  expect(valueKind("tinyint(1)")).toBe("boolean");
  expect(valueKind("varchar(80)")).toBe("text");
});

test("conditions_become_quoted_sql_per_dialect", () => {
  expect(filterCondition("postgres", "number", f("total", "gte", "500"))).toBe('"total" >= 500');
  expect(filterCondition("mysql", "text", f("status", "eq", "it's"))).toBe("`status` = 'it''s'");
  // A backslash goes as hex, which reads the same with NO_BACKSLASH_ESCAPES on or off; Postgres uses E''.
  expect(filterCondition("mysql", "text", f("note", "contains", "a\\b"))).toBe("LOCATE(_utf8mb4 X'615c62', `note`) > 0");
  expect(filterCondition("postgres", "text", f("note", "eq", "\\' OR 1=1 --"))).toBe(`"note" = E'\\\\'' OR 1=1 --'`);
  expect(filterCondition("postgres", "text", f("note", "contains", "late"))).toBe(`strpos("note"::text, 'late') > 0`);
  expect(filterCondition("sqlite", "text", f("note", "startsWith", "Re"))).toBe(`substr("note", 1, 2) = 'Re'`);
  expect(filterCondition("postgres", "text", f("note", "endsWith", "yet"))).toBe(`right("note"::text, 3) = 'yet'`);
  expect(filterCondition("postgres", "boolean", f("paid", "isTrue"))).toBe('"paid" = TRUE');
  expect(filterCondition("mysql", "boolean", f("paid", "isFalse"))).toBe("`paid` = 0");
  expect(filterCondition("postgres", "text", f("paid_at", "null"))).toBe('"paid_at" IS NULL');
  // A day takes all of its times.
  expect(filterCondition("postgres", "date", f("issued_at", "on", "2026-10-01"))).toBe(`"issued_at" >= '2026-10-01' AND "issued_at" < '2026-10-02'`);
  expect(filterCondition("postgres", "date", f("issued_at", "onOrBefore", "2026-12-31"))).toBe(`"issued_at" < '2027-01-01'`);
  expect(filterCondition("mysql", "date", f("d", "between", "2026-01-01", "2026-01-31"))).toBe("`d` >= '2026-01-01' AND `d` < '2026-02-01'");
  expect(filterCondition("mysql", "number", f("n", "between", "1", "9"))).toBe("`n` BETWEEN 1 AND 9");
  // A name with a quote in it stays one name.
  expect(filterCondition("postgres", "number", f('we"ird', "eq", "1"))).toBe('"we""ird" = 1');
});

test("a_value_that_does_not_fit_says_so_and_writes_nothing", () => {
  expect(filterProblem("number", { op: "gte", value: "five" })).toBe("Enter a number, such as 500 or 12.5.");
  expect(filterProblem("date", { op: "on", value: "2026-02-30" })).toBe("Enter a date as YYYY-MM-DD, such as 2026-10-01.");
  expect(filterProblem("text", { op: "contains", value: "" })).toBe("Enter the text to look for.");
  expect(filterProblem("text", { op: "eq", value: "" })).toBeNull();
  expect(filterProblem("number", { op: "null", value: "" })).toBeNull();
  expect(filterCondition("postgres", "number", f("n", "gt", "1; DROP TABLE x"))).toBeNull();
});

test("filters_join_with_and", () => {
  const kind = (c: string) => (c === "total" ? "number" : "text");
  expect(filtersSql("postgres", [], kind)).toBeNull();
  expect(filtersSql("postgres", [f("total", "gte", "500")], kind)).toBe('"total" >= 500');
  expect(filtersSql("postgres", [f("status", "eq", "overdue"), f("total", "gte", "500")], kind)).toBe(`("status" = 'overdue') AND ("total" >= 500)`);
});

test("chips_and_sentences_read_as_words", () => {
  expect(filterWords("date", f("issued_at", "onOrAfter", "2026-10-01"))).toEqual({ column: "issued_at", condition: "is on or after", value: "Oct 1, 2026" });
  expect(filterSentence("number", f("total", "gte", "500"))).toBe("Shows rows where total is at least 500.");
  expect(filterSentence("text", f("paid_at", "null"))).toBe("Shows rows where paid_at is NULL.");
  expect(sortWords("date", true)).toBe("newest first");
  expect(sortWords("text", false)).toBe("A to Z");
  expect(quickDays(new Date(2026, 9, 19))).toEqual([
    { label: "Today", value: "2026-10-19" },
    { label: "Start of this month", value: "2026-10-01" },
    { label: "30d ago", value: "2026-09-19" },
  ]);
});

describe("G13: a filter from a cell's value", () => {
  it("M11: a timestamp filters by the exact value shown, with its offset, as DataGrip and DBeaver do", () => {
    const shown = "2026-10-01 23:30:00.123456+07";
    const f = { id: "f1", ...filterForValue("at", "date", { t: "text", value: shown, truncated: false, totalBytes: shown.length })! };
    expect(f.op).toBe("eq");
    // The offset makes it one instant whatever the session's time zone; the day is not taken.
    expect(filterCondition("postgres", "date", f)).toBe(`"at" = '2026-10-01 23:30:00.123456+07'`);
    expect(filterCondition("mysql", "date", { ...f, value: "2026-10-01 23:30:00" })).toBe("`at` = '2026-10-01 23:30:00'");
    expect(filterWords("date", f)).toEqual({ column: "at", condition: "is", value: shown });
    // A date alone is exact too.
    expect(filterCondition("sqlite", "date", { ...f, value: "2026-10-01" })).toBe(`"at" = '2026-10-01'`);
    expect(filterProblem("date", { op: "eq", value: "yesterday" })).not.toBeNull();
  });

  const text = (value: string) => ({ t: "text" as const, value, truncated: false, totalBytes: value.length });
  it("is the column's own condition for its kind, NULL as is NULL", () => {
    expect(filterForValue("status", "text", text("paid"))).toEqual({ column: "status", op: "eq", value: "paid" });
    expect(filterForValue("total", "number", { t: "number", value: "58.00" })).toEqual({ column: "total", op: "eq", value: "58.00" });
    expect(filterForValue("at", "date", text("2026-10-01 09:14:07+07"))).toEqual({ column: "at", op: "eq", value: "2026-10-01 09:14:07+07" });
    expect(filterForValue("ok", "boolean", text("t"))).toEqual({ column: "ok", op: "isTrue", value: "" });
    expect(filterForValue("ok", "boolean", text("false"))).toEqual({ column: "ok", op: "isFalse", value: "" });
    expect(filterForValue("at", "date", { t: "null" })).toEqual({ column: "at", op: "null", value: "" });
    expect(filterForValue("note", "text", { t: "text", value: "a long", truncated: true, totalBytes: 900 })).toEqual({ column: "note", op: "startsWith", value: "a long" });
    expect(filterForValue("data", "text", { t: "bytes", previewHex: "ff", truncated: false, totalBytes: 1 })).toBeNull();
  });
});
