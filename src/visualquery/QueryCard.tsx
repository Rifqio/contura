// A Visual Query card on the engine's frame: tick columns, see keys and Joins, rename the alias.
import { type NodeProps, useUpdateNodeInternals } from "@xyflow/react";
import { createContext, type KeyboardEvent, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Aggregate, VqTable } from "../api/types";
import Icon from "../components/Icon";
import { type MenuItem, MenuList } from "../components/Menu";
import { useDismiss } from "../components/useDismiss";
import CardFrame, { MAX_CARD_WIDTH, Ports } from "../diagram/CardFrame";
import { CARD_ROW, CARD_WIDTH, cardHeight } from "../diagram/metrics";

/** Over this many columns a card shows only ticked, key and joined ones until it is expanded. */
export const MANY_COLUMNS = 12;
/** Item 41: a card shorter than its rows draws only the rows in view (and the joined ones) past this many. */
export const WINDOW_ROWS = 40;
/** Rows drawn above and below the ones in view. */
const OVERSCAN = 6;

/**
 * The rows a scrolling card draws: those in view around `first`, plus every joined row (its port keeps the Join's
 * line), in order, with the gaps between them as row counts.
 */
export function windowRows(count: number, first: number, visible: number, keep: ReadonlySet<number>): ({ index: number } | { gap: number; at: number })[] {
  const lo = Math.max(0, first - OVERSCAN);
  const hi = Math.min(count, first + visible + OVERSCAN);
  const want = new Set<number>();
  for (let i = lo; i < hi; i++) want.add(i);
  for (const i of keep) if (i >= 0 && i < count) want.add(i);
  const out: ({ index: number } | { gap: number; at: number })[] = [];
  let at = 0;
  for (const i of [...want].sort((a, b) => a - b)) {
    if (i > at) out.push({ gap: i - at, at });
    out.push({ index: i });
    at = i + 1;
  }
  if (count > at) out.push({ gap: count - at, at });
  return out;
}

export interface CardColumn {
  name: string;
  /** Null while the schema has not arrived, or when the table was not found. */
  type: string | null;
  pk: boolean;
}

/**
 * `loading`: its schema is on the way; `failed`: its schema did not load (Try again); `closed`:
 * the Connection is not open, so nothing can load; `missing`: the loaded schema lacks the table.
 */
export type CardState = "ok" | "loading" | "failed" | "closed" | "missing";

export type QueryCardData = {
  table: VqTable;
  kind: "table" | "view";
  columns: CardColumn[];
  /** Ticked columns: the aggregate of the first output of each, or null. */
  ticked: Record<string, Aggregate | null>;
  joined: string[];
  state: CardState;
  /** Not joined to anything: written as a CROSS JOIN. */
  lone: boolean;
  /** Where the card's table should be, for "Not found in {database}". */
  home: string;
  /** Problems the Core gave for this card. */
  problems: string[];
  expanded: boolean;
  root: boolean;
  /** The card's width when it was dragged (item 25), else the engine's 216 px. */
  width?: number;
  /** Item 41: the card's height when it was dragged shorter than its rows, which then scroll inside it. */
  height?: number;
  /** Columns of a Join the server's error points into, marked danger until the next change. */
  dangerColumns?: string[];
};

/** The row a column drag is over: the drop target, gold when the two types differ. */
export type DropTarget = { table: string; column: string; warn: boolean };
/** Context, not node data: a drag must not rebuild the nodes under React Flow while it runs. */
export const DropTargetContext = createContext<DropTarget | null>(null);

/** What a card can ask of its tab; one stable object, so cards need no callbacks in their data. */
export interface CardActions {
  toggle(tableId: string, column: string): void;
  remove(tableId: string): void;
  rename(tableId: string, alias: string): void;
  setRoot(tableId: string): void;
  expand(tableId: string): void;
  /** Loads the card's schema again after it failed. */
  retry(tableId: string): void;
  /** A resize ended (board B2): the card's new box; `h` is null when every row shows. */
  resize(tableId: string, box: { x: number; y: number; w: number; h: number | null }): void;
  /** Ticks every column of the card not ticked yet, in the card's order. */
  tickAll(tableId: string, columns: string[]): void;
  /** Unticks every column of the card. */
  untickAll(tableId: string): void;
  /** J on a column row: a list of the other cards' columns to join it to. */
  joinFrom(tableId: string, column: string, anchor: DOMRect): void;
}

