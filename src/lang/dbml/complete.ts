import type { DialectKind, SchemaModel } from "../../api/types";
import { DIALECT_TYPES } from "../dialectTypes";
import { DBML_TEMPLATES } from "./templates";

export type Completion = {
  label: string;
  kind: "table" | "column" | "type" | "keyword" | "template";
  detail?: string;
  apply: string;
};

/** Items to offer at `pos`; `from` is where the word being completed starts. */
export type CompletionResult = { from: number; items: Completion[] };

const SETTINGS = ["pk", "increment", "not null", "null", "unique", "default: ", "note: ", "ref: > "];

/** Brace depth at `pos`, ignoring quoted text and `//` comments. */
function depthAt(text: string, pos: number): number {
  let depth = 0;
  for (let i = 0; i < pos; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < pos && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const close = c;
      i += 1;
      while (i < pos && text[i] !== close) i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** Inside an unclosed `[` on the current line. */
function inBrackets(line: string): boolean {
  return line.lastIndexOf("[") > line.lastIndexOf("]");
}

function filter(items: Completion[], prefix: string): Completion[] {
  const p = prefix.toLowerCase();
  return items.filter((i) => i.label.toLowerCase().startsWith(p));
}

export function completeDbml(
  text: string,
  pos: number,
  model: SchemaModel | null,
  dialect: DialectKind,
): CompletionResult {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const line = text.slice(lineStart, pos);
  const word = /[\w.]*$/.exec(line)?.[0] ?? "";
  const from = pos - word.length;
  const none = { from, items: [] };

  if (inBrackets(line)) {
    const prefix = /[\w ]*$/.exec(line.slice(line.lastIndexOf("[") + 1).split(",").pop() ?? "")?.[0].trimStart() ?? "";
    const items = SETTINGS.map((s) => ({ label: s.trim(), kind: "keyword" as const, apply: s }));
    return { from: pos - prefix.length, items: filter(items, prefix) };
  }

  // After a relation operator in a Ref: `table.column` for every column.
  if (/^\s*Ref\b.*(<>|[<>-])\s*[\w.]*$/i.test(line)) {
    const items: Completion[] = (model?.tables ?? []).flatMap((t) =>
      t.columns.map((c) => ({
        label: `${t.name}.${c.name}`,
        kind: "column" as const,
        detail: c.typeName,
        apply: `${t.name}.${c.name}`,
      })),
    );
    return { from, items: filter(items, word) };
  }

  const depth = depthAt(text, pos);
  if (depth === 0) {
    if (!/^\s*\w*$/.test(line)) return none;
    const items = DBML_TEMPLATES.map((t) => ({ label: t.name, kind: "template" as const, apply: t.body }));
    return { from, items: filter(items, word) };
  }

  // A column line: `<name> <type…`.
  if (/^\s*("[^"]*"|\w+)\s+[\w.]*$/.test(line)) {
    const items = DIALECT_TYPES[dialect].map((t) => ({ label: t, kind: "type" as const, apply: t }));
    return { from, items: filter(items, word) };
  }
  return none;
}
