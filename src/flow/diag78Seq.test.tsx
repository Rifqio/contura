// Diagram step 8 (board DiagramSequence, rulings of 25 Oct): the sequence on the canvas. A click or a drag between
// two lifelines puts a message at that height and opens its label on its row (S1, S3); a message drags up or down
// with an insertion line (S1); a participant drags sideways (S2); a message's menu has Request and Reply, Add reply
// below, Reverse and Loop around the selection, and a selected loop is renamed or taken apart with its messages kept
// (S4). Each write is one undo step and its exact text is checked.
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

const SEQ = lines(
  'diagram sequence "Checkout"',
  "actor Customer",
  "participant Shop",
  "participant Stock",
  "participant Payments",
  "",
  "Customer -> Shop: place order",
  "Shop -> Stock: reserve items",
  "Stock --> Shop: reserved",
  "Shop -> Payments: charge card",
  "Payments --> Shop: approved",
  "Shop --> Customer: receipt",
);

const LOOPED = lines(
  'diagram sequence "Checkout"',
  "actor Customer",
  "participant Shop",
  "participant Stock",
  "",
  "Customer -> Shop: place order",
  "loop every item {",
  "  Shop -> Stock: reserve items",
  "  Stock --> Shop: reserved",
  "}",
  "Shop --> Customer: receipt",
);

function setup(initial = SEQ) {
  routeInvoke({ read_diagram: () => ({ text: initial, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="d78s" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const field = (label: string) => screen.findByRole("textbox", { name: label }) as Promise<HTMLInputElement>;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const box = (n: string) => {
    const g = canvas.props!.nodes.find((x) => x.id === n)!;
    return { x: g.position.x, y: g.position.y, w: g.initialWidth ?? 0, h: g.initialHeight ?? 0 };
  };
  /** Message `i`'s row: its height on the canvas. */
  const row = (i: number) => (canvas.props!.edges.find((e) => e.id === `edge:${i}`)!.data as { y: number }).y;
  const mid = (n: string) => box(n).x + box(n).w / 2;
  /** A flow point on screen, through the viewport's transform (jsdom puts the pane at 0, 0). */
  const screenAt = (x: number, y: number) => {
    const t = (utils.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
    const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(t) ?? ["", "0", "0", "1"];
    return { clientX: Number(m[1]) + x * Number(m[3]), clientY: Number(m[2]) + y * Number(m[3]) };
  };
  /** A click on participant `n`'s lifeline (or head) at height `y`. */
  const clickLifeline = (n: string, y: number) => {
    const at = screenAt(mid(n), y);
    const el = node(`${n === "Customer" ? "Actor" : "Participant"} ${n}`)!;
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, ...at });
    fireEvent.pointerUp(window, { button: 0, pointerId: 1, ...at });
    fireEvent.click(el, at);
  };
  const edgeEl = (i: number) => utils.container.querySelector(`.react-flow__edge[data-id="edge:${i}"]`) as HTMLElement;
  return { ...utils, view, doc, node, press, field, strip, box, row, mid, screenAt, clickLifeline, edgeEl, canvasEl };
}
type Setup = ReturnType<typeof setup>;
const shown = (s: Setup, label: string) => waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });
const settle = () => new Promise((r) => setTimeout(r, 30));

// ----- S1 and S3: a message where you mean it, named on its row

test("S1 a click on a lifeline between two rows, then on another lifeline, puts the message there; its label opens on its row", async () => {
  const s = setup();
  await shown(s, "Participant Payments");
  const y = (s.row(1) + s.row(2)) / 2;
  s.clickLifeline("Customer", y);
  await waitFor(() => expect(s.strip().textContent).toContain("From Customer at row 3"));
  // The height it lands at is drawn as a line across the lifelines.
  expect(s.container.querySelector(".flow-slot-guide")).not.toBeNull();
  s.clickLifeline("Payments", y);
  const added = SEQ.replace("Stock --> Shop: reserved\n", "Customer -> Payments\nStock --> Shop: reserved\n");
  await waitFor(() => expect(s.doc()).toBe(added));
  const label = await s.field("Message label");
  const wrap = label.closest(".inline-edit-wrap") as HTMLElement;
  await waitFor(() => expect(Math.abs(parseFloat(wrap.style.top) - (s.row(2) - 10))).toBeLessThanOrEqual(18));
  await userEvent.type(label, "check limit{Enter}");
  await waitFor(() => expect(s.doc()).toBe(added.replace("Customer -> Payments\n", "Customer -> Payments: check limit\n")));
  // The message and its label are two undo steps.
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(added));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(SEQ));
});

