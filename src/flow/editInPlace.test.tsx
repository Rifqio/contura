// Diagram step 3 (board DiagramEditInPlace; diagram-ux-research F3, CL1, T1, C1): every kind's label is edited on
// the shape. Double-click, F2 or Enter open it with the text selected; Enter, a click away and Escape keep it (the
// user's decision of 25 Oct); Shift+Enter starts a new line where the kind allows it; a refused name stays in the
// field with its reason. Class members are rows, timeline items take their dates in place, a new group's title
// opens in edit. Each kept edit is one undo step.
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
import { boardFrameId } from "./board/boardScene";
import FlowTab from "./FlowTab";
import { SEQ_HEAD, SEQ_ROW } from "./kindLayout";

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

function setup(initial: string, name = "edit") {
  routeInvoke({ read_diagram: () => ({ text: initial, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
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
  const clickAway = () => userEvent.click(utils.container.querySelector(".react-flow__pane") as HTMLElement);
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  return { ...utils, view, doc, node, press, field, clickAway, strip };
}
type Setup = ReturnType<typeof setup>;

const shown = (s: Setup, label: string) => waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });

async function oneUndo(s: Setup, before: string) {
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(before));
}

async function select(s: Setup, label: string) {
  fireEvent.keyDown(s.node(label)!, { key: "Enter" });
  await waitFor(() => expect(s.node(label)!.classList.contains("selected")).toBe(true));
}

const FLOW = lines('diagram flow "Orders"', "Order in [start]", "Check stock", "Done [end]", "", "Order in > Check stock", "Check stock > Done");

test("F3 a double-click edits a flowchart step on the shape, its text selected, not in the details panel", async () => {
  const s = setup(FLOW);
  await shown(s, "Step Check stock");
  fireEvent.doubleClick(s.node("Step Check stock")!);
  const box = await s.field("Rename Check stock");
  expect(box.closest(".react-flow")).not.toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect([box.selectionStart, box.selectionEnd]).toEqual([0, "Check stock".length]);
  await userEvent.type(box, "Check shelf{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 11 });
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace(/Check stock/g, "Check shelf")));
  await oneUndo(s, FLOW);
});

test("F3 Shift+Enter starts a new line in a flowchart name, written quoted with \\n (ADR 0019 P5)", async () => {
  const s = setup(FLOW);
  await shown(s, "Step Check stock");
  await select(s, "Step Check stock");
  s.press("F2");
  const box = await s.field("Rename Check stock");
  expect(box.tagName).toBe("TEXTAREA");
  await userEvent.type(box, "{End}{Shift>}{Enter}{/Shift}twice{Enter}");
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace(/Check stock/g, '"Check stock\\ntwice"')));
});

test("F3 a sequence name stays on one line: Shift+Enter says so", async () => {
  const SEQ = lines('diagram sequence "Pay"', "participant App", "participant Api", "App -> Api: charge");
  const s = setup(SEQ);
  await shown(s, "Participant App");
  fireEvent.doubleClick(s.node("Participant App")!);
  const box = await s.field("Rename App");
  expect(box.tagName).toBe("INPUT");
  await userEvent.type(box, "{End}{Shift>}{Enter}{/Shift}");
  expect(s.container.querySelector(".inline-edit-hint")?.textContent).toBe("A sequence name stays on one line.");
  expect(s.doc()).toBe(SEQ);
});

test("F3 a taken name and an empty one are refused in place; the first Esc keeps the reason, the second puts it back", async () => {
  // Step 11: a class takes no label, so a taken name is still refused there (a flowchart shape keeps it as label:).
  const CLS = lines('diagram class "Orders"', "class Customer", "class Order", "", "Customer --> Order");
  const s = setup(CLS);
  await shown(s, "Class Order");
  fireEvent.doubleClick(s.node("Class Order")!.querySelector(".fkind-head")!);
  const box = await s.field("Rename Order");
  await userEvent.clear(box);
  await userEvent.type(box, "Customer{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("Customer is already used.");
  // A click away (on the frame, so the frame stays selected: a click outside the only frame lets it go, final review
  // F2) keeps the field and the typed text.
  // The frame's box passes pointer events through to the canvas, which keeps the live frame on a click inside it.
  const frameBox = [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === boardFrameId("Orders"))!;
  await userEvent.setup({ pointerEventsCheck: 0 }).click(frameBox);
  expect((await s.field("Rename Order")).value).toBe("Customer");
  await userEvent.clear(box);
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("A class needs a name."));
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.getByRole("textbox", { name: "Rename Order" })).toBe(box);
  expect(screen.getByRole("alert").textContent).toBe("A class needs a name.");
  fireEvent.keyDown(box, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Rename Order" })).toBeNull());
  expect(s.doc()).toBe(CLS);
});

