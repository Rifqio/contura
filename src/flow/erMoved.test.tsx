// One ERD (ADR 0030): a `diagram er` file from before opens read-only in the text pane with one way on, "Open as
// DBML", which opens it in the Schema Builder as an unsaved model; the first Save asks where. Nothing is written.
import { EditorView } from "@codemirror/view";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { LangClient } from "../lang/client";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(cleanup);

const BILLING = ['diagram er "Billing"', "customers", "customers.id int [pk]", "orders", "orders.id int [pk]", "orders.customer_id int", "customers 1--* orders : places", ""].join("\n");

function setup() {
  routeInvoke({
    read_diagram: () => ({ text: BILLING, layout: null }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
  });
  const onOpenModel = vi.fn();
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="billing" client={new LangClient(() => fakeWorker())} onOpenModel={onOpenModel} />
    </div>,
  );
  return { ...utils, onOpenModel };
}

const writes = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === "write_diagram" || c === "write_diagram_layout");

test("an ER file opens read-only with the strip and Open as DBML, and no canvas", async () => {
  const { container } = setup();
  expect(await screen.findByText("ER diagrams moved to the Schema Builder.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open as DBML" })).toBeTruthy();
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  expect(view.state.doc.toString()).toBe(BILLING);
  expect(view.state.readOnly).toBe(true);
  expect(container.querySelector(".react-flow")).toBeNull();
  // The title is the diagram's name, never the file's.
  expect(screen.getByRole("heading", { name: "billing" })).toBeTruthy();
  expect(container.textContent).not.toContain(".flow");
});

test("Open as DBML hands the converted DBML on as an unsaved model named after the diagram; nothing is written", async () => {
  const { onOpenModel } = setup();
  await userEvent.click(await screen.findByRole("button", { name: "Open as DBML" }));
  expect(onOpenModel).toHaveBeenCalledTimes(1);
  const [name, dbml] = onOpenModel.mock.calls[0];
  expect(name).toBe("billing");
  expect(dbml).toContain("Ref: orders.customer_id > customers.id");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  // No write of the .flow, its layout or any file: no command that writes, creates, renames or deletes.
  expect(vi.mocked(invoke).mock.calls.map(([c]) => c).filter((c) => /write|create|rename|delete|save/.test(c))).toEqual([]);
  expect(writes()).toEqual([]);
});
