// "Add here" (board DiagramAddNext; draw.io's double-click on the blank canvas, since 13.4.2): a grid of the kind's
// shapes at the pointer, kept inside the canvas. Arrow keys move in the grid, Enter or a click picks, Esc or a click
// away closes. The picked shape lands where the canvas was double-clicked, its name ready. The grid is the kind's
// fixed list, the same array on every open, so it costs nothing per node or per frame.
import { type KeyboardEvent, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Icon from "../../components/Icon";
import type { DiagramKind } from "../../lang/flow/model";
import { type Shape, shapesOf } from "../ShapePicker";

const COLS = 3;
const CELL_W = 96;
const CELL_H = 64;

const cache = new Map<DiagramKind, readonly Shape[]>();

/** The kind's shapes the grid offers: its Shapes list's plain shapes, notes included. */
export function addHereItems(kind: DiagramKind): readonly Shape[] {
  let items = cache.get(kind);
  if (!items) {
    items = shapesOf(kind).filter((s) => s.act.kind === "node");
    cache.set(kind, items);
  }
  return items;
}

interface Props {
  kind: DiagramKind;
  /** Where the canvas was double-clicked, in window coordinates. */
  at: { x: number; y: number };
  /** The canvas's box on the window: the grid stays inside it. */
  inside?: { left: number; top: number; right: number; bottom: number };
  /** Why an item cannot be added now (a mind map's second central idea), or null. */
  disabled?(shape: Shape): string | null;
  onPick(shape: Shape): void;
  onCancel(): void;
}

export default function AddHere({ kind, at, inside, disabled, onPick, onCancel }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const items = addHereItems(kind);
  const latest = useRef(onCancel);
  latest.current = onCancel;
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")?.focus();
    const away = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) latest.current();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onCancel();
      return;
    }
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (step) {
      e.preventDefault();
      const all = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
      const i = all.indexOf(document.activeElement as HTMLElement);
      const next = i < 0 ? 0 : Math.max(0, Math.min(all.length - 1, i + step));
      all[next]?.focus();
    }
  };
  const rows = Math.ceil(items.length / COLS);
  const w = Math.min(items.length, COLS) * CELL_W + 16;
  const h = rows * CELL_H + 40;
  const box = inside ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const left = Math.max(box.left + 4, Math.min(at.x, box.right - w - 4));
  const top = Math.max(box.top + 4, Math.min(at.y, box.bottom - h - 4));
  return createPortal(
    <div className="tree-menu flow-add-here" style={{ left, top }}>
      <div ref={menu} className="menu" role="menu" aria-label="Add here" onKeyDown={onKey}>
        <div className="menu-heading" role="presentation">
          Add here
        </div>
        <div className="flow-add-grid" role="presentation" style={{ gridTemplateColumns: `repeat(${Math.min(items.length, COLS)}, ${CELL_W - 8}px)` }}>
          {items.map((s) => {
            const why = disabled?.(s) ?? null;
            return (
              <button
                key={s.label}
                type="button"
                role="menuitem"
                className="flow-add-cell"
                aria-disabled={why ? true : undefined}
                aria-keyshortcuts={s.tool?.key}
                title={why ?? s.code.split("\n")[0]}
                onClick={() => {
                  if (!why) onPick(s);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !why) {
                    e.preventDefault();
                    e.stopPropagation();
                    onPick(s);
                  }
                }}
              >
                <Icon name={s.icon} size={20} />
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
