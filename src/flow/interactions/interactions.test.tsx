// Canvas interactions and motion (spec 6+ section 4, the motion design's playground): snap and guides, drawing a
// flow, the label box, "Add and connect", the pull-back, groups, Tidy, zoom to fit, undo and delete.
import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { MOTION, setReducedMotionPref } from "../../diagram/motion";
import { LangClient, type WorkerLike } from "../../lang/client";
import type { FromWorker, ToWorker } from "../../lang/protocol";
import { createHandler } from "../../lang/worker";
import flowCanvasCss from "../../styles/flow-canvas.css?raw";
import { routeInvoke } from "../../test/invoke";
import { mockEditorDom } from "../../test/editor";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import { holdTimers } from "../../test/timers";
import { EditorView } from "@codemirror/view";
import FlowTab from "../FlowTab";
import { GUIDE_PX, MAGNET_PX, SNAP, ghostCell, guidesFor, magnetTarget } from "./geometry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// A busy machine stretches the canvas work; waits still end as soon as their condition holds.
patientFile();

type Snap = { at: number; nodes: DiagramCanvasProps["nodes"]; edges: DiagramCanvasProps["edges"]; live: DiagramCanvasProps["livePositions"] };
// The real canvas draws; the test keeps every render's props, to drive a drag and to watch nodes glide.
const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, renders: [] as Snap[] }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      const last = canvas.renders[canvas.renders.length - 1];
      if (!last || last.nodes !== p.nodes || last.edges !== p.edges || last.live !== p.livePositions)
        canvas.renders.push({ at: performance.now(), nodes: p.nodes, edges: p.edges, live: p.livePositions });
      return real.default(p);
    },
  };
});

/**
 * Frames come every 16ms and each one is 16ms after the last, however late it really runs. A glide then always
 * has the same frames: on a busy machine a real clock let one late frame jump a 240ms glide to its end.
 */
function steadyFrames() {
  let now = 0;
  let next = 1;
  let queue = new Map<number, FrameRequestCallback>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    now += 16;
    const run = queue;
    queue = new Map();
    for (const cb of run.values()) cb(now);
  };
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = next++;
    queue.set(id, cb);
    timer ??= setTimeout(flush, 16);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => queue.delete(id));
}

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  // Motion is on: the system setting does not ask for reduced motion. Tests that want it set the app preference.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  steadyFrames();
});
beforeEach(() => {
  canvas.renders = [];
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  setReducedMotionPref(false);
});

const DFD = [
  'diagram dfd "Checkout"',
  "",
  "Customer [entity]",
  "Checkout [process, id: 1.0]",
  "Orders [store, id: D1, table: shop.orders]",
  "",
  "Payments {",
  "  Charge card [process, id: 2.0]",
  "  Card network [entity]",
  "}",
  "",
  "Customer > Checkout: order details",
  "Checkout > Orders: new order",
  "Checkout > Charge card: amount",
  "Charge card <> Card network: authorise",
  "Orders --> Checkout: stock level",
  "",
].join("\n");

/** The motion playground's places, off the grid Tidy would pick, so Tidy has to move them. */
const PLACES = {
  Customer: { x: 32, y: 128 },
  Checkout: { x: 288, y: 128 },
  Orders: { x: 544, y: 48 },
  "Charge card": { x: 288, y: 320 },
  "Card network": { x: 544, y: 320 },
};
const LAYOUT = JSON.stringify({ version: 1, nodes: PLACES, style: "modern", direction: "LR" });

/** The language worker with the app's own 120 ms parse wait, so two quick changes share one parse. */
function waitingWorker(): WorkerLike {
  const fake: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(m: ToWorker) {
      handler(m);
    },
    terminate() {},
  };
  const handler = createHandler((m: FromWorker) => fake.onmessage?.({ data: m }), 120);
  return fake;
}

