import { act, render, waitFor } from "@testing-library/react";
import type { Node, NodeProps } from "@xyflow/react";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mockReactFlowDom } from "../test/reactFlow";
import CardFrame, { Ports } from "./CardFrame";
import DiagramCanvas from "./DiagramCanvas";
import { detailFor, useDetail } from "./detail";
import { BOX_HEIGHT, BOX_WIDTH, CARD_WIDTH, cardHeight } from "./metrics";
import { buildFlowGraph, FLOW_EDGE_TYPES, FLOW_NODE_TYPES } from "../flow/flowNodes";
import { parseFlow } from "../lang/flow/parse";

/**
 * One canvas frame in this harness. jsdom draws a React Flow frame several times slower than the webview (about
 * 30 ms here for the visible part of 2,000 nodes, alone), and a full parallel run adds noise; drawing every node
 * took about 110 ms alone.
 */
const FRAME_BUDGET_MS = 250;

const PANE = { width: 1280, height: 800 };

const savedSizes = {
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
};

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [name, d] of Object.entries(savedSizes)) {
    if (d) Object.defineProperty(HTMLElement.prototype, name, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

beforeAll(() => {
  mockReactFlowDom();
  // As in a browser, one resize callback reports every element observed in a frame (the shared mock reports each at once).
  class BatchedResizeObserver {
    private pending: Element[] = [];
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      if (this.pending.push(target) > 1) return;
      queueMicrotask(() => {
        const targets = this.pending.splice(0);
        this.cb(targets.map((t) => ({ target: t, contentRect: { width: PANE.width, height: PANE.height } }) as unknown as ResizeObserverEntry), this as never);
      });
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", BatchedResizeObserver);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  // The pane is 1280 x 800; every node measures as the 100 x 48 box fast mode draws.
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { get(this: HTMLElement) { return this.classList.contains("react-flow") ? PANE.width : BOX_WIDTH; }, configurable: true },
    offsetHeight: { get(this: HTMLElement) { return this.classList.contains("react-flow") ? PANE.height : BOX_HEIGHT; }, configurable: true },
  });
});

const COLS = ["id", "order_id", "amount"];
const seen: string[] = [];

function Card({ data, selected }: NodeProps) {
  const name = (data as { name: string }).name;
  const { detail, fast } = useDetail();
  if (seen.length === 0) seen.push(`${detail}:${fast}`);
  return (
    <CardFrame
      kind="table"
      label={`Table ${name}`}
      name={name}
      title={name}
      count={COLS.length}
      selected={!!selected}
      rows={COLS.map((c) => (
        <li key={c} className="table-card-column">
          <Ports column={c} />
          {c}
        </li>
      ))}
    />
  );
}

test("two_thousand_nodes_render_capped", { timeout: 60000 }, async () => {
  // A generated statement of thousands of joins lays out wide: one rank per join, a few rows deep.
  const nodes: Node[] = Array.from({ length: 2000 }, (_, i) => ({
    id: `t${i}`,
    type: "card",
    position: { x: Math.floor(i / 4) * (CARD_WIDTH + 80), y: (i % 4) * (cardHeight(COLS.length) + 40) },
    initialWidth: CARD_WIDTH,
    initialHeight: cardHeight(COLS.length),
    data: { name: `t${i}` },
  }));
  expect(detailFor(0.1, nodes.length)).toEqual({ detail: "box", fast: true });
  const { container } = render(
    <div style={PANE}>
      <DiagramCanvas nodes={nodes} edges={[]} nodeTypes={{ card: Card }} />
    </div>,
  );
  // Fitted to the minimum zoom, the pane shows a slice of the diagram.
  await waitFor(() => expect(container.querySelector(".canvas-zoom-percent")?.textContent).toBe("10%"), { timeout: 15000 });
  await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0), { timeout: 15000 });
  const rendered = container.querySelectorAll(".react-flow__node").length;
  expect(rendered).toBeLessThan(300);
  // Fast mode: name boxes, no rows, no ports, the fast class on the canvas.
  expect(seen[0]).toBe("box:true");
  expect(container.querySelectorAll(".card-box").length).toBe(rendered);
  expect(container.querySelectorAll(".table-card-column")).toHaveLength(0);
  expect(container.querySelectorAll(".react-flow__handle.connectable")).toHaveLength(0);
  expect(container.querySelector(".diagram-canvas.is-fast")).not.toBeNull();
});

