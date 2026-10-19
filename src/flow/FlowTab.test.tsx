import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeAll, expect, onTestFinished, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { LangClient } from "../lang/client";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import { flowEntry } from "./flowRegistry";
import FlowTab from "./FlowTab";
import { usePendingEditsGuard } from "../app/usePendingEditsGuard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The real canvas draws; the test also keeps its latest props, to drive what jsdom cannot (a drag, a drawn flow).
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

/** Frame 6+.2's diagram. */
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

/** Frame 6+.3: line 14 sends a flow to a name that has no node. */
const BROKEN = DFD.replace("Checkout > Charge card: amount", "Checkout > Refunds: reversal");

const FLOWCHART = ['diagram flow "Refund request"', "", "Request in [start]", "Within 30 days? [decision]", "Done [end]", "", "Request in > Within 30 days?", "Within 30 days? > Done: yes", ""].join("\n");

const CLOUD = ['diagram cloud "Order API"', "Users [icon: users]", "API Gateway [icon: aws-api-gateway]", "Users > API Gateway: HTTPS", ""].join("\n");

type Files = { text: string; layout: string | null };

function setup(
  files: Files | ((name: string) => Files) = { text: DFD, layout: null },
  name = "checkout",
  opts: { write?: (args: Record<string, unknown>) => unknown } = {},
) {
  const read = typeof files === "function" ? files : () => files;
  routeInvoke({
    read_diagram: ({ name: n }) => read(n as string),
    write_diagram: opts.write ?? (() => null),
    write_diagram_layout: opts.write ?? (() => null),
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name={name} client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const text = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const saves = () => allSaves();
  const lastSave = () => saves()[saves().length - 1];
  const type = (insert: string, from = 0, to = view().state.doc.length) => act(() => view().dispatch({ changes: { from, to, insert } }));
  return { ...utils, client, view, text, node, canvasEl, press, saves, lastSave, type };
}

type Setup = ReturnType<typeof setup>;

/** Every save in order: a text save (`write_diagram`) or a layout-only one (`write_diagram_layout`, no text). */
type Save = { cmd: "write_diagram" | "write_diagram_layout"; name: string; text?: string; layout: string; overwrite?: boolean };
function allSaves(): Save[] {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([c]) => c === "write_diagram" || c === "write_diagram_layout")
    .map(([c, a]) => ({ cmd: c, ...(a as object) }) as Save);
}

/** The tab drawn: its first node is on the canvas. */
async function drawn(s: Setup, label = "Process Checkout") {
  await waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });
}

/** Selects a node as the keyboard does: focus it, press Enter. */
function select(s: Setup, label: string) {
  fireEvent.keyDown(s.node(label)!, { key: "Enter" });
}

const banded = (c: HTMLElement) => [...c.querySelectorAll(".cm-line.cm-flow-band")].map((e) => e.textContent);

test("opening_renders_text_and_canvas", async () => {
  const s = setup();
  await drawn(s);
  expect(callsTo("read_diagram")).toEqual([{ name: "checkout" }]);
  expect(s.text()).toBe(DFD);
  for (const label of ["Outside party Customer", "Process Checkout", "Data store Orders", "Process Charge card", "Outside party Card network"]) {
    expect(s.node(label)).not.toBeNull();
  }
  expect(s.container.querySelector('[aria-label="Group Payments"]')).not.toBeNull();
  const text = s.container.querySelector(".flow-pane-text") as HTMLElement;
  expect(within(text).getByText("Data flow")).toBeTruthy();
  expect(within(text).getByText("Saved")).toBeTruthy();
  expect(within(text).getByText("No problems")).toBeTruthy();
  expect(within(text).getByText("5 nodes, 5 flows")).toBeTruthy();
  // Modern by default: the pastel card.
  expect(s.node("Process Checkout")!.querySelector(".fnode-modern")).not.toBeNull();
  // Nothing is written by opening.
  expect(s.saves()).toEqual([]);
});

test("selecting_a_node_bands_its_line_and_clicking_a_line_selects_its_node", async () => {
  const s = setup();
  await drawn(s);
  const strip = s.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  expect(within(strip).getByText("Nothing selected")).toBeTruthy();
  select(s, "Process Checkout");
  await waitFor(() => expect(banded(s.container)).toEqual(["Checkout [process, id: 1.0]"]));
  expect(within(strip).getByText("Checkout")).toBeTruthy();
  expect(within(strip).getByText("1.0")).toBeTruthy();
  expect(within(strip).getByText("Process, 4 flows")).toBeTruthy();
  // Clicking line 5 selects Orders, and its line is banded instead.
  const line5 = s.view().state.doc.line(5);
  act(() => s.view().dispatch({ selection: { anchor: line5.from + 2 }, userEvent: "select.pointer" }));
  await waitFor(() => expect(within(strip).getByText("Orders")).toBeTruthy());
  await waitFor(() => expect(banded(s.container)).toEqual(["Orders [store, id: D1, table: shop.orders]"]));
  await waitFor(() => expect(s.node("Data store Orders")!.classList.contains("selected")).toBe(true));
  expect(s.node("Process Checkout")!.classList.contains("selected")).toBe(false);
  // A line with no node on it (a flow) leaves the selection as it is.
  const line12 = s.view().state.doc.line(12);
  act(() => s.view().dispatch({ selection: { anchor: line12.from + 1 }, userEvent: "select.pointer" }));
  await new Promise((r) => setTimeout(r, 50));
  expect(within(strip).getByText("Orders")).toBeTruthy();
});

test("a_move_writes_only_the_layout", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onMove!("Checkout", 400, 208));
  await waitFor(() => expect(s.saves()).toHaveLength(1));
  const saved = s.lastSave();
  // Only the layout file: the .flow is not written, so an outside edit to it survives (P24 I1).
  expect(saved).toMatchObject({ cmd: "write_diagram_layout", name: "checkout" });
  expect(saved.text).toBeUndefined();
  expect(callsTo("write_diagram")).toHaveLength(0);
  expect(JSON.parse(saved.layout).nodes.Checkout).toEqual({ x: 400, y: 208 });
  expect(s.text()).toBe(DFD);
  // The move is its own entry in the one history: undo puts it back and leaves the text alone.
  const before = JSON.parse(saved.layout).nodes.Customer;
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.saves()).toHaveLength(2));
  expect(JSON.parse(s.lastSave().layout).nodes.Checkout).not.toEqual({ x: 400, y: 208 });
  expect(JSON.parse(s.lastSave().layout).nodes.Customer).toEqual(before);
  expect(s.text()).toBe(DFD);
});

