import {
  autocompletion,
  type Completion as CmCompletion,
  type CompletionContext,
  hasNextSnippetField,
  snippet,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { type Diagnostic as CmDiagnostic, lintGutter, openLintPanel, setDiagnostics } from "@codemirror/lint";
import { closeSearchPanel, searchPanelOpen } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, Prec, RangeSet, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutterLineClass,
  highlightActiveLineGutter,
  keymap,
  lineNumberMarkers,
  lineNumbers,
  showTooltip,
  type Tooltip,
  WidgetType,
} from "@codemirror/view";
import { type MutableRefObject, useEffect, useRef } from "react";
import type { DialectKind } from "../api/types";
import { type EditorCommands, editorCommandKeymap } from "../commands/editorKeymap";
import type { CommandId } from "../commands/registry";
import { hintFor } from "../commands/keymap";
import { kbdElement } from "../components/Kbd";
import { useCommandKeys, useKeymap } from "../commands/useCommandKeys";
import { iconElement } from "../components/Icon";
import type { LangClient } from "../lang/client";
import { insertionLine } from "../lang/insertionLine";
import { editorTheme } from "../lang/editorTheme";
import { editingBasics } from "../lang/editingBasics";
import type { Diagnostic, TextEdit } from "../lang/protocol";
import { findTable } from "../lang/sql/analyze";
import type { SqlCompletion } from "../lang/sql/complete";
import type { SchemaState } from "../lang/sql/inspect";
import type { ParameterHints } from "../lang/sql/refactor";
import { insertColumnsTemplate, SQL_TEMPLATES, type SqlTemplate } from "../lang/sql/templates";
// The same Theme-token syntax colours as the DBML editor.
import { dbmlHighlight as themeHighlight } from "../schema/dbmlLanguage";
import { functionCallMarks } from "./functionCalls";
import { type Stmt, splitStatements, statementAt } from "./statements";

const SQL_DIALECT = { mysql: MySQL, postgres: PostgreSQL, sqlite: SQLite } as const;

/** An error where you are typing waits this long, so you are not flagged mid-word. */
const TYPING_ERROR_DELAY_MS = 1500;

type Range = { from: number; to: number };

/** What the query tab asks of the editor. */
export interface SqlEditorApi {
  /** The selection when there is one, else the statement being typed. */
  runTarget(): Stmt | null;
  /** The editor's text now, which the tab's state may not have caught up with. */
  text(): string;
  select(from: number, to: number): void;
  insert(text: string): void;
  replaceAll(text: string): void;
  /** Replaces `from` to `to` with `text`, leaves you typing after it, and scrolls it into view. */
  replaceRange(from: number, to: number, text: string): void;
  focus(): void;
  /** Bands every line the ranges touch in --c-accent-subtle (the query diagram's selected card); empty clears. */
  band(ranges: Range[]): void;
}

/** The language service for this editor: which document, and which schema applies. */
export interface SqlLang {
  client: LangClient;
  docId: string;
  schemaKey: string | null;
  schemaState: SchemaState;
  /** Unseen SQL in front of the text, such as `SELECT * FROM orders WHERE ` for a grid filter. */
  prefix?: string;
}

interface Props {
  value: string;
  dialect: DialectKind;
  onChange(text: string): void;
  onRun(kind: "current" | "all"): void;
  onFormat(): void;
  onSave(): void;
  /** True when it handled Esc, such as cancelling a running query. */
  onEscape(): boolean;
  editorRef: MutableRefObject<SqlEditorApi | null>;
  markRunning?: Range | null;
  markError?: Range | null;
  /** A statement that cannot run here: a lock in the gutter on its first line and the message under it. */
  blocked?: Blocked | null;
  /** A statement that writes on a Production Connection: a band, a gutter bar and a note under it. */
  writeHazard?: WriteHazard | null;
  /** The line and column being typed at, for the status line. */
  onPosition?(line: number, column: number): void;
  /** Completion, checks and refactors; without it the editor is plain. */
  lang?: SqlLang;
  /** Go to definition on a table: show it in the Database Tree. */
  onShowInTree?(table: { schema: string | null; name: string }): void;
  /** One line, no gutters, Enter runs: the grid filter. */
  oneLine?: boolean;
  /** Offer this editor's commands to the Command Palette: only a query tab's own editor does (S1). */
  paletteCommands?: boolean;
  /** Ask AI about the selection, or the current statement: Ctrl+I, and the Ask button on a selection. */
  onAsk?(ctx: AskSelection): void;
  /** Show the Ask button at the end of a selection; Ctrl+I works either way. */
  askButton?: boolean;
  /** The command keys and how to run app commands; the app's keymap when absent. */
  commands?: EditorCommands;
}

