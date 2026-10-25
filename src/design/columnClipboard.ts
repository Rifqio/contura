// The column Copy took in a Table Designer (D4). It outlives the tab on purpose, so a column copies from one table
// to another; it holds one column's few strings, and the Dialect it came from, since a type or default of one
// Dialect is not the other's.
import type { ColumnDraft, DialectKind } from "../api/types";

export interface CopiedColumn {
  column: ColumnDraft;
  dialect: DialectKind;
  /** What the copy left out: auto-increment (and a serial's own sequence default) goes with the keys. */
  dropped: "increment" | null;
}

let copied: CopiedColumn | null = null;

export function copiedColumn(dialect: DialectKind): CopiedColumn | null {
  return copied && copied.dialect === dialect ? copied : null;
}

export function setCopiedColumn(c: CopiedColumn): void {
  copied = c;
}

export function clearCopiedColumn(): void {
  copied = null;
}
