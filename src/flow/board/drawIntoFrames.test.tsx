// Task 8: an armed tool draws into the frame under the press (Decisions 18 and 19, Review Focus 5). A click places the
// shape at its default size, a drag sizes it, Enter places it next to the selection; the edit is the frame's own line,
// written as a minimal text edit. Only Pen stays armed.
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { splitFrames } from "../../lang/flow/board";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import { canvasEdit } from "./frameView";
import { boardFrameId } from "./boardScene";
import { ER_NOTES } from "../../lang/flow/edits";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

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
  canvas.props = null;
  canvas.instance = null;
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

type Box = { x: number; y: number; w: number; h: number };

function setup(initial = BOARD, layout: string | null = LAYOUT) {
  const saved = { text: initial, layout };
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
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const text = () => view().state.doc.toString();
  /** Frame `i`'s block of the text. */
  const frame = (i: number) => {
    const t = text();
    const f = splitFrames(t)[i];
    return t.slice(f.from, f.to);
  };
  const props = () => canvas.props!;
  const inst = () => canvas.instance!;
  const nodes = () => props().nodes;
  const nodeOf = (id: string) => nodes().find((n) => n.id === id);
  const bar = () => screen.getByRole("toolbar", { name: "Board tools" });
  const pressed = () => within(bar()).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"));
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const frameEl = (key: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === boardFrameId(key)) ?? null;
  const isSelected = (key: string) => {
    const el = frameEl(key);
    return !!el && within(el).queryByRole("button", { name: /^Code Editor/ }) !== null;
  };
  const boxOf = (key: string): Box => {
    const n = nodeOf(boardFrameId(key))!;
    return { x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) };
  };
  /** The flow boxes of the shapes inside a frame's box (live or static). */
  const shapesIn = (key: string): Box[] => {
    const f = boxOf(key);
    return nodes()
      .filter((n) => n.type !== "boardFrame" && n.type !== "liveAnchor")
      // On the board: a child's place is its parent's plus its own (a static frame's box, the live anchor).
      .map((n) => {
        const at = n.parentId ? (inst().getInternalNode(n.id)?.internals.positionAbsolute ?? { x: f.x + n.position.x, y: f.y + n.position.y }) : n.position;
        return { x: at.x, y: at.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 };
      });
  };
  const screenAt = (p: { x: number; y: number }) => inst().flowToScreenPosition(p);
  /** A press on the canvas at flow `from`, let go at `to` (a click when the same), as a browser sends it. */
  const drawAt = (from: { x: number; y: number }, to = from, target: Element = pane()) => {
    const a = screenAt(from);
    const b = screenAt(to);
    fireEvent.pointerDown(target, { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
    fireEvent.pointerMove(target, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
    fireEvent.pointerUp(target, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
    fireEvent.click(target, { clientX: b.x, clientY: b.y });
  };
  const banded = () => [...utils.container.querySelectorAll(".cm-line.cm-flow-band")].map((e) => e.textContent);
  return { ...utils, saved, canvasEl, pane, view, text, frame, props, inst, nodes, nodeOf, bar, pressed, press, frameEl, isSelected, boxOf, shapesIn, drawAt, banded };
}
type Setup = ReturnType<typeof setup>;

async function opened(titles = ["Checkout", "Refund", "Shipping"]) {
  for (const t of titles) await screen.findByRole("button", { name: new RegExp(` ${t}$`) });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

/** Selects a frame by its tab and waits for its shapes to be live. */
async function pick(s: Setup, label: string, title: string, first: string) {
  fireEvent.click(await screen.findByRole("button", { name: `${label} ${title}` }));
  await waitFor(() => expect(s.nodes().some((n) => n.id === first)).toBe(true));
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
}

/** A point inside every box of `inside`, on none of `avoid`. */
function freePoint(inside: Box[], avoid: Box[]) {
  const x0 = Math.max(...inside.map((b) => b.x));
  const y0 = Math.max(...inside.map((b) => b.y));
  const x1 = Math.min(...inside.map((b) => b.x + b.w));
  const y1 = Math.min(...inside.map((b) => b.y + b.h));
  for (let y = y0 + 8; y < y1 - 8; y += 6)
    for (let x = x0 + 8; x < x1 - 8; x += 6) if (!avoid.some((a) => x >= a.x - 4 && x <= a.x + a.w + 4 && y >= a.y - 4 && y <= a.y + a.h + 4)) return { x, y };
  throw new Error("no free point");
}

async function keepNew() {
  fireEvent.keyDown(await screen.findByRole("textbox", { name: /^(Name the new|Note text)/ }), { key: "Enter" });
}

const boxOfNode = (n: Node): Box => ({ x: n.position.x, y: n.position.y, w: n.width ?? n.initialWidth ?? 0, h: n.height ?? n.initialHeight ?? 0 });

test("a_diamond_drop_writes_a_decision_line", async () => {
  const s = setup();
  await opened();
  await pick(s, "Flowchart", "Refund", "Ask");
  s.press("d");
  expect(s.pressed()).toEqual(["Decision"]);
  s.drawAt(freePoint([s.boxOf("Refund")], s.shapesIn("Refund")));
  await keepNew();
  // After the frame's last node line, before its first link line; the other frames are untouched.
  await waitFor(() => expect(s.frame(1)).toBe('diagram flow "Refund"\nAsk\nRefund it\nDecision [decision]\nAsk > Refund it\n'));
  expect(s.frame(0)).toBe(CHECKOUT);
  expect(s.frame(2)).toBe(SHIPPING);
  await waitFor(() => expect(s.banded()).toEqual(["Decision [decision]"]));
  // A shape tool is used once: Select again.
  expect(s.pressed()).toEqual(["Select"]);
});

test("inside_a_group_it_goes_in_the_braces", async () => {
  const text = 'diagram flow "Checkout"\nCart\nPayments {\n  Charge\n}\nCart > Charge\n';
  const layout = JSON.stringify({ version: 1, nodes: { Cart: { x: 0, y: 0 }, Charge: { x: 0, y: 200 } }, style: "modern", direction: "TB" });
  const s = setup(text, layout);
  await opened(["Checkout"]);
  await waitFor(() => expect(s.nodeOf("\u0000group:Payments")).toBeTruthy());
  s.press("r");
  const area = boxOfNode(s.nodeOf("\u0000group:Payments")!);
  // Below the title band, clear of Charge.
  const inner = { x: area.x, y: area.y + 40, w: area.w, h: area.h - 40 };
  const charge = boxOfNode(s.nodeOf("Charge")!);
  s.drawAt(freePoint([inner], [charge]));
  await keepNew();
  await waitFor(() => expect(s.text()).toBe('diagram flow "Checkout"\nCart\nPayments {\n  Charge\n  Step [step]\n}\nCart > Charge\n'));
});

test("a_drag_sizes_the_shape_in_one_undo", async () => {
  const s = setup(CHECKOUT, null);
  await opened(["Checkout"]);
  await waitFor(() => expect(s.nodeOf("Cart")).toBeTruthy());
  s.press("r");
  const from = { x: 400, y: 0 };
  s.drawAt(from, { x: 640, y: 160 });
  await keepNew();
  await waitFor(() => expect(s.text()).toBe('diagram flow "Checkout"\nCart\nPay\nStep [step]\nCart > Pay\n'));
  await waitFor(() => expect(s.nodeOf("Step")).toBeTruthy());
  const drawn = () => {
    const n = s.nodeOf("Step")!;
    return { x: n.position.x, y: n.position.y, w: n.width ?? n.initialWidth, h: n.height ?? n.initialHeight };
  };
  expect(drawn()).toEqual({ x: 400, y: 0, w: 240, h: 160 });
  // One undo takes the line, the place and the size together; one redo brings all three back.
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.text()).toBe(CHECKOUT));
  // The kept size goes with it.
  await waitFor(() => expect(s.saved.text).toBe(CHECKOUT));
  expect(s.saved.layout ?? "").not.toContain('"sizes"');
  act(() => void redo(s.view()));
  await waitFor(() => expect(s.nodeOf("Step")).toBeTruthy());
  expect(drawn()).toEqual({ x: 400, y: 0, w: 240, h: 160 });
});

test("enter_places_next_to_the_selection", async () => {
  const s = setup(CHECKOUT, JSON.stringify({ version: 1, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" }));
  await opened(["Checkout"]);
  await waitFor(() => expect(s.nodeOf("Pay")).toBeTruthy());
  act(() => s.props().onSelect!(["Pay"]));
  s.press("r");
  s.press("Enter");
  await keepNew();
  await waitFor(() => expect(s.nodeOf("Step")).toBeTruthy());
  // Below Pay in a top-to-bottom frame, lined up with it.
  const pay = boxOfNode(s.nodeOf("Pay")!);
  const step = boxOfNode(s.nodeOf("Step")!);
  expect(step.x + step.w / 2).toBe(pay.x + pay.w / 2);
  expect(step.y).toBeGreaterThan(pay.y + pay.h);
  expect(step.y).toBeLessThan(pay.y + pay.h + 200);
  expect(s.pressed()).toEqual(["Select"]);
});

test("a_generic_rectangle_inside_a_flowchart_writes_a_step", async () => {
  const s = setup();
  await opened();
  // Nothing selected: the generic tools.
  s.press("r");
  expect(s.pressed()).toEqual(["Rectangle"]);
  s.drawAt(freePoint([s.boxOf("Refund")], s.shapesIn("Refund")));
  // The press selects the frame, and the shape goes in it.
  await waitFor(() => expect(s.isSelected("Refund")).toBe(true));
  await keepNew();
  await waitFor(() => expect(s.frame(1)).toBe('diagram flow "Refund"\nAsk\nRefund it\nStep [step]\nAsk > Refund it\n'));
  expect(s.frame(0)).toBe(CHECKOUT);
  expect(s.frame(2)).toBe(SHIPPING);
  expect(s.pressed()).toEqual(["Select"]);
});

test("a_generic_shape_inside_an_er_frame_writes_a_table", async () => {
  const shop = 'diagram er "Shop"\ncustomers {\n  id int pk\n}\n';
  const layout = JSON.stringify({
    version: 2,
    frames: {
      Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
      Shop: { at: { x: 600, y: 0 }, nodes: { customers: { x: 0, y: 0 } }, style: "modern", direction: "TB" },
    },
    sketches: [],
  });
  const s = setup([CHECKOUT, shop].join("\n"), layout);
  await opened(["Checkout", "Shop"]);
  s.press("r");
  const box = s.boxOf("Shop");
  // Room inside the frame below the table.
  const room = { x: box.x, y: box.y + box.h - 60, w: box.w, h: 60 };
  s.drawAt(freePoint([room], s.shapesIn("Shop")));
  // B3 R13: the generic R opens the new table's field; Enter writes it.
  const name = (await screen.findByLabelText("Table name", { selector: "input" })) as HTMLInputElement;
  expect(name.value).toBe("table_1");
  expect(s.frame(1)).toBe(shop);
  fireEvent.keyDown(name, { key: "Enter" });
  await waitFor(() => expect(s.frame(1)).toBe('diagram er "Shop"\ncustomers {\n  id int pk\n}\ntable_1\n'));
  expect(s.frame(0)).toBe(CHECKOUT);
  await waitFor(() => expect(s.isSelected("Shop")).toBe(true));
  expect(s.pressed()).toEqual(["Select"]);
});

test("a_kind_with_no_match_makes_a_sketch", async () => {
  // A sequence has no diamond: the generic Diamond draws a loose sketch there (Task 12 draws it), never the frame's code.
  const login = 'diagram sequence "Login"\nparticipant User\nparticipant App\nUser -> App: sign in\n';
  const layout = JSON.stringify({
    version: 2,
    frames: { Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" }, Login: { at: { x: 600, y: 0 }, nodes: {} } },
    sketches: [],
  });
  const s = setup([CHECKOUT, login].join("\n"), layout);
  await opened(["Checkout", "Login"]);
  const before = s.text();
  s.press("d");
  expect(s.pressed()).toEqual(["Diamond"]);
  const at = freePoint([s.boxOf("Login")], s.shapesIn("Login"));
  s.drawAt(at);
  // The sketch is made where the click was, 120 by 80 around it; the frame's code is left alone.
  await waitFor(() => expect(s.nodes().filter((n) => n.type === "sketch")).toHaveLength(1));
  const made = (s.nodes().find((n) => n.type === "sketch")!.data as { sketch: { kind: string; x: number; y: number; w: number; h: number } }).sketch;
  expect(made.kind).toBe("diamond");
  expect(Math.abs(made.x + 60 - at.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(made.y + 40 - at.y)).toBeLessThanOrEqual(1);
  expect([made.w, made.h]).toEqual([120, 80]);
  await new Promise((r) => setTimeout(r, 100));
  expect(screen.queryByRole("textbox", { name: /^Name the new/ })).toBeNull();
  expect(s.text()).toBe(before);
  expect(s.pressed()).toEqual(["Select"]);
});

test("a_kind_tool_in_another_frame_selects_it_and_disarms", async () => {
  const s = setup();
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  s.press("r");
  expect(s.pressed()).toEqual(["Step"]);
  s.drawAt(freePoint([s.boxOf("Shipping")], s.shapesIn("Shipping")));
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(true));
  expect(s.pressed()).toEqual(["Select"]);
  await new Promise((r) => setTimeout(r, 100));
  expect(screen.queryByRole("textbox", { name: /^Name the new/ })).toBeNull();
  expect(s.text()).toBe(BOARD);
});

const LOGIN = 'diagram sequence "Login"\nparticipant User\nparticipant App\nparticipant Store\nUser -> App: sign in\n';

test("a_participant_click_goes_in_x_order", async () => {
  const s = setup(LOGIN, null);
  await opened(["Login"]);
  await waitFor(() => expect(s.nodeOf("Store")).toBeTruthy());
  s.press("r");
  expect(s.pressed()).toEqual(["Participant"]);
  // Between App and Store, below everything drawn.
  const app = boxOfNode(s.nodeOf("App")!);
  const store = boxOfNode(s.nodeOf("Store")!);
  const low = Math.max(...s.nodes().map((n) => boxOfNode(n)).map((b) => b.y + b.h)) + 40;
  s.drawAt({ x: (app.x + app.w / 2 + store.x + store.w / 2) / 2, y: low });
  await keepNew();
  await waitFor(() => expect(s.text()).toBe('diagram sequence "Login"\nparticipant User\nparticipant App\nparticipant Participant\nparticipant Store\nUser -> App: sign in\n'));
  expect(s.pressed()).toEqual(["Select"]);
});

test("fixed_kinds_take_no_drag_size", async () => {
  const s = setup(LOGIN, null);
  await opened(["Login"]);
  await waitFor(() => expect(s.nodeOf("Store")).toBeTruthy());
  const store = boxOfNode(s.nodeOf("Store")!);
  s.press("r");
  const low = Math.max(...s.nodes().map((n) => boxOfNode(n)).map((b) => b.y + b.h)) + 40;
  const from = { x: store.x + store.w + 80, y: low };
  s.drawAt(from, { x: from.x + 300, y: from.y + 200 });
  await keepNew();
  await waitFor(() => expect(s.text()).toContain("participant Participant\n"));
  await waitFor(() => expect(s.nodeOf("Participant")).toBeTruthy());
  // Drawn at the kind's own size, and the layout keeps no size for it.
  const p = boxOfNode(s.nodeOf("Participant")!);
  expect(p.w).toBe(store.w);
  await waitFor(() => expect(s.saved.text).toContain("participant Participant"));
  expect(s.saved.layout ?? "").not.toContain('"sizes"');
});

const ROUTE = 'diagram flow "Checkout"\nCart\nPay\nShip\nCart > Pay\n';
const ROUTE_AT = JSON.stringify({ version: 1, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 160 }, Ship: { x: 320, y: 160 } }, style: "modern", direction: "TB" });

test("arrow_connects_by_press_drag", async () => {
  const s = setup(ROUTE, ROUTE_AT);
  await opened(["Checkout"]);
  await waitFor(() => expect(s.nodeOf("Ship")).toBeTruthy());
  s.press("a");
  expect(s.pressed()).toEqual(["Arrow"]);
  const pay = boxOfNode(s.nodeOf("Pay")!);
  const ship = boxOfNode(s.nodeOf("Ship")!);
  const payEl = [...s.container.querySelectorAll(".react-flow__node")].find((e) => e.getAttribute("data-id") === "Pay")!;
  s.drawAt({ x: pay.x + pay.w / 2, y: pay.y + pay.h / 2 }, { x: ship.x + ship.w / 2, y: ship.y + ship.h / 2 }, payEl);
  await waitFor(() => expect(s.text()).toBe(`${ROUTE}Pay > Ship\n`));
  // Pay did not move: the press drew a line, not a drag.
  expect(boxOfNode(s.nodeOf("Pay")!)).toEqual(pay);
  expect(s.pressed()).toEqual(["Select"]);
});

test("arrow_connects_by_two_clicks", async () => {
  const s = setup(ROUTE, ROUTE_AT);
  await opened(["Checkout"]);
  await waitFor(() => expect(s.nodeOf("Ship")).toBeTruthy());
  s.press("a");
  act(() => s.props().onSelect!(["Pay"]));
  act(() => s.props().onSelect!(["Ship"]));
  await waitFor(() => expect(s.text()).toBe(`${ROUTE}Pay > Ship\n`));
  expect(s.pressed()).toEqual(["Select"]);
});

test("column_and_relationship_tools_in_an_erd", async () => {
  const er = 'diagram er "Billing"\ncustomers {\n  id int pk\n}\norders {\n  id int pk\n}\n';
  const s = setup(er, JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, orders: { x: 400, y: 0 } }, style: "modern", direction: "TB" }));
  await opened(["Billing"]);
  await waitFor(() => expect(s.nodeOf("orders")).toBeTruthy());
  // Column: a click on a table opens a new column row at its end (B3 decision 9), written once kept.
  s.press("c");
  expect(s.pressed()).toEqual(["Column"]);
  act(() => s.props().onSelect!(["orders"]));
  const name = (await screen.findByLabelText("Column name", { selector: "input" })) as HTMLInputElement;
  expect(s.text()).toBe(er);
  expect(s.pressed()).toEqual(["Select"]);
  fireEvent.change(name, { target: { value: "column_1" } });
  fireEvent.keyDown(name, { key: "Tab" });
  const type = (await screen.findByLabelText("Column type", { selector: "input" })) as HTMLInputElement;
  fireEvent.change(type, { target: { value: "text" } });
  fireEvent.keyDown(type, { key: "Enter" });
  await waitFor(() => expect(s.text()).toBe('diagram er "Billing"\ncustomers {\n  id int pk\n}\norders {\n  id int pk\n  column_1 text\n}\n'));
  fireEvent.keyDown(await screen.findByLabelText("Column name", { selector: "input" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByLabelText("Column name")).toBeNull());
  // The Relationship half (A by two clicks, and its press-drag) is B3 Task 7's: it joins columns, so it lives in
  // erRelationships.test.tsx as the_relationship_tool_joins_by_two_clicks and the_relationship_tool_drags_from_a_row_without_its_port.
});

test("the_empty_card_hint_says_what_a_click_does", async () => {
  // "Press R, S or E and click where it goes": the key arms, the click on the canvas places the shape there.
  const s = setup('diagram dfd "New"\n', null);
  expect(await screen.findByText("Press R, S or E and click where it goes, or click here")).toBeTruthy();
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => expect(s.boxOf("New").w).toBeGreaterThan(0));
  s.press("s");
  const box = s.boxOf("New");
  const at = { x: box.x + 20, y: box.y + 20 };
  s.drawAt(at);
  await keepNew();
  await waitFor(() => expect(s.text()).toBe('diagram dfd "New"\nData store [store, id: D1]\n'));
  const n = boxOfNode(s.nodeOf("Data store")!);
  expect(Math.abs(n.x + n.w / 2 - at.x)).toBeLessThanOrEqual(1);
});

test("dragging_out_a_shape_shows_its_outline_until_release", async () => {
  const s = setup(CHECKOUT, null);
  await opened(["Checkout"]);
  await waitFor(() => expect(s.nodeOf("Cart")).toBeTruthy());
  const outline = () => s.container.querySelector<HTMLElement>(".board-draw-outline");
  const a = s.inst().flowToScreenPosition({ x: 400, y: 0 });
  const b = s.inst().flowToScreenPosition({ x: 640, y: 160 });
  // Mid-drag: the dragged box is outlined, takes no presses, and nothing is written.
  s.press("r");
  fireEvent.pointerDown(s.pane(), { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
  fireEvent.pointerMove(s.pane(), { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  expect(outline()).not.toBeNull();
  expect(outline()!.style.left).toBe(`${a.x}px`);
  expect(outline()!.style.width).toBe(`${b.x - a.x}px`);
  expect(screen.queryByRole("textbox", { name: /^Name the new/ })).toBeNull();
  expect(s.text()).toBe(CHECKOUT);
  // Released: the outline goes and the shape opens with its name.
  fireEvent.pointerUp(s.pane(), { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  expect(outline()).toBeNull();
  await keepNew();
  await waitFor(() => expect(s.text()).toBe('diagram flow "Checkout"\nCart\nPay\nStep [step]\nCart > Pay\n'));
  // Esc mid-drag: the outline goes, nothing is drawn on release.
  s.press("r");
  fireEvent.pointerDown(s.pane(), { clientX: a.x, clientY: a.y + 300, button: 0, pointerId: 1 });
  fireEvent.pointerMove(s.pane(), { clientX: b.x, clientY: b.y + 300, button: 0, pointerId: 1 });
  expect(outline()).not.toBeNull();
  fireEvent.keyDown(s.canvasEl(), { key: "Escape" });
  expect(outline()).toBeNull();
  fireEvent.pointerUp(s.pane(), { clientX: b.x, clientY: b.y + 300, button: 0, pointerId: 1 });
  await new Promise((r) => setTimeout(r, 100));
  expect(screen.queryByRole("textbox", { name: /^Name the new/ })).toBeNull();
  expect(s.text()).toBe('diagram flow "Checkout"\nCart\nPay\nStep [step]\nCart > Pay\n');
});

test("a_tiny_or_flat_drag_places_the_default_size", async () => {
  const s = setup(CHECKOUT, null);
  await opened(["Checkout"]);
  await waitFor(() => expect(s.nodeOf("Cart")).toBeTruthy());
  const cart = boxOfNode(s.nodeOf("Cart")!);
  // A flat drag: no side may go under the minimum, so it is a click at the press, at the default size.
  s.press("r");
  s.drawAt({ x: 400, y: 0 }, { x: 640, y: 2 });
  await keepNew();
  await waitFor(() => expect(s.nodeOf("Step")).toBeTruthy());
  const step = boxOfNode(s.nodeOf("Step")!);
  expect({ w: step.w, h: step.h }).toEqual({ w: cart.w, h: cart.h });
  expect(Math.abs(step.x + step.w / 2 - 400)).toBeLessThanOrEqual(1);
  // A tiny drag past the click threshold: the default size too.
  s.press("r");
  s.drawAt({ x: 400, y: 300 }, { x: 405, y: 305 });
  await keepNew();
  await waitFor(() => expect(s.nodeOf("Step 2")).toBeTruthy());
  expect({ w: boxOfNode(s.nodeOf("Step 2")!).w, h: boxOfNode(s.nodeOf("Step 2")!).h }).toEqual({ w: cart.w, h: cart.h });
  // A huge drag is held to the resize limits (320 by 200).
  s.press("r");
  s.drawAt({ x: 800, y: 0 }, { x: 1600, y: 900 });
  await keepNew();
  await waitFor(() => expect(s.nodeOf("Step 3")).toBeTruthy());
  const big = boxOfNode(s.nodeOf("Step 3")!);
  expect({ x: big.x, y: big.y, w: big.w, h: big.h }).toEqual({ x: 800, y: 0, w: 320, h: 200 });
});

test("an_arrow_press_drag_shows_its_line_and_takes_a_release_off_the_edge", async () => {
  const s = setup(ROUTE, ROUTE_AT);
  await opened(["Checkout"]);
  await waitFor(() => expect(s.nodeOf("Ship")).toBeTruthy());
  s.press("a");
  const pay = boxOfNode(s.nodeOf("Pay")!);
  const ship = boxOfNode(s.nodeOf("Ship")!);
  const payEl = [...s.container.querySelectorAll(".react-flow__node")].find((e) => e.getAttribute("data-id") === "Pay")!;
  const a = s.inst().flowToScreenPosition({ x: pay.x + pay.w / 2, y: pay.y + pay.h / 2 });
  // Just off Ship's left edge: today's line end snaps to it.
  const b = s.inst().flowToScreenPosition({ x: ship.x - 10, y: ship.y + ship.h / 2 });
  fireEvent.pointerDown(payEl, { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
  fireEvent.pointerMove(payEl, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  // Mid-drag: the line is drawn, locked onto Ship, and nothing is written.
  await waitFor(() => expect(s.container.querySelector(".flow-overlay-svg .flow-drawing-line")).not.toBeNull());
  expect(s.container.querySelector(".flow-overlay-svg .flow-drawing.is-locked")).not.toBeNull();
  expect(s.text()).toBe(ROUTE);
  fireEvent.pointerUp(payEl, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  fireEvent.click(payEl, { clientX: b.x, clientY: b.y });
  expect(s.container.querySelector(".flow-overlay-svg .flow-drawing-line")).toBeNull();
  await waitFor(() => expect(s.text()).toBe(`${ROUTE}Pay > Ship\n`));
  expect(s.pressed()).toEqual(["Select"]);
});

test("a_message_press_drag_to_a_lifeline_connects", async () => {
  const s = setup(LOGIN, null);
  await opened(["Login"]);
  await waitFor(() => expect(s.nodeOf("Store")).toBeTruthy());
  s.press("a");
  expect(s.pressed()).toEqual(["Message"]);
  const user = boxOfNode(s.nodeOf("User")!);
  const store = boxOfNode(s.nodeOf("Store")!);
  const userEl = [...s.container.querySelectorAll(".react-flow__node")].find((e) => e.getAttribute("data-id") === "User")!;
  // Low on both lifelines, far under their heads.
  s.drawAt({ x: user.x + user.w / 2, y: user.y + user.h - 10 }, { x: store.x + store.w / 2, y: store.y + store.h - 10 }, userEl);
  await waitFor(() => expect(s.text()).toBe(`${LOGIN}User -> Store\n`));
});

test("a_draw_into_a_clashing_frame_never_fires_later", async () => {
  // The third frame takes a title the first has: it is drawn faded and never goes live.
  const clash = 'diagram flow "Checkout"\nPack\nSend\nPack > Send\n';
  const s = setup([CHECKOUT, REFUND, clash].join("\n"));
  // Two tabs say Checkout here: only this test allows more than one.
  await screen.findAllByRole("button", { name: / Checkout$/ });
  await opened(["Refund"]);
  const faded = () => s.nodes().find((n) => n.type === "boardFrame" && (n.data as { box: { index: number } }).box.index === 2)!;
  await waitFor(() => expect(faded()).toBeTruthy());
  const f = faded();
  const box = { x: f.position.x, y: f.position.y, w: Number(f.style?.width), h: Number(f.style?.height) };
  const kids = s.nodes().filter((n) => n.parentId === f.id).map((n) => ({ x: box.x + n.position.x, y: box.y + n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 }));
  s.press("r");
  s.drawAt(freePoint([box], kids));
  await new Promise((r) => setTimeout(r, 150));
  expect(screen.queryByRole("textbox", { name: /^Name the new/ })).toBeNull();
  // With that frame selected, a kind tool pressed outside every frame draws nothing: the frame is not live.
  s.press("r");
  s.drawAt({ x: box.x + box.w + 400, y: box.y + box.h + 400 });
  await new Promise((r) => setTimeout(r, 150));
  expect(screen.queryByRole("textbox", { name: /^Name the new/ })).toBeNull();
  expect(s.text()).toBe([CHECKOUT, REFUND, clash].join("\n"));
  // Pressed in the faded frame again with the generic Rectangle: it is selected, not live, and waits for nothing.
  s.press("r");
  expect(s.pressed()).toEqual(["Rectangle"]);
  s.drawAt(freePoint([box], kids));
  await new Promise((r) => setTimeout(r, 150));
  expect(screen.queryByRole("textbox", { name: /^Name the new/ })).toBeNull();
  // The first frame is renamed in the code: frame 2 now owns its title and goes live, still selected. The pane shows
  // frame 2 only, so the rename comes as an edit from outside the pane, which hidden frames take.
  const v = s.view();
  act(() => v.dispatch({ changes: { from: 0, to: 'diagram flow "Checkout"'.length, insert: 'diagram flow "Orders"' }, annotations: canvasEdit.of(true) }));
  await waitFor(() => expect(s.nodes().some((n) => n.id === "Pack")).toBe(true));
  // The old press draws nothing there.
  await new Promise((r) => setTimeout(r, 150));
  expect(screen.queryByRole("textbox", { name: /^Name the new/ })).toBeNull();
  expect(s.text()).toBe([CHECKOUT.replace('"Checkout"', '"Orders"'), REFUND, clash].join("\n"));
});

test("a_tool_in_an_overlap_draws_into_the_frame_on_top_where_it_was_pressed", async () => {
  const layout = JSON.parse(LAYOUT);
  layout.frames.Shipping.at = { x: 700, y: 60 };
  const s = setup(BOARD, JSON.stringify(layout));
  await opened();
  // Nothing live: the later frame in text order is on top in the overlap.
  s.press("r");
  const p = freePoint([s.boxOf("Refund"), s.boxOf("Shipping")], [...s.shapesIn("Refund"), ...s.shapesIn("Shipping")]);
  const pressed = s.inst().flowToScreenPosition(p);
  s.drawAt(p);
  await waitFor(() => expect(s.isSelected("Shipping")).toBe(true));
  await keepNew();
  await waitFor(() => expect(s.frame(2)).toBe('diagram flow "Shipping"\nPack\nSend\nStep [step]\nPack > Send\n'));
  expect(s.frame(1)).toBe(REFUND);
  // Drawn where it was pressed: the switch moved nothing on screen. Its place on the board is its frame-local position
  // plus the live anchor's.
  await waitFor(() => expect(s.nodeOf("Step")).toBeTruthy());
  const n = boxOfNode(s.nodeOf("Step")!);
  const abs = s.inst().getInternalNode("Step")!.internals.positionAbsolute;
  const mid = s.inst().flowToScreenPosition({ x: abs.x + n.w / 2, y: abs.y + n.h / 2 });
  expect(Math.abs(mid.x - pressed.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(mid.y - pressed.y)).toBeLessThanOrEqual(1);
});

// ---- Task 18a: the parked minors

test("a_huge_drag_up_and_left_keeps_the_press_corner", async () => {
  const s = setup(CHECKOUT, null);
  await opened(["Checkout"]);
  await waitFor(() => expect(s.nodeOf("Cart")).toBeTruthy());
  // Pressed at (1600, 900), let go far up and left: held to 320 by 200, the box still ends at the press (Figma, draw.io).
  s.press("r");
  s.drawAt({ x: 1600, y: 900 }, { x: 800, y: 0 });
  await keepNew();
  await waitFor(() => expect(s.nodeOf("Step")).toBeTruthy());
  const big = boxOfNode(s.nodeOf("Step")!);
  expect({ x: big.x, y: big.y, w: big.w, h: big.h }).toEqual({ x: 1280, y: 700, w: 320, h: 200 });
});

test("a_draw_its_add_refuses_keeps_the_tool_armed", async () => {
  // An old-form ER frame takes no table until it is rewritten: the draw says so, and Table stays armed.
  const s = setup('diagram er "Tables"\ncustomer\norder\ncustomer 1--* order\n', null);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => expect(s.boxOf("Tables").w).toBeGreaterThan(0));
  s.press("r");
  expect(s.pressed()).toEqual(["Table"]);
  const box = s.boxOf("Tables");
  s.drawAt({ x: box.x + box.w - 20, y: box.y + box.h - 20 });
  expect(await screen.findByText(ER_NOTES.oldForm)).toBeTruthy();
  expect(s.pressed()).toEqual(["Table"]);
  // Enter refused the same way keeps it armed too.
  s.press("Enter");
  expect(s.pressed()).toEqual(["Table"]);
  expect(s.text()).toBe('diagram er "Tables"\ncustomer\norder\ncustomer 1--* order\n');
});

test("a_frame_switch_clears_the_line_tools_prompt", async () => {
  const s = setup();
  await opened();
  await pick(s, "Flowchart", "Checkout", "Cart");
  s.press("a");
  expect(s.pressed()).toEqual(["Arrow"]);
  const prompt = "Click the shape the arrow starts from, then the one it goes to.";
  expect(await screen.findByText(prompt)).toBeTruthy();
  await pick(s, "Flowchart", "Refund", "Ask");
  expect(s.pressed()).toEqual(["Select"]);
  await waitFor(() => expect(screen.queryByText(prompt)).toBeNull());
});

test("a_table_the_worker_refuses_on_keep_keeps_its_field_open", async () => {
  // Task 18a carried C2, B3 R13: a drawn ER table opens its field and the tool is used; the worker's refusal of the
  // kept name stays in the field with its reason, and nothing is written.
  const shop = 'diagram er "Shop"\ncustomers {\n  id int pk\n}\n';
  const s = setup(shop, null);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => expect(s.boxOf("Shop").w).toBeGreaterThan(0));
  s.press("r");
  expect(s.pressed()).toEqual(["Table"]);
  const box = s.boxOf("Shop");
  s.drawAt({ x: box.x + box.w - 20, y: box.y + box.h - 20 });
  const name = (await screen.findByLabelText("Table name", { selector: "input" })) as HTMLInputElement;
  expect(s.pressed()).toEqual(["Select"]);
  const ask = vi.spyOn(LangClient.prototype, "flowEdit").mockResolvedValue({ stale: false, edits: [], note: "No table this time." } as Awaited<ReturnType<LangClient["flowEdit"]>>);
  try {
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("No table this time."));
    expect(ask).toHaveBeenCalled();
    expect(s.text()).toBe(shop);
  } finally {
    ask.mockRestore();
  }
  // Kept again with the worker's yes, the table is written.
  fireEvent.keyDown(name, { key: "Enter" });
  await waitFor(() => expect(s.text()).toContain("table_1"));
});