export const CardActionsContext = createContext<CardActions | null>(null);

const AGG_TAG: Record<Aggregate, string> = {
  count: "count",
  countDistinct: "count distinct",
  sum: "sum",
  avg: "avg",
  min: "min",
  max: "max",
};

/** The rows a card draws: all of them, or (over 12 and not expanded) ticked, key and joined ones. */
export function shownColumns(d: Pick<QueryCardData, "columns" | "ticked" | "joined" | "expanded">): { rows: CardColumn[]; more: number } {
  if (d.columns.length <= MANY_COLUMNS || d.expanded) return { rows: d.columns, more: 0 };
  const rows = d.columns.filter((c) => c.pk || c.name in d.ticked || d.joined.includes(c.name));
  return { rows, more: d.columns.length - rows.length };
}

/** The card's height for the canvas fit: header, rows, the "more" row and the note lines. */
export function queryCardHeight(d: QueryCardData): number {
  const { rows, more } = shownColumns(d);
  // Loading shows a header chip and a closed Connection only the banner: neither draws a note row.
  const note = d.state === "missing" || d.state === "failed" || (d.state === "ok" && d.lone);
  const notes = (note ? 1 : 0) + d.problems.length + (more > 0 ? 1 : 0);
  return cardHeight(rows.length) + notes * CARD_ROW;
}

/** Code small (12 px JetBrains Mono) and Code micro (11 px) advance widths, and UI small's average. */
const MONO = 7.2;
const MONO_MICRO = 6.6;
const UI_SMALL = 6.5;

/**
 * The width a card needs to show its table name, alias and column names whole (item 32: Contura never
 * shortens a name on its own). The engine's 216 px at least, 480 px at most; a dragged width wins over it.
 */
export function fitWidth(d: Pick<QueryCardData, "table" | "columns" | "home">): number {
  const schema = Math.min((d.table.schema ?? d.home).length, 14) * UI_SMALL;
  // Padding, icon, gaps, count and the two 24 px buttons, then the name and alias.
  const header = 126 + (d.table.name.length + d.table.alias.length) * MONO + schema;
  // Check box, key mark, gaps and padding, then the column name and its type.
  const rows = Math.max(0, ...d.columns.map((c) => 70 + c.name.length * MONO + (c.type ?? "").length * MONO_MICRO));
  return Math.round(Math.min(MAX_CARD_WIDTH, Math.max(CARD_WIDTH, header, rows)));
}

/** The alias: mono and subtle, edited on double-click; Enter keeps, Esc cancels. */
function Alias({ value, name, onCommit }: { value: string; name: string; onCommit(v: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    return (
      <input
        className="vq-card-alias-input card-input nodrag"
        aria-label={`Alias of ${name}`}
        value={draft}
        autoFocus
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            const v = draft.trim();
            setDraft(null);
            if (v && v !== value) onCommit(v);
          } else if (e.key === "Escape") setDraft(null);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="vq-card-alias card-text"
      title="Double-click to change the alias"
      aria-label={`Alias ${value}`}
      onDoubleClick={() => setDraft(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          setDraft(value);
        }
      }}
    >
      {value}
    </button>
  );
}

/** Where the card's menu is open: under its More button, or where it was right-clicked (item 26). */
type MenuAt = { x: number; y: number; from: "button" | "pointer" };

