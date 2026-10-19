// Lineage's canvas pieces: the 214 px table card, the dashed diagram or view card, and the dashed line
// between that card and the table, routed square by the drawn diagrams' router (Task 5).
import { BaseEdge, type EdgeProps, Handle, type InternalNode, type NodeProps, Position, useInternalNode } from "@xyflow/react";
import { memo } from "react";
import type { LineageTable } from "../api/types";
import CardFrame from "../diagram/CardFrame";
import { type Rect, routeOrthogonal } from "../diagram/route";
import Icon from "../components/Icon";
import { Anchors } from "../querydiagram/ShapeCard";
import { LINEAGE_CARD_WIDTH, moreColumns } from "./scene";

/** A row's ends are `c:{column}:t` and `c:{column}:s`; the card's own are `card:t` and `card:s`. */
export const columnPort = (column: string) => `c:${column}`;

export type LineageCardData = {
  table: LineageTable;
  center: boolean;
  /** Columns tinted because their line is marked from the panel. */
  drive: string[];
  onDouble(): void;
};

function Card({ data, selected }: NodeProps) {
  const d = data as LineageCardData;
  const t = d.table;
  const more = moreColumns(t);
  const rows = (
    <>
      {t.columns.map((c) => (
        <li key={c.name} className={d.drive.includes(c.name) ? "table-card-column lineage-row lineage-drive" : "table-card-column lineage-row"} data-column={c.name}>
          <Anchors id={columnPort(c.name)} />
          <span className={c.pk ? "lineage-mark lineage-mark-pk" : c.fk ? "lineage-mark lineage-mark-fk" : "lineage-mark"}>{c.pk ? "PK" : c.fk ? "FK" : ""}</span>
          <span className="lineage-col-name">{c.name}</span>
          <span className="lineage-col-type">{c.nullable ? `${c.ty} ?` : c.ty}</span>
        </li>
      ))}
      {more > 0 && (
        <li className="lineage-more">
          {more} more {more === 1 ? "column" : "columns"}
        </li>
      )}
      {t.unreadable && <li className="lineage-unreadable">{t.unreadable}</li>}
    </>
  );
  return (
    <div className={d.center ? "lineage-card lineage-center" : "lineage-card"} onDoubleClick={d.onDouble}>
      <Anchors id="card" />
      <CardFrame
        kind="table"
        label={`Table ${t.path.name}`}
        name={t.path.name}
        title={<span className="table-card-name">{t.path.name}</span>}
        subtitle={t.path.schema ?? t.path.database}
        rows={rows}
        count={t.columnCount}
        countLabel={t.unreadable ? "?" : undefined}
        selected={!!selected}
        width={LINEAGE_CARD_WIDTH}
        tone={t.unreadable ? "danger" : undefined}
        dashed={!!t.unreadable}
      />
    </div>
  );
}

/** Memo: hovering a panel row gives new data only to the card it marks, so the others don't redraw. */
// The card draws from its data and selection only; the canvas hands every node new sizes when any node changes.
export const LineageCard = memo(Card, (a, b) => a.data === b.data && a.selected === b.selected);

export type RefCardData = { kind: "flow" | "view"; title: string; file: string; onDouble(): void };

/** A diagram that reads or writes the table, or a view that selects from it: a dashed card below the table. */
export function RefCard({ data }: NodeProps) {
  const d = data as RefCardData;
  return (
    <div className="lineage-ref" role="group" aria-label={`${d.kind === "flow" ? "Diagram" : "View"} ${d.file}`} onDoubleClick={d.onDouble}>
      <Handle type="source" position={Position.Top} isConnectable={false} className="edge-anchor" />
      <Handle type="target" position={Position.Top} isConnectable={false} className="edge-anchor" />
      <span className="lineage-ref-file">
        <Icon name={d.kind === "flow" ? "flow" : "view"} size={14} />
        {d.file}
      </span>
      <b className="lineage-ref-title">{d.title}</b>
    </div>
  );
}

function rectOf(n: InternalNode): Rect {
  return {
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    w: n.measured.width ?? n.width ?? n.initialWidth ?? 0,
    h: n.measured.height ?? n.height ?? n.initialHeight ?? 0,
  };
}

/** Edge type `lineageRef`: box to box, square with 8 px corners, from the side facing the other card. */
export function RefEdge(props: EdgeProps) {
  const a = useInternalNode(props.source);
  const b = useInternalNode(props.target);
  if (!a || !b) return null;
  const route = routeOrthogonal(rectOf(a), rectOf(b));
  return <BaseEdge id={props.id} path={route.d} markerStart={props.markerStart} markerEnd={props.markerEnd} style={props.style} interactionWidth={0} />;
}
