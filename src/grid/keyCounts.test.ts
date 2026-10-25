// UX step 8: how many rows of another table point here, from the Core's count (capped at 1,001, on a read of its own
// that the server stops after a few seconds), one at a time per Connection; skipped on a closed Connection, for a
// minute after a slow one, and when the list that asked has closed.
import { afterEach, expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import { countRows, forgetSlowForTests } from "./keyCounts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const orders = { database: "shop", schema: "public", name: "orders" };
const req = { table: orders, where: `"customer_id" = '214'` };

afterEach(() => forgetSlowForTests());

test("counts_with_the_core_count_and_the_page_filter", async () => {
  routeInvoke({ count_rows: () => ({ kind: "counted", rows: 2 }) });
  expect(await countRows("c1", req, true)).toEqual({ state: "done", rows: 2, more: false });
  expect(callsTo("count_rows")).toEqual([{ id: "c1", request: { table: orders, filter: `"customer_id" = '214'` } }]);
  // No page is read to count.
  expect(callsTo("fetch_page")).toEqual([]);
});

test("1001_reads_as_1000_plus", async () => {
  routeInvoke({ count_rows: () => ({ kind: "counted", rows: 1001 }) });
  expect(await countRows("c1", req, true)).toEqual({ state: "done", rows: 1000, more: true });
});

test("a_closed_connection_is_not_counted", async () => {
  routeInvoke({});
  expect(await countRows("c1", req, false)).toEqual({ state: "skipped", why: "closed" });
  expect(callsTo("count_rows")).toEqual([]);
});

test("a_count_the_server_stopped_skips_the_connection_for_a_while", async () => {
  routeInvoke({ count_rows: () => ({ kind: "timedOut" }) });
  expect(await countRows("c1", req, true)).toEqual({ state: "timeout" });
  expect(await countRows("c1", req, true)).toEqual({ state: "skipped", why: "slow" });
  expect(callsTo("count_rows")).toHaveLength(1);
  routeInvoke({ count_rows: () => ({ kind: "counted", rows: 0 }) });
  expect(await countRows("c2", req, true)).toEqual({ state: "done", rows: 0, more: false });
});

test("a_failed_count_is_not_counted", async () => {
  routeInvoke({ count_rows: () => Promise.reject({ kind: "query", message: "permission denied" }) });
  expect(await countRows("c1", req, true)).toEqual({ state: "skipped", why: "error" });
});

test("a_slow_table_count_does_not_stop_the_key_counts_and_the_reverse", async () => {
  routeInvoke({ count_rows: () => ({ kind: "timedOut" }) });
  const whole = { table: orders, where: null };
  expect(await countRows("c1", whole, true, undefined, "table")).toEqual({ state: "timeout" });
  routeInvoke({ count_rows: () => ({ kind: "counted", rows: 2 }) });
  // The key counts of the same Connection still run.
  expect(await countRows("c1", req, true)).toEqual({ state: "done", rows: 2, more: false });
  // The table count waits its minute.
  expect(await countRows("c1", whole, true, undefined, "table")).toEqual({ state: "skipped", why: "slow" });
  // A slow key count does not stop another table's count.
  routeInvoke({ count_rows: () => ({ kind: "timedOut" }) });
  expect(await countRows("c2", req, true)).toEqual({ state: "timeout" });
  routeInvoke({ count_rows: () => ({ kind: "counted", rows: 5 }) });
  expect(await countRows("c2", whole, true, undefined, "table")).toEqual({ state: "done", rows: 5, more: false });
});

test("counts_run_one_at_a_time_per_connection_and_a_closed_list_drops_its_waiting_ones", async () => {
  const answers: ((v: unknown) => void)[] = [];
  routeInvoke({ count_rows: () => new Promise((resolve) => answers.push(resolve)) });
  const stop = { cancelled: false };
  const first = countRows("c1", req, true, stop);
  const second = countRows("c1", req, true, stop);
  const other = countRows("c2", req, true);
  await vi.waitFor(() => expect(callsTo("count_rows")).toHaveLength(2));
  // c1's second waits for its first; c2 runs beside them.
  expect(callsTo("count_rows").map((c) => c.id)).toEqual(["c1", "c2"]);
  stop.cancelled = true;
  answers[0]({ kind: "counted", rows: 1 });
  answers[1]({ kind: "counted", rows: 3 });
  expect(await first).toEqual({ state: "skipped", why: "cancelled" });
  expect(await second).toEqual({ state: "skipped", why: "cancelled" });
  expect(await other).toEqual({ state: "done", rows: 3, more: false });
  // The waiting count never ran.
  expect(callsTo("count_rows")).toHaveLength(2);
});
