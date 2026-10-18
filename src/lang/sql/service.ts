// The SQL service inside the language worker: the schemas it was sent, and
// the last analysis per document, so completion and refactors on the same
// text reuse it instead of analysing again.
import type { DialectKind } from "../../api/types";
import type { Diagnostic, SqlAt, SqlRefactorAction, SqlRefactorResult } from "../protocol";
import { analyzeSql, type SqlAnalysis } from "./analyze";
import { completeSql, type SqlCompletionResult } from "./complete";
import { inspectSql, type SchemaState } from "./inspect";
import { type QueryShape, queryShape, type ShapeProblem } from "./queryShape";
import { definitionAt, expandStar, parameterHints, renameBlocked, renameTargets } from "./refactor";
import type { SqlSchema } from "./types";

/** Documents whose last analysis is kept; the oldest goes first. */
const KEEP_DOCS = 8;

export function createSqlService() {
  const schemas = new Map<string, SqlSchema>();
  const last = new Map<string, SqlAnalysis>();
  let parses = 0;

  function analysis(docId: string | undefined, text: string, dialect: DialectKind, schemaKey: string | null): SqlAnalysis {
    const schema = schemaKey ? (schemas.get(schemaKey) ?? null) : null;
    const key = docId ?? "";
    const prev = last.get(key);
    if (prev && prev.text === text && prev.dialect === dialect && prev.schema === schema) return prev;
    const a = analyzeSql(text, dialect, schema);
    parses++;
    // Map order is insertion order: re-inserting marks the document as the newest.
    last.delete(key);
    last.set(key, a);
    while (last.size > KEEP_DOCS) last.delete(last.keys().next().value!);
    return a;
  }

  return {
    setSchema(key: string, schema: SqlSchema | null) {
      // An analysis holding the old schema would keep it, and its indexes, alive.
      const old = schemas.get(key);
      if (old && old !== schema) for (const [doc, a] of last) if (a.schema === old) last.delete(doc);
      if (schema) schemas.set(key, schema);
      else schemas.delete(key);
    },
    /** How many documents' analyses are kept, for tests. */
    cachedDocs: () => last.size,
    /** How many times the service has analysed text, for tests. */
    parses: () => parses,
    analyze(docId: string, text: string, dialect: DialectKind, schemaKey: string | null, schemaState: SchemaState): Diagnostic[] {
      const known = schemaKey && schemas.has(schemaKey) ? schemaState : "none";
      return inspectSql(analysis(docId, text, dialect, schemaKey), text, dialect, known);
    },
    /** The query diagram's shape of the statement at `pos`, over the same cached analysis. */
    shape(docId: string, text: string, dialect: DialectKind, schemaKey: string | null, schemaState: SchemaState, pos: number): QueryShape | ShapeProblem {
      const known = schemaKey && schemas.has(schemaKey) ? schemaState : "none";
      return queryShape(analysis(docId, text, dialect, schemaKey), pos, known);
    },
    complete(at: SqlAt & { docId?: string; explicit: boolean; aliasTables?: boolean }): SqlCompletionResult {
      const a = analysis(at.docId, at.text, at.dialect, at.schemaKey);
      return completeSql(at.text, at.pos, at.dialect, a.schema, at.explicit, { aliasTables: at.aliasTables, analysis: a });
    },
    refactor(at: SqlAt & { docId?: string; action: SqlRefactorAction }): SqlRefactorResult {
      const a = analysis(at.docId, at.text, at.dialect, at.schemaKey);
      switch (at.action) {
        case "expandStar":
          return { action: "expandStar", edits: expandStar(a, at.text, at.pos) };
        case "rename":
          return { action: "rename", ranges: renameTargets(a, at.pos), blocked: renameBlocked(a, at.pos) };
        case "definition":
          return { action: "definition", definition: definitionAt(a, at.pos) };
        case "params":
          return { action: "params", hints: parameterHints(a, at.text, at.pos, at.dialect) };
      }
    },
  };
}
