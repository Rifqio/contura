// Plan F Task 9: the recorder's measures on a real board (FlowTab), as the release WebView's run reads them. The live run
// logged an empty `measures` list on every line: its sweep picked no frame (`select_pick` is marked by a pick) and built
// no picture (every picture is built at open, and a zoom changes none). These pin that each hook does fire on the
// FlowTab code path it names, and that a sweep alone builds no picture (zoomSweep.perf.test.ts).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import FlowTab from "../flow/FlowTab";
import { setIconTheme } from "../flow/icons";
import { LangClient } from "../lang/client";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import { startPerfRecorder, stopPerfRecorder } from "./perfRecorder";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const log = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../api/client", async (load) => ({
  ...(await load<typeof import("../api/client")>()),
  perfLogEnabled: () => Promise.resolve(true),
  perfLogAppend: (line: string) => {
    log.lines.push(line);
    return Promise.resolve();
  },
}));

const canvas = vi.hoisted(() => ({ instance: null as ReactFlowInstance | null }));
vi.mock("../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) =>
      real.default({
        ...p,
        onInit: (i) => {
          canvas.instance = i;
          p.onInit?.(i);
        },
      }),
  };
});

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  stopPerfRecorder();
  setIconTheme("light");
  log.lines = [];
  canvas.instance = null;
});

const frame = (t: string, a: string, b: string) => `diagram flow "${t}"\n${a}\n${b}\n${a} > ${b}: go\n`;
const BOARD = [frame("Checkout", "Cart", "Pay"), frame("Refund", "Ask", "Refund it"), frame("Shipping", "Pack", "Send")].join("\n");
const at = (x: number, a: string, b: string) => ({ at: { x, y: 0 }, nodes: { [a]: { x: 0, y: 0 }, [b]: { x: 0, y: 120 } }, style: "modern", direction: "TB" });
const LAYOUT = JSON.stringify({
  version: 2,
  frames: { Checkout: at(0, "Cart", "Pay"), Refund: at(600, "Ask", "Refund it"), Shipping: at(1200, "Pack", "Send") },
  sketches: [],
});

/** Every measure the recorder logged so far, by name. */
const measures = () => log.lines.flatMap((l) => (JSON.parse(l) as { measures: { name: string; ms: number }[] }).measures).map((m) => m.name);

async function openBoard() {
  await startPerfRecorder();
  routeInvoke({ read_diagram: () => ({ text: BOARD, layout: LAYOUT }), write_diagram: () => null, write_diagram_layout: () => null });
  render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  await screen.findByRole("button", { name: "Flowchart Refund" });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  // Far out, so the static frames are pictures.
  await act(async () => void (await canvas.instance!.setViewport({ x: 0, y: 200, zoom: 0.2 })));
}

test("a_frame_pick_logs_select_live", async () => {
  await openBoard();
  fireEvent.click(await screen.findByRole("button", { name: "Flowchart Refund" }));
  await waitFor(() => expect(measures()).toContain("select_live"), { timeout: 4000 });
});

test("a_picture_build_logs_pictures_settled", async () => {
  await openBoard();
  await waitFor(() => expect(document.querySelectorAll(".board-picture-img").length).toBeGreaterThan(0));
  // A theme switch builds every picture again, in slices after open.
  act(() => setIconTheme("dark"));
  await waitFor(() => expect(measures()).toContain("pictures_settled"), { timeout: 4000 });
});

test("each_zoom_button_glide_logs_glide_landed_with_its_worst_frame", async () => {
  // The sweep's own reading: each zoom step from its click to the paint after it lands, with the worst frame between.
  await openBoard();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await waitFor(() => expect(measures()).toContain("glide_landed"), { timeout: 4000 });
  const glide = log.lines.flatMap((l) => (JSON.parse(l) as { measures: { name: string; ms: number; worst: number }[] }).measures).find((m) => m.name === "glide_landed")!;
  expect(glide.ms).toBeGreaterThan(0);
  expect(typeof glide.worst).toBe("number");
});

test("frames_turning_real_log_each_form_step", async () => {
  // Task 9 fix 4: a step of the drawn forms is a FlowTab render; its render and commit are logged as `form_step`, so
  // a long glide frame on the live run splits into React's work for the step and the WebView's own.
  await openBoard();
  await waitFor(() => expect(document.querySelectorAll(".board-picture-img").length).toBeGreaterThan(0));
  await act(async () => void (await canvas.instance!.setViewport({ x: 0, y: 200, zoom: 1 })));
  const steps = () => log.lines.flatMap((l) => Object.keys((JSON.parse(l) as { steps: Record<string, unknown> }).steps));
  await waitFor(() => expect(steps()).toContain("form_step"), { timeout: 4000 });
});
