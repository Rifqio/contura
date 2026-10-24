import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SqlEditorApi } from "../query/SqlEditor";
import { answerText, commentedOut, type RunFn, useQueryTabRefs } from "./queryTabRefs";

describe("answerText", () => {
  it("answer_text_ends_with_one_semicolon_and_a_new_line", () => {
    expect(answerText("SELECT 1;  ")).toBe("SELECT 1;\n");
    expect(answerText("SELECT 1")).toBe("SELECT 1;\n");
  });
});

describe("commentedOut", () => {
  it("commented_out", () => {
    expect(commentedOut("DELETE FROM t\nWHERE a = 1;")).toBe("-- DELETE FROM t\n-- WHERE a = 1;\n");
    expect(commentedOut("DELETE FROM t;\n")).toBe("-- DELETE FROM t;\n");
    expect(commentedOut("A\r\nB")).toBe("-- A\n-- B\n");
  });

  it("every line end starts a commented line", () => {
    expect(commentedOut("SELECT 1;\rDROP TABLE orders;")).toBe("-- SELECT 1;\n-- DROP TABLE orders;\n");
    const mixed = commentedOut("SELECT 1;\r\nDELETE FROM a;\rDELETE FROM b;\nDELETE FROM c;\u2028DELETE FROM d;\u2029DELETE FROM e;\u0085DELETE FROM f;");
    const lines = mixed.trimEnd().split(/\r\n|\r|\n|\u0085|\u2028|\u2029/);
    expect(lines).toHaveLength(7);
    for (const l of lines) expect(l.startsWith("-- ")).toBe(true);
    expect(mixed).not.toMatch(/[\r\u0085\u2028\u2029]/);
  });

  it("commented text is not wrapped again: no live `;` after it", () => {
    const once = commentedOut(answerText("DELETE FROM t\u0085"));
    expect(once).toBe("-- DELETE FROM t;\n");
    expect(answerText(once)).toBe(once);
    expect(answerText(commentedOut("SELECT 1;\rDROP TABLE t;\u0085"))).toBe("-- SELECT 1;\n-- DROP TABLE t;\n");
    // Live SQL still gets its one `;`.
    expect(answerText("SELECT 1\u0085")).toBe("SELECT 1;\n");
  });
});

describe("useQueryTabRefs", () => {
  it("refs_are_stable_per_id", () => {
    const { result } = renderHook(() => useQueryTabRefs());
    expect(result.current.editorRef("a")).toBe(result.current.editorRef("a"));
    expect(result.current.runRef("a")).toBe(result.current.runRef("a"));
    expect(result.current.editorRef("a")).not.toBe(result.current.editorRef("b"));
    expect(result.current.runRef("a")).not.toBe(result.current.runRef("b"));
  });

  it("forget_and_clear_drop_refs", () => {
    const { result } = renderHook(() => useQueryTabRefs());
    const a = result.current.editorRef("a");
    const b = result.current.runRef("b");
    result.current.forget("a");
    expect(result.current.editorRef("a")).not.toBe(a);
    expect(result.current.runRef("b")).toBe(b);
    result.current.clear();
    expect(result.current.runRef("b")).not.toBe(b);
  });

  it("editor_and_runner_read_the_current_values", async () => {
    const { result } = renderHook(() => useQueryTabRefs());
    expect(result.current.editor("a")).toBeNull();
    expect(result.current.runner("a")).toBeNull();
    const api = { insert: () => {} } as unknown as SqlEditorApi;
    const run: RunFn = async () => ({ ran: true }) as never;
    result.current.editorRef("a").current = api;
    result.current.runRef("a").current = run;
    expect(result.current.editor("a")).toBe(api);
    expect(result.current.runner("a")).toBe(run);
  });
});
