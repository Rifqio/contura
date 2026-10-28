import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { SqlBlock } from "../api/types";
import { splitStatements, statementAt } from "../query/statements";
import { fakeSqlEditor } from "../test/fakeSqlEditor";
import AnswerSql from "./AnswerSql";
import AnswerText from "./AnswerText";
import { sha256Hex } from "./sha256";

/** The last mark the block asked the editor for. */
const lastMark = (ed: ReturnType<typeof fakeSqlEditor>) => ed.marks[ed.marks.length - 1];

const READ: SqlBlock = {
  fence: 0,
  label: "1 statement: 1 read",
  statements: [{ text: "SELECT id FROM invoices", class: "read", flags: [] }],
  bodySha256: sha256Hex("SELECT id FROM invoices"),
};

const NO_WHERE: SqlBlock = {
  fence: 0,
  label: "1 statement: 1 write (UPDATE). UPDATE without WHERE.",
  statements: [{ text: "UPDATE t SET a = 1", class: "write", flags: [{ kind: "noWhere", verb: "UPDATE" }] }],
};

const DOC = "-- report\nSELECT id\nFROM orders\nLIMIT 5;\n\nSELECT 2;\n";

function renderSql(over: Partial<React.ComponentProps<typeof AnswerSql>> = {}) {
  const ed = fakeSqlEditor(DOC, 15);
  const onCopy = vi.fn();
  const onOpenInNewTab = vi.fn();
  render(
    <AnswerSql
      sql="SELECT id FROM invoices"
      dialect="postgres"
      check={READ}
      target={{ editor: () => ed.api, name: "Query 2" }}
      onCopy={onCopy}
      onOpenInNewTab={onOpenInNewTab}
      {...over}
    />,
  );
  return { ed, onCopy, onOpenInNewTab };
}

test("label_and_flags", () => {
  renderSql();
  const block = screen.getByRole("group", { name: "SQL answer" });
  expect(block.querySelector(".answer-sql-head")!.textContent).toContain("1 statement: 1 read");
  expect(block.querySelector(".answer-sql-head")!.classList.contains("warn")).toBe(false);
  expect(screen.getByRole("button", { name: "Copy the SQL" })).toBeTruthy();
});

test("a_block_with_flags_or_writes_has_a_warning_head", () => {
  renderSql({ sql: "UPDATE t SET a = 1", check: NO_WHERE });
  const head = document.querySelector(".answer-sql-head")!;
  expect(head.classList.contains("warn")).toBe(true);
  expect(head.textContent).toContain("1 statement: 1 write (UPDATE). UPDATE without WHERE.");
});

test("while_streaming_a_block_has_no_label_and_no_actions", () => {
  renderSql({ check: null, streaming: true });
  expect(document.querySelector(".answer-sql-head")!.textContent).toBe("");
  expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
});

test("no_run_button", () => {
  renderSql();
  expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  expect(screen.getByRole("button", { name: "Insert" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Apply to statement" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open in new tab" })).toBeTruthy();
});

test("a3_insert_and_apply_name_the_lines_they_touch", () => {
  renderSql();
  // The cursor is in the statement on lines 2 to 4: Insert goes below it, Apply replaces it.
  const where = document.querySelector(".answer-sql-where")!.textContent;
  expect(where).toContain("Insert adds line 6 of Query 2, below the current statement.");
  expect(where).toContain("Apply replaces lines 2 to 4 of Query 2.");
  const first = document.querySelector(".answer-sql-actions button")!;
  expect(first.textContent).toBe("Insert");
  expect(first.classList.contains("button-primary")).toBe(true);
});

test("a3_insert_shows_a_diff_in_the_editor_first_and_never_splits_the_statement", async () => {
  const user = userEvent.setup();
  const { ed } = renderSql();
  await user.click(screen.getByRole("button", { name: "Insert" }));
  // Nothing is written until it is kept.
  expect(ed.now()).toBe(DOC);
  expect(ed.pending()).toMatchObject({ text: "\n\nSELECT id FROM invoices;", bar: true, focus: true, keepLabel: "Keep" });
  expect(screen.getByRole("status").textContent).toContain("Ctrl+Enter keeps, Esc discards");
  act(() => void ed.api.keepSuggestion());
  expect(ed.now()).toBe("-- report\nSELECT id\nFROM orders\nLIMIT 5;\n\nSELECT id FROM invoices;\n\nSELECT 2;\n");
  expect(screen.getByRole("status").textContent).toBe("Kept in the editor");
});

