import { expect, test } from "vitest";
import { isOwnOrder, moveColumn, namesOfOrder, orderFromNames, ownOrder, shownOf } from "./columnOrder";

const NAMES = ["id", "customer_id", "status", "ordered_at", "total"];

test("the own order is every column in place", () => {
  expect(ownOrder(4)).toEqual([0, 1, 2, 3]);
  expect(isOwnOrder([0, 1, 2])).toBe(true);
  expect(isOwnOrder([1, 0, 2])).toBe(false);
  expect(isOwnOrder([])).toBe(true);
  // The shown part of the own order, a hidden column left out.
  expect(isOwnOrder([0, 2, 3])).toBe(true);
});

test("a column moves into the gap it is dropped on", () => {
  const all = ownOrder(5);
  // status before id: the gap 0.
  expect(moveColumn(all, all, 2, 0)).toEqual({ order: [2, 0, 1, 3, 4], at: 0 });
  // customer_id after total: the gap past the last column.
  expect(moveColumn(all, all, 1, 5)).toEqual({ order: [0, 2, 3, 4, 1], at: 4 });
  // id between ordered_at and total.
  expect(moveColumn(all, all, 0, 4)).toEqual({ order: [1, 2, 3, 0, 4], at: 3 });
});

test("a drop on either side of the column moves nothing", () => {
  const all = ownOrder(5);
  expect(moveColumn(all, all, 2, 2)).toBeNull();
  expect(moveColumn(all, all, 2, 3)).toBeNull();
  expect(moveColumn(all, all, -1, 0)).toBeNull();
  expect(moveColumn(all, all, 0, 6)).toBeNull();
});

test("move left and right are gaps one either side", () => {
  const all = ownOrder(3);
  expect(moveColumn(all, all, 1, 0)?.order).toEqual([1, 0, 2]);
  expect(moveColumn(all, all, 1, 3)?.order).toEqual([0, 2, 1]);
});

test("hidden columns keep their place while a shown one moves past them", () => {
  // customer_id (1) is hidden; shown: id, status, ordered_at, total.
  const order = ownOrder(5);
  const shown = shownOf(order, (c) => c === 1);
  expect(shown).toEqual([0, 2, 3, 4]);
  // id after status.
  expect(moveColumn(order, shown, 0, 2)).toEqual({ order: [1, 2, 0, 3, 4], at: 1 });
  // total first.
  expect(moveColumn(order, shown, 3, 0)).toEqual({ order: [4, 0, 1, 2, 3], at: 0 });
});

test("a remembered order comes back by name", () => {
  expect(orderFromNames(["status", "id", "customer_id", "ordered_at", "total"], NAMES)).toEqual([2, 0, 1, 3, 4]);
  expect(orderFromNames(null, NAMES)).toEqual([0, 1, 2, 3, 4]);
  expect(orderFromNames([], NAMES)).toEqual([0, 1, 2, 3, 4]);
});

test("a dropped column leaves the order, a new one goes in after its table neighbour", () => {
  // ordered_at was dropped; note was added after total, and code before everything.
  const now = ["code", "id", "customer_id", "status", "total", "note"];
  const saved = ["total", "status", "ordered_at", "id", "customer_id"];
  // total, status, id, customer_id remembered; code goes first (the table's first); note after total.
  expect(orderFromNames(saved, now).map((i) => now[i])).toEqual(["code", "total", "note", "status", "id", "customer_id"]);
});

test("a renamed column is a new one: the rest keep their order and none is lost", () => {
  const now = ["id", "customer", "status", "ordered_at", "total"];
  const saved = ["status", "id", "customer_id", "ordered_at", "total"];
  const order = orderFromNames(saved, now);
  expect(order.map((i) => now[i])).toEqual(["status", "id", "customer", "ordered_at", "total"]);
  expect([...order].sort()).toEqual([0, 1, 2, 3, 4]);
});

test("names repeated or unknown in a stored order are ignored", () => {
  expect(orderFromNames(["total", "total", "nope", "id"], NAMES).map((i) => NAMES[i])).toEqual([
    "total",
    "id",
    "customer_id",
    "status",
    "ordered_at",
  ]);
});

test("an order is remembered as names, and the own order as none", () => {
  expect(namesOfOrder([2, 0, 1, 3, 4], NAMES)).toEqual(["status", "id", "customer_id", "ordered_at", "total"]);
  expect(namesOfOrder([0, 1, 2, 3, 4], NAMES)).toBeNull();
});
