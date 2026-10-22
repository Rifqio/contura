import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import RemoveDialog from "./RemoveDialog";

afterEach(() => cleanup());

test("remove_dialog_texts_and_buttons", () => {
  const on = { onCancel: vi.fn(), onReview: vi.fn(), onRemove: vi.fn() };
  render(<RemoveDialog shapes={["Take order", "Pick and pack", "Bill customer", "orders", "invoices", "Warehouse"]} lines={5} tables={["orders", "invoices"]} adds={3} {...on} />);
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
  render(<RemoveDialog shapes={["A", "B", "C", "D"]} lines={1} tables={[]} adds={0} onCancel={() => {}} onReview={() => {}} onRemove={() => {}} />);
  expect(screen.getByText("This would remove 4 shapes and 1 line: A, B, C and D.")).toBeTruthy();
  expect(screen.getByText("Remove 4 shapes and 1 line?")).toBeTruthy();
  expect(screen.getByText("Removing more than 3 shapes always asks, even with Auto-apply on.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove and redraw" })).toBeNull();
});
