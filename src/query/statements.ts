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
/** Words that may come between CREATE and the kind of object it makes. */
const CREATE_MODIFIERS = new Set(["OR", "REPLACE", "TEMP", "TEMPORARY", "AGGREGATE", "CONSTRAINT"]);
/** Kinds of object a CREATE makes that end a `DEFINER = ...` clause without being a routine. */
const OTHER_OBJECTS = new Set(["TABLE", "VIEW", "INDEX", "UNIQUE", "DATABASE", "SCHEMA", "USER", "ROLE", "SEQUENCE", "TYPE", "EXTENSION", "SERVER", "TABLESPACE"]);

const isMeaningful = (t: Token) => t.t !== "ws" && t.t !== "comment";
/** Code the server runs: what is meaningful, and on MySQL an executable comment (slash, star, bang) too. */
export const isCode = (t: Token, dialect: DialectKind) =>
  isMeaningful(t) || (dialect === "mysql" && t.t === "comment" && t.v.startsWith("/*!"));

/**
 * One top-level token of a part, outside parentheses: a bare (possibly dotted) word upper-cased, a quoted name, a
 * number or string, or a mark. The same reading as the Core's `Top`.
 */
type Top = { w: string } | "name" | "val" | ":" | "," | "()" | "op";

/**
 * Whether a part's top-level tokens begin a routine, as the Core's `opens_routine` reads them:
 * `CREATE [OR REPLACE] [DEFINER = ...] [TEMP|TEMPORARY] [AGGREGATE] [CONSTRAINT]` right before TRIGGER, PROCEDURE,
 * FUNCTION or EVENT.
 */
function opensRoutine(top: readonly Top[]): boolean {
  const word = (t: Top | undefined) => (t && typeof t === "object" ? t.w : null);
  if (word(top[0]) !== "CREATE") return false;
  let definer = false;
  for (const t of top.slice(1)) {
    const w = word(t);
    if (w === null) {
      if (definer) continue;
      return false;
    }
    if (ROUTINE.has(w)) return true;
    if (OTHER_OBJECTS.has(w)) return false;
    if (w === "DEFINER") {
      definer = true;
      continue;
    }
    if (definer || CREATE_MODIFIERS.has(w)) continue;
    return false;
  }
  return false;
}

/** Keywords a name follows (the Core's `NAME_AFTER`). */
const NAME_AFTER = new Set([
  "AS", "SET", "DECLARE", "ON", "OF", "FROM", "JOIN", "INTO", "UPDATE", "TABLE", "TRIGGER", "PROCEDURE", "FUNCTION",
  "EVENT", "SELECT", "WHERE", "AND", "OR", "BY", "NEW", "OLD", "IS", "NOT", "IN", "DEFINER", "CALL", "USING", "RETURN",
  "RETURNS", "VALUES", "LIKE", "WHEN", "FOLLOWS", "PRECEDES", "SETOF", "IF", "ELSEIF", "WHILE", "UNTIL", "HAVING",
  "LIMIT", "LEAVE", "ITERATE", "RETURNING",
]);
/** Keywords after which a CASE is a name (the Core's `CASE_NAME_AFTER`). */
const CASE_NAME_AFTER = new Set([
  "AS", "SET", "DECLARE", "ON", "OF", "FROM", "JOIN", "INTO", "UPDATE", "TABLE", "TRIGGER", "PROCEDURE", "FUNCTION",
  "EVENT", "DEFINER", "CALL", "FOLLOWS", "PRECEDES", "SETOF", "LEAVE", "ITERATE",
]);
/** Words after which a statement starts inside a body; END is not one (`END begin` is a label). */
const STATEMENT_START = new Set(["BEGIN", "THEN", "ELSE", "DO", "LOOP", "REPEAT"]);
/** Words after which a `DECLARE ... HANDLER FOR` condition ends and its block may start. */
const HANDLER_CONDITIONS = new Set(["SQLEXCEPTION", "SQLWARNING", "FOUND"]);