test("F3 a note's text and a line's label edit in place; Esc keeps what was typed", async () => {
  const NOTE = lines('diagram flow "Orders"', "A", "B", "note: ask legal", "", "A > B");
  const s = setup(NOTE);
  await shown(s, "Note Note 1");
  fireEvent.doubleClick(s.node("Note Note 1")!);
  const box = await s.field("Edit the note");
  await userEvent.type(box, "{End}, then sign{Escape}");
  await waitFor(() => expect(s.doc()).toBe(NOTE.replace("note: ask legal", "note: ask legal, then sign")));
  act(() => canvas.props!.onEdgeDoubleClick!("edge:0"));
  const label = await s.field("Flow label");
  await userEvent.type(label, "yes{Escape}");
  await waitFor(() => expect(s.doc()).toBe(NOTE.replace("note: ask legal", "note: ask legal, then sign").replace("A > B", "A > B: yes")));
});

test("S3 a message's label edits on its own row", async () => {
  const SEQ = lines('diagram sequence "Pay"', "participant App", "participant Api", "App -> Api: charge", "Api --> App: ok");
  const s = setup(SEQ);
  await shown(s, "Participant App");
  act(() => canvas.props!.onEdgeDoubleClick!("edge:1"));
  const label = await s.field("Message label");
  const top = parseFloat((label.closest(".inline-edit-wrap") as HTMLElement).style.top);
  const app = canvas.props!.nodes.find((n) => n.id === "App")!;
  expect(Math.abs(top - (app.position.y + SEQ_HEAD + 1.5 * SEQ_ROW))).toBeLessThanOrEqual(18);
  await userEvent.type(label, "{End} done{Enter}");
  await waitFor(() => expect(s.doc()).toBe(SEQ.replace("Api --> App: ok", "Api --> App: ok done")));
});

test("the state start and end markers have no name: Enter says they are written [*]", async () => {
  const STATE = lines('diagram state "Invoice"', "Draft", "", "[*] > Draft");
  const s = setup(STATE);
  await shown(s, "Start");
  await select(s, "Start");
  s.press("Enter");
  await waitFor(() => expect(s.strip().textContent).toContain("The start and end markers have no name: they are written [*]."));
  expect(screen.queryByRole("textbox", { name: /Rename/ })).toBeNull();
});

const CLASS = lines('diagram class "Billing"', "class Invoice", "Invoice : + total: decimal", "Invoice : + send()", "class LineItem", "LineItem : + qty: int", "", "Invoice *-- LineItem");