function setup(files: { text: string; layout: string | null } = { text: DFD, layout: LAYOUT }, worker: () => WorkerLike = fakeWorker) {
  routeInvoke({ read_diagram: () => files, write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(worker);
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="checkout" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const text = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  // Text saves and layout-only saves, in order (a move writes only the layout file).
  const saves = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([c]) => c === "write_diagram" || c === "write_diagram_layout")
      .map(([, a]) => a as { text?: string; layout: string });
  const portal = () => utils.container.querySelector(".react-flow__viewport-portal") as HTMLElement;
  return { ...utils, view, text, node, canvasEl, press, saves, portal };
}
type Setup = ReturnType<typeof setup>;

async function drawn(s: Setup) {
  await waitFor(() => expect(s.node("Process Checkout")).not.toBeNull(), { timeout: 4000 });
}

/** Where a render draws `name`: a glide's live position over the node's own. */
function drawnAt(r: { nodes: DiagramCanvasProps["nodes"]; live?: DiagramCanvasProps["livePositions"] }, name: string) {
  const live = r.live && Object.prototype.hasOwnProperty.call(r.live, name) ? r.live[name] : undefined;
  if (live) return { x: live.x, y: live.y };
  return r.nodes.find((n) => n.id === name)?.position;
}

/** Where the canvas was last told to draw `name`. */
function shownAt(name: string) {
  return drawnAt({ nodes: canvas.props!.nodes, live: canvas.props!.livePositions }, name);
}

/** Every distinct position `name` was drawn at since `from` (an index into the renders). */
function track(name: string, from = 0) {
  const out: { at: number; x: number; y: number }[] = [];
  for (const r of canvas.renders.slice(from)) {
    const p = drawnAt(r, name);
    if (!p) continue;
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push({ at: r.at, x: p.x, y: p.y });
  }
  return out;
}

const between = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);

// ----- geometry

test("snap_ghost_cell", async () => {
  expect(SNAP).toBe(16);
  expect(ghostCell({ x: 403, y: 210, w: 172, h: 52 })).toEqual({ x: 400, y: 208, w: 172, h: 52 });
  expect(ghostCell({ x: 409, y: 215, w: 172, h: 52 })).toEqual({ x: 416, y: 208, w: 172, h: 52 });
  // On the canvas: the node follows the pointer, a dashed outline shows the cell it lands on, and the release
  // settles it into that cell.
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onDrag!("Checkout", 403, 210));
  const ghost = await waitFor(() => {
    const g = s.portal().querySelector<HTMLElement>(".flow-ghost");
    expect(g).not.toBeNull();
    return g!;
  });
  expect([ghost.style.left, ghost.style.top]).toEqual(["400px", "208px"]);
  act(() => canvas.props!.onMove!("Checkout", 403, 210));
  expect(s.portal().querySelector(".flow-ghost")).toBeNull();
  await waitFor(() => expect(s.saves().length).toBeGreaterThan(0));
  expect(JSON.parse(s.saves()[s.saves().length - 1].layout).nodes.Checkout).toEqual({ x: 400, y: 208 });
  await waitFor(() => expect(shownAt("Checkout")).toEqual({ x: 400, y: 208 }));
  expect(s.text()).toBe(DFD);
});

test("guides_within_4px_only", async () => {
  expect(GUIDE_PX).toBe(4);
  const lead = { x: 100, y: 100, w: 100, h: 50 };
  // Left edges 4 px apart: a vertical guide on the other node's edge.
  expect(guidesFor(lead, [{ x: 104, y: 300, w: 120, h: 50 }])).toEqual([{ axis: "x", at: 104, from: 88, to: 362 }]);
  // 5 px apart: none (centres and right edges are further still).
  expect(guidesFor(lead, [{ x: 105, y: 300, w: 120, h: 50 }])).toEqual([]);
  // Centres in line: one guide through both centres.
  expect(guidesFor(lead, [{ x: 400, y: 103, w: 100, h: 50 }]).map((g) => [g.axis, g.at])).toEqual([
    ["y", 103],
    ["y", 128],
    ["y", 153],
  ]);
  expect(guidesFor(lead, [{ x: 400, y: 95, w: 100, h: 50 }])).toEqual([]);
  // On the canvas: Checkout dragged level with Customer shows a guide.
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onDrag!("Checkout", 610, 500));
  await waitFor(() => expect(s.portal().querySelector(".flow-ghost")).not.toBeNull());
  expect(s.portal().querySelectorAll(".flow-guide")).toHaveLength(0);
  act(() => canvas.props!.onDrag!("Checkout", 610, 130));
  await waitFor(() => expect(s.portal().querySelectorAll(".flow-guide").length).toBeGreaterThan(0));
  act(() => canvas.props!.onMove!("Checkout", 610, 130));
  expect(s.portal().querySelectorAll(".flow-guide")).toHaveLength(0);
});

