// Plan F Task 2: real shapes at every zoom on boards (ruling 1, Decision 1). The live frame keeps its shapes, icons,
// ports and lines at any zoom and any count; B1's fast mode and Task 18b's "live frame fast below 0.45" are gone.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import { resetIcons } from "../icons";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

// The real canvas draws; the test keeps its latest props and its React Flow instance (as frames.test.tsx does).
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

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
beforeEach(() => resetIcons());
afterEach(() => {
  cleanup();
  canvas.props = null;
  canvas.instance = null;
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPaid? [decision]\nCart > Paid?\n';
const PLATFORM = 'diagram cloud "Platform"\nUsers [icon: users]\nHandler [icon: aws-lambda]\nUsers > Handler\n';
const INDEX = ["users", "aws-lambda"].map((name) => ({ name, set: name.startsWith("aws-") ? "aws" : "lucide", title: name, licence: null }));
const svg = (name: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><title>${name}</title></svg>`;

/** Many shapes in a row-major grid, each joined to the next. */
function bigFlow(title: string, n: number) {
  const lines = [`diagram flow "${title}"`];
  for (let i = 0; i < n; i++) lines.push(`Step ${i}`);
  for (let i = 0; i < n - 1; i++) lines.push(`Step ${i} > Step ${i + 1}`);
  return `${lines.join("\n")}\n`;
}

function setup(frames: { text: string; key: string; nodes: Record<string, { x: number; y: number }> }[]) {
  const text = frames.map((f) => f.text).join("\n");
  const layout = JSON.stringify({
    version: 2,
    frames: Object.fromEntries(frames.map((f, i) => [f.key, { at: { x: i * 800, y: 0 }, nodes: f.nodes, style: "modern", direction: "TB" }])),
    sketches: [],
  });
  routeInvoke({
    read_diagram: () => ({ text, layout }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    icon_index: () => INDEX,
    icon: ({ name }) => svg(name as string),
    icon_sets: () => [],
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>,
  );
  /** A live shape's node on the page. */
  const live = (id: string) => utils.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] .fnode`);
  const zoomTo = async (zoom: number) => {
    await act(async () => {
      await canvas.instance!.setViewport({ x: 0, y: 0, zoom });
    });
  };
  return { ...utils, live, zoomTo };
}
type Setup = ReturnType<typeof setup>;

/** Selects a frame by its tab and waits for its shape to be drawn live. */
async function pick(s: Setup, tab: string, first: string) {
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  fireEvent.click(await screen.findByRole("button", { name: tab }));
  await waitFor(() => expect(s.live(first)).not.toBeNull(), { timeout: 10000 });
}

const twoFrames = () =>
  setup([
    { text: CHECKOUT, key: "Checkout", nodes: { Cart: { x: 0, y: 0 }, "Paid?": { x: 0, y: 160 } } },
    { text: PLATFORM, key: "Platform", nodes: { Users: { x: 0, y: 0 }, Handler: { x: 0, y: 160 } } },
  ]);

test("a_decision_stays_a_decision_zoomed_out", async () => {
  const s = twoFrames();
  await pick(s, "Flowchart Checkout", "Paid?");
  await s.zoomTo(0.12);
  await waitFor(() => expect(s.live("Paid?")).not.toBeNull());
  const el = s.live("Paid?")!;
  expect(el.classList.contains("fnode-decision")).toBe(true);
  expect(el.classList.contains("fnode-flowchart")).toBe(true);
  expect(el.classList.contains("fnode-box")).toBe(false);
  expect(el.classList.contains("fnode-block")).toBe(false);
});

test("icons_stay_zoomed_out", async () => {
  const s = twoFrames();
  await pick(s, "Cloud Platform", "Users");
  await waitFor(() => expect(s.live("Users")!.querySelector(".fnode-tile img")).not.toBeNull());
  await s.zoomTo(0.12);
  await waitFor(() => expect(s.live("Users")).not.toBeNull());
  expect(s.live("Users")!.querySelector(".fnode-tile img")).not.toBeNull();
});

test("a_live_frame_over_300_shapes_is_not_fast", { timeout: 60000 }, async () => {
  const nodes: Record<string, { x: number; y: number }> = {};
  for (let i = 0; i < 400; i++) nodes[`Step ${i}`] = { x: (i % 20) * 200, y: Math.floor(i / 20) * 120 };
  const s = setup([
    { text: bigFlow("Big", 400), key: "Big", nodes },
    { text: CHECKOUT, key: "Checkout", nodes: { Cart: { x: 0, y: 0 }, "Paid?": { x: 0, y: 160 } } },
  ]);
  await pick(s, "Flowchart Big", "Step 0");
  await s.zoomTo(1);
  await waitFor(() => expect(s.live("Step 0")).not.toBeNull());
  expect(s.container.querySelector(".diagram-canvas.is-fast")).toBeNull();
  // Ports show on hover.
  const step = s.live("Step 0")!;
  expect(step.classList.contains("fnode-box")).toBe(false);
  fireEvent.pointerEnter(step);
  await waitFor(() => expect(step.querySelectorAll(".fnode-port").length).toBeGreaterThan(0));
  // Lines keep their handles and their own type: nothing is cut to a straight line between box sides.
  const given = new Map(canvas.props!.edges.map((e) => [e.id, e]));
  const drawn = canvas.instance!.getEdges().filter((e) => given.has(e.id));
  expect(drawn.length).toBeGreaterThan(0);
  for (const e of drawn) {
    const g = given.get(e.id)!;
    // A flow line names no handle (it finds its own sides); fast mode cut every handle to null and drew it straight.
    expect(e.sourceHandle, e.id).not.toBeNull();
    expect(e.targetHandle, e.id).not.toBeNull();
    expect(e.type, e.id).not.toBe("straight");
    // The canvas hands the owner's line to React Flow as it is: no handle key added, no type changed.
    expect(e, e.id).toStrictEqual(g);
  }
});

test("the_live_frame_is_full_below_0_45", async () => {
  const s = twoFrames();
  await pick(s, "Flowchart Checkout", "Cart");
  for (const zoom of [0.44, 0.3, 0.12]) {
    await s.zoomTo(zoom);
    await waitFor(() => expect(s.live("Cart")).not.toBeNull());
    const cart = s.live("Cart")!;
    expect(cart.classList.contains("fnode-flowchart"), String(zoom)).toBe(true);
    expect(cart.classList.contains("fnode-box"), String(zoom)).toBe(false);
    expect(s.container.querySelector(".diagram-canvas.is-fast"), String(zoom)).toBeNull();
    expect(s.container.querySelector(".react-flow__edge-straight"), String(zoom)).toBeNull();
  }
});
