import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { buildTree } from "./compareModel";
import DiffTree from "./DiffTree";
import { ITEMS } from "./fixtures";
import type { DiffItem } from "../api/types";

function Harness({ start = "column:billing.invoices.total:changed" }: { start?: string }) {
  const [selected, setSelected] = useState<string | null>(start);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  return <DiffTree rows={buildTree(ITEMS, "all", "billing", 4)} collapsed={collapsed} onCollapsed={setCollapsed} selected={selected} onSelect={setSelected} />;
}

const selectedName = () => screen.getAllByRole("treeitem").find((r) => r.getAttribute("aria-selected") === "true")?.getAttribute("title");

test("rows_carry_marks_with_words_and_details", () => {
  render(<Harness />);
  const fax = screen.getByRole("treeitem", { name: /fax/ });
  expect(fax.getAttribute("title")).toBe("fax, removed");
  expect(fax.querySelector(".compare-trow-badge")?.textContent).toBe("R");
  expect(within(fax).getByText("text")).toBeTruthy();
  expect(fax.querySelector(".compare-mark-removed")).not.toBeNull();
  const total = screen.getByRole("treeitem", { name: /total/ });
  expect(within(total).getByText("numeric(10,2) to numeric(12,2)")).toBeTruthy();
  expect(total.querySelector(".compare-trow-badge")?.textContent).toBe("C");
  // Guides as the object tree draws them.
  expect(fax.querySelector(".tree-stub")).not.toBeNull();
  // Folders and Not compared keep their counts.
  expect(within(screen.getByRole("treeitem", { name: "Tables" })).getByText("4")).toBeTruthy();
  expect(within(screen.getByRole("treeitem", { name: "Not compared" })).getByText("4")).toBeTruthy();
  expect(screen.getByRole("treeitem", { name: "billing" }).getAttribute("aria-level")).toBe("1");
});

test("keys_move_expand_and_collapse", () => {
  render(<Harness />);
  const tree = screen.getByRole("tree", { name: "Differences" });
  fireEvent.keyDown(tree, { key: "ArrowDown" });
  expect(selectedName()).toBe("fax, removed");
  fireEvent.keyDown(tree, { key: "ArrowUp" });
  fireEvent.keyDown(tree, { key: "ArrowUp" });
  expect(selectedName()).toBe("invoices, changed, 4 changes inside");
  // Left collapses an open table, then goes to its parent.
  fireEvent.keyDown(tree, { key: "ArrowLeft" });
  expect(screen.queryByRole("treeitem", { name: /^fax/ })).toBeNull();
  expect(screen.getByRole("treeitem", { name: /^invoices/ }).getAttribute("aria-expanded")).toBe("false");
  // Right expands it again, then moves to its first child.
  fireEvent.keyDown(tree, { key: "ArrowRight" });
  expect(screen.getByRole("treeitem", { name: /^fax/ })).toBeTruthy();
  fireEvent.keyDown(tree, { key: "ArrowRight" });
  expect(selectedName()).toBe("total, changed");
  fireEvent.keyDown(tree, { key: "ArrowLeft" });
  expect(selectedName()).toBe("invoices, changed, 4 changes inside");
});

test("a_300_table_compare_draws_only_the_rows_on_screen", () => {
  // 300 changed tables with 3 changed columns each: 1,200 rows and more.
  const items: DiffItem[] = Array.from({ length: 300 }, (_, t) =>
    ["a", "b", "c"].map((c) => ({ ...ITEMS[0], id: `column:billing.t${t}.${c}:changed`, path: { schema: "billing", table: `t${String(t).padStart(3, "0")}`, name: c } })),
  ).flat();
  function Many() {
    const [selected, setSelected] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    return <DiffTree rows={buildTree(items, "all", "billing", 0)} collapsed={collapsed} onCollapsed={setCollapsed} selected={selected} onSelect={setSelected} />;
  }
  render(<Many />);
  expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(60);
  const tree = screen.getByRole("tree", { name: "Differences" });
  const spacers = tree.querySelectorAll<HTMLElement>(':scope > [role="presentation"]');
  expect(parseFloat(spacers[1].style.height)).toBeGreaterThan(28 * 1100);
  // The keys still reach rows that were not drawn, and the tree scrolls to them.
  for (let i = 0; i < 40; i++) fireEvent.keyDown(tree, { key: "ArrowDown" });
  expect(screen.getAllByRole("treeitem").find((r) => r.getAttribute("aria-selected") === "true")).toBeTruthy();
  expect(tree.scrollTop).toBeGreaterThan(0);
  expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(60);
}, 30_000);

test("item_43_rows_take_git_decoration_colours_and_a_one_letter_badge", () => {
  render(<Harness />);
  const fax = screen.getByRole("treeitem", { name: /^fax/ });
  // The name and the mark carry the status class; the word is gone, a letter sits at the right edge.
  expect(fax.querySelector(".compare-trow-name")!.classList.contains("diff-removed")).toBe(true);
  expect(fax.querySelector(".compare-mark")!.classList.contains("compare-mark-removed")).toBe(true);
  expect(within(fax).queryByText("removed")).toBeNull();
  const badge = fax.querySelector(".compare-trow-badge")!;
  expect(badge.textContent).toBe("R");
  expect(badge.classList.contains("diff-removed")).toBe(true);
  expect(badge.getAttribute("aria-hidden")).toBe("true");
  const due = screen.getByRole("treeitem", { name: /^due_on/ });
  expect(due.querySelector(".compare-trow-badge")!.textContent).toBe("A");
  expect(due.querySelector(".compare-trow-name")!.classList.contains("diff-added")).toBe(true);
  const total = screen.getByRole("treeitem", { name: /^total/ });
  expect(total.querySelector(".compare-trow-badge")!.textContent).toBe("C");
  expect(total.querySelector(".compare-trow-name")!.classList.contains("diff-changed")).toBe(true);
  // No colour is set per row in an inline style: classes only.
  for (const r of screen.getAllByRole("treeitem")) expect(r.getAttribute("style") ?? "").not.toMatch(/color/);
});

test("item_43_a_parent_that_holds_changes_is_amber_with_its_count", () => {
  render(<Harness />);
  const inv = screen.getByRole("treeitem", { name: "invoices, changed, 4 changes inside" });
  const badge = inv.querySelector(".compare-trow-badge")!;
  expect(badge.textContent).toBe("4");
  expect(badge.classList.contains("compare-trow-count")).toBe(true);
  expect(badge.classList.contains("diff-changed")).toBe(true);
  expect(inv.querySelector(".compare-trow-name")!.classList.contains("diff-changed")).toBe(true);
  // The Tables folder stays neutral with its count.
  const tables = screen.getByRole("treeitem", { name: "Tables" });
  expect(tables.querySelector(".compare-trow-badge")).toBeNull();
  expect(tables.querySelector(".compare-trow-name")!.className).not.toMatch(/diff-/);
  expect(within(tables).getByText("4").classList.contains("tree-count")).toBe(true);
});