/** The Core's `Part`: reads one part's top-level tokens. */
class Part {
  constructor(readonly top: readonly Top[]) {}
  word(k: number): string | null {
    const t = this.top[k];
    return t && typeof t === "object" ? t.w : null;
  }
  cast(k: number): boolean {
    return this.top[k] === ":" && (this.top[k - 1] === ":" || this.top[k + 1] === ":");
  }
  isName(k: number): boolean {
    if (k === 0) return false;
    const p = this.top[k - 1];
    if (typeof p === "object") return NAME_AFTER.has(p.w) && !this.isName(k - 1);
    if (p === ":") return this.cast(k - 1);
    return false;
  }
  statementStart(k: number): boolean {
    if (k === 0) return true;
    const p = this.top[k - 1];
    if (p === ":") return !this.cast(k - 1);
    if (typeof p === "object") return STATEMENT_START.has(p.w) && !this.isName(k - 1);
    return false;
  }
  label(k: number): boolean {
    return this.top[k + 1] === ":" && !this.cast(k + 1);
  }
}

/** Follows routine bodies across parts, by the same rules as the Core's `RoutineDepth` (round 8). */
class RoutineDepth {
  open = false;
  body = false;
  stack: ("begin" | "case")[] = [];

  feed(top: readonly Top[]): boolean {
    if (!this.open) {
      if (!opensRoutine(top)) return false;
      this.open = true;
      this.body = false;
      this.stack = [];
    }
    const part = new Part(top);
    const handler = (k: number) => top.slice(0, k).some((t) => typeof t === "object" && t.w === "HANDLER");
    for (let k = 0; k < top.length; k++) {
      const w = part.word(k);
      const prev = k > 0 ? top[k - 1] : undefined;
      if (w === "BEGIN" && !part.isName(k) && !part.label(k)) {
        const opens =
          !this.body && this.stack.length === 0
            ? prev !== "," && prev !== "op" && !(prev === ":" && part.cast(k - 1))
            : part.statementStart(k) || (handler(k) && (prev === "val" || HANDLER_CONDITIONS.has(part.word(k - 1) ?? "")));
        if (opens) {
          this.stack.push("begin");
          this.body = true;
        }
      } else if (w === "CASE" && !part.label(k) && !(k > 0 && CASE_NAME_AFTER.has(part.word(k - 1) ?? "") && !part.isName(k - 1))) {
        this.stack.push("case");
      } else if (w === "END" && !part.isName(k) && !part.label(k)) {
        const next = part.word(k + 1);
        const last = this.stack[this.stack.length - 1];
        const closesControl = next !== null && END_OF_CONTROL.has(next);
        if (closesControl) k++;
        else if (last === "case") {
          this.stack.pop();
          if (next === "CASE") k++;
        } else if (last === "begin" && part.statementStart(k)) this.stack.pop();
        // `END lbl` or `END LOOP lbl`: the last word of the part is a label.
        if ((closesControl || part.statementStart(k)) && k + 2 === top.length && part.word(k + 1) !== null) k++;
      }
    }
    if (this.stack.length === 0) this.open = false;
    return true;
  }

  inside() {
    return this.open && this.stack.length > 0;
  }
}

/** The top-level tokens of a part's code tokens: a dotted name (`NEW.begin`) is one word, as the Core reads it. */
function topTokens(tokens: readonly Token[]): Top[] {
  const top: Top[] = [];
  let paren = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === "punct" && t.v === "(") {
      paren++;
      continue;
    }
    if (t.t === "punct" && t.v === ")") {
      paren = Math.max(0, paren - 1);
      if (paren === 0) top.push("()");
      continue;
    }
    if (paren > 0) continue;
    const last = top[top.length - 1];
    if (t.t === "punct" && t.v === "." && typeof last === "object" && tokens[i + 1]?.t === "word") {
      last.w += `.${tokens[i + 1].v.toUpperCase()}`;
      i++;
      continue;
    }
    if (t.t === "word") top.push({ w: t.v.toUpperCase() });
    else if (t.t === "number" || t.t === "string") top.push("val");
    else if (t.t === "quoted") top.push("name");
    else if (t.t === "punct" && t.v === ":") top.push(":");
    else if (t.t === "punct" && t.v === ",") top.push(",");
    else top.push("op");
  }
  return top;
}

