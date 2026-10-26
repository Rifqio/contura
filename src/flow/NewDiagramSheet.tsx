// The New diagram sheet (frame 6+.6, extended in step 12 by frame NewDiagram): pick the kind from drawn
// previews, found by a word or by group (Data, Software, Planning), name it, create. The file goes in Contura's
// diagrams folder by name, so there is no folder to choose; Mermaid has its own way in, and the recent diagrams
// sit beside it.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { errorText, isCommandError, listDiagrams, writeDiagram } from "../api/client";
import type { DiagramEntry } from "../api/types";
import { hintFor } from "../commands/keymap";
import { useKeymap } from "../commands/useCommandKeys";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import { exportPalette } from "../diagram/export/palette";
import { exampleSvg } from "./previewScene";
import Kbd from "../components/Kbd";
import { agoText } from "../format/units";
import { DIAGRAM_KINDS, type DiagramKind, flowName, quote } from "../lang/flow/model";
import { DIAGRAM_KIND_WORD, freeDiagramName, typedDiagramName } from "./diagramKinds";

export { freeDiagramName };
import { parseFlowLayout, serializeFlowLayout } from "./layout";
import Segmented from "../components/Segmented";

/** What the sheet was left at, so Back from the Mermaid dialog opens it the same (step 10, VS Code's multi-step Back). */
export interface SheetState {
  kind: DiagramKind;
  name: string;
  start: "example" | "blank";
  query: string;
  group: "all" | "data" | "software" | "planning";
}

interface Props {
  onClose(): void;
  /** The diagram was written: open its tab and put focus in its text. */
  onCreated(name: string): void;
  /** From Mermaid... : the Mermaid dialog takes over, with what the sheet was left at for its Back. */
  onMermaid(state: SheetState): void;
  /** Back from the Mermaid dialog: the sheet as it was left. */
  initial?: SheetState;
  /** Runs before a Replace writes over diagram `name`: its open tab goes first (ruling P19). */
  beforeReplace?(name: string): void | Promise<void>;
  /** A Recent diagram was picked. */
  onOpenDiagram(name: string): void;
  /** The clock Recent's times are measured from; tests fix it. */
  now?: Date;
}

/** Recent rows shown in the right column. */
const RECENT_SHOWN = 8;

type KindGroup = "data" | "software" | "planning";

/** Each kind's card; `group` sorts them under the switch. */
const CARDS: Record<DiagramKind, { title: string; text: string; group: KindGroup }> = {
  dfd: { title: "Data flow", text: "Processes, data stores and outside parties. Stores can link to tables.", group: "data" },
  flow: { title: "Flowchart", text: "Steps, decisions, input and output, start and end.", group: "data" },
  cloud: { title: "Cloud architecture", text: "Services as provider icons, grouped by network or layer.", group: "software" },
  er: { title: "ER diagram", text: "Tables with their columns and the relationships between them.", group: "data" },
  sequence: { title: "Sequence", text: "Who calls whom, in order: requests, replies and waits.", group: "software" },
  state: { title: "State", text: "States and the events that move between them.", group: "software" },
  class: { title: "Class", text: "Types with their fields and methods, and how they extend each other.", group: "software" },
  mindmap: { title: "Mind map", text: "One idea in the middle, branches out from it.", group: "planning" },
  timeline: { title: "Timeline", text: "Dated events and periods along one line.", group: "planning" },
};

/** Every kind, in the language's order (DIAGRAM_KINDS). */
export const KINDS: { kind: DiagramKind; title: string; text: string; group: KindGroup }[] = DIAGRAM_KINDS.map((kind) => ({ kind, ...CARDS[kind] }));

const GROUPS: { value: "all" | KindGroup; label: string }[] = [
  { value: "all", label: "All" },
  { value: "data", label: "Data" },
  { value: "software", label: "Software" },
  { value: "planning", label: "Planning" },
];

/** The kinds a typed word finds: by title, kind word or description, ignoring case. */
export function findKinds(query: string, group: "all" | KindGroup): typeof KINDS {
  const q = query.trim().toLowerCase();
  return KINDS.filter((k) => (group === "all" || k.group === group) && (!q || `${k.title} ${k.kind} ${k.text}`.toLowerCase().includes(q)));
}

/** The new file's text: only the first line, which names the kind and the title. */
export function newDiagramText(kind: DiagramKind, name: string): string {
  return `diagram ${kind} ${quote(name)}\n`;
}

/** A blank start (draw.io's Blank Diagram): the first line; a mind map keeps its central idea, the diagram's name. */
export function blankText(kind: DiagramKind, name: string): string {
  return kind === "mindmap" ? `${newDiagramText(kind, name)}root ${flowName(name)}\n` : newDiagramText(kind, name);
}

