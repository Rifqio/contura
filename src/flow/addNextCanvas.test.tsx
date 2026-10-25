// Diagram step 6 (board DiagramAddNext; diagram-ux-research F17, F13, FC1, F18, ST1, D1): add the next shape. A +
// on each side of a hovered or selected shape adds a connected shape of the same kind there, its name ready, written
// only when the name is kept (one undo step); Alt+Shift+arrow does the same; a + dragged onto a shape draws a line,
// onto empty canvas a new connected shape. Only a data flow and a sequence ask for the new line's label. Every Shapes
// item adds on the canvas, "Add here" offers the kind's shapes at a double-click, the state markers join a state, and
// Ctrl+G groups while Ctrl+Shift+G and Ctrl+Shift+U take a group apart.
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

function setup(initial: string, layout: string | null = null, name = "add") {
  routeInvoke({ read_diagram: () => ({ text: initial, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name={name} client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const field = (label: string) => screen.findByRole("textbox", { name: label }) as Promise<HTMLInputElement>;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const at = (n: string) => canvas.props!.nodes.find((x) => x.id === n)?.position;
  const box = (n: string) => {
    const g = canvas.props!.nodes.find((x) => x.id === n)!;
    return { x: g.position.x, y: g.position.y, w: g.initialWidth ?? 0, h: g.initialHeight ?? 0 };
  };
  return { ...utils, view, doc, node, press, field, strip, at, box };
}
type Setup = ReturnType<typeof setup>;

const shown = (s: Setup, label: string) => waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });

async function oneUndo(s: Setup, before: string) {
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(before));
}

const FLOW = lines('diagram flow "Orders"', "Order in [start]", "Check stock", "", "Order in > Check stock");
const FLOW_AT = JSON.stringify({ version: 1, nodes: { "Order in": { x: 100, y: 100 }, "Check stock": { x: 100, y: 194 } } });

/** Clicks a + (a press and a release in place). */
function clickPlus(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerUp(window, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
}

test("F17 hovering a shape shows a + on each side; a click adds the next shape there, written only when its name is kept, with its line, as one undo step", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  expect(screen.queryByRole("button", { name: /Add the next step/ })).toBeNull();
  fireEvent.pointerMove(s.node("Step Check stock")!, { clientX: 10, clientY: 10 });
  const plus = await screen.findAllByRole("button", { name: /Add the next step/ });
  expect(plus.map((p) => p.getAttribute("aria-label"))).toEqual(["Add the next step above", "Add the next step to the right", "Add the next step below", "Add the next step to the left"]);
  clickPlus(screen.getByRole("button", { name: "Add the next step below" }));
  const name = await s.field("Name the new step");
  expect([name.value, name.selectionStart, name.selectionEnd]).toEqual(["Step", 0, 4]);
  // Nothing is written yet.
  expect(s.doc()).toBe(FLOW);
  // One layout gap below its source, centred on it: the diagram's own gap, the one between Order in and Check stock.
  const ghost = s.container.querySelector(".flow-ghost") as HTMLElement;
  const src = s.box("Check stock");
  const gap = src.y - (s.box("Order in").y + s.box("Order in").h);
  expect(parseFloat(ghost.style.top)).toBe(src.y + src.h + gap);
  expect(parseFloat(ghost.style.left) + parseFloat(ghost.style.width) / 2).toBeCloseTo(src.x + src.w / 2, 0);
  await userEvent.type(name, "Ship{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 4 });
  await waitFor(() => expect(s.doc()).toBe(lines('diagram flow "Orders"', "Order in [start]", "Check stock", "Ship [step]", "", "Order in > Check stock", "Check stock > Ship")));
  // A flowchart asks for no label (F13).
  expect(screen.queryByRole("textbox", { name: "Flow label" })).toBeNull();
  await waitFor(() => expect(s.at("Ship")).toEqual({ x: Math.round(parseFloat(ghost.style.left)), y: src.y + src.h + gap }));
  await oneUndo(s, FLOW);
});

test("F17 Esc on the untouched name adds nothing and leaves no undo step", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  fireEvent.pointerMove(s.node("Step Check stock")!, { clientX: 10, clientY: 10 });
  clickPlus(await screen.findByRole("button", { name: "Add the next step to the right" }));
  const name = await s.field("Name the new step");
  fireEvent.keyDown(name, { key: "Escape" });
  await waitFor(() => expect(s.container.querySelector(".flow-ghost")).toBeNull());
  expect(s.doc()).toBe(FLOW);
  act(() => {
    expect(undo(s.view())).toBe(false);
  });
});

test("F17 Alt+Shift+arrow clones and connects from the keyboard", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  act(() => canvas.props!.onSelect!(["Check stock"]));
  s.press("ArrowDown", { altKey: true, shiftKey: true });
  const name = await s.field("Name the new step");
  await userEvent.type(name, "Pack{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 4 });
  await waitFor(() => expect(s.doc()).toContain("Check stock > Pack\n"));
});

test("F17 a + dragged onto another shape draws a line to it; onto empty canvas, a new connected shape there", async () => {
  const two = lines('diagram flow "Orders"', "Order in [start]", "Check stock", "Done [end]");
  const at = JSON.stringify({ version: 1, nodes: { "Order in": { x: 100, y: 100 }, "Check stock": { x: 100, y: 300 }, Done: { x: 500, y: 300 } } });
  const s = setup(two, at);
  await shown(s, "End Done");
  const toScreen = (p: { x: number; y: number }) => {
    // The test canvas draws flow coordinates through the viewport's transform.
    const vp = s.container.querySelector(".react-flow__viewport") as HTMLElement;
    const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(vp.style.transform) ?? ["", "0", "0", "1"];
    const r = s.container.querySelector(".react-flow")!.getBoundingClientRect();
    return { x: r.left + Number(m[1]) + p.x * Number(m[3]), y: r.top + Number(m[2]) + p.y * Number(m[3]) };
  };
  fireEvent.pointerMove(s.node("Start Order in")!, { clientX: 10, clientY: 10 });
  const plus = await screen.findByRole("button", { name: "Add the next start or end below" });
  const done = s.box("Done");
  const onDone = toScreen({ x: done.x + done.w / 2, y: done.y + done.h / 2 });
  fireEvent.pointerDown(plus, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: onDone.x / 2, clientY: onDone.y / 2, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: onDone.x, clientY: onDone.y, pointerId: 1 });
  await waitFor(() => expect(s.doc()).toBe(`${two}\nOrder in > Done\n`));
  fireEvent.pointerMove(s.node("Step Check stock")!, { clientX: 10, clientY: 10 });
  const plus2 = await screen.findByRole("button", { name: "Add the next step below" });
  const empty = toScreen({ x: 160, y: 600 });
  fireEvent.pointerDown(plus2, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: empty.x - 30, clientY: empty.y - 30, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: empty.x, clientY: empty.y, pointerId: 1 });
  const name = await s.field("Name the new step");
  const ghost = s.container.querySelector(".flow-ghost") as HTMLElement;
  // Centred where it was let go.
  expect(parseFloat(ghost.style.left) + parseFloat(ghost.style.width) / 2).toBeCloseTo(160, 0);
  expect(parseFloat(ghost.style.top) + parseFloat(ghost.style.height) / 2).toBeCloseTo(600, 0);
  await userEvent.type(name, "{Enter}");
  await waitFor(() => expect(s.doc()).toContain("Check stock > Step\n"));
});