test("add_connect_rename_and_delete_from_the_canvas_each_rewrite_the_text", async () => {
  const s = setup();
  await drawn(s);
  // Add: P adds a process with the next free id.
  s.press("p");
  await waitFor(() => expect(s.text()).toContain("Process [process, id: 3.0]\n"));
  expect(s.text().split("\n").slice(0, 6)).toEqual(['diagram dfd "Checkout"', "", "Customer [entity]", "Checkout [process, id: 1.0]", "Orders [store, id: D1, table: shop.orders]", "Process [process, id: 3.0]"]);
  // Connect: a flow drawn from Customer to Orders.
  act(() => canvas.props!.onConnectPorts!({ node: "Customer", port: "r" }, { node: "Orders", port: "l" }, false));
  await waitFor(() => expect(s.text()).toContain("Orders --> Checkout: stock level\nCustomer > Orders\n"));
  // Rename: F2 on the selected node.
  await waitFor(() => expect(s.node("Outside party Customer")).not.toBeNull());
  select(s, "Outside party Customer");
  s.press("F2");
  const box = await screen.findByRole("textbox", { name: "Rename Customer" });
  await userEvent.clear(box);
  await userEvent.type(box, "Shopper{Enter}");
  await waitFor(() => expect(s.text()).toContain("Shopper [entity]\n"));
  expect(s.text()).toContain("Shopper > Checkout: order details\n");
  expect(s.text()).toContain("Shopper > Orders\n");
  expect(s.text()).not.toContain("Customer");
  // Delete: the node's line and every flow that touches it.
  await waitFor(() => expect(s.node("Data store Orders")).not.toBeNull());
  select(s, "Data store Orders");
  s.press("Delete");
  await waitFor(() => expect(s.text()).not.toContain("Orders"));
  expect(s.text()).toContain("Checkout [process, id: 1.0]\n");
  // Each change is saved with the layout, through one write.
  await waitFor(() => expect(s.lastSave()?.text).toBe(s.text()));
});

test("undo_after_a_canvas_add_removes_the_line", async () => {
  const s = setup();
  await drawn(s);
  await userEvent.click(screen.getByRole("button", { name: "Add data store" }));
  await waitFor(() => expect(s.text()).toContain("Data store [store, id: D2]\n"));
  act(() => void undo(s.view()));
  expect(s.text()).toBe(DFD);
});

