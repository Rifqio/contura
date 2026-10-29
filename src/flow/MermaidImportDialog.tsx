// New flow from Mermaid: paste or open a Mermaid flowchart, see the flow it becomes, and save
// it as an ordinary .flow file with its layout file (ruling D1) in Contura's diagrams folder, by name.
// The Mermaid text is not kept.
import { useUngroupedLabel } from "../prefs/usePrefs";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState, Prec, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorText, isCommandError, listDiagrams, writeDiagram } from "../api/client";
import { freeDiagramName } from "./diagramKinds";
import { readTextFile } from "../api/jobs";
import type { Group, GroupId } from "../api/types";
import Dialog from "../components/Dialog";
import GroupBadge from "../components/GroupBadge";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import Segmented from "../components/Segmented";
import Select from "../components/Select";
import { useToast } from "../components/Toast";
import type { LangClient } from "../lang/client";
import { editorTheme } from "../lang/editorTheme";
import { dbmlHighlight } from "../schema/dbmlLanguage";
import FlowPreview from "./FlowPreview";
import type { DiagramKind } from "../lang/flow/model";
import { insertKindRefusal, KIND_SHORT } from "../lang/flow/insert";
import type { MermaidAdd } from "./FlowTab";
import type { MermaidResult } from "./mermaid";
import { mermaidLang } from "./mermaidLang";

interface Props {
  groups: Group[];
  defaultGroup: GroupId | null;
  lang: LangClient;
  onClose(): void;
  /** Called with the saved diagram's name; it is kept in the diagrams folder. */
  onCreated(name: string): void;
  /** Runs before a Replace writes over diagram `name`: its open tab goes first. */
  beforeReplace?(name: string): void | Promise<void>;
  /** Step 10: opened from New diagram, Back returns to it (VS Code's multi-step Back); there is no Insert then. */
  onBack?(): void;
  /**
   * Step 10: opened from the canvas, Insert puts the converted text into the open diagram `file` of `kind` only
   * (draw.io's Arrange > Insert > Mermaid). `run` answers why it was refused, or null once it is in.
   */
  insert?: { kind: DiagramKind; file: string; run(flow: string): Promise<string | null> };
  /**
   * B2 decision 15: opened from the Shelf, the result becomes a new frame in the board `add.file`. The Name is the frame's
   * Title; Create, Insert and the Group are hidden; Ctrl+Enter runs Add to board. `run` answers why it was refused, or null.
   */
  add?: MermaidAdd;
}

/** The lines the converter could not read, marked where they are written (board DiagramStartWell). */
const setBad = StateEffect.define<number[]>();
const badLine = Decoration.line({ class: "cm-mermaid-bad" });
const badField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setBad)) continue;
      const b = new RangeSetBuilder<Decoration>();
      for (const n of [...new Set(e.value)].sort((x, y) => x - y)) if (n >= 1 && n <= tr.state.doc.lines) b.add(tr.state.doc.line(n).from, tr.state.doc.line(n).from, badLine);
      next = b.finish();
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The preview redraws this long after the last keystroke. */
const REDRAW_MS = 150;
/** The name a new diagram starts with, as in New diagram (fix round 1, M8): free of every diagram there is. */
const DEFAULT_NAME = "Untitled diagram";
/** Notes drawn in the list; the rest are counted. */
const NOTES_SHOWN = 200;

