import type { LineMark, SqlEditorApi } from "../query/SqlEditor";
import type { DialectKind } from "../api/types";
import { type Stmt, statementOnLine } from "../query/statements";

/** The query tab an answer's SQL goes into: its editor (null once closed) and its name. */
export interface InsertTarget {
  editor(): SqlEditorApi | null;
  name: string;
  /** The tab's key (`tabKey`), so an Insert records where the chat last worked; absent, nothing is recorded (P22). */
  key?: string;
  connectionId?: string | null;
  database?: string | null;
}

/** The query tab Open in new tab opened, as it opened: its key and name, the text it holds and its place. */
export interface OpenedTab {
  key: string;
  name: string;
  sql: string;
  connectionId: string | null;
  database: string | null;
}

type Range = { from: number; to: number };

/** Where an answer's SQL goes: `from` to `to` of the editor's text becomes `text`. */
export interface InsertPlan {
  from: number;
  to: number;
  text: string;
  /** "Replaces lines 2 to 10 of Query 2", "Adds lines 11 to 19 of Query 2, below the current statement". */
  where: string;
  /** The first and last line it replaces, or the first and last line it adds. */
  lines: [number, number];
  /** What hovering or focusing the action marks in the editor. */
  mark: LineMark;
}

const lineOf = (doc: string, pos: number) => {
  let n = 1;
  for (let i = doc.indexOf("\n"); i >= 0 && i < pos; i = doc.indexOf("\n", i + 1)) n++;
  return n;
};
const lineStart = (doc: string, pos: number) => doc.lastIndexOf("\n", pos - 1) + 1;
const lineEnd = (doc: string, pos: number) => {
  const i = doc.indexOf("\n", pos);
  return i < 0 ? doc.length : i;
};
const n = (line: number) => line.toLocaleString("en-US");
const span = (a: number, b: number) => (a === b ? `line ${n(a)}` : `lines ${n(a)} to ${n(b)}`);
const ends = (doc: string, s: Stmt) => (doc[s.to] === ";" ? s.to + 1 : s.to);
const newLines = (text: string) => text.split("\n").length - 1;

/** The statement on the line being typed, from its first line of code, with its `;`; none on a blank or comment line. */
function statementOn(doc: string, at: number, stmts: readonly Stmt[], dialect: DialectKind): Stmt | null {
  return statementOnLine(doc, at, stmts, dialect)?.code ?? null;
}

/**
 * Apply (A3): the answer over the selection when there is one, else over the statement being typed and its `;`.
 * Null where there is neither, such as a blank line with nothing selected.
 */
export function planApply(
  doc: string,
  sel: Range,
  stmts: readonly Stmt[],
  name: string,
  sql: string,
  dialect: DialectKind = "postgres",
): (InsertPlan & { over: "selection" | "statement" }) | null {
  let from: number;
  let to: number;
  let over: "selection" | "statement";
  const raw = doc.slice(sel.from, sel.to);
  if (raw.trim() !== "") {
    from = sel.from + (raw.length - raw.trimStart().length);
    to = sel.from + raw.trimEnd().length;
    if (doc[to] === ";") to++;
    over = "selection";
  } else {
    const s = statementOn(doc, sel.from, stmts, dialect);
    if (!s) return null;
    from = s.from;
    to = ends(doc, s);
    over = "statement";
  }
  const lines: [number, number] = [lineOf(doc, from), lineOf(doc, Math.max(from, to - 1))];
  return { from, to, text: sql.trimEnd(), where: `Replaces ${span(...lines)} of ${name}`, lines, mark: { from, to }, over };
}

/**
 * Insert (A3, Copilot's Insert at Cursor): below the statement being typed, after a blank line, so a statement is never split;
 * on a line with no statement, where you are typing's line. Nothing is removed.
 */
export function planInsert(
  doc: string,
  sel: Range,
  stmts: readonly Stmt[],
  name: string,
  sql: string,
  dialect: DialectKind = "postgres",
): InsertPlan & { below: boolean } {
  const body = sql.trimEnd();
  const s = statementOn(doc, sel.to, stmts, dialect);
  if (s) {
    const end = ends(doc, s);
    const eol = lineEnd(doc, end);
    const rest = doc.slice(end, eol);
    // Code after the `;` on the same line is the next statement: go in right after the `;`, never inside that one.
    if (rest.trim() !== "") {
      const space = rest.length - rest.trimStart().length;
      const first = lineOf(doc, end) + 2;
      const lines: [number, number] = [first, first + newLines(body)];
      return { from: end, to: end + space, text: `\n\n${body}\n\n`, where: `Adds ${span(...lines)} of ${name}, below the current statement`, lines, mark: { after: end }, below: true };
    }
    // A blank line before the next statement too, so the block never reads as that statement's comment (I1).
    const next = eol < doc.length ? doc.slice(eol + 1, lineEnd(doc, eol + 1)) : "";
    const gap = eol < doc.length && next.trim() !== "" ? "\n" : "";
    const text = `\n\n${body}${gap}`;
    const first = lineOf(doc, eol) + 2;
    const lines: [number, number] = [first, first + newLines(body)];
    return { from: eol, to: eol, text, where: `Adds ${span(...lines)} of ${name}, below the current statement`, lines, mark: { after: eol }, below: true };
  }
  const start = lineStart(doc, sel.to);
  const end = lineEnd(doc, sel.to);
  const blank = doc.slice(start, end).trim() === "";
  const at = blank ? start : end;
  const text = blank ? `${body}\n` : `\n${body}`;
  const first = lineOf(doc, at) + (blank ? 0 : 1);
  const lines: [number, number] = [first, first + newLines(body)];
  return { from: at, to: at, text, where: `Adds ${span(...lines)} of ${name} where you are typing`, lines, mark: { after: at }, below: false };
}

/** The plans for an editor as it is now. */
export function plansFor(editor: SqlEditorApi, name: string, sql: string) {
  const doc = editor.text();
  const sel = editor.selection();
  const stmts = editor.statements();
  const dialect = editor.dialect();
  return { apply: planApply(doc, sel, stmts, name, sql, dialect), insert: planInsert(doc, sel, stmts, name, sql, dialect) };
}