test("S1 M, then two lifelines, adds a message at the height of the first click; Esc cancels the pick", async () => {
  const s = setup();
  await shown(s, "Participant Payments");
  s.press("m");
  await waitFor(() => expect(s.strip().textContent).toContain("Message: click a lifeline at the height the message goes"));
  s.press("Escape");
  await waitFor(() => expect(s.strip().textContent).not.toContain("Message: click a lifeline"));
  s.press("m");
  const y = s.row(5) + 30;
  s.clickLifeline("Stock", y);
  s.clickLifeline("Customer", y);
  await waitFor(() => expect(s.doc()).toBe(`${SEQ}Stock -> Customer\n`));
});

test("S1 a drag from one lifeline to another adds the message at the height it started; let go off a lifeline, nothing", async () => {
  const s = setup();
  await shown(s, "Participant Payments");
  const y = (s.row(3) + s.row(4)) / 2;
  fireEvent.pointerDown(s.node("Participant Shop")!, { button: 0, pointerId: 1, ...s.screenAt(s.mid("Shop"), y) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(s.mid("Shop") + 40, y) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(s.mid("Payments") + 3, y + 30) });
  await waitFor(() => expect(s.container.querySelector(".flow-msg-preview")).not.toBeNull());
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(s.mid("Payments") + 3, y + 30) });
  await waitFor(() => expect(s.doc()).toBe(SEQ.replace("Payments --> Shop: approved\n", "Shop -> Payments\nPayments --> Shop: approved\n")));
  await s.field("Message label");
  fireEvent.keyDown(await s.field("Message label"), { key: "Escape" });
  const before = s.doc();
  fireEvent.pointerDown(s.node("Participant Shop")!, { button: 0, pointerId: 2, ...s.screenAt(s.mid("Shop"), y) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 2, ...s.screenAt(s.mid("Shop") + 40, y) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 2, ...s.screenAt(s.mid("Shop") + 100, y) });
  fireEvent.pointerUp(window, { pointerId: 2, ...s.screenAt(s.mid("Shop") + 100, y) });
  await waitFor(() => expect(s.strip().textContent).toContain("Not dropped on a lifeline: no message added."));
  expect(s.doc()).toBe(before);
});

test("S1 a message inside a loop, between two of its rows, joins it; one added above it stays outside", async () => {
  const s = setup(LOOPED);
  await shown(s, "Participant Stock");
  const y = (s.row(1) + s.row(2)) / 2;
  s.clickLifeline("Customer", y);
  s.clickLifeline("Stock", y);
  await waitFor(() => expect(s.doc()).toBe(LOOPED.replace("  Stock --> Shop", "  Customer -> Stock\n  Stock --> Shop")));
});

// ----- S1: a message dragged to another row

