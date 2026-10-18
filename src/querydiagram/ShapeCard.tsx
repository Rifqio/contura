// A query diagram card: one table, view, CTE or subquery the statement reads (frame 6.2, ruling D1).
import { Handle, type NodeProps, Position } from "@xyflow/react";
import CardFrame from "../diagram/CardFrame";
import Icon from "../components/Icon";
import { CARD_HEADER, CARD_ROW, QUERY_CARD_WIDTH } from "../diagram/metrics";
import type { ShapeTable } from "../lang/sql/queryShape";

/** `failed`: the schema of the database the table names did not load; `onRetry` loads it again. */
export type ShapeCardData = { table: ShapeTable; failed?: boolean; onRetry?(): void };

/** A card row's port id: by index, since a derived card can repeat a name, and `card` is the header's. */
export const rowPort = (index: number) => `c${index}`;

/** The rows a card draws: its columns, then "N more columns" and "Not in the schema" lines. */
export function shapeCardRows(t: ShapeTable): number {
  return t.columns.length + (t.more > 0 ? 1 : 0) + (t.kind === "unknown" ? 1 : 0);
}

/** The card's height on the canvas: header, rows, and the list's 4 px padding top and bottom. */
export const shapeCardHeight = (t: ShapeTable) => CARD_HEADER + CARD_ROW * shapeCardRows(t) + 8;

/** The card's node kind and colours: unknown tables are drawn as tables with a dashed danger edge. */
export const shapeKind = (t: ShapeTable) => (t.kind === "unknown" ? "table" : t.kind);

/** "Table orders o", "View daily_sales", "Derived late": the card's accessible name. */
export function shapeLabel(t: ShapeTable): string {
  const kind = t.kind === "view" ? "View" : t.kind === "derived" ? "Derived" : "Table";
  return t.alias && t.alias !== t.name ? `${kind} ${t.name} ${t.alias}` : `${kind} ${t.name}`;
}

/**
 * The two ends of a row (or of the header, id `card`): `{id}:t` on the left, `{id}:s` on the
 * right. Read only, so they are never drawn or dragged (`edge-anchor`).
 */
export function Anchors({ id }: { id: string }) {
  return (
    <>
      <Handle type="target" id={`${id}:t`} position={Position.Left} isConnectable={false} className="edge-anchor" />
      <Handle type="source" id={`${id}:s`} position={Position.Right} isConnectable={false} className="edge-anchor" />
    </>
  );
}

export default function ShapeCard({ data, selected }: NodeProps & { data: ShapeCardData }) {
  const t = data.table;
  const unknown = t.kind === "unknown";
  const title = (
    <>
      <span className="table-card-name">{t.name}</span>
      {t.alias && t.alias !== t.name && <span className="table-card-alias qd-alias">{t.alias}</span>}
    </>
  );
  // The schema sits at the right of the header (frame 6.2), with the chips before it.
  const actions = (
    <>
      {t.kind === "derived" && <span className="chip chip-neutral qd-chip">derived</span>}
      {t.schemaState === "loading" && t.kind !== "derived" && <span className="chip chip-neutral qd-chip">Loading schema</span>}
      {t.schema && <span className="table-card-schema">{t.schema}</span>}
    </>
  );
  const rows = (
    <>
      {t.columns.map((c, i) => (
        <li key={i} className="table-card-column qd-row" data-column={c.name}>
          <Anchors id={rowPort(i)} />
          <span className={c.pk ? "table-card-key table-card-pk" : "table-card-key"} aria-hidden="true">
            {c.pk && <Icon name="key" size={14} />}
          </span>
          <span className="qd-row-name">{c.name}</span>
          <span className="table-card-col-type qd-mono">{c.type ?? ""}</span>
        </li>
      ))}
      {t.more > 0 && (
        <li className="qd-more">
          {t.more} more {t.more === 1 ? "column" : "columns"}
        </li>
      )}
      {unknown && (
        <li className="qd-note qd-note-danger">
          {data.failed ? "Schema did not load." : "Not in the schema"}
          {data.failed && data.onRetry && (
            <button type="button" className="link-button nodrag" onClick={data.onRetry}>
              Try again
            </button>
          )}
        </li>
      )}
    </>
  );
  return (
    <div className="qd-card">
      <Anchors id="card" />
      <CardFrame
        kind={shapeKind(t)}
        label={shapeLabel(t)}
        name={t.name}
        title={title}
        actions={actions}
        rows={rows}
        count={t.columns.length + t.more}
        selected={!!selected}
        width={QUERY_CARD_WIDTH}
        tone={unknown ? "danger" : undefined}
        dashed={unknown}
      />
    </div>
  );
}