/**
 * Statements split on real statement ends; pieces with only comments are dropped. Inside a CREATE TRIGGER,
 * PROCEDURE, FUNCTION or EVENT, semicolons within its BEGIN ... END body do not end the statement. The same rules as
 * the Core's `split_statements` (round 7): only a real routine's CREATE opens a body, a BEGIN opens a block only
 * where one can start, END closes one only at a statement's start, and a body still open at the end of the text is
 * no routine: from its CREATE on, each `;` ends a statement.
 */
export function splitStatements(text: string, dialect: DialectKind): Stmt[] {
  const tokens = tokenize(text, dialect);
  // The parts between top-level `;`s that hold code: where each runs and its code tokens.
  const parts: { from: number; to: number; code: Token[] }[] = [];
  let start = 0;
  let code: Token[] = [];
  const cut = (end: number) => {
    if (code.length > 0) parts.push({ from: start, to: end, code });
    code = [];
  };
  for (const t of tokens) {
    if (t.t === "punct" && t.v === ";") {
      cut(t.from);
      start = t.to;
    } else if (isCode(t, dialect)) code.push(t);
  }
  cut(text.length);

  const tops = parts.map((p) => topTokens(p.code));
  // Which parts belong to a routine; one whose body is still open at the end is none.
  const member: boolean[] = [];
  const depth = new RoutineDepth();
  let openFrom: number | null = null;
  tops.forEach((top, k) => {
    const wasOpen = depth.open;
    const mine = depth.feed(top);
    if (mine && !wasOpen) openFrom = k;
    member.push(mine);
    if (!depth.inside()) openFrom = null;
  });
  if (openFrom !== null && depth.inside()) for (let k = openFrom; k < member.length; k++) member[k] = false;

  const out: Stmt[] = [];
  const push = (from: number, to: number) => {
    const piece = text.slice(from, to);
    const lead = piece.length - piece.trimStart().length;
    const body = piece.trim();
    out.push({ from: from + lead, to: from + lead + body.length, text: body });
  };
  const join = new RoutineDepth();
  let joining: number | null = null;
  parts.forEach((p, k) => {
    if (!member[k]) {
      push(p.from, p.to);
      return;
    }
    const from = joining ?? p.from;
    join.feed(tops[k]);
    if (join.inside()) {
      joining = from;
      return;
    }
    joining = null;
    push(from, p.to);
  });
  return out;
}

/**
 * The statement whose code is on the line at `pos` (DataGrip's rule): a blank line, or a line that only holds comments
 * in this dialect (dash dash, MySQL hash, nested PostgreSQL block comments), is outside any statement; a MySQL
 * executable comment is code.
 * With two statements on the line, it is the one the insertion point is in, as `statementAt` picks it: the last one
 * whose code starts at or before `pos`, else the first. `code` starts at the code, without the comments above it.
 */
export function statementOnLine(
  doc: string,
  pos: number,
  stmts: readonly Stmt[],
  dialect: DialectKind,
): { stmt: Stmt; code: Stmt; end: number } | null {
  const lineFrom = doc.lastIndexOf("\n", pos - 1) + 1;
  const nl = doc.indexOf("\n", pos);
  const lineTo = nl < 0 ? doc.length : nl;
  let found: { stmt: Stmt; code: Stmt; end: number } | null = null;
  for (const s of stmts) {
    if (s.from > lineTo) break;
    const end = doc[s.to] === ";" ? s.to + 1 : s.to;
    if (end < lineFrom) continue;
    const first = tokenize(doc.slice(s.from, s.to), dialect).find((t) => isCode(t, dialect));
    if (!first) continue;
    const from = s.from + first.from;
    if (from > lineTo) continue;
    const hit = { stmt: s, code: { from, to: s.to, text: doc.slice(from, s.to) }, end };
    if (!found || from <= pos) found = hit;
    if (from > pos) break;
  }
  return found;
}

/** The statement being typed at `pos`: the last one starting at or before it, else the first. */
export function statementAt(stmts: Stmt[], pos: number): Stmt | null {
  let found: Stmt | null = null;
  for (const s of stmts) if (s.from <= pos) found = s;
  return found ?? stmts[0] ?? null;
}
