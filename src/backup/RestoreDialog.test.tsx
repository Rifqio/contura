import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { open } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  ConnectionConfig,
  JobEvent,
  JobReport,
  RestoreCheck,
  RestorePlan,
  RestoreRequest,
  RestoreTarget,
  ScriptStatement,
} from "../api/types";
import { ToastProvider } from "../components/Toast";
import { JobsProvider, useJobs } from "../jobs/useJobs";
import { callsTo, routeInvoke } from "../test/invoke";
import RestoreDialog from "./RestoreDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const MB = 1024 * 1024;
const SHA = `9f3c1a7e${"0".repeat(52)}e21a`;
const FILE = "E:\\Backups\\freight-2026-10-16.sql";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 17, 9, 0, 0));
  vi.mocked(open).mockResolvedValue(FILE);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const prod: ConnectionConfig = {
  id: "c1",
  name: "freight-prod",
  dialect: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: "freight",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: true,
  readOnly: false,
};
const plain: ConnectionConfig = { ...prod, name: "freight-dev", production: false };

const TABLES = ["customers", "invoices", "invoice_lines", "orders", "order_items", "payments"];

const CHECK: RestoreCheck = {
  path: FILE,
  header: {
    format: 1,
    madeBy: "Contura 0.9.0",
    dialect: "postgres",
    serverVersion: "16.4",
    database: "freight",
    schema: "billing",
    takenAt: "2026-10-16T22:00:00Z",
    contents: ["tables", "indexes", "rows"],
    rows: [
      { table: "billing.customers", rows: 1204 },
      { table: "billing.invoices", rows: 90_412 },
      { table: "billing.invoice_lines", rows: 300_000 },
      { table: "billing.orders", rows: 100_000 },
      { table: "billing.order_items", rows: 250_000 },
      { table: "billing.payments", rows: 1202 },
    ],
    notIncluded: ["extension pgcrypto"],
    definerRemoved: false,
    dropTables: false,
  },
  bytes: Math.round(48.2 * MB),
  sha256: SHA,
  targetName: "freight-prod",
  targetDialect: "postgres",
  targetVersion: "16.4",
  dialectOk: true,
  versionNote: null,
  statements: 1503,
  refused: [],
  skipped: [
    { line: 40, kind: "GRANT" },
    { line: 41, kind: "GRANT" },
  ],
  existingTables: TABLES.map((t) => `billing.${t}`),
  targetEmpty: false,
  missingExtensions: ["pgcrypto"],
  trailerOk: true,
};

const stmt = (index: number, text: string): ScriptStatement => ({
  index,
  line: index + 1,
  text,
  class: "write",
  kind: "create",
  action: { kind: "run" },
});

const TABLE_SQL = [
  "CREATE TABLE billing.customers (",
  "  id bigint NOT NULL,",
  "  name text NOT NULL,",
  "  email text,",
  "  country text,",
  "  created_at timestamptz,",
  "  note text",
  ");",
].join("\n");

const PLAN: RestorePlan = {
  setup: [
    { text: "SET client_encoding = 'UTF8';", class: "read" },
    { text: "SET search_path = '';", class: "read" },
    { text: "SET TimeZone = 'UTC';", class: "read" },
  ],
  drops: [],
  structure: [
    stmt(0, "CREATE SCHEMA billing;"),
    stmt(1, TABLE_SQL),
    ...Array.from({ length: 26 }, (_, i) => stmt(i + 2, `CREATE INDEX ix_${i} ON billing.orders (id);`)),
  ],
  structureTotal: 28,
  creates: { tables: 6, indexes: 14, foreignKeys: 5 },
  insertCount: 1472,
  insertRows: 742_818,
  insertShape: {
    head: "INSERT INTO billing.customers (id, name) VALUES",
    firstRows: ["(1, 'Acme')", "(2, 'Borealis')", "(3, 'Cobalt')", "(4, 'Dune')"],
    rowsPerStatement: 500,
    statements: 1472,
    rows: 742_818,
  },
  after: [],
  cleanup: ["DROP DATABASE freight_restore_1017"],
  replacedRows: null,
  backupFirstPath: null,
  modeLine: "One transaction. Cancel rolls back and removes freight_restore_1017.",
  fingerprint: "fp1",
  verdict: { kind: "needsConfirmation", connection: "freight-prod", database: "freight_restore_1017", fingerprint: "fp1", fileBytes: CHECK.bytes, fileSha256: SHA },
};

