import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { BackupPlan, BackupRequest, ConnectionConfig, JobEvent, JobReport } from "../api/types";
import { ToastProvider } from "../components/Toast";
import { useJobs, JobsProvider } from "../jobs/useJobs";
import { callsTo, routeInvoke } from "../test/invoke";
import BackupDialog from "./BackupDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ documentDir: vi.fn(async () => "E:\\Backups") }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const MB = 1024 * 1024;

const pg: ConnectionConfig = {
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

const PLAN: BackupPlan = {
  dialect: "postgres",
  counts: { tables: 6, indexes: 14, foreignKeys: 5, enums: 1, sequences: 6, views: 3, functions: 7, triggers: 2, rows: 742_818 },
  notIncluded: ["the pgcrypto extension", "large objects", "grants and roles"],
  estimateBytes: 48 * MB,
  nonSnapshotTables: [],
  defaultFileName: "freight-2026-10-17.sql",
};

const report = (over: Partial<JobReport> = {}): JobReport => ({
  kind: "backup",
  rowsRead: 742_818,
  rowsWritten: 742_818,
  statements: 1503,
  skipped: 0,
  warnings: [],
  elapsedMs: 3000,
  file: "E:\\Backups\\freight-2026-10-17.sql",
  bytes: Math.round(48.2 * MB),
  committed: 0,
  check: null,
  ...over,
});

let probe: ReturnType<typeof useJobs> | null = null;
function Probe() {
  probe = useJobs();
  return null;
}

function lastEvents(): { onmessage: (e: JobEvent) => void } {
  const calls = callsTo("start_backup");
  return calls[calls.length - 1].events as { onmessage: (e: JobEvent) => void };
}

function setup({
  connection = pg,
  plan = PLAN,
  database = "freight",
  schema = "billing" as string | null,
  startBackup = (): unknown => undefined,
}: { connection?: ConnectionConfig; plan?: BackupPlan; database?: string; schema?: string | null; startBackup?: (a: Record<string, unknown>) => unknown } = {}) {
  const onClose = vi.fn();
  routeInvoke({
    plan_backup: () => plan,
    start_backup: startBackup,
    cancel_job: () => undefined,
    reveal_in_folder: () => undefined,
  });
  render(
    <ToastProvider>
      <JobsProvider>
        <Probe />
        <BackupDialog connection={connection} group={null} database={database} schema={schema} onClose={onClose} />
      </JobsProvider>
    </ToastProvider>,
  );
  return { onClose };
}

async function dialog() {
  const d = await screen.findByRole("dialog", { name: /Back up freight-prod/ });
  await within(d).findByText("6 tables in billing");
  return d;
}

test("the title names the Connection and database, with the PROD chip", async () => {
  setup();
  const d = await dialog();
  expect(d.querySelector("h2")?.textContent).toContain("Back up freight-prod · freight");
  expect(within(d).getByText("Production")).toBeTruthy();
});

test("each tick has its count line", async () => {
  setup();
  const d = await dialog();
  expect(within(d).getByRole("checkbox", { name: /Tables, columns and keys/ })).toBeTruthy();
  expect(within(d).getByText("6 tables in billing")).toBeTruthy();
  expect(within(d).getByText("14 indexes, 5 Foreign Keys")).toBeTruthy();
  expect(within(d).getByText("1 enum, 6 sequences")).toBeTruthy();
  expect(within(d).getByText("3 views, 7 functions, 2 triggers, from the server's own definitions")).toBeTruthy();
  expect(within(d).getByText("742,818 rows")).toBeTruthy();
});

test("unticking Tables unticks what depends on it", async () => {
  setup();
  const d = await dialog();
  const box = (name: RegExp) => within(d).getByRole("checkbox", { name }) as HTMLInputElement;
  await userEvent.click(box(/Tables, columns and keys/));
  expect(box(/Indexes and Foreign Keys/).checked).toBe(false);
  expect(box(/Indexes and Foreign Keys/).disabled).toBe(true);
  expect(box(/Views, functions and triggers/).checked).toBe(false);
  expect(box(/^Rows/).checked).toBe(false);
  // Enums and sequences stand alone.
  expect(box(/Enums and sequences/).checked).toBe(true);
  await userEvent.click(box(/Tables, columns and keys/));
  expect(box(/Indexes and Foreign Keys/).disabled).toBe(false);
});

test("the Not included banner, Save to hint, Consistency, Estimated, Production banner and footer", async () => {
  setup();
  const d = await dialog();
  expect(
    within(d).getByText(
      "Not included: the pgcrypto extension, large objects, grants and roles. The file header lists them so a restore can say what to add by hand.",
    ),
  ).toBeTruthy();
  await waitFor(() => expect((within(d).getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("freight-2026-10-17.sql"));
  expect(within(d).getByText("Written as freight-2026-10-17.sql.partial and renamed when complete.")).toBeTruthy();
  expect(within(d).getByText("One snapshot: the whole file shows freight at the moment the backup starts.")).toBeTruthy();
  expect(within(d).getByText("About 48 MB, 742,818 rows in 6 tables")).toBeTruthy();
  expect(within(d).getByText("The file is plain text and holds Production rows. Keep it somewhere safe.")).toBeTruthy();
  expect(within(d).getByText("Backup only reads freight-prod, so no confirmation is needed.")).toBeTruthy();
  expect(within(d).getByRole("button", { name: /Cancel/ })).toBeTruthy();
  expect(within(d).getByRole("button", { name: /^Back up/ })).toBeTruthy();
  expect(within(d).getByRole("radio", { name: /Contura SQL script/ })).toBeTruthy();
  expect(within(d).getByText("Plain SQL that Contura can restore, readable in any editor.")).toBeTruthy();
  // Exact file copy is SQLite's only.
  expect(within(d).queryByRole("radio", { name: /Exact file copy/ })).toBeNull();
});

test("a plain Connection has no Production banner", async () => {
  setup({ connection: { ...pg, production: false } });
  const d = await dialog();
  expect(within(d).queryByText(/holds Production rows/)).toBeNull();
});

test("SQLite offers the exact file copy", async () => {
  const lite: ConnectionConfig = { ...pg, dialect: "sqlite", name: "kiosk", production: false, file: "E:\\data\\kiosk.db", database: null };
  setup({ connection: lite, database: "main", schema: null, plan: { ...PLAN, dialect: "sqlite", notIncluded: [], defaultFileName: "main-2026-10-17.sql" } });
  const d = await screen.findByRole("dialog", { name: /Back up kiosk/ });
  const copy = await within(d).findByRole("radio", { name: /Exact file copy/ });
  expect(within(d).getByText("A copy of the database file, made with VACUUM INTO. Restore it by opening it as a Connection.")).toBeTruthy();
  await userEvent.click(copy);
  await userEvent.click(within(d).getByRole("button", { name: /^Back up/ }));
  await waitFor(() => expect(callsTo("start_backup")).toHaveLength(1));
  expect((callsTo("start_backup")[0].req as BackupRequest).format).toBe("fileCopy");
});

test("MySQL with MyISAM tables says their rows may not match", async () => {
  setup({
    connection: { ...pg, dialect: "mysql" },
    schema: null,
    plan: { ...PLAN, dialect: "mysql", nonSnapshotTables: ["orders"] },
  });
  const d = await screen.findByRole("dialog", { name: /Back up freight-prod/ });
  expect(await within(d).findByText("orders uses MyISAM, so its rows may not match the moment the backup starts.")).toBeTruthy();
});

test("Back up sends the request; an existing file asks first", async () => {
  let first = true;
  setup({
    startBackup: () => {
      if (first) {
        first = false;
        throw { kind: "fileExists", message: "E:\\Backups\\freight-2026-10-17.sql" };
      }
      return undefined;
    },
  });
  const d = await dialog();
  await waitFor(() => expect((within(d).getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("freight-2026-10-17.sql"));
  await userEvent.click(within(d).getByRole("button", { name: /^Back up/ }));
  const ask = await screen.findByText("freight-2026-10-17.sql exists. Replace it?");
  expect(ask).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Replace" }));
  await waitFor(() => expect(callsTo("start_backup")).toHaveLength(2));
  const call = callsTo("start_backup")[1];
  expect(call.overwrite).toBe(true);
  const req = call.req as BackupRequest;
  expect(req).toMatchObject({
    connectionId: "c1",
    database: "freight",
    schema: "billing",
    format: "script",
    rowsPerStatement: 500,
    addDropTables: false,
    path: "E:\\Backups\\freight-2026-10-17.sql",
  });
});

test("the running state, Run in the background and Cancel", async () => {
  const { onClose } = setup();
  const d = await dialog();
  await waitFor(() => expect((within(d).getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("freight-2026-10-17.sql"));
  await userEvent.click(within(d).getByRole("button", { name: /^Back up/ }));
  await waitFor(() => expect(callsTo("start_backup")).toHaveLength(1));
  act(() =>
    lastEvents().onmessage({
      kind: "progress",
      phase: "writing",
      table: "billing.invoices",
      rowsDone: 371_409,
      rowsTotal: 742_818,
      bytesDone: 24 * MB,
      bytesTotal: null,
      statementsDone: 700,
      fileRow: null,
      tablesDone: 3,
      tablesTotal: 6,
    }),
  );
  const run = await screen.findByRole("dialog", { name: /Back up freight-prod/ });
  expect(await within(run).findByText("3 of 6, now billing.invoices")).toBeTruthy();
  expect(within(run).getByText("371,409 of 742,818")).toBeTruthy();
  expect(within(run).getByText("24 MB")).toBeTruthy();
  expect(within(run).getByText("50 percent")).toBeTruthy();
  expect(within(run).getByText("Cancel deletes the unfinished file.")).toBeTruthy();
  await userEvent.click(within(run).getByRole("button", { name: "Cancel" }));
  expect(callsTo("cancel_job")).toHaveLength(1);
  await userEvent.click(within(run).getByRole("button", { name: /Run in the background/ }));
  expect(onClose).toHaveBeenCalled();
  expect(probe?.jobs[0].background).toBe(true);
});

test("the end shows the toast with Open folder", async () => {
  const { onClose } = setup();
  const d = await dialog();
  await waitFor(() => expect((within(d).getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("freight-2026-10-17.sql"));
  await userEvent.click(within(d).getByRole("button", { name: /^Back up/ }));
  await waitFor(() => expect(callsTo("start_backup")).toHaveLength(1));
  act(() => lastEvents().onmessage({ kind: "finished", report: report() }));
  expect(await screen.findByText("Backed up freight to freight-2026-10-17.sql, 48.2 MB")).toBeTruthy();
  expect(onClose).toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
  expect(callsTo("reveal_in_folder")[0]).toEqual({ path: "E:\\Backups\\freight-2026-10-17.sql" });
});

test("MySQL keeps Indexes and Foreign Keys on with the tables, and has no Enums and sequences", async () => {
  setup({ connection: { ...pg, dialect: "mysql" }, schema: null, plan: { ...PLAN, dialect: "mysql" } });
  const d = await screen.findByRole("dialog", { name: /Back up freight-prod/ });
  const idx = (await within(d).findByRole("checkbox", { name: /Indexes and Foreign Keys/ })) as HTMLInputElement;
  expect(idx.checked).toBe(true);
  expect(idx.disabled).toBe(true);
  expect(within(d).getByText("On MySQL these are part of each table's CREATE TABLE.")).toBeTruthy();
  expect(within(d).queryByRole("checkbox", { name: /Enums and sequences/ })).toBeNull();
  await waitFor(() => expect((within(d).getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("freight-2026-10-17.sql"));
  await userEvent.click(within(d).getByRole("button", { name: /^Back up/ }));
  await waitFor(() => expect(callsTo("start_backup")).toHaveLength(1));
  expect((callsTo("start_backup")[0].req as BackupRequest).include.indexes).toBe(true);
});

test("Ctrl+Enter does nothing when nothing is ticked", async () => {
  setup();
  const d = await dialog();
  await waitFor(() => expect((within(d).getByRole("textbox", { name: "File name" }) as HTMLInputElement).value).toBe("freight-2026-10-17.sql"));
  for (const name of [/Tables, columns and keys/, /Enums and sequences/]) await userEvent.click(within(d).getByRole("checkbox", { name }));
  expect((within(d).getByRole("button", { name: /^Back up/ }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(within(d).getByRole("textbox", { name: "File name" }));
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(callsTo("start_backup")).toHaveLength(0);
});

test("R21: on PostgreSQL Enums and sequences follow Tables", async () => {
  setup();
  const d = await dialog();
  const box = (name: RegExp) => within(d).getByRole("checkbox", { name }) as HTMLInputElement;
  expect(box(/Enums and sequences/).checked).toBe(true);
  expect(box(/Enums and sequences/).disabled).toBe(true);
  await userEvent.click(box(/Tables, columns and keys/));
  expect(box(/Enums and sequences/).disabled).toBe(false);
  await userEvent.click(box(/Enums and sequences/));
  expect(box(/Enums and sequences/).checked).toBe(false);
  // Ticking Tables again brings them back on.
  await userEvent.click(box(/Tables, columns and keys/));
  expect(box(/Enums and sequences/).checked).toBe(true);
  await userEvent.click(within(d).getByRole("button", { name: /^Back up/ }));
  await waitFor(() => expect(callsTo("start_backup")).toHaveLength(1));
  expect((callsTo("start_backup")[0].req as BackupRequest).include.enums).toBe(true);
});

test("R25: the request carries the user's local date", async () => {
  setup();
  await dialog();
  const sent = callsTo("plan_backup")[0].req as BackupRequest;
  const now = new Date();
  const two = (v: number) => String(v).padStart(2, "0");
  expect(sent.localDate).toBe(`${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`);
});

test("the form is the wide Backup form; the Not included banner sits under both columns", async () => {
  setup();
  const d = await dialog();
  expect(d.classList.contains("backup-form")).toBe(true);
  const banner = within(d).getByText(/^Not included:/).closest(".backup-banner");
  expect(banner?.parentElement?.classList.contains("backup-body")).toBe(true);
  expect(banner?.closest(".backup-grid")).toBeNull();
});
