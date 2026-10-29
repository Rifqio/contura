// The review across a board's frames (Decision 11): each frame the accepted changes land in, drawn as the overlay of
// its parse before the landing to its parse after it. Only touched and new frames are reviewed; the rest draw as they are.
import type { ProposedChange } from "../../api/types";
import { type BoardPlan, changeFrame, type TouchedFrame } from "./proposal";
import { type ReviewOverlay, reviewOverlay } from "./reviewOverlay";

/** One frame's review: what to draw and what is new, gone or changed in it, with its waiting count. */
export interface FrameReview extends ReviewOverlay {
  /** The accepted changes landing in the frame (a new frame's own add_frame included). */
  count: number;
  /** A frame the proposal adds: drawn as a dashed box at its proposed place. */
  isNew: boolean;
}

/** Records `from` renamed to `to`, following an earlier rename to `from` (a then b, then b then c, is a to c). */
function renameIn(m: Map<string, string>, from: string, to: string) {
  for (const [k, v] of m) if (v === from) return void m.set(k, to);
  m.set(from, to);
}

/** The map at `key` in `m`, made when it has none. */
function mapAt<V>(m: Map<string, Map<string, V>>, key: string): Map<string, V> {
  let at = m.get(key);
  if (!at) m.set(key, (at = new Map()));
  return at;
}

/**
 * Each touched or new frame's review, by title, from `plan` (the landing of `accepted`). A frame none of the accepted
 * changes land in has none. An accepted `rename_node` in a frame makes its shape one shape renamed, not one removed
 * and one added; an accepted `set_column` with a `name` makes its column one changed row. `board.titles` holds one
 * title per frame of the board, as `touchedFrames` and `planBoardLanding` take them.
 */
export function boardReview(
  touched: readonly TouchedFrame[],
  plan: BoardPlan,
  changes: ProposedChange[],
  accepted: ReadonlySet<number>,
  board: { titles: readonly string[] },
): Map<string, FrameReview> {
  const renames = new Map<string, Map<string, string>>();
  /** Per frame, by table as the change named it, its renamed columns. */
  const columns = new Map<string, Map<string, Map<string, string>>>();
  const counts = new Map<string, number>();
  // In index order, as they land, so renames chain.
  for (const c of changes.filter((x) => accepted.has(x.index)).sort((a, b) => a.index - b.index)) {
    const title = changeFrame(c, board.titles);
    if (title === null) continue;
    counts.set(title, (counts.get(title) ?? 0) + 1);
    if ("rename_node" in c.op) renameIn(mapAt(renames, title), c.op.rename_node.target, c.op.rename_node.name);
    else if ("set_column" in c.op) {
      const { table, column, name } = c.op.set_column;
      if (name && name !== column) renameIn(mapAt(mapAt(columns, title), table), column, name);
    }
  }
  const out = new Map<string, FrameReview>();
  for (const t of touched) {
    const after = plan.after.get(t.title)?.parse.doc;
    if (out.has(t.title) || !after) continue;
    const before = t.before.doc ?? { ...after, nodes: [], links: [], groups: [] };
    const named = renames.get(t.title);
    // Each table under its proposed name: a column change named it before or after the table's own rename.
    let cols: Map<string, Map<string, string>> | undefined;
    for (const [table, m] of columns.get(t.title) ?? []) {
      const final = named?.get(table) ?? table;
      const at = mapAt((cols ??= new Map<string, Map<string, string>>()), final);
      for (const [from, to] of m) renameIn(at, from, to);
    }
    out.set(t.title, { ...reviewOverlay(before, after, named, cols), count: counts.get(t.title) ?? 0, isNew: t.slice === null });
  }
  return out;
}
