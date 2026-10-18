import { expect, test } from "vitest";
import { DEFAULT_IMPORT_OPTIONS, type CheckReport, type FileSummary, type InsertShape, type PlannedColumn, type ScriptPlan, type ScriptStatement } from "../api/types";
import {
  bytesText,
  checkBanner,
  confirmSummary,
  fileHint,
  fingerprintText,
  footerText,
  oneTransactionOf,
  scriptOneTransaction,
  writtenText,
  matchByName,
  runLabel,
  scriptFooter,
  scriptNotes,
  scriptSummary,
} from "./importModel";
import casesText from "./match_cases.json?raw";
import { foldText } from "../query/ConfirmRun";

interface Case {
  file: string[];
  targets: { name: string; type: string; nullable: boolean; generated: boolean }[];
  expected: (string | null)[];
}

// The case file Task 1 wrote, read as text; the Core's `match_by_name` reads the same one (D19, Q11).
const CASES = JSON.parse(casesText) as Case[];

test("match_cases_json", () => {
  expect(CASES.length).toBeGreaterThan(0);
  for (const c of CASES) {
    const targets: PlannedColumn[] = c.targets.map((t) => ({
      into: t.name,
      typeSql: t.type,
      fileColumn: null,
      note: null,
      blocks: null,
      generated: t.generated,
    }));
    const got = matchByName(c.file, targets);
    expect({ file: c.file, got: got.map((m) => m.into) }).toEqual({ file: c.file, got: c.expected });
    expect(got.map((m) => m.fileColumn)).toEqual(c.file.map((_, i) => i));
    expect(got.every((m) => !m.byHand)).toBe(true);
  }
});

const SUMMARY: FileSummary = {
  format: "csv",
  delimiter: "comma",
  encoding: "UTF-8",
  bytes: 212 * 1024,
  header: ["id", "name", "price", "a", "b", "c"],
  rows: [],
  rowsEstimate: { rows: 1204, exact: true },
  sheets: [],
  conturaBackup: false,
};

test("file_hint_exact_and_estimate", () => {
  expect(fileHint(SUMMARY)).toBe("1,204 rows, 6 columns, 212 KB");
  expect(fileHint({ ...SUMMARY, rowsEstimate: { rows: 4_210_000, exact: false }, bytes: 812 * 1024 * 1024 })).toBe(
    "about 4.2 million rows, 6 columns, 812 MB",
  );
  expect(fileHint({ ...SUMMARY, header: ["id"], rowsEstimate: { rows: 1, exact: true }, bytes: 40 })).toBe("1 row, 1 column, 40 bytes");
});

test("bytes_text", () => {
  expect(bytesText(212 * 1024)).toBe("212 KB");
  expect(bytesText(1536 * 1024)).toBe("1.5 MB");
  expect(bytesText(3 * 1024 * 1024 * 1024)).toBe("3 GB");
});

test("footer_text_per_option", () => {
  const plan = { table: "public.menu_items", warnings: [] };
  expect(footerText(plan, DEFAULT_IMPORT_OPTIONS, 1204, "postgres")).toBe(
    "Writes 1,204 rows into public.menu_items in one transaction. Cancel rolls everything back.",
  );
  expect(footerText(plan, { ...DEFAULT_IMPORT_OPTIONS, commit: { kind: "every", rows: 10000 } }, 1204, "postgres")).toBe(
    "Writes 1,204 rows into public.menu_items, committing every 10,000 rows. If the import stops, the rows committed before it stay.",
  );
  expect(
    footerText({ table: "shop.menu_items", warnings: ["menu_items uses MyISAM: rows written before a failure stay"] }, DEFAULT_IMPORT_OPTIONS, 1204, "mysql"),
  ).toBe("Writes 1,204 rows into shop.menu_items. menu_items uses MyISAM: rows written before a failure stay.");
  expect(footerText(plan, DEFAULT_IMPORT_OPTIONS, 1, "sqlite")).toBe("Writes 1 row into public.menu_items in one transaction. Cancel rolls everything back.");
});

test("footer_reads_the_cores_one_transaction_flag", () => {
  const plan = { table: "public.menu_items", warnings: [] };
  // The Core says no single transaction, with no MyISAM warning to match: no rollback claim.
  expect(footerText({ ...plan, oneTransaction: false }, DEFAULT_IMPORT_OPTIONS, 1204, "postgres")).toBe(
    "Writes 1,204 rows into public.menu_items. If the import stops, the rows written before it stay.",
  );
  expect(footerText({ ...plan, oneTransaction: true }, DEFAULT_IMPORT_OPTIONS, 1204, "postgres")).toBe(
    "Writes 1,204 rows into public.menu_items in one transaction. Cancel rolls everything back.",
  );
});

