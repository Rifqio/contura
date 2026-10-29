import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({ perfLogEnabled: vi.fn(), perfLogAppend: vi.fn(() => Promise.resolve()) }));

import { perfLogAppend, perfLogEnabled } from "../api/client";
import { perfMark, perfMeasure, perfOn, perfRingState, perfStep, RING_SIZE, startPerfRecorder, stopPerfRecorder } from "./perfRecorder";

const lines = () => vi.mocked(perfLogAppend).mock.calls.map((c) => JSON.parse(c[0]));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(perfLogAppend).mockClear();
});
afterEach(() => {
  stopPerfRecorder();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("perf recorder", () => {
  it("does nothing when off: no rAF loop, no log calls, no-op marks", async () => {
    vi.mocked(perfLogEnabled).mockResolvedValue(false);
    const raf = vi.spyOn(globalThis, "requestAnimationFrame");
    const mark = vi.spyOn(performance, "mark");
    await startPerfRecorder();
    perfMark("a");
    perfMeasure("m", "a");
    await vi.advanceTimersByTimeAsync(3000);
    expect(perfOn()).toBe(false);
    expect(raf).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
    expect(perfLogAppend).not.toHaveBeenCalled();
  });

  it("writes one line a second with the frame figures and the measures of that second", async () => {
    vi.mocked(perfLogEnabled).mockResolvedValue(true);
    await startPerfRecorder();
    expect(perfOn()).toBe(true);
    perfMark("pick");
    await vi.advanceTimersByTimeAsync(30);
    perfMeasure("select", "pick");
    await vi.advanceTimersByTimeAsync(2000);
    const l = lines();
    expect(l).toHaveLength(2);
    expect(Object.keys(l[0]).sort()).toEqual(["frames", "measures", "over16", "over50", "p95", "steps", "t", "worst"]);
    expect(l[0].t).toBe(1000);
    expect(l[1].t).toBe(2000);
    expect(l[0].frames).toBeGreaterThan(30);
    expect(l[0].worst).toBeGreaterThan(0);
    expect(l[0].p95).toBeGreaterThan(0);
    expect(l[0].measures).toHaveLength(1);
    expect(l[0].measures[0].name).toBe("select");
    expect(l[0].measures[0].ms).toBeGreaterThanOrEqual(30);
    expect(l[1].measures).toEqual([]);
  });

  it("counts frames over 16 ms and 50 ms, and the ring never grows past its size", async () => {
    vi.mocked(perfLogEnabled).mockResolvedValue(true);
    let cb: FrameRequestCallback | null = null;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((f) => {
      cb = f;
      return 1;
    });
    await startPerfRecorder();
    const base = performance.now();
    let now = base;
    const tick = (dt: number) => {
      now += dt;
      cb!(now);
    };
    for (let i = 0; i < 1000; i++) tick(4);
    expect(perfRingState()).toEqual({ size: RING_SIZE, filled: RING_SIZE });
    tick(20);
    tick(60);
    tick(100);
    await vi.advanceTimersByTimeAsync(1000);
    const [l] = lines();
    expect(l.frames).toBe(1003);
    expect(l.over16).toBe(3);
    expect(l.over50).toBe(2);
    expect(l.worst).toBe(100);
    expect(perfRingState().filled).toBe(0);
  });

  it("gives each measure the worst frame between its mark and its end", async () => {
    vi.mocked(perfLogEnabled).mockResolvedValue(true);
    let cb: FrameRequestCallback | null = null;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((f) => {
      cb = f;
      return 1;
    });
    await startPerfRecorder();
    let now = performance.now();
    const tick = (dt: number) => {
      now += dt;
      cb!(now);
    };
    tick(90); // before the mark: not the glide's
    perfMark("glide");
    tick(16);
    tick(70);
    tick(16);
    perfMeasure("glide_landed", "glide");
    tick(120); // after its end: not the glide's either
    perfMark("quiet");
    perfMeasure("quiet_landed", "quiet");
    await vi.advanceTimersByTimeAsync(1000);
    const [l] = lines();
    expect(l.measures.map((m: { name: string; worst: number }) => [m.name, m.worst])).toEqual([
      ["glide_landed", 70],
      ["quiet_landed", 0],
    ]);
  });

  it("sums each kind of main-thread step of a second: how many, how long in all, the longest", async () => {
    // Task 9 fix 3: a picture's build runs in steps (a band drawn and read back, its PNG written); the line says what
    // each kind cost, so a long frame can be put down to the step that made it.
    vi.mocked(perfLogEnabled).mockResolvedValue(true);
    await startPerfRecorder();
    perfStep("picture_band", 3.04);
    perfStep("picture_band", 6.5);
    perfStep("picture_png", 1);
    await vi.advanceTimersByTimeAsync(1000);
    perfStep("picture_png", 2);
    await vi.advanceTimersByTimeAsync(1000);
    const [a, b] = lines();
    expect(a.steps).toEqual({ picture_band: { n: 2, ms: 9.5, worst: 6.5 }, picture_png: { n: 1, ms: 1, worst: 1 } });
    expect(b.steps).toEqual({ picture_png: { n: 1, ms: 2, worst: 2 } });
  });

  it("keeps no step while off", () => {
    perfStep("picture_band", 3);
    expect(perfOn()).toBe(false);
  });

  it("records nothing for a measure without its mark", async () => {
    vi.mocked(perfLogEnabled).mockResolvedValue(true);
    await startPerfRecorder();
    perfMeasure("none", "never-marked");
    await vi.advanceTimersByTimeAsync(1000);
    expect(lines()[0].measures).toEqual([]);
  });
});
