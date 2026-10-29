// Diagram build 1, step 1 (diagram-ux-research section 4): the shell's quick wins in the diagram tab. A line is
// selected, named in the strip, deleted with Delete or Backspace or its own menu as one undo step; Backspace deletes
// like Delete; Enter edits the selected shape in place; the tool bar has no inert button; Ctrl+Shift+E publishes;
// a participant double-clicked between two lands between them.
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { LangClient } from "../lang/client";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
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

const FLOW = lines('diagram flow "Refund"', "", "Request in [start]", "Check", "Done [end]", "", "Request in > Check", "Check > Done: yes");

function setup(initial = FLOW, name = "shell") {
  routeInvoke({ read_diagram: () => ({ text: initial, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name={name} client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const text = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const edge = (i: number) => utils.container.querySelector(`.react-flow__edge[data-id="edge:${i}"]`);
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  return { ...utils, view, text, node, edge, canvasEl, press, strip };
}

type Setup = ReturnType<typeof setup>;

async function drawn(s: Setup, label = "Step Check") {
  await waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });
}

function oneUndo(s: Setup, before: string) {
  act(() => void undo(s.view()));
  expect(s.text()).toBe(before);
}

test("F1 a selected line shows in the strip, and Delete removes it as one undo step", async () => {
  const s = setup();
  await drawn(s);
  expect(within(s.strip()).getByText("Nothing selected")).toBeTruthy();
  act(() => canvas.props!.onLineSelect!(["edge:1"]));
  await waitFor(() => expect(within(s.strip()).getByText("Check to Done")).toBeTruthy());
  expect(within(s.strip()).getByText("Line: yes")).toBeTruthy();
  expect(within(s.strip()).queryByText("Nothing selected")).toBeNull();
  s.press("Delete");
  await waitFor(() => expect(s.text()).toBe(FLOW.replace("Check > Done: yes\n", "")));
  // The line is gone, so nothing is selected any more.
  await waitFor(() => expect(within(s.strip()).getByText("Nothing selected")).toBeTruthy());
  oneUndo(s, FLOW);
});

test("F1 F25 Backspace deletes a selected line too, and a line in a chain keeps the others", async () => {
  const chain = lines('diagram flow "Chain"', "A", "B", "C", "", "A > B > C");
  const s = setup(chain, "chain");
  await drawn(s, "Step A");
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await waitFor(() => expect(within(s.strip()).getByText("A to B")).toBeTruthy());
  s.press("Backspace");
  await waitFor(() => expect(s.text()).toBe(lines('diagram flow "Chain"', "A", "B", "C", "", "B > C")));
  oneUndo(s, chain);
});

test("F1 a clicked line is selected on the canvas and its right-click menu has Delete", async () => {
  const s = setup();
  await drawn(s);
  await waitFor(() => expect(s.edge(0)).not.toBeNull());
  fireEvent.click(s.edge(0)!);
  await waitFor(() => expect(within(s.strip()).getByText("Request in to Check")).toBeTruthy());
  await waitFor(() => expect(s.edge(0)!.classList.contains("selected")).toBe(true));
  fireEvent.contextMenu(s.edge(0)!, { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Line actions" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual(["Edit label", "Arrow", "Colour", "Reverse", "Show in the text", "Delete"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
  await waitFor(() => expect(s.text()).toBe(FLOW.replace("Request in > Check\n", "")));
  oneUndo(s, FLOW);
});

test("F1 every kind's line deletes through the canvas: a message, a relationship, a transition", async () => {
  const cases: [string, string, string, string][] = [
    [lines('diagram sequence "Pay"', "participant App", "participant Api", "App -> Api : charge", "Api --> App : ok"), "Participant App", "Api to App", "Api --> App : ok\n"],
    [lines('diagram er "Billing"', "customers {", "  id int pk", "}", "invoices {", "  id int pk", "  customer_id int", "}", "", "invoices.customer_id > customers.id"), "Table customers", "invoices to customers", "invoices.customer_id > customers.id\n"],
    [lines('diagram class "Types"', "class Animal", "class Dog", "Animal <|-- Dog"), "Class Animal", "Animal to Dog", "Animal <|-- Dog\n"],
    [lines('diagram state "Invoice"', "Draft", "Sent", "[*] > Draft", "Draft > Sent : send"), "State Draft", "Draft to Sent", "Draft > Sent : send\n"],
  ];
  for (const [text, label, chip, gone] of cases) {
    const s = setup(text, `k-${label}`);
    await drawn(s, label);
    const index = label === "Participant App" ? 1 : label === "Class Animal" || label === "Table customers" ? 0 : 1;
    act(() => canvas.props!.onLineSelect!([`edge:${index}`]));
    await waitFor(() => expect(within(s.strip()).getByText(chip)).toBeTruthy());
    s.press("Delete");
    await waitFor(() => expect(s.text()).toBe(text.replace(gone, "")));
    oneUndo(s, text);
    cleanup();
  }
});

test("F1 with nodes and lines selected, Delete removes both as one undo step", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onSelect!(["Done"]));
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  s.press("Delete");
  await waitFor(() => expect(s.text()).toBe(lines('diagram flow "Refund"', "", "Request in [start]", "Check", "")));
  oneUndo(s, FLOW);
});

test("F25 Backspace deletes the selected shapes like Delete", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.keyDown(s.node("Step Check")!, { key: "Enter" });
  await waitFor(() => expect(s.node("Step Check")!.classList.contains("selected")).toBe(true));
  s.press("Backspace");
  await waitFor(() => expect(s.text()).toBe(lines('diagram flow "Refund"', "", "Request in [start]", "Done [end]", "")));
  oneUndo(s, FLOW);
});

test("F25 Backspace in the F2 field types, it does not delete the shape", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.keyDown(s.node("Step Check")!, { key: "Enter" });
  await waitFor(() => expect(s.node("Step Check")!.classList.contains("selected")).toBe(true));
  s.press("F2");
  const box = (await screen.findByRole("textbox", { name: "Rename Check" })) as HTMLInputElement;
  await userEvent.type(box, "{Backspace}");
  expect(box.value).not.toBe("Check");
  expect(screen.getByRole("textbox", { name: "Rename Check" })).toBe(box);
  expect(s.text()).toBe(FLOW);
});

