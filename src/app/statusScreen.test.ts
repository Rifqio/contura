import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "../api/types";
import type { WindowTab, WorkTab } from "../shell/tabs";
import { type StatusInput, statusScreenFor } from "./statusScreen";

const conn = (id: string): ConnectionConfig => ({
  id,
  name: id,
  dialect: "postgres",
  host: "h",
  port: 1,
  user: "u",
  database: null,
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
});

const a = conn("a");
const b = conn("b");
const c = conn("c");

const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  activeWindow: undefined,
  current: undefined,
  treeBranch: null,
  activeId: null,
  connections: [a, b, c],
  openIds: new Set(),
  versions: new Map(),
  dataFolder: "D:\\data",
  version: "1.2.3",
  ...over,
});

const queryTab = (connectionId: string | null): WorkTab => ({
  kind: "query",
  doc: { id: "q1", name: "Q", text: "", connectionId, database: null, savedId: null, savedText: null },
});
const tableTab = (connectionId: string): WorkTab => ({
  kind: "object",
  key: "k",
  selection: { connectionId, kind: "table", path: ["t"] } as never,
});
const schemaWindow = (path: string | null): WindowTab => ({
  kind: "schema",
  id: "m1",
  doc: { path, dbml: "", savedDbml: "", layout: {} as never, dialect: "postgres", source: "blank", connectionId: null },
});

describe("statusScreenFor", () => {
  it("home_counts_connections_and_open_ones", () => {
    const s = statusScreenFor(input({ activeWindow: { kind: "home" }, openIds: new Set(["a", "c"]) }));
    expect(s).toEqual({ kind: "home", connections: 3, open: 2 });
  });

  it("settings_shows_the_data_folder_and_version", () => {
    const s = statusScreenFor(input({ activeWindow: { kind: "settings", section: "about" } }));
    expect(s).toEqual({ kind: "settings", dataFolder: "D:\\data", version: "1.2.3" });
  });

  it("schema_shows_the_file_name_or_untitled", () => {
    expect(statusScreenFor(input({ activeWindow: schemaWindow("C:\\m\\shop.dbml") }))).toEqual({
      kind: "schema",
      fileName: "shop.dbml",
      appliedTo: null,
    });
    expect(statusScreenFor(input({ activeWindow: schemaWindow(null) }))).toEqual({
      kind: "schema",
      fileName: "Untitled.dbml",
      appliedTo: null,
    });
  });

  it("a_diagram_shows_its_file_name", () => {
    expect(statusScreenFor(input({ activeWindow: { kind: "flow", name: "checkout" } }))).toEqual({ kind: "flow", name: "checkout", fileName: "checkout.flow" });
  });

  it("workspace_follows_the_tree_branch_while_the_tree_has_focus", () => {
    const s = statusScreenFor(input({ treeBranch: "b", current: queryTab("a"), activeId: "c" }));
    expect(s).toMatchObject({ kind: "workspace", connection: b });
  });

  it("workspace_follows_the_query_tab_then_the_table_tab_then_the_active_connection", () => {
    expect(statusScreenFor(input({ current: queryTab("a"), activeId: "c" }))).toMatchObject({ connection: a });
    expect(statusScreenFor(input({ current: tableTab("b"), activeId: "c" }))).toMatchObject({ connection: b });
    expect(statusScreenFor(input({ activeId: "c" }))).toMatchObject({ connection: c });
    expect(statusScreenFor(input())).toMatchObject({ connection: null, open: false, serverVersion: null });
  });

  it("workspace_open_and_server_version_come_from_the_maps", () => {
    const s = statusScreenFor(
      input({ activeId: "a", openIds: new Set(["a"]), versions: new Map([["a", "16.1"]]) }),
    );
    expect(s).toEqual({ kind: "workspace", connection: a, open: true, serverVersion: "16.1" });
    const closed = statusScreenFor(input({ activeId: "b", versions: new Map([["a", "16.1"]]) }));
    expect(closed).toEqual({ kind: "workspace", connection: b, open: false, serverVersion: null });
  });

  it("home_has_no_status_connection_even_with_a_tree_branch", () => {
    const s = statusScreenFor(input({ activeWindow: { kind: "home" }, treeBranch: "a", activeId: "a" }));
    expect(s.kind).toBe("home");
    expect(s).not.toHaveProperty("connection");
  });
});
