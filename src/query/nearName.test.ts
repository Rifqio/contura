import { expect, test } from "vitest";
import { missingName, nearName } from "./nearName";

test("near_name_finds_a_close_table", () => {
  expect(nearName("shipment", ["shipments", "carriers"])).toBe("shipments");
  expect(nearName("SHIPMENT", ["shipments"])).toBe("shipments");
});
test("far_names_give_null", () => {
  expect(nearName("orders", ["customers"])).toBeNull();
  expect(nearName("abcdef", ["abcxyz1"])).toBeNull();
});
test("the_nearest_wins_and_ties_go_by_name", () => {
  expect(nearName("cat", ["cats", "cap", "cab"])).toBe("cab");
  expect(nearName("cat", ["cart", "cats"])).toBe("cart");
});
test("an_exact_name_needs_no_suggestion", () => {
  expect(nearName("orders", ["orders"])).toBeNull();
});
test("missing_name_reads_the_quoted_name_from_the_message", () => {
  expect(missingName("Table 'shop.shipment' doesn't exist")).toBe("shipment");
  expect(missingName('relation "menu_itms" does not exist')).toBe("menu_itms");
  expect(missingName("no such table: orders")).toBe("orders");
  expect(missingName("syntax error")).toBeNull();
});
