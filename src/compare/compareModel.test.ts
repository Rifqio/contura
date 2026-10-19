import { expect, test } from "vitest";
import {
  buildTree,
  confirmModeNote,
  comparedAgo,
  compareTitle,
  confirmLossSentence,
  dbmlErrorNotice,
  dialectRefusal,
  filterCounts,
  footerLine,
  lossBanner,
  lossLine,
  matchText,
  notComparedTotal,
  notComparedWords,
  progressText,
  lossChip,
  scriptLines,
  scriptText,
  scriptTitle,
  tickRefusal,
  toggleTick,
  treeFootText,
  visibleRows,
} from "./compareModel";
import { ITEMS, RESULT, planFor } from "./fixtures";

test("refusals_and_notices_use_the_spec_words", () => {
  expect(dialectRefusal("freight-staging", "postgres", "kestrel-pos", "mysql")).toBe(
    "freight-staging is PostgreSQL and kestrel-pos is MySQL. Schema Compare needs the same Dialect; use Data Transfer to copy across Dialects.",
  );
  expect(dbmlErrorNotice(27)).toBe("The DBML has an error on line 27. Compare uses the last valid version.");
  expect(compareTitle("freight-staging", "freight-prod")).toBe("freight-staging to freight-prod");
  expect(compareTitle("orders.dbml", "freight-prod")).toBe("orders.dbml to freight-prod");
  expect(compareTitle("orders.dbml", null)).toBe("Schema Compare");
});

test("compared_ago_is_compact", () => {
  expect(comparedAgo(0, 12_400)).toBe("Compared 12s ago");
  expect(comparedAgo(0, 125_000)).toBe("Compared 2m ago");
  expect(comparedAgo(0, 2 * 3600_000)).toBe("Compared 2h ago");
});

test("not_compared_takes_the_larger_side_per_kind", () => {
  expect(notComparedWords(RESULT.notCompared)).toBe("2 views, 1 trigger, 1 check constraint");
  expect(notComparedTotal(RESULT.notCompared)).toBe(4);
  expect(treeFootText(RESULT.notCompared)).toBe(
    "Not compared yet: 2 views, 1 trigger, 1 check constraint. Renames show as removed plus added.",
  );
  expect(treeFootText({ source: [], target: [] })).toBe("Renames show as removed plus added.");
  // The Core's own line wins when it sends one.
  const core = "Not compared yet: 1 view in the source; 1 view, 1 trigger in the target.";
  expect(treeFootText(RESULT.notCompared, core)).toBe(`${core} Renames show as removed plus added.`);
});

test("match_text_names_what_was_compared", () => {
  expect(matchText("billing", "freight-staging", "freight-prod", RESULT.summary)).toBe(
    "billing in freight-staging and freight-prod match: 6 tables, 1 enum, 14 indexes, 5 Foreign Keys.",
  );
  expect(matchText("pos", "a", "b", { tables: 1, enums: 0, indexes: 0, foreignKeys: 1, matches: true, notComparedLine: null })).toBe("pos in a and b match: 1 table, 1 Foreign Key.");
});

test("data_loss_words", () => {
  const fax = { kind: "removed" as const, object: "column" as const, name: "fax" };
  const legacy = { kind: "removed" as const, object: "table" as const, name: "legacy_invoices" };
  expect(lossLine(fax, { rows: 18402, exact: true })).toBe("Drops values in 18,402 rows");
  expect(lossLine(legacy, { rows: 2310, exact: false })).toBe("Drops about 2,310 rows");
  expect(lossBanner(fax, { rows: 18402, exact: true }, "freight-prod")).toBe(
    "Dropping fax removes its values in 18,402 rows on freight-prod. It starts unticked in the Sync Script.",
  );
  expect(lossBanner(legacy, { rows: 2310, exact: true }, "freight-prod")).toBe(
    "Dropping legacy_invoices removes its 2,310 rows on freight-prod. It starts unticked in the Sync Script.",
  );
  expect(confirmLossSentence(fax, { rows: 18402, exact: true })).toBe("DROP COLUMN fax removes its values in 18,402 rows.");
});

test("footer_title_and_progress", () => {
  expect(footerLine(9, 10, "freight-prod", true)).toBe("9 of 10 changes ticked. Writes on freight-prod (Production).");
  expect(footerLine(1, 1, "x", false)).toBe("1 of 1 change ticked.");
  expect(scriptTitle(9, "postgres")).toBe("Sync Script, 9 statements, PostgreSQL");
  expect(progressText(2, 9)).toBe("Statement 3 of 9");
  expect(progressText(9, 9)).toBe("Statement 9 of 9");
});

test("script_has_comment_headings_per_group", () => {
  const plan = planFor(null);
  const lines = scriptLines(plan.statements);
  expect(lines[0]).toEqual({ text: "-- 2. Change", statement: null, last: false });
  expect(lines.filter((l) => l.text.startsWith("-- ")).map((l) => l.text)).toEqual(["-- 2. Change", "-- 3. Create"]);
  expect(scriptText(planFor([...ITEMS.map((i) => i.id)]).statements).split("\n")[0]).toBe("-- 1. Drop");
});

