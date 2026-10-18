import { type KeyboardEvent, useEffect, useRef, useState } from "react";

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
}

/** The editor that opens inside a grid cell. Leaving it keeps the value. */
export default function CellEditor({ initial, multiline, onCommit, onCancel, onSave, onInput, suggestions }: Props) {
  const [value, setValue] = useState(initial);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Set once a key kept or dropped the value, so the blur that follows does nothing. */
  const done = useRef(false);

  useEffect(() => {
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
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finish(() => onCommit(value, "none"));
    } else if (e.key === "Enter" && !multiline && !e.shiftKey) {
      e.preventDefault();
      finish(() => onCommit(value, "down"));
    } else if (e.key === "Tab") {
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

  return (
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
  );
}
