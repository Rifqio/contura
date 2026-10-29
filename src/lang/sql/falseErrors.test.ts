// Valid SQL never gets an error squiggle, and a near miss still does (owner, 29 Oct). The corpus is in
// falseErrors.corpus.ts, one list per Dialect.
import { expect, test } from "vitest";
import { analyzeSql } from "./analyze";
import { MISSES, VALID, WORDS_SCHEMA } from "./falseErrors.corpus";

const errors = (sql: string, d: "mysql" | "postgres" | "sqlite") =>
  analyzeSql(sql, d, WORDS_SCHEMA)
    .problems.filter((p) => p.severity === "error")
    .map((p) => `${p.message} [${sql.slice(p.from, p.to)}]`);

test.each(VALID.mysql)("mysql valid, $c: $sql", ({ sql }) => {
  expect(errors(sql, "mysql")).toEqual([]);
});

test.each(VALID.postgres)("postgres valid, $c: $sql", ({ sql }) => {
  expect(errors(sql, "postgres")).toEqual([]);
});

test.each(VALID.sqlite)("sqlite valid, $c: $sql", ({ sql }) => {
  expect(errors(sql, "sqlite")).toEqual([]);
});

/** The near miss's message, without its "Did you mean", is among the errors. */
const reports = (sql: string, d: "mysql" | "postgres" | "sqlite", error: string) => {
  const want = error.split(" Did you mean")[0];
  const got = analyzeSql(sql, d, WORDS_SCHEMA).problems.filter((p) => p.severity === "error").map((p) => p.message);
  expect(got.some((m) => m.split(" Did you mean")[0] === want), `${want} in ${JSON.stringify(got)}`).toBe(true);
};

test.each(MISSES.mysql)("mysql near miss, $c: $sql", ({ sql, error }) => reports(sql, "mysql", error));
test.each(MISSES.postgres)("postgres near miss, $c: $sql", ({ sql, error }) => reports(sql, "postgres", error));
test.each(MISSES.sqlite)("sqlite near miss, $c: $sql", ({ sql, error }) => reports(sql, "sqlite", error));
