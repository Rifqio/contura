// Task 9: the frame bar (Decisions 22 and 23). The selected frame's settings in one bar at the bottom of the canvas:
// Reset layout, the frame's name, its kind's settings, Text size, Colour and the More menu (Publish frame, Insert
// Mermaid, Tidy selection, Duplicate, Open as DBML, Delete frame).
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { ARROW_MARKER, MANY_MARKER, ONE_MARKER } from "../../diagram/edges";
import type { Scene } from "../../diagram/export/scene";
import { sceneToSvg } from "../../diagram/export/svg";
import { exportPalette } from "../../diagram/export/palette";
import { LangClient } from "../../lang/client";
import { parseFlow } from "../../lang/flow/parse";
import { splitFrames } from "../../lang/flow/board";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import { flowScene } from "../flowScene";
import { parseFlowLayout, serializeFlowLayout } from "../layout";
import * as flowToolbar from "../FlowToolbar";
import { boardFrameId, inFrameId } from "./boardScene";
import boardCss from "../../styles/flow-board.css?raw";

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

// The dialog has its own tests: here it only has to open with the frame's scene.
const dialog = vi.hoisted(() => ({ opened: [] as Scene[] }));
vi.mock("../../diagram/export/PublishDialog", async () => ({
  default: (p: { scene: Scene }) => {
    if (dialog.opened[dialog.opened.length - 1] !== p.scene) dialog.opened.push(p.scene);
    return <div role="dialog" aria-label="Publish image" />;
  },
}));

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  canvas.instance = null;
  dialog.opened = [];
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\n';
const BOARD = [CHECKOUT, REFUND, SHIPPING].join("\n");
const entry = (at: number, nodes: Record<string, { x: number; y: number }>) => ({ at: { x: at, y: 0 }, nodes, style: "modern", direction: "TB" });
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: entry(0, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }),
    Refund: entry(600, { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }),
    Shipping: entry(1200, { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }),
  },
  sketches: [],
});
const BILLING = 'diagram er "Billing"\ncustomers {\n  id int pk\n}\norders {\n  id int pk\n  customer_id int\n}\norders.customer_id > customers.id\n';
const SHOP = 'diagram dfd "Shop"\nCustomer [entity]\nCheckout [process, id: 1.0]\nCustomer > Checkout\n';
const LOGIN = 'diagram sequence "Login"\nparticipant User\nparticipant App\nUser -> App: sign in\n';