test("CL1 a double-click on a member edits it in its row; the class name renames in the header", async () => {
  const s = setup(CLASS);
  await shown(s, "Class Invoice");
  fireEvent.doubleClick(s.node("Class Invoice")!.querySelector('[data-row="1"]')!);
  const box = await s.field("Member");
  expect(box.value).toBe("+ send()");
  expect(box.closest('[data-row="1"]')).not.toBeNull();
  await userEvent.type(box, "+ send(to: Email){Enter}", { initialSelectionStart: 0, initialSelectionEnd: 8 });
  await waitFor(() => expect(s.doc()).toBe(CLASS.replace("+ send()", "+ send(to: Email)")));
  await oneUndo(s, CLASS);
  fireEvent.doubleClick(s.node("Class LineItem")!.querySelector(".fkind-head")!);
  const name = await s.field("Rename LineItem");
  await userEvent.type(name, "Line{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 8 });
  await waitFor(() => expect(s.doc()).toBe(CLASS.replace(/LineItem/g, "Line")));
});

test("CL1 a double-click on the card's empty space adds rows: Enter keeps adding, Enter on an empty row closes, Esc on an untouched row removes it", async () => {
  const s = setup(CLASS);
  await shown(s, "Class LineItem");
  fireEvent.doubleClick(s.node("Class LineItem")!.querySelector(".fkind-inside")!);
  let box = await s.field("Member");
  expect(box.closest(".is-new")).not.toBeNull();
  await userEvent.type(box, "+ price: decimal{Enter}");
  await waitFor(() => expect(s.doc()).toBe(CLASS.replace("LineItem : + qty: int\n", "LineItem : + qty: int\nLineItem : + price: decimal\n")));
  box = await s.field("Member");
  expect(box.value).toBe("");
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Member" })).toBeNull());
  await oneUndo(s, CLASS);
  fireEvent.doubleClick(s.node("Class LineItem")!.querySelector(".fkind-inside")!);
  box = await s.field("Member");
  await userEvent.type(box, "{Escape}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Member" })).toBeNull());
  expect(s.doc()).toBe(CLASS);
});

test("CL1 a member already in the class is refused in place", async () => {
  const s = setup(CLASS);
  await shown(s, "Class LineItem");
  fireEvent.doubleClick(s.node("Class LineItem")!.querySelector(".fkind-inside")!);
  const box = await s.field("Member");
  await userEvent.type(box, "+ qty: int{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("+ qty: int is already a member of LineItem.");
  expect(s.doc()).toBe(CLASS);
});

test("CL1 with a member selected, Ctrl+Enter copies it below and Delete removes it, one undo step each", async () => {
  const s = setup(CLASS);
  await shown(s, "Class LineItem");
  fireEvent.doubleClick(s.node("Class LineItem")!.querySelector('[data-row="0"]')!);
  const box = await s.field("Member");
  // Kept unchanged: the member stays selected.
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Member" })).toBeNull());
  s.press("Enter", { ctrlKey: true });
  await waitFor(() => expect(s.doc()).toBe(CLASS.replace("LineItem : + qty: int\n", "LineItem : + qty: int\nLineItem : + qty_copy: int\n")));
  await oneUndo(s, CLASS);
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(CLASS.replace("LineItem : + qty: int\n", "")));
  await oneUndo(s, CLASS);
});

test("CL1 hovering a class shows + member, which opens a new row", async () => {
  const s = setup(CLASS);
  await shown(s, "Class Invoice");
  fireEvent.pointerMove(s.node("Class Invoice")!, { clientX: 10, clientY: 10 });
  await userEvent.click(await screen.findByRole("button", { name: "Add member" }));
  const box = await s.field("Member");
  await userEvent.type(box, "+ due: date{Enter}");
  await waitFor(() => expect(s.doc()).toBe(CLASS.replace("Invoice : + send()\n", "Invoice : + send()\nInvoice : + due: date\n")));
});

const TIME = lines('diagram timeline "Launch"', "2026-10-01: Kickoff", "2026-10-05 to 2026-10-20: Build", "milestone v1.0");

test("T1 a double-click on an event's date opens a date field on the item; Enter writes it as one undo step", async () => {
  const s = setup(TIME);
  await shown(s, "Event Kickoff");
  fireEvent.doubleClick(s.node("Event Kickoff")!.querySelector('[data-part="date"]')!);
  const date = (await screen.findByLabelText("Date")) as HTMLInputElement;
  expect(date.type).toBe("date");
  expect(date.closest(".react-flow__node")).toBe(s.node("Event Kickoff"));
  fireEvent.change(date, { target: { value: "2026-10-03" } });
  fireEvent.keyDown(date, { key: "Enter" });
  await waitFor(() => expect(s.doc()).toBe(TIME.replace("2026-10-01: Kickoff", "2026-10-03: Kickoff")));
  await oneUndo(s, TIME);
});

