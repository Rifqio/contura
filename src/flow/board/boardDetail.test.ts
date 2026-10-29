import { expect, test } from "vitest";
import tokensCss from "../../styles/tokens.css?raw";
import type { FrameBox } from "./boardScene";
import {
  BODY_PX,
  type BoardView,
  type DrawnForms,
  type FrameDrawInput,
  type FrameForm,
  farSizes,
  frameDraw,
  SKETCHES_REAL,
  sketchesFar,
  stepForms,
  stepSketches,
  swapBudget,
  SWAP_BUDGET_MIN,
  SWAP_BUDGET_SHAPES,
  tabHeight,
  textFarBelow,
  withLiveReal,
} from "./boardDetail";
import type { TextSize } from "./boardLayout";

const NONE: ReadonlySet<TextSize> = new Set();

function box(index: number, x: number, y = 100, w = 100, h = 100): FrameBox {
  return { key: `f${index}`, index, title: `F${index}`, kind: null, x, y, w, h, problems: 0, clash: false };
}

const VIEW: BoardView = { x: 0, y: 0, w: 1000, h: 800, zoom: 1 };

function input(boxes: FrameBox[], over: Partial<FrameDrawInput> = {}): FrameDrawInput {
  return {
    boxes,
    sizes: boxes.map(() => "m" as TextSize),
    shapes: boxes.map(() => 10),
    live: null,
    dragging: null,
    dragForm: null,
    view: VIEW,
    wasFar: NONE,
    ...over,
  };
}

test("thresholds_follow_the_text_size", () => {
  expect(textFarBelow("s")).toBeCloseTo(0.5245, 4);
  expect(textFarBelow("m")).toBeCloseTo(0.4615, 4);
  expect(textFarBelow("l")).toBeCloseTo(0.4013, 4);
});

test("body_px_matches_the_type_token", () => {
  expect(tokensCss).toContain(`--font-body-size: ${BODY_PX}px;`);
});

test("jitter_at_the_line_flips_once", () => {
  let far = NONE;
  const seen: boolean[] = [];
  for (const z of [0.47, 0.46, 0.47, 0.48, 0.46]) {
    far = farSizes(z, far);
    seen.push(far.has("m"));
  }
  expect(seen).toEqual([false, true, true, true, true]);
  expect(farSizes(0.5, far).has("m")).toBe(false);
});

test("the_tab_is_screen_size_below_100_percent", () => {
  expect(tabHeight(0.25)).toBeCloseTo(120, 9);
  expect(tabHeight(2)).toBe(30);
});

test("off_screen_frames_are_not_drawn", () => {
  const p = frameDraw(input([box(0, 100), box(1, 5000), box(2, -4000)]));
  expect([...p.form.keys()]).toEqual([0]);
});

test("a_frame_half_in_view_is_drawn", () => {
  const half = frameDraw(input([box(0, 950, 100)], { view: { ...VIEW, x: -100 } }));
  expect(half.form.has(0)).toBe(true);
  // Only the tab strip is inside the overscanned view: the box is below it, the tab (at tabHeight) reaches up.
  const view: BoardView = { x: 0, y: 0, w: 100, h: 100, zoom: 0.25 };
  const below = frameDraw(input([box(0, 0, 50 + 100 + 119, 100, 100)], { view }));
  expect(below.form.has(0)).toBe(true);
  const clear = frameDraw(input([box(0, 0, 50 + 100 + 121, 100, 100)], { view }));
  expect(clear.form.has(0)).toBe(false);
});

test("overscan_draws_a_frame_just_outside", () => {
  expect(frameDraw(input([box(0, 1400)])).form.has(0)).toBe(true);
  expect(frameDraw(input([box(0, 1600)])).form.has(0)).toBe(false);
});

test("a_far_frame_is_a_picture_and_a_readable_one_is_real", () => {
  const p = frameDraw(input([box(0, 0), box(1, 200)], { sizes: ["l", "s"], view: { ...VIEW, zoom: 0.45 } }));
  expect(p.form.get(0)).toBe("real");
  expect(p.form.get(1)).toBe("picture");
});

test("the_live_frame_is_always_real", () => {
  const p = frameDraw(input([box(0, 9000)], { live: 0, view: { ...VIEW, zoom: 0.2 } }));
  expect(p.form.get(0)).toBe("real");
});

test("a_dragged_frame_is_never_culled", () => {
  const p = frameDraw(input([box(0, 9000)], { dragging: 0, dragForm: "picture" }));
  expect(p.form.get(0)).toBe("picture");
});

test("past_3000_shapes_in_view_static_frames_simplify", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => box(i, i * 10));
  const p = frameDraw(input(twenty, { shapes: twenty.map(() => 200), live: 3 }));
  for (let i = 0; i < 20; i++) expect(p.form.get(i)).toBe(i === 3 ? "real" : "picture-text");
  const few = Array.from({ length: 19 }, (_, i) => box(i, i * 10));
  const q = frameDraw(input(few, { shapes: few.map(() => 150) }));
  expect([...q.form.values()].every((f) => f === "real")).toBe(true);
});

