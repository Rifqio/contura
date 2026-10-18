import { expect, test } from "vitest";
import type { ChildAction } from "../api/types";
import { warningText } from "./warnings";

test("a_sqlite_drop_names_what_it_does_to_each_child_table", () => {
  const t = (action: ChildAction, child: string) =>
    warningText({ kind: "childRows", table: "customers", child, action });
  expect(t("delete", "orders")).toBe("Dropping customers also deletes the matching rows in orders.");
  expect(t("clear", "notes")).toBe("Dropping customers also clears the key in notes on the matching rows, or fails if that key is required.");
  expect(t("setDefault", "tags")).toBe("Dropping customers also sets the key in tags to its default on the matching rows, or fails if that default is not NULL.");
  expect(t("fail", "audit")).toBe("Dropping customers fails while rows in audit point at it. Nothing is lost.");
});
