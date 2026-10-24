import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Edge, Node, NodeProps, ReactFlowInstance } from "@xyflow/react";
import { useMemo, useState } from "react";
import { afterEach, beforeAll, expect, onTestFinished, test, vi } from "vitest";
import { mockReactFlowDom } from "../test/reactFlow";
import CardFrame, { Ports } from "./CardFrame";
import DiagramCanvas from "./DiagramCanvas";
import { detailFor } from "./detail";
import { JoinBadge, OrthogonalEdge } from "./edges";
import { setReducedMotionPref } from "./motion";
import { cardHeight, CARD_WIDTH } from "./metrics";
import type { Port } from "./types";

beforeAll(() => {
  mockReactFlowDom();
  // No fit animation: the view settles at once.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});

/** Where a port drag was let go, in flow coordinates (onConnectPorts says it since ER build C). */
const AT = expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) });

const realElementFromPoint = document.elementFromPoint;
afterEach(() => {
  document.elementFromPoint = realElementFromPoint;
});

type CardData = { name: string; cols: string[] };

function TestCard({ data, selected }: NodeProps) {
  const d = data as CardData;
  return (
    <CardFrame
      kind="table"
      label={`Table ${d.name}`}
      name={d.name}
      title={<span className="table-card-name">{d.name}</span>}
      count={d.cols.length}
      selected={!!selected}
      rows={d.cols.map((c) => (
        <li key={c} className="table-card-column">
          <Ports column={c} />
          <span>{c}</span>
        </li>
      ))}
    />
  );
}

const nodeTypes = { card: TestCard };
const COLS = ["id", "name", "city", "kind", "opened_at"];

const card = (id: string, x: number, y = 0, cols = COLS): Node => ({
  id,
  type: "card",
  position: { x, y },
  initialWidth: CARD_WIDTH,
  initialHeight: cardHeight(cols.length),
  data: { name: id, cols },
});

function renderCanvas(nodes: Node[], extra: Partial<Parameters<typeof DiagramCanvas>[0]> = {}, edges: Edge[] = []) {
  let flow: ReactFlowInstance | null = null;
  const utils = render(
    <div style={{ width: 800, height: 600 }}>
      <DiagramCanvas
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={(i) => {
          flow = i;
        }}
        {...extra}
      />
    </div>,
  );
  return { ...utils, flow: () => flow! };
}

const percent = () => within(screen.getByRole("group", { name: "Zoom" })).getByText(/^\d+%$/).textContent;

test("detail_follows_zoom_and_count", () => {
  expect(detailFor(1, 10)).toEqual({ detail: "full", fast: false });
  expect(detailFor(0.45, 10)).toEqual({ detail: "full", fast: false });
  expect(detailFor(0.44, 10)).toEqual({ detail: "box", fast: false });
  expect(detailFor(0.14, 10)).toEqual({ detail: "block", fast: false });
  expect(detailFor(1, 300)).toEqual({ detail: "full", fast: false });
  expect(detailFor(1, 301)).toEqual({ detail: "box", fast: true });
  expect(detailFor(0.1, 2000)).toEqual({ detail: "box", fast: true });
});

test("a_small_diagram_fits_at_100_percent", async () => {
  renderCanvas([card("stores", 0)]);
  await waitFor(() => expect(percent()).toBe("100%"));
  expect(document.querySelectorAll(".table-card-column")).toHaveLength(5);
});

test("zoomed_out_a_card_is_a_name_box_without_rows", async () => {
  const { flow } = renderCanvas([card("stores", 0)]);
  await waitFor(() => expect(percent()).toBe("100%"));
  await act(async () => {
    await flow().setViewport({ x: 0, y: 0, zoom: 0.4 });
  });
  expect(percent()).toBe("40%");
  const box = screen.getByRole("group", { name: "Table stores" });
  expect(within(box).getByText("stores")).toBeTruthy();
  expect(within(box).getByText("5 columns")).toBeTruthy();
  expect(document.querySelectorAll(".table-card-column")).toHaveLength(0);
  // The snap grid is shown from 40 percent up.
  expect(document.querySelector(".diagram-grid")).not.toBeNull();
  await act(async () => {
    await flow().setViewport({ x: 0, y: 0, zoom: 0.14 });
  });
  expect(document.querySelector(".card-block")).not.toBeNull();
  expect(screen.queryByText("5 columns")).toBeNull();
  expect(document.querySelector(".diagram-grid")).toBeNull();
});

