import { expect, test } from "vitest";
import { errorText } from "./client";

test("errorText handles an absent message, a numeric message and an unknown kind", () => {
  expect(errorText({ kind: "noPrimaryKey" })).toBe(
    "This table has no primary key, so DB View cannot pick out one row to open the full value.",
  );
  expect(errorText({ kind: "valueTooLarge", message: 17 * 1024 * 1024 })).toBe(
    "This value is 17 MiB, more than the 16 MiB DB View opens at once.",
  );
  expect(errorText({ kind: "auth", message: "Access denied" })).toContain("Access denied");
  expect(errorText({ kind: "somethingNew", message: "disk full" })).toBe("Error (somethingNew): disk full");
  expect(errorText({ kind: "somethingNew" })).toBe("Error: somethingNew.");
  expect(errorText(new Error("network down"))).toBe("network down");
});