test("magnet_24px_locks_nearest_port", () => {
  expect(MAGNET_PX).toBe(24);
  const nodes = [
    { id: "Orders", box: { x: 100, y: 100, w: 100, h: 50 } },
    { id: "Refunds", box: { x: 400, y: 100, w: 100, h: 50 } },
  ];
  expect(magnetTarget({ x: 224, y: 125 }, nodes)).toEqual({ id: "Orders", side: "r" });
  expect(magnetTarget({ x: 225, y: 125 }, nodes)).toBeNull();
  expect(magnetTarget({ x: 150, y: 76 }, nodes)).toEqual({ id: "Orders", side: "t" });
  expect(magnetTarget({ x: 150, y: 174 }, nodes)).toEqual({ id: "Orders", side: "b" });
  expect(magnetTarget({ x: 380, y: 140 }, nodes)).toEqual({ id: "Refunds", side: "l" });
  // Inside the box: the port nearest the pointer.
  expect(magnetTarget({ x: 110, y: 125 }, nodes)).toEqual({ id: "Orders", side: "l" });
  // Between two nodes, the nearer one wins.
  const close = [
    { id: "A", box: { x: 0, y: 0, w: 100, h: 50 } },
    { id: "B", box: { x: 130, y: 0, w: 100, h: 50 } },
  ];
  expect(magnetTarget({ x: 120, y: 25 }, close)).toEqual({ id: "B", side: "l" });
});

// ----- drawing a flow