const restoreReport = (): JobReport => ({
  kind: "restore",
  rowsRead: 742_818,
  rowsWritten: 742_818,
  statements: 1503,
  skipped: 2,
  warnings: [],
  elapsedMs: 214_000,
  file: FILE,
  bytes: CHECK.bytes,
  committed: 742_818,
  check: null,
  restore: { database: "freight_restore_1017", tables: 6, rows: 742_818, countsMatch: true, newFile: null },
});

function events(cmd: string): { onmessage: (e: JobEvent) => void } {
  const calls = callsTo(cmd);
  return calls[calls.length - 1].events as { onmessage: (e: JobEvent) => void };
}

interface Opts {
  connection?: ConnectionConfig;
  target?: RestoreTarget;
  check?: RestoreCheck;
  plan?: RestorePlan | ((req: RestoreRequest) => RestorePlan);
  statements?: ScriptStatement[];
}

function setup({ connection = prod, target = { connectionId: "c1", database: "freight", schema: "billing" }, check = CHECK, plan = PLAN, statements = [] }: Opts = {}) {
  const onClose = vi.fn();
  const onRestored = vi.fn();
  const onOpenInTree = vi.fn();
  routeInvoke({
    inspect_restore: () => undefined,
    plan_restore: (a) => (typeof plan === "function" ? plan(a.req as RestoreRequest) : plan),
    restore_statements: () => statements,
    confirm_restore: () => "pass-1",
    start_restore: () => undefined,
    cancel_job: () => undefined,
  });
  render(
    <ToastProvider>
      <JobsProvider>
        <RestoreDialog connection={connection} group={null} target={target} onClose={onClose} onRestored={onRestored} onOpenInTree={onOpenInTree} />
      </JobsProvider>
    </ToastProvider>,
  );
  return { onClose, onRestored, onOpenInTree, check };
}

/** Chooses the file and finishes the check pass with `check`. */
async function checked(check: RestoreCheck = CHECK) {
  const d = await screen.findByRole("dialog", { name: /Restore into/ });
  await userEvent.click(within(d).getByRole("button", { name: /Browse/ }));
  await waitFor(() => expect(callsTo("inspect_restore")).toHaveLength(1));
  act(() =>
    events("inspect_restore").onmessage({
      kind: "finished",
      report: { ...restoreReport(), kind: "restoreCheck", restore: null, restoreCheck: check },
    }),
  );
  await within(d).findByText("Made by");
  return d;
}

test("the title names the target with the PROD chip", async () => {
  setup();
  const d = await screen.findByRole("dialog", { name: /Restore into freight-prod/ });
  expect(d.querySelector("h2")?.textContent).toBe("Restore into freight-prod");
  expect(within(d).getByText("Production")).toBeTruthy();
});

test("the header list, with SHA-256 grouped in fours", async () => {
  setup();
  const d = await checked();
  const call = callsTo("inspect_restore")[0];
  expect(call.target).toEqual({ connectionId: "c1", database: "freight", schema: "billing" });
  expect(call.path).toBe(FILE);
  const list = within(d).getByRole("list", { name: "From the file header" }) as HTMLElement;
  expect(within(list).getByText("Contura 0.9.0")).toBeTruthy();
  expect(within(list).getByText("PostgreSQL 16.4")).toBeTruthy();
  expect(within(list).getByText("freight · billing")).toBeTruthy();
  expect(within(list).getByText("2026-10-16 22:00 UTC")).toBeTruthy();
  expect(within(list).getByText("6 tables, 742,818 rows")).toBeTruthy();
  expect(within(list).getByText("48.2 MB")).toBeTruthy();
  expect(within(list).getByText("9f3c 1a7e ... e21a")).toBeTruthy();
});

test("each check line", async () => {
  setup();
  const d = await checked();
  expect(within(d).getByText("Same Dialect as freight-prod: PostgreSQL")).toBeTruthy();
  expect(within(d).getByText("The backup is from PostgreSQL 16.4 and freight-prod runs 16.4.")).toBeTruthy();
  expect(within(d).getByText("1,503 statements read, none refused")).toBeTruthy();
  expect(within(d).getByText("2 GRANT statements are skipped. Tick Run as is to keep them.")).toBeTruthy();
  expect(within(d).getByText("freight already has 6 tables with these names")).toBeTruthy();
  expect(within(d).getByText("pgcrypto is not installed on freight-prod. Functions that use it will fail.")).toBeTruthy();
  expect(within(d).getByText("The trailer is present.")).toBeTruthy();
});

