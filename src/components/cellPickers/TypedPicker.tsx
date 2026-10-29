import { type FocusEvent, type KeyboardEvent, type RefObject, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { listPlacement } from "../Select";
import DatePicker, { type PickHow } from "./DatePicker";
import EnumList from "./EnumList";
import type { CellPicker } from "./picker";
import { type Day, formatTemporal, parseTemporal, withDate, withTime } from "./temporal";
import TimeFields from "./TimeFields";

interface Props {
  picker: CellPicker;
  /** The text box's value: the picker reads it and writes it, never anything else. */
  value: string;
  /** The column, for the labels. */
  label: string;
  /** The text box, which the popover sits under (its cell). */
  anchor: RefObject<HTMLElement | null>;
  popRef: RefObject<HTMLDivElement | null>;
  /** A change that keeps the editor open. */
  onChange(text: string): void;
  /** A pick that finishes the value: Enter moves down, a click stays. */
  onKeep(text: string, move: "down" | "none"): void;
  /** Present when the column takes NULL. */
  onSetNull?(): void;
  /** Esc: back to the text box. */
  onBack(): void;
  /** Focus went somewhere outside the text box and the popover. */
  onLeave(): void;
}

const WIDTH = { temporal: 264, enum: 220 };

/**
 * The popover under an editing cell: a calendar and time fields, or the enum's values. Focus stays in the text box
 * until Alt+Down; inside, Tab moves between the parts and Esc goes back.
 */
export default function TypedPicker(p: Props) {
  const [at, setAt] = useState<{ left: number; top: number; minWidth: number } | null>(null);
  useLayoutEffect(() => {
    const box = p.anchor.current;
    const cell = (box?.closest("td") ?? box)?.getBoundingClientRect();
    if (!cell) return;
    const width = WIDTH[p.picker.kind];
    const measured = p.popRef.current?.getBoundingClientRect().height ?? 0;
    const place = listPlacement(cell, measured > 0 ? measured : 320, window.innerHeight);
    setAt({ top: place.top, left: Math.max(8, Math.min(place.left, window.innerWidth - Math.max(width, cell.width) - 8)), minWidth: Math.max(width, cell.width) });
    // Placed once, as the larger editor is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKey(e: KeyboardEvent) {
    // The grid under the editor must not act on keys meant for the picker.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      p.onBack();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const stops = Array.from(p.popRef.current?.querySelectorAll<HTMLElement>("[data-picker-stop]") ?? []);
      const i = stops.findIndex((s) => s === document.activeElement || s.contains(document.activeElement));
      stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
    }
  }

  function onBlur(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (to && (p.popRef.current?.contains(to) || p.anchor.current === to)) return;
    if (to) return p.onLeave();
    // Focus went nowhere (a re-rendered day, the window): leave only when it is not back inside.
    window.setTimeout(() => {
      const now = document.activeElement;
      if (now && (p.popRef.current?.contains(now) || p.anchor.current === now)) return;
      if (now === document.body) p.onLeave();
    }, 0);
  }

  const kind = p.picker.kind === "enum" ? "a value" : p.picker.spec.kind === "date" ? "a date" : p.picker.spec.kind === "time" ? "a time" : "a date and time";
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return createPortal(
    <div
      ref={p.popRef}
      className={`cell-picker cell-picker-${p.picker.kind}`}
      role="dialog"
      aria-label={`Pick ${kind} for ${p.label}`}
      style={at ?? { visibility: "hidden" }}
      data-sublayer
      onKeyDown={onKey}
      onBlur={onBlur}
      onMouseDown={(e) => {
        e.stopPropagation();
        // A press on the popover keeps focus where it is; only the time fields and the filter take it.
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      {p.picker.kind === "enum" ? (
        <EnumList
          values={p.picker.values}
          current={p.value}
          nullable={!!p.onSetNull}
          label={p.label}
          onPick={(v, how) => (v === null ? p.onSetNull?.() : p.onKeep(v, how === "enter" ? "down" : "none"))}
        />
      ) : (
        <Temporal {...p} spec={p.picker.spec} />
      )}
    </div>,
    document.body,
  );
}

function Temporal(p: Props & { spec: Extract<CellPicker, { kind: "temporal" }>["spec"] }) {
  const { spec } = p;
  const parsed = parseTemporal(p.value, spec);
  function pickDay(day: Day, how: PickHow) {
    const text = formatTemporal(withDate(parsed, day), spec);
    if (how === "enter") p.onKeep(text, "down");
    else if (how === "click" && spec.kind === "date") p.onKeep(text, "none");
    else p.onChange(text);
  }
  return (
    <>
      {spec.kind !== "time" && <DatePicker value={parsed?.date ?? null} onPick={pickDay} />}
      {spec.kind !== "date" && (
        <TimeFields
          value={parsed?.time ?? (parsed?.date ? { h: 0, mi: 0, s: 0, frac: "" } : null)}
          spec={spec}
          onChange={(c) => p.onChange(formatTemporal(withTime(parsed, c), spec))}
          onEnter={() => p.onKeep(p.value, "down")}
        />
      )}
    </>
  );
}
