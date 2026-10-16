// Messages between the editor side (LangClient) and the language worker.
import type { DialectKind, SchemaModel } from "../api/types";

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

export type ToWorker = { type: "update"; id: number; docId: string; text: string; dialect: DialectKind };

export type FromWorker =
  | { type: "result"; ids: number[]; docId: string; result: ParseResult }
  | { type: "failed"; ids: number[]; message: string };

/** The one key for a table, used by ranges, edits and the canvas layout. */
export function tableKey(t: { schema: string | null; name: string }): string {
  return `${t.schema ?? ""}.${t.name}`;
}
