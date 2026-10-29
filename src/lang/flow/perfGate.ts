// The flow perf gate: the best of three 20-run medians. Noise from other processes only ever adds
// time, so the best batch shows what the code costs; a slow parser is still slow in all three.
export function bestMedian(work: (run: number) => void, batches = 3, runs = 20): number {
  let best = Number.POSITIVE_INFINITY;
  let run = 0;
  for (let b = 0; b < batches; b++) {
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      work(run++);
      times.push(performance.now() - start);
    }
    times.sort((x, y) => x - y);
    const mid = runs / 2;
    best = Math.min(best, runs % 2 ? times[Math.floor(mid)] : (times[mid - 1] + times[mid]) / 2);
  }
  return best;
}
