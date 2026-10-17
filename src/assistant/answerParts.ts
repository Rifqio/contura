export type AnswerPart = { kind: "text"; text: string } | { kind: "sql"; sql: string };

const FENCE = /```(sql)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi;

/** Splits an answer into prose and fenced SQL blocks (tagged `sql` or untagged). */
export function answerParts(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  const pushText = (s: string) => {
    const t = s.trim();
    if (t) parts.push({ kind: "text", text: t });
  };
  let at = 0;
  for (const m of text.matchAll(FENCE)) {
    const start = m.index ?? 0;
    pushText(text.slice(at, start));
    const sql = m[2].trim();
    if (sql) parts.push({ kind: "sql", sql });
    at = start + m[0].length;
  }
  pushText(text.slice(at));
  return parts;
}