test("large_flow_2000_nodes_smooth", { timeout: 90000 }, async () => {
  // A 2,000-node data flow: every node a process in a 50-wide grid, each linked to the next.
  const lines = ['diagram dfd "Large"'];
  for (let i = 0; i < 2000; i++) lines.push(`Node ${i} [process, id: ${i + 1}.0]`);
  for (let i = 0; i < 1999; i++) lines.push(`Node ${i} > Node ${i + 1}`);
  const parsed = parseFlow(lines.join("\n"));
  const doc = parsed.doc!;
  const at: Record<string, { x: number; y: number }> = {};
  for (let i = 0; i < 2000; i++) at[`Node ${i}`] = { x: (i % 50) * 240, y: Math.floor(i / 50) * 112 };
  const graph = buildFlowGraph(doc, at, "modern");
  expect(graph.nodes).toHaveLength(2000);
  expect(detailFor(0.1, graph.nodes.length)).toEqual({ detail: "box", fast: true });

  const { container, rerender } = render(
    <div style={PANE}>
      <DiagramCanvas nodes={graph.nodes} edges={graph.edges} nodeTypes={FLOW_NODE_TYPES} edgeTypes={FLOW_EDGE_TYPES} />
    </div>,
  );
  await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0), { timeout: 15000 });
  // Fast mode switches on: only visible nodes are in the page, each a name box with no ports.
  const rendered = container.querySelectorAll(".react-flow__node").length;
  expect(rendered).toBeLessThan(300);
  expect(container.querySelector(".diagram-canvas.is-fast")).not.toBeNull();
  expect(container.querySelectorAll(".fnode-box").length).toBe(rendered);
  expect(container.querySelectorAll(".fnode-port")).toHaveLength(0);

  // One drag frame: a node moves and the canvas draws again. The best of three batches stays within the frame
  // budget this harness allows (jsdom is several times slower than the webview; the worker gates are in test:perf).
  const frame = (i: number) => {
    const moved = graph.nodes.map((n, j) => (j === 0 ? { ...n, position: { x: 10 + i, y: 10 } } : n));
    const start = performance.now();
    act(() =>
      rerender(
        <div style={PANE}>
          <DiagramCanvas nodes={moved} edges={graph.edges} nodeTypes={FLOW_NODE_TYPES} edgeTypes={FLOW_EDGE_TYPES} />
        </div>,
      ),
    );
    return performance.now() - start;
  };
  let best = Infinity;
  for (let b = 0; b < 3; b++) {
    const times = Array.from({ length: 5 }, (_, i) => frame(b * 5 + i)).sort((x, y) => x - y);
    best = Math.min(best, times[2]);
  }
  expect(best).toBeLessThan(FRAME_BUDGET_MS);
  // A change keeps each node's measured size, so a frame still draws only the visible nodes.
  expect(container.querySelectorAll(".react-flow__node").length).toBeLessThan(300);
  // So does a new parse of the same text: every node is a new object with equal data.
  const again = buildFlowGraph(doc, at, "modern");
  act(() =>
    rerender(
      <div style={PANE}>
        <DiagramCanvas nodes={again.nodes} edges={again.edges} nodeTypes={FLOW_NODE_TYPES} edgeTypes={FLOW_EDGE_TYPES} />
      </div>,
    ),
  );
  expect(container.querySelectorAll(".react-flow__node").length).toBeLessThan(300);
});

test("large_flow_glide_end_keeps_drawing_only_the_visible_nodes", { timeout: 90000 }, async () => {
  const lines = ['diagram dfd "Large"'];
  for (let i = 0; i < 2000; i++) lines.push(`Node ${i} [process, id: ${i + 1}.0]`);
  const doc = parseFlow(lines.join("\n")).doc!;
  const at: Record<string, { x: number; y: number }> = {};
  for (let i = 0; i < 2000; i++) at[`Node ${i}`] = { x: (i % 50) * 240, y: Math.floor(i / 50) * 112 };
  const graph = buildFlowGraph(doc, at, "modern");
  const draw = (live: Record<string, { x: number; y: number }> | null) => (
    <div style={PANE}>
      <DiagramCanvas nodes={graph.nodes} edges={graph.edges} nodeTypes={FLOW_NODE_TYPES} edgeTypes={FLOW_EDGE_TYPES} livePositions={live} />
    </div>
  );
  const { container, rerender } = render(draw(null));
  await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0), { timeout: 15000 });
  const count = () => container.querySelectorAll(".react-flow__node").length;
  expect(count()).toBeLessThan(300);
  // A Tidy glide moves every node; at its end every node is drawn from the props again.
  const live = Object.fromEntries(Object.entries(at).map(([k, p]) => [k, { x: p.x + 4, y: p.y + 4 }]));
  act(() => rerender(draw(live)));
  expect(count()).toBeLessThan(300);
  act(() => rerender(draw(null)));
  expect(count()).toBeLessThan(300);
});
