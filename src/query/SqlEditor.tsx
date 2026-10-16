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
import { EditorSelection, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  showTooltip,
  type Tooltip,
} from "@codemirror/view";
import { type MutableRefObject, useEffect, useRef } from "react";
import type { DialectKind } from "../api/types";
import type { LangClient } from "../lang/client";
import type { Diagnostic, TextEdit } from "../lang/protocol";
import { findTable } from "../lang/sql/analyze";
import type { SqlCompletion } from "../lang/sql/complete";
import type { SchemaState } from "../lang/sql/inspect";
import type { ParameterHints } from "../lang/sql/refactor";
import { insertColumnsTemplate, SQL_TEMPLATES, type SqlTemplate } from "../lang/sql/templates";
// The same Theme-token syntax colours as the DBML editor.
import { dbmlHighlight as themeHighlight } from "../schema/dbmlLanguage";
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
  focus(): void;
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
  /** The line and column being typed at, for the status line. */
  onPosition?(line: number, column: number): void;
  /** Completion, checks and refactors; without it the editor is plain. */
  lang?: SqlLang;
  /** Go to definition on a table: show it in the Database Tree. */
  onShowInTree?(table: { schema: string | null; name: string }): void;
  /** One line, no gutters, Enter runs: the grid filter. */
  oneLine?: boolean;
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
  onPosition,
  lang,
  onShowInTree,
  oneLine,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const reanalyze = useRef<(() => void) | null>(null);
  const latest = useRef({ onChange, onRun, onFormat, onSave, onEscape, dialect, onPosition, lang, onShowInTree });
  latest.current = { onChange, onRun, onFormat, onSave, onEscape, dialect, onPosition, lang, onShowInTree };

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

    const escape = (view: EditorView) => {
      if (view.state.field(paramsField)) {
        view.dispatch({ effects: setParams.of(null) });
        return true;
      }
      return latest.current.onEscape();
    };

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          oneLine ? [] : [lineNumbers(), lintGutter()],
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
          marksField,
          noticeField,
          paramsField,
          EditorState.allowMultipleSelections.of(true),
          autocompletion({ override: [completionSource] }),
          Prec.highest(keymap.of([{ key: "Tab", run: leaveInsField }])),
          Prec.high(
            keymap.of([
              ...(oneLine ? [{ key: "Enter", run: run("current") }] : [{ key: "Enter", run: endRename }]),
              { key: "Ctrl-Enter", run: run("current") },
              { key: "Shift-Ctrl-Enter", run: run("all") },
              {
                key: "Shift-Alt-f",
                run: () => {
                  latest.current.onFormat();
                  return true;
                },
              },
              {
                key: "Ctrl-s",
                run: () => {
                  latest.current.onSave();
                  return true;
                },
              },
              { key: "Escape", run: escape },
              ...(oneLine ? [] : [{ key: "Tab", run: tabTemplate }]),
              { key: "Ctrl-.", run: openFixes },
              { key: "Alt-Enter", run: openFixes },
              { key: "F2", run: rename },
              { key: "F12", run: definition },
              { key: "Shift-Ctrl-Space", run: (v) => params(v, true) },
            ]),
          ),
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
      focus() {
        view.focus();
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

  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setMarks.of({ running: markRunning ?? null, error: markError ?? null }) });
  }, [markRunning?.from, markRunning?.to, markError?.from, markError?.to]);

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
