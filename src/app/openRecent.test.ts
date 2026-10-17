import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorText } from "../api/client";
import type { ConnectionConfig, RecentItem, SavedQuery } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import { openRecentItem, type RecentEnv } from "./openRecent";
import { placeOf } from "./places";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const conn = (id: string, groupId: string | null = null): ConnectionConfig => ({
  id,
  name: id,
  dialect: "postgres",
  host: "h",
  port: 1,
  user: "u",
  database: null,
  ssl: { mode: "disable" },
  file: null,
  groupId,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
});

const saved: SavedQuery = { id: "q1", name: "Daily", sql: "select 1", updatedAtMs: 1, connectionId: "a" };

function fakeEnv(over: Partial<RecentEnv> = {}): RecentEnv {
  return {
    connections: [conn("a", "g1")],
    savedQueries: [saved],
    openConnectionAt: vi.fn(async () => "open" as const),
    enterPlace: vi.fn(async () => true),
    whenDraftsLoaded: vi.fn(),
    openSaved: vi.fn(),
    openObject: vi.fn(),
    openBuilder: vi.fn(),
    askDialect: vi.fn(),
    notice: vi.fn(),
    ...over,
  };
}

const modelItem = (connectionId: string | null = "a"): RecentItem => ({
  target: { kind: "schemaModel", file: "C:\\m\\shop.dbml" },
  connectionId,
  openedAtMs: 1,
});
const queryItem = (connectionId: string | null): RecentItem => ({
  target: { kind: "query", savedId: "q1", name: "Daily" },
  connectionId,
  openedAtMs: 1,
});
const tableItem = (connectionId: string | null): RecentItem => ({
  target: { kind: "table", path: { database: "d", schema: null, name: "t" }, object: "table" },
  connectionId,
  openedAtMs: 1,
});

const withDialect = "// Dialect: PostgreSQL\nTable t {}";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("openRecentItem", () => {
  it("a_missing_model_file_says_so_and_stays", async () => {
    routeInvoke({
      read_model_files: () => {
        throw { kind: "file", message: "The system cannot find the file (os error 2)" };
      },
    });
    const env = fakeEnv();
    await openRecentItem(modelItem(), env);
    expect(env.notice).toHaveBeenCalledWith("shop.dbml is no longer there.");
    expect(env.openConnectionAt).not.toHaveBeenCalled();
    expect(env.openBuilder).not.toHaveBeenCalled();
  });

  it("another_file_error_shows_its_text", async () => {
    routeInvoke({
      read_model_files: () => {
        throw { kind: "file", message: "Access is denied (os error 5)" };
      },
    });
    const env = fakeEnv();
    await openRecentItem(modelItem(), env);
    expect(env.notice).toHaveBeenCalledWith(
      errorText({ kind: "file", message: "Access is denied (os error 5)" }),
    );
    expect(env.notice).not.toHaveBeenCalledWith("shop.dbml is no longer there.");
  });

  it("a_model_without_a_dialect_asks_for_one", async () => {
    routeInvoke({ read_model_files: () => ({ dbml: "Table t {}", layout: null }) });
    const env = fakeEnv();
    await openRecentItem(modelItem(null), env);
    expect(env.askDialect).toHaveBeenCalledWith({ path: "C:\\m\\shop.dbml", dbml: "Table t {}", layout: null });
    expect(env.openBuilder).not.toHaveBeenCalled();
    expect(callsTo("read_model_files")).toHaveLength(1);
  });

  it("a_model_opens_even_when_its_connection_fails", async () => {
    routeInvoke({ read_model_files: () => ({ dbml: withDialect, layout: null }) });
    const failed = fakeEnv({ openConnectionAt: vi.fn(async () => "failed" as const) });
    await openRecentItem(modelItem(), failed);
    expect(failed.openBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ path: "C:\\m\\shop.dbml", dialect: "postgres", source: "file", connectionId: "a" }),
    );
    const stayed = fakeEnv({ openConnectionAt: vi.fn(async () => "stayed" as const) });
    await openRecentItem(modelItem(), stayed);
    expect(stayed.openBuilder).not.toHaveBeenCalled();
  });

  it("a_saved_query_no_longer_saved_says_so", async () => {
    const env = fakeEnv({ savedQueries: [] });
    await openRecentItem(queryItem("a"), env);
    expect(env.notice).toHaveBeenCalledWith("Daily is no longer a Saved Query.");
    expect(env.openConnectionAt).not.toHaveBeenCalled();
  });

  it("a_saved_query_opens_after_the_drafts_of_its_connections_place", async () => {
    const env = fakeEnv();
    await openRecentItem(queryItem("a"), env);
    expect(env.openConnectionAt).toHaveBeenCalledWith("a");
    expect(env.whenDraftsLoaded).toHaveBeenCalledWith(placeOf(conn("a", "g1")), expect.any(Function));
    expect(env.openSaved).not.toHaveBeenCalled();
    vi.mocked(env.whenDraftsLoaded).mock.calls[0][1]();
    expect(env.openSaved).toHaveBeenCalledWith(saved, "a");
  });

  it("a_saved_query_without_a_connection_enters_ungrouped_without_remembering_it", async () => {
    const env = fakeEnv();
    await openRecentItem(queryItem(null), env);
    expect(env.enterPlace).toHaveBeenCalledWith({ kind: "ungrouped" }, false);
    expect(env.whenDraftsLoaded).toHaveBeenCalledWith({ kind: "ungrouped" }, expect.any(Function));
    vi.mocked(env.whenDraftsLoaded).mock.calls[0][1]();
    expect(env.openSaved).toHaveBeenCalledWith(saved, null);
  });

  it("a_table_without_its_connection_says_so", async () => {
    const env = fakeEnv();
    await openRecentItem(tableItem("gone"), env);
    expect(env.notice).toHaveBeenCalledWith("The Connection of that table is no longer there.");
    expect(env.openConnectionAt).not.toHaveBeenCalled();
  });

  it("a_table_opens_after_its_connection_and_the_drafts", async () => {
    const env = fakeEnv();
    await openRecentItem(tableItem("a"), env);
    expect(env.whenDraftsLoaded).toHaveBeenCalledWith({ kind: "group", groupId: "g1" }, expect.any(Function));
    expect(env.openObject).not.toHaveBeenCalled();
    vi.mocked(env.whenDraftsLoaded).mock.calls[0][1]();
    expect(env.openObject).toHaveBeenCalledWith({
      connectionId: "a",
      kind: "table",
      path: { database: "d", schema: null, name: "t" },
    });
    const stayed = fakeEnv({ openConnectionAt: vi.fn(async () => "stayed" as const) });
    await openRecentItem(tableItem("a"), stayed);
    expect(stayed.whenDraftsLoaded).not.toHaveBeenCalled();
  });
});
