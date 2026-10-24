// UX step 8: the small list under a cell that picks where a key goes (DataGrip's choose-target popup): a column in two
// keys, the related rows of a row, or the rows that point here. IntelliJ popup keys: Up and Down wrap and skip rows
// that are off, Enter or a click opens, Esc or a press outside closes. Hover only highlights.
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Icon from "../components/Icon";

export interface PickItem {
  id: string;
  dir: "out" | "in";
  table: string;
  /** The key in words: `id = 214`, `by order_id`, or why it is off (`currency is NULL`). */
  by: string;
  /** The quiet right column: `via customer_id`, or a row count. */
  meta: string;
  /** The constraint: `orders_customer_fk: customer_id → customers.id`. */
  tip: string;
  disabled: boolean;
}

export interface PickGroup {
  label: string | null;
  items: PickItem[];
}

interface Props {
  title: string;
  /** What it was opened on: `product_id = 5`, or `orders row 3`. */
  from: string;
  groups: PickGroup[];
  x: number;
  y: number;
  onPick(id: string): void;
  /** `refocus`: Esc gives focus back to the cell; a press elsewhere leaves it where it went. */
  onClose(refocus: boolean): void;
}

const WIDTH = 400;

export default function KeyPicker({ title, from, groups, x, y, onPick, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (id: string) => `${listId}-${id}`;
  const flat = groups.flatMap((g) => g.items);
  const live = flat.filter((i) => !i.disabled).map((i) => i.id);
  const [at, setAt] = useState<string | null>(live[0] ?? null);
  // Counts come in after it opens: a row turned off gives its place to the first that is on.
  const current = at !== null && live.includes(at) ? at : (live[0] ?? null);

  useLayoutEffect(() => box.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    const outside = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) onClose(false);
    };
    document.addEventListener("mousedown", outside, true);
    return () => document.removeEventListener("mousedown", outside, true);
  }, [onClose]);

  function move(by: 1 | -1) {
    if (live.length === 0) return;
    const i = current === null ? -1 : live.indexOf(current);
    setAt(live[(i + by + live.length) % live.length]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Escape") return done(), onClose(true);
    if (e.key === "ArrowDown") return done(), move(1);
    if (e.key === "ArrowUp") return done(), move(-1);
    if (e.key === "Enter") {
      done();
      if (current !== null) onPick(current);
      return;
    }
    // The list keeps the keys while it is open, so F4 or Tab do not act on the grid under it.
    if (e.key === "Tab" || e.key === "F4" || e.key.startsWith("Arrow")) done();
  }

  const left = Math.max(4, Math.min(x, (typeof window === "undefined" ? 1280 : window.innerWidth) - WIDTH - 4));
  return (
    <div
      ref={box}
      className="key-picker"
      role="listbox"
      tabIndex={-1}
      aria-label={title}
      // Focus stays on the list; the current option is announced through it.
      aria-activedescendant={current === null ? undefined : optionId(current)}
      style={{ left, top: y }}
      onKeyDown={onKeyDown}
    >
      <div className="key-picker-head">
        <b>{title}</b>
        <span className="key-picker-from">{from}</span>
        <span className="key-picker-hint">Enter · Esc</span>
      </div>
      {groups.map((g, gi) =>
        g.items.length === 0 ? null : (
          <div key={gi} role="group" aria-label={g.label ?? title}>
            {g.label && <div className={gi === 0 ? "key-picker-group key-picker-group-first" : "key-picker-group"}>{g.label}</div>}
            {g.items.map((item) => (
              <div
                key={item.id}
                id={optionId(item.id)}
                role="option"
                className={["key-picker-item", item.id === current ? "key-picker-on" : "", item.disabled ? "key-picker-off" : ""].filter(Boolean).join(" ")}
                aria-selected={item.id === current}
                aria-disabled={item.disabled}
                data-table={item.table}
                title={item.tip}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!item.disabled) onPick(item.id);
                }}
              >
                <Icon name={item.dir === "out" ? "arrowRight" : "link"} size={14} className="key-picker-icon" />
                <span className="key-picker-table">{item.table}</span>
                <span className="key-picker-by">{item.by}</span>
                <span className="key-picker-meta">{item.meta}</span>
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}
