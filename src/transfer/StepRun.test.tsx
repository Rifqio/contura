import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import StepRun, { runTime, type StepRunProps } from "./StepRun";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

const TABLES = [
  { table: "stores", rowsHint: 412 },
  { table: "products", rowsHint: 2_316 },
  { table: "customers", rowsHint: 18_904 },
  { table: "sales", rowsHint: 1_284_339 },
  { table: "sales_lines", rowsHint: 4_012_876 },
  { table: "payments", rowsHint: 1_190_220 },
];

const PG_ERROR =
  "sales_lines, row 2,114,903: the value NaN is not valid for numeric(10,2) in unit_price. The transaction rolled back, so pinecone-analytics is as it was.";

function props(over: Partial<StepRunProps> = {}): StepRunProps {
  return {
    tables: TABLES,
    target: "pinecone-analytics",
    targetDialect: "postgres",
    mode: "oneTransaction",
    structure: "6 tables, 1 type, 9 indexes created.",
    startedAt: 0,
    progress: { table: "sales", rowsDone: 1_190_000, rowsTotal: 1_284_339, statementsDone: 3 },
    outcome: null,
    countsCompared: true,
    onOpenTarget: () => {},
    now: 111_000,
    ...over,
  };
}

const row = (name: string) => document.querySelector<HTMLElement>(`tr[data-table="${name}"]`)!;
const state = (name: string) => row(name).querySelector("td:last-child")!.textContent;