const DFD = lines('diagram dfd "Orders"', "Customer [entity, id: E1]", "Take order [process, id: 1.0]", "", "Customer > Take order: order");
const DFD_AT = JSON.stringify({ version: 1, nodes: { Customer: { x: 100, y: 100 }, "Take order": { x: 400, y: 100 } } });

test("F13 a data flow asks for the new flow's label, as its own undo step", async () => {
  const s = setup(DFD, DFD_AT);
  await shown(s, "Process Take order");
  fireEvent.pointerMove(s.node("Process Take order")!, { clientX: 10, clientY: 10 });
  clickPlus(await screen.findByRole("button", { name: "Add the next process to the right" }));
  const name = await s.field("Name the new process");
  await userEvent.type(name, "Bill{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 7 });
  const after = lines('diagram dfd "Orders"', "Customer [entity, id: E1]", "Take order [process, id: 1.0]", "Bill [process, id: 2.0]", "", "Customer > Take order: order", "Take order > Bill");
  await waitFor(() => expect(s.doc()).toBe(after));
  const label = await s.field("Flow label");
  await userEvent.type(label, "items{Enter}");
  await waitFor(() => expect(s.doc()).toBe(after.replace("Take order > Bill", "Take order > Bill: items")));
  await oneUndo(s, after);
  await oneUndo(s, DFD);
});

test("F13 a line drawn in a flowchart, state or class asks for no label", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  act(() => canvas.props!.onConnectPorts!({ node: "Check stock", port: "r" }, { node: "Order in", port: "l" }, false));
  await waitFor(() => expect(s.doc()).toContain("Check stock > Order in\n"));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole("textbox", { name: "Flow label" })).toBeNull();
});

