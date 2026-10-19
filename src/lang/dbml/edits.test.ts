import { expect, test } from "vitest";
import type { TextEdit } from "../protocol";
import {
  addColumn,
  addRef,
  addTable,
  applyEdits,
  fkTargetWarning,
  renameColumn,
  renameTable,
  setColumnSetting,
  setColumnType,
} from "./edits";
import { parseDbml } from "./parse";
import { KFC_TEXT } from "./fixtures";

const parsed = () => parseDbml(KFC_TEXT, "postgres");
const STORES = "public.stores";
const ORDERS = "public.orders";

/** Lines of `before` that no longer appear in `after`. */
function changedLines(before: string, after: string): string[] {
  const rest = after.split("\n");
  return before.split("\n").filter((line) => {
    const i = rest.indexOf(line);
    if (i === -1) return true;
    rest.splice(i, 1);
    return false;
  });
}

function check(edits: TextEdit[], maxChanged: number) {
  const after = applyEdits(KFC_TEXT, edits);
  for (const comment of KFC_TEXT.match(/\/\/[^\n]*/g) ?? []) expect(after).toContain(comment);
  expect(changedLines(KFC_TEXT, after).length).toBeLessThanOrEqual(maxChanged);
  const out = parseDbml(after, "postgres");
  expect(out.diagnostics).toEqual([]);
  return out.model!;
}

test("canvas_edits_keep_comments_and_formatting", () => {
  const { ranges, model } = parsed();
  // Rename a table: its declaration line and the Ref line.
  let m = check(renameTable(KFC_TEXT, ranges, STORES, "shops"), 2);
  expect(m.tables.map((t) => t.name)).toEqual(["shops", "orders"]);
  expect(m.refs[0].to.table).toBe("shops");
  // Rename a column that has a trailing comment and is used by the Ref and an index.
  m = check(renameColumn(KFC_TEXT, ranges, ORDERS, "store_id", "shop_id"), 3);
  expect(m.tables[1].columns[2].name).toBe("shop_id");
  expect(m.refs[0].from.columns).toEqual(["shop_id"]);
  expect(m.tables[1].indexes[1].columns).toEqual(["shop_id"]);
  // Set a type.
  m = check(setColumnType(KFC_TEXT, ranges, STORES, "name", "text"), 1);
  expect(m.tables[0].columns[1].typeName).toBe("text");
  // Toggle a setting on a column with settings, and on one without.
  m = check(setColumnSetting(KFC_TEXT, ranges, STORES, "name", "unique", false), 1);
  expect(m.tables[0].columns[1].unique).toBe(false);
  m = check(setColumnSetting(KFC_TEXT, ranges, ORDERS, "line", "not null", true), 1);
  expect(m.tables[1].columns[1].notNull).toBe(true);
  // Add a column, a table and a ref.
  m = check(addColumn(KFC_TEXT, ranges, ORDERS, "placed_at", "timestamptz"), 0);
  expect(m.tables[1].columns.map((c) => c.name)).toContain("placed_at");
  m = check(addTable(KFC_TEXT, "customers"), 0);
  expect(m.tables.map((t) => t.name)).toContain("customers");
  m = check(
    addRef(
      KFC_TEXT,
      ranges,
      { schema: "public", table: "orders", columns: ["line"] },
      { schema: "public", table: "stores", columns: ["id"] },
    ),
    0,
  );
  expect(m.refs).toHaveLength(2);
  expect(model).not.toBeNull();
});

test("rename_table_updates_refs", () => {
  const { ranges } = parsed();
  const after = applyEdits(KFC_TEXT, renameTable(KFC_TEXT, ranges, STORES, "shop list"));
  expect(after).toContain('Table "shop list" {');
  expect(after).toContain('Ref: orders.store_id > "shop list".id');
});

test("set_setting_creates_and_removes_brackets", () => {
  const { ranges } = parsed();
  const on = applyEdits(KFC_TEXT, setColumnSetting(KFC_TEXT, ranges, ORDERS, "id", "pk", true));
  expect(on).toContain("  id bigint [pk]\n");
  const r = parseDbml(on, "postgres").ranges;
  const off = applyEdits(on, setColumnSetting(on, r, ORDERS, "id", "pk", false));
  expect(off).toContain("  id bigint\n");
});

test("fk_warning_for_plain_column", () => {
  const { model } = parsed();
  expect(fkTargetWarning(model!, { schema: "public", table: "stores", columns: ["id"] })).toBeNull();
  expect(fkTargetWarning(model!, { schema: "public", table: "stores", columns: ["name"] })).toBeNull(); // unique
  expect(fkTargetWarning(model!, { schema: "public", table: "stores", columns: ["kind"] })).toBe(
    "stores.kind is not a key, unique or indexed. The database may refuse this Foreign Key.",
  );
  expect(fkTargetWarning(model!, { schema: "public", table: "orders", columns: ["store_id"] })).toBeNull(); // indexed
});
