import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type Edge, getViewportForBounds, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { afterEach, beforeAll, expect, onTestFinished, test, vi } from "vitest";
import { LIVE_ANCHOR_ID } from "../flow/board/boardScene";
import { mockReactFlowDom } from "../test/reactFlow";
import { type CanvasHandle, type CanvasView, LIVE_ANCHOR, MAX_ZOOM, MIN_ZOOM } from "./canvasView";
import CardFrame, { Ports } from "./CardFrame";
import DiagramCanvas, { SKETCH_LAYER } from "./DiagramCanvas";
import { detailFor, useDetail } from "./detail";
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

/** A node that shows the level of detail its canvas provides. */
function Probe({ id }: NodeProps) {
  const { detail, fast } = useDetail();
  return <div data-testid={`probe-${id}`} data-detail={detail} data-fast={String(fast)} />;
}
const probeTypes = { card: TestCard, probe: Probe };
const probe = (id: string, x: number, y = 0): Node => ({ id, type: "probe", position: { x, y }, initialWidth: 100, initialHeight: 48, data: {} });
/** Nodes the canvas counts but never mounts: jsdom pays for every mounted node, the count is what is under test. */
const fillers = (n: number) => Array.from({ length: n }, (_, i): Node => ({ ...probe(`n${i}`, 5000 + (i % 50) * 200, Math.floor(i / 50) * 100), hidden: true }));
const probeReads = (id = "p") => {
  const el = screen.getByTestId(`probe-${id}`);
  return { detail: el.dataset.detail, fast: el.dataset.fast === "true" };
};

test("legacy_canvases_keep_their_swaps", async () => {
  // Ruling 4: every canvas but a board keeps detail.ts's swaps (no detailPolicy is the legacy policy).
  const { flow, unmount } = renderCanvas([card("stores", 0)]);
  await waitFor(() => expect(percent()).toBe("100%"));
  await act(async () => {
    await flow().setViewport({ x: 0, y: 0, zoom: 0.3 });
  });
  expect(document.querySelector(".card-box")).not.toBeNull();
  await act(async () => {
    await flow().setViewport({ x: 0, y: 0, zoom: 0.1 });
  });
  expect(document.querySelector(".card-block")).not.toBeNull();
  unmount();
  // Over FAST_OVER nodes the canvas is fast at any zoom.
  const many = [probe("p", 0), ...fillers(300)];
  const again = renderCanvas(many, { nodeTypes: probeTypes });
  await waitFor(() => expect(again.flow()).toBeTruthy());
  await act(async () => {
    await again.flow().setViewport({ x: 0, y: 0, zoom: 1 });
  });
  await waitFor(() => expect(probeReads()).toEqual({ detail: "box", fast: true }));
  expect(document.querySelector(".diagram-canvas.is-fast")).not.toBeNull();
});

test("the_board_policy_is_full_at_any_count_and_zoom", async () => {
  // Decision 1: a board draws full at every zoom and node count.
  const many = [probe("p", 0), ...fillers(2000)];
  const { flow } = renderCanvas(many, { nodeTypes: probeTypes, detailPolicy: "board" });
  await waitFor(() => expect(flow()).toBeTruthy());
  await act(async () => {
    await flow().setViewport({ x: 0, y: 0, zoom: 0.1 });
  });
  await waitFor(() => expect(screen.getByTestId("probe-p")).toBeTruthy());
  expect(probeReads()).toEqual({ detail: "full", fast: false });
  expect(document.querySelector(".diagram-canvas.is-fast")).toBeNull();
});

/** Each card id ever mounted, for the board's mount count. */
const mounted = new Set<string>();
function CountedCard({ id }: NodeProps) {
  useEffect(() => {
    mounted.add(id);
  }, [id]);
  return <div className="counted-card" />;
}

test("a_board_mounts_only_the_shapes_in_view", async () => {
  // The release milestone (Plan F Task 3): React Flow draws every node it has never measured, whatever is on screen, so
  // a live 2,000-table ERD mounted all 2,000 full cards at open. A board gives each new shape its four side handles
  // (React Flow's `handles`), so only the shapes in view mount. The fit of this grid (the ERD's: 50 a row, 260 by
  // 520 apart, 240 by 480 each) lands at the least zoom, 10 percent, where the 800 by 600 view holds at most
  // 32 x 13 = 416 cards; the view at 100 percent before the fit adds a few.
  mounted.clear();
  const cards = Array.from({ length: 2000 }, (_, i): Node => ({ id: `t${i}`, type: "counted", position: { x: (i % 50) * 260, y: Math.floor(i / 50) * 520 }, initialWidth: 240, initialHeight: 480, data: {} }));
  const { flow } = renderCanvas(cards, { nodeTypes: { counted: CountedCard }, detailPolicy: "board" });
  await waitFor(() => expect(flow().getViewport().zoom).toBeCloseTo(0.1, 5));
  await new Promise((r) => setTimeout(r, 50));
  expect(mounted.size).toBeGreaterThan(0);
  expect(mounted.size).toBeLessThan(440);
});