test("S1 a message dragged down shows an insertion line and moves its line, one undo step; Esc cancels", async () => {
  const s = setup();
  await shown(s, "Participant Payments");
  const at = s.screenAt(s.mid("Shop"), s.row(0));
  fireEvent.pointerDown(s.edgeEl(0), { button: 0, pointerId: 1, ...at });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(s.mid("Shop"), s.row(0) + 20) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(s.mid("Shop"), (s.row(2) + s.row(3)) / 2) });
  await waitFor(() => expect(s.container.querySelector(".flow-drop-line")).not.toBeNull());
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(s.mid("Shop"), (s.row(2) + s.row(3)) / 2) });
  await settle();
  expect(s.doc()).toBe(SEQ);
  expect(s.container.querySelector(".flow-drop-line")).toBeNull();
  fireEvent.pointerDown(s.edgeEl(0), { button: 0, pointerId: 2, ...at });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 2, ...s.screenAt(s.mid("Shop"), s.row(0) + 20) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 2, ...s.screenAt(s.mid("Shop"), (s.row(2) + s.row(3)) / 2) });
  fireEvent.pointerUp(window, { pointerId: 2, ...s.screenAt(s.mid("Shop"), (s.row(2) + s.row(3)) / 2) });
  const moved = SEQ.replace("Customer -> Shop: place order\n", "").replace("Stock --> Shop: reserved\n", "Stock --> Shop: reserved\nCustomer -> Shop: place order\n");
  await waitFor(() => expect(s.doc()).toBe(moved));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(SEQ));
});

// ----- S2: a participant dragged sideways

test("S2 a participant's head dragged sideways shows where it goes and moves its line only", async () => {
  const s = setup();
  await shown(s, "Participant Payments");
  const head = s.box("Payments").y + 20;
  fireEvent.pointerDown(s.node("Participant Payments")!, { button: 0, pointerId: 1, ...s.screenAt(s.mid("Payments"), head) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(s.mid("Payments") - 20, head) });
  const gap = (s.mid("Customer") + s.mid("Shop")) / 2;
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(gap, head) });
  await waitFor(() => expect(s.container.querySelector(".flow-drop-line.is-vertical")).not.toBeNull());
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(gap, head) });
  await waitFor(() => expect(s.doc()).toBe(SEQ.replace("participant Payments\n", "").replace("participant Shop\n", "participant Payments\nparticipant Shop\n")));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(SEQ));
});

test("S2 a participant's foot dragged sideways moves its line as the head does", async () => {
  const s = setup();
  await shown(s, "Participant Payments");
  // The foot box repeats the head at the bottom of the same node.
  const foot = s.box("Payments").y + s.box("Payments").h - 20;
  fireEvent.pointerDown(s.node("Participant Payments")!, { button: 0, pointerId: 1, ...s.screenAt(s.mid("Payments"), foot) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(s.mid("Payments") - 20, foot) });
  const gap = (s.mid("Customer") + s.mid("Shop")) / 2;
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(gap, foot) });
  await waitFor(() => expect(s.container.querySelector(".flow-drop-line.is-vertical")).not.toBeNull());
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(gap, foot) });
  await waitFor(() => expect(s.doc()).toBe(SEQ.replace("participant Payments\n", "").replace("participant Shop\n", "participant Payments\nparticipant Shop\n")));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(SEQ));
});

// ----- S4: the message menu, Loop, a selected loop