test("shift_1_fits_and_ctrl_plus_minus_zoom", async () => {
  const { container } = renderCanvas([card("stores", 0)]);
  await waitFor(() => expect(percent()).toBe("100%"));
  const root = container.querySelector(".diagram-canvas") as HTMLElement;
  fireEvent.keyDown(root, { key: "-", code: "Minus", ctrlKey: true });
  await waitFor(() => expect(Number(percent()!.replace("%", ""))).toBeLessThan(100));
  fireEvent.keyDown(root, { key: "!", code: "Digit1", shiftKey: true });
  await waitFor(() => expect(percent()).toBe("100%"));
  fireEvent.keyDown(root, { key: "+", code: "Equal", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(Number(percent()!.replace("%", ""))).toBeGreaterThan(100));
});

test("zoom_buttons_and_keys_jump_under_reduced_motion", async () => {
  // The app preference alone, with the system setting off: zoom in and out are instant, as DESIGN-NEXT 8 says.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  setReducedMotionPref(true);
  try {
    const { container } = renderCanvas([card("stores", 0)]);
    await waitFor(() => expect(percent()).toBe("100%"));
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    });
    expect(Number(percent()!.replace("%", ""))).toBeGreaterThan(100);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    });
    expect(percent()).toBe("100%");
    const root = container.querySelector(".diagram-canvas") as HTMLElement;
    act(() => {
      fireEvent.keyDown(root, { key: "-", code: "Minus", ctrlKey: true });
    });
    expect(Number(percent()!.replace("%", ""))).toBeLessThan(100);
    act(() => {
      fireEvent.keyDown(root, { key: "+", code: "Equal", ctrlKey: true, shiftKey: true });
    });
    expect(percent()).toBe("100%");
  } finally {
    setReducedMotionPref(false);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  }
});

test("the_canvas_has_its_fixed_parts", () => {
  const { container } = renderCanvas([card("stores", 0)]);
  expect(container.querySelector(".react-flow__minimap")).not.toBeNull();
  expect(container.querySelector(".react-flow__attribution")).toBeNull();
  expect(container.querySelector("marker#crow-many")).not.toBeNull();
  expect(container.querySelector("marker#bar-one")).not.toBeNull();
  expect(container.querySelector("marker#arrow")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Fit to view" })).toBeTruthy();
});

/** Drags from one port to another, as React Flow reads it: mouse down on the handle, moves, mouse up over the target. */
function dragPort(from: Element, to: Element) {
  document.elementFromPoint = () => to;
  fireEvent.mouseDown(from, { clientX: 10, clientY: 10, button: 0 });
  fireEvent.mouseMove(document, { clientX: 300, clientY: 40 });
}

test("connecting_two_ports_reports_them_with_shift_from_the_drop", async () => {
  const onConnectPorts = vi.fn<(from: Port, to: Port, shift: boolean) => void>();
  const onDragOver = vi.fn();
  const { container } = renderCanvas([card("orders", 0), card("stores", 320)], { onConnectPorts, onDragOver });
  await waitFor(() => expect(container.querySelectorAll(".react-flow__handle").length).toBeGreaterThan(0));
  const handle = (node: string, id: string) => container.querySelector(`.react-flow__node[data-id="${node}"] .react-flow__handle[data-handleid="${id}"]`)!;
  dragPort(handle("orders", "city:s"), handle("stores", "id:t"));
  await waitFor(() =>
    expect(onDragOver).toHaveBeenLastCalledWith({ from: { nodeId: "orders", column: "city" }, over: { nodeId: "stores", column: "id" } }),
  );
  fireEvent.mouseUp(document, { clientX: 300, clientY: 40, shiftKey: true });
  expect(onConnectPorts).toHaveBeenCalledWith({ node: "orders", port: "city" }, { node: "stores", port: "id" }, true, AT);
  await waitFor(() => expect(onDragOver).toHaveBeenLastCalledWith(null));

  // Dragged from the target side, the ports still come source first; no Shift, no append.
  dragPort(handle("stores", "name:t"), handle("orders", "id:s"));
  fireEvent.mouseUp(document, { clientX: 300, clientY: 40 });
  expect(onConnectPorts).toHaveBeenLastCalledWith({ node: "orders", port: "id" }, { node: "stores", port: "name" }, false, AT);
});

test("esc_cancels_a_column_drag_and_the_drop_does_nothing", async () => {
  const onConnectPorts = vi.fn();
  const onDragOver = vi.fn();
  const onDragCancel = vi.fn();
  const { container } = renderCanvas([card("orders", 0), card("stores", 320)], { onConnectPorts, onDragOver, onDragCancel });
  await waitFor(() => expect(container.querySelectorAll(".react-flow__handle").length).toBeGreaterThan(0));
  const handle = (node: string, id: string) => container.querySelector(`.react-flow__node[data-id="${node}"] .react-flow__handle[data-handleid="${id}"]`)!;
  dragPort(handle("orders", "city:s"), handle("stores", "id:t"));
  await waitFor(() => expect(onDragOver).toHaveBeenLastCalledWith(expect.objectContaining({ over: { nodeId: "stores", column: "id" } })));
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(onDragCancel).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(onDragOver).toHaveBeenLastCalledWith(null));
  // The pointer moves on and is released over the port: nothing is connected.
  fireEvent.mouseMove(document, { clientX: 310, clientY: 40 });
  fireEvent.mouseUp(document, { clientX: 310, clientY: 40 });
  expect(onConnectPorts).not.toHaveBeenCalled();
  // The next drag works as usual.
  dragPort(handle("orders", "city:s"), handle("stores", "id:t"));
  fireEvent.mouseUp(document, { clientX: 300, clientY: 40 });
  expect(onConnectPorts).toHaveBeenCalledWith({ node: "orders", port: "city" }, { node: "stores", port: "id" }, false, AT);
});

