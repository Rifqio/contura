import { autocompletion, type Completion as CmCompletion, snippet, snippetCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { type Diagnostic as CmDiagnostic, lintGutter, openLintPanel, setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { DialectKind } from "../api/types";
import { type EditorCommands, editorCommandKeymap } from "../commands/editorKeymap";
import type { CommandId } from "../commands/registry";
import { useKeymap } from "../commands/useCommandKeys";
import { LangClient } from "../lang/client";
import { insertionLine } from "../lang/insertionLine";
import { editorTheme } from "../lang/editorTheme";
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
  /** Set by the editor: scrolls an offset into view without moving the selection or the focus. */
  revealRef?: React.MutableRefObject<((offset: number) => void) | null>;
  /** Text ranges to band: the blocks of the tables selected on the canvas. */
  band?: { from: number; to: number }[];
  /** The language engine; one is created when absent. */
  client?: LangClient;
  /** The command keys and how to run app commands; the app's keymap when absent. */
  commands?: EditorCommands;
}

/** The blocks of the tables selected on the canvas; each line of each gets a band. */
const setBand = StateEffect.define<{ from: number; to: number }[]>();
const bandLine = Decoration.line({ class: "cm-block-band" });
const bandField = StateField.define<{ from: number; to: number }[]>({
  create: () => [],
  update: (ranges, tr) => {
    const set = tr.effects.find((e) => e.is(setBand));
    if (set) return set.value;
    return tr.docChanged ? ranges.map((r) => ({ from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) })) : ranges;
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const lines: number[] = [];
      for (const r of state.field(f)) {
        const last = state.doc.lineAt(Math.min(Math.max(r.to, r.from), state.doc.length)).number;
        for (let n = state.doc.lineAt(Math.min(r.from, state.doc.length)).number; n <= last; n++) lines.push(state.doc.line(n).from);
      }
      return Decoration.set([...new Set(lines)].sort((a, b) => a - b).map((at) => bandLine.range(at)));
    }),
});

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
  revealRef,
  band,
  client,
  commands,
}: Props) {
  const appKeys = useKeymap();
  const cmds = commands ?? appKeys;
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const commandKeys = useRef(new Compartment());
  /** Runs a command id: the editor's own, else the owner's. Set once the view exists. */
  const runCommand = useRef<(id: CommandId) => boolean>(() => false);
  const latest = useRef({ onChange, onResult, dialect, cmds });
  latest.current = { onChange, onResult, dialect, cmds };

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

    /** The commands that act on this editor; any other id goes to the owner. */
    const own: Partial<Record<CommandId, (view: EditorView) => boolean>> = {
      "editor.quickFix": openFixes,
      "editor.rename": rename,
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
          lineNumbers(),
          insertionLine(),
          editorTheme(),
          bandField,
          changedLinesGutter(savedValue),
          lintGutter(),
          history(),
          dbmlLanguage,
          dbmlHighlight,
          autocompletion({ override: [completionSource] }),
          Prec.high(keymap.of([{ key: "Tab", run: expandTemplate }])),
          // Every command key, above the editor's defaults, so a confirmed override wins (PR11).
          commandKeys.current.of(editorCommandKeymap(latest.current.cmds.map, (id) => runCommand.current(id))),
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
    if (revealRef) {
      revealRef.current = (offset) =>
        view.dispatch({ effects: EditorView.scrollIntoView(Math.min(offset, view.state.doc.length), { y: "nearest" }) });
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

  // A changed keymap rebinds the keys in place.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: commandKeys.current.reconfigure(editorCommandKeymap(cmds.map, (id) => runCommand.current(id))),
    });
  }, [cmds.map]);

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

  // Selecting a card bands its block.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setBand.of(band ?? []) });
  }, [band]);

  return <div ref={host} className="dbml-editor" />;
}
