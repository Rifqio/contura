import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { SqlBlock } from "../api/types";
import type { SqlEditorApi } from "../query/SqlEditor";
import { type Stmt, splitStatements, statementAt } from "../query/statements";
import AnswerSql from "./AnswerSql";
import AnswerText from "./AnswerText";

/** An editor holding `doc`, typing at `at`, with an optional selection. */
function fakeEditor(doc: string, at: number, selection?: [number, number]) {
  let text = doc;
  const api: SqlEditorApi = {
    text: () => text,
    runTarget: (): Stmt | null => {
      if (selection) return { from: selection[0], to: selection[1], text: text.slice(selection[0], selection[1]) };
      return statementAt(splitStatements(text, "postgres"), at);
    },
    select: vi.fn(),
    insert: vi.fn(),
    replaceAll: vi.fn(),
    replaceRange: vi.fn((from: number, to: number, insert: string) => {
      text = text.slice(0, from) + insert + text.slice(to);
    }),
    focus: vi.fn(),
    band: vi.fn(),
  };
  return { api, now: () => text };
}

const READ: SqlBlock = {
  fence: 0,
  label: "1 statement: 1 read",
  statements: [{ text: "SELECT id FROM invoices", class: "read", flags: [] }],
};

const NO_WHERE: SqlBlock = {
  fence: 0,
  label: "1 statement: 1 write (UPDATE). UPDATE without WHERE.",
  statements: [{ text: "UPDATE t SET a = 1", class: "write", flags: [{ kind: "noWhere", verb: "UPDATE" }] }],
};

const DOC = "-- report\nSELECT id\nFROM orders\nLIMIT 5;\n\nSELECT 2;\n";

function renderSql(over: Partial<React.ComponentProps<typeof AnswerSql>> = {}) {
  const ed = fakeEditor(DOC, 15);
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
  expect(screen.queryByRole("button", { name: "Insert into the editor" })).toBeNull();
});

