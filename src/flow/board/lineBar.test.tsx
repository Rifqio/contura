// Task 10: the line bar. One selected line takes the frame bar's place with its colour and, in an ERD, its cardinality.
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { splitFrames } from "../../lang/flow/board";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import { ARROWS } from "../../lang/flow/model";
import { ARROW_NAMES } from "../canvasMenus";
import FlowTab from "../FlowTab";
import { shownRange } from "./frameView";
import LineBar from "./LineBar";
import lineBarSource from "./LineBar.tsx?raw";

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
  // The pane shows the frame in the frame after the canvas paints it (Task 18b): typing waits for it, as a hand does.
  await waitFor(() => {
    const r = shownRange(s.view().state);
    expect(r && s.view().state.sliceDoc(r.from, r.to)).toContain(`"${title}"`);
  });
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


const lineBar = () => screen.findByRole("toolbar", { name: "Line settings" });
const selectLine = (ids: string[]) => act(() => canvas.props!.onLineSelect!(ids));

test("one_line_selected_shows_the_line_bar", async () => {
  const s = setup();
  await opened();
  await pick(s, "Flowchart", "Refund", "Ask");
  selectLine(["edge:0"]);
  const bar = await lineBar();
  expect(controls(bar)).toEqual(["Colour"]);
  expect(screen.queryByRole("toolbar", { name: "Refund settings" })).toBeNull();
  // Clearing the selection brings the frame bar back.
  selectLine([]);
  await screen.findByRole("toolbar", { name: "Refund settings" });
  expect(screen.queryByRole("toolbar", { name: "Line settings" })).toBeNull();
});

test("line_colour_writes_the_preset", async () => {
  const s = setup();
  await opened();
  await pick(s, "Flowchart", "Refund", "Ask");
  selectLine(["edge:0"]);
  const bar = await lineBar();
  fireEvent.click(within(bar).getByRole("button", { name: "Colour" }));
  expect(await screen.findByText('Or type any CSS colour in the code: color: "#2f6f8f"')).toBeTruthy();
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Warning/ }));
  await waitFor(() => expect(s.frame(1)).toBe('diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it [color: warning]\n'));
  expect(s.frame(0)).toBe(CHECKOUT);
  expect(s.frame(2)).toBe(SHIPPING);
  // One undo entry.
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.text()).toBe(BOARD));
});

test("a_sequence_line_has_no_colour", async () => {
  const s = setup(LOGIN, null);
  await screen.findByRole("toolbar", { name: "Login settings" });
  await waitFor(() => expect(canvas.props!.onLineSelect).toBeTruthy());
  selectLine(["edge:0"]);
  const bar = await lineBar();
  const colour = within(bar).getByRole("button", { name: "Colour" }) as HTMLButtonElement;
  expect(colour.disabled).toBe(true);
  expect(colour.title).toBe("Colour a participant in the code, for example participant App [color: info].");
  expect(s.text()).toBe(LOGIN);
});

test("er_cardinality_rewrites_the_arrow_only", async () => {
  const s = setup(BILLING, null);
  await screen.findByRole("toolbar", { name: "Billing settings" });
  await waitFor(() => expect(s.edges().length).toBeGreaterThan(0));
  selectLine(["edge:0"]);
  const bar = await lineBar();
  expect(controls(bar)).toEqual(["Colour", "Cardinality"]);
  expect(shown(bar, "Cardinality")).toContain("Many to one >");
  await choose(bar, "Cardinality", "One to many <");
  await waitFor(() => expect(s.text()).toBe(BILLING.replace("orders.customer_id > customers.id", "orders.customer_id < customers.id")));
  await waitFor(() => expect(shown(screen.getByRole("toolbar", { name: "Line settings" }), "Cardinality")).toContain("One to many <"));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.text()).toBe(BILLING));
});

test("a_flow_line_has_no_cardinality", async () => {
  const s = setup();
  await opened();
  await pick(s, "Flowchart", "Refund", "Ask");
  selectLine(["edge:0"]);
  expect(within(await lineBar()).queryByRole("combobox", { name: "Cardinality" })).toBeNull();
});

test("two_lines_selected_show_no_line_bar", async () => {
  const s = setup('diagram flow "Two"\nA\nB\nC\nA > B\nB > C\n', null);
  await screen.findByRole("toolbar", { name: "Two settings" });
  selectLine(["edge:0", "edge:1"]);
  await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Line settings" })).toBeNull());
  expect(screen.getByRole("toolbar", { name: "Two settings" })).toBeTruthy();
  expect(s.text()).toContain("A > B");
});

