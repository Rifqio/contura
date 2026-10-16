import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { MySQL, PostgreSQL, SQLite, sql } from "@codemirror/lang-sql";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { type MutableRefObject, useEffect, useRef } from "react";
import type { DialectKind } from "../api/types";
// The same Theme-token syntax colours as the DBML editor.
import { dbmlHighlight as themeHighlight } from "../schema/dbmlLanguage";
import { type Stmt, splitStatements, statementAt } from "./statements";

const SQL_DIALECT = { mysql: MySQL, postgres: PostgreSQL, sqlite: SQLite } as const;

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
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onRun, onFormat, onSave, onEscape, dialect, onPosition });
  latest.current = { onChange, onRun, onFormat, onSave, onEscape, dialect, onPosition };

  useEffect(() => {
    const run = (kind: "current" | "all") => () => {
      latest.current.onRun(kind);
      return true;
    };
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          sql({ dialect: SQL_DIALECT[dialect], upperCaseKeywords: true }),
          themeHighlight,
          marksField,
          Prec.high(
            keymap.of([
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
              { key: "Escape", run: () => latest.current.onEscape() },
            ]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ "aria-label": "SQL" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
            if ((u.docChanged || u.selectionSet) && latest.current.onPosition) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              latest.current.onPosition(line.number, head - line.from + 1);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
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
    return () => {
      editorRef.current = null;
      viewRef.current = null;
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

  return <div className="sql-editor" ref={host} />;
}
