// The New diagram dialog (decision 18): the Shelf's catalog in a dialog, Diagrams on the left and the templates on the
// right. A pick writes a new file in Contura's diagrams folder and opens its tab: a kind as "Untitled diagram" made free,
// a template under its own name made free. From my database and From Mermaid hand over to their own dialogs, which come
// back here with the search kept. There is no name field; File > Rename renames.
import { useRef, useState } from "react";
import { errorText, isCommandError, listDiagrams } from "../api/client";
import Kbd from "../components/Kbd";
import Dialog from "../components/Dialog";
import type { DiagramKind } from "../lang/flow/model";
import Shelf from "./board/shelf/Shelf";
import type { ShelfItem } from "./board/shelf/types";
import { templateById } from "./board/catalog/templates";
import { blankText } from "./diagramKinds";
import { frameHeaders } from "../lang/flow/board";
import { parseFlowLayout, serializeFlowLayout } from "./layout";
import { writeFreeDiagram } from "./writeFreeDiagram";

interface Props {
  /** The search the catalog opens with: Back from Mermaid or From my database keeps it. */
  initialQuery: string;
  /** The file was written: open its tab and put focus in its text. */
  onCreated(name: string): void;
  /** From Mermaid: its dialog takes over, with the search for its Back. */
  onMermaid(query: string): void;
  /** From my database: its dialog takes over, with the search for its Back. */
  onDatabase(query: string): void;
  onClose(): void;
}

const DEFAULT_NAME = "Untitled diagram";

/** The kind a template's first frame names in its header; a template without one is a bug, so it fails loudly. */
export function firstKind(text: string): DiagramKind {
  const kind = frameHeaders(text)[0]?.kind;
  if (!kind) throw new Error("A template's first frame has no diagram kind in its header.");
  return kind;
}

/** What a pick writes: the file's name, its text and the kind its layout is made for. */
function fileFor(item: ShelfItem): { base: string; text: (name: string) => string; kind: DiagramKind } | null {
  if (item.kind === "diagram") return { base: DEFAULT_NAME, text: (name) => blankText(item.diagram, name), kind: item.diagram };
  if (item.kind !== "template") return null;
  const t = templateById(item.id);
  if (!t) return null;
  if ("frames" in t) return { base: t.name, text: () => t.frames.join("\n"), kind: firstKind(t.frames[0]) };
  return { base: t.name, text: () => t.text, kind: t.kind };
}

export default function NewDiagramDialog({ initialQuery, onCreated, onMermaid, onDatabase, onClose }: Props) {
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);
  const query = useRef(initialQuery);

  async function create(item: ShelfItem) {
    const file = fileFor(item);
    if (!file || busy.current) return;
    busy.current = true;
    setMessage(null);
    try {
      const taken = (await listDiagrams()).map((d) => d.name);
      // One frame and a v1 layout of its kind is the old single-diagram format, so B1's bytes stay as they were.
      const layout = serializeFlowLayout(parseFlowLayout(null, file.kind));
      onCreated(await writeFreeDiagram(file.base, taken, file.text, layout));
    } catch (e) {
      setMessage(isCommandError(e) && e.kind === "diagramExists" ? `${e.message.name}.flow already exists. Try again.` : errorText(e));
    } finally {
      busy.current = false;
    }
  }

  function add(item: ShelfItem) {
    if (item.kind === "fromMermaid") onMermaid(query.current);
    else if (item.kind === "fromDatabase") onDatabase(query.current);
    else void create(item);
  }

  return (
    <Dialog title="New diagram" subtitle="Pick a kind or start from a template. Rename it any time from the File menu." className="new-diagram-catalog" onClose={onClose}>
      <div className="dialog-body">
        <Shelf id="new-diagram-catalog" host="new" frameKind={null} initialQuery={initialQuery} onQuery={(q) => (query.current = q)} onAdd={add} onClose={() => {}} />
        {message && (
          <p className="error-text" role="alert">
            {message}
          </p>
        )}
        <p className="new-diagram-keys">
          <Kbd keys="Tab" /> switches sides <Kbd keys="Up" /> <Kbd keys="Down" /> move <Kbd keys="Enter" /> creates <Kbd keys="Ctrl+PageUp" />{" "}
          <Kbd keys="Ctrl+PageDown" /> switch the template tabs <Kbd keys="Esc" /> closes
        </p>
      </div>
    </Dialog>
  );
}
