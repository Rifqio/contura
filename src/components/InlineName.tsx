import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useToast } from "./Toast";

interface Props {
  /** The name as it is now; the input starts with it, selected. */
  value: string;
  /** The input's accessible name, such as "Rename KFC". */
  label: string;
  /** Saves the new (trimmed) name. Resolves to a message when it is not allowed, or null once saved. */
  onCommit(next: string): Promise<string | null> | string | null;
  /**
   * Leaves editing: after a save, an unchanged name, or Esc. `refocus` is true when it ended from the keyboard (Enter or
   * Esc), so the name takes focus back; after a blur, focus stays where the user put it.
   */
  onClose(refocus: boolean): void;
  maxLength?: number;
}

/**
 * A name edited in place: the input takes the label's font and size. Enter or blur saves, Esc cancels. A name that is not
 * allowed shows its message below and keeps editing after Enter; after a blur the edit is cancelled and the message is a
 * toast, so a click elsewhere never pulls focus back.
 */
export default function InlineName({ value, label, onCommit, onClose, maxLength }: Props) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  /** Set once the edit is over or a save is running, so the blur that follows does not save twice. */
  const settled = useRef(false);
  const live = useRef(true);
  const toast = useToast();

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  // Before the input leaves the page (the place changed, say), so a blur it raises on the way out saves nothing.
  useLayoutEffect(() => {
    live.current = true;
    settled.current = false;
    return () => {
      live.current = false;
      settled.current = true;
    };
  }, []);

  async function commit(byKey: boolean) {
    if (settled.current) return;
    const next = text.trim();
    settled.current = true;
    if (next === value && next !== "") {
      onClose(byKey);
      return;
    }
    let problem: string | null;
    try {
      problem = await onCommit(next);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
    if (!live.current) return;
    if (problem === null) {
      onClose(byKey);
    } else if (byKey) {
      settled.current = false;
      setError(problem);
    } else {
      toast.show({ kind: "info", text: `${value} keeps its name. ${problem}` });
      onClose(false);
    }
  }

  return (
    <span className="inline-name">
      <input
        ref={input}
        className="inline-name-input"
        value={text}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        maxLength={maxLength}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            void commit(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            settled.current = true;
            onClose(true);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onBlur={() => void commit(false)}
      />
      {error && (
        <span className="inline-name-error error-text" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
