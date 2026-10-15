import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { Page } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import DataGrid from "./DataGrid";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const table = { database: "shop", schema: null, name: "orders" };

function page(hasMore: boolean): Page {
  return {
    columns: [
      { name: "id", typeName: "int unsigned", isPrimaryKey: true },
      { name: "note", typeName: "varchar(80)", isPrimaryKey: false },
    ],
    rows: [
      [
        { t: "number", value: "1" },
        { t: "text", value: "first", truncated: false, totalBytes: 5 },
      ],
    ],
    hasMore,
  };
}

const nextButton = () => screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement;

test("requests page 0 then page 1 on next", async () => {
  routeInvoke({ fetch_page: () => page(true) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await waitFor(() => expect(nextButton().disabled).toBe(false));
  await userEvent.click(nextButton());
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  const pages = callsTo("fetch_page").map((a) => (a.request as { page: number }).page);
  expect(pages).toEqual([0, 1]);
  expect(callsTo("fetch_page")[0]).toEqual({ id: "c1", request: { table, page: 0, sort: null } });
});

test("next disabled when hasMore false", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  expect(nextButton().disabled).toBe(true);
});

test("sort toggles asc then desc", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  const sortById = screen.getByRole("button", { name: "Sort by id" });
  await userEvent.click(sortById);
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await userEvent.click(screen.getByRole("button", { name: "Sort by id" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(3));
  await userEvent.click(screen.getByRole("button", { name: "Sort by note" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(4));
  const sorts = callsTo("fetch_page").map((a) => (a.request as { sort: unknown }).sort);
  expect(sorts).toEqual([
    null,
    { column: "id", descending: false },
    { column: "id", descending: true },
    { column: "note", descending: false },
  ]);
});