test("canvas_edits_while_text_has_error", async () => {
  // Opened with the error: the problem shows, and an add still writes its line.
  const s = setup({ text: BROKEN, layout: null });
  await waitFor(() => expect(screen.getByText("Refunds is not defined.")).toBeTruthy());
  s.press("e");
  await waitFor(() => expect(s.text()).toContain("Outside party [entity]\n"));
  expect(s.text()).toContain("Checkout > Refunds: reversal\n");
  cleanup();
  // Opened good, then broken by typing: the last good drawing stays (faded) and takes every action.
  const fresh = setup({ text: DFD, layout: null });
  await drawn(fresh);
  const at = fresh.text().indexOf("Charge card: amount");
  fresh.type("Refunds: reversal", at, at + "Charge card: amount".length);
  await waitFor(() => expect(fresh.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  // Add: a new line, while the error stays.
  fresh.press("p");
  await waitFor(() => expect(fresh.text()).toContain("Process [process, id: 3.0]\n"));
  expect(fresh.text()).toContain("Checkout > Refunds: reversal\n");
  // Connect two nodes of the faded drawing.
  act(() => canvas.props!.onConnectPorts!({ node: "Customer", port: "b" }, { node: "Charge card", port: "l" }, false));
  await waitFor(() => expect(fresh.text()).toContain("Customer > Charge card\n"));
  // Rename every use, the broken line included.
  select(fresh, "Process Checkout");
  fresh.press("F2");
  const box = await screen.findByRole("textbox", { name: "Rename Checkout" });
  await userEvent.clear(box);
  await userEvent.type(box, "Pay{Enter}");
  await waitFor(() => expect(fresh.text()).toContain("Pay > Refunds: reversal\n"));
  expect(fresh.text()).toContain("Pay [process, id: 1.0]\n");
  expect(fresh.text()).toContain("Customer > Pay: order details\n");
  expect(fresh.text()).not.toMatch(/Checkout [>[]/);
  // Moves write only the layout file; the text was written by the edits before.
  const before = fresh.text();
  await waitFor(() => expect(fresh.lastSave()?.text).toBe(before));
  const count = fresh.saves().length;
  const texts = callsTo("write_diagram").length;
  act(() => canvas.props!.onMove!("Orders", 640, 96));
  await waitFor(() => expect(fresh.saves().length).toBeGreaterThan(count));
  expect(fresh.lastSave()).toMatchObject({ cmd: "write_diagram_layout", name: "checkout" });
  expect(fresh.lastSave().text).toBeUndefined();
  expect(callsTo("write_diagram")).toHaveLength(texts);
  expect(JSON.parse(fresh.lastSave().layout).nodes.Orders).toEqual({ x: 640, y: 96 });
  expect(fresh.text()).toBe(before);
});

test("an_error_shows_the_faded_last_drawing_and_the_banner_text", async () => {
  const s = setup();
  await drawn(s);
  expect(s.container.querySelector(".flow-stale")).toBeNull();
  const at = s.text().indexOf("Charge card: amount");
  s.type("Refunds: reversal", at, at + "Charge card: amount".length);
  const banner = await screen.findByText("Showing the last drawing that worked. Fix line 14 to update it.");
  expect(banner.closest(".flow-stale")).not.toBeNull();
  expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull();
  // The last good drawing is still there.
  expect(s.node("Process Charge card")).not.toBeNull();
  // The Problems block names the line and offers the fixes.
  const problems = s.container.querySelector(".flow-problems") as HTMLElement;
  expect(within(problems).getByText("Refunds is not defined.")).toBeTruthy();
  expect(within(problems).getByText("Line 14")).toBeTruthy();
  // Frame 6+.3: the plain sentence, and the fix's line shown in grey while it is hovered.
  expect(within(problems).getByText("Checkout sends a flow to a name that has no node, so that flow is left off the drawing.")).toBeTruthy();
  const fix = within(problems).getByRole("button", { name: "Add Refunds as a store" });
  fireEvent.mouseEnter(fix);
  await waitFor(() => expect(s.container.querySelector(".cm-flow-ghost")?.textContent).toContain("Refunds [store"));
  expect(s.text()).not.toContain("Refunds [store");
  fireEvent.mouseLeave(fix);
  await waitFor(() => expect(s.container.querySelector(".cm-flow-ghost")).toBeNull());
  expect(within(s.container.querySelector(".flow-pane-text") as HTMLElement).getByText("1 problem")).toBeTruthy();
  await userEvent.click(within(problems).getByRole("button", { name: "Add Refunds as a store" }));
  await waitFor(() => expect(s.container.querySelector(".flow-stale")).toBeNull());
  expect(s.text()).toContain("Refunds [store");
  expect(s.container.querySelector(".flow-canvas.is-stale")).toBeNull();
  await waitFor(() => expect(within(s.container.querySelector(".flow-pane-text") as HTMLElement).getByText("6 nodes, 5 flows")).toBeTruthy());
});

test("the_strip_tool_bar_tools_and_hints_match_the_artifact", async () => {
  const tools = (c: HTMLElement) => {
    const bar = c.querySelector(".flow-toolbar") as HTMLElement;
    return within(bar)
      .getAllByRole("button")
      .map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-keyshortcuts") ?? "", b.querySelector(".flow-hint")?.textContent ?? ""]);
  };
  const dfd = setup();
  await drawn(dfd);
  expect(tools(dfd.container)).toEqual([
    ["Select", "", "Select"],
    ["Add process", "P", "Add processP"],
    ["Add data store", "S", "Add data storeS"],
    ["Add outside party", "E", "Add outside partyE"],
    ["Shapes", "", "Every shape and line"],
    ["Modern", "", "Modern"],
    ["Textbook shapes (Gane-Sarson)", "", "Textbook shapes (Gane-Sarson)"],
    ["Tidy", "", "Tidy"],
  ]);
  const strip = () => dfd.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  expect(within(strip()).getByText("Nothing selected")).toBeTruthy();
  expect(within(strip()).getByRole("button", { name: "Publish" })).toBeTruthy();
  expect(within(strip()).queryByRole("button", { name: "Icon credits" })).toBeNull();
  // The empty flow's card.
  cleanup();
  const empty = setup({ text: 'diagram dfd "New"\n', layout: null }, "new");
  expect(await screen.findByText("Add the first node")).toBeTruthy();
  expect(screen.getByText("Press P, S or E, or click here")).toBeTruthy();
  expect(empty.container.querySelector(".flow-first-node-line")?.textContent).toBe("Or type Customer [entity] on line 2");
  await userEvent.click(screen.getByRole("button", { name: /Add the first node/ }));
  await waitFor(() => expect(empty.text()).toBe('diagram dfd "New"\nProcess [process, id: 1.0]\n'));
  cleanup();

  const flow = setup({ text: FLOWCHART, layout: null }, "refund-policy");
  await drawn(flow, "Start Request in");
  expect(tools(flow.container)).toEqual([
    ["Select", "", "Select"],
    ["Add step", "S", "Add stepS"],
    ["Add decision", "D", "Add decisionD"],
    ["Add input or output", "I", "Add input or outputI"],
    ["Add start or end", "T", "Add start or endT"],
    ["Shapes", "", "Every shape and line"],
    ["Tidy", "", "Tidy"],
  ]);
  expect(within(flow.container.querySelector(".flow-pane-text") as HTMLElement).getByText("Flowchart")).toBeTruthy();
  expect(within(flow.container.querySelector(".flow-pane-text") as HTMLElement).getByText("3 shapes, 2 lines")).toBeTruthy();
  cleanup();

  const cloud = setup({ text: CLOUD, layout: null }, "platform");
  await drawn(cloud, "Service Users");
  expect(tools(cloud.container)).toEqual([
    ["Select", "", "Select"],
    ["Add a service", "N", "Add a serviceN"],
    ["Group", "G", "GroupG"],
    ["Shapes", "", "Every shape and line"],
    ["Tidy", "", "Tidy"],
  ]);
  const cloudStrip = cloud.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  expect(within(cloudStrip).getByRole("button", { name: "Icon credits" })).toBeTruthy();
  expect(within(cloud.container.querySelector(".flow-pane-text") as HTMLElement).getByText("Cloud")).toBeTruthy();
  expect(within(cloud.container.querySelector(".flow-pane-text") as HTMLElement).getByText("2 services")).toBeTruthy();
  cloud.press("n");
  await waitFor(() => expect(cloud.text()).toContain("Service\n"));
});

test("classic_toggles_and_is_kept_in_the_layout", async () => {
  const s = setup();
  await drawn(s);
  const modern = screen.getByRole("button", { name: "Modern" });
  const classic = screen.getByRole("button", { name: "Textbook shapes (Gane-Sarson)" });
  expect(modern.getAttribute("aria-pressed")).toBe("true");
  expect(classic.getAttribute("aria-pressed")).toBe("false");
  await userEvent.click(classic);
  await waitFor(() => expect(s.node("Process Checkout")!.querySelector(".fnode-classic")).not.toBeNull());
  expect(classic.getAttribute("aria-pressed")).toBe("true");
  await waitFor(() => expect(s.saves()).toHaveLength(1));
  expect(JSON.parse(s.lastSave().layout).style).toBe("classic");
  expect(s.lastSave()).toMatchObject({ cmd: "write_diagram_layout" });
  expect(callsTo("write_diagram")).toHaveLength(0);
  const layout = s.lastSave().layout;
  cleanup();
  // Opened again, the diagram keeps Classic.
  const again = setup({ text: DFD, layout });
  await drawn(again);
  expect(screen.getByRole("button", { name: "Textbook shapes (Gane-Sarson)" }).getAttribute("aria-pressed")).toBe("true");
  expect(again.node("Process Checkout")!.querySelector(".fnode-classic")).not.toBeNull();
});

test("a_flowchart_is_top_to_bottom_by_default_and_the_left_to_right_switch_is_kept_in_the_layout", async () => {
  const s = setup({ text: FLOWCHART, layout: null }, "refund-policy");
  await drawn(s, "Start Request in");
  const strip = s.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const tb = within(strip).getByRole("button", { name: "Top to bottom" });
  const lr = within(strip).getByRole("button", { name: "Left to right" });
  expect(tb.getAttribute("aria-pressed")).toBe("true");
  expect(lr.getAttribute("aria-pressed")).toBe("false");
  await userEvent.click(lr);
  expect(lr.getAttribute("aria-pressed")).toBe("true");
  await waitFor(() => expect(s.saves()).toHaveLength(1));
  expect(JSON.parse(s.lastSave().layout).direction).toBe("LR");
  // The text does not change, and is not written.
  expect(s.lastSave()).toMatchObject({ cmd: "write_diagram_layout" });
  expect(callsTo("write_diagram")).toHaveLength(0);
  expect(s.text()).toBe(FLOWCHART);
  // A data flow has no direction switch.
  cleanup();
  const dfd = setup();
  await drawn(dfd);
  expect(screen.queryByRole("button", { name: "Left to right" })).toBeNull();
});

test("closing_the_tab_frees_its_worker_state_and_saves_what_is_waiting", async () => {
  const s = setup();
  await drawn(s);
  const close = vi.spyOn(s.client, "closeFlow");
  act(() => canvas.props!.onMove!("Checkout", 480, 160));
  // Closed before the 400 ms save: the waiting save runs at once, then the worker forgets the diagram.
  s.unmount();
  expect(s.saves()).toHaveLength(1);
  expect(JSON.parse(s.lastSave().layout).nodes.Checkout).toEqual({ x: 480, y: 160 });
  expect(close).toHaveBeenCalledWith("flow:checkout");
});

// ---- Fix round 1 (ruling P16)

const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const settle = () => new Promise((r) => setTimeout(r, 60));

test("a_crlf_file_is_never_rewritten_by_moves_classic_and_direction", async () => {
  const s = setup({ text: crlf(DFD), layout: null });
  await drawn(s);
  act(() => canvas.props!.onMove!("Checkout", 400, 208));
  await waitFor(() => expect(s.saves()).toHaveLength(1));
  expect(s.lastSave().cmd).toBe("write_diagram_layout");
  await userEvent.click(screen.getByRole("button", { name: "Textbook shapes (Gane-Sarson)" }));
  await waitFor(() => expect(s.saves()).toHaveLength(2));
  expect(s.lastSave().cmd).toBe("write_diagram_layout");
  expect(callsTo("write_diagram")).toHaveLength(0);
  cleanup();
  const f = setup({ text: crlf(FLOWCHART), layout: null }, "refund-policy");
  await drawn(f, "Start Request in");
  const before = f.saves().length;
  await userEvent.click(screen.getByRole("button", { name: "Left to right" }));
  await waitFor(() => expect(f.saves()).toHaveLength(before + 1));
  expect(f.lastSave().cmd).toBe("write_diagram_layout");
  expect(callsTo("write_diagram")).toHaveLength(0);
});

test("a_broken_crlf_file_moved_is_left_as_it_is", async () => {
  // Edited outside Contura: CRLF, and line 14 names a node that does not exist.
  const s = setup({ text: crlf(BROKEN), layout: null });
  await waitFor(() => expect(screen.getByText("Refunds is not defined.")).toBeTruthy());
  act(() => canvas.props!.onMove!("Checkout", 64, 64));
  await waitFor(() => expect(s.saves()).toHaveLength(1));
  expect(s.lastSave().cmd).toBe("write_diagram_layout");
  expect(callsTo("write_diagram")).toHaveLength(0);
  expect(JSON.parse(s.lastSave().layout).nodes.Checkout).toEqual({ x: 64, y: 64 });
});

test("an_edit_to_a_crlf_file_saves_crlf", async () => {
  const s = setup({ text: crlf(DFD), layout: null });
  await drawn(s);
  s.press("p");
  await waitFor(() => expect(s.lastSave()?.text).toContain("Process [process, id: 3.0]\r\n"));
  expect(s.lastSave().text).toBe(crlf(s.text()));
  expect(/(^|[^\r])\n/.test(s.lastSave().text!)).toBe(false);
});

test("after_a_worker_restart_the_tab_still_updates_and_takes_actions", async () => {
  const s = setup();
  await drawn(s);
  // Many parses, so the old worker's version count is well ahead of a new one's.
  for (let i = 0; i < 6; i++) {
    s.type(`// note ${i}\n`, s.text().length, s.text().length);
    await settle();
  }
  act(() => (s.client as unknown as { worker: { onerror(): void } }).worker.onerror());
  await settle();
  const at = s.text().indexOf("Charge card: amount");
  s.type("Refunds: reversal", at, at + "Charge card: amount".length);
  await waitFor(() => expect(screen.getByText("Refunds is not defined.")).toBeTruthy());
  s.press("p");
  await waitFor(() => expect(s.text()).toContain("Process [process, id: 3.0]\n"));
});

test("a_failed_save_is_tried_again_when_the_tab_closes", async () => {
  let fail = true;
  const s = setup({ text: DFD, layout: null }, "checkout", {
    write: () => {
      if (fail) throw { kind: "io", message: "The disk is full." };
      return null;
    },
  });
  await drawn(s);
  act(() => canvas.props!.onMove!("Checkout", 400, 208));
  await waitFor(() => expect(s.saves()).toHaveLength(1));
  await waitFor(() => expect(s.container.querySelector(".flow-save-failed")).not.toBeNull());
  expect(flowEntry("checkout")?.save).toBe("failed");
  fail = false;
  s.unmount();
  expect(s.saves()).toHaveLength(2);
  expect(JSON.parse(s.lastSave().layout).nodes.Checkout).toEqual({ x: 400, y: 208 });
  expect(flowEntry("checkout")).toBeUndefined();
});

test("a_new_or_renamed_node_is_selected_on_the_canvas_and_in_the_strip", async () => {
  const s = setup();
  await drawn(s);
  const strip = () => s.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  select(s, "Process Checkout");
  await waitFor(() => expect(s.node("Process Checkout")!.classList.contains("selected")).toBe(true));
  s.press("p");
  await waitFor(() => expect(s.node("Process Process")?.classList.contains("selected")).toBe(true));
  expect(s.node("Process Checkout")!.classList.contains("selected")).toBe(false);
  expect(within(strip()).getByText("Process")).toBeTruthy();
  expect(within(strip()).getByText("3.0")).toBeTruthy();
  // F2 renames it, and the renamed node stays selected with no pick by hand.
  s.press("F2");
  const box = await screen.findByRole("textbox", { name: "Rename Process" });
  await userEvent.clear(box);
  await userEvent.type(box, "Pack{Enter}");
  await waitFor(() => expect(s.node("Process Pack")?.classList.contains("selected")).toBe(true));
  expect(within(strip()).getByText("Pack")).toBeTruthy();
});

test("deleting_three_nodes_is_one_undo_entry", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onSelect!(["Customer", "Orders", "Card network"]));
  s.press("Delete");
  await waitFor(() => expect(s.text()).not.toContain("Orders"));
  expect(s.text()).not.toContain("Customer");
  expect(s.text()).not.toContain("Card network");
  act(() => void undo(s.view()));
  expect(s.text()).toBe(DFD);
});

test("nodes_named_constructor_and___proto___are_drawn_and_placed_once", async () => {
  const s = setup({ text: 'diagram dfd "P"\n\nconstructor [process]\n__proto__ [store]\ntoString [entity]\nconstructor > __proto__\n', layout: null }, "proto");
  const layout = vi.spyOn(s.client, "layout");
  await drawn(s, "Process constructor");
  await waitFor(() => expect(s.node("Data store __proto__")).not.toBeNull());
  expect(s.node("Outside party toString")).not.toBeNull();
  await new Promise((r) => setTimeout(r, 300));
  expect(layout.mock.calls.length).toBeLessThanOrEqual(1);
});

test("ctrl_z_and_ctrl_y_on_the_canvas_run_the_one_history", async () => {
  const s = setup();
  await drawn(s);
  s.press("p");
  await waitFor(() => expect(s.text()).toContain("Process [process, id: 3.0]\n"));
  s.press("z", { ctrlKey: true });
  expect(s.text()).toBe(DFD);
  s.press("y", { ctrlKey: true });
  expect(s.text()).toContain("Process [process, id: 3.0]\n");
  s.press("z", { ctrlKey: true });
  s.press("Z", { ctrlKey: true, shiftKey: true });
  expect(s.text()).toContain("Process [process, id: 3.0]\n");
});

test("backspace_does_not_delete_nodes", async () => {
  const s = setup();
  await drawn(s);
  select(s, "Data store Orders");
  s.press("Backspace");
  await new Promise((r) => setTimeout(r, 150));
  expect(s.text()).toBe(DFD);
});

test("connecting_from_the_faded_drawing_refuses_a_name_the_text_lacks", async () => {
  const s = setup();
  await drawn(s);
  // Orders is renamed by typing on its own line only: the faded drawing still has Orders, the text does not.
  const at = s.text().indexOf("Orders [store");
  s.type("Ordrs", at, at + "Orders".length);
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  const before = s.text();
  act(() => canvas.props!.onConnectPorts!({ node: "Customer", port: "r" }, { node: "Orders", port: "l" }, false));
  const strip = s.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  expect(await within(strip).findByText("Orders is not defined.")).toBeTruthy();
  await new Promise((r) => setTimeout(r, 100));
  expect(s.text()).toBe(before);
});

test("renaming_to_a_taken_name_says_so", async () => {
  const s = setup();
  await drawn(s);
  select(s, "Outside party Customer");
  s.press("F2");
  const box = await screen.findByRole("textbox", { name: "Rename Customer" });
  await userEvent.clear(box);
  await userEvent.type(box, "Checkout{Enter}");
  const strip = s.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  expect(await within(strip).findByText("Checkout is already used.")).toBeTruthy();
  expect(s.text()).toBe(DFD);
});

test("hints_are_not_counted_as_problems", async () => {
  const s = setup({ text: FLOWCHART.replace("Done: yes", "Done"), layout: null }, "refund-policy");
  await drawn(s, "Start Request in");
  const text = s.container.querySelector(".flow-pane-text") as HTMLElement;
  // The decision hint is listed, but the foot counts errors only.
  await waitFor(() => expect(within(text).getByText("A decision needs a label on each way out, for example yes and no.")).toBeTruthy());
  expect(within(text).getByText("No problems")).toBeTruthy();
});

test("the_status_bar_and_tab_read_the_diagram_state", async () => {
  const s = setup();
  await drawn(s);
  await waitFor(() => expect(flowEntry("checkout")).toMatchObject({ save: "saved", errors: 0 }));
  const line4 = s.view().state.doc.line(4);
  act(() => s.view().dispatch({ selection: { anchor: line4.from + 8 } }));
  await waitFor(() => expect(flowEntry("checkout")).toMatchObject({ line: 4, col: 9 }));
  act(() => canvas.props!.onMove!("Checkout", 32, 32));
  await waitFor(() => expect(flowEntry("checkout")?.save).toBe("waiting"));
  await waitFor(() => expect(flowEntry("checkout")?.save).toBe("saved"));
  const at = s.text().indexOf("Charge card: amount");
  s.type("Refunds: reversal", at, at + "Charge card: amount".length);
  await waitFor(() => expect(flowEntry("checkout")?.errors).toBe(1));
});

// ---- Fix round 2 (ruling P17)

const guard = vi.hoisted(() => ({ g: null as null | { confirmCloseFlow(name: string): Promise<boolean> } }));

function GuardedTab({ client }: { client: LangClient }) {
  const g = usePendingEditsGuard({ tabs: [], connections: [], savedQueries: [], activate() {}, onSavedQuerySaved() {}, onError() {} });
  guard.g = g;
  return (
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="checkout" client={client} />
      {g.dialog}
    </div>
  );
}

test("discard_after_a_failed_save_writes_nothing_more", async () => {
  routeInvoke({
    read_diagram: () => ({ text: DFD, layout: null }),
    write_diagram: () => {
      throw { kind: "io", message: "The disk is full." };
    },
    write_diagram_layout: () => {
      throw { kind: "io", message: "The disk is full." };
    },
  });
  const utils = render(<GuardedTab client={new LangClient(() => fakeWorker())} />);
  await waitFor(() => expect(utils.container.querySelector('[aria-label="Process Checkout"]')).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onMove!("Checkout", 400, 208));
  await waitFor(() => expect(utils.container.querySelector(".flow-save-failed")).not.toBeNull());
  let closing!: Promise<boolean>;
  act(() => {
    closing = guard.g!.confirmCloseFlow("checkout");
  });
  // The close tries once more, fails, and asks.
  await screen.findByText("Save changes to checkout.flow?");
  const writes = allSaves().length;
  expect(writes).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole("button", { name: /^Discard/ }));
  expect(await closing).toBe(true);
  utils.unmount();
  await new Promise((r) => setTimeout(r, 500));
  expect(allSaves()).toHaveLength(writes);
});

