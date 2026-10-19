import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWindowed } from "./useWindowed";
import type { DiffKind } from "../api/types";
import Icon from "../components/Icon";
import { guideX, STUB_WIDTH, treeGuides, type RowGuides } from "../components/treeGuides";
import { type TreeNode, visibleRows } from "./compareModel";

const MARK_PATH: Record<DiffKind, string> = {
  added: "M12 8.5v7M8.5 12h7",
  removed: "M8.5 12h7",
  changed: "M8 13c1.2-2 2.6-2 4 0s2.8 2 4 0",
};

/** The added, removed or changed mark: a rounded square with +, - or ~, in the mark's colour. Always beside its word. */
export function MarkIcon({ mark, label }: { mark: DiffKind; label?: string }) {
  return (
    <svg
      className={`icon compare-mark compare-mark-${mark}`}
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d={MARK_PATH[mark]} />
    </svg>
  );
}

function Guides({ g }: { g: RowGuides | undefined }) {
  if (!g) return null;
  const stub = g.stub;
  return (
    <>
      {g.levels.map((k) => (
        <span key={k} className={k === g.strong ? "tree-guide tree-guide-strong" : "tree-guide"} style={{ left: guideX(k) }} aria-hidden="true" />
      ))}
      {stub && (
        <span
          className={["tree-stub", stub.elbow && "tree-elbow", stub.strong && "tree-stub-strong"].filter(Boolean).join(" ")}
          style={{ left: guideX(stub.level), width: STUB_WIDTH }}
          aria-hidden="true"
        />
      )}
    </>
  );
}

interface Props {
  rows: TreeNode[];
  collapsed: ReadonlySet<string>;
  onCollapsed(next: Set<string>): void;
  selected: string | null;
  onSelect(id: string): void;
}

/** The object tree's row height until `--tree-row-height` is read (24 px at the compact density). */
const FALLBACK_ROW_HEIGHT = 28;

/** The Differences tree (`role="tree"`, guides as the object tree): Up and Down move, Right and Left expand and collapse. */
export default function DiffTree({ rows, collapsed, onCollapsed, selected, onSelect }: Props) {
  const shown = useMemo(() => visibleRows(rows, collapsed), [rows, collapsed]);
  const guides = useMemo(() => treeGuides(shown.map((r) => ({ id: r.id, level: r.level })), selected), [shown, selected]);
  const box = useRef<HTMLDivElement>(null);
  // Only the rows on screen are drawn: a 300-table compare has thousands of rows.
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const h = parseFloat(getComputedStyle(el).getPropertyValue("--tree-row-height"));
    if (h > 0 && h !== rowHeight) setRowHeight(h);
  });
  const heights = useMemo(() => shown.map(() => rowHeight), [shown, rowHeight]);
  const win = useWindowed(heights, box);
  const { scrollToIndex } = win;

  // The selected row stays in view as the keys move it.
  useEffect(() => {
    scrollToIndex(shown.findIndex((r) => r.id === selected));
  }, [selected, shown, scrollToIndex]);

  const selectable = (r: TreeNode) => r.kind !== "note";
  const toggle = (id: string, open: boolean) => {
    const next = new Set(collapsed);
    if (open) next.delete(id);
    else next.add(id);
    onCollapsed(next);
  };

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const at = shown.findIndex((r) => r.id === selected);
    const cur = at >= 0 ? shown[at] : null;
    const move = (step: number) => {
      for (let i = at + step; i >= 0 && i < shown.length; i += step) {
        if (selectable(shown[i])) return onSelect(shown[i].id);
      }
    };
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (at < 0) {
        const first = shown.find(selectable);
        if (first) onSelect(first.id);
      } else move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "ArrowRight" && cur) {
      e.preventDefault();
      if (cur.hasChildren && collapsed.has(cur.id)) toggle(cur.id, true);
      else if (cur.hasChildren) move(1);
    } else if (e.key === "ArrowLeft" && cur) {
      e.preventDefault();
      if (cur.hasChildren && !collapsed.has(cur.id)) toggle(cur.id, false);
      else if (cur.parent) onSelect(cur.parent);
    }
  }

  return (
    <div ref={box} className="compare-tree" role="tree" aria-label="Differences" tabIndex={0} onKeyDown={onKey} onScroll={win.onScroll}>
      <div role="presentation" style={{ height: win.before }} />
      {shown.slice(win.start, win.end).map((r, k) => {
        const i = win.start + k;
        const on = r.id === selected;
        const open = r.hasChildren && !collapsed.has(r.id);
        return (
          <div
            key={r.id}
            role="treeitem"
            aria-level={r.level + 1}
            aria-selected={on}
            aria-expanded={r.hasChildren ? open : undefined}
            title={r.mark ? `${r.name}, ${r.mark}` : r.name}
            aria-label={r.mark ? `${r.name}, ${r.mark}` : r.name}
            className={["tree-row", "compare-trow", on && "tree-row-selected", r.kind === "note" && "compare-trow-note"].filter(Boolean).join(" ")}
            style={{ paddingLeft: `calc(8px + 20px * ${r.level})` }}
            onClick={() => {
              if (selectable(r)) onSelect(r.id);
            }}
          >
            <Guides g={guides[i]} />
            {r.hasChildren ? (
              <span
                className="tree-chevron compare-chevron"
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(r.id, !open);
                }}
              >
                <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
              </span>
            ) : (
              <span className="tree-chevron" aria-hidden="true" />
            )}
            {r.mark ? (
              <MarkIcon mark={r.mark} />
            ) : (
              <Icon name={r.kind === "scope" ? "database" : r.kind === "note" ? "list" : "folder"} size={14} />
            )}
            <span className={r.kind === "item" || r.kind === "table" ? "compare-trow-name mono" : "compare-trow-name"}>{r.name}</span>
            {r.detail && <span className="compare-trow-detail mono">{r.detail}</span>}
            {r.mark && <span className={`compare-trow-word compare-word-${r.mark}`}>{r.mark}</span>}
            {r.count !== null && <span className="tree-count">{r.count.toLocaleString("en-US")}</span>}
          </div>
        );
      })}
      <div role="presentation" style={{ height: win.after }} />
    </div>
  );
}
