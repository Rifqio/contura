import { describe, expect, it } from "vitest";
import type { AskTab, ConnectionConfig, SqlSchema } from "../api/types";
import { alsoOf, toAskRequest, withTabFields } from "../assistant/context";
import type { QueryTabDoc } from "../query/QueryTab";
import type { ModelDoc } from "../schema/SchemaBuilder";
import type { AnyTab, WorkTab } from "../shell/tabs";
import { type AssistantTarget, assistantContextFor, assistantTargetFor } from "./assistantContext";

const conn = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "a",
  name: "Shop",
  dialect: "postgres",
  host: "h",
  port: 1,
  user: "u",
  database: null,
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
  ...over,
});

const doc = (over: Partial<QueryTabDoc> = {}): QueryTabDoc => ({
  id: "q1",
  name: "Orders",
  text: "SELECT 1;\nSELECT a\nFROM orders",
  connectionId: "a",
  database: "shop",
  savedId: null,
  savedText: null,
  ...over,
});
const query = (d: QueryTabDoc): WorkTab => ({ kind: "query", doc: d });

const target = (c = conn(), d = doc()): AssistantTarget => ({
  connection: c,
  connectionId: c.id,
  database: "shop",
  schema: null,
  tabKind: "query",
  tab: { kind: "query", title: d.name },
  doc: d,
  also: [],
});

const path = (name: string, database = "shop", schema: string | null = null) => ({ database, schema, name });
const model = (over: Partial<ModelDoc> = {}): ModelDoc =>
  ({ path: "/home/k/kestrel.dbml", dbml: "", savedDbml: "", layout: {}, dialect: "postgres", source: "connection", connectionId: "a", ...over }) as ModelDoc;
/** What the target names: the Connection, database, schema and other Connections (spec 4's table). */
const where = (t: AssistantTarget | null) => t && { id: t.connectionId, found: t.connection?.id ?? null, database: t.database, schema: t.schema, also: t.also };

