import { expect, test } from "vitest";
import { createHistory, HISTORY_CAP, record, redo, undo } from "./history";

const tick = () => new Promise<void>((r) => queueMicrotask(r));

test("undo steps back one gesture and redo steps forward again", async () => {
  const h = createHistory<number>();
  record(h, 1, { now: 0 });
  await tick();
  record(h, 2, { now: 0 });
  await tick();
  // The model is now 3.
  expect(undo(h, 3)).toBe(2);
  expect(undo(h, 2)).toBe(1);
  expect(undo(h, 1)).toBeNull();
  expect(redo(h, 1)).toBe(2);
  expect(redo(h, 2)).toBe(3);
  expect(redo(h, 3)).toBeNull();
});

test("a new change after an undo drops the redo steps", async () => {
  const h = createHistory<number>();
  record(h, 1, { now: 0 });
  await tick();
  expect(undo(h, 2)).toBe(1);
  record(h, 1, { now: 0 });
  expect(redo(h, 5)).toBeNull();
});

test("changes in one tick are one step (a multi-card drag)", async () => {
  const h = createHistory<number>();
  record(h, 1, { now: 0 });
  record(h, 2, { now: 0 });
  record(h, 3, { now: 0 });
  await tick();
  expect(undo(h, 4)).toBe(1);
  expect(undo(h, 1)).toBeNull();
});

test("typing in one field merges into one step, another field or a pause starts a new one", async () => {
  const h = createHistory<string>();
  record(h, "", { now: 0, merge: "f0" });
  await tick();
  record(h, "a", { now: 200, merge: "f0" });
  await tick();
  record(h, "ab", { now: 400, merge: "f0" });
  await tick();
  record(h, "abc", { now: 600, merge: "f1" });
  await tick();
  record(h, "x", { now: 5000, merge: "f1" });
  await tick();
  expect(undo(h, "y")).toBe("x");
  expect(undo(h, "x")).toBe("abc");
  expect(undo(h, "abc")).toBe("");
  expect(undo(h, "")).toBeNull();
});

test("history is capped so memory stays bounded", async () => {
  const h = createHistory<number>();
  for (let i = 0; i < HISTORY_CAP + 50; i++) {
    record(h, i, { now: 0 });
    await tick();
  }
  expect(h.past.length).toBe(HISTORY_CAP);
  expect(h.past[0]).toBe(50);
});

test("a_history_can_take_its_own_cap", async () => {
  const h = createHistory<number>();
  for (let i = 0; i < 250; i++) {
    record(h, i, { now: 0, cap: 200 });
    await tick();
  }
  expect(h.past.length).toBe(200);
  expect(h.past[0]).toBe(50);
});

test("without_grouping_each_record_in_one_tick_is_its_own_step", () => {
  // The Table Designer: a cell commit and the Add it came with are two steps, Ctrl+Z takes back one at a time.
  const h = createHistory<number>();
  record(h, 1, { now: 0, group: false });
  record(h, 2, { now: 0, group: false });
  expect(undo(h, 3)).toBe(2);
  expect(undo(h, 2)).toBe(1);
});

test("a_merge_without_grouping_still_ends_after_the_pause", () => {
  const h = createHistory<string>();
  record(h, "", { now: 0, merge: "name", group: false });
  record(h, "o", { now: 300, merge: "name", group: false });
  record(h, "or", { now: 5000, merge: "name", group: false });
  expect(h.past).toEqual(["", "or"]);
});
