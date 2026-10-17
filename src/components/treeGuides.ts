export interface TreeLine {
  id: string;
  level: number;
}

export interface RowGuides {
  /**
   * The columns whose vertical guide runs the full height of this row. Column k joins the
   * children at level k + 1, so it runs only while a later sibling at that level follows.
   */
  levels: number[];
  /** The column whose guide is drawn stronger on this row (the selection's parent level), or null. */
  strong: number | null;
  /**
   * The connector from the parent's column (`level`) to this row: a straight stub, or for the
   * last child an L-shaped elbow that ends the column. Null at level 0.
   */
  stub: { level: number; elbow: boolean; strong: boolean } | null;
}

/** Horizontal position of the guide for level `k`: 8 px padding + 20 px per level + 7 px to the chevron centre. */
export const guideX = (k: number) => 8 + 20 * k + 7;

/** Width of a stub: from the column to 2 px before the row's chevron or icon. */
export const STUB_WIDTH = 20 - 7 - 2;

/**
 * Guides for every row of the flattened tree (all rows, not only the ones on screen), with the
 * selection's parent level drawn stronger across its whole block.
 */
export function treeGuides(lines: readonly TreeLine[], selectedId: string | null): RowGuides[] {
  const s = lines.findIndex((l) => l.id === selectedId);
  const p = s >= 0 ? lines[s].level - 1 : -1; // the selection's parent level
  let from = s;
  let to = s;
  if (p >= 0) {
    while (from > 0 && lines[from - 1].level > p) from--; // up to the parent's first child
    while (to < lines.length - 1 && lines[to + 1].level > p) to++; // down to its last descendant
  }
  // laterSibling[m]: a later row sits at level m with nothing shallower in between. One pass from the end.
  const laterSibling: boolean[] = [];
  const out: RowGuides[] = new Array(lines.length);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const inBlock = p >= 0 && i >= from && i <= to;
    const levels: number[] = [];
    for (let k = 0; k < l.level; k++) if (laterSibling[k + 1]) levels.push(k);
    const elbow = l.level > 0 && !laterSibling[l.level];
    out[i] = {
      levels,
      strong: inBlock ? p : null,
      stub:
        l.level === 0
          ? null
          : { level: l.level - 1, elbow, strong: i === s || (elbow && inBlock && l.level === p + 1) },
    };
    laterSibling[l.level] = true;
    laterSibling.length = l.level + 1;
  }
  return out;
}