test("drop_on_node_opens_label_box_enter_keeps_esc_unlabelled", async () => {
  const s = setup();
  await drawn(s);
  // Released on Orders: the flow is written at once and a label box opens on it.
  act(() => canvas.props!.onConnectPorts!({ node: "Customer", port: "r" }, { node: "Orders", port: "l" }, false));
  await waitFor(() => expect(s.text()).toContain("Orders --> Checkout: stock level\nCustomer > Orders\n"));
  const box = await screen.findByRole("textbox", { name: "Flow label" });
  expect(box.getAttribute("placeholder")).toBe("Type a label, Enter to keep");
  expect(screen.getByText("New flow: Customer to Orders")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(box));
  await userEvent.type(box, "card details{Enter}");
  await waitFor(() => expect(s.text()).toContain("Customer > Orders: card details\n"));
  expect(screen.queryByRole("textbox", { name: "Flow label" })).toBeNull();
  // Esc leaves the new flow unlabelled.
  act(() => canvas.props!.onConnectPorts!({ node: "Customer", port: "b" }, { node: "Charge card", port: "l" }, false));
  await waitFor(() => expect(s.text()).toContain("Customer > Charge card\n"));
  const second = await screen.findByRole("textbox", { name: "Flow label" });
  await userEvent.type(second, "ignored");
  fireEvent.keyDown(second, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Flow label" })).toBeNull());
  await new Promise((r) => setTimeout(r, 50));
  expect(s.text()).toContain("Customer > Charge card\n");
  expect(s.text()).not.toContain("ignored");
  // A release within 24 px of a node locks onto it: the flow goes there, no menu opens.
  const before = s.text();
  act(() => canvas.props!.onConnectRelease!({ node: "Checkout", port: "r" }, { x: 544 + 20, y: 48 - 20 }));
  await waitFor(() => expect(s.text()).not.toBe(before));
  expect(s.text()).toContain("Checkout > Orders\n");
  expect(screen.queryByRole("menu", { name: "Add and connect" })).toBeNull();
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Flow label" }), { key: "Escape" });
});

test("drop_on_empty_opens_add_and_connect", async () => {
  const s = setup();
  await drawn(s);
  const cases = [
    { key: "s", x: 203, node: "Data store [store, id: D2]\n", link: "Customer > Data store\n" },
    { key: "p", x: 603, node: "Process [process, id: 3.0]\n", link: "Customer > Process\n" },
    { key: "e", x: 1003, node: "Outside party [entity]\n", link: "Customer > Outside party\n" },
  ];
  for (const c of cases) {
    act(() => canvas.props!.onConnectRelease!({ node: "Customer", port: "r" }, { x: c.x, y: 700 }));
    const menu = await screen.findByRole("menu", { name: "Add and connect" });
    expect([...menu.querySelectorAll("[role=menuitem]")].map((b) => b.textContent)).toEqual(["ProcessP", "Data storeS", "Outside partyE"]);
    fireEvent.keyDown(menu, { key: c.key });
    await waitFor(() => expect(s.text()).toContain(c.node));
    expect(s.text()).toContain(c.link);
    expect(screen.queryByRole("menu", { name: "Add and connect" })).toBeNull();
    // The new node lands where the line was released, on the grid; the new flow takes a label.
    const box = await screen.findByRole("textbox", { name: "Flow label" });
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Flow label" })).toBeNull());
  }
  await waitFor(() => expect(s.saves().length).toBeGreaterThan(0));
  await waitFor(() => expect(JSON.parse(s.saves()[s.saves().length - 1].layout).nodes["Data store"]).toEqual({ x: 208, y: 672 }));
});

test("esc_pulls_line_back", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectRelease!({ node: "Customer", port: "r" }, { x: 203, y: 700 }));
  const menu = await screen.findByRole("menu", { name: "Add and connect" });
  expect(s.portal().querySelector(".flow-pending")).not.toBeNull();
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "Add and connect" })).toBeNull();
  // The line pulls back into its port, then goes.
  expect(s.portal().querySelector(".flow-pending.is-pulling")).not.toBeNull();
  await waitFor(() => expect(s.portal().querySelector(".flow-pending")).toBeNull(), { timeout: 3000 });
  expect(s.text()).toBe(DFD);
  // Under reduced motion it goes at once.
  setReducedMotionPref(true);
  act(() => canvas.props!.onConnectRelease!({ node: "Customer", port: "r" }, { x: 203, y: 700 }));
  fireEvent.keyDown(await screen.findByRole("menu", { name: "Add and connect" }), { key: "Escape" });
  expect(s.portal().querySelector(".flow-pending")).toBeNull();
  // A click away from the menu cancels it the same way.
  setReducedMotionPref(false);
  act(() => canvas.props!.onConnectRelease!({ node: "Customer", port: "r" }, { x: 203, y: 700 }));
  await screen.findByRole("menu", { name: "Add and connect" });
  fireEvent.mouseDown(document.body);
  await waitFor(() => expect(screen.queryByRole("menu", { name: "Add and connect" })).toBeNull());
  await waitFor(() => expect(s.portal().querySelector(".flow-pending")).toBeNull(), { timeout: 3000 });
  expect(s.text()).toBe(DFD);
});

// ----- groups

test("group_join_and_leave_rewrite_text", async () => {
  const s = setup();
  await drawn(s);
  // Customer dragged over Payments: the group's edge turns accent; the release joins it.
  act(() => canvas.props!.onDrag!("Customer", 420, 330));
  await waitFor(() => expect(s.portal().querySelector(".flow-group-hot")).not.toBeNull());
  act(() => canvas.props!.onMove!("Customer", 420, 330));
  await waitFor(() => expect(s.text()).toContain("Payments {\n  Charge card [process, id: 2.0]\n  Card network [entity]\n  Customer [entity]\n}"));
  expect(s.text().split("\n").slice(2, 4)).toEqual(["Checkout [process, id: 1.0]", "Orders [store, id: D1, table: shop.orders]"]);
  expect(s.portal().querySelector(".flow-group-hot")).toBeNull();
  await waitFor(() => expect(JSON.parse(s.saves()[s.saves().length - 1].layout).nodes.Customer).toEqual({ x: 416, y: 336 }));
  // The move and the text change are one undo entry.
  act(() => void s.press("z", { ctrlKey: true }));
  await waitFor(() => expect(s.text()).toBe(DFD));
  await waitFor(() => expect(JSON.parse(s.saves()[s.saves().length - 1].layout).nodes.Customer).toEqual(PLACES.Customer));
  // Card network dragged out of Payments and released outside leaves it.
  await waitFor(() => expect(shownAt("Card network")).toEqual(PLACES["Card network"]));
  act(() => canvas.props!.onDrag!("Card network", 960, 640));
  expect(s.portal().querySelector(".flow-group-hot")).toBeNull();
  act(() => canvas.props!.onMove!("Card network", 960, 640));
  await waitFor(() => expect(s.text()).toContain("Orders [store, id: D1, table: shop.orders]\nCard network [entity]\n"));
  expect(s.text()).toContain("Payments {\n  Charge card [process, id: 2.0]\n}");
});