/** Each kind's example (board DiagramStartWell; draw.io's templates, Mermaid Live's samples), after the first line. */
const EXAMPLES: Partial<Record<DiagramKind, string[]>> = {
  dfd: [
    "Customer [entity, id: E1]",
    "Take order [process, id: 1.0]",
    "Orders [store, id: D1]",
    "Bill customer [process, id: 2.0]",
    "",
    "Customer > Take order: order details",
    "Take order > Orders: new order",
    "Orders > Bill customer: order",
    "Bill customer > Customer: invoice",
  ],
  flow: [
    "Order in [start]",
    "Check stock",
    "In stock? [decision]",
    "Ship order",
    "Back-order",
    "note: Stock is checked against the warehouse feed",
    "",
    "Order in > Check stock",
    "Check stock > In stock?",
    "In stock? > Ship order: yes",
    "In stock? > Back-order: no",
  ],
  cloud: [
    "Users [icon: users]",
    "AWS [icon: aws-cloud] {",
    "  Gateway [icon: aws-api-gateway]",
    "  Orders API [icon: aws-lambda]",
    "  Orders table [icon: aws-dynamodb]",
    "  Receipts [icon: aws-s3]",
    "}",
    "",
    "Users > Gateway: HTTPS",
    "Gateway > Orders API",
    "Orders API <> Orders table",
    "Orders API > Receipts",
  ],
  er: [
    "customers {",
    "  id int pk",
    "  email text not null unique",
    "}",
    "orders {",
    "  id int pk",
    "  customer_id int not null",
    "  total numeric",
    "}",
    "",
    "orders.customer_id > customers.id",
  ],
  sequence: [
    "actor Customer",
    "participant Shop",
    "participant Payments",
    "Customer -> Shop: place order",
    "Shop -> Payments: charge card",
    "Payments --> Shop: approved",
    "Shop --> Customer: receipt",
  ],
  state: ["Draft", "Sent", "Paid", "Overdue", "", "[*] > Draft", "Draft > Sent: send", "Sent > Paid: payment", "Sent > Overdue: due date passes", "Overdue > Paid: payment", "Paid > [*]"],
  class: [
    "interface Payable",
    "Payable : pay(amount)",
    "class Invoice",
    "Invoice : + id: int",
    "Invoice : + total: numeric",
    "Invoice : + send()",
    "enum InvoiceStatus",
    "InvoiceStatus : DRAFT",
    "InvoiceStatus : SENT",
    "InvoiceStatus : PAID",
    "class LineItem",
    "LineItem : + qty: int",
    "LineItem : + price: numeric",
    "",
    "Payable <|-- Invoice",
    "Invoice *-- LineItem: lines",
    "Invoice --> InvoiceStatus",
  ],
  mindmap: ["root Q4 plan", "  Diagrams", "    New kinds", "    Inline editing", "  Redis", "  Release", "    Docs"],
  timeline: ["2026-09-01 to 2026-10-15: Build", "2026-10-19: Beta", "2026-11-09: Release candidate", "milestone Launch"],
};

/** The kind's example under the diagram's name: shapes, lines and text to change or delete. */
export function exampleText(kind: DiagramKind, name: string): string {
  const body = EXAMPLES[kind];
  return body ? `${newDiagramText(kind, name)}${body.join("\n")}\n` : blankText(kind, name);
}

const DEFAULT_NAME = "Untitled diagram";

/**
 * The drawn preview of each kind: its real example, drawn as Publish draws it (fix round 1, M8; board DiagramStartWell).
 * Made once per theme for all cards, and kept: nine small SVG strings.
 */
const drawings = new Map<string, Map<DiagramKind, string>>();
function drawingsFor(theme: "light" | "dark"): Map<DiagramKind, string> {
  let m = drawings.get(theme);
  if (!m) {
    const palette = exportPalette(theme);
    m = new Map(KINDS.map((k) => [k.kind, exampleSvg(exampleText(k.kind, k.title), palette)] as const));
    drawings.set(theme, m);
  }
  return m;
}

