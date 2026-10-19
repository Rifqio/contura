import type { ConnectionId, RecentItem } from "../api/types";
import { agoShort } from "../format/units";

/** At most this many rows in Recent, diagrams counted; mirrors RECENT_LIMIT in crates/contura-core/src/recent.rs. */
export const RECENT_LIMIT = 50;

export type DayLabel = "Today" | "Yesterday" | "Earlier this week" | "Earlier";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function daysBefore(d: Date, n: number): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
}

/** Midnight of the Monday that began `now`'s week. */
function startOfWeek(now: Date): number {
  return daysBefore(now, (now.getDay() + 6) % 7);
}

const two = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
const isoDate = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

/** "Oct 14" in the current year, "2025-12-03" in another. */
function dateText(d: Date, now: Date): string {
  return d.getFullYear() === now.getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : isoDate(d);
}

function dayOf(ms: number, now: Date): DayLabel {
  if (ms >= startOfDay(now)) return "Today";
  if (ms >= daysBefore(now, 1)) return "Yesterday";
  if (ms >= startOfWeek(now)) return "Earlier this week";
  return "Earlier";
}

const ORDER: DayLabel[] = ["Today", "Yesterday", "Earlier this week", "Earlier"];

/** The items by day, in list order within each day; a day with no items is left out. */
export function recentSections(items: RecentItem[], now: Date): { label: DayLabel; items: RecentItem[] }[] {
  return sectionsBy(items, (i) => i.openedAtMs, now);
}

/** Any rows by day, by the time `at` gives each, in list order within each day. */
export function sectionsBy<T>(items: T[], at: (item: T) => number, now: Date): { label: DayLabel; items: T[] }[] {
  const byDay = new Map<DayLabel, T[]>();
  for (const item of items) {
    const day = dayOf(at(item), now);
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  return ORDER.flatMap((label) => {
    const list = byDay.get(label);
    return list ? [{ label, items: list }] : [];
  });
}

/** The Recent column's short time: "now", "12m", "2h" today; "16:12" yesterday; a date before. */
export function recentTime(ms: number, now: Date): string {
  const d = new Date(ms);
  const day = dayOf(ms, now);
  if (day === "Today") {
    const ago = Math.max(0, now.getTime() - ms);
    return agoShort(ago, now);
  }
  if (day === "Yesterday") return clock(d);
  return dateText(d, now);
}

/** When a Connection last had an item opened, from the Recent list; null when never. */
export function lastOpened(items: RecentItem[], id: ConnectionId): number | null {
  let newest: number | null = null;
  for (const item of items) {
    if (item.connectionId === id && (newest === null || item.openedAtMs > newest)) newest = item.openedAtMs;
  }
  return newest;
}

/** A Home row's last-opened time: "Just now", "12m ago", "Today 09:41", "Yesterday 16:12", "Oct 9". */
export function lastOpenedText(ms: number, now: Date): string {
  const d = new Date(ms);
  const day = dayOf(ms, now);
  if (day === "Today") {
    const ago = Math.max(0, now.getTime() - ms);
    if (ago < MINUTE) return "Just now";
    if (ago < HOUR) return `${agoShort(ago, now)} ago`;
    return `Today ${clock(d)}`;
  }
  if (day === "Yesterday") return `Yesterday ${clock(d)}`;
  return dateText(d, now);
}

/** The file name at the end of a Windows or POSIX path. */
export function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
}

/** A query's name, a schema-qualified table (`billing.invoices`), or a model's file name. */
export function recentTitle(item: RecentItem): string {
  const t = item.target;
  if (t.kind === "query") return t.name;
  if (t.kind === "schemaModel") return fileName(t.file);
  // SQLite's one database is "main"; naming it adds nothing.
  const qualifier = t.path.schema ?? (t.path.database === "main" ? null : t.path.database);
  return qualifier ? `${qualifier}.${t.path.name}` : t.path.name;
}

/** The kind word, said in the row's label and tooltip only. */
export function recentKind(item: RecentItem): string {
  const t = item.target;
  if (t.kind === "query") return "Query";
  if (t.kind === "schemaModel") return "Schema model";
  return t.object === "view" ? "View" : "Table";
}