test("script_footer_reads_the_flag_and_notes_come_apart_from_the_run_line", () => {
  // Not its own transactions, not MySQL DDL, yet the Core says no single transaction (Q37: CONCURRENTLY).
  const apart = { ...SCRIPT, hasDdl: false, oneTransaction: false };
  expect(scriptFooter(apart, "postgres", "shop")).toEqual([
    "Runs 1,503 statements in shop, each on its own. If a statement fails, the ones before it stay.",
  ]);
  expect(scriptNotes(apart, "postgres")).toEqual([
    "Runs each statement on its own. If a statement fails, the ones before it stay.",
  ]);
  expect(scriptNotes({ ...SCRIPT, hasDdl: false }, "postgres")).toEqual([]);
  expect(scriptNotes(SCRIPT, "mysql")).toEqual([
    "MySQL commits each CREATE, ALTER and DROP as it runs. If a later statement fails, those stay.",
  ]);
  expect(scriptNotes({ ...SCRIPT, ownTransactions: true }, "postgres")).toEqual([
    "This file manages its own transactions, so Contura runs it as written. If a statement fails, the ones before it stay.",
  ]);
});

test("run_label_plain_and_production", () => {
  expect(runLabel({ production: false }, 1204)).toBe("Import 1,204 rows");
  expect(runLabel({ production: false }, 1)).toBe("Import 1 row");
  expect(runLabel({ production: true }, 1204)).toBe("Import on PROD...");
});

test("fingerprint_text", () => {
  const sha = "4be091c2" + "0".repeat(52) + "7d1f";
  expect(fingerprintText(212 * 1024, sha)).toBe("212 KB, SHA-256 4be0 91c2 ... 7d1f");
});

const REPORT: CheckReport = { rows: 1204, failing: 0, first: [], sha256: "ab" };

test("check_banner", () => {
  expect(checkBanner(REPORT)).toBe("All 1,204 rows fit");
  expect(
    checkBanner({
      ...REPORT,
      failing: 2,
      first: [
        { fileRow: 7, column: "price", message: "n/a is not a number for price." },
        { fileRow: 388, column: "price", message: "12,50 uses a comma." },
      ],
    }),
  ).toBe("2 rows will fail. Row 7 of the file: n/a is not a number for price. Row 388: 12,50 uses a comma. Fix the file, or choose Skip the row.");
  expect(checkBanner({ ...REPORT, failing: 1, first: [{ fileRow: 3, column: "qty", message: "x is not a number for qty." }] })).toBe(
    "1 row will fail. Row 3 of the file: x is not a number for qty. Fix the file, or choose Skip the row.",
  );
});

function statement(index: number, text: string, kind: ScriptStatement["kind"], action: ScriptStatement["action"] = { kind: "run" }): ScriptStatement {
  return { index, line: index + 1, text, class: "write", kind, action };
}

const SCRIPT: ScriptPlan = {
  statements: 1503,
  creates: 31,
  inserts: 1472,
  skipped: [statement(0, "GRANT SELECT ON t TO bob", "other", { kind: "skip", reason: "r" }), statement(1, "grant all on t to amy", "other", { kind: "skip", reason: "r" })],
  refused: [],
  ownTransactions: false,
  hasDdl: true,
  conturaBackup: false,
  first: [],
  confirm: [],
  confirmMore: 0,
  bytes: 1024,
  sha256: "00",
  verdict: { kind: "ok" },
};

test("script_summary", () => {
  expect(scriptSummary(SCRIPT)).toBe("1,503 statements: 31 create, 1,472 insert. 2 GRANT are skipped.");
  expect(scriptSummary({ ...SCRIPT, skipped: [] })).toBe("1,503 statements: 31 create, 1,472 insert.");
  expect(
    scriptSummary({
      ...SCRIPT,
      statements: 10,
      creates: 1,
      inserts: 6,
      skipped: [statement(0, "SET GLOBAL x = 1", "other", { kind: "skip", reason: "r" })],
      refused: [statement(1, "DROP DATABASE shop", "other", { kind: "refuse", reason: "r" })],
    }),
  ).toBe("10 statements: 1 create, 6 insert, 1 other. 1 SET GLOBAL is skipped. 1 DROP DATABASE is refused.");
});

test("script_summary_counts_the_statements_past_the_first_1000", () => {
  const skip = statement(0, "GRANT ALL ON t TO u", "other", { kind: "skip", reason: "r" });
  const refuse = statement(1, "DROP DATABASE shop", "other", { kind: "refuse", reason: "r" });
  expect(
    scriptSummary({
      ...SCRIPT,
      statements: 2_000,
      creates: 0,
      inserts: 0,
      skipped: Array(1_000).fill(skip),
      skippedMore: 500,
      refused: [refuse],
      refusedMore: 2,
    }),
  ).toBe("2,000 statements: 0 create, 0 insert, 497 other. 1,000 GRANT and 500 more are skipped. 1 DROP DATABASE and 2 more are refused.");
});

