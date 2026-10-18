import { invoke } from "@tauri-apps/api/core";
import { expect, test, vi } from "vitest";
import { connectionTarget, errorText, listSavedQueries, runVisualQuery, shortenPath, visualQuerySql } from "./client";
import type { ColumnTypes, SqlFk, VisualQuery, VqPreview, VqRun } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
  expect(errorText({ kind: "ai", message: { kind: "notAvailable", provider: "groq" } })).toBe(
    "Answers from Groq arrive in a later Contura version. Nothing was sent.",
  );
  expect(errorText({ kind: "ai", message: { kind: "rateLimited", retryAfterSecs: 7 } })).toContain("7s");
  expect(errorText({ kind: "ai", message: { kind: "network", host: "api.groq.com" } })).toContain("api.groq.com");
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