test("an older server, refused statements and another Dialect", async () => {
  setup();
  const d = await checked({
    ...CHECK,
    versionNote: "The backup is from PostgreSQL 17.0 and freight-prod runs 16.4. Statements may fail.",
    refused: [{ line: 2041, kind: "DROP DATABASE" }],
  });
  expect(within(d).getByText("The backup is from PostgreSQL 17.0 and freight-prod runs 16.4. Statements may fail.")).toBeTruthy();
  expect(within(d).getByText("Line 2,041: DROP DATABASE is not run by Restore.")).toBeTruthy();
  expect((within(d).getByRole("button", { name: /Restore on PROD/ }) as HTMLButtonElement).disabled).toBe(true);
});

test("a refused file shows the reason", async () => {
  setup();
  const d = await screen.findByRole("dialog", { name: /Restore into/ });
  await userEvent.click(within(d).getByRole("button", { name: /Browse/ }));
  await waitFor(() => expect(callsTo("inspect_restore")).toHaveLength(1));
  const reason = "This Backup is from MySQL. Restore it on a MySQL Connection, or use Data Transfer.";
  act(() => events("inspect_restore").onmessage({ kind: "failed", error: { kind: "backupRefused", message: { reason } } }));
  expect(await within(d).findByText(reason)).toBeTruthy();
});

test("Run as is keeps the skipped statements", async () => {
  setup();
  const d = await checked();
  expect(within(d).getByText("Keeps statements Contura would skip.")).toBeTruthy();
  await userEvent.click(within(d).getByRole("checkbox", { name: /Run as is/ }));
  expect(within(d).getByText("2 GRANT statements run as is.")).toBeTruthy();
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  await waitFor(() => expect(callsTo("plan_restore")).toHaveLength(1));
  expect((callsTo("plan_restore")[0].req as RestoreRequest).runAsIs).toBe(true);
});

test("the modes: the default name, the disabled empty mode, Replace, and the footer", async () => {
  setup();
  const d = await checked();
  const fresh = within(d).getByRole("radio", { name: /Into a new database/ }) as HTMLInputElement;
  // On Production, Restore defaults to Into a new database.
  expect(fresh.checked).toBe(true);
  expect((within(d).getByRole("textbox", { name: "New database name" }) as HTMLInputElement).value).toBe("freight_restore_1017");
  const into = within(d).getByRole("radio", { name: /Into freight/ }) as HTMLInputElement;
  expect(into.disabled).toBe(true);
  expect(within(d).getByText("freight is not empty")).toBeTruthy();
  expect(within(d).getByRole("radio", { name: /Replace the 6 tables in freight/ })).toBeTruthy();
  expect(within(d).getByText("Lists every DROP and asks again")).toBeTruthy();
  expect(within(d).getByText("Next you see the exact SQL before anything runs.")).toBeTruthy();
  const go = within(d).getByRole("button", { name: /Restore on PROD\.\.\./ });
  expect(go.className).toContain("button-prod");
});

test("a plain Connection with an empty target defaults to Into the database", async () => {
  setup({ connection: plain });
  const d = await checked({ ...CHECK, targetName: "freight-dev", targetEmpty: true, existingTables: [] });
  expect((within(d).getByRole("radio", { name: /Into freight/ }) as HTMLInputElement).checked).toBe(true);
  expect(within(d).getByRole("button", { name: /^Restore$/ })).toBeTruthy();
});

test("a Connection row offers only Into a new database", async () => {
  setup({ target: { connectionId: "c1", database: null, schema: null } });
  const d = await checked();
  expect(within(d).getByRole("radio", { name: /Into a new database/ })).toBeTruthy();
  expect(within(d).queryByRole("radio", { name: /Replace/ })).toBeNull();
  expect(within(d).queryByRole("radio", { name: /Into freight/ })).toBeNull();
});

