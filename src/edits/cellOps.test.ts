import { expect, test } from "vitest";
import { constantDefault } from "./cellOps";

test("M12: constant defaults with casts on NULL and nested parentheses are constants", () => {
  expect(constantDefault("NULL::character varying")).toEqual({ value: { t: "null" } });
  expect(constantDefault("((0))")).toEqual({ value: { t: "text", value: "0" } });
  expect(constantDefault("(N'x')")).toEqual({ value: { t: "text", value: "x" } });
  expect(constantDefault("'it''s'::text")).toEqual({ value: { t: "text", value: "it's" } });
  expect(constantDefault("now()")).toEqual({ expression: "now()" });
  expect(constantDefault("nextval('orders_id_seq'::regclass)")).toEqual({ expression: "nextval('orders_id_seq'::regclass)" });
});
