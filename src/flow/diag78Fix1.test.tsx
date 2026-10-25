// Diagram build 3, fix round 1 (diag-78-build-review.md): the canvas findings I1 to I4, the board gaps (the ghost's
// size, two participants kept, the faded message, the drag status lines) and the minors M2, M3, M8 to M13.
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

const MAP = lines(
  'diagram mindmap "Q4 plan"',
  "root Q4 plan",
  "  Diagrams",
  "    New kinds",
  "    Inline editing",
  "  Redis",
  "    Pub/Sub",
  "    Key browser",
  "  Release",
  "    Docs",
  "    Installer",
  "  Servers",
  "",
  "Installer > Servers",
);

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

function setup(initial: string) {
  routeInvoke({ read_diagram: () => ({ text: initial, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="d78f" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const field = (label: string) => screen.findByRole("textbox", { name: label }) as Promise<HTMLInputElement>;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const select = (n: string) => act(() => canvas.props!.onSelect!([n]));
  const box = (n: string) => {
    const g = canvas.props!.nodes.find((x) => x.id === n)!;
    return { x: g.position.x, y: g.position.y, w: g.initialWidth ?? 0, h: g.initialHeight ?? 0 };
  };
  const row = (i: number) => (canvas.props!.edges.find((e) => e.id === `edge:${i}`)!.data as { y: number }).y;
  const mid = (n: string) => box(n).x + box(n).w / 2;
  const screenAt = (x: number, y: number) => {
    const t = (utils.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
    const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(t) ?? ["", "0", "0", "1"];
    return { clientX: Number(m[1]) + x * Number(m[3]), clientY: Number(m[2]) + y * Number(m[3]) };
  };
  const edgeEl = (i: number) => utils.container.querySelector(`.react-flow__edge[data-id="edge:${i}"]`) as HTMLElement;
  return { ...utils, view, doc, node, press, field, strip, select, box, row, mid, screenAt, edgeEl, canvasEl };
}
type Setup = ReturnType<typeof setup>;
const shown = (s: Setup, label: string) => waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });
const settle = () => new Promise((r) => setTimeout(r, 30));
const held = { buttons: 1, pointerId: 1 };

/** Starts dragging topic `from` and moves it to flow point `to`, the button held. */
function dragTopic(s: Setup, from: string, to: { x: number; y: number }) {
  const b = s.box(from);
  const start = s.screenAt(b.x + b.w / 2, b.y + b.h / 2);
  fireEvent.pointerDown(s.node(`Topic ${from}`)!, { button: 0, pointerId: 1, ...start });
  fireEvent.pointerMove(window, { ...held, clientX: start.clientX + 10, clientY: start.clientY + 10 });
  fireEvent.pointerMove(window, { ...held, ...s.screenAt(to.x, to.y) });
}

// ----- Important

test("I1 a last sibling dragged just below itself stays where it is", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Installer");
  const b = s.box("Installer");
  dragTopic(s, "Installer", { x: b.x + b.w / 2, y: b.y + b.h + 10 });
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(b.x + b.w / 2, b.y + b.h + 10) });
  await settle();
  expect(s.doc()).toBe(MAP);
});

test("I3 a chained message dragged to another row is refused, and the strip says why", async () => {
  const text = lines('diagram sequence "s"', "participant A", "participant B", "participant C", "A -> B -> C", "C -> A: back");
  const s = setup(text);
  await shown(s, "Participant C");
  const at = s.screenAt(s.mid("B"), s.row(1));
  fireEvent.pointerDown(s.edgeEl(1), { button: 0, pointerId: 1, ...at });
  fireEvent.pointerMove(window, { ...held, ...s.screenAt(s.mid("B"), s.row(1) + 20) });
  fireEvent.pointerMove(window, { ...held, ...s.screenAt(s.mid("B"), s.row(2) + 30) });
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(s.mid("B"), s.row(2) + 30) });
  await waitFor(() => expect(s.strip().textContent).toContain("This message shares its line with others (A -> B -> C)."));
  expect(s.doc()).toBe(text);
});

// ----- Board gaps

test("the ghost is the size of the topic it will be, and grows while the name is typed", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  s.select("Redis");
  s.press("Tab");
  const name = await s.field("Name the new topic");
  const ghost = () => canvas.props!.nodes.find((n) => n.id === "\u0000ghost")!;
  // A subtopic, the size Key browser's level draws at.
  expect(ghost().initialHeight).toBe(s.box("Key browser").h);
  const w0 = ghost().initialWidth!;
  // Round 2, N5: typing measures the ghost alone; the map is not laid out again for each key.
  const drawing = canvas.props!.nodes;
  const shape = () => s.container.querySelector(".flow-ghost-topic") as HTMLElement;
  await userEvent.clear(name);
  await userEvent.type(name, "A much longer subtopic name");
  await waitFor(() => expect(parseFloat(shape().style.width)).toBeGreaterThan(w0));
  expect(canvas.props!.nodes).toBe(drawing);
});

