/** Edit distance between two strings, giving up early past `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** The loaded name closest to `word`, at most 2 edits away and not the word itself; ties go by name. */
export function nearName(word: string, names: string[]): string | null {
  const w = word.toLowerCase();
  let best: { name: string; d: number } | null = null;
  for (const name of names) {
    const d = distance(w, name.toLowerCase(), 2);
    if (d === 0) return null;
    if (d > 2) continue;
    if (!best || d < best.d || (d === best.d && name < best.name)) best = { name, d };
  }
  return best ? best.name : null;
}

/** The table or column a "does not exist" message names: the quoted part, after its last dot. */
export function missingName(message: string): string | null {
  const quoted = /(['"`])([^'"`]+)\1/.exec(message)?.[2] ?? /no such (?:table|column): ([\w.$]+)/i.exec(message)?.[1];
  if (!quoted) return null;
  return quoted.split(".").pop() || null;
}
