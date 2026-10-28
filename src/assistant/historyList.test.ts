import { expect, test } from "vitest";
import type { ThreadSummary } from "../api/types";
import { HEAD_PX, LIST_PX, LIST_WINDOW, type ListItem, ROW_PX, groupByDay, rowTime, rowWindow } from "./historyList";

const NOW = new Date(2026, 9, 22, 12, 0).getTime();
const summary = (id: string, at: number): ThreadSummary => ({
  id,
  place: "ungrouped",
  title: id,
  titleBy: "rule",
  updatedAt: at,
  messages: 2,
  topics: 1,
  work: null,
});

test("groups_today_yesterday_previous_7_days_older", () => {
  const rows = [
    summary("older", new Date(2026, 9, 14, 12, 0).getTime()), // 8 days ago
    summary("today-midnight", new Date(2026, 9, 22, 0, 0).getTime()),
    summary("now", NOW),
    summary("yesterday-late", new Date(2026, 9, 21, 23, 59).getTime()),
    summary("six-days", new Date(2026, 9, 16, 9, 0).getTime()),
    summary("yesterday-early", new Date(2026, 9, 21, 0, 0).getTime()),
    summary("before-yesterday", new Date(2026, 9, 20, 23, 59).getTime()),
  ];
  const groups = groupByDay(rows, NOW);
  expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([
    ["Today", ["now", "today-midnight"]],
    ["Yesterday", ["yesterday-late", "yesterday-early"]],
    ["Previous 7 days", ["before-yesterday", "six-days"]],
    ["Older", ["older"]],
  ]);
  // Empty groups are left out.
  expect(groupByDay([summary("now", NOW), summary("older", NOW - 30 * 86_400_000)], NOW).map((g) => g.label)).toEqual(["Today", "Older"]);
  expect(groupByDay([], NOW)).toEqual([]);
});

test("row_time_is_clock_today_else_date", () => {
  expect(rowTime(new Date(2026, 9, 22, 9, 5).getTime(), NOW)).toBe("09:05");
  expect(rowTime(new Date(2026, 9, 21, 23, 59).getTime(), NOW)).toBe("Oct 21");
  expect(rowTime(new Date(2026, 0, 3, 8, 0).getTime(), NOW)).toBe("Jan 3");
  expect(rowTime(new Date(2025, 11, 30, 8, 0).getTime(), NOW)).toBe("Dec 30, 2025");
});

/** `n` rows under the four day headers, as the popover lays them out. */
function items(n: number): ListItem[] {
  const labels = ["Today", "Yesterday", "Previous 7 days", "Older"] as const;
  const out: ListItem[] = [];
  const per = Math.ceil(n / labels.length);
  for (let g = 0, made = 0; g < labels.length && made < n; g++) {
    out.push({ kind: "head", label: labels[g] });
    for (let i = 0; i < per && made < n; i++, made++) out.push({ kind: "row", row: summary(`r${made}`, NOW - made * 60_000) });
  }
  return out;
}

const fullHeight = (list: readonly ListItem[]) => list.reduce((h, it) => h + (it.kind === "head" ? HEAD_PX : ROW_PX), 0);

test("row_window_is_all_rows_up_to_200", () => {
  const list = items(LIST_WINDOW);
  expect(list.filter((x) => x.kind === "row")).toHaveLength(200);
  expect(rowWindow(list, 0, 0)).toEqual({ from: 0, to: list.length, before: 0, after: 0 });
  expect(rowWindow(list, 4000, 320)).toEqual({ from: 0, to: list.length, before: 0, after: 0 });
});

test("row_window_past_200_draws_the_visible_items_plus_4", () => {
  const list = items(250);
  expect(list).toHaveLength(254);
  const total = fullHeight(list);
  // Height 0 (jsdom has no layout) reads as LIST_PX: the items starting above 320 px are in view, then 4 more.
  const top = rowWindow(list, 0, 0);
  let y = 0;
  let inView = 0;
  while (y < LIST_PX) y += list[inView++].kind === "head" ? HEAD_PX : ROW_PX;
  expect(top.from).toBe(0);
  expect(top.to).toBe(inView + 4);
  expect(top.before).toBe(0);
  expect(top.before + fullHeight(list.slice(top.from, top.to)) + top.after).toBe(total);
  expect(top.to - top.from).toBeLessThan(20);

  // Scrolled to the middle: 4 items above the first in view, 4 below the last, spacers fill the rest.
  const mid = rowWindow(list, Math.floor(total / 2), 320);
  expect(mid.from).toBeGreaterThan(100);
  expect(mid.to - mid.from).toBeLessThan(20);
  expect(mid.before).toBe(fullHeight(list.slice(0, mid.from)));
  expect(mid.before + fullHeight(list.slice(mid.from, mid.to)) + mid.after).toBe(total);
  expect(mid.before).toBeLessThanOrEqual(Math.floor(total / 2) - 4 * HEAD_PX);

  // Scrolled to the end: the last item is drawn and nothing comes after it.
  const end = rowWindow(list, total - 320, 320);
  expect(end.to).toBe(list.length);
  expect(end.after).toBe(0);
});
