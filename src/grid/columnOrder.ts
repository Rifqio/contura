/**
 * The order a grid shows its columns in, view only: the table or result keeps its own order, and nothing here ever
 * alters a table or a query. An order is one array of column indexes (into the columns and into every row), so a
 * moved column copies no row and allocates nothing per cell.
 */

/** The table's (or the query's) own order: 0 to n - 1. */
export function ownOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** The columns are in their own order: every index after a smaller one (the shown part of the own order too). */
export function isOwnOrder(order: readonly number[]): boolean {
  return order.every((c, i) => i === 0 || order[i - 1] < c);
}

/** The columns on screen, in the order shown: `order` without the hidden ones. */
export function shownOf(order: readonly number[], hidden: (column: number) => boolean): number[] {
  return order.filter((c) => !hidden(c));
}

/**
 * Moves the column at shown position `from` into the gap `slot` (0 is before the first shown column, `shown.length`
 * after the last), keeping hidden columns where they were in `order`. Returns the new order and the column's new
 * shown position, or null when the gap is on either side of it (nothing moves).
 */
export function moveColumn(
  order: readonly number[],
  shown: readonly number[],
  from: number,
  slot: number,
): { order: number[]; at: number } | null {
  if (from < 0 || from >= shown.length || slot < 0 || slot > shown.length || slot === from || slot === from + 1) return null;
  const column = shown[from];
  const next = order.filter((c) => c !== column);
  if (slot < shown.length) next.splice(next.indexOf(shown[slot]), 0, column);
  else next.splice(next.indexOf(shown[shown.length - 1]) + 1, 0, column);
  return { order: next, at: slot > from ? slot - 1 : slot };
}

/**
 * A remembered order (column names) over the columns the table has now. Names still there keep their remembered
 * places; a new column goes in after the column before it in the table (first when it is the table's first); names
 * gone are dropped. Every column is in the result once, so none is ever hidden by a stale order.
 */
export function orderFromNames(saved: readonly string[] | null, names: readonly string[]): number[] {
  if (!saved || saved.length === 0) return ownOrder(names.length);
  const at = new Map<string, number>();
  names.forEach((n, i) => {
    if (!at.has(n)) at.set(n, i);
  });
  const out: number[] = [];
  const used = new Set<number>();
  for (const n of saved) {
    const i = at.get(n);
    if (i !== undefined && !used.has(i)) {
      used.add(i);
      out.push(i);
    }
  }
  for (let i = 0; i < names.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    out.splice(i === 0 ? 0 : out.indexOf(i - 1) + 1, 0, i);
  }
  return out;
}

/** The order as column names, for remembering it; null when it is the table's own. */
export function namesOfOrder(order: readonly number[], names: readonly string[]): string[] | null {
  return isOwnOrder(order) ? null : order.map((c) => names[c]);
}
