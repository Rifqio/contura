// UX step 8: Back and Forward over followed keys, as in a browser, bounded per window.
import { expect, test } from "vitest";
import { NAV_LIMIT, type NavSpot, emptyNav, navBack, navForward, navPush } from "./navHistory";

const spot = (key: string, row = 0): NavSpot => ({
  key,
  selection: { connectionId: "c1", kind: "table", path: { database: "shop", schema: "public", name: key } },
  preview: false,
  filters: [],
  where: null,
  page: 0,
  sort: null,
  cell: { row, column: "id", key: null },
});

test("back_returns_where_you_were_and_forward_goes_again", () => {
  let h = navPush(emptyNav, spot("orders", 2));
  expect(h.back.map((s) => s.key)).toEqual(["orders"]);
  const b = navBack(h, spot("customers"))!;
  expect(b.to.key).toBe("orders");
  expect(b.to.cell).toEqual({ row: 2, column: "id", key: null });
  h = b.history;
  expect(h.back).toEqual([]);
  expect(h.forward.map((s) => s.key)).toEqual(["customers"]);
  const f = navForward(h, spot("orders", 4))!;
  expect(f.to.key).toBe("customers");
  // Leaving a place keeps where you are in it now, so Back returns to the cell you moved to.
  expect(f.history.back[0].cell).toEqual({ row: 4, column: "id", key: null });
});

test("nothing_to_go_back_or_forward_to", () => {
  expect(navBack(emptyNav, spot("orders"))).toBeNull();
  expect(navForward(emptyNav, spot("orders"))).toBeNull();
});

test("a_new_jump_drops_the_forward_list", () => {
  let h = navPush(navPush(emptyNav, spot("a")), spot("b"));
  h = navBack(h, spot("c"))!.history;
  expect(h.forward).toHaveLength(1);
  h = navPush(h, spot("b"));
  expect(h.forward).toEqual([]);
  expect(h.back.map((s) => s.key)).toEqual(["a", "b"]);
});

test("the_history_is_bounded", () => {
  let h = emptyNav;
  for (let i = 0; i < NAV_LIMIT + 10; i++) h = navPush(h, spot(`t${i}`));
  expect(NAV_LIMIT).toBe(50);
  expect(h.back).toHaveLength(NAV_LIMIT);
  // The oldest go first.
  expect(h.back[0].key).toBe("t10");
  // Forward is bounded too.
  let f = h;
  for (let i = 0; i < NAV_LIMIT; i++) f = navBack(f, spot(`here${i}`))!.history;
  expect(f.forward.length).toBeLessThanOrEqual(NAV_LIMIT);
});
