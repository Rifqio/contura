import { expect, test } from "vitest";
import type { RecentItem } from "../api/types";
import { lastOpened, lastOpenedText, recentSections, recentTime, recentTitle } from "./recent";

// Thursday 15 October 2026, 10:00 local time; the week began on Monday the 12th.
const now = new Date(2026, 9, 15, 10, 0);
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

function table(name: string, openedAtMs: number, connectionId: string | null = "c1"): RecentItem {
  return {
    target: { kind: "table", path: { database: "shop", schema: null, name }, object: "table" },
    connectionId,
    openedAtMs,
  };
}

test("items_fall_into_the_four_day_sections_in_order", () => {
  const items = [
    table("now", now.getTime()),
    table("yesterday", at(2026, 9, 14, 16, 12)),
    table("monday", at(2026, 9, 12, 9, 0)),
    table("last-month", at(2026, 8, 20, 9, 0)),
  ];
  const sections = recentSections(items, now);
  expect(sections.map((s) => s.label)).toEqual(["Today", "Yesterday", "Earlier this week", "Earlier"]);
  expect(sections.map((s) => s.items.map((i) => (i.target.kind === "table" ? i.target.path.name : "")))).toEqual([
    ["now"],
    ["yesterday"],
    ["monday"],
    ["last-month"],
  ]);
});

test("empty_sections_are_left_out", () => {
  const sections = recentSections([table("old", at(2025, 11, 3, 9, 0))], now);
  expect(sections.map((s) => s.label)).toEqual(["Earlier"]);
  expect(recentSections([], now)).toEqual([]);
});

test("on_monday_sunday_is_yesterday_and_the_week_starts_today", () => {
  const monday = new Date(2026, 9, 12, 9, 0);
  const sections = recentSections([table("sun", at(2026, 9, 11, 20, 0)), table("sat", at(2026, 9, 10, 20, 0))], monday);
  expect(sections.map((s) => s.label)).toEqual(["Yesterday", "Earlier"]);
});

test("recent_time_formats", () => {
  expect(recentTime(now.getTime() - 20_000, now)).toBe("now");
  expect(recentTime(now.getTime() - 12 * 60_000, now)).toBe("12m");
  expect(recentTime(now.getTime() - 2 * 3_600_000, now)).toBe("2h");
  expect(recentTime(at(2026, 9, 14, 16, 12), now)).toBe("16:12");
  expect(recentTime(at(2026, 9, 14, 9, 5), now)).toBe("09:05");
  expect(recentTime(at(2026, 9, 12, 9, 0), now)).toBe("Oct 12");
  expect(recentTime(at(2026, 9, 9, 9, 0), now)).toBe("Oct 9");
  expect(recentTime(at(2025, 11, 3, 9, 0), now)).toBe("2025-12-03");
});

test("last_opened_text_formats", () => {
  expect(lastOpenedText(now.getTime() - 20_000, now)).toBe("Just now");
  expect(lastOpenedText(now.getTime() - 12 * 60_000, now)).toBe("12m ago");
  expect(lastOpenedText(at(2026, 9, 15, 7, 41), now)).toBe("Today 07:41");
  expect(lastOpenedText(at(2026, 9, 14, 16, 12), now)).toBe("Yesterday 16:12");
  expect(lastOpenedText(at(2026, 9, 9, 16, 12), now)).toBe("Oct 9");
  expect(lastOpenedText(at(2025, 11, 3, 9, 0), now)).toBe("2025-12-03");
});

test("last_opened_gives_the_newest_item_of_a_connection", () => {
  const items = [
    table("a", at(2026, 9, 14, 9, 0), "c1"),
    table("b", at(2026, 9, 15, 9, 0), "c1"),
    table("c", at(2026, 9, 15, 9, 30), "c2"),
    table("d", at(2026, 9, 13, 9, 0), "c1"),
  ];
  expect(lastOpened(items, "c1")).toBe(at(2026, 9, 15, 9, 0));
  expect(lastOpened(items, "c3")).toBeNull();
});

test("titles_by_kind", () => {
  expect(recentTitle({ target: { kind: "query", savedId: "q1", name: "overdue invoices" }, connectionId: null, openedAtMs: 0 })).toBe(
    "overdue invoices",
  );
  expect(
    recentTitle({
      target: { kind: "table", path: { database: "freight", schema: "billing", name: "invoices" }, object: "table" },
      connectionId: "c1",
      openedAtMs: 0,
    }),
  ).toBe("billing.invoices");
  expect(
    recentTitle({
      target: { kind: "table", path: { database: "pos_live", schema: null, name: "sales_lines" }, object: "table" },
      connectionId: "c1",
      openedAtMs: 0,
    }),
  ).toBe("pos_live.sales_lines");
  expect(
    recentTitle({
      target: { kind: "table", path: { database: "main", schema: null, name: "events" }, object: "table" },
      connectionId: "c1",
      openedAtMs: 0,
    }),
  ).toBe("events");
  expect(
    recentTitle({ target: { kind: "schemaModel", file: "E:\\models\\kestrel_orders.dbml" }, connectionId: null, openedAtMs: 0 }),
  ).toBe("kestrel_orders.dbml");
});
