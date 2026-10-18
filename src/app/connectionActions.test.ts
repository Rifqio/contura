import { beforeEach, describe, expect, it, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import { type ConnectionActionsEnv, connectionActions } from "./connectionActions";

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
});
