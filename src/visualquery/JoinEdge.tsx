// A Join on the Visual Query canvas (edge type `join`): an orthogonal line between the two column
// rows with a dot at each end, and a badge at its midpoint with the Venn mark and the kind.
import { BaseEdge, type EdgeProps, useStore } from "@xyflow/react";
import { createContext, useContext, useId } from "react";
import type { JoinKind, SqlFk, SmEndpoint, VqJoin, VqTable } from "../api/types";
import { clearBadgeSpot, type FlowBox, JoinBadge, orthogonalPath } from "../diagram/edges";
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

/**
 * The badge that has focus, by Join id and canvas. React Flow draws an edge again (a new button) when the
 * cards around it change, such as when a pick's preview lands; the new badge takes focus back if it fell
 * to the page with the old one. Focus moved elsewhere on purpose forgets it.
 */
let focusedBadge: { id: string; flow: Element | null } | null = null;

/** The badge kept for focus, for tests. */
export const focusedBadgeNow = () => focusedBadge;

/** Forgets the badge once its whole canvas is gone (the tab closed), so the detached canvas is not kept. */
function forgetIfCanvasGone() {
  if (focusedBadge && !focusedBadge.flow?.isConnected) focusedBadge = null;
}

const badgeRef = (id: string) => (el: HTMLButtonElement | null) => {
  // A badge leaving: checked once React has finished removing, when a closed canvas is detached.
  if (!el) {
    if (focusedBadge?.id === id) queueMicrotask(forgetIfCanvasGone);
    return;
  }
  if (!focusedBadge || focusedBadge.id !== id || focusedBadge.flow !== el.closest(".react-flow")) return;
  const now = document.activeElement;
  if (!now || now === document.body) el.focus();
};

function onBadgeFocus(e: React.FocusEvent<HTMLButtonElement>, id: string) {
  focusedBadge = { id, flow: e.currentTarget.closest(".react-flow") };
}

function onBadgeBlur(e: React.FocusEvent<HTMLButtonElement>) {
  const el = e.currentTarget;
  // Still on the page: the user moved focus away. Gone with its edge: kept for the badge drawn next.
  queueMicrotask(() => {
    if (el.isConnected && focusedBadge?.flow === el.closest(".react-flow")) focusedBadge = null;
    else forgetIfCanvasGone();
  });
}

const boxesEqual = (a: FlowBox[], b: FlowBox[]) =>
  a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y && p.w === b[i].w && p.h === b[i].h);

/** Edge type `join`. */
export default function JoinEdge(props: EdgeProps) {
  const actions = useContext(JoinActionsContext);
  const data = props.data as JoinEdgeData | undefined;
  const { path, x: midX, y: midY } = orthogonalPath(props);
  // Item 31: the badge never sits on a card, where it would cover a column name.
  const boxes = useStore((s) => {
    const out: FlowBox[] = [];
    for (const n of s.nodeLookup.values()) {
      const w = n.measured.width ?? n.width ?? n.initialWidth ?? 0;
      const h = n.measured.height ?? n.height ?? n.initialHeight ?? 0;
      out.push({ x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w, h });
    }
    return out;
  }, boxesEqual);
  const { x, y } = clearBadgeSpot(path, { x: midX, y: midY }, boxes);
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
          ref={badgeRef(join.id)}
          onFocus={(e) => onBadgeFocus(e, join.id)}
          onBlur={onBadgeBlur}
          onClick={(e) => actions?.open(join.id, e.currentTarget.getBoundingClientRect())}
        >
          {pending ? null : <VennMark kind={join.kind} />}
          {pending ? "Pick" : KIND_LABEL[join.kind]}
        </button>
      </JoinBadge>
    </>
  );
}