test("a_refused_line_edit_does_not_keep_a_stale_line", async () => {
  const s = setup();
  await opened();
  await pick(s, "Flowchart", "Refund", "Ask");
  selectLine(["edge:0"]);
  const bar = await lineBar();
  // The frame's text stops reading: the pick is refused.
  const f = splitFrames(s.text())[1];
  const broken = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n[[[ broken\n';
  act(() => s.view().dispatch({ changes: { from: f.from, to: f.to, insert: broken } }));
  await waitFor(() => expect(s.frame(1)).toBe(broken));
  fireEvent.click(within(bar).getByRole("button", { name: "Colour" }));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Warning/ }));
  expect(s.frame(1)).toBe(broken);
  // The text is fixed with a new first line: edge:0 now names another link.
  const fixed = 'diagram flow "Refund"\nAsk\nRefund it\nX\nX > Ask\nAsk > Refund it\n';
  const g = splitFrames(s.text())[1];
  act(() => s.view().dispatch({ changes: { from: g.from, to: g.to, insert: fixed } }));
  await waitFor(() => expect(s.frame(1)).toBe(fixed));
  await screen.findByRole("toolbar", { name: "Refund settings" });
  expect(screen.queryByRole("toolbar", { name: "Line settings" })).toBeNull();
});

test("the_assistant_lock_disables_both_controls_with_a_reason", () => {
  render(<LineBar kind="er" link={{ arrow: ">" }} disabled onColour={() => {}} onArrow={() => {}} />);
  const colour = screen.getByRole("button", { name: "Colour" }) as HTMLButtonElement;
  expect(colour.disabled).toBe(true);
  expect(colour.title).toBe("The Assistant is editing. Colour and cardinality are off until it finishes.");
  expect((screen.getByRole("combobox", { name: "Cardinality" }) as HTMLButtonElement).disabled).toBe(true);
});

test("clicking_an_er_line_on_the_canvas_shows_the_line_bar", async () => {
  const s = setup(BILLING, null);
  await screen.findByRole("toolbar", { name: "Billing settings" });
  await waitFor(() => expect(s.container.querySelector('.react-flow__edge[data-id="edge:0"]')).not.toBeNull());
  const edge = s.container.querySelector('.react-flow__edge[data-id="edge:0"]')!;
  fireEvent.click(edge.querySelector("path.react-flow__edge-interaction") ?? edge.querySelector("path") ?? edge);
  const bar = await lineBar();
  expect(controls(bar)).toEqual(["Colour", "Cardinality"]);
});

// B3 Task 8 (R19, D9): one list of cardinalities, ARROW_NAMES.er in ARROWS.er order, read by the bar and the menu.
test("the_line_bar_and_the_menu_offer_the_same_cardinalities", async () => {
  const picked: string[] = [];
  render(<LineBar kind="er" link={{ arrow: ">" }} onColour={() => {}} onArrow={(a) => picked.push(a)} />);
  for (let i = 0; i < ARROWS.er.length; i++) {
    fireEvent.click(screen.getByRole("combobox", { name: "Cardinality" }), { detail: 1 });
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(ARROWS.er.map((a) => expect.stringMatching(new RegExp(`^${ARROW_NAMES.er[a]}`))));
    fireEvent.click(options[i]);
  }
  // Each option's value is its arrow, in the order the menu lists them.
  // The arrow it already has (>) changes nothing, so it is not sent.
  expect(picked).toEqual(ARROWS.er.slice(1));
  // No list of its own: the names are read, not written again, in LineBar.tsx.
  for (const a of ARROWS.er) expect(lineBarSource).not.toContain(`"${ARROW_NAMES.er[a]}`);
});

test("show_in_the_text_opens_the_pane_on_the_column_line", async () => {
  const shop = 'diagram er "Shop"\ncustomers {\n  id int pk\n}\norders {\n  id int pk\n  customer_id int\n  total numeric\n}\norders.customer_id > customers.id\n';
  const board = [CHECKOUT, shop].join("\n");
  const layout = JSON.stringify({
    version: 2,
    frames: { Checkout: entry(0, { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }), Shop: entry(1200, { customers: { x: 0, y: 0 }, orders: { x: 400, y: 0 } }) },
    sketches: [],
  });
  const s = setup(board, layout);
  await opened(["Checkout", "Shop"]);
  await pick(s, "ER diagram", "Shop", "orders");
  // Close enough to read the rows: zoomed out, a card draws as a plain box.
  const p = canvas.instance!.getInternalNode("orders")!.internals.positionAbsolute;
  await act(async () => void (await canvas.instance!.setCenter(p.x, p.y, { zoom: 1 })));
  const row = await waitFor(() => {
    const r = s.container.querySelectorAll<HTMLElement>('.react-flow__node[data-id="orders"] [aria-label="Table orders"] .fkind-er-row')[2];
    expect(r).toBeTruthy();
    return r;
  });
  fireEvent.contextMenu(row, { clientX: 300, clientY: 220 });
  const menu = await screen.findByRole("menu", { name: "orders.total actions" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Show in the text" }));
  await waitFor(() => expect(s.view().state.doc.lineAt(s.view().state.selection.main.head).text).toBe("  total numeric"));
  // At the column's name, where its row span starts (decision 13).
  expect(s.view().state.selection.main.head).toBe(board.indexOf("total numeric"));
  expect(s.text()).toBe(board);
});
