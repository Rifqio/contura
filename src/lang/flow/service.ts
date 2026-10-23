// The language worker's .flow state (ruling P5). Source ranges stay here: a parse sends only the doc, its problems
// and the last good doc, which keeps the posted result small. Span and edit requests are answered against the
// cached parse of one text version, and a request planned on an older version is refused.
import { completeFlow, type FlowCompletionResult } from "./complete";
import type { TextEdit } from "../protocol";
import { applyFlowEdit, type FlowEditOp, type FlowEditResult } from "./edits";
import type { FlowDoc } from "./model";
import { flowOutline } from "./outline";
import type { FlowOutline } from "../../api/types";
import { type FlowParse, type FlowSpan, parseFlow } from "./parse";
import type { FlowProblem } from "./problems";

/** What a parse posts to the editor side. */
export type FlowResult = {
  kind: FlowParse["kind"];
  /** Null while the text has an error. */
  doc: FlowDoc | null;
  problems: FlowProblem[];
  /** The most recent good doc for this document, sent only while `doc` is null (else `doc` is it), so it is sent once. */
  lastValid: FlowDoc | null;
  /** The text version this result is for; span and edit requests name it. */
  version: number;
};

export type FlowSpansResult =
  | { stale: true }
  | {
      stale: false;
      /** Each asked key (`node:<name>`, `group:<name>`, `link:<i>`, `diagram`, `kind`, `title`); null when the text has none. */
      spans: Record<string, FlowSpan | null>;
      /** The line each asked name is defined on; null when it is not defined. */
      lineOf: Record<string, number | null>;
    };

/** Several canvas actions as one (a multi-node delete): one edit list, one undo entry, all or nothing. */
export type FlowBatchOp = { op: "batch"; ops: FlowEditOp[] };

/** What a canvas action asks the worker for. */
export type FlowRequestOp = FlowEditOp | FlowBatchOp;

/** Applies sorted, non-overlapping edits to `text`. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

/**
 * Runs the ops in turn on the text, parsing again between them, and returns one replace of the changed span
 * against the original text. An op that does not apply refuses the whole batch (an empty list).
 */
export function applyFlowBatch(text: string, parse: FlowParse, ops: readonly FlowEditOp[]): FlowEditResult {
  // Only the edits: the worker answers a canvas batch without posting the whole text back.
  const { edits } = applyFlowSteps(text, parse, ops.length, (_, i) => ops[i]);
  return { edits };
}

/**
 * Like `applyFlowBatch`, but each op is made from the parse of the text the steps before it left, so an op that
 * names a link by its index sees the right one. `opAt` returning null refuses the whole batch. The final text
 * comes back with the edit, so a caller that wants it need not apply the edit again.
 */
export function applyFlowSteps(text: string, parse: FlowParse, count: number, opAt: (parse: FlowParse, i: number) => FlowEditOp | null): FlowEditResult & { text?: string } {
  let t = text;
  let p = parse;
  for (let i = 0; i < count; i++) {
    const op = opAt(p, i);
    if (!op) return { edits: [] };
    const r = applyFlowEdit(t, p, op);
    if (r.edits.length === 0) return { edits: [] };
    t = applyEdits(t, r.edits);
    if (i < count - 1) p = parseFlow(t);
  }
  if (t === text) return { edits: [] };
  let a = 0;
  while (a < t.length && a < text.length && t[a] === text[a]) a++;
  let b = 0;
  while (b < t.length - a && b < text.length - a && t[t.length - 1 - b] === text[text.length - 1 - b]) b++;
  return { edits: [{ from: a, to: text.length - b, insert: t.slice(a, t.length - b) }], text: t };
}

/** The outline of the text of `version`, or `{ stale: true }` once the text has changed. */
export type FlowOutlineAnswer = { stale: true } | { stale: false; outline: FlowOutline };

/** Edits for a canvas action, or `{ stale: true }` when the text has changed since the version it was planned on. */
export type FlowEditAnswer = { stale: true } | ({ stale: false } & FlowEditResult);

