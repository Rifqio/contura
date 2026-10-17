import { describe, expect, it } from "vitest";
import type { AiAccess } from "../api/types";
import { KFC_SCHEMA } from "../lang/sql/fixtures";
import { actionsFor, type AskContext } from "./context";
import { buildSends, payloadText } from "./payload";

const conn = (access: AiAccess) => ({ id: "c1", name: "KFC shop", dialect: "postgres" as const, database: "kfc", access });
const SQL9 = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n");
const sqlCtx = (access: AiAccess): AskContext => ({
  kind: "sql",
  connection: conn(access),
  sql: SQL9,
  lines: [1, 9],
  tables: [{ schema: "sales", name: "orders" }],
  label: "Selection",
});
const by = (items: ReturnType<typeof buildSends>, key: string) => items.find((i) => i.key === key)!;

describe("buildSends", () => {
  it("sql_selection_sends_query_and_schema", () => {
    const items = buildSends(sqlCtx("schemaQuery"), KFC_SCHEMA, false);
    expect(by(items, "query").on).toBe(true);
    expect(by(items, "query").text.startsWith("Query (lines 1 to 9):")).toBe(true);
    expect(by(items, "schema").on).toBe(true);
    expect(by(items, "rows").locked).toBe("Sample rows are off for KFC shop");
  });

  it("schema_only_locks_query_text", () => {
    const items = buildSends(sqlCtx("schema"), KFC_SCHEMA, false);
    expect(by(items, "query").locked).toBe("KFC shop shares schema only");
    expect(by(items, "schema").on).toBe(true);
  });

  it("never_sends_only_the_question", () => {
    const ctx: AskContext = { ...sqlCtx("never"), kind: "error", error: "42703 column o.store does not exist" };
    const items = buildSends(ctx, KFC_SCHEMA, false);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.locked && !i.on)).toBe(true);
    expect(payloadText(items)).toBe("Only your question");
    expect(items.every((i) => i.text === "")).toBe(true);
  });

  it("no_connection_fails_closed", () => {
    const items = buildSends({ ...sqlCtx("schema"), connection: null }, KFC_SCHEMA, false);
    expect(by(items, "query").locked).toBe("No Connection is chosen");
    expect(by(items, "schema").locked).toBe("No Connection is chosen");
    expect(by(items, "rows").locked).not.toBeNull();
    expect(payloadText(items)).toBe("Only your question");
    const none = buildSends({ kind: "none", connection: null, tables: [], label: "Home" }, null, false);
    expect(payloadText(none)).toBe("Only your question");
    const card = buildSends({ kind: "card", connection: null, tables: [], dbml: "Table a {}", label: "x.dbml" }, null, false);
    expect(by(card, "dbml").on).toBe(true);
    expect(payloadText(card)).toContain("Table a {}");
  });

  it("rows_allowed_but_switched_off", () => {
    const rows = by(buildSends(sqlCtx("schemaQueryRows"), KFC_SCHEMA, true), "rows");
    expect(rows.locked).toBeNull();
    expect(rows.on).toBe(false);
    expect(by(buildSends(sqlCtx("schemaQueryRows"), KFC_SCHEMA, false), "rows").on).toBe(true);
  });

  it("schema_text_matches_the_design", () => {
    const text = by(buildSends(sqlCtx("schema"), KFC_SCHEMA, false), "schema").text;
    const lines = text.split("\n");
    expect(lines[0]).toBe("Dialect: PostgreSQL, database kfc");
    expect(lines[1].startsWith("orders(id int8 pk, store_id int4 -> stores.id, ")).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it("empty_tables_means_no_schema_item", () => {
    const items = buildSends({ ...sqlCtx("schema"), tables: [] }, KFC_SCHEMA, false);
    expect(items.find((i) => i.key === "schema")).toBeUndefined();
  });

  it("card_sends_dbml_and_locks_rows", () => {
    const ctx: AskContext = { kind: "card", connection: conn("schemaQueryRows"), tables: [], dbml: "Table a {}", label: "shop.dbml" };
    const items = buildSends(ctx, null, false);
    expect(by(items, "dbml").on).toBe(true);
    expect(by(items, "rows").locked).toBe("A Schema Model has no rows");
  });

  it("filter_sends_its_text_from_schema_and_query", () => {
    const ctx: AskContext = { ...sqlCtx("schemaQuery"), kind: "filter", sql: "status = 'refunded'", lines: undefined };
    const items = buildSends(ctx, KFC_SCHEMA, false);
    expect(by(items, "query").label).toBe("Filter text");
    expect(by(items, "query").text).toBe("Filter (orders): status = 'refunded'");
    expect(by(items, "query").on).toBe(true);
    expect(by(buildSends({ ...ctx, connection: conn("schema") }, KFC_SCHEMA, false), "query").locked).toBe("KFC shop shares schema only");
  });

  it("payload_is_capped", () => {
    const ctx: AskContext = { ...sqlCtx("schemaQuery"), sql: "x".repeat(300 * 1024) };
    const text = payloadText(buildSends(ctx, KFC_SCHEMA, false));
    expect(text.endsWith("\n… cut at 200 KB")).toBe(true);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(200 * 1024 + 32);
  });
});

describe("sample rows", () => {
  it("no_sample_rows_line_is_sent_at_any_access_level", () => {
    for (const access of ["never", "schema", "schemaQuery", "schemaQueryRows"] as const) {
      expect(payloadText(buildSends(sqlCtx(access), KFC_SCHEMA, false))).not.toMatch(/sample rows/i);
    }
  });
});

describe("actionsFor", () => {
  it("puts Fix this error first for errors", () => {
    expect(actionsFor("error")[0].label).toBe("Fix this error");
    expect(actionsFor("filter")[0].label).toBe("Write a WHERE for this filter");
  });
});