test("a_drawing_too_big_for_the_least_zoom_opens_at_its_start", async () => {
  // B3's ER limit board, written to a file, opened on an empty view: the fit, held at 10 percent, centred the bounds of
  // 40 frames in a row and an ERD far right and tall, and nothing was there. A drawing too big to fit opens at its
  // top left instead (a page larger than the window opens at its start, as draw.io and every document viewer do); a
  // side that fits is still centred.
  const { flow } = renderCanvas([card("first", 0, 0), card("far", 200000, 20000)]);
  await waitFor(() => expect(flow().getViewport().zoom).toBeCloseTo(0.1, 5));
  const { x, y, zoom } = flow().getViewport();
  // The first card is on screen, a margin in from the top left.
  expect(x).toBeGreaterThan(0);
  expect(y).toBeGreaterThan(0);
  expect(x + CARD_WIDTH * zoom).toBeLessThan(800);
  expect(y).toBeLessThan(60);
  // Only the side that does not fit moves: a wide, short drawing keeps its rows centred.
  const wide = renderCanvas([card("a", 0, 0), card("b", 200000, 0)]);
  await waitFor(() => expect(wide.flow().getViewport().zoom).toBeCloseTo(0.1, 5));
  const v = wide.flow().getViewport();
  expect(v.x).toBeLessThan(60);
  expect(v.y + (cardHeight(COLS.length) * v.zoom) / 2).toBeCloseTo(300, 0);
});

test("a_small_diagram_fits_at_100_percent", async () => {
  renderCanvas([card("stores", 0)]);
  await waitFor(() => expect(percent()).toBe("100%"));
  expect(document.querySelectorAll(".table-card-column")).toHaveLength(5);
});

test("the_fit_takes_sketches_at_their_board_place_not_their_layer", async () => {
  // A board's sketch layer sits at -origin with no size; its sketches are drawn from it at their board places.
  const layer: Node = { id: "\u0000sketches", position: { x: -3000, y: 0 }, width: 0, height: 0, style: { width: 0, height: 0, pointerEvents: "none" }, data: {} };
  const sketch: Node = { id: "\u0000sketch:s1", parentId: "\u0000sketches", position: { x: 3000, y: 0 }, initialWidth: 100, initialHeight: 60, data: {} };
  renderCanvas([layer, sketch, card("stores", 0)]);
  // Everything drawn is near the origin: the fit stays at 100 percent.
  await waitFor(() => expect(percent()).toBe("100%"));
});

