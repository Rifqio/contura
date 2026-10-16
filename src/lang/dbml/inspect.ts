import type { SchemaModel } from "../../api/types";
import type { Diagnostic } from "../protocol";

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Up to 3 names within edit distance 2, best first. */
function nearest(name: string, candidates: string[]): string[] {
  return candidates
    .map((c) => ({ c, d: editDistance(name.toLowerCase(), c.toLowerCase()) }))
    .filter((x) => x.d > 0 && x.d <= 2)
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, 3)
    .map((x) => x.c);
}

const COLUMN = /^Column '(.+)' does not exist in Table '(?:.+\.)?(.+)'$/;
const TABLE = /^Table '(.+)' does not exist in Schema '.+'$/;

/**
 * Turns the compiler's unknown-table and unknown-column errors into
 * "Unknown table …" / "Unknown column …" with "Did you mean" fixes, using the
 * names of the last valid model (the current text has no model while it has errors).
 */
export function inspectDbml(text: string, diagnostics: Diagnostic[], known: SchemaModel | null): Diagnostic[] {
  return diagnostics.map((d) => {
    const col = COLUMN.exec(d.message);
    const tab = TABLE.exec(d.message);
    if (!col && !tab) return d;
    const at = text.slice(d.from, d.to);
    let message: string;
    let names: string[];
    if (col) {
      const [, column, table] = col;
      message = `Unknown column ${table}.${column}`;
      names = known?.tables.find((t) => t.name === table)?.columns.map((c) => c.name) ?? [];
    } else {
      message = `Unknown table ${tab![1]}`;
      names = known?.tables.map((t) => t.name) ?? [];
    }
    const fixes = nearest(at, names).map((n) => ({
      title: `Did you mean ${n}?`,
      edits: [{ from: d.from, to: d.to, insert: n }],
    }));
    return { ...d, message, fixes };
  });
}
