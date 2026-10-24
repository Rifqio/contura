import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { type TabAskFields, tabAskSize, usePublishTabAsk, useTabAsk } from "./tabAsk";

const home = (n: number): TabAskFields => ({ tab: { kind: "home" }, tables: [{ schema: null, name: `t${n}` }] });

/** A publisher and a reader of the same key, in one hook. */
function both(key: string, state: { n: number; other: number }) {
  usePublishTabAsk(key, () => home(state.n), [state.n]);
  return useTabAsk(key);
}

test("publish and read: the getter gives the state of the last draw", () => {
  const { result, rerender, unmount } = renderHook((p: { n: number; other: number }) => both("query:a", p), { initialProps: { n: 1, other: 0 } });
  expect(result.current?.get()).toEqual(home(1));
  rerender({ n: 2, other: 0 });
  expect(result.current?.get()).toEqual(home(2));
  unmount();
});

test("rev bumps when the deps change, never on a draw with the same deps", () => {
  const { result, rerender, unmount } = renderHook((p: { n: number; other: number }) => both("query:b", p), { initialProps: { n: 1, other: 0 } });
  const first = result.current;
  rerender({ n: 1, other: 5 });
  expect(result.current).toBe(first);
  rerender({ n: 2, other: 5 });
  expect(result.current).not.toBe(first);
  expect(result.current!.rev).toBe(first!.rev + 1);
  unmount();
});

test("the entry goes on unmount, and a reader sees null", () => {
  const pub = renderHook(() => usePublishTabAsk("design:x", () => home(1), []));
  const read = renderHook(() => useTabAsk("design:x"));
  expect(read.result.current).not.toBeNull();
  pub.unmount();
  expect(read.result.current).toBeNull();
  read.unmount();
  expect(tabAskSize()).toBe(0);
});

test("two tabs do not mix", () => {
  const one = renderHook(() => usePublishTabAsk("tab-1", () => home(1), []));
  const two = renderHook(() => usePublishTabAsk("tab-2", () => home(2), []));
  const read = renderHook((p: { key: string | null }) => useTabAsk(p.key), { initialProps: { key: "tab-1" as string | null } });
  expect(read.result.current?.get()).toEqual(home(1));
  read.rerender({ key: "tab-2" });
  expect(read.result.current?.get()).toEqual(home(2));
  // Unmounting one leaves the other.
  one.unmount();
  expect(read.result.current?.get()).toEqual(home(2));
  read.rerender({ key: null });
  expect(read.result.current).toBeNull();
  two.unmount();
  read.unmount();
});

test("a null key publishes nothing", () => {
  const pub = renderHook(() => usePublishTabAsk(null, () => home(1), []));
  expect(tabAskSize()).toBe(0);
  pub.unmount();
});

test("the registry is back to empty after 50 mount and unmount cycles", () => {
  for (let i = 0; i < 50; i++) {
    const pub = renderHook(() => usePublishTabAsk(`object:${i}`, () => home(i), [i]));
    const read = renderHook(() => useTabAsk(`object:${i}`));
    expect(tabAskSize()).toBe(2);
    pub.unmount();
    read.unmount();
  }
  expect(tabAskSize()).toBe(0);
});

test("a delay holds later bumps until the deps are quiet; the first publish is at once", () => {
  vi.useFakeTimers();
  try {
    const { result, rerender, unmount } = renderHook(
      (p: { n: number }) => {
        usePublishTabAsk("design:slow", () => home(p.n), [p.n], 150);
        return useTabAsk("design:slow");
      },
      { initialProps: { n: 1 } },
    );
    const first = result.current;
    expect(first?.get()).toEqual(home(1));
    rerender({ n: 2 });
    rerender({ n: 3 });
    expect(result.current).toBe(first);
    act(() => vi.advanceTimersByTime(149));
    expect(result.current).toBe(first);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current!.rev).toBe(first!.rev + 1);
    expect(result.current!.get()).toEqual(home(3));
    unmount();
    expect(tabAskSize()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
