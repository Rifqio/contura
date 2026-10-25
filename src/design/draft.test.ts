import { expect, test } from "vitest";
import type { DesignEdit, Position, TableDesign, TableForeignKey, TableIndex } from "../api/types";
import { ORDERS, col } from "./fixtures";
import {
  addColumn,
  addNamedColumn,
  copyColumn,
  pasteColumn,
  addForeignKey,
  addIndex,
  backslashNote,
  droppedIndexNotes,
  keysProblem,
  editForeignKey,
  editIndex,
  removeForeignKey,
  removeIndex,
  changeCount,
  columnMark,
  editColumn,
  emptyDraft,
  fromDesign,
  moveColumn,
  primaryColumns,
  refNames,
  restoreColumn,
  removeColumn,
  renameTable,
  toEdits,
  togglePrimary,
  type Draft,
} from "./draft";

const idOf = (dr: Draft, name: string) => dr.columns.find((c) => c.name === name)!.id;

/** Applies column edits in order, as the Core does, to get the final column names. */
function applied(base: string[], edits: DesignEdit[]): string[] {
  const list = [...base];
  const at = (p: Position) => (p.kind === "last" ? list.length : p.kind === "first" ? 0 : list.indexOf(p.column) + 1);
  for (const e of edits) {
    if (e.op === "dropColumn") list.splice(list.indexOf(e.name), 1);
    else if (e.op === "changeColumn") list[list.indexOf(e.name)] = e.column.name;
    else if (e.op === "moveColumn") {
      list.splice(list.indexOf(e.name), 1);
      list.splice(at(e.position), 0, e.name);
    } else if (e.op === "addColumn") list.splice(at(e.position), 0, e.column.name);
  }
  return list;
}
const names = (dr: Draft) => dr.columns.filter((c) => !dr.removed.includes(c.id)).map((c) => c.name);
const BASE = ORDERS.columns.map((c) => c.name);

test("a_loaded_design_has_no_edits", () => {
  const dr = fromDesign(ORDERS);
  expect(toEdits(dr)).toEqual([]);
  expect(changeCount(dr)).toBe(0);
  expect(dr.columns.map((c) => c.origin)).toEqual(BASE);
});

test("editing_a_name_is_a_rename_even_with_a_type_change", () => {
  const dr = fromDesign(ORDERS);
  const next = editColumn(dr, idOf(dr, "status"), { name: "state", typeSql: "varchar(32)" });
  expect(toEdits(next)).toEqual([
    {
      op: "changeColumn",
      name: "status",
      column: { name: "state", typeSql: "varchar(32)", nullable: false, defaultSql: "'new'", increment: false, comment: null },
    },
  ]);
  expect(toEdits(next).some((e) => e.op === "dropColumn" || e.op === "addColumn")).toBe(false);
  expect(columnMark(next, idOf(dr, "status"))).toBe("cell-edited");
});

test("remove_then_add_same_name_is_drop_and_add", () => {
  const dr = fromDesign(ORDERS);
  let next = removeColumn(dr, idOf(dr, "status"));
  next = addColumn(next);
  const added = next.columns[next.columns.length - 1];
  next = editColumn(next, added.id, { name: "status", typeSql: "varchar(16)" });
  const edits = toEdits(next);
  expect(edits).toEqual([
    { op: "dropColumn", name: "status" },
    {
      op: "addColumn",
      column: { name: "status", typeSql: "varchar(16)", nullable: true, defaultSql: null, increment: false, comment: null },
      position: { kind: "last" },
    },
  ]);
  expect(columnMark(next, idOf(dr, "status"))).toBe("row-deleted");
  expect(columnMark(next, added.id)).toBe("row-added");
});

test("a_change_back_to_the_loaded_values_gives_no_edit", () => {
  const dr = fromDesign(ORDERS);
  const id = idOf(dr, "total");
  const changed = editColumn(dr, id, { typeSql: "decimal(12,2)", nullable: false });
  expect(toEdits(changed)).toHaveLength(1);
  const back = editColumn(changed, id, { typeSql: "decimal(10,2)", nullable: true });
  expect(toEdits(back)).toEqual([]);
  expect(changeCount(back)).toBe(0);
  expect(columnMark(back, id)).toBeNull();
  // An emptied default is no default.
  expect(toEdits(editColumn(dr, id, { defaultSql: "" }))).toEqual([]);
});