test("loose_mode_accepts_a_drop_on_a_right_hand_dot_and_strict_does_not", async () => {
  for (const mode of ["strict", "loose"] as const) {
    const onConnectPorts = vi.fn();
    const { container, unmount } = renderCanvas([card("orders", 0), card("stores", 320)], { onConnectPorts, connectionMode: mode });
    await waitFor(() => expect(container.querySelectorAll(".react-flow__handle").length).toBeGreaterThan(0));
    const handle = (node: string, id: string) => container.querySelector(`.react-flow__node[data-id="${node}"] .react-flow__handle[data-handleid="${id}"]`)!;
    dragPort(handle("orders", "city:s"), handle("stores", "id:s"));
    fireEvent.mouseUp(document, { clientX: 300, clientY: 40 });
    if (mode === "strict") expect(onConnectPorts).not.toHaveBeenCalled();
    else expect(onConnectPorts).toHaveBeenCalledWith({ node: "orders", port: "city" }, { node: "stores", port: "id" }, false, AT);
    unmount();
  }
});

test("backspace_never_removes_a_card", async () => {
  const onSelect = vi.fn();
  const { container } = renderCanvas([card("orders", 0), card("stores", 320)], { onSelect });
  const node = container.querySelector('.react-flow__node[data-id="orders"]') as HTMLElement;
  fireEvent.keyDown(node, { key: "Enter", code: "Enter" });
  fireEvent.keyUp(node, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(["orders"]));
  for (const key of ["Backspace", "Delete"]) {
    fireEvent.keyDown(node, { key, code: key });
    // React Flow acts on the key while it is held: let that render before the key comes up.
    await new Promise((done) => setTimeout(done, 50));
    fireEvent.keyUp(node, { key, code: key });
  }
  expect(container.querySelector('.react-flow__node[data-id="orders"]')).not.toBeNull();
  expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
});

test("read_only_has_no_connectable_ports", async () => {
  const { container } = renderCanvas([card("orders", 0)], { readOnly: true, onConnectPorts: () => {} });
  await waitFor(() => expect(container.querySelectorAll(".react-flow__handle").length).toBeGreaterThan(0));
  expect(container.querySelectorAll(".react-flow__handle.connectable")).toHaveLength(0);
});

