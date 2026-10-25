import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";
import { fakePlan } from "./fakeCore";

type Handler = (args: Record<string, unknown>) => unknown;

/**
 * Routes the mocked `invoke` by command name. Each test file must call
 * `vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))` first.
 * A handler that throws makes the command reject with what it threw.
 */
export function routeInvoke(handlers: Record<string, Handler>) {
  const mock = vi.mocked(invoke);
  mock.mockImplementation(async (cmd: string, args?: unknown) => {
    const handler = handlers[cmd] ?? (cmd === "plan_run" ? fakePlanRun : undefined);
    if (!handler) throw new Error(`unexpected command ${cmd}`);
    return handler((args ?? {}) as Record<string, unknown>);
  });
  return mock;
}

/**
 * A stand-in for the Core's `plan_run` where a test does not route one: the editor's own split and check. Tests about
 * what the Core decides route `plan_run` with the Core's answer (see `safety::plan_run`'s Rust tests).
 */
function fakePlanRun(args: Record<string, unknown>) {
  return fakePlan(args.statements as string[]);
}

/** The argument objects of every call to `cmd`, in order. */
export function callsTo(cmd: string): Record<string, unknown>[] {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([c]) => c === cmd)
    .map(([, args]) => (args ?? {}) as Record<string, unknown>);
}