function setup(initial = BOARD, layout: string | null = LAYOUT, props: { onMermaid?: (r: { kind: string; file: string; run(flow: string): Promise<string | null> }) => void; onOpenModel?: (name: string, dbml: string) => void } = {}) {
  const saved = { text: initial, layout, layoutWrites: 0 };
  routeInvoke({
    read_diagram: () => ({ text: saved.text, layout: saved.layout }),
    write_diagram: (a) => {
      saved.text = a.text as string;
      saved.layout = a.layout as string;
      return null;
    },
    write_diagram_layout: (a) => {
      saved.layout = a.layout as string;
      saved.layoutWrites++;
      return null;
    },
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <FlowTab name="board" client={client} onMermaid={props.onMermaid as any} onOpenModel={props.onOpenModel} />
    </div>,
  );
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const text = () => view().state.doc.toString();
  const frame = (i: number) => {
    const t = text();
    const f = splitFrames(t)[i];
    return f ? t.slice(f.from, f.to) : null;
  };
  const nodes = () => canvas.props!.nodes;
  const edges = () => canvas.props!.edges;
  const nodeOf = (id: string) => nodes().find((n) => n.id === id);
  const bar = (title: string) => screen.getByRole("toolbar", { name: `${title} settings` });
  return { ...utils, saved, canvasEl, view, text, frame, nodes, edges, nodeOf, bar };
}
type Setup = ReturnType<typeof setup>;

async function opened(titles = ["Checkout", "Refund", "Shipping"]) {
  for (const t of titles) await screen.findByRole("button", { name: new RegExp(` ${t}$`) });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

/** Selects a frame by its tab and waits for its bar. */
async function pick(s: Setup, label: string, title: string, first: string) {
  fireEvent.click(await screen.findByRole("button", { name: `${label} ${title}` }));
  await waitFor(() => expect(s.nodes().some((n) => n.id === first)).toBe(true));
  return await screen.findByRole("toolbar", { name: `${title} settings` });
}

/** The bar's controls by name, in order. */
const controls = (bar: HTMLElement) => [...bar.querySelectorAll<HTMLElement>("button, input")].filter((e) => !e.closest("[role=menu], [role=listbox]")).map((e) => e.getAttribute("aria-label"));

/** Picks `option` in the bar's `label` list. */
async function choose(bar: HTMLElement, label: string, option: string) {
  fireEvent.click(within(bar).getByRole("combobox", { name: label }), { detail: 1 });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
const shown = (bar: HTMLElement, label: string) => within(bar).getByRole("combobox", { name: label }).textContent;

/** Opens the bar's More menu and picks `item`. */
async function more(bar: HTMLElement, item: string) {
  fireEvent.click(within(bar).getByRole("button", { name: "More" }));
  const row = await screen.findByRole("menuitem", { name: item });
  fireEvent.click(row);
}
async function moreRow(bar: HTMLElement, item: string) {
  fireEvent.click(within(bar).getByRole("button", { name: "More" }));
  return (await screen.findByRole("menuitem", { name: item })) as HTMLButtonElement;
}

const entryOf = (s: Setup, title: string) => JSON.parse(s.saved.layout ?? "{}").frames?.[title];

test("the_bar_follows_the_kind", async () => {
  const flow = setup();
  await opened();
  expect(screen.queryByRole("toolbar", { name: /settings$/ })).toBeNull();
  const bar = await pick(flow, "Flowchart", "Refund", "Ask");
  expect(controls(bar)).toEqual(["Reset layout", "Frame name", "Direction", "Text size", "Colour", "More"]);
  expect(shown(bar, "Direction")).toContain("Top to bottom");
  expect(shown(bar, "Text size")).toContain("Medium");
  // The interim settings bar is gone.
  expect(screen.queryByRole("toolbar", { name: "Diagram settings" })).toBeNull();
  cleanup();

  setup(SHOP, null);
  const dfd = await screen.findByRole("toolbar", { name: "Shop settings" });
  expect(controls(dfd)).toEqual(["Reset layout", "Frame name", "Direction", "Look", "Text size", "Colour", "More"]);
  expect(shown(dfd, "Look")).toContain("Modern");
  cleanup();

  setup(BILLING, null);
  const er = await screen.findByRole("toolbar", { name: "Billing settings" });
  expect(controls(er)).toEqual(["Reset layout", "Frame name", "Direction", "Notation", "Text size", "Colour", "More"]);
  expect(shown(er, "Notation")).toContain("Crow's foot");
  cleanup();

  setup(LOGIN, null);
  const seq = await screen.findByRole("toolbar", { name: "Login settings" });
  expect(controls(seq)).toEqual(["Frame name", "Text size", "Colour", "More"]);
  expect(within(seq).queryByRole("combobox", { name: "Direction" })).toBeNull();
  expect(within(seq).queryByRole("combobox", { name: "Numbering" })).toBeNull();
});

test("rename_in_the_bar_rewrites_the_header_and_keeps_positions", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  const name = within(bar).getByRole("textbox", { name: "Frame name" }) as HTMLInputElement;
  expect(name.value).toBe("Refund");
  fireEvent.change(name, { target: { value: "Returns" } });
  fireEvent.keyDown(name, { key: "Enter" });
  await waitFor(() => expect(s.frame(1)).toBe('diagram flow "Returns"\nAsk\nRefund it\nAsk > Refund it\n'));
  expect(s.frame(0)).toBe(CHECKOUT);
  expect(s.frame(2)).toBe(SHIPPING);
  // The bar follows the frame under its new name.
  const after = await screen.findByRole("toolbar", { name: "Returns settings" });
  expect((within(after).getByRole("textbox", { name: "Frame name" }) as HTMLInputElement).value).toBe("Returns");
  // The positions go with the title.
  await waitFor(() => expect(entryOf(s, "Returns")).toBeTruthy());
  expect(entryOf(s, "Returns").nodes).toEqual({ Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } });
  expect(entryOf(s, "Returns").at).toEqual({ x: 600, y: 0 });
  expect(entryOf(s, "Refund")).toBeUndefined();
  // A blur commits too.
  const field = within(after).getByRole("textbox", { name: "Frame name" }) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "Refunds" } });
  fireEvent.blur(field);
  await waitFor(() => expect(s.frame(1)).toBe('diagram flow "Refunds"\nAsk\nRefund it\nAsk > Refund it\n'));
});