// ----- tidy, zoom, undo, delete

test("tidy_glides_240", async () => {
  const s = setup();
  await drawn(s);
  const from = canvas.renders.length;
  const start = performance.now();
  await userEvent.click(screen.getByRole("button", { name: "Tidy" }));
  await waitFor(() => expect(s.saves().length).toBeGreaterThan(0));
  const target = JSON.parse(s.saves()[s.saves().length - 1].layout).nodes.Customer as { x: number; y: number };
  expect(target).not.toEqual(PLACES.Customer);
  await waitFor(() => expect(shownAt("Customer")).toEqual(target), { timeout: 2000 });
  const path = track("Customer", from);
  // Gliding: drawn at places in between, and it takes the tidy duration, not one frame.
  expect(path.some((p) => between(p.x, PLACES.Customer.x, target.x) || between(p.y, PLACES.Customer.y, target.y))).toBe(true);
  expect(path[path.length - 1].at - start).toBeGreaterThanOrEqual(200);
  expect(s.text()).toBe(DFD);
});

test("tidy_jumps_under_reduced_motion", async () => {
  setReducedMotionPref(true);
  const s = setup();
  await drawn(s);
  const from = canvas.renders.length - 1;
  await userEvent.click(screen.getByRole("button", { name: "Tidy" }));
  await waitFor(() => expect(s.saves().length).toBeGreaterThan(0));
  const target = JSON.parse(s.saves()[s.saves().length - 1].layout).nodes.Customer;
  await waitFor(() => expect(shownAt("Customer")).toEqual(target));
  // The same final place, with nothing in between.
  const path = track("Customer", from);
  expect(path.map(({ x, y }) => ({ x, y }))).toEqual([PLACES.Customer, target]);
});

test("tidy_selection_only_moves_selection", async () => {
  setReducedMotionPref(true);
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onSelect!(["Orders", "Card network"]));
  await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: "Tidy" }));
  await waitFor(() => expect(s.saves().length).toBeGreaterThan(0));
  const nodes = JSON.parse(s.saves()[s.saves().length - 1].layout).nodes;
  for (const n of ["Customer", "Checkout", "Charge card"] as const) expect(nodes[n]).toEqual(PLACES[n]);
  expect([nodes.Orders, nodes["Card network"]]).not.toEqual([PLACES.Orders, PLACES["Card network"]]);
  // The selection stays where it was: its top-left corner does not move.
  expect(Math.min(nodes.Orders.x, nodes["Card network"].x)).toBe(544);
  expect(Math.min(nodes.Orders.y, nodes["Card network"].y)).toBe(48);
});

test("zoom_to_fit_240", async () => {
  const s = setup();
  await drawn(s);
  const percent = () => s.container.querySelector(".canvas-zoom-percent")!.textContent;
  // The first fit has settled.
  await new Promise((r) => setTimeout(r, 600));
  const fitted = percent();
  // Zoom out at once, then fit: one smooth step back, not a jump.
  setReducedMotionPref(true);
  await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  const out = percent();
  expect(out).not.toBe(fitted);
  setReducedMotionPref(false);
  const start = performance.now();
  fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
  expect(percent()).toBe(out);
  await waitFor(() => expect(percent()).toBe(fitted), { timeout: 2000 });
  expect(performance.now() - start).toBeGreaterThanOrEqual(200);
  // Under reduced motion the same fit lands at once.
  setReducedMotionPref(true);
  await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(percent()).not.toBe(fitted);
  fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
  expect(percent()).toBe(fitted);
});

