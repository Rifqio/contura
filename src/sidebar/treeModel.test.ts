import { describe, expect, it } from "vitest";
import type { ConnectionConfig, DbObject, SavedQuery } from "../api/types";
import {
  databaseId,
  flattenTree,
  folderId,
  moveFocus,
  objectId,
  schemaId, windowRange,
  type BranchData, type TreeData, type TreeRow } from "./treeModel";

function conn(id: string, name: string, dialect: ConnectionConfig["dialect"] = "mysql"): ConnectionConfig {
  return {
    id,
    name,
    dialect,
    host: "127.0.0.1",
    port: 3306,
    user: "u",
    database: null,
    ssl: { mode: "disable" },
    file: null,
    groupId: null,
    queryTimeoutSecs: null,
    aiAccess: "never",
    production: false,
    readOnly: false,
  };
}

const saved = (id: string, name: string, connectionId: string | null = null): SavedQuery => ({
  id,
  name,
  sql: "select 1",
  updatedAtMs: 0,
  connectionId,
});

const obj = (name: string, kind: DbObject["kind"] = "table", rows: number | null = null): DbObject => ({ kind, name, rows });

function branch(over: Partial<BranchData> = {}): BranchData {
  return {
    databases: { s: "loaded", value: ["shop"] },
    schemas: {},
    objects: {},
    showSystem: new Set(),
    ...over,
  };
}

function data(over: Partial<TreeData> = {}): TreeData {
  return {
    connections: [],
    states: {},
    branches: {},
    saved: [],
    expanded: new Set(),
    filter: "",
    ...over,
  };
}

const ids = (rows: TreeRow[]) => rows.map((r) => r.node.id);

describe("flattenTree", () => {
  it("connections_are_top_level_and_saved_queries_last", () => {
    const rows = flattenTree(data({ connections: [conn("b", "Zeta"), conn("a", "alpha")], saved: [saved("q", "x")] }));
    expect(rows.map((r) => [r.node.kind, r.level])).toEqual([
      ["connection", 0],
      ["connection", 0],
      ["savedRoot", 0],
    ]);
    expect(ids(rows)).toEqual(["a", "b", "saved"]);
  });

  it("a_closed_connection_has_no_children", () => {
    const rows = flattenTree(
      data({
        connections: [conn("a", "A")],
        states: { a: "closed" },
        branches: { a: branch() },
        expanded: new Set(["a"]),
      }),
    );
    expect(ids(rows)).toEqual(["a", "saved"]);
    expect(rows[0]).toMatchObject({ level: 0, expandable: true, expanded: false });
  });

  it("tables_folder_has_its_count_and_tables_their_estimates", () => {
    const rows = flattenTree(
      data({
        connections: [conn("a", "A")],
        states: { a: "open" },
        branches: {
          a: branch({
            objects: {
              shop: { s: "loaded", value: [obj("orders", "table", 120), obj("items", "table"), obj("v", "view")] },
            },
          }),
        },
        expanded: new Set(["a", databaseId("a", "shop"), folderId("a", "shop", "table")]),
      }),
    );
    const folder = rows.find((r) => r.node.kind === "folder")!;
    expect(folder.node).toMatchObject({ label: "Tables", count: 2, objectKind: "table" });
    expect(folder.level).toBe(2);
    const tables = rows.filter((r) => r.node.kind === "object");
    expect(tables.map((r) => [r.level, (r.node as { rows: number | null }).rows])).toEqual([
      [3, 120],
      [3, null],
    ]);
    expect(rows.filter((r) => r.node.kind === "folder")).toHaveLength(2);
  });

  it("postgres_adds_a_schema_level_and_hides_system_schemas_until_shown", () => {
    const base = (showSystem: string[]) =>
      data({
        connections: [conn("p", "P", "postgres")],
        states: { p: "open" },
        branches: {
          p: branch({
            databases: { s: "loaded", value: ["app"] },
            schemas: {
              app: {
                s: "loaded",
                value: [
                  { name: "public", isSystem: false },
                  { name: "pg_catalog", isSystem: true },
                ],
              },
            },
            objects: { "app\u0000public": { s: "loaded", value: [obj("t1")] } },
            showSystem: new Set(showSystem),
          }),
        },
        expanded: new Set(["p", databaseId("p", "app"), schemaId("p", "app", "public"), folderId("p", "app\u0000public", "table")]),
      });
    const hidden = flattenTree(base([]));
    const schemas = hidden.filter((r) => r.node.kind === "schema");
    expect(schemas.map((r) => [(r.node as { name: string }).name, r.level])).toEqual([["public", 2]]);
    expect(hidden.find((r) => r.node.kind === "object")!.level).toBe(4);
    const shown = flattenTree(base(["app"]));
    expect(shown.filter((r) => r.node.kind === "schema").map((r) => (r.node as { name: string }).name)).toEqual([
      "public",
      "pg_catalog",
    ]);
    expect(shown.find((r) => r.node.kind === "schema" && (r.node as { system: boolean }).system)).toBeDefined();
  });

  const filterData = (filter: string) =>
    data({
      connections: [conn("a", "A"), conn("b", "B")],
      states: { a: "open", b: "open" },
      branches: {
        a: branch({
          objects: { shop: { s: "loaded", value: [obj("late_parcels"), obj("orders"), obj("carriers")] } },
        }),
        b: branch({ databases: { s: "loaded", value: ["other"] } }),
      },
      saved: [saved("q1", "late shipments by carrier"), saved("q2", "daily totals")],
      filter,
    });

  it("filter_keeps_ancestors_and_covers_saved_queries", () => {
    const rows = flattenTree(filterData("late"));
    expect(rows.map((r) => [r.node.kind, r.level])).toEqual([
      ["connection", 0],
      ["database", 1],
      ["folder", 2],
      ["object", 3],
      ["savedRoot", 0],
      ["saved", 1],
    ]);
    expect(ids(rows)).toContain("q1");
    expect(rows.find((r) => r.node.kind === "object")!.node).toMatchObject({ path: { name: "late_parcels" } });
    expect(rows.every((r) => !r.expandable || r.expanded)).toBe(true);
    expect(ids(rows)).not.toContain("b");
  });

  it("filter_marks_the_matched_characters", () => {
    const rows = flattenTree(filterData("LATE"));
    const o = rows.find((r) => r.node.kind === "object")!;
    expect(o.match).toEqual([0, 4]);
    expect(rows.find((r) => r.node.kind === "connection")!.match).toBeNull();
    expect(rows.find((r) => r.node.kind === "saved")!.match).toEqual([0, 4]);
  });
});

