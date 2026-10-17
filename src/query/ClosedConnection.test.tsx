import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig } from "../api/types";
import ClosedConnection from "./ClosedConnection";

const freight: ConnectionConfig = {
  id: "c2",
  name: "freight-prod",
  dialect: "postgres",
  host: "pg-prod-01.orbitfreight.net",
  port: 5432,
  user: "u",
  database: "freight",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: true,
  readOnly: false,
};

const handlers = () => ({ onOpen: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn() });

test("closed_state_copy_and_open", async () => {
  const h = handlers();
  render(<ClosedConnection state="closed" connection={freight} elapsedMs={0} error={null} {...h} />);
  expect(screen.getByRole("heading", { name: "Open the Connection to run this query" })).toBeTruthy();
  expect(
    screen.getByText("freight-prod is closed. Opening it connects and reads the schema. Nothing runs until you press Run."),
  ).toBeTruthy();
  const open = screen.getByRole("button", { name: /Open freight-prod/ });
  expect(open.textContent).toContain("Enter");
  await userEvent.click(open);
  expect(h.onOpen).toHaveBeenCalledTimes(1);
  // Enter on the region opens it too.
  screen.getByRole("group").focus();
  await userEvent.keyboard("{Enter}");
  expect(h.onOpen).toHaveBeenCalledTimes(2);
});

test("connecting_state_with_elapsed_and_cancel", async () => {
  const h = handlers();
  render(<ClosedConnection state="connecting" connection={freight} elapsedMs={4200} error={null} {...h} />);
  expect(screen.getByRole("heading", { name: "Connecting to freight-prod..." })).toBeTruthy();
  expect(
    screen.getByText("pg-prod-01.orbitfreight.net:5432, 4s so far. The query runs only when you press Run."),
  ).toBeTruthy();
  const cancel = screen.getByRole("button", { name: /Cancel/ });
  expect(cancel.textContent).toContain("Esc");
  await userEvent.click(cancel);
  expect(h.onCancel).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: /Open freight-prod/ })).toBeNull();
});

test("failed_state_with_try_again_and_edit", async () => {
  const h = handlers();
  render(
    <ClosedConnection
      state="failed"
      connection={freight}
      elapsedMs={0}
      error={{ reason: "The server did not answer.", server: "timeout connecting to pg-prod-01.orbitfreight.net:5432" }}
      {...h}
    />,
  );
  expect(screen.getByRole("heading", { name: "Could not open freight-prod" })).toBeTruthy();
  expect(screen.getByText("The server did not answer.")).toBeTruthy();
  const server = screen.getByText("timeout connecting to pg-prod-01.orbitfreight.net:5432");
  expect(server.className).toContain("closed-connection-server");
  const again = screen.getByRole("button", { name: /Try again/ });
  expect(again.textContent).toContain("Enter");
  await userEvent.click(again);
  expect(h.onOpen).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Edit Connection..." }));
  expect(h.onEdit).toHaveBeenCalledTimes(1);
});
