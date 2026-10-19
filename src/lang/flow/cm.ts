// The .flow editor language: highlighting, folding of groups, and completion through the language worker.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { foldService, HighlightStyle, StreamLanguage, type StringStream, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { dbmlHighlight } from "../../schema/dbmlLanguage";
import type { LangClient } from "../client";
import type { FlowCompletion, FlowCompletionResult } from "./complete";

type State = {
  /** The first statement has been read (it may be the diagram line). */
  header: boolean;
  /** The diagram kind comes next, then the title. */
  kindNext: boolean;
  title: boolean;
  /** Inside `[ ]`, and after a key's `:` there. */
  bracket: boolean;
  value: boolean;
  /** After a link's `:`, the label runs to the end of the line. */
  label: boolean;
  /** Nothing read yet on this line (step 12: the words a statement starts with, a timeline date). */
  first: boolean;
};

/** The words step 12 kinds start a statement with. */
const LEADING = /^(participant|actor|activate|deactivate|loop|alt|opt|par|critical|class|interface|enum|root|section|milestone)(?=\s)|^note(?=\s*:)/;

const isWs = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** Reads a quoted string with `\` escapes, to its closing quote or the line end. */
function quoted(stream: StringStream) {
  stream.next();
  while (!stream.eol()) {
    const c = stream.next();
    if (c === "\\") stream.next();
    else if (c === '"') return;
  }
}

/** Reads up to a `//` comment or the line end, leaving trailing white space out. */
function toCommentOrEnd(stream: StringStream, stop?: (c: string) => boolean) {
  const s = stream.string;
  let p = stream.pos;
  while (p < s.length && !(s[p] === "/" && s[p + 1] === "/") && !stop?.(s[p])) p++;
  while (p > stream.pos && isWs(s[p - 1])) p--;
  stream.pos = Math.max(p, stream.pos + 1);
}

/** Where an unquoted name stops: the characters the writer's quoting rule reserves (as the parser reads them). */
function stopsName(s: string, j: number): boolean {
  const c = s[j];
  if ("[]{}:><\"\\".includes(c)) return true;
  if (c === "/") return s[j + 1] === "/";
  if (c === "-") return s[j + 1] === "-" || s[j + 1] === ">" || ((j === 0 || isWs(s[j - 1])) && (j + 1 >= s.length || isWs(s[j + 1])));
  if (c === ".") return s[j + 1] === "." && s[j + 2] === ">";
  return false;
}

export const flowLanguage = StreamLanguage.define<State>({
  name: "flow",
  startState: () => ({ header: false, kindNext: false, title: false, bracket: false, value: false, label: false, first: true }),
  copyState: (s) => ({ ...s }),
  languageData: { commentTokens: { line: "//" } },
  token(stream, st) {
    if (stream.sol()) {
      st.kindNext = false;
      st.title = false;
      st.bracket = false;
      st.value = false;
      st.label = false;
      st.first = true;
    }
    if (stream.eatSpace()) return null;
    const first = st.first;
    st.first = false;
    if (first && st.header && stream.match(LEADING)) return "keyword";
    // A timeline date, and a period's "to" and second date.
    if (first && st.header && stream.match(/^\d{4}(-\d{2}){0,2}(?=[\s:])/)) return "number";
    if (stream.match(/^to(?=\s+\d{4})/)) return "keyword";
    if (/^\d{4}(-\d{2}){0,2}(?=\s*:)/.test(stream.string.slice(stream.pos)) && stream.match(/^\d{4}(-\d{2}){0,2}/)) return "number";
    if (stream.match("[*]")) return "atom";
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (st.kindNext) {
      st.kindNext = false;
      st.title = true;
      if (stream.match(/^[^\s"/]+/)) return "typeName";
    }
    if (st.title) {
      if (stream.peek() === '"') quoted(stream);
      else toCommentOrEnd(stream);
      return "string";
    }
    if (!st.header) {
      st.header = true;
      if (stream.match(/^diagram(?=\s|$)/)) {
        st.kindNext = true;
        return "keyword";
      }
    }
    const ch = stream.peek() ?? "";
    if (ch === '"') {
      quoted(stream);
      return st.bracket || st.label ? "string" : "variableName";
    }
    if (st.label) {
      toCommentOrEnd(stream);
      return "string";
    }
    if (st.bracket) {
      if (ch === "]" || ch === ",") {
        stream.next();
        st.value = false;
        if (ch === "]") st.bracket = false;
        return "punctuation";
      }
      if (ch === ":") {
        stream.next();
        st.value = true;
        return "operator";
      }
      if (st.value) {
        toCommentOrEnd(stream, (c) => c === "," || c === "]");
        return "string";
      }
      toCommentOrEnd(stream, (c) => c === "," || c === "]" || c === ":");
      return /^\s*:/.test(stream.string.slice(stream.pos)) ? "propertyName" : "typeName";
    }
    if (ch === "[") {
      stream.next();
      st.bracket = true;
      st.value = false;
      return "punctuation";
    }
    if (ch === "{" || ch === "}") {
      stream.next();
      return "punctuation";
    }
    if (ch === ":") {
      stream.next();
      st.label = true;
      return "operator";
    }
    if (stream.match(/^(<\|--|[1*]--[1*](?=\s)|\*--(?=\s)|-->|--(?=\s)|->|\.\.>|<>|>)/)) return "variableName.special";
    const s = stream.string;
    if (ch === "-" && stopsName(s, stream.pos)) {
      stream.next();
      return "variableName.special";
    }
    let p = stream.pos;
    while (p < s.length && !stopsName(s, p)) p++;
    while (p > stream.pos && isWs(s[p - 1])) p--;
    if (p === stream.pos) {
      stream.next();
      return null;
    }
    stream.pos = p;
    return "variableName";
  },
});

/** Attribute keys, coloured as setting keys are in DBML. */
const flowStyle = HighlightStyle.define([{ tag: tags.propertyName, color: "var(--c-syn-function)" }]);

/** The braces of a line outside quotes and comments. */
function braces(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) if (line[i] === "\\") i++;
    } else if (c === "/" && line[i + 1] === "/") {
      break;
    } else if (c === "{" || c === "}") {
      out += c;
    }
  }
  return out;
}

