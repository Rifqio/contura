import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, test, vi } from "vitest";
import App from "../App";
import ObjectTree from "../components/ObjectTree";
import { routeInvoke } from "../test/invoke";
import { mockReactFlowDom } from "../test/reactFlow";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

beforeAll(mockReactFlowDom);

test("home_new_schema_model_opens_the_builder", async () => {
  routeInvoke({
    list_groups: () => [],
    list_connections: () => [],
    last_group: () => null,
    suggested_connections: () => [],
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "New Schema Model" }));
  await userEvent.click(screen.getByRole("button", { name: "Start blank" }));
  expect(await screen.findByRole("region", { name: "Schema Model schema" })).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("group", { name: "Table new_table" })).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  await userEvent.click(screen.getByRole("button", { name: "Don't save" }));
  expect(await screen.findByRole("heading", { name: "Home" })).toBeTruthy();
});

test("tree_offers_reverse_engineering_per_database", async () => {
  routeInvoke({ list_databases: () => ["shop"] });
  const onReverseEngineer = vi.fn();
  render(
    <ObjectTree
      connectionId="c1"
      dialect="mysql"
      defaultDatabase={null}
      selected={null}
      onSelect={() => {}}
      onNotOpen={() => {}}
      onReverseEngineer={onReverseEngineer}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Reverse-engineer shop into a Schema Model" }));
  expect(onReverseEngineer).toHaveBeenCalledWith("shop", null);
});

test("postgres_tree_offers_reverse_engineering_per_schema", async () => {
  routeInvoke({
    list_databases: () => ["shop"],
    list_schemas: () => [
      { name: "public", isSystem: false },
      { name: "pg_catalog", isSystem: true },
    ],
    list_objects: () => [],
  });
  const onReverseEngineer = vi.fn();
  render(
    <ObjectTree
      connectionId="c1"
      dialect="postgres"
      defaultDatabase="shop"
      selected={null}
      onSelect={() => {}}
      onNotOpen={() => {}}
      onReverseEngineer={onReverseEngineer}
    />,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Reverse-engineer public into a Schema Model" }));
  expect(onReverseEngineer).toHaveBeenCalledWith("shop", "public");
});