test("change_count_counts_columns_keys_and_the_comment", () => {
  const dr = fromDesign(ORDERS);
  let next = editColumn(dr, idOf(dr, "total"), { typeSql: "decimal(12,2)" });
  next = editColumn(next, idOf(dr, "total"), { nullable: false });
  expect(changeCount(next)).toBe(1);
  next = removeColumn(next, idOf(dr, "email"));
  next = addColumn(next);
  expect(changeCount(next)).toBe(3);
  next = { ...next, comment: "Orders placed online" };
  expect(changeCount(next)).toBe(4);
  // The primary key moves to email: one index change.
  const fresh = fromDesign(ORDERS);
  const keyed = togglePrimary(fresh, idOf(fresh, "email"), "mysql");
  expect(changeCount(keyed)).toBe(1);
  expect(toEdits(keyed)).toEqual([
    { op: "dropIndex", name: "PRIMARY" },
    { op: "addIndex", index: { name: "PRIMARY", columns: ["id", "email"], unique: true, primary: true } },
  ]);
});

test("move_on_mysql_gives_move_column_after_the_column_before_it", () => {
  const dr = fromDesign(ORDERS);
  const next = moveColumn(dr, idOf(dr, "status"), -1);
  expect(names(next)).toEqual(["id", "status", "email", "total", "created_at"]);
  expect(toEdits(next)).toEqual([{ op: "moveColumn", name: "status", position: { kind: "after", column: "id" } }]);
  expect(changeCount(next)).toBe(1);
  // Moving it back is no change at all.
  expect(toEdits(moveColumn(next, idOf(dr, "status"), 1))).toEqual([]);
});

test("moving_the_first_column_to_the_end_moves_only_it", () => {
  let dr = fromDesign(ORDERS);
  const id = idOf(dr, "id");
  for (let i = 0; i < 4; i++) dr = moveColumn(dr, id, 1);
  expect(names(dr)).toEqual(["email", "status", "total", "created_at", "id"]);
  expect(toEdits(dr)).toEqual([{ op: "moveColumn", name: "id", position: { kind: "after", column: "created_at" } }]);
  expect(applied(BASE, toEdits(dr))).toEqual(names(dr));
});

test("add_column_appends_at_the_end_as_position_last", () => {
  const dr = fromDesign(ORDERS);
  const next = addColumn(dr);
  expect(next.columns).toHaveLength(6);
  const added = next.columns[5];
  expect(added.origin).toBeNull();
  expect(columnMark(next, added.id)).toBe("row-added");
  const edits = toEdits(editColumn(next, added.id, { name: "note", typeSql: "text" }));
  expect(edits).toEqual([
    {
      op: "addColumn",
      column: { name: "note", typeSql: "text", nullable: true, defaultSql: null, increment: false, comment: null },
      position: { kind: "last" },
    },
  ]);
});

test("removing_an_added_column_drops_it_from_the_list", () => {
  const dr = addColumn(fromDesign(ORDERS));
  const added = dr.columns[5];
  const next = removeColumn(dr, added.id);
  expect(next.columns).toHaveLength(5);
  expect(next.removed).toEqual([]);
  expect(toEdits(next)).toEqual([]);
});

test("mixed_edits_rebuild_the_edited_order", () => {
  let dr = fromDesign(ORDERS);
  dr = editColumn(dr, idOf(dr, "email"), { name: "mail" });
  dr = removeColumn(dr, idOf(dr, "total"));
  dr = addColumn(dr);
  const added = dr.columns[dr.columns.length - 1].id;
  dr = editColumn(dr, added, { name: "note", typeSql: "text" });
  dr = moveColumn(dr, added, -1);
  dr = moveColumn(dr, added, -1);
  // One press: the removed total is stepped over.
  dr = moveColumn(dr, idOf(dr, "created_at"), -1);
  expect(names(dr)).toEqual(["id", "mail", "note", "created_at", "status"]);
  const edits = toEdits(dr);
  expect(edits.map((e) => e.op)).toEqual(["dropColumn", "changeColumn", "moveColumn", "addColumn"]);
  expect(applied(BASE, edits)).toEqual(names(dr));
});

test("a_new_table_starts_with_one_empty_column", () => {
  const dr = emptyDraft({ database: "shop", schema: null, name: "" });
  expect(dr.base).toBeNull();
  expect(dr.columns).toHaveLength(1);
  expect(dr.columns[0]).toMatchObject({ name: "", typeSql: "", origin: null });
  expect(columnMark(dr, dr.columns[0].id)).toBe("row-added");
  // The untouched starting row is not a change yet.
  expect(changeCount(dr)).toBe(0);
  expect(changeCount(editColumn(dr, dr.columns[0].id, { name: "id" }))).toBe(1);
});