describe("assistantTargetFor", () => {
  const a = conn();
  const b = conn({ id: "b", name: "Kestrel staging", groupId: "g2" });

  it("target per tab kind", () => {
    const inPlace = [a];
    const all = [a, b];
    const of = (t: AnyTab) => where(assistantTargetFor(t, inPlace, all));
    expect(of(query(doc()))).toEqual({ id: "a", found: "a", database: "shop", schema: null, also: [] });
    expect(of({ kind: "object", key: "k", selection: { connectionId: "a", kind: "table", path: path("orders", "shop", "sales") } })).toEqual({
      id: "a",
      found: "a",
      database: "shop",
      schema: "sales",
      also: [],
    });
    expect(of({ kind: "design", key: "d", connectionId: "a", target: { kind: "alter", path: path("orders", "shop", "sales") } })).toEqual({
      id: "a",
      found: "a",
      database: "shop",
      schema: "sales",
      also: [],
    });
    expect(
      of({ kind: "design", key: "n", connectionId: "a", target: { kind: "create", scope: { database: "warehouse", schema: "public" }, id: "n1" } }),
    ).toEqual({ id: "a", found: "a", database: "warehouse", schema: "public", also: [] });
    const visual = { id: "v1", name: "Orders over 1M", connectionId: "a", database: "shop", model: {} as never, savedId: null, savedJson: null };
    expect(of({ kind: "visual", doc: visual })).toEqual({ id: "a", found: "a", database: "shop", schema: null, also: [] });
    expect(of({ kind: "import", key: "i", connectionId: "a", target: { kind: "table", path: path("orders") } })).toEqual({
      id: "a",
      found: "a",
      database: "shop",
      schema: null,
      also: [],
    });
    expect(of({ kind: "import", key: "j", connectionId: "a", target: { kind: "database", database: "warehouse" } })?.database).toBe("warehouse");
    expect(of({ kind: "lineage", key: "l", connectionId: "a", path: path("orders", "shop", "sales") })).toEqual({
      id: "a",
      found: "a",
      database: "shop",
      schema: "sales",
      also: [],
    });
    // A tied model asks on its source; an untied one has no Connection.
    expect(of({ kind: "schema", id: "s1", doc: model() })).toEqual({ id: "a", found: "a", database: null, schema: null, also: [] });
    expect(of({ kind: "schema", id: "s2", doc: model({ connectionId: null, source: "blank" }) })).toEqual({
      id: null,
      found: null,
      database: null,
      schema: null,
      also: [],
    });
    // Compare: the target, with a database source as the other Connection; a model source spans none.
    const side = (connectionId: string, database: string) => ({ connectionId, database, schema: null });
    expect(
      of({ kind: "compare", id: "c1", title: "", connectionId: "b", seed: { source: { kind: "database", ...side("a", "shop") }, target: side("b", "shop_staging") } }),
    ).toEqual({ id: "b", found: "b", database: "shop_staging", schema: null, also: ["a"] });
    expect(
      of({
        kind: "compare",
        id: "c2",
        title: "",
        connectionId: "b",
        seed: { source: { kind: "model", model: {} as never, path: null, dialect: "postgres", notice: null }, target: side("b", "shop_staging") },
      }),
    ).toEqual({ id: "b", found: "b", database: "shop_staging", schema: null, also: [] });
    // Transfer before the target is chosen: the source side, nothing else.
    expect(
      of({ kind: "transfer", id: "t1", title: "", dirty: false, seed: { connectionId: "a", database: "shop", schema: null, table: "orders" } }),
    ).toEqual({ id: "a", found: "a", database: "shop", schema: null, also: [] });
    for (const t of [{ kind: "home" }, { kind: "settings", section: "ai" }, { kind: "savedQueries" }] as AnyTab[]) {
      expect(of(t)).toEqual({ id: null, found: null, database: null, schema: null, also: [] });
    }
    expect(assistantTargetFor({ kind: "flow", name: "orders" }, inPlace, all)).toBeNull();
    expect(assistantTargetFor(undefined, inPlace, all)).toBeNull();
  });

  it("the tab App knows goes with the target", () => {
    expect(assistantTargetFor({ kind: "home" }, [a], [a])?.tab).toEqual({ kind: "home" });
    expect(assistantTargetFor({ kind: "settings", section: "appearance" }, [a], [a])?.tab).toEqual({ kind: "settings", section: "appearance" });
    expect(assistantTargetFor({ kind: "savedQueries" }, [a], [a])?.tab).toEqual({ kind: "savedQueries" });
    expect(assistantTargetFor(query(doc()), [a], [a])?.tab).toEqual({ kind: "query", title: "Orders" });
    expect(assistantTargetFor({ kind: "lineage", key: "l", connectionId: "a", path: path("orders") }, [a], [a])?.tab).toEqual({
      kind: "lineage",
      path: path("orders"),
      neighbours: [],
    });
  });

  it("window tabs find Connections in other Groups", () => {
    // b is in another Group: a place tab does not find it, a window tab does.
    const compare: AnyTab = {
      kind: "compare",
      id: "c1",
      title: "",
      connectionId: "b",
      seed: { source: { kind: "database", connectionId: "a", database: "shop", schema: null }, target: null },
    };
    expect(assistantTargetFor(compare, [a], [a, b])?.connection).toBe(b);
    expect(assistantTargetFor({ kind: "schema", id: "s", doc: model({ connectionId: "b" }) }, [a], [a, b])?.connection).toBe(b);
    const object: AnyTab = { kind: "object", key: "k", selection: { connectionId: "b", kind: "table", path: path("orders") } };
    // Not in this place: the id stays, so the Core counts it at Nothing.
    expect(where(assistantTargetFor(object, [a], [a, b]))).toMatchObject({ id: "b", found: null });
  });

  it("a query tab on no Connection of this place asks with none, as before", () => {
    expect(where(assistantTargetFor(query(doc()), [conn({ id: "z" })], [a]))).toMatchObject({ id: null, found: null });
  });

  it("sqlite_target_database_is_main", () => {
    const lite = conn({ dialect: "sqlite" });
    expect(assistantTargetFor(query(doc({ database: null })), [lite], [lite])?.database).toBe("main");
  });
});

