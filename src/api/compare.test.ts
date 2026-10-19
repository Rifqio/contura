import { invoke } from "@tauri-apps/api/core";
import { expect, test, vi } from "vitest";
import { errorText } from "./client";
import { applySync, compareDdl, compareSchemas, confirmSync, planSync } from "./compare";
import type { CompareRequest, JobEvent } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

const REQ: CompareRequest = {
  source: { kind: "database", connectionId: "stg", database: "freight", schema: "billing" },
  target: { connectionId: "prod", database: "freight", schema: "billing" },
};

test("compare_commands_send_camel_case_arguments", async () => {
  const mock = vi.mocked(invoke);
  mock.mockClear();
  await compareSchemas(REQ);
  await compareDdl(REQ, "invoices");
  await planSync(REQ, null);
  await planSync(REQ, ["column:billing.invoices.fax:removed"]);
  await confirmSync(REQ, ["a"]);
  expect(mock.mock.calls.map(([c, a]) => [c, a])).toEqual([
    ["compare_schemas", { req: REQ }],
    ["compare_ddl", { req: REQ, table: "invoices" }],
    ["plan_sync", { req: REQ, selection: null }],
    ["plan_sync", { req: REQ, selection: ["column:billing.invoices.fax:removed"] }],
    ["confirm_sync", { req: REQ, selection: ["a"] }],
  ]);
});

test("apply_sync_streams_job_events", async () => {
  const mock = vi.mocked(invoke);
  mock.mockClear();
  const seen: JobEvent[] = [];
  await applySync("j1", REQ, ["a"], "pass", "h1", (e) => seen.push(e));
  const [cmd, args] = mock.mock.calls[0] as [string, Record<string, unknown>];
  expect(cmd).toBe("apply_sync");
  expect(args).toMatchObject({ job: "j1", req: REQ, selection: ["a"], pass: "pass", expectedHash: "h1" });
  const events = args.events as { onmessage(e: JobEvent): void };
  events.onmessage({ kind: "warning", message: "w" });
  expect(seen).toEqual([{ kind: "warning", message: "w" }]);
});

test("plan_changed_names_the_target", () => {
  expect(errorText({ kind: "planChanged", message: { connection: "freight-prod" } })).toBe(
    "freight-prod changed since you compared. Compare again to see the current Sync Script.",
  );
});

test("sync_cancel_says_what_stayed_applied", () => {
  expect(errorText({ kind: "syncCancelled", message: { applied: 3, total: 9 } })).toBe("Apply was cancelled. 3 of 9 statements were applied.");
  expect(errorText({ kind: "syncCancelled", message: { applied: 1, total: 9 } })).toBe("Apply was cancelled. 1 of 9 statements was applied.");
  expect(errorText({ kind: "syncCancelled", message: { applied: 0, total: 9 } })).toBe("Apply was cancelled. Nothing was changed.");
  expect(errorText({ kind: "syncCancelled", message: { applied: 1200, total: 1500 } })).toBe(
    "Apply was cancelled. 1,200 of 1,500 statements were applied.",
  );
});

test("design_failure_counts_have_grouping_commas", () => {
  expect(errorText({ kind: "designFailed", message: { statement: 1200, ran: 1200, total: 1500, message: "boom" } })).toBe(
    "1,200 of 1,500 statements were applied. Statement 1,201 failed: boom",
  );
});