/** The flow's title from its file name: `order-handover.flow` is "Order handover". */
export function titleFromName(name: string): string {
  const words = name.replace(/\.flow$/i, "").replace(/[-_\s]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Untitled flow";
}

/** The layout file D1 writes beside the flow: only the direction and the Group, so the first layout matches the preview. */
export function flowLayoutJson(direction: "TB" | "LR", group: GroupId | null): string {
  return `${JSON.stringify({ version: 1, direction, group, nodes: {} }, null, 2)}\n`;
}


/** Why Create and Insert wait (board DiagramStartWell): a line to fix, or nothing to bring in yet. */
function blockOf(text: string, result: MermaidResult | null): string | null {
  if (!text.trim() || !result) return "Paste a Mermaid diagram first.";
  const lines = [...new Set(result.errors.filter((e) => e.line > 0).map((e) => e.line))];
  if (result.nodes === 0 && result.errors.length > 0 && !result.flow) return "This kind cannot come in.";
  if (lines.length === 1) return `Fix or delete line ${lines[0]} to go on.`;
  if (lines.length > 1) return `Fix or delete the ${lines.length} lines marked to go on.`;
  if (result.errors.length > 0) return result.errors[0].text;
  if (result.nodes === 0) return "Nothing to bring in yet.";
  return null;
}

export default function MermaidImportDialog({ groups, defaultGroup, lang, onClose, onCreated, beforeReplace, onBack, insert, add }: Props) {
  const { label: ungroupedLabel } = useUngroupedLabel();
  const toast = useToast();
  const [text, setText] = useState("");
  const [name, setName] = useState(DEFAULT_NAME);
  const nameTouched = useRef(false);
  /** Every diagram's name, so the name it suggests is free (VS Code's Untitled-N). */
  const taken = useRef<string[]>([]);
  useEffect(() => {
    // A frame's title needs no free file name.
    if (add) return;
    let live = true;
    // Asked once; a test with no Core answer leaves the default as it is.
    Promise.resolve()
      .then(() => listDiagrams())
      .then(
        (all) => {
          if (!live || !Array.isArray(all)) return;
          taken.current = all.map((d) => d.name);
          if (!nameTouched.current) setName((n) => freeDiagramName(n.replace(/\.flow$/i, ""), taken.current));
        },
        () => {},
      );
    return () => {
      live = false;
    };
    // The mode is fixed for the dialog's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [group, setGroup] = useState<string>(defaultGroup ?? "");
  const [tab, setTab] = useState<"diagram" | "text">("diagram");
  const [result, setResult] = useState<MermaidResult | null>(null);
  const [busy, setBusy] = useState(false);
  /** Create, Insert or Add is running: a second press before the first renders does nothing (`busy` lags a render). */
  const running = useRef(false);
  /** False once the dialog is gone (Cancel, Esc): a conversion or write still running then adds, writes and says nothing. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [message, setMessage] = useState<string | null>(null);
  /** The file name being asked about: "<name>.flow already exists. Replace it?" */
  const [asking, setAsking] = useState<string | null>(null);
  /** Back with Mermaid typed asks first, as Esc and Cancel do (fix round 1, M3). */
  const [backAsk, setBackAsk] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  const fileName = /\.flow$/i.test(name.trim()) ? name.trim() : `${name.trim()}.flow`;
  /** The name the Core gets; it adds .flow and keeps the file in the diagrams folder. */
  const flowName = fileName.replace(/\.flow$/i, "");
  // Add mode: the typed Title is the frame's header title as typed; addFrames makes it free. Empty keeps the default.
  const title = add && name.trim() ? name.trim() : titleFromName(fileName);

  // Convert in the language worker 150 ms after the last change to the text or the Name.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      lang.mermaid(text, title).then(
        (r) => {
          if (!live) return;
          setResult(r);
          // A front matter title names the file until the Name is edited.
          if (!nameTouched.current && r.doc.title !== title) setName(freeDiagramName(r.doc.title, taken.current));
        },
        (e: unknown) => live && setMessage(errorText(e)),
      );
    }, REDRAW_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, title, lang]);

  const errors = result?.errors ?? [];
  const block = blockOf(text, result);
  const canCreate = !busy && block === null && name.trim() !== "";
  /** Insert takes the open diagram's kind only (board DiagramStartWell). */
  const insertWhy = !insert ? null : block ?? (result && result.kind !== insert.kind ? insertKindRefusal(insert.kind, result.kind) : null);
  const canInsert = !!insert && !busy && insertWhy === null;

  const canAdd = !!add && !busy && block === null && name.trim() !== "";
  const actions = useRef({ create: () => {}, openFile: () => {}, insert: () => {} });
  actions.current.create = () => void (add ? addFlow() : createFlow());
  actions.current.openFile = () => void openFile();
  actions.current.insert = () => void insertFlow();

  // The lines it could not read are marked in the editor, where they are.
  useEffect(() => {
    view.current?.dispatch({ effects: setBad.of(errors.filter((e) => e.line > 0).map((e) => e.line)) });
  }, [errors]);

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          editorTheme(),
          history(),
          mermaidLang,
          dbmlHighlight,
          badField,
          // The dialog's keys win over the editor's own Ctrl+Enter (a new line).
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: () => (actions.current.create(), true) },
              { key: "Mod-Shift-Enter", run: () => (actions.current.insert(), true) },
              { key: "Mod-o", run: () => (actions.current.openFile(), true) },
            ]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          // The dialog puts focus here first, so Ctrl+V pastes at once.
          EditorView.contentAttributes.of({ "aria-label": "Mermaid, pasted", "data-autofocus": "true" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setText(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    // The dialog opens with focus in the Mermaid text, so Ctrl+V pastes there at once (fix round 2, L4). The dialog's own
    // first-field focus runs before this editor exists, so the editor takes focus itself.
    v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  // Ctrl+O and Ctrl+Enter anywhere in the dialog; the editor handles its own first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.shiftKey && e.key === "Enter") actions.current.insert();
      else if (e.shiftKey) return;
      else if (e.key.toLowerCase() === "o") actions.current.openFile();
      else if (e.key === "Enter") actions.current.create();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function openFile() {
    setMessage(null);
    try {
      const picked = await open({ multiple: false, directory: false, filters: [{ name: "Mermaid", extensions: ["mmd", "mermaid"] }] });
      if (typeof picked !== "string" || !alive.current) return;
      const content = await readTextFile(picked);
      if (!alive.current) return;
      const v = view.current;
      if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } });
      else setText(content);
      if (!nameTouched.current) {
        const base = picked.split(/[\\/]/).pop() ?? "";
        setName(freeDiagramName(base.replace(/\.[^.]*$/, "") || DEFAULT_NAME, taken.current));
      }
    } catch (e) {
      if (alive.current) setMessage(errorText(e));
    }
  }

  async function createFlow(replace = false) {
    if (!canCreate || running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    setAsking(null);
    try {
      const fresh = await lang.mermaid(text, title);
      if (!alive.current) return;
      setResult(fresh);
      if (blockOf(text, fresh) !== null) return;
      // One Core call writes the .flow and its layout file together in the diagrams folder, by name; a taken
      // name is refused unless this is the Replace answer.
      if (replace) await beforeReplace?.(flowName);
      if (!alive.current) return;
      await writeDiagram(flowName, fresh.flow, flowLayoutJson(fresh.direction, group === "" ? null : group), replace);
      if (!alive.current) return;
      toast.show({ kind: "success", text: `Created ${flowName}` });
      onCreated(flowName);
    } catch (e) {
      if (!alive.current) return;
      if (isCommandError(e) && e.kind === "diagramExists") setAsking(`${e.message.name}.flow`);
      else setMessage(errorText(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const groupOptions = useMemo(
    () => [
      { value: "", label: ungroupedLabel, lead: <GroupBadge name="" color={null} /> },
      ...groups.map((g) => ({ value: g.id as string, label: g.name, lead: <GroupBadge id={g.id} name={g.name} color={g.color} /> })),
    ],
    [groups, ungroupedLabel],
  );

  const count = result?.count ? `${result.count}${errors.length ? " read" : ""}` : "";
  const createWord = KIND_SHORT[result && result.nodes > 0 ? result.kind : "flow"];

  /** Insert: the converted text into the open diagram, as one undo step; the dialog closes once it is in. */
  async function insertFlow() {
    if (!insert || !canInsert || running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const fresh = await lang.mermaid(text, title);
      if (!alive.current) return;
      setResult(fresh);
      if (blockOf(text, fresh) !== null) return;
      if (fresh.kind !== insert.kind) return setMessage(insertKindRefusal(insert.kind, fresh.kind));
      const why = await insert.run(fresh.flow);
      if (!alive.current) return;
      if (why) setMessage(why);
      else onClose();
    } catch (e) {
      if (alive.current) setMessage(errorText(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  /** Add to board (decision 15): the converted text as a new frame; the dialog closes once it is in, a refusal stays here. */
  async function addFlow() {
    if (!add || !canAdd || running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const fresh = await lang.mermaid(text, title);
      if (!alive.current) return;
      setResult(fresh);
      if (blockOf(text, fresh) !== null) return;
      const why = await add.run(fresh.flow, fresh.direction);
      if (!alive.current) return;
      if (why) setMessage(why);
      else onClose();
    } catch (e) {
      if (alive.current) setMessage(errorText(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const flowLines = (result?.flow ?? "").replace(/\n$/, "").split("\n");

  return (
    <Dialog
      title="Diagram from Mermaid"
      icon="flow"
      subtitle="Flowchart, sequence, state, class, mind map and timeline, one way"
      size="large"
      className="mermaid-dialog"
      dirty={text.trim() !== ""}
      onClose={onClose}
    >
      <div className="dialog-body mermaid-body">
        <div className="mermaid-panes">
          <section className="mermaid-pane" aria-label="Mermaid">
            <header className="mermaid-pane-head">
              <span className="mermaid-pane-title">Mermaid, pasted</span>
              <span className="spacer" />
              <button type="button" className="button button-ghost mermaid-open" title="Open .mmd file (Ctrl+O)" onClick={() => void openFile()}>
                <Icon name="folder" size={14} />
                Open .mmd file...
              </button>
            </header>
            <div className="mermaid-editor" ref={host} />
          </section>
          <section className="mermaid-pane" aria-label="Result">
            <header className="mermaid-pane-head">
              <Segmented
                label="Show"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "diagram", label: "Diagram" },
                  { value: "text", label: ".flow text" },
                ]}
              />
              <span className="spacer" />
              <span className="mermaid-count">{count}</span>
            </header>
            {tab === "diagram" ? (
              <div className="mermaid-preview">
                <FlowPreview result={result} lang={lang} />
              </div>
            ) : (
              <div className="sql-block flow-text" role="group" aria-label="The .flow text">
                {flowLines.map((line, i) => (
                  <div key={i} className="sql-block-line">
                    <span className="sql-block-gutter" aria-hidden="true">
                      {i + 1}
                    </span>
                    <code className="sql-block-text">{line}</code>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
        {errors.length > 0 ? (
          // Only the rows: nothing under them, so no empty band.
          <div className="mermaid-problems">
            {errors.map((e, i) => (
              <div key={i} className="flow-banner flow-banner-danger" role="alert">
                <Icon name="alert" size={14} />
                <span>{e.text}</span>
              </div>
            ))}
          </div>
        ) : (
          result &&
            result.notes.length > 0 && (
              <div className="mermaid-notes">
                <div className="mermaid-notes-head">
                  <span className="mermaid-notes-title">Not carried over</span>
                  <span className="chip">{result.notes.length}</span>
                </div>
                <ul className="mermaid-notes-list" aria-label="Not carried over">
                  {result.notes.slice(0, NOTES_SHOWN).map((n, i) => (
                    <li key={i} className="mermaid-note">
                      <Icon name="alert" size={14} />
                      <span>{n.text}</span>
                    </li>
                  ))}
                </ul>
                {result.notes.length > NOTES_SHOWN && (
                  <span className="mermaid-notes-more">And {(result.notes.length - NOTES_SHOWN).toLocaleString("en-US")} more.</span>
                )}
              </div>
            )
        )}
        <div className="mermaid-fields">
          <label className="field mermaid-name">
            <span>{add ? "Title" : "Name"}</span>
            <input
              className="input mono"
              value={name}
              spellCheck={false}
              onChange={(e) => {
                nameTouched.current = true;
                setName(e.target.value);
                setAsking(null);
              }}
            />
          </label>
          {!add && (
            <div className="field mermaid-group">
              <span>Group</span>
              <Select value={group} options={groupOptions} onChange={setGroup} label="Group" />
            </div>
          )}
        </div>
      </div>
      {backAsk && onBack && (
        <div className="dialog-discard" role="alert" aria-label="Discard your changes?">
          <span>Discard your changes?</span>
          <span className="spacer" />
          <button type="button" className="button" autoFocus onClick={() => setBackAsk(false)}>
            Keep editing
          </button>
          <button type="button" className="button" onClick={onBack}>
            Discard
          </button>
        </div>
      )}
      {asking ? (
        <footer className="dialog-footer">
          <span className="mermaid-message" role="alert">{`${asking} already exists. Replace it?`}</span>
          <span className="spacer" />
          <button type="button" className="button" onClick={() => setAsking(null)}>
            Cancel
          </button>
          <button type="button" className="button button-primary" disabled={busy} onClick={() => void createFlow(true)}>
            Replace
          </button>
        </footer>
      ) : (
        <footer className="dialog-footer">
          {onBack && (
            <button type="button" className="button" title="Back to New diagram" onClick={() => (text.trim() ? setBackAsk(true) : onBack())}>
              <Icon name="chevronLeft" size={14} />
              Back
            </button>
          )}
          {message ? (
            <span className="mermaid-message" role="alert">
              {message}
            </span>
          ) : text.trim() && block !== null && errors.length > 0 ? (
            <span className="mermaid-message">{block}</span>
          ) : insertWhy && result && result.nodes > 0 ? (
            <span className="mermaid-hint">{insertWhy}</span>
          ) : (
            <span className="mermaid-hint">Your Mermaid text is not kept. Edit the .flow text after.</span>
          )}
          <span className="spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
            <Kbd keys="Esc" />
          </button>
          {add ? (
            <button type="button" className="button button-primary" disabled={!canAdd} onClick={() => void addFlow()}>
              Add to board
              <Kbd keys="Ctrl+Enter" />
            </button>
          ) : (
            <>
              {insert && (
                <button
                  type="button"
                  className="button"
                  disabled={!canInsert}
                  title={insertWhy ?? "Adds it to the open diagram, selected, as one undo step (Ctrl+Shift+Enter)"}
                  onClick={() => void insertFlow()}
                >
                  {`Insert into ${insert.file}`}
                  <Kbd keys="Ctrl+Shift+Enter" />
                </button>
              )}
              <button type="button" className="button button-primary" disabled={!canCreate} onClick={() => void createFlow()}>
                {`Create ${createWord}`}
                <Kbd keys="Ctrl+Enter" />
              </button>
            </>
          )}
        </footer>
      )}
    </Dialog>
  );
}
