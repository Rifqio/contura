import { afterEach, vi } from "vitest";

let releaseHeld: (() => void) | null = null;
// A test that fails while holding timers lets them go, so the next test starts with real ones.
afterEach(() => releaseHeld?.());

/**
 * Holds every `setTimeout` of `ms` set from now until `release`, so a timed step (a fade, a save or a
 * preview wait) cannot fire between two checks on a busy machine. On `release` each one fires, in order.
 */
export function holdTimers(ms: number) {
  releaseHeld?.();
  const real = globalThis.setTimeout;
  const held: (() => void)[] = [];
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay !== ms) return real(fn, delay, ...args);
    held.push(() => fn(...args));
    return 0;
  }) as never);
  const release = () => {
    if (releaseHeld === release) releaseHeld = null;
    spy.mockRestore();
    for (const f of held.splice(0)) f();
  };
  releaseHeld = release;
  return { release, count: () => held.length };
}
