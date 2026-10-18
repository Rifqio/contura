// A Join on the Visual Query canvas (edge type `join`): an orthogonal line between the two column
// rows with a dot at each end, and a badge at its midpoint with the Venn mark and the kind.
import { BaseEdge, type EdgeProps } from "@xyflow/react";
import { createContext, useContext, useId } from "react";
import type { JoinKind, SqlFk, SmEndpoint, VqJoin, VqTable } from "../api/types";
import { JoinBadge, orthogonalPath } from "../diagram/edges";
import type { VqSchema } from "./model";

export const KIND_LABEL: Record<JoinKind, string> = { inner: "Inner", left: "Left", right: "Right", full: "Full" };

/** What a Join edge carries. */
export type JoinEdgeData = {
  join: VqJoin;
  /** No Foreign Key in the schema has these pairs: the user drew it here (dashed). */
  madeHere: boolean;
  /** Its popover is open. */
  selected: boolean;
  /** A problem the Core gave for this Join, or (Task 9) a server error in its lines. */
  danger: string | null;
  /** "Join orders to stores", the badge's tooltip. */
  title: string;
};

/** What a badge asks of its tab: open the Join's popover (or the Pick popover) beside the badge. */
export const JoinActionsContext = createContext<{ open(joinId: string, anchor: DOMRect): void } | null>(null);

/**
 * The Venn mark of a Join kind: two circles, the kept part filled. Colours come from the CSS
 * (`currentColor`), so the theme draws it.
 */
export function VennMark({ kind }: { kind: JoinKind | null }) {
  const fillLeft = kind === "left" || kind === "full";
  const fillRight = kind === "right" || kind === "full";
  const clip = `vq-venn-${useId().replace(/:/g, "")}`;
  return (
    <svg className="vq-venn" width="16" height="12" viewBox="0 0 16 12" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clip}>
          <circle cx="6" cy="6" r="5" />
        </clipPath>
      </defs>
      {fillLeft && <circle className="vq-venn-fill" cx="6" cy="6" r="5" />}
      {fillRight && <circle className="vq-venn-fill" cx="10" cy="6" r="5" />}
      {kind !== null && <circle className="vq-venn-fill" cx="10" cy="6" r="5" clipPath={`url(#${clip})`} />}
      <circle className="vq-venn-ring" cx="6" cy="6" r="5" />
      <circle className="vq-venn-ring" cx="10" cy="6" r="5" />
    </svg>
  );
}

function endpointIs(e: SmEndpoint, t: VqTable): boolean {
  return (e.schema ?? null) === (t.schema ?? null) && e.table === t.name;
}

/**
 * The Foreign Keys between two cards with their pairs oriented to a Join from `left` to `right`
 * (`leftColumn` belongs to `left`), as the model makes them.
 */
export function keysBetween(schema: VqSchema, left: VqTable, right: VqTable): { key: SqlFk; on: VqJoin["on"] }[] {
  const out: { key: SqlFk; on: VqJoin["on"] }[] = [];
  for (const key of schema.fks) {
    const forward = endpointIs(key.from, left) && endpointIs(key.to, right);
    const back = endpointIs(key.from, right) && endpointIs(key.to, left);
    if (!forward && !back) continue;
    const [l, r] = forward ? [key.from.columns, key.to.columns] : [key.to.columns, key.from.columns];
    out.push({ key, on: l.map((leftColumn, i) => ({ leftColumn, rightColumn: r[i] })) });
  }
  return out;
}

const samePairs = (a: VqJoin["on"], b: VqJoin["on"]) =>
  a.length === b.length && a.every((p) => b.some((q) => q.leftColumn === p.leftColumn && q.rightColumn === p.rightColumn));

/** The Foreign Key whose pairs are exactly these, or null. */
export function keyFor(schema: VqSchema, left: VqTable, right: VqTable, on: VqJoin["on"]): SqlFk | null {
  return keysBetween(schema, left, right).find((k) => samePairs(k.on, on))?.key ?? null;
}

/** A settled Join whose pairs match no Foreign Key in the schema was made here (decision: dashed). */
export function isMadeHere(schema: VqSchema, join: VqJoin, left: VqTable | undefined, right: VqTable | undefined): boolean {
  if (join.pending != null || !left || !right) return false;
  return keyFor(schema, left, right, join.on) === null;
}

/** A condition as the Core writes it, the newly joined table first: `s.id = o.store_id`. */
export function conditionText(p: VqJoin["on"][number], leftAlias: string, rightAlias: string): string {
  return `${rightAlias}.${p.rightColumn} = ${leftAlias}.${p.leftColumn}`;
}

/** Edge type `join`. */
export default function JoinEdge(props: EdgeProps) {
  const actions = useContext(JoinActionsContext);
  const data = props.data as JoinEdgeData | undefined;
  const { path, x, y } = orthogonalPath(props);
  if (!data) return <BaseEdge id={props.id} path={path} />;
  const { join, madeHere, selected, danger, title } = data;
  const pending = join.pending != null;
  const line = [
    "vq-join-line",
    pending ? "vq-join-pending" : madeHere ? "vq-join-made" : "vq-join-fk",
    selected && "vq-join-selected",
    danger && "vq-join-danger",
  ]
    .filter(Boolean)
    .join(" ");
  const badge = ["vq-join-badge", pending && "vq-join-badge-pick", selected && "vq-join-badge-on", danger && "vq-join-badge-danger"]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <BaseEdge id={props.id} path={path} className={line} interactionWidth={props.interactionWidth} />
      <circle className="vq-join-dot" cx={props.sourceX} cy={props.sourceY} r={3} />
      <circle className="vq-join-dot" cx={props.targetX} cy={props.targetY} r={3} />
      <JoinBadge x={x} y={y}>
        <button
          type="button"
          className={badge}
          data-join={join.id}
          title={danger ?? title}
          aria-haspopup="dialog"
          onClick={(e) => actions?.open(join.id, e.currentTarget.getBoundingClientRect())}
        >
          {pending ? null : <VennMark kind={join.kind} />}
          {pending ? "Pick" : KIND_LABEL[join.kind]}
        </button>
      </JoinBadge>
    </>
  );
}