test("undo_glides_and_toasts", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onMove!("Checkout", 400, 208));
  await waitFor(() => expect(shownAt("Checkout")).toEqual({ x: 400, y: 208 }));
  s.press("z", { ctrlKey: true });
  // The layout is back at once, but the node glides there: it starts where it was.
  expect(shownAt("Checkout")).toEqual({ x: 400, y: 208 });
  await waitFor(() => expect(s.container.querySelector(".flow-toast")?.textContent).toBe("Moved Checkout back"));
  await waitFor(() => expect(shownAt("Checkout")).toEqual(PLACES.Checkout), { timeout: 3000 });
  expect(s.text()).toBe(DFD);
  // Under reduced motion the same undo jumps.
  setReducedMotionPref(true);
  act(() => canvas.props!.onMove!("Checkout", 400, 208));
  await waitFor(() => expect(shownAt("Checkout")).toEqual({ x: 400, y: 208 }));
  s.press("z", { ctrlKey: true });
  expect(shownAt("Checkout")).toEqual(PLACES.Checkout);
});

test("delete_fades_then_removes", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.keyDown(s.node("Data store Orders")!, { key: "Enter" });
  await waitFor(() => expect(screen.getByText("Data store, 2 flows")).toBeTruthy());
  // The fade is held open while it is checked: a late check must not find it already over.
  const fade = holdTimers(MOTION.exit);
  s.press("Delete");
  // The node and its lines fade out first; the text still has them.
  await waitFor(() => expect(s.node("Data store Orders")!.querySelector(".fnode-leaving")).not.toBeNull());
  const leaving = canvas.props!.edges.filter((e) => String(e.className).includes("is-leaving")).map((e) => `${e.source}>${e.target}`);
  expect(leaving.sort()).toEqual(["Checkout>Orders", "Orders>Checkout"]);
  expect(s.text()).toContain("Orders [store");
  fade.release();
  await waitFor(() => expect(s.text()).not.toContain("Orders [store"));
  expect(s.text()).not.toContain("> Orders");
  await waitFor(() => expect(s.node("Data store Orders")).toBeNull());
});

// ----- fix round 1 (ruling P20)

test("undo_inside_the_parse_wait_after_delete_leaves_the_node_visible", async () => {
  const s = setup(undefined, waitingWorker);
  await drawn(s);
  fireEvent.keyDown(s.node("Data store Orders")!, { key: "Enter" });
  await waitFor(() => expect(screen.getByText("Data store, 2 flows")).toBeTruthy());
  s.press("Delete");
  await waitFor(() => expect(s.text()).not.toContain("Orders [store"), { interval: 5 });
  // Undone before the worker parsed the delete: one parse holds both texts, and it still has Orders.
  s.press("z", { ctrlKey: true });
  expect(s.text()).toBe(DFD);
  await new Promise((r) => setTimeout(r, 500));
  expect(s.node("Data store Orders")).not.toBeNull();
  expect(s.node("Data store Orders")!.querySelector(".fnode-leaving")).toBeNull();
  expect(canvas.props!.edges.filter((e) => String(e.className).includes("is-leaving"))).toEqual([]);
});

test("undo_after_delete_on_a_faded_drawing_leaves_the_node_visible", async () => {
  const s = setup();
  await drawn(s);
  const view = s.view();
  const at = s.text().indexOf("Charge card: amount");
  act(() => view.dispatch({ changes: { from: at, to: at + "Charge card: amount".length, insert: "Refunds: reversal" } }));
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  fireEvent.keyDown(s.node("Data store Orders")!, { key: "Enter" });
  await waitFor(() => expect(screen.getByText("Data store, 2 flows")).toBeTruthy());
  s.press("Delete");
  await waitFor(() => expect(s.text()).not.toContain("Orders [store"));
  await new Promise((r) => setTimeout(r, 200));
  s.press("z", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toContain("Orders [store"));
  const fix = s.text().indexOf("Refunds: reversal");
  act(() => view.dispatch({ changes: { from: fix, to: fix + "Refunds: reversal".length, insert: "Charge card: amount" } }));
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).toBeNull());
  await new Promise((r) => setTimeout(r, 200));
  expect(s.node("Data store Orders")!.querySelector(".fnode-leaving")).toBeNull();
});