/** The theme the window shows now: its `data-theme`, else Windows' own. */
function shownTheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function Preview({ kind, theme }: { kind: DiagramKind; theme: "light" | "dark" }) {
  const svg = drawingsFor(theme).get(kind) ?? "";
  return (
    <div className="new-diagram-preview" aria-hidden="true">
      <div className="new-diagram-drawing" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

export default function NewDiagramSheet({ onClose, onCreated, onMermaid, initial, beforeReplace, onOpenDiagram, now = new Date() }: Props) {
  const keys = useKeymap().map;
  const [theme] = useState(shownTheme);
  const [kind, setKind] = useState<DiagramKind>(initial?.kind ?? "dfd");
  const [query, setQuery] = useState(initial?.query ?? "");
  const [group, setGroup] = useState<"all" | KindGroup>(initial?.group ?? "all");
  const shown = findKinds(query, group);
  /** F27: the selected kind follows the search and the group: a card you cannot see is never what Create makes. */
  const chosen: DiagramKind | null = shown.some((k) => k.kind === kind) ? kind : (shown[0]?.kind ?? null);
  const [start, setStart] = useState<"example" | "blank">(initial?.start ?? "example");
  /** The default name, free of every diagram there is; typing over it is the sheet's only change. */
  const [def, setDef] = useState(initial?.name ?? DEFAULT_NAME);
  const [name, setName] = useState(initial?.name ?? DEFAULT_NAME);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The file asked about: "checkout.flow already exists. Replace it?" */
  const [asking, setAsking] = useState<string | null>(null);
  const [recent, setRecent] = useState<DiagramEntry[] | null>(null);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    let live = true;
    listDiagrams().then(
      (all) => {
        if (!live) return;
        setRecent(all.slice(0, RECENT_SHOWN));
        if (initial) return;
        // The default name moves to the next free one while it is untouched.
        const free = freeDiagramName(DEFAULT_NAME, all.map((d) => d.name));
        setDef(free);
        setName((n) => (n === DEFAULT_NAME ? free : n));
      },
      () => live && setRecent([]),
    );
    return () => {
      live = false;
    };
  }, []);

  const typed = typedDiagramName(name);
  const canCreate = !busy && typed !== "" && chosen !== null;

  async function create(replace = false, picked: DiagramKind | null = chosen) {
    if (busy || typed === "" || picked === null) return;
    setBusy(true);
    setMessage(null);
    setAsking(null);
    try {
      const layout = serializeFlowLayout(parseFlowLayout(null, picked));
      if (replace) await beforeReplace?.(typed);
      await writeDiagram(typed, start === "example" ? exampleText(picked, typed) : blankText(picked, typed), layout, replace);
      onCreated(typed);
    } catch (e) {
      if (isCommandError(e) && e.kind === "diagramExists") setAsking(`${e.message.name}.flow`);
      else setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function onKinds(e: KeyboardEvent) {
    if (shown.length === 0) return;
    const at = shown.findIndex((k) => k.kind === chosen);
    // A 3-column grid: left and right move one, up and down a row.
    const by = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 3 : e.key === "ArrowUp" ? -3 : 0;
    if (by === 0) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(shown.length - 1, (at < 0 ? 0 : at) + by));
    setKind(shown[next].kind);
    cards.current[next]?.focus();
  }

  const title = chosen ? (KINDS.find((k) => k.kind === chosen) ?? KINDS[0]).title : "diagram";

  const createKey = "Enter";
  const mermaidKey = hintFor(keys, "flow.fromMermaid");

  return (
    <Dialog title="New diagram" subtitle="The kind is the first line of the file, so you can change it later." className="new-diagram" dirty={name.trim() !== def} onClose={onClose}>
      <div className="new-diagram-body">
        <div className="new-diagram-main">
          <div className="new-diagram-find">
            <label className="new-diagram-search">
              <Icon name="search" size={14} />
              <input
                className="input"
                type="search"
                aria-label="Find a kind"
                placeholder="Find a kind"
                value={query}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // The name is ready, so Enter creates at once (F27).
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  void create();
                }}
              />
            </label>
            <Segmented label="Kind group" value={group} options={GROUPS} onChange={setGroup} />
          </div>
          {shown.length === 0 && <p className="new-diagram-none">No kind matches. Try another word.</p>}
          <div className="new-diagram-kinds" role="radiogroup" aria-label="Kind" onKeyDown={onKinds}>
            {shown.map((k, i) => {
              const on = k.kind === chosen;
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
                  // A double-click on a card creates it at once (draw.io).
                  onDoubleClick={() => {
                    setKind(k.kind);
                    void create(false, k.kind);
                  }}
                >
                  {on && (
                    <span className="new-diagram-check">
                      <Icon name="check" size={14} />
                    </span>
                  )}
                  <Preview kind={k.kind} theme={theme} />
                  <span className="new-diagram-kind-text">
                    <span className="new-diagram-kind-title">
                      {k.title} <span className="new-diagram-kind-word">{k.kind}</span>
                    </span>
                    <span className="new-diagram-kind-sub">{k.text}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="new-diagram-form">
            <div className="new-diagram-start">
              <span className="new-diagram-label">Start with</span>
              <span className="new-diagram-start-pick">
                <Segmented
                  label="Start with"
                  value={start}
                  options={[
                    { value: "example", label: "Example" },
                    { value: "blank", label: "Blank" },
                  ]}
                  onChange={setStart}
                />
                <span className="new-diagram-start-hint">
                  {start === "example" ? "The card's example comes with it." : `Only the first line, diagram ${chosen ?? kind} "${typed || "name"}".`}
                </span>
              </span>
            </div>
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
            <span>Have a Mermaid diagram already?</span>
            <button
              type="button"
              className="button"
              title={mermaidKey ? `From Mermaid (${mermaidKey})` : undefined}
              onClick={() => onMermaid({ kind: chosen ?? kind, name, start, query, group })}
            >
              From Mermaid...
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
                  {`Create ${chosen === "mindmap" ? "mind map" : title.toLowerCase()}`}
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
                  <button type="button" className="new-diagram-recent-row" title={`Open ${d.name}`} onClick={() => onOpenDiagram(d.name)}>
                    <Icon name="flow" />
                    <span className="new-diagram-recent-text">
                      <span className="new-diagram-recent-name">{d.name}</span>
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
