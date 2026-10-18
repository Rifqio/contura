// Light Mermaid flowchart highlighting for the import dialog: keywords, arrows, strings and comments.
import { StreamLanguage } from "@codemirror/language";

const KEYWORDS = /^(flowchart|graph|subgraph|end|direction|style|classDef|class|linkStyle|click|accTitle|accDescr|TD|TB|LR|RL|BT)\b/;
/** Links, longest first, and `&` between nodes. */
const ARROW = /^(<?[-=.]{2,}[->ox]?|~{3,}|&)/;

export const mermaidLang = StreamLanguage.define<Record<string, never>>({
  name: "mermaid",
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("%%")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^"[^"]*"?/)) return "string";
    if (stream.match(/^\|[^|]*\|?/)) return "string";
    if (stream.match(ARROW)) return "operator";
    if (stream.match(/^:::[\w-]+/)) return "comment";
    if (stream.match(KEYWORDS)) return "keyword";
    // A node's text inside its shape brackets reads as a string.
    if (stream.match(/^(\(\(\(|\(\[|\(\(|\[\[|\[\(|\[\/|\[\\|\{\{|[[({>])/)) {
      stream.match(/^[^\])}/\\]*/);
      return "string";
    }
    if (stream.match(/^[\])}/\\]+/)) return "punctuation";
    if (stream.match(/^[\p{L}\p{N}_]+/u)) return "variableName";
    stream.next();
    return null;
  },
});
