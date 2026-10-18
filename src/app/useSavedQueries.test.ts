import { act, renderHook, waitFor } from "@testing-library/react";
import type { SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedQuery } from "../api/types";
import type { QueryTabDoc } from "../query/QueryTab";
import type { WorkTab } from "../shell/tabs";
import { routeInvoke } from "../test/invoke";
import { emptyQuery } from "../visualquery/model";
import { useSavedQueries } from "./useSavedQueries";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

const saved = (id: string, name: string): SavedQuery => ({ id, name, sql: "SELECT 1", updatedAtMs: 1, connectionId: null });
const doc = (id: string, savedId: string | null): QueryTabDoc => ({
  id,
  name: `Query ${id}`,
  text: "SELECT 2",
  connectionId: null,
  database: null,
  savedId,
  savedText: savedId ? "SELECT 1" : null,
});

function setup() {
  let tabs: WorkTab[] = [
    { kind: "query", doc: doc("a", "s1") },
    { kind: "query", doc: doc("b", "s2") },
    { kind: "query", doc: doc("c", null) },
    { kind: "savedQueries" },
  ];
  const setTabs = vi.fn((next: SetStateAction<WorkTab[]>) => {
    tabs = typeof next === "function" ? next(tabs) : next;
  });
  const onError = vi.fn();
  const hook = renderHook(() => useSavedQueries({ setTabs, onError }));
  return { hook, onError, tabs: () => tabs };
}

describe("useSavedQueries", () => {
  it("load_failure_leaves_an_empty_list", async () => {
    routeInvoke({ list_saved_queries: () => [saved("s1", "One")] });
    const { hook } = setup();
    act(() => hook.result.current.load());
    await waitFor(() => expect(hook.result.current.savedQueries).toHaveLength(1));
    routeInvoke({
      list_saved_queries: () => {
        throw new Error("unreadable");
      },
    });
    act(() => hook.result.current.load());
    await waitFor(() => expect(hook.result.current.savedQueries).toEqual([]));
  });

  it("reload_renames_a_saved_visual_query_tab_and_unlinks_a_deleted_one", async () => {
    routeInvoke({ list_saved_queries: () => [{ ...saved("v1", "Renamed"), kind: "visual", visualJson: "{}" }] });
    const model = emptyQuery("shop", "mysql");
    const vdoc = (id: string, savedId: string): WorkTab => ({
      kind: "visual",
      doc: { id, name: "Old", connectionId: "c1", database: "shop", model, savedId, savedJson: "{}" },
    });
    let tabs: WorkTab[] = [vdoc("a", "v1"), vdoc("b", "v2")];
    const setTabs = vi.fn((next: SetStateAction<WorkTab[]>) => {
      tabs = typeof next === "function" ? next(tabs) : next;
    });
    const hook = renderHook(() => useSavedQueries({ setTabs, onError: vi.fn() }));
    act(() => hook.result.current.reloadSaved());
    await waitFor(() => expect(hook.result.current.savedQueries).toHaveLength(1));
    expect(tabs[0]).toMatchObject({ doc: { name: "Renamed", savedId: "v1", savedJson: "{}" } });
    expect(tabs[1]).toMatchObject({ doc: { name: "Old", savedId: null, savedJson: null } });
  });

  it("reload_renames_open_tabs_and_unlinks_deleted_ones", async () => {
    routeInvoke({ list_saved_queries: () => [saved("s1", "Renamed")] });
    const { hook, tabs } = setup();
    act(() => hook.result.current.reloadSaved());
    await waitFor(() => expect(hook.result.current.savedQueries).toHaveLength(1));
    const [a, b, c, home] = tabs();
    expect(a).toEqual({ kind: "query", doc: { ...doc("a", "s1"), name: "Renamed" } });
    expect(b).toEqual({ kind: "query", doc: { ...doc("b", null), savedId: null, savedText: null } });
    expect(c).toEqual({ kind: "query", doc: doc("c", null) });
    expect(home).toEqual({ kind: "savedQueries" });
  });

  it("reload_failure_reports_the_error", async () => {
    routeInvoke({
      list_saved_queries: () => {
        throw "disk gone";
      },
    });
    const { hook, onError } = setup();
    act(() => hook.result.current.reloadSaved());
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toContain("disk gone");
  });

  it("saved_one_replaces_and_sorts_by_name_ignoring_case", async () => {
    routeInvoke({ list_saved_queries: () => [saved("s1", "beta"), saved("s2", "Delta")] });
    const { hook } = setup();
    act(() => hook.result.current.load());
    await waitFor(() => expect(hook.result.current.savedQueries).toHaveLength(2));
    act(() => hook.result.current.savedOne(saved("s3", "Alpha")));
    act(() => hook.result.current.savedOne(saved("s1", "charlie")));
    expect(hook.result.current.savedQueries.map((q) => `${q.id}:${q.name}`)).toEqual(["s3:Alpha", "s1:charlie", "s2:Delta"]);
  });
});
