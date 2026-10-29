// Task 9 fix 2: the canvas zoom as `--rz-zoom` is written only on the elements that read it (the frame tabs, the resize
// zones), never on the whole canvas: an inherited custom property changed on `.react-flow` restyles every node in it
// on every zoom frame of a glide.
import { act, render, waitFor } from "@testing-library/react";
import type { Node, NodeProps, ReactFlowInstance } from "@xyflow/react";
import { beforeAll, expect, test, vi } from "vitest";
import { mockReactFlowDom } from "../test/reactFlow";
import DiagramCanvas from "./DiagramCanvas";
import { ResizeZones } from "./resize";
import { useZoomVar } from "./zoomVar";

beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});

function Reader({ id }: NodeProps) {
  const ref = useZoomVar();
  return <div ref={ref} data-testid={`reader-${id}`} />;
}
function Zoned() {
  return <ResizeZones start={() => null} limits={{ minW: 1, maxW: 10, minH: 1, maxH: 10 }} onLive={() => {}} onDone={() => {}} />;
}
function Plain({ id }: NodeProps) {
  return <div data-testid={`plain-${id}`} />;
}

const node = (id: string, type: string, x: number): Node => ({ id, type, position: { x, y: 0 }, initialWidth: 100, initialHeight: 48, data: {} });

test("the_zoom_var_is_written_only_where_it_is_read", async () => {
  let flow: ReactFlowInstance | null = null;
  const writes = { root: 0, all: 0 };
  const real = CSSStyleDeclaration.prototype.setProperty;
  const spy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (this: CSSStyleDeclaration, name: string, value: string | null, priority?: string) {
    if (name === "--rz-zoom") {
      writes.all++;
      if (this === document.querySelector<HTMLElement>(".react-flow")?.style) writes.root++;
    }
    return real.call(this, name, value, priority);
  });
  try {
    const nodes = [node("a", "reader", 0), node("b", "reader", 200), node("z", "zoned", 400), ...Array.from({ length: 20 }, (_, i) => node(`p${i}`, "plain", 600 + i * 120))];
    const utils = render(
      <div style={{ width: 800, height: 600 }}>
        <DiagramCanvas nodes={nodes} edges={[]} nodeTypes={{ reader: Reader, zoned: Zoned, plain: Plain }} onInit={(i) => (flow = i)} />
      </div>,
    );
    await waitFor(() => expect(flow).not.toBeNull());
    const readers = () => [utils.getByTestId("reader-a"), utils.getByTestId("reader-b"), ...utils.container.querySelectorAll<HTMLElement>(".rz-zone")];
    await waitFor(() => expect(readers().length).toBe(10));
    for (const zoom of [0.3, 0.5, 0.8, 1.2, 2]) {
      const before = writes.all;
      await act(async () => {
        await flow!.setViewport({ x: 0, y: 0, zoom });
      });
      // Each element that reads it has this zoom; the canvas itself has none, and nothing else was written.
      for (const el of readers()) expect(el.style.getPropertyValue("--rz-zoom")).toBe(String(zoom));
      expect(writes.all - before).toBe(readers().length);
    }
    expect(writes.root).toBe(0);
    expect(utils.container.querySelector<HTMLElement>(".react-flow")!.style.getPropertyValue("--rz-zoom")).toBe("");
    for (const el of utils.container.querySelectorAll<HTMLElement>("[data-testid^=plain-]")) expect(el.closest("[style*='--rz-zoom']")).toBeNull();
  } finally {
    spy.mockRestore();
  }
});

test("an_element_that_reads_the_zoom_only_up_to_a_cap_is_written_only_below_it", async () => {
  // A frame tab reads min(zoom, 1): past 100 percent nothing it draws changes, so it is not restyled.
  const { createZoomTargets } = await import("./zoomVar");
  const t = createZoomTargets();
  const tab = document.createElement("div");
  const zone = document.createElement("div");
  const writes = { tab: 0, zone: 0 };
  for (const [el, k] of [[tab, "tab"], [zone, "zone"]] as const) {
    const set = el.style.setProperty.bind(el.style);
    el.style.setProperty = (name: string, value: string | null, p?: string) => {
      writes[k]++;
      set(name, value, p);
    };
  }
  t.add(tab, 1);
  t.add(zone);
  for (const z of [0.5, 0.9, 1.2, 2, 4, 2, 0.8]) t.set(z);
  expect(tab.style.getPropertyValue("--rz-zoom")).toBe("0.8");
  expect(zone.style.getPropertyValue("--rz-zoom")).toBe("0.8");
  // The tab: its first value, 0.5, 0.9, 1 (once, for 1.2 to 2, 4 and 2), 0.8.
  expect(writes.tab).toBe(5);
  expect(writes.zone).toBe(8);
});
