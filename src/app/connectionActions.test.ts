import { beforeEach, describe, expect, it, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import type { ConnectionConfig } from "../api/types";
import { connectionMenu } from "../sidebar/connectionMenu";
import { type ConnectionActionsEnv, connectionActions } from "./connectionActions";
import { clearAllSteps, recordStep, stepsOf } from "../assistant/recentSteps";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function fakeEnv(over: Partial<ConnectionActionsEnv> = {}): ConnectionActionsEnv {
  return {
    openIds: new Set(),
    confirmLeave: vi.fn(async () => true),
    tableKeys: vi.fn(() => ["t1"]),
    openTracked: vi.fn(async () => {}),
    markClosed: vi.fn(),
    reload: vi.fn(async () => {}),
    setActiveId: vi.fn(),
    newQuery: vi.fn(),
    setNotice: vi.fn(),
    historyCleared: vi.fn(),
    toast: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  routeInvoke({
    close_connection: () => undefined,
    move_connection: () => undefined,
    delete_connection: () => undefined,
    clear_query_history: () => undefined,
  });
});

describe("connectionActions", () => {
  it("close_asks_first_and_cancel_keeps_the_connection_open", async () => {
    const env = fakeEnv({ confirmLeave: vi.fn(async () => false) });
    await connectionActions(env).closeFromTree("a");
    expect(env.tableKeys).toHaveBeenCalledWith("a");
    expect(env.confirmLeave).toHaveBeenCalledWith(["t1"]);
    expect(callsTo("close_connection")).toHaveLength(0);
    expect(env.markClosed).not.toHaveBeenCalled();

    const ok = fakeEnv();
    await connectionActions(ok).closeFromTree("a");
    expect(callsTo("close_connection")).toHaveLength(1);
    expect(ok.markClosed).toHaveBeenCalledWith("a");
  });

  it("close_and_delete_ask_about_running_jobs_and_keep_running_keeps_the_connection", async () => {
    const env = fakeEnv({ confirmJobs: vi.fn(async () => false) });
    await connectionActions(env).closeFromTree("a");
    await connectionActions(env).deleteFromTree("a");
    expect(env.confirmJobs).toHaveBeenCalledWith("a");
    expect(callsTo("close_connection")).toHaveLength(0);
    expect(callsTo("delete_connection")).toHaveLength(0);

    const ok = fakeEnv({ confirmJobs: vi.fn(async () => true) });
    await connectionActions(ok).closeFromTree("a");
    expect(callsTo("close_connection")).toHaveLength(1);
  });

  it("a_move_asks_about_running_import_tabs_and_no_keeps_it_q43", async () => {
    const confirmImports = vi.fn(async () => false);
    // The imports ask runs as the Pending Edits ask's `then`, so a Discard waits for it.
    const confirmLeave = vi.fn(async (_keys: string[], opts?: { then?(): Promise<boolean> }) => (opts?.then ? opts.then() : true));
    const env = fakeEnv({ confirmImports, confirmLeave });
    await connectionActions(env).moveFromTree("a", "g2");
    expect(confirmLeave).toHaveBeenCalledWith(["t1"], { then: expect.any(Function) });
    expect(confirmImports).toHaveBeenCalledWith("a");
    expect(callsTo("move_connection")).toHaveLength(0);
  });

  it("close_failure_sets_the_notice", async () => {
    routeInvoke({
      close_connection: () => {
        throw "boom";
      },
    });
    const env = fakeEnv();
    await connectionActions(env).closeFromTree("a");
    expect(env.markClosed).not.toHaveBeenCalled();
    expect(env.setNotice).toHaveBeenCalledWith("boom");
  });

  it("move_asks_then_moves_and_reloads", async () => {
    const env = fakeEnv();
    await connectionActions(env).moveFromTree("a", "g1");
    expect(env.confirmLeave).toHaveBeenCalledWith(["t1"]);
    expect(callsTo("move_connection")).toHaveLength(1);
    expect(env.reload).toHaveBeenCalled();

    const no = fakeEnv({ confirmLeave: vi.fn(async () => false) });
    await connectionActions(no).moveFromTree("a", null);
    expect(callsTo("move_connection")).toHaveLength(1);
    expect(no.reload).not.toHaveBeenCalled();
  });

  it("delete_asks_then_deletes_marks_closed_and_reloads", async () => {
    const env = fakeEnv();
    await connectionActions(env).deleteFromTree("a");
    expect(env.confirmLeave).toHaveBeenCalledWith(["t1"]);
    expect(callsTo("delete_connection")).toHaveLength(1);
    expect(env.markClosed).toHaveBeenCalledWith("a");
    expect(env.reload).toHaveBeenCalled();

    const no = fakeEnv({ confirmLeave: vi.fn(async () => false) });
    await connectionActions(no).deleteFromTree("a");
    expect(callsTo("delete_connection")).toHaveLength(1);
    expect(no.markClosed).not.toHaveBeenCalled();
  });

  it("clear_history_and_delete_drop_the_connections_recent_steps", async () => {
    clearAllSteps();
    const step = (connectionId: string) => ({ verb: "runQuery" as const, tab: "query", title: null, connectionId, database: "shop", schema: null, count: 1 });
    recordStep("ungrouped", step("a"));
    recordStep("ungrouped", step("b"));
    await connectionActions(fakeEnv()).clearHistoryFromTree("b");
    expect(stepsOf("ungrouped").map((s) => s.connectionId)).toEqual(["a"]);
    recordStep("ungrouped", step("b"));
    await connectionActions(fakeEnv()).deleteFromTree("a");
    expect(stepsOf("ungrouped").map((s) => s.connectionId)).toEqual(["b"]);
    // A failed clear keeps them.
    routeInvoke({ clear_query_history: () => { throw new Error("locked"); } });
    await connectionActions(fakeEnv()).clearHistoryFromTree("b");
    expect(stepsOf("ungrouped").map((s) => s.connectionId)).toEqual(["b"]);
    clearAllSteps();
  });

  it("clear_history_tells_the_owner", async () => {
    const env = fakeEnv();
    await connectionActions(env).clearHistoryFromTree("a");
    expect(callsTo("clear_query_history")).toHaveLength(1);
    expect(env.historyCleared).toHaveBeenCalled();
    expect(env.confirmLeave).not.toHaveBeenCalled();
  });

  it("open_from_tree_clears_the_notice_and_swallows_a_failure", async () => {
    const env = fakeEnv({
      openTracked: vi.fn(async () => {
        throw new Error("no route");
      }),
    });
    await expect(connectionActions(env).openFromTree("a")).resolves.toBeUndefined();
    expect(env.setActiveId).toHaveBeenCalledWith("a");
    expect(env.setNotice).toHaveBeenCalledWith(null);
    expect(env.openTracked).toHaveBeenCalledWith("a");
  });

  it("new_query_on_opens_only_a_closed_connection", async () => {
    const closed = fakeEnv();
    await connectionActions(closed).newQueryOn("a");
    expect(closed.setActiveId).toHaveBeenCalledWith("a");
    expect(closed.newQuery).toHaveBeenCalledWith("a");
    expect(closed.openTracked).toHaveBeenCalledWith("a");

    const open = fakeEnv({ openIds: new Set(["a"]) });
    await connectionActions(open).newQueryOn("a");
    expect(open.newQuery).toHaveBeenCalledWith("a");
    expect(open.openTracked).not.toHaveBeenCalled();
  });

  it("resync_item_hidden_at_never", () => {
    const c: ConnectionConfig = {
      id: "a",
      name: "Shop",
      dialect: "mysql",
      host: "127.0.0.1",
      port: 3306,
      user: "root",
      database: "shop",
      ssl: { mode: "disable" },
      file: null,
      groupId: null,
      queryTimeoutSecs: null,
      aiAccess: "schema",
      production: false,
      readOnly: false,
    };
    const noop = () => {};
    const act = { toggleOpen: noop, newQuery: noop, newVisualQuery: noop, newSchemaModel: noop, edit: noop, duplicate: noop, copyHost: noop, refresh: noop, move: noop, newGroup: noop, clearHistory: noop, remove: noop, resync: vi.fn() };
    const keys = (conn: ConnectionConfig) => connectionMenu(conn, { open: true, groups: [] }, act).map((i) => i.key);
    expect(keys(c)).toContain("resync");
    const item = connectionMenu(c, { open: true, groups: [] }, act).find((i) => i.key === "resync")!;
    expect(item.label).toBe("Re-sync AI context");
    // Right after Refresh schema.
    expect(keys(c)[keys(c).indexOf("refresh") + 1]).toBe("resync");
    expect(keys({ ...c, aiAccess: "never" })).not.toContain("resync");
    const { resync: _, ...withoutResync } = act;
    expect(connectionMenu(c, { open: true, groups: [] }, withoutResync).map((i) => i.key)).not.toContain("resync");
  });

  it("resync_from_tree_toasts_the_tables_or_the_error", async () => {
    routeInvoke({
      ai_resync: ({ connectionId }) => {
        if (connectionId === "bad") throw { kind: "invalidInput", message: "AI access is Never for this Connection." };
        if (connectionId === "shut") return { connectionId, database: "shop", schema: "", sync: "automatic", builtAt: null, tableCount: 0, stale: false, check: { kind: "missing" } };
        return { connectionId, database: "shop", schema: "", sync: "automatic", builtAt: 1, tableCount: 1042, stale: false, check: { kind: "rebuilt", reason: "asked" } };
      },
    });
    const env = fakeEnv({ openIds: new Set(["a", "bad"]) });
    await connectionActions(env).resyncFromTree("a");
    expect(callsTo("ai_resync")).toEqual([{ connectionId: "a", database: null, schema: null }]);
    expect(env.toast).toHaveBeenLastCalledWith({ kind: "success", text: "AI context re-synced: 1,042 tables." });
    await connectionActions(env).resyncFromTree("bad");
    expect(env.toast).toHaveBeenLastCalledWith({ kind: "error", text: "AI access is Never for this Connection." });
    await connectionActions(env).resyncFromTree("shut");
    expect(env.toast).toHaveBeenLastCalledWith({ kind: "error", text: "Open the Connection to re-sync." });
  });

  it("resync_from_tree_runs_once_at_a_time_and_says_so", async () => {
    let finish: () => void = () => {};
    routeInvoke({
      ai_resync: ({ connectionId }) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ connectionId, database: "shop", schema: "", sync: "automatic", builtAt: 1, tableCount: 3, stale: false, check: { kind: "rebuilt", reason: "asked" } });
        }),
    });
    const env = fakeEnv({ openIds: new Set(["a"]) });
    const first = connectionActions(env).resyncFromTree("a");
    expect(env.toast).toHaveBeenLastCalledWith({ kind: "info", text: "Re-syncing the AI context..." });
    // Chosen again while it runs: no second call.
    await connectionActions(env).resyncFromTree("a");
    await vi.waitFor(() => expect(callsTo("ai_resync")).toHaveLength(1));
    finish();
    await first;
    expect(env.toast).toHaveBeenLastCalledWith({ kind: "success", text: "AI context re-synced: 3 tables." });
    // Done: it can run again.
    const again = connectionActions(env).resyncFromTree("a");
    await vi.waitFor(() => expect(callsTo("ai_resync")).toHaveLength(2));
    finish();
    await again;
  });
});
