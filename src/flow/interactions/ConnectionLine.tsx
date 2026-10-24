// The flow being drawn from a port (motion design, "Drawing a flow"): a dashed accent line routed square to the
// pointer; within 24 px of another node it locks onto that node's nearest port, turns solid and rings the node,
// which lifts with a shadow (frame 6+.3). It follows the pointer live, with no easing; only the lock's ring
// fades in (80 ms).
import { type ConnectionLineComponentProps, type InternalNode, useStore } from "@xyflow/react";
import { useEffect } from "react";
import { routeOrthogonal, routeRows } from "../../diagram/route";
import { type Box, linkBox, magnetTarget, type Point, portAt, type Side } from "./geometry";

const SIDE_OF: Record<string, Side> = { right: "r", left: "l", top: "t", bottom: "b" };

/** The side of the pressed port: its handle id (r, l, t, b), else the handle's position. */
export function pressedSide(handleId: string | null | undefined, position: string): Side {
  if (handleId === "r" || handleId === "l" || handleId === "t" || handleId === "b") return handleId;
  return SIDE_OF[position] ?? "r";
}

/** Where lines meet the node: its box, or a cloud service's 48 px tile. */
function boxOf(n: InternalNode): Box {
  return linkBox(n.type, {
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    w: n.measured.width ?? n.width ?? n.initialWidth ?? 0,
    h: n.measured.height ?? n.height ?? n.initialHeight ?? 0,
  });
}

/** Group areas carry a NUL in their id; a flow never ends on one. */
const isArea = (id: string) => id.startsWith("\u0000");

/** The nodes a drawn flow can lock onto, by box. */
export function targetsOf(lookup: Map<string, InternalNode>, from: string): { id: string; box: Box }[] {
  const out: { id: string; box: Box }[] = [];
  for (const [id, n] of lookup) if (id !== from && !isArea(id)) out.push({ id, box: boxOf(n) });
  return out;
}

/** Where a drawn flow is: its node's box, where its line ends (the pointer, or the locked port) and the lock. */
export interface DrawState {
  fromId: string;
  from: Box;
  end: Point;
  lock: string | null;
}

/** The node the flow is locked onto lifts with the dragged node's shadow while the lock holds. */
function useLift(id: string | null) {
  useEffect(() => {
    if (id === null) return;
    const el = [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find((n) => n.dataset.id === id);
    el?.classList.add("is-drop-target");
    return () => el?.classList.remove("is-drop-target");
  }, [id]);
}

/** The connection line, with `onDraw` told where it is each frame. Made once per tab, so React Flow keeps one component. */
export function makeConnectionLine(onDraw: (draw: DrawState) => void) {
  return function FlowConnectionLine({ fromNode, fromHandle, fromPosition, fromX, fromY, pointer }: ConnectionLineComponentProps) {
    const lookup = useStore((s) => s.nodeLookup);
    // React Flow gives the pointer in pixels of the canvas element; the line is drawn in flow coordinates
    // (fix round 2, live bug (a): with the view panned or zoomed the line ended far from the pointer).
    const [tx, ty, zoom] = useStore((s) => s.transform);
    const at = { x: (pointer.x - tx) / zoom, y: (pointer.y - ty) / zoom };
    const from = boxOf(fromNode);
    // ER build C: from a column's port the line leaves at the row and follows the pointer; the drop decides the
    // column or header it joins, so it never locks onto a whole table.
    const column = !!fromHandle?.id?.startsWith("col:");
    const lock = column ? null : magnetTarget(at, targetsOf(lookup, fromNode.id));
    const target = lock ? lookup.get(lock.id) : undefined;
    const to = target ? boxOf(target) : null;
    // The line always leaves from the port that was pressed (item 18), to the pointer or the locked port.
    const end = to && lock ? portAt(to, lock.side) : at;
    const route = column
      ? routeRows({ x: fromX, y: fromY, w: 0, h: 0 }, fromY, { x: end.x, y: end.y, w: 0, h: 0 }, end.y)
      : routeOrthogonal(from, { x: end.x, y: end.y, w: 0, h: 0 }, { toPoint: true, from: pressedSide(fromHandle?.id, fromPosition) });
    const lockId = to && lock ? lock.id : null;
    useLift(lockId);
    useEffect(() => onDraw({ fromId: fromNode.id, from, end, lock: lockId }));
    return (
      <g className={to ? "flow-drawing is-locked" : "flow-drawing"}>
        <path className="flow-drawing-line" d={route.d} fill="none" />
        {to && <rect className="flow-lock-ring" x={to.x - 3} y={to.y - 3} width={to.w + 6} height={to.h + 6} rx={10} />}
      </g>
    );
  };
}
