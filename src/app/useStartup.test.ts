import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, Group } from "../api/types";
import { errorText } from "../api/client";
import { routeInvoke } from "../test/invoke";
import { firstPlace, useStartup } from "./useStartup";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const group = (id: string): Group => ({ id, name: id, color: "pink", hasImage: false });
const conn: ConnectionConfig = {
  id: "a",
  name: "Shop",
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
};

function setup() {
  const loaded = vi.fn();
  const always = vi.fn();
  const hook = renderHook(() => useStartup({ loaded, always }));
  return { ...hook, loaded, always };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("firstPlace", () => {
  it("first_place_is_the_last_group_when_it_exists", () => {
    expect(firstPlace([group("g1"), group("g2")], "g2")).toEqual({ kind: "group", groupId: "g2" });
  });

  it("first_place_is_ungrouped_without_a_last_group_or_when_it_is_gone", () => {
    expect(firstPlace([group("g1")], null)).toEqual({ kind: "ungrouped" });
    expect(firstPlace([group("g1")], "gone")).toEqual({ kind: "ungrouped" });
  });
});

describe("useStartup", () => {
  it("steps_count_up_and_ready_hands_over_groups_connections_and_the_first_place", async () => {
    const releases: Record<string, () => void> = {};
    const gate = (name: string, value: unknown) => () => new Promise((r) => (releases[name] = () => r(value)));
    routeInvoke({
      list_groups: gate("groups", [group("g1")]),
      list_connections: gate("connections", [conn]),
      last_group: gate("last", "g1"),
    });
    const { result, loaded } = setup();
    expect(result.current.startup).toEqual({ s: "loading" });
    expect(result.current.step).toBe(0);
    await waitFor(() => expect(Object.keys(releases)).toHaveLength(3));
    await act(async () => releases.groups());
    expect(result.current.step).toBe(1);
    await act(async () => releases.connections());
    expect(result.current.step).toBe(2);
    expect(loaded).not.toHaveBeenCalled();
    await act(async () => releases.last());
    expect(result.current.step).toBe(3);
    expect(result.current.startup).toEqual({ s: "ready" });
    expect(loaded).toHaveBeenCalledWith({
      groups: [group("g1")],
      connections: [conn],
      first: { kind: "group", groupId: "g1" },
    });
  });

  it("a_failed_read_says_why_and_retry_starts_again", async () => {
    const failure = { kind: "storage", message: "disk" };
    let calls = 0;
    routeInvoke({
      list_groups: () => {
        if (calls++ === 0) throw failure;
        return [];
      },
      list_connections: () => [],
      last_group: () => null,
    });
    const { result, loaded } = setup();
    await waitFor(() => expect(result.current.startup).toEqual({ s: "failed", message: errorText(failure) }));
    expect(loaded).not.toHaveBeenCalled();
    act(() => {
      void result.current.retry();
    });
    expect(result.current.startup).toEqual({ s: "loading" });
    await waitFor(() => expect(result.current.startup).toEqual({ s: "ready" }));
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it("always_runs_after_success_and_after_failure", async () => {
    let fail = true;
    routeInvoke({
      list_groups: () => {
        if (fail) throw { kind: "storage", message: "disk" };
        return [];
      },
      list_connections: () => [],
      last_group: () => null,
    });
    const { result, always } = setup();
    await waitFor(() => expect(always).toHaveBeenCalledTimes(1));
    expect(result.current.startup.s).toBe("failed");
    fail = false;
    act(() => {
      void result.current.retry();
    });
    await waitFor(() => expect(always).toHaveBeenCalledTimes(2));
    expect(result.current.startup).toEqual({ s: "ready" });
  });
});
