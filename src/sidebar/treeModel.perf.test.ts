import { expect, it } from "vitest";
import type { ConnectionConfig } from "../api/types";
import { databaseId, flattenTree, folderId, type TreeData } from "./treeModel";

it("flatten_and_filter_5_connections_by_2000_tables_under_30ms", () => {
  const connections: ConnectionConfig[] = [];
  const states: TreeData["states"] = {};
  const branches: TreeData["branches"] = {};
  const expanded = new Set<string>();
  for (let c = 0; c < 5; c++) {
    const id = `c${c}`;
    connections.push({ id, name: `Conn ${c}`, dialect: "mysql" } as ConnectionConfig);
    states[id] = "open";
    const value = Array.from({ length: 2000 }, (_, i) => ({ kind: "table" as const, name: `table_${i}`, rows: i }));
    branches[id] = {
      databases: { s: "loaded", value: ["shop"] },
      schemas: {},
      objects: { shop: { s: "loaded", value } },
      showSystem: new Set(),
    };
    expanded.add(id).add(databaseId(id, "shop")).add(folderId(id, "shop", "table"));
  }
  const base: TreeData = { connections, states, branches, saved: [], expanded, filter: "" };
  expect(flattenTree(base).length).toBeGreaterThan(10000);
  expect(flattenTree({ ...base, filter: "table_19" }).length).toBeGreaterThan(0);
  const median = (filter: string) => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      flattenTree({ ...base, filter });
      times.push(performance.now() - t);
    }
    return times.sort((a, b) => a - b)[2];
  };
  expect(median("")).toBeLessThan(30);
  expect(median("table_19")).toBeLessThan(30);
});
