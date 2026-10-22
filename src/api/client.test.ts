import { invoke } from "@tauri-apps/api/core";
import { expect, test, vi } from "vitest";
import {
  aiAskStream,
  aiCancel,
  aiClearAll,
  aiClearContext,
  aiContextChanged,
  aiContextStatus,
  aiResync,
  aiConfirmKeyHost,
  aiKnownModels,
  aiModels,
  connectionTarget,
  errorText,
  fileName,
  listSavedQueries,
  runVisualQuery,
  setAiModelPrefs,
  setAiSyncMode,
  shortenPath,
  visualQuerySql,
} from "./client";

test("fileName_is_the_last_part_of_either_path_style", () => {
  expect(fileName("C:\\out\\orders.csv")).toBe("orders.csv");
  expect(fileName("/home/r/orders.csv")).toBe("orders.csv");
  expect(fileName("orders.csv")).toBe("orders.csv");
});
import type { AiError, AiEvent, AskRequest, ColumnTypes, SqlFk, VisualQuery, VqPreview, VqRun } from "./types";
import type { BackupRequest, ExportRequest, ImportRequest, JobEvent, RestoreRequest, ScriptRequest, TransferRequest } from "./types";
import { DEFAULT_BACKUP_INCLUDE, DEFAULT_EXPORT_OPTIONS, DEFAULT_IMPORT_OPTIONS } from "./types";
import * as jobs from "./jobs";
import { contextAge, contextText, formatWindow } from "../settings/ai/providers";

const exportReq: ExportRequest = {
  connectionId: "c1",
  source: { kind: "query", database: null, sql: "SELECT 1", columns: [] },
  format: "csv",
  options: DEFAULT_EXPORT_OPTIONS,
  path: "C:\\out\\orders.csv",
  rowsHint: null,
};
const importReq: ImportRequest = {
  connectionId: "c1",
  table: { database: "shop", schema: null, name: "orders" },
  file: "C:\\in\\orders.csv",
  format: "csv",
  options: DEFAULT_IMPORT_OPTIONS,
  mapping: [],
};
const scriptReq: ScriptRequest = { connectionId: "c1", database: "shop", path: "C:\\in\\dump.sql", runAsIs: false };

/** The `events` channel of the last call to `cmd`, which forwards to the `onEvent` given. */
function lastChannel(cmd: string): { onmessage: (e: JobEvent) => void } {
  const call = vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd).slice(-1)[0];
  return (call[1] as { events: { onmessage: (e: JobEvent) => void } }).events;
}

