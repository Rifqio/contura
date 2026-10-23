import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Kbd from "./Kbd";

/** Item 4: what the larger editor names above and under its text. */
export interface LargeEditor {
  /** The column and its type, such as "notes text". */
  column: string;
  /** Where the value is, such as "row 4, id 88502". */
  where: string;
  /** What keeping the value does, such as "Becomes a Pending Edit. Nothing is written until you save." */
  note: string;
  /** Sets the cell to NULL; absent when it cannot be. */
  onSetNull?(): void;
}

interface Props {
  initial: string;
  /** Enter adds a line instead of keeping the value; Ctrl+Enter keeps it. */
  multiline: boolean;
  /** `blurred` is true when focus left the editor, so the grid doesn't take focus back. */
  onCommit(value: string, move: "down" | "right" | "none", blurred?: boolean): void;
  onCancel(): void;
  /** Ctrl+S: keep the value, then save. */
  onSave?(value: string): void;
  /** Told on every change, so the grid can keep the value before it acts. */
  onInput?(value: string): void;
  /** One line with a native suggestion list (the designer's Type cell, D26); `id` names the list. */
  suggestions?: { id: string; values: string[] };
  /** Item 4: edit in a larger panel under the cell, for long values in narrow columns. */
  large?: LargeEditor;
  /** Shift+F2 in the cell: open the larger panel with what is typed so far. */
  onLarger?(value: string): void;
}

/** The editor that opens inside a grid cell. Leaving it keeps the value. */
export default function CellEditor({ initial, multiline, onCommit, onCancel, onSave, onInput, suggestions, large, onLarger }: Props) {
  const [value, setValue] = useState(initial);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Set once a key kept or dropped the value, so the blur that follows does nothing. */
  const done = useRef(false);

  // Before paint and inside the key press that opened the editor, so that key is typed here (item 47).
  useLayoutEffect(() => {
    const box = areaRef.current ?? inputRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);

  function finish(run: () => void) {
    done.current = true;
    run();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      finish(onCancel);
    } else if (e.key.toLowerCase() === "s" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finish(() => (onSave ? onSave(value) : onCommit(value, "none")));
    } else if (e.key === "F2" && e.shiftKey && onLarger && !large) {
      e.preventDefault();
      finish(() => onLarger(value));
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finish(() => onCommit(value, "none"));
    } else if (e.key === "Enter" && !multiline && !large && !e.shiftKey) {
      e.preventDefault();
      finish(() => onCommit(value, "down"));
    } else if (e.key === "Tab" && !large) {
      e.preventDefault();
      finish(() => onCommit(value, "right"));
    }
  }

  const change = (next: string) => {
    setValue(next);
    onInput?.(next);
  };
  const blur = () => !done.current && finish(() => onCommit(value, "none", true));

  if (suggestions) {
    return (
      <>
        <input
          ref={inputRef}
          type="text"
          className="cell-editor"
          aria-label="Cell value"
          list={suggestions.id}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={blur}
        />
        <datalist id={suggestions.id}>
          {suggestions.values.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </>
    );
  }

  if (large) return <LargePanel value={value} large={large} areaRef={areaRef} change={change} onKeyDown={onKeyDown} blur={blur} finish={finish} onCommit={onCommit} onCancel={onCancel} />;

  return (
    <>
      {onLarger && (
        <span className="cell-editor-tip" aria-hidden="true">
          <Kbd keys="Shift+F2" /> opens larger
        </span>
      )}
      <textarea
      ref={areaRef}
      className={multiline ? "cell-editor cell-editor-multiline" : "cell-editor"}
      aria-label="Cell value"
      value={value}
      rows={multiline ? 4 : 1}
      spellCheck={false}
      onChange={(e) => change(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={blur}
    />
    </>
  );
}

/**
 * The larger editor (frame Table, "Long value"): a panel under the cell with the column, where the value is and
 * how long it is, a tall text box, Set NULL, Cancel and Set value. Enter adds a line; Ctrl+Enter keeps the value.
 */
function LargePanel(p: {
  value: string;
  large: LargeEditor;
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
  change(v: string): void;
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void;
  blur(): void;
  finish(run: () => void): void;
  onCommit(value: string, move: "down" | "right" | "none", blurred?: boolean): void;
  onCancel(): void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const cell = anchor.current?.closest("td")?.getBoundingClientRect();
    if (!cell) return;
    const width = 440;
    setAt({ left: Math.max(8, Math.min(cell.left, window.innerWidth - width - 8)), top: Math.min(cell.bottom + 4, window.innerHeight - 300) });
  }, []);
  const count = [...p.value].length;
  // A press on the panel's buttons must not blur the text first (the blur keeps the value).
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <>
      <span ref={anchor} className="cell-editor-anchor">
        {p.value.split("\n")[0]}
      </span>
      {createPortal(
        <div
          ref={panel}
          className="cell-large"
          role="dialog"
          aria-label={`Edit ${p.large.column.split(" ")[0]}`}
          style={at ?? { visibility: "hidden" }}
          data-sublayer
        >
          <div className="cell-large-head">
            <span className="cell-large-column">{p.large.column}</span>
            <span className="cell-large-where">{p.large.where}</span>
            <span className="spacer" />
            <span className="cell-large-count">
              {count.toLocaleString("en-US")} {count === 1 ? "character" : "characters"}
            </span>
          </div>
          <textarea
            ref={p.areaRef}
            className="cell-large-text"
            aria-label="Cell value"
            value={p.value}
            rows={8}
            spellCheck={false}
            onChange={(e) => p.change(e.target.value)}
            onKeyDown={p.onKeyDown}
            onBlur={p.blur}
          />
          <div className="cell-large-foot">
            {p.large.onSetNull && (
              <button type="button" className="button button-small button-quiet" onMouseDown={keep} onClick={() => p.finish(() => p.large.onSetNull?.())}>
                Set NULL
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="button button-small" onMouseDown={keep} onClick={() => p.finish(p.onCancel)}>
              Cancel <Kbd keys="Esc" />
            </button>
            <button type="button" className="button button-small button-primary" onMouseDown={keep} onClick={() => p.finish(() => p.onCommit(p.value, "none"))}>
              Set value <Kbd keys="Ctrl+Enter" />
            </button>
          </div>
          <p className="cell-large-note">{p.large.note}</p>
        </div>,
        document.body,
      )}
    </>
  );
}
