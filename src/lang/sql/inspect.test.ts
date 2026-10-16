import { expect, test } from "vitest";
import type { DialectKind } from "../../api/types";
import type { Diagnostic } from "../protocol";
import { analyzeSql } from "./analyze";
import { KFC_SCHEMA } from "./fixtures";
import { inspectSql } from "./inspect";
import type { SqlSchema } from "./types";

const run = (text: string, state: "loaded" | "loading" | "none" = "loaded", dialect: DialectKind = "postgres", schema: SqlSchema | null = KFC_SCHEMA) =>
  inspectSql(analyzeSql(text, dialect, state === "none" ? null : schema), text, dialect, state);
const titles = (d: Diagnostic | undefined) => d?.fixes.map((f) => f.title) ?? [];
const apply = (text: string, d: Diagnostic, i = 0) =>
  [...d.fixes[i].edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);

test("unknown_table_suggests_did_you_mean", () => {
  const text = "SELECT * FROM order";
  const d = run(text).find((x) => x.message.startsWith("Unknown table"));
  expect(d).toMatchObject({ severity: "error", message: "Unknown table order. Did you mean orders?", line: 1, column: 15 });
  expect(titles(d)).toEqual(["Change to orders"]);
  expect(apply(text, d!)).toBe("SELECT * FROM orders");
  expect(run("SELECT * FROM order o ORDER BY 1").some((x) => x.message.startsWith("Unknown table order."))).toBe(true);
});

test("unknown_table_offers_schema_qualification", () => {
  const text = "SELECT * FROM orders_2019";
  const d = run(text).find((x) => x.message.startsWith("Unknown table"));
  expect(titles(d)).toContain("Qualify as archive.orders_2019");
  expect(apply(text, d!, titles(d).indexOf("Qualify as archive.orders_2019"))).toBe("SELECT * FROM archive.orders_2019");
});

test("unknown_column_suggests_did_you_mean", () => {
  const text = "SELECT o.totl FROM orders o";
  const d = run(text).find((x) => x.message.startsWith("Unknown column"));
  expect(d).toMatchObject({ severity: "error", message: "Unknown column totl in sales.orders. Did you mean total?" });
  expect(apply(text, d!)).toBe("SELECT o.total FROM orders o");
  const bare = run("SELECT statu FROM orders").find((x) => x.message.startsWith("Unknown column"));
  expect(titles(bare)).toEqual(["Change to status"]);
});

test("ambiguous_column_offers_qualifying", () => {
  const text = "SELECT id FROM stores s JOIN orders o ON o.store_id = s.id";
  const d = run(text).find((x) => x.message.includes("ambiguous"));
  expect(d).toMatchObject({ severity: "error", from: 7, to: 9 });
  expect(titles(d).sort()).toEqual(["Qualify as o.id", "Qualify as s.id"]);
  expect(apply(text, d!, titles(d).indexOf("Qualify as o.id"))).toBe("SELECT o.id FROM stores s JOIN orders o ON o.store_id = s.id");
});

test("update_or_delete_without_where_warns", () => {
  const text = "DELETE FROM orders";
  const d = run(text).find((x) => x.severity === "warning");
  expect(d?.message).toBe("DELETE without WHERE changes every row in orders.");
  expect(titles(d)).toEqual(["Add WHERE"]);
  expect(apply(text, d!)).toBe("DELETE FROM orders\nWHERE ");
  expect(run("UPDATE stores SET name = 'x'").some((x) => x.message.startsWith("UPDATE without WHERE"))).toBe(true);
  expect(run("DELETE FROM orders WHERE id = 1").some((x) => x.severity === "warning")).toBe(false);
  // Shown with or without a schema: it does not depend on one.
  expect(run(text, "none").some((x) => x.severity === "warning")).toBe(true);
});

test("unused_alias_is_a_hint_with_remove", () => {
  const text = "SELECT id FROM stores s";
  const d = run(text).find((x) => x.message.startsWith("Alias"));
  expect(d).toMatchObject({ severity: "hint", message: "Alias s is never used." });
  expect(apply(text, d!)).toBe("SELECT id FROM stores");
  expect(run("SELECT s.id FROM stores s").some((x) => x.message.startsWith("Alias"))).toBe(false);
});

test("syntax_errors_point_at_the_spot", () => {
  const text = "SELECT count(* FROM orders";
  const d = run(text).find((x) => x.message === "This ( is never closed.");
  expect(d).toMatchObject({ from: 12, to: 13, line: 1, column: 13, severity: "error" });
  const extra = "SELECT 1)\nFROM orders";
  expect(run(extra).find((x) => x.message === "There is no ( for this ).")).toMatchObject({ line: 1, column: 9 });
  const comma = run("SELECT id,\nFROM stores");
  expect(comma.find((x) => x.message.startsWith("Expected a column after the comma"))).toMatchObject({ line: 2, column: 1 });
});

test("no_unknown_inspections_until_the_schema_loads", () => {
  const texts = ["SELECT * FROM order", "SELECT o.totl FROM orders o", "SELECT id FROM stores s JOIN orders o ON o.store_id = s.id"];
  for (const t of texts)
    for (const state of ["loading", "none"] as const) {
      const ds = run(t, state);
      expect(ds.some((x) => x.message.startsWith("Unknown") || x.message.includes("ambiguous"))).toBe(false);
    }
  // A schema loading again after a refresh keeps the last one but still waits.
  expect(run("SELECT * FROM order", "loading", "postgres", KFC_SCHEMA).some((x) => x.message.startsWith("Unknown"))).toBe(false);
  // Problems inside the query itself do not wait: a CTE has the columns it selects.
  const cte = run("WITH d AS (SELECT 1 AS n) SELECT d.m FROM d", "none");
  expect(cte.some((x) => x.message.startsWith("Unknown column m in d"))).toBe(true);
});