test("jobs_functions_invoke_their_commands_with_the_spec_argument_names", async () => {
  const mock = vi.mocked(invoke);
  mock.mockResolvedValue(undefined);
  const onEvent = vi.fn();
  const sent = (cmd: string) => {
    const call = mock.mock.calls.filter(([c]) => c === cmd).slice(-1)[0];
    const { events, ...rest } = call[1] as Record<string, unknown>;
    return { rest, hasEvents: events !== undefined };
  };

  await jobs.previewExport(exportReq);
  expect(mock).toHaveBeenLastCalledWith("preview_export", { req: exportReq });

  await expect(jobs.startExport("j1", exportReq, true, onEvent)).resolves.toBe("j1");
  expect(sent("start_export")).toEqual({ rest: { job: "j1", req: exportReq, overwrite: true }, hasEvents: true });
  const progress: JobEvent = {
    kind: "progress",
    phase: "writing",
    table: null,
    rowsDone: 1,
    rowsTotal: 2,
    bytesDone: 3,
    bytesTotal: null,
    statementsDone: 0,
    fileRow: null,
  };
  lastChannel("start_export").onmessage(progress);
  expect(onEvent).toHaveBeenCalledWith(progress);

  await jobs.inspectImportFile("C:\\in\\orders.csv", null);
  expect(mock).toHaveBeenLastCalledWith("inspect_import_file", { path: "C:\\in\\orders.csv", format: null });
  await jobs.planImport(importReq);
  expect(mock).toHaveBeenLastCalledWith("plan_import", { req: importReq });

  mock.mockResolvedValueOnce("j2");
  await expect(jobs.checkImportFile(importReq, onEvent)).resolves.toBe("j2");
  expect(sent("check_import_file")).toEqual({ rest: { req: importReq }, hasEvents: true });

  await jobs.confirmImport(importReq);
  expect(mock).toHaveBeenLastCalledWith("confirm_import", { req: importReq });
  await expect(jobs.startImport("j3", importReq, "p1", onEvent)).resolves.toBe("j3");
  expect(sent("start_import")).toEqual({ rest: { job: "j3", req: importReq, pass: "p1" }, hasEvents: true });

  await jobs.planScript(scriptReq);
  expect(mock).toHaveBeenLastCalledWith("plan_script", { req: scriptReq });
  await jobs.scriptStatements("c1", "C:\\in\\dump.sql", 50);
  expect(mock).toHaveBeenLastCalledWith("script_statements", { connectionId: "c1", path: "C:\\in\\dump.sql", from: 50 });
  await jobs.scriptStatements("c1", "C:\\in\\dump.sql", 0, true);
  expect(mock).toHaveBeenLastCalledWith("script_statements", { connectionId: "c1", path: "C:\\in\\dump.sql", from: 0, runAsIs: true });
  await jobs.confirmScript(scriptReq);
  expect(mock).toHaveBeenLastCalledWith("confirm_script", { req: scriptReq });
  await expect(jobs.startScript("j4", scriptReq, null, onEvent)).resolves.toBe("j4");
  expect(sent("start_script")).toEqual({ rest: { job: "j4", req: scriptReq, pass: null }, hasEvents: true });

  const side = { connectionId: "c1", database: "shop", schema: null };
  const transferReq: TransferRequest = {
    source: side,
    target: { ...side, connectionId: "c2" },
    tables: [{ name: "stores", ticked: true, ifExists: "stop" }],
    order: [],
    copy: "both",
    batchRows: 1000,
    overrides: [],
    choices: [],
    names: [],
    compareCounts: true,
    createTargetScope: false,
  };
  await jobs.planTransfer(transferReq);
  expect(mock).toHaveBeenLastCalledWith("plan_transfer", { req: transferReq });
  await jobs.transferSample(transferReq, "stores");
  expect(mock).toHaveBeenLastCalledWith("transfer_sample", { req: transferReq, table: "stores" });
  await jobs.confirmTransfer(transferReq);
  expect(mock).toHaveBeenLastCalledWith("confirm_transfer", { req: transferReq });
  await expect(jobs.startTransfer("j5", transferReq, "ab12", "p2", onEvent)).resolves.toBe("j5");
  expect(sent("start_transfer")).toEqual({
    rest: { job: "j5", req: transferReq, reviewed: "ab12", pass: "p2" },
    hasEvents: true,
  });

  await jobs.cancelJob("j1");
  expect(mock).toHaveBeenLastCalledWith("cancel_job", { job: "j1" });
  await jobs.listJobs();
  expect(mock).toHaveBeenLastCalledWith("list_jobs");
  await expect(jobs.jobEvents("j1", onEvent)).resolves.toBe("j1");
  expect(sent("job_events")).toEqual({ rest: { job: "j1" }, hasEvents: true });
  await jobs.revealInFolder("C:\\out\\orders.csv");
  expect(mock).toHaveBeenLastCalledWith("reveal_in_folder", { path: "C:\\out\\orders.csv" });
  await jobs.readTextFile("C:\\in\\flow.mmd");
  expect(mock).toHaveBeenLastCalledWith("read_text_file", { path: "C:\\in\\flow.mmd" });
  mock.mockReset();
});