test("flush_writes_a_save_that_comes_due_while_it_runs", async () => {
  const gates: (() => void)[] = [];
  const s = setup({ text: DFD, layout: null }, "checkout", {
    write: () => new Promise<null>((r) => gates.push(() => r(null))),
  });
  await drawn(s);
  act(() => canvas.props!.onMove!("Checkout", 400, 208));
  await settle();
  let flushed: boolean | null = null;
  const done = flowEntry("checkout")!.flush().then((ok) => (flushed = ok));
  await waitFor(() => expect(s.saves()).toHaveLength(1));
  // A move while that write is on its way: the flush is not done until the newer save is on disk too.
  act(() => canvas.props!.onMove!("Checkout", 480, 240));
  gates.shift()!();
  await new Promise((r) => setTimeout(r, 50));
  expect(flushed).toBeNull();
  await waitFor(() => expect(s.saves()).toHaveLength(2));
  expect(JSON.parse(s.lastSave().layout).nodes.Checkout).toEqual({ x: 480, y: 240 });
  gates.shift()!();
  await done;
  expect(flushed).toBe(true);
});

test("a_node_that_is_not_drawn_keeps_no_selection", async () => {
  const s = setup();
  await drawn(s);
  const at = s.text().indexOf("Charge card: amount");
  s.type("Refunds: reversal", at, at + "Charge card: amount".length);
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  // An add on the broken text writes its line, but the faded drawing cannot show it: nothing stays selected.
  s.press("p");
  await waitFor(() => expect(s.text()).toContain("Process [process, id: 3.0]\n"));
  const strip = s.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  await waitFor(() => expect(within(strip).getByText("Nothing selected")).toBeTruthy());
  s.press("Delete");
  await new Promise((r) => setTimeout(r, 150));
  expect(s.text()).toContain("Process [process, id: 3.0]\n");
});

