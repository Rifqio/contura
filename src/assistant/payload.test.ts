import { describe, expect, it } from "vitest";
import type { AiAccess } from "../api/types";
import { type AskContext, toAskRequest } from "./context";
import { actionsFor, sizeText, tablesLine, tokensText } from "./payload";

const conn = (access: AiAccess) => ({ id: "c1", name: "KFC shop", dialect: "postgres" as const, database: "kfc", access });
const sqlCtx: AskContext = {
  kind: "sql",
  connection: conn("schemaQuery"),
  sql: "SELECT * FROM orders",
  lines: [1, 1],
  tables: [{ schema: "sales", name: "orders" }],
  label: "Selection",
};

describe("toAskRequest", () => {
  it("maps_a_sql_context", () => {
    const r = toAskRequest(sqlCtx, "why slow?", ["cards"], { rows: false, values: true }, { groupId: "g1", action: "explain" });
    expect(r).toMatchObject({
      place: "group:g1",
      groupId: "g1",
      connectionId: "c1",
      database: "kfc",
      schema: null,
      action: "explain",
      question: "why slow?",
      threadId: null,
      focus: { sql: "SELECT * FROM orders", selection: null, error: null, filter: null, dbml: null, tables: [{ schema: "sales", name: "orders" }], untiedModel: false },
      switches: { rows: false, values: true },
      off: ["cards"],
    });
    expect(r.requestId).not.toBe("");
  });

  it("maps_filter_error_card_and_no_connection", () => {
    const sw = { rows: false, values: false };
    const filter = toAskRequest({ ...sqlCtx, kind: "filter", sql: "status = 'x'" }, "q", [], sw, { groupId: null });
    expect(filter.place).toBe("ungrouped");
    expect(filter.action).toBe("ask");
    expect(filter.focus.filter).toBe("status = 'x'");
    expect(filter.focus.sql).toBeNull();
    const error = toAskRequest({ ...sqlCtx, kind: "error", error: "42P01 relation x does not exist" }, "q", [], sw, { groupId: null });
    expect(error.focus.sql).toBe("SELECT * FROM orders");
    expect(error.focus.error).toBe("42P01 relation x does not exist");
    const card = toAskRequest({ kind: "card", connection: null, tables: [], dbml: "Table a {}", label: "x.dbml" }, "q", [], sw, { groupId: null });
    expect(card.connectionId).toBeNull();
    expect(card.database).toBeNull();
    expect(card.focus.dbml).toBe("Table a {}");
  });
});

describe("sizes", () => {
  it("uses_compact_units_and_grouping", () => {
    expect(sizeText(900)).toBe("900 B");
    expect(sizeText(2355)).toBe("2.3 KB");
    expect(sizeText(204_800)).toBe("200 KB");
    expect(sizeText(1_572_864)).toBe("1.5 MB");
    expect(tokensText(1)).toBe("about 1 token");
    expect(tokensText(12_345)).toBe("about 12,345 tokens");
  });

  it("tables_line_counts_each_list", () => {
    expect(tablesLine({ full: ["a", "b"], namesOnly: ["c"], leftOut: [], reasons: [] })).toBe("2 full, 1 names only, 0 left out");
    expect(tablesLine({ full: ["a"], namesOnly: [], leftOut: [], reasons: [] })).toBeNull();
  });
});

describe("actionsFor", () => {
  it("puts Fix this error first for errors", () => {
    expect(actionsFor("error")[0].label).toBe("Fix this error");
    expect(actionsFor("filter")[0].label).toBe("Write a WHERE for this filter");
  });
});
