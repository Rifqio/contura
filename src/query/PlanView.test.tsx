import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { Plan } from "../api/types";
import PlanView from "./PlanView";

const plan: Plan = {
  raw: "-> Filter\n    -> Table scan on orders",
  totalCost: 14182,
  nodes: [
    {
      label: "Filter: (orders.status = 'paid')",
      object: null,
      rows: 14138,
      cost: 14182,
      fullScan: false,
      children: [
        { label: "Table scan on orders", object: "orders", rows: 141377, cost: 14000, fullScan: true, children: [] },
      ],
    },
  ],
};

test("tree_shows_operation_object_rows_and_cost", () => {
  render(<PlanView plan={plan} />);
  const rows = screen.getAllByRole("treeitem");
  expect(rows).toHaveLength(2);
  expect(rows[1].textContent).toContain("Table scan on orders");
  expect(rows[1].textContent).toContain("141,377 rows");
  expect(rows[1].textContent).toContain("cost 14,000");
  expect(rows[1].getAttribute("aria-level")).toBe("2");
  expect(screen.getByText("Full scan of orders, about 141,377 rows")).toBeTruthy();
  expect(screen.getByText("This step is 99 percent of the cost")).toBeTruthy();
});

test("raw_text_is_one_switch_away", async () => {
  render(<PlanView plan={plan} />);
  expect(screen.queryByText(/-> Filter/)).toBeNull();
  await userEvent.click(screen.getByRole("switch", { name: "Show raw plan" }));
  expect(document.querySelector(".plan-raw")?.textContent).toBe(plan.raw);
});
