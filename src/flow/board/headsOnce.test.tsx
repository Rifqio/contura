// Final review finding 6: one keystroke reads the frame headers once, shared by the keys (useFlowDoc) and the code
// pane's frame following (FlowTab), never twice over the whole text.
import { EditorView } from "@codemirror/view";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";

const heads = vi.hoisted(() => ({ read: [] as string[] }));
vi.mock("../../lang/flow/board", async (load) => {
  const real = await load<typeof import("../../lang/flow/board")>();
  return {
    ...real,
    frameHeaders: (text: string) => {
      heads.read.push(text);
      return real.frameHeaders(text);
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => cleanup());

const BOARD = [
  'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n',
  'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n',
  'diagram flow "Shipping"\nPack\nSend\nPack > Send\n',
].join("\n");

test("a_keystroke_reads_the_frame_headers_once", async () => {
  routeInvoke({ read_diagram: () => ({ text: BOARD, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  for (const t of ["Checkout", "Refund", "Shipping"]) await screen.findByRole("button", { name: `Flowchart ${t}` });
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  await waitFor(() => expect(view).toBeTruthy());
  heads.read.length = 0;
  const at = view.state.doc.toString().indexOf("Cart\n") + 4;
  act(() => view.dispatch({ changes: { from: at, insert: "s" }, selection: { anchor: at + 1 }, userEvent: "input.type" }));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  const now = view.state.doc.toString();
  expect(now).toContain("Carts\n");
  expect(heads.read.filter((t) => t === now)).toHaveLength(1);
});
