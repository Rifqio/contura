import type { DialectKind } from "../api/types";
import { mysqlCommentAfter, type Token, quotedEnd, tokenize } from "../lang/sql/tokens";

/**
 * One statement: its trimmed text, without the closing `;`, and where it sits. `delimiter` is the custom MySQL
 * delimiter that ended it: the Core is told it, so it keeps the statement whole too.
 */
export interface Stmt {
  from: number;
  to: number;
  text: string;
  delimiter?: string;
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

/** Where a MySQL `DELIMITER` line sits (the word to the end of its line) and the delimiter it sets. */
interface DelimiterLine {
  from: number;
  to: number;
  delimiter: string;
}

/** Blanks that keep a DELIMITER at the start of its line, as the Core's `delimited_chunks` reads them. */
const LINE_BLANK = new Set([" ", "\t", "\r", "\v", "\f"]);

/**
 * The argument of a `DELIMITER` line, as the mysql client reads it: a quoted string, or the first word; the rest of
 * the line is ignored. None when it is missing or holds a backslash: then the line is text, as the Core reads it.
 */
function delimiterArg(rest: string): string | null {
  const src = rest.trim();
  const q = src[0];
  let arg: string;
  if (q === "'" || q === '"' || q === "`") {
    const inner = src.slice(1);
    const close = inner.indexOf(q);
    arg = close < 0 ? inner : inner.slice(0, close);
  } else arg = src.split(/[ \t\r\v\f]/)[0] ?? "";
  return arg === "" || arg.includes("\\") ? null : arg;
}

/**
 * MySQL `DELIMITER` lines, as the Core's `delimited_chunks` reads them (and the SQL file import's script reader): a
 * line whose first word is DELIMITER, outside strings, quoted names and comments, sets the statement end until the
 * next one, and is itself never sent. The chunks are the text between DELIMITER lines, cut at each custom delimiter.
 * A chunk a custom delimiter is in force for (`delimiter` set) that is one routine or compound statement (`compound`)
 * is sent whole, as the mysql client sends it; the Core still classifies and checks each of its `;`-parts. Any other
 * chunk is split as any other text, so each of its parts runs as its own statement with its own result. Null on
 * other dialects and when the text has no DELIMITER line and starts under `;`, so such text splits exactly as before.
 */
function delimitedChunks(
  text: string,
  dialect: DialectKind,
  initial = ";",
): { chunks: { from: number; to: number; delimiter?: string }[]; lines: DelimiterLine[] } | null {
  if (dialect !== "mysql") return null;
  const chunks: { from: number; to: number; delimiter?: string }[] = [];
  const lines: DelimiterLine[] = [];
  let delimiter = initial || ";";
  const chunk = (from: number, to: number) => chunks.push(delimiter === ";" ? { from, to } : { from, to, delimiter });
  let from = 0;
  let lineStart = true;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (c === "\n") {
      lineStart = true;
      i++;
      continue;
    }
    if (LINE_BLANK.has(c)) {
      i++;
      continue;
    }
    if (lineStart && text.slice(i, i + 9).toLowerCase() === "delimiter" && (i + 9 === len || " \t\r\n".includes(text[i + 9]))) {
      const nl = text.indexOf("\n", i);
      const end = nl < 0 ? len : nl;
      const arg = delimiterArg(text.slice(i + 9, end));
      if (arg !== null) {
        chunk(from, i);
        lines.push({ from: i, to: end, delimiter: arg });
        delimiter = arg;
        from = end;
        i = end;
        continue;
      }
    }
    lineStart = false;
    if (delimiter !== ";" && text.startsWith(delimiter, i)) {
      chunk(from, i);
      i += delimiter.length;
      from = i;
      continue;
    }
    const next = text[i + 1];
    if ((c === "-" && next === "-" && mysqlCommentAfter(text, i + 2)) || c === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? len : nl;
    } else if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? len : close + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      i = quotedEnd(text, i, c, c !== "`");
    } else i++;
  }
  if (lines.length === 0 && (initial || ";") === ";") return null;
  chunk(from, len);
  return { chunks, lines };
}

