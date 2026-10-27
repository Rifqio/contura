import { expect, test } from "vitest";
import type { IconEntry } from "../../../api/types";
import { bestMedian } from "../../../lang/flow/perfGate";
import { basicCount, basicResults, makeShelfIconSource } from "./iconSource";
import { spaceResults } from "./spaceResults";

// Task 11 (provisional until Task 15 measures it). Run alone through `npm run test:perf` (it needs --expose-gc).
const gc = () => (globalThis as unknown as { gc: () => void }).gc();
const heapUsed = () => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

const PROVIDERS = ["aws-", "azure-", "gcp-", "k8s-", "", "", ""];
const SETS = ["aws", "azure", "gcp", "k8s", "lucide", "simple", "tabler"];
const WORDS = ["database", "cache", "chart", "mail", "alarm", "table", "map", "camera", "lambda", "queue", "user", "lock"];
/** A pack the size of the real one, provider and general names mixed. */
const PACK: IconEntry[] = Array.from({ length: 4600 }, (_, i) => ({
  name: `${PROVIDERS[i % PROVIDERS.length]}${WORDS[i % WORDS.length]}-${i}`,
  set: SETS[i % SETS.length],
  title: `${WORDS[i % WORDS.length]} ${i}`,
  licence: null,
  aliasOf: null,
}));
const QUERIES = ["", "f", "flow", "shop", "er", "aws", "data", "cache", "zzz", "k8s-q", "sequence", "map 1", "lock-4", "ca", "e"];

test("results_take_under_8ms_and_hold_nothing", async () => {
  const icons = makeShelfIconSource({ entries: () => Promise.resolve(PACK), count: basicCount, results: basicResults, remember: () => {} });
  await icons.load();
  // The baseline holds the catalog index and the one prepared name list, so the loop measures growth, not the first fill.
  for (const q of QUERIES) spaceResults(q, icons);
  gc();
  const base = heapUsed();
  for (let i = 0; i < 500; i++) {
    const rows = spaceResults(QUERIES[i % QUERIES.length], icons);
    expect(rows.length).toBeLessThanOrEqual(8);
  }
  gc();
  expect(heapUsed() - base).toBeLessThan(1024 * 1024);
  for (const q of ["a", "data", ""]) expect(bestMedian(() => spaceResults(q, icons))).toBeLessThan(8);
});
