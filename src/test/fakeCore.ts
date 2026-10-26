import type { DialectKind, NoWhere, PlannedRun } from "../api/types";
import { splitStatements } from "../query/statements";
import { tokenize } from "../lang/sql/tokens";

/**
 * TEST ONLY: a stand-in for the Core's `plan_run` (`safety::plan_run`), which decides what runs and when the
 * missing-WHERE ask comes. It knows plain SQL only; tests about the hard inputs route the Core's own answer, taken
 * from its Rust tests.
 */
export function fakePlan(
  statements: string[],
  dialect: DialectKind = "postgres",
  noWhere: (sql: string) => NoWhere | null = fakeNoWhere,
  delimiters: string[] = [],
): PlannedRun[] {
  return statements.flatMap((sql, piece) =>
    splitStatements(sql, dialect, delimiters[piece] ?? ";").map((s) => ({ text: s.text, piece, from: s.from, to: s.to, noWhere: noWhere(s.text) })),
  );
}

/** TEST ONLY: an UPDATE or DELETE with no WHERE outside parentheses, for plain test SQL. */
export function fakeNoWhere(sql: string): NoWhere | null {
  const toks = tokenize(sql, "postgres").filter((t) => t.t !== "ws" && t.t !== "comment");
  let depth = 0;
  const top = toks.filter((t) => {
    if (t.v === "(") depth++;
    else if (t.v === ")") depth--;
    else return depth === 0;
    return false;
  });
  const verb = top[0]?.v.toUpperCase();
  if ((verb !== "UPDATE" && verb !== "DELETE") || top.some((t) => t.t === "word" && t.v.toUpperCase() === "WHERE")) return null;
  let i = 1;
  while (i < top.length && ["FROM", "ONLY", "LOW_PRIORITY", "IGNORE", "QUICK"].includes(top[i].v.toUpperCase())) i++;
  let table = top[i]?.v ?? "";
  while (top[i + 1]?.v === "." && top[i + 2]) {
    table += `.${top[i + 2].v}`;
    i += 2;
  }
  return { verb, table, text: sql.trim() };
}
