import { expect, test } from "vitest";
import { ER_CARD_CHROME, ER_MAX_ROWS, erFits, erRowWindow, erViewH, KIND_ROW } from "./kindLayout";

// Decision 7 at the board limit: a card draws at most 22 rows whatever its columns, size or scroll, and 2,000
// cards' windows cost nothing. Run alone through `npm run test:perf`.

test("the_window_never_passes_22_rows", () => {
  // Every card height from 0 to the 20-row cap in 1 px steps, plus the natural (undefined) one and one past the cap.
  const heights: (number | undefined)[] = [undefined, 1000];
  for (let h = 0; h <= ER_CARD_CHROME + ER_MAX_ROWS * KIND_ROW; h++) heights.push(h);
  expect(Math.max(...heights.map(erFits))).toBe(ER_MAX_ROWS);
  const views = [...new Set(heights.map(erViewH))];
  let worst = 0;
  const check = (count: number, view: number, scroll: number) => {
    const { from, to } = erRowWindow(count, view, scroll);
    if (to - from > worst) worst = to - from;
    if (from < 0 || to > count || to < from) throw new Error(`bad window ${from}..${to} for ${count}, ${view}, ${scroll}`);
    // Every row that meets the visible range is drawn: no blank band above or below (review Important 1).
    if ((from > 0 && from * KIND_ROW + 3 > scroll) || (to < count && to * KIND_ROW + 3 < scroll + view)) {
      throw new Error(`gap in ${from}..${to} for ${count}, ${view}, ${scroll}`);
    }
  };
  // The window depends on the scroll only modulo a row, but for the clamps at the top and the end: so every offset
  // of one row period at the top and in the middle, every px around the last scroll position, and past the end.
  for (let count = 0; count <= 2000; count++) {
    const mid = Math.floor(count / 2) * KIND_ROW;
    for (const view of views) {
      const last = Math.max(0, count * KIND_ROW + 6 - view);
      for (let o = 0; o < KIND_ROW; o++) {
        check(count, view, o);
        check(count, view, mid + o);
      }
      for (let scroll = Math.max(0, last - KIND_ROW); scroll <= last + KIND_ROW; scroll++) check(count, view, scroll);
      for (const past of [count * KIND_ROW, count * KIND_ROW + KIND_ROW, count * KIND_ROW + 1000]) check(count, view, past);
    }
  }
  expect(worst).toBeLessThanOrEqual(22);
  expect(erFits(ER_CARD_CHROME + 5 * KIND_ROW)).toBe(5);
});

test("erRowWindow_for_2000_cards_under_1ms", () => {
  const run = () => {
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      const w = erRowWindow(20 + (i % 300), erViewH(i % 2 ? undefined : 300), (i * 37) % 6000);
      n += w.to - w.from;
    }
    return n;
  };
  for (let i = 0; i < 20; i++) run();
  let best = Infinity;
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    run();
    best = Math.min(best, performance.now() - t);
  }
  expect(best).toBeLessThan(1);
});