// ---- Fix wave (ruling P24 I1)

/** A diagrams folder of one diagram, kept the way the Core keeps it. */
function folder(text: string) {
  const disk: { text: string | null; layout: string | null } = { text, layout: null };
  const write = (a: Record<string, unknown>) => {
    disk.text = a.text as string;
    disk.layout = a.layout as string;
    return null;
  };
  const writeLayout = (a: Record<string, unknown>) => {
    // The Core refuses a layout save when the .flow is gone, so nothing is recreated.
    if (disk.text === null) throw { kind: "notFound", message: "checkout.flow" };
    disk.layout = a.layout as string;
    return null;
  };
  return { disk, write, writeLayout };
}

test("an_outside_edit_survives_a_move_classic_and_the_direction", async () => {
  const f = folder(DFD);
  const s = setup(() => ({ text: f.disk.text!, layout: f.disk.layout }));
  routeInvoke({ read_diagram: () => ({ text: f.disk.text!, layout: f.disk.layout }), write_diagram: f.write, write_diagram_layout: f.writeLayout });
  await drawn(s);
  // Another editor saves the file while the tab is open.
  f.disk.text = 'diagram dfd "checkout"\n// edited outside\n';
  act(() => canvas.props!.onMove!("Checkout", 400, 208));
  await waitFor(() => expect(s.saves()).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "Textbook shapes (Gane-Sarson)" }));
  await waitFor(() => expect(s.saves()).toHaveLength(2));
  expect(f.disk.text).toBe('diagram dfd "checkout"\n// edited outside\n');
  expect(JSON.parse(f.disk.layout!).nodes.Checkout).toEqual({ x: 400, y: 208 });
  expect(JSON.parse(f.disk.layout!).style).toBe("classic");
});