test("T1 a period has From and Until; Tab goes from one to the other; an end before the start is refused in place", async () => {
  const s = setup(TIME);
  await shown(s, "Period Build");
  fireEvent.doubleClick(s.node("Period Build")!.querySelector('[data-part="date"]')!);
  const from = (await screen.findByLabelText("From")) as HTMLInputElement;
  const until = screen.getByLabelText("Until") as HTMLInputElement;
  fireEvent.change(from, { target: { value: "2026-10-25" } });
  fireEvent.keyDown(from, { key: "Tab" });
  expect(document.activeElement).toBe(until);
  fireEvent.keyDown(until, { key: "Enter" });
  expect((await screen.findByRole("alert")).textContent).toBe("The end is before the start: pick a later end date.");
  expect(s.doc()).toBe(TIME);
  fireEvent.change(until, { target: { value: "2026-11-01" } });
  fireEvent.keyDown(until, { key: "Enter" });
  await waitFor(() => expect(s.doc()).toBe(TIME.replace("2026-10-05 to 2026-10-20", "2026-10-25 to 2026-11-01")));
});

const CLOUD = lines('diagram cloud "App"', "Users [icon: users]", "Api [icon: aws-api-gateway]", "Fn [icon: aws-lambda]", "", "Users > Api", "Api > Fn");

test("C1 G then Enter on a selection draws the new group with its name selected; Enter writes it, Esc on the untouched name groups nothing", async () => {
  const s = setup(CLOUD);
  await shown(s, "Service Api");
  act(() => canvas.props!.onSelect!(["Api", "Fn"]));
  s.press("g");
  s.press("Enter");
  let box = await s.field("Group name");
  expect([box.value, box.selectionStart, box.selectionEnd]).toEqual(["Group", 0, 5]);
  await userEvent.type(box, "{Escape}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Group name" })).toBeNull());
  expect(s.doc()).toBe(CLOUD);
  act(() => canvas.props!.onSelect!(["Api", "Fn"]));
  s.press("g");
  s.press("Enter");
  box = await s.field("Group name");
  await userEvent.type(box, "Backend{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 5 });
  await waitFor(() => expect(s.doc()).toBe(lines('diagram cloud "App"', "Users [icon: users]", "Backend [icon: aws-vpc] {", "  Api [icon: aws-api-gateway]", "  Fn [icon: aws-lambda]", "}", "", "Users > Api", "Api > Fn")));
  await oneUndo(s, CLOUD);
});

test("C1 a double-click on a group's title renames it", async () => {
  const GROUPED = lines('diagram cloud "App"', "Users [icon: users]", "Backend {", "  Api [icon: aws-api-gateway]", "}", "", "Users > Api");
  const s = setup(GROUPED);
  await shown(s, "Service Api");
  // Area nodes take no presses: the canvas finds the title under a double-click on it.
  const area = canvas.props!.nodes.find((n) => n.id === "\u0000group:Backend")!;
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 0, y: 0 }, flow: { x: area.position.x + 30, y: area.position.y + 14 } }));
  const box = await s.field("Group name");
  await userEvent.type(box, "Core{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 7 });
  await waitFor(() => expect(s.doc()).toBe(GROUPED.replace("Backend {", "Core {")));
});

// ----- Re-review R1: a member or a date typed, then another frame picked: the edit lands in its own frame.