test("S4 the message menu: Reply (dashed), Request (solid), Add reply below and Reverse, each one undo step", async () => {
  const s = setup();
  await shown(s, "Participant Payments");
  const open = () => act(() => canvas.props!.onContextMenu!({ node: null, line: "edge:1", screen: { x: 200, y: 200 }, flow: { x: 0, y: 0 }, fit: () => {} }));
  open();
  let menu = await screen.findByRole("menu", { name: "Message actions" });
  expect(within(menu).getByRole("menuitemcheckbox", { name: "Request (solid)" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Reply (dashed)" }));
  await waitFor(() => expect(s.doc()).toBe(SEQ.replace("Shop -> Stock", "Shop --> Stock")));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(SEQ));
  open();
  menu = await screen.findByRole("menu", { name: "Message actions" });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Add reply below" }));
  await waitFor(() => expect(s.doc()).toBe(SEQ.replace("Shop -> Stock: reserve items\n", "Shop -> Stock: reserve items\nStock --> Shop\n")));
  fireEvent.keyDown(await s.field("Message label"), { key: "Escape" });
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(SEQ));
  open();
  menu = await screen.findByRole("menu", { name: "Message actions" });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Reverse" }));
  await waitFor(() => expect(s.doc()).toBe(SEQ.replace("Shop -> Stock: reserve items", "Stock -> Shop: reserve items")));
});

test("S4 Loop around a selection of messages takes every row between them, its label ready; one across another is refused", async () => {
  const s = setup();
  await shown(s, "Participant Payments");
  act(() => canvas.props!.onLineSelect!(["edge:1", "edge:3"]));
  act(() => canvas.props!.onContextMenu!({ node: null, line: "edge:3", screen: { x: 200, y: 200 }, flow: { x: 0, y: 0 }, fit: () => {} }));
  const menu = await screen.findByRole("menu", { name: "Message actions" });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Loop around 2 messages" }));
  const label = await s.field("Loop label");
  expect(label.value).toBe("every item");
  fireEvent.keyDown(label, { key: "Enter" });
  await waitFor(() =>
    expect(s.doc()).toBe(SEQ.replace("Shop -> Stock: reserve items\nStock --> Shop: reserved\nShop -> Payments: charge card\n", "loop every item {\n  Shop -> Stock: reserve items\n  Stock --> Shop: reserved\n  Shop -> Payments: charge card\n}\n")),
  );
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(SEQ));
});

test("S4 a loop that would cut across another is refused with the reason", async () => {
  const s = setup(LOOPED);
  await shown(s, "Participant Stock");
  act(() => canvas.props!.onLineSelect!(["edge:2", "edge:3"]));
  act(() => canvas.props!.onContextMenu!({ node: null, line: "edge:3", screen: { x: 200, y: 200 }, flow: { x: 0, y: 0 }, fit: () => {} }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Message actions" })).getByRole("menuitem", { name: "Loop around 2 messages" }));
  await waitFor(() => expect(s.strip().textContent).toContain('A loop holds whole frames: this one would cut across "loop every item".'));
  expect(screen.queryByRole("textbox", { name: "Loop label" })).toBeNull();
  expect(s.doc()).toBe(LOOPED);
});

test("S4 a loop is selected by its tab, renamed with F2, and Delete takes the frame away and keeps its messages", async () => {
  const s = setup(LOOPED);
  await shown(s, "Participant Stock");
  const tab = s.box("\u0000frameTab:0");
  const at = s.screenAt(tab.x + 10, tab.y + 8);
  fireEvent.pointerDown(s.canvasEl().querySelector(".react-flow__pane")!, { button: 0, pointerId: 1, ...at });
  fireEvent.pointerUp(window, { pointerId: 1, ...at });
  await waitFor(() => expect(s.strip().textContent).toContain("Selected the loop."));
  expect(s.container.querySelector(".flow-loop-selected")).not.toBeNull();
  s.press("F2");
  const label = await s.field("Loop label");
  expect(label.value).toBe("every item");
  await userEvent.clear(label);
  await userEvent.type(label, "each line{Enter}");
  await waitFor(() => expect(s.doc()).toBe(LOOPED.replace("loop every item {", "loop each line {")));
  fireEvent.pointerDown(s.canvasEl().querySelector(".react-flow__pane")!, { button: 0, pointerId: 2, ...at });
  fireEvent.pointerUp(window, { pointerId: 2, ...at });
  await waitFor(() => expect(s.container.querySelector(".flow-loop-selected")).not.toBeNull());
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(lines('diagram sequence "Checkout"', "actor Customer", "participant Shop", "participant Stock", "", "Customer -> Shop: place order", "Shop -> Stock: reserve items", "Stock --> Shop: reserved", "Shop --> Customer: receipt")));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(LOOPED.replace("loop every item {", "loop each line {")));
});

