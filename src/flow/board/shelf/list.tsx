// What every list on the Shelf's pick side shares (decision 3): one active option stepped one by one in reading
// order, the search's `aria-activedescendant` following it, and options that add on a click and travel on a drag.
import { type DragEvent, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ShelfItem } from "./types";

/** PageUp and PageDown step this many options. */
const PAGE = 8;

/** True for Ctrl (Cmd on a Mac) without Alt. */
const ctrl = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey;

/** The keys the Shelf forwards to the list that owns them; Left, Right, Home and End stay with the search's text. */
export function isListKey(e: KeyboardEvent): boolean {
  if (e.key === "Home" || e.key === "End") return ctrl(e);
  if (e.key === "PageUp" || e.key === "PageDown") return !ctrl(e);
  // Ctrl+Enter and the like are the board's shortcuts; an Enter that ends an IME composition is the input's.
  if (e.key === "Enter") return !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing && e.keyCode !== 229;
  return e.key === "ArrowDown" || e.key === "ArrowUp";
}

/**
 * An active option over `n` options, back on the first whenever `reset` changes (a new query). Its key handler goes
 * to the Shelf through `registerKeys`; `pick(i)` runs on Enter.
 */
export function useOptionList(p: {
  n: number;
  reset: string;
  registerKeys(handler: (e: KeyboardEvent) => boolean): void;
  setActiveDescendant?(id: string | undefined): void;
  pick(i: number): void;
}) {
  const id = useId();
  const optionId = (i: number) => `${id}o${i}`;
  const [state, setState] = useState({ reset: p.reset, active: 0 });
  if (state.reset !== p.reset) setState({ reset: p.reset, active: 0 });
  const active = state.reset === p.reset ? Math.max(0, Math.min(state.active, p.n - 1)) : 0;
  const latest = useRef({ n: p.n, active, pick: p.pick, reset: p.reset });
  latest.current = { n: p.n, active, pick: p.pick, reset: p.reset };

  const { registerKeys, setActiveDescendant } = p;
  useEffect(() => {
    registerKeys((e) => {
      if (!isListKey(e)) return false;
      const { n, active: at, pick, reset } = latest.current;
      const to = (i: number) => setState({ reset, active: Math.max(0, Math.min(n - 1, i)) });
      if (e.key === "Enter") {
        if (n > 0) pick(at);
      } else if (e.key === "ArrowDown") to(at + 1);
      else if (e.key === "ArrowUp") to(at - 1);
      else if (e.key === "PageDown") to(at + PAGE);
      else if (e.key === "PageUp") to(at - PAGE);
      else if (e.key === "Home") to(0);
      else to(n - 1);
      return true;
    });
  }, [registerKeys]);

  const activeId = p.n > 0 ? optionId(active) : undefined;
  useEffect(() => {
    setActiveDescendant?.(activeId);
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId, setActiveDescendant]);
  useEffect(() => () => setActiveDescendant?.(undefined), [setActiveDescendant]);

  return { active, optionId };
}

interface OptionProps {
  id: string;
  active: boolean;
  /** The option's accessible name. */
  label: string;
  item: ShelfItem;
  /** Whether it can be dragged onto the board. */
  drag: boolean;
  className: string;
  add(item: ShelfItem): void;
  beginDrag(item: ShelfItem, e: DragEvent): void;
  describedBy?: string;
  /** A tooltip, where the option shows less than its name. */
  title?: string;
  /** What it does, said to a screen reader when it is not disabled (a shape's hint, B3 A8). */
  description?: string;
  /** Why it cannot be added now: it shows disabled, the reason its tooltip and description, and it does not drag. A press still goes to `add`, which says the reason. */
  disabled?: string | null;
  name?: string;
  children: ReactNode;
}

/** One option: a click adds it, a drag carries it, and a press never takes focus from the search. */
export function ShelfOption({ id, active, label, item, drag, className, add, beginDrag, describedBy, title, description, name, disabled, children }: OptionProps) {
  const off = !!disabled;
  const cls = `${className}${active ? " is-active" : ""}${off ? " is-disabled" : ""}`;
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={off ? true : undefined}
      aria-description={off ? disabled! : description}
      title={off ? disabled! : title}
      data-name={name}
      className={cls}
      draggable={drag && !off}
      onDragStart={drag && !off ? (e) => beginDrag(item, e) : undefined}
      // A press keeps focus in the search (decision 3). A tile that drags keeps its mousedown, since WebKit starts no
      // drag from a prevented one; the Shelf gives the search its focus back when the press ends.
      onMouseDown={drag && !off ? undefined : (e) => e.preventDefault()}
      onClick={() => add(item)}
    >
      {children}
    </div>
  );
}

/** What an empty search says. */
export function Nothing({ query }: { query: string }) {
  return <p className="flow-shelf-empty">{`Nothing here matches "${query.trim()}".`}</p>;
}
