// The engine's card: a 216 px card in full detail, a 100 x 48 name box zoomed out, a plain block further out.
import { Handle, Position } from "@xyflow/react";
import { createContext, type CSSProperties, type PointerEvent, type ReactNode, useContext, useRef, useState } from "react";
import Icon, { type IconName } from "../components/Icon";
import { useDetail } from "./detail";
import { type CardKind, NODE_TOKENS } from "./types";

const KIND_ICON: Record<CardKind, IconName> = { table: "table", view: "view", derived: "layers", result: "columns" };

/** False while the canvas takes no new connections (read only, fast mode, or no handler). */
export const ConnectableContext = createContext(true);

/**
 * A column row's two ports: a target dot on the left and a source dot on the right, with handle ids
 * `{column}:t` and `{column}:s` (columnOfHandle in DiagramCanvas reads them back).
 */
export function Ports({ column, connectable = true }: { column: string; connectable?: boolean }) {
  const on = useContext(ConnectableContext) && connectable;
  return (
    <>
      <Handle type="target" id={`${column}:t`} position={Position.Left} isConnectable={on} />
      <Handle type="source" id={`${column}:s`} position={Position.Right} isConnectable={on} />
    </>
  );
}

/** A card's width can be dragged between these (item 25). */
export const MIN_CARD_WIDTH = 200;
export const MAX_CARD_WIDTH = 480;

const CORNERS = ["nw", "ne", "sw", "se"] as const;

/** A width drag from a corner: a left corner moves the left edge, a right corner the right edge. */
export function draggedWidth(start: number, corner: (typeof CORNERS)[number], dx: number): { width: number; shift: number } {
  const left = corner === "nw" || corner === "sw";
  const width = Math.round(Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, left ? start - dx : start + dx)));
  return { width, shift: left ? start - width : 0 };
}

/**
 * The selection: a 2 px accent outline 5 px outside the card, with a square handle on each corner. With
 * `onResize` the handles drag the card's width (its height follows its rows); without it they are not drawn,
 * so no handle ever promises a resize that does nothing (item 25).
 */
function SelBox({ resize }: { resize?: { width: number; onDrag(width: number, shift: number): void; onDone(width: number, shift: number): void } }) {
  const drag = useRef<{ x: number; corner: (typeof CORNERS)[number]; last: { width: number; shift: number } } | null>(null);
  if (!resize) return <div className="selbox" aria-hidden="true" />;
  const down = (corner: (typeof CORNERS)[number]) => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, corner, last: { width: resize.width, shift: 0 } };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    // The canvas zoom scales the card: a screen pixel is 1 / zoom of the card's own.
    const zoom = Number(e.currentTarget.closest<HTMLElement>(".react-flow__viewport")?.style.transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1) || 1;
    d.last = draggedWidth(resize.width, d.corner, (e.clientX - d.x) / zoom);
    resize.onDrag(d.last.width, d.last.shift);
  };
  const up = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    resize.onDone(d.last.width, d.last.shift);
  };
  return (
    <div className="selbox is-resizable" aria-hidden="true">
      {CORNERS.map((c) => (
        <i
          key={c}
          className="nodrag nopan"
          data-corner={c}
          title="Drag to change the width"
          onPointerDown={down(c)}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      ))}
    </div>
  );
}

export interface CardFrameProps {
  kind: CardKind;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** The column rows (`li`), drawn only in full detail. */
  rows: ReactNode;
  count: number;
  /** Shown in place of `count`: "?" when the count is not known, "" to show none (a card still loading). */
  countLabel?: string;
  selected: boolean;
  width?: number;
  /** The card's accessible name, at every level of detail ("Table stores"). */
  label?: string;
  /** The plain name the zoomed-out box shows; `title` when absent. */
  name?: string;
  /** A danger edge (missing table) or a warning edge (lone card). */
  tone?: "danger" | "warning";
  dashed?: boolean;
  /** Makes the selection handles drag the width; called once when the drag ends, with how far the left edge moved. */
  onResize?: (width: number, shift: number) => void;
}

export default function CardFrame({ kind, title, subtitle, actions, rows, count, countLabel, selected, width, label, name, tone, dashed, onResize }: CardFrameProps) {
  const { detail } = useDetail();
  // While a width drag runs the card draws its live width; the owner gets the result once, at the end.
  const [live, setLive] = useState<{ width: number; shift: number } | null>(null);
  const tokens = NODE_TOKENS[kind];
  const style = { "--card-fill": `var(${tokens.fill})`, "--card-stroke": `var(${tokens.stroke})` } as CSSProperties;
  const marks = `${tone ? ` card-${tone}` : ""}${dashed ? " card-dashed" : ""}`;

  if (detail !== "full") {
    // Edges end on the box's sides: no column ports at this size.
    const anchors = (
      <>
        <Handle type="target" position={Position.Left} isConnectable={false} className="edge-anchor" />
        <Handle type="source" position={Position.Right} isConnectable={false} className="edge-anchor" />
      </>
    );
    if (detail === "block") {
      return (
        <div className={`card-block${marks}`} role="group" aria-label={label} style={style}>
          {anchors}
          {selected && <SelBox />}
        </div>
      );
    }
    return (
      <div className={`card-box${marks}`} role="group" aria-label={label} style={style}>
        <span className="card-box-name">{name ?? title}</span>
        {countLabel !== "" && (
          <span className="card-box-count">
            {countLabel ?? count} {countLabel === undefined && count === 1 ? "column" : "columns"}
          </span>
        )}
        {anchors}
        {selected && <SelBox />}
      </div>
    );
  }

  const shown = live?.width ?? width;
  const sized: CSSProperties = { ...style, ...(shown ? { width: shown } : {}), ...(live?.shift ? { marginLeft: live.shift } : {}) };
  const resize =
    onResize && width
      ? {
          width,
          onDrag: (w: number, shift: number) => setLive({ width: w, shift }),
          onDone: (w: number, shift: number) => {
            setLive(null);
            if (w !== width) onResize(w, shift);
          },
        }
      : undefined;
  return (
    <div className={`table-card${marks}`} role="group" aria-label={label} style={sized}>
      <div className="table-card-header">
        <Icon name={KIND_ICON[kind]} className="table-card-icon" />
        {title}
        {subtitle != null && <span className="table-card-schema">{subtitle}</span>}
        <span className="table-card-spacer" />
        {countLabel !== "" && <span className="table-card-count">{countLabel ?? count}</span>}
        {actions}
      </div>
      <ul className="table-card-columns">{rows}</ul>
      {selected && <SelBox resize={resize} />}
    </div>
  );
}
