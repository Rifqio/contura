// @vitest-environment jsdom
import { expect, test } from "vitest";
import { bestMedian } from "../../../lang/flow/perfGate";
import { boardPreviewUrls, previewCacheSize } from "./preview";
import { indexBuilds, searchKinds, searchTemplates } from "./search";
import { BOARD_TEMPLATES } from "./templates";

// Run alone through `npm run test:perf` (it needs --expose-gc). The thresholds are provisional until Checkpoint M2.
const gc = () => (globalThis as unknown as { gc: () => void }).gc();
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;
const QUERIES = ["", "o", "er", "erd", "triage", "seq", "cloud", "shop", "zzz", "state machine", "a b", "flow"];

test("a_thousand_searches_do_not_grow_the_heap", () => {
  searchTemplates("o", "all");
  gc();
  const base = heapUsed();
  for (let i = 0; i < 1000; i++) {
    searchKinds(QUERIES[i % QUERIES.length]);
    searchTemplates(QUERIES[i % QUERIES.length], "all");
  }
  gc();
  expect(heapUsed() - base).toBeLessThan(1024 * 1024);
});

test("searching_kinds_and_templates_takes_under_1ms", () => {
  const ms = bestMedian((run) => {
    searchKinds(QUERIES[run % QUERIES.length]);
    searchTemplates(QUERIES[run % QUERIES.length], "all");
  });
  expect(ms).toBeLessThan(1);
});

test("the_index_is_built_once", () => {
  for (let i = 0; i < 50; i++) searchTemplates(QUERIES[i % QUERIES.length], "all");
  expect(indexBuilds()).toBe(1);
});

test("previews_keep_one_theme_and_stay_bounded", () => {
  // The baseline holds every board in one theme, so the loop measures growth, not the first fill.
  for (const b of BOARD_TEMPLATES) boardPreviewUrls(b.id, "dark");
  for (const b of BOARD_TEMPLATES) boardPreviewUrls(b.id, "light");
  gc();
  const base = heapUsed();
  for (let i = 0; i < 40; i++) {
    const theme = i % 2 ? "dark" : "light";
    for (const b of BOARD_TEMPLATES) {
      boardPreviewUrls(b.id, theme);
      searchKinds(QUERIES[i % QUERIES.length]);
      searchTemplates(QUERIES[i % QUERIES.length], "all");
    }
    expect(previewCacheSize()).toBe(BOARD_TEMPLATES.length);
  }
  gc();
  expect(heapUsed() - base).toBeLessThan(1024 * 1024);
});
