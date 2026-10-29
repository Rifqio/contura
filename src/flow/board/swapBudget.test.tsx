// Plan F Task 9 fix (Decision 7, ruling 7): a frame turning real mounts its shapes and then its lines within the swap
// budget, a chunk an animation frame. Lines came all at once with the last shape: on the B1 limit board that was a
// frame's 300 labelled lines in one animation frame at the crossing (the release WebView's crossing frame missed 50 ms).
// The budget is cut to one part here, so every canvas render may add one static shape or line at most.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./boardDetail", async (load) => ({ ...(await load<typeof import("./boardDetail")>()), SWAP_BUDGET_SHAPES: 1 }));

// Every set of nodes and lines the canvas was handed, in order.
const canvas = vi.hoisted(() => ({ renders: [] as { nodes: number; edges: number }[], instance: null as ReactFlowInstance | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      const staticParts = (ids: { id: string }[]) => ids.filter((x) => x.id.startsWith("\u0000in:") && !x.id.endsWith("\u0000picture")).length;
      canvas.renders.push({ nodes: staticParts(p.nodes), edges: staticParts(p.edges) });
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

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.renders = [];
  canvas.instance = null;
});

// Two frames of three shapes and three lines each, side by side.
const frame = (t: string) => `diagram flow "${t}"\nA\nB\nC\nA > B: one\nB > C: two\nC > A: three\n`;
const BOARD = [frame("Left"), frame("Right")].join("\n");
const at = (x: number) => ({ at: { x, y: 0 }, nodes: { A: { x: 0, y: 0 }, B: { x: 0, y: 120 }, C: { x: 0, y: 240 } }, style: "modern", direction: "TB" });
const LAYOUT = JSON.stringify({ version: 2, frames: { Left: at(0), Right: at(600) }, sketches: [] });

const settle = () => act(async () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))));

test("a_frame_turning_real_mounts_its_lines_within_the_budget", async () => {
  routeInvoke({ read_diagram: () => ({ text: BOARD, layout: LAYOUT }), write_diagram: () => null, write_diagram_layout: () => null });
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  // Far out: both frames are pictures, nothing static mounted.
  await act(async () => void (await canvas.instance!.setViewport({ x: 0, y: 0, zoom: 0.2 })));
  for (let i = 0; i < 4; i++) await settle();
  await waitFor(() => expect(utils.container.querySelectorAll(".board-picture-img").length).toBe(2));
  canvas.renders = [];
  // Zoom in past the readable line: both frames turn real, a part a frame.
  await act(async () => void (await canvas.instance!.setViewport({ x: 0, y: 0, zoom: 1 })));
  for (let i = 0; i < 20; i++) await settle();
  const last = canvas.renders[canvas.renders.length - 1];
  expect(last).toEqual({ nodes: 6, edges: 6 });
  for (let i = 1; i < canvas.renders.length; i++) {
    const a = canvas.renders[i - 1];
    const b = canvas.renders[i];
    expect(b.nodes - a.nodes + (b.edges - a.edges), `render ${i}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`).toBeLessThanOrEqual(1);
  }
  // Its picture stays until its last line is in.
  expect(utils.container.querySelectorAll(".board-picture-img").length).toBe(0);
});