test("the_key_changes_only_with_the_plan", () => {
  const b = [box(0, 0), box(1, 200)];
  const a = frameDraw(input(b));
  const moved = frameDraw(input(b, { view: { ...VIEW, x: 5, zoom: 1 } }));
  expect(moved.key).toBe(a.key);
  expect(frameDraw(input(b, { view: { ...VIEW, zoom: 0.3 } })).key).not.toBe(a.key);
});

const AT = { x: 0, y: 0 };

function ten(): { target: ReturnType<typeof frameDraw>; shapes: number[]; centres: { x: number; y: number }[]; drawn: DrawnForms } {
  const boxes = Array.from({ length: 10 }, (_, i) => box(i, i * 120));
  const target = frameDraw(input(boxes, { shapes: boxes.map(() => 200) }));
  const pictured = new Map<number, FrameForm>(boxes.map((b) => [b.index, "picture"]));
  return {
    target,
    shapes: boxes.map(() => 200),
    centres: boxes.map((b) => ({ x: b.x + 50, y: b.y + 50 })),
    drawn: { form: pictured, mounted: new Map() },
  };
}

test("a_crossing_swaps_within_the_frame_budget", () => {
  const { target, shapes, centres } = ten();
  let { drawn } = ten();
  const toward = { x: 1100, y: 150 };
  const order: number[] = [];
  for (let step = 0; step < 40; step++) {
    const before = new Map(drawn.mounted);
    const beforeForm = drawn.form;
    drawn = stepForms(target, drawn, () => true, shapes, centres, toward, 80);
    let added = 0;
    for (let i = 0; i < 10; i++) {
      const was = beforeForm.get(i) === "real" ? 200 : (before.get(i) ?? 0);
      const now = drawn.form.get(i) === "real" ? 200 : (drawn.mounted.get(i) ?? 0);
      added += now - was;
      if (now > was && !order.includes(i)) order.push(i);
      if (drawn.form.get(i) === "picture") expect(drawn.mounted.get(i) ?? 0).toBeLessThan(200);
    }
    expect(added).toBeLessThanOrEqual(80);
  }
  expect(order[0]).toBe(9);
  expect(order.slice(0, 3)).toEqual([9, 8, 7]);
  expect([...drawn.form.values()].every((f) => f === "real")).toBe(true);
});

test("a_frame_turning_into_a_picture_waits_until_it_is_ready", () => {
  const boxes = [box(0, 0)];
  const target = frameDraw(input(boxes, { view: { ...VIEW, zoom: 0.3 } }));
  const drawn: DrawnForms = { form: new Map([[0, "real"]]), mounted: new Map() };
  const waiting = stepForms(target, drawn, () => false, [10], [AT], AT, 80);
  expect(waiting.form.get(0)).toBe("real");
  const done = stepForms(target, drawn, () => true, [10], [AT], AT, 80);
  expect(done.form.get(0)).toBe("picture");
});

test("a_frame_leaving_the_view_goes_at_once", () => {
  const target = frameDraw(input([box(0, 0), box(1, 9000)]));
  const drawn: DrawnForms = {
    form: new Map<number, FrameForm>([[0, "real"], [1, "real"]]),
    mounted: new Map(),
  };
  const next = stepForms(target, drawn, () => false, [10, 10], [AT, AT], AT, 0);
  expect(next.form.has(1)).toBe(false);
  expect(next.form.get(0)).toBe("real");
});

test("hysteresis_edges_are_exact", () => {
  for (const size of ["s", "m", "l"] as const) {
    const t = textFarBelow(size);
    const band = t * 1.08;
    expect(farSizes(t, NONE).has(size)).toBe(false);
    expect(farSizes(t - 1e-9, NONE).has(size)).toBe(true);
    const far: ReadonlySet<TextSize> = new Set([size]);
    expect(farSizes(t, far).has(size)).toBe(true);
    expect(farSizes(band - 1e-9, far).has(size)).toBe(true);
    expect(farSizes(band, far).has(size)).toBe(false);
  }
});

