import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, SavedQuery } from "../api/types";
import type { GridControl } from "../components/DataGrid";
import type { QueryTabDoc } from "../query/QueryTab";
import type { WorkTab } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import { type PendingEditsGuard, usePendingEditsGuard } from "./usePendingEditsGuard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const closeWindow = vi.hoisted(() => ({
  handler: null as null | ((e: { preventDefault(): void }) => Promise<void>),
  destroy: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (h: (e: { preventDefault(): void }) => Promise<void>) => {
      closeWindow.handler = h;
      return () => {};
    },
    destroy: closeWindow.destroy,
  }),
}));

const conn = (id: string, name: string, groupId: string | null, production = false): ConnectionConfig => ({
  id,
  name,
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
  production,
  readOnly: false,
});
const connections = [conn("c1", "KFC Shop", "g1"), conn("c2", "Billing", "g2")];

const table = (key: string, connectionId: string, name: string): WorkTab => ({
  kind: "object",
  key,
  selection: { connectionId, kind: "table", path: { database: "shop", schema: "public", name } },
});

const savedQ: SavedQuery = {
  id: "q1",
  name: "late shipments",
  sql: "SELECT 1",
  updatedAtMs: new Date(2026, 9, 14, 12).getTime(),
  connectionId: "c1",
};
const savedDoc = (text: string): QueryTabDoc => ({
  id: "d1",
  name: "late shipments",
  text,
  connectionId: "c1",
  database: null,
  savedId: "q1",
  savedText: "SELECT 1",
});

type Opts = Parameters<typeof usePendingEditsGuard>[0];

let g!: PendingEditsGuard;
function Harness(p: Opts) {
  g = usePendingEditsGuard(p);
  return <>{g.dialog}</>;
}

function setup(tabs: WorkTab[] = [table("k", "c1", "orders")]) {
  const opts: Opts = {
    tabs,
    connections,
    savedQueries: [savedQ],
    activate: vi.fn(),
    onSavedQuerySaved: vi.fn(),
    onError: vi.fn(),
  };
  const view = render(<Harness {...opts} />);
  return { ...view, opts };
}

/** A fake grid control on `key`: dirty while `state.dirty`, saving with `save`'s answer. */
function control(key: string, save: () => Promise<boolean> = async () => true) {
  const state = { dirty: true };
  const c: GridControl = {
    flush: vi.fn(() => state.dirty),
    pendingCount: vi.fn(() => 2),
    save: vi.fn(save),
    discard: vi.fn(() => {
      state.dirty = false;
      return true;
    }),
  };
  g.gridControl(key).current = c;
  return { c, state };
}

