import { autocompletion, type Completion as CmCompletion, snippet, snippetCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { type Diagnostic as CmDiagnostic, lintGutter, openLintPanel, setDiagnostics } from "@codemirror/lint";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { DialectKind } from "../api/types";
import { LangClient } from "../lang/client";
import { completeDbml } from "../lang/dbml/complete";
import { renameColumn, renameTable } from "../lang/dbml/edits";
import { DBML_TEMPLATES } from "../lang/dbml/templates";
import type { Diagnostic, ParseResult, TextEdit } from "../lang/protocol";
import { changedLinesGutter, setSaved } from "./changedLines";
import { dbmlHighlight, dbmlLanguage } from "./dbmlLanguage";

/** An error at the caret waits this long, so you are not flagged while still typing. */
const CARET_ERROR_DELAY_MS = 1500;

interface Props {
  value: string;
  /** The text as last saved; lines that differ get a gutter bar. */
  savedValue: string;
  dialect: DialectKind;
  onChange: (text: string) => void;
  /** A parse result and the text it was parsed from (it may be older than the current text). */
  onResult: (r: ParseResult, text: string) => void;
  /** Set by the editor: applies canvas edits as one undoable transaction. */
  editsRef: React.MutableRefObject<((edits: TextEdit[]) => void) | null>;
  /** Set by the editor: moves the caret to an offset and focuses the editor. */
  focusRef?: React.MutableRefObject<((offset: number) => void) | null>;
  /** The language engine; one is created when absent. */
  client?: LangClient;
}

const KIND: Record<string, string> = { table: "class", column: "property", type: "type", keyword: "keyword" };

function toCm(diagnostics: Diagnostic[], docLength: number): CmDiagnostic[] {
  return diagnostics.map((d) => ({
    from: Math.min(d.from, docLength),
    to: Math.min(Math.max(d.to, d.from), docLength),
    severity: d.severity === "hint" ? "info" : d.severity,
    message: d.message,
    actions: d.fixes.map((f) => ({
      name: f.title,
      apply: (view: EditorView) => view.dispatch({ changes: f.edits.map((e) => ({ ...e })) }),
    })),
  }));
}

export default function DbmlEditor({
  value,
  savedValue,
  dialect,
  onChange,
  onResult,
  editsRef,
  focusRef,
  client,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onResult, dialect });
  latest.current = { onChange, onResult, dialect };

  useEffect(() => {
    const lang = client ?? new LangClient();
    let result: ParseResult | null = null;
    let resultText = "";
    let caretTimer: ReturnType<typeof setTimeout> | null = null;

    /** Diagnostics now, holding back an error at the caret unless `all`. */
    function show(view: EditorView, all: boolean) {
      if (!result || resultText !== view.state.doc.toString()) return;
      const head = view.state.selection.main.head;
      const shown = all
        ? result.diagnostics
        : result.diagnostics.filter((d) => !(d.severity === "error" && d.from <= head && head <= d.to));
      view.dispatch(setDiagnostics(view.state, toCm(shown, view.state.doc.length)));
    }

    function parse(view: EditorView) {
      const text = view.state.doc.toString();
      lang
        .update("dbml", text, latest.current.dialect)
        .then((r) => {
          result = r;
          resultText = text;
          latest.current.onResult(r, text);
          if (viewRef.current !== view) return;
          show(view, false);
          if (caretTimer) clearTimeout(caretTimer);
          caretTimer = setTimeout(() => show(view, true), CARET_ERROR_DELAY_MS);
        })
        .catch(() => {
          // The engine restarted; the next edit parses again.
        });
    }

    const completionSource = (ctx: { state: EditorState; pos: number }) => {
      const model = result?.model ?? result?.lastValid ?? null;
      const r = completeDbml(ctx.state.doc.toString(), ctx.pos, model, latest.current.dialect);
      if (r.items.length === 0) return null;
      const options: CmCompletion[] = r.items.map((i) =>
        i.kind === "template"
          ? snippetCompletion(i.apply, { label: i.label, type: "keyword" })
          : { label: i.label, detail: i.detail, apply: i.apply, type: KIND[i.kind] },
      );
      return { from: r.from, options };
    };

    const expandTemplate = (view: EditorView) => {
      const { head } = view.state.selection.main;
      const line = view.state.doc.lineAt(head);
      const word = /\w+$/.exec(line.text.slice(0, head - line.from))?.[0];
      const t = DBML_TEMPLATES.find((x) => x.name === word);
      if (!t || !word) return false;
      snippet(t.body)(view, { label: t.name }, head - word.length, head);
      return true;
    };

    const openFixes = (view: EditorView) => {
      show(view, true);
      openLintPanel(view);
      return true;
    };

    const rename = (view: EditorView) => {
      if (!result || resultText !== view.state.doc.toString()) return false;
      const head = view.state.selection.main.head;
      const hit = Object.entries(result.ranges).find(
        ([k, r]) => k.endsWith("/name") && r.from <= head && head <= r.to,
      );
      if (!hit) return false;
      const [k] = hit;
      const text = view.state.doc.toString();
      const current = text.slice(hit[1].from, hit[1].to);
      const next = window.prompt("Rename to", current.replace(/^"|"$/g, ""));
      if (!next || next === current) return true;
      let edits: TextEdit[];
      if (k.startsWith("table:")) {
        edits = renameTable(text, result.ranges, k.slice("table:".length, -"/name".length), next);
      } else {
        const [key, col] = k.slice("column:".length, -"/name".length).split("/");
        edits = renameColumn(text, result.ranges, key, col, next);
      }
      view.dispatch({ changes: edits });
      return true;
    };

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          changedLinesGutter(savedValue),
          lintGutter(),
          history(),
          dbmlLanguage,
          dbmlHighlight,
          autocompletion({ override: [completionSource] }),
          Prec.high(
            keymap.of([
              { key: "Tab", run: expandTemplate },
              { key: "Ctrl-.", run: openFixes },
              { key: "Alt-Enter", run: openFixes },
              { key: "F2", run: rename },
            ]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ "aria-label": "DBML" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const text = u.state.doc.toString();
              latest.current.onChange(text);
              if (caretTimer) clearTimeout(caretTimer);
              parse(u.view);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    editsRef.current = (edits) => view.dispatch({ changes: edits.map((e) => ({ ...e })), userEvent: "input.canvas" });
    if (focusRef) {
      focusRef.current = (offset) => {
        view.dispatch({ selection: { anchor: Math.min(offset, view.state.doc.length) }, scrollIntoView: true });
        view.focus();
      };
    }
    parse(view);
    return () => {
      if (caretTimer) clearTimeout(caretTimer);
      editsRef.current = null;
      viewRef.current = null;
      view.destroy();
      if (!client) lang.dispose();
    };
    // The view is created once; later prop changes are pushed in below.
  }, []);

  // A new document from outside (open, reverse-engineer) replaces the text.
  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setSaved.of(savedValue) });
  }, [savedValue]);

  return <div ref={host} className="dbml-editor" />;
}
