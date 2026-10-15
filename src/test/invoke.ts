import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";

type Handler = (args: Record<string, unknown>) => unknown;

/**
 * Routes the mocked `invoke` by command name. Each test file must call
 * `vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))` first.
 * A handler that throws makes the command reject with what it threw.
 */
export function routeInvoke(handlers: Record<string, Handler>) {
  const mock = vi.mocked(invoke);
  mock.mockImplementation(async (cmd: string, args?: unknown) => {
    const handler = handlers[cmd];
    if (!handler) throw new Error(`unexpected command ${cmd}`);
    return handler((args ?? {}) as Record<string, unknown>);
  });
  return mock;
}

/** The argument objects of every call to `cmd`, in order. */
export function callsTo(cmd: string): Record<string, unknown>[] {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([c]) => c === cmd)
    .map(([, args]) => (args ?? {}) as Record<string, unknown>);
}
