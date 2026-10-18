import { describe, expect, it } from "vitest";
import { nounFor } from "./nouns";

describe("nounFor", () => {
  it.each([
    ["orders", "order", "orders"],
    ["menu_items", "menu item", "menu items"],
    ["order_items", "order item", "order items"],
    ["order_line", "order line", "order lines"],
    ["address", "address", "addresses"],
    ["addresses", "address", "addresses"],
    ["status", "status", "statuses"],
    ["bus", "bus", "buses"],
    ["batch", "batch", "batches"],
    ["box", "box", "boxes"],
    ["boxes", "box", "boxes"],
    ["analysis", "analysis", "analyses"],
    ["data", "data", "data"],
    ["news", "news", "news"],
    ["series", "series", "series"],
    ["information", "information", "information"],
    ["movies", "movie", "movies"],
    ["people", "person", "people"],
    ["categories", "category", "categories"],
    ["category", "category", "categories"],
    ["day", "day", "days"],
    ["person", "person", "persons"],
    ["PERSON", "PERSON", "PERSONS"],
    ["ORDERS", "ORDER", "ORDERS"],
    ["Categories", "Category", "Categories"],
    ["BOX", "BOX", "BOXES"],
    ["store_status", "store status", "store statuses"],
  ])("%s gives %s and %s", (name, one, many) => {
    expect(nounFor(name)).toEqual({ one, many });
  });

  it("takes a table object", () => {
    expect(nounFor({ name: "stores" })).toEqual({ one: "store", many: "stores" });
  });

  it.each([
    ["sizes", "size", "sizes"],
    ["houses", "house", "houses"],
    ["purchases", "purchase", "purchases"],
    ["courses", "course", "courses"],
    ["expenses", "expense", "expenses"],
    ["warehouses", "warehouse", "warehouses"],
    ["aliases", "alias", "aliases"],
    ["statuses", "status", "statuses"],
    ["quizzes", "quiz", "quizzes"],
    ["order_sizes", "order size", "order sizes"],
    ["user_aliases", "user alias", "user aliases"],
  ])("%s is %s and %s", (name, one, many) => {
    expect(nounFor(name)).toEqual({ one, many });
  });

  it.each(["menus", "gurus"])(
    "%s is a word the rules are unsure of, so it keeps the table name",
    (name) => {
      expect(nounFor(name)).toEqual({ one: name, many: name });
    },
  );
});
