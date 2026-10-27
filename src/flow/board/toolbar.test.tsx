// Task 7: the top toolbar, its letter keys, Space (tap and hold) and the add menu (Decisions 18, 19, 24, 25, 26).
// B2 Task 11: a Space tap opens the Space box (B2 decision 19), not B1's kind menu.
// React Flow's panning cannot be driven in jsdom (D3): the pan tests assert the pane's props and the menu state; the
// real pan is Task 18's live check.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { DIAGRAM_KINDS, type DiagramKind } from "../../lang/flow/model";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import { CARDS } from "../diagramKinds";
import FlowTab from "../FlowTab";
import { ADD_TOOLS } from "../FlowToolbar";
import dialogSource from "../NewDiagramDialog.tsx?raw";
import { shapesOf } from "../ShapePicker";
import BoardToolbar from "./BoardToolbar";
import DiagramsTab from "./shelf/DiagramsTab";
import { boardFrameId } from "./boardScene";
import { SHELF_KINDS } from "./catalog/kinds";
import { KIND_HEAD } from "./chips";
import { GENERIC_TOOLS, KIND_TOOLS, keyOfShape, SPACE_TAP_MS } from "./kindTools";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

// What the canvas hands React Flow is its pan model; jsdom cannot drag the pane, so the props are the proof (D3).
const flow = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@xyflow/react", async (orig) => {
  const m = await orig<typeof import("@xyflow/react")>();
  const Real = m.ReactFlow;
  return {
    ...m,
    ReactFlow: (p: Record<string, unknown>) => {
      flow.props = p;
      return <Real {...(p as object)} />;
    },
  };
});
const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      return real.default({
        ...p,
        onInit: (i) => {
          canvas.instance = i;
          p.onInit?.(i);
        },
      });
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
  vi.restoreAllMocks();
  canvas.props = null;
  canvas.instance = null;
  flow.props = null;
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\n';
const BOARD = [CHECKOUT, REFUND, SHIPPING].join("\n");
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Refund: { at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Shipping: { at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
  },
  sketches: [],
});

function setup(text = BOARD, layout: string | null = LAYOUT) {
  const saved = { text, layout };
  routeInvoke({
    read_diagram: () => saved,
    write_diagram: (a) => {
      saved.text = a.text as string;
      saved.layout = a.layout as string;
      return null;
    },
    write_diagram_layout: (a) => {
      saved.layout = a.layout as string;
      return null;
    },
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>,
  );
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const pane = () => utils.container.querySelector(".react-flow__pane") as HTMLElement;
  const bar = () => screen.getByRole("toolbar", { name: "Board tools" });
  const tool = (name: string) => within(bar()).getByRole("button", { name });
  const pressed = () => within(bar()).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"));
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  return { ...utils, saved, canvasEl, pane, bar, tool, pressed, press };
}

/** The board drawn with its frames' tabs and the canvas's instance. */
async function opened(titles = ["Checkout", "Refund", "Shipping"]) {
  for (const t of titles) await screen.findByRole("button", { name: `Flowchart ${t}` });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

/** A one-frame flowchart board: its frame opens selected, with its shapes live. */
async function oneFrame() {
  const s = setup(CHECKOUT, null);
  await opened(["Checkout"]);
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === "Cart")).toBe(true));
  await waitFor(() => expect(within(s.bar()).queryByRole("button", { name: "Step" })).not.toBeNull());
  return s;
}

/** Date.now under the test's hand, for Space's tap timing. */
function clock() {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return (ms: number) => {
    now += ms;
  };
}

const names = (el: HTMLElement) => within(el).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
const noop = () => {};

