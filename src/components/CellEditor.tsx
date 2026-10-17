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
}

/** The editor that opens inside a grid cell. Leaving it keeps the value. */
export default function CellEditor({ initial, multiline, onCommit, onCancel, onSave, onInput }: Props) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  /** Set once a key kept or dropped the value, so the blur that follows does nothing. */
  const done = useRef(false);

  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);

  function finish(run: () => void) {
    done.current = true;
    run();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
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

  return (
    <textarea
      ref={ref}
      className={multiline ? "cell-editor cell-editor-multiline" : "cell-editor"}
      aria-label="Cell value"
      value={value}
      rows={multiline ? 4 : 1}
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
        onInput?.(e.target.value);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => !done.current && finish(() => onCommit(value, "none", true))}
    />
  );
}
