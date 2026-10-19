// The engine's card: a 216 px card in full detail, a 100 x 48 name box zoomed out, a plain block further out.
import { Handle, Position } from "@xyflow/react";
import { createContext, type CSSProperties, type ReactNode, useContext } from "react";
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

/** The selection: a 2 px accent outline 5 px outside the card, with a square handle on each corner. */
function SelBox() {
  return (
    <div className="selbox" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
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
}

export default function CardFrame({ kind, title, subtitle, actions, rows, count, countLabel, selected, width, label, name, tone, dashed }: CardFrameProps) {
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

  return (
    <div className={`table-card${marks}`} role="group" aria-label={label} style={width ? { ...style, width } : style}>
      <div className="table-card-header">
        <Icon name={KIND_ICON[kind]} className="table-card-icon" />
        {title}
        {subtitle != null && <span className="table-card-schema">{subtitle}</span>}
        <span className="table-card-spacer" />
        {countLabel !== "" && <span className="table-card-count">{countLabel ?? count}</span>}
        {actions}
      </div>
      <ul className="table-card-columns">{rows}</ul>
      {selected && <SelBox />}
    </div>
  );
}
