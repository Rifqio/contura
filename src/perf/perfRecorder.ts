/**
 * An opt-in frame recorder for the release WebView's gates (Plan F Task 9). Off unless the app was started with
 * `CONTURA_PERF_LOG`: `startPerfRecorder` asks once, and while off `perfMark`, `perfMeasure` and `perfOn` do nothing
 * and allocate nothing. On, a requestAnimationFrame loop keeps frame deltas in a fixed ring, and once a second one JSON
 * line goes to the log: `t` (ms since start), `frames`, `worst`, `p95`, `over16`, `over50` and `measures` of that second.
 * Each measure is `{ name, ms, worst }`: `worst` is the longest frame between its mark and its end, so a glide's measure
 * carries the worst frame of that glide (ruling 7's crossing frame) whichever second's line it lands in. `steps` sums
 * each kind of main-thread step of that second (`perfStep`: a picture's band, its PNG, a redraw), as `{ n, ms, worst }`.
 */
import { perfLogAppend, perfLogEnabled } from "../api/client";

/** Frame deltas kept for the p95 of a second (a 240 Hz screen fits). */
export const RING_SIZE = 256;
/** Measures kept for one second's line; more are dropped. */
const MAX_MEASURES = 64;
/** Marks waiting for their measure (by name: a new mark of a name replaces the old). */
const MAX_MARKS = 32;

interface Measure {
  name: string;
  ms: number;
  /** The longest frame delta between the mark and the measure (0 with no frame between them). */
  worst: number;
}

let on = false;
let started = false;
let t0 = 0;
let last = 0;
let raf = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const ring = new Float64Array(RING_SIZE);
let ringN = 0;
let frames = 0;
let worst = 0;
let over16 = 0;
let over50 = 0;
let measures: Measure[] = [];
let steps = new Map<string, { n: number; ms: number; worst: number }>();
/** Kinds of step kept for one second's line; more are dropped. */
const MAX_STEP_KINDS = 16;
const marks = new Map<string, number>();
/** The longest frame delta since each waiting mark. */
const markWorst = new Map<string, number>();

/** True while the recorder is on: a caller guards extra work (a rAF just to measure) with it. */
export const perfOn = (): boolean => on;

export function perfMark(name: string): void {
  if (!on) return;
  if (marks.size >= MAX_MARKS && !marks.has(name)) return;
  marks.set(name, performance.now());
  markWorst.set(name, 0);
  performance.mark(name);
}

/** Ends the mark `startMark` (once: it is spent) as `name`, and records its duration for the next line. */
export function perfMeasure(name: string, startMark: string): void {
  if (!on) return;
  const from = marks.get(startMark);
  if (from === undefined) return;
  const worstFrame = markWorst.get(startMark) ?? 0;
  marks.delete(startMark);
  markWorst.delete(startMark);
  const ms = performance.now() - from;
  try {
    performance.measure(name, { start: from, end: from + ms });
  } catch {
    // The timeline is only for the WebView's own tools; the line below is the record.
  }
  if (measures.length < MAX_MEASURES) measures.push({ name, ms: Math.round(ms * 10) / 10, worst: Math.round(worstFrame * 10) / 10 });
}

/** Adds one main-thread step of kind `name` that took `ms` to this second's sums. */
export function perfStep(name: string, ms: number): void {
  if (!on) return;
  let s = steps.get(name);
  if (!s) {
    if (steps.size >= MAX_STEP_KINDS) return;
    s = { n: 0, ms: 0, worst: 0 };
    steps.set(name, s);
  }
  s.n++;
  s.ms += ms;
  if (ms > s.worst) s.worst = ms;
}

const tenth = (ms: number) => Math.round(ms * 10) / 10;

function frame(now: number) {
  if (!on) return;
  const dt = now - last;
  last = now;
  if (dt > 0 && dt < 10_000) {
    ring[ringN % RING_SIZE] = dt;
    ringN++;
    frames++;
    if (dt > worst) worst = dt;
    if (dt > 16.7) over16++;
    if (dt > 50) over50++;
    for (const [m, w] of markWorst) if (dt > w) markWorst.set(m, dt);
  }
  raf = requestAnimationFrame(frame);
}

function flush() {
  const n = Math.min(ringN, RING_SIZE);
  const sorted = Array.from(ring.subarray(0, n)).sort((a, b) => a - b);
  const p95 = n === 0 ? 0 : sorted[Math.min(n - 1, Math.ceil(n * 0.95) - 1)];
  const line = JSON.stringify({
    t: Math.round(performance.now() - t0),
    frames,
    worst: Math.round(worst * 10) / 10,
    p95: Math.round(p95 * 10) / 10,
    over16,
    over50,
    measures,
    steps: Object.fromEntries([...steps].map(([k, v]) => [k, { n: v.n, ms: tenth(v.ms), worst: tenth(v.worst) }])),
  });
  ringN = 0;
  frames = 0;
  worst = 0;
  over16 = 0;
  over50 = 0;
  measures = [];
  steps = new Map();
  void perfLogAppend(line).catch(() => {});
  // The timeline keeps every mark and measure: clear them so a long run does not grow it.
  performance.clearMarks();
  performance.clearMeasures();
}

/** Asks the app once whether the log is on, and starts only then. */
export async function startPerfRecorder(): Promise<void> {
  if (started) return;
  started = true;
  let enabled = false;
  try {
    enabled = await perfLogEnabled();
  } catch {
    enabled = false;
  }
  if (!enabled) return;
  on = true;
  t0 = last = performance.now();
  raf = requestAnimationFrame(frame);
  timer = setInterval(flush, 1000);
}

/** For tests: the ring's length and how much of it holds a delta. */
export const perfRingState = () => ({ size: ring.length, filled: Math.min(ringN, RING_SIZE) });

/** For tests: back to off, with nothing kept. */
export function stopPerfRecorder(): void {
  on = false;
  started = false;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  cancelAnimationFrame(raf);
  ringN = frames = over16 = over50 = 0;
  worst = 0;
  measures = [];
  steps = new Map();
  marks.clear();
  markWorst.clear();
}
