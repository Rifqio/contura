// DBML highlighting: a StreamLanguage port of the @dbml/parse Monarch rules.
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const KEYWORDS = /^(table|ref|enum|note|indexes|as|project|tablegroup|tablepartial|records)\b/i;
const SETTINGS = /^(pk|increment|not|null|unique|default|note|ref|delete|update|cascade|restrict|set|no|action|name|type|headercolor|primary|key)\b/i;

type State = { inBlockComment: boolean; inSettings: boolean };

export const dbmlLanguage = StreamLanguage.define<State>({
  startState: () => ({ inBlockComment: false, inSettings: false }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.skipTo("*/")) {
        stream.next();
        stream.next();
        state.inBlockComment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }
    const ch = stream.peek();
    if (ch === "'" || ch === "`") {
      stream.next();
      let escaped = false;
      for (let c = stream.next(); c != null; c = stream.next()) {
        if (c === ch && !escaped) break;
        escaped = c === "\\" && !escaped;
      }
      return "string";
    }
    if (ch === '"') {
      stream.next();
      while (!stream.eol() && stream.next() !== '"');
      return "variableName";
    }
    if (ch === "[") state.inSettings = true;
    if (ch === "]") state.inSettings = false;
    if (stream.match(/^-?\d+(\.\d+)?/)) return "number";
    if (state.inSettings && stream.match(SETTINGS)) return "keyword";
    if (stream.match(KEYWORDS)) return "keyword";
    if (stream.match(/^[A-Za-z_][\w]*/)) return "variableName";
    stream.next();
    return null;
  },
});

/** Syntax colours from the Theme tokens (DESIGN.md). */
export const dbmlHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "var(--color-syntax-keyword)" },
    { tag: tags.string, color: "var(--color-syntax-string)" },
    { tag: tags.number, color: "var(--color-syntax-number)" },
    { tag: tags.comment, color: "var(--color-syntax-comment)", fontStyle: "italic" },
    { tag: tags.variableName, color: "var(--color-syntax-name)" },
  ]),
);