test("a3_apply_replaces_the_current_statement_through_the_diff", async () => {
  const user = userEvent.setup();
  const { ed } = renderSql();
  await user.click(screen.getByRole("button", { name: "Apply to statement" }));
  expect(ed.now()).toBe(DOC);
  expect(ed.pending()?.where).toBe("Apply replaces lines 2 to 4 of Query 2");
  act(() => void ed.api.keepSuggestion());
  expect(ed.now()).toBe("-- report\nSELECT id FROM invoices;\n\nSELECT 2;\n");
});

test("a3_apply_names_and_replaces_only_the_selection", async () => {
  const user = userEvent.setup();
  const ed = fakeSqlEditor(DOC, 0, [10, 30]);
  renderSql({ target: { editor: () => ed.api, name: "Query 2" } });
  await user.click(screen.getByRole("button", { name: "Apply to selection" }));
  expect(ed.pending()?.where).toBe("Apply replaces lines 2 to 3 of Query 2");
});

test("a3_on_a_blank_line_apply_is_off_and_insert_adds_at_the_cursor", async () => {
  const user = userEvent.setup();
  const ed = fakeSqlEditor(DOC, DOC.indexOf("\n\n") + 1);
  renderSql({ target: { editor: () => ed.api, name: "Query 2" } });
  const apply = screen.getByRole("button", { name: "Apply to statement" });
  expect(apply.getAttribute("aria-disabled")).toBe("true");
  expect(document.querySelector(".answer-sql-where")!.textContent).toContain("Apply needs a selection, or a statement where you are typing.");
  expect(document.querySelector(".answer-sql-where")!.textContent).toContain("Insert adds line 5 of Query 2 where you are typing.");
  await user.click(apply);
  expect(ed.pending()).toBeNull();
});

test("a3_hover_and_keyboard_focus_mark_the_lines_and_leaving_clears_them", async () => {
  const user = userEvent.setup();
  const { ed } = renderSql();
  const insert = screen.getByRole("button", { name: "Insert" });
  const apply = screen.getByRole("button", { name: "Apply to statement" });
  fireEvent.pointerEnter(insert);
  expect(lastMark(ed)).toEqual({ after: DOC.indexOf("LIMIT 5;") + 8 });
  fireEvent.pointerLeave(insert);
  expect(lastMark(ed)).toBeNull();
  fireEvent.pointerEnter(apply);
  expect(lastMark(ed)).toEqual({ from: DOC.indexOf("SELECT id"), to: DOC.indexOf("LIMIT 5;") + 8 });
  fireEvent.pointerLeave(apply);
  // Keyboard focus marks too, and Tab away clears.
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy the SQL" }));
  await user.tab();
  expect(document.activeElement).toBe(insert);
  expect(lastMark(ed)).toEqual({ after: DOC.indexOf("LIMIT 5;") + 8 });
  await user.tab();
  expect(lastMark(ed)).toEqual({ from: DOC.indexOf("SELECT id"), to: DOC.indexOf("LIMIT 5;") + 8 });
  await user.tab();
  expect(lastMark(ed)).toBeNull();
});

test("a3_unmounting_while_marked_clears_the_marks", () => {
  const { ed } = renderSql();
  fireEvent.pointerEnter(screen.getByRole("button", { name: "Insert" }));
  cleanup();
  expect(lastMark(ed)).toBeNull();
});

test("insert_into_an_empty_editor_adds_line_1", async () => {
  const user = userEvent.setup();
  const ed = fakeSqlEditor("", 0);
  renderSql({ target: { editor: () => ed.api, name: "Query 3" } });
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(ed.pending()?.where).toBe("Insert adds line 1 of Query 3 where you are typing");
  act(() => void ed.api.keepSuggestion());
  expect(ed.now()).toBe("SELECT id FROM invoices;\n");
});