/** The card's actions (frame VisualQuery, card menu): each row says what it does (item 27). */
function CardMenu({
  name,
  root,
  at,
  setAt,
  onRoot,
  onTickAll,
  onUntickAll,
  onRemove,
}: {
  name: string;
  root: boolean;
  at: MenuAt | null;
  setAt(at: MenuAt | null): void;
  onRoot(): void;
  onTickAll(): void;
  onUntickAll(): void;
  onRemove(): void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => {
    const from = at?.from;
    setAt(null);
    if (from === "button") button.current?.focus();
  };
  // Item 28: a press outside or Escape closes it, wherever focus is.
  useDismiss(at !== null, [menu, button], close);
  const items: MenuItem[] = [
    {
      key: "root",
      label: `Start the query from ${name}`,
      description: root ? "It is first after FROM already. The Joins follow from it." : "Puts it first after FROM. The Joins follow from it.",
      icon: <Icon name="chevronRight" />,
      disabled: root,
      onSelect: onRoot,
    },
    { key: "tick", label: "Tick every column", icon: <Icon name="check" />, separatorBefore: true, onSelect: onTickAll },
    { key: "untick", label: "Untick every column", icon: <Icon name="close" />, onSelect: onUntickAll },
    { key: "remove", label: "Remove from the query", icon: <Icon name="trash" />, shortcut: "Delete", danger: true, separatorBefore: true, onSelect: onRemove },
  ];
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-button nodrag"
        aria-label={`More for ${name}`}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={() => {
          if (at) return close();
          const box = button.current?.getBoundingClientRect();
          setAt({ x: box?.left ?? 0, y: box?.bottom ?? 0, from: "button" });
        }}
      >
        <Icon name="moreHorizontal" size={14} />
      </button>
      {/* Portalled: a menu never sits inside the clipped canvas. */}
      {at &&
        createPortal(
          <div ref={menu} className="tree-menu vq-card-menu" style={{ left: at.x, top: at.y }}>
            <MenuList label={`${name} actions`} onClose={close} items={items} />
          </div>,
          document.body,
        )}
    </>
  );
}