test("card_frame_draws_with_tokens_only", async () => {
  const { container } = renderCanvas([card("stores", 0)]);
  await waitFor(() => expect(percent()).toBe("100%"));
  const frame = container.querySelector(".table-card") as HTMLElement;
  expect(frame.getAttribute("style")).toContain("var(--c-node-table-stroke)");
  expect(frame.getAttribute("style")).toContain("var(--c-node-table-fill)");
  const hex = /#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![\w-])/i;
  expect(hex.test(container.innerHTML.replace(/marker id="[^"]*"|url\(#[\w-]+\)/g, ""))).toBe(false);
  for (const el of container.querySelectorAll("[style]")) {
    const style = el.getAttribute("style") ?? "";
    expect({ style, hex: hex.test(style) }).toEqual({ style, hex: false });
  }
});

test("card_frame_tones_and_dashed_border", () => {
  render(
    <div>
      <CardFrame kind="view" label="View v" title="v" count={0} selected={false} rows={null} tone="danger" dashed />
    </div>,
  );
  const frame = screen.getByRole("group", { name: "View v" });
  expect(frame.classList.contains("card-danger")).toBe(true);
  expect(frame.classList.contains("card-dashed")).toBe(true);
  expect(frame.getAttribute("style")).toContain("var(--c-node-view-stroke)");
});

test("an_orthogonal_edge_carries_a_join_badge", async () => {
  const edges: Edge[] = [
    { id: "j1", type: "orthogonal", source: "orders", sourceHandle: "city:s", target: "stores", targetHandle: "id:t", data: { badge: <span>Inner</span> } },
  ];
  renderCanvas([card("orders", 0), card("stores", 320)], {}, edges);
  await waitFor(() => expect(screen.getByText("Inner")).toBeTruthy());
  expect(screen.getByText("Inner").closest(".edge-badge")).not.toBeNull();
  expect(OrthogonalEdge).toBeTypeOf("function");
  expect(JoinBadge).toBeTypeOf("function");
});

test("parity_P11_34_reveal_brings_a_node_outside_the_view_into_it", async () => {
  const { flow, rerender } = renderCanvas([card("stores", 0)]);
  await waitFor(() => expect(percent()).toBe("100%"));
  const far = card("far", 4000, 3000);
  const inView = () => {
    const { x, y, zoom } = flow().getViewport();
    const left = (4000 * zoom + x) | 0;
    const top = (3000 * zoom + y) | 0;
    return left >= 0 && top >= 0 && left < 800 && top < 600;
  };
  rerender(
    <div style={{ width: 800, height: 600 }}>
      <DiagramCanvas nodes={[card("stores", 0), far]} edges={[]} nodeTypes={nodeTypes} onInit={() => {}} />
    </div>,
  );
  expect(inView()).toBe(false);
  const zoom = flow().getViewport().zoom;
  rerender(
    <div style={{ width: 800, height: 600 }}>
      <DiagramCanvas nodes={[card("stores", 0), far]} edges={[]} nodeTypes={nodeTypes} onInit={() => {}} reveal="far" />
    </div>,
  );
  await waitFor(() => expect(inView()).toBe(true));
  // Kept at the zoom it had: only the view moves.
  expect(flow().getViewport().zoom).toBe(zoom);
});

test("parity_P11_34_reveal_leaves_a_node_already_in_view_where_it_is", async () => {
  // Nodes measure at their card size here (the shared mock gives every element 800 by 600).
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  const isNode = (el: HTMLElement) => el.classList.contains("react-flow__node");
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { get(this: HTMLElement) { return isNode(this) ? CARD_WIDTH : 800; }, configurable: true },
    offsetHeight: { get(this: HTMLElement) { return isNode(this) ? cardHeight(COLS.length) : 600; }, configurable: true },
  });
  onTestFinished(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
  });
  const { flow, rerender } = renderCanvas([card("stores", 0), card("near", 300)]);
  await waitFor(() => expect(percent()).toBe("100%"));
  const before = flow().getViewport();
  rerender(
    <div style={{ width: 800, height: 600 }}>
      <DiagramCanvas nodes={[card("stores", 0), card("near", 300)]} edges={[]} nodeTypes={nodeTypes} onInit={() => {}} reveal="near" />
    </div>,
  );
  await act(async () => {});
  expect(flow().getViewport()).toEqual(before);
});

