import { fireEvent, render, screen } from "@testing-library/react";
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
  const rows = Array.from(dialog.querySelectorAll(".confirm-stmt"));
  expect(rows.map((r) => r.querySelector(".confirm-tag")!.textContent)).toEqual(["reads", "writes", "writes"]);
  expect(rows[1].textContent).toContain("UPDATE orders SET status = 'shipped'");
  expect(rows[1].textContent).toContain("WHERE id = 10482");
  expect(dialog.textContent).toContain(
    "Enter runs only when Run on freight-prod has focus. Press Tab to reach it, or click it.",
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  const run = screen.getByRole("button", { name: "Run on freight-prod" });
  expect(run.className).toContain("button-primary");
  expect(run.className).not.toContain("button-danger-fill");
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
  expect(screen.getByRole("alert").textContent).toContain("UPDATE without WHERE changes every row in orders.");
  expect(screen.getByText("1 of 2 statements writes.")).toBeTruthy();
  expect(screen.getByText("no WHERE")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Run on freight-prod" }).className).toContain("button-danger-fill");
  await userEvent.click(screen.getByRole("button", { name: "Add WHERE" }));
  expect(onAddWhere).toHaveBeenCalledTimes(1);
  expect(onRun).not.toHaveBeenCalled();
});