/** What Ask AI is about: the SQL, where it sits in the editor and its first and last line. */
export interface AskSelection {
  sql: string;
  from: number;
  to: number;
  lines: [number, number];
}

const setMarks = StateEffect.define<{ running: Range | null; error: Range | null }>();
const runMark = Decoration.mark({ class: "cm-run-mark" });
const errorMark = Decoration.mark({ class: "cm-error-mark" });

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const len = tr.state.doc.length;
      const clip = (r: Range) => ({ from: Math.min(r.from, len), to: Math.min(r.to, len) });
      const ranges = [];
      if (e.value.running) {
        const r = clip(e.value.running);
        if (r.from < r.to) ranges.push(runMark.range(r.from, r.to));
      }
      if (e.value.error) {
        const r = clip(e.value.error);
        if (r.from < r.to) ranges.push(errorMark.range(r.from, r.to));
      }
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const setBand = StateEffect.define<Range[]>();
const bandLine = Decoration.line({ class: "cm-diagram-band" });

/** The lines a query diagram card was read from; they follow edits until the next band. */
const bandField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(band, tr) {
    let next = band.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setBand)) continue;
      const doc = tr.state.doc;
      const starts = new Set<number>();
      for (const r of e.value) {
        const from = Math.max(0, Math.min(r.from, doc.length));
        const to = Math.max(from, Math.min(r.to, doc.length));
        for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) starts.add(doc.line(n).from);
      }
      next = Decoration.set([...starts].sort((a, b) => a - b).map((at) => bandLine.range(at)));
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const currentStmtLine = Decoration.line({ class: "cm-current-stmt" });
const currentStmtGutter = new (class extends GutterMarker {
  elementClass = "cm-current-stmt-gutter";
})();

/**
 * The statement where you are typing: a band on each of its lines and a 2 px accent bar
 * in the gutter beside them. `dialect` is read when the text or the selection changes.
 */
function currentStatement(dialect: () => DialectKind) {
  /** The first character of each line the statement covers. */
  const linesOf = (state: EditorState): number[] => {
    const doc = state.doc;
    const st = statementAt(splitStatements(doc.toString(), dialect()), state.selection.main.head);
    if (!st || st.from >= st.to) return [];
    const lines: number[] = [];
    for (let n = doc.lineAt(st.from).number; n <= doc.lineAt(st.to).number; n++) lines.push(doc.line(n).from);
    return lines;
  };
  return StateField.define<number[]>({
    create: linesOf,
    update: (lines, tr) => (tr.docChanged || tr.selection ? linesOf(tr.state) : lines),
    compare: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    provide: (f) => [
      EditorView.decorations.compute([f], (state) =>
        Decoration.set(state.field(f).map((at) => currentStmtLine.range(at))),
      ),
      gutterLineClass.compute([f], (state) => RangeSet.of(state.field(f).map((at) => currentStmtGutter.range(at)))),
    ],
  });
}

/** A statement that cannot run, such as a write on a Read-only Connection; `detail` follows the message. */
export type Blocked = { from: number; to: number; message: string; detail?: string };

const setBlocked = StateEffect.define<Blocked | null>();

class BlockedNote extends WidgetType {
  constructor(readonly message: string, readonly detail: string | undefined) {
    super();
  }
  eq(other: BlockedNote) {
    return other.message === this.message && other.detail === this.detail;
  }
  toDOM() {
    const dom = document.createElement("div");
    dom.className = "cm-blocked-note";
    dom.setAttribute("role", "status");
    const note = document.createElement("span");
    note.className = "cm-blocked-text";
    note.append(this.message);
    dom.append(iconElement("lock", 14));
    if (this.detail) {
      const d = document.createElement("span");
      d.className = "muted";
      d.textContent = this.detail;
      note.append(d);
    }
    dom.append(note);
    return dom;
  }
}

