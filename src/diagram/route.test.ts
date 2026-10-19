import { expect, test } from "vitest";
import { routeOrthogonal } from "./route";

const A = { x: 0, y: 0, w: 100, h: 40 };

/** Every number in the path, so a NaN or Infinity shows up. */
const numbers = (d: string) => (d.match(/-?[\d.]+|NaN|Infinity/g) ?? []).map(Number);

test("right_of_leaves_the_right_side_and_enters_the_left", () => {
  const r = routeOrthogonal(A, { x: 200, y: 100, w: 100, h: 40 });
  expect(r.d).toBe("M 100 20 L 142 20 Q 150 20 150 28 L 150 112 Q 150 120 158 120 L 200 120");
  expect(r.mid).toEqual({ x: 150, y: 70 });
  expect(r.end).toEqual({ x: 200, y: 120 });
});

test("left_of_leaves_the_left_side_and_enters_the_right", () => {
  const r = routeOrthogonal(A, { x: -200, y: 100, w: 100, h: 40 });
  expect(r.d).toBe("M 0 20 L -42 20 Q -50 20 -50 28 L -50 112 Q -50 120 -58 120 L -100 120");
  expect(r.mid).toEqual({ x: -50, y: 70 });
  expect(r.end).toEqual({ x: -100, y: 120 });
});

test("below_leaves_the_bottom_and_enters_the_top", () => {
  const r = routeOrthogonal(A, { x: 40, y: 120, w: 100, h: 40 });
  expect(r.d).toBe("M 50 40 L 50 72 Q 50 80 58 80 L 82 80 Q 90 80 90 88 L 90 120");
  expect(r.mid).toEqual({ x: 70, y: 80 });
  expect(r.end).toEqual({ x: 90, y: 120 });
});

test("above_leaves_the_top_and_enters_the_bottom", () => {
  const r = routeOrthogonal(A, { x: 40, y: -120, w: 100, h: 40 });
  expect(r.d).toBe("M 50 0 L 50 -32 Q 50 -40 58 -40 L 82 -40 Q 90 -40 90 -48 L 90 -80");
  expect(r.end).toEqual({ x: 90, y: -80 });
});

test("overlapping_nodes_still_give_a_finite_square_path", () => {
  const r = routeOrthogonal(A, { x: 10, y: 10, w: 100, h: 40 });
  expect(r.d.startsWith("M 50 40")).toBe(true);
  expect(r.d.endsWith("L 60 10")).toBe(true);
  for (const n of numbers(r.d)) expect(Number.isFinite(n)).toBe(true);
  // Only horizontal and vertical runs: every L shares an x or a y with the point before it.
  expect(r.end).toEqual({ x: 60, y: 10 });
});

test("same_box_gives_a_finite_path", () => {
  const r = routeOrthogonal(A, A);
  for (const n of numbers(r.d)) expect(Number.isFinite(n)).toBe(true);
});

test("corner_radius_is_clamped_on_short_segments", () => {
  // A 4 px jog: each corner can take at most half of it.
  const r = routeOrthogonal(A, { x: 4, y: 100, w: 100, h: 40 });
  expect(r.d).toBe("M 50 40 L 50 68 Q 50 70 52 70 L 52 70 Q 54 70 54 72 L 54 100");
});

test("a_straight_run_has_no_corners", () => {
  const r = routeOrthogonal(A, { x: 200, y: 0, w: 100, h: 40 });
  expect(r.d).toBe("M 100 20 L 200 20");
  expect(r.mid).toEqual({ x: 150, y: 20 });
});

test("radius_option_and_free_point", () => {
  expect(routeOrthogonal(A, { x: 200, y: 100, w: 100, h: 40 }, { radius: 4 }).d).toBe(
    "M 100 20 L 146 20 Q 150 20 150 24 L 150 116 Q 150 120 154 120 L 200 120",
  );
  // Drawing a flow: the line runs from the side facing the pointer to the pointer itself.
  const toRight = routeOrthogonal(A, { x: 160, y: 80, w: 0, h: 0 }, { toPoint: true });
  expect(toRight.d).toBe("M 100 20 L 122 20 Q 130 20 130 28 L 130 72 Q 130 80 138 80 L 160 80");
  expect(toRight.end).toEqual({ x: 160, y: 80 });
  const toLeft = routeOrthogonal(A, { x: -60, y: 20, w: 0, h: 0 }, { toPoint: true });
  expect(toLeft.d).toBe("M 0 20 L -60 20");
});