test("a controlled selection settles when the click that picks a card also changes the cards (no update loop)", async () => {
  function Harness() {
    const [selection, setSelection] = useState<string[]>([]);
    const [grown, setGrown] = useState(false);
    const nodes = useMemo(() => [card("orders", 0, 0, grown ? [...COLS, "extra"] : COLS), card("stores", 320)], [grown]);
    return (
      // The same click that React Flow turns into a pick grows the card, as "+ column" on an ER table does.
      <div style={{ width: 800, height: 600 }} onClickCapture={() => setGrown(true)}>
        <DiagramCanvas nodes={nodes} edges={[]} nodeTypes={nodeTypes} selection={selection} onSelect={setSelection} />
        <output data-testid="picked">{selection.join(",")}</output>
      </div>
    );
  }
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const { container } = render(<Harness />);
  const node = () => container.querySelector('.react-flow__node[data-id="orders"]') as HTMLElement;
  await waitFor(() => expect(node()).not.toBeNull());
  fireEvent.click(node());
  await waitFor(() => expect(screen.getByTestId("picked").textContent).toBe("orders"));
  await waitFor(() => expect(node().classList.contains("selected")).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByTestId("picked").textContent).toBe("orders");
  expect(node().classList.contains("selected")).toBe(true);
  expect(errors.mock.calls.some((c) => String(c[0]).includes("Maximum update depth"))).toBe(false);
});

// ---- Diagram build 1: shell quick wins (diagram-ux-research F10, F16, F22, F1)

const zoomNow = () => Number(percent()!.replace("%", ""));

test("F16 a window resize after the first fit keeps the user's view", async () => {
  const { flow } = renderCanvas([card("stores", 0)]);
  await waitFor(() => expect(percent()).toBe("100%"));
  await act(async () => {
    await flow().setViewport({ x: 40, y: 30, zoom: 1.5 });
  });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(flow().getViewport()).toEqual({ x: 40, y: 30, zoom: 1.5 });
});

test("F22 Shift+0 zooms to 100 percent, Shift+2 to the selection, and zoom goes to 400 percent", async () => {
  const { container, flow } = renderCanvas([card("stores", 0), card("far", 3000, 2000)], { selection: ["far"], onSelect: () => {} });
  await waitFor(() => expect(zoomNow()).toBeLessThan(100));
  const root = container.querySelector(".diagram-canvas") as HTMLElement;
  fireEvent.keyDown(root, { key: ")", code: "Digit0", shiftKey: true });
  await waitFor(() => expect(percent()).toBe("100%"));
  // Shift+2: the selected card fills the view, centred on it.
  fireEvent.keyDown(root, { key: "@", code: "Digit2", shiftKey: true });
  await waitFor(() => {
    const { x, y, zoom } = flow().getViewport();
    const cx = (3000 + CARD_WIDTH / 2) * zoom + x;
    const cy = (2000 + cardHeight(COLS.length) / 2) * zoom + y;
    expect([Math.round(cx), Math.round(cy)]).toEqual([400, 300]);
  });
  for (let i = 0; i < 20; i++) fireEvent.keyDown(root, { key: "=", code: "Equal", ctrlKey: true });
  await waitFor(() => expect(percent()).toBe("400%"));
});

test("F10 Shift+click and Ctrl+click add a card to the selection", async () => {
  const onSelect = vi.fn();
  function Harness() {
    const [selection, setSelection] = useState<string[]>([]);
    return (
      <div style={{ width: 800, height: 600 }}>
        <DiagramCanvas
          nodes={[card("a", 0), card("b", 320), card("c", 640)]}
          edges={[]}
          nodeTypes={nodeTypes}
          boxSelect
          selection={selection}
          onSelect={(ids) => {
            onSelect(ids);
            setSelection(ids);
          }}
        />
      </div>
    );
  }
  const { container } = render(<Harness />);
  const node = (id: string) => container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
  await waitFor(() => expect(node("a")).not.toBeNull());
  fireEvent.click(node("a"));
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(["a"]));
  fireEvent.keyDown(document, { key: "Shift", code: "ShiftLeft" });
  fireEvent.click(node("b"), { shiftKey: true });
  fireEvent.keyUp(document, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(["a", "b"]));
  fireEvent.keyDown(document, { key: "Control", code: "ControlLeft" });
  fireEvent.click(node("c"), { ctrlKey: true });
  fireEvent.keyUp(document, { key: "Control", code: "ControlLeft" });
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(["a", "b", "c"]));
});

