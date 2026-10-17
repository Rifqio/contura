import { expect, test } from "vitest";
import { connectionTarget, errorText, shortenPath } from "./client";

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
  expect(errorText({ kind: "timedOut", message: 30 })).toBe("Stopped after 30 s, the Connection's timeout.");
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
  expect(errorText({ kind: "ai", message: { kind: "rateLimited", retryAfterSecs: 7 } })).toContain("7 s");
  expect(errorText({ kind: "ai", message: { kind: "network", host: "api.groq.com" } })).toContain("api.groq.com");
});