async function openShapes(_s: Setup) {
  await userEvent.click(screen.getByRole("button", { name: "Shapes" }));
  return screen.findByRole("menu", { name: "Shapes" });
}

test("F18 every flowchart Shapes item adds on the canvas: a Database ghost with its name ready, Group disabled without a selection", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  const menu = await openShapes(s);
  expect(within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual([
    "Start or end",
    "Step",
    "Decision",
    "Input or output",
    "Subprocess",
    "Document",
    "Database",
    "Note",
    "Line",
    "Group",
  ]);
  const group = within(menu).getByRole("menuitem", { name: "Group" });
  expect(group.getAttribute("aria-disabled")).toBe("true");
  expect(group.textContent).toContain("Select shapes first");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Database" }));
  const name = await s.field("Name the new database");
  await userEvent.type(name, "Stock{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 8 });
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace("Check stock\n", "Check stock\nStock [database]\n")));
  // Placed clear of the other shapes.
  const b = s.box("Stock");
  for (const other of ["Order in", "Check stock"]) {
    const o = s.box(other);
    expect(b.x >= o.x + o.w || b.x + b.w <= o.x || b.y >= o.y + o.h || b.y + b.h <= o.y).toBe(true);
  }
});

test("F18 a Line item is drawn from the next two shapes clicked; Esc leaves the mode", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  await userEvent.click(within(await openShapes(s)).getByRole("menuitem", { name: "Line" }));
  await waitFor(() => expect(s.strip().textContent).toContain("Click the shape the line starts from, then the one it goes to."));
  act(() => canvas.props!.onSelect!(["Check stock"]));
  await waitFor(() => expect(s.strip().textContent).toContain("Now click the shape the line goes to."));
  act(() => canvas.props!.onSelect!(["Order in"]));
  await waitFor(() => expect(s.doc()).toBe(`${FLOW}Check stock > Order in\n`));
});

test("F18 class Inheritance is drawn from the child to the parent, written parent first", async () => {
  const CLASS = lines('diagram class "Pay"', "class Payable", "class Customer");
  const s = setup(CLASS);
  await shown(s, "Class Customer");
  act(() => canvas.props!.onSelect!(["Customer"]));
  await userEvent.click(within(await openShapes(s)).getByRole("menuitem", { name: "Inheritance" }));
  await waitFor(() => expect(s.strip().textContent).toContain("Click the class Customer inherits from."));
  act(() => canvas.props!.onSelect!(["Payable"]));
  await waitFor(() => expect(s.doc()).toBe(`${CLASS}\nPayable <|-- Customer\n`));
});

test("Add here: a double-click on the blank canvas offers the kind's shapes at the pointer; the pick lands there, its name ready", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 500, y: 400 }, flow: { x: 600, y: 300 } }));
  const grid = await screen.findByRole("menu", { name: "Add here" });
  expect(within(grid).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Start or end", "Step", "Decision", "Input or output", "Subprocess", "Document", "Database", "Note"]);
  // Arrow keys move in the grid, Enter picks.
  expect(document.activeElement?.textContent).toBe("Start or end");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toBe("Subprocess");
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  const name = await s.field("Name the new subprocess");
  const ghost = s.container.querySelector(".flow-ghost") as HTMLElement;
  expect(parseFloat(ghost.style.left) + parseFloat(ghost.style.width) / 2).toBeCloseTo(600, 0);
  await userEvent.type(name, "{Enter}");
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace("Check stock\n", "Check stock\nSubprocess [subprocess]\n")));
});

test("N adds a note where the kind has notes, its text ready", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  s.press("n");
  const text = await s.field("Note text");
  await userEvent.type(text, "Ask legal{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 4 });
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace("Check stock\n", "Check stock\nnote: Ask legal\n")));
});

const STATE = lines('diagram state "Invoice"', "Draft", "Sent", "", "Draft > Sent : send");

test("ST1 Shapes > Start joins the selected state; End asks for a state, then joins it", async () => {
  const s = setup(STATE);
  await shown(s, "State Draft");
  act(() => canvas.props!.onSelect!(["Draft"]));
  await userEvent.click(within(await openShapes(s)).getByRole("menuitem", { name: "Start" }));
  await waitFor(() => expect(s.doc()).toBe(`${STATE}[*] > Draft\n`));
  await oneUndo(s, STATE);
  act(() => canvas.props!.onSelect!([]));
  await userEvent.click(within(await openShapes(s)).getByRole("menuitem", { name: "End" }));
  await waitFor(() => expect(s.strip().textContent).toContain("Click the last state: the end goes after it."));
  act(() => canvas.props!.onSelect!(["Sent"]));
  await waitFor(() => expect(s.doc()).toBe(`${STATE}Sent > [*]\n`));
});

