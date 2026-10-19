import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ObjectPath } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import { LAYOUT_SAVE_MS, keyFor, layoutText, readLayoutText, useLineageLayout } from "./layout";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => vi.useRealTimers());

const p = (name: string): ObjectPath => ({ database: "kestrel", schema: "shop", name });
const ORDERS = p("orders");

test("the_layout_file_is_versioned_and_keeps_only_card_keys", () => {
  const text = layoutText({ 't:["kestrel","shop","orders"]': { x: 1, y: 2 }, "r:flow:checkout": { x: 3, y: 4 } });
  expect(JSON.parse(text)).toEqual({ version: 1, cards: { 'r:flow:checkout': { x: 3, y: 4 }, 't:["kestrel","shop","orders"]': { x: 1, y: 2 } } });
  // Another version, other keys and inherited names read as nothing moved.
  expect(readLayoutText('{"version":2,"cards":{"t:a":{"x":1,"y":2}}}')).toEqual({});
  expect(readLayoutText("not json")).toEqual({});
  const read = readLayoutText('{"version":1,"cards":{"__proto__":{"x":1,"y":2},"constructor":{"x":1,"y":2},"t:a":{"x":5,"y":6}}}');
  expect(Object.keys(read)).toEqual(["t:a"]);
  expect(read["t:a"]).toEqual({ x: 5, y: 6 });
});

test("the_hook_loads_saves_after_a_pause_and_resets", async () => {
  routeInvoke({
    read_lineage_layout: () => layoutText({ "t:a": { x: 10, y: 20 } }),
    write_lineage_layout: () => undefined,
    delete_lineage_layout: () => undefined,
  });
  const { result } = renderHook(() => useLineageLayout("c1", ORDERS));
  await vi.waitFor(() => expect(result.current.moves).toEqual({ "t:a": { x: 10, y: 20 } }));
  expect(callsTo("read_lineage_layout")).toEqual([{ id: "c1", path: ORDERS }]);

  vi.useFakeTimers();
  act(() => result.current.move("t:b", { x: 1, y: 2 }));
  act(() => result.current.move("t:b", { x: 3, y: 4 }));
  expect(result.current.moves).toEqual({ "t:a": { x: 10, y: 20 }, "t:b": { x: 3, y: 4 } });
  // Moves are saved once, after a pause.
  act(() => vi.advanceTimersByTime(LAYOUT_SAVE_MS - 1));
  expect(callsTo("write_lineage_layout")).toHaveLength(0);
  act(() => vi.advanceTimersByTime(1));
  expect(callsTo("write_lineage_layout")).toEqual([{ id: "c1", path: ORDERS, layout: layoutText({ "t:a": { x: 10, y: 20 }, "t:b": { x: 3, y: 4 } }) }]);

  // Reset drops a waiting save and removes the file.
  act(() => result.current.move("t:c", { x: 0, y: 0 }));
  act(() => result.current.reset());
  act(() => vi.advanceTimersByTime(LAYOUT_SAVE_MS * 2));
  // The removal waits for the read, which has answered already.
  await act(async () => {});
  expect(callsTo("write_lineage_layout")).toHaveLength(1);
  expect(callsTo("delete_lineage_layout")).toEqual([{ id: "c1", path: ORDERS }]);
  expect(result.current.moves).toEqual({});
});

test("a_waiting_save_is_written_when_the_tab_closes", async () => {
  routeInvoke({ read_lineage_layout: () => null, write_lineage_layout: () => undefined });
  const { result, unmount } = renderHook(() => useLineageLayout("c1", ORDERS));
  await vi.waitFor(() => expect(callsTo("read_lineage_layout")).toHaveLength(1));
  act(() => result.current.move("t:a", { x: 1, y: 1 }));
  unmount();
  expect(callsTo("write_lineage_layout")).toEqual([{ id: "c1", path: ORDERS, layout: layoutText({ "t:a": { x: 1, y: 1 } }) }]);
});

test("a_move_before_the_file_answers_is_not_undone_by_it", async () => {
  let answer: (text: string | null) => void = () => {};
  routeInvoke({ read_lineage_layout: () => new Promise((r) => (answer = r)), write_lineage_layout: () => undefined });
  const { result } = renderHook(() => useLineageLayout("c1", ORDERS));
  act(() => result.current.move("t:b", { x: 7, y: 7 }));
  await act(async () => answer(layoutText({ "t:a": { x: 1, y: 1 } })));
  expect(result.current.moves).toEqual({ "t:a": { x: 1, y: 1 }, "t:b": { x: 7, y: 7 } });
});

