// The release milestone (Plan F Task 3, ruling 11): B3's live 2,000-table ERD at its fit. React Flow draws every node it
// has not measured, whatever is on screen, so the live ERD mounted all 2,000 cards at open (154,015 elements in jsdom)
// and kept 800 cards of 76 elements at the fit; the release WebView read 2,577 MB private. Now only the cards in view
// mount, and a far card is 8 elements with no <svg>. Sizes are given to jsdom as the release build lays them out: each node
// its own box, the pane 640 by 400.
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { ER_TABLES, erPositions } from "../../lang/flow/fixtures/erBoard";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      return real.default({
        ...p,
        onInit: (i) => {
          canvas.instance = i;
          p.onInit?.(i);
        },
      });
    },
  };
});

// A small pane keeps the test quick in jsdom; the view at the least zoom scales with it.
const PANE = { width: 640, height: 400 };
const saved = {
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
};
/** A node's box as laid out; a small box inside a node; the pane's size for everything else. */
function sizeOf(el: HTMLElement, side: "w" | "h"): number {
  if (el.classList.contains("react-flow__node")) {
    const n = canvas.props?.nodes.find((x) => x.id === el.getAttribute("data-id"));
    return Number((side === "w" ? (n?.initialWidth ?? n?.style?.width) : (n?.initialHeight ?? n?.style?.height)) ?? 10);
  }
  // Anything inside a node is small; the canvas and the elements around it are the pane's size.
  if (el.closest(".react-flow__node")) return 10;
  return side === "w" ? PANE.width : PANE.height;
}

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  class RO {
    constructor(private cb: ResizeObserverCallback) {}
    observe(t: Element) {
      queueMicrotask(() => this.cb([{ target: t, contentRect: PANE } as unknown as ResizeObserverEntry], this as never));
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { get(this: HTMLElement) { return sizeOf(this, "w"); }, configurable: true },
    offsetHeight: { get(this: HTMLElement) { return sizeOf(this, "h"); }, configurable: true },
  });
});
afterAll(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const [name, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(HTMLElement.prototype, name, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

test("a_live_2000_table_erd_mounts_only_the_cards_in_view", async () => {
  const block = (t: string) => [`${t} {`, "  id int pk", ...Array.from({ length: 19 }, (_, c) => `  c${c + 1} int`), "}"];
  const ring = ER_TABLES.map((t, i) => `${t}.c1 > ${ER_TABLES[(i + 1) % ER_TABLES.length]}.id`);
  const text = ['diagram er "Schema"', ...ER_TABLES.flatMap(block), "", ...ring, ""].join("\n");
  const layout = JSON.stringify({ version: 2, frames: { Schema: { at: { x: 0, y: 0 }, nodes: erPositions(), style: "modern", direction: "TB" } }, sketches: [] });
  routeInvoke({ read_diagram: () => ({ text, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const { container } = render(
    <div style={PANE}>
      <FlowTab name="erd" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  // The most cards and elements ever in the page at once, from the first draw on.
  let peakCards = 0;
  let peakElements = 0;
  const watch = new MutationObserver(() => {
    const cards = container.querySelectorAll(".react-flow__node-kind").length;
    if (cards <= peakCards) return;
    peakCards = cards;
    peakElements = container.querySelector(".react-flow__nodes")?.querySelectorAll("*").length ?? 0;
  });
  watch.observe(container, { childList: true, subtree: true });
  // 2,000 cards, the frame's box and the live anchor they hang from (Plan F Decision 11).
  await waitFor(() => expect(canvas.props?.nodes.length).toBe(2002), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance?.getViewport().zoom).toBeCloseTo(0.1, 5));
  await waitFor(() => expect(container.querySelectorAll(".react-flow__node-kind").length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 500));
  watch.disconnect();
  // Every card in view has mounted (fewer would mean the view was not the pane's size and the caps below proved
  // nothing).
  expect(peakCards).toBeGreaterThan(150);
  // The fit lands at 10 percent, at the ERD's top left: the 640 by 400 view holds 6,400 by 4,000 board units, at most
  // 26 columns of cards 260 apart by 9 rows 520 apart, 234 cards. Never all 2,000.
  expect(peakCards).toBeLessThanOrEqual(234);
  // A far card is drawn as main's fast name box is, plus its row bars (Decision 3) as the body's backgrounds: React
  // Flow's node, the shell, the card's inside, its header and name, the body and its bars, and one handle for its
  // lines. 8 elements and no <svg> (WebKit gives each <svg> root its own memory; main's fast box had none), where its
  // rows were 76, then 18, then 10 with one <svg>.
  const card = container.querySelector(".react-flow__node-kind")!;
  expect(card.querySelector("svg")).toBeNull();
  expect(card.querySelectorAll("*").length + 1).toBe(8);
  expect(peakElements).toBeLessThanOrEqual(234 * 8);
  // The lines between cards in view are drawn.
  expect(container.querySelectorAll(".react-flow__edge").length).toBeGreaterThan(0);
});
