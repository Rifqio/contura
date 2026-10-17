import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import CellValue from "./CellValue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const table = { database: "shop", schema: null, name: "orders" };

test('number renders exact string "18446744073709551615"', () => {
  render(<CellValue cell={{ t: "number", value: "18446744073709551615" }} />);
  expect(screen.getByText("18446744073709551615")).toBeTruthy();
});

test("a_boolean_true_cell_has_cell_bool", () => {
  const { container } = render(<CellValue cell={{ t: "text", value: "true", truncated: false, totalBytes: 4 }} boolean />);
  expect(container.querySelector(".cell-bool")?.textContent).toBe("true");
});

test("true_in_a_text_column_stays_plain_text", () => {
  const { container } = render(<CellValue cell={{ t: "text", value: "true", truncated: false, totalBytes: 4 }} />);
  expect(container.querySelector(".cell-bool")).toBeNull();
  expect(container.querySelector(".cell-text")?.textContent).toBe("true");
});

test("null_and_numbers_keep_their_classes", () => {
  const { container } = render(
    <>
      <CellValue cell={{ t: "null" }} boolean />
      <CellValue cell={{ t: "number", value: "42" }} />
    </>,
  );
  expect(container.querySelector(".cell-null")?.textContent).toBe("NULL");
  expect(container.querySelector(".cell-number")?.textContent).toBe("42");
});

test("truncated text offers full value and calls fetch_full_value with pk key", async () => {
  routeInvoke({ fetch_full_value: () => ({ t: "text", value: "the whole long note" }) });
  const key = [{ column: "id", value: { t: "number" as const, value: "7" } }];
  render(
    <CellValue
      cell={{ t: "text", value: "the whole", truncated: true, totalBytes: 5000 }}
      source={{ connectionId: "c1", table, column: "note", rowKey: key }}
    />,
  );
  expect(screen.getByText("truncated (5,000 bytes)")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open full value" }));
  await waitFor(() => expect(callsTo("fetch_full_value")).toHaveLength(1));
  expect(callsTo("fetch_full_value")[0]).toEqual({
    id: "c1",
    request: { table, column: "note", key },
  });
  expect(await screen.findByText("the whole long note")).toBeTruthy();
});
