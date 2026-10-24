import type { Cell } from "../api/types";
import { cellCount, eachCell, type Selection } from "./selection";

/** Cells read for the summary: past this the status line says only how many are selected, so a click stays cheap. */
const READ_LIMIT = 100_000;

const WHOLE = /^-?\d+$/;
const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

/**
 * The status line's words for the selected cells (Excel): how many, how many hold a value, and the sum of the numbers.
 * Nothing for one cell. `numericColumn[c]` marks a column of numbers, whose edited (text) values still add.
 */
export function summarize(
  selection: Selection | null,
  cellAt: (row: number, column: number) => Cell | undefined,
  numericColumn: readonly boolean[],
  limit = READ_LIMIT,
): string | null {
  const total = cellCount(selection);
  if (total < 2) return null;
  const head = `${fmt(total)} cells selected`;
  if (total > limit) return head;
  let count = 0;
  let numbers = 0;
  let whole = 0n;
  let float = 0;
  let allWhole = true;
  eachCell(selection, (r, c) => {
    const cell = cellAt(r, c);
    if (!cell || cell.t === "null") return;
    count++;
    const value = cell.t === "number" ? cell.value : cell.t === "text" && numericColumn[c] && !cell.truncated ? cell.value.trim() : null;
    if (value === null || !NUMBER.test(value)) return;
    numbers++;
    if (allWhole && WHOLE.test(value)) whole += BigInt(value);
    else allWhole = false;
    float += Number(value);
  });
  const parts = [head, `Count ${fmt(count)}`];
  if (numbers > 0) {
    // Whole numbers add exactly (a bigint column goes past 2^53); decimals add as doubles, shown to 15 digits.
    parts.push(`Sum ${allWhole ? whole.toLocaleString("en-US") : Number.isFinite(float) ? fmt(Number(float.toPrecision(15)), 15) : "too large"}`);
  }
  return parts.join(", ");
}
