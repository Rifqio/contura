import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import RemoveDialog from "./RemoveDialog";

afterEach(() => cleanup());

test("remove_dialog_texts_and_buttons", () => {
  const on = { onCancel: vi.fn(), onReview: vi.fn(), onRemove: vi.fn() };
  render(<RemoveDialog shapes={["Take order", "Pick and pack", "Bill customer", "orders", "invoices", "Warehouse"]} columns={[]} lines={5} tables={["orders", "invoices"]} adds={3} frames={[]} {...on} />);
  expect(screen.getByText("This would remove 6 shapes and 5 lines: Take order, Pick and pack, Bill customer, orders, invoices and Warehouse. Then I'd draw 3 new shapes.")).toBeTruthy();
  expect(screen.getByText("Remove 6 shapes and 5 lines?")).toBeTruthy();
  expect(screen.getByText("Removing more than 3 shapes always asks, even with Auto-apply on. The links from orders and invoices to their tables go too.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Review each change" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove and redraw" }));
  expect(on.onCancel).toHaveBeenCalled();
  expect(on.onReview).toHaveBeenCalled();
  expect(on.onRemove).toHaveBeenCalled();
});

test("remove_only_and_no_tables", () => {
  render(<RemoveDialog shapes={["A", "B", "C", "D"]} columns={[]} lines={1} tables={[]} adds={0} frames={[]} onCancel={() => {}} onReview={() => {}} onRemove={() => {}} />);
  expect(screen.getByText("This would remove 4 shapes and 1 line: A, B, C and D.")).toBeTruthy();
  expect(screen.getByText("Remove 4 shapes and 1 line?")).toBeTruthy();
  expect(screen.getByText("Removing more than 3 shapes always asks, even with Auto-apply on.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove and redraw" })).toBeNull();
});

test("the_remove_dialog_names_columns_and_frames", () => {
  // Decision 13b: shapes and ER columns count together, summed across frames, and the frames are named.
  render(
    <RemoveDialog
      shapes={["Cart", "Pay", "Ship", "Done"]}
      columns={["orders.legacy"]}
      lines={6}
      tables={[]}
      adds={0}
      frames={["Checkout flow", "Orders ERD"]}
      onCancel={() => {}}
      onReview={() => {}}
      onRemove={() => {}}
    />,
  );
  expect(screen.getByText("This would remove 4 shapes, 1 column and 6 lines in Checkout flow and Orders ERD: Cart, Pay, Ship, Done and orders.legacy.")).toBeTruthy();
  expect(screen.getByText("Remove 4 shapes, 1 column and 6 lines?")).toBeTruthy();
  expect(screen.getByRole("group", { name: "Remove 4 shapes, 1 column and 6 lines?" })).toBeTruthy();
  expect(screen.getByText("Removing more than 3 shapes and columns always asks, even with Auto-apply on.")).toBeTruthy();
  cleanup();

  // Columns alone: no shapes or lines clause, and one frame is named too when the board has several.
  render(<RemoveDialog shapes={[]} columns={["orders.a", "orders.b", "orders.c", "orders.d"]} lines={0} tables={[]} adds={0} frames={["Orders ERD"]} onCancel={() => {}} onReview={() => {}} onRemove={() => {}} />);
  expect(screen.getByText("This would remove 4 columns in Orders ERD: orders.a, orders.b, orders.c and orders.d.")).toBeTruthy();
  expect(screen.getByText("Remove 4 columns?")).toBeTruthy();
});
