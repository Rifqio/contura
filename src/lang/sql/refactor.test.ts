import { expect, test } from "vitest";
import type { TextEdit } from "../protocol";
import { analyzeSql } from "./analyze";
import { at, KFC_SCHEMA } from "./fixtures";
import { definitionAt, expandStar, parameterHints, renameBlocked, renameTargets } from "./refactor";

const pg = (text: string) => analyzeSql(text, "postgres", KFC_SCHEMA);
const apply = (text: string, edits: TextEdit[]) =>
  [...edits].sort((a, b) => b.from - a.from).reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
const slices = (text: string, rs: { from: number; to: number }[] | null) => rs?.map((r) => text.slice(r.from, r.to));

test("expand_star_lists_columns_and_qualifies_with_joins", () => {
  const one = "SELECT * FROM stores";
  expect(apply(one, expandStar(pg(one), one, 7)!)).toBe("SELECT id, code, name, city, opened_on, is_active FROM stores");
  const two = "SELECT * FROM stores s JOIN orders o ON o.store_id = s.id";
  const out = apply(two, expandStar(pg(two), two, 8)!);
  expect(out).toContain("s.id, s.code, s.name, s.city, s.opened_on, s.is_active,\n       o.id, o.store_id");
  const q = "SELECT o.* FROM stores s JOIN orders o ON o.store_id = s.id";
  expect(apply(q, expandStar(pg(q), q, 9)!)).toBe(
    "SELECT o.id, o.store_id, o.customer_id, o.channel, o.status, o.total, o.placed_at FROM stores s JOIN orders o ON o.store_id = s.id",
  );
  // Not on a star, or a star over an unknown table: nothing.
  expect(expandStar(pg(one), one, 15)).toBeNull();
  const unk = "SELECT * FROM nope";
  expect(expandStar(pg(unk), unk, 7)).toBeNull();
});

test("rename_targets_cover_declaration_and_uses", () => {
  const text = "SELECT o.id, o.total FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.status = 'paid'";
  const a = pg(text);
  const rs = renameTargets(a, text.indexOf("o.total"));
  expect(slices(text, rs)).toEqual(["o", "o", "o", "o", "o"]);
  expect(rs).toEqual(renameTargets(a, text.indexOf("orders o") + 7));
  const cte = "WITH d AS (SELECT 1 AS n) SELECT d.n FROM d JOIN d d2 ON true";
  const cr = renameTargets(pg(cte), cte.indexOf("d.n"));
  expect(cr?.map((r) => r.from)).toEqual([5, 33, 42, 49]);
  // A table or a column is renamed in the database, not here.
  expect(renameTargets(a, text.indexOf("orders"))).toBeNull();
  expect(renameBlocked(a, text.indexOf("orders"))).toContain("Table Designer");
  expect(renameBlocked(a, text.indexOf("total"))).toContain("Renaming a column");
  expect(renameTargets(a, text.indexOf("'paid'") + 2)).toBeNull();
});

test("definition_of_an_alias_is_its_declaration", () => {
  const text = "SELECT o.id FROM orders o";
  expect(definitionAt(pg(text), 7)).toEqual({ kind: "range", range: { from: 24, to: 25 } });
  const cte = "WITH d AS (SELECT 1 AS n) SELECT d.n FROM d";
  const a = pg(cte);
  expect(definitionAt(a, cte.lastIndexOf("d"))).toEqual({ kind: "range", range: { from: 5, to: 6 } });
  // A CTE's column goes to where the CTE names it.
  expect(definitionAt(a, cte.indexOf("d.n") + 2)).toEqual({ kind: "range", range: { from: 23, to: 24 } });
});

test("definition_of_a_table_names_it", () => {
  const text = "SELECT o.total FROM orders o";
  const a = pg(text);
  expect(definitionAt(a, text.indexOf("orders"))).toEqual({ kind: "table", schema: "sales", name: "orders" });
  expect(definitionAt(a, text.indexOf("total"))).toEqual({ kind: "table", schema: "sales", name: "orders", column: "total" });
  expect(definitionAt(pg("SELECT count(*) FROM orders"), 8)).toBeNull();
});

test("parameter_hints_track_the_argument", () => {
  const p = at("SELECT date_trunc('day', |");
  expect(parameterHints(pg(p.text), p.text, p.pos, "postgres")).toEqual({
    name: "date_trunc",
    signatures: [
      ["field text", "source timestamptz"],
      ["field text", "source timestamptz", "time_zone text"],
    ],
    active: 0,
    activeParam: 1,
  });
  const third = at("SELECT date_trunc('day', placed_at, |) FROM orders");
  expect(parameterHints(pg(third.text), third.text, third.pos, "postgres")).toMatchObject({ active: 1, activeParam: 2 });
  const nested = at("SELECT round(sum(total|), 2) FROM orders");
  expect(parameterHints(pg(nested.text), nested.text, nested.pos, "postgres")).toMatchObject({ name: "sum", activeParam: 0 });
  const outside = at("SELECT round(1, 2)| FROM orders");
  expect(parameterHints(pg(outside.text), outside.text, outside.pos, "postgres")).toBeNull();
  // Not a function of this Dialect.
  const my = at("SELECT date_trunc('day', |");
  expect(parameterHints(analyzeSql(my.text, "mysql", KFC_SCHEMA), my.text, my.pos, "mysql")).toBeNull();
});
