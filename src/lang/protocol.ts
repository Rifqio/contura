// Messages between the editor side (LangClient) and the language worker.
import type { DialectKind, SchemaModel } from "../api/types";
import type { MermaidResult } from "../flow/mermaid";
import type { FlowCompleteAnswer, FlowEditAnswer, FlowOutlineAnswer, FlowRequestOp, FlowResult, FlowSpansResult } from "./flow/service";
import type { LayoutRequest, Positions } from "../diagram/layout";
import type { Range } from "./sql/analyze";
import type { SqlCompletionResult } from "./sql/complete";
import type { SchemaState } from "./sql/inspect";
import type { QueryShape, ShapeProblem } from "./sql/queryShape";
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

export type { FlowBatchOp, FlowCompleteAnswer, FlowEditAnswer, FlowOutlineAnswer, FlowRequestOp, FlowResult, FlowSpansResult } from "./flow/service";
export type { FlowCompletionResult } from "./flow/complete";
export type { FlowEditOp } from "./flow/edits";

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
  /** The query diagram's shape of the statement at `pos`, debounced like sqlAnalyze (D13). */
  | { type: "sqlShape"; id: number; docId: string; text: string; dialect: DialectKind; schemaKey: string | null; schemaState: SchemaState; pos: number }
  | ({ type: "sqlComplete"; id: number; docId?: string; explicit: boolean; aliasTables?: boolean } & SqlAt)
  | ({ type: "sqlRefactor"; id: number; docId?: string; action: SqlRefactorAction } & SqlAt)
  /** Places the diagram nodes the request has no position for (ruling D14). */
  | { type: "layout"; id: number; request: LayoutRequest }
  /** Converts a Mermaid flowchart to .flow (Task 12); the dialog waits 150 ms after the last keystroke. */
  | { type: "mermaid"; id: number; text: string; title: string; keepUnread?: boolean }
  /** Parses .flow text, debounced as the DBML path is. */
  | { type: "flowParse"; id: number; docId: string; text: string }
  /** The flow tab closed: forget its text, ranges and last good doc, and drop parses that arrive later. */
  | { type: "flowClose"; docId: string }
  /** A DBML editor closed: forget its last valid model. */
  | { type: "dbmlClose"; docId: string }
  /** A flow tab opened again under a closed id. */
  | { type: "flowOpen"; docId: string }
  /** Source ranges of the parse with `version`; refused as stale when the text has changed since. */
  | { type: "flowSpans"; id: number; docId: string; version: number; keys: string[]; names: string[] }
  /** A canvas action as text edits against the parse with `version`; refused as stale when the text has changed. */
  | { type: "flowEdit"; id: number; docId: string; version: number; edit: FlowRequestOp }
  /** The outline of the parse with `version`, for the diagram assistant; refused as stale when the text has changed. */
  | { type: "flowOutline"; id: number; docId: string; version: number }
  /** Completion at `pos` in a .flow text. */
  | { type: "flowComplete"; id: number; docId: string; text: string; pos: number }
  /** Every icon name, for completion after `icon:`. */
  | { type: "flowIcons"; names: string[] };

export type FromWorker =
  | { type: "result"; ids: number[]; docId: string; result: ParseResult }
  | { type: "sqlDiagnostics"; ids: number[]; docId: string; diagnostics: Diagnostic[] }
  | { type: "sqlShape"; ids: number[]; result: QueryShape | ShapeProblem }
  | { type: "sqlCompletion"; ids: number[]; result: SqlCompletionResult }
  | { type: "sqlRefactor"; ids: number[]; result: SqlRefactorResult }
  | { type: "layout"; ids: number[]; positions: Positions }
  | { type: "mermaid"; ids: number[]; result: MermaidResult }
  | { type: "flowResult"; ids: number[]; docId: string; result: FlowResult }
  | { type: "flowSpans"; ids: number[]; result: FlowSpansResult }
  | { type: "flowEdit"; ids: number[]; result: FlowEditAnswer }
  | { type: "flowOutline"; ids: number[]; result: FlowOutlineAnswer }
  | { type: "flowCompletion"; ids: number[]; result: FlowCompleteAnswer }
  | { type: "failed"; ids: number[]; message: string };

/** The one key for a table, used by ranges, edits and the canvas layout. */
export function tableKey(t: { schema: string | null; name: string }): string {
  return `${t.schema ?? ""}.${t.name}`;
}