test("the running frame: title, times, overall rows and structure", () => {
  render(<StepRun {...props()} />);
  expect(screen.getByText("Copying 6 tables to pinecone-analytics")).toBeTruthy();
  expect(screen.getByText(/^1m 51s elapsed, about .+ left$/)).toBeTruthy();
  // 412 + 2,316 + 18,904 done, plus 1,190,000 of sales.
  expect(screen.getByText("1,211,632 of 6,509,067 rows")).toBeTruthy();
  expect(screen.getByText("Structure: 6 tables, 1 type, 9 indexes created. Foreign Keys are added after the rows.")).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Transfer progress" }).getAttribute("aria-valuenow")).toBe("19");
  expect(screen.getByText("PostgreSQL target: everything runs in one transaction. Cancel rolls it all back.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Copy error/ })).toBeNull();
});

test("per-table states mid-way through the 4th table", () => {
  render(<StepRun {...props()} />);
  expect(["stores", "products", "customers"].map(state)).toEqual(["Done", "Done", "Done"]);
  expect(state("sales")).toBe("Copying");
  expect(state("sales_lines")).toBe("Waiting");
  expect(state("payments")).toBe("Waiting");
  expect(within(row("stores")).getByText("412 of 412")).toBeTruthy();
  expect(within(row("sales")).getByText("1,190,000 of 1,284,339")).toBeTruthy();
  expect(within(row("sales_lines")).getByText("0 of 4,012,876")).toBeTruthy();
});

test("the running hint on a MySQL target", () => {
  render(<StepRun {...props({ targetDialect: "mysql", mode: "perTable", target: "kestrel-target" })} />);
  expect(
    screen.getByText("MySQL creates tables one by one and they stay if a later step fails. Each table's rows are copied in its own transaction."),
  ).toBeTruthy();
});

test("elapsed only, without a known total", () => {
  render(<StepRun {...props({ tables: [...TABLES.slice(0, 5), { table: "payments", rowsHint: null }] })} />);
  expect(screen.getByText("1m 51s elapsed")).toBeTruthy();
  expect(screen.getByText("1,211,632 rows")).toBeTruthy();
});

test("the failure frame on one transaction: rolled back, failed, not started, and Copy error", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(
    <StepRun
      {...props({
        progress: { table: "sales_lines", rowsDone: 2_114_000, rowsTotal: 4_012_876, statementsDone: 4 },
        outcome: {
          kind: "failed",
          message: PG_ERROR,
          hint: "Fix the value in kestrel-pos, or set unit_price to text on Type mapping, then run again.",
        },
        now: 277_000,
      })}
    />,
  );
  expect(screen.getByText("Transfer stopped, nothing was written")).toBeTruthy();
  expect(screen.getByText("4m 37s")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain(PG_ERROR);
  expect(
    screen.getByText("Structure: 6 tables, 1 type, 9 indexes created, then rolled back. Foreign Keys are added after the rows."),
  ).toBeTruthy();
  expect(["stores", "products", "customers", "sales"].map(state)).toEqual(["Rolled back", "Rolled back", "Rolled back", "Rolled back"]);
  expect(state("sales_lines")).toBe("Failed");
  expect(row("sales_lines").className).toBe("err");
  expect(within(row("sales_lines")).getByText("2,114,000 of 4,012,876")).toBeTruthy();
  expect(state("payments")).toBe("Not started");
  expect(screen.getByText("Fix the value in kestrel-pos, or set unit_price to text on Type mapping, then run again.")).toBeTruthy();
  expect(screen.queryByText(/everything runs in one transaction/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy error" }));
  expect(writeText).toHaveBeenCalledWith(PG_ERROR);
});

test("a MySQL failure keeps the finished tables as Done", () => {
  const message =
    "sales_lines, row 2,114,903: Data truncated for column unit_price. 6 tables were created and 4 were copied before the failure. They stay on kestrel-target.";
  render(
    <StepRun
      {...props({
        targetDialect: "mysql",
        mode: "perTable",
        target: "kestrel-target",
        progress: { table: "sales_lines", rowsDone: 2_114_000, rowsTotal: 4_012_876, statementsDone: 4 },
        outcome: { kind: "failed", message, hint: null },
      })}
    />,
  );
  expect(screen.getByText("Transfer stopped")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain(message);
  expect(["stores", "products", "customers", "sales"].map(state)).toEqual(["Done", "Done", "Done", "Done"]);
  expect(state("sales_lines")).toBe("Failed");
  expect(state("payments")).toBe("Not started");
  expect(screen.getByText("Structure: 6 tables, 1 type, 9 indexes created. Foreign Keys are created with the tables.")).toBeTruthy();
  expect(screen.queryByText(/MySQL creates tables one by one/)).toBeNull();
});

test("cancelled: the title, the Core's warning and the rows like a failure", () => {
  render(
    <StepRun
      {...props({
        outcome: { kind: "cancelled", message: "Cancelled. The transaction rolled back, so pinecone-analytics is as it was.", hint: null },
      })}
    />,
  );
  expect(screen.getByText("Transfer cancelled")).toBeTruthy();
  expect(screen.getByText("Cancelled. The transaction rolled back, so pinecone-analytics is as it was.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy error" })).toBeNull();
  expect(state("customers")).toBe("Rolled back");
  expect(state("sales")).toBe("Rolled back");
  expect(state("payments")).toBe("Not started");
});

test("success with the counts compared, and Open in the target tree", () => {
  const onOpenTarget = vi.fn();
  render(
    <StepRun
      {...props({
        progress: { table: "payments", rowsDone: 1_190_220, rowsTotal: 1_190_220, statementsDone: 6 },
        outcome: { kind: "finished", rowsWritten: 6_508_267, elapsedMs: 252_000 },
        onOpenTarget,
      })}
    />,
  );
  expect(screen.getByText("Copied 6 tables, 6,508,267 rows in 4m 12s. Row counts match.")).toBeTruthy();
  expect(TABLES.map((t) => state(t.table))).toEqual(Array(6).fill("Done"));
  fireEvent.click(screen.getByRole("button", { name: "Open in the target tree" }));
  expect(onOpenTarget).toHaveBeenCalledOnce();
});

test("success without the counts compared", () => {
  render(<StepRun {...props({ countsCompared: false, outcome: { kind: "finished", rowsWritten: 6_508_267, elapsedMs: 252_000 } })} />);
  expect(screen.getByText("Copied 6 tables, 6,508,267 rows in 4m 12s.")).toBeTruthy();
  expect(screen.queryByText(/Row counts match/)).toBeNull();
});

test("one table is singular", () => {
  const one = [{ table: "stores", rowsHint: 412 }];
  const { unmount } = render(<StepRun {...props({ tables: one, progress: { table: "stores", rowsDone: 100, rowsTotal: 412, statementsDone: 0 } })} />);
  expect(screen.getByText("Copying 1 table to pinecone-analytics")).toBeTruthy();
  unmount();
  render(<StepRun {...props({ tables: one, countsCompared: false, outcome: { kind: "finished", rowsWritten: 412, elapsedMs: 400 } })} />);
  expect(screen.getByText("Copied 1 table, 412 rows in 0.4s.")).toBeTruthy();
});

test("elapsed ticks every second while running", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(10_000);
    render(<StepRun {...props({ now: undefined, startedAt: 0, progress: null })} />);
    expect(screen.getByText("10s elapsed")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText("12s elapsed")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test("compact times", () => {
  expect(runTime(400, true)).toBe("0.4s");
  expect(runTime(104_000)).toBe("1m 44s");
  expect(runTime(252_000)).toBe("4m 12s");
  expect(runTime(38_000)).toBe("38s");
});

test("the Foreign Keys sentence on a SQLite target", () => {
  render(<StepRun {...props({ targetDialect: "sqlite", target: "local.db" })} />);
  expect(
    screen.getByText("Structure: 6 tables, 1 type, 9 indexes created. Foreign Keys are created with the tables and checked after the rows."),
  ).toBeTruthy();
});

test("rows only: no structure and no Foreign Keys sentence", () => {
  render(<StepRun {...props({ structure: "" })} />);
  expect(screen.getByText("Structure: none, rows go into tables that exist.")).toBeTruthy();
  expect(screen.queryByText(/Foreign Keys/)).toBeNull();
  expect(screen.queryByText(/0 tables created/)).toBeNull();
});

test("the overall line uses the whole run's rows when the Core sends them", () => {
  const two = [
    { table: "sales", rowsHint: null },
    { table: "payments", rowsHint: null },
  ];
  render(
    <StepRun
      {...props({
        tables: two,
        progress: { table: "sales", rowsDone: 2_495_632, rowsTotal: 4_000_000, statementsDone: 0, allDone: 2_495_632, allTotal: 6_508_267 },
      })}
    />,
  );
  expect(screen.getByText("2,495,632 of 6,508,267 rows")).toBeTruthy();
  expect(screen.getByText(/^1m 51s elapsed, about .+ left$/)).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Transfer progress" }).getAttribute("aria-valuenow")).toBe("38");
  expect(within(row("payments")).getByText("0")).toBeTruthy();
});