test("F1 a line can be selected, is drawn selected, and has its own right-click", async () => {
  const onLineSelect = vi.fn();
  const onSelect = vi.fn();
  const onContextMenu = vi.fn();
  const edges: Edge[] = [{ id: "edge:0", type: "orthogonal", source: "orders", target: "stores" }];
  function Harness() {
    const [lines, setLines] = useState<string[]>([]);
    return (
      <div style={{ width: 800, height: 600 }}>
        <DiagramCanvas
          nodes={[card("orders", 0), card("stores", 320)]}
          edges={edges}
          nodeTypes={nodeTypes}
          selection={[]}
          onSelect={onSelect}
          lineSelection={lines}
          onLineSelect={(ids) => {
            onLineSelect(ids);
            setLines(ids);
          }}
          onContextMenu={onContextMenu}
        />
      </div>
    );
  }
  const { container } = render(<Harness />);
  const edge = () => container.querySelector('.react-flow__edge[data-id="edge:0"]') as Element;
  await waitFor(() => expect(edge()).not.toBeNull());
  fireEvent.click(edge());
  await waitFor(() => expect(onLineSelect).toHaveBeenLastCalledWith(["edge:0"]));
  await waitFor(() => expect(edge().classList.contains("selected")).toBe(true));
  fireEvent.contextMenu(edge(), { clientX: 200, clientY: 100 });
  expect(onContextMenu).toHaveBeenLastCalledWith(expect.objectContaining({ node: null, line: "edge:0", screen: { x: 200, y: 100 } }));
  // A click on the empty canvas lets the line go.
  fireEvent.click(container.querySelector(".react-flow__pane") as HTMLElement);
  await waitFor(() => expect(onLineSelect).toHaveBeenLastCalledWith([]));
});

// ---- Fix round 1

test("F16 a window resize keeps the view's centre and zoom", async () => {
  const { flow } = renderCanvas([card("stores", 0)]);
  await waitFor(() => expect(percent()).toBe("100%"));
  await act(async () => {
    await flow().setViewport({ x: 40, y: 30, zoom: 1.5 });
  });
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  onTestFinished(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
  });
  // The window grows by 200 x 100: the middle of the view moves by half of that, and so does the drawing.
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { get: () => 1000, configurable: true },
    offsetHeight: { get: () => 700, configurable: true },
  });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  await waitFor(() => expect(flow().getViewport()).toEqual({ x: 140, y: 80, zoom: 1.5 }));
  await new Promise((r) => setTimeout(r, 300));
  expect(flow().getViewport()).toEqual({ x: 140, y: 80, zoom: 1.5 });
});

/** A mouse event with its view set, as d3-drag reads it (jsdom refuses the test window as `view`). */
function mouse(type: string, target: EventTarget, init: MouseEventInit) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, "view", { get: () => window });
  act(() => {
    target.dispatchEvent(e);
  });
}