test("F6 Enter on a selected shape edits its name in place", async () => {
  const s = setup();
  await drawn(s);
  // The first Enter on a focused shape selects it (React Flow); with it selected, Enter edits.
  fireEvent.keyDown(s.node("Step Check")!, { key: "Enter" });
  await waitFor(() => expect(s.node("Step Check")!.classList.contains("selected")).toBe(true));
  expect(screen.queryByRole("textbox", { name: "Rename Check" })).toBeNull();
  s.press("Enter");
  const box = await screen.findByRole("textbox", { name: "Rename Check" });
  // On the shape, not in a form beside it.
  expect(box.closest(".flow-rename-inline")).not.toBeNull();
  await userEvent.clear(box);
  await userEvent.type(box, "Review{Enter}");
  await waitFor(() => expect(s.text()).toBe(FLOW.replace(/Check/g, "Review")));
  oneUndo(s, FLOW);
});

test("F24 the tool bar's Select is not inert: it disarms the armed tool", async () => {
  const s = setup();
  await drawn(s);
  const bar = screen.getByRole("toolbar", { name: "Board tools" });
  const select = within(bar).getAllByRole("button")[0];
  expect(select.getAttribute("aria-label")).toBe("Select");
  expect(select.getAttribute("aria-pressed")).toBe("true");
  s.press("d");
  expect(within(bar).getByRole("button", { name: "Decision" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(select);
  expect(select.getAttribute("aria-pressed")).toBe("true");
  expect(within(bar).getByRole("button", { name: "Decision" }).getAttribute("aria-pressed")).toBe("false");
});

test("F29 Ctrl+Shift+E opens Publish, and the menu shows the key", async () => {
  const s = setup();
  await drawn(s);
  s.press("E", { ctrlKey: true, shiftKey: true });
  expect(await screen.findByRole("dialog", { name: "Publish image" }, { timeout: 3000 })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish image" })).toBeNull());
  fireEvent.contextMenu(s.container.querySelector(".react-flow__pane") as HTMLElement, { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Canvas actions" });
  const item = within(menu).getByRole("menuitem", { name: "Publish image..." });
  expect(item.textContent).toContain("Ctrl+Shift+E");
});

test("S5 a participant double-clicked between two lands between them in the text", async () => {
  const seq = lines('diagram sequence "Pay"', "participant App", "participant Api", "participant Bank", "App -> Api : charge");
  const s = setup(seq, "seq-gap");
  await drawn(s, "Participant Api");
  const at = (id: string) => canvas.props!.nodes.find((n) => n.id === id)!;
  const api = at("Api");
  const bank = at("Bank");
  // Halfway between Api and Bank.
  const x = (api.position.x + (api.initialWidth ?? 0) + bank.position.x) / 2;
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 500, y: 300 }, flow: { x, y: api.position.y } }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Participant/ }));
  // "Add here" (diagram): the new participant's name is ready; Enter writes it in the gap.
  await userEvent.type(await screen.findByRole("textbox", { name: "Name the new participant" }), "{Enter}");
  await waitFor(() =>
    expect(s.text()).toBe(lines('diagram sequence "Pay"', "participant App", "participant Api", "participant Participant", "participant Bank", "App -> Api : charge")),
  );
});

// ---- Fix round 1

test("I3 Enter on a focused tool bar button keeps its own Enter; it does not rename the selected shape", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onSelect!(["Check"]));
  await waitFor(() => expect(s.node("Step Check")!.classList.contains("selected")).toBe(true));
  const button = within(screen.getByRole("toolbar", { name: "Board tools" })).getByRole("button", { name: "Decision" });
  button.focus();
  // Not cancelled: the browser still activates the button.
  expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(true);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole("textbox", { name: "Rename Check" })).toBeNull();
  // On the canvas itself Enter still edits.
  s.press("Enter");
  expect(await screen.findByRole("textbox", { name: "Rename Check" })).toBeTruthy();
});

