// F7 (diagram step 5, erd-ux-research 5.5): the arrow keys move the selection 1 px, Shift+arrows 16 px, and a held
// key's repeats are one undo step (Figma), on every kind whose shapes move.
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

const FLOW = 'diagram flow "B"\ncustomers\ninvoices\n';
const LAYOUT = JSON.stringify({ version: 1, nodes: { customers: { x: 100, y: 100 }, invoices: { x: 400, y: 100 } } });

function setup() {
  routeInvoke({ read_diagram: () => ({ text: FLOW, layout: LAYOUT }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="nudge" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const at = (id: string) => canvas.props!.nodes.find((n) => n.id === id)!.position;
  return { ...utils, view, canvasEl, at };
}

async function picked() {
  await waitFor(() => expect(canvas.props?.nodes.some((n) => n.id === "customers")).toBe(true), { timeout: 4000 });
  act(() => canvas.props!.onSelect!(["customers"]));
  await waitFor(() => expect(canvas.props!.selection).toEqual(["customers"]));
}

test("an arrow moves 1 px and Shift+arrow 16 px, each press one undo step", async () => {
  const s = setup();
  await picked();
  fireEvent.keyDown(s.canvasEl(), { key: "ArrowRight" });
  fireEvent.keyUp(s.canvasEl(), { key: "ArrowRight" });
  await waitFor(() => expect(s.at("customers")).toEqual({ x: 101, y: 100 }));
  fireEvent.keyDown(s.canvasEl(), { key: "ArrowDown", shiftKey: true });
  fireEvent.keyUp(s.canvasEl(), { key: "ArrowDown", shiftKey: true });
  await waitFor(() => expect(s.at("customers")).toEqual({ x: 101, y: 116 }));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.at("customers")).toEqual({ x: 101, y: 100 }));
});

test("a held arrow's repeats are one undo step", async () => {
  const s = setup();
  await picked();
  fireEvent.keyDown(s.canvasEl(), { key: "ArrowLeft" });
  for (let i = 0; i < 4; i++) fireEvent.keyDown(s.canvasEl(), { key: "ArrowLeft", repeat: true });
  await waitFor(() => expect(s.at("customers")).toEqual({ x: 95, y: 100 }));
  fireEvent.keyUp(s.canvasEl(), { key: "ArrowLeft" });
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.at("customers")).toEqual({ x: 100, y: 100 }));
});
