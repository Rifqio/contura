// The Join popover (decision 9, 300 px): the kind with its plain line and key, the conditions,
// Swap sides and Remove Join. Portalled, beside the badge on the side away from the cards.
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DialectKind, JoinKind, VqJoin } from "../api/types";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { conditionText, KIND_LABEL, VennMark } from "./JoinEdge";
import { nounFor } from "./nouns";

export const JOIN_POPOVER_WIDTH = 300;
const GAP = 8;
const EDGE = 8;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };

const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Where a popover goes beside its anchor (decision 9): right of it, then left, below, above,
 * taking the first place that covers none of `avoid` (the Join's cards) and fits the window;
 * with none clear, the one that covers the least.
 */
export function placeBeside(anchor: Box, avoid: Box[], size: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number } {
  const midY = anchor.top + anchor.height / 2 - size.height / 2;
  const midX = anchor.left + anchor.width / 2 - size.width / 2;
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, view.width - size.width - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, view.height - size.height - EDGE));
  const tries = [
    { left: anchor.right + GAP, top: clampY(midY), fits: anchor.right + GAP + size.width <= view.width - EDGE },
    { left: anchor.left - GAP - size.width, top: clampY(midY), fits: anchor.left - GAP - size.width >= EDGE },
    { left: clampX(midX), top: anchor.bottom + GAP, fits: anchor.bottom + GAP + size.height <= view.height - EDGE },
    { left: clampX(midX), top: anchor.top - GAP - size.height, fits: anchor.top - GAP - size.height >= EDGE },
  ];
  // With the cards on both sides, under (or over) all of them, still in line with the badge.
  if (avoid.length > 0) {
    const under = Math.max(...avoid.map((a) => a.bottom)) + GAP;
    const over = Math.min(...avoid.map((a) => a.top)) - GAP - size.height;
    tries.push({ left: clampX(midX), top: under, fits: under + size.height <= view.height - EDGE });
    tries.push({ left: clampX(midX), top: over, fits: over >= EDGE });
  }
  const box = (t: { left: number; top: number }): Box => ({ ...t, right: t.left + size.width, bottom: t.top + size.height, ...size });
  const covered = (t: { left: number; top: number }) => {
    const b = box(t);
    return avoid.reduce((sum, a) => {
      if (!overlaps(b, a)) return sum;
      return sum + (Math.min(b.right, a.right) - Math.max(b.left, a.left)) * (Math.min(b.bottom, a.bottom) - Math.max(b.top, a.top));
    }, 0);
  };
  const clear = tries.find((t) => t.fits && covered(t) === 0);
  if (clear) return { left: clear.left, top: clear.top };
  const best = tries.filter((t) => t.fits).sort((a, b) => covered(a) - covered(b))[0] ?? tries[0];
  return { left: clampX(best.left), top: clampY(best.top) };
}

/**
 * A fixed popover in `document.body`, placed beside `anchor` away from `avoid`, focused when it
 * opens; a press outside or Esc closes it.
 */
