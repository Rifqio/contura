// The New diagram sheet (frame 6+.6): pick the kind from drawn previews, name it, create. The file goes in
// Contura's diagrams folder by name, so there is no folder to choose; Mermaid has its own way in, and the
// recent diagrams sit beside it.
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { errorText, isCommandError, listDiagrams, writeDiagram } from "../api/client";
import type { DiagramEntry } from "../api/types";
import { hintFor } from "../commands/keymap";
import { useKeymap } from "../commands/useCommandKeys";
import Dialog from "../components/Dialog";
import Icon, { type IconName } from "../components/Icon";
import Kbd from "../components/Kbd";
import { agoText } from "../format/units";
import { type DiagramKind, quote } from "../lang/flow/model";
import { DIAGRAM_KIND_WORD, typedDiagramName } from "./diagramKinds";
import { parseFlowLayout, serializeFlowLayout } from "./layout";
import DfdNode from "./nodes/DfdNode";
import FlowchartNode from "./nodes/FlowchartNode";
import { kindStyle } from "./nodes/parts";

interface Props {
  onClose(): void;
  /** The diagram was written: open its tab and put focus in its text. */
  onCreated(name: string): void;
  /** Flow from Mermaid... : the step 7 dialog takes over. */
  onMermaid(): void;
  /** Runs before a Replace writes over diagram `name`: its open tab goes first (ruling P19). */
  beforeReplace?(name: string): void | Promise<void>;
  /** A Recent diagram was picked. */
  onOpenDiagram(name: string): void;
  /** The clock Recent's times are measured from; tests fix it. */
  now?: Date;
}

/** Recent rows shown in the right column. */
const RECENT_SHOWN = 8;

const KINDS: { kind: DiagramKind; title: string; text: string }[] = [
  { kind: "dfd", title: "Data flow", text: "Processes, data stores and outside parties. Stores can link to tables." },
  { kind: "flow", title: "Flowchart", text: "Steps, decisions, input and output, start and end." },
  { kind: "cloud", title: "Cloud architecture", text: "Services as provider icons, grouped by network or layer." },
];

/** The new file's text: only the first line, which names the kind and the title. */
export function newDiagramText(kind: DiagramKind, name: string): string {
  return `diagram ${kind} ${quote(name)}\n`;
}

/** A node placed in a preview, in the preview's unscaled space. */
function At({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div className="new-diagram-at" style={{ left: x, top: y }}>
      {children}
    </div>
  );
}

/** A cloud service tile in a preview: the kind's colours with a general icon. */
function Service({ name, icon }: { name?: string; icon: IconName }) {
  return (
    <div className="fnode fnode-service fnode-modern" style={kindStyle("service")}>
      <span className="fnode-tile">
        <Icon name={icon} size={20} />
      </span>
      {name && <span className="fnode-name">{name}</span>}
    </div>
  );
}

/** The drawn preview of each kind, with the real nodes. */
function Preview({ kind }: { kind: DiagramKind }) {
  return (
    <div className="new-diagram-preview" aria-hidden="true">
      <div className="new-diagram-scene">
        {kind === "dfd" && (
          <>
            <svg className="new-diagram-edges">
              <path d="M 100 76 V 126 H 196" />
              <path d="M 280 152 V 214 H 186" />
            </svg>
            <At x={16} y={24}>
              <DfdNode kind="external" name="Customer" style="modern" selected={false} />
            </At>
            <At x={196} y={100}>
              <DfdNode kind="process" name="Checkout" id="1.0" style="modern" selected={false} />
            </At>
            <At x={16} y={188}>
              <DfdNode kind="store" name="Orders" id="D1" style="modern" selected={false} />
            </At>
          </>
        )}
        {kind === "flow" && (
          <>
            <svg className="new-diagram-edges">
              <path d="M 120 58 H 196" />
              <path d="M 256 130 V 184" />
            </svg>
            <At x={24} y={38}>
              <FlowchartNode kind="start" name="Start" style="modern" selected={false} />
            </At>
            <At x={196} y={10}>
              <FlowchartNode kind="decision" name="Paid?" style="modern" selected={false} />
            </At>
            <At x={176} y={184}>
              <FlowchartNode kind="step" name="Ship order" style="modern" selected={false} />
            </At>
          </>
        )}
        {kind === "cloud" && (
          <>
            <div className="new-diagram-area">
              <span>Production</span>
            </div>
            <svg className="new-diagram-edges">
              <path d="M 72 124 H 150" />
              <path d="M 214 124 H 262" />
            </svg>
            <At x={16} y={100}>
              <Service icon="user" />
            </At>
            <At x={140} y={100}>
              <Service name="API" icon="plug" />
            </At>
            <At x={252} y={100}>
              <Service name="Orders" icon="database" />
            </At>
          </>
        )}
      </div>
    </div>
  );
}