test("I2 a Ctrl+drag reports a copy, and the dragged card goes back where it was", async () => {
  const onMove = vi.fn();
  const { container } = renderCanvas([card("orders", 0), card("stores", 320)], { onMove });
  await waitFor(() => expect(percent()).toBe("100%"));
  const node = () => container.querySelector('.react-flow__node[data-id="orders"]') as HTMLElement;
  const at = () => node().style.transform;
  const before = at();
  mouse("mousedown", node(), { clientX: 10, clientY: 10, button: 0 });
  mouse("mousemove", window, { clientX: 60, clientY: 40 });
  mouse("mousemove", window, { clientX: 110, clientY: 70, ctrlKey: true });
  await waitFor(() => expect(at()).not.toBe(before));
  mouse("mouseup", window, { clientX: 110, clientY: 70, ctrlKey: true });
  await waitFor(() => expect(onMove).toHaveBeenCalledTimes(1));
  const [id, x, y, copy] = onMove.mock.calls[0];
  expect([id, copy]).toEqual(["orders", true]);
  expect(x).toBeGreaterThan(0);
  expect(y).toBeGreaterThan(0);
  await waitFor(() => expect(at()).toBe(before));
  // A plain drag is a move: no copy, and the card stays where it was let go.
  mouse("mousedown", node(), { clientX: 10, clientY: 10, button: 0 });
  mouse("mousemove", window, { clientX: 60, clientY: 40 });
  mouse("mousemove", window, { clientX: 110, clientY: 70 });
  mouse("mouseup", window, { clientX: 110, clientY: 70 });
  await waitFor(() => expect(onMove).toHaveBeenCalledTimes(2));
  expect(onMove.mock.calls[1][3]).toBe(false);
  expect(at()).not.toBe(before);
});

// ---- ER step 2.5 and diagram step 5 (erd-ux-research 5.5, F7, F26, F32): guides instead of the grid.

/** A drag of `id` by (dx, dy) screen px at 100 percent, with the keys held on the moves and the release. */
function dragBy(container: HTMLElement, id: string, dx: number, dy: number, keys: MouseEventInit = {}, release = true) {
  const node = container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
  mouse("mousedown", node, { clientX: 10, clientY: 10, button: 0 });
  // React Flow starts a drag once the pointer has gone past 1 px, and moves the card from there.
  mouse("mousemove", window, { clientX: 12, clientY: 10, ...keys });
  mouse("mousemove", window, { clientX: 12 + dx, clientY: 10 + dy, ...keys });
  if (release) mouse("mouseup", window, { clientX: 12 + dx, clientY: 10 + dy, ...keys });
}

test("F7 a dragged card lands where it is let go, on no grid, unless an edge or centre is within 6 px of a neighbour's", async () => {
  const onMove = vi.fn();
  const { container } = renderCanvas([card("orders", 0, 0), card("stores", 450, 200)], { onMove });
  await waitFor(() => expect(percent()).toBe("100%"));
  dragBy(container, "orders", 37, 53);
  await waitFor(() => expect(onMove).toHaveBeenCalledTimes(1));
  expect(onMove.mock.calls[0].slice(0, 3)).toEqual(["orders", 37, 53]);
  // Top edge 197 is 3 px from stores' 200: it snaps, and a guide shows while dragging.
  dragBy(container, "orders", 3, 144, {}, false);
  // Checked at once: React Flow's auto-pan would move a card held still at jsdom's empty bounds.
  expect(container.querySelectorAll(".diagram-guides line").length).toBeGreaterThan(0);
  mouse("mouseup", window, { clientX: 15, clientY: 154 });
  await waitFor(() => expect(onMove).toHaveBeenCalledTimes(2));
  expect(onMove.mock.calls[1].slice(0, 3)).toEqual(["orders", 40, 200]);
  expect(container.querySelectorAll(".diagram-guides line")).toHaveLength(0);
});

test("F7 Alt moves freely with no guides; Shift keeps the axis moved furthest along", async () => {
  const onMove = vi.fn();
  const { container } = renderCanvas([card("orders", 0, 0), card("stores", 450, 200)], { onMove });
  await waitFor(() => expect(percent()).toBe("100%"));
  dragBy(container, "orders", 40, 197, { altKey: true });
  await waitFor(() => expect(onMove).toHaveBeenCalledTimes(1));
  expect(onMove.mock.calls[0].slice(0, 3)).toEqual(["orders", 40, 197]);
  expect(container.querySelectorAll(".diagram-guides line")).toHaveLength(0);
  // From (40, 197): Shift with mostly sideways motion keeps y where it was, and only x may snap.
  dragBy(container, "orders", 9, 6, { shiftKey: true });
  await waitFor(() => expect(onMove).toHaveBeenCalledTimes(2));
  expect(onMove.mock.calls[1].slice(0, 3)).toEqual(["orders", 49, 197]);
});

