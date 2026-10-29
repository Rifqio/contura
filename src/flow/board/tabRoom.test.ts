// The tab strip's room by zoom intervals (re-review M1, M4): what a frame selects on a pan or zoom tick is one interval
// index, and the strip read from it is the same as working it out at that zoom.
import { expect, test } from "vitest";
import { breakIndex, byLeft, roomCss, stripAt, stripBreaks, stripFit, stripParts, tabNeighbours, tabRoom } from "./tabRoom";

/** A small seeded random, so a failure repeats. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function boards(seed: number, n: number) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, index) => ({ index, x: Math.round(r() * 4000), y: Math.round((r() - 0.5) * 600), w: 120 + Math.round(r() * 600) }));
}

const ZOOMS = Array.from({ length: 400 }, (_, i) => 0.1 + (i * 3.9) / 399);

test("the_staircase_of_neighbours_gives_the_same_room_as_every_frame", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const boxes = boards(seed, 30);
    const sorted = byLeft(boxes);
    for (const box of boxes) {
      const all = boxes.filter((b) => b.index !== box.index && b.x > box.x).map((b) => ({ dx: b.x - box.x, dy: b.y - box.y })).sort((a, b) => a.dx - b.dx);
      const few = tabNeighbours(box, sorted);
      expect(few.length).toBeLessThanOrEqual(all.length);
      for (const z of ZOOMS) expect(tabRoom(box.w, few, z)).toBe(tabRoom(box.w, all, z));
    }
  }
});

test("the_strip_read_from_its_interval_is_the_strip_at_that_zoom", () => {
  const parts = [stripParts({ kind: "flow", title: "Checkout", problems: 0 }, 0), stripParts({ kind: "er", title: "A long schema name here", problems: 12 }, 3)];
  for (let seed = 1; seed <= 20; seed++) {
    const boxes = boards(seed, 20);
    const sorted = byLeft(boxes);
    for (const box of boxes) {
      const near = tabNeighbours(box, sorted);
      for (const p of parts)
        for (const panes of [true, false]) {
          const breaks = stripBreaks(box.w, near, p, panes);
          for (const z of ZOOMS) {
            // Off the breaks themselves, where either side is right.
            if (breaks.some((b) => Math.abs(b - z) < 1e-9)) continue;
            const room = tabRoom(box.w, near, z);
            const fit = room === Infinity ? "all" : stripFit(roomCss(room, z), p, panes);
            expect(stripAt(box.w, near, p, panes, breaks, breakIndex(breaks, z))).toEqual({ room, fit });
          }
        }
    }
  }
});

test("a_frame_selects_one_number_per_tick", () => {
  // The interval index only changes at a break: between two, every zoom gives the same number.
  const near = [{ dx: 400, dy: 60 }, { dx: 900, dy: 0 }];
  const breaks = stripBreaks(320, near, stripParts({ kind: "flow", title: "Checkout", problems: 0 }, 0), true);
  expect(breaks.length).toBeGreaterThan(0);
  expect(new Set(ZOOMS.filter((z) => z < breaks[0]).map((z) => breakIndex(breaks, z))).size).toBe(1);
  expect(breakIndex(breaks, 4)).toBe(breaks.length);
});