/** The delimiter in force at `pos`: the one the last DELIMITER line before it set, else `;`. */
export function delimiterAt(text: string, pos: number, dialect: DialectKind): string {
  let delimiter = ";";
  for (const line of delimitedChunks(text, dialect)?.lines ?? []) {
    if (line.to > pos) break;
    delimiter = line.delimiter;
  }
  return delimiter;
}

/**
 * Statements split on real statement ends; pieces with only comments are dropped. Inside a CREATE TRIGGER,
 * PROCEDURE, FUNCTION or EVENT, semicolons within its BEGIN ... END body do not end the statement. The same rules as
 * the Core's `split_statements` (round 7): only a real routine's CREATE opens a body, a BEGIN opens a block only
 * where one can start, END closes one only at a statement's start, and a body still open at the end of the text is
 * no routine: from its CREATE on, each `;` ends a statement. On MySQL, DELIMITER lines are read first (see
 * `delimitedChunks`); `delimiter` is the one in force where the text starts.
 */
export function splitStatements(text: string, dialect: DialectKind, delimiter = ";"): Stmt[] {
  const delimited = delimitedChunks(text, dialect, delimiter);
  if (!delimited) return splitPlain(text, dialect);
  return delimited.chunks.flatMap((c): Stmt[] => {
    const piece = text.slice(c.from, c.to);
    if (c.delimiter === undefined || !compound(piece, dialect))
      return splitPlain(piece, dialect).map((s) => ({ from: c.from + s.from, to: c.from + s.to, text: s.text }));
    const from = c.from + piece.length - piece.trimStart().length;
    const body = piece.trim();
    return [{ from, to: from + body.length, text: body, delimiter: c.delimiter }];
  });
}

/**
 * Whether a MySQL chunk is one routine or compound statement, which the server reads as one statement, `;`s inside,
 * as the Core's `compound` reads it: a routine's CREATE, or after an optional `label:` a BEGIN block (BEGIN followed
 * by a word other than WORK, so not a transaction), LOOP, WHILE or REPEAT, or without a label an IF or CASE statement.
 */
export function compound(chunk: string, dialect: DialectKind): boolean {
  const top = topTokens(tokenize(chunk, dialect).filter((t) => isCode(t, dialect)));
  if (opensRoutine(top)) return true;
  const word = (k: number) => {
    const t = top[k];
    return t && typeof t === "object" ? t.w : null;
  };
  const labelled = word(0) !== null && top[1] === ":";
  const w = word(labelled ? 2 : 0);
  const next = word(labelled ? 3 : 1);
  if (w === "BEGIN") return next !== null && next !== "WORK";
  if (w === "LOOP" || w === "WHILE" || w === "REPEAT") return true;
  return !labelled && (w === "IF" || w === "CASE");
}

/**
 * What a run of the selection `from`..`to` sends: the selected text, trimmed and without a last `;` (or the custom
 * MySQL delimiter in force where it starts), which the Core splits. That delimiter goes with it, so the Core splits
 * the selection as the editor reads it: a routine or compound statement runs whole, and plain statements as a `;`
 * selection does (the last one).
 */
export function selectionStatement(doc: string, from: number, to: number, dialect: DialectKind): Stmt | null {
  const raw = doc.slice(from, to);
  const delimiter = delimiterAt(doc, from, dialect);
  const lead = raw.length - raw.trimStart().length;
  let body = raw.trim();
  if (body.endsWith(delimiter)) body = body.slice(0, body.length - delimiter.length).trimEnd();
  if (!body) return null;
  const stmt: Stmt = { from: from + lead, to: from + lead + body.length, text: body };
  return delimiter === ";" ? stmt : { ...stmt, delimiter };
}


/** `splitStatements` for text with no DELIMITER line in force. */
function splitPlain(text: string, dialect: DialectKind): Stmt[] {
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
