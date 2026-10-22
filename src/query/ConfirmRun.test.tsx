import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { RunVerdict } from "../api/types";
import ConfirmRun from "./ConfirmRun";

type Ask = Extract<RunVerdict, { kind: "needsConfirmation" }>;

const VERDICT: Ask = {
  kind: "needsConfirmation",
  connection: "freight-prod",
  database: "shop",
  writes: 2,
  statements: [
    { text: "SELECT id, status FROM orders WHERE id = 10482", class: "read" },
    { text: "UPDATE orders SET status = 'shipped'\nWHERE id = 10482", class: "write" },
    { text: "INSERT INTO invoices (order_id) VALUES (10482)", class: "write" },
  ],
};

function setup(verdict: Ask = VERDICT, noWhere: Parameters<typeof ConfirmRun>[0]["noWhere"] = null) {
  const onRun = vi.fn();
  const onCancel = vi.fn();
  const onAddWhere = vi.fn();
  render(<ConfirmRun verdict={verdict} noWhere={noWhere} onRun={onRun} onCancel={onCancel} onAddWhere={onAddWhere} />);
  return { onRun, onCancel, onAddWhere };
}

test("dialog_lists_statements_with_labels_and_count", () => {
  setup();
  const dialog = screen.getByRole("dialog");
  expect(dialog.querySelector("h2")!.textContent).toBe("Run on freight-prod · shop");
  expect(dialog.querySelector("h2 b")!.textContent).toBe("freight-prod");
  expect(screen.getByText("2 of 3 statements write.")).toBeTruthy();
  expect(Array.from(dialog.querySelectorAll(".sql-block-tag")).map((t) => t.textContent)).toEqual(["reads", "writes", "writes"]);
  expect(dialog.querySelector(".sql-block")!.textContent).toContain("UPDATE orders SET status = 'shipped'");
  expect(dialog.querySelector(".sql-block")!.textContent).toContain("WHERE id = 10482");
  expect(dialog.textContent).toContain(
    "Enter runs only when Run on freight-prod has focus. Press Tab to reach it, or click it.",
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  const run = screen.getByRole("button", { name: "Run on freight-prod" });
  expect(run.className).toContain("button-primary");
  expect(run.className).not.toContain("button-danger-fill");
});

test("the_title_carries_the_mark_prod_chip_and_group_square", () => {
  render(
    <ConfirmRun
      verdict={VERDICT}
      noWhere={null}
      dialect="mysql"
      group={{ id: "g1", name: "Orbit Freight", color: "teal", hasImage: false }}
      onRun={() => {}}
      onCancel={() => {}}
      onAddWhere={() => {}}
    />,
  );
  const dialog = screen.getByRole("dialog");
  const header = dialog.querySelector(".dialog-header") as HTMLElement;
  expect(header.querySelector('[role="img"][aria-label="MySQL"]')).toBeTruthy();
  expect(header.textContent).toContain("PROD");
  expect(header.querySelector(".group-badge")!.textContent).toBe("O");
  // The title text itself is unchanged.
  expect(dialog.querySelector("h2")!.textContent).toBe("Run on freight-prod · shop");
  expect(dialog.querySelector("h2 b")!.textContent).toBe("freight-prod");
});

test("ligatures_never_change_the_text", () => {
  const sql = "a != b AND c >= 1 AND j->>'k' = 'x'";
  setup({ ...VERDICT, statements: [{ text: sql, class: "write" }] });
  const text = screen.getByRole("dialog").querySelector(".sql-block-text")!;
  expect(text.textContent).toBe(sql);
});

test("singular_count_and_no_database", () => {
  setup({ ...VERDICT, database: null, writes: 1, statements: [VERDICT.statements[1]] });
  expect(screen.getByRole("dialog").querySelector("h2")!.textContent).toBe("Run on freight-prod");
  expect(screen.getByText("1 of 1 statement writes.")).toBeTruthy();
});

test("enter_on_sql_block_does_not_run", async () => {
  const { onRun, onCancel } = setup();
  const block = screen.getByLabelText("SQL to run, read-only");
  expect(document.activeElement).toBe(block);
  await userEvent.keyboard("{Enter}");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
  expect(onRun).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  await userEvent.tab();
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run on freight-prod" }));
  await userEvent.keyboard("{Enter}");
  expect(onRun).toHaveBeenCalledTimes(1);
});

test("escape_cancels", async () => {
  const { onRun, onCancel } = setup();
  await userEvent.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onRun).not.toHaveBeenCalled();
});