test("D1 Ctrl+G puts the selection in a composite with its name in edit; Ctrl+Shift+G and Ctrl+Shift+U take it apart, one undo step each", async () => {
  const s = setup(STATE);
  await shown(s, "State Draft");
  act(() => canvas.props!.onSelect!(["Draft", "Sent"]));
  s.press("g", { ctrlKey: true });
  const name = await s.field("Composite name");
  await userEvent.type(name, "Open{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 9 });
  const grouped = lines('diagram state "Invoice"', "Open {", "  Draft", "  Sent", "}", "", "Draft > Sent : send");
  await waitFor(() => expect(s.doc()).toBe(grouped));
  await waitFor(() => expect(s.node("State Draft")).not.toBeNull());
  act(() => canvas.props!.onSelect!(["Draft"]));
  s.press("G", { ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(s.doc()).toBe(STATE));
  await oneUndo(s, grouped);
  await waitFor(() => expect(s.node("State Draft")).not.toBeNull());
  act(() => canvas.props!.onSelect!(["Sent"]));
  s.press("U", { ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(s.doc()).toBe(STATE));
});

test("D1 Ctrl+G in a kind with no groups says why", async () => {
  const s = setup(lines('diagram class "Pay"', "class Payable", "class Customer"));
  await shown(s, "Class Customer");
  act(() => canvas.props!.onSelect!(["Customer", "Payable"]));
  s.press("g", { ctrlKey: true });
  await waitFor(() => expect(s.strip().textContent).toContain("Nothing grouped: A class diagram has no groups."));
});

test("F18 sequence: Loop goes around the selected message, its label ready; Activation asks for the participant", async () => {
  const SEQ = lines('diagram sequence "Pay"', "participant App", "participant Api", "", "App -> Api: charge", "Api --> App: ok");
  const s = setup(SEQ);
  await shown(s, "Participant App");
  await userEvent.click(within(await openShapes(s)).getByRole("menuitem", { name: "Loop" }));
  const label = await s.field("Loop label");
  expect(label.value).toBe("every item");
  await userEvent.type(label, "{Enter}");
  await waitFor(() => expect(s.doc()).toBe(SEQ.replace("Api --> App: ok\n", "loop every item {\n  Api --> App: ok\n}\n")));
  await oneUndo(s, SEQ);
  await userEvent.click(within(await openShapes(s)).getByRole("menuitem", { name: "Activation" }));
  await waitFor(() => expect(s.strip().textContent).toContain("Click the participant that becomes active."));
  act(() => canvas.props!.onSelect!(["Api"]));
  await waitFor(() => expect(s.doc()).toBe(`${SEQ}activate Api\n`));
});

test("F18 mind map: Central idea is disabled once the map has one; Subtopic goes under the selected topic", async () => {
  const MIND = lines('diagram mindmap "Plan"', "root Launch", "  Docs");
  const s = setup(MIND);
  await shown(s, "Topic Docs");
  act(() => canvas.props!.onSelect!(["Docs"]));
  const menu = await openShapes(s);
  expect(within(menu).getByRole("menuitem", { name: "Central idea" }).getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Subtopic" }));
  const name = await s.field("Name the new topic");
  await userEvent.type(name, "Guide{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 5 });
  await waitFor(() => expect(s.doc()).toBe(`${MIND}    Guide\n`));
});

test("F18 timeline: Section takes the selected events, its name ready", async () => {
  const TL = lines('diagram timeline "Launch"', "2026-10-01: Kickoff", "2026-10-05: Build");
  const s = setup(TL);
  await shown(s, "Event Kickoff");
  expect(within(await openShapes(s)).getByRole("menuitem", { name: "Section" }).getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Shapes" }));
  act(() => canvas.props!.onSelect!(["Kickoff", "Build"]));
  await userEvent.click(within(await openShapes(s)).getByRole("menuitem", { name: "Section" }));
  const name = await s.field("Section name");
  await userEvent.type(name, "Phase 1{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 7 });
  await waitFor(() => expect(s.doc()).toBe(lines('diagram timeline "Launch"', "section Phase 1", "  2026-10-01: Kickoff", "  2026-10-05: Build")));
});
