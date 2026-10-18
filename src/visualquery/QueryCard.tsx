// A Visual Query card on the engine's frame: tick columns, see keys and Joins, rename the alias.
import type { NodeProps } from "@xyflow/react";
import { createContext, type KeyboardEvent, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Aggregate, VqTable } from "../api/types";
import Icon from "../components/Icon";
import { MenuList } from "../components/Menu";
import CardFrame, { Ports } from "../diagram/CardFrame";
import { CARD_ROW, CARD_WIDTH, cardHeight } from "../diagram/metrics";

/** Over this many columns a card shows only ticked, key and joined ones until it is expanded. */
export const MANY_COLUMNS = 12;

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

function CardMenu({ name, root, onRoot }: { name: string; root: boolean; onRoot(): void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setAt(null);
    button.current?.focus();
  };
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
          setAt({ x: box?.left ?? 0, y: box?.bottom ?? 0 });
        }}
      >
        <Icon name="moreHorizontal" size={14} />
      </button>
      {/* Portalled: a menu never sits inside the clipped canvas. */}
      {at &&
        createPortal(
          <div className="tree-menu" style={{ left: at.x, top: at.y }}>
            <MenuList
              label={name}
              onClose={close}
              items={[{ key: "root", label: "Start FROM here", icon: <Icon name="arrowRight" />, disabled: root, onSelect: onRoot }]}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

export default function QueryCard({ data, selected }: NodeProps & { data: QueryCardData }) {
  const act = useContext(CardActionsContext);
  const drop = useContext(DropTargetContext);
  const { table, kind, ticked, joined, state, lone, problems } = data;
  const { rows, more } = shownColumns(data);
  const tone = state === "missing" ? "danger" : lone ? "warning" : undefined;

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
      <CardMenu name={table.name} root={data.root} onRoot={() => act?.setRoot(table.id)} />
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

  const lines = (
    <>
      {rows.map((c) => {
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
      })}
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
    <div className="vq-card" onKeyDown={onCardKey}>
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
        width={CARD_WIDTH}
        tone={tone}
        dashed={tone === "warning"}
      />
    </div>
  );
}