export default function QueryCard({ id, data, selected }: NodeProps & { data: QueryCardData }) {
  const act = useContext(CardActionsContext);
  const drop = useContext(DropTargetContext);
  const { table, kind, ticked, joined, state, lone, problems } = data;
  const { rows, more } = shownColumns(data);
  const full = queryCardHeight(data);
  const scrolls = data.height !== undefined && data.height < full;
  // Item 41: a long card shorter than its rows draws only the rows in view; the window moves a row at a time.
  const windowed = scrolls && rows.length > WINDOW_ROWS;
  const [first, setFirst] = useState(0);
  const updateInternals = useUpdateNodeInternals();
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // Once a frame while the rows scroll: the Join lines find their ports again, and the window follows.
  const onRowsScroll = (list: HTMLUListElement) => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      list.classList.toggle("is-scrolled", list.scrollTop > 0);
      list.classList.toggle("is-at-end", list.scrollTop + list.clientHeight >= list.scrollHeight - 1);
      if (windowed) setFirst(Math.floor(list.scrollTop / CARD_ROW));
      updateInternals(id);
    });
  };
  const tone = state === "missing" ? "danger" : lone ? "warning" : undefined;
  const [menuAt, setMenuAt] = useState<MenuAt | null>(null);

  const onRowKey = (column: string) => (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      e.stopPropagation();
      act?.toggle(table.id, column);
    } else if ((e.key === "j" || e.key === "J") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      act?.joinFrom(table.id, column, e.currentTarget.getBoundingClientRect());
    }
  };
  const onCardKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    // A portalled menu's keys bubble here through React: they are the menu's, not the card's.
    if (e.key !== "Delete" || t.tagName === "INPUT" || !e.currentTarget.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
    act?.remove(table.id);
  };

  const title = (
    <>
      <span className="table-card-name">{table.name}</span>
      <Alias value={table.alias} name={table.name} onCommit={(v) => act?.rename(table.id, v)} />
    </>
  );
  const actions = (
    <>
      {state === "loading" && <span className="chip chip-neutral vq-card-loading">Loading schema</span>}
      <CardMenu
        name={table.name}
        root={data.root}
        at={menuAt}
        setAt={setMenuAt}
        onRoot={() => act?.setRoot(table.id)}
        onTickAll={() => act?.tickAll(table.id, data.columns.map((c) => c.name))}
        onUntickAll={() => act?.untickAll(table.id)}
        onRemove={() => act?.remove(table.id)}
      />
      <button
        type="button"
        className="icon-button nodrag"
        aria-label={`Remove ${table.name}`}
        title="Remove (Delete)"
        onClick={() => act?.remove(table.id)}
      >
        <Icon name="trash" size={14} />
      </button>
    </>
  );

  const rowOf = (c: CardColumn) => {
    const on = c.name in ticked;
    const agg = ticked[c.name] ?? null;
    const link = joined.includes(c.name);
    const target = drop?.table === table.id && drop.column === c.name ? drop : null;
    return (
      <li
        key={c.name}
        className={[
          "table-card-column",
          "vq-card-row",
          on && "vq-card-row-on",
          state !== "ok" && state !== "loading" && "vq-card-row-faded",
          target && "vq-card-row-target",
          target?.warn && "vq-card-row-target-warn",
          data.dangerColumns?.includes(c.name) && "vq-card-row-danger",
        ]
          .filter(Boolean)
          .join(" ")}
        tabIndex={0}
        data-column={c.name}
        onKeyDown={onRowKey(c.name)}
      >
        <Ports column={c.name} />
        <input
          type="checkbox"
          className="vq-card-check nodrag"
          // The row is the one tab stop; Space on it ticks.
          tabIndex={-1}
          aria-label={`${table.alias}.${c.name}`}
          checked={on}
          onChange={() => act?.toggle(table.id, c.name)}
        />
        <span className="vq-card-mark" aria-hidden="true">
          {c.pk ? <Icon name="key" size={14} /> : link ? <Icon name="link" size={14} /> : null}
        </span>
        <span className="vq-card-col">{c.name}</span>
        {agg ? (
          <span className="vq-card-agg">{AGG_TAG[agg]}</span>
        ) : (
          // A closed Connection shows no types: they may have changed since.
          <span className="vq-card-type">{state === "closed" ? "" : (c.type ?? "")}</span>
        )}
      </li>
    );
  };
  const visible = Math.ceil((data.height ?? full) / CARD_ROW);
  const keep = new Set(rows.flatMap((c, i) => (joined.includes(c.name) ? [i] : [])));
  const lines = (
    <>
      {windowed
        ? windowRows(rows.length, first, visible, keep).map((r) =>
            "gap" in r ? <li key={`gap${r.at}`} className="vq-card-gap" aria-hidden="true" style={{ height: r.gap * CARD_ROW }} /> : rowOf(rows[r.index]),
          )
        : rows.map(rowOf)}
      {more > 0 && (
        <li className="vq-card-more">
          <button type="button" className="link-button nodrag" onClick={() => act?.expand(table.id)}>
            {more} more {more === 1 ? "column" : "columns"}
          </button>
        </li>
      )}
      {state === "missing" && <li className="vq-card-note vq-card-note-danger">Not found in {data.home}</li>}
      {state === "failed" && (
        <li className="vq-card-note vq-card-note-danger">
          Schema did not load.
          <button type="button" className="link-button nodrag" onClick={() => act?.retry(table.id)}>
            Try again
          </button>
        </li>
      )}
      {state === "ok" && lone && <li className="vq-card-note vq-card-note-warning">No Join. Runs as a CROSS JOIN.</li>}
      {problems.map((p) => (
        <li key={p} className="vq-card-note vq-card-note-danger">
          {p}
        </li>
      ))}
    </>
  );

  return (
    <div
      className="vq-card"
      onKeyDown={onCardKey}
      onContextMenu={(e) => {
        // Item 26: right-click on a card opens its own menu, not the canvas's.
        e.preventDefault();
        e.stopPropagation();
        setMenuAt({ x: e.clientX, y: e.clientY, from: "pointer" });
      }}
    >
      <CardFrame
        kind={kind}
        label={`${kind === "view" ? "View" : "Table"} ${table.name} ${table.alias}`}
        name={table.name}
        title={title}
        subtitle={table.schema ?? data.home}
        actions={actions}
        rows={lines}
        count={data.columns.length}
        selected={!!selected}
        width={data.width ?? fitWidth(data)}
        height={data.height}
        fullHeight={full}
        onRowsScroll={scrolls ? onRowsScroll : undefined}
        onResize={(box) => act?.resize(table.id, { ...box, h: box.h >= full ? null : box.h })}
        tone={tone}
        dashed={tone === "warning"}
      />
    </div>
  );
}
