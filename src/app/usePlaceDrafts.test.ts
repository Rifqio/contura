import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryTabDoc } from "../query/QueryTab";
import type { Place, WorkTab } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import { DRAFT_SAVE_MS, usePlaceDrafts } from "./usePlaceDrafts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const g1: Place = { kind: "group", groupId: "g1" };
const g2: Place = { kind: "group", groupId: "g2" };

const doc = (id: string, name: string): QueryTabDoc => ({
  id,
  name,
  text: "SELECT 1",
  connectionId: "c1",
  database: null,
  savedId: null,
  savedText: null,
});
const tab = (d: QueryTabDoc): WorkTab => ({ kind: "query", doc: d });
const draftsJson = (docs: QueryTabDoc[]) => JSON.stringify({ version: 1, tabs: docs });

/** A load_query_tabs answer per place that the test releases (or fails) when it wants. */
function heldLoads() {
  const held = new Map<string, { resolve: (v: string | null) => void; reject: (e: unknown) => void }>();
  routeInvoke({
    load_query_tabs: ({ place }) =>
      new Promise((resolve, reject) => held.set(place as string, { resolve, reject })),
    save_query_tabs: () => null,
  });
  return {
    async answer(place: string, json: string | null) {
      await act(async () => {
        held.get(place)!.resolve(json);
      });
    },
  };
}

type Props = { place: Place; tabs: WorkTab[]; ready: boolean };

function setup(initial: Partial<Props> = {}) {
  const onRestored = vi.fn();
  const hook = renderHook((p: Props) => usePlaceDrafts({ ...p, onRestored }), {
    initialProps: { place: g1, tabs: [], ready: true, ...initial },
  });
  return { ...hook, onRestored };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("usePlaceDrafts", () => {
  it("nothing_loads_before_ready", async () => {
    routeInvoke({ load_query_tabs: () => null, save_query_tabs: () => null });
    const { onRestored } = setup({ ready: false });
    await act(async () => {});
    expect(callsTo("load_query_tabs")).toEqual([]);
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("ready_loads_the_places_drafts_and_hands_them_over", async () => {
    const d = doc("d1", "Late deliveries");
    routeInvoke({ load_query_tabs: ({ place }) => (place === "group:g1" ? draftsJson([d]) : null) });
    const { onRestored } = setup();
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith([d]));
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(callsTo("load_query_tabs")).toEqual([{ place: "group:g1" }]);
  });

  it("a_failed_load_hands_over_no_drafts", async () => {
    routeInvoke({
      load_query_tabs: () => {
        throw { kind: "file", message: "denied" };
      },
    });
    const { onRestored } = setup();
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith([]));
  });

  it("saves_after_the_pause_and_only_once_loaded", async () => {
    vi.useFakeTimers();
    const loads = heldLoads();
    const a = doc("d1", "Query 1");
    const b = doc("d2", "Query 2");
    const { rerender } = setup();
    // A tab opened before the drafts are read never saves over them.
    rerender({ place: g1, tabs: [tab(a)], ready: true });
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_MS * 4));
    expect(callsTo("save_query_tabs")).toEqual([]);
    await loads.answer("group:g1", null);
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_MS * 4));
    expect(callsTo("save_query_tabs")).toEqual([]);
    rerender({ place: g1, tabs: [tab(a), tab(b)], ready: true });
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_MS - 1));
    expect(callsTo("save_query_tabs")).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(callsTo("save_query_tabs")).toEqual([{ place: "group:g1", json: draftsJson([a, b]) }]);
  });

  it("when_drafts_loaded_runs_at_once_when_loaded", async () => {
    routeInvoke({ load_query_tabs: () => null });
    const { result, onRestored } = setup();
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    const run = vi.fn();
    result.current.whenDraftsLoaded(g1, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("when_drafts_loaded_waits_for_the_load_then_runs", async () => {
    const loads = heldLoads();
    const log: string[] = [];
    const onRestored = vi.fn(() => log.push("restored"));
    const { result } = renderHook(() => usePlaceDrafts({ place: g1, tabs: [], ready: true, onRestored }));
    await act(async () => {});
    result.current.whenDraftsLoaded(g1, () => log.push("run"));
    expect(log).toEqual([]);
    await loads.answer("group:g1", null);
    expect(log).toEqual(["restored", "run"]);
  });

  it("an_open_for_another_place_is_dropped", async () => {
    const loads = heldLoads();
    const { result } = setup();
    await act(async () => {});
    const run = vi.fn();
    result.current.whenDraftsLoaded(g2, run);
    await loads.answer("group:g1", null);
    result.current.whenDraftsLoaded(g2, run);
    expect(run).not.toHaveBeenCalled();
  });

  it("leave_for_saves_at_once_and_drops_a_queued_open", async () => {
    const loads = heldLoads();
    const a = doc("d1", "Query 1");
    const { result, rerender } = setup({ tabs: [tab(a)] });
    await act(async () => {});
    // While the drafts are on their way, leaving saves nothing and drops the open.
    const run = vi.fn();
    result.current.whenDraftsLoaded(g1, run);
    act(() => result.current.leaveFor(g2));
    expect(callsTo("save_query_tabs")).toEqual([]);
    expect(result.current.placeNow.current).toEqual(g2);
    expect(result.current.visit.current).toBe(1);
    await loads.answer("group:g1", null);
    expect(run).not.toHaveBeenCalled();

    // Once loaded, leaving saves this place's drafts at once, without the pause.
    rerender({ place: g2, tabs: [tab(a)], ready: true });
    await act(async () => {});
    await loads.answer("group:g2", null);
    act(() => result.current.leaveFor(g1));
    expect(callsTo("save_query_tabs")).toEqual([{ place: "group:g2", json: draftsJson([a]) }]);
    expect(result.current.placeNow.current).toEqual(g1);
    expect(result.current.visit.current).toBe(2);
  });

  it("drop_queued_counts_a_visit_and_drops_the_open", async () => {
    const loads = heldLoads();
    const { result } = setup();
    await act(async () => {});
    const run = vi.fn();
    result.current.whenDraftsLoaded(g1, run);
    result.current.dropQueued();
    expect(result.current.visit.current).toBe(1);
    expect(result.current.placeNow.current).toEqual(g1);
    await loads.answer("group:g1", null);
    expect(run).not.toHaveBeenCalled();
  });

  it("a_load_that_answers_after_a_move_is_ignored", async () => {
    vi.useFakeTimers();
    const loads = heldLoads();
    const a = doc("d1", "Query 1");
    const { rerender, onRestored } = setup();
    await act(async () => {});
    rerender({ place: g2, tabs: [], ready: true });
    await act(async () => {});
    await loads.answer("group:g1", draftsJson([a]));
    expect(onRestored).not.toHaveBeenCalled();
    // g1's late answer does not count as g2's drafts being read: no save yet.
    rerender({ place: g2, tabs: [tab(a)], ready: true });
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_MS * 4));
    expect(callsTo("save_query_tabs")).toEqual([]);
    await loads.answer("group:g2", null);
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onRestored).toHaveBeenCalledWith([]);
  });
});
