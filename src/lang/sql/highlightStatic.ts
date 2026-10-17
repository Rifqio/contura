import { sql, MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import { highlightTree } from "@lezer/highlight";
import { StyleModule } from "style-mod";
import type { DialectKind } from "../../api/types";
import { dbmlStyle } from "../../schema/dbmlLanguage";

const DIALECTS = {
  mysql: MySQL,
  postgres: PostgreSQL,
  sqlite: SQLite,
} as const;

export interface Span {
  text: string;
  cls: string | null;
}

let mounted = false;
function mountStyle() {
  if (mounted || typeof document === "undefined" || !dbmlStyle.module) return;
  StyleModule.mount(document, dbmlStyle.module);
  mounted = true;
}

/** Lines of spans, coloured by the editor's own syntax roles; the text is the input, unchanged. */
export function highlightSql(text: string, dialect: DialectKind): Span[][] {
  mountStyle();
  const tree = sql({ dialect: DIALECTS[dialect] }).language.parser.parse(text);
  const lines: Span[][] = [[]];
  const push = (chunk: string, cls: string | null) => {
    chunk.split("\n").forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls });
    });
  };
  let at = 0;
  highlightTree(tree, dbmlStyle, (from, to, cls) => {
    if (from > at) push(text.slice(at, from), null);
    push(text.slice(from, to), cls);
    at = to;
  });
  if (at < text.length) push(text.slice(at), null);
  return lines;
}