test("a_frame_that_was_live_waits_for_its_new_picture", () => {
  // Frame 0 went live from a picture and was edited; its drawn form may still say picture (a switch before its first
  // step). Live, it is real in the drawn forms; once frame 1 is live and frame 0 is planned a picture again, it stays
  // real until its new picture is ready, and only then is a picture.
  const boxes = [box(0, 0), box(1, 300)];
  const leftOver: DrawnForms = { form: new Map<number, FrameForm>([[0, "picture"], [1, "picture"]]), mounted: new Map([[0, 40]]) };
  const live0 = withLiveReal(leftOver, 0);
  expect(live0.form.get(0)).toBe("real");
  expect(live0.mounted.has(0)).toBe(false);
  expect(live0.form.get(1)).toBe("picture");
  // Without it, the left-over picture form is kept with no ready asked: the image from before the edit.
  const target = frameDraw(input(boxes, { live: 1, view: { ...VIEW, zoom: 0.3 } }));
  expect(target.form.get(0)).toBe("picture");
  expect(stepForms(target, leftOver, () => false, [10, 10], [AT, AT], AT, 80).form.get(0)).toBe("picture");
  // With it: real until ready, then the new picture.
  const after = withLiveReal(live0, 1);
  expect(stepForms(target, after, () => false, [10, 10], [AT, AT], AT, 80).form.get(0)).toBe("real");
  expect(stepForms(target, after, () => true, [10, 10], [AT, AT], AT, 80).form.get(0)).toBe("picture");
  // Nothing to change: the same object.
  const settled: DrawnForms = { form: new Map<number, FrameForm>([[0, "real"]]), mounted: new Map() };
  expect(withLiveReal(settled, 0)).toBe(settled);
  expect(withLiveReal(settled, null)).toBe(settled);
});

test("the_sketch_layer_is_pictured_only_while_body_text_is_far_and_nothing_works_on_it", () => {
  // Task 9 fix 2: below the readable zoom the sketches draw as pictures, as frames do.
  expect(sketchesFar(new Set<TextSize>(["s", "m"]), false)).toBe(true);
  expect(sketchesFar(new Set<TextSize>(["s"]), false)).toBe(false);
  expect(sketchesFar(NONE, false)).toBe(false);
  // A sketch picked or a sketch tool armed works on real sketches.
  expect(sketchesFar(new Set<TextSize>(["s", "m", "l"]), true)).toBe(false);
});

test("the_sketch_layer_turns_into_its_pictures_once_they_are_built_and_real_by_the_budget", () => {
  // Into pictures only once they are ready; until then real.
  expect(stepSketches(true, SKETCHES_REAL, false, 1_000, 20, false)).toBe(SKETCHES_REAL);
  const pictured = stepSketches(true, SKETCHES_REAL, true, 1_000, 20, false);
  expect(pictured).toEqual({ pictured: true, mounted: 0 });
  expect(stepSketches(true, pictured, true, 1_000, 20, false)).toBe(pictured);
  // Real again: 20 sketches a frame over the pictures, real once the last is in.
  let f = pictured;
  const steps: number[] = [];
  while (f.pictured) {
    f = stepSketches(false, f, true, 50, 20, false);
    steps.push(f.mounted);
  }
  expect(steps).toEqual([20, 40, 0]);
  expect(f).toBe(SKETCHES_REAL);
  // No budget left by the frames: nothing mounts, the same form.
  expect(stepSketches(false, pictured, true, 50, 0, false)).toBe(pictured);
  // Picked or armed: real at once.
  expect(stepSketches(false, pictured, true, 1_000, 20, true)).toBe(SKETCHES_REAL);
  // Far again while turning real: back to the pictures at once (they are built).
  expect(stepSketches(true, { pictured: true, mounted: 40 }, true, 1_000, 20, false)).toEqual({ pictured: true, mounted: 0 });
});

test("the_swap_budget_follows_the_last_frame", () => {
  // Task 9 fix 3: on the release WebView a mid zoom on B1's frames (f50nosk: 1,000 parts turning real from 52 percent)
  // ran 51 to 94 ms frames while 20 parts mounted each. The step reads the frame it follows: a frame over 50 ms mounts
  // nothing (the WebView catches up) and halves the budget, one over SWAP_FRAME_MS halves it, a quick one (under one
  // 60 Hz frame and a bit) doubles it back, never past SWAP_BUDGET_SHAPES nor under SWAP_BUDGET_MIN.
  let b = { now: SWAP_BUDGET_SHAPES, next: SWAP_BUDGET_SHAPES };
  b = swapBudget(b.next, 17);
  expect(b).toEqual({ now: SWAP_BUDGET_SHAPES, next: SWAP_BUDGET_SHAPES });
  b = swapBudget(b.next, 40);
  expect(b).toEqual({ now: SWAP_BUDGET_SHAPES / 2, next: SWAP_BUDGET_SHAPES / 2 });
  b = swapBudget(b.next, 80);
  expect(b).toEqual({ now: 0, next: SWAP_BUDGET_SHAPES / 4 });
  for (let i = 0; i < 5; i++) b = swapBudget(b.next, 90);
  expect(b).toEqual({ now: 0, next: SWAP_BUDGET_MIN });
  b = swapBudget(b.next, 16);
  expect(b.now).toBe(SWAP_BUDGET_MIN * 2);
  for (let i = 0; i < 5; i++) b = swapBudget(b.next, 16);
  expect(b.now).toBe(SWAP_BUDGET_SHAPES);
  // Between 20 and SWAP_FRAME_MS it holds.
  expect(swapBudget(10, 25)).toEqual({ now: 10, next: 10 });
});
