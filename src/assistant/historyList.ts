// The chat history list as data (D2 Decision 8): day groups, the row's time and the window of items drawn past
// LIST_WINDOW rows. Pure, no React, so the perf gate times it in node.
import type { ThreadSummary } from "../api/types";

export type DayGroup = "Today" | "Yesterday" | "Previous 7 days" | "Older";

/** Up to this many rows the list draws them all; past it, only the items in view and a few each side. */
export const LIST_WINDOW = 200;
/** A row's height in px (two lines and 8 px padding); `.history-menu .history-item` in app.css. */
export const ROW_PX = 52;
/** A day header's height in px; `.history-menu .history-group` in app.css. */
export const HEAD_PX = 28;
/** The list's CSS `max-height`, the height read when the list has none yet (jsdom has no layout). */
export const LIST_PX = 320;
/** Items drawn past each end of the view, so a quick scroll or an arrow key never shows a gap. */
const OVERSCAN = 4;

export type ListItem = { kind: "head"; label: DayGroup } | { kind: "row"; row: ThreadSummary };

const midnight = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

/** The rows by local calendar day against `now`, newest first; groups with no rows are left out. */
export function groupByDay(rows: readonly ThreadSummary[], now: number): { label: DayGroup; rows: ThreadSummary[] }[] {
  const n = new Date(now);
  const [y, m, d] = [n.getFullYear(), n.getMonth(), n.getDate()];
  // Date arithmetic on the calendar, not 86,400,000 ms steps, so a daylight saving day keeps its midnight.
  const today = midnight(y, m, d);
  const yesterday = midnight(y, m, d - 1);
  const week = midnight(y, m, d - 7);
  const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups: { label: DayGroup; rows: ThreadSummary[] }[] = [];
  for (const row of sorted) {
    const at = row.updatedAt;
    const label: DayGroup = at >= today ? "Today" : at >= yesterday ? "Yesterday" : at >= week ? "Previous 7 days" : "Older";
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A row's time: `HH:MM` today, else `MMM D`, and `MMM D, YYYY` in another year. */
export function rowTime(at: number, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === n.getFullYear() ? day : `${day}, ${d.getFullYear()}`;
}

const heightOf = (item: ListItem) => (item.kind === "head" ? HEAD_PX : ROW_PX);

/**
 * The items to draw, `from` (first) to `to` (one past the last), with the spacer heights in px above and below.
 * All of them while the rows are at or under LIST_WINDOW; past it, the items in view of `scrollTop` and `height`
 * (0 reads as LIST_PX) plus OVERSCAN each side.
 */
export function rowWindow(items: readonly ListItem[], scrollTop: number, height: number): { from: number; to: number; before: number; after: number } {
  let rows = 0;
  for (const item of items) if (item.kind === "row") rows++;
  if (rows <= LIST_WINDOW) return { from: 0, to: items.length, before: 0, after: 0 };
  const top = Math.max(0, scrollTop);
  const bottom = top + (height > 0 ? height : LIST_PX);
  let y = 0;
  let first = -1;
  let last = items.length - 1;
  for (let i = 0; i < items.length; i++) {
    const end = y + heightOf(items[i]);
    if (first < 0 && end > top) first = i;
    if (y >= bottom) {
      last = i - 1;
      break;
    }
    y = end;
  }
  if (first < 0) first = items.length - 1;
  if (last < first) last = first;
  const from = Math.max(0, first - OVERSCAN);
  const to = Math.min(items.length, last + 1 + OVERSCAN);
  let before = 0;
  let after = 0;
  for (let i = 0; i < from; i++) before += heightOf(items[i]);
  for (let i = to; i < items.length; i++) after += heightOf(items[i]);
  return { from, to, before, after };
}
