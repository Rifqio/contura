import { expect, it } from "vitest";
import { type QuickItem, createQuickSearch } from "./entries";

const WORDS = ["order", "customer", "invoice", "product", "stock", "payment", "refund", "ship", "cart", "event", "session", "user", "audit", "log", "tax"];
const SCHEMAS = ["public", "billing", "sales", "analytics", "staging"];

/** 20,000 names, the index's cap, spread over four Connections and five schemas. */
function names(): QuickItem[] {
  const out: QuickItem[] = [];
  for (let i = 0; i < 20_000; i++) {
    const name = `${WORDS[i % WORDS.length]}_${WORDS[(i * 7) % WORDS.length]}_${i}`;
    const qualifier = SCHEMAS[i % SCHEMAS.length];
    const connectionId = `c${i % 4}`;
    out.push({
      id: `${connectionId}:${qualifier}.${name}`,
      kind: i % 9 === 0 ? "view" : "table",
      name,
      qualifier,
      connection: { id: connectionId, name: connectionId, dialect: "postgres", production: false, readOnly: false, open: true },
      target: { kind: "object", connectionId, object: "table", path: { database: "db", schema: qualifier, name } },
    });
  }
  return out;
}

/** Each prefix of `word` typed in turn, as a person types it. */
const typing = (word: string) => Array.from({ length: word.length }, (_, i) => word.slice(0, i + 1));

it("typing_over_20000_names_takes_under_16ms_a_key_at_the_median", () => {
  const all = names();
  const recentIds = all.slice(0, 50).map((i) => i.id);
  const times: number[] = [];
  const builds: number[] = [];
  const sessions = ["order", "custinv", "billing.inv", "pay_ref", "evt", "staging.log_tax", "zzz"];
  // Warm the code paths once, as the second Quick Open of a session is.
  createQuickSearch(all, recentIds).rows("or");
  for (const word of sessions) {
    const b = performance.now();
    const search = createQuickSearch(all, recentIds);
    builds.push(performance.now() - b);
    for (const text of [...typing(word), word.slice(0, -1)]) {
      const t = performance.now();
      const rows = search.rows(text);
      times.push(performance.now() - t);
      expect(rows.length).toBeLessThanOrEqual(200);
    }
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  builds.sort((a, b) => a - b);
  const build = builds[Math.floor(builds.length / 2)];
  console.log(`quick open: median ${median.toFixed(2)}ms a key, worst ${times[times.length - 1].toFixed(2)}ms over ${times.length} keys; opening ${build.toFixed(2)}ms`);
  expect(median).toBeLessThan(16);
  // Made once as the box opens: well inside a frame budget of a few frames.
  expect(build).toBeLessThan(100);
});