test("another_table_reads_its_own_file", async () => {
  routeInvoke({ read_lineage_layout: (a) => ((a.path as ObjectPath).name === "orders" ? layoutText({ "t:a": { x: 1, y: 1 } }) : null) });
  const { result, rerender } = renderHook(({ path }) => useLineageLayout("c1", path), { initialProps: { path: ORDERS } });
  await vi.waitFor(() => expect(result.current.moves).toEqual({ "t:a": { x: 1, y: 1 } }));
  rerender({ path: p("customers") });
  await vi.waitFor(() => expect(callsTo("read_lineage_layout")).toHaveLength(2));
  expect(result.current.moves).toEqual({});
});

test("a_moved_card_is_saved_under_its_stable_key", () => {
  const refs = [{ key: "r:flow:[\"checkout\",null]" }, { key: "r:view:[\"kestrel\",\"shop\",\"daily\"]" }];
  expect(keyFor("ref:1", refs)).toBe(refs[1].key);
  expect(keyFor("ref:0", refs)).toBe(refs[0].key);
  expect(keyFor('t:["kestrel","shop","orders"]', refs)).toBe('t:["kestrel","shop","orders"]');
  // A row that is gone, or no rows yet, keeps the node id (the file drops it).
  expect(keyFor("ref:5", refs)).toBe("ref:5");
  expect(keyFor("ref:0", null)).toBe("ref:0");
});

test("reset_before_the_file_answers_waits_for_it_and_keeps_nothing_saved", async () => {
  let answer: (text: string | null) => void = () => {};
  routeInvoke({
    read_lineage_layout: () => new Promise((r) => (answer = r)),
    write_lineage_layout: () => undefined,
    delete_lineage_layout: () => undefined,
  });
  vi.useFakeTimers();
  const { result } = renderHook(() => useLineageLayout("c1", ORDERS));
  act(() => result.current.move("t:b", { x: 7, y: 7 }));
  act(() => result.current.reset());
  // A waiting save is cancelled, and the file is removed only once the read has answered.
  act(() => vi.advanceTimersByTime(LAYOUT_SAVE_MS * 2));
  expect(callsTo("write_lineage_layout")).toHaveLength(0);
  expect(callsTo("delete_lineage_layout")).toHaveLength(0);
  await act(async () => answer(layoutText({ "t:a": { x: 1, y: 1 } })));
  expect(result.current.moves).toEqual({});
  expect(callsTo("delete_lineage_layout")).toEqual([{ id: "c1", path: ORDERS }]);
  // The next move saves only itself, never the layout Reset removed.
  act(() => result.current.move("t:c", { x: 2, y: 2 }));
  act(() => vi.advanceTimersByTime(LAYOUT_SAVE_MS));
  expect(callsTo("write_lineage_layout")).toEqual([{ id: "c1", path: ORDERS, layout: layoutText({ "t:c": { x: 2, y: 2 } }) }]);
});

test("reset_waits_for_a_save_already_on_its_way", async () => {
  let landed: () => void = () => {};
  const order: string[] = [];
  routeInvoke({
    read_lineage_layout: () => null,
    write_lineage_layout: () =>
      new Promise<void>((r) => {
        order.push("write sent");
        landed = () => {
          order.push("write landed");
          r();
        };
      }),
    delete_lineage_layout: () => {
      order.push("delete");
    },
  });
  const { result } = renderHook(() => useLineageLayout("c1", ORDERS));
  await vi.waitFor(() => expect(callsTo("read_lineage_layout")).toHaveLength(1));
  vi.useFakeTimers();
  act(() => result.current.move("t:a", { x: 1, y: 1 }));
  act(() => vi.advanceTimersByTime(LAYOUT_SAVE_MS));
  expect(order).toEqual(["write sent"]);
  // Reset while the save runs: the removal goes after it, so the file cannot come back.
  act(() => result.current.reset());
  await act(async () => {});
  expect(order).toEqual(["write sent"]);
  await act(async () => landed());
  await vi.waitFor(() => expect(order).toEqual(["write sent", "write landed", "delete"]));
});