test("no_where_warning_sits_at_the_top_with_add_where_and_a_red_button", async () => {
  const { onAddWhere, onRun } = setup(
    {
      ...VERDICT,
      writes: 1,
      statements: [
        { text: "SELECT COUNT(*) FROM orders", class: "read" },
        { text: "UPDATE orders SET carrier = 'Northline'", class: "write" },
      ],
    },
    { index: 1, verb: "UPDATE", table: "orders" },
  );
  expect(screen.getByRole("alert").textContent).toContain("Statement 2 has no WHERE. It changes every row in orders.");
  expect(screen.getByText("1 of 2 statements writes.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run on freight-prod" }).className).toContain("button-danger-fill");
  await userEvent.click(screen.getByRole("button", { name: "Add WHERE" }));
  expect(onAddWhere).toHaveBeenCalledTimes(1);
  expect(onRun).not.toHaveBeenCalled();
});

test("the Save variant says Save on the Connection", () => {
  render(
    <ConfirmRun
      verb="Save"
      verdict={{ kind: "needsConfirmation", connection: "freight-prod", database: "shop", statements: [{ text: "DELETE FROM t WHERE id = 1", class: "write" }], writes: 1 }}
      noWhere={null}
      onRun={() => {}}
      onCancel={() => {}}
      onAddWhere={() => {}}
    />,
  );
  expect(screen.getByRole("dialog").textContent).toContain("Save on freight-prod · shop");
  expect(screen.getByRole("button", { name: "Save on freight-prod" })).toBeTruthy();
  expect(screen.getByRole("dialog").textContent).toContain("Enter saves only when Save on freight-prod has focus.");
});

const NO_WHERE_VERDICT: Ask = {
  ...VERDICT,
  writes: 1,
  statements: [
    { text: "UPDATE order_items\n   SET discount = 0", class: "write" },
    { text: "SELECT count(*) FROM order_items WHERE discount != 0", class: "read" },
  ],
};

test("dialog_is_760_wide", () => {
  setup();
  expect(screen.getByRole("dialog").className).toContain("dialog-size-wide");
});

test("title_bolds_only_the_connection", () => {
  setup();
  const h2 = screen.getByRole("dialog").querySelector("h2")!;
  expect(h2.querySelectorAll("b, strong")).toHaveLength(1);
  expect(h2.querySelector("b")!.textContent).toBe("freight-prod");
});

test("count_line_is_regular", () => {
  setup();
  const line = screen.getByText("2 of 3 statements write.");
  expect(line.querySelector("strong, b")).toBeNull();
  expect(line.closest("strong, b")).toBeNull();
});

test("sql_uses_the_sql_block_with_colours_tags_and_bar", () => {
  setup();
  const dialog = screen.getByRole("dialog");
  const block = dialog.querySelector(".sql-block")!;
  expect(block).toBeTruthy();
  // Syntax colours come from the shared highlighter.
  expect(block.querySelector(".sql-block-text span[class]")).toBeTruthy();
  expect(Array.from(block.querySelectorAll(".sql-block-tag")).map((t) => t.textContent)).toEqual(["reads", "writes", "writes"]);
  // The Production band (and its 3 px bar) sits on writing lines only: UPDATE (2 lines) and INSERT.
  expect(block.querySelectorAll(".sql-block-line-prod")).toHaveLength(3);
  // Focus still starts on the labelled wrapper around the block.
  expect(screen.getByLabelText("SQL to run, read-only").contains(block)).toBe(true);
});

