import { expect, test } from "vitest";
import { createErStore, type ErCardView } from "./erCanvas";

// Decision 6 at the board limit: 2,000 tables in one ERD frame. Run alone through `npm run test:perf` (it needs --expose-gc).
const gc = () => (globalThis as unknown as { gc: () => void }).gc();
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

const TABLES = Array.from({ length: 2000 }, (_, i) => `table_${i}`);

test("a_store_with_2000_cards_at_rest_holds_nothing", () => {
  const s = createErStore();
  const churn = () => {
    for (let i = 0; i < 500; i++) {
      const table = TABLES[(i * 7) % TABLES.length];
      if (i % 3 === 0) s.set({ edit: { kind: "col", table, index: i % 20, field: "name" } });
      else if (i % 3 === 1) s.set({ selected: { table, index: i % 20 } });
      else s.set({ aim: { table, index: (i % 21) - 1 } });
    }
    for (const t of TABLES) s.view(t);
  };
  // The first pass warms the code paths, so the second measures growth, not the first fill.
  churn();
  gc();
  const base = heapUsed();
  churn();
  gc();
  expect(s.size()).toBeLessThanOrEqual(3);
  expect(heapUsed() - base).toBeLessThan(1024 * 1024);
});

test("one_change_changes_two_views", () => {
  const s = createErStore();
  s.set({ selected: { table: TABLES[10], index: 2 } });
  const before: (ErCardView | null)[] = TABLES.map((t) => s.view(t));
  s.set({ selected: { table: TABLES[1500], index: 0 } });
  let changed = 0;
  TABLES.forEach((t, i) => {
    if (s.view(t) !== before[i]) changed++;
  });
  expect(changed).toBe(2);
});