test("emptying_an_indexed_name_then_typing_it_again_gives_no_edit", () => {
  const dr = fromDesign({
    ...ORDERS,
    foreignKeys: [
      {
        name: "orders_parent",
        columns: ["email"],
        target: { database: "shop", schema: null, name: "orders" },
        targetColumns: ["id"],
        onDelete: null,
        onUpdate: null,
        advanced: false,
      },
    ],
  });
  const id = idOf(dr, "id");
  const email = idOf(dr, "email");
  let next = editColumn(dr, id, { name: "" });
  next = editColumn(next, email, { name: "" });
  expect(primaryColumns(next).has(id)).toBe(true);
  next = editColumn(next, id, { name: "id" });
  next = editColumn(next, email, { name: "email" });
  expect(toEdits(next)).toEqual([]);
  expect(changeCount(next)).toBe(0);
  expect(primaryColumns(next).has(id)).toBe(true);
  // A real rename keeps the index and the self-referencing key on the column, with no index edit.
  const renamed = editColumn(dr, id, { name: "order_id" });
  expect(toEdits(renamed).map((e) => e.op)).toEqual(["changeColumn"]);
  expect(refNames(renamed, renamed.indexes[0].columns)).toEqual(["order_id"]);
  expect(refNames(renamed, renamed.foreignKeys[0].targetColumns)).toEqual(["order_id"]);
});

test("a_removed_column_comes_back_and_moves_step_over_it", () => {
  const dr = fromDesign(ORDERS);
  const removed = removeColumn(dr, idOf(dr, "email"));
  expect(toEdits(restoreColumn(removed, idOf(dr, "email")))).toEqual([]);
  // Moving status up steps over the removed email: one press puts it above id.
  const moved = moveColumn(removed, idOf(dr, "status"), -1);
  expect(names(moved)).toEqual(["status", "id", "total", "created_at"]);
  expect(moved.columns.map((c) => c.name)).toEqual(["status", "id", "email", "total", "created_at"]);
});

// Task 9: indexes and Foreign Keys.

const ix = (name: string, columns: string[], over: Partial<TableIndex> = {}): TableIndex => ({
  name,
  columns,
  unique: false,
  primary: false,
  constraint: false,
  sql: null,
  method: "btree",
  predicate: null,
  expression: false,
  advanced: false,
  ...over,
});
const fk = (name: string, columns: string[], over: Partial<TableForeignKey> = {}): TableForeignKey => ({
  name,
  columns,
  target: { database: "shop", schema: null, name: "customers" },
  targetColumns: ["id"],
  onDelete: null,
  onUpdate: null,
  advanced: false,
  ...over,
});
/** Every column name an edit hands the Core for an index or key. */
const indexedNames = (edits: DesignEdit[]) =>
  edits.flatMap((e) =>
    e.op === "addIndex" ? e.index.columns : e.op === "addForeignKey" ? [...e.key.columns, ...e.key.targetColumns] : [],
  );

test("key_toggles_on_two_columns_give_one_primary_index_in_column_order", () => {
  const dr = fromDesign({ ...ORDERS, indexes: [] });
  let next = togglePrimary(dr, idOf(dr, "total"), "postgres");
  next = togglePrimary(next, idOf(dr, "email"), "postgres");
  expect(next.indexes).toHaveLength(1);
  expect(refNames(next, next.indexes[0].columns)).toEqual(["email", "total"]);
  expect(toEdits(next)).toEqual([
    { op: "addIndex", index: { name: "orders_pkey", columns: ["email", "total"], unique: true, primary: true } },
  ]);
});

test("renaming_an_index_gives_rename_index", () => {
  const dr = fromDesign({ ...ORDERS, indexes: [...ORDERS.indexes, ix("orders_email_idx", ["email"])] });
  const next = editIndex(dr, dr.indexes[1].id, { name: "orders_mail_idx" });
  expect(toEdits(next)).toEqual([{ op: "renameIndex", name: "orders_email_idx", to: "orders_mail_idx" }]);
  expect(changeCount(next)).toBe(1);
});

test("a_partial_or_expression_index_only_takes_a_new_name", () => {
  const dr = fromDesign({
    ...ORDERS,
    indexes: [
      ...ORDERS.indexes,
      ix("orders_open_idx", ["status"], { predicate: "status <> 'done'" }),
      ix("orders_lower_idx", ["lower(email)"], { expression: true }),
    ],
  });
  const [, partial, expr] = dr.indexes;
  expect(partial).toMatchObject({ method: "btree", predicate: "status <> 'done'", expression: false });
  for (const i of [partial, expr]) {
    expect(editIndex(dr, i.id, { unique: true })).toBe(dr);
    expect(editIndex(dr, i.id, { columns: [{ id: idOf(dr, "total") }] })).toBe(dr);
  }
  expect(toEdits(editIndex(dr, partial.id, { name: "orders_pending_idx" }))).toEqual([
    { op: "renameIndex", name: "orders_open_idx", to: "orders_pending_idx" },
  ]);
  expect(toEdits(removeIndex(dr, expr.id))).toEqual([{ op: "dropIndex", name: "orders_lower_idx" }]);
});

