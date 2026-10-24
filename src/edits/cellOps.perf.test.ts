import { expect, it } from "vitest";
import type { Cell, ColumnInfo, Page } from "../api/types";
import { planCells } from "./cellOps";
import { displayRows } from "./gridRows";
import { applyMany, emptyPending, summary } from "./pending";

// C1 (UX step 3 review): Ctrl+A then Delete on a full page is one history step built in linear time.
it("ctrl_a_then_delete_on_a_1000_by_19_page_is_one_step_well_under_200ms", () => {
  const columns: ColumnInfo[] = Array.from({ length: 19 }, (_, i) => ({
    name: i === 0 ? "id" : `c${i}`,
    typeName: i === 0 ? "int8" : i % 2 ? "text" : "numeric",
    isPrimaryKey: i === 0,
  }));
  const rows: Cell[][] = Array.from({ length: 1000 }, (_, r) =>
    columns.map((_, c): Cell => (c === 0 || c % 2 === 0 ? { t: "number", value: String(r * 100 + c) } : { t: "text", value: `v${r}.${c}`, truncated: false, totalBytes: 6 })),
  );
  const page: Page = { columns, rows, hasMore: true };
  const design = new Map(columns.map((c) => [c.name, { nullable: c.name !== "id", defaultSql: null }]));
  const cells = rows.flatMap((_, row) => columns.map((_, column) => ({ row, column })));
  const once = () => {
    const p0 = emptyPending(columns);
    const view = displayRows(p0, page);
    const t = performance.now();
    const plan = planCells({ kind: "clear", view, columns, cells, design, updateDefault: true });
    const p1 = applyMany(p0, plan.ops)[0];
    const shown = displayRows(p1, page);
    const ms = performance.now() - t;
    return { ms, p0, p1, shown };
  };
  const runs = Array.from({ length: 5 }, once);
  const { p0, p1, shown } = runs[0];
  expect(p1.past.length).toBe(p0.past.length + 1);
  expect(summary(p1).cells).toBe(1000 * 18);
  expect(shown[999].cells[1]).toEqual({ t: "text", value: "", truncated: false, totalBytes: 0 });
  expect(shown[999].cells[2]).toEqual({ t: "null" });
  const median = runs.map((r) => r.ms).sort((a, b) => a - b)[2];
  console.log(`ctrl+A Delete 1000x19: ${median.toFixed(1)}ms`);
  expect(median).toBeLessThan(200);
});
