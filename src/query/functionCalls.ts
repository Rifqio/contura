// lang-sql gives a function call the same node as any other name, so "a name followed by `(`"
// is coloured here instead (DESIGN.md 3.6, the function role).
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

const fnMark = Decoration.mark({ class: "cm-fn" });

/** Nodes whose text is never a function name: types such as `varchar(`, strings, comments, literals. */
const NOT_A_NAME = /^(Type|String|QuotedIdentifier|LineComment|BlockComment|Bytes|Bits|Number|Bool|Null)$/;

/**
 * Keywords that come before `(` without being a call. lang-sql's keyword lists also hold
 * count, sum, max, left and other functions, so its Keyword node cannot decide this.
 */
const KEYWORDS = new Set(
  (
    "select from where and or not in exists any all some values as on using over filter within " +
    "when then else case join into table key unique check references primary foreign partition by " +
    "returns return lateral union intersect except with recursive set row rows range groups " +
    "default constraint index view distinct having limit offset order group window"
  ).split(" "),
);

/**
 * A table named before its column list, as in `INSERT INTO public.orders (id)` or
 * `CREATE INDEX i ON orders (id)`, is not a call. A plain ON is not: `JOIN t ON lower(a.x)`.
 */
const BEFORE_A_TABLE = /(\b(into|table|references|view)|\bindex\s+\w+\s+on)\s+(\w+\.)?$/i;

const matcher = new MatchDecorator({
  regexp: /\b[A-Za-z_][\w$]*(?=\s*\()/g,
  decorate(add, from, to, match, view) {
    if (KEYWORDS.has(match[0].toLowerCase())) return;
    const node = syntaxTree(view.state).resolveInner(from, 1);
    if (NOT_A_NAME.test(node.name)) return;
    const line = view.state.doc.lineAt(from);
    if (BEFORE_A_TABLE.test(view.state.doc.sliceString(Math.max(line.from, from - 120), from))) return;
    add(from, to, fnMark);
  },
});

export const functionCallMarks: Extension = ViewPlugin.fromClass(
  class {
    marks: DecorationSet;
    constructor(view: EditorView) {
      this.marks = matcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      // The syntax tree can grow without a text change, so a parse step redraws too.
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.marks = matcher.createDeco(u.view);
    }
  },
  { decorations: (p) => p.marks },
);