test("the_text_is_written_only_after_a_text_edit", async () => {
  const s = setup();
  await drawn(s);
  s.press("p");
  await waitFor(() => expect(s.lastSave()?.cmd).toBe("write_diagram"));
  expect(s.lastSave().text).toBe(s.text());
  const texts = callsTo("write_diagram").length;
  // Saved: the next move writes the layout only.
  act(() => canvas.props!.onMove!("Checkout", 480, 160));
  await waitFor(() => expect(s.lastSave()?.cmd).toBe("write_diagram_layout"));
  expect(callsTo("write_diagram")).toHaveLength(texts);
  // An edit made meanwhile goes with the text again.
  s.type("// note\n", s.text().length, s.text().length);
  await waitFor(() => expect(callsTo("write_diagram")).toHaveLength(texts + 1));
  expect(s.lastSave().text).toBe(s.text());
});

test("a_move_on_a_file_deleted_outside_is_not_written_back", async () => {
  const f = folder(DFD);
  const s = setup(() => ({ text: f.disk.text!, layout: f.disk.layout }));
  routeInvoke({ read_diagram: () => ({ text: f.disk.text!, layout: f.disk.layout }), write_diagram: f.write, write_diagram_layout: f.writeLayout });
  await drawn(s);
  f.disk.text = null;
  act(() => canvas.props!.onMove!("Checkout", 400, 208));
  await waitFor(() => expect(s.container.querySelector(".flow-save-failed")).not.toBeNull());
  expect(f.disk.text).toBeNull();
  expect(f.disk.layout).toBeNull();
  expect(callsTo("write_diagram")).toHaveLength(0);
});