test("a sequence keeps at least two participants", async () => {
  const text = lines('diagram sequence "s"', "participant A", "participant B", "A -> B");
  const s = setup(text);
  await shown(s, "Participant B");
  s.select("B");
  s.press("Delete");
  await waitFor(() => expect(s.strip().textContent).toContain("A sequence keeps at least two participants."));
  await settle();
  expect(s.doc()).toBe(text);
});

test("a dragged message is drawn faded, and each drag says in the strip where it lands", async () => {
  const s = setup(SEQ);
  await shown(s, "Participant Payments");
  fireEvent.pointerDown(s.edgeEl(0), { button: 0, pointerId: 1, ...s.screenAt(s.mid("Shop"), s.row(0)) });
  fireEvent.pointerMove(window, { ...held, ...s.screenAt(s.mid("Shop"), s.row(0) + 20) });
  fireEvent.pointerMove(window, { ...held, ...s.screenAt(s.mid("Shop"), (s.row(2) + s.row(3)) / 2) });
  await waitFor(() => expect(s.strip().textContent).toContain("Release to put it on the line shown, as row 3."));
  expect(s.edgeEl(0).classList.contains("is-drag-source")).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(s.edgeEl(0).classList.contains("is-drag-source")).toBe(false));
  // A participant.
  const head = s.box("Payments").y + 20;
  fireEvent.pointerDown(s.node("Participant Payments")!, { button: 0, pointerId: 2, ...s.screenAt(s.mid("Payments"), head) });
  fireEvent.pointerMove(window, { ...held, ...s.screenAt(s.mid("Payments") - 20, head) });
  fireEvent.pointerMove(window, { ...held, ...s.screenAt((s.mid("Customer") + s.mid("Shop")) / 2, head) });
  await waitFor(() => expect(s.strip().textContent).toContain("Release to put Payments on the line shown."));
  fireEvent.keyDown(window, { key: "Escape" });
  // A new message drawn between lifelines.
  const y = (s.row(3) + s.row(4)) / 2;
  fireEvent.pointerDown(s.node("Participant Shop")!, { button: 0, pointerId: 3, ...s.screenAt(s.mid("Shop"), y) });
  fireEvent.pointerMove(window, { ...held, ...s.screenAt(s.mid("Shop") + 40, y) });
  await waitFor(() => expect(s.strip().textContent).toContain("Drag to another lifeline. The message lands on the line shown."));
  fireEvent.pointerMove(window, { ...held, ...s.screenAt(s.mid("Payments"), y) });
  await waitFor(() => expect(s.strip().textContent).toContain("Release on Payments: the message lands at row 5, on the line shown."));
  fireEvent.keyDown(window, { key: "Escape" });
});

test("a topic drag says in the strip where it lands", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  const t = s.box("Release");
  dragTopic(s, "Redis", { x: t.x + t.w / 2, y: t.y + t.h / 2 });
  await waitFor(() => expect(s.strip().textContent).toContain("Drop: subtopic of Release. Release to move it with its subtopics; Esc cancels."));
  fireEvent.keyDown(window, { key: "Escape" });
});

// ----- Minors

test("M2 the message menu acts on the message it opened on, even after the text changed", async () => {
  const s = setup(SEQ);
  await shown(s, "Participant Payments");
  act(() => canvas.props!.onContextMenu!({ node: null, line: "edge:1", screen: { x: 200, y: 200 }, flow: { x: 0, y: 0 }, fit: () => {} }));
  const menu = await screen.findByRole("menu", { name: "Message actions" });
  // A message typed in above it, while the menu is open.
  const at = s.doc().indexOf("Customer -> Shop");
  act(() => s.view().dispatch({ changes: { from: at, insert: "Customer -> Stock: peek\n" } }));
  await settle();
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Reverse" }));
  await waitFor(() => expect(s.doc()).toBe(SEQ.replace("Customer -> Shop", "Customer -> Stock: peek\nCustomer -> Shop").replace("Shop -> Stock: reserve items", "Stock -> Shop: reserve items")));
});

test("M3 focus stays on the canvas after a fold dot is clicked", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  s.select("Redis");
  fireEvent.click(await screen.findByRole("button", { name: "Fold Redis" }));
  await waitFor(() => expect(document.activeElement).toBe(s.canvasEl()));
});