test("discard_keeps_the_editor_and_says_nothing_went_in", async () => {
  const user = userEvent.setup();
  const onAction = vi.fn();
  const { ed } = renderSql({ onAction });
  await user.click(screen.getByRole("button", { name: "Insert" }));
  act(() => void ed.api.discardSuggestion());
  expect(ed.now()).toBe(DOC);
  expect(screen.getByRole("status").textContent).toBe("");
  expect(onAction).not.toHaveBeenCalled();
});

test("without_a_query_tab_insert_and_apply_are_disabled", () => {
  renderSql({ target: null });
  expect((screen.getByRole("button", { name: "Insert" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Apply to statement" }) as HTMLButtonElement).disabled).toBe(true);
});

test("insert_commented_out_for_write_in_explain", async () => {
  const user = userEvent.setup();
  const check: SqlBlock = {
    fence: 0,
    label: "1 statement: 1 write (DELETE). This answer contains a write.",
    statements: [{ text: "DELETE FROM invoices WHERE id = 3", class: "write", flags: [{ kind: "writeInReadAnswer" }] }],
  };
  const ed = fakeSqlEditor("", 0);
  const onCopy = vi.fn();
  renderSql({ sql: "DELETE FROM invoices WHERE id = 3", check, target: { editor: () => ed.api, name: "Query 2" }, onCopy });
  const card = screen.getByRole("alert");
  expect(card.textContent).toContain("This answer writes to the database: 1 delete.");
  expect(card.textContent).toContain(
    "The SQL check found a write. Insert puts it in the editor commented out, so Run cannot pick it up by accident.",
  );
  expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(onCopy).toHaveBeenCalledWith("DELETE FROM invoices WHERE id = 3");
  await user.click(screen.getByRole("button", { name: "Insert commented out" }));
  expect(ed.pending()?.keepLabel).toBe("Keep, commented out");
  act(() => void ed.api.keepSuggestion());
  expect(ed.now()).toBe("-- DELETE FROM invoices WHERE id = 3;\n");
});

test("parity_P11_30_an_answer_that_writes_inserts_commented_out", async () => {
  const user = userEvent.setup();
  const check: SqlBlock = {
    fence: 0,
    label: "1 statement: 1 write (UPDATE)",
    statements: [{ text: "UPDATE shipments SET carrier = 'DHL' WHERE id = 7", class: "write", flags: [] }],
  };
  const ed = fakeSqlEditor("", 0);
  renderSql({ sql: "UPDATE shipments SET carrier = 'DHL' WHERE id = 7", check, target: { editor: () => ed.api, name: "Query 3" } });
  // Board 11.6, "Answer writes": the note, and Insert only commented out.
  const card = screen.getByRole("alert");
  expect(card.textContent).toContain("This answer writes to the database: 1 update.");
  expect(card.textContent).toContain("The SQL check found a write. Insert puts it in the editor commented out, so Run cannot pick it up by accident.");
  expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Insert commented out" }));
  act(() => void ed.api.keepSuggestion());
  expect(ed.now()).toBe("-- UPDATE shipments SET carrier = 'DHL' WHERE id = 7;\n");
  // Run finds no statement in it until the user uncomments it.
  expect(splitStatements(ed.now(), "postgres")).toEqual([]);
  expect(statementAt(splitStatements(ed.now(), "postgres"), 0)).toBeNull();
});

test("a_commented_write_goes_below_the_statement_and_removes_nothing", async () => {
  const user = userEvent.setup();
  const { ed } = renderSql({ sql: "UPDATE t SET a = 1", check: NO_WHERE });
  await user.click(screen.getByRole("button", { name: "Insert commented out" }));
  expect(ed.pending()).toMatchObject({ from: DOC.indexOf("LIMIT 5;") + 8, to: DOC.indexOf("LIMIT 5;") + 8, text: "\n\n-- UPDATE t SET a = 1;" });
});

test("write_counts_name_each_verb", () => {
  const check: SqlBlock = {
    fence: 0,
    label: "3 statements: 3 writes (UPDATE, DELETE)",
    statements: [
      { text: "UPDATE a SET x = 1 WHERE id = 1", class: "write", flags: [{ kind: "writeInReadAnswer" }] },
      { text: "-- then\nUPDATE b SET x = 1 WHERE id = 1", class: "write", flags: [{ kind: "writeInReadAnswer" }] },
      { text: "DELETE FROM c WHERE id = 1", class: "write", flags: [{ kind: "writeInReadAnswer" }] },
    ],
  };
  renderSql({ sql: "UPDATE a SET x = 1 WHERE id = 1;", check });
  expect(screen.getByRole("alert").textContent).toContain("This answer writes to the database: 2 updates, 1 delete.");
});

test("open_in_new_tab", async () => {
  const user = userEvent.setup();
  const { onOpenInNewTab, ed } = renderSql();
  await user.click(screen.getByRole("button", { name: "Open in new tab" }));
  expect(onOpenInNewTab).toHaveBeenCalledWith("SELECT id FROM invoices");
  expect(ed.api.replaceRange).not.toHaveBeenCalled();
});

test("copy_copies_the_sql", async () => {
  const user = userEvent.setup();
  const { onCopy } = renderSql();
  await user.click(screen.getByRole("button", { name: "Copy the SQL" }));
  expect(onCopy).toHaveBeenCalledWith("SELECT id FROM invoices");
});

function renderAnswer(text: string, blocks?: SqlBlock[] | null) {
  const ed = fakeSqlEditor("", 0);
  const onOpenInNewTab = vi.fn();
  render(
    <AnswerText
      text={text}
      blocks={blocks}
      dialect="postgres"
      target={{ editor: () => ed.api, name: "Query 2" }}
      onOpenInNewTab={onOpenInNewTab}
      onCopy={vi.fn()}
    />,
  );
  return { ed, onOpenInNewTab };
}

const actions = () =>
  Array.from(document.querySelectorAll(".answer-sql-actions button")).map((b) => b.textContent);

test("a_reloaded_answer_without_its_check_inserts_only_commented_out", async () => {
  const user = userEvent.setup();
  const { ed } = renderAnswer("Clean up:\n\n```sql\nDELETE FROM invoices\n```");
  expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in new tab" })).toBeNull();
  expect(actions()).toEqual(["Insert commented out", "Copy"]);
  await user.click(screen.getByRole("button", { name: "Insert commented out" }));
  act(() => void ed.api.keepSuggestion());
  expect(ed.now()).toBe("-- DELETE FROM invoices;\n");
});

test("an_answer_with_its_check_has_the_real_actions", () => {
  renderAnswer("```sql\nSELECT id FROM invoices\n```", [READ]);
  expect(actions()).toEqual(["Insert", "Apply to statement", "Open in new tab"]);
});

test("an_unclosed_fence_without_a_check_has_copy_only", () => {
  renderAnswer("```sql\nDELETE FROM invoices WHERE");
  expect(actions()).toEqual(["Copy"]);
});

test("line_numbers_have_grouping_commas", () => {
  const ed = fakeSqlEditor("\n".repeat(1204), 1204);
  renderSql({ target: { editor: () => ed.api, name: "Query 3" } });
  expect(document.querySelector(".answer-sql-where")!.textContent).toContain("Insert adds line 1,205 of Query 3 where you are typing.");
});

// ---- Final fix wave: the Diagram's "You:" box ----

test("each_action_is_reported_once_it_happens", async () => {
  const user = userEvent.setup();
  const onAction = vi.fn();
  const { ed } = renderSql({ onAction });
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(onAction).not.toHaveBeenCalled();
  act(() => void ed.api.keepSuggestion());
  // With the SQL as it went in, and for Open in new tab the new tab's key (none opened here).
  expect(onAction).toHaveBeenLastCalledWith("inserted", "SELECT id FROM invoices;\n");
  await user.click(screen.getByRole("button", { name: "Open in new tab" }));
  expect(onAction).toHaveBeenLastCalledWith("openedInNewTab", "SELECT id FROM invoices", null);
});

test("a_commented_insert_is_reported_as_such", async () => {
  const user = userEvent.setup();
  const onAction = vi.fn();
  const { ed } = renderSql({ onAction, check: null, unchecked: true });
  await user.click(screen.getByRole("button", { name: "Insert commented out" }));
  act(() => void ed.api.keepSuggestion());
  expect(onAction).toHaveBeenCalledWith("insertedCommented", expect.stringMatching(/^-- SELECT id FROM invoices;/));
});

test("non-query tab offers Open in new query tab", async () => {
  const onAction = vi.fn();
  const { ed, onOpenInNewTab } = renderSql({ target: null, noEditor: true, onAction });
  expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Insert/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open in new query tab" }));
  expect(onOpenInNewTab).toHaveBeenCalledWith("SELECT id FROM invoices");
  expect(onAction).toHaveBeenCalledWith("openedInNewTab", "SELECT id FROM invoices", null);
  // Nothing went into an editor and nothing ran.
  expect(ed.api.replaceRange).not.toHaveBeenCalled();
  expect(ed.api.insert).not.toHaveBeenCalled();
});

test("non-query tab: a write opens in a new query tab, commented out", async () => {
  const { onOpenInNewTab } = renderSql({ sql: "UPDATE t SET a = 1", check: NO_WHERE, target: null, noEditor: true });
  expect(screen.queryByRole("button", { name: "Open in new query tab" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Insert commented out" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open in new query tab, commented out" }));
  expect(onOpenInNewTab).toHaveBeenCalledWith("-- UPDATE t SET a = 1;\n");
});

test("non-query tab: an unchecked block opens commented out too", async () => {
  const { onOpenInNewTab } = renderSql({ check: null, unchecked: true, target: null, noEditor: true });
  expect(screen.queryByRole("button", { name: "Insert commented out" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open in new query tab, commented out" }));
  expect(onOpenInNewTab).toHaveBeenCalledWith("-- SELECT id FROM invoices;\n");
});

test("a query tab keeps Insert and Open in new tab", () => {
  renderSql();
  expect(screen.getByRole("button", { name: "Insert" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open in new tab" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open in new query tab" })).toBeNull();
});

/** A Core check whose statements are all of `cls`. */
const checked = (label: string, statements: [string, "read" | "write"][]): SqlBlock => ({
  fence: 0,
  label,
  statements: statements.map(([text, cls]) => ({ text, class: cls, flags: [] })),
});

/** Every line of an opened text is behind `-- `, whatever line ends it had. */
const allCommented = (text: string) =>
  text
    .trimEnd()
    .split(/\r\n|\r|\n|\u0085|\u2028|\u2029/)
    .every((l) => l.startsWith("-- "));

test.each([
  ["a write after a lone CR", "SELECT 1;\rDROP TABLE orders;", checked("2 statements", [["SELECT 1", "read"], ["DROP TABLE orders", "write"]])],
  ["mixed line ends", "SELECT 1;\r\nDELETE FROM a;\rDELETE FROM b;\nDELETE FROM c;", checked("4 statements", [["SELECT 1", "read"], ["DELETE FROM a", "write"], ["DELETE FROM b", "write"], ["DELETE FROM c", "write"]])],
  ["a read then a write", "SELECT id FROM orders;\nUPDATE orders SET total = 0;", checked("2 statements", [["SELECT id FROM orders", "read"], ["UPDATE orders SET total = 0", "write"]])],
  ["a CTE with DML", "WITH gone AS (DELETE FROM orders RETURNING id)\nSELECT count(*) FROM gone;", checked("1 statement", [["WITH gone AS (DELETE FROM orders RETURNING id) SELECT count(*) FROM gone", "write"]])],
  ["DDL", "CREATE TABLE monthly_totals (\n  customer_id int not null\n);", checked("1 statement", [["CREATE TABLE monthly_totals (customer_id int not null)", "write"]])],
  ["a CALL", "CALL refresh_totals();", checked("1 statement", [["CALL refresh_totals()", "write"]])],
])("non-query tab: %s opens only commented out", async (_name, sql, check) => {
  const { onOpenInNewTab } = renderSql({ sql, check, target: null, noEditor: true });
  expect(screen.queryByRole("button", { name: "Open in new query tab" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Insert/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open in new query tab, commented out" }));
  const opened = onOpenInNewTab.mock.calls[0][0] as string;
  expect(allCommented(opened)).toBe(true);
  expect(opened).not.toMatch(/[\r\u0085\u2028\u2029]/);
});

test("a lone CR in an answer opens as the Core checked it: the write after it only commented out", async () => {
  // MySQL reads `-- note\rDROP ...` as one comment, the editor as two lines. The Core and the parser both read the
  // CR as a line end, so the DROP is checked as the write the editor would run.
  const check: SqlBlock = {
    fence: 0,
    label: "2 statements: 1 read, 1 write (DROP)",
    statements: [
      { text: "SELECT 1", class: "read", flags: [] },
      { text: "-- note\nDROP TABLE orders", class: "write", flags: [] },
    ],
  };
  const onOpenInNewTab = vi.fn();
  render(<AnswerText text={"```sql\nSELECT 1; -- note\rDROP TABLE orders;\n```"} blocks={[check]} dialect="mysql" target={null} noEditor onOpenInNewTab={onOpenInNewTab} onCopy={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Open in new query tab" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Insert/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open in new query tab, commented out" }));
  expect(onOpenInNewTab).toHaveBeenCalledWith("-- SELECT 1; -- note\n-- DROP TABLE orders;\n");
});

test("a block that still holds a CR is never opened or inserted live", () => {
  // Defence in depth: the parser removes every CR, but a block that has one is treated as unchecked.
  renderSql({ sql: "SELECT 1; -- note\rDROP TABLE orders" });
  expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in new tab" })).toBeNull();
  expect(screen.getByRole("button", { name: "Insert commented out" })).toBeTruthy();
  cleanup();
  renderSql({ sql: "SELECT 1; -- note\rDROP TABLE orders", target: null, noEditor: true });
  expect(screen.queryByRole("button", { name: "Open in new query tab" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open in new query tab, commented out" })).toBeTruthy();
});

// ---- A check is used only for the block it was made on (its body's hash) ----

const readCheck = (body: string, fence = 0): SqlBlock => ({
  fence,
  label: "1 statement: 1 read",
  statements: [{ text: body, class: "read", flags: [] }],
  bodySha256: sha256Hex(body),
});

test("a check whose body is another block's gives no plain Open and no Insert", () => {
  // The Core checked `SELECT 1` as fence 0; the UI's fence 0 holds a DROP: the check is not used.
  renderAnswer("```sql\nDROP TABLE orders\n```", [readCheck("SELECT 1")]);
  expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in new tab" })).toBeNull();
  expect(screen.getByRole("button", { name: "Insert commented out" })).toBeTruthy();
  expect(screen.queryByText("1 statement: 1 read")).toBeNull();
});

test("a check with no body hash (saved before it) is not used either", () => {
  const { bodySha256: _, ...old } = readCheck("SELECT 1");
  renderAnswer("```sql\nSELECT 1\n```", [old]);
  expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
  expect(screen.getByRole("button", { name: "Insert commented out" })).toBeTruthy();
});

test("a check on its own block is used, and so on a non-query tab", () => {
  renderAnswer("Run:\n```sql\nSELECT 1\n```", [readCheck("SELECT 1")]);
  expect(screen.getByText("1 statement: 1 read")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Insert" })).toBeTruthy();
});

test("an answer that ends mid-fence binds its check to that block", () => {
  // The Core checks an unclosed last fence when the answer ended normally; its body is the text to the end.
  renderAnswer("Try:\n```sql\nSELECT 1", [readCheck("SELECT 1")]);
  expect(screen.getByText("1 statement: 1 read")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Insert" })).toBeTruthy();
});

test("the NEL answer from the review: the read check never lands on the DROP", () => {
  // The Core numbers this answer's one fence as the DROP block (only space and tab indent a fence), so a read check
  // made on `SELECT 1` elsewhere cannot be used for it.
  renderAnswer("Here:\n\u0085```sql\nSELECT 1\n```\nDROP TABLE orders\n```", [readCheck("SELECT 1")]);
  expect(screen.queryByRole("button", { name: "Insert" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in new tab" })).toBeNull();
});