test("nothing_selected_shows_the_drawing_tools", async () => {
  const { container } = render(<BoardToolbar kind={null} armed="select" pending={0} onArm={noop} onAdd={noop} onAsk={noop} onMoreShapes={noop} />);
  const bar = screen.getByRole("toolbar", { name: "Board tools" });
  expect(names(bar)).toEqual(["Select", "Hand", "Rectangle", "Ellipse", "Diamond", "Arrow", "Line", "Pen", "Text", "Section", "Note", "Add", "Ask"]);
  // Each icon tool shows its key in the corner, hidden from a screen reader, and a hint with its name and key.
  const rect = within(bar).getByRole("button", { name: "Rectangle" });
  expect(rect.getAttribute("aria-keyshortcuts")).toBe("R");
  expect(rect.querySelector(".board-tool-key")?.textContent).toBe("R");
  expect(rect.querySelector(".board-tool-key")?.getAttribute("aria-hidden")).toBe("true");
  expect(rect.querySelector(".flow-hint")?.textContent).toBe("RectangleR");
  expect(within(bar).getByRole("button", { name: "Select" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(bar).getByRole("button", { name: "Add" }).getAttribute("aria-keyshortcuts")).toBe("/");
  expect(within(bar).getByRole("button", { name: "Add" }).textContent).toContain("Add");
  expect(within(bar).getByRole("button", { name: "Ask" }).getAttribute("aria-keyshortcuts")).toBe("Control+J");
  expect(within(bar).getByRole("button", { name: "Section" }).getAttribute("aria-keyshortcuts")).toBe("F");
  expect(container.querySelector(".board-ask-count")).toBeNull();
  cleanup();
  // The assistant's changes waiting for review are counted on Ask.
  render(<BoardToolbar kind={null} armed="select" pending={3} onArm={noop} onAdd={noop} onAsk={noop} onMoreShapes={noop} />);
  expect(screen.getByRole("button", { name: "Ask" }).querySelector(".board-ask-count")?.textContent).toBe("3");
  expect(screen.getByRole("button", { name: "Ask" }).getAttribute("aria-description")).toBe("3 changes to review");

  // On the canvas: a board with nothing selected shows the drawing tools, and today's add tools are gone.
  cleanup();
  const s = setup();
  await opened();
  expect(names(s.bar())).toEqual(["Select", "Hand", "Rectangle", "Ellipse", "Diamond", "Arrow", "Line", "Pen", "Text", "Section", "Note", "Add", "Ask"]);
  expect(screen.queryByRole("button", { name: "Add step" })).toBeNull();
});

test("a_selected_frame_shows_its_kind_tools", () => {
  const bar = (kind: DiagramKind) => {
    cleanup();
    render(<BoardToolbar kind={kind} armed="select" pending={0} onArm={noop} onAdd={noop} onAsk={noop} onMoreShapes={noop} />);
    return screen.getByRole("toolbar", { name: "Board tools" });
  };
  const flowBar = bar("flow");
  expect(names(flowBar)).toEqual(["Select", "Hand", "Start or end", "Step", "Decision", "Input or output", "Arrow", "Group", "Section", "Note", "More shapes", "Add", "Ask"]);
  expect(within(flowBar).getAllByRole("button").map((b) => b.getAttribute("aria-keyshortcuts"))).toEqual(["V", "H", "O", "R", "D", "P", "A", "G", "F", "N", null, "/", "Control+J"]);
  expect(names(bar("er"))).toEqual(["Select", "Hand", "Table", "Column", "Relationship", "Section", "Note", "More shapes", "Add", "Ask"]);
  // Block (G) is the sequence's loop, not a group, so NO_GROUPS.sequence does not hide it (C13).
  const seq = bar("sequence");
  expect(names(seq)).toEqual(["Select", "Hand", "Participant", "Message", "Reply", "Block", "Section", "Note", "More shapes", "Add", "Ask"]);
  expect(within(seq).getByRole("button", { name: "Block" }).getAttribute("aria-keyshortcuts")).toBe("G");
  // Group shows only where the kind has groups.
  for (const kind of ["class", "mindmap", "timeline"] as const) expect(within(bar(kind)).queryByRole("button", { name: "Group" })).toBeNull();
  expect(names(bar("state"))).toEqual(["Select", "Hand", "State", "Choice", "Fork", "Arrow", "Group", "Section", "Note", "More shapes", "Add", "Ask"]);
});

test("kind_tools_carry_picker_shapes", () => {
  for (const kind of DIAGRAM_KINDS) {
    const shapes = shapesOf(kind);
    expect(KIND_TOOLS[kind].length).toBeGreaterThan(0);
    for (const t of KIND_TOOLS[kind]) expect(shapes.some((sh) => sh.label === t.shape.label && sh.act.kind === t.shape.act.kind && sh.code === t.shape.code)).toBe(true);
  }
  // ER adds a table through its add tool (runShape reads sh.tool), and a line tool carries its label for the prompts.
  const table = KIND_TOOLS.er.find((t) => t.name === "Table")!;
  expect(table.shape.tool).toBeDefined();
  expect(table.shape.tool!.kind).toBe("entity");
  expect(KIND_TOOLS.flow.find((t) => t.name === "Arrow")!.shape.act).toEqual({ kind: "line", arrow: ">" });
  expect(KIND_TOOLS.sequence.find((t) => t.name === "Block")!.shape.act).toEqual({ kind: "loop" });
});

test("kind_names_have_one_source", () => {
  render(<DiagramsTab query="" active registerKeys={noop} add={noop} beginDrag={noop} frameKind={null} />);
  const cards = within(screen.getByRole("listbox", { name: "Diagrams" })).getAllByRole("option");
  expect(cards.map((c) => c.querySelector(".flow-shelf-card-name")?.textContent)).toEqual(SHELF_KINDS.map((k) => KIND_HEAD[k].name));
  // KIND_HEAD reads CARDS: one source of kind names.
  for (const k of DIAGRAM_KINDS) expect(KIND_HEAD[k]).toEqual({ name: CARDS[k].title, line: CARDS[k].text });
  // The New diagram dialog lists no kinds of its own: the Shelf's Diagrams tab does, from diagramKinds.ts.
  expect(dialogSource).not.toMatch(/\bDIAGRAM_KINDS\b|\bCARDS\b|\bKINDS\b/);
  expect(CARDS.flow).toEqual({ title: "Flowchart", text: "Steps, decisions, input and output, start and end." });
});

test("keys_have_one_source", async () => {
  for (const kind of DIAGRAM_KINDS) {
    for (const t of ADD_TOOLS[kind]) expect(Object.keys(t)).not.toContain("key");
    const keys = KIND_TOOLS[kind].map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(["V", "H", "F", "N", "/"]).not.toContain(k);
  }
  const generic = GENERIC_TOOLS.map((t) => t.key);
  expect(generic).toEqual(["R", "O", "D", "A", "L", "P", "T"]);
  // A shape's key hint (Add here) comes from the kind tools.
  const keyOf = (label: string) => keyOfShape("flow", shapesOf("flow").find((x) => x.label === label)!) ?? null;
  expect(keyOf("Step")).toBe("R");
  expect(keyOf("Start or end")).toBe("O");
  expect(keyOf("Line")).toBe("A");
  expect(keyOf("Subprocess")).toBeNull();
  expect(keyOf("Note")).toBe("N");
});

test("a_key_arms_and_esc_disarms", async () => {
  const s = await oneFrame();
  expect(s.pressed()).toEqual(["Select"]);
  s.press("r");
  expect(s.pressed()).toEqual(["Step"]);
  s.press("Escape");
  expect(s.pressed()).toEqual(["Select"]);
  // Esc only disarmed: the frame stays selected.
  expect(within(s.bar()).queryByRole("button", { name: "Step" })).not.toBeNull();
  // A click on a tool arms it too.
  fireEvent.click(s.tool("Decision"), { detail: 1 });
  expect(s.pressed()).toEqual(["Decision"]);
  // A click hands the keys back to the canvas.
  expect(document.activeElement).toBe(s.canvasEl());
  s.press("v");
  expect(s.pressed()).toEqual(["Select"]);
  // From the keyboard the toolbar keeps focus, and Esc there disarms too.
  s.tool("Decision").focus();
  fireEvent.click(s.tool("Decision"));
  expect(document.activeElement).toBe(s.tool("Decision"));
  fireEvent.keyDown(s.tool("Decision"), { key: "Escape" });
  expect(s.pressed()).toEqual(["Select"]);
  // Enter places the armed shape in the view and the tool goes back to Select (only Pen stays armed).
  s.press("r");
  s.press("Enter");
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Name the new step" }), { key: "Enter" });
  await waitFor(() => expect(s.saved.text).toMatch(/\nStep\b/));
  expect(s.pressed()).toEqual(["Select"]);
});

// Only the keys here: nothing uses the Pen until Task 12, which owns "Pen stays armed after a stroke" (plan self-review
// row 32). That a used tool goes back to Select is asserted in a_key_arms_and_esc_disarms.
test("pen_stays_armed_until_esc_or_v", async () => {
  const s = setup();
  await opened();
  s.press("p");
  expect(s.pressed()).toEqual(["Pen"]);
  s.press("Enter");
  s.press("Enter");
  expect(s.pressed()).toEqual(["Pen"]);
  s.press("v");
  expect(s.pressed()).toEqual(["Select"]);
  s.press("p");
  s.press("Escape");
  expect(s.pressed()).toEqual(["Select"]);
  // Other letters arm their tools; H is the hand and F the section.
  for (const [k, name] of [["o", "Ellipse"], ["l", "Line"], ["t", "Text"], ["h", "Hand"], ["f", "Section"]] as const) {
    s.press(k);
    expect(s.pressed()).toEqual([name]);
  }
});

test("arrows_move_along_the_toolbar", () => {
  render(<BoardToolbar kind="flow" armed="flow.step" pending={0} onArm={noop} onAdd={noop} onAsk={noop} onMoreShapes={noop} />);
  const bar = screen.getByRole("toolbar", { name: "Board tools" });
  const buttons = within(bar).getAllByRole("button");
  // One tab stop.
  expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  buttons[0].focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Hand");
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Ask");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Select");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Ask");
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Select");
  // The arrow keys stop at the toolbar: the canvas does not nudge with them.
  expect(fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" })).toBe(false);
  expect(within(bar).getAllByRole("button").filter((b) => b.tabIndex === 0).map((b) => b.getAttribute("aria-label"))).toEqual(["Hand"]);
});

test("a_space_tap_opens_the_space_box_at_the_pointer", async () => {
  const s = setup();
  await opened();
  const tick = clock();
  fireEvent.pointerMove(s.pane(), { clientX: 420, clientY: 330 });
  s.press(" ");
  tick(100);
  fireEvent.keyUp(s.canvasEl(), { key: " " });
  const box = await screen.findByRole("dialog", { name: "Add here" });
  // Its crosshair marks the pointer (the canvas sits at the page's corner here).
  const cross = s.container.querySelector(".flow-space-cross") as HTMLElement;
  expect([cross.style.left, cross.style.top]).toEqual(["420px", "330px"]);
  // The pick adds a frame centred on that point on the board.
  const at = canvas.instance!.screenToFlowPosition({ x: 420, y: 330 });
  fireEvent.change(within(box).getByRole("combobox"), { target: { value: "state" } });
  fireEvent.click(within(box).getByRole("option", { name: "State" }));
  await waitFor(() => expect(s.saved.text).toContain('diagram state "State"'));
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === boardFrameId("State"))).toBe(true));
  const node = canvas.props!.nodes.find((n) => n.id === boardFrameId("State"))!;
  const origin = canvas.props!.origin ?? { x: 0, y: 0 };
  expect(Math.abs(node.position.x + origin.x + Number(node.style?.width) / 2 - at.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(node.position.y + origin.y + Number(node.style?.height) / 2 - at.y)).toBeLessThanOrEqual(1.5);
  expect(SPACE_TAP_MS).toBe(250);
});