test("a_taken_name_is_refused_and_put_back", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  const name = within(bar).getByRole("textbox", { name: "Frame name" }) as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Checkout" } });
  fireEvent.keyDown(name, { key: "Enter" });
  expect(await screen.findByText("Another diagram on this board has that title.")).toBeTruthy();
  await waitFor(() => expect(name.value).toBe("Refund"));
  expect(s.text()).toBe(BOARD);
  // An empty name is put back too.
  fireEvent.change(name, { target: { value: "  " } });
  fireEvent.blur(name);
  expect(await screen.findByText("A diagram needs a title.")).toBeTruthy();
  await waitFor(() => expect(name.value).toBe("Refund"));
  expect(s.text()).toBe(BOARD);
  // Esc puts the name back without a rename.
  fireEvent.change(name, { target: { value: "Elsewhere" } });
  fireEvent.keyDown(name, { key: "Escape" });
  expect(name.value).toBe("Refund");
  expect(s.text()).toBe(BOARD);
});

test("direction_and_text_size_are_one_undo_each", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  await choose(bar, "Direction", "Left to right");
  await waitFor(() => expect(shown(s.bar("Refund"), "Direction")).toContain("Left to right"));
  await choose(s.bar("Refund"), "Text size", "Large");
  await waitFor(() => expect(shown(s.bar("Refund"), "Text size")).toContain("Large"));
  await waitFor(() => expect(entryOf(s, "Refund")).toMatchObject({ direction: "LR", textSize: "l" }));
  // Only the selected frame's entry changes.
  expect(entryOf(s, "Checkout")).toEqual(entry(0, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }));
  expect(entryOf(s, "Shipping")).toEqual(entry(1200, { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }));
  // Settings write the layout file only.
  expect(s.text()).toBe(BOARD);
  act(() => void undo(s.view()));
  await waitFor(() => expect(shown(s.bar("Refund"), "Text size")).toContain("Medium"));
  expect(shown(s.bar("Refund"), "Direction")).toContain("Left to right");
  act(() => void undo(s.view()));
  await waitFor(() => expect(shown(s.bar("Refund"), "Direction")).toContain("Top to bottom"));
});

test("reset_layout_tidies_the_frame", async () => {
  const layout = JSON.parse(LAYOUT);
  layout.frames.Refund.nodes = { Ask: { x: 400, y: 400 }, "Refund it": { x: 0, y: 0 } };
  const s = setup(BOARD, JSON.stringify(layout));
  await opened();
  await pick(s, "Flowchart", "Refund", "Ask");
  // Even with shapes selected, Reset layout lays out the whole frame.
  act(() => canvas.props!.onSelect!(["Ask", "Refund it"]));
  fireEvent.click(within(s.bar("Refund")).getByRole("button", { name: "Reset layout" }));
  await waitFor(() => expect(s.nodeOf("Ask")!.position.y).toBeLessThan(s.nodeOf("Refund it")!.position.y));
  await waitFor(() => expect(entryOf(s, "Refund").nodes.Ask).not.toEqual({ x: 400, y: 400 }));
  expect(entryOf(s, "Checkout").nodes).toEqual({ Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } });
  expect(entryOf(s, "Shipping").nodes).toEqual({ Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } });
  expect(s.text()).toBe(BOARD);
});

