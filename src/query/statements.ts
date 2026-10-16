import type { DialectKind } from "../api/types";
import { type Token, tokenize } from "../lang/sql/tokens";

/** One statement: its trimmed text, without the closing `;`, and where it sits. */
export interface Stmt {
  from: number;
  to: number;
  text: string;
}

/** Statements whose body is a BEGIN ... END block, with semicolons inside it. */
const ROUTINE = new Set(["TRIGGER", "PROCEDURE", "FUNCTION", "EVENT"]);
/** `END IF` and its kind close a control structure, not a BEGIN or CASE. */
const END_OF_CONTROL = new Set(["IF", "LOOP", "WHILE", "REPEAT", "FOR"]);

const isMeaningful = (t: Token) => t.t !== "ws" && t.t !== "comment";
const upper = (t: Token | undefined) => (t && t.t === "word" ? t.v.toUpperCase() : "");

/**
 * Statements split on real statement ends; pieces with only comments are dropped.
 * Inside a CREATE TRIGGER, PROCEDURE, FUNCTION or EVENT, semicolons within its
 * BEGIN ... END body do not end the statement.
 */
export function splitStatements(text: string, dialect: DialectKind): Stmt[] {
  const tokens = tokenize(text, dialect);
  const out: Stmt[] = [];
  let start = 0;
  let words: string[] = [];
  let routine = false;
  let depth = 0;
  const close = (end: number) => {
    if (words.length > 0) {
      const piece = text.slice(start, end);
      const lead = piece.length - piece.trimStart().length;
      const body = piece.trim();
      out.push({ from: start + lead, to: start + lead + body.length, text: body });
    }
    words = [];
    routine = false;
    depth = 0;
  };
  const nextMeaningful = (i: number) => tokens.slice(i + 1).find(isMeaningful);
  tokens.forEach((t, i) => {
    if (t.t === "punct" && t.v === ";" && depth === 0) {
      close(t.from);
      start = t.to;
      return;
    }
    if (!isMeaningful(t)) return;
    const w = upper(t);
    words.push(w);
    if (words[0] === "CREATE" && depth === 0 && ROUTINE.has(w)) routine = true;
    if (!routine) return;
    if (w === "BEGIN" || w === "CASE") depth++;
    else if (w === "END" && depth > 0 && !END_OF_CONTROL.has(upper(nextMeaningful(i)))) depth--;
  });
  close(text.length);
  return out;
}

/** The statement being typed at `pos`: the last one starting at or before it, else the first. */
export function statementAt(stmts: Stmt[], pos: number): Stmt | null {
  let found: Stmt | null = null;
  for (const s of stmts) if (s.from <= pos) found = s;
  return found ?? stmts[0] ?? null;
}