test("the_primary_index_changes_only_through_the_key_toggles", () => {
  const dr = fromDesign(ORDERS);
  const pk = dr.indexes[0].id;
  expect(editIndex(dr, pk, { name: "pk", unique: false })).toBe(dr);
  expect(removeIndex(dr, pk)).toBe(dr);
});

test("changing_a_keys_on_delete_is_a_drop_then_an_add", () => {
  const dr = fromDesign({ ...ORDERS, foreignKeys: [fk("orders_customer_fkey", ["email"], { targetColumns: ["email"] })] });
  const next = editForeignKey(dr, dr.foreignKeys[0].id, { onDelete: "CASCADE" });
  expect(toEdits(next)).toEqual([
    { op: "dropForeignKey", name: "orders_customer_fkey" },
    {
      op: "addForeignKey",
      key: {
        name: "orders_customer_fkey",
        columns: ["email"],
        target: { database: "shop", schema: null, name: "customers" },
        targetColumns: ["email"],
        onDelete: "CASCADE",
        onUpdate: null,
      },
    },
  ]);
  expect(changeCount(next)).toBe(1);
  // NO ACTION is the default the server reports as null: picking it is no change.
  expect(toEdits(editForeignKey(dr, dr.foreignKeys[0].id, { onDelete: "NO ACTION" }))).toEqual([]);
});

test("new_indexes_and_keys_name_themselves_until_a_name_is_typed", () => {
  let dr = addIndex(fromDesign(ORDERS));
  const i = dr.indexes[1].id;
  expect(dr.indexes[1]).toMatchObject({ origin: null, primary: false, unique: false, columns: [] });
  dr = editIndex(dr, i, { columns: [{ id: idOf(dr, "email") }, { id: idOf(dr, "status") }] });
  expect(dr.indexes[1].name).toBe("orders_email_status_idx");
  dr = editIndex(dr, i, { unique: true });
  expect(dr.indexes[1].name).toBe("orders_email_status_key");
  dr = editIndex(dr, i, { name: "by_mail" });
  dr = editIndex(dr, i, { unique: false });
  expect(dr.indexes[1].name).toBe("by_mail");
  expect(toEdits(dr)).toEqual([
    { op: "addIndex", index: { name: "by_mail", columns: ["email", "status"], unique: false, primary: false } },
  ]);

  let keyed = addForeignKey(fromDesign(ORDERS));
  const k = keyed.foreignKeys[0].id;
  expect(keyed.foreignKeys[0]).toMatchObject({ origin: null, columns: [], targetColumns: [], onDelete: null, onUpdate: null });
  keyed = editForeignKey(keyed, k, { columns: [{ id: idOf(keyed, "email") }] });
  expect(keyed.foreignKeys[0].name).toBe("orders_email_fkey");
  keyed = editForeignKey(keyed, k, {
    target: { database: "shop", schema: null, name: "customers" },
    targetColumns: [{ text: "email" }],
  });
  // A new table for the key clears the columns picked on the old one.
  const moved = editForeignKey(keyed, k, { target: { database: "shop", schema: null, name: "people" } });
  expect(moved.foreignKeys[0].targetColumns).toEqual([]);
  expect(toEdits(keyed).map((e) => e.op)).toEqual(["addForeignKey"]);
  expect(toEdits(removeForeignKey(keyed, k))).toEqual([]);
});

test("an_added_column_put_in_the_primary_key_then_removed_leaves_no_trace", () => {
  let dr = addColumn(fromDesign(ORDERS));
  const added = dr.columns[5].id;
  dr = editColumn(dr, added, { name: "tenant", typeSql: "int" });
  dr = togglePrimary(dr, added, "mysql");
  expect(refNames(dr, dr.indexes[0].columns)).toEqual(["id", "tenant"]);
  dr = removeColumn(dr, added);
  expect(refNames(dr, dr.indexes[0].columns)).toEqual(["id"]);
  expect(toEdits(dr)).toEqual([]);
  expect(changeCount(dr)).toBe(0);

  // Alone in a new table's primary key: the key goes with it.
  let fresh = emptyDraft({ database: "shop", schema: null, name: "items" });
  const only = fresh.columns[0].id;
  fresh = editColumn(fresh, only, { name: "id", typeSql: "int" });
  fresh = togglePrimary(fresh, only, "mysql");
  fresh = removeColumn(fresh, only);
  expect(fresh.indexes).toEqual([]);
  expect(indexedNames(toEdits(fresh))).toEqual([]);
});

