import { expect, test, vi } from "vitest";
import type { IconEntry } from "../../../api/types";
import { bestMedian } from "../../../lang/flow/perfGate";
import { basicCount, basicResults, makeShelfIconSource, SHELF_ICON_LIMIT } from "./iconSource";

// Run alone through `npm run test:perf` (it needs --expose-gc). Provisional until Checkpoint M2 measures it.
const gc = () => (globalThis as unknown as { gc: () => void }).gc();
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

const PROVIDERS = ["aws-", "azure-", "gcp-", "k8s-", "", "", ""];
const WORDS = ["database", "cache", "chart", "mail", "alarm", "table", "map", "camera", "lambda", "queue", "user", "lock"];
/** A pack the size of the real one, provider and general names mixed. */
const PACK: IconEntry[] = Array.from({ length: 4600 }, (_, i) => ({
  name: `${PROVIDERS[i % PROVIDERS.length]}${WORDS[i % WORDS.length]}-${i}`,
  set: "lucide",
  title: `${WORDS[i % WORDS.length]} ${i}`,
  licence: null,
  aliasOf: null,
}));
const QUERIES = ["", "a", "aws", "aws-l", "data", "cache", "zzz", "k8s-q", "map 1", "lock-4", "ca", "e"];

test("the_source_loads_once_and_searches_without_growth", async () => {
  const entries = vi.fn(() => Promise.resolve(PACK));
  const source = makeShelfIconSource({ entries, count: basicCount, results: basicResults, remember: () => {} });
  expect(source.count("a")).toBeNull();
  expect(source.results("a", 8)).toEqual([]);
  await source.load();
  // The baseline holds the one prepared name list, so the loop measures growth, not the first fill.
  for (const q of QUERIES) {
    source.count(q);
    source.results(q, SHELF_ICON_LIMIT);
  }
  gc();
  const base = heapUsed();
  for (let i = 0; i < 500; i++) {
    const q = QUERIES[i % QUERIES.length];
    await source.load();
    source.count(q);
    source.results(q, SHELF_ICON_LIMIT);
    source.top(q, 8);
  }
  gc();
  expect(heapUsed() - base).toBeLessThan(1024 * 1024);
  expect(entries).toHaveBeenCalledTimes(1);
  const ms = bestMedian(() => source.results("a", SHELF_ICON_LIMIT));
  expect(ms).toBeLessThan(8);
});
