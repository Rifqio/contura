import type { Channel } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig, DbObject, JobEvent, SchemaModel, TransferPlan } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import type { TransferSeed } from "../shell/tabs";
import { JobsProvider } from "../jobs/useJobs";
import TransferTab, { transferStep, transferTabAsk } from "./TransferTab";
import { clearAllSteps, RecordStepContext, stepsOf } from "../assistant/recentSteps";
import { emptyTransfer } from "./transferModel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

const BASE: ConnectionConfig = {
  id: "my",
  name: "kestrel-pos",
  dialect: "mysql",
  host: "h",
  port: 3306,
  user: "u",
  database: "pos_live",
  ssl: { mode: "disable" },
  file: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
  groupId: null,
};
const PG: ConnectionConfig = { ...BASE, id: "pg", name: "pinecone-analytics", dialect: "postgres", port: 5432, database: "analytics" };
const PROD: ConnectionConfig = { ...PG, id: "prod", name: "freight-prod", production: true };
const RO: ConnectionConfig = { ...PG, id: "ro", name: "kestrel-reporting", readOnly: true };
const CONNS = [BASE, PG, PROD, RO];

const GB = 1024 ** 3;
const OBJECTS: DbObject[] = [
  { kind: "table", name: "sales", rows: 1_284_339, bytes: 0.3 * GB },
  { kind: "table", name: "stores", rows: 412, bytes: 96 * 1024 },
  { kind: "table", name: "customers", rows: 18_904, bytes: 5 * 1024 ** 2 },
  { kind: "table", name: "audit_log", rows: 9, bytes: 1024 },
  { kind: "view", name: "daily_totals", rows: null, bytes: null },
];
const ref = (from: string, to: string) => ({
  name: null,
  from: { schema: null, table: from, columns: [`${to}_id`] },
  to: { schema: null, table: to, columns: ["id"] },
  onDelete: null,
  onUpdate: null,
});
const MODEL: SchemaModel = { dialect: "mysql", tables: [], refs: [ref("sales", "stores"), ref("sales", "customers")], enums: [], skipped: [] };

function routes() {
  return routeInvoke({
    open_connection: (a) => (a.id === "my" ? "8.0.30" : "17.0"),
    list_objects: (a) => (a.id === "my" ? OBJECTS : []),
    schema_snapshot: () => MODEL,
    list_databases: (a) => (a.id === "my" ? ["pos_live", "pos_archive"] : ["analytics"]),
    list_schemas: () => [
      { name: "public", isSystem: false },
      { name: "pos", isSystem: false },
    ],
  });
}

function renderTab(seed: Partial<TransferSeed> = {}) {
  const onMeta = vi.fn();
  render(
    <RecordStepContext.Provider value="ungrouped">
      <JobsProvider>
        <TransferTab
          seed={{ connectionId: "my", database: "pos_live", schema: null, table: null, ...seed }}
          connections={CONNS}
          groups={[]}
          visible
          onMeta={onMeta}
        />
      </JobsProvider>
    </RecordStepContext.Provider>,
  );
  return { onMeta };
}

const combo = (name: string) => screen.getByRole("combobox", { name });

async function pickTarget(name: RegExp, schema = "pos") {
  await userEvent.click(combo("Target Connection"));
  await userEvent.click(screen.getByRole("option", { name }));
  await userEvent.click(combo("Target database"));
  await userEvent.click(screen.getByRole("option", { name: "analytics" }));
  await userEvent.click(combo("Target schema"));
  await userEvent.click(screen.getByRole("option", { name: `schema ${schema}` }));
}

async function toTables() {
  await pickTarget(/^pinecone-analytics/);
  await userEvent.click(screen.getByRole("button", { name: /Next: Tables/ }));
  await screen.findByRole("region", { name: "Tables" });
}

const tableNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.getAttribute("data-table"));

test("the target picker greys out Read-only and names Production", async () => {
  routes();
  renderTab();
  await userEvent.click(combo("Target Connection"));
  const ro = screen.getByRole("option", { name: /kestrel-reporting/ });
  expect(ro.getAttribute("aria-disabled")).toBe("true");
  expect(ro.textContent).toContain("Read-only: cannot be a target");
  expect(screen.getByRole("option", { name: /freight-prod/ }).textContent).toContain("Asks you to confirm the exact SQL before it runs");
  // The source picker offers every Connection, with no target lines.
  await userEvent.keyboard("{Escape}");
  await userEvent.click(combo("Source Connection"));
  expect(screen.getByRole("option", { name: /kestrel-reporting/ }).getAttribute("aria-disabled")).toBeNull();
});