test("colour_is_disabled_with_no_shape_selected", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  const colour = within(bar).getByRole("button", { name: "Colour" }) as HTMLButtonElement;
  expect(colour.disabled).toBe(true);
  expect(colour.getAttribute("title")).toBe("Select shapes to colour them");
  act(() => canvas.props!.onSelect!(["Ask"]));
  await waitFor(() => expect((within(s.bar("Refund")).getByRole("button", { name: "Colour" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(within(s.bar("Refund")).getByRole("button", { name: "Colour" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Success" }));
  await waitFor(() => expect(s.frame(1)).toBe('diagram flow "Refund"\nAsk [color: success]\nRefund it\nAsk > Refund it\n'));
  expect(s.frame(0)).toBe(CHECKOUT);
});

test("insert_mermaid_goes_into_this_frame", async () => {
  const onMermaid = vi.fn();
  const s = setup(BOARD, LAYOUT, { onMermaid });
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  await more(bar, "Insert Mermaid...");
  expect(onMermaid).toHaveBeenCalledTimes(1);
  const { run, kind, file } = onMermaid.mock.calls[0][0];
  expect([kind, file]).toEqual(["flow", "board"]);
  let why: string | null = "not run";
  await act(async () => {
    why = await run('diagram flow "Pasted"\nCheck\nDone\nCheck > Done\n');
  });
  expect(why).toBeNull();
  await waitFor(() => expect(s.frame(1)).toContain("Check > Done"));
  expect(s.frame(0)).toBe(CHECKOUT);
  expect(s.frame(2)).toBe(SHIPPING);
});

test("tidy_selection_tidies_only_the_selected", async () => {
  const text = 'diagram flow "Refund"\nAsk\nCheck\nRefund it\nAsk > Check\nCheck > Refund it\n';
  const layout = JSON.stringify({ version: 1, nodes: { Ask: { x: 0, y: 0 }, Check: { x: 400, y: 400 }, "Refund it": { x: 800, y: 40 } }, style: "modern", direction: "TB" });
  const s = setup(text, layout);
  const bar = await screen.findByRole("toolbar", { name: "Refund settings" });
  await waitFor(() => expect(s.nodeOf("Check")).toBeTruthy());
  // With one shape or none selected, the row is off.
  expect((await moreRow(bar, "Tidy selection")).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  act(() => canvas.props!.onSelect!(["Ask", "Check"]));
  await more(s.bar("Refund"), "Tidy selection");
  await waitFor(() => expect(s.nodeOf("Check")!.position).not.toEqual({ x: 400, y: 400 }));
  // The shape left out stays where it was.
  expect(s.nodeOf("Refund it")!.position).toEqual({ x: 800, y: 40 });
  // The selection menu says the same.
  const items = await import("../canvasMenus");
  const rows = items.selectionMenuItems({ count: 2, shapes: 2, movable: true, service: false, align() {}, distribute() {}, cut() {}, copy() {}, duplicate() {}, tidy() {}, group() {}, remove() {} });
  expect(rows.map((r) => r.label)).toContain("Tidy selection");
});

test("duplicate_frame_places_the_copy_beside_it", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  const box = (title: string) => {
    const n = s.nodeOf(boardFrameId(title))!;
    return { x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) };
  };
  const src = box("Refund");
  await more(bar, "Duplicate frame");
  await waitFor(() => expect(s.frame(2)).toBe('diagram flow "Refund 2"\nAsk\nRefund it\nAsk > Refund it\n'));
  expect(s.frame(3)).toBe(SHIPPING);
  await waitFor(() => expect(s.nodeOf(boardFrameId("Refund 2"))).toBeTruthy());
  // The copy is selected, to the right of the frame, top aligned, over no other frame.
  await screen.findByRole("toolbar", { name: "Refund 2 settings" });
  await waitFor(() => expect(entryOf(s, "Refund 2")).toBeTruthy());
  const copy = box("Refund 2");
  const was = box("Refund");
  expect(copy.x).toBeGreaterThan(was.x + was.w);
  expect(copy.y).toBe(was.y);
  expect(copy.w).toBe(src.w);
  for (const t of ["Checkout", "Refund", "Shipping"]) {
    const o = box(t);
    expect(copy.x >= o.x + o.w || copy.x + copy.w <= o.x || copy.y >= o.y + o.h || copy.y + copy.h <= o.y).toBe(true);
  }
  expect(entryOf(s, "Refund 2").nodes).toEqual(entryOf(s, "Refund").nodes);
});

test("undoing_a_duplicate_takes_the_frame_and_its_entry", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  const before = JSON.parse(LAYOUT).frames;
  await more(bar, "Duplicate frame");
  await waitFor(() => expect(entryOf(s, "Refund 2")).toBeTruthy());
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.text()).toBe(BOARD));
  await waitFor(() => expect(entryOf(s, "Refund 2")).toBeUndefined());
  // Every other entry is as it was.
  expect(JSON.parse(s.saved.layout!).frames).toEqual(before);
});

test("delete_frame_toasts_and_undo_brings_it_back", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  await more(bar, "Delete frame");
  await waitFor(() => expect(s.text()).toBe([CHECKOUT, SHIPPING].join("\n")));
  expect(await screen.findByText("Deleted Refund.")).toBeTruthy();
  await waitFor(() => expect(entryOf(s, "Refund")).toBeUndefined());
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(s.text()).toBe(BOARD));
  await waitFor(() => expect(entryOf(s, "Refund")).toEqual(entry(600, { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } })));
});

