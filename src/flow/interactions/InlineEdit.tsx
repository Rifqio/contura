// The shared in-place editor (diagram steps 3 and 6): one text field drawn on the shape itself, for any kind's
// label, a class member, a line's label and a new group's title. Enter keeps it,
// Tab and Shift+Tab keep it and move on, and a click away keeps it, as draw.io and Figma do (F4, F5). Escape keeps
// the typed text and ends the edit too (the user's decision of 25 Oct; draw.io, Miro and Figma), with two edges:
// a new item still untouched or emptied is dropped (`fresh`), and a value the caller refused is never kept, so the
// first Escape leaves the field open with its reason and a second one puts the old value back. Typed text is never
// dropped silently. The caller decides what each way out means and may keep the field open with an error.
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";

/** How the field was left: a key, Escape, or a click away (`blur`). */
export type CommitHow = "enter" | "tab" | "shifttab" | "escape" | "blur";

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
  /** A new item: Escape with its text untouched, or emptied, drops it (nothing written, no undo step). */
  fresh?: boolean;
  /** The name may hold a line break: Shift+Enter starts a new line (written `\n` in quotes, ADR 0019 P5). */
  multiline?: boolean;
  /** For a name that stays on one line: what Shift+Enter says instead of breaking it. */
  oneLine?: string;
  onCommit(value: string, how: CommitHow): void;
  onCancel(): void;
  /** Each change of the typed text (diagram build 3: a new topic's ghost grows with its name). */
  onInput?(value: string): void;
}

export default function InlineEdit({ value, label, placeholder, className, style, wrapClassName, error, errorKey, list, fresh, multiline, oneLine, onCommit, onCancel, onInput }: Props) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  /** Left by a key: the blur that follows as the field goes is not a second commit. */
  const left = useRef(false);
  /** Typed into since it opened, and since the last refusal. */
  const touched = useRef(false);
  const sinceError = useRef(false);
  /** The last try was an Escape: one more, on the same refused value, puts the old value back. */
  const escaped = useRef(false);
  const [hint, setHint] = useState<string | null>(null);
  const [rows, setRows] = useState(() => Math.max(1, value.split("\n").length));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: false });
    el.select();
    // A long name that wraps opens at its full height, not clipped until the first key (N6).
    if (multiline && el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, []);
  // A refused commit keeps the field open and live, with focus back in it so Escape works at once (a click away
  // included).
  useEffect(() => {
    if (!error) return;
    left.current = false;
    sinceError.current = false;
    ref.current?.focus();
  }, [error, errorKey]);
  const text = () => {
    const v = ref.current?.value ?? "";
    return multiline ? v.replace(/^\s+|\s+$/g, "").replace(/[ \t]+\n|\n[ \t]+/g, "\n") : v.trim();
  };
  const leave = (how: CommitHow) => {
    if (left.current) return;
    left.current = how !== "blur";
    escaped.current = how === "escape";
    onCommit(text(), how);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // The canvas's keys (Delete, arrows, tools) are not for a field being typed in.
    e.stopPropagation();
    // A key that confirms or cancels an IME candidate is the IME's, not the field's. WebKit (both Tauri targets)
    // ends the composition before the confirming keydown, which then has keyCode 229.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && e.shiftKey && !(e.ctrlKey || e.metaKey)) {
      // A new line where the name may hold one; else the name stays on one line and the field says so.
      if (multiline) return;
      e.preventDefault();
      if (oneLine) setHint(oneLine);
      return;
    }
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
      const refused = !!error && !sinceError.current && escaped.current;
      // A refused value cannot be kept: the second Escape puts the old one back. A new item never typed into, or
      // emptied, is dropped.
      if (refused || (fresh && (!touched.current || text() === ""))) {
        left.current = true;
        onCancel();
        return;
      }
      left.current = false;
      leave("escape");
    }
  };
  const common = {
    className: `inline-edit nodrag nopan nowheel${error ? " is-bad" : ""}${className ? ` ${className}` : ""}`,
    "aria-label": label,
    "aria-invalid": error ? true : undefined,
    placeholder,
    defaultValue: value,
    spellCheck: false,
    autoComplete: "off",
    onPointerDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
    onDoubleClick: (e: { stopPropagation(): void }) => e.stopPropagation(),
    onClick: (e: { stopPropagation(): void }) => e.stopPropagation(),
    onChange: (e: { currentTarget: { value: string } }) => {
      left.current = false;
      touched.current = true;
      sinceError.current = true;
      setHint(null);
      onInput?.(e.currentTarget.value);
      if (multiline) {
        const n = Math.max(1, e.currentTarget.value.split("\n").length);
        if (n !== rows) setRows(n);
        // Wrapped text grows the field too, not only line breaks (fix round 1, M7).
        const el = e.currentTarget as unknown as HTMLElement;
        el.style.height = "auto";
        if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
      }
    },
    onKeyDown,
    onBlur: () => leave("blur"),
  };
  return (
    <span className={wrapClassName ? `inline-edit-wrap ${wrapClassName}` : "inline-edit-wrap"} style={style}>
      {multiline ? <textarea ref={ref} rows={rows} {...common} /> : <input ref={ref} list={list} {...common} />}
      {error && (
        <span className="inline-edit-error" role="alert">
          {error}
        </span>
      )}
      {!error && hint && (
        <span className="inline-edit-hint" role="status">
          {hint}
        </span>
      )}
    </span>
  );
}