test("the_live_anchor_mirror_matches", () => {
  // diagram/ never imports flow/: the canvas mirrors the board's live anchor id, as it mirrors the sketch layer's.
  expect(LIVE_ANCHOR).toBe(LIVE_ANCHOR_ID);
  expect(LIVE_ANCHOR).toBe("\u0000live");
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
  const before = flow()!.getViewport();
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

test("a_board_card_moved_after_it_is_measured_keeps_its_column_ports", async () => {
  // A board gives a shape it has never measured four side handles (`withHandles`) so React Flow mounts only those in
  // view. Once measured, the side handles must leave the node: every later change (the measure itself, a select, a
  // move) hands React Flow a new node, and a node still carrying `handles` had its measured ports replaced by the four
  // sides, so a drag from a column port found no handle and silently did nothing.
  const onConnectPorts = vi.fn();
  const onDragOver = vi.fn();
  const { container, flow } = renderCanvas([card("orders", 0), card("stores", 320)], { onConnectPorts, onDragOver, onMove: () => {}, detailPolicy: "board" });
  await waitFor(() => expect(container.querySelectorAll(".react-flow__handle").length).toBeGreaterThan(0));
  await waitFor(() => expect(percent()).toBe("100%"));
  const ids = () => (flow().getInternalNode("orders")?.internals.handleBounds?.source ?? []).map((h) => h.id);
  // Selected, then moved.
  fireEvent.click(container.querySelector('.react-flow__node[data-id="orders"]')!);
  await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="orders"]')!.classList.contains("selected")).toBe(true));
  dragBy(container, "orders", 30, 20);
  await new Promise((r) => setTimeout(r, 20));
  expect(ids()).toContain("city:s");
  expect(flow().getNodes().every((n) => !n.measured || !n.handles)).toBe(true);
  // A drag from a column port starts a line.
  const handle = (node: string, id: string) => container.querySelector(`.react-flow__node[data-id="${node}"] .react-flow__handle[data-handleid="${id}"]`)!;
  dragPort(handle("orders", "city:s"), handle("stores", "id:t"));
  await waitFor(() => expect(onDragOver).toHaveBeenLastCalledWith(expect.objectContaining({ from: { nodeId: "orders", column: "city" } })));
  fireEvent.mouseUp(document, { clientX: 300, clientY: 40 });
  expect(onConnectPorts).toHaveBeenCalledWith({ node: "orders", port: "city" }, { node: "stores", port: "id" }, false, AT);
});

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

test("a_sketch_drag_snaps_and_guides_in_board_coordinates", async () => {
  // A board's sketch is a child of the layer at -origin (Plan B Task 11): its position is on the board, its place on
  // the canvas the layer's plus its own. With the live frame at (600, 300) the guides and the snap use the canvas place.
  const onMove = vi.fn();
  const layer: Node = { id: SKETCH_LAYER, type: "card", position: { x: -600, y: -300 }, width: 0, height: 0, data: { name: "", cols: [] }, selectable: false, draggable: false };
  const sketch: Node = { ...card("sk", 637, 353), parentId: SKETCH_LAYER };
  const { container } = renderCanvas([layer, sketch, card("stores", 450, 200)], { onMove });
  await waitFor(() => expect(percent()).toBe("100%"));
  const el = [...container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === "sk")!;
  mouse("mousedown", el, { clientX: 10, clientY: 10, button: 0 });
  mouse("mousemove", window, { clientX: 12, clientY: 10 });
  // Its top edge goes to 197 on the canvas, 3 px from stores' 200: a guide at y 200, and it snaps there.
  mouse("mousemove", window, { clientX: 15, clientY: 154 });
  const lines = [...container.querySelectorAll(".diagram-guides line")];
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.some((l) => l.getAttribute("y1") === "200" && l.getAttribute("y2") === "200")).toBe(true);
  mouse("mouseup", window, { clientX: 15, clientY: 154 });
  await waitFor(() => expect(onMove).toHaveBeenCalledTimes(1));
  // Reported on the board, as the layer's child: 300 + 200.
  expect(onMove.mock.calls[0].slice(0, 3)).toEqual(["sk", 640, 500]);
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

test("an_unchanged_node_keeps_its_object_when_another_changes", async () => {
  // Task 18b: a board's switch hands the canvas 1,000 unchanged sketches and 49 unchanged frames; React Flow skips a
  // node whose object is the one it has, so only what changed draws again.
  let inst: ReactFlowInstance | null = null;
  const a = card("a", 0);
  const b = card("b", 400);
  const ui = (nodes: Node[]) => (
    <div style={{ width: 800, height: 600 }}>
      <DiagramCanvas nodes={nodes} edges={[]} nodeTypes={nodeTypes} onInit={(i) => (inst = i)} />
    </div>
  );
  const { rerender } = render(ui([a, b]));
  await waitFor(() => expect(inst?.getNode("a")?.measured).toBeTruthy());
  const was = inst!.getNode("a");
  const wasB = inst!.getNode("b");
  rerender(ui([a, { ...b, data: { name: "b", cols: ["id"] } }]));
  await waitFor(() => expect((inst!.getNode("b")!.data as CardData).cols).toEqual(["id"]));
  expect(inst!.getNode("a")).toBe(was);
  expect(inst!.getNode("b")).not.toBe(wasB);
});

test("glide_view_reports_its_target_first", async () => {
  // Plan F Decision 8: a glide reports where it lands once, before the view moves, then nothing more until it is there.
  const seen: { v: CanvasView; landing: boolean; at: { x: number; y: number; zoom: number } }[] = [];
  let handle: CanvasHandle | null = null;
  let flow: () => ReactFlowInstance | null = () => null;
  const r = renderCanvas([card("a", 0), card("b", 900, 500)], {
    onViewChange: (v, landing) => seen.push({ v, landing, at: flow()?.getViewport() ?? { x: 0, y: 0, zoom: 0 } }),
    onCanvasReady: (h) => (handle = h),
  });
  flow = r.flow;
  await waitFor(() => expect(handle).not.toBeNull());
  // The first fit has landed and been reported.
  await waitFor(() => expect(seen.length).toBeGreaterThan(0));
  await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
  const before = flow()!.getViewport();
  seen.length = 0;
  await act(async () => handle!.glideView({ center: { x: 500, y: 300 }, zoom: 2 }));
  await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
  // One report, the landing view in flow units (800 by 600 pane at 200 percent), made while the view was still where it was.
  expect(seen).toHaveLength(1);
  expect(seen[0].landing).toBe(true);
  expect(seen[0].v).toEqual({ x: 300, y: 150, w: 400, h: 300, zoom: 2 });
  expect(seen[0].at).toEqual(before);
  expect(flow()!.getViewport()).toEqual({ x: -600, y: -300, zoom: 2 });
  // Bounds: React Flow's fit of them, reported the same way.
  seen.length = 0;
  const b = { x: 0, y: 0, width: 1600, height: 1200 };
  await act(async () => handle!.glideView({ bounds: b, padding: 0.1 }));
  const fit = getViewportForBounds(b, 800, 600, MIN_ZOOM, MAX_ZOOM, 0.1);
  expect(seen).toHaveLength(1);
  expect(seen[0].landing).toBe(true);
  expect(seen[0].v.zoom).toBeCloseTo(fit.zoom, 6);
  expect(seen[0].v.x).toBeCloseTo(-fit.x / fit.zoom, 6);
  expect(seen[0].v.w).toBeCloseTo(800 / fit.zoom, 6);
  // A pan that is not a glide is reported once per animation frame, not landing.
  seen.length = 0;
  act(() => {
    for (let i = 0; i < 5; i++) void flow()!.setViewport({ x: -10 * i, y: 0, zoom: 1 });
  });
  await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ landing: false, v: { x: 40, y: 0, w: 800, h: 600, zoom: 1 } });
});