/** Lines looked at for a group's `}`; past this a group is left unfoldable rather than slow. */
const FOLD_SCAN_LINES = 50_000;

/** A group folds from the end of its `{` line to its `}`. */
const flowFolding = foldService.of((state, lineStart, lineEnd) => {
  const first = state.doc.lineAt(lineStart);
  const own = braces(first.text);
  if (!own.endsWith("{")) return null;
  let depth = 0;
  for (const c of own) depth += c === "{" ? 1 : -1;
  if (depth <= 0) return null;
  const last = Math.min(state.doc.lines, first.number + FOLD_SCAN_LINES);
  for (let n = first.number + 1; n <= last; n++) {
    const line = state.doc.line(n);
    const b = braces(line.text);
    for (let k = 0; k < b.length; k++) {
      depth += b[k] === "{" ? 1 : -1;
      if (depth === 0) {
        // The `}` itself: the k-th brace of the line, found the same way.
        let seen = -1;
        for (let i = 0; i < line.text.length; i++) {
          const c = line.text[i];
          if (c === '"') {
            for (i++; i < line.text.length && line.text[i] !== '"'; i++) if (line.text[i] === "\\") i++;
          } else if (c === "{" || c === "}") {
            seen++;
            if (seen === k) return { from: lineEnd, to: line.from + i };
          }
        }
        return null;
      }
    }
  }
  return null;
});

/** Highlighting and folding for .flow, without completion. */
export function flowLanguageSupport(): Extension[] {
  return [flowLanguage, flowFolding, dbmlHighlight, syntaxHighlighting(flowStyle)];
}

const TYPE: Record<FlowCompletion["kind"], string> = {
  kind: "type",
  attr: "property",
  node: "variable",
  icon: "constant",
  keyword: "keyword",
};

/** The worker's items as CodeMirror options, in the worker's order (it has ranked them, so no second filter). */
export function toCmCompletions(r: FlowCompletionResult): (CompletionResult & { filter: false }) | null {
  if (r.items.length === 0) return null;
  const options: Completion[] = r.items.map((i) => ({ label: i.label, apply: i.apply, type: TYPE[i.kind] }));
  return { from: r.from, options, filter: false };
}

/** The .flow editor language with completion answered by the language worker for document `docId`. */
export function flowLanguageWith(client: LangClient, docId: string): Extension[] {
  const source = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    try {
      const text = ctx.state.doc.toString();
      let r = await client.completeFlow(docId, text, ctx.pos);
      // A waiting parse made it stale; the worker has parsed it now, so the second answer is current.
      if (r.stale) r = await client.completeFlow(docId, text, ctx.pos);
      if (r.stale) return null;
      // Names are offered while a name is typed or on request, not on a bare space.
      if (!ctx.explicit && r.from === ctx.pos && r.items[0]?.kind === "node") return null;
      return toCmCompletions(r);
    } catch {
      // The engine restarted; the next keystroke asks again.
      return null;
    }
  };
  return [...flowLanguageSupport(), flowLanguage.data.of({ autocomplete: source })];
}
