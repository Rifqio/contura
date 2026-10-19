import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import DdlPanes from "./DdlPanes";

const PAIR = {
  source: ["CREATE TABLE billing.invoices (", "  total numeric(12,2) NOT NULL,", "  due_on date,", ");"].join("\n"),
  target: ["CREATE TABLE billing.invoices (", "  total numeric(10,2) NOT NULL,", "  fax text,", ");"].join("\n"),
};

function setup(production: boolean, focus: string | null = null) {
  return render(
    <DdlPanes pair={PAIR} dialect="postgres" source={{ name: "freight-staging" }} target={{ name: "freight-prod" }} production={production} focus={focus} />,
  );
}

const marks = (pane: HTMLElement) => [...pane.querySelectorAll(".compare-dl")].map((d) => d.getAttribute("data-mark"));

test("panes_align_lines_with_fillers_and_marks", () => {
  setup(false);
  const src = screen.getByRole("region", { name: "Source DDL, freight-staging" });
  const tgt = screen.getByRole("region", { name: "Target DDL, freight-prod" });
  expect(marks(src)).toEqual(["same", "changed", "added", "fill", "same"]);
  expect(marks(tgt)).toEqual(["same", "changed", "fill", "removed", "same"]);
  // The line marks and their words.
  const changed = src.querySelector('[data-mark="changed"] .compare-dl-mk') as HTMLElement;
  expect(changed.textContent).toBe("~differs");
  expect((src.querySelector('[data-mark="added"] .compare-dl-mk') as HTMLElement).textContent).toBe("+in source only");
  expect((tgt.querySelector('[data-mark="removed"] .compare-dl-mk') as HTMLElement).textContent).toBe("−in target only");
  // Fillers carry no line number; each side numbers its own lines.
  expect([...tgt.querySelectorAll(".compare-dl-n")].map((n) => n.textContent)).toEqual(["1", "2", "3", "4"]);
  expect(within(src).getByText("Source")).toBeTruthy();
  expect(within(tgt).getByText("Target")).toBeTruthy();
});

test("the_target_carries_the_production_wash", () => {
  setup(true);
  expect(screen.getByRole("region", { name: "Target DDL, freight-prod" }).classList.contains("prod-wash")).toBe(true);
  expect(screen.getByRole("region", { name: "Source DDL, freight-staging" }).classList.contains("prod-wash")).toBe(false);
});

test("the_selected_column_gets_the_focus_bar", () => {
  const { container } = setup(false, "total");
  expect(container.querySelectorAll(".compare-dl-foc")).toHaveLength(2);
});
