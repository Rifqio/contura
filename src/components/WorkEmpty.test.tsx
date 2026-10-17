import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig } from "../api/types";
import WorkEmpty from "./WorkEmpty";

const shop: ConnectionConfig = {
  id: "c1",
  name: "shop-staging",
  dialect: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};

const ui = (anyOpen: boolean, over: Partial<Parameters<typeof WorkEmpty>[0]> = {}) => (
  <WorkEmpty lastConnection={shop} anyOpen={anyOpen} onNewQuery={() => {}} onOpen={() => {}} {...over} />
);

test("with_an_open_connection", async () => {
  const onNewQuery = vi.fn();
  render(ui(true, { onNewQuery }));
  expect(screen.getByRole("heading", { name: "No tab open" })).toBeTruthy();
  expect(
    screen.getByText(
      "Pick a table in the tree to see its rows, or start a new query. It opens on shop-staging, the Connection you used last.",
    ),
  ).toBeTruthy();
  const button = screen.getByRole("button", { name: /New query/ });
  expect(button.textContent).toContain("Ctrl+T");
  expect(screen.getByText("Filter the tree")).toBeTruthy();
  expect(screen.getByText("New Connection")).toBeTruthy();
  expect(screen.getByText("Ctrl+Shift+F")).toBeTruthy();
  expect(screen.getByText("Ctrl+N")).toBeTruthy();
  await userEvent.click(button);
  expect(onNewQuery).toHaveBeenCalledTimes(1);
});

test("with_none_open_enter_opens_the_last_used", async () => {
  const onOpen = vi.fn();
  render(ui(false, { onOpen }));
  expect(screen.getByRole("heading", { name: "No Connection open" })).toBeTruthy();
  expect(screen.getByText("Open a Connection in the tree to browse its tables and run queries.")).toBeTruthy();
  const button = screen.getByRole("button", { name: /Open shop-staging/ });
  expect(button.textContent).toContain("Enter");
  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(shop);
});