/** The line number with a lock in front, on the blocked statement's first line. */
class LockMarker extends GutterMarker {
  constructor(readonly line: number) {
    super();
  }
  eq(other: LockMarker) {
    return other.line === this.line;
  }
  toDOM() {
    const dom = document.createElement("span");
    dom.className = "cm-blocked-lock";
    dom.append(iconElement("lock"), String(this.line));
    return dom;
  }
}

const blockedField = StateField.define<Blocked | null>({
  create: () => null,
  update(v, tr) {
    let next = v && tr.docChanged ? { ...v, from: tr.changes.mapPos(v.from), to: tr.changes.mapPos(v.to, 1) } : v;
    for (const e of tr.effects) if (e.is(setBlocked)) next = e.value;
    return next;
  },
  provide: (f) => [
    EditorView.decorations.compute([f], (state) => {
      const v = state.field(f);
      if (!v) return Decoration.none;
      const end = state.doc.lineAt(Math.min(v.to, state.doc.length)).to;
      return Decoration.set([
        Decoration.widget({ widget: new BlockedNote(v.message, v.detail), block: true, side: 1 }).range(end),
      ]);
    }),
    lineNumberMarkers.compute([f], (state) => {
      const v = state.field(f);
      if (!v) return RangeSet.empty;
      const line = state.doc.lineAt(Math.min(v.from, state.doc.length));
      return RangeSet.of([new LockMarker(line.number).range(line.from)]);
    }),
  ],
});

/** A statement that writes on a Production Connection: it still runs, after the confirm dialog. */
export type WriteHazard = { from: number; to: number; note: string };

const setWriteHazard = StateEffect.define<WriteHazard | null>();
const prodWriteLine = Decoration.line({ class: "cm-prod-write" });
const prodWriteGutter = new (class extends GutterMarker {
  elementClass = "cm-prod-write-bar";
})();

class ProdWriteNote extends WidgetType {
  constructor(readonly note: string) {
    super();
  }
  eq(other: ProdWriteNote) {
    return other.note === this.note;
  }
  toDOM() {
    const dom = document.createElement("div");
    dom.className = "cm-prod-write-note";
    dom.append(iconElement("warning", 14), this.note);
    return dom;
  }
}

/** The Production band on each line of a writing statement, a 3 px bar beside them, and a note under the last. */
const writeHazardField = StateField.define<WriteHazard | null>({
  create: () => null,
  update(v, tr) {
    let next = v && tr.docChanged ? { ...v, from: tr.changes.mapPos(v.from), to: tr.changes.mapPos(v.to, 1) } : v;
    for (const e of tr.effects) if (e.is(setWriteHazard)) next = e.value;
    return next;
  },
  provide: (f) => {
    const lines = (state: EditorState): number[] => {
      const v = state.field(f);
      if (!v) return [];
      const doc = state.doc;
      const out: number[] = [];
      const last = doc.lineAt(Math.min(v.to, doc.length)).number;
      for (let n = doc.lineAt(Math.min(v.from, doc.length)).number; n <= last; n++) out.push(doc.line(n).from);
      return out;
    };
    return [
      EditorView.decorations.compute([f], (state) => {
        const v = state.field(f);
        if (!v) return Decoration.none;
        const end = state.doc.lineAt(Math.min(v.to, state.doc.length)).to;
        return Decoration.set(
          [
            ...lines(state).map((at) => prodWriteLine.range(at)),
            Decoration.widget({ widget: new ProdWriteNote(v.note), block: true, side: 1 }).range(end),
          ],
          true,
        );
      }),
      gutterLineClass.compute([f], (state) => RangeSet.of(lines(state).map((at) => prodWriteGutter.range(at)))),
    ];
  },
});

/** A short message where you are typing, such as why a name cannot be renamed. */
const setNotice = StateEffect.define<{ pos: number; text: string } | null>();
const noticeField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tip, tr) {
    for (const e of tr.effects)
      if (e.is(setNotice)) {
        const v = e.value;
        return v
          ? {
              pos: v.pos,
              above: true,
              create: () => {
                const dom = document.createElement("div");
                dom.className = "cm-sql-notice";
                dom.setAttribute("role", "status");
                dom.textContent = v.text;
                return { dom };
              },
            }
          : null;
      }
    return tr.docChanged || tr.selection ? null : tip;
  },
  provide: (f) => showTooltip.from(f),
});

