// T1 (board DiagramEditInPlace; Preceden's event dates, Lucidchart's milestone date): a timeline item's date picked
// in a native date field on the item itself, and a period's From and Until. Tab goes from one to the other; Enter,
// Escape, Tab past the end and a click away keep the dates, as the shared in-place editor does. A refused date
// stays with its reason on the first Escape and is put back on the second.
import { type FocusEvent, type KeyboardEvent, useEffect, useRef } from "react";
import type { CommitHow } from "./InlineEdit";

interface Props {
  date: string;
  /** A period's end; absent for an event. */
  until?: string;
  error?: string | null;
  errorKey?: number;
  /** The field the refusal is about; focus goes back there (N5). */
  errorAt?: "from" | "until";
  onCommit(date: string, until: string | undefined, how: CommitHow): void;
  onCancel(): void;
}

/** A native date field holds only a whole day: a month or a year shows empty until one is picked. */
const dayOnly = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "");

export default function DateEdit({ date, until, error, errorKey, errorAt, onCommit, onCancel }: Props) {
  const wrap = useRef<HTMLSpanElement>(null);
  const from = useRef<HTMLInputElement>(null);
  const to = useRef<HTMLInputElement>(null);
  const left = useRef(false);
  const sinceError = useRef(false);
  const escaped = useRef(false);
  /** The field focus was last in, so a refusal brings it back there, Until included (M5). */
  const lastField = useRef<HTMLInputElement | null>(null);
  const period = until !== undefined;
  useEffect(() => {
    from.current?.focus();
  }, []);
  useEffect(() => {
    if (!error) return;
    left.current = false;
    sinceError.current = false;
    (errorAt === "until" ? to.current : errorAt === "from" ? from.current : (lastField.current ?? from.current))?.focus();
  }, [error, errorKey]);
  // A field never touched keeps the date as written, a month or a year included.
  const value = (el: HTMLInputElement | null, was: string) => (el && el.dataset.touched ? el.value : was);
  const leave = (how: CommitHow) => {
    if (left.current) return;
    left.current = how !== "blur";
    escaped.current = how === "escape";
    onCommit(value(from.current, date), period ? value(to.current, until ?? "") : undefined, how);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const onFrom = e.currentTarget === from.current;
    if (e.key === "Tab" && period && onFrom !== e.shiftKey) {
      // From to Until, and back.
      e.preventDefault();
      (onFrom ? to : from).current?.focus();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      left.current = false;
      leave(e.key === "Enter" ? "enter" : e.shiftKey ? "shifttab" : "tab");
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (error && !sinceError.current && escaped.current) {
        left.current = true;
        onCancel();
        return;
      }
      left.current = false;
      leave("escape");
    }
  };
  const field = {
    type: "date",
    className: `inline-edit inline-date nodrag nopan nowheel${error ? " is-bad" : ""}`,
    "aria-invalid": error ? true : undefined,
    onKeyDown,
    onFocus: (e: { currentTarget: HTMLInputElement }) => {
      lastField.current = e.currentTarget;
    },
    onChange: (e: { currentTarget: HTMLInputElement }) => {
      e.currentTarget.dataset.touched = "1";
      left.current = false;
      sinceError.current = true;
    },
    onPointerDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
    onDoubleClick: (e: { stopPropagation(): void }) => e.stopPropagation(),
    onClick: (e: { stopPropagation(): void }) => e.stopPropagation(),
  };
  // A click away, not a move between the two fields, keeps the dates.
  const onBlur = (e: FocusEvent) => {
    if (wrap.current?.contains(e.relatedTarget as Node | null)) return;
    leave("blur");
  };
  return (
    <span ref={wrap} className="inline-edit-wrap fkind-dated" onBlur={onBlur}>
      {period && <span className="fkind-dated-word">From</span>}
      <input ref={from} {...field} aria-label={period ? "From" : "Date"} defaultValue={dayOnly(date)} />
      {period && (
        <>
          <span className="fkind-dated-word">until</span>
          <input ref={to} {...field} aria-label="Until" defaultValue={dayOnly(until ?? "")} />
        </>
      )}
      {error && (
        <span className="inline-edit-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