test("script_footer_lines", () => {
  expect(scriptFooter({ ...SCRIPT, hasDdl: false }, "postgres", "shop")).toEqual(["Runs 1,503 statements in shop in one transaction. Cancel rolls everything back."]);
  // Q43 I3: MySQL with DDL is not one transaction, so no rollback claim; the lines say what stays.
  expect(scriptFooter(SCRIPT, "mysql", "shop")).toEqual([
    "Runs 1,503 statements in shop. If the import stops, what ran before it stays.",
    "MySQL commits each CREATE, ALTER and DROP as it runs. If a later statement fails, those stay.",
  ]);
  expect(scriptFooter({ ...SCRIPT, oneTransaction: false }, "mysql", "shop")[0]).toBe(
    "Runs 1,503 statements in shop. If the import stops, what ran before it stays.",
  );
  // The flag wins over the derived value: a Core that says one transaction is believed.
  expect(scriptFooter({ ...SCRIPT, hasDdl: false, oneTransaction: true }, "postgres", "shop")).toEqual([
    "Runs 1,503 statements in shop in one transaction. Cancel rolls everything back.",
  ]);
  expect(scriptFooter({ ...SCRIPT, ownTransactions: true }, "postgres", "shop")).toEqual([
    "This file manages its own transactions, so Contura runs it as written. If a statement fails, the ones before it stay.",
  ]);
});

const SHAPE: InsertShape = { head: "INSERT INTO t (a) VALUES", firstRows: ["(1)", "(2)", "(3)", "(4)"], rowsPerStatement: 500, statements: 3, rows: 1204 };

test("rolls_back_reads_the_current_commit_option_over_a_stale_plan_flag_q43", () => {
  const every = { ...DEFAULT_IMPORT_OPTIONS, commit: { kind: "every" as const, rows: 10000 } };
  expect(oneTransactionOf({ warnings: [], oneTransaction: true }, every)).toBe(false);
  expect(oneTransactionOf({ warnings: [], oneTransaction: true }, DEFAULT_IMPORT_OPTIONS)).toBe(true);
  expect(oneTransactionOf({ warnings: [], oneTransaction: false }, DEFAULT_IMPORT_OPTIONS)).toBe(false);
});

test("fold_and_confirm_summary", () => {
  expect(foldText(SHAPE)).toBe("496 more rows in this statement, then 2 more statements");
  expect(foldText({ ...SHAPE, statements: 1, rows: 4 })).toBe(null);
  expect(foldText({ ...SHAPE, statements: 2, rows: 504 })).toBe("496 more rows in this statement, then 1 more statement");
  expect(foldText({ ...SHAPE, statements: 1, rows: 5 })).toBe("1 more row in this statement");
  expect(confirmSummary("billing.products", SHAPE, DEFAULT_IMPORT_OPTIONS)).toBe("Inserts 1,204 rows into billing.products in 3 statements, in one transaction.");
  expect(confirmSummary("billing.products", SHAPE, { ...DEFAULT_IMPORT_OPTIONS, commit: { kind: "every", rows: 10000 } })).toBe(
    "Inserts 1,204 rows into billing.products in 3 statements, committing every 10,000 rows.",
  );
});

test("fix_round_1_texts", () => {
  // Q28: no transaction claim when the plan says the import is not one transaction.
  expect(confirmSummary("shop.menu_items", SHAPE, DEFAULT_IMPORT_OPTIONS, false)).toBe("Inserts 1,204 rows into shop.menu_items in 3 statements.");
  expect(confirmSummary("shop.menu_items", SHAPE, DEFAULT_IMPORT_OPTIONS, true)).toBe("Inserts 1,204 rows into shop.menu_items in 3 statements, in one transaction.");
  // Q27: what stayed after a stop.
  expect(writtenText(500, "menu_items")).toBe("500 rows were written before the stop and stay in menu_items.");
  expect(writtenText(1, "menu_items")).toBe("1 row was written before the stop and stays in menu_items.");
  // An estimate reads "about" until the check pass ends.
  expect(runLabel({ production: false }, 4_200_000, false)).toBe("Import about 4.2 million rows");
  expect(footerText({ table: "t", warnings: [] }, DEFAULT_IMPORT_OPTIONS, 4_200_000, "postgres", false)).toBe(
    "Writes about 4.2 million rows into t in one transaction. Cancel rolls everything back.",
  );
  expect(oneTransactionOf({ warnings: [] }, DEFAULT_IMPORT_OPTIONS)).toBe(true);
  expect(oneTransactionOf({ warnings: ["t uses MyISAM: rows written before a failure stay"] }, DEFAULT_IMPORT_OPTIONS)).toBe(false);
  expect(oneTransactionOf({ warnings: [] }, { ...DEFAULT_IMPORT_OPTIONS, commit: { kind: "every", rows: 10000 } })).toBe(false);
  expect(oneTransactionOf({ warnings: [], oneTransaction: false }, DEFAULT_IMPORT_OPTIONS)).toBe(false);
  expect(scriptOneTransaction(SCRIPT, "mysql")).toBe(false);
  expect(scriptOneTransaction(SCRIPT, "postgres")).toBe(true);
  expect(scriptOneTransaction({ ...SCRIPT, oneTransaction: false }, "postgres")).toBe(false);
});