describe("windowRange", () => {
  it("window_range_renders_only_what_shows", () => {
    expect(windowRange(1800, 0, 800, 28)).toEqual({ start: 0, end: 37 });
    expect(windowRange(1800, 28000, 800, 28).start).toBe(992);
    expect(windowRange(10, 0, 800, 28)).toEqual({ start: 0, end: 10 });
  });
});

const DB_A = databaseId("a", "shop");

describe("moveFocus", () => {
  const rows = flattenTree(
    data({
      connections: [conn("a", "A"), conn("b", "B")],
      states: { a: "open", b: "closed" },
      branches: { a: branch() },
      expanded: new Set(["a"]),
    }),
  );
  // rows: a, the shop database, b, saved

  it("right_expands_then_moves_to_the_first_child", () => {
    expect(moveFocus(rows, "b", "ArrowRight")).toEqual({ focus: "b", expand: "b" });
    expect(moveFocus(rows, "a", "ArrowRight")).toEqual({ focus: DB_A });
  });

  it("left_collapses_then_moves_to_the_parent", () => {
    expect(moveFocus(rows, "a", "ArrowLeft")).toEqual({ focus: "a", collapse: "a" });
    expect(moveFocus(rows, DB_A, "ArrowLeft")).toEqual({ focus: "a" });
    expect(moveFocus(rows, "b", "ArrowLeft")).toEqual({ focus: "b" });
  });

  it("end_goes_to_the_last_row", () => {
    expect(moveFocus(rows, "a", "End")).toEqual({ focus: "saved" });
    expect(moveFocus(rows, "b", "Home")).toEqual({ focus: "a" });
    expect(moveFocus(rows, "a", "ArrowDown")).toEqual({ focus: DB_A });
    expect(moveFocus(rows, "a", "ArrowUp")).toEqual({ focus: "a" });
  });
});

describe("moveFocus edge cases", () => {
  const rows = flattenTree(
    data({ connections: [conn("a", "A")], states: { a: "open" }, branches: { a: branch() }, expanded: new Set(["a"]) }),
  );
  it("an_empty_list_is_a_no_op_and_a_missing_id_goes_to_the_first_row", () => {
    expect(moveFocus([], "x", "ArrowDown")).toEqual({ focus: "x" });
    expect(moveFocus([], null, "End")).toEqual({ focus: "" });
    expect(moveFocus(rows, "gone", "End")).toEqual({ focus: "a" });
    expect(moveFocus(rows, null, "ArrowUp")).toEqual({ focus: "a" });
  });

  it("left_while_filtering_goes_to_the_parent_without_collapsing", () => {
    expect(moveFocus(rows, "a", "ArrowLeft", true)).toEqual({ focus: "a" });
    expect(moveFocus(rows, DB_A, "ArrowLeft", true)).toEqual({ focus: "a" });
  });
});