export function Popover({
  label,
  width,
  anchor,
  avoid,
  className,
  onKeyDown,
  onClose,
  returnFocus,
  children,
}: {
  label: string;
  width: number;
  anchor: DOMRect | null;
  avoid: DOMRect[];
  className?: string;
  onKeyDown?(e: KeyboardEvent<HTMLDivElement>): void;
  onClose(): void;
  /** Where focus goes on close when what had it before is gone. */
  returnFocus?(): HTMLElement | null;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const h = box.current?.getBoundingClientRect().height || 240;
    const view = { width: window.innerWidth, height: window.innerHeight };
    const a = anchor ?? new DOMRect(view.width / 2, view.height / 3, 0, 0);
    setAt(placeBeside(a, avoid, { width, height: h }, view));
    // Placed once per anchor: the tab closes it when a wheel pans or zooms the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, width]);
  // Focus moves in when it opens and goes back when it closes (Esc, a choice, a press outside): to
  // what had it before, else to `returnFocus` (the Join's badge, then the canvas). A press outside
  // that lands on another control keeps focus there.
  const before = useRef<Element | null>(null);
  const fallback = useRef(returnFocus);
  fallback.current = returnFocus;
  useLayoutEffect(() => {
    before.current = document.activeElement;
    const el = box.current;
    el?.focus();
    return () => {
      const now = document.activeElement;
      if (now && now !== document.body && !el?.contains(now)) return;
      const prev = before.current;
      queueMicrotask(() => {
        const cur = document.activeElement;
        if (cur && cur !== document.body && !el?.contains(cur)) return;
        const target = prev instanceof HTMLElement && prev !== document.body && prev.isConnected ? prev : fallback.current?.();
        target?.focus();
      });
    };
  }, []);
  /** Tab and Shift+Tab wrap inside, so Esc always reaches the popover. */
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (all.length === 0) return;
    e.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : at < 0 || at === all.length - 1 ? 0 : at + 1;
    all[next].focus();
  };
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      // The badge that opened it toggles it itself.
      if (box.current?.contains(t) || t?.closest?.(".vq-join-badge") || t?.closest?.(".select-list")) return;
      close.current();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={className ? `vq-popover ${className}` : "vq-popover"}
      style={{ width, ...(at ?? { visibility: "hidden" as const }) }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          return;
        }
        if (e.key === "Tab") return trapTab(e);
        onKeyDown?.(e);
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface JoinPopoverProps {
  join: VqJoin;
  left: string;
  right: string;
  dialect: DialectKind;
  anchor: DOMRect;
  onKind(k: JoinKind): void;
  onRemoveCondition(i: number): void;
  onSwap(): void;
  onRemove(): void;
  onClose(): void;
  /** The cards' aliases, for the conditions; the names when absent. */
  leftAlias?: string;
  rightAlias?: string;
  /** Rects of the Join's cards, which the popover keeps clear of. */
  avoid?: DOMRect[];
  /** A problem the Core gave for this Join. */
  problem?: string | null;
  /** Where focus goes on close when what had it before is gone. */
  returnFocus?(): HTMLElement | null;
}

const KINDS: JoinKind[] = ["inner", "left", "right", "full"];
const KEY: Record<JoinKind, string> = { inner: "I", left: "L", right: "R", full: "F" };

/** The plain line for each kind ("Only orders that have a store"). */
export function kindLines(left: string, right: string): Record<JoinKind, string> {
  const l = nounFor(left);
  const r = nounFor(right);
  // A name the noun rules are unsure of reads as "row of {table}" instead of a wrong word.
  const one = (n: { one: string; many: string }) => (n.one === n.many ? `row of ${n.one}` : n.one);
  const many = (n: { one: string; many: string }) => (n.one === n.many ? `rows of ${n.many}` : n.many);
  return {
    inner: `Only ${many(l)} that have a ${one(r)}`,
    left: `Every ${one(l)}, with its ${one(r)} if any`,
    right: `Every ${one(r)}, with its ${many(l)} if any`,
    full: "Every row from both sides",
  };
}

export default function JoinPopover(props: JoinPopoverProps) {
  const { join, left, right, dialect, anchor, onKind, onRemoveCondition, onSwap, onRemove, onClose } = props;
  const lines = kindLines(left, right);
  const fullOff = dialect === "mysql";
  const pending = join.pending != null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const kind = KINDS.find((k) => KEY[k] === e.key.toUpperCase());
    if (kind) {
      e.preventDefault();
      if (!(kind === "full" && fullOff)) onKind(kind);
    } else if (e.key === "Delete") {
      e.preventDefault();
      onRemove();
    }
  };

  return (
    <Popover
      label={`Join ${left} to ${right}`}
      width={JOIN_POPOVER_WIDTH}
      anchor={anchor}
      avoid={props.avoid ?? []}
      className="vq-join-popover"
      onKeyDown={onKey}
      onClose={onClose}
      returnFocus={props.returnFocus}
    >
      <header className="vq-popover-head">
        <span className="vq-popover-title">
          Join {left} to {right}
        </span>
        <Kbd keys="Esc" />
      </header>
      {props.problem && <p className="vq-problem vq-popover-problem">{props.problem}</p>}
      <div className="vq-join-kinds" role="radiogroup" aria-label="Join kind">
        {KINDS.map((k) => {
          const off = k === "full" && fullOff;
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={join.kind === k}
              disabled={off}
              title={off ? "MySQL has no FULL JOIN." : undefined}
              className={join.kind === k ? "vq-join-kind vq-join-kind-on" : "vq-join-kind"}
              onClick={() => onKind(k)}
            >
              <VennMark kind={k} />
              <span className="vq-join-kind-text">
                <span className="vq-join-kind-name">{KIND_LABEL[k]}</span>
                <span className="vq-join-kind-line">{off ? "MySQL has no FULL JOIN." : lines[k]}</span>
              </span>
              <Kbd keys={KEY[k]} />
            </button>
          );
        })}
      </div>
      <div className="vq-popover-section">
        <span className="vq-popover-label">Joined on</span>
        <ul className="vq-join-conditions">
          {join.on.map((p, i) => (
            <li key={`${p.leftColumn}=${p.rightColumn}`} className="vq-join-condition-row">
              <span className="vq-join-condition">{conditionText(p, props.leftAlias ?? left, props.rightAlias ?? right)}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Remove this condition"
                title="Remove this condition"
                onClick={() => onRemoveCondition(i)}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
        <p className="vq-popover-hint">Hold Shift while you drop a column to add another condition.</p>
      </div>
      <footer className="vq-popover-foot">
        <button type="button" className="button button-small button-quiet" disabled={pending} onClick={onSwap}>
          <Icon name="swap" size={14} />
          Swap sides
        </button>
        <span className="spacer" />
        <button type="button" className="button button-small button-quiet vq-danger-text" onClick={onRemove}>
          <Icon name="trash" size={14} />
          Remove Join
          <Kbd keys="Delete" />
        </button>
      </footer>
    </Popover>
  );
}
