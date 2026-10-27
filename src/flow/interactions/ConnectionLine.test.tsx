// Fix round 2, live bug (a): React Flow hands the drawing line the pointer in pixels of the canvas element, not in
// flow coordinates, so with the view panned or zoomed the line ended far from the pointer. The line's end is the
// pointer in flow coordinates.
import { type ConnectionLineComponentProps, type InternalNode, Position, ReactFlowProvider, useStoreApi } from "@xyflow/react";
import { render } from "@testing-library/react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { expect, test, vi } from "vitest";
import { type DrawState, makeConnectionLine } from "./ConnectionLine";

/** Sets the canvas transform (pan 100, 50; zoom 2) before drawing what it holds. */
function Panned({ children }: { children: ReactNode }) {
  const store = useStoreApi();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    store.setState({ transform: [100, 50, 2] });
    setReady(true);
  }, [store]);
  return ready ? <svg>{children}</svg> : null;
}

const node = { id: "Checkout", type: "kind", position: { x: 0, y: 0 }, data: {}, measured: { width: 200, height: 100 }, internals: { positionAbsolute: { x: 0, y: 0 }, z: 0, userNode: {} } } as unknown as InternalNode;

function draw(handle: string) {
  const onDraw = vi.fn<(d: DrawState) => void>();
  const Line = makeConnectionLine(onDraw);
  const props = {
    fromNode: node,
    fromHandle: { id: handle, nodeId: "Checkout", type: "source", position: Position.Right, x: 0, y: 0, width: 8, height: 8 },
    fromX: 200,
    fromY: 69,
    toX: 0,
    toY: 0,
    fromPosition: Position.Right,
    toPosition: Position.Left,
    connectionStatus: null,
    connectionLineType: "default",
    toNode: null,
    toHandle: null,
    // In pixels of the canvas element: flow (450, 200) with the pan and zoom above.
    pointer: { x: 1000, y: 450 },
  } as unknown as ConnectionLineComponentProps;
  const { container } = render(
    <ReactFlowProvider>
      <Panned>
        <Line {...props} />
      </Panned>
    </ReactFlowProvider>,
  );
  return { onDraw, d: container.querySelector(".flow-drawing-line")!.getAttribute("d")! };
}

test("a column's drag line ends at the pointer in flow coordinates", () => {
  // Restored from 5478210^ (B3 Task 7): from a column's port the line leaves at the row (fromY 69) and never locks
  // onto a whole table; the drop decides the column or header it joins.
  const { onDraw, d } = draw("col:customer_id:r");
  expect(onDraw).toHaveBeenLastCalledWith(expect.objectContaining({ end: { x: 450, y: 200 }, lock: null }));
  expect(d.startsWith("M 200 69")).toBe(true);
  expect(d.endsWith("L 450 200")).toBe(true);
});

test("a shape's drag line ends at the pointer in flow coordinates", () => {
  const { onDraw, d } = draw("r");
  expect(onDraw).toHaveBeenLastCalledWith(expect.objectContaining({ end: { x: 450, y: 200 } }));
  expect(d.endsWith("L 450 200")).toBe(true);
});
