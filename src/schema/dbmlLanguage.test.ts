import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { expect, test } from "vitest";
import { dbmlLanguage } from "./dbmlLanguage";

const ROLES = tagHighlighter([
  { tag: tags.keyword, class: "keyword" },
  { tag: tags.typeName, class: "typeName" },
  { tag: tags.modifier, class: "modifier" },
  { tag: tags.operator, class: "operator" },
  { tag: tags.special(tags.variableName), class: "ref" },
  { tag: tags.function(tags.variableName), class: "function" },
  { tag: tags.variableName, class: "variableName" },
  { tag: tags.punctuation, class: "punctuation" },
  { tag: tags.bool, class: "bool" },
  { tag: tags.null, class: "null" },
  { tag: tags.number, class: "number" },
  { tag: tags.string, class: "string" },
  { tag: tags.comment, class: "comment" },
]);

/** Each highlighted piece of the text with its role. */
function roles(text: string): [string, string][] {
  const state = EditorState.create({ doc: text, extensions: dbmlLanguage });
  const tree = ensureSyntaxTree(state, text.length, 5000)!;
  const out: [string, string][] = [];
  highlightTree(tree, ROLES, (from, to, cls) => out.push([text.slice(from, to), cls]));
  return out;
}

const roleOf = (text: string, piece: string) => roles(text).find(([t]) => t === piece)?.[1];

const ORDERS = "Table orders {\n  id int [pk, not null]\n  user_id int [ref: > users.id]\n}";

test("column_types_settings_ref_arrows_and_braces_get_their_roles", () => {
  expect(roleOf(ORDERS, "int")).toBe("typeName");
  expect(roleOf(ORDERS, "pk")).toBe("modifier");
  expect(roleOf(ORDERS, "not null")).toBe("modifier");
  expect(roleOf(ORDERS, ">")).toBe("ref");
  expect(roleOf(ORDERS, "{")).toBe("punctuation");
  expect(roleOf(ORDERS, "Table")).toBe("keyword");
  expect(roleOf(ORDERS, "orders")).toBe("variableName");
  expect(roleOf(ORDERS, "id")).toBe("variableName");
});

test("defaults_booleans_null_and_other_arrows", () => {
  const text = "Table t {\n  a bool [default: true, unique]\n  b text [null, default: 'x', increment]\n}\nRef: a.b <> c.d\nRef: a.c - c.e\nRef: a.d < c.f";
  expect(roleOf(text, "bool")).toBe("typeName");
  expect(roleOf(text, "text")).toBe("typeName");
  expect(roleOf(text, "default")).toBe("modifier");
  expect(roleOf(text, "unique")).toBe("modifier");
  expect(roleOf(text, "increment")).toBe("number");
  expect(roleOf(text, "true")).toBe("bool");
  expect(roleOf(text, "null")).toBe("null");
  expect(roleOf(text, "'x'")).toBe("string");
  expect(roleOf(text, "<>")).toBe("ref");
  expect(roleOf(text, "-")).toBe("ref");
  expect(roleOf(text, "<")).toBe("ref");
  expect(roleOf(text, ",")).toBe("operator");
  expect(roleOf(text, ":")).toBe("operator");
  expect(roleOf(text, ".")).toBe("operator");
  expect(roleOf(text, "[")).toBe("punctuation");
});

test("enum_values_and_index_columns_are_not_types", () => {
  const text = "Enum status {\n  open closed\n}\nTable t {\n  a int\n  indexes {\n    a b\n  }\n}";
  expect(roles(text).filter(([, c]) => c === "typeName").map(([t]) => t)).toEqual(["int"]);
});

test("note_key_is_a_function_and_comments_stay_comments", () => {
  const text = "Table t {\n  a int [note: 'n'] // why\n}";
  expect(roleOf(text, "note")).toBe("function");
  expect(roleOf(text, "// why")).toBe("comment");
});
