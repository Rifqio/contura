import { expect, test } from "vitest";
import type { ThreadSummary } from "../api/types";
import { bestMedian } from "../lang/flow/perfGate";
import { type ListItem, groupByDay, rowTime, rowWindow } from "./historyList";

// Timing test: runs alone through `npm run test:perf`. Opening the chat history groups the place's chats by day and
// lays out the window; 500 chats stay far under the spec's 50 ms for the list.
const NOW = new Date(2026, 9, 22, 12, 0).getTime();
const rows: ThreadSummary[] = Array.from({ length: 500 }, (_, i) => ({
  id: `t${i}`,
  place: "ungrouped",
  title: `Chat ${i}`,
  titleBy: "rule",
  updatedAt: NOW - ((i * 7919) % 500) * 3_600_000,
  messages: 2,
  topics: 1,
  work: { connectionId: "c1", database: "shop", table: "orders", tabLabel: null },
}));

test("five_hundred_rows_group_under_5ms", () => {
  let drawn = 0;
  const ms = bestMedian(() => {
    const items: ListItem[] = [];
    for (const g of groupByDay(rows, NOW)) {
      items.push({ kind: "head", label: g.label });
      for (const row of g.rows) items.push({ kind: "row", row });
    }
    const w = rowWindow(items, 0, 0);
    for (let i = w.from; i < w.to; i++) {
      const it = items[i];
      if (it.kind === "row") drawn += rowTime(it.row.updatedAt, NOW).length;
    }
  });
  expect(drawn).toBeGreaterThan(0);
  expect(ms).toBeLessThan(5);
});
