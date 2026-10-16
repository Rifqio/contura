import { expect, test } from "vitest";
import { completeSql } from "./complete";
import type { SqlSchema } from "./types";

const big: SqlSchema = {
  searchPath: ["public"],
  tables: Array.from({ length: 2000 }, (_, i) => ({
    schema: "public",
    name: `t${i}`,
    kind: "table" as const,
    columns: Array.from({ length: 15 }, (_, c) => ({ name: `c${c}_of_${i}`, typeName: "int4", pk: c === 0 })),
  })),
  fks: Array.from({ length: 1999 }, (_, i) => ({
    from: { schema: "public", table: `t${i + 1}`, columns: [`c1_of_${i + 1}`] },
    to: { schema: "public", table: `t${i}`, columns: [`c0_of_${i}`] },
  })),
};

test("complete_2000_tables_under_50ms", () => {
  const cases = [
    { text: "SELECT * FROM ", pos: "SELECT * FROM ".length },
    { text: "SELECT t1234. FROM t1234", pos: "SELECT t1234.".length },
  ];
  completeSql(cases[0].text, cases[0].pos, "postgres", big, false);
  let slowest = 0;
  for (let i = 0; i < 20; i++)
    for (const c of cases) {
      const t0 = performance.now();
      const r = completeSql(c.text, c.pos, "postgres", big, false);
      slowest = Math.max(slowest, performance.now() - t0);
      expect(r.items.length).toBeGreaterThan(0);
    }
  expect(slowest).toBeLessThan(50);
});
