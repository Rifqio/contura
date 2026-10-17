import { describe, expect, it } from "vitest";
import type { ConnectionConfig, SqlSchema } from "../api/types";
import type { QueryTabDoc } from "../query/QueryTab";
import type { WorkTab } from "../shell/tabs";
import { assistantContextFor, assistantTargetFor } from "./assistantContext";

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

const target = (c = conn(), d = doc()) => ({ connection: c, database: "shop", doc: d });

describe("assistantTargetFor", () => {
  it("target_is_the_query_tabs_connection_in_this_place_only", () => {
    const a = conn();
    expect(assistantTargetFor(query(doc()), [a])).toEqual({ connection: a, database: "shop", doc: doc() });
    expect(assistantTargetFor(query(doc()), [conn({ id: "z" })])).toBeNull();
    expect(assistantTargetFor({ kind: "savedQueries" }, [a])).toBeNull();
    expect(assistantTargetFor({ kind: "object", key: "k", selection: { connectionId: "a" } as never }, [a])).toBeNull();
    expect(assistantTargetFor(undefined, [a])).toBeNull();
  });

  it("sqlite_target_database_is_main", () => {
    const lite = conn({ dialect: "sqlite" });
    expect(assistantTargetFor(query(doc({ database: null })), [lite])?.database).toBe("main");
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
