import { describe, expect, test } from "vitest";
import { parseMysqlEnum, pickerFor } from "./picker";

describe("parseMysqlEnum", () => {
  test("reads the values in order", () => {
    expect(parseMysqlEnum("enum('draft','paid','void')")).toEqual(["draft", "paid", "void"]);
    expect(parseMysqlEnum("ENUM('a', 'b')")).toEqual(["a", "b"]);
  });
  test("doubled and escaped quotes, commas and parentheses inside values", () => {
    expect(parseMysqlEnum("enum('it''s','a,b','(x)','')")).toEqual(["it's", "a,b", "(x)", ""]);
    expect(parseMysqlEnum("enum('back\\\\slash','say \\'hi\\'')")).toEqual(["back\\slash", "say 'hi'"]);
  });
  test("anything else is not an enum", () => {
    expect(parseMysqlEnum("set('a','b')")).toBeNull();
    expect(parseMysqlEnum("varchar(10)")).toBeNull();
    expect(parseMysqlEnum("enum('a'")).toBeNull();
    expect(parseMysqlEnum("enum('a' 'b')")).toBeNull();
  });
});

describe("pickerFor", () => {
  test("mysql enum from the column's full type", () => {
    expect(pickerFor("enum('s','m','l')", "mysql")).toEqual({ kind: "enum", values: ["s", "m", "l"] });
  });
  test("postgres enum from the schema index's labels", () => {
    expect(pickerFor("mood", "postgres", ["sad", "ok"])).toEqual({ kind: "enum", values: ["sad", "ok"] });
    expect(pickerFor("mood", "postgres", [])).toBeNull();
    expect(pickerFor("mood", "postgres")).toBeNull();
  });
  test("sqlite has no enum; set stays text", () => {
    expect(pickerFor("enum('a')", "sqlite")).toBeNull();
    expect(pickerFor("set('a','b')", "mysql")).toBeNull();
  });
  test("temporal types", () => {
    expect(pickerFor("datetime(3)", "mysql")).toEqual({ kind: "temporal", spec: { kind: "datetime", fraction: 3, trim: false, zone: false } });
    expect(pickerFor("text", "postgres")).toBeNull();
  });
});
