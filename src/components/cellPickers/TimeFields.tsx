import { type KeyboardEvent, useState } from "react";
import type { Clock, TemporalSpec } from "./temporal";

type Part = "h" | "mi" | "s" | "frac";

const fractionLabel = (digits: number) => (digits === 3 ? "Milliseconds" : digits === 6 ? "Microseconds" : "Fraction of a second");

const MIDNIGHT: Clock = { h: 0, mi: 0, s: 0, frac: "" };

interface Props {
  /** The time in the text box, or null when it has none the fields can show. */
  value: Clock | null;
  spec: TemporalSpec;
  onChange(c: Clock): void;
  /** Enter in a field keeps the value. */
  onEnter(): void;
}

/** Hour : minute : second [. fraction], to the column's precision. Up and Down step a field and wrap. */
export default function TimeFields({ value, spec, onChange, onEnter }: Props) {
  const parts: { part: Part; label: string; width: number; max: number }[] = [
    { part: "h", label: "Hour", width: 2, max: 23 },
    { part: "mi", label: "Minute", width: 2, max: 59 },
    { part: "s", label: "Second", width: 2, max: 59 },
  ];
  if (spec.fraction > 0) parts.push({ part: "frac", label: fractionLabel(spec.fraction), width: spec.fraction, max: 10 ** spec.fraction - 1 });
  return (
    <div className="time-fields" role="group" aria-label="Time">
      {parts.map((p, i) => (
        <span key={p.part} className="time-part">
          {i > 0 && (
            <span className="time-sep" aria-hidden="true">
              {p.part === "frac" ? "." : ":"}
            </span>
          )}
          <Field {...p} value={value} onChange={onChange} onEnter={onEnter} />
        </span>
      ))}
    </div>
  );
}

function Field(p: { part: Part; label: string; width: number; max: number; value: Clock | null; onChange(c: Clock): void; onEnter(): void }) {
  /** What is typed while the field has focus; the value's text otherwise. */
  const [draft, setDraft] = useState<string | null>(null);
  const base = p.value ?? MIDNIGHT;
  const number = p.part === "frac" ? Number(base.frac.slice(0, p.width).padEnd(p.width, "0")) : base[p.part];
  const shown = p.value === null ? "" : String(number).padStart(p.width, "0");

  function set(n: number) {
    if (p.part === "frac") p.onChange({ ...base, frac: String(n).padStart(p.width, "0") });
    else p.onChange({ ...base, [p.part]: n });
  }

  function type(text: string) {
    const digits = text.replace(/\D/g, "").slice(0, p.width);
    setDraft(digits);
    if (digits === "") return;
    if (p.part === "frac") return p.onChange({ ...base, frac: digits });
    const n = Number(digits);
    if (n <= p.max) set(n);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setDraft(null);
      const span = p.max + 1;
      set((number + (e.key === "ArrowUp" ? 1 : -1) + span) % span);
    } else if (e.key === "Enter") {
      e.preventDefault();
      p.onEnter();
    }
  }

  const text = draft ?? shown;
  const invalid = p.part !== "frac" && text !== "" && Number(text) > p.max;
  return (
    <input
      type="text"
      role="spinbutton"
      className="time-field"
      aria-label={p.label}
      aria-valuemin={0}
      aria-valuemax={p.max}
      aria-valuenow={p.value === null ? undefined : number}
      aria-invalid={invalid || undefined}
      inputMode="numeric"
      maxLength={p.width}
      size={p.width}
      spellCheck={false}
      autoComplete="off"
      data-picker-stop=""
      placeholder={"0".repeat(p.width)}
      value={text}
      onChange={(e) => type(e.target.value)}
      onKeyDown={onKey}
      onFocus={(e) => e.target.select()}
      onBlur={() => setDraft(null)}
    />
  );
}
