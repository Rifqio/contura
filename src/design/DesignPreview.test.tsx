import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { DesignMode, DesignRequest, DesignVerdict, DesignWarning } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import DesignPreview, { modeLine } from "./DesignPreview";
import { ORDERS } from "./fixtures";
import { warningText } from "./warnings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
});

const request = (type = "int"): DesignRequest => ({
  target: { kind: "alter", base: ORDERS },
  edits: [{ op: "changeColumn", name: "total", column: { name: "total", typeSql: type, nullable: true, defaultSql: null, increment: false, comment: null } }],
});

const verdict = (mode: DesignMode, statements: string[], warnings: DesignWarning[] = []): DesignVerdict => ({
  plan: { statements, warnings, mode, before: 0, after: 0, checks: [], foreignKeys: null },
  verdict: { kind: "ok" },
});

function show(v: DesignVerdict, req: DesignRequest | null = request()) {
  routeInvoke({ plan_design: () => v });
  const onPlan = vi.fn();
  const r = render(<DesignPreview connectionId="c1" dialect="mysql" request={req} onPlan={onPlan} />);
  return { onPlan, ...r };
}

const island = () => screen.getByRole("region", { name: "SQL preview" });

test.each([
  [{ kind: "transaction" } as DesignMode, "Apply runs exactly this, in one transaction."],
  [{ kind: "atomic" } as DesignMode, "Apply runs exactly this. MySQL applies it all or nothing."],
  [
    { kind: "sequential" } as DesignMode,
    "MySQL runs these 2 statements one by one. If one fails, the ones before it stay applied.",
  ],
  [
    { kind: "copyOnly", reason: "it has a CHECK constraint" } as DesignMode,
    "Contura cannot rebuild this table safely: it has a CHECK constraint. Copy this SQL to run it yourself.",
  ],
])("mode_line %#", async (mode, line) => {
  const { onPlan } = show(verdict(mode, ["ALTER TABLE a", "ALTER TABLE b"]));
  expect(await screen.findByText(line)).toBeTruthy();
  expect(island().querySelector(".design-island-sub")!.textContent).toBe(line);
  expect(island().querySelector(".design-island-title")!.textContent).toBe("SQL preview");
  expect(onPlan).toHaveBeenLastCalledWith(expect.objectContaining({ plan: expect.objectContaining({ mode }) }));
});

test("copy_writes_the_shown_text", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  show(verdict({ kind: "atomic" }, ["ALTER TABLE `orders` MODIFY `total` int", "ALTER TABLE `orders` ADD INDEX i (total)"]));
  await screen.findByText("Apply runs exactly this. MySQL applies it all or nothing.");
  const text = "ALTER TABLE `orders` MODIFY `total` int;\n\nALTER TABLE `orders` ADD INDEX i (total);";
  expect(island().querySelector(".sql-block-text")?.textContent ?? island().querySelector(".sql-block")!.textContent).toContain(
    "MODIFY `total` int;",
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy SQL" }));
  expect(writeText).toHaveBeenCalledWith(text);
});