/** Ids of removed columns that some index or key in the draft still names. */
const dangling = (dr: Draft) =>
  [...dr.indexes.flatMap((i) => i.columns), ...dr.foreignKeys.flatMap((k) => [...k.columns, ...k.targetColumns])].flatMap((r) =>
    "id" in r && dr.removed.includes(r.id) ? [r.id] : [],
  );
/** Column names an edit hands the Core for an index or key that the same edits drop as columns. */
const namesDropped = (edits: DesignEdit[]) => {
  const dropped = edits.flatMap((e) => (e.op === "dropColumn" ? [e.name] : []));
  return indexedNames(edits).filter((n) => dropped.includes(n));
};

test("a_loaded_column_removed_drops_its_loaded_indexes_and_keys_whole", () => {
  const dr = fromDesign({
    ...ORDERS,
    indexes: [
      ...ORDERS.indexes,
      ix("orders_email_status_idx", ["email", "status"]),
      ix("orders_email_key", ["email"], { unique: true }),
      ix("orders_total_idx", ["total"]),
    ],
    foreignKeys: [fk("orders_customer_fkey", ["email", "status"], { targetColumns: ["email", "state"] })],
  });
  const next = removeColumn(dr, idOf(dr, "email"));
  // Never narrowed (S12): the plain, the UNIQUE index and the key go whole.
  expect(next.indexes.map((i) => i.name)).toEqual(["PRIMARY", "orders_total_idx"]);
  expect(next.foreignKeys).toEqual([]);
  expect(toEdits(next)).toEqual([
    { op: "dropForeignKey", name: "orders_customer_fkey" },
    { op: "dropIndex", name: "orders_email_status_idx" },
    { op: "dropIndex", name: "orders_email_key" },
    { op: "dropColumn", name: "email" },
  ]);
  // Only the plain index gets the designer's note; the others get the Core's warnings.
  expect(droppedIndexNotes(next)).toEqual(["Removing email also drops index orders_email_status_idx."]);
  expect(toEdits(restoreColumn(next, idOf(dr, "email")))).toEqual([]);
  expect(droppedIndexNotes(restoreColumn(next, idOf(dr, "email")))).toEqual([]);
});

test("restoring_in_either_order_brings_a_rule_back_only_when_all_its_columns_are", () => {
  const cases: { design: TableDesign; a: string; b: string; name: string; drop: DesignEdit["op"] }[] = [
    {
      design: { ...ORDERS, indexes: [...ORDERS.indexes, ix("orders_email_status_idx", ["email", "status"])] },
      a: "email",
      b: "status",
      name: "orders_email_status_idx",
      drop: "dropIndex",
    },
    {
      design: { ...ORDERS, indexes: [ix("PRIMARY", ["id", "total"], { unique: true, primary: true })] },
      a: "id",
      b: "total",
      name: "PRIMARY",
      drop: "dropIndex",
    },
    {
      design: {
        ...ORDERS,
        foreignKeys: [
          fk("orders_pair_fkey", ["email", "status"], {
            target: { database: "shop", schema: null, name: "people" },
            targetColumns: ["mail", "state"],
          }),
        ],
      },
      a: "email",
      b: "status",
      name: "orders_pair_fkey",
      drop: "dropForeignKey",
    },
    {
      design: { ...ORDERS, indexes: [...ORDERS.indexes, ix("orders_open_idx", ["email", "status"], { predicate: "total > 0" })] },
      a: "email",
      b: "status",
      name: "orders_open_idx",
      drop: "dropIndex",
    },
    {
      design: { ...ORDERS, foreignKeys: [fk("orders_adv_fkey", ["email", "status"], { targetColumns: ["a", "b"], advanced: true })] },
      a: "email",
      b: "status",
      name: "orders_adv_fkey",
      drop: "dropForeignKey",
    },
  ];
  for (const { design, a, b, name, drop } of cases) {
    for (const [first, second] of [
      [a, b],
      [b, a],
    ]) {
      let dr = fromDesign(design);
      dr = removeColumn(dr, idOf(dr, a));
      dr = removeColumn(dr, idOf(dr, b));
      dr = restoreColumn(dr, idOf(dr, first));
      const label = `${name} back ${first}`;
      expect([...dr.indexes, ...dr.foreignKeys].some((x) => x.name === name), label).toBe(false);
      expect(dangling(dr), label).toEqual([]);
      expect(toEdits(dr), label).toContainEqual({ op: drop, name });
      expect(namesDropped(toEdits(dr)), label).toEqual([]);
      dr = restoreColumn(dr, idOf(dr, second));
      expect(toEdits(dr), `${label} then ${second}`).toEqual([]);
    }
  }
});

