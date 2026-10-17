import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, expect, test, vi } from "vitest";
import { mockReactFlowDom } from "../test/reactFlow";
import { parseDbml } from "../lang/dbml/parse";
import Canvas from "./Canvas";

// No React Flow mocks here: the real useNodesInitialized and fitView run.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(mockReactFlowDom);

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
  const settle = () => new Promise((done) => setTimeout(done, 300));
  await settle(); // the fit animates for 240 ms
  const fitted = (viewport() as HTMLElement).style.transform;
  // An edit later (here, one more table) keeps the view where it is: the fit runs once.
  rerender(view(parseDbml(`${text}\nTable extra {\n  id integer\n}\n`, "postgres").model!));
  await settle();
  expect((viewport() as HTMLElement).style.transform).toBe(fitted);
});

test("refits_after_a_window_resize", async () => {
  const model = parseDbml(Array.from({ length: 24 }, (_, i) => `Table t${i} {\n  id integer [pk]\n}\n`).join("\n"), "postgres").model!;
  render(
    <div style={{ width: 800, height: 600 }}>
      <Canvas model={model} layout={{ version: 1, tables: {} }} blocked={false} onLayout={() => {}} onEdit={() => {}} onGoToError={() => {}} />
    </div>,
  );
  const viewport = () => (document.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
  const settle = (ms = 400) => new Promise((done) => setTimeout(done, ms));
  await waitFor(() => expect(scaleOf(document.querySelector(".react-flow__viewport"))).toBeLessThan(0.5));
  await settle();
  const fitted = viewport();
  // The user zooms in; then the window is resized.
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await settle();
  expect(viewport()).not.toBe(fitted);
  fireEvent(window, new Event("resize"));
  // Debounced: nothing has moved yet.
  expect(viewport()).not.toBe(fitted);
  await settle(600);
  expect(viewport()).toBe(fitted);
});
