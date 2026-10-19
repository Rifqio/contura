// A 2,000-node diagram stays responsive in the flow tab (spec 6+ section 9, the existing large.test.tsx pattern):
// only what is visible is drawn, in fast mode, and canvas actions still answer quickly.
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { BOX_HEIGHT, BOX_WIDTH } from "../diagram/metrics";
import { LangClient } from "../lang/client";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null }));
vi.mock("../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      return real.default(p);
    },
  };
});

const PANE = { width: 1280, height: 800 };
const N = 2000;

const savedSizes = {
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
};

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
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
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { get(this: HTMLElement) { return this.classList.contains("react-flow") ? PANE.width : BOX_WIDTH; }, configurable: true },
    offsetHeight: { get(this: HTMLElement) { return this.classList.contains("react-flow") ? PANE.height : BOX_HEIGHT; }, configurable: true },
  });
});

afterAll(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const [name, d] of Object.entries(savedSizes)) {
    if (d) Object.defineProperty(HTMLElement.prototype, name, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

test("two_thousand_node_flow_tab_draws_only_what_is_visible_and_stays_responsive", { timeout: 90000 }, async () => {
  const lines = ['diagram dfd "Large"', ""];
  for (let i = 0; i < N; i++) lines.push(`Node ${i} [process, id: ${i + 1}.0]`);
  lines.push("");
  for (let i = 0; i < N - 1; i++) lines.push(`Node ${i} > Node ${i + 1}`);
  const text = `${lines.join("\n")}\n`;
  const nodes: Record<string, { x: number; y: number }> = {};
  for (let i = 0; i < N; i++) nodes[`Node ${i}`] = { x: (i % 50) * 240, y: Math.floor(i / 50) * 112 };
  routeInvoke({
    read_diagram: () => ({ text, layout: JSON.stringify({ version: 1, nodes, style: "modern", direction: "LR" }) }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
  });
  const client = new LangClient(() => fakeWorker());
  const { container } = render(
    <div style={PANE}>
      <FlowTab name="large" client={client} />
    </div>,
  );
  await waitFor(() => expect(container.querySelectorAll(".react-flow__node").length).toBeGreaterThan(0), { timeout: 30000 });
  // Every node is on the canvas's list; only the visible ones are in the page, drawn as name boxes.
  await waitFor(() => expect(canvas.props!.nodes.length).toBe(N), { timeout: 30000 });
  const rendered = container.querySelectorAll(".react-flow__node").length;
  expect(rendered).toBeLessThan(300);
  expect(container.querySelector(".diagram-canvas.is-fast")).not.toBeNull();
  expect(container.querySelectorAll(".fnode-box").length).toBe(rendered);

  // A move writes only the layout; an add goes through the worker and comes back as one line of text. The
  // timing budgets are the worker's gates in `npm run test:perf`: jsdom under a full parallel run is too noisy
  // for wall-clock limits here.
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  act(() => canvas.props!.onMove!("Node 7", 4000, 4000));
  await waitFor(() => expect(canvas.props!.nodes.find((n) => n.id === "Node 7")?.position).toEqual({ x: 4000, y: 4000 }), { timeout: 15000 });
  expect(view.state.doc.toString()).toBe(text);
  fireEvent.keyDown(container.querySelector(".flow-canvas") as HTMLElement, { key: "p" });
  await waitFor(() => expect(view.state.doc.toString()).toContain("Process [process, id: 2001.0]\n"), { timeout: 15000 });
  await waitFor(() => expect(callsTo("write_diagram").length).toBeGreaterThan(0), { timeout: 15000 });
  // Still only the visible part is in the page.
  expect(container.querySelectorAll(".react-flow__node").length).toBeLessThan(300);
});