describe("withTabFields", () => {
  const a = conn();
  const b = conn({ id: "b", name: "Kestrel analytics", aiAccess: "schemaQuery" });
  const transfer: AnyTab = { kind: "transfer", id: "t1", title: "", dirty: false, seed: { connectionId: "a", database: "shop", schema: null, table: null } };

  it("transfer after the target is chosen asks on the target, with the source as the other Connection", () => {
    const base = assistantContextFor(assistantTargetFor(transfer, [a], [a, b])!, null, null);
    const tab: AskTab = { kind: "transfer", sourceDatabase: "shop", targetDatabase: "analytics", mode: "perTable", tables: [], notes: [] };
    const ctx = withTabFields(base, { tab, also: ["a"], where: { connectionId: "b", database: "analytics", schema: null } }, [a, b]);
    expect(ctx.connection).toEqual({ id: "b", name: "Kestrel analytics", dialect: "postgres", database: "analytics", access: "schemaQuery" });
    const req = toAskRequest(ctx, "q", [], { rows: false, values: false }, { groupId: null });
    expect(req.connectionId).toBe("b");
    expect(req.database).toBe("analytics");
    expect(req.focus.also).toEqual(["a"]);
    expect(req.tab).toEqual(tab);
  });

  it("a Connection that is gone keeps its id at Nothing", () => {
    const base = assistantContextFor(assistantTargetFor(transfer, [a], [a])!, null, null);
    const ctx = withTabFields(base, { tab: { kind: "home" }, where: { connectionId: "gone", database: "x", schema: null } }, [a]);
    expect(ctx.connection).toMatchObject({ id: "gone", access: "never" });
  });

  it("no fields keep the base", () => {
    const base = assistantContextFor(assistantTargetFor({ kind: "home" }, [a], [a])!, null, null);
    expect(withTabFields(base, null, [a])).toBe(base);
  });
});

describe("focus.also", () => {
  it("each other Connection once, never the Ask's own", () => {
    expect(alsoOf("a", ["a", "b", "b", "c"])).toEqual(["b", "c"]);
  });

  it("never cuts past four: every Connection stays in the gate and the Core refuses the Ask", () => {
    expect(alsoOf(null, ["b", "c", "d", "e", "f", "g"])).toEqual(["b", "c", "d", "e", "f", "g"]);
    const ctx = assistantContextFor(target(), null, null);
    const req = toAskRequest({ ...ctx, also: ["b", "c", "d", "e", "f"] }, "q", [], { rows: false, values: false }, { groupId: null });
    expect(req.focus.also).toEqual(["b", "c", "d", "e", "f"]);
  });

  it("is left out of the request when there is none", () => {
    const ctx = assistantContextFor(target(), null, null);
    const req = toAskRequest({ ...ctx, also: ["a"] }, "q", [], { rows: false, values: false }, { groupId: null });
    expect("also" in req.focus).toBe(false);
  });
});

describe("assistantContextFor", () => {
  it("context_uses_the_statement_where_you_are_typing_and_its_lines", () => {
    const ctx = assistantContextFor(target(), null, { from: 10, to: 30, text: "SELECT a\nFROM orders" });
    expect(ctx.kind).toBe("sql");
    expect(ctx.sql).toBe("SELECT a\nFROM orders");
    expect(ctx.lines).toEqual([2, 3]);
  });

  it("context_without_a_statement_uses_the_whole_text_from_line_1", () => {
    const ctx = assistantContextFor(target(), null, null);
    expect(ctx.sql).toBe("SELECT 1;\nSELECT a\nFROM orders");
    expect(ctx.lines).toEqual([1, 3]);
  });

  it("empty_text_is_kind_none_with_no_sql", () => {
    const ctx = assistantContextFor(target(conn(), doc({ text: "  \n " })), null, null);
    expect(ctx.kind).toBe("none");
    expect(ctx.sql).toBeUndefined();
  });

  it("tables_are_the_schema_tables_named_in_the_sql_ignoring_case", () => {
    const schema: SqlSchema = {
      searchPath: [],
      fks: [],
      tables: [
        { schema: "public", name: "Orders", kind: "table", columns: [] },
        { schema: null, name: "users", kind: "table", columns: [] },
      ],
    };
    const ctx = assistantContextFor(target(), schema, null);
    expect(ctx.tables).toEqual([{ schema: "public", name: "Orders" }]);
  });

  it("label_is_the_tab_name_and_access_is_the_connections_ai_access", () => {
    const ctx = assistantContextFor(target(conn({ aiAccess: "none" as never })), null, null);
    expect(ctx.label).toBe("Orders");
    expect(ctx.connection).toEqual({ id: "a", name: "Shop", dialect: "postgres", database: "shop", access: "none" });
  });
});
