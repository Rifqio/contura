// A small SQL tokenizer for splitting statements, formatting and the missing-WHERE
// check. It only needs to know what is a comment, a string or a quoted name, so a
// semicolon or keyword inside one is never mistaken for SQL.
import type { DialectKind } from "../../api/types";

export type TokenKind = "comment" | "string" | "quoted" | "word" | "number" | "punct" | "ws";

export interface Token {
  t: TokenKind;
  v: string;
  from: number;
  to: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * Whether a MySQL `--` with `at` after it starts a comment: the server wants an ASCII blank or control character (or
 * the end) there, so a no-break space does not (the Core's `mysql_comment_after`).
 */
export function mysqlCommentAfter(text: string, at: number): boolean {
  return at >= text.length || text.charCodeAt(at) <= 0x20 || text.charCodeAt(at) === 0x7f;
}

/** Index after a quoted run starting at `i` with `q`; a doubled `q` stays inside. */
export function quotedEnd(text: string, i: number, q: string, backslash: boolean): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (backslash && c === "\\") {
      j += 2;
      continue;
    }
    if (c === q) {
      if (text[j + 1] === q) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return text.length;
}

/** Index after the block comment at `i`; PostgreSQL nests them, MySQL and SQLite end at the first close. */
function blockCommentEnd(text: string, i: number, nests: boolean): number {
  if (!nests) {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  let depth = 1;
  let j = i + 2;
  while (j < text.length) {
    if (text[j] === "/" && text[j + 1] === "*") {
      depth++;
      j += 2;
    } else if (text[j] === "*" && text[j + 1] === "/") {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else j++;
  }
  return text.length;
}

export function tokenize(text: string, dialect: DialectKind): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (t: TokenKind, to: number) => {
    out.push({ t, v: text.slice(i, to), from: i, to });
    i = to;
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "-" && next === "-" && (dialect !== "mysql" || mysqlCommentAfter(text, i + 2))) {
      // MySQL reads `--` as a comment only before an ASCII blank, a control character or the end: `1--1` is one minus another.
      const nl = text.indexOf("\n", i);
      push("comment", nl === -1 ? text.length : nl);
    } else if (c === "#" && dialect === "mysql") {
      const nl = text.indexOf("\n", i);
      push("comment", nl === -1 ? text.length : nl);
    } else if (c === "/" && next === "*") {
      push("comment", blockCommentEnd(text, i, dialect === "postgres"));
    } else if (c === "'") {
      // MySQL strings take backslash escapes; Postgres only in E'...' strings.
      const prev = text[i - 1];
      const escaped = dialect === "mysql" || (dialect === "postgres" && (prev === "E" || prev === "e"));
      push("string", quotedEnd(text, i, "'", escaped));
    } else if (c === '"') {
      push("quoted", quotedEnd(text, i, '"', dialect === "mysql"));
    } else if (c === "`") {
      push("quoted", quotedEnd(text, i, "`", false));
    } else if (c === "$" && dialect === "postgres" && /[A-Za-z_$]/.test(next ?? "")) {
      // $tag$ ... $tag$, or $$ ... $$. `$1` is a parameter, not a quote.
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const end = text.indexOf(m[0], i + m[0].length);
        push("string", end === -1 ? text.length : end + m[0].length);
      } else {
        push("punct", i + 1);
      }
    } else if (/\s/.test(c)) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      push("ws", j);
    } else if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < text.length && WORD_PART.test(text[j])) j++;
      push("word", j);
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      push("number", j);
    } else {
      push("punct", i + 1);
    }
  }
  return out;
}

/** Tokens that carry meaning: no comments, no whitespace. */
export const significant = (tokens: Token[]) => tokens.filter((t) => t.t !== "ws" && t.t !== "comment");
