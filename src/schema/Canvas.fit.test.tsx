import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { setReducedMotionPref } from "../diagram/motion";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { parseDbml } from "../lang/dbml/parse";
import Canvas from "./Canvas";

// No React Flow mocks here: the real useNodesInitialized and fitView run.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// 24 real cards: a busy machine stretches the first draw well past a second.
patientFile();

beforeAll(mockReactFlowDom);
// The fit and the zoom buttons move the view at once, so a view read after them is where they end. With the
// 240ms animation a busy machine could read it part way, and a fixed wait could not tell.
beforeAll(() => setReducedMotionPref(true));
afterAll(() => setReducedMotionPref(false));

const scaleOf = (el: Element | null) => Number(/scale\(([\d.]+)\)/.exec((el as HTMLElement | null)?.style.transform ?? "")?.[1] ?? NaN);

test("a_model_bigger_than_the_pane_is_fitted_on_open", async () => {
  // 24 tables on the default grid (4 across, 300 x 320 apart) span about 1100 x 2000, far more than 800 x 600.
  const text = Array.from({ length: 24 }, (_, i) => `Table t${i} {\n  id integer [pk]\n  name text\n}\n`).join("\n");
  const model = parseDbml(text, "postgres").model!;
  const view = (m = model) => (
    <div style={{ width: 800, height: 600 }}>
      <Canvas
        model={m}
        layout={{ version: 1, tables: {} }}
        blocked={false}
        onLayout={() => {}}
        onEdit={() => {}}
        onGoToError={() => {}}
      />
    </div>
  );
  const { rerender } = render(view());
  const viewport = () => document.querySelector(".react-flow__viewport");
  await waitFor(() => expect(scaleOf(viewport())).toBeLessThan(0.5));
  const fitted = (viewport() as HTMLElement).style.transform;
  // An edit later (here, one more table) keeps the view where it is: the fit runs once.
  rerender(view(parseDbml(`${text}\nTable extra {\n  id integer\n}\n`, "postgres").model!));
  await new Promise((done) => setTimeout(done, 300));
  expect((viewport() as HTMLElement).style.transform).toBe(fitted);
});

test("a_window_resize_keeps_the_users_view", async () => {
  const model = parseDbml(Array.from({ length: 24 }, (_, i) => `Table t${i} {\n  id integer [pk]\n}\n`).join("\n"), "postgres").model!;
  render(
    <div style={{ width: 800, height: 600 }}>
      <Canvas model={model} layout={{ version: 1, tables: {} }} blocked={false} onLayout={() => {}} onEdit={() => {}} onGoToError={() => {}} />
    </div>,
  );
  const viewport = () => (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
  await waitFor(() => expect(scaleOf(document.querySelector(".react-flow__viewport"))).toBeLessThan(0.5));
  const fitted = viewport();
  // The user zooms in; then the window is resized: the view stays where the user put it (diagram-ux-research F16,
  // as Figma and draw.io).
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await waitFor(() => expect(viewport()).not.toBe(fitted));
  const zoomed = viewport();
  fireEvent(window, new Event("resize"));
  await new Promise((done) => setTimeout(done, 300));
  expect(viewport()).toBe(zoomed);
});