/** The parameters of the function being typed. */
const setParams = StateEffect.define<{ pos: number; hints: ParameterHints } | null>();
const paramsField = StateField.define<{ pos: number; hints: ParameterHints } | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setParams)) return e.value;
    return v && tr.docChanged ? { ...v, pos: tr.changes.mapPos(v.pos) } : v;
  },
  provide: (f) =>
    showTooltip.from(f, (v): Tooltip | null =>
      v
        ? {
            pos: v.pos,
            above: true,
            create: () => {
              const dom = document.createElement("div");
              dom.className = "cm-sql-params";
              dom.setAttribute("role", "status");
              const h = v.hints;
              const params = h.signatures[h.active] ?? [];
              dom.append(`${h.name}(`);
              params.forEach((p, i) => {
                if (i > 0) dom.append(", ");
                const span = document.createElement("span");
                if (i === Math.min(h.activeParam, params.length - 1) || (p.startsWith("...") && h.activeParam >= i))
                  span.className = "cm-sql-param-active";
                span.textContent = p;
                dom.append(span);
              });
              dom.append(")");
              if (h.signatures.length > 1) {
                const n = document.createElement("span");
                n.className = "cm-sql-params-count";
                n.textContent = ` ${h.active + 1} of ${h.signatures.length}`;
                dom.append(n);
              }
              return { dom };
            },
          }
        : null,
    ),
});

const KIND: Record<SqlCompletion["kind"], string> = {
  table: "class",
  view: "class",
  cte: "class",
  schema: "namespace",
  column: "property",
  keyword: "keyword",
  function: "function",
  alias: "variable",
  join: "text",
  template: "keyword",
};

function toCm(diagnostics: Diagnostic[], docLength: number): CmDiagnostic[] {
  return diagnostics.map((d) => ({
    from: Math.min(d.from, docLength),
    to: Math.min(Math.max(d.to, d.from), docLength),
    severity: d.severity,
    message: d.message,
    actions: d.fixes.map((f) => ({
      name: f.title,
      apply: (view: EditorView) => view.dispatch({ changes: f.edits.map((e) => ({ ...e })) }),
    })),
  }));
}

/** The editor commands the Command Palette can run in the editor on screen. */
const PALETTE_IDS: readonly CommandId[] = [
  "query.run",
  "query.runAll",
  "query.format",
  "query.save",
  "editor.ask",
  "editor.quickFix",
  "editor.rename",
  "editor.definition",
  "editor.parameterHints",
];