test("backup_and_restore_functions_invoke_the_step9_commands", async () => {
  const mock = vi.mocked(invoke);
  mock.mockResolvedValue(undefined);
  const onEvent = vi.fn();
  const sent = (cmd: string) => {
    const call = mock.mock.calls.filter(([c]) => c === cmd).slice(-1)[0];
    const { events, ...rest } = call[1] as Record<string, unknown>;
    return { rest, hasEvents: events !== undefined };
  };
  const backupReq: BackupRequest = {
    connectionId: "c1",
    database: "freight",
    schema: "billing",
    include: DEFAULT_BACKUP_INCLUDE,
    format: "script",
    rowsPerStatement: 500,
    addDropTables: false,
    path: "E:/Backups/freight-2026-10-17.sql",
  };
  await jobs.planBackup(backupReq);
  expect(mock).toHaveBeenLastCalledWith("plan_backup", { req: backupReq });
  await expect(jobs.startBackup("b1", backupReq, false, onEvent)).resolves.toBe("b1");
  expect(sent("start_backup")).toEqual({ rest: { job: "b1", req: backupReq, overwrite: false }, hasEvents: true });

  const target = { connectionId: "c1", database: "freight", schema: null };
  await expect(jobs.inspectRestore("r1", target, "E:/Backups/f.sql", onEvent)).resolves.toBe("r1");
  expect(sent("inspect_restore")).toEqual({ rest: { job: "r1", target, path: "E:/Backups/f.sql" }, hasEvents: true });
  const restoreReq: RestoreRequest = { target, path: "E:/Backups/f.sql", mode: { kind: "newDatabase", name: "freight_restore_1017" }, runAsIs: false };
  await jobs.planRestore(restoreReq);
  expect(mock).toHaveBeenLastCalledWith("plan_restore", { req: restoreReq });
  await jobs.restoreStatements(restoreReq, 50);
  expect(mock).toHaveBeenLastCalledWith("restore_statements", { req: restoreReq, from: 50 });
  await jobs.confirmRestore(restoreReq);
  expect(mock).toHaveBeenLastCalledWith("confirm_restore", { req: restoreReq });
  await expect(jobs.startRestore("r2", restoreReq, "fp1", "p9", onEvent)).resolves.toBe("r2");
  expect(sent("start_restore")).toEqual({ rest: { job: "r2", req: restoreReq, fingerprint: "fp1", pass: "p9" }, hasEvents: true });
  mock.mockReset();

  expect(errorText({ kind: "backupRefused", message: { reason: "Line 2,041: DROP DATABASE is not run by Restore." } })).toBe(
    "Line 2,041: DROP DATABASE is not run by Restore.",
  );
});

test("newJobId_makes_a_fresh_uuid", () => {
  const a = jobs.newJobId();
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(jobs.newJobId()).not.toBe(a);
});

test("error_text_for_job_errors", () => {
  const at = { fileRow: 7, line: null, table: "menu_items", statement: 1 };
  expect(errorText({ kind: "jobFailed", message: { at, message: "Row 7 of the file: n/a is not a number for price." } })).toBe(
    "Row 7 of the file: n/a is not a number for price.",
  );
  expect(errorText({ kind: "fileChanged", message: { file: "menu-oct.csv", confirmed: true } })).toBe(
    "menu-oct.csv changed after you confirmed. Nothing was imported.",
  );
  // Q45 M5: "after you confirmed" only when there was a confirm.
  expect(errorText({ kind: "fileChanged", message: { file: "menu-oct.csv", confirmed: false } })).toBe(
    "menu-oct.csv changed while Contura read it. Nothing was imported.",
  );
  expect(errorText({ kind: "jobBusy", message: { connection: "kestrel-main" } })).toBe(
    "Another import is writing to kestrel-main. Wait for it to end.",
  );
  expect(errorText({ kind: "fileExists", message: "C:\\out\\orders.csv" })).toBe("orders.csv exists.");
  expect(errorText({ kind: "fileExists", message: "/home/r/out/orders.csv" })).toBe("orders.csv exists.");
  expect(errorText({ kind: "readStopped" })).toBe("The read stopped unexpectedly. Nothing more was written.");
  expect(errorText({ kind: "afterCommit", message: { sql: "ANALYZE t", message: "no such table" } })).toBe(
    "The rows were committed, but ANALYZE t failed afterwards: no such table.",
  );
});