const liveNode = (s: Setup, id: string) => [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === id) ?? null;
/** A press and click on a frame's tab, as a browser sends them. */
async function pressTab(title: string) {
  const tab = await screen.findByRole("button", { name: new RegExp(` ${title}$`) });
  fireEvent.pointerDown(tab, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(tab, { button: 0, pointerId: 1 });
  fireEvent.click(tab);
}
const blockOf = (text: string, title: string) => {
  const from = text.indexOf(`"${title}"`);
  const next = text.indexOf("\ndiagram ", from);
  return text.slice(from, next < 0 ? text.length : next);
};
const isLive = (s: Setup, title: string) => {
  const el = [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === boardFrameId(title));
  return !!el && within(el).queryByRole("button", { name: /^Code Editor/ }) !== null;
};
/** Picks a live shape first, so its card is drawn selected before a field opens on it. */
async function picked(s: Setup, id: string) {
  await waitFor(() => expect(liveNode(s, id)).not.toBeNull());
  act(() => canvas.props!.onSelect!([id]));
  await waitFor(() => expect(liveNode(s, id)!.querySelector(".fnode-selected")).not.toBeNull());
}

test("R1 a member typed, then another frame picked, lands in its own frame", async () => {
  const BOARD = lines('diagram class "A"', "class Order", "Order : + id: int", "", 'diagram class "B"', "class Order", "Order : + id: int");
  const s = setup(BOARD);
  await pressTab("A");
  await picked(s, "Order");
  fireEvent.doubleClick(liveNode(s, "Order")!.querySelector(".fkind-inside")!);
  const box = await s.field("Member");
  await userEvent.type(box, "+ total: int");
  await pressTab("B");
  await waitFor(() => expect(isLive(s, "B")).toBe(true));
  await waitFor(() => expect(blockOf(s.doc(), "A")).toContain("Order : + total: int"));
  expect(blockOf(s.doc(), "B")).not.toContain("total");
  expect(screen.queryByRole("textbox", { name: "Member" })).toBeNull();
});

test("R1 a date typed, then another frame picked, lands in its own frame", async () => {
  const BOARD = lines('diagram timeline "A"', "2026-10-01: Kickoff", "", 'diagram timeline "B"', "2026-10-01: Kickoff");
  const s = setup(BOARD);
  await pressTab("A");
  await picked(s, "Kickoff");
  fireEvent.doubleClick(liveNode(s, "Kickoff")!.querySelector('[data-part="date"]')!);
  const date = (await screen.findByLabelText("Date")) as HTMLInputElement;
  fireEvent.change(date, { target: { value: "2026-10-03" } });
  await pressTab("B");
  await waitFor(() => expect(isLive(s, "B")).toBe(true));
  await waitFor(() => expect(blockOf(s.doc(), "A")).toContain("2026-10-03: Kickoff"));
  expect(blockOf(s.doc(), "B")).toContain("2026-10-01: Kickoff");
  expect(screen.queryByLabelText("Date")).toBeNull();
});

// ----- Static frames are inert: a card of the same name in another frame never draws the live frame's edit row.

test("a member row on a board where two frames have a User opens once, keeps focus and commits", async () => {
  const BOARD = lines('diagram class "A"', "class User", "User : + id: int", "", 'diagram class "B"', "class User", "User : + id: int");
  const s = setup(BOARD);
  await pressTab("A");
  await picked(s, "User");
  fireEvent.doubleClick(liveNode(s, "User")!.querySelector(".fkind-inside")!);
  const box = await s.field("Member");
  expect(screen.getAllByRole("textbox", { name: "Member" })).toHaveLength(1);
  expect(liveNode(s, "User")!.contains(box)).toBe(true);
  expect(document.activeElement).toBe(box);
  await userEvent.type(box, "+ email: text{Enter}");
  await waitFor(() => expect(blockOf(s.doc(), "A")).toContain("User : + email: text"));
  expect(blockOf(s.doc(), "B")).not.toContain("email");
});

test("a date field on a board where two frames have a Kickoff opens once, keeps focus and commits", async () => {
  const BOARD = lines('diagram timeline "A"', "2026-10-01: Kickoff", "", 'diagram timeline "B"', "2026-10-01: Kickoff");
  const s = setup(BOARD);
  await pressTab("A");
  await picked(s, "Kickoff");
  fireEvent.doubleClick(liveNode(s, "Kickoff")!.querySelector('[data-part="date"]')!);
  const date = (await screen.findByLabelText("Date")) as HTMLInputElement;
  expect(screen.getAllByLabelText("Date")).toHaveLength(1);
  expect(liveNode(s, "Kickoff")!.contains(date)).toBe(true);
  expect(document.activeElement).toBe(date);
  fireEvent.change(date, { target: { value: "2026-10-03" } });
  fireEvent.keyDown(date, { key: "Enter" });
  await waitFor(() => expect(blockOf(s.doc(), "A")).toContain("2026-10-03: Kickoff"));
  expect(blockOf(s.doc(), "B")).toContain("2026-10-01: Kickoff");
});
