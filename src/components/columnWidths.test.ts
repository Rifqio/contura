import { expect, test } from "vitest";
import { GROW_CAP, fitColumns, headerFloor, headerWidth } from "./columnWidths";

test("header_never_narrower_than_its_label", () => {
  expect(fitColumns({ natural: [40], header: [96], available: 0, pinned: [null] })).toEqual([96]);
});

test("leftover_is_shared_out", () => {
  expect(fitColumns({ natural: [80, 80], header: [0, 0], available: 400, pinned: [null, null] })).toEqual([200, 200]);
});

test("growth_stops_at_the_cap", () => {
  expect(GROW_CAP).toBe(400);
  expect(fitColumns({ natural: [80], header: [0], available: 2000, pinned: [null] })).toEqual([400]);
});

test("resized_column_keeps_its_width", () => {
  expect(fitColumns({ natural: [80, 80], header: [0, 0], available: 400, pinned: [120, null] })).toEqual([120, 280]);
});

test("no_leftover_keeps_bases", () => {
  expect(fitColumns({ natural: [300, 250], header: [120, 260], available: 500, pinned: [null, null] })).toEqual([
    300, 260,
  ]);
  expect(fitColumns({ natural: [80, 80], header: [0, 0], available: 160, pinned: [null, null] })).toEqual([80, 80]);
});

test("odd_leftover_goes_to_the_first_columns_in_whole_px", () => {
  expect(fitColumns({ natural: [10, 10, 10], header: [0, 0, 0], available: 35, pinned: [null, null, null] })).toEqual([
    12, 12, 11,
  ]);
});

test("a_capped_column_passes_its_share_on", () => {
  expect(fitColumns({ natural: [380, 80], header: [0, 0], available: 900, pinned: [null, null] })).toEqual([400, 400]);
  expect(fitColumns({ natural: [380, 80], header: [0, 0], available: 600, pinned: [null, null] })).toEqual([400, 200]);
});

test("a_column_wider_than_the_cap_keeps_its_width", () => {
  expect(fitColumns({ natural: [520, 80], header: [0, 0], available: 800, pinned: [null, null] })).toEqual([520, 280]);
});

function el(className: string, size: { offset?: number; scroll?: number }): HTMLElement {
  const e = document.createElement("span");
  e.className = className;
  Object.defineProperty(e, "offsetWidth", { value: size.offset ?? 0 });
  Object.defineProperty(e, "scrollWidth", { value: size.scroll ?? size.offset ?? 0 });
  return e;
}

test("header_width_takes_the_whole_name_the_type_hint_and_the_icons", () => {
  // A column laid out narrower than its header clips the name ("stat..."): the label's own
  // scrollWidth then misses the clipped part, so the name's full width is read instead.
  const label = el("header-label", { offset: 90, scroll: 90 });
  label.style.columnGap = "6px";
  label.append(
    el("key-icon", { offset: 14 }),
    el("header-name", { offset: 30, scroll: 120 }),
    el("type-hint", { offset: 50 }),
    el("sort-slot", { offset: 14 }),
  );
  expect(headerWidth(label, 16)).toBe(14 + 120 + 50 + 14 + 3 * 6 + 16);
});

test("header_width_rounds_up_from_the_fractional_widths", () => {
  // At 124% zoom "id" is 10.01 px and INTEGER 46.21 px while offsetWidth says 10 and 46:
  // rounding down left the label 0.02 px short and the name showed as "i...".
  const label = el("header-label", {});
  label.style.columnGap = "6px";
  const name = el("header-name", { offset: 10, scroll: 10 });
  const hint = el("type-hint", { offset: 46 });
  name.getBoundingClientRect = () => ({ width: 10.01 }) as DOMRect;
  hint.getBoundingClientRect = () => ({ width: 46.21 }) as DOMRect;
  label.append(name, hint);
  // 16 px of padding and the 0.8 px header border.
  expect(headerWidth(label, 16.8)).toBe(80);
});

test("header_width_without_icons", () => {
  const label = el("header-label", {});
  label.style.columnGap = "6px";
  label.append(el("header-name", { offset: 10, scroll: 64 }), el("type-hint", { offset: 40 }));
  expect(headerWidth(label, 16)).toBe(64 + 40 + 6 + 16);
});

test("type_truncates_before_the_name", () => {
  // The least a header can be dragged to keeps the whole name, the icons and the padding; only the type hint gives way.
  const label = el("header-label", {});
  label.style.columnGap = "6px";
  label.append(
    el("key-icon", { offset: 14 }),
    el("header-name", { offset: 30, scroll: 40 }),
    el("type-hint", { offset: 50 }),
    el("sort-slot", { offset: 14 }),
  );
  expect(headerFloor(label, 16)).toBe(14 + 40 + 14 + 2 * 6 + 16);
});