test("holding_space_and_dragging_pans_without_the_box", async () => {
  const s = setup();
  await opened();
  const tick = clock();
  fireEvent.pointerMove(s.pane(), { clientX: 300, clientY: 300 });
  s.press(" ");
  // While Space is held, React Flow's hold-to-pan key is Space and the canvas shows the grab hand.
  expect(flow.props!.panActivationKeyCode).toBe("Space");
  await waitFor(() => expect(s.canvasEl().classList.contains("is-space-held")).toBe(true));
  // A repeat of the held key starts nothing new.
  s.press(" ", { repeat: true });
  fireEvent.pointerDown(s.pane(), { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
  fireEvent.pointerMove(s.pane(), { clientX: 340, clientY: 300, pointerId: 1 });
  fireEvent.pointerUp(s.pane(), { button: 0, clientX: 340, clientY: 300, pointerId: 1 });
  tick(600);
  fireEvent.keyUp(s.canvasEl(), { key: " " });
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByRole("dialog", { name: "Add here" })).toBeNull();
  expect(s.canvasEl().classList.contains("is-space-held")).toBe(false);

  // A quick press with the pointer moved 40 px is a pan too, not a tap.
  s.press(" ");
  fireEvent.pointerMove(s.pane(), { clientX: 380, clientY: 300 });
  tick(100);
  fireEvent.keyUp(s.canvasEl(), { key: " " });
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByRole("dialog", { name: "Add here" })).toBeNull();
});