test("delete_is_pinned_to_the_parse_it_was_planned_on", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.keyDown(s.node("Data store Orders")!, { key: "Enter" });
  await waitFor(() => expect(screen.getByText("Data store, 2 flows")).toBeTruthy());
  const fade = holdTimers(MOTION.exit);
  s.press("Delete");
  await waitFor(() => expect(s.node("Data store Orders")!.querySelector(".fnode-leaving")).not.toBeNull());
  // The text changes during the fade: the delete was planned on the old text, so it does nothing.
  const end = s.text().length;
  act(() => s.view().dispatch({ changes: { from: end, to: end, insert: "// note\n" } }));
  fade.release();
  // The fade lets go as the delete ends, worked or not, so the text then shows what it did.
  await waitFor(() => expect(s.node("Data store Orders")?.querySelector(".fnode-leaving") ?? null).toBeNull());
  expect(s.text()).toContain("Orders [store");
  expect(s.node("Data store Orders")).not.toBeNull();
});

test("the_new_flow_is_banded_and_in_accent_while_its_label_box_is_open", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "Customer", port: "r" }, { node: "Orders", port: "l" }, false));
  const box = await screen.findByRole("textbox", { name: "Flow label" });
  await waitFor(() => expect([...s.container.querySelectorAll(".cm-line.cm-flow-band")].map((e) => e.textContent)).toEqual(["Customer > Orders"]));
  const fresh = () => canvas.props!.edges.filter((e) => String(e.className).includes("is-new")).map((e) => `${e.source}>${e.target}`);
  expect(fresh()).toEqual(["Customer>Orders"]);
  fireEvent.keyDown(box, { key: "Escape" });
  await waitFor(() => expect(s.container.querySelectorAll(".cm-line.cm-flow-band")).toHaveLength(0));
  expect(fresh()).toEqual([]);
});

test("the_label_lands_on_the_flow_just_drawn_when_an_identical_one_exists", async () => {
  // An identical unlabelled flow already sits in a group block after the place a new outside flow is written.
  const s = setup({ text: `${DFD}Later {\n  Customer > Orders\n}\n`, layout: LAYOUT });
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "Customer", port: "r" }, { node: "Orders", port: "l" }, false));
  const box = await screen.findByRole("textbox", { name: "Flow label" });
  await userEvent.type(box, "settle{Enter}");
  await waitFor(() => expect(s.text()).toContain("Orders --> Checkout: stock level\nCustomer > Orders: settle\n"));
  expect(s.text()).toContain("Later {\n  Customer > Orders\n}");
});

test("a_glide_frame_moves_only_the_gliding_nodes", async () => {
  const s = setup();
  await drawn(s);
  const from = canvas.renders.length;
  await userEvent.click(screen.getByRole("button", { name: "Tidy" }));
  await waitFor(() => expect(s.saves().length).toBeGreaterThan(0));
  await waitFor(() => expect(canvas.props!.livePositions ?? null).toBeNull(), { timeout: 3000 });
  const during = canvas.renders.slice(from).filter((r) => r.live);
  // Frames change only the live positions; the node list is built once for the new layout.
  expect(new Set(during.map((r) => r.live)).size).toBeGreaterThanOrEqual(2);
  expect(new Set(during.map((r) => r.nodes)).size).toBe(1);
});

test("a_new_node_fades_in_on_the_enter_curve", () => {
  expect(flowCanvasCss).toMatch(/\.fnode:not\(\.fnode-leaving\)\s*\{[^}]*opacity var\(--motion-base\) var\(--ease-enter\)[^}]*transform var\(--motion-base\) var\(--ease-enter\)/);
});