describe("windowRange guards", () => {
  it("a_zero_row_height_does_not_divide_by_zero", () => {
    expect(windowRange(100, 50, 800, 0)).toEqual({ start: 0, end: 8 });
  });
});

describe("filter details", () => {
  const pg = (filter: string) =>
    data({
      connections: [conn("p", "P", "postgres")],
      states: { p: "open" },
      branches: {
        p: branch({
          databases: { s: "loaded", value: ["app", "other", "loading"] },
          schemas: {
            app: { s: "loaded", value: [{ name: "public", isSystem: false }, { name: "audit", isSystem: false }] },
            other: { s: "failed", message: "denied" },
          },
          objects: { "app\u0000public": { s: "loaded", value: [obj("parcels")] }, "app\u0000audit": { s: "loaded", value: [obj("log")] } },
        }),
      },
      filter,
    });

  it("unmatched_databases_and_schemas_are_dropped_and_notes_hidden_while_filtering", () => {
    const rows = flattenTree(pg("parcel"));
    expect(rows.map((r) => r.node.kind)).toEqual(["connection", "database", "schema", "folder", "object"]);
    expect(rows.some((r) => r.node.kind === "note")).toBe(false);
    expect(rows.map((r) => r.node.kind)).not.toContain("savedRoot");
    const unfiltered = flattenTree({ ...pg(""), expanded: new Set(["p", databaseId("p", "other"), databaseId("p", "loading")]) });
    expect(unfiltered.filter((r) => r.node.kind === "note").map((r) => (r.node as { text: string }).text)).toEqual([
      "denied",
      "Loading schemas…",
    ]);
  });

  it("a_matching_database_stays_without_its_children_and_spaces_are_kept", () => {
    const rows = flattenTree(pg("oth"));
    expect(rows.map((r) => r.node.kind)).toEqual(["connection", "database"]);
    expect(rows[1].match).toEqual([0, 3]);
    expect(flattenTree(pg("   "))).toEqual(flattenTree(pg("")));
    expect(flattenTree(pg("a b")).some((r) => r.node.kind === "database")).toBe(false);
  });
});

describe("row ids", () => {
  const open = (c: string, objects: BranchData["objects"], extra: string[] = []) => ({
    branch: branch({ objects }),
    ids: [c, databaseId(c, "shop"), ...extra],
  });

  it("ids_stay_unique_with_colons_the_same_table_in_two_schemas_connections_and_overloads", () => {
    const a = open("a", { shop: { s: "loaded", value: [obj("x:y"), obj("x"), obj("f", "function"), obj("f", "function")] } });
    const b = open("b", { shop: { s: "loaded", value: [obj("x")] } });
    const expanded = new Set([...a.ids, ...b.ids, folderId("a", "shop", "table"), folderId("a", "shop", "function"), folderId("b", "shop", "table")]);
    const rows = flattenTree(
      data({
        connections: [conn("a", "A"), conn("b", "B")],
        states: { a: "open", b: "open" },
        branches: { a: a.branch, b: b.branch },
        expanded,
      }),
    );
    const all = ids(rows);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain(objectId("a", "table", "shop", "x:y"));
    expect(all).toContain(`${objectId("a", "function", "shop", "f")}#2`);
    expect(all).toContain(objectId("a", "table", "shop", "x"));
    expect(all).toContain(objectId("b", "table", "shop", "x"));
  });

  it("every_id_is_unique_across_a_big_tree", () => {
    const connections = [conn("a", "A"), conn("b", "B", "postgres")];
    const objects: BranchData["objects"] = {};
    const schemas = [{ name: "s1", isSystem: false }, { name: "s2", isSystem: false }];
    const expanded = new Set<string>(["a", "b", databaseId("a", "d"), databaseId("b", "d")]);
    for (const s of schemas) {
      expanded.add(schemaId("b", "d", s.name));
      objects[`d\u0000${s.name}`] = { s: "loaded", value: Array.from({ length: 300 }, (_, i) => obj(`t${i % 250}`)) };
      expanded.add(folderId("b", `d\u0000${s.name}`, "table"));
    }
    objects.d = { s: "loaded", value: Array.from({ length: 300 }, (_, i) => obj(`t${i % 250}`)) };
    expanded.add(folderId("a", "d", "table"));
    const rows = flattenTree(
      data({
        connections,
        states: { a: "open", b: "open" },
        branches: {
          a: branch({ databases: { s: "loaded", value: ["d"] }, objects }),
          b: branch({ databases: { s: "loaded", value: ["d"] }, schemas: { d: { s: "loaded", value: schemas } }, objects }),
        },
        saved: [saved("q1", "one"), saved("q2", "two")],
        expanded,
      }),
    );
    const all = ids(rows);
    expect(all.length).toBeGreaterThan(900);
    expect(new Set(all).size).toBe(all.length);
  });
});
