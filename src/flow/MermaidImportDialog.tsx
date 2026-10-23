// New flow from Mermaid (frame 7.3): paste or open a Mermaid flowchart, see the flow it becomes, and save
// it as an ordinary .flow file with its layout file (ruling D1) in Contura's diagrams folder, by name (Q35).
// The Mermaid text is not kept.
import { useUngroupedLabel } from "../prefs/usePrefs";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorText, isCommandError, writeDiagram } from "../api/client";
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
import type { MermaidResult } from "./mermaid";
import { mermaidLang } from "./mermaidLang";

interface Props {
  groups: Group[];
  defaultGroup: GroupId | null;
  lang: LangClient;
  onClose(): void;
  /** Called with the saved diagram's name; it is kept in the diagrams folder. */
  onCreated(name: string): void;
  /** Runs before a Replace writes over diagram `name`: its open tab goes first (ruling P19). */
  beforeReplace?(name: string): void | Promise<void>;
}

/** The preview redraws this long after the last keystroke. */
const REDRAW_MS = 150;
const DEFAULT_NAME = "new-flow.flow";
/** Notes drawn in the list; the rest are counted. */
const NOTES_SHOWN = 200;

/** The flow's title from its file name: `order-handover.flow` is "Order handover". */
export function titleFromName(name: string): string {
  const words = name.replace(/\.flow$/i, "").replace(/[-_\s]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Untitled flow";
}

/** The file name a title gives: "Order handover" is `order-handover.flow`. */
export function nameFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "new-flow"}.flow`;
}

/** The layout file D1 writes beside the flow: only the direction and the Group, so the first layout matches the preview. */
export function flowLayoutJson(direction: "TB" | "LR", group: GroupId | null): string {
  return `${JSON.stringify({ version: 1, direction, group, nodes: {} }, null, 2)}\n`;
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;

/** "Line 5 is left out ...", or "Lines 5 and 8 are left out ..." */
function leftOutLine(lines: number[]): string | null {
  if (lines.length === 0) return null;
  if (lines.length === 1) return `Line ${lines[0]} is left out until it can be read. The rest is drawn.`;
  const list = `${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}`;
  return `Lines ${list} are left out until they can be read. The rest is drawn.`;
}

export default function MermaidImportDialog({ groups, defaultGroup, lang, onClose, onCreated, beforeReplace }: Props) {
  const { label: ungroupedLabel } = useUngroupedLabel();
  const toast = useToast();
  const [text, setText] = useState("");
  const [name, setName] = useState(DEFAULT_NAME);
  const nameTouched = useRef(false);
  const [group, setGroup] = useState<string>(defaultGroup ?? "");
  const [tab, setTab] = useState<"diagram" | "text">("diagram");
  const [result, setResult] = useState<MermaidResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The file name being asked about: "<name>.flow already exists. Replace it?" */
  const [asking, setAsking] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  const fileName = /\.flow$/i.test(name.trim()) ? name.trim() : `${name.trim()}.flow`;
  /** The name the Core gets; it adds .flow and keeps the file in the diagrams folder. */
  const flowName = fileName.replace(/\.flow$/i, "");
  const title = titleFromName(fileName);

  // Convert in the language worker 150 ms after the last change to the text or the Name.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      lang.mermaid(text, title).then(
        (r) => {
          if (!live) return;
          setResult(r);
          // A front matter title names the file until the Name is edited.
          if (!nameTouched.current && r.doc.title !== title) setName(nameFromTitle(r.doc.title));
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
  const canCreate = !busy && !!result && errors.length === 0 && result.nodes > 0 && name.trim() !== "";

  const actions = useRef({ create: () => {}, openFile: () => {} });
  actions.current.create = () => void createFlow();
  actions.current.openFile = () => void openFile();

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
          // The dialog's keys win over the editor's own Ctrl+Enter (a new line).
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: () => (actions.current.create(), true) },
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
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  // Ctrl+O and Ctrl+Enter anywhere in the dialog; the editor handles its own first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "o") actions.current.openFile();
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
      if (typeof picked !== "string") return;
      const content = await readTextFile(picked);
      const v = view.current;
      if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } });
      else setText(content);
      if (!nameTouched.current) {
        const base = picked.split(/[\\/]/).pop() ?? "";
        setName(`${base.replace(/\.[^.]*$/, "") || "new-flow"}.flow`);
      }
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  async function createFlow(replace = false) {
    if (!canCreate) return;
    setBusy(true);
    setMessage(null);
    setAsking(null);
    try {
      const fresh = await lang.mermaid(text, title);
      setResult(fresh);
      if (fresh.errors.length > 0 || fresh.nodes === 0) return;
      // One Core call writes the .flow and its layout file together in the diagrams folder, by name; a taken
      // name is refused unless this is the Replace answer.
      if (replace) await beforeReplace?.(flowName);
      await writeDiagram(flowName, fresh.flow, flowLayoutJson(fresh.direction, group === "" ? null : group), replace);
      toast.show({ kind: "success", text: `Created ${flowName}.flow` });
      onCreated(flowName);
    } catch (e) {
      if (isCommandError(e) && e.kind === "diagramExists") setAsking(`${e.message.name}.flow`);
      else setMessage(errorText(e));
    } finally {
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

  const count = result ? `${plural(result.nodes, "node")}, ${plural(result.links, "link")}${errors.length ? " read" : ""}` : "";
  const leftOut = leftOutLine(errors.filter((e) => e.line > 0).map((e) => e.line));
  const flowLines = (result?.flow ?? "").replace(/\n$/, "").split("\n");

  return (
    <Dialog title="New flow from Mermaid" icon="flow" subtitle="Flowcharts only, one way" size="large" className="mermaid-dialog" onClose={onClose}>
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
                {leftOut && (
                  <div className="flow-banner flow-banner-danger mermaid-left-out">
                    <Icon name="alert" size={14} />
                    <span>{leftOut}</span>
                  </div>
                )}
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
        {errors.length > 0
          ? errors.map((e, i) => (
              <div key={i} className="flow-banner flow-banner-danger" role="alert">
                <Icon name="alert" size={14} />
                <span>{e.text}</span>
              </div>
            ))
          : result &&
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
            )}
        <div className="mermaid-fields">
          <label className="field mermaid-name">
            <span>Name</span>
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
          <div className="field mermaid-group">
            <span>Group</span>
            <Select value={group} options={groupOptions} onChange={setGroup} label="Group" />
          </div>
        </div>
      </div>
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
          {message ? (
            <span className="mermaid-message" role="alert">
              {message}
            </span>
          ) : (
            <span className="mermaid-hint">Your Mermaid text is not kept. Edit the .flow text after.</span>
          )}
          <span className="spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
            <Kbd keys="Esc" />
          </button>
          <button type="button" className="button button-primary" disabled={!canCreate} onClick={() => void createFlow()}>
            Create flow
            <Kbd keys="Ctrl+Enter" />
          </button>
        </footer>
      )}
    </Dialog>
  );
}
