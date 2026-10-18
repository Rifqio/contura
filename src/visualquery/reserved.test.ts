import { describe, expect, it } from "vitest";
import coreReserved from "../../crates/contura-core/src/visual_query/reserved.rs?raw";
import namesPostgres from "../../crates/contura-core/src/visual_query/golden/names.postgres.sql?raw";
import namesMysql from "../../crates/contura-core/src/visual_query/golden/names.mysql.sql?raw";
import namesSqlite from "../../crates/contura-core/src/visual_query/golden/names.sqlite.sql?raw";
import type { DialectKind } from "../api/types";
import { RESERVED, isReserved, isReservedAnywhere } from "./reserved";

function coreList(name: string): string[] {
  const start = coreReserved.indexOf(`const ${name}:`);
  const end = coreReserved.indexOf("];", start);
  return [...coreReserved.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("reserved words", () => {
  it("matches the Core lists word for word", () => {
    expect(RESERVED.postgres).toEqual(coreList("POSTGRES"));
    expect(RESERVED.mysql).toEqual(coreList("MYSQL"));
    expect(RESERVED.sqlite).toEqual(coreList("SQLITE"));
  });

  it("agrees with the words the Core quotes in the golden names case", () => {
    const sql: Record<DialectKind, string> = { postgres: namesPostgres, mysql: namesMysql, sqlite: namesSqlite };
    for (const dialect of ["postgres", "mysql", "sqlite"] as const) {
      // `order` and `select` are plain lower-case names, so only being reserved makes the Core quote them.
      for (const word of ["order", "select"]) {
        expect(isReserved(dialect, word)).toBe(true);
        expect(sql[dialect]).not.toMatch(new RegExp(`[ .]${word}\\b(?![\`"\\]])`));
      }
      // The aliases the Core writes bare are not reserved.
      for (const word of ["o", "c"]) expect(isReserved(dialect, word)).toBe(false);
    }
  });

  it("ignores case and knows the short words", () => {
    for (const word of ["or", "as", "do", "to", "in", "is", "on", "OR", "Select"]) expect(isReservedAnywhere(word)).toBe(true);
    expect(isReserved("postgres", "user")).toBe(true);
    expect(isReserved("mysql", "user")).toBe(false);
    expect(isReservedAnywhere("user")).toBe(true);
    expect(isReservedAnywhere("oi")).toBe(false);
  });
});