test("F26 Esc during a drag puts the cards back and nothing is moved", async () => {
  const onMove = vi.fn();
  const { container } = renderCanvas([card("orders", 0, 0), card("stores", 450, 200)], { onMove });
  await waitFor(() => expect(percent()).toBe("100%"));
  const node = () => container.querySelector('.react-flow__node[data-id="orders"]') as HTMLElement;
  const before = node().style.transform;
  dragBy(container, "orders", 80, 60, {}, false);
  await waitFor(() => expect(node().style.transform).not.toBe(before));
  act(() => {
    fireEvent.keyDown(window, { key: "Escape" });
  });
  await waitFor(() => expect(node().style.transform).toBe(before));
  mouse("mousemove", window, { clientX: 200, clientY: 200 });
  mouse("mouseup", window, { clientX: 200, clientY: 200 });
  await new Promise((r) => setTimeout(r, 30));
  expect(onMove).not.toHaveBeenCalled();
  expect(node().style.transform).toBe(before);
});

// ---- Fix round 1 (I6, M1, M3): every canvas nudges 1 px and Shift 16 px, keeps whole pixels, and an aborted drag
// leaves no Esc trap.

test("I6 arrows nudge the selected card 1 px, Shift 16 px, reported once when the key goes up", async () => {
  const onMove = vi.fn();
  const { container } = renderCanvas([card("orders", 0, 0), card("stores", 450, 200)], { onMove });
  await waitFor(() => expect(percent()).toBe("100%"));
  const node = () => container.querySelector('.react-flow__node[data-id="orders"]') as HTMLElement;
  fireEvent.click(node());
  await waitFor(() => expect(node().classList.contains("selected")).toBe(true));
  fireEvent.keyDown(node(), { key: "ArrowRight" });
  fireEvent.keyUp(node(), { key: "ArrowRight" });
  expect(onMove.mock.calls).toEqual([["orders", 1, 0, false]]);
  fireEvent.keyDown(node(), { key: "ArrowDown", shiftKey: true });
  for (let i = 0; i < 3; i++) fireEvent.keyDown(node(), { key: "ArrowDown", shiftKey: true, repeat: true });
  // Held: drawn at once, reported once.
  expect(onMove).toHaveBeenCalledTimes(1);
  fireEvent.keyUp(node(), { key: "ArrowDown" });
  expect(onMove.mock.calls[1]).toEqual(["orders", 1, 64, false]);
});

test("M3 a drag at a fractional zoom reports whole pixels", async () => {
  const onMove = vi.fn();
  const { container, flow } = renderCanvas([card("orders", 0, 0), card("stores", 450, 200)], { onMove });
  await waitFor(() => expect(percent()).toBe("100%"));
  await act(async () => {
    await flow().setViewport({ x: 0, y: 0, zoom: 0.75 });
  });
  dragBy(container, "orders", 10, 7, { altKey: true });
  await waitFor(() => expect(onMove).toHaveBeenCalledTimes(1));
  const [, x, y] = onMove.mock.calls[0];
  expect([x, y]).toEqual([Math.round(x), Math.round(y)]);
});

// Fix round 1c (N1): React Flow's own keyboard move never runs, with or without a modifier, so the card drawn and
// the card kept never part: a later drag starts from where the card really is.
test("N1 Ctrl, Alt or Meta with an arrow on a focused card moves nothing, inside React Flow too", async () => {
  const onMove = vi.fn();
  const { container } = renderCanvas([card("orders", 0, 0), card("stores", 450, 200)], { onMove });
  await waitFor(() => expect(percent()).toBe("100%"));
  const node = () => container.querySelector('.react-flow__node[data-id="orders"]') as HTMLElement;
  fireEvent.click(node());
  await waitFor(() => expect(node().classList.contains("selected")).toBe(true));
  for (const mod of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
    fireEvent.keyDown(node(), { key: "ArrowRight", ...mod });
    fireEvent.keyUp(node(), { key: "ArrowRight", ...mod });
  }
  expect(onMove).not.toHaveBeenCalled();
  // A drag now starts from 0, 0: no hidden 5 or 20 px.
  dragBy(container, "orders", 30, 20, { altKey: true });
  await waitFor(() => expect(onMove).toHaveBeenCalledTimes(1));
  expect(onMove.mock.calls[0].slice(0, 3)).toEqual(["orders", 30, 20]);
});
