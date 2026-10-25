import { vi } from "vitest";
import type { LineMark, SqlEditorApi, Suggestion } from "../query/SqlEditor";
import { type Stmt, splitStatements, statementAt } from "../query/statements";

/**
 * A stand-in query editor holding `doc`, typing at `at` or over `selection`: a suggestion waits until kept or
 * discarded, as in the real editor, without CodeMirror.
 */
export function fakeSqlEditor(doc: string, at = 0, selection?: [number, number]) {
  let text = doc;
  let sel = selection ? { from: selection[0], to: selection[1] } : { from: at, to: at };
  let pending: Suggestion | null = null;
  const marks: (LineMark | null)[] = [];
  const ranges = new Map<number, { from: number; to: number }>();
  let nextTrack = 1;
  const end = (how: "kept" | "discarded" | "replaced", kept?: { from: number; to: number }) => {
    const s = pending;
    pending = null;
    s?.onEnd?.(how, kept);
  };
  /** Moves every tracked range for an edit of `from` to `to` that became `len` characters long. */
  const shift = (from: number, to: number, len: number) => {
    const d = len - (to - from);
    for (const [id, r] of ranges) {
      const a = r.from >= to ? r.from + d : r.from > from ? from + len : r.from;
      const b = r.to >= to ? r.to + d : r.to > from ? from : r.to;
      ranges.set(id, { from: a, to: Math.max(a, b) });
    }
  };
  const api: SqlEditorApi = {
    text: () => text,
    runTarget: (): Stmt | null => {
      if (sel.from !== sel.to) return { from: sel.from, to: sel.to, text: text.slice(sel.from, sel.to) };
      return statementAt(splitStatements(text, "postgres"), sel.from);
    },
    select: vi.fn((from: number, to: number) => {
      sel = { from, to };
    }),
    insert: vi.fn(),
    replaceAll: vi.fn(),
    replaceRange: vi.fn((from: number, to: number, insert: string) => {
      text = text.slice(0, from) + insert + text.slice(to);
    }),
    focus: vi.fn(),
    band: vi.fn(),
    selection: () => sel,
    statements: () => splitStatements(text, "postgres"),
    dialect: () => "postgres",
    suggest: vi.fn((s: Suggestion) => {
      if (pending) end("replaced");
      pending = s;
    }),
    keepSuggestion: vi.fn(() => {
      const s = pending;
      if (!s) return false;
      text = text.slice(0, s.from) + s.text + text.slice(s.to);
      shift(s.from, s.to, s.text.length);
      end("kept", { from: s.from, to: s.from + s.text.length });
      return true;
    }),
    discardSuggestion: vi.fn(() => {
      if (!pending) return false;
      end("discarded");
      return true;
    }),
    suggesting: () => pending !== null,
    markLines: vi.fn((m: LineMark | null) => {
      marks.push(m);
    }),
    track: vi.fn((from: number, to: number) => {
      const id = nextTrack++;
      ranges.set(id, { from, to });
      return id;
    }),
    tracked: (id: number) => ranges.get(id) ?? null,
    retrack: vi.fn((id: number, from: number, to: number) => {
      ranges.set(id, { from, to });
    }),
    untrack: vi.fn((id: number) => {
      ranges.delete(id);
    }),
    askZone: () => null,
  };
  return {
    api,
    now: () => text,
    pending: () => pending,
    marks,
    ranges,
    /** Edits the text as typing would: `from` to `to` becomes `insert`; tracked ranges follow. */
    edit(from: number, to: number, insert: string) {
      text = text.slice(0, from) + insert + text.slice(to);
      shift(from, to, insert.length);
      if (pending && !(to < pending.from || from > pending.to)) end("discarded");
    },
    /** Moves the cursor, as a click in the editor would. */
    moveTo(pos: number, to = pos) {
      sel = { from: pos, to };
    },
    /** Types over the text, as the user would while a suggestion waits: one that runs into it goes. */
    type(next: string) {
      text = next;
      if (pending) end("discarded");
    },
  };
}