const button = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("usePendingEditsGuard", () => {
  beforeEach(() => {
    closeWindow.handler = null;
  });
  afterEach(() => {
    closeWindow.handler = null;
  });

  it("confirm_leave_without_pending_edits_resolves_true_without_asking", async () => {
    const { opts } = setup();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await g.confirmLeave(["k"]);
    });
    expect(ok).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opts.activate).not.toHaveBeenCalled();
  });

  it("confirm_leave_asks_activates_the_tab_and_cancel_resolves_false", async () => {
    const { opts } = setup();
    control("k");
    let result: Promise<boolean>;
    act(() => {
      result = g.confirmLeave(["k"]);
    });
    expect(await screen.findByText("Save changes to orders?")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("You have 2 Pending Edits in shop.public.orders on KFC Shop.");
    expect(opts.activate).toHaveBeenCalledWith("k");
    await userEvent.click(button("Cancel"));
    expect(await result!).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("discard_calls_the_grids_discard_clears_the_mark_and_resolves_true", async () => {
    setup();
    act(() => g.markDirty("k", true));
    const { c } = control("k");
    expect(g.dirtyKeys.has("k")).toBe(true);
    let result: Promise<boolean>;
    act(() => {
      result = g.confirmLeave(["k"]);
    });
    await screen.findByText("Save changes to orders?");
    await userEvent.click(button("Discard"));
    expect(await result!).toBe(true);
    expect(c.discard).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(g.dirtyKeys.has("k")).toBe(false));
  });

  it("save_resolves_with_the_grids_save_result", async () => {
    setup();
    act(() => g.markDirty("k", true));
    const { c } = control("k", async () => false);
    let result: Promise<boolean>;
    act(() => {
      result = g.confirmLeave(["k"]);
    });
    await screen.findByText("Save changes to orders?");
    await userEvent.click(button("Save"));
    expect(await result!).toBe(false);
    expect(c.save).toHaveBeenCalledTimes(1);
    expect(g.dirtyKeys.has("k")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    vi.mocked(c.save).mockImplementation(async () => true);
    act(() => {
      result = g.confirmLeave(["k"]);
    });
    await screen.findByText("Save changes to orders?");
    await userEvent.click(button("Save"));
    expect(await result!).toBe(true);
    await waitFor(() => expect(g.dirtyKeys.has("k")).toBe(false));
  });

  it("two_requests_ask_one_at_a_time_and_the_second_checks_again", async () => {
    setup();
    const { c } = control("k");
    let first: Promise<boolean>;
    let second: Promise<boolean>;
    act(() => {
      first = g.confirmLeave(["k"]);
      second = g.confirmLeave(["k"]);
    });
    expect(await screen.findAllByRole("dialog")).toHaveLength(1);
    await userEvent.click(button("Discard"));
    expect(await first!).toBe(true);
    expect(await second!).toBe(true);
    expect(c.flush).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("flush_decides_dirty_when_the_grid_has_a_control", () => {
    setup();
    act(() => g.markDirty("k", true));
    expect(g.isDirty("k")).toBe(true);
    const { c, state } = control("k");
    state.dirty = false;
    expect(g.isDirty("k")).toBe(false);
    expect(c.flush).toHaveBeenCalled();
    state.dirty = true;
    act(() => g.markDirty("k", false));
    expect(g.isDirty("k")).toBe(true);
  });

  it("a_removed_tab_takes_its_dirty_mark_and_its_control", () => {
    const { opts, rerender } = setup();
    act(() => g.markDirty("k", true));
    const ref = g.gridControl("k");
    control("k");
    rerender(<Harness {...opts} tabs={[]} />);
    expect(g.dirtyKeys.size).toBe(0);
    expect(g.isDirty("k")).toBe(false);
    expect(g.gridControl("k")).not.toBe(ref);
  });

  it("table_keys_and_group_table_keys_list_the_right_tabs", () => {
    setup([
      table("k1", "c1", "orders"),
      { kind: "query", doc: savedDoc("SELECT 1") },
      table("k2", "c2", "invoices"),
      { kind: "savedQueries" },
      table("k3", "c1", "items"),
    ]);
    expect(g.tableKeys()).toEqual(["k1", "k2", "k3"]);
    expect(g.tableKeys("c1")).toEqual(["k1", "k3"]);
    expect(g.tableKeys("c2")).toEqual(["k2"]);
    expect(g.groupTableKeys("g1")).toEqual(["k1", "k3"]);
    expect(g.groupTableKeys("g2")).toEqual(["k2"]);
    expect(g.groupTableKeys("g3")).toEqual([]);
  });

  it("confirm_close_saved_asks_only_when_the_text_changed", async () => {
    const { opts } = setup([]);
    let ok: boolean | undefined;
    await act(async () => {
      ok = await g.confirmCloseSaved(savedDoc("SELECT 1"));
    });
    expect(ok).toBe(true);
    await act(async () => {
      ok = await g.confirmCloseSaved({ ...savedDoc("SELECT 2"), savedId: null, savedText: null });
    });
    expect(ok).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    let result: Promise<boolean>;
    act(() => {
      result = g.confirmCloseSaved(savedDoc("SELECT 2"));
    });
    expect(await screen.findByText("Save changes to late shipments?")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain(
      "Your edits to this Saved Query are not saved. Discard keeps the version saved on Oct 14.",
    );
    expect(opts.activate).toHaveBeenCalledWith("query:d1");
    await userEvent.click(button("Discard"));
    expect(await result!).toBe(true);
    expect(callsTo("save_saved_query")).toHaveLength(0);
  });

  it("saving_a_saved_query_from_the_ask_saves_and_reports_it", async () => {
    routeInvoke({ save_saved_query: ({ input }) => ({ ...savedQ, sql: (input as { sql: string }).sql }) });
    const { opts } = setup([]);
    let result: Promise<boolean>;
    act(() => {
      result = g.confirmCloseSaved(savedDoc("SELECT 2"));
    });
    await screen.findByText("Save changes to late shipments?");
    await userEvent.click(button("Save"));
    expect(await result!).toBe(true);
    expect(callsTo("save_saved_query")).toEqual([{ input: { id: "q1", name: "late shipments", sql: "SELECT 2" } }]);
    expect(opts.onSavedQuerySaved).toHaveBeenCalledTimes(1);
    expect(opts.onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a_failed_saved_query_save_reports_the_error_and_resolves_false", async () => {
    routeInvoke({
      save_saved_query: () => {
        throw { kind: "internal", message: "disk full" };
      },
    });
    const { opts } = setup([]);
    let result: Promise<boolean>;
    act(() => {
      result = g.confirmCloseSaved(savedDoc("SELECT 2"));
    });
    await screen.findByText("Save changes to late shipments?");
    await userEvent.click(button("Save"));
    expect(await result!).toBe(false);
    expect(opts.onError).toHaveBeenCalledTimes(1);
    expect(opts.onSavedQuerySaved).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("quitting_with_pending_edits_prevents_the_close_and_asks", async () => {
    setup();
    await waitFor(() => expect(closeWindow.handler).not.toBeNull());
    const handler = closeWindow.handler!;

    // No Pending Edits: the close goes on.
    const clean = { preventDefault: vi.fn() };
    await act(async () => {
      await handler(clean);
    });
    expect(clean.preventDefault).not.toHaveBeenCalled();

    control("k");
    const dirty = { preventDefault: vi.fn() };
    let closing: Promise<void>;
    act(() => {
      closing = handler(dirty);
    });
    expect(dirty.preventDefault).toHaveBeenCalledTimes(1);
    await screen.findByText("Save changes to orders?");
    await userEvent.click(button("Discard"));
    await act(async () => {
      await closing!;
    });
    expect(closeWindow.destroy).toHaveBeenCalledTimes(1);
  });
});