test("a_held_primary_key_stays_out_when_the_key_toggles_made_a_new_one", () => {
  let dr = fromDesign(ORDERS);
  dr = removeColumn(dr, idOf(dr, "id"));
  dr = togglePrimary(dr, idOf(dr, "email"), "mysql");
  dr = restoreColumn(dr, idOf(dr, "id"));
  expect(dr.indexes.filter((i) => i.primary).map((i) => refNames(dr, i.columns))).toEqual([["email"]]);
});

test("an_added_index_loses_removed_columns_and_gets_them_back_in_any_order", () => {
  let dr = addIndex(fromDesign(ORDERS));
  const i = dr.indexes[1].id;
  dr = editIndex(dr, i, { columns: [{ id: idOf(dr, "email") }, { id: idOf(dr, "status") }] });
  dr = removeColumn(dr, idOf(dr, "email"));
  expect(refNames(dr, dr.indexes[1].columns)).toEqual(["status"]);
  dr = removeColumn(dr, idOf(dr, "status"));
  expect(dr.indexes.map((x) => x.id)).not.toContain(i);
  dr = restoreColumn(dr, idOf(dr, "email"));
  expect(refNames(dr, dr.indexes[1].columns)).toEqual(["email"]);
  expect(dangling(dr)).toEqual([]);
  dr = restoreColumn(dr, idOf(dr, "status"));
  expect(toEdits(dr)).toEqual([
    { op: "addIndex", index: { name: "orders_email_status_idx", columns: ["email", "status"], unique: false, primary: false } },
  ]);
});

test("a_partial_or_expression_index_naming_a_removed_column_in_its_sql_goes_too", () => {
  const dr = fromDesign({
    ...ORDERS,
    indexes: [
      ...ORDERS.indexes,
      ix("orders_open_idx", ["total"], { predicate: "status <> 'done'" }),
      ix("orders_lower_idx", ["lower(email)"], { expression: true }),
      ix("orders_statuses_idx", ["total"], { predicate: "statuses > 0" }),
    ],
  });
  let next = removeColumn(dr, idOf(dr, "status"));
  expect(next.indexes.map((i) => i.name)).toEqual(["PRIMARY", "orders_lower_idx", "orders_statuses_idx"]);
  expect(droppedIndexNotes(next)).toEqual(["Removing status also drops index orders_open_idx."]);
  next = removeColumn(next, idOf(dr, "email"));
  expect(next.indexes.map((i) => i.name)).toEqual(["PRIMARY", "orders_statuses_idx"]);
  expect(toEdits(next).filter((e) => e.op === "dropIndex")).toEqual([
    { op: "dropIndex", name: "orders_open_idx" },
    { op: "dropIndex", name: "orders_lower_idx" },
  ]);
});

test("index_and_key_names_must_be_unique_in_the_draft", () => {
  let dr = addIndex(addIndex(fromDesign(ORDERS)));
  const [, one, two] = dr.indexes;
  dr = editIndex(dr, one.id, { columns: [{ id: idOf(dr, "email") }] });
  dr = editIndex(dr, two.id, { columns: [{ id: idOf(dr, "status") }], name: "orders_email_idx" });
  expect(keysProblem(dr)).toBe("Two indexes are named orders_email_idx. Rename one.");
  dr = editIndex(dr, two.id, { name: "orders_status_idx" });
  expect(keysProblem(dr)).toBeNull();
});

// Final review fixes (S13 I3 and the ledger's text match).

/** A new PostgreSQL table with the column id int, not named yet. */
function newPgTable(): Draft {
  let dr = emptyDraft({ database: "shop", schema: "public", name: "" });
  dr = editColumn(dr, dr.columns[0].id, { name: "id", typeSql: "int" });
  return addColumn(dr);
}

