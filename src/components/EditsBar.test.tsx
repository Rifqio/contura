import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Cell, Page } from "../api/types";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import DataGrid from "./DataGrid";
import EditsBar, { summaryText } from "./EditsBar";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
mockEditorDom();

test("summary names only what changed", () => {
  expect(summaryText({ cells: 1, newRows: 1, deletedRows: 1 })).toBe("1 edited cell, 1 new row, 1 deleted row");
  expect(summaryText({ cells: 3, newRows: 0, deletedRows: 2 })).toBe("3 edited cells, 2 deleted rows");
});

const num = (value: string): Cell => ({ t: "number", value });
const text = (value: string): Cell => ({ t: "text", value, truncated: false, totalBytes: value.length });
const orders: Page = {
  columns: [
    { name: "id", typeName: "bigint", isPrimaryKey: true },
    { name: "status", typeName: "varchar", isPrimaryKey: false },
  ],
  rows: [
    [num("1"), text("paid")],
    [num("2"), text("shipped")],
  ],
  hasMore: false,
};
const td = (row: number, col: number) => document.querySelector(`tr[data-row="${row}"] td[data-col="${col}"]`) as HTMLElement;

test("bar_sits_above_the_footer_with_chip_summary_and_actions", async () => {
  routeInvoke({ fetch_page: () => orders });
  render(<DataGrid connectionId="c1" table={{ database: "shop", schema: "public", name: "orders" }} onClose={() => {}} />);
  await screen.findByText("paid");
  // An edited cell, a new row and a deleted row.
  fireEvent.doubleClick(td(0, 1));
  const box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "cancelled" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Add row" }));
  fireEvent.contextMenu(td(1, 1));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete row" }));

  const bar = screen.getByRole("region", { name: "Pending Edits" });
  // Its own bar, above the footer, not in the header strip.
  expect(bar.closest(".table-header")).toBeNull();
  expect(bar.nextElementSibling?.classList.contains("table-foot")).toBe(true);
  const chip = bar.querySelector(".edits-count") as HTMLElement;
  expect(chip.textContent).toBe("3 changes");
  expect(chip.className).toContain("chip-warning");
  expect(bar.querySelector(".edits-summary")!.textContent).toBe("1 edited cell, 1 new row, 1 deleted row");
  const preview = within(bar).getByRole("button", { name: "Preview SQL" });
  const discard = within(bar).getByRole("button", { name: "Discard" });
  const save = within(bar).getByRole("button", { name: "Save" });
  for (const b of [preview, discard, save]) expect(b.querySelector("svg")).not.toBeNull();
  expect(save.className).toContain("button-primary");
  expect(save.querySelector("kbd")!.textContent).toBe("Ctrl+S");
  // The order the frame draws: Preview SQL, Discard, Save.
  const buttons = within(bar).getAllByRole("button");
  expect(buttons.indexOf(preview)).toBeLessThan(buttons.indexOf(discard));
  expect(buttons.indexOf(discard)).toBeLessThan(buttons.indexOf(save));
});

test("production_save_on_prod_says_production", () => {
  const noop = () => {};
  render(
    <EditsBar
      summary={{ cells: 1, newRows: 0, deletedRows: 0 }}
      changes={1}
      busy={false}
      production
      previewOpen={false}
      onPreview={noop}
      onDiscard={noop}
      onSave={noop}
    />,
  );
  const save = screen.getByRole("button", { name: "Save on Production" });
  // T2, frame j state 2: Save on PROD carries the same boxed Ctrl+S as Save.
  expect(save.textContent).toBe("Save on PRODCtrl+S");
  expect(save.querySelector("kbd.kbd")!.textContent).toBe("Ctrl+S");
  expect(save.className).toContain("button-prod");
  expect(save.title).toContain("Ctrl+S");
  expect(screen.getByText("1 change")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});
