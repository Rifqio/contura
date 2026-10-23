// The engine's card: a 216 px card in full detail, a 100 x 48 name box zoomed out, a plain block further out.
import { Handle, Position, useNodeId, useReactFlow } from "@xyflow/react";
import { createContext, type CSSProperties, type ReactNode, useContext } from "react";
import Icon, { type IconName } from "../components/Icon";
import { useDetail } from "./detail";
import { cardHeight } from "./metrics";
import { type Box, ResizeZones } from "./resize";
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

/** The widest a card grows on its own to show its names whole (item 32). */
export const MAX_CARD_WIDTH = 480;
/** Board B2 (items 25, 41): a card is dragged between these widths; one wider on its own may keep its width. */
export const CARD_LIMITS = { minW: 216, maxW: 340 };

/**
 * Board B2 (items 25, 41): the pointer zones of a selected card that resizes. A drag is live: once a frame the node
 * takes the new box in React Flow, so its Join lines follow; the owner gets the box once, at the end.
 */
function CardZones({ width, height, fullHeight, onResize }: { width: number; height?: number; fullHeight?: number; onResize(box: Box): void }) {
  const id = useNodeId();
  const flow = useReactFlow();
  return (
    <ResizeZones
      start={() => {
        const n = id ? flow.getInternalNode(id) : undefined;
        return { x: n?.position.x ?? 0, y: n?.position.y ?? 0, w: width, h: height ?? fullHeight ?? n?.measured.height ?? 0 };
      }}
      limits={(from) => {
        const full = fullHeight ?? from.h;
        return { minW: CARD_LIMITS.minW, maxW: Math.max(CARD_LIMITS.maxW, from.w), minH: Math.min(full, cardHeight(2)), maxH: full };
      }}
      onLive={(box, node) => {
        node?.classList.add("is-resizing");
        if (!id) return;
        flow.updateNode(id, { position: { x: box.x, y: box.y }, width: box.w, height: box.h });
      }}
      onDone={(box, from, node) => {
        if (box.x === from.x && box.y === from.y && box.w === from.w && box.h === from.h) {
          node?.classList.remove("is-resizing");
          if (id) flow.updateNode(id, { position: { x: from.x, y: from.y }, width: undefined, height: undefined });
          return;
        }
        // The node keeps the live box until its owner draws it again at the kept size.
        requestAnimationFrame(() => node?.classList.remove("is-resizing"));
        onResize(box);
      }}
      onCancel={(from, node) => {
        node?.classList.remove("is-resizing");
        if (id) flow.updateNode(id, { position: { x: from.x, y: from.y }, width: undefined, height: undefined });
      }}
    />
  );
}

/** The selection: a 2 px accent outline 5 px outside the card. */
function SelBox() {
  return <div className="selbox" aria-hidden="true" />;
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
  /**
   * Board B2 (items 25, 41): the selected card resizes from pointer zones on its edges and corners, live, and this
   * gets its new box once, when the drag ends.
   */
  onResize?: (box: Box) => void;
  /** The card's height when it is shorter than its rows (they scroll inside it); none shows every row. */
  height?: number;
  /** The height that shows every row: the most a card is dragged to. */
  fullHeight?: number;
  /** The column list scrolled (a card shorter than its rows). */
  onRowsScroll?: (list: HTMLUListElement) => void;
}

export default function CardFrame({
  kind,
  title,
  subtitle,
  actions,
  rows,
  count,
  countLabel,
  selected,
  width,
  label,
  name,
  tone,
  dashed,
  onResize,
  height,
  fullHeight,
  onRowsScroll,
}: CardFrameProps) {
  const { detail } = useDetail();
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

  // A card as tall as its rows, or taller, keeps no height of its own.
  const scroll = height !== undefined && fullHeight !== undefined && height < fullHeight;
  const sized: CSSProperties = { ...style, ...(width ? { width } : {}), ...(scroll ? { height } : {}) };
  const zones = selected && onResize && width ? <CardZones width={width} height={scroll ? height! : undefined} fullHeight={fullHeight} onResize={onResize} /> : null;
  return (
    <div className={`table-card${marks}${scroll ? " table-card-scroll" : ""}`} role="group" aria-label={label} style={sized}>
      <div className="table-card-header">
        <Icon name={KIND_ICON[kind]} className="table-card-icon" />
        {title}
        {subtitle != null && <span className="table-card-schema">{subtitle}</span>}
        <span className="table-card-spacer" />
        {countLabel !== "" && <span className="table-card-count">{countLabel ?? count}</span>}
        {actions}
      </div>
      {/* A shorter card scrolls its rows: the wheel scrolls them, not the canvas. */}
      <ul className={scroll ? "table-card-columns nowheel" : "table-card-columns"} onScroll={onRowsScroll ? (e) => onRowsScroll(e.currentTarget) : undefined}>
        {rows}
      </ul>
      {selected && <SelBox />}
      {zones}
    </div>
  );
}
