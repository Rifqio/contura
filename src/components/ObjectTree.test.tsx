import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import App from "../App";
import { callsTo, routeInvoke } from "../test/invoke";
import ObjectTree from "./ObjectTree";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const objects = [
  { kind: "table", name: "orders" },
  { kind: "table", name: "stores" },
  { kind: "view", name: "v_daily_sales" },
  { kind: "procedure", name: "close_day" },
  { kind: "trigger", name: "orders_audit" },
];

test("expanding a database lists its objects grouped by kind", async () => {
  routeInvoke({ list_databases: () => ["shop"], list_objects: () => objects });
  const onSelect = vi.fn();
  render(
    <ObjectTree connectionId="c1" defaultDatabase={null} selected={null} onSelect={onSelect} onNotOpen={() => {}} />,
  );
  const shop = await screen.findByRole("button", { name: "shop" });
  expect(callsTo("list_objects")).toHaveLength(0);
  await userEvent.click(shop);
  expect(shop.getAttribute("aria-expanded")).toBe("true");
  expect(callsTo("list_objects")).toEqual([{ id: "c1", database: "shop", schema: null }]);
  const tables = await screen.findByRole("list", { name: "Tables in shop" });
  expect(
    within(tables)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["orders", "stores"]);
  expect(within(screen.getByRole("list", { name: "Views in shop" })).getByText("v_daily_sales")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Procedures in shop" })).getByText("close_day")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Triggers in shop" })).getByText("orders_audit")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Functions in shop" })).toBeNull();
  await userEvent.click(within(tables).getByRole("button", { name: "orders" }));
  expect(onSelect).toHaveBeenCalledWith("table", { database: "shop", schema: null, name: "orders" });
});

test("selecting a routine or trigger shows its definition", async () => {
  routeInvoke({
    list_groups: () => [{ id: "g1", name: "KFC", color: "red" }],
    list_connections: () => [
      {
        id: "c1",
        name: "kfc-prod",
        dialect: "mysql",
        host: "127.0.0.1",
        port: 3306,
        user: "root",
        database: null,
        ssl: { mode: "disable" },
        groupId: "g1",
      },
    ],
    last_group: () => "g1",
    open_connection: () => null,
    list_databases: () => ["shop"],
    list_objects: () => objects,
    object_definition: (a) =>
      a.kind === "trigger" ? "CREATE TRIGGER orders_audit AFTER INSERT" : "CREATE PROCEDURE close_day() BEGIN END",
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Open kfc-prod" }));
  await userEvent.click(await screen.findByRole("button", { name: "shop" }));
  await userEvent.click(await screen.findByRole("button", { name: "close_day" }));
  expect(await screen.findByText("CREATE PROCEDURE close_day() BEGIN END")).toBeTruthy();
  expect(callsTo("object_definition")).toEqual([
    { id: "c1", kind: "procedure", path: { database: "shop", schema: null, name: "close_day" } },
  ]);
  await userEvent.click(screen.getByRole("button", { name: "orders_audit" }));
  expect(await screen.findByText("CREATE TRIGGER orders_audit AFTER INSERT")).toBeTruthy();
  expect(callsTo("fetch_page")).toHaveLength(0);
});

test("a connection not open error calls onNotOpen and says to open it again", async () => {
  routeInvoke({
    list_databases: () => {
      throw { kind: "notFound", message: "connection not open" };
    },
  });
  const onNotOpen = vi.fn();
  render(
    <ObjectTree connectionId="c1" defaultDatabase={null} selected={null} onSelect={() => {}} onNotOpen={onNotOpen} />,
  );
  expect(await screen.findByText("This Connection is not open. Open it again to continue.")).toBeTruthy();
  await waitFor(() => expect(onNotOpen).toHaveBeenCalledTimes(1));
});