test("the confirm state: count line, 12 lines and the fold, Show all, the INSERT shape, cleanup and fingerprint", async () => {
  setup();
  const d = await checked();
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  expect(confirm.querySelector("h2")?.textContent).toBe("Restore on freight-prod · freight_restore_1017");
  expect((callsTo("plan_restore")[0].req as RestoreRequest).mode).toEqual({ kind: "newDatabase", name: "freight_restore_1017" });
  expect(
    within(confirm).getByText(
      "Creates freight_restore_1017, then 6 tables, 14 indexes and 5 Foreign Keys, then runs 1,472 INSERT statements (742,818 rows). All of it writes.",
    ),
  ).toBeTruthy();
  expect(within(confirm).getByText("Structure, 31 statements, exact SQL from the file")).toBeTruthy();
  const structure = within(confirm).getByLabelText("Structure SQL");
  expect(structure.textContent).toContain("SET client_encoding = 'UTF8';");
  expect(structure.textContent).toContain("CREATE TABLE billing.customers (");
  expect(structure.textContent).not.toContain("ix_0");
  expect(within(confirm).getByText("26 more structure statements")).toBeTruthy();
  await userEvent.click(within(confirm).getByRole("button", { name: "Show all" }));
  expect(within(confirm).getByLabelText("Structure SQL").textContent).toContain("ix_25");
  expect(within(confirm).queryByText(/more structure statements/)).toBeNull();
  expect(within(confirm).getByText("Rows: INSERT shape, statement 1 of 1,472")).toBeTruthy();
  expect(within(confirm).getByText("500 rows each")).toBeTruthy();
  expect(within(confirm).getByLabelText("INSERT shape").textContent).toContain("INSERT INTO billing.customers (id, name) VALUES");
  expect(within(confirm).getByText("If the restore fails or is cancelled:")).toBeTruthy();
  expect(within(confirm).getByText("DROP DATABASE freight_restore_1017")).toBeTruthy();
  expect(
    within(confirm).getByText("Checked file: 48.2 MB, SHA-256 9f3c 1a7e ... e21a. If the file changes before the run, Contura asks again."),
  ).toBeTruthy();
  expect(within(confirm).getByText("Enter runs only when Restore on freight-prod has focus. Press Tab to reach it, or click it.")).toBeTruthy();
  expect(within(confirm).getByRole("button", { name: "Restore on freight-prod" }).className).toContain("button-primary");
});

test("Show all pages the rest through restore_statements", async () => {
  const fifty = Array.from({ length: 50 }, (_, i) => stmt(i, `CREATE INDEX ix_${i} ON billing.orders (id);`));
  setup({
    plan: { ...PLAN, structure: fifty, structureTotal: 60 },
    statements: Array.from({ length: 10 }, (_, i) => stmt(50 + i, `CREATE INDEX ix_${50 + i} ON billing.orders (id);`)),
  });
  const d = await checked();
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  await userEvent.click(within(confirm).getByRole("button", { name: "Show all" }));
  await waitFor(() => expect(callsTo("restore_statements")).toHaveLength(1));
  expect(callsTo("restore_statements")[0].from).toBe(50);
  await waitFor(() => expect(within(confirm).getByLabelText("Structure SQL").textContent).toContain("ix_59"));
});

test("Replace: the danger banner and fill, and Restore into a new database instead", async () => {
  setup({
    plan: (req) =>
      req.mode.kind === "replace"
        ? {
            ...PLAN,
            drops: TABLES.map((t) => ({ text: `DROP TABLE IF EXISTS billing.${t};`, class: "write" as const })),
            cleanup: [],
            replacedRows: 742_818,
            verdict: { ...PLAN.verdict, database: "freight" } as RestorePlan["verdict"],
          }
        : PLAN,
  });
  const d = await checked();
  await userEvent.click(within(d).getByRole("radio", { name: /Replace the 6 tables/ }));
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  expect(confirm.querySelector("h2")?.textContent).toBe("Restore on freight-prod · freight");
  expect(
    within(confirm).getByText("Replace drops 6 tables in freight with 742,818 rows. Tables in freight that the file does not hold are left alone."),
  ).toBeTruthy();
  // Run order (R10): Contura's setup, then the drops, then the file (the block numbers its lines).
  expect(within(confirm).getByLabelText("Structure SQL").textContent).toMatch(/^1SET client_encoding = 'UTF8';reads2.*4DROP TABLE IF EXISTS billing\.customers;writes/);
  expect(within(confirm).getByRole("button", { name: "Restore on freight-prod" }).className).toContain("button-danger-fill");
  await userEvent.click(within(confirm).getByRole("button", { name: "Restore into a new database instead" }));
  const back = await screen.findByRole("dialog", { name: /Restore into freight-prod/ });
  expect((within(back).getByRole("radio", { name: /Into a new database/ }) as HTMLInputElement).checked).toBe(true);
});