/** Completion items; `stale` when a newer text was still waiting to be parsed (it has been parsed now, so ask again). */
export type FlowCompleteAnswer = FlowCompletionResult & { stale?: true };

type Cached = { version: number; text: string; parse: FlowParse; lastValid: FlowDoc | null };

/**
 * How many closed diagram ids the worker remembers, newest kept: a parse that arrives just after its tab closed is
 * dropped, and older ids are forgotten so the set does not grow with every diagram ever opened.
 */
export const CLOSED_KEPT = 64;

export function createFlowService() {
  const docs = new Map<string, Cached>();
  const closed = new Set<string>();
  let icons: readonly string[] = [];
  /** The same names as a set for the parser's unknown-icon check; undefined until the list arrives. */
  let iconSet: ReadonlySet<string> | undefined;
  /** The nearest icon for each misspelt name, kept while the list is the same. */
  const iconNear = new Map<string, string | null>();
  let nextVersion = 1;

  /** The cached parse for `version`, or null when the text has changed since (or the tab closed). */
  function current(docId: string, version: number): Cached | null {
    const c = docs.get(docId);
    return c && c.version === version ? c : null;
  }

  return {
    current,

    /** True after `close` until `open`: a late parse for a closed tab is dropped, so nothing is kept for it. */
    isClosed: (docId: string) => closed.has(docId),

    open(docId: string) {
      closed.delete(docId);
    },

    close(docId: string) {
      closed.delete(docId);
      closed.add(docId);
      if (closed.size > CLOSED_KEPT) closed.delete(closed.values().next().value!);
      docs.delete(docId);
    },

    parse(docId: string, text: string): FlowResult {
      const parse = parseFlow(text, { icons: iconSet, iconNear });
      const lastValid = parse.doc ?? docs.get(docId)?.lastValid ?? null;
      const version = nextVersion++;
      docs.set(docId, { version, text, parse, lastValid });
      return { kind: parse.kind, doc: parse.doc, problems: parse.problems, lastValid: parse.doc ? null : lastValid, version };
    },

    spans(docId: string, version: number, keys: readonly string[], names: readonly string[]): FlowSpansResult {
      const c = current(docId, version);
      if (!c) return { stale: true };
      // No prototype, so a name such as __proto__ is a plain key.
      const spans = Object.create(null) as Record<string, FlowSpan | null>;
      for (const k of keys) spans[k] = c.parse.span(k);
      const lineOf = Object.create(null) as Record<string, number | null>;
      for (const n of names) lineOf[n] = c.parse.defined.get(n) ?? null;
      return { stale: false, spans, lineOf };
    },

    /** The outline the diagram assistant sends and checks against, from the parse of `version`. */
    outline(docId: string, version: number): FlowOutlineAnswer {
      const c = current(docId, version);
      if (!c) return { stale: true };
      return { stale: false, outline: flowOutline(c.parse, c.lastValid) };
    },

    /** Runs a canvas action on the text of `version`; works while that text has errors. */
    edit(docId: string, version: number, edit: FlowRequestOp): FlowEditAnswer {
      const c = current(docId, version);
      if (!c) return { stale: true };
      if (edit.op === "batch") return { stale: false, ...applyFlowBatch(c.text, c.parse, edit.ops) };
      return { stale: false, ...applyFlowEdit(c.text, c.parse, edit) };
    },

    /** Every icon name, for completion after `icon:` and the unknown-icon check; an empty list checks nothing. */
    setIcons(names: readonly string[]) {
      icons = names;
      iconSet = names.length > 0 ? new Set(names) : undefined;
      iconNear.clear();
    },

    /** Completion at `pos`; the cached names are used when they are for this same text. */
    complete(docId: string, text: string, pos: number): FlowCompletionResult {
      const c = docs.get(docId);
      return completeFlow(text, pos, icons, c && c.text === text ? c.parse.defined : undefined);
    },
  };
}