test("the source and target hints use the exact texts", async () => {
  routes();
  renderTab();
  await screen.findByText("MySQL 8.0.30 · 4 tables, 1 view · 312.3 MB · reading only");
  await pickTarget(/^pinecone-analytics/);
  await screen.findByText("PostgreSQL 17.0 · schema pos is empty · structure and rows run in one transaction");
});

test("the same database on both sides is refused", async () => {
  routes();
  renderTab();
  await userEvent.click(combo("Target Connection"));
  await userEvent.click(screen.getByRole("option", { name: /^kestrel-pos/ }));
  await userEvent.click(combo("Target database"));
  await userEvent.click(screen.getByRole("option", { name: "pos_live" }));
  expect(screen.getByRole("alert").textContent).toBe("Source and target are the same. Pick another target.");
  expect((screen.getByRole("button", { name: /Next: Tables/ }) as HTMLButtonElement).disabled).toBe(true);
});

test("tables load parents first, views are listed disabled", async () => {
  routes();
  renderTab();
  await toTables();
  expect(tableNames()).toEqual(["stores", "customers", "audit_log", "sales", "daily_totals"]);
  const view = screen.getByRole("checkbox", { name: "daily_totals is a view" }) as HTMLInputElement;
  expect(view.disabled).toBe(true);
  expect(screen.getByText("Views are not copied. Recreate it after.")).toBeTruthy();
  expect(screen.getByText("4 of 4 ticked")).toBeTruthy();
  expect(screen.getByText("Parents first, so Foreign Keys hold. Drag a row to change the order.")).toBeTruthy();
});

test("space ticks a table, Alt+Up and Alt+Down move it", async () => {
  routes();
  renderTab();
  await toTables();
  const row = (name: string) => document.querySelector(`tr[data-table="${name}"]`)!;
  fireEvent.keyDown(row("audit_log"), { key: " " });
  expect(screen.getByText("3 of 4 ticked")).toBeTruthy();
  fireEvent.keyDown(row("customers"), { key: "ArrowUp", altKey: true });
  expect(tableNames().slice(0, 2)).toEqual(["customers", "stores"]);
  fireEvent.keyDown(row("customers"), { key: "ArrowDown", altKey: true });
  fireEvent.keyDown(row("customers"), { key: "ArrowDown", altKey: true });
  expect(tableNames().slice(0, 3)).toEqual(["stores", "audit_log", "customers"]);
  // A table never moves below the views.
  fireEvent.keyDown(row("sales"), { key: "ArrowDown", altKey: true });
  expect(tableNames().slice(-2)).toEqual(["sales", "daily_totals"]);
});

test("dragging a row changes the order", async () => {
  routes();
  renderTab();
  await toTables();
  const row = (name: string) => document.querySelector(`tr[data-table="${name}"]`)!;
  const data = { setData: vi.fn(), effectAllowed: "" };
  fireEvent.dragStart(row("sales"), { dataTransfer: data });
  fireEvent.dragOver(row("stores"), { dataTransfer: data });
  fireEvent.drop(row("stores"), { dataTransfer: data });
  expect(tableNames()[0]).toBe("sales");
});

test("a table ticked without its parent gets a note", async () => {
  routes();
  renderTab();
  await toTables();
  fireEvent.click(screen.getByRole("checkbox", { name: "Tick stores" }));
  expect(screen.getByText("Needs stores, which is not ticked")).toBeTruthy();
});

test("If it exists is set per table and from the header for all", async () => {
  routes();
  renderTab();
  await toTables();
  await userEvent.click(combo("If sales exists"));
  await userEvent.click(screen.getByRole("option", { name: "Append" }));
  expect(combo("If sales exists").textContent).toContain("Append");
  expect(combo("If stores exists").textContent).toContain("Stop");
  await userEvent.click(within(screen.getByRole("radiogroup", { name: "If a table already exists" })).getByRole("radio", { name: "Empty it first" }));
  for (const t of ["sales", "stores", "customers", "audit_log"]) expect(combo(`If ${t} exists`).textContent).toContain("Empty it first");
  expect(screen.getByText("Stop is the default: nothing on the target is touched.")).toBeTruthy();
});