test("MySQL Replace backs up the tables first", async () => {
  const mysql = { ...prod, dialect: "mysql" as const };
  const myCheck: RestoreCheck = { ...CHECK, header: { ...CHECK.header!, dialect: "mysql", serverVersion: "8.0.30", schema: null }, targetDialect: "mysql", targetVersion: "8.0.30", missingExtensions: [] };
  setup({
    connection: mysql,
    target: { connectionId: "c1", database: "freight", schema: null },
    plan: { ...PLAN, drops: [{ text: "DROP TABLE IF EXISTS `customers`;", class: "write" }], cleanup: [], backupFirstPath: "E:\\Backups\\freight-before-restore.sql" },
  });
  const d = await checked(myCheck);
  await userEvent.click(within(d).getByRole("radio", { name: /Replace the 6 tables/ }));
  expect(within(d).getByText("MySQL cannot undo DROP TABLE. If the restore fails, the dropped tables are gone.")).toBeTruthy();
  const first = within(d).getByRole("checkbox", { name: "Back up these 6 tables first" }) as HTMLInputElement;
  expect(first.checked).toBe(true);
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  await waitFor(() => expect(callsTo("plan_restore")).toHaveLength(1));
  expect((callsTo("plan_restore")[0].req as RestoreRequest).mode).toEqual({ kind: "replace", backupFirst: true });
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  expect(within(confirm).getByText("Back up these 6 tables first:")).toBeTruthy();
  expect(within(confirm).getByText("E:\\Backups\\freight-before-restore.sql")).toBeTruthy();
});

test("Production takes a pass, then the running state with phases, then the end line with Open in the tree", async () => {
  const { onRestored, onOpenInTree } = setup();
  const d = await checked();
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  await userEvent.click(within(confirm).getByRole("button", { name: "Restore on freight-prod" }));
  await waitFor(() => expect(callsTo("start_restore")).toHaveLength(1));
  expect(callsTo("confirm_restore")).toHaveLength(1);
  expect(callsTo("start_restore")[0].pass).toBe("pass-1");
  // R28: the start carries the fingerprint of the plan shown; R25: the user's own date.
  expect(callsTo("start_restore")[0].fingerprint).toBe("fp1");
  expect((callsTo("start_restore")[0].req as RestoreRequest).localDate).toBe("2026-10-17");
  act(() =>
    events("start_restore").onmessage({
      kind: "progress",
      phase: "writing",
      table: "billing.order_items",
      rowsDone: 154_000,
      rowsTotal: null,
      bytesDone: Math.round(10.1 * MB),
      bytesTotal: CHECK.bytes,
      statementsDone: 343,
      fileRow: null,
      restoreStep: "rows",
      insertsDone: 310,
      now: "INSERT INTO billing.order_items, rows 154,001 to 154,500",
    }),
  );
  const run = await screen.findByRole("dialog", { name: /Restoring on freight-prod/ });
  expect(within(run).getByText("Into freight_restore_1017")).toBeTruthy();
  expect(within(run).getByText("20 percent")).toBeTruthy();
  expect(within(run).getByText("10.1 of 48.2 MB")).toBeTruthy();
  expect(within(run).getByText("343 of 1,501")).toBeTruthy();
  expect(within(run).getByText("INSERT INTO billing.order_items, rows 154,001 to 154,500")).toBeTruthy();
  const phases = within(run).getByRole("list", { name: "Phases" });
  const items = within(phases).getAllByRole("listitem").map((li) => [li.textContent, li.getAttribute("data-state")]);
  expect(items).toEqual([
    ["Database created", "done"],
    ["Schema, enum and tables", "done"],
    ["Rows (310 of 1,472 INSERT statements)", "now"],
    ["Indexes and Foreign Keys", "next"],
    ["Sequences set to the highest id", "next"],
    ["Row counts compared with the file header", "next"],
  ]);
  expect(within(run).getByText("One transaction. Cancel rolls back and removes freight_restore_1017.")).toBeTruthy();
  expect(within(run).getByText("Recorded in Query History for freight-prod.")).toBeTruthy();
  expect(within(run).getByRole("button", { name: /Cancel and roll back/ })).toBeTruthy();
  act(() => events("start_restore").onmessage({ kind: "finished", report: restoreReport() }));
  expect(
    await within(run).findByText("Restored freight into freight_restore_1017: 6 tables, 742,818 rows in 3m 34s. Row counts match the file."),
  ).toBeTruthy();
  expect(onRestored).toHaveBeenCalled();
  await userEvent.click(within(run).getByRole("button", { name: "Open in the tree" }));
  expect(onOpenInTree).toHaveBeenCalledWith("freight_restore_1017");
});

