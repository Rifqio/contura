// Messages between the editor side (LangClient) and the language worker.
import type { DialectKind, SchemaModel } from "../api/types";
import type { Range } from "./sql/analyze";
import type { SqlCompletionResult } from "./sql/complete";
import type { SchemaState } from "./sql/inspect";
import type { Definition, ParameterHints } from "./sql/refactor";
import type { SqlSchema } from "./sql/types";

/** A change to the document, as offsets into the current text. */
export type TextEdit = { from: number; to: number; insert: string };

export type QuickFix = { title: string; edits: TextEdit[] };

export type Diagnostic = {
  from: number;
  to: number;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  severity: "error" | "warning" | "hint";
  message: string;
  fixes: QuickFix[];
};

/**
 * Source ranges keyed by element path:
 * `table:<key>`, `table:<key>/name`, `column:<key>/<col>`, `column:<key>/<col>/name`,
 * `column:<key>/<col>/type`, `column:<key>/<col>/settings`, `index:<key>/<n>/<j>` (column j of index n),
 * `ref:<i>`, `ref:<i>/from`, `ref:<i>/to`.
 * `<key>` is `tableKey(table)`.
 */
export type Ranges = Record<string, { from: number; to: number }>;

export type ParseResult = {
  model: SchemaModel | null;
  /** The most recent non-null `model` for this document. */
  lastValid: SchemaModel | null;
  diagnostics: Diagnostic[];
  ranges: Ranges;
};

export type SqlRefactorAction = "expandStar" | "rename" | "definition" | "params";

export type SqlRefactorResult =
  | { action: "expandStar"; edits: TextEdit[] | null }
  | { action: "rename"; ranges: Range[] | null; blocked: string | null }
  | { action: "definition"; definition: Definition | null }
  | { action: "params"; hints: ParameterHints | null };

/** Where SQL is being typed: the text, the position in it, and which schema applies. */
export type SqlAt = { text: string; pos: number; dialect: DialectKind; schemaKey: string | null };

export type ToWorker =
  | { type: "update"; id: number; docId: string; text: string; dialect: DialectKind }
  /** A schema for a Connection and database; null drops it. */
  | { type: "sqlSchema"; key: string; schema: SqlSchema | null }
  | { type: "sqlAnalyze"; id: number; docId: string; text: string; dialect: DialectKind; schemaKey: string | null; schemaState: SchemaState }
  | ({ type: "sqlComplete"; id: number; docId?: string; explicit: boolean; aliasTables?: boolean } & SqlAt)
  | ({ type: "sqlRefactor"; id: number; docId?: string; action: SqlRefactorAction } & SqlAt);

export type FromWorker =
  | { type: "result"; ids: number[]; docId: string; result: ParseResult }
  | { type: "sqlDiagnostics"; ids: number[]; docId: string; diagnostics: Diagnostic[] }
  | { type: "sqlCompletion"; ids: number[]; result: SqlCompletionResult }
  | { type: "sqlRefactor"; ids: number[]; result: SqlRefactorResult }
  | { type: "failed"; ids: number[]; message: string };

/** The one key for a table, used by ranges, edits and the canvas layout. */
export function tableKey(t: { schema: string | null; name: string }): string {
  return `${t.schema ?? ""}.${t.name}`;
}
