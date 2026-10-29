// The board assistant's start screen (Plan D Decision 15, owner answers 2 and 6): an empty chat asks what to create
// over the nine kind cards, B2's Diagrams-tab cards and roles (A17: one listbox of options, the Shelf's order, arrows
// move and Enter picks), then offers Template (the board Shelf on its templates side) and File (one text file read by
// the Core's own dialog). ChatGPT's, Claude's and FigJam AI's empty chats: a question over starting points.
import { type KeyboardEvent, useCallback, useId, useRef, useState } from "react";
import Icon from "../../components/Icon";
import type { DiagramKind } from "../../lang/flow/model";
import DiagramsTab from "../board/shelf/DiagramsTab";
import { isListKey } from "../board/shelf/list";
import type { ShelfItem } from "../board/shelf/types";

interface Props {
  /** A kind card was picked: the "New <kind>" chip goes on the composer. */
  onKind(kind: DiagramKind): void;
  /** Template: the board Shelf opens on its templates. */
  onTemplate(): void;
  /** File: the Core's open dialog, then the file's chip. */
  onFile(): void;
  /** Why the last file could not be attached, or null. */
  fileNote: string | null;
}

/**
 * The listbox owns focus here, not a search: the arrows of a grid step through the cards in reading order (Left and
 * Right as Up and Down), and Home and End jump, as Ctrl+Home and Ctrl+End do on the Shelf.
 */
function asListKey(e: KeyboardEvent): KeyboardEvent {
  const key = e.key === "ArrowRight" ? "ArrowDown" : e.key === "ArrowLeft" ? "ArrowUp" : e.key;
  const jump = (e.key === "Home" || e.key === "End") && !e.altKey;
  return { key, ctrlKey: jump || e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, keyCode: e.keyCode, nativeEvent: e.nativeEvent } as KeyboardEvent;
}

const noDrag = (_: ShelfItem, e: { preventDefault(): void }) => e.preventDefault();

export default function StartScreen({ onKind, onTemplate, onFile, fileNote }: Props) {
  const id = useId();
  const headingId = `${id}h`;
  const keys = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const registerKeys = useCallback((handler: (e: KeyboardEvent) => boolean) => {
    keys.current = handler;
  }, []);
  const [active, setActive] = useState<string | undefined>();
  const add = useCallback((item: ShelfItem) => item.kind === "diagram" && onKind(item.diagram), [onKind]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    const k = asListKey(e);
    if (isListKey(k) && keys.current?.(k)) e.preventDefault();
  }

  return (
    <section className="ai-start" aria-labelledby={headingId}>
      <h2 id={headingId} className="ai-start-title">
        What would you like to create?
      </h2>
      <div className="ai-start-kinds">
        <DiagramsTab
          query=""
          active
          frameKind={null}
          registerKeys={registerKeys}
          setActiveDescendant={setActive}
          add={add}
          beginDrag={noDrag}
          listboxId={`${id}k`}
          still
          listbox={{ tabIndex: 0, "aria-labelledby": headingId, "aria-activedescendant": active, onKeyDown }}
        />
      </div>
      <p className="ai-start-sub">Already have something to start with?</p>
      <div className="ai-start-acts">
        <button type="button" className="btn pbtn2" onClick={onTemplate}>
          <Icon name="layers" size={14} />
          Template
        </button>
        <button type="button" className="btn pbtn2" onClick={onFile}>
          <Icon name="fileCode" size={14} />
          File
        </button>
      </div>
      {fileNote && (
        <p className="msg-notice" role="alert">
          {fileNote}
        </p>
      )}
    </section>
  );
}