test("error_text_for_file_errors_q45", () => {
  // A whole sentence from the Core is shown as it is.
  expect(errorText({ kind: "file", message: "Line 12 is not UTF-8. Save the file as UTF-8." })).toBe(
    "Line 12 is not UTF-8. Save the file as UTF-8.",
  );
  expect(errorText({ kind: "file", message: "Line 3: one row is larger than 16 MB." })).toBe("Line 3: one row is larger than 16 MB.");
  expect(errorText({ kind: "file", message: "Line 2, column 7: expected value." })).toBe("Line 2, column 7: expected value.");
  // A file Contura reads gets read advice.
  expect(errorText({ kind: "file", message: "cannot read C:\\in\\menu.csv: Access is denied. (os error 5)" })).toBe(
    "Cannot read C:\\in\\menu.csv: Access is denied. (os error 5). Check the file exists and Contura can read it.",
  );
  // Writes keep the folder advice.
  expect(errorText({ kind: "file", message: "cannot write E:\\Exports\\menu_items.csv" })).toBe(
    "Cannot write E:\\Exports\\menu_items.csv. Check the folder exists and Contura can write to it.",
  );
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

test("shortenPath_keeps_file_name", () => {
  expect(shortenPath("C:\\data\\shop.db")).toBe("C:\\data\\shop.db");
  const long = "C:\\Users\\rifqi\\Documents\\Projects\\kfc\\exports\\2026\\october\\shop.db";
  expect(shortenPath(long)).toBe("C:\\Users\\rifqi\\Documents\\Projects\\kfc\\…\\shop.db");
  expect(shortenPath(long, 24)).toBe("C:\\Users\\rifqi\\…\\shop.db");
  expect(shortenPath(long).length).toBeLessThanOrEqual(48);
  // The file name is never cut, even when it alone is longer than max.
  const bigName = `C:\\data\\${"x".repeat(60)}.db`;
  expect(shortenPath(bigName)).toBe(`…\\${"x".repeat(60)}.db`);
  // Forward slashes work too.
  expect(shortenPath("/home/rifqi/projects/kfc/exports/2026/october/archive/shop.db", 30)).toBe(
    "/home/rifqi/projects/…/shop.db",
  );
});

test("errorText handles an absent message, a numeric message and an unknown kind", () => {
  expect(errorText({ kind: "noPrimaryKey" })).toBe(
    "This table has no primary key, so Contura cannot pick out one row to open the full value.",
  );
  expect(errorText({ kind: "valueTooLarge", message: 17 * 1024 * 1024 })).toBe(
    "This value is 17 MiB, more than the 16 MiB Contura opens at once.",
  );
  expect(errorText({ kind: "auth", message: "Access denied" })).toContain("Access denied");
  expect(errorText({ kind: "somethingNew", message: "disk full" })).toBe("Error (somethingNew): disk full");
  expect(errorText({ kind: "somethingNew" })).toBe("Error: somethingNew.");
  expect(errorText(new Error("network down"))).toBe("network down");
});

test("errorText names the changed row and the failed statement of a save", () => {
  const single = { statement: 0, key: [{ column: "id", value: { t: "number", value: "42" } }] };
  expect(errorText({ kind: "rowChanged", message: single })).toBe(
    "Row id 42 changed since you loaded it. Revert the row, then Reload to see the current values.",
  );
  const composite = {
    statement: 1,
    key: [
      { column: "id", value: { t: "number", value: "42" } },
      { column: "line", value: { t: "text", value: "3", truncated: false, totalBytes: 1 } },
    ],
  };
  expect(errorText({ kind: "rowChanged", message: composite })).toBe(
    "Row id 42, line 3 changed since you loaded it. Revert the row, then Reload to see the current values.",
  );
  expect(errorText({ kind: "editFailed", message: { statement: 2, message: "Data too long for column 'name'" } })).toBe(
    "Save failed at statement 3: Data too long for column 'name'",
  );
});

test("error_text_for_design_errors", () => {
  expect(
    errorText({ kind: "designFailed", message: { statement: 0, ran: 0, total: 2, message: "Duplicate column name 'note'" } }),
  ).toBe("Nothing was changed. Statement 1 failed: Duplicate column name 'note'");
  expect(
    errorText({ kind: "designFailed", message: { statement: 1, ran: 1, total: 2, message: "Failed to open the referenced table 'nowhere'" } }),
  ).toBe("1 of 2 statements were applied. Statement 2 failed: Failed to open the referenced table 'nowhere'");
  expect(errorText({ kind: "designForeignKeys", message: { table: "orders" } })).toBe(
    "Rows in orders would break a Foreign Key. Nothing was changed.",
  );
  const restore = { sql: "PRAGMA foreign_keys = ON", message: "disk I/O error" };
  expect(errorText({ kind: "designRestoreFailed", message: { applied: true, ...restore } })).toBe(
    "The change was applied, but restoring the connection with PRAGMA foreign_keys = ON failed afterwards: disk I/O error. Reconnect before you go on.",
  );
  expect(errorText({ kind: "designRestoreFailed", message: { applied: false, ...restore } })).toBe(
    "The change was not applied, and restoring the connection with PRAGMA foreign_keys = ON failed afterwards: disk I/O error. Reconnect before you go on.",
  );
  // A plain query error that happens to start with the same words keeps its prefix.
  expect(errorText({ kind: "query", message: "The change was applied" })).toBe(
    "The query failed: The change was applied",
  );
});

test("connectionTarget_by_dialect", () => {
  expect(connectionTarget({ dialect: "mysql", host: "127.0.0.1", port: 3306, file: null })).toBe("127.0.0.1:3306");
  expect(connectionTarget({ dialect: "postgres", host: "10.0.4.20", port: 5432, file: null })).toBe("10.0.4.20:5432");
  expect(connectionTarget({ dialect: "sqlite", host: "", port: 0, file: "C:\\data\\shop.db" })).toBe(
    "C:\\data\\shop.db",
  );
});

test("sqlite_connect_error_hint_mentions_the_file", () => {
  expect(
    errorText({ kind: "connect", message: "cannot open C:\\data\\x.db: the file does not exist" }, "sqlite"),
  ).toBe("Cannot open C:\\data\\x.db: the file does not exist. Check the path, or choose the file again.");
  expect(errorText({ kind: "connect", message: "C:\\data\\notes.txt is not a SQLite database" }, "sqlite")).toBe(
    "C:\\data\\notes.txt is not a SQLite database.",
  );
  expect(errorText({ kind: "connect", message: "cannot open C:\\data\\x.db: access is denied" }, "sqlite")).toBe(
    "Cannot open C:\\data\\x.db: access is denied. Check that Contura can read the file.",
  );
  // Server Dialects keep the step 1 copy.
  const server = errorText({ kind: "connect", message: "connection refused" }, "postgres");
  expect(server).toBe(
    "Could not connect: connection refused. Check the host and port, and that the database server is running.",
  );
  expect(errorText({ kind: "connect", message: "connection refused" })).toBe(server);
});

test("postgres_auth_hint_mentions_access_rules", () => {
  const message = "the server requires a password, and none is saved for this Connection";
  expect(errorText({ kind: "auth", message }, "postgres")).toBe(
    `Sign-in failed: ${message}. Check the user name and password, or the server's access rules for this database.`,
  );
  expect(errorText({ kind: "auth", message: "Access denied" }, "mysql")).toBe(
    "Sign-in failed: Access denied. Check the user name and password.",
  );
});

test("error_text_for_query_sessions", () => {
  expect(errorText({ kind: "cancelled" })).toBe("The query was cancelled.");
  expect(errorText({ kind: "timedOut", message: 30 })).toBe("Stopped after 30s, the Connection's timeout.");
  expect(errorText({ kind: "invalidInput", message: "Give the query a name." })).toBe("Give the query a name.");
  expect(errorText({ kind: "invalidInput", message: "name must not be empty" })).toBe("Name must not be empty.");
  expect(errorText({ kind: "notFound", message: "That query session is closed." })).toBe(
    "This tab lost its session. Run the query again.",
  );
});

test("error_text_for_safety_errors", () => {
  expect(errorText({ kind: "readOnly", message: 2 })).toBe("Read-only Connection: this statement writes");
  expect(errorText({ kind: "needsConfirmation" })).toBe("Confirm this write on a Production Connection");
  expect(errorText({ kind: "readOnlyRefused" })).toBe("The server refused a write: this Connection is Read-only");
});

test("error_text_for_ai_errors", () => {
  expect(errorText({ kind: "ai", message: { kind: "notConfigured" } })).toBe("No AI provider is set up. Connect one in Settings.");
  expect(errorText({ kind: "ai", message: { kind: "rateLimited", retryAfterSecs: 7 } })).toContain("7s");
  expect(errorText({ kind: "ai", message: { kind: "network", host: "api.groq.com" } })).toContain("api.groq.com");
});

test("error_text_for_real_provider_errors", () => {
  const ai = (message: AiError) => errorText({ kind: "ai", message });
  expect(ai({ kind: "rateLimited", retryAfterSecs: 20 })).toBe("The provider is limiting requests. Try again in 20s.");
  expect(ai({ kind: "contextFull", used: 192_000, window: 200_000, model: "claude-haiku-4-5" })).toBe(
    "This thread fills 96% of claude-haiku-4-5's 200K window.",
  );
  expect(ai({ kind: "tooBig", needed: 1_300_000, window: 200_000, model: "claude-haiku-4-5" })).toBe(
    "This question needs 1.3M tokens. claude-haiku-4-5 holds 200K.",
  );
  expect(ai({ kind: "tooBig", needed: 1_000_000, window: 128_000, model: "gpt-4o" })).toBe(
    "This question needs 1M tokens. gpt-4o holds 128K.",
  );
  expect(ai({ kind: "tooBig", needed: 999_960, window: 950, model: "tiny" })).toBe("This question needs 1M tokens. tiny holds 950.");
  expect(ai({ kind: "tls", host: "api.groq.com" })).toBe(
    "Could not check the certificate of api.groq.com. A proxy or antivirus may be inspecting https.",
  );
  expect(ai({ kind: "insecureUrl", host: "10.0.0.5" })).toBe(
    "Use https for 10.0.0.5. Plain http is allowed only on this PC or a private network.",
  );
  expect(ai({ kind: "insecureUrl", host: "" })).toBe("The base URL is not a valid address.");
  expect(ai({ kind: "keyHostChanged", host: "api.example.com" })).toBe(
    "The base URL now points to api.example.com. Save the key again to send it there.",
  );
  expect(ai({ kind: "timeout", phase: "firstByte" })).toBe("The provider did not answer in time.");
  expect(ai({ kind: "provider", status: 404, message: "model not found" })).toBe(
    "The provider returned an error (404): model not found.",
  );
  const long = ai({ kind: "provider", status: 500, message: "x".repeat(300) });
  expect(long.startsWith("The provider returned an error (500): ")).toBe(true);
  expect(long.length - "The provider returned an error (500): ".length).toBeLessThanOrEqual(200);
  expect(ai({ kind: "badResponse" })).toBe("The provider's answer could not be read.");
  expect(ai({ kind: "tooLarge" })).toBe("This Ask is over the size this model accepts, even after trimming.");
  const builtAt = new Date(2026, 9, 19, 9, 5).getTime();
  expect(ai({ kind: "contextUnavailable", builtAt })).toBe("Could not check the schema. Using the context from 09:05.");
  expect(ai({ kind: "overloaded", provider: "groq" })).toBe("Groq is busy right now.");
  expect(ai({ kind: "urlHasCredentials", host: "x.example" })).toBe(
    "Remove the user name and password from the base URL. Save the key in the key field instead.",
  );
  expect(ai({ kind: "offline" })).toBe("No internet connection.");
  expect(ai({ kind: "outOfCredit", provider: "anthropic" })).toBe("Your Anthropic Claude account is out of credit.");
  expect(ai({ kind: "modelRetired", model: "claude-sonnet-4-5" })).toBe("claude-sonnet-4-5 is no longer offered.");
  expect(ai({ kind: "cancelled" })).toBe("Stopped.");
  expect(ai({ kind: "busy" })).toBe("An answer is still being written. Stop it first.");
  expect(ai({ kind: "internal" })).toBe("Something went wrong before the question was sent.");
});

test("ai_ask_stream_sends_the_request_and_forwards_events", async () => {
  const mock = vi.mocked(invoke);
  mock.mockResolvedValue(undefined);
  const onEvent = vi.fn();
  const request = { requestId: "r1" } as AskRequest;
  await aiAskStream(request, onEvent);
  const call = mock.mock.calls.filter(([c]) => c === "ai_ask_stream").slice(-1)[0];
  const { events, ...rest } = call[1] as { events: { onmessage: (e: AiEvent) => void } };
  expect(rest).toEqual({ request });
  events.onmessage({ type: "delta", text: "hi" });
  expect(onEvent).toHaveBeenCalledWith({ type: "delta", text: "hi" });

  mock.mockResolvedValue(true);
  await expect(aiCancel("r1")).resolves.toBe(true);
  expect(mock).toHaveBeenLastCalledWith("ai_cancel", { requestId: "r1" });
});

test("visualQuerySql invokes visual_query_sql with id, query and types", async () => {
  const query: VisualQuery = {
    version: 1,
    database: "app",
    dialect: "postgres",
    tables: [{ id: "t1", schema: "sales", name: "orders", alias: "o", x: 0, y: 0 }],
    joins: [],
    columns: [{ table: "t1", column: "id", alias: null, aggregate: "count" }],
    filters: [{ joiner: "and", table: "t1", column: "status", op: "eq", values: ["late"] }],
    groupBy: { kind: "auto" },
    orderBy: [{ target: { kind: "output", index: 0 }, dir: "desc" }],
    limit: 50,
    distinct: false,
  };
  const types: ColumnTypes = { t1: { id: "integer", status: "text" } };
  const preview: VqPreview = {
    query: {
      sql: "SELECT count(o.id) AS count_id\nFROM sales.orders AS o",
      parts: [{ part: { kind: "select" }, fromLine: 1, toLine: 1 }],
      outputs: ["count_id"],
      warnings: [{ kind: "crossJoin", table: "t2", rows: null }],
    },
    problems: [],
  };
  vi.mocked(invoke).mockResolvedValueOnce(preview);
  await expect(visualQuerySql("c1", query, types)).resolves.toEqual(preview);
  expect(invoke).toHaveBeenCalledWith("visual_query_sql", { id: "c1", query, types });
});

test("runVisualQuery invokes run_visual_query with session, query, types and pass", async () => {
  const query: VisualQuery = {
    version: 1,
    database: "app",
    tables: [{ id: "t1", schema: null, name: "orders", alias: "o", x: 0, y: 0 }],
    joins: [],
    columns: [{ table: "t1", column: "id", alias: null, aggregate: null }],
    filters: [],
    groupBy: { kind: "auto" },
    orderBy: [],
    limit: null,
    distinct: false,
  };
  const types: ColumnTypes = {};
  const run: VqRun = {
    sql: "SELECT o.id\nFROM orders AS o",
    execution: { outcome: { t: "rows", columns: [], rows: [], hasMore: false }, elapsedMs: 3 },
  };
  vi.mocked(invoke).mockResolvedValueOnce(run);
  await expect(runVisualQuery("s1", query, types, null)).resolves.toEqual(run);
  expect(invoke).toHaveBeenLastCalledWith("run_visual_query", { session: "s1", query, types, pass: null });
  vi.mocked(invoke).mockResolvedValueOnce(run);
  await runVisualQuery("s1", query, types, "p1");
  expect(invoke).toHaveBeenLastCalledWith("run_visual_query", { session: "s1", query, types, pass: "p1" });
});

test("SqlFk carries its constraint name and comment", () => {
  const fk: SqlFk = {
    from: { schema: "public", table: "orders", columns: ["store_id"] },
    to: { schema: "public", table: "stores", columns: ["id"] },
    name: "orders_store_id_fkey",
    comment: "Where the order was placed",
  };
  expect(fk.name).toBe("orders_store_id_fkey");
});

test("a_saved_query_without_kind_from_an_older_core_reads_as_sql", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([
    { id: "q1", name: "late orders", sql: "SELECT 1", updatedAtMs: 1, connectionId: null },
    { id: "q2", name: "by store", sql: "SELECT 2", updatedAtMs: 2, connectionId: "c1", kind: "visual", visualJson: '{"version":1}' },
  ]);
  const list = await listSavedQueries();
  expect(list[0]).toEqual({ id: "q1", name: "late orders", sql: "SELECT 1", updatedAtMs: 1, connectionId: null, kind: "sql", visualJson: null });
  expect(list[1]).toMatchObject({ kind: "visual", visualJson: '{"version":1}' });
});

test("format_window_reads_like_the_model_facts", () => {
  expect(formatWindow(1_000_000)).toBe("1M");
  expect(formatWindow(1_047_576)).toBe("1M");
  expect(formatWindow(200_000)).toBe("200K");
  expect(formatWindow(131_072)).toBe("131K");
  expect(formatWindow(1_500_000)).toBe("1.5M");
  expect(formatWindow(8_000)).toBe("8K");
  expect(formatWindow(8_192)).toBe("8K");
});

test("model_list_commands_carry_the_group", async () => {
  const list = { models: [], current: "m", fetchedAt: null };
  vi.mocked(invoke).mockResolvedValue(list);
  expect(await aiModels("g1")).toEqual(list);
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("ai_models", { groupId: "g1" });
  expect(await aiKnownModels(null)).toEqual(list);
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("ai_known_models", { groupId: null });
  vi.mocked(invoke).mockResolvedValue(undefined);
  await setAiModelPrefs("g1", "openai/gpt-oss-20b", { thinking: "high", caching: false });
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("set_ai_model_prefs", {
    groupId: "g1",
    model: "openai/gpt-oss-20b",
    picks: { thinking: "high", caching: false },
  });
  await aiConfirmKeyHost("g1", "api.example.com");
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("ai_confirm_key_host", { groupId: "g1", host: "api.example.com" });
});

test("contextAge_latest_and_stale", () => {
  const row = (builtAt: number, stale: boolean, tableCount: number) => ({
    connectionId: "c1",
    database: "shop",
    schema: "",
    builtAt,
    checkedAt: builtAt,
    stale,
    tableCount,
    bytes: 2048,
  });
  const now = 10_000_000_000;
  expect(contextAge([], now)).toEqual({ builtAt: null, stale: false, tables: 0 });
  expect(contextAge([row(now - 180_000, false, 6), row(now - 600_000, true, 4)], now)).toEqual({
    builtAt: now - 180_000,
    stale: true,
    tables: 10,
  });
  expect(contextText({ builtAt: null, stale: false, tables: 0 }, now)).toBe("Not built");
  expect(contextText({ builtAt: now - 30_000, stale: false, tables: 6 }, now)).toBe("Synced just now");
  expect(contextText({ builtAt: now - 180_000, stale: false, tables: 6 }, now)).toBe("Synced 3m ago");
  expect(contextText({ builtAt: now - 2 * 86_400_000, stale: true, tables: 6 }, now)).toBe("Stale, synced 2d ago");
});

test("ai_context_commands_send_their_shapes", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  await setAiSyncMode("c1", "manual");
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("set_ai_sync_mode", { connectionId: "c1", mode: "manual" });
  await aiContextChanged("c1");
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("ai_context_changed", { connectionId: "c1" });
  await aiClearContext(null);
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("ai_clear_context", { connectionId: null });
  await aiClearAll();
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("ai_clear_all", {});
  await aiContextStatus("c1");
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("ai_context_status", { connectionId: "c1" });
  await aiResync("c1", "shop", null);
  expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("ai_resync", { connectionId: "c1", database: "shop", schema: null });
});