test("item_20_right_click_on_the_canvas_and_on_a_node_opens_contura_menus", async () => {
  const s = setup();
  await drawn(s);
  // The empty canvas: add tools placed where it was clicked, then the canvas actions.
  const pane = s.container.querySelector(".react-flow__pane") as HTMLElement;
  fireEvent.contextMenu(pane, { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Canvas actions" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual([
    "Add process",
    "Add data store",
    "Add outside party",
    "Select all",
    "Tidy",
    "Zoom to fit",
    "Publish image...",
  ]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Add data store" }));
  await waitFor(() => expect(s.text()).toContain("Data store [store, id: D2]\n"));
  expect(screen.queryByRole("menu", { name: "Canvas actions" })).toBeNull();
  // Escape closes it.
  fireEvent.contextMenu(pane, { clientX: 300, clientY: 200 });
  await screen.findByRole("menu", { name: "Canvas actions" });
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu", { name: "Canvas actions" })).toBeNull());
  // A node: its own actions; Delete takes it out of the text.
  fireEvent.contextMenu(s.node("Data store Orders")!, { clientX: 320, clientY: 220 });
  const nodeMenu = await screen.findByRole("menu", { name: "Orders actions" });
  expect(within(nodeMenu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual(["Edit name and details...", "Rename", "Show in the text", "Delete"]);
  await userEvent.click(within(nodeMenu).getByRole("menuitem", { name: "Delete" }));
  await waitFor(() => expect(s.text()).not.toContain("Orders ["));
});

// ---- Step 12, item 19: the newer kinds draw ----

const KIND_TEXTS: Record<string, string> = {
  er: ['diagram er "Billing"', "customers", "customers.id int", "customers.email text", "invoices", "customers 1--* invoices : bills"].join("\n"),
  sequence: ['diagram sequence "Pay"', "actor Customer", "participant App", "Customer -> App : Pay invoice", "loop retry {", "  App -> App : check", "}", "App --> Customer : done"].join("\n"),
  state: ['diagram state "Invoice"', "Draft", "Sent", "Paid in full? [choice]", "[*] > Draft", "Draft > Sent : send", "Sent > [*]"].join("\n"),
  class: ['diagram class "Types"', "interface Payable", "Payable : pay(amount)", "class Invoice", "Invoice : + total: numeric", "Payable <|-- Invoice"].join("\n"),
  mindmap: ['diagram mindmap "Plan"', "root Q4 plan", "  Diagrams", "    New kinds", "  Release"].join("\n"),
  timeline: ['diagram timeline "2026"', "section Q4", "2026-10-19: Docs ready", "milestone v1.0", "2026-11 to 2026-12: Backup"].join("\n"),
};

test("item_19_each_newer_kind_draws_its_shapes", async () => {
  const expected: Record<string, string[]> = {
    er: ["Entity customers", "Entity invoices"],
    sequence: ["Actor Customer", "Participant App"],
    state: ["Start", "End", "State Draft", "Choice Paid in full?"],
    class: ["Interface Payable", "Class Invoice"],
    mindmap: ["Central idea Q4 plan", "Topic Diagrams", "Topic New kinds"],
    timeline: ["Event Docs ready", "Milestone v1.0", "Period Backup"],
  };
  for (const [kind, labels] of Object.entries(expected)) {
    const s = setup({ text: `${KIND_TEXTS[kind]}\n`, layout: null }, `k-${kind}`);
    for (const label of labels) await waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });
    cleanup();
  }
});

test("item_19_cards_show_their_rows_and_fixed_kinds_are_laid_out_without_a_layout_file", async () => {
  const s = setup({ text: `${KIND_TEXTS.er}\n`, layout: null }, "k-er-rows");
  await waitFor(() => expect(s.node("Entity customers")).not.toBeNull(), { timeout: 4000 });
  expect([...s.node("Entity customers")!.querySelectorAll(".fkind-col")].map((e) => e.textContent)).toEqual(["id", "email"]);
  cleanup();
  const seq = setup({ text: `${KIND_TEXTS.sequence}\n`, layout: null }, "k-seq");
  await waitFor(() => expect(seq.node("Participant App")).not.toBeNull(), { timeout: 4000 });
  // The frame and the lifelines are drawn; nothing is written to the layout file for a sequence.
  expect(seq.container.querySelector('[aria-label="Frame loop retry"]')).not.toBeNull();
  expect(seq.node("Participant App")!.querySelector(".fkind-lifeline")).not.toBeNull();
  // Closing the tab runs any waiting save at once, so an empty list here means none was ever due.
  seq.unmount();
  expect(seq.saves()).toEqual([]);
});

test("item_19_the_shapes_list_names_the_open_kinds_shapes_and_writes_a_line", async () => {
  const s = setup({ text: `${KIND_TEXTS.state}\n`, layout: null }, "k-shapes");
  await waitFor(() => expect(s.node("State Draft")).not.toBeNull(), { timeout: 4000 });
  await userEvent.click(screen.getByRole("button", { name: "Shapes" }));
  const list = screen.getByRole("menu", { name: "Shapes" });
  expect(within(list).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual([
    "State",
    "Start",
    "End",
    "Choice",
    "Fork or join",
    "Composite",
    "Transition",
    "Note",
  ]);
  // A line shape is written at the end of the text, selected.
  await userEvent.click(within(list).getByRole("menuitem", { name: "Transition" }));
  expect(s.text().endsWith("A > B: event\n")).toBe(true);
  const sel = s.view().state.selection.main;
  expect(s.text().slice(sel.from, sel.to)).toBe("A > B: event");
  // A shape with a tool adds the node.
  await userEvent.click(screen.getByRole("button", { name: "Shapes" }));
  await userEvent.click(within(screen.getByRole("menu", { name: "Shapes" })).getByRole("menuitem", { name: "State" }));
  await waitFor(() => expect(s.text()).toMatch(/^State$/m));
});

test("item_21_a_selected_node_shows_four_resize_handles_and_a_kept_size_draws_it", async () => {
  // A browser tells a ResizeObserver after layout, not inside observe(): the shared mock calls back at once,
  // which a node with a size of its own turns into a render loop that no browser runs.
  class LaterResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() => this.cb([{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry], this as never));
    }
    unobserve() {}
    disconnect() {}
  }
  const Before = globalThis.ResizeObserver;
  vi.stubGlobal("ResizeObserver", LaterResizeObserver);
  onTestFinished(() => {
    vi.stubGlobal("ResizeObserver", Before);
  });
  const layout = JSON.stringify({ version: 1, nodes: {}, style: "modern", direction: "LR", sizes: { Checkout: { w: 260, h: 90 } } });
  const s = setup({ text: DFD, layout }, "resize-sizes");
  await drawn(s);
  select(s, "Process Checkout");
  await waitFor(() => expect(s.node("Process Checkout")!.querySelectorAll(".fnode-resize")).toHaveLength(4));
  // The kept size: the node draws at 260 x 90.
  const fnode = s.node("Process Checkout")!.querySelector(".fnode") as HTMLElement;
  expect(fnode.className).toContain("fnode-sized");
  expect([fnode.style.width, fnode.style.height]).toEqual(["260px", "90px"]);
  // Dragging the bottom right corner 40 px right and 10 down keeps the new size in the layout file.
  const se = s.node("Process Checkout")!.querySelector('.fnode-resize[data-corner="se"]') as HTMLElement;
  fireEvent.pointerDown(se, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(window, { clientX: 140, clientY: 110 });
  fireEvent.pointerUp(window, { clientX: 140, clientY: 110 });
  // jsdom measures every box at 800 x 600: the new size is that plus the drag, in canvas units at the fitted zoom.
  const zoom = Number(/scale\(([\d.]+)\)/.exec((s.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform)?.[1] ?? 1);
  await waitFor(() => expect(JSON.parse(s.lastSave()?.layout ?? "{}").sizes?.Checkout).toEqual({ w: Math.round(800 + 40 / zoom), h: Math.round(600 + 10 / zoom) }));
});

test("item_22_double_click_a_node_to_edit_its_name_and_details", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.node("Data store Orders")!);
  const panel = await screen.findByRole("dialog", { name: "Edit Orders" });
  const name = within(panel).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
  expect(name.value).toBe("Orders");
  expect((within(panel).getByRole("textbox", { name: "Id" }) as HTMLInputElement).value).toBe("D1");
  expect((within(panel).getByRole("textbox", { name: "Table" }) as HTMLInputElement).value).toBe("shop.orders");
  await userEvent.clear(name);
  await userEvent.type(name, "Order book");
  const id = within(panel).getByRole("textbox", { name: "Id" });
  await userEvent.clear(id);
  await userEvent.type(id, "D7{Enter}");
  await waitFor(() => expect(s.text()).toContain("Order book [store, id: D7, table: shop.orders]\n"));
  expect(s.text()).toContain("Checkout > Order book: new order");
  expect(screen.queryByRole("dialog", { name: "Edit Orders" })).toBeNull();
  // Escape leaves a node as it was.
  await waitFor(() => expect(s.node("Process Checkout")).not.toBeNull());
  fireEvent.doubleClick(s.node("Process Checkout")!);
  const again = await screen.findByRole("dialog", { name: "Edit Checkout" });
  await userEvent.type(within(again).getByRole("textbox", { name: "Name" }), "x");
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Checkout" })).toBeNull());
  expect(s.text()).toContain("Checkout [process, id: 1.0]");
});

