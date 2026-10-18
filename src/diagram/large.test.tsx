import { render, waitFor } from "@testing-library/react";
import type { Node, NodeProps } from "@xyflow/react";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mockReactFlowDom } from "../test/reactFlow";
import CardFrame, { Ports } from "./CardFrame";
import DiagramCanvas from "./DiagramCanvas";
import { detailFor, useDetail } from "./detail";
import { BOX_HEIGHT, BOX_WIDTH, CARD_WIDTH, cardHeight } from "./metrics";

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
