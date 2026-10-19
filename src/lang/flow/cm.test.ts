import { ensureSyntaxTree, foldable } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { CompletionContext } from "@codemirror/autocomplete";
import { describe, expect, test, vi } from "vitest";
import type { LangClient } from "../client";
import { flowLanguage, flowLanguageSupport, flowLanguageWith, toCmCompletions } from "./cm";

test("a stale completion answer is asked once more, and the second answer is shown", async () => {
  const completeFlow = vi
    .fn()
    .mockResolvedValueOnce({ from: 9, items: [], stale: true })
    .mockResolvedValueOnce({ from: 9, items: [{ label: "store", kind: "kind", apply: "store" }] });
  const client = { completeFlow } as unknown as LangClient;
  const text = 'diagram dfd "A"\nR [st';
  const state = EditorState.create({ doc: text, extensions: flowLanguageWith(client, "d") });
  const source = state.languageDataAt<(c: CompletionContext) => Promise<{ options: { label: string }[] } | null>>("autocomplete", text.length)[0];
  const r = await source(new CompletionContext(state, text.length, false));
  expect(completeFlow).toHaveBeenCalledTimes(2);
  expect(r?.options.map((o) => o.label)).toEqual(["store"]);
});

const ROLES = tagHighlighter([
  { tag: tags.keyword, class: "keyword" },
  { tag: tags.typeName, class: "typeName" },
  { tag: tags.propertyName, class: "property" },
  { tag: tags.operator, class: "operator" },
  { tag: tags.special(tags.variableName), class: "arrow" },
  { tag: tags.variableName, class: "name" },
  { tag: tags.punctuation, class: "punctuation" },
  { tag: tags.string, class: "string" },
  { tag: tags.comment, class: "comment" },
]);

function roles(text: string): [string, string][] {
  const state = EditorState.create({ doc: text, extensions: flowLanguage });
  const tree = ensureSyntaxTree(state, text.length, 5000)!;
  const out: [string, string][] = [];
  highlightTree(tree, ROLES, (from, to, cls) => out.push([text.slice(from, to), cls]));
  return out;
}

const roleOf = (text: string, piece: string) => roles(text).find(([t]) => t === piece)?.[1];

const TEXT = [
  'diagram dfd "Checkout"',
  "// a note",
  "Customer [entity]",
  "Orders [store, id: D1, table: shop.orders]",
  "Payments [icon: bank] {",
  "  Charge card [process, id: 2]",
  "  Inner {",
  "    Deep [process]",
  "  }",
  "}",
  'Customer > Orders: order "details"',
  "Orders --> Customer",
  "Charge card <> Orders",
  "",
].join("\n");

describe("highlighting", () => {
  test("the first line, kinds, keys, arrows, names, labels and comments get their roles", () => {
    expect(roleOf(TEXT, "diagram")).toBe("keyword");
    expect(roleOf(TEXT, "dfd")).toBe("typeName");
    expect(roleOf(TEXT, '"Checkout"')).toBe("string");
    expect(roleOf(TEXT, "// a note")).toBe("comment");
    expect(roleOf(TEXT, "Customer")).toBe("name");
    expect(roleOf(TEXT, "entity")).toBe("typeName");
    expect(roleOf(TEXT, "table")).toBe("property");
    expect(roleOf(TEXT, "shop.orders")).toBe("string");
    expect(roleOf(TEXT, "[")).toBe("punctuation");
    expect(roleOf(TEXT, "{")).toBe("punctuation");
    expect(roleOf(TEXT, ">")).toBe("arrow");
    expect(roleOf(TEXT, "-->")).toBe("arrow");
    expect(roleOf(TEXT, "<>")).toBe("arrow");
    expect(roleOf(TEXT, ':')).toBe("operator");
    expect(roleOf(TEXT, 'order "details"')).toBe("string");
  });

  test("a name with spaces is one name, and a quoted name reads as a name", () => {
    expect(roleOf(TEXT, "Charge card")).toBe("name");
    expect(roleOf('diagram flow "A"\n"a: b" > X\n', '"a: b"')).toBe("name");
  });

  test("an odd line never throws", () => {
    for (const odd of ['"open', "[[[", "a > > :", "]]}}{{", '"\\', "x [icon: \"y"]) expect(() => roles(odd)).not.toThrow();
  });
});

describe("folding", () => {
  test("each group folds from its brace to its closing brace", () => {
    const state = EditorState.create({ doc: TEXT, extensions: flowLanguageSupport() });
    const line = (n: number) => state.doc.line(n);
    const outer = foldable(state, line(5).from, line(5).to);
    expect(outer).toEqual({ from: line(5).to, to: line(10).from });
    const inner = foldable(state, line(7).from, line(7).to);
    expect(inner).toEqual({ from: line(7).to, to: line(9).from + 2 });
    expect(foldable(state, line(3).from, line(3).to)).toBeNull();
  });

  test("an unclosed group and a brace in a comment or quotes do not fold", () => {
    const text = 'diagram flow "A"\nG {\n  A\nB // {\n"x {"\n';
    const state = EditorState.create({ doc: text, extensions: flowLanguageSupport() });
    for (let n = 1; n <= state.doc.lines; n++) {
      const l = state.doc.line(n);
      expect(foldable(state, l.from, l.to)).toBeNull();
    }
  });
});

describe("completion options", () => {
  test("keep the worker's order and are not filtered again", () => {
    const r = toCmCompletions({ from: 3, items: [{ label: "aws-s3", kind: "icon", apply: "aws-s3" }, { label: "Orders", kind: "node", apply: "Orders" }] });
    expect(r?.from).toBe(3);
    expect(r?.filter).toBe(false);
    expect(r?.options.map((o) => o.label)).toEqual(["aws-s3", "Orders"]);
    expect(toCmCompletions({ from: 0, items: [] })).toBeNull();
  });
});