test("the right panel shows the options and the transfer size", async () => {
  routes();
  renderTab();
  await toTables();
  expect(screen.getByRole("radio", { name: "Structure and rows" })).toHaveProperty("checked", true);
  expect((screen.getByRole("textbox", { name: "Rows per batch" }) as HTMLInputElement).value).toBe("1,000");
  expect(screen.getByRole("switch", { name: "Compare row counts at the end" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("This transfer: 4 tables, 1,303,664 rows. About 312.3 MB read from kestrel-pos.")).toBeTruthy();
  // A batch outside 100 to 5,000 is held to the nearest end.
  const batch = screen.getByRole("textbox", { name: "Rows per batch" }) as HTMLInputElement;
  fireEvent.change(batch, { target: { value: "20000" } });
  fireEvent.blur(batch);
  expect(batch.value).toBe("5,000");
});

test("a table row's Transfer data ticks only that table", async () => {
  routes();
  renderTab({ table: "customers" });
  await toTables();
  expect(screen.getByText("1 of 4 ticked")).toBeTruthy();
});

test("the tab title names both databases and is marked until it runs", async () => {
  routes();
  const { onMeta } = renderTab();
  await waitFor(() => expect(onMeta).toHaveBeenLastCalledWith("Data Transfer", true));
  await pickTarget(/^pinecone-analytics/);
  await waitFor(() => expect(onMeta).toHaveBeenLastCalledWith("pos_live to analytics", true));
});

test("Ctrl+Enter goes on and Alt+Left goes back", async () => {
  routes();
  renderTab();
  await pickTarget(/^pinecone-analytics/);
  const tab = document.querySelector(".transfer-tab") as HTMLElement;
  fireEvent.keyDown(tab, { key: "Enter", ctrlKey: true });
  await screen.findByRole("region", { name: "Tables" });
  fireEvent.keyDown(tab, { key: "ArrowLeft", altKey: true });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Tables" })).toBeNull());
});

// ---- Task 9: Type mapping, Review SQL and Run ----

const PLAN: TransferPlan = {
  sourceDialect: "mysql",
  targetDialect: "postgres",
  tables: [
    {
      name: "sales",
      target: "sales",
      exists: false,
      columns: [
        { name: "id", targetName: "id", sourceType: "int", targetType: "integer" },
        { name: "is_refund", targetName: "is_refund", sourceType: "tinyint(1)", targetType: "smallint" },
        { name: "drop_point", targetName: "drop_point", sourceType: "point", targetType: "text" },
      ],
    },
  ],
  mappingNotes: [
    {
      table: "sales",
      column: "is_refund",
      kind: { kind: "needsChoice", options: ["boolean", "smallint"] },
      text: "tinyint(1) is often a flag. Pick boolean or smallint.",
    },
    { table: "sales", column: "drop_point", kind: { kind: "noMatch" }, text: "No PostgreSQL match. Copied as text, for example POINT(-1.54 53.80)." },
  ],
  notes: [],
  structure: ['CREATE TABLE "pos"."sales" (id integer);'],
  afterRows: ['CREATE INDEX "sales_id" ON "pos"."sales" (id);'],
  copies: [
    {
      table: "sales",
      source: "sales",
      target: '"pos"."sales"',
      columns: [],
      select: "",
      sourceSql: "",
      insertHead: 'INSERT INTO "pos"."sales" (id, is_refund, drop_point)',
      targetSql: "",
      overriding: false,
      delete: null,
      keyColumns: ["id"],
      rowsHint: 1500,
    },
  ],
  notCopied: ["view daily_totals", "trigger sales_touch on sales"],
  emptied: [],
  mode: "oneTransaction",
  modeLine: "PostgreSQL target: everything runs in one transaction. Cancel rolls it all back.",
  blocked: ["sales.is_refund"],
  fkGroups: [],
  orphanChecks: [],
  fingerprint: "f".repeat(64),
};
const SETTLED: TransferPlan = { ...PLAN, mappingNotes: [PLAN.mappingNotes[1]!], blocked: [] };

type Req = { choices: unknown[]; overrides: unknown[]; tables: { ifExists: string }[] };

function runRoutes(over: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  const sent: Channel<JobEvent>[] = [];
  routeInvoke({
    open_connection: (a) => (a.id === "my" ? "8.0.30" : "17.0"),
    list_objects: (a) => (a.id === "my" ? OBJECTS : []),
    schema_snapshot: () => MODEL,
    list_databases: (a) => (a.id === "my" ? ["pos_live"] : ["analytics"]),
    list_schemas: () => [{ name: "pos", isSystem: false }],
    plan_transfer: (a) => ((a.req as Req).choices.length > 0 ? SETTLED : PLAN),
    transfer_sample: () => 'INSERT INTO "pos"."sales" (id) VALUES (1), (2), (3), (4);',
    confirm_transfer: () => "pass-1",
    start_transfer: (a) => {
      sent.push(a.events as Channel<JobEvent>);
      return a.job;
    },
    cancel_job: () => undefined,
    ...over,
  });
  return sent;
}

function renderWith(extra: Partial<Parameters<typeof TransferTab>[0]>) {
  render(
    <JobsProvider>
      <TransferTab
        seed={{ connectionId: "my", database: "pos_live", schema: null, table: null }}
        connections={CONNS}
        groups={[]}
        visible
        onMeta={vi.fn()}
        {...extra}
      />
    </JobsProvider>,
  );
}

async function toMapping(target = /^pinecone-analytics/) {
  await pickTarget(target);
  await userEvent.click(screen.getByRole("button", { name: /Next: Tables/ }));
  await screen.findByRole("region", { name: "Tables" });
  await userEvent.click(screen.getByRole("button", { name: /Next: Type mapping/ }));
  await screen.findByRole("region", { name: "Columns of stores" });
}

function setType(column: string, value: string) {
  const input = screen.getByRole("combobox", { name: `Target type of sales.${column}` });
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

const nextReview = () => screen.getByRole("button", { name: /Next: Review SQL/ }) as HTMLButtonElement;

async function toReview(target?: RegExp) {
  await toMapping(target);
  await userEvent.click(screen.getByRole("button", { name: /sales/ }));
  setType("is_refund", "boolean");
  await waitFor(() => expect(nextReview().disabled).toBe(false));
  await userEvent.click(nextReview());
  await screen.findByRole("region", { name: "Structure SQL" });
}

const lastReq = () => callsTo("plan_transfer").slice(-1)[0]!.req as Req;

test("a needs-a-choice column blocks Next until a type is picked", async () => {
  runRoutes();
  renderTab();
  await toMapping();
  await userEvent.click(screen.getByRole("button", { name: /sales/ }));
  expect(screen.getByText("3 columns, 2 notes, 1 needs a choice")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe(
    "1 column needs a choice before Review SQL. Every type here can be changed; the SQL in the next step uses what you set.",
  );
  expect(screen.getByText("No PostgreSQL match. Copied as text, for example POINT(-1.54 53.80).")).toBeTruthy();
  expect(screen.getByText("2 notes. Rows that do not fit their new type stop the run with the row number.")).toBeTruthy();
  expect(screen.getByText("Also not copied from sales: trigger sales_touch on sales. They are listed again on Review SQL.")).toBeTruthy();
  expect(nextReview().disabled).toBe(true);
  expect(nextReview().title).toBe("Pick a type for sales.is_refund first");
  // Notes only shows the columns with a note.
  await userEvent.click(screen.getByRole("radio", { name: "Notes only 2" }));
  expect(screen.queryByRole("combobox", { name: "Target type of sales.id" })).toBeNull();
  await userEvent.click(screen.getByRole("radio", { name: "All 3 columns" }));

  setType("is_refund", "boolean");
  await waitFor(() => expect(nextReview().disabled).toBe(false));
  expect(lastReq().choices).toEqual([{ table: "sales", column: "is_refund", value: "boolean" }]);
  // A type typed by hand is an override.
  setType("id", "bigint");
  await waitFor(() => expect(lastReq().overrides).toEqual([{ table: "sales", column: "id", value: "bigint" }]));
});

test("a refused type shows the Core's words and keeps the grid", async () => {
  runRoutes({
    plan_transfer: (a) => {
      if ((a.req as Req).overrides.length > 0) throw { kind: "invalidInput", message: "The type of id is not one SQL expression." };
      return PLAN;
    },
  });
  renderTab();
  await toMapping();
  await userEvent.click(screen.getByRole("button", { name: /sales/ }));
  setType("id", "int; DROP TABLE x");
  expect((await screen.findByRole("alert")).textContent).toContain("The type of id is not one SQL expression.");
  expect(screen.getByRole("combobox", { name: "Target type of sales.is_refund" })).toBeTruthy();
});

test("Review SQL shows the exact SQL, the row copies and what is not copied", async () => {
  runRoutes();
  const onOpenInEditor = vi.fn();
  renderWith({ onOpenInEditor });
  await toReview();
  const sql = screen.getByRole("region", { name: "Structure SQL" }).textContent ?? "";
  expect(sql).toContain("-- Tables");
  expect(sql).toContain('CREATE TABLE "pos"."sales" (id integer);');
  expect(sql).toContain("-- Indexes, after the rows");
  expect(screen.getByText('sales: INSERT INTO "pos"."sales" (id, is_refund, drop_point) VALUES ... 1,500 rows in batches of 1,000')).toBeTruthy();
  expect(screen.getByText("view daily_totals")).toBeTruthy();
  expect(screen.getByText(PLAN.modeLine)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open in editor" }));
  expect(onOpenInEditor).toHaveBeenCalledWith({ connectionId: "pg", database: "analytics", schema: "pos" }, expect.stringContaining("CREATE TABLE"));
  await userEvent.click(screen.getByRole("button", { name: "Show sample" }));
  const sample = await screen.findByRole("dialog", { name: "Sample INSERT for sales" });
  await waitFor(() => expect(sample.textContent).toContain("VALUES (1), (2), (3), (4);"));
  expect(callsTo("transfer_sample")[0]!.table).toBe("sales");
});

test("Empty it first shows the danger banner and Change to Stop", async () => {
  runRoutes({
    plan_transfer: (a) => {
      const r = a.req as Req;
      const base = r.choices.length > 0 ? SETTLED : PLAN;
      return r.tables.some((t) => t.ifExists === "emptyFirst") ? { ...base, emptied: [{ table: "stores", rows: 412 }] } : base;
    },
  });
  renderTab();
  await pickTarget(/^pinecone-analytics/);
  await userEvent.click(screen.getByRole("button", { name: /Next: Tables/ }));
  await screen.findByRole("region", { name: "Tables" });
  await userEvent.click(combo("If stores exists"));
  await userEvent.click(screen.getByRole("option", { name: "Empty it first" }));
  await userEvent.click(screen.getByRole("button", { name: /Next: Type mapping/ }));
  await screen.findByRole("region", { name: "Columns of stores" });
  await userEvent.click(screen.getByRole("button", { name: /sales/ }));
  setType("is_refund", "boolean");
  await waitFor(() => expect(nextReview().disabled).toBe(false));
  await userEvent.click(nextReview());
  expect((await screen.findByRole("alert")).textContent).toContain("Empty it first deletes 412 rows in stores on pinecone-analytics.");
  await userEvent.click(screen.getByRole("button", { name: "Change to Stop" }));
  await waitFor(() => expect(screen.queryByText(/Empty it first deletes/)).toBeNull());
});

test("a Production target asks with the job body, then runs with the pass", async () => {
  const sent = runRoutes({
    plan_transfer: (a) => ({ ...((a.req as Req).choices.length > 0 ? SETTLED : PLAN), emptied: [{ table: "stores", rows: 412 }] }),
  });
  renderTab();
  await toReview(/^freight-prod/);
  await userEvent.click(screen.getByRole("button", { name: /Run on PROD\.\.\./ }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("Transfer to freight-prod · analytics");
  expect(dialog.textContent).toContain("Creates 1 table and 1 index, then copies 1,500 rows from kestrel-pos (counted when the run starts).");
  expect(dialog.textContent).toContain("Empty it first deletes 412 rows in stores on freight-prod.");
  expect(dialog.textContent).toContain("Enter runs only when Run on freight-prod has focus.");
  const runButton = within(dialog).getByRole("button", { name: "Run on freight-prod" });
  expect(runButton.className).toContain("button-danger-fill");
  await userEvent.click(runButton);
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(callsTo("confirm_transfer")).toHaveLength(1);
  expect(callsTo("start_transfer")[0]).toMatchObject({ pass: "pass-1", reviewed: "f".repeat(64) });
});

test("the run shows each table, then the success line", async () => {
  const sent = runRoutes();
  const onOpenTarget = vi.fn();
  renderWith({ onOpenTarget });
  await toReview();
  fireEvent.keyDown(document.querySelector(".transfer-tab")!, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(callsTo("start_transfer")[0]).toMatchObject({ pass: null, reviewed: "f".repeat(64) });
  const ch = sent[0]!;
  act(() =>
    ch.onmessage({
      kind: "progress",
      phase: "writing",
      table: "sales",
      rowsDone: 700,
      rowsTotal: 1500,
      bytesDone: 0,
      bytesTotal: null,
      statementsDone: 0,
      fileRow: null,
      tableRows: 700,
      tableTotal: 1500,
    }),
  );
  expect(await screen.findByText("Copying 1 table to pinecone-analytics")).toBeTruthy();
  expect(screen.getByText("700 of 1,500")).toBeTruthy();
  expect(screen.getByText("You can keep working in other tabs.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel and roll back" })).toBeTruthy();
  act(() =>
    ch.onmessage({
      kind: "finished",
      report: { kind: "transfer", rowsRead: 1500, rowsWritten: 1500, statements: 1, elapsedMs: 252_000, committed: 1500 } as never,
    }),
  );
  expect(await screen.findByText("Copied 1 table, 1,500 rows in 4m 12s. Row counts match.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open in the target tree" }));
  expect(onOpenTarget).toHaveBeenCalledWith({ connectionId: "pg", database: "analytics", schema: "pos", name: "sales" });
});

test("a failed run shows the error, Back to Type mapping and Run again", async () => {
  const sent = runRoutes();
  renderTab();
  await toReview();
  await userEvent.click(screen.getByRole("button", { name: /^Run/ }));
  await waitFor(() => expect(sent).toHaveLength(1));
  const message =
    "sales, row 500, id 500: the value NaN is not valid for numeric(10,2) in unit_price. The transaction rolled back, so pinecone-analytics is as it was.";
  act(() =>
    sent[0]!.onmessage({
      kind: "failed",
      error: { kind: "jobFailed", message: { at: { fileRow: null, line: null, table: "sales", statement: null }, message } },
    }),
  );
  expect(await screen.findByText("Transfer stopped, nothing was written")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("the value NaN is not valid");
  expect(screen.getByText("Fix the value in kestrel-pos, or set unit_price to text on Type mapping, then run again.")).toBeTruthy();
  expect(screen.getByText("Recorded in Query History for pinecone-analytics.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /Run again/ }));
  await waitFor(() => expect(sent).toHaveLength(2));
  act(() => sent[1]!.onmessage({ kind: "failed", error: { kind: "cancelled" } as never }));
  await userEvent.click(await screen.findByRole("button", { name: "Back to Type mapping" }));
  expect(await screen.findByRole("region", { name: /Columns of/ })).toBeTruthy();
});

test("a target that changed since review goes back to Review SQL with the notice", async () => {
  runRoutes({
    start_transfer: () => {
      throw { kind: "invalidInput", message: "The target changed since you reviewed. Check the SQL again." };
    },
  });
  renderTab();
  await toReview();
  await userEvent.click(screen.getByRole("button", { name: /^Run/ }));
  expect(await screen.findByText("The target changed since you reviewed. Check the SQL again.")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Structure SQL" })).toBeTruthy();
});

test("a name too long for the target is picked on Type mapping", async () => {
  const long = "c".repeat(70);
  const named: TransferPlan = {
    ...SETTLED,
    tables: [{ ...SETTLED.tables[0]!, columns: [{ name: long, targetName: long.slice(0, 63), sourceType: "int", targetType: "integer" }] }],
    mappingNotes: [
      {
        table: "sales",
        column: long,
        kind: { kind: "needsChoice", options: [long.slice(0, 63)] },
        text: `The name ${long} is longer than PostgreSQL's 63 bytes. The server would cut it, so pick a name.`,
      },
    ],
    blocked: [`sales.${long}`],
  };
  runRoutes({ plan_transfer: (a) => ((a.req as { names: unknown[] }).names.length > 0 ? SETTLED : named) });
  renderTab();
  await toMapping();
  await userEvent.click(screen.getByRole("button", { name: /sales/ }));
  expect(nextReview().disabled).toBe(true);
  const name = screen.getByRole("textbox", { name: `Target name of sales.${long}` });
  fireEvent.change(name, { target: { value: "c_short" } });
  fireEvent.blur(name);
  await waitFor(() => expect(nextReview().disabled).toBe(false));
  expect((callsTo("plan_transfer").slice(-1)[0]!.req as { names: unknown[] }).names).toEqual([{ table: "sales", column: long, value: "c_short" }]);
});

// ---- Review findings ----

test("Review shows the Core's refusal after Change to Stop and Run is off", async () => {
  const refusal = "products already exists on pinecone-analytics. Choose Append or Empty it first, or untick it.";
  runRoutes({
    plan_transfer: (a) => {
      const r = a.req as Req;
      if (r.tables.some((t) => t.ifExists === "emptyFirst")) {
        return { ...SETTLED, emptied: [{ table: "products", rows: 2316 }], structure: ['DELETE FROM "pos"."products";'] };
      }
      if (r.choices.length + r.overrides.length > 0) throw { kind: "invalidInput", message: refusal };
      return PLAN;
    },
  });
  renderTab();
  await pickTarget(/^pinecone-analytics/);
  await userEvent.click(screen.getByRole("button", { name: /Next: Tables/ }));
  await screen.findByRole("region", { name: "Tables" });
  await userEvent.click(within(screen.getByRole("radiogroup", { name: "If a table already exists" })).getByRole("radio", { name: "Empty it first" }));
  await userEvent.click(screen.getByRole("button", { name: /Next: Type mapping/ }));
  await screen.findByRole("region", { name: "Columns of stores" });
  await userEvent.click(screen.getByRole("button", { name: /sales/ }));
  setType("is_refund", "boolean");
  await waitFor(() => expect(nextReview().disabled).toBe(false));
  await userEvent.click(nextReview());
  await screen.findByRole("button", { name: "Change to Stop" });
  await userEvent.click(screen.getByRole("button", { name: "Change to Stop" }));
  // errorText starts the Core's sentence with a capital.
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(`P${refusal.slice(1)}`));
  expect((screen.getByRole("button", { name: /^Run/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("region", { name: "Structure SQL" })).toBeNull();
  expect(screen.queryByText(/DELETE FROM/)).toBeNull();
});

test("a type change on Type mapping holds Next until the new plan arrives", async () => {
  const held: { release?: () => void } = {};
  runRoutes({
    plan_transfer: async (a) => {
      const r = a.req as Req;
      if (r.overrides.length > 0) await new Promise<void>((done) => (held.release = done));
      return r.choices.length > 0 ? SETTLED : PLAN;
    },
  });
  renderTab();
  await toMapping();
  await userEvent.click(screen.getByRole("button", { name: /sales/ }));
  setType("is_refund", "boolean");
  await waitFor(() => expect(nextReview().disabled).toBe(false));
  setType("id", "bigint");
  await waitFor(() => expect(nextReview().disabled).toBe(true));
  // The grid stays while the plan is rebuilt.
  expect(screen.getByRole("combobox", { name: "Target type of sales.id" })).toBeTruthy();
  await waitFor(() => expect(held.release).toBeDefined());
  act(() => held.release!());
  await waitFor(() => expect(nextReview().disabled).toBe(false));
});

test("Ctrl+Enter in Rows per batch keeps the typed value", async () => {
  runRoutes();
  renderTab();
  await toTables();
  const batch = screen.getByRole("textbox", { name: "Rows per batch" }) as HTMLInputElement;
  fireEvent.change(batch, { target: { value: "5000" } });
  fireEvent.keyDown(batch, { key: "Enter", ctrlKey: true });
  await screen.findByRole("region", { name: "Columns of stores" });
  expect((lastReq() as unknown as { batchRows: number }).batchRows).toBe(5000);
});

test("Ctrl+Enter inside Show sample does not start the run", async () => {
  runRoutes();
  renderTab();
  await toReview();
  await userEvent.click(screen.getByRole("button", { name: "Show sample" }));
  const sample = await screen.findByRole("dialog", { name: "Sample INSERT for sales" });
  await waitFor(() => expect(sample.textContent).toContain("VALUES (1), (2), (3), (4);"));
  fireEvent.keyDown(within(sample).getAllByRole("button", { name: "Close" })[0]!, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(sample, { key: "Enter", ctrlKey: true });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(callsTo("start_transfer")).toHaveLength(0);
  expect(screen.getByRole("region", { name: "Structure SQL" })).toBeTruthy();
});

test("the run passes the whole run's rows to the overall line", async () => {
  const sent = runRoutes();
  renderTab();
  await toReview();
  await userEvent.click(screen.getByRole("button", { name: /^Run/ }));
  await waitFor(() => expect(sent).toHaveLength(1));
  act(() =>
    sent[0]!.onmessage({
      kind: "progress",
      phase: "writing",
      table: "sales",
      rowsDone: 700,
      rowsTotal: 3000,
      bytesDone: 0,
      bytesTotal: null,
      statementsDone: 0,
      fileRow: null,
      tableRows: 700,
      tableTotal: 1500,
    }),
  );
  expect(await screen.findByText("700 of 3,000 rows")).toBeTruthy();
});

// ---- What the tab tells the Ask (spec 4.7) ----

test("transferTabAsk asks on the source until a target is chosen, then on the target with the source beside it", () => {
  const source = { connectionId: "c1", database: "pos", schema: null };
  const before = transferTabAsk({ ...emptyTransfer(source), tables: [{ name: "sales", view: false, rows: 1500, bytes: null, needs: [], ticked: true, ifExists: "stop" }] }, null);
  expect(before.where).toEqual({ connectionId: "c1", database: "pos", schema: null });
  expect(before.also).toEqual([]);
  // No plan and no target yet: no mode is claimed and the target is empty, which the Core words as not chosen.
  expect(before.tab).toMatchObject({ kind: "transfer", targetDatabase: "", mode: null });
  const target = { connectionId: "c2", database: "analytics", schema: "pos" };
  const after = transferTabAsk(
    {
      ...emptyTransfer(source),
      target,
      tables: [
        { name: "sales", view: false, rows: 1500, bytes: null, needs: [], ticked: true, ifExists: "append" },
        { name: "daily_totals", view: true, rows: null, bytes: null, needs: [], ticked: true, ifExists: "stop" },
        { name: "staff", view: false, rows: 10, bytes: null, needs: [], ticked: false, ifExists: "stop" },
      ],
    },
    PLAN,
  );
  expect(after.where).toEqual({ connectionId: "c2", database: "analytics", schema: "pos" });
  expect(after.also).toEqual(["c1"]);
  expect(after.tab).toMatchObject({ kind: "transfer", sourceDatabase: "pos", targetDatabase: "analytics", mode: "oneTransaction" });
  const t = after.tab.kind === "transfer" ? after.tab : null;
  // Ticked tables only, never views.
  expect(t!.tables.map((x) => x.source)).toEqual(["sales"]);
  expect(t!.tables[0]).toMatchObject({ target: "sales", exists: false, ifExists: "append", emptiedRows: null });
  expect(t!.tables[0]!.columns).toHaveLength(3);
  // Notes as typed kinds: their text names values.
  expect(t!.notes).toEqual([
    { table: "sales", column: "is_refund", kind: "needsChoice" },
    { table: "sales", column: "drop_point", kind: "noMatch" },
  ]);
  expect(JSON.stringify(after)).not.toContain("POINT(");
});

test("transferStep is on the target, names the source database then the tables, and the source's Connection beside it", () => {
  const source = { connectionId: "c1", database: "pos", schema: null };
  const target = { connectionId: "c2", database: "analytics", schema: "pos" };
  const tables = [
    { name: "sales", view: false, rows: 1500, bytes: null, needs: [], ticked: true, ifExists: "append" as const },
    { name: "staff", view: false, rows: 10, bytes: null, needs: [], ticked: false, ifExists: "stop" as const },
  ];
  expect(transferStep({ ...emptyTransfer(source), target, tables }, null, 12_000, false)).toEqual({
    verb: "transferRan",
    tab: "transfer",
    title: null,
    connectionId: "c2",
    database: "analytics",
    schema: "pos",
    names: ["pos", "sales"],
    count: 12_000,
    sourceConnectionId: "c1",
  });
  const same = transferStep({ ...emptyTransfer(source), target: { ...target, connectionId: "c1" }, tables }, null, null, true);
  expect(same).toMatchObject({ failed: true, count: null });
  expect(same.sourceConnectionId).toBeUndefined();
});

test("a finished run is a Recent step on the target with the source beside it", async () => {
  clearAllSteps();
  const sent = runRoutes();
  renderTab();
  await toReview();
  await userEvent.click(screen.getByRole("button", { name: /^Run/ }));
  await waitFor(() => expect(sent).toHaveLength(1));
  act(() =>
    sent[0]!.onmessage({
      kind: "finished",
      report: { kind: "transfer", rowsRead: 1500, rowsWritten: 1500, statements: 1, elapsedMs: 9_000, committed: 1500 } as never,
    }),
  );
  await waitFor(() =>
    expect(stepsOf("ungrouped")).toMatchObject([
      { verb: "transferRan", tab: "transfer", connectionId: "pg", database: "analytics", names: ["pos_live", "sales"], count: 1500, sourceConnectionId: "my" },
    ]),
  );
  clearAllSteps();
});