test("a_long_space_with_no_drag_opens_nothing", async () => {
  const s = setup();
  await opened();
  const tick = clock();
  fireEvent.pointerMove(s.pane(), { clientX: 300, clientY: 300 });
  s.press(" ");
  tick(400);
  fireEvent.keyUp(s.canvasEl(), { key: " " });
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByRole("dialog", { name: "Add here" })).toBeNull();
});

test("space_in_a_text_field_types_a_space", async () => {
  const s = await oneFrame();
  const tick = clock();
  act(() => canvas.props!.onSelect!(["Cart"]));
  s.press("F2");
  const box = await screen.findByRole("textbox", { name: "Rename Cart" });
  // Not cancelled: the field types the space.
  expect(fireEvent.keyDown(box, { key: " " })).toBe(true);
  tick(50);
  fireEvent.keyUp(box, { key: " " });
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByRole("dialog", { name: "Add here" })).toBeNull();
  expect(s.canvasEl().classList.contains("is-space-held")).toBe(false);
});

test("add_opens_the_shelf_and_a_card_adds_at_the_middle", async () => {
  // B2 controller question 2: a click adds in the middle of the view (Figma, Miro), not beside the others.
  const s = setup();
  await opened();
  vi.spyOn(s.canvasEl(), "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} } as DOMRect);
  // Nothing selected: the origin is (0, 0), so the canvas is the board.
  const mid = canvas.instance!.screenToFlowPosition({ x: 400, y: 300 });
  const centre = vi.spyOn(canvas.instance!, "setCenter");
  fireEvent.click(s.tool("Add"));
  expect(s.tool("Add").getAttribute("aria-expanded")).toBe("true");
  const shelf = await screen.findByRole("dialog", { name: "Add to the board" });
  // Each kind with its line, as the New diagram sheet says it.
  const card = within(shelf).getByRole("option", { name: CARDS.sequence.title });
  expect(card.textContent).toContain(CARDS.sequence.text);
  fireEvent.click(card);
  await waitFor(() => expect(s.saved.text.startsWith(`${BOARD.trimEnd()}\n\ndiagram sequence "Sequence"`)).toBe(true));
  // Selected: its tab carries the pane buttons, and its kind tools show.
  const tab = await screen.findByRole("button", { name: "Sequence Sequence" });
  await waitFor(() => expect(tab.getAttribute("aria-current")).toBe("true"));
  await waitFor(() => expect(within(s.bar()).queryByRole("button", { name: "Participant" })).not.toBeNull());
  // Its box is centred on the middle of the view, on the board.
  await waitFor(() => expect(JSON.parse(s.saved.layout!).frames.Sequence).toBeTruthy());
  const at = JSON.parse(s.saved.layout!).frames.Sequence.at;
  const node = canvas.props!.nodes.find((n) => n.id === boardFrameId("Sequence"))!;
  expect(Math.abs(node.position.x + at.x + Number(node.style?.width) / 2 - mid.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(node.position.y + at.y + Number(node.style?.height) / 2 - mid.y)).toBeLessThanOrEqual(1.5);
  // It glides into view: the view centres on its box.
  await waitFor(() => expect(centre).toHaveBeenCalled());
  const [x, y] = centre.mock.calls[centre.mock.calls.length - 1];
  expect(x).toBeCloseTo(node.position.x + Number(node.style?.width) / 2, 0);
  expect(y).toBeCloseTo(node.position.y + Number(node.style?.height) / 2, 0);
  expect(s.tool("Add").getAttribute("aria-expanded")).toBe("false");
});

test("ctrl_j_opens_the_assistant", async () => {
  const s = await oneFrame();
  const assistant = () => s.container.querySelector("[data-side-pane='assistant']") as HTMLElement;
  expect(assistant().hidden).toBe(true);
  s.press("j", { ctrlKey: true });
  await waitFor(() => expect(assistant().hidden).toBe(false));
  // Its prompt is ready to type in.
  await waitFor(() => expect(assistant().contains(document.activeElement) && document.activeElement?.tagName === "TEXTAREA").toBe(true));
  // The Editor again, then Ask on the toolbar does the same.
  fireEvent.click(screen.getByRole("tab", { name: /Editor/ }));
  await waitFor(() => expect(assistant().hidden).toBe(true));
  fireEvent.click(s.tool("Ask"));
  await waitFor(() => expect(assistant().hidden).toBe(false));
});

test("hand_pans_with_the_left_button", async () => {
  const s = setup();
  await opened();
  expect(flow.props!.panOnDrag).toEqual([1]);
  s.press("h");
  expect(s.pressed()).toEqual(["Hand"]);
  await waitFor(() => expect(flow.props!.panOnDrag).toEqual([0, 1]));
  // The left button pans, so it draws no selection box, and a press on a shape pans rather than moving it.
  expect(flow.props!.selectionOnDrag).toBe(false);
  expect(flow.props!.nodesDraggable).toBe(false);
  expect(s.canvasEl().classList.contains("is-hand")).toBe(true);
  fireEvent.pointerDown(s.pane(), { button: 0, clientX: 300, clientY: 300, pointerId: 1 });
  fireEvent.pointerMove(s.pane(), { clientX: 360, clientY: 320, pointerId: 1 });
  fireEvent.pointerUp(s.pane(), { button: 0, clientX: 360, clientY: 320, pointerId: 1 });
  fireEvent.click(s.pane(), { clientX: 360, clientY: 320 });
  expect(screen.queryByRole("menu")).toBeNull();
  s.press("v");
  await waitFor(() => expect(flow.props!.panOnDrag).toEqual([1]));
  expect(flow.props!.selectionOnDrag).toBe(true);
  expect(flow.props!.nodesDraggable).toBe(true);
});

test("clicking_add_again_closes_the_shelf", async () => {
  const s = setup();
  await opened();
  const add = () => s.tool("Add");
  const shelf = () => screen.queryByRole("dialog", { name: "Add to the board" });
  // A real click: the press first (where an outside press closes the Shelf), then the click.
  const click = (el: HTMLElement) => {
    fireEvent.pointerDown(el, { button: 0 });
    fireEvent.mouseDown(el, { button: 0 });
    fireEvent.pointerUp(el, { button: 0 });
    fireEvent.mouseUp(el, { button: 0 });
    fireEvent.click(el, { detail: 1 });
  };
  click(add());
  await screen.findByRole("dialog", { name: "Add to the board" });
  expect(add().getAttribute("aria-expanded")).toBe("true");
  click(add());
  await new Promise((r) => setTimeout(r, 30));
  expect(shelf()).toBeNull();
  expect(add().getAttribute("aria-expanded")).toBe("false");
  // A press anywhere else still closes it.
  click(add());
  await screen.findByRole("dialog", { name: "Add to the board" });
  click(s.tool("Hand"));
  await waitFor(() => expect(shelf()).toBeNull());
});

test("closing_the_shelf_returns_focus_to_add", async () => {
  const s = setup();
  await opened();
  const shelf = () => screen.queryByRole("dialog", { name: "Add to the board" });
  // Opened from the keyboard on Add: the Shelf's search takes focus, and Esc hands it back to Add (R16).
  s.tool("Add").focus();
  fireEvent.click(s.tool("Add"));
  const panel = await screen.findByRole("dialog", { name: "Add to the board" });
  await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(shelf()).toBeNull());
  expect(document.activeElement).toBe(s.tool("Add"));
  // More shapes' Shelf gives focus back to its button too.
  cleanup();
  const one = await oneFrame();
  one.tool("More shapes").focus();
  fireEvent.click(one.tool("More shapes"));
  const more = await screen.findByRole("dialog", { name: "Add to the board" });
  await waitFor(() => expect(more.contains(document.activeElement)).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(shelf()).toBeNull());
  expect(document.activeElement).toBe(one.tool("More shapes"));
});

test("closing_the_space_box_returns_focus_to_the_canvas", async () => {
  const s = setup();
  await opened();
  const tick = clock();
  s.canvasEl().focus();
  s.press("h");
  fireEvent.pointerMove(s.pane(), { clientX: 420, clientY: 330 });
  s.press(" ");
  tick(100);
  fireEvent.keyUp(s.canvasEl(), { key: " " });
  const box = await screen.findByRole("dialog", { name: "Add here" });
  await waitFor(() => expect(document.activeElement).toBe(within(box).getByRole("combobox")));
  // Opening it disarmed Hand (R26). Its search keeps its keys: H arms nothing behind it and / opens no second box.
  expect(s.pressed()).toEqual(["Select"]);
  fireEvent.keyDown(document.activeElement!, { key: "h" });
  fireEvent.keyDown(document.activeElement!, { key: "/" });
  expect(s.pressed()).toEqual(["Select"]);
  expect(screen.getAllByRole("dialog", { name: "Add here" })).toHaveLength(1);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add here" })).toBeNull());
  expect(document.activeElement).toBe(s.canvasEl());
  // The keys work at once, where focus is.
  fireEvent.keyDown(document.activeElement!, { key: "v" });
  fireEvent.keyDown(document.activeElement!, { key: "r" });
  expect(s.pressed()).toEqual(["Rectangle"]);
});
