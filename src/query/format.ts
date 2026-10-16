import type { DialectKind } from "../api/types";
import { type Token, tokenize } from "../lang/sql/tokens";

const KEYWORDS = new Set(
  `select from where and or not in is null as on join left right inner outer full cross group by order
   having limit offset insert into values update set delete with recursive distinct case when then else
   end like ilike between exists union all asc desc true false returning create table view index drop
   alter add column primary key foreign references default unique check constraint using natural
   lateral interval cast begin commit rollback over partition window filter`
    .split(/\s+/)
    .filter(Boolean),
);

/** Clauses that start a new line. A JOIN's LEFT/RIGHT/INNER/FULL/CROSS breaks before itself. */
const BREAK = new Set(["FROM", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "VALUES", "SET", "RETURNING", "JOIN"]);
const JOIN_LEAD = new Set(["LEFT", "RIGHT", "INNER", "FULL", "CROSS", "NATURAL"]);

/** Keywords UPPERCASE and each clause on its own line. Strings, names and comments are untouched. */
export function formatSql(text: string, dialect: DialectKind): string {
  const tokens: Token[] = tokenize(text, dialect).map((t) =>
    t.t === "word" && KEYWORDS.has(t.v.toLowerCase()) ? { ...t, v: t.v.toUpperCase() } : t,
  );
  const words = tokens.map((t, i) => ({ t, i })).filter(({ t }) => t.t !== "ws" && t.t !== "comment");
  const breakAt = new Set<number>();
  words.forEach(({ t, i }, k) => {
    if (k === 0 || t.t !== "word") return;
    const prev = words[k - 1].t.v;
    if (t.v === "JOIN") {
      // Break before the JOIN's lead words instead, such as LEFT OUTER JOIN.
      let m = k;
      while (m > 0 && (JOIN_LEAD.has(words[m - 1].t.v) || words[m - 1].t.v === "OUTER")) m--;
      if (m > 0) breakAt.add(words[m].i);
      return;
    }
    if (BREAK.has(t.v) && !(t.v === "SET" && prev === "CHARACTER")) breakAt.add(i);
  });
  let out = "";
  tokens.forEach((t, i) => {
    if (t.t === "ws" && breakAt.has(i + 1)) {
      out += t.v.includes("\n") ? t.v : "\n";
      return;
    }
    if (breakAt.has(i) && tokens[i - 1]?.t !== "ws") out += "\n";
    out += t.v;
  });
  return out;
}
