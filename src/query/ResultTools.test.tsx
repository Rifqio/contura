import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { Cell, ResultColumn } from "../api/types";
import ResultTools from "./ResultTools";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

afterEach(cleanup);

const columns: ResultColumn[] = [{ name: "id", typeName: "int4" } as ResultColumn];
const rows: Cell[][] = [[{ t: "text", value: "1" } as Cell]];

function renderTools(props: Partial<Parameters<typeof ResultTools>[0]> = {}) {
  render(
    <ResultTools columns={columns} rows={rows} filter="" onFilter={() => {}} hidden={new Set()} onToggleColumn={() => {}} {...props} />,
  );
}

async function exportItems() {
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  return screen.getAllByRole("menuitem").map((m) => m.textContent);
}

test("without_the_dialog_the_export_menu_keeps_save_as_csv", async () => {
  renderTools();
  expect(await exportItems()).toEqual(["Copy as CSV", "Save as CSV..."]);
});

test("with_on_export_the_menu_is_copy_and_export_with_ctrl_e", async () => {
  const onExport = vi.fn();
  renderTools({ onExport });
  const items = await exportItems();
  expect(items).toEqual(["Copy as CSV", "Export...Ctrl+E"]);
  await userEvent.click(screen.getByRole("menuitem", { name: /Export\.\.\./ }));
  expect(onExport).toHaveBeenCalledTimes(1);
});

test("with_on_import_the_menu_adds_import", async () => {
  const onImport = vi.fn();
  renderTools({ onExport: () => {}, onImport });
  expect(await exportItems()).toEqual(["Copy as CSV", "Export...Ctrl+E", "Import..."]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Import..." }));
  expect(onImport).toHaveBeenCalledTimes(1);
});