test("a_new_tables_primary_key_is_named_from_the_name_typed_after_the_key", () => {
  let dr = newPgTable();
  dr = editColumn(dr, dr.columns[1].id, { name: "email", typeSql: "text" });
  dr = togglePrimary(dr, idOf(dr, "id"), "postgres");
  // An index on email made before the name too, and one the user named.
  dr = addIndex(dr);
  dr = editIndex(dr, dr.indexes[1].id, { columns: [{ id: idOf(dr, "email") }] });
  dr = addIndex(dr);
  dr = editIndex(dr, dr.indexes[2].id, { columns: [{ id: idOf(dr, "email") }], name: "by_email", unique: true });
  expect(dr.indexes.map((i) => i.name)).toEqual(["_pkey", "email_idx", "by_email"]);
  dr = renameTable(dr, "invoices");
  // The grid shows the names the plan uses.
  expect(dr.indexes.map((i) => i.name)).toEqual(["invoices_pkey", "invoices_email_idx", "by_email"]);
  expect(toEdits(dr).filter((e) => e.op === "addIndex")).toEqual([
    { op: "addIndex", index: { name: "invoices_pkey", columns: ["id"], unique: true, primary: true } },
    { op: "addIndex", index: { name: "invoices_email_idx", columns: ["email"], unique: false, primary: false } },
    { op: "addIndex", index: { name: "by_email", columns: ["email"], unique: true, primary: false } },
  ]);
});

test("a_new_tables_auto_names_come_from_the_final_trimmed_name_in_to_edits", () => {
  let dr = newPgTable();
  dr = editColumn(dr, dr.columns[1].id, { name: "customer_id", typeSql: "int" });
  dr = renameTable(dr, "invoice");
  dr = togglePrimary(dr, idOf(dr, "id"), "postgres");
  dr = addForeignKey(dr);
  dr = editForeignKey(dr, dr.foreignKeys[0].id, {
    columns: [{ id: idOf(dr, "customer_id") }],
    target: { database: "shop", schema: "public", name: "customers" },
    targetColumns: [{ text: "id" }],
  });
  // Even a path set without renameTable is read when the request is built.
  dr = { ...dr, path: { ...dr.path, name: " invoices " } };
  const edits = toEdits(dr);
  expect(edits).toContainEqual({ op: "addIndex", index: { name: "invoices_pkey", columns: ["id"], unique: true, primary: true } });
  expect(edits).toContainEqual(
    expect.objectContaining({ op: "addForeignKey", key: expect.objectContaining({ name: "invoices_customer_id_fkey" }) }),
  );
});

test("mysql_and_sqlite_primary_keys_keep_their_fixed_names_and_an_alter_keeps_its_names", () => {
  let my = newPgTable();
  my = togglePrimary(my, idOf(my, "id"), "mysql");
  expect(toEdits(renameTable(my, "t")).find((e) => e.op === "addIndex")).toMatchObject({ index: { name: "PRIMARY" } });
  let lite = newPgTable();
  lite = togglePrimary(lite, idOf(lite, "id"), "sqlite");
  expect(toEdits(renameTable(lite, "t")).find((e) => e.op === "addIndex")).toMatchObject({ index: { name: "primary" } });
  // A loaded table's PostgreSQL key is named from its own fixed name.
  let alter = fromDesign({ ...ORDERS, indexes: [] });
  alter = togglePrimary(alter, idOf(alter, "id"), "postgres");
  expect(toEdits(alter)).toEqual([{ op: "addIndex", index: { name: "orders_pkey", columns: ["id"], unique: true, primary: true } }]);
});

test("a_removed_column_named_only_inside_a_string_literal_keeps_the_partial_index", () => {
  const dr = fromDesign({
    ...ORDERS,
    indexes: [
      ...ORDERS.indexes,
      ix("orders_tag_idx", ["total"], { predicate: "status <> 'email' AND note = 'it''s email'" }),
      ix("orders_mail_idx", ["total"], { predicate: "email IS NOT NULL" }),
    ],
  });
  const next = removeColumn(dr, idOf(dr, "email"));
  expect(next.indexes.map((i) => i.name)).toEqual(["PRIMARY", "orders_tag_idx"]);
});

test("the_text_match_uses_the_loaded_name_not_the_draft_name", () => {
  const dr = fromDesign({
    ...ORDERS,
    indexes: [...ORDERS.indexes, ix("orders_open_idx", ["total"], { predicate: "state > 0" })],
  });
  // status renamed to state in the draft, then removed: the server's text names state, a different column.
  let next = editColumn(dr, idOf(dr, "status"), { name: "state" });
  next = removeColumn(next, idOf(dr, "status"));
  expect(next.indexes.map((i) => i.name)).toEqual(["PRIMARY", "orders_open_idx"]);
});

