import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

/** Rows drawn beyond each edge of the viewport. */
const OVERSCAN = 8;

export interface Windowed {
  /** First and one-past-last row drawn. */
  start: number;
  end: number;
  /** Heights of the spacers above and below the drawn rows, so every row keeps its place. */
  before: number;
  after: number;
  onScroll(): void;
  /** Scrolls row `i` into view, as the keys move the selection. */
  scrollToIndex(i: number): void;
}

/**
 * Only the rows on screen are drawn (the object tree's pattern, with per-row heights for the
 * Sync list's two-line items). A hidden or unlaid-out scroller (a test DOM) draws a window's worth.
 */
export function useWindowed(heights: readonly number[], scroller: RefObject<HTMLElement | null>): Windowed {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const offsets = useMemo(() => {
    const out = new Array<number>(heights.length + 1);
    out[0] = 0;
    for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i];
    return out;
  }, [heights]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && el.clientHeight !== viewport) setViewport(el.clientHeight);
  });
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroller]);

  const view = viewport > 0 ? viewport : window.innerHeight;
  const count = heights.length;
  /** The row at pixel `y`: the last offset at or before it. */
  const rowAt = (y: number) => {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(lo, Math.max(0, count - 1));
  };
  const start = count === 0 ? 0 : Math.max(0, rowAt(scrollTop) - OVERSCAN);
  const end = count === 0 ? 0 : Math.min(count, rowAt(scrollTop + view) + 1 + OVERSCAN);

  const scrollToIndex = useCallback(
    (i: number) => {
      const el = scroller.current;
      if (!el || i < 0 || i >= count) return;
      const top = offsets[i];
      const bottom = offsets[i + 1];
      const h = el.clientHeight > 0 ? el.clientHeight : window.innerHeight;
      let next = el.scrollTop;
      if (top < next) next = top;
      else if (bottom > next + h) next = bottom - h;
      if (next !== el.scrollTop) el.scrollTop = next;
      setScrollTop(el.scrollTop);
    },
    [scroller, offsets, count],
  );

  return {
    start,
    end,
    before: offsets[start] ?? 0,
    after: (offsets[count] ?? 0) - (offsets[end] ?? 0),
    onScroll: () => setScrollTop(scroller.current?.scrollTop ?? 0),
    scrollToIndex,
  };
}
