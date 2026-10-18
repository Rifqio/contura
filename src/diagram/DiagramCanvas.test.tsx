import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Edge, Node, NodeProps, ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { mockReactFlowDom } from "../test/reactFlow";
import CardFrame, { Ports } from "./CardFrame";
import DiagramCanvas from "./DiagramCanvas";
import { detailFor } from "./detail";
import { JoinBadge, OrthogonalEdge } from "./edges";
import { cardHeight, CARD_WIDTH } from "./metrics";
import type { Port } from "./types";

beforeAll(() => {
  mockReactFlowDom();
  // No fit animation: the view settles at once.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});

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
  expect(onConnectPorts).toHaveBeenCalledWith({ node: "orders", port: "city" }, { node: "stores", port: "id" }, true);
  await waitFor(() => expect(onDragOver).toHaveBeenLastCalledWith(null));

  // Dragged from the target side, the ports still come source first; no Shift, no append.
  dragPort(handle("stores", "name:t"), handle("orders", "id:s"));
  fireEvent.mouseUp(document, { clientX: 300, clientY: 40 });
  expect(onConnectPorts).toHaveBeenLastCalledWith({ node: "orders", port: "id" }, { node: "stores", port: "name" }, false);
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
  expect(onConnectPorts).toHaveBeenCalledWith({ node: "orders", port: "city" }, { node: "stores", port: "id" }, false);
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
    else expect(onConnectPorts).toHaveBeenCalledWith({ node: "orders", port: "city" }, { node: "stores", port: "id" }, false);
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