test("Cancel and roll back cancels the job", async () => {
  setup({ connection: plain, plan: { ...PLAN, verdict: { kind: "ok" } } });
  const d = await checked({ ...CHECK, targetName: "freight-dev" });
  await userEvent.click(within(d).getByRole("button", { name: /^Restore$/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-dev/ });
  // A plain Connection reviews the same SQL, with Restore as the button and no pass.
  await userEvent.click(within(confirm).getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(callsTo("start_restore")).toHaveLength(1));
  expect(callsTo("confirm_restore")).toHaveLength(0);
  expect(callsTo("start_restore")[0].pass).toBeNull();
  const run = await screen.findByRole("dialog", { name: /Restoring on freight-dev/ });
  await userEvent.click(within(run).getByRole("button", { name: /Cancel and roll back/ }));
  // J1: Cancel asks first; nothing is cancelled until the answer.
  expect(callsTo("cancel_job")).toHaveLength(0);
  await userEvent.click(within(run).getByRole("button", { name: /Keep running/ }));
  expect(callsTo("cancel_job")).toHaveLength(0);
  await userEvent.click(within(run).getByRole("button", { name: /Cancel and roll back/ }));
  await userEvent.click(within(run).getByRole("button", { name: "Yes, roll back" }));
  expect(callsTo("cancel_job")).toHaveLength(1);
});

async function runningRestore() {
  const s = setup({ connection: plain, plan: { ...PLAN, verdict: { kind: "ok" } } });
  const d = await checked({ ...CHECK, targetName: "freight-dev" });
  await userEvent.click(within(d).getByRole("button", { name: /^Restore$/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-dev/ });
  await userEvent.click(within(confirm).getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(callsTo("start_restore")).toHaveLength(1));
  const run = await screen.findByRole("dialog", { name: /Restoring on freight-dev/ });
  return { ...s, run };
}

test("J1: Esc, a scrim mousedown and the close button leave a running Restore running", async () => {
  const { onClose, run } = await runningRestore();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(run.parentElement as HTMLElement);
  await userEvent.click(within(run).getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(3);
  expect(callsTo("cancel_job")).toHaveLength(0);
});

test("J1: after Cancel and roll back, focus is on Keep running and Enter or a second click never rolls back", async () => {
  const { run } = await runningRestore();
  await userEvent.click(within(run).getByRole("button", { name: /Cancel and roll back/ }));
  expect(document.activeElement).toBe(within(run).getByRole("button", { name: /Keep running/ }));
  await userEvent.keyboard("{Enter}");
  expect(callsTo("cancel_job")).toHaveLength(0);
  expect(within(run).queryByRole("button", { name: "Yes, roll back" })).toBeNull();
  // Back on the run, focus is on a safe button too.
  expect(document.activeElement).toBe(within(run).getByRole("button", { name: /Run in the background/ }));
});

test("J1: Esc while the cancel question shows goes back to the run", async () => {
  const { onClose, run } = await runningRestore();
  await userEvent.click(within(run).getByRole("button", { name: /Cancel and roll back/ }));
  await userEvent.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  expect(callsTo("cancel_job")).toHaveLength(0);
  expect(within(run).getByRole("button", { name: /Cancel and roll back/ })).toBeTruthy();
});

test("a file changed after confirming says nothing was restored", async () => {
  setup();
  const d = await checked();
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  await userEvent.click(within(confirm).getByRole("button", { name: "Restore on freight-prod" }));
  await waitFor(() => expect(callsTo("start_restore")).toHaveLength(1));
  act(() =>
    events("start_restore").onmessage({ kind: "failed", error: { kind: "fileChanged", message: { file: "freight-2026-10-16.sql", confirmed: true } } }),
  );
  expect(await screen.findByText("freight-2026-10-16.sql changed after you confirmed. Nothing was restored.")).toBeTruthy();
});

test("Read-only shows the reason and offers no Restore", async () => {
  setup({ connection: { ...prod, name: "kestrel-reporting", production: false, readOnly: true } });
  const d = await screen.findByRole("dialog", { name: /Restore into kestrel-reporting/ });
  expect(within(d).getByText("kestrel-reporting is Read-only. Restore is not allowed here.")).toBeTruthy();
  expect((within(d).getByRole("button", { name: /Browse/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(d).getByRole("button", { name: /^Restore$/ }) as HTMLButtonElement).disabled).toBe(true);
});

test("skipped statements stay out unless Run as is, labels come from the Core, and after follows the file", async () => {
  const skipped: ScriptStatement = { ...stmt(1, "GRANT SELECT ON billing.customers TO app;"), class: "write", kind: "other", action: { kind: "skip", reason: "GRANT" } };
  const kept: ScriptStatement = { ...skipped, runAsIs: true, index: 2, text: "GRANT USAGE ON SCHEMA billing TO app;" };
  const setval: ScriptStatement = { ...stmt(3, "SELECT setval('billing.customers_id_seq', 1204);"), class: "write", kind: "other" };
  setup({
    plan: {
      ...PLAN,
      structure: [stmt(0, "CREATE SCHEMA billing;"), skipped, kept, setval],
      structureTotal: 3,
      after: [{ text: "PRAGMA foreign_key_check;", class: "read" }],
    },
  });
  const d = await checked();
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  const sql = within(confirm).getByLabelText("Structure SQL").textContent ?? "";
  expect(sql).not.toContain("GRANT SELECT");
  expect(sql).toContain("GRANT USAGE");
  expect(sql).toContain("setval('billing.customers_id_seq', 1204);writes");
  expect(sql).toContain("SET TimeZone = 'UTC';reads");
  expect(sql).toMatch(/1204\);writes\d+PRAGMA foreign_key_check;reads$/);
});

test("after waits until every file statement is loaded", async () => {
  setup({
    plan: { ...PLAN, structure: [stmt(0, "CREATE SCHEMA billing;")], structureTotal: 2, after: [{ text: "PRAGMA foreign_key_check;", class: "read" }] },
    statements: [stmt(1, "CREATE TABLE billing.t (id int);")],
  });
  const d = await checked();
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  expect(within(confirm).getByLabelText("Structure SQL").textContent).not.toContain("PRAGMA");
  await userEvent.click(within(confirm).getByRole("button", { name: "Show all" }));
  await waitFor(() => expect(within(confirm).getByLabelText("Structure SQL").textContent).toMatch(/CREATE TABLE billing\.t \(id int\);writes\d+PRAGMA/));
});

async function runToCancel(connection: ConnectionConfig, check: RestoreCheck, mode: RegExp) {
  setup({ connection, plan: { ...PLAN, verdict: { kind: "ok" } } });
  const d = await checked(check);
  await userEvent.click(within(d).getByRole("radio", { name: mode }));
  await userEvent.click(within(d).getByRole("button", { name: /^Restore$/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on/ });
  await userEvent.click(within(confirm).getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(callsTo("start_restore")).toHaveLength(1));
  act(() =>
    events("start_restore").onmessage({
      kind: "progress",
      phase: "writing",
      table: null,
      rowsDone: 0,
      rowsTotal: null,
      bytesDone: 10,
      bytesTotal: CHECK.bytes,
      statementsDone: 312,
      fileRow: null,
    }),
  );
  act(() => events("start_restore").onmessage({ kind: "failed", error: { kind: "cancelled" } }));
}

test("a cancelled restore on PostgreSQL: nothing restored, the new database removed", async () => {
  await runToCancel(plain, { ...CHECK, targetName: "freight-dev" }, /Into a new database/);
  expect(await screen.findByText("Restore cancelled. Nothing was restored. freight_restore_1017 was removed.")).toBeTruthy();
});

test("a cancelled restore on MySQL says how many statements ran", async () => {
  const my = { ...plain, dialect: "mysql" as const };
  const myCheck: RestoreCheck = { ...CHECK, targetName: "freight-dev", header: { ...CHECK.header!, dialect: "mysql", schema: null }, targetDialect: "mysql", missingExtensions: [] };
  await runToCancel(my, myCheck, /Replace the 6 tables/);
  expect(await screen.findByText("Restore cancelled. 312 of 1,501 statements ran.")).toBeTruthy();
});

test("a file that changed during the check names the file only", async () => {
  setup();
  const d = await checked();
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  await userEvent.click(within(confirm).getByRole("button", { name: "Restore on freight-prod" }));
  await waitFor(() => expect(callsTo("start_restore")).toHaveLength(1));
  act(() =>
    events("start_restore").onmessage({ kind: "failed", error: { kind: "fileChanged", message: { file: "E:\\Backups\\freight-2026-10-16.sql", confirmed: false } } }),
  );
  expect(await screen.findByText("freight-2026-10-16.sql changed while Contura read it. Nothing was restored.")).toBeTruthy();
});

test("MySQL phases leave out the schema words and the sequences", async () => {
  const my = { ...plain, dialect: "mysql" as const };
  const myCheck: RestoreCheck = { ...CHECK, targetName: "freight-dev", header: { ...CHECK.header!, dialect: "mysql", schema: null }, targetDialect: "mysql", missingExtensions: [] };
  setup({ connection: my, plan: { ...PLAN, verdict: { kind: "ok" } } });
  const d = await checked(myCheck);
  await userEvent.click(within(d).getByRole("button", { name: /^Restore$/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on/ });
  await userEvent.click(within(confirm).getByRole("button", { name: "Restore" }));
  const run = await screen.findByRole("dialog", { name: /Restoring on freight-dev/ });
  const phases = within(within(run).getByRole("list", { name: "Phases" })).getAllByRole("listitem").map((li) => li.textContent);
  expect(phases).toEqual([
    "Database created",
    "Tables",
    "Rows (0 of 1,472 INSERT statements)",
    "Indexes and Foreign Keys",
    "Row counts compared with the file header",
  ]);
});

test("a started Restore is handed to the App, and an attached one opens on its running view", async () => {
  const onStarted = vi.fn();
  routeInvoke({
    inspect_restore: () => undefined,
    plan_restore: () => PLAN,
    confirm_restore: () => "pass-1",
    start_restore: () => undefined,
    cancel_job: () => undefined,
  });
  render(
    <ToastProvider>
      <JobsProvider>
        <RestoreDialog connection={prod} group={null} target={{ connectionId: "c1", database: "freight", schema: "billing" }} onClose={() => {}} onStarted={onStarted} />
      </JobsProvider>
    </ToastProvider>,
  );
  const d = await checked();
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  await userEvent.click(within(confirm).getByRole("button", { name: "Restore on freight-prod" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  const [id, run] = onStarted.mock.calls[0];
  expect(run).toMatchObject({ source: "freight", mode: "newDatabase", into: "freight_restore_1017", path: FILE, addConnection: false });
  cleanup();

  // Opened again from the status bar: straight to the running view, with Cancel.
  const onEvent = { current: null as ((e: JobEvent) => void) | null };
  function Track() {
    const jobs = useJobs();
    if (!onEvent.current) onEvent.current = jobs.track(id, "restore", "Restoring", "c1", "freight");
    return null;
  }
  render(
    <ToastProvider>
      <JobsProvider>
        <Track />
        <RestoreDialog connection={prod} group={null} target={{ connectionId: "c1", database: "freight", schema: "billing" }} onClose={() => {}} attach={{ id, run }} />
      </JobsProvider>
    </ToastProvider>,
  );
  const again = await screen.findByRole("dialog", { name: /Restoring on freight-prod/ });
  act(() =>
    onEvent.current?.({
      kind: "progress",
      phase: "writing",
      table: null,
      rowsDone: 0,
      rowsTotal: null,
      bytesDone: 5,
      bytesTotal: CHECK.bytes,
      statementsDone: 343,
      fileRow: null,
    }),
  );
  expect(await within(again).findByText("343 of 1,501")).toBeTruthy();
  await userEvent.click(within(again).getByRole("button", { name: /Cancel and roll back/ }));
  await userEvent.click(within(again).getByRole("button", { name: "Yes, roll back" }));
  expect(callsTo("cancel_job").slice(-1)[0]).toEqual({ job: id });
});

test("R15: CREATE DATABASE is shown first, before Contura's setup", async () => {
  setup({ plan: { ...PLAN, createDatabase: { text: 'CREATE DATABASE "freight_restore_1017"', class: "write" } } });
  const d = await checked();
  await userEvent.click(within(d).getByRole("button", { name: /Restore on PROD/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on freight-prod/ });
  const text = within(confirm).getByLabelText("Structure SQL").textContent ?? "";
  expect(text).toContain('CREATE DATABASE "freight_restore_1017"');
  expect(text.indexOf("CREATE DATABASE")).toBeLessThan(text.indexOf("SET client_encoding"));
});

test("R18: Replace is disabled with the Core's reason when no schema is known", async () => {
  setup({ target: { connectionId: "c1", database: "freight", schema: null } });
  const d = await checked({ ...CHECK, replaceNote: "Open Restore on a schema to replace its tables." });
  const replace = within(d).getByRole("radio", { name: /Replace the/ }) as HTMLInputElement;
  expect(replace.disabled).toBe(true);
  expect(within(d).getByText("Open Restore on a schema to replace its tables.")).toBeTruthy();
  expect(within(d).queryByText("Lists every DROP and asks again")).toBeNull();
});

test("R28: a plain Connection's start carries the reviewed fingerprint too", async () => {
  setup({ connection: plain, plan: { ...PLAN, verdict: { kind: "ok" }, fingerprint: "fp-plain" } });
  const d = await checked({ ...CHECK, targetName: "freight-dev" });
  await userEvent.click(within(d).getByRole("button", { name: /^Restore$/ }));
  const confirm = await screen.findByRole("dialog", { name: /Restore on/ });
  await userEvent.click(within(confirm).getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(callsTo("start_restore")).toHaveLength(1));
  expect(callsTo("start_restore")[0].fingerprint).toBe("fp-plain");
  expect(callsTo("start_restore")[0].pass).toBeNull();
  expect(callsTo("confirm_restore")).toHaveLength(0);
});