test("M1: on MySQL a typed default with a backslash says how Contura reads it; a loaded one does not", () => {
  const dr = fromDesign(ORDERS);
  expect(backslashNote(dr, "mysql")).toBeNull();
  const typed = editColumn(dr, idOf(dr, "status"), { defaultSql: "'C:\\temp'" });
  expect(backslashNote(typed, "mysql")).toBe(
    "MySQL default status: Contura reads a backslash in quotes as an escape, whatever the server's sql_mode, so \\\\ is one backslash and \\t a tab.",
  );
  expect(backslashNote(typed, "postgres")).toBeNull();
});

test("paste_column_inserts_a_copy_below_with_a_free_name_and_no_key", () => {
  const dr = fromDesign(ORDERS);
  const def = copyColumn(dr, idOf(dr, "status"))!.column;
  expect(def).toEqual({ name: "status", typeSql: "varchar(16)", nullable: false, defaultSql: "'new'", increment: false, comment: null });
  const { draft: next, id } = pasteColumn(dr, def, idOf(dr, "status"));
  expect(next.columns.map((c) => c.name)).toEqual(["id", "email", "status", "status_2", "total", "created_at"]);
  const added = next.columns.find((c) => c.id === id)!;
  expect(added).toMatchObject({ origin: null, name: "status_2", typeSql: "varchar(16)", nullable: false, defaultSql: "'new'" });
  expect(primaryColumns(next).has(id)).toBe(false);
  // A second paste takes the next free name, in any case.
  const again = pasteColumn(next, { ...def, name: "STATUS" }, null);
  expect(again.draft.columns[again.draft.columns.length - 1].name).toBe("STATUS_3");
  // A free name is kept as it is.
  expect(pasteColumn(dr, { ...def, name: "note" }, null).draft.columns.pop()!.name).toBe("note");
});

test("paste_column_counts_on_only_a_number_it_added", () => {
  const dr = fromDesign(ORDERS);
  const def = copyColumn(dr, idOf(dr, "status"))!.column;
  const once = pasteColumn(dr, def, null).draft;
  // status_2 is there because status is: its copy counts on.
  expect(pasteColumn(once, { ...def, name: "status_2" }, null).draft.columns.pop()!.name).toBe("status_3");
  // A year is part of the name: never log_2025.
  const year = pasteColumn(dr, { ...def, name: "log_2024" }, null).draft;
  expect(pasteColumn(year, { ...def, name: "log_2024" }, null).draft.columns.pop()!.name).toBe("log_2024_2");
});

test("paste_column_with_no_row_goes_at_the_end", () => {
  const dr = fromDesign(ORDERS);
  const { draft: next } = pasteColumn(dr, copyColumn(dr, idOf(dr, "email"))!.column, null);
  expect(next.columns.map((c) => c.name)).toEqual(["id", "email", "status", "total", "created_at", "email_2"]);
  expect(toEdits(next)).toContainEqual(expect.objectContaining({ op: "addColumn", position: { kind: "last" } }));
});

test("add_named_column_appends_one_column_with_the_typed_field", () => {
  const dr = fromDesign(ORDERS);
  const { draft: next, id } = addNamedColumn(dr, { name: "note" });
  expect(next.columns).toHaveLength(6);
  expect(next.columns[5]).toMatchObject({ id, origin: null, name: "note", typeSql: "", nullable: true, defaultSql: null });
});

test("paste_column_keeps_a_blank_name_blank", () => {
  const dr = addColumn(fromDesign(ORDERS));
  const blank = dr.columns[dr.columns.length - 1];
  const { draft: next } = pasteColumn(dr, copyColumn(dr, blank.id)!.column, blank.id);
  expect(next.columns.slice(-2).map((c) => c.name)).toEqual(["", ""]);
});

test("copy_column_leaves_auto_increment_behind_with_the_keys", () => {
  const dr = fromDesign(ORDERS);
  const copied = copyColumn(dr, idOf(dr, "id"))!;
  expect(copied.column.increment).toBe(false);
  expect(copied.dropped).toBe("increment");
  expect(copyColumn(dr, idOf(dr, "email"))!.dropped).toBeNull();
});

test("copy_column_drops_a_serials_own_sequence_default", () => {
  const serial = {
    ...ORDERS,
    path: { database: "shop", schema: "public", name: "orders" },
    columns: [col("id", "integer", { nullable: false, increment: { kind: "serial" }, defaultSql: "nextval('orders_id_seq'::regclass)" }), ...ORDERS.columns.slice(1)],
  };
  const dr = fromDesign(serial);
  const copied = copyColumn(dr, idOf(dr, "id"))!;
  expect(copied.column).toMatchObject({ increment: false, defaultSql: null });
  expect(copied.dropped).toBe("increment");
});
