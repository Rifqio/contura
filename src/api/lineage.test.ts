import { invoke } from "@tauri-apps/api/core";
import { expect, test, vi } from "vitest";
import { deleteLineageLayout, readLineageLayout, viewDependencies, writeLineageLayout } from "./client";
import type { ObjectPath, ViewDependencies } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const ORDERS: ObjectPath = { database: "kestrel", schema: "shop", name: "orders" };

test("viewDependencies_asks_the_core_by_connection_and_table", async () => {
  const deps: ViewDependencies = { catalog: true, views: [{ database: "kestrel", schema: "shop", name: "daily" }], capped: false };
  vi.mocked(invoke).mockResolvedValueOnce(deps);
  expect(await viewDependencies("c1", ORDERS)).toEqual(deps);
  expect(invoke).toHaveBeenLastCalledWith("view_dependencies", { id: "c1", path: ORDERS });
});

test("the_lineage_layout_commands_send_the_connection_and_table", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  expect(await readLineageLayout("c1", ORDERS)).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("read_lineage_layout", { id: "c1", path: ORDERS });

  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await writeLineageLayout("c1", ORDERS, '{"version":1,"cards":{}}');
  expect(invoke).toHaveBeenLastCalledWith("write_lineage_layout", { id: "c1", path: ORDERS, layout: '{"version":1,"cards":{}}' });

  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await deleteLineageLayout("c1", ORDERS);
  expect(invoke).toHaveBeenLastCalledWith("delete_lineage_layout", { id: "c1", path: ORDERS });
});
