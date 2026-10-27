// The board's top toolbar (Decisions 18, 19, 24 and 28): Select and Hand, the drawing tools with nothing selected or
// the selected frame's kind tools, Section and Note, More shapes, then Add and Ask. A WAI-ARIA toolbar: one tab stop, the arrow
// keys, Home and End move along it. Each icon tool shows its key in the corner and a hint with its name and key on
// hover and focus (Figma, Excalidraw).
import { type KeyboardEvent, useRef, useState } from "react";
import Icon from "../../components/Icon";
import Kbd from "../../components/Kbd";
import type { DiagramKind } from "../../lang/flow/model";
import { GENERIC_TOOLS, HAND_TOOL, KIND_TOOLS, NOTE_TOOL, SECTION_TOOL, SELECT_TOOL, type Tool } from "./kindTools";

interface Props {
  /** The selected frame's kind; null with no frame selected (the drawing tools show). */
  kind: DiagramKind | null;
  /** The armed tool's id ("select" when none is). */
  armed: string;
  /** The assistant's changes waiting for review, counted on Ask. */
  pending: number;
  /** A tool was picked; `pointer` when by a click, not a key. */
  onArm(id: string, pointer?: boolean): void;
  onAdd(): void;
  onAsk(): void;
  onMoreShapes(): void;
  /** The Shelf is open from Add (or `/`). */
  addOpen?: boolean;
  /** The Shelf is open from More shapes. */
  moreOpen?: boolean;
  /** The open Shelf's id, which Add and More shapes control (R27). */
  shelfId?: string;
}

const count = (n: number) => n.toLocaleString("en-US");

export default function BoardToolbar({ kind, armed, pending, onArm, onAdd, onAsk, onMoreShapes, addOpen = false, moreOpen = false, shelfId }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  /** The one tab stop: the button last moved to or focused. */
  const [stop, setStop] = useState(0);
  const tools: Tool[] = kind ? KIND_TOOLS[kind] : GENERIC_TOOLS;
  const buttons = () => Array.from(bar.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  const total = 2 + tools.length + 2 + (kind ? 1 : 0) + 2;
  const tabStop = Math.min(stop, total - 1);
  let at = 0;
  const roving = () => {
    const i = at++;
    return { tabIndex: i === tabStop ? 0 : -1, onFocus: () => setStop(i) };
  };

  const onKey = (e: KeyboardEvent) => {
    const all = buttons();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      e.key === "ArrowRight" ? (i + 1) % all.length : e.key === "ArrowLeft" ? (i - 1 + all.length) % all.length : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : null;
    if (to === null || i < 0) return;
    // The canvas would nudge the selection with these keys.
    e.preventDefault();
    e.stopPropagation();
    setStop(to);
    all[to]?.focus();
  };

  const toolButton = (t: Tool) => (
    <button
      key={t.id}
      type="button"
      className="flow-tool board-tool"
      aria-label={t.name}
      aria-keyshortcuts={t.key}
      aria-pressed={armed === t.id}
      onClick={(e) => onArm(t.id, e.detail > 0)}
      {...roving()}
    >
      <Icon name={t.icon} />
      <span className="board-tool-key" aria-hidden="true">
        {t.key}
      </span>
      <span className="flow-hint" aria-hidden="true">
        {t.name}
        <Kbd keys={t.key} />
      </span>
    </button>
  );

  return (
    <div ref={bar} className="board-toolbar nodrag nopan" role="toolbar" aria-label="Board tools" onKeyDown={onKey}>
      {toolButton(SELECT_TOOL)}
      {toolButton(HAND_TOOL)}
      <span className="flow-toolbar-divider" aria-hidden="true" />
      {tools.map(toolButton)}
      <span className="flow-toolbar-divider" aria-hidden="true" />
      {toolButton(SECTION_TOOL)}
      {toolButton(NOTE_TOOL)}
      {kind && (
        <button
          type="button"
          className={moreOpen ? "flow-tool board-tool is-on" : "flow-tool board-tool"}
          data-tool="more"
          aria-label="More shapes"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-controls={shelfId}
          onClick={onMoreShapes}
          {...roving()}
        >
          <Icon name="shapes" />
          <span className="flow-hint" aria-hidden="true">
            More shapes
          </span>
        </button>
      )}
      <span className="flow-toolbar-divider" aria-hidden="true" />
      <button
        type="button"
        className="board-add"
        data-tool="add"
        aria-label="Add"
        aria-keyshortcuts="/"
        aria-haspopup="dialog"
        aria-expanded={addOpen}
        aria-controls={shelfId}
        onClick={onAdd}
        {...roving()}
      >
        <Icon name="plus" />
        <span>Add</span>
        <span className="flow-hint" aria-hidden="true">
          Add a diagram
          <Kbd keys="/" />
        </span>
      </button>
      <button
        type="button"
        className="board-ask"
        aria-label="Ask"
        aria-keyshortcuts="Control+J"
        aria-description={pending > 0 ? `${count(pending)} ${pending === 1 ? "change" : "changes"} to review` : undefined}
        onClick={onAsk}
        {...roving()}
      >
        <Icon name="sparkles" />
        <span>Ask</span>
        {pending > 0 && (
          <span className="board-ask-count" aria-hidden="true">
            {count(pending)}
          </span>
        )}
        <span className="flow-hint" aria-hidden="true">
          Ask the assistant
          <Kbd keys="Ctrl+J" />
        </span>
      </button>
    </div>
  );
}