test("M9 a frame is named by its kind: an opt frame is selected, labelled and removed as an option", async () => {
  const text = lines('diagram sequence "s"', "participant A", "participant B", "A -> B: one", "opt {", "  B -> A: two", "}");
  const s = setup(text);
  await shown(s, "Participant B");
  const tab = s.box("\u0000frameTab:0");
  const at = s.screenAt(tab.x + 10, tab.y + 8);
  fireEvent.pointerDown(s.canvasEl().querySelector(".react-flow__pane")!, { button: 0, pointerId: 1, ...at });
  await waitFor(() => expect(s.strip().textContent).toContain("Selected the opt frame."));
  s.press("F2");
  fireEvent.keyDown(await s.field("Opt label"), { key: "Escape" });
  await settle();
  fireEvent.pointerDown(s.canvasEl().querySelector(".react-flow__pane")!, { button: 0, pointerId: 2, ...at });
  await settle();
  fireEvent.pointerDown(s.canvasEl().querySelector(".react-flow__pane")!, { button: 0, pointerId: 3, ...s.screenAt(-900, -900) });
  fireEvent.pointerDown(s.canvasEl().querySelector(".react-flow__pane")!, { button: 0, pointerId: 4, ...at });
  await waitFor(() => expect(s.container.querySelector(".flow-loop-selected")).not.toBeNull());
  s.press("Delete");
  await waitFor(() => expect(s.strip().textContent).toContain("Removed the opt frame; its messages stay."));
});

test("M10 the new topic's field stays where it was when the topic it was added to goes from the text", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  s.select("Redis");
  s.press("Tab");
  const name = await s.field("Name the new topic");
  const wrap = () => name.closest(".inline-edit-wrap") as HTMLElement;
  const before = [wrap().style.left, wrap().style.top];
  const from = s.doc().indexOf("  Redis\n");
  act(() => s.view().dispatch({ changes: { from, to: from + "  Redis\n    Pub/Sub\n    Key browser\n".length, insert: "" } }));
  await waitFor(() => expect(s.node("Topic Pub/Sub")).toBeNull());
  expect([wrap().style.left, wrap().style.top]).toEqual(before);
});

test("M11 Tab leaves the canvas when no topic is selected", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  expect(fireEvent.keyDown(s.canvasEl(), { key: "Tab" })).toBe(true);
});

test("M12 a press on a loop's tab or a lifeline gives the canvas focus", async () => {
  const text = lines('diagram sequence "s"', "participant A", "participant B", "A -> B: one", "loop again {", "  B -> A: two", "}");
  const s = setup(text);
  await shown(s, "Participant B");
  s.view().focus();
  const tab = s.box("\u0000frameTab:0");
  fireEvent.pointerDown(s.canvasEl().querySelector(".react-flow__pane")!, { button: 0, pointerId: 1, ...s.screenAt(tab.x + 10, tab.y + 8) });
  await waitFor(() => expect(document.activeElement).toBe(s.canvasEl()));
  s.view().focus();
  fireEvent.pointerDown(s.node("Participant B")!, { button: 0, pointerId: 2, ...s.screenAt(s.mid("B"), s.row(0) + 30) });
  await waitFor(() => expect(document.activeElement).toBe(s.canvasEl()));
});

test("M13 a drag ends with nothing written when the button was let go out of sight", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  const t = s.box("Release");
  dragTopic(s, "Redis", { x: t.x + t.w / 2, y: t.y + t.h / 2 });
  await waitFor(() => expect(s.container.querySelector(".flow-drop-tag")).not.toBeNull());
  // The next move comes with no button down: the release happened outside the window.
  fireEvent.pointerMove(window, { buttons: 0, pointerId: 1, ...s.screenAt(t.x + t.w / 2, t.y + t.h / 2) });
  await waitFor(() => expect(s.container.querySelector(".flow-drop-tag")).toBeNull());
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(t.x + t.w / 2, t.y + t.h / 2) });
  await settle();
  expect(s.doc()).toBe(MAP);
});

test("M8 Delete fades the subtopics that go and not the central idea that stays", async () => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  try {
    const s = setup(MAP);
    await shown(s, "Topic Redis");
    act(() => canvas.props!.onSelect!(["Q4 plan", "Redis"]));
    s.press("Delete");
    await waitFor(() => expect(s.node("Topic Pub/Sub")?.querySelector(".fnode-leaving")).toBeTruthy());
    expect(s.node("Central idea Q4 plan")!.querySelector(".fnode-leaving")).toBeNull();
    // The topic and its subtopics go; the central idea stays.
    await waitFor(() => expect(s.doc()).toBe(MAP.replace("  Redis\n    Pub/Sub\n    Key browser\n", "")));
  } finally {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  }
});
