/** A duration the compact way: `38ms`, `1.5s`, `38s`, `2m 5s`. No space before a unit. */
export function durationText(ms: number): string {
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole}ms`;
  // Round to a tenth first, so 9,960 ms reads 10s rather than 10.0s.
  if (whole < 9950) return `${(whole / 1000).toFixed(1)}s`;
  const secs = Math.round(whole / 1000);
  if (secs < 60) return `${secs}s`;
  const rest = secs % 60;
  return rest === 0 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 60)}m ${rest}s`;
}

/** How long ago, short: `now`, `12m`, `2h`. `ms` is the time elapsed since; `now` is accepted for call-site symmetry. */
export function agoShort(ms: number, _now: Date): string {
  const ago = Math.max(0, ms);
  if (ago < 60_000) return "now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m`;
  return `${Math.floor(ago / 3_600_000)}h`;
}

/** How long ago with the word: `now`, `12m ago`, `2h ago`, `3d ago`. `ms` is the time elapsed since. */
export function agoText(ms: number): string {
  const ago = Math.max(0, ms);
  if (ago < 60_000) return "now";
  if (ago < 86_400_000) return `${agoShort(ago, new Date())} ago`;
  return `${Math.floor(ago / 86_400_000)}d ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A question's time: `Today 11:42`, `Yesterday 11:42`, `Oct 18 11:42`; `, now` while its answer is being written. */
export function dayClock(at: number, now: number, answering = false): string {
  const d = new Date(at);
  const midnight = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(d)) / 86_400_000);
  const day = days === 0 ? "Today" : days === 1 ? "Yesterday" : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${day} ${time}${answering ? ", now" : ""}`;
}
