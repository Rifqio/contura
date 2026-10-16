import { expect, test } from "vitest";
import { objectKey, objectPrefix } from "./objectPath";

test("objectPrefix_adds_the_schema_when_there_is_one", () => {
  expect(objectPrefix({ database: "shop", schema: null, name: "orders" })).toBe("shop.");
  expect(objectPrefix({ database: "shop", schema: "sales", name: "orders" })).toBe("shop.sales.");
});

test("objectKey_tells_schemas_and_dotted_names_apart", () => {
  const key = (database: string, schema: string | null, name: string) =>
    objectKey("c1", "table", { database, schema, name });
  expect(key("shop", "public", "orders")).not.toBe(key("shop", "sales", "orders"));
  expect(key("shop", null, "orders")).not.toBe(key("shop", "", "orders"));
  expect(key("shop", "a.b", "c")).not.toBe(key("shop", "a", "b.c"));
  expect(key("a/b", null, "c")).not.toBe(key("a", null, "b/c"));
  expect(objectKey("c1", "table", { database: "shop", schema: null, name: "x" })).not.toBe(
    objectKey("c1", "view", { database: "shop", schema: null, name: "x" }),
  );
});
