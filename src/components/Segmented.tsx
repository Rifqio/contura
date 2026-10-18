import { type ReactNode, useRef } from "react";

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
  lead?: ReactNode;
  /** Shown but not choosable, such as Selected nodes with nothing selected. */
  disabled?: boolean;
}

interface Props<V extends string> {
  value: V;
  options: SegmentedOption<V>[];
  onChange: (value: V) => void;
  label: string;
}

/** A small set of exclusive choices side by side. The arrows move and choose. */
export default function Segmented<V extends string>({ value, options, onChange, label }: Props<V>) {
  const group = useRef<HTMLDivElement>(null);

  function onKey(e: React.KeyboardEvent) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const from = Math.max(0, options.findIndex((o) => o.value === value));
    let to = from;
    do to = (to + step + options.length) % options.length;
    while (options[to].disabled && to !== from);
    if (to === from) return;
    onChange(options[to].value);
    group.current?.querySelectorAll<HTMLElement>("[role=radio]")[to]?.focus();
  }

  return (
    <div ref={group} className="segmented" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          className={o.value === value ? "segmented-option segmented-on" : "segmented-option"}
          onClick={() => onChange(o.value)}
        >
          {o.lead}
          {o.label}
        </button>
      ))}
    </div>
  );
}