export default function NewDiagramSheet({ onClose, onCreated, onMermaid, beforeReplace, onOpenDiagram, now = new Date() }: Props) {
  const keys = useKeymap().map;
  const [kind, setKind] = useState<DiagramKind>("dfd");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The file asked about: "checkout.flow already exists. Replace it?" */
  const [asking, setAsking] = useState<string | null>(null);
  const [recent, setRecent] = useState<DiagramEntry[] | null>(null);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    let live = true;
    listDiagrams().then(
      (all) => live && setRecent(all.slice(0, RECENT_SHOWN)),
      () => live && setRecent([]),
    );
    return () => {
      live = false;
    };
  }, []);

  const typed = typedDiagramName(name);
  const canCreate = !busy && typed !== "";

  async function create(replace = false) {
    if (!canCreate) return;
    setBusy(true);
    setMessage(null);
    setAsking(null);
    try {
      const layout = serializeFlowLayout(parseFlowLayout(null, kind));
      if (replace) await beforeReplace?.(typed);
      await writeDiagram(typed, newDiagramText(kind, typed), layout, replace);
      onCreated(typed);
    } catch (e) {
      if (isCommandError(e) && e.kind === "diagramExists") setAsking(`${e.message.name}.flow`);
      else setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function onKinds(e: KeyboardEvent) {
    const at = KINDS.findIndex((k) => k.kind === kind);
    const by = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (by === 0) return;
    e.preventDefault();
    const next = (at + by + KINDS.length) % KINDS.length;
    setKind(KINDS[next].kind);
    cards.current[next]?.focus();
  }

  const createKey = "Enter";
  const mermaidKey = hintFor(keys, "flow.fromMermaid");

  return (
    <Dialog title="New diagram" subtitle="The kind is the first line of the file, so you can change it later." className="new-diagram" onClose={onClose}>
      <div className="new-diagram-body">
        <div className="new-diagram-main">
          <div className="new-diagram-kinds" role="radiogroup" aria-label="Kind" onKeyDown={onKinds}>
            {KINDS.map((k, i) => {
              const on = k.kind === kind;
              return (
                <button
                  key={k.kind}
                  ref={(el) => {
                    cards.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={k.title}
                  tabIndex={on ? 0 : -1}
                  className={on ? "new-diagram-kind is-on" : "new-diagram-kind"}
                  onClick={() => setKind(k.kind)}
                >
                  {on && (
                    <span className="new-diagram-check">
                      <Icon name="check" size={14} />
                    </span>
                  )}
                  <Preview kind={k.kind} />
                  <span className="new-diagram-kind-text">
                    <span className="new-diagram-kind-title">{k.title}</span>
                    <span className="new-diagram-kind-sub">{k.text}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="new-diagram-form">
            <label className="new-diagram-name">
              <span>Name</span>
              <input
                className="input mono"
                value={name}
                placeholder="checkout"
                spellCheck={false}
                onChange={(e) => {
                  setName(e.target.value);
                  setMessage(null);
                  setAsking(null);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  void create();
                }}
              />
            </label>
            <span className="new-diagram-hint">
              Saved as {typed || "checkout"}.flow in Contura's diagrams folder. Publish or Save a copy as puts it anywhere else.
            </span>
            {message && (
              <span className="new-diagram-message" role="alert">
                {message}
              </span>
            )}
          </div>
          <div className="new-diagram-alt">
            <Icon name="flow" size={14} />
            <span>Have a Mermaid flowchart already?</span>
            <button type="button" className="button" title={mermaidKey ? `Flow from Mermaid (${mermaidKey})` : undefined} onClick={onMermaid}>
              Flow from Mermaid...
            </button>
            <span className="spacer" />
            {asking ? (
              <>
                <span className="new-diagram-message" role="alert">{`${asking} already exists. Replace it?`}</span>
                <button type="button" className="button" onClick={() => setAsking(null)}>
                  Cancel
                </button>
                <button type="button" className="button button-primary" disabled={busy} onClick={() => void create(true)}>
                  Replace
                </button>
              </>
            ) : (
              <>
                <button type="button" className="button" onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className="button button-primary" disabled={!canCreate} onClick={() => void create()}>
                  Create
                  <Kbd keys={createKey} />
                </button>
              </>
            )}
          </div>
        </div>
        <aside className="new-diagram-aside">
          <span className="new-diagram-aside-title">Recent diagrams</span>
          {recent !== null && recent.length === 0 ? (
            <p className="new-diagram-empty">No diagrams yet</p>
          ) : (
            <ul className="new-diagram-recent" aria-label="Recent diagrams">
              {(recent ?? []).map((d) => (
                <li key={d.name}>
                  <button type="button" className="new-diagram-recent-row" title={`Open ${d.name}.flow`} onClick={() => onOpenDiagram(d.name)}>
                    <Icon name="flow" />
                    <span className="new-diagram-recent-text">
                      <span className="new-diagram-recent-name">{d.name}.flow</span>
                      <span className="new-diagram-recent-meta">
                        {DIAGRAM_KIND_WORD[d.kind]}, {agoText(now.getTime() - d.modifiedMs)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </Dialog>
  );
}
