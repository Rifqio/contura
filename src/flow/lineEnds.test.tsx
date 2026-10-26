// Diagram step 4 (F8): a selected line shows a handle at each end; dragging one onto another shape reattaches that
// end there (draw.io), as one text edit and one undo step. Let go on empty canvas or Esc, and the line stays.
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { LangClient } from "../lang/client";
import { routeInvoke } from "../test/invoke";
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

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
});

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const FLOW = lines('diagram flow "Refund"', "Request in [start]", "Check", "Done [end]", "Request in > Check", "Check > Done: yes");
const LAYOUT = JSON.stringify({ version: 1, nodes: { "Request in": { x: 0, y: 0 }, Check: { x: 300, y: 0 }, Done: { x: 0, y: 300 } } });

function setup(text = FLOW) {
  routeInvoke({ read_diagram: () => ({ text, layout: LAYOUT }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="ends" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  /** A flow point on screen, through the viewport's transform (jsdom puts the pane at 0, 0). */
  const screenOf = (p: { x: number; y: number }) => {
    const t = (utils.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
    const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([\d.e]+)\)/.exec(t)!;
    return { clientX: p.x * Number(m[3]) + Number(m[1]), clientY: p.y * Number(m[3]) + Number(m[2]) };
  };
  const centre = (id: string) => {
    const n = canvas.props!.nodes.find((x) => x.id === id)!;
    return screenOf({ x: n.position.x + (n.initialWidth ?? 0) / 2, y: n.position.y + (n.initialHeight ?? 0) / 2 });
  };
  return { ...utils, doc, view, screenOf, centre };
}

async function selectLine(s: ReturnType<typeof setup>, i: number) {
  await waitFor(() => expect(s.container.querySelector(`.react-flow__edge[data-id="edge:${i}"]`)).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onLineSelect!([`edge:${i}`]));
  await waitFor(() => expect(s.container.querySelector(`.flow-line-end[data-end="to"]`)).not.toBeNull());
}

test("dragging a selected line's end onto another shape reattaches it, one undo step", async () => {
  const s = setup();
  await selectLine(s, 0);
  expect(s.container.querySelectorAll(".flow-line-end")).toHaveLength(2);
  const end = s.container.querySelector('.flow-line-end[data-end="to"]')!;
  fireEvent.pointerDown(end, { button: 0, pointerId: 1, ...s.centre("Check") });
  fireEvent.pointerMove(window, { pointerId: 1, ...s.centre("Done") });
  expect(s.container.querySelector(".flow-line-end-preview")).not.toBeNull();
  fireEvent.pointerUp(window, { pointerId: 1, ...s.centre("Done") });
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace("Request in > Check", "Request in > Done")));
  act(() => void undo(s.view()));
  expect(s.doc()).toBe(FLOW);
});

test("the start end moves the line's source", async () => {
  const s = setup();
  await selectLine(s, 1);
  const end = s.container.querySelector('.flow-line-end[data-end="from"]')!;
  fireEvent.pointerDown(end, { button: 0, pointerId: 1, ...s.centre("Check") });
  fireEvent.pointerUp(window, { pointerId: 1, ...s.centre("Request in") });
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace("Check > Done: yes", "Request in > Done: yes")));
});

test("let go on empty canvas or Esc mid-drag, and the line stays as it was", async () => {
  const s = setup();
  await selectLine(s, 0);
  let end = s.container.querySelector('.flow-line-end[data-end="to"]')!;
  fireEvent.pointerDown(end, { button: 0, pointerId: 1, ...s.centre("Check") });
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenOf({ x: 900, y: 900 }) });
  end = s.container.querySelector('.flow-line-end[data-end="to"]')!;
  fireEvent.pointerDown(end, { button: 0, pointerId: 1, ...s.centre("Check") });
  fireEvent.pointerMove(window, { pointerId: 1, ...s.centre("Done") });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(s.container.querySelector(".flow-line-end-preview")).toBeNull();
  fireEvent.pointerUp(window, { pointerId: 1, ...s.centre("Done") });
  await new Promise((r) => setTimeout(r, 50));
  expect(s.doc()).toBe(FLOW);
});

test("a_dotted_line_has_the_dash_and_no_head", async () => {
  const dotted = lines('diagram flow "Refund"', "Request in [start]", "Check", "Done [end]", "Request in --> Check", "Check -- Done", "Done -- Request in [color: #3b82f6]");
  const s = setup(dotted);
  await waitFor(() => expect(canvas.props?.edges).toHaveLength(3), { timeout: 4000 });
  const [dashed, plain, coloured] = canvas.props!.edges;
  expect(dashed.markerEnd).toBeTruthy();
  for (const e of [plain, coloured]) {
    expect(e.markerStart).toBeUndefined();
    expect(e.markerEnd).toBeUndefined();
    expect(e.className).toContain("flow-line-dashed");
  }
  expect(plain.className).toBe(dashed.className);
  await waitFor(() => expect(s.container.querySelectorAll(".react-flow__edge.flow-line-dashed")).toHaveLength(3));
});

test("a_class_association_dash_dash_stays_solid", async () => {
  const s = setup(lines('diagram class "Types"', "class Animal", "class Dog", "Animal -- Dog"));
  await waitFor(() => expect(canvas.props?.edges).toHaveLength(1), { timeout: 4000 });
  expect(canvas.props!.edges[0].className).not.toContain("flow-line-dashed");
  expect(canvas.props!.edges[0].className).not.toContain("flow-line-dotted");
  await waitFor(() => expect(s.container.querySelectorAll(".react-flow__edge")).toHaveLength(1));
});