test("warnings_are_alert_banners_above_the_sql", async () => {
  show(
    verdict({ kind: "atomic" }, ["ALTER TABLE `orders` DROP COLUMN `total`"], [
      { kind: "dropColumn", column: "total" },
      { kind: "narrowType", column: "total", from: "decimal(10,2)", to: "int", note: null },
    ]),
  );
  const alerts = await screen.findAllByRole("alert");
  expect(alerts.map((a) => a.textContent)).toEqual([
    "Dropping total deletes its data in every row.",
    "Changing total from decimal(10,2) to int can cut or round existing values.",
  ]);
  const sql = island().querySelector(".design-sql")!;
  expect(sql.className).toContain("sql-block");
  for (const a of alerts) expect(a.compareDocumentPosition(sql) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a_second_edit_within_200ms_makes_one_call", async () => {
  vi.useFakeTimers();
  routeInvoke({ plan_design: () => verdict({ kind: "atomic" }, ["ALTER TABLE a"]) });
  const onPlan = vi.fn();
  const { rerender } = render(<DesignPreview connectionId="c1" dialect="mysql" request={request("int")} onPlan={onPlan} />);
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
  rerender(<DesignPreview connectionId="c1" dialect="mysql" request={request("bigint")} onPlan={onPlan} />);
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
  expect(callsTo("plan_design")).toHaveLength(1);
  const sent = callsTo("plan_design")[0].request as DesignRequest;
  expect(sent.edits[0]).toMatchObject({ column: { typeSql: "bigint" } });
});

test("a_plan_error_is_shown_and_reported_as_no_plan", async () => {
  routeInvoke({
    plan_design: () => {
      throw { kind: "invalidInput", message: "The type of total is not one SQL expression." };
    },
  });
  const onPlan = vi.fn();
  render(<DesignPreview connectionId="c1" dialect="mysql" request={request("int;")} onPlan={onPlan} />);
  expect(await screen.findByText("The type of total is not one SQL expression.")).toBeTruthy();
  await waitFor(() => expect(onPlan).toHaveBeenLastCalledWith(null));
});

test("no_request_makes_no_call", async () => {
  vi.useFakeTimers();
  const { onPlan } = show(verdict({ kind: "atomic" }, []), null);
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(callsTo("plan_design")).toHaveLength(0);
  expect(onPlan).toHaveBeenLastCalledWith(null);
});

test("warning_texts", () => {
  const t = (w: DesignWarning) => warningText(w);
  expect(t({ kind: "existingRows", rule: "notNull", name: "total" })).toBe("Making total required fails if a row holds NULL. Nothing is lost.");
  expect(t({ kind: "existingRows", rule: "unique", name: "email" })).toBe(
    "A unique index on email fails if two rows share a value. Nothing is lost.",
  );
  expect(t({ kind: "existingRows", rule: "foreignKey", name: "fk_x" })).toBe(
    "The Foreign Key fk_x fails if a row points at a missing row. Nothing is lost.",
  );
  expect(t({ kind: "dropRule", rule: "primaryKey", name: "PRIMARY" })).toBe("Dropping the primary key removes a rule the data relies on.");
  expect(t({ kind: "dropRule", rule: "unique", name: "email" })).toBe("Dropping the unique index email removes a rule the data relies on.");
  expect(t({ kind: "dropRule", rule: "foreignKey", name: "fk_x" })).toBe("Dropping the Foreign Key fk_x removes a rule the data relies on.");
  expect(t({ kind: "rewriteLock", table: "orders" })).toBe(
    "PostgreSQL rewrites orders and blocks reads and writes on it until this finishes.",
  );
  expect(t({ kind: "rebuildCopy", table: "orders" })).toBe(
    "SQLite copies every row of orders into a new table. A large table takes time and disk space.",
  );
  expect(t({ kind: "renameColumn", from: "status", to: "state" })).toBe(
    "Views, routines and applications that use status stop working until they use state.",
  );
  expect(t({ kind: "dropTable", table: "orders", rows: { kind: "exact", n: 1204 }, referencedBy: [] })).toBe(
    "Dropping orders deletes its 1,204 rows.",
  );
  expect(t({ kind: "dropTable", table: "orders", rows: { kind: "over", n: 10000 }, referencedBy: ["items", "payments"] })).toBe(
    "Dropping orders deletes more than 10,000 rows. Foreign Keys in items, payments point at it.",
  );
});

test("a_sequential_plan_of_one_statement_reads_singular", () => {
  expect(modeLine({ kind: "sequential" }, 1)).toBe("MySQL runs this 1 statement. If it fails, nothing is applied.");
});

test("a_drop_with_an_unknown_row_count_says_so", () => {
  expect(warningText({ kind: "dropTable", table: "orders", rows: null, referencedBy: [] })).toBe(
    "Dropping orders deletes it and every row in it. Contura could not count its rows.",
  );
});