export default function SqlEditor({
  value,
  dialect,
  onChange,
  onRun,
  onFormat,
  onSave,
  onEscape,
  editorRef,
  markRunning,
  markError,
  blocked,
  writeHazard,
  onPosition,
  lang,
  onShowInTree,
  oneLine,
  paletteCommands = false,
  onAsk,
  askButton,
  commands,
}: Props) {
  const appKeys = useKeymap();
  const cmds = commands ?? appKeys;
  const host = useRef<HTMLDivElement>(null);
  const commandKeys = useRef(new Compartment());
  /** Runs a command id: the editor's own, else the owner's. Set once the view exists. */
  const runCommand = useRef<(id: CommandId) => boolean>(() => false);
  const viewRef = useRef<EditorView | null>(null);
  const reanalyze = useRef<(() => void) | null>(null);
  const latest = useRef({ onChange, onRun, onFormat, onSave, onEscape, dialect, onPosition, lang, onShowInTree, onAsk, askButton, cmds, askKey: hintFor(appKeys.map, "editor.ask") });
  latest.current = { onChange, onRun, onFormat, onSave, onEscape, dialect, onPosition, lang, onShowInTree, onAsk, askButton, cmds, askKey: hintFor(appKeys.map, "editor.ask") };
  // The Command Palette runs this editor's commands (S1); keys reach them through the editor's own keymap.
  useCommandKeys(
    oneLine || !paletteCommands ? {} : Object.fromEntries(PALETTE_IDS.filter((id) => id !== "editor.ask" || !!onAsk).map((id) => [id, () => void runCommand.current(id)])),
    { region: host, paletteOnly: true },
  );

  useEffect(() => {
    let diagnostics: Diagnostic[] = [];
    let extra: Diagnostic[] = [];
    let diagnosticsText = "";
    let typingTimer: ReturnType<typeof setTimeout> | null = null;
    /** Where `ins` takes its table name, while that field is being filled. */
    let insField: number | null = null;
    /** Fixes were asked for: show every diagnostic, even one that arrives later, until the next edit. */
    let fixesOpen = false;
    /** F2 put a selection on every use of a name; Enter or a run ends it. */
    let renaming = false;

    const endRename = (view: EditorView) => {
      if (!renaming) return false;
      renaming = false;
      if (view.state.selection.ranges.length < 2) return false;
      view.dispatch({ selection: { anchor: view.state.selection.main.head } });
      return true;
    };
    const run = (kind: "current" | "all") => (view: EditorView) => {
      endRename(view);
      latest.current.onRun(kind);
      return true;
    };
    /** An async answer is used only if the editor is still there and its text unchanged. */
    const current = (view: EditorView, doc: string) => viewRef.current === view && view.state.doc.toString() === doc;
    /** The request for where you are typing; `p` is the prefix length to take off offsets that come back. */
    const at = (view: EditorView) => {
      const l = latest.current.lang;
      if (!l) return null;
      const prefix = l.prefix ?? "";
      const doc = view.state.doc.toString();
      const q = { docId: l.docId, text: prefix + doc, pos: prefix.length + view.state.selection.main.head, dialect: latest.current.dialect, schemaKey: l.schemaKey };
      return { client: l.client, q, p: prefix.length, doc, head: view.state.selection.main.head };
    };
    const shiftEdits = (edits: TextEdit[], p: number) => edits.map((e) => ({ ...e, from: e.from - p, to: e.to - p }));
    const shiftDiagnostics = (ds: Diagnostic[], p: number) =>
      ds.filter((d) => d.from >= p).map((d) => ({ ...d, from: d.from - p, to: d.to - p, fixes: d.fixes.map((f) => ({ ...f, edits: shiftEdits(f.edits, p) })) }));

    /** Diagnostics now, holding back an error where you are typing unless `all`. */
    function show(view: EditorView, all: boolean) {
      if (diagnosticsText !== view.state.doc.toString()) return;
      const head = view.state.selection.main.head;
      const shown = all ? diagnostics : diagnostics.filter((d) => !(d.severity === "error" && d.from <= head && head <= d.to));
      view.dispatch(setDiagnostics(view.state, toCm([...shown, ...extra], view.state.doc.length)));
    }

    function analyze(view: EditorView) {
      const l = latest.current.lang;
      const a = at(view);
      if (!l || !a) return;
      const text = a.doc;
      l.client
        .analyzeSql({ docId: l.docId, text: a.q.text, dialect: latest.current.dialect, schemaKey: l.schemaKey, schemaState: l.schemaState })
        .then((ds) => {
          if (viewRef.current !== view || view.state.doc.toString() !== text) return;
          diagnostics = shiftDiagnostics(ds, a.p);
          diagnosticsText = text;
          show(view, fixesOpen);
          if (typingTimer) clearTimeout(typingTimer);
          typingTimer = setTimeout(() => show(view, true), TYPING_ERROR_DELAY_MS);
        })
        .catch(() => {
          // The engine restarted; the next edit checks again.
        });
    }

    // CodeMirror marks the end of a snippet with `${}`, where our templates write `$0`.
    const cmSnippet = (body: string) => snippet(body.replace(/\$0/g, "${}"));
    const expandTemplate = (view: EditorView, t: SqlTemplate, from: number, to: number) => {
      cmSnippet(t.body)(view, { label: t.abbr }, from, to);
      insField = t.onLeave?.[1] === "insertColumns" ? from + t.body.indexOf("${1:") : null;
    };

    const completionSource = async (ctx: CompletionContext) => {
      const a = at(ctx.view!);
      if (!a) return null;
      const result = await a.client.completeSql({ ...a.q, text: a.q.text.slice(0, a.p) + ctx.state.doc.toString(), pos: a.p + ctx.pos, explicit: ctx.explicit });
      const r = { ...result, from: result.from - a.p };
      if (r.from < 0) return null;
      const typed = ctx.matchBefore(/[\w$]+$/);
      const afterDot = ctx.state.sliceDoc(r.from - 1, r.from) === ".";
      if (r.items.length === 0) return null;
      // Typing a space opens the list only where a table goes.
      if (!ctx.explicit && !typed && !afterDot && !["table", "view", "cte", "join"].includes(r.items[0].kind)) return null;
      const options: CmCompletion[] = r.items.map((i) => ({
        label: i.label,
        detail: i.detail,
        info: i.info,
        type: KIND[i.kind],
        boost: i.boost,
        apply: i.template
          ? (view: EditorView, _c: CmCompletion, from: number, to: number) => expandTemplate(view, i.template!, from, to)
          : i.back
            ? (view: EditorView, _c: CmCompletion, from: number, to: number) =>
                view.dispatch({ changes: { from, to, insert: i.apply }, selection: { anchor: from + i.apply.length - i.back! } })
            : i.apply,
      }));
      return { from: r.from, options, filter: false };
    };

    /** Tab on a template's name at the start of a statement expands it. */
    const tabTemplate = (view: EditorView) => {
      const { head, empty } = view.state.selection.main;
      if (!empty) return false;
      const text = view.state.doc.toString();
      const word = /[A-Za-z_]\w*$/.exec(text.slice(0, head))?.[0];
      const t = word && SQL_TEMPLATES.find((x) => x.abbr === word.toLowerCase());
      if (!t || !word) return false;
      const start = head - word.length;
      const stmt = splitStatements(text, latest.current.dialect).find((s) => s.from <= start && start <= s.to);
      if (stmt && stmt.from !== start) return false;
      expandTemplate(view, t, start, head);
      return true;
    };

    /** Leaving `ins`'s table field fills in every column of that table. */
    const leaveInsField = (view: EditorView) => {
      if (insField === null) return false;
      const start = insField;
      insField = null;
      if (!hasNextSnippetField(view.state)) return false;
      const name = /^[\w$]+(?:\.[\w$]+)?/.exec(view.state.sliceDoc(start, Math.min(view.state.doc.length, start + 200)))?.[0];
      const head = view.state.selection.main.head;
      if (!name || head < start || head > start + name.length) return false;
      const l = latest.current.lang;
      const schema = l?.client.sqlSchemaFor(l.schemaKey) ?? null;
      const [s, n] = name.includes(".") ? name.split(".") : [null, name];
      const t = schema && findTable(schema, s, n);
      if (!t) return false;
      const end = start + name.length;
      cmSnippet(insertColumnsTemplate(t).body)(view, { label: "ins" }, end, end);
      return true;
    };

    const openFixes = (view: EditorView) => {
      fixesOpen = true;
      show(view, true);
      openLintPanel(view);
      const a = at(view);
      if (a)
        void a.client
          .refactorSql({ ...a.q, action: "expandStar" })
          .then((r) => {
            if (!r.edits || !current(view, a.doc)) return;
            const edits = shiftEdits(r.edits, a.p);
            const e = edits[0];
            extra = [
              { from: e.from, to: e.to, line: 0, column: 0, severity: "hint", message: "Expand column list", fixes: [{ title: "Expand", edits }] },
            ];
            show(view, true);
          })
          .catch(() => {});
      return true;
    };

    const rename = (view: EditorView) => {
      const a = at(view);
      if (!a) return false;
      void a.client
        .refactorSql({ ...a.q, action: "rename" })
        .then((r) => {
          if (!current(view, a.doc)) return;
          const ranges = r.ranges?.filter((x) => x.from >= a.p).map((x) => ({ from: x.from - a.p, to: x.to - a.p }));
          if (ranges?.length) {
            const main = Math.max(0, ranges.findIndex((x) => x.from <= a.head && a.head <= x.to));
            view.dispatch({ selection: EditorSelection.create(ranges.map((x) => EditorSelection.range(x.from, x.to)), main) });
            renaming = ranges.length > 1;
          } else if (r.blocked) view.dispatch({ effects: setNotice.of({ pos: a.head, text: r.blocked }) });
        })
        .catch(() => {});
      return true;
    };

    const definition = (view: EditorView) => {
      const a = at(view);
      if (!a) return false;
      void a.client
        .refactorSql({ ...a.q, action: "definition" })
        .then((r) => {
          const d = r.definition;
          if (!d || !current(view, a.doc)) return;
          if (d.kind === "range") {
            if (d.range.from >= a.p)
              view.dispatch({ selection: { anchor: d.range.from - a.p, head: d.range.to - a.p }, scrollIntoView: true });
          } else latest.current.onShowInTree?.({ schema: d.schema, name: d.name });
        })
        .catch(() => {});
      return true;
    };

    const params = (view: EditorView, open: boolean) => {
      const a = at(view);
      if (!a) return false;
      if (!open && !view.state.field(paramsField)) return false;
      void a.client
        .refactorSql({ ...a.q, action: "params" })
        .then((r) => {
          if (!current(view, a.doc)) return;
          if (!open && !view.state.field(paramsField)) return;
          view.dispatch({ effects: setParams.of(r.hints ? { pos: a.head, hints: r.hints } : null) });
        })
        .catch(() => {});
      return true;
    };

    /** The selection, else the current statement (the whole text in a one-line box), as what to ask about. */
    const askTarget = (view: EditorView): AskSelection | null => {
      const doc = view.state.doc;
      const { from, to } = view.state.selection.main;
      let range: { from: number; to: number } | null = from !== to ? { from, to } : null;
      if (!range && oneLine) range = doc.length > 0 ? { from: 0, to: doc.length } : null;
      if (!range) {
        const st = statementAt(splitStatements(doc.toString(), latest.current.dialect), from);
        range = st ? { from: st.from, to: st.to } : null;
      }
      if (!range) return null;
      const sql = doc.sliceString(range.from, range.to);
      if (sql.trim() === "") return null;
      return { sql, from: range.from, to: range.to, lines: [doc.lineAt(range.from).number, doc.lineAt(range.to).number] };
    };
    const ask = (view: EditorView) => {
      if (!latest.current.onAsk) return false;
      const target = askTarget(view);
      if (target) latest.current.onAsk(target);
      return true;
    };
    /** The small Ask button at the end of a non-empty selection. */
    const askTipView = (view: EditorView) => {
      const dom = document.createElement("div");
      dom.className = "cm-ask-tip";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ask-btn";
      b.append("Ask ");
      const askKey = latest.current.askKey;
      if (askKey) {
        b.append(kbdElement(askKey));
      }
      // Keep the selection while the button is pressed.
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => ask(view));
      dom.append(b);
      return { dom };
    };
    const askTip = StateField.define<Tooltip | null>({
      create: () => null,
      update(tip, tr) {
        if (!tr.docChanged && !tr.selection) return tip;
        const { from, to } = tr.state.selection.main;
        if (oneLine || from === to || !latest.current.askButton || !latest.current.onAsk) return null;
        if (tr.state.doc.sliceString(from, to).trim() === "") return null;
        return { pos: to, above: false, arrow: false, create: askTipView };
      },
      provide: (f) => showTooltip.from(f),
    });

    const escape = (view: EditorView) => {
      if (searchPanelOpen(view.state)) return closeSearchPanel(view);
      if (view.state.field(paramsField)) {
        view.dispatch({ effects: setParams.of(null) });
        return true;
      }
      return latest.current.onEscape();
    };

    /** The commands that act on this editor; any other id goes to the owner. */
    const own: Partial<Record<CommandId, (view: EditorView) => boolean>> = {
      "query.run": run("current"),
      "query.runAll": run("all"),
      "query.format": () => {
        latest.current.onFormat();
        return true;
      },
      "query.save": () => {
        latest.current.onSave();
        return true;
      },
      "editor.ask": ask,
      "editor.quickFix": openFixes,
      "editor.rename": rename,
      "editor.definition": definition,
      "editor.parameterHints": (v) => params(v, true),
    };
    runCommand.current = (id) => {
      const v = viewRef.current;
      if (!v) return false;
      const mine = own[id];
      return mine ? mine(v) : latest.current.cmds.run(id);
    };

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          oneLine ? [] : [lineNumbers(), lintGutter(), highlightActiveLineGutter()],
          insertionLine(),
          editorTheme(),
          oneLine
            ? EditorState.transactionFilter.of((tr) => {
                if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
                const changes: { from: number; to: number; insert: string }[] = [];
                tr.changes.iterChanges((from, to, _fb, _tb, inserted) =>
                  changes.push({ from, to, insert: inserted.toString().replace(/\r?\n/g, " ") }),
                );
                return { changes, selection: tr.selection, effects: tr.effects, scrollIntoView: tr.scrollIntoView };
              })
            : [],
          history(),
          sql({ dialect: SQL_DIALECT[dialect], upperCaseKeywords: true }),
          themeHighlight,
          functionCallMarks,
          oneLine ? [] : currentStatement(() => latest.current.dialect),
          marksField,
          bandField,
          blockedField,
          writeHazardField,
          noticeField,
          paramsField,
          askTip,
          EditorState.allowMultipleSelections.of(true),
          autocompletion({ override: [completionSource] }),
          Prec.highest(keymap.of([{ key: "Tab", run: leaveInsField }])),
          Prec.high(
            keymap.of([
              ...(oneLine ? [{ key: "Enter", run: run("current") }] : [{ key: "Enter", run: endRename }]),
              { key: "Escape", run: escape },
              ...(oneLine ? [] : [{ key: "Tab", run: tabTemplate }]),
            ]),
          ),
          // Every command key, above the editor's defaults, so a confirmed override wins (PR11).
          commandKeys.current.of(editorCommandKeymap(latest.current.cmds.map, (id) => runCommand.current(id))),
          oneLine ? [] : editingBasics(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ "aria-label": oneLine ? "Filter" : "SQL" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              if (insField !== null) insField = u.changes.mapPos(insField, -1);
              latest.current.onChange(u.state.doc.toString());
              if (typingTimer) clearTimeout(typingTimer);
              extra = [];
              fixesOpen = false;
              analyze(u.view);
            }
            if (u.selectionSet && u.state.selection.ranges.length < 2) renaming = false;
            if (u.docChanged || u.selectionSet) {
              params(u.view, false);
              if (latest.current.onPosition) {
                const head = u.state.selection.main.head;
                const line = u.state.doc.lineAt(head);
                latest.current.onPosition(line.number, head - line.from + 1);
              }
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    reanalyze.current = () => analyze(view);
    editorRef.current = {
      text() {
        return view.state.doc.toString();
      },
      runTarget() {
        const { from, to } = view.state.selection.main;
        const text = view.state.doc.toString();
        if (from !== to) {
          const raw = text.slice(from, to);
          const lead = raw.length - raw.trimStart().length;
          const body = raw.trim().replace(/;$/, "").trimEnd();
          return body ? { from: from + lead, to: from + lead + body.length, text: body } : null;
        }
        return statementAt(splitStatements(text, latest.current.dialect), from);
      },
      select(from, to) {
        const len = view.state.doc.length;
        view.dispatch({ selection: { anchor: Math.min(from, len), head: Math.min(to, len) }, scrollIntoView: true });
        view.focus();
      },
      insert(text) {
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
        view.focus();
      },
      replaceAll(text) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      },
      replaceRange(from, to, text) {
        const len = view.state.doc.length;
        const start = Math.min(from, len);
        view.dispatch({
          changes: { from: start, to: Math.min(Math.max(to, start), len), insert: text },
          selection: { anchor: start + text.length },
          scrollIntoView: true,
        });
        view.focus();
      },
      focus() {
        view.focus();
      },
      band(ranges) {
        view.dispatch({ effects: setBand.of(ranges) });
      },
    };
    analyze(view);
    return () => {
      if (typingTimer) clearTimeout(typingTimer);
      editorRef.current = null;
      viewRef.current = null;
      reanalyze.current = null;
      view.destroy();
    };
    // The view is created once; later prop changes are pushed in below.
  }, []);

  // A changed keymap rebinds the keys in place.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: commandKeys.current.reconfigure(editorCommandKeymap(cmds.map, (id) => runCommand.current(id))),
    });
  }, [cmds.map]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setMarks.of({ running: markRunning ?? null, error: markError ?? null }) });
  }, [markRunning?.from, markRunning?.to, markError?.from, markError?.to]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setBlocked.of(blocked ?? null) });
  }, [blocked?.from, blocked?.to, blocked?.message, blocked?.detail]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setWriteHazard.of(writeHazard ?? null) });
  }, [writeHazard?.from, writeHazard?.to, writeHazard?.note]);

  // A restarted engine has no results for this document yet: ask it again.
  useEffect(() => {
    if (!lang) return;
    const off = lang.client.onRestart(() => reanalyze.current?.());
    return () => {
      off();
    };
  }, [lang?.client]);

  // A schema that loads, refreshes or goes away changes what the checks can say.
  useEffect(() => {
    reanalyze.current?.();
  }, [lang?.schemaKey, lang?.schemaState, dialect]);

  return <div className={oneLine ? "sql-editor sql-editor-one-line" : "sql-editor"} ref={host} />;
}

export type { TextEdit };