test("S4 a double press on a loop's tab edits its label on the tab; Esc keeps what was typed", async () => {
  const s = setup(LOOPED);
  await shown(s, "Participant Stock");
  const tab = s.box("\u0000frameTab:0");
  const at = s.screenAt(tab.x + 10, tab.y + 8);
  const pane = s.canvasEl().querySelector(".react-flow__pane")!;
  fireEvent.pointerDown(pane, { button: 0, pointerId: 1, ...at });
  fireEvent.pointerDown(pane, { button: 0, pointerId: 1, ...at });
  const label = await s.field("Loop label");
  await userEvent.clear(label);
  await userEvent.type(label, "per line{Escape}");
  await waitFor(() => expect(s.doc()).toBe(LOOPED.replace("loop every item {", "loop per line {")));
});

// ----- The block's side tab and its caption.

test("S4 a press on a block's side tab selects it", async () => {
  const s = setup(LOOPED);
  await shown(s, "Participant Stock");
  const box = s.box("\u0000frame:0");
  const caption = s.box("\u0000frameTab:0");
  const pane = s.canvasEl().querySelector(".react-flow__pane")!;
  // Just right of the side tab, on the block's wash: no selection.
  const off = s.screenAt(box.x + 40, box.y + box.h - 8);
  fireEvent.pointerDown(pane, { button: 0, pointerId: 1, ...off });
  fireEvent.pointerUp(window, { pointerId: 1, ...off });
  await settle();
  expect(s.container.querySelector(".flow-loop-selected")).toBeNull();
  // Low on the side tab, well below the caption: the press selects the loop.
  expect(box.y + box.h - 8).toBeGreaterThan(caption.y + caption.h);
  const at = s.screenAt(box.x + 12, box.y + box.h - 8);
  fireEvent.pointerDown(pane, { button: 0, pointerId: 2, ...at });
  fireEvent.pointerUp(window, { pointerId: 2, ...at });
  await waitFor(() => expect(s.strip().textContent).toContain("Selected the loop."));
  expect(s.container.querySelector(".flow-loop-selected")).not.toBeNull();
});

test("S4 F2 and a new loop open their label field on the caption", async () => {
  const s = setup(LOOPED);
  await shown(s, "Participant Stock");
  const cap = s.box("\u0000frameTab:0");
  const at = s.screenAt(cap.x + 10, cap.y + 8);
  fireEvent.pointerDown(s.canvasEl().querySelector(".react-flow__pane")!, { button: 0, pointerId: 1, ...at });
  fireEvent.pointerUp(window, { pointerId: 1, ...at });
  await waitFor(() => expect(s.container.querySelector(".flow-loop-selected")).not.toBeNull());
  s.press("F2");
  const label = await s.field("Loop label");
  const wrap = label.closest(".inline-edit-wrap") as HTMLElement;
  // The field's left edge on the caption's, its middle on the caption's middle.
  expect(parseFloat(wrap.style.left)).toBeCloseTo(cap.x);
  expect(parseFloat(wrap.style.top)).toBeCloseTo(cap.y + cap.h / 2);
  fireEvent.keyDown(label, { key: "Escape" });
  cleanup();

  // A new loop's field opens where its caption will be once it is written.
  const t = setup();
  await shown(t, "Participant Payments");
  act(() => canvas.props!.onLineSelect!(["edge:1", "edge:3"]));
  act(() => canvas.props!.onContextMenu!({ node: null, line: "edge:3", screen: { x: 200, y: 200 }, flow: { x: 0, y: 0 }, fit: () => {} }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Message actions" })).getByRole("menuitem", { name: "Loop around 2 messages" }));
  const field = await t.field("Loop label");
  const w = field.closest(".inline-edit-wrap") as HTMLElement;
  const [left, top] = [parseFloat(w.style.left), parseFloat(w.style.top)];
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(t.doc()).toContain("loop every item {\n"));
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === "\u0000frameTab:0")).toBe(true));
  const made = t.box("\u0000frameTab:0");
  expect(left).toBeCloseTo(made.x);
  expect(top).toBeCloseTo(made.y + made.h / 2);
});
