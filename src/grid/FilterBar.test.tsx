import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import FilterBar from "./FilterBar";
import type { SortSpec } from "../api/types";
import type { RowFilter } from "./rowFilters";

function Bar({ start = [] }: { start?: RowFilter[] }) {
  const [filters, setFilters] = useState<RowFilter[]>(start);
  const [sort, setSort] = useState<SortSpec | null>(null);
  return (
    <FilterBar
      columns={[{ name: "status", typeName: "varchar", kind: "text" }]}
      filters={filters}
      sort={sort}
      onFilters={setFilters}
      onSort={setSort}
    />
  );
}

test("focus_goes_back_to_add_filter_when_the_form_closes", async () => {
  render(<Bar />);
  const add = screen.getByRole("button", { name: "Add filter" });
  await userEvent.click(add);
  expect(screen.getByRole("dialog", { name: "Add filter" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Add filter" })).toBeNull();
  expect(document.activeElement).toBe(add);
  await userEvent.click(add);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(add);
});

test("focus_goes_back_to_the_chip_after_an_edit", async () => {
  render(<Bar start={[{ id: "f1", column: "status", op: "eq", value: "paid" }]} />);
  const chip = screen.getByRole("button", { name: /^Edit filter:/ });
  await userEvent.click(chip);
  await userEvent.click(screen.getByRole("button", { name: /^Keep filter/ }));
  expect(screen.queryByRole("dialog", { name: "Edit filter" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Edit filter:/ }));
});

test("focus_goes_back_to_sort_when_its_form_closes", async () => {
  render(<Bar />);
  await userEvent.click(screen.getByRole("button", { name: "Sort" }));
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sort" }));
});
