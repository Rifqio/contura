import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";

/** The gap between the button and the list, and the list's tallest size (app.css `.select-list`). */
const GAP = 4;
const LIST_MAX = 280;

/**
 * Where the open list goes, in viewport pixels: under the button, or above it when there is less
 * room below than the list needs and more room above. At least as wide as the button.
 */
export function listPlacement(
  button: { top: number; bottom: number; left: number; width: number },
  listHeight: number,
  viewportHeight: number,
): { top: number; left: number; minWidth: number; up: boolean } {
  const below = viewportHeight - button.bottom - GAP;
  const above = button.top - GAP;
  const up = below < listHeight && above > below;
  return {
    top: up ? Math.max(0, button.top - GAP - Math.min(listHeight, above)) : button.bottom + GAP,
    left: button.left,
    minWidth: button.width,
    up,
  };
}

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  /** A small mark before the label, such as a database mark or a Group square. */
  lead?: ReactNode;
  /** Quiet text at the right of the row. */
  hint?: string;
  /** Small marks after the label, such as the PROD and Read-only tags. */
  trail?: ReactNode;
  disabled?: boolean;
}

interface Props<V extends string> {
  value: V;
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  label: string;
  disabled?: boolean;
  /** Shows the value in the Code face. */
  mono?: boolean;
  className?: string;
  /** The id of a help line that describes the control. */
  describedBy?: string;
  /** Marks the control in danger: its value has a problem, said in the `describedBy` line. */
  invalid?: boolean;
}

/** The themed replacement for a native select: a combobox button and a listbox popover. */
export default function Select<V extends string>({ value, options, onChange, label, disabled, mono, className, describedBy, invalid }: Props<V>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const typed = useRef({ text: "", timer: 0 });

  const selected = options.find((o) => o.value === value);
  const enabled = (i: number) => !options[i]?.disabled;
  const optionId = (i: number) => `${id}-opt-${i}`;

  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => !!t && (root.current?.contains(t as Node) || list.current?.contains(t as Node));
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) setOpen(false);
    };
    // The list is fixed to where the button was: a scroll elsewhere or a resize would leave it behind.
    const onScroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // In a portal on <body> with fixed placement, so a scrolling dialog body cannot clip it.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const b = button.current?.getBoundingClientRect();
    if (!b) return;
    const measured = list.current?.getBoundingClientRect().height ?? 0;
    // jsdom measures nothing: fall back to the rows the list would show.
    const height = measured > 0 ? measured : Math.min(LIST_MAX, options.length * 28 + 2 * GAP + 2);
    const p = listPlacement(b, height, window.innerHeight);
    setPlace({ top: p.top, left: p.left, minWidth: p.minWidth });
    // Placed once per opening; scroll and resize close it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // optionId only depends on the stable id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  useEffect(() => () => window.clearTimeout(typed.current.timer), []);

  function openList() {
    const at = options.findIndex((o) => o.value === value);
    setActive(
      at >= 0 && enabled(at)
        ? at
        : Math.max(
            0,
            options.findIndex((_, i) => enabled(i)),
          ),
    );
    setOpen(true);
  }

  function step(from: number, by: 1 | -1): number {
    for (let i = from + by; i >= 0 && i < options.length; i += by) if (enabled(i)) return i;
    return from;
  }

  function pick(i: number) {
    if (!enabled(i)) return;
    setOpen(false);
    button.current?.focus();
    if (options[i].value !== value) onChange(options[i].value);
  }

  function typeahead(ch: string) {
    window.clearTimeout(typed.current.timer);
    typed.current.text += ch.toLowerCase();
    typed.current.timer = window.setTimeout(() => (typed.current.text = ""), 700);
    const hit = options.findIndex((o, i) => enabled(i) && o.label.toLowerCase().startsWith(typed.current.text));
    if (hit >= 0) setActive(hit);
  }

  function onKey(e: React.KeyboardEvent) {
    const k = e.key;
    if (!open) {
      if (k === "Enter" || k === " " || k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (k === "ArrowDown") {
      e.preventDefault();
      setActive((a) => step(a, 1));
    } else if (k === "ArrowUp") {
      e.preventDefault();
      setActive((a) => step(a, -1));
    } else if (k === "Home") {
      e.preventDefault();
      setActive(
        Math.max(
          0,
          options.findIndex((_, i) => enabled(i)),
        ),
      );
    } else if (k === "End") {
      e.preventDefault();
      const last = [...options.keys()].reverse().find(enabled);
      if (last !== undefined) setActive(last);
    } else if (k === "Enter" || (k === " " && typed.current.text === "")) {
      e.preventDefault();
      pick(active);
    } else if (k === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (k === "Tab") {
      setOpen(false);
    } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      typeahead(k);
    }
  }

  const classes = ["select", mono ? "select-mono" : "", invalid ? "select-invalid" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes} ref={root}>
      <button
        ref={button}
        type="button"
        role="combobox"
        className="select-button"
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        disabled={disabled}
        onKeyDown={onKey}
        onClick={(e) => {
          // A click made by Enter or Space has no pointer; the key handler already ran.
          if (e.detail === 0) return;
          if (open) setOpen(false);
          else openList();
        }}
      >
        {selected?.lead && <span className="select-lead">{selected.lead}</span>}
        <span className="select-value">{selected?.label ?? ""}</span>
        {selected?.trail && <span className="select-trail">{selected.trail}</span>}
        <Icon name="chevronDown" size={14} className="select-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            id={`${id}-list`}
            className="select-list"
            data-sublayer
            role="listbox"
            aria-label={label}
            style={place ?? { visibility: "hidden" }}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                className={["select-option", i === active ? "select-option-active" : "", o.value === value ? "select-option-on" : ""]
                  .filter(Boolean)
                  .join(" ")}
                onMouseMove={() => enabled(i) && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
              >
                {o.lead && <span className="select-lead">{o.lead}</span>}
                <span className="select-label">{o.label}</span>
                {o.trail && <span className="select-trail">{o.trail}</span>}
                {o.hint && <span className="select-hint">{o.hint}</span>}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
