import { significant, tokenize } from "./sqlTokens";

/** Words that may sit between UPDATE or DELETE and the table name. */
const MODIFIERS = new Set(["LOW_PRIORITY", "IGNORE", "QUICK", "ONLY", "FROM"]);

/**
 * An UPDATE or DELETE with no WHERE at its top level, which changes every row.
 * A WHERE inside parentheses, such as in a subquery, does not count.
 */
export function writeWithoutWhere(sql: string): { verb: "UPDATE" | "DELETE"; table: string } | null {
  // The MySQL tokenizer also treats `#` as a comment, which no other Dialect uses as SQL.
  const toks = significant(tokenize(sql, "mysql"));
  const first = toks[0]?.v.toUpperCase();
  if (first !== "UPDATE" && first !== "DELETE") return null;
  let i = 1;
  while (i < toks.length && toks[i].t === "word" && MODIFIERS.has(toks[i].v.toUpperCase())) i++;
  let table = "";
  while (i < toks.length && (toks[i].t === "word" || toks[i].t === "quoted")) {
    table += toks[i].v;
    if (toks[i + 1]?.v === "." && toks[i + 2]) {
      table += ".";
      i += 2;
    } else {
      i++;
      break;
    }
  }
  let depth = 0;
  for (const t of toks.slice(i)) {
    if (t.v === "(") depth++;
    else if (t.v === ")") depth--;
    else if (depth === 0 && t.t === "word" && t.v.toUpperCase() === "WHERE") return null;
  }
  return { verb: first, table };
}