test("enter_hint_is_a_sentence_under_the_sql", () => {
  setup();
  const dialog = screen.getByRole("dialog");
  const hint = dialog.querySelector(".confirm-hint")!;
  expect(hint.textContent).toBe("Enter runs only when Run on freight-prod has focus. Press Tab to reach it, or click it.");
  expect(hint.querySelector("kbd, button")).toBeNull();
  const block = dialog.querySelector(".confirm-sql")!;
  expect(block.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(dialog.querySelector(".dialog-footer")!.contains(hint)).toBe(false);
  expect(Array.from(dialog.querySelectorAll(".dialog-footer button")).map((b) => b.textContent)).toEqual([
    "Cancel",
    "Run on freight-prod",
  ]);
});

test("save_variant_copy", () => {
  render(
    <ConfirmRun
      verb="Save"
      verdict={{ ...VERDICT, writes: 3, statements: [1, 2, 3].map((i) => ({ text: `DELETE FROM t WHERE id = ${i}`, class: "write" as const })) }}
      noWhere={null}
      onRun={() => {}}
      onCancel={() => {}}
      onAddWhere={() => {}}
    />,
  );
  const dialog = screen.getByRole("dialog");
  expect(screen.getByText("3 of 3 statements write. They run in one transaction.")).toBeTruthy();
  expect(dialog.querySelector(".confirm-hint")!.textContent).toBe(
    "Enter saves only when Save on freight-prod has focus. Press Tab to reach it, or click it.",
  );
});

test("no_where_names_the_row_estimate", () => {
  const props = { verdict: NO_WHERE_VERDICT, noWhere: { index: 0, verb: "UPDATE" as const, table: "order_items" }, onRun() {}, onCancel() {}, onAddWhere() {} };
  const { unmount } = render(<ConfirmRun {...props} rowEstimate={412960} />);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Statement 1 has no WHERE. It changes every row in order_items, about 412,960 rows.");
  expect(alert.querySelector("strong, b")!.textContent).toBe("Statement 1 has no WHERE.");
  expect(screen.getByRole("button", { name: "Add WHERE" })).toBeTruthy();
  unmount();
  render(<ConfirmRun {...props} rowEstimate={null} />);
  expect(screen.getByRole("alert").textContent).toContain("Statement 1 has no WHERE. It changes every row in order_items.");
  expect(screen.getByRole("alert").textContent).not.toContain("about");
});

test("apply_verb_title_hint_and_warning_banners", () => {
  render(
    <ConfirmRun
      verb="Apply"
      verdict={{
        kind: "needsConfirmation",
        connection: "freight-prod",
        database: "shop",
        statements: [{ text: "ALTER TABLE orders DROP COLUMN total", class: "write" }],
        writes: 1,
      }}
      warnings={["Dropping total deletes its data in every row."]}
      onRun={() => {}}
      onCancel={() => {}}
    />,
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.querySelector("h2")!.textContent).toBe("Apply on freight-prod · shop");
  expect(screen.getByRole("button", { name: "Apply on freight-prod" }).className).toContain("button-primary");
  expect(dialog.textContent).toContain("Enter applies only when Apply on freight-prod has focus.");
  const banner = screen.getByRole("alert");
  expect(banner.className).toContain("warning-banner");
  expect(banner.textContent).toContain("Dropping total deletes its data in every row.");
  // Warnings sit above the count line.
  const count = screen.getByText("1 of 1 statement writes.");
  expect(banner.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add WHERE" })).toBeNull();
});

test("no_where_banner_keeps_its_class", () => {
  setup(VERDICT, { index: 1, verb: "UPDATE", table: "orders" });
  const banner = screen.getByRole("alert");
  expect(banner.className).toContain("confirm-nowhere");
  expect(banner.className).toContain("warning-banner");
});

test("drop_verb_uses_the_danger_button", () => {
  render(
    <ConfirmRun
      verb="Drop"
      verdict={{ kind: "needsConfirmation", connection: "freight-prod", database: "shop", statements: [{ text: "DROP TABLE orders", class: "write" }], writes: 1 }}
      onRun={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Drop on freight-prod" }).className).toContain("button-danger-fill");
});

const SHAPE = {
  head: "INSERT INTO billing.products (id, name, price) VALUES",
  firstRows: ["(1, 'Tea', 2.50)", "(2, 'Cake', 4.00)", "(3, 'Soup', 6.00)", "(4, 'Bread', 3.20)"],
  rowsPerStatement: 500,
  statements: 3,
  rows: 1204,
};

function setupJob(onShowAll = vi.fn()) {
  const onRun = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmRun
      verb="Import"
      verdict={{ connection: "freight-prod", database: "freight" }}
      job={{
        title: "Inserts 1,204 rows into billing.products in 3 statements, in one transaction.",
        counts: "4 statements write.",
        shapes: [
          { kind: "shape", line: 1, shape: SHAPE },
          { kind: "exact", line: 0, text: "SELECT setval(pg_get_serial_sequence('billing.products', 'id'), max(id)) FROM billing.products" },
        ],
        fingerprint: "212 KB, SHA-256 4be0 91c2 ... 7d1f",
        onShowAll,
      }}
      dialect="postgres"
      onRun={onRun}
      onCancel={onCancel}
    />,
  );
  return { onRun, onCancel, onShowAll };
}

test("job_body_shows_summary_shape_fold_exact_and_fingerprint", async () => {
  const { onShowAll } = setupJob();
  const dialog = screen.getByRole("dialog");
  expect(screen.getByText("Inserts 1,204 rows into billing.products in 3 statements, in one transaction.")).toBeTruthy();
  expect(screen.getByText("4 statements write.")).toBeTruthy();
  const box = dialog.querySelector(".confirm-shape")!;
  expect(box.textContent).toContain("Statement 1 of 3, 500 rows each");
  expect(box.querySelector(".sql-block")!.textContent).toContain("INSERT INTO billing.products (id, name, price) VALUES");
  expect(box.querySelector(".sql-block")!.textContent).toContain("(4, 'Bread', 3.20)");
  expect(box.textContent).toContain("496 more rows in this statement, then 2 more statements");
  await userEvent.click(screen.getByRole("button", { name: "Show all" }));
  expect(onShowAll).toHaveBeenCalledTimes(1);
  expect(dialog.querySelector(".confirm-exact .sql-block")!.textContent).toContain("SELECT setval(pg_get_serial_sequence('billing.products', 'id'), max(id)) FROM billing.products");
  expect(dialog.textContent).toContain(
    "The file is fingerprinted (212 KB, SHA-256 4be0 91c2 ... 7d1f). If it changes before the run, Contura asks again.",
  );
});

test("job_import_verb_title_and_accent_primary_button", () => {
  setupJob();
  const dialog = screen.getByRole("dialog");
  expect(dialog.querySelector("h2")!.textContent).toBe("Import on freight-prod · freight");
  expect(dialog.querySelector("h2 b")!.textContent).toBe("freight-prod");
  const button = screen.getByRole("button", { name: "Import on freight-prod" });
  expect(button.className).toContain("button-primary");
  expect(button.className).not.toContain("button-prod");
  expect(dialog.querySelector(".confirm-hint")!.textContent).toBe(
    "Enter runs only when Import on freight-prod has focus. Press Tab to reach it, or click it.",
  );
});

test("job_enter_only_when_the_button_has_focus", async () => {
  const { onRun } = setupJob();
  expect(document.activeElement).toBe(screen.getByLabelText("SQL to run, read-only"));
  await userEvent.keyboard("{Enter}");
  expect(onRun).not.toHaveBeenCalled();
  screen.getByRole("button", { name: "Import on freight-prod" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(onRun).toHaveBeenCalledTimes(1);
});

test("job_script_list_interleaves_exact_and_shapes", () => {
  render(
    <ConfirmRun
      verb="Import"
      verdict={{ connection: "freight-prod", database: "freight" }}
      job={{
        title: "Runs 3 statements from dump.sql in freight, in one transaction.",
        counts: "3 statements: 1 create, 2 insert.",
        shapes: [
          { kind: "exact", line: 1, text: "CREATE TABLE t (a int)" },
          { kind: "shape", line: 2, shape: { head: "INSERT INTO t (a) VALUES", firstRows: ["(1)"], rowsPerStatement: 1, statements: 1, rows: 1 } },
          { kind: "exact", line: 3, text: "INSERT INTO t SELECT 2" },
        ],
      }}
      onRun={() => {}}
      onCancel={() => {}}
    />,
  );
  const items = Array.from(screen.getByRole("dialog").querySelectorAll(".confirm-item")).map((e) => (e.classList.contains("confirm-shape") ? "shape" : "exact"));
  expect(items).toEqual(["exact", "shape", "exact"]);
  expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  expect(screen.getByRole("dialog").textContent).not.toContain("fingerprinted");
});

test("restore_verb_with_its_own_body_banner_and_fingerprint_sentence", () => {
  render(
    <ConfirmRun
      verb="Restore"
      verdict={{ connection: "freight-prod", database: "freight_restore_1017" }}
      danger
      banner={<p>Replace drops 6 tables in freight.</p>}
      job={{
        title: "Creates freight_restore_1017. All of it writes.",
        shapes: [],
        fingerprintText: "Checked file: 48.2 MB, SHA-256 9f3c 1a7e ... e21a. If the file changes before the run, Contura asks again.",
        body: <p>the restore body</p>,
      }}
      onRun={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(screen.getByRole("heading").textContent).toBe("Restore on freight-prod · freight_restore_1017");
  expect(screen.getByText("the restore body")).toBeTruthy();
  expect(screen.getByText("Replace drops 6 tables in freight.")).toBeTruthy();
  expect(screen.getByText(/^Checked file: 48.2 MB/)).toBeTruthy();
  expect(screen.getByText("Enter runs only when Restore on freight-prod has focus. Press Tab to reach it, or click it.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restore on freight-prod" }).className).toContain("button-danger-fill");
});

test("a_plain_connection_has_no_prod_chip_and_the_bare_verb", () => {
  render(
    <ConfirmRun
      verb="Restore"
      production={false}
      verdict={{ connection: "freight-dev", database: "freight" }}
      job={{ title: "Creates 6 tables. All of it writes.", shapes: [] }}
      onRun={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(screen.queryByText("Production")).toBeNull();
  expect(screen.getByRole("button", { name: "Restore" }).className).toContain("button-primary");
});

test("assistant_tag", () => {
  setup({
    ...VERDICT,
    writes: 2,
    statements: [
      { text: "SELECT pg_sleep(1)", class: "write", byAssistant: true },
      { text: "UPDATE orders SET status = 'shipped'\nWHERE id = 10482", class: "write", byAssistant: false },
    ],
  });
  const dialog = screen.getByRole("dialog");
  const tags = Array.from(dialog.querySelectorAll(".sql-block-tag")).map((t) => t.textContent);
  expect(tags).toEqual(["Written by the assistant", "writes", "writes"]);
  const first = dialog.querySelectorAll(".sql-block-line")[0];
  expect(first.textContent).toContain("Written by the assistant");
  expect(within(dialog).getAllByText("Written by the assistant")).toHaveLength(1);
});

test("a_flagged_read_says_why_it_is_confirmed", () => {
  // Final review M2: a read the register made a write names its reason.
  setup({
    ...VERDICT,
    writes: 1,
    statements: [{ text: "SELECT pg_sleep(60)", class: "write", byAssistant: true, reason: "calls pg_sleep()" }],
  } as Ask);
  expect(screen.getByText("Written by the assistant and calls pg_sleep().")).toBeTruthy();
});

test("several_flagged_reads_name_their_statements", () => {
  setup({
    ...VERDICT,
    writes: 2,
    statements: [
      { text: "SELECT 1", class: "read" },
      { text: "SELECT pg_sleep(60)", class: "write", byAssistant: true, reason: "calls pg_sleep()" },
      { text: "DELETE FROM t WHERE a = 1", class: "write", byAssistant: true },
    ],
  } as Ask);
  expect(screen.getByText("Statement 2 was written by the assistant and calls pg_sleep().")).toBeTruthy();
});