test("item_23_canvas_keys_and_a_double_click_on_empty_canvas", async () => {
  const s = setup(undefined, "keys-canvas");
  await drawn(s);
  // Ctrl+A selects every node; Escape lets go.
  s.press("a", { ctrlKey: true });
  await waitFor(() => expect(s.container.querySelectorAll(".react-flow__node.selected").length).toBeGreaterThanOrEqual(5));
  s.press("Escape");
  await waitFor(() => expect(s.container.querySelectorAll(".react-flow__node.selected")).toHaveLength(0));
  // An arrow key nudges the selection one grid cell, kept in the layout file.
  select(s, "Process Checkout");
  await waitFor(() => expect(s.node("Process Checkout")!.classList.contains("selected")).toBe(true));
  const before = JSON.parse(s.lastSave()?.layout ?? "null")?.nodes?.Checkout;
  s.press("ArrowRight");
  await waitFor(() => {
    const now = JSON.parse(s.lastSave()?.layout ?? "{}").nodes?.Checkout;
    expect(now?.x).toBe((before?.x ?? now.x - 16) + 16);
  });
  // A double-click on empty canvas offers the kind's shapes there.
  fireEvent.doubleClick(s.container.querySelector(".react-flow__pane") as HTMLElement, { clientX: 400, clientY: 300 });
  await userEvent.click(await screen.findByRole("menuitem", { name: /Data store/ }));
  await waitFor(() => expect(s.text()).toContain("Data store [store, id: D2]\n"));
});