test("M3 a mind map branch is not a line in the text: its menu's Delete is off, and Delete says why", async () => {
  const mm = lines('diagram mindmap "Plan"', "root Q4 plan", "  Diagrams", "  Release");
  const s = setup(mm, "mm-branch");
  await drawn(s, "Topic Diagrams");
  const branch = canvas.props!.edges.findIndex((e) => e.className?.includes("flow-line-branch"));
  expect(branch).toBeGreaterThanOrEqual(0);
  act(() => canvas.props!.onLineSelect!([`edge:${branch}`]));
  await waitFor(() => expect(within(s.strip()).getByText("Branch")).toBeTruthy());
  s.press("Delete");
  await waitFor(() =>
    expect(within(s.strip()).getByRole("status").textContent).toBe("A branch comes from its topic's indent: move or delete the topic instead."),
  );
  expect(s.text()).toBe(mm);
  act(() => canvas.props!.onContextMenu!({ node: null, line: `edge:${branch}`, screen: { x: 200, y: 200 }, flow: { x: 0, y: 0 }, fit: () => {} }));
  const menu = await screen.findByRole("menu", { name: "Line actions" });
  expect((within(menu).getByRole("menuitem", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
});

test("M7 a delete of shapes and lines while the text has an error says the lines were left", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  act(() => canvas.props!.onSelect!(["Done"]));
  // An error typed in the text: the drawing is the last one that worked.
  act(() => s.view().dispatch({ changes: { from: s.text().length, insert: "Oops [\n" } }));
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  act(() => canvas.props!.onSelect!(["Done"]));
  s.press("Delete");
  await waitFor(() => expect(s.text()).not.toContain("Done [end]"));
  expect(within(s.strip()).getByRole("status").textContent).toBe("The selected lines were left: fix the text first, the drawing is the last one without errors.");
});

test("M10 a data flow's flow deletes through the canvas too", async () => {
  const dfd = lines('diagram dfd "D"', "Customer [entity]", "Checkout [process, id: 1.0]", "", "Customer > Checkout: order");
  const s = setup(dfd, "dfd-line");
  await drawn(s, "Process Checkout");
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await waitFor(() => expect(within(s.strip()).getByText("Flow: order")).toBeTruthy());
  s.press("Delete");
  await waitFor(() => expect(s.text()).toBe(lines('diagram dfd "D"', "Customer [entity]", "Checkout [process, id: 1.0]", "")));
});
