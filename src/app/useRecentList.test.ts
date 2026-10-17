import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentItem } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import { useRecentList } from "./useRecentList";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const item = (file: string): RecentItem => ({ target: { kind: "schemaModel", file }, connectionId: null, openedAtMs: 1 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useRecentList", () => {
  it("load_reads_items_and_opened_times", async () => {
    routeInvoke({ recent_items: () => [item("a.dbml")], connection_opened_times: () => ({ c1: 5 }) });
    const { result } = renderHook(() => useRecentList());
    expect(result.current.recent).toEqual([]);
    act(() => result.current.load());
    await waitFor(() => expect(result.current.recent).toEqual([item("a.dbml")]));
    await waitFor(() => expect(result.current.openedTimes).toEqual({ c1: 5 }));
  });

  it("record_records_then_loads_again", async () => {
    let items = [item("a.dbml")];
    routeInvoke({
      recent_items: () => items,
      connection_opened_times: () => ({}),
      record_recent: () => {
        items = [item("b.dbml"), ...items];
      },
    });
    const { result } = renderHook(() => useRecentList());
    act(() => result.current.record({ kind: "schemaModel", file: "b.dbml" }, "c1"));
    await waitFor(() => expect(result.current.recent).toEqual([item("b.dbml"), item("a.dbml")]));
    expect(callsTo("record_recent")).toEqual([{ target: { kind: "schemaModel", file: "b.dbml" }, connectionId: "c1" }]);
  });

  it("failures_leave_the_lists_as_they_were", async () => {
    let fail = false;
    routeInvoke({
      recent_items: () => {
        if (fail) throw new Error("down");
        return [item("a.dbml")];
      },
      connection_opened_times: () => {
        if (fail) throw new Error("down");
        return { c1: 5 };
      },
      record_recent: () => {
        throw new Error("down");
      },
    });
    const { result } = renderHook(() => useRecentList());
    act(() => result.current.load());
    await waitFor(() => expect(result.current.openedTimes).toEqual({ c1: 5 }));
    fail = true;
    act(() => result.current.load());
    act(() => result.current.record({ kind: "schemaModel", file: "x.dbml" }, null));
    await waitFor(() => expect(callsTo("record_recent")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.recent).toEqual([item("a.dbml")]);
    expect(result.current.openedTimes).toEqual({ c1: 5 });
  });
});
