// The table finder (frame 6.1): in place on an empty canvas, else over the canvas in a portal.
import { type ReactNode, type Ref, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hintFor } from "../commands/keymap";
import { useKeymap } from "../commands/useCommandKeys";
import Icon from "../components/Icon";
import Kbd from "../components/Kbd";
import { useDismiss } from "../components/useDismiss";
import { windowRange } from "../sidebar/treeModel";

export interface FinderTable {
  schema: string | null;
  name: string;
  kind: "table" | "view";
  rows: number | null;
}

export interface FinderProps {
  tables: FinderTable[];
  onAdd(t: FinderTable): void;
  onClose(): void;
  /** Drawn in the empty canvas instead of over it. */
  inline?: boolean;
  /** The canvas box the finder floats over, near its top. */
  anchor?: DOMRect | null;
  /** What a table with no schema of its own lives in (the tab's database), for the schema column. */
  home?: string | null;
  /** The search field, so Ctrl+Shift+A can focus the finder in place. */
  inputRef?: Ref<HTMLInputElement>;
  /** Databases whose tables are still on the way (V6), under the list. */
  loadingNote?: string | null;
}

export const FINDER_WIDTH = 420;
/** A row's height (`.vq-finder-row`) and the list's most (`.vq-finder-list`): only the rows in view are drawn. */
const ROW = 28;
const LIST_MAX = 280;
const rowsText = (n: number) => n.toLocaleString("en-US");

export default function Finder({ tables, onAdd, onClose, inline, anchor, home = null, inputRef, loadingNote }: FinderProps) {
  const { map } = useKeymap();
  const key = hintFor(map, "visualQuery.addTable");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tables.filter((t) => t.name.toLowerCase().includes(q) || (t.schema ?? "").toLowerCase().includes(q)) : tables;
  }, [tables, query]);
  const at = Math.min(active, Math.max(0, shown.length - 1));

  // ---- Only the rows in view are drawn: a server can reach thousands of tables (V6) ----
  const list = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  useLayoutEffect(() => {
    const h = list.current?.clientHeight ?? 0;
    if (h !== viewport) setViewport(h);
  });
  // Not laid out (a test DOM): draw the list's most.
  const view = viewport > 0 ? viewport : LIST_MAX;
  const { start, end } = windowRange(shown.length, scrollTop, view, ROW);

  // A press outside (the canvas too, which stops its own events) or Escape anywhere closes the floating finder (item 29).
  useDismiss(!inline, [root], onClose);

  // The active row stays in view, so it is always drawn.
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const top = at * ROW;
    let next = el.scrollTop;
    if (top < next) next = top;
    else if (top + ROW > next + view) next = top + ROW - view;
    if (next !== el.scrollTop) el.scrollTop = next;
    setScrollTop(next);
    // `view` changes only with the layout; the active row is what moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, shown]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length === 0) return;
      const by = e.key === "ArrowDown" ? 1 : -1;
      setActive((at + by + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const t = shown[at];
      if (t) onAdd(t);
    } else if (e.key === "Escape" && !inline) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  const body: ReactNode = (
    <>
      <div className="vq-finder-search">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          type="search"
          className="vq-finder-input"
          aria-label="Find a table"
          placeholder="Find a table"
          aria-controls={listId}
          aria-activedescendant={shown[at] ? `${listId}-${at}` : undefined}
          value={query}
          autoFocus={!inline}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            if (list.current) list.current.scrollTop = 0;
            setScrollTop(0);
          }}
          onKeyDown={onKey}
        />
        {key && <Kbd keys={key} />}
      </div>
      <div
        className="vq-finder-list"
        role="listbox"
        id={listId}
        aria-label="Tables"
        ref={list}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {start > 0 && <div role="presentation" style={{ height: start * ROW }} />}
        {shown.slice(start, end).map((t, k) => {
          const i = start + k;
          return (
            <div
              key={`${t.schema ?? ""}.${t.name}`}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === at}
              className={i === at ? "vq-finder-row vq-finder-row-on" : "vq-finder-row"}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onAdd(t)}
            >
              <Icon name={t.kind === "view" ? "view" : "table"} size={14} />
              <span className="vq-finder-name">{t.name}</span>
              <span className="vq-finder-schema">
                {[t.schema ?? home, t.kind === "view" ? "view" : null].filter(Boolean).join(", ")}
              </span>
              <span className="vq-finder-rows">{t.kind === "view" ? "view" : t.rows !== null ? rowsText(t.rows) : ""}</span>
            </div>
          );
        })}
        {end < shown.length && <div role="presentation" style={{ height: (shown.length - end) * ROW }} />}
        {shown.length === 0 && <p className="vq-finder-none">{query.trim() ? `Nothing matches "${query.trim()}".` : "No tables here yet."}</p>}
      </div>
      {loadingNote && <p className="vq-finder-none">{loadingNote}</p>}
      <p className="vq-finder-foot">Tables on other Connections are not listed. Data Transfer copies between Connections.</p>
    </>
  );

  if (inline) {
    return (
      <div className="vq-finder vq-finder-inline" ref={root}>
        {body}
      </div>
    );
  }
  const left = anchor ? Math.max(8, anchor.left + anchor.width / 2 - FINDER_WIDTH / 2) : 8;
  const top = anchor ? anchor.top + 48 : 48;
  return createPortal(
    <div className="vq-finder vq-finder-over" role="dialog" aria-label="Add table" ref={root} style={{ left, top }}>
      {body}
    </div>,
    document.body,
  );
}