test("script_text_ends_each_statement_with_a_separator", () => {
  const plan = planFor([...ITEMS.map((i) => i.id)]);
  // The Core's statements carry none; the shown, copied and saved script adds them.
  expect(plan.statements.every((s) => !s.sql.trimEnd().endsWith(";"))).toBe(true);
  const lines = scriptLines(plan.statements);
  for (const l of lines) {
    if (l.statement === null) expect(l.text.endsWith(";")).toBe(false);
    else expect(l.text.endsWith(";")).toBe(l.last);
  }
  const text = scriptText(plan.statements);
  expect(text).toContain("ALTER TABLE billing.invoices ALTER COLUMN total\n  TYPE numeric(12,2) USING total::numeric(12,2);\n");
  expect(text).toContain("CREATE TABLE billing.refunds (\n  id bigint PRIMARY KEY\n);");
  expect(text.split(";").length - 1).toBe(plan.statements.length);
});

test("loss_chip_fits_drops_and_narrowing", () => {
  expect(lossChip(1)).toBe("1 change loses data");
  expect(lossChip(1200)).toBe("1,200 changes lose data");
});

test("tick_closure_in_both_directions", () => {
  const items = planFor(null).items;
  const all = new Set(items.filter((i) => i.ticked).map((i) => i.id));
  const col = "column:billing.invoices.due_on:added";
  const idx = "index:billing.invoices.invoices_due_on_idx:added";
  // Unticking the column unticks the index that needs it.
  const off = toggleTick(items, all, col, false);
  expect(off.has(col)).toBe(false);
  expect(off.has(idx)).toBe(false);
  // Ticking the index ticks the column it needs.
  const on = toggleTick(items, off, idx, true);
  expect(on.has(col) && on.has(idx)).toBe(true);
  // A not-scriptable item never gets ticked.
  expect(toggleTick(items, all, "enum:billing.plan_kind:changed", true).has("enum:billing.plan_kind:changed")).toBe(false);
});

test("tree_groups_tables_and_enums_with_counts", () => {
  const rows = buildTree(ITEMS, "all", "billing", 4);
  expect(rows.map((r) => [r.level, r.name, r.mark, r.detail])).toEqual([
    [0, "billing", null, ""],
    [1, "Tables", null, ""],
    [2, "invoices", "changed", "4 changes"],
    [3, "total", "changed", "numeric(10,2) to numeric(12,2)"],
    [3, "fax", "removed", "text"],
    [3, "due_on", "added", "date"],
    [3, "invoices_due_on_idx", "added", "index"],
    [2, "legacy_invoices", "removed", "table"],
    [2, "payments", "changed", "1 change"],
    [3, "method", "changed", "default"],
    [2, "refunds", "added", "table, 4 columns"],
    [1, "Enums", null, ""],
    [2, "invoice_status", "changed", "+ written_off"],
    [2, "plan_kind", "changed", "- trial"],
    [0, "Not compared", null, ""],
  ]);
  expect(rows.find((r) => r.name === "Tables")?.count).toBe(4);
  expect(rows[rows.length - 1].count).toBe(4);
  expect(filterCounts(ITEMS)).toEqual({ all: 9, added: 3, removed: 2, changed: 4 });
});

test("filter_drops_empty_tables_and_collapse_hides_children", () => {
  const added = buildTree(ITEMS, "added", "billing", 0);
  expect(added.map((r) => r.name)).toEqual(["billing", "Tables", "invoices", "due_on", "invoices_due_on_idx", "refunds"]);
  const shown = visibleRows(buildTree(ITEMS, "all", "billing", 0), new Set(["table:invoices"]));
  expect(shown.map((r) => r.name)).not.toContain("fax");
  expect(shown.map((r) => r.name)).toContain("payments");
});

test("a_tick_through_a_not_scriptable_need_is_refused", () => {
  const items = [
    { id: "a", line: "SET DEFAULT t.c 'trial'", needs: ["e"], notScriptable: null },
    { id: "e", line: "Remove plan_kind value 'trial'", needs: [], notScriptable: "PostgreSQL cannot remove a value from an enum. Remove trial by hand." },
  ];
  expect(tickRefusal(items, "a")).toBe(
    "SET DEFAULT t.c 'trial' needs Remove plan_kind value 'trial': PostgreSQL cannot remove a value from an enum. Remove trial by hand.",
  );
  expect(tickRefusal(items, "e")).toBeNull();
});

test("a_created_table_closes_over_its_columns_indexes_and_incoming_keys", () => {
  const items = [
    { id: "table", needs: [], notScriptable: null },
    { id: "col", needs: ["table"], notScriptable: null },
    { id: "idx", needs: ["col"], notScriptable: null },
    { id: "fk", needs: ["table"], notScriptable: null },
    { id: "other", needs: [], notScriptable: null },
  ];
  const all = new Set(items.map((i) => i.id));
  // Unticking CREATE TABLE unticks every item that needs it, through its columns.
  expect([...toggleTick(items, all, "table", false)]).toEqual(["other"]);
  // Ticking a Foreign Key to the created table ticks the table.
  expect([...toggleTick(items, new Set(), "fk", true)].sort()).toEqual(["fk", "table"]);
});

test("the_mode_sentence_drops_one_transaction_when_enum_values_commit_first", () => {
  expect(confirmModeNote({ kind: "transaction" })).toBe("They run in one transaction: if one fails, nothing changes.");
  expect(confirmModeNote({ kind: "transaction" }, true)).toBe(
    "The enum values are added first and stay. The rest run in one transaction: if one fails, none of the rest is applied.",
  );
  expect(confirmModeNote({ kind: "sequential" })).toBe("They run one by one: if one fails, the ones before it stay.");
  expect(confirmModeNote({ kind: "copyOnly", reason: "x" })).toBeUndefined();
});
