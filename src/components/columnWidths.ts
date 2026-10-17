/** Free space never grows a column past this width (one already wider keeps its own). */
export const GROW_CAP = 400;

/**
 * The width a header needs to show in full: each part of its `.header-label` (key icon,
 * name, type hint, sort slot), the gaps between them and the side padding. The name is
 * read by its scrollWidth, since a column laid out narrower than its header clips the
 * name inside its own box and the label's scrollWidth then misses that part. Widths are
 * taken unrounded and the total rounded up: at a zoom like 124% the parts are fractional,
 * and a label even 0.02 px short shows its name with an ellipsis. `padding` covers the
 * side padding and the header's border.
 */
export function headerWidth(label: HTMLElement, padding: number, withType = true): number {
  const parts = Array.from(label.children).filter((p) => withType || !p.classList.contains("type-hint"));
  const gap = parseFloat(getComputedStyle(label).columnGap) || 0;
  // An icon is an <svg>, which has no offsetWidth.
  const width = (p: Element) => {
    const exact = p.getBoundingClientRect().width || 0;
    if (!(p instanceof HTMLElement)) return exact;
    const whole = p.classList.contains("header-name") ? Math.max(p.scrollWidth, p.offsetWidth) : p.offsetWidth;
    return Math.max(exact, whole);
  };
  const sum = parts.reduce((a, p) => a + width(p), 0);
  return Math.ceil(sum + gap * Math.max(0, parts.length - 1) + padding);
}

/** The side padding and borders a header cell takes from its label. */
export function headerPadding(th: HTMLElement, padding: number): number {
  const cs = getComputedStyle(th);
  return padding + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
}

/**
 * The least a column can be dragged to: the whole name, the icons and the padding. Only the type
 * hint gives way below `headerWidth`, so a name is never cut before its type (E8).
 */
export const headerFloor = (label: HTMLElement, padding: number): number => headerWidth(label, padding, false);

/**
 * Column widths in whole px. A column starts at its pinned width (a user
 * resize) or else the wider of its content and its header; space left in the
 * pane is shared equally among the unpinned columns up to the cap, any odd
 * pixels going to the first of them.
 */
export function fitColumns(o: {
  natural: number[];
  header: number[];
  available: number;
  pinned: (number | null)[];
}): number[] {
  const out = o.natural.map((n, i) => Math.round(o.pinned[i] ?? Math.max(n, o.header[i] ?? 0)));
  const caps = out.map((w) => Math.max(w, GROW_CAP));
  let left = Math.floor(o.available - out.reduce((a, b) => a + b, 0));
  let open = out.map((_, i) => i).filter((i) => o.pinned[i] == null && out[i] < caps[i]);
  while (left > 0 && open.length > 0) {
    const share = Math.floor(left / open.length);
    const extra = left - share * open.length;
    open.forEach((i, k) => {
      const add = Math.min(share + (k < extra ? 1 : 0), caps[i] - out[i]);
      out[i] += add;
      left -= add;
    });
    open = open.filter((i) => out[i] < caps[i]);
  }
  return out;
}
