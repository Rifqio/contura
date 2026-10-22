import { afterEach, expect, test, vi } from "vitest";
import { queueOffline } from "./offlineQueue";

const online = () => window.dispatchEvent(new Event("online"));
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  // Drain anything a test left queued so the next one starts clean.
  online();
});

test("one_online_event_sends_both_in_order", async () => {
  const log: string[] = [];
  let release: () => void = () => {};
  const first = vi.fn(async () => {
    log.push("a:start");
    await new Promise<void>((r) => (release = r));
    log.push("a:end");
  });
  const second = vi.fn(async () => {
    log.push("b:start");
  });
  queueOffline("panel", first);
  queueOffline("inline", second);
  online();
  await tick();
  // The second waits for the first to settle.
  expect(log).toEqual(["a:start"]);
  release();
  await tick();
  expect(log).toEqual(["a:start", "a:end", "b:start"]);
  online();
  await tick();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

test("latest_send_per_key", async () => {
  const old = vi.fn(async () => {});
  const latest = vi.fn(async () => {});
  queueOffline("panel", old);
  queueOffline("panel", latest);
  online();
  await tick();
  expect(old).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
});

test("cancel_removes", async () => {
  const send = vi.fn(async () => {});
  const other = vi.fn(async () => {});
  const cancel = queueOffline("panel", send);
  queueOffline("inline", other);
  cancel();
  online();
  await tick();
  expect(send).not.toHaveBeenCalled();
  expect(other).toHaveBeenCalledTimes(1);
});

test("a_stale_cancel_keeps_the_newer_send", async () => {
  const old = vi.fn(async () => {});
  const latest = vi.fn(async () => {});
  const cancelOld = queueOffline("panel", old);
  queueOffline("panel", latest);
  cancelOld();
  online();
  await tick();
  expect(latest).toHaveBeenCalledTimes(1);
});

test("a_failing_send_is_reported_and_the_rest_still_go", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const next = vi.fn(async () => {});
  queueOffline("a", async () => {
    throw new Error("boom");
  });
  queueOffline("b", next);
  online();
  await tick();
  expect(report).toHaveBeenCalled();
  expect(next).toHaveBeenCalledTimes(1);
  report.mockRestore();
});