test("no_run_button", () => {
  renderSql();
  expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  expect(screen.getByRole("button", { name: "Insert into the editor" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open in new tab" })).toBeTruthy();
});

test("insert_shows_diff_then_replaces", async () => {
  const user = userEvent.setup();
  const { ed } = renderSql();
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  expect(ed.api.replaceRange).not.toHaveBeenCalled();
  const diff = screen.getByRole("region", { name: "Insert into the editor" });
  expect(diff.textContent).toContain("Replaces lines 1 to 4 of Query 2");
  const rows = Array.from(diff.querySelectorAll(".diff-line")).map((r) => [r.className.split(" ")[1] ?? "", r.querySelector(".diff-text")!.textContent]);
  expect(rows).toEqual([
    ["del", "-- report"],
    ["del", "SELECT id"],
    ["del", "FROM orders"],
    ["del", "LIMIT 5;"],
    ["add", "SELECT id FROM invoices;"],
  ]);
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(ed.api.replaceRange).toHaveBeenCalledTimes(1);
  expect(ed.now()).toBe("SELECT id FROM invoices;\n\nSELECT 2;\n");
  expect(screen.queryByRole("region", { name: "Insert into the editor" })).toBeNull();
  expect(screen.getByText("Inserted into the editor")).toBeTruthy();
});

test("insert_replaces_the_selection_when_there_is_one", async () => {
  const user = userEvent.setup();
  const ed = fakeEditor(DOC, 0, [10, 30]);
  renderSql({ target: { editor: () => ed.api, name: "Query 2" } });
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  expect(screen.getByRole("region", { name: "Insert into the editor" }).textContent).toContain("Replaces lines 2 to 3 of Query 2");
});

test("insert_into_an_empty_editor_adds", async () => {
  const user = userEvent.setup();
  const ed = fakeEditor("", 0);
  renderSql({ target: { editor: () => ed.api, name: "Query 3" } });
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  expect(screen.getByRole("region", { name: "Insert into the editor" }).textContent).toContain("Adds at line 1 of Query 3");
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(ed.now()).toBe("SELECT id FROM invoices;\n");
});

test("the_diff_repeats_the_flags", async () => {
  const user = userEvent.setup();
  renderSql({ sql: "UPDATE t SET a = 1", check: NO_WHERE });
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  expect(screen.getByRole("region", { name: "Insert into the editor" }).textContent).toContain("UPDATE without WHERE.");
});

test("cancel_keeps_editor", async () => {
  const user = userEvent.setup();
  const { ed } = renderSql();
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(ed.api.replaceRange).not.toHaveBeenCalled();
  expect(ed.now()).toBe(DOC);
  expect(screen.queryByRole("region", { name: "Insert into the editor" })).toBeNull();
  expect(screen.queryByText("Inserted into the editor")).toBeNull();
});

test("an_editor_changed_under_the_diff_is_diffed_again_not_overwritten", async () => {
  const user = userEvent.setup();
  const { ed } = renderSql();
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  ed.api.replaceRange(0, 0, "-- typed\n");
  (ed.api.replaceRange as ReturnType<typeof vi.fn>).mockClear();
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(ed.api.replaceRange).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Insert into the editor" }).textContent).toContain("The editor changed");
});

test("without_a_query_tab_insert_is_disabled", () => {
  renderSql({ target: null });
  expect((screen.getByRole("button", { name: "Insert into the editor" }) as HTMLButtonElement).disabled).toBe(true);
});

test("insert_commented_out_for_write_in_explain", async () => {
  const user = userEvent.setup();
  const check: SqlBlock = {
    fence: 0,
    label: "1 statement: 1 write (DELETE). This answer contains a write.",
    statements: [{ text: "DELETE FROM invoices WHERE id = 3", class: "write", flags: [{ kind: "writeInReadAnswer" }] }],
  };
  const ed = fakeEditor("", 0);
  const onCopy = vi.fn();
  renderSql({ sql: "DELETE FROM invoices WHERE id = 3", check, target: { editor: () => ed.api, name: "Query 2" }, onCopy });
  const card = screen.getByRole("alert");
  expect(card.textContent).toContain("This answer writes to the database: 1 delete.");
  expect(card.textContent).toContain(
    "The SQL check found a write. Insert puts it in the editor commented out, so Run cannot pick it up by accident.",
  );
  expect(screen.queryByRole("button", { name: "Insert into the editor" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(onCopy).toHaveBeenCalledWith("DELETE FROM invoices WHERE id = 3");
  await user.click(screen.getByRole("button", { name: "Insert commented out" }));
  const diff = screen.getByRole("region", { name: "Insert into the editor" });
  expect(diff.textContent).toContain("-- DELETE FROM invoices WHERE id = 3;");
  expect(diff.textContent).toContain("This answer contains a write.");
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(ed.now()).toBe("-- DELETE FROM invoices WHERE id = 3;\n");
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
  const ed = fakeEditor("", 0);
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
  expect(screen.queryByRole("button", { name: "Insert into the editor" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in new tab" })).toBeNull();
  expect(actions()).toEqual(["Insert commented out", "Copy"]);
  await user.click(screen.getByRole("button", { name: "Insert commented out" }));
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(ed.now()).toBe("-- DELETE FROM invoices;\n");
});

test("an_answer_with_its_check_has_the_real_actions", () => {
  renderAnswer("```sql\nSELECT id FROM invoices\n```", [READ]);
  expect(actions()).toEqual(["Insert into the editor", "Open in new tab"]);
});

test("an_unclosed_fence_without_a_check_has_copy_only", () => {
  renderAnswer("```sql\nDELETE FROM invoices WHERE");
  expect(actions()).toEqual(["Copy"]);
});

test("insert_writes_only_into_the_tab_the_diff_was_made_for", async () => {
  const user = userEvent.setup();
  const one = fakeEditor("", 0);
  const two = fakeEditor("", 0);
  let current = one;
  render(
    <AnswerSql
      sql="SELECT id FROM invoices"
      dialect="postgres"
      check={READ}
      target={{ editor: () => current.api, get name() { return current === one ? "Query 1" : "Query 2"; } }}
      onCopy={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  current = two;
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(one.api.replaceRange).not.toHaveBeenCalled();
  expect(two.api.replaceRange).not.toHaveBeenCalled();
  const diff = screen.getByRole("region", { name: "Insert into the editor" });
  expect(diff.textContent).toContain("The editor changed");
  expect(diff.textContent).toContain("of Query 2");
});

test("line_numbers_in_the_diff_have_grouping_commas", async () => {
  const user = userEvent.setup();
  const ed = fakeEditor("\n".repeat(1204), 0);
  renderSql({ target: { editor: () => ed.api, name: "Query 3" } });
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  expect(screen.getByRole("region", { name: "Insert into the editor" }).textContent).toContain("Adds at line 1,205 of Query 3");
});

// ---- Final fix wave: the Diagram's "You:" box ----

test("each_action_is_reported_once_it_happens", async () => {
  const user = userEvent.setup();
  const onAction = vi.fn();
  renderSql({ onAction });
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  expect(onAction).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(onAction).toHaveBeenLastCalledWith("inserted");
  await user.click(screen.getByRole("button", { name: "Open in new tab" }));
  expect(onAction).toHaveBeenLastCalledWith("openedInNewTab");
});

test("a_commented_insert_is_reported_as_such", async () => {
  const user = userEvent.setup();
  const onAction = vi.fn();
  renderSql({ onAction, check: null, unchecked: true });
  await user.click(screen.getByRole("button", { name: "Insert commented out" }));
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(onAction).toHaveBeenCalledWith("insertedCommented");
});