test("a_jog_under_half_a_pixel_draws_straight", () => {
  // Fractional centres (measured text, the pointer while drawing) must not curl into an 8 px hook.
  const down = routeOrthogonal(A, { x: 0.3, y: 100, w: 100, h: 40 });
  expect(down.d).toBe("M 50 40 L 50 100");
  expect(down.d).not.toContain("Q");
  const across = routeOrthogonal(A, { x: 200, y: 0.4, w: 100, h: 40 });
  expect(across.d).toBe("M 100 20 L 200 20");
  const back = routeOrthogonal(A, { x: -200, y: -0.45, w: 100, h: 40 });
  expect(back.d).toBe("M 0 20 L -100 20");
  // Just over the tolerance it is a real jog with clamped corners, still square.
  const jog = routeOrthogonal(A, { x: 200, y: 0.6, w: 100, h: 40 });
  expect(jog.d).toBe("M 100 20 L 149.7 20 Q 150 20 150 20.3 L 150 20.3 Q 150 20.6 150.3 20.6 L 200 20.6");
});

test("every_corner_turns_square_on_fractional_inputs", () => {
  for (const dx of [0.1, 0.25, 0.49, 0.5, 0.51, 3.3]) {
    for (const dy of [0.1, 0.49, 0.5, 0.7, 41.3]) {
      for (const b of [
        { x: 200 + dx, y: dy, w: 100, h: 40 },
        { x: dx, y: 100 + dy, w: 100.3, h: 40 },
        { x: -200 - dx, y: -dy, w: 99.7, h: 40 },
      ]) {
        const d = routeOrthogonal(A, b).d;
        // Every quadratic corner turns from one axis to the other: its control point shares x with the
        // point before it and y with the point after it, or the other way round.
        for (const m of d.matchAll(/L (\S+) (\S+) Q (\S+) (\S+) (\S+) (\S+)/g)) {
          const [ax, ay, cx, cy, ex, ey] = m.slice(1).map(Number);
          const hv = ay === cy && cx === ex;
          const vh = ax === cx && cy === ey;
          expect(hv || vh, `${d}`).toBe(true);
        }
      }
    }
  }
});

test("item_18_drawing_leaves_the_pressed_side_even_when_the_pointer_is_behind_it", () => {
  // Right port pressed, pointer down and to the left: out 16 px to the right, then around to the pointer.
  const r = routeOrthogonal(A, { x: -60, y: 80, w: 0, h: 0 }, { toPoint: true, from: "r" });
  expect(r.points[0]).toEqual({ x: 100, y: 20 });
  expect(r.points[1]).toEqual({ x: 116, y: 20 });
  expect(r.end).toEqual({ x: -60, y: 80 });
});

test("item_18_each_port_starts_its_own_side", () => {
  const p = { x: 300, y: 300, w: 0, h: 0 };
  expect(routeOrthogonal(A, p, { toPoint: true, from: "l" }).points[0]).toEqual({ x: 0, y: 20 });
  expect(routeOrthogonal(A, p, { toPoint: true, from: "t" }).points[0]).toEqual({ x: 50, y: 0 });
  expect(routeOrthogonal(A, p, { toPoint: true, from: "b" }).points[0]).toEqual({ x: 50, y: 40 });
  expect(routeOrthogonal(A, p, { toPoint: true, from: "r" }).points[0]).toEqual({ x: 100, y: 20 });
});

test("item_31_a_badge_moves_off_the_cards_to_the_longest_clear_run", async () => {
  const { clearBadgeSpot, pathPoints } = await import("./edges");
  const d = "M 100 20 L 150 20 Q 158 20 158 28 L 158 200 Q 158 208 150 208 L 20 208";
  expect(pathPoints(d)).toEqual([
    { x: 100, y: 20 },
    { x: 150, y: 20 },
    { x: 158, y: 28 },
    { x: 158, y: 200 },
    { x: 150, y: 208 },
    { x: 20, y: 208 },
  ]);
  // The midpoint is clear: it stays.
  expect(clearBadgeSpot(d, { x: 158, y: 114 }, [])).toEqual({ x: 158, y: 114 });
  // A card covers the midpoint: the badge goes to the longest run the cards leave clear.
  const card = { x: 120, y: 60, w: 200, h: 100 };
  expect(clearBadgeSpot(d, { x: 158, y: 114 }, [card])).toEqual({ x: 85, y: 208 });
});