/** Motion on for one test: glides take their 240 ms. */
function motionOn() {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  onTestFinished(() => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  });
}

test("a_wheel_during_a_glide_is_reported_at_once", async () => {
  // Review Minor 2: a pan or wheel zoom that cuts a glide short is the view from then on, not after the glide's fallback.
  const seen: { v: CanvasView; landing: boolean; t: number }[] = [];
  let handle: CanvasHandle | null = null;
  const { container } = renderCanvas([card("a", 0), card("b", 900, 500)], {
    onViewChange: (v, landing) => seen.push({ v, landing, t: performance.now() }),
    onCanvasReady: (h) => (handle = h),
  });
  await waitFor(() => expect(handle).not.toBeNull());
  await waitFor(() => expect(seen.length).toBeGreaterThan(0));
  motionOn();
  seen.length = 0;
  void handle!.glideView({ center: { x: 2000, y: 1500 }, zoom: 2 });
  expect(seen).toHaveLength(1);
  expect(seen[0].landing).toBe(true);
  await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
  const wheelAt = performance.now();
  fireEvent.wheel(container.querySelector(".react-flow__pane")!, { deltaY: 100, clientX: 400, clientY: 300 });
  await waitFor(() => expect(seen.filter((x) => !x.landing).length).toBeGreaterThan(0), { timeout: 1000 });
  // Within a frame or two of the wheel, well before the 290 ms fallback.
  expect(seen.find((x) => !x.landing)!.t - wheelAt).toBeLessThan(150);
});

test("a_glide_cut_by_an_unmount_reports_nothing_after", async () => {
  // Review Minor 3: the fallback timer is cleared, so a tab closed mid-glide is never told about a view.
  let calls = 0;
  let gone = false;
  let late = 0;
  let handle: CanvasHandle | null = null;
  const { unmount } = renderCanvas([card("a", 0)], {
    onViewChange: () => {
      calls++;
      if (gone) late++;
    },
    onCanvasReady: (h) => (handle = h),
  });
  await waitFor(() => expect(handle).not.toBeNull());
  await waitFor(() => expect(calls).toBeGreaterThan(0));
  motionOn();
  void handle!.glideView({ center: { x: 2000, y: 1500 }, zoom: 2 });
  unmount();
  gone = true;
  await act(async () => new Promise((r) => setTimeout(r, 400)));
  expect(late).toBe(0);
});