test("delete_is_disabled_on_the_last_frame", async () => {
  setup(CHECKOUT, null);
  const bar = await screen.findByRole("toolbar", { name: "Checkout settings" });
  const row = await moreRow(bar, "Delete frame");
  expect(row.disabled).toBe(true);
});

test("open_as_dbml_sends_the_frame", async () => {
  const onOpenModel = vi.fn();
  const s = setup(`${CHECKOUT}\n${BILLING}`, null, { onOpenModel });
  await opened(["Checkout", "Billing"]);
  // Not on a flowchart.
  const flow = await pick(s, "Flowchart", "Checkout", "Cart");
  fireEvent.click(within(flow).getByRole("button", { name: "More" }));
  expect(screen.queryByRole("menuitem", { name: "Open as DBML" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  const bar = await pick(s, "ER diagram", "Billing", "customers");
  await more(bar, "Open as DBML");
  expect(onOpenModel).toHaveBeenCalledTimes(1);
  const [name, dbml] = onOpenModel.mock.calls[0];
  expect(name).toBe("board");
  expect(dbml).toContain("Table customers {");
  expect(dbml).toContain("Ref: orders.customer_id > customers.id");
});

test("arrows_notation_draws_arrowheads_on_the_canvas", async () => {
  const s = setup(`${CHECKOUT}\n${BILLING}`, null);
  await opened(["Checkout", "Billing"]);
  const bar = await pick(s, "ER diagram", "Billing", "customers");
  const line = () => s.edges().find((e) => e.id === "edge:0")!;
  await waitFor(() => expect(line()).toBeTruthy());
  expect([line().markerStart, line().markerEnd]).toEqual([MANY_MARKER, ONE_MARKER]);
  await choose(bar, "Notation", "Arrows");
  await waitFor(() => expect([line().markerStart, line().markerEnd]).toEqual([undefined, ARROW_MARKER]));
  // Drawn static, the frame keeps its notation.
  await pick(s, "Flowchart", "Checkout", "Cart");
  const still = () => s.edges().find((e) => e.id === inFrameId("Billing", "edge:0"));
  await waitFor(() => expect(still()).toBeTruthy());
  expect([still()!.markerStart, still()!.markerEnd]).toEqual([undefined, ARROW_MARKER]);
  // The text is not changed.
  expect(s.text()).toBe(`${CHECKOUT}\n${BILLING}`);
  // Publish draws the same: a head at the second end, no crow's feet.
  const doc = parseFlow(BILLING).doc!;
  const at = { customers: { x: 0, y: 0 }, orders: { x: 400, y: 0 } };
  const crow = flowScene(doc, at, "modern", new Map()).edges[0];
  expect(crow.marks).toEqual({ start: "many", end: "one" });
  const arrows = flowScene(doc, at, "modern", new Map(), undefined, undefined, { notation: "arrow" }).edges[0];
  expect(arrows.marks).toBeUndefined();
  expect(arrows.heads).toBe("end");
});

test("publish_frame_opens_publish_on_that_frame", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Shipping", "Pack");
  const row = await moreRow(bar, "Publish frame...");
  expect(row.getAttribute("aria-label")).toBe("Publish frame...");
  expect(row.textContent).toContain("Ctrl+Shift+E");
  fireEvent.click(row);
  await waitFor(() => expect(dialog.opened.length).toBeGreaterThan(0));
  expect(dialog.opened[0].nodes.map((n) => n.id).sort()).toEqual(["Pack", "Send"]);
});

test("large_text_scales_labels_on_the_canvas_and_in_publish", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  await choose(bar, "Text size", "Large");
  // The live shapes carry the scale; the CSS sizes their labels from it.
  await waitFor(() => expect(s.nodeOf("Ask")!.className ?? "").toContain("is-text-scaled"));
  expect((s.nodeOf("Ask")!.style as Record<string, unknown>)["--text-scale"]).toBe(1.15);
  const el = s.container.querySelector<HTMLElement>('.react-flow__node[data-id="Ask"]')!;
  expect(el.style.getPropertyValue("--text-scale")).toBe("1.15");
  const css = boardCss;
  const rule = /\.is-text-scaled\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(rule).toContain("--font-small-size: calc(var(--text-base-small-size) * var(--text-scale");
  // From the tokens, never a size of its own.
  expect(rule).not.toMatch(/\d+px/);
  expect(/\.react-flow\s*\{([^}]*)\}/.exec(css)?.[1] ?? "").toContain("--text-base-small-size: var(--font-small-size);");
  expect(rule).toContain("--font-small: var(--font-small-weight) var(--font-small-size)");
  // Static, Refund's shapes keep the scale.
  await pick(s, "Flowchart", "Checkout", "Cart");
  await waitFor(() => expect(s.nodeOf(inFrameId("Refund", "Ask"))?.className ?? "").toContain("is-text-scaled"));
  expect(s.nodeOf(inFrameId("Checkout", "Cart"))).toBeUndefined();
  expect(s.nodeOf("Cart")!.className ?? "").not.toContain("is-text-scaled");
  // Publish: the scene says the scale and the image's labels are larger.
  const doc = parseFlow(REFUND).doc!;
  const at = { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } };
  const plain = flowScene(doc, at, "modern", new Map());
  const large = flowScene(doc, at, "modern", new Map(), undefined, undefined, { textScale: 1.15 });
  expect(plain.textScale).toBeUndefined();
  expect(large.textScale).toBe(1.15);
  const sizes = (svg: string) => [...svg.matchAll(/ font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
  const palette = exportPalette("light");
  const a = sizes(sceneToSvg(plain, palette, { padding: 16, background: "theme", mark: false }));
  const b = sizes(sceneToSvg(large, palette, { padding: 16, background: "theme", mark: false }));
  // The image's own size (its labels inherit it) and every label's size grow by the scale.
  expect(a[0]).toBe(13);
  expect(b.length).toBe(a.length);
  b.forEach((n, i) => expect(n).toBeCloseTo(a[i] * 1.15, 1));
  // The mark keeps its size.
  expect(sceneToSvg(large, palette, { padding: 16, background: "theme", mark: true })).toContain('font-size="11" fill');
});

test("publish_label_pills_grow_with_the_text_size", () => {
  const doc = parseFlow('diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it: when the order is late\n').doc!;
  const at = { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 200 } };
  const palette = exportPalette("light");
  const pill = (k: number) => {
    const svg = sceneToSvg(flowScene(doc, at, "modern", new Map(), undefined, undefined, k === 1 ? {} : { textScale: k }), palette, { padding: 16, background: "theme", mark: false });
    const m = /<g data-edge="edge:0">[^]*?<rect data-part="(?:chip|label-pill)"[^>]*width="([\d.]+)" height="([\d.]+)"/.exec(svg);
    expect(m).not.toBeNull();
    return { w: Number(m![1]), h: Number(m![2]) };
  };
  const medium = pill(1);
  const large = pill(1.15);
  // The words grow by the scale, and so does their pill: the padding round them stays.
  const words = "when the order is late".length;
  expect(large.w - medium.w).toBeGreaterThanOrEqual(Math.floor(words * 6.5 * 0.15));
  expect(large.h).toBeCloseTo(medium.h * 1.15, 1);
});

