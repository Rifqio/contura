// DBML highlighting: a StreamLanguage port of the @dbml/parse Monarch rules.
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const KEYWORDS = /^(table|ref|enum|note|indexes|as|project|tablegroup|tablepartial|records)\b/i;
/** Column settings that change what the column holds: the operator role (DESIGN.md 3.6). */
const MODIFIERS = /^(pk|primary\s+key|not\s+null|unique|default)\b/i;
const SETTINGS = /^(note|ref|delete|update|cascade|restrict|set|no|action|name|type|headercolor)\b/i;
/** A ref arrow, but not the minus of a negative number. */
const ARROW = /^(<>|[<>]|-(?!\d))/;

type State = {
  inBlockComment: boolean;
  inSettings: boolean;
  /** The keyword before the next `{`, and the open blocks named that way. */
  pending: string;
  blocks: string[];
  /** Words so far on this line outside `[ ]`: in a Table the second one is the column type. */
  words: number;
};

export const dbmlLanguage = StreamLanguage.define<State>({
  startState: () => ({ inBlockComment: false, inSettings: false, pending: "", blocks: [], words: 0 }),
  copyState: (s) => ({ ...s, blocks: [...s.blocks] }),
  token(stream, state) {
    if (stream.sol()) state.words = 0;
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
    if (ch === "'") {
      stream.next();
      let escaped = false;
      for (let c = stream.next(); c != null; c = stream.next()) {
        if (c === ch && !escaped) break;
        escaped = c === "\\" && !escaped;
      }
      return "string";
    }
    // A backtick expression, such as `now()`, is code the database runs.
    if (ch === "`") {
      stream.next();
      while (!stream.eol() && stream.next() !== "`");
      return "variableName.function";
    }
    if (ch === '"') {
      stream.next();
      while (!stream.eol() && stream.next() !== '"');
      if (!state.inSettings) state.words++;
      return "variableName";
    }
    if (ch === "{") {
      stream.next();
      state.blocks.push(state.pending);
      state.pending = "";
      return "punctuation";
    }
    if (ch === "}") {
      stream.next();
      state.blocks.pop();
      return "punctuation";
    }
    if (ch === "[" || ch === "]") {
      stream.next();
      state.inSettings = ch === "[";
      return "punctuation";
    }
    if (ch === "," || ch === ":" || ch === ".") {
      stream.next();
      return "operator";
    }
    if (ch === "(" || ch === ")") {
      stream.next();
      return "paren";
    }
    if (stream.match(/^-?\d+(\.\d+)?/)) return "number";
    if (stream.match(ARROW)) return "variableName.special";
    if (stream.match(/^(true|false)\b/i)) return "bool";
    if (stream.match(/^null\b/i)) return "null";
    // `note:` is a setting key, coloured like a function call.
    if (stream.match(/^note(?=\s*:)/i)) return "variableName.function";
    if (state.inSettings) {
      if (stream.match(/^increment\b/i)) return "number";
      if (stream.match(MODIFIERS)) return "modifier";
      if (stream.match(SETTINGS)) return "keyword";
    }
    const kw = stream.match(KEYWORDS) as RegExpMatchArray | null;
    if (kw) {
      state.pending = kw[0].toLowerCase();
      state.words++;
      return "keyword";
    }
    if (stream.match(/^[A-Za-z_][\w]*/)) {
      if (state.inSettings) return "variableName";
      state.words++;
      const block = state.blocks[state.blocks.length - 1];
      const inTable = block === "table" || block === "tablepartial";
      return inTable && state.words === 2 ? "typeName" : "variableName";
    }
    stream.next();
    return null;
  },
});

/** Syntax colours from the DESIGN.md roles (3.6), shared by the SQL and DBML editors. */
export const dbmlStyle = HighlightStyle.define([
    { tag: tags.keyword, color: "var(--c-syn-keyword)", fontWeight: "var(--syn-kw-weight)" },
    { tag: tags.function(tags.variableName), color: "var(--c-syn-function)" },
    { tag: tags.string, color: "var(--c-syn-string)" },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--c-syn-number)" },
    { tag: tags.typeName, color: "var(--c-syn-type)", fontStyle: "var(--syn-type-style)" },
    { tag: [tags.variableName, tags.name], color: "var(--c-syn-identifier)" },
    { tag: [tags.special(tags.variableName), tags.special(tags.name)], color: "var(--c-syn-ref)" },
    { tag: [tags.operator, tags.modifier], color: "var(--c-syn-operator)" },
    { tag: [tags.punctuation, tags.bracket, tags.separator], color: "var(--c-syn-punctuation)" },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--c-syn-comment)", fontStyle: "italic" },
    { tag: tags.invalid, color: "var(--c-syn-error)" },
  ]);

export const dbmlHighlight = syntaxHighlighting(dbmlStyle);
