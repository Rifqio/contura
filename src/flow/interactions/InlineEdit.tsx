// The shared in-place editor (ER build A; diagram fix plan step 3): one text field drawn on the shape itself,
// for an ER table or column today and every kind's labels later. Enter keeps it, Tab and Shift+Tab keep it
// and move on, Escape puts it back, and a click away keeps it, as draw.io and Figma do (F4, F5): typed text is
// never thrown away by leaving the field. The caller decides what each way out means and may keep the field
// open with an error, shown under it, whichever way it was left; only Escape discards.
import { type CSSProperties, useEffect, useRef } from "react";

/** How the field was left: a key, or a click away (`blur`). */
export type CommitHow = "enter" | "tab" | "shifttab" | "blur";

interface Props {
  /** The text it opens with, selected. */
  value: string;
  /** The field's accessible name ("Column name"). */
  label: string;
  placeholder?: string;
  className?: string;
  /** Placed on the field's wrapper, so it can sit over a shape (absolute, in flow coordinates). */
  style?: CSSProperties;
  wrapClassName?: string;
  /** Why the last commit was refused; the field stays open and shows it. */
  error?: string | null;
  /** Changes with each refusal, so the same reason again still brings focus back. */
  errorKey?: number;
  /** A `<datalist>` id to suggest from. */
  list?: string;
  onCommit(value: string, how: CommitHow): void;
  onCancel(): void;
}

export default function InlineEdit({ value, label, placeholder, className, style, wrapClassName, error, errorKey, list, onCommit, onCancel }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  /** Left by a key: the blur that follows as the field goes is not a second commit. */
  const left = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: false });
    el.select();
  }, []);
  // A refused commit keeps the field open and live, with focus back in it so Escape works at once (a click away
  // included: only Escape discards).
  useEffect(() => {
    if (!error) return;
    left.current = false;
    ref.current?.focus();
  }, [error, errorKey]);
  const leave = (how: CommitHow) => {
    if (left.current) return;
    left.current = how !== "blur";
    onCommit(ref.current?.value.trim() ?? "", how);
  };
  return (
    <span className={wrapClassName ? `inline-edit-wrap ${wrapClassName}` : "inline-edit-wrap"} style={style}>
      <input
        ref={ref}
        className={`inline-edit nodrag nopan nowheel${error ? " is-bad" : ""}${className ? ` ${className}` : ""}`}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        placeholder={placeholder}
        defaultValue={value}
        list={list}
        spellCheck={false}
        autoComplete="off"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onChange={() => {
          left.current = false;
        }}
        onKeyDown={(e) => {
          // The canvas's keys (Delete, arrows, tools) are not for a field being typed in.
          e.stopPropagation();
          // A key that confirms or cancels an IME candidate is the IME's, not the field's. WebKit (both Tauri
          // targets) ends the composition before the confirming keydown, which then has keyCode 229.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            // A key is always a fresh try, even with the same reason still shown.
            left.current = false;
            leave("enter");
          } else if (e.key === "Tab") {
            e.preventDefault();
            left.current = false;
            leave(e.shiftKey ? "shifttab" : "tab");
          } else if (e.key === "Escape") {
            e.preventDefault();
            left.current = true;
            onCancel();
          }
        }}
        onBlur={() => leave("blur")}
      />
      {error && (
        <span className="inline-edit-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