test("the_toast_sits_above_the_frame_bar", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  const name = within(bar).getByRole("textbox", { name: "Frame name" });
  fireEvent.change(name, { target: { value: "Checkout" } });
  fireEvent.keyDown(name, { key: "Enter" });
  const toast = (await screen.findByText("Another diagram on this board has that title.")).closest(".flow-toast") as HTMLElement;
  // One stack at the bottom of the canvas: the toast over the bar, never on it.
  const stack = s.container.querySelector(".board-bottom") as HTMLElement;
  expect(stack).not.toBeNull();
  expect(stack.contains(toast) && stack.contains(s.bar("Refund"))).toBe(true);
  expect(toast.compareDocumentPosition(s.bar("Refund")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const board = boardCss;
  const stackRule = /\.board-bottom\s*\{([^}]*)\}/.exec(board)?.[1] ?? "";
  expect(stackRule).toContain("display: flex");
  expect(stackRule).toContain("flex-direction: column");
  expect(stackRule).toContain("bottom: 12px");
  const toastRule = /\.board-bottom \.flow-toast\s*\{([^}]*)\}/.exec(board)?.[1] ?? "";
  expect(toastRule).toContain("position: static");
});

test("a_one_frame_file_stays_version_1_when_its_settings_do_not_change", async () => {
  // The file as Contura writes version 1.
  const layout = serializeFlowLayout(parseFlowLayout(JSON.stringify({ version: 1, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" }), "flow"));
  const s = setup(CHECKOUT, layout);
  const bar = await screen.findByRole("toolbar", { name: "Checkout settings" });
  await waitFor(() => expect(s.nodeOf("Cart")).toBeTruthy());
  // Picking what is already set writes nothing.
  await choose(bar, "Text size", "Medium");
  await choose(s.bar("Checkout"), "Direction", "Top to bottom");
  await new Promise((r) => setTimeout(r, 500));
  expect(s.saved.layoutWrites).toBe(0);
  // Large and back to Medium: the file is version 1 again, byte for byte.
  await choose(s.bar("Checkout"), "Text size", "Large");
  await waitFor(() => expect(JSON.parse(s.saved.layout!).version).toBe(2));
  await choose(s.bar("Checkout"), "Text size", "Medium");
  await waitFor(() => expect(s.saved.layout).toBe(layout));
});

test("the_bar_is_keyboard_reachable", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  const named = [...bar.querySelectorAll<HTMLElement>("button, input")].filter((e) => !e.closest("[role=menu], [role=listbox]"));
  // Every control is named; Colour is off with no shape selected, and every other one takes the focus.
  for (const el of named) expect(el.getAttribute("aria-label")).toBeTruthy();
  expect(named.filter((e) => (e as HTMLButtonElement).disabled).map((e) => e.getAttribute("aria-label"))).toEqual(["Colour"]);
  const all = named.filter((e) => !(e as HTMLButtonElement).disabled);
  for (const el of all) expect(el.tabIndex).toBe(0);
  // The arrows go along the bar (WAI-ARIA toolbar); in the name field they stay in the text.
  all[0].focus();
  fireEvent.keyDown(all[0], { key: "ArrowRight" });
  expect(document.activeElement).toBe(all[1]);
  fireEvent.keyDown(all[1], { key: "ArrowRight" });
  expect(document.activeElement).toBe(all[1]);
  all[2].focus();
  fireEvent.keyDown(all[2], { key: "End" });
  expect(document.activeElement).toBe(all[all.length - 1]);
  fireEvent.keyDown(all[all.length - 1], { key: "ArrowRight" });
  expect(document.activeElement).toBe(all[0]);
  // The keys on the bar never reach the canvas: R in the bar arms nothing.
  all[2].focus();
  fireEvent.keyDown(all[2], { key: "r" });
  expect(within(screen.getByRole("toolbar", { name: "Board tools" })).getByRole("button", { name: "Select" }).getAttribute("aria-pressed")).toBe("true");
  // More opens from the keyboard, and Esc gives focus back to it.
  const moreButton = within(bar).getByRole("button", { name: "More" });
  moreButton.focus();
  await userEvent.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual(["Publish frame...", "Tidy selection", "Duplicate frame", "Delete frame"]);
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(moreButton);
});

test("flow_toolbar_is_gone", () => {
  const mod = flowToolbar as Record<string, unknown>;
  expect(mod.default).toBeUndefined();
  expect(mod.FrameTools).toBeUndefined();
  expect(Object.keys(mod).sort()).toEqual(["ADD_TOOLS"]);
  expect(Object.keys(flowToolbar.ADD_TOOLS)).toContain("flow");
});

test("an_edit_after_delete_dismisses_the_undo_toast", async () => {
  const s = setup();
  await opened();
  const bar = await pick(s, "Flowchart", "Refund", "Ask");
  await more(bar, "Delete frame");
  await waitFor(() => expect(s.text()).toBe([CHECKOUT, SHIPPING].join("\n")));
  expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();
  // A typed edit: the toast goes at once, so its Undo can never take the edit back instead.
  act(() => s.view().dispatch({ changes: { from: s.view().state.doc.length, insert: "// later\n" } }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(), { timeout: 600 });
  expect(screen.queryByText("Deleted Refund.")).toBeNull();
  expect(s.text()).toBe(`${[CHECKOUT, SHIPPING].join("\n")}// later\n`);
  cleanup();

  // A setting changed after the delete (an undo entry with no text change) dismisses it too.
  const t = setup();
  await opened();
  await more(await pick(t, "Flowchart", "Refund", "Ask"), "Delete frame");
  await waitFor(() => expect(t.text()).toBe([CHECKOUT, SHIPPING].join("\n")));
  await screen.findByRole("button", { name: "Undo" });
  const live = await screen.findByRole("toolbar", { name: /settings$/ });
  await choose(live, "Text size", "Large");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(), { timeout: 600 });
  cleanup();

  // A frame switch dismisses it.
  const u = setup();
  await opened();
  await more(await pick(u, "Flowchart", "Refund", "Ask"), "Delete frame");
  await waitFor(() => expect(u.text()).toBe([CHECKOUT, SHIPPING].join("\n")));
  await screen.findByRole("button", { name: "Undo" });
  // The delete leaves a neighbour selected; the switch goes to the other one.
  const now = (await screen.findByRole("toolbar", { name: /settings$/ })).getAttribute("aria-label")!.replace(" settings", "");
  const unselected = now === "Checkout" ? "Shipping" : "Checkout";
  fireEvent.click(screen.getByRole("button", { name: `Flowchart ${unselected}` }));
  await screen.findByRole("toolbar", { name: `${unselected} settings` });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(), { timeout: 600 });
  expect(u.text()).toBe([CHECKOUT, SHIPPING].join("\n"));
});
