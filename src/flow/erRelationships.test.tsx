// ER build C, in the diagram tab (erd-ux-research 5.4, 5.7, A6): relationships drawn from a column's port onto a
// column or a header, renames and deletes that carry their lines. Every gesture writes exactly its lines, as one undo
// step.
//
// B3 Task 7: restored on a board (FlowTab as B1's frames.test.tsx renders it), every text in block form with the
// board's arrows (`>` many to one, `-` one to one) and every card queried as `Table <t>` (R17). The column ports, the
// column drags and the Relationship tool (A) come back in `useErRelate` (decisions 4, 7 and 9; R10, R11, R12). The rest
// of the old file comes back with the tasks that own it: the relationship's menu, its label field and F2 (Task 8), the
// end drags onto columns and "Add relationship to..." (Task 9), the table added by a double-click (Task 3, in
// erEditing.test.tsx) and the line that follows scrolled rows (Task 5, in erScroll.test.tsx). From erFix2.test.tsx: I5,
// I6, live bug (b) and M3.
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Node, ReactFlow, ReactFlowProvider, type ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { installTooltipGuard } from "../components/tooltipGuard";
import { LangClient } from "../lang/client";
import { splitFrames } from "../lang/flow/board";
import { ER_NOTES, LINK_NOTES } from "../lang/flow/edits";
import { README_BILLING } from "./fixtures/erBilling";
import { parseFlow } from "../lang/flow/parse";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { boardFrameId, clashInFrameId, inFrameId } from "./board/staticIds";
import { type ErCanvasApi, ErCanvasContext, createErStore } from "./erCanvas";
import { RELATE_MESSAGES } from "./erRelate";
import { createErScrollStore, createErSoleStore, ErScrollContext, ErSoleContext } from "./erScroll";
import { buildFlowGraph, FLOW_NODE_TYPES } from "./flowNodes";
import FlowTab from "./FlowTab";
import { type ErRelateOptions, useErRelate } from "./useErRelate";
import { EDIT_MESSAGES } from "./editWords";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

// The real canvas draws; the test keeps its latest props and its React Flow instance, to drive what jsdom cannot.
const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null }));
vi.mock("../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../diagram/DiagramCanvas")>();
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

/** Counts the measures the canvas is asked for, so stale port bounds show (I6). */
const measures = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@xyflow/react", async (load) => {
  const real = await load<typeof import("@xyflow/react")>();
  return {
    ...real,
    useUpdateNodeInternals: () => {
      const update = real.useUpdateNodeInternals();
      return (id: string | string[]) => {
        measures.calls.push(String(id));
        update(id);
      };
    },
  };
});

/** The tab's ER store and scroll store, as FlowTab hands them to `useErRelate`, so a test counts their listeners. */
const rel = vi.hoisted(() => ({ opts: null as ErRelateOptions | null }));
vi.mock("./useErRelate", async (load) => {
  const real = await load<typeof import("./useErRelate")>();
  return {
    ...real,
    useErRelate: (o: ErRelateOptions) => {
      rel.opts = o;
      return real.useErRelate(o);
    },
  };
});

/** The tab's sole store (the one table selected alone), as FlowTab makes it, so a test reads what it holds. */
const sole = vi.hoisted(() => ({ stores: [] as { is(table: string): boolean }[] }));
vi.mock("./erScroll", async (load) => {
  const real = await load<typeof import("./erScroll")>();
  return {
    ...real,
    createErSoleStore: () => {
      const s = real.createErSoleStore();
      sole.stores.push(s);
      return s;
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
  measures.calls = [];
  rel.opts = null;
  sole.stores = [];
  vi.restoreAllMocks();
});

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const ER = lines(
  'diagram er "Billing"',
  "customers {",
  "  id int pk",
  "  email text not null",
  "}",
  "invoices {",
  "  id int pk",
  "  customer_id int",
  "  note text",
  "}",
);
const LINKED = `${ER}\ninvoices.customer_id > customers.id\n`;
/** jsdom has no layout: every card measures 800 px wide on the canvas (mockReactFlowDom). */
const MEASURED_W = 800;
const LAYOUT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 400, y: 0 } }, style: "modern", direction: "TB" });

type Point = { x: number; y: number };

function setup(text = ER, layout: string | null = LAYOUT, name = "rel") {
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
      <FlowTab name={name} client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  /** Frame `i`'s block of the text. */
  const frame = (i: number) => {
    const t = doc();
    const f = splitFrames(t)[i];
    return t.slice(f.from, f.to);
  };
  const props = () => canvas.props!;
  /** A node on the page by its id (a static one holds a NUL, which no CSS selector can name). */
  const nodeEl = (id: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === id) ?? null;
  const card = (table: string) => nodeEl(table)?.querySelector<HTMLElement>(`[aria-label="Table ${table}"]`) ?? null;
  const cardOf = (id: string, table: string) => nodeEl(id)?.querySelector<HTMLElement>(`[aria-label="Table ${table}"]`) ?? null;
  const node = (table: string) => nodeEl(table)!;
  const edge = (i: number) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__edge")].find((e) => e.getAttribute("data-id") === `edge:${i}`) ?? null;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const pane = () => utils.container.querySelector(".react-flow__pane") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const field = (label: string) => screen.findByLabelText(label, { selector: "input" }) as Promise<HTMLInputElement>;
  const notice = () => strip().querySelector(".flow-notice")?.textContent ?? "";
  /** A live node's place on the board. */
  const at = (table: string) => canvas.props!.nodes.find((n) => n.id === table)!.position;
  const row = (table: string, column: string) =>
    [...card(table)!.querySelectorAll<HTMLElement>(".fkind-er-row")].find((r) => r.querySelector(".fkind-col")?.textContent === column)!;
  const screenAt = (p: Point) => canvas.instance!.flowToScreenPosition(p);
  const bar = () => screen.getByRole("toolbar", { name: "Board tools" });
  const pressed = () => within(bar()).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label"));
  return { ...utils, saved, view, doc, frame, props, nodeEl, card, cardOf, node, edge, strip, canvasEl, pane, press, field, notice, at, row, screenAt, pressed };
}
type Setup = ReturnType<typeof setup>;

async function drawn(s: Setup, table = "invoices") {
  await waitFor(() => expect(s.card(table)).not.toBeNull(), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

async function oneUndo(s: Setup, before: string) {
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(before));
}

/** A press on `el` at flow `from`, moved and let go at flow `to` (a click when the same), as a browser sends it. */
function pressDrag(s: Setup, el: Element, from: Point, to: Point = from) {
  const a = s.screenAt(from);
  const b = s.screenAt(to);
  fireEvent.pointerDown(el, { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  fireEvent.click(el, { clientX: b.x, clientY: b.y });
}

// ---- Restored from 5478210^ (erRelationships.test.tsx)

test("a table shows its column ports on hover or when selected, two per row, and none at rest", async () => {
  const s = setup();
  await drawn(s);
  expect(s.container.querySelectorAll(".fkind-port")).toHaveLength(0);
  fireEvent.pointerEnter(s.card("invoices")!.querySelector(".fkind-er-body")!);
  await waitFor(() => expect(s.node("invoices").querySelectorAll(".fkind-port")).toHaveLength(6));
  const ids = [...s.node("invoices").querySelectorAll<HTMLElement>(".fkind-port")].map((h) => h.dataset.handleid);
  expect(ids.slice(0, 2)).toEqual(["col:id:l", "col:id:r"]);
  fireEvent.pointerLeave(s.card("invoices")!.querySelector(".fkind-er-body")!);
  await waitFor(() => expect(s.node("invoices").querySelectorAll(".fkind-port")).toHaveLength(0));
  act(() => canvas.props!.onSelect!(["customers"]));
  await waitFor(() => expect(s.node("customers").querySelectorAll(".fkind-port")).toHaveLength(4));
});

test("a column dropped on a column makes the relationship at once, cardinality from the keys, one undo step", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:customer_id" }, { node: "customers", port: "col:id" }, false));
  await waitFor(() => expect(s.doc()).toBe(LINKED));
  expect(s.notice()).toBe("Linked invoices.customer_id > customers.id. Right-click the line to change it.");
  // The new line is banded in the pane (decision 14).
  await waitFor(() => expect([...s.container.querySelectorAll(".cm-line.cm-flow-band")].map((e) => e.textContent)).toEqual(["invoices.customer_id > customers.id"]));
  await oneUndo(s, ER);
});

test("a drag from a key to the column that refers to it is written from the referring column", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "customers", port: "col:id" }, { node: "invoices", port: "col:customer_id" }, false));
  await waitFor(() => expect(s.doc()).toBe(LINKED));
  // Two keys are one to one.
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:id" }, { node: "customers", port: "col:id" }, false));
  await waitFor(() => expect(s.doc()).toBe(`${LINKED}invoices.id - customers.id\n`));
  expect(s.notice()).toBe("Linked invoices.id - customers.id. Right-click the line to change it.");
});

test("a drop let go over a row, not on its port, joins that row's column", async () => {
  const s = setup();
  await drawn(s);
  const c = s.at("customers");
  // customers' first row (id) is 47 px down its card.
  act(() => canvas.props!.onConnectRelease!({ node: "invoices", port: "col:customer_id" }, { x: c.x + 90, y: c.y + 47 }));
  await waitFor(() => expect(s.doc()).toBe(LINKED));
  // A port it snapped to elsewhere on the card yields to where it was let go.
  act(() => canvas.props!.onConnectPorts!({ node: "customers", port: "col:email" }, { node: "invoices", port: "l" }, false, { x: s.at("invoices").x + 90, y: s.at("invoices").y + 47 + 22 * 2 }));
  // No key at either end: the board's many to one, as dragged.
  await waitFor(() => expect(s.doc()).toContain("customers.email > invoices.note\n"));
});

test("fix 1: a column dropped on a table's header joins that table's key, as one undo step", async () => {
  const s = setup();
  await drawn(s);
  const c = s.at("customers");
  act(() => canvas.props!.onConnectRelease!({ node: "invoices", port: "col:customer_id" }, { x: c.x + 60, y: c.y + 12 }));
  await waitFor(() => expect(s.doc()).toBe(LINKED));
  expect(s.notice()).toBe("Linked invoices.customer_id > customers.id. Right-click the line to change it.");
  await oneUndo(s, ER);
  // A header with no key refuses, as the board does.
  const keyless = `${ER}logs {\n  msg text\n}\n`;
  act(() => void s.view().dispatch({ changes: { from: 0, to: s.doc().length, insert: keyless } }));
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === "logs")).toBe(true));
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:note" }, { node: "logs", port: "l" }, false, { x: s.at("logs").x + 60, y: s.at("logs").y + 12 }));
  await waitFor(() => expect(s.notice()).toBe("logs has no primary key. Drop on one of its columns instead."));
  expect(s.doc()).toBe(keyless);
});

test("fix 1: a drag from a table's own port adds the singular table plus its key to the source table, as one undo step", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "r" }, { node: "customers", port: "l" }, false, { x: 10, y: 10 }));
  // invoices already has customer_id: the board links it and adds nothing (fix round 2, I2).
  await waitFor(() => expect(s.doc()).toBe(LINKED));
  expect(s.notice()).toBe("Linked invoices.customer_id > customers.id. Right-click the line to change it.");
  await oneUndo(s, ER);
  act(() => canvas.props!.onConnectPorts!({ node: "customers", port: "r" }, { node: "invoices", port: "l" }, false));
  const after = `${ER.replace("  email text not null\n", "  email text not null\n  invoice_id int not null\n")}\ncustomers.invoice_id > invoices.id\n`;
  await waitFor(() => expect(s.doc()).toBe(after));
  expect(s.notice()).toBe("Added customers.invoice_id and linked it to invoices.id, in one undo step.");
  await oneUndo(s, ER);
});

test("a drop on the same column, an incompatible column or nowhere refuses with the reason", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:note" }, { node: "invoices", port: "col:note" }, false));
  await waitFor(() => expect(s.notice()).toBe("A column cannot refer to itself. Drop on another column."));
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:note" }, { node: "customers", port: "col:id" }, false));
  await waitFor(() => expect(s.notice()).toBe("No line made: invoices.note is text and customers.id is int. A relationship joins columns of one type."));
  act(() => canvas.props!.onConnectRelease!({ node: "invoices", port: "col:note" }, { x: -500, y: -500 }));
  await waitFor(() => expect(s.notice()).toBe("No line made: drop on a column of another table."));
  expect(s.doc()).toBe(ER);
});

test("a relationship between two columns of one table is drawn as a loop on its right", async () => {
  const text = lines('diagram er "Staff"', "staff {", "  id int pk", "  manager_id int", "}");
  const s = setup(text, JSON.stringify({ version: 1, nodes: { staff: { x: 100, y: 50 } }, style: "modern", direction: "TB" }));
  await drawn(s, "staff");
  act(() => canvas.props!.onConnectPorts!({ node: "staff", port: "col:manager_id" }, { node: "staff", port: "col:id" }, false));
  await waitFor(() => expect(s.doc()).toBe(`${text}\nstaff.manager_id > staff.id\n`));
  await waitFor(() => expect(s.edge(0)).not.toBeNull());
  const d = s.edge(0)!.querySelector("path")!.getAttribute("d")!;
  // Out of manager_id's row (69 px down), round on the right, into id's row (47 px down).
  expect(d.startsWith(`M ${100 + MEASURED_W} ${50 + 69} L ${100 + MEASURED_W + 16}`)).toBe(true);
  expect(d.endsWith(`L ${100 + MEASURED_W} ${50 + 47}`)).toBe(true);
});

test("a relationship between columns meets each card at its column's row", async () => {
  const s = setup(LINKED, JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 1000, y: 30 } }, style: "modern", direction: "TB" }));
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  const d = s.edge(0)!.querySelector("path")!.getAttribute("d")!;
  // From invoices' left side at customer_id (its second row, 69 px down), to customers' right side at id (47 px down).
  expect(d.startsWith(`M 1000 ${30 + 69}`)).toBe(true);
  expect(d.endsWith(`L ${MEASURED_W} 47`)).toBe(true);
});

test("A6 renaming a column on the card rewrites its relationships, as one undo step", async () => {
  const s = setup(LINKED);
  await drawn(s);
  fireEvent.doubleClick(s.row("invoices", "customer_id").querySelector(".fkind-col")!);
  const box = await s.field("Column name");
  await userEvent.clear(box);
  await userEvent.type(box, "client_id{Enter}");
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("  customer_id int", "  client_id int").replace("invoices.customer_id >", "invoices.client_id >")));
  await oneUndo(s, LINKED);
});

test("deleting a column a relationship uses deletes the relationship too, says so, as one undo step", async () => {
  const s = setup(LINKED);
  await drawn(s);
  fireEvent.click(s.row("invoices", "customer_id"));
  s.press("Delete");
  await waitFor(() => expect(s.doc()).not.toContain("customer_id"));
  expect(s.doc().startsWith(ER.replace("  customer_id int\n", ""))).toBe(true);
  expect(s.notice()).toBe("Deleted invoices.customer_id and its line. Ctrl+Z brings them back.");
  await oneUndo(s, LINKED);
});

test("Publish draws a relationship between columns at its rows, as the canvas does", async () => {
  const { flowScene } = await import("./flowScene");
  const scene = flowScene(parseFlow(LINKED).doc!, { customers: { x: 0, y: 0 }, invoices: { x: 400, y: 30 } }, "modern", new Map());
  const pts = scene.edges[0].points;
  const cus = scene.nodes.find((n) => n.id === "customers")!;
  // From invoices' left side at customer_id (69 px down its card) to customers' right side at id (47 px down).
  expect(pts[0]).toEqual({ x: 400, y: 30 + 69 });
  expect(pts[pts.length - 1]).toEqual({ x: cus.w, y: 47 });
});

// ---- Restored from 5478210^ (erFix2.test.tsx)

test("M3 deleting a column takes its lines and says so in the board's words, with Ctrl+Z to bring them back", async () => {
  const s = setup(LINKED);
  await drawn(s);
  fireEvent.click(s.row("invoices", "customer_id"));
  fireEvent.keyDown(s.canvasEl(), { key: "Delete" });
  await waitFor(() => expect(s.notice()).toBe("Deleted invoices.customer_id and its line. Ctrl+Z brings them back."));
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(LINKED));
});

test("I5 select all shows no column ports and measures no card; one selected table shows its ports", async () => {
  const many = lines('diagram er "Many"', ...Array.from({ length: 6 }, (_, i) => [`t${i} {`, "  id int pk", "  note text", "}"]).flat());
  const at = JSON.stringify({ version: 1, nodes: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`t${i}`, { x: (i % 3) * 220, y: Math.floor(i / 3) * 120 }])), style: "modern", direction: "TB" });
  const s = setup(many, at);
  await drawn(s, "t0");
  const names = Array.from({ length: 6 }, (_, i) => `t${i}`);
  measures.calls = [];
  act(() => canvas.props!.onSelect!(names));
  await waitFor(() => expect(s.node("t0").className).toContain("selected"));
  await new Promise((r) => setTimeout(r, 50));
  expect(s.container.querySelectorAll(".fkind-port")).toHaveLength(0);
  expect(measures.calls).toEqual([]);
  act(() => canvas.props!.onSelect!(["t0"]));
  await waitFor(() => expect(s.node("t0").querySelectorAll(".fkind-port")).toHaveLength(4));
  expect(s.container.querySelectorAll(".fkind-port")).toHaveLength(4);
});

test("I6 rows scrolled under shown ports measure the card again, and a drop takes the row under the pointer, not a stale port", async () => {
  const s = setup();
  await drawn(s);
  const body = s.card("invoices")!.querySelector<HTMLElement>(".fkind-er-body")!;
  fireEvent.pointerEnter(body);
  await waitFor(() => expect(s.node("invoices").querySelectorAll(".fkind-port")).toHaveLength(6));
  measures.calls = [];
  // jsdom fires no scroll event on a scrollTop write (R28): the card's rows report it as the browser would.
  body.scrollTop = 22;
  fireEvent.scroll(body);
  await waitFor(() => expect(measures.calls).toContain("invoices"));
  // React Flow snapped to customers.id's port from bounds of before; the pointer is over customers' email row.
  const c = s.at("customers");
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:note" }, { node: "customers", port: "col:id" }, false, { x: c.x + 90, y: c.y + 47 + 22 }));
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.note > customers.email\n`));
});

test("live bug (b): a column's tooltip goes on a press of its port and stays away over other rows during the drag and after the drop", async () => {
  const off = installTooltipGuard();
  try {
    const s = setup();
    await drawn(s);
    const id = s.row("invoices", "id");
    fireEvent.pointerEnter(s.card("invoices")!.querySelector(".fkind-er-body")!);
    fireEvent.pointerOver(id);
    expect((await screen.findByRole("tooltip", {}, { timeout: 1500 })).textContent).toBe("id int (primary key, not null)");
    const port = await waitFor(() => {
      const p = s.row("invoices", "id").querySelector<HTMLElement>(".fkind-port");
      expect(p).not.toBeNull();
      return p!;
    });
    fireEvent.pointerDown(port, { button: 0 });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerOver(s.row("customers", "email"));
    await new Promise((r) => setTimeout(r, 700));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerUp(window, { button: 0, clientX: 5, clientY: 5 });
    await new Promise((r) => setTimeout(r, 700));
    expect(screen.queryByRole("tooltip")).toBeNull();
  } finally {
    off();
  }
});

// ---- B3 Task 7: the Relationship tool (decision 9, R10, R11, A11)

const SHOP = lines('diagram er "Shop"', "customers {", "  id int pk", "  email text", "}", "orders {", "  id int pk", "  customer_id int", "}", "profiles {", "  id int pk", "  customer_id int", "}");
const SHOP_AT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, orders: { x: 400, y: 0 }, profiles: { x: 400, y: 300 } }, style: "modern", direction: "TB" });

/** A flow point on `table`'s row `row` (-1 its header), 60 px in from its left. */
const rowPoint = (s: Setup, table: string, row: number): Point => ({ x: s.at(table).x + 60, y: s.at(table).y + (row < 0 ? 12 : 47 + 22 * row) });

test("the_relationship_tool_drags_from_a_row_without_its_port", async () => {
  const s = setup(SHOP, SHOP_AT, "shop");
  await drawn(s, "orders");
  s.press("a");
  expect(s.pressed()).toEqual(["Relationship"]);
  // No port is shown: the press is on the row itself.
  expect(s.container.querySelectorAll(".fkind-port")).toHaveLength(0);
  const from = s.row("orders", "customer_id");
  const a = s.screenAt(rowPoint(s, "orders", 1));
  const b = s.screenAt(rowPoint(s, "customers", -1));
  fireEvent.pointerDown(from, { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  // The line leaves at the row and rings the table it would join, its header aimed.
  await waitFor(() => expect(s.container.querySelector(".fkind-head.is-pick")).not.toBeNull());
  expect(s.card("customers")!.contains(s.container.querySelector(".fkind-head.is-pick"))).toBe(true);
  fireEvent.pointerUp(window, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  await waitFor(() => expect(s.doc()).toBe(`${SHOP}\norders.customer_id > customers.id\n`));
  expect(s.container.querySelector(".is-pick")).toBeNull();
  expect(s.pressed()).toEqual(["Select"]);
});

test("the_relationship_tool_joins_by_two_clicks", async () => {
  const s = setup(SHOP, SHOP_AT, "shop");
  await drawn(s, "orders");
  s.press("a");
  pressDrag(s, s.row("orders", "customer_id"), rowPoint(s, "orders", 1));
  await waitFor(() => expect(s.notice()).toBe("From orders.customer_id: click the column or table it refers to."));
  expect(s.doc()).toBe(SHOP);
  expect(s.pressed()).toEqual(["Relationship"]);
  pressDrag(s, s.card("customers")!.querySelector(".fkind-head")!, rowPoint(s, "customers", -1));
  // The arrow inferred from the keys, written from the referring column.
  await waitFor(() => expect(s.doc()).toBe(`${SHOP}\norders.customer_id > customers.id\n`));
  expect(s.notice()).toBe("Linked orders.customer_id > customers.id. Right-click the line to change it.");
  expect(s.pressed()).toEqual(["Select"]);
});

test("shapes_one_to_one_joins_two_columns_with_its_arrow", async () => {
  const s = setup(SHOP, SHOP_AT, "shop");
  await drawn(s, "profiles");
  if (!screen.queryByRole("dialog", { name: "Add to the board" })) await userEvent.click(screen.getByRole("button", { name: "More shapes" }));
  const shelf = await screen.findByRole("dialog", { name: "Add to the board" });
  await userEvent.click(within(within(shelf).getAllByRole("group")[0]).getByRole("option", { name: /^One to one/ }));
  // A Shapes line arms no tool (A11): two clicks, each a press and a click on the card.
  expect(s.pressed()).toEqual(["Select"]);
  pressDrag(s, s.row("profiles", "customer_id"), rowPoint(s, "profiles", 1));
  await waitFor(() => expect(s.notice()).toBe("From profiles.customer_id: click the column or table it refers to."));
  pressDrag(s, s.row("customers", "id"), rowPoint(s, "customers", 0));
  // Written from the first pick to the second with the item's arrow, never turned to the key.
  await waitFor(() => expect(s.doc()).toBe(`${SHOP}\nprofiles.customer_id - customers.id\n`));
});

test("a_refused_reference_shows_the_workers_note", async () => {
  // A dotted table name is plain in Plan A, but the column the board would add (sales.customer_id) is no column name:
  // the worker refuses the addColumn with its note, and the strip says it, not EDIT_MESSAGES.changed.
  const text = lines('diagram er "Shop"', "sales.customers {", "  id int pk", "}", "orders {", "  id int pk", "}");
  const s = setup(text, JSON.stringify({ version: 1, nodes: { "sales.customers": { x: 0, y: 0 }, orders: { x: 400, y: 0 } }, style: "modern", direction: "TB" }), "shop");
  await drawn(s, "orders");
  act(() => canvas.props!.onConnectPorts!({ node: "orders", port: "r" }, { node: "sales.customers", port: "l" }, false));
  await waitFor(() => expect(s.notice()).toBe(ER_NOTES.columnName));
  expect(s.doc()).toBe(text);
});

// ---- B3 Task 7: frames (Review Focus 3, R12)

const FRAME = (title: string, columns = 0) =>
  lines(`diagram er "${title}"`, "customers {", "  id int pk", "}", "orders {", "  id int pk", "  customer_id int", ...Array.from({ length: columns }, (_, i) => `  c${i} text`), "}");
const FRAMES_AT = (titles: string[], gap = { x: 800, y: 0 }) =>
  JSON.stringify({
    version: 2,
    frames: Object.fromEntries(titles.map((t, i) => [t, { at: { x: i * gap.x, y: i * gap.y }, nodes: { customers: { x: 0, y: 0 }, orders: { x: 300, y: 0 } }, style: "modern", direction: "TB" }])),
    sketches: [],
  });

/** Selects a frame by its tab (the first of a repeated title) and waits for its table to be live. */
async function pickFrame(s: Setup, title: string, first = "orders") {
  fireEvent.click((await screen.findAllByRole("button", { name: `ER diagram ${title}` }))[0]);
  await waitFor(() => expect(s.card(first)).not.toBeNull());
}

test("same_table_names_in_two_frames_edit_only_the_selected", async () => {
  const shop = FRAME("Shop");
  const archive = FRAME("Archive");
  const s = setup([shop, archive].join("\n"), FRAMES_AT(["Shop", "Archive"]), "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Archive");
  act(() => canvas.props!.onConnectPorts!({ node: "orders", port: "col:customer_id" }, { node: "customers", port: "col:id" }, false));
  await waitFor(() => expect(s.frame(1)).toBe(`${archive}\norders.customer_id > customers.id\n`));
  expect(s.frame(0)).toBe(shop);
  // A drop let go over the Archive card's row lands in Archive too, never in Shop's same-named table.
  const c = s.at("customers");
  act(() => canvas.props!.onConnectRelease!({ node: "orders", port: "col:id" }, { x: c.x + 60, y: c.y + 47 }));
  await waitFor(() => expect(s.notice()).toBe("Linked orders.id - customers.id. Right-click the line to change it."));
  expect(s.frame(1)).toBe(`${archive}\norders.customer_id > customers.id\norders.id - customers.id\n`);
  expect(s.frame(0)).toBe(shop);
});

test("a_static_same_named_table_draws_none_of_the_live_state", async () => {
  // Three frames with orders, the third a repeated title (a clash frame). The live orders scrolls (30 more columns).
  const shop = FRAME("Shop", 30);
  const s = setup([shop, FRAME("Archive", 30), FRAME("Shop", 30)].join("\n"), FRAMES_AT(["Shop", "Archive"], { x: 0, y: 600 }), "three");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  const statics = [inFrameId("Archive", "orders"), clashInFrameId(2, "orders")];
  const listening = () => [rel.opts!.store.listeners(), rel.opts!.scroll.listeners("orders"), rel.opts!.scroll.listeners("customers")];
  // Fitted, the static frames are previews with no card DOM; zoomed in, every card is drawn.
  const before = listening();
  await act(async () => void (await canvas.instance!.setViewport({ x: 0, y: 0, zoom: 0.5 })));
  for (const id of statics) await waitFor(() => expect(s.cardOf(id, "orders")).not.toBeNull());
  expect(listening()).toEqual(before);
  const clean = () => {
    // The static cards add no listener at any step: only the live cards' own (and, while shown, their ports' measure).
    const ports = (t: string) => (s.card(t)!.querySelector(".fkind-port") ? 1 : 0);
    expect(listening()).toEqual([before[0], before[1] + ports("orders"), before[2] + ports("customers")]);
    for (const id of statics) {
      const c = s.cardOf(id, "orders")!;
      expect(c.querySelector("input")).toBeNull();
      expect(c.querySelector(".is-selected, .is-pick, .fkind-port")).toBeNull();
      expect(c.querySelector<HTMLElement>(".fkind-er-body")!.scrollTop).toBe(0);
    }
  };
  // A field open on the live orders.
  fireEvent.doubleClick(s.row("orders", "customer_id").querySelector(".fkind-col")!);
  await s.field("Column name");
  clean();
  fireEvent.keyDown(await s.field("Column name"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByLabelText("Column name")).toBeNull());
  // A column selected.
  fireEvent.click(s.row("orders", "id"));
  await waitFor(() => expect(s.row("orders", "id").classList.contains("is-selected")).toBe(true));
  clean();
  // Aimed: the Relationship tool's drag over orders' own header.
  s.press("a");
  const a = s.screenAt(rowPoint(s, "orders", 1));
  const b = s.screenAt(rowPoint(s, "orders", -1));
  fireEvent.pointerDown(s.row("orders", "customer_id"), { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  await waitFor(() => expect(s.card("orders")!.querySelector(".fkind-head.is-pick")).not.toBeNull());
  clean();
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(s.container.querySelector(".is-pick")).toBeNull());
  // Hovered: the live card's ports only.
  fireEvent.pointerEnter(s.card("orders")!.querySelector(".fkind-er-body")!);
  await waitFor(() => expect(s.card("orders")!.querySelectorAll(".fkind-port").length).toBeGreaterThan(0));
  clean();
  // Scrolled.
  const body = s.card("orders")!.querySelector<HTMLElement>(".fkind-er-body")!;
  body.scrollTop = 220;
  fireEvent.scroll(body);
  await waitFor(() => expect(rel.opts!.scroll.get("orders")).toBe(220));
  clean();
  // The static card's double-click goes to the pane at its flow point (R29) and selects its own frame.
  const n = canvas.props!.nodes.find((x) => x.id === inFrameId("Archive", "orders"))!;
  const f = canvas.props!.nodes.find((x) => x.id === n.parentId)!;
  const p = s.screenAt({ x: f.position.x + n.position.x + 60, y: f.position.y + n.position.y + 12 });
  fireEvent.doubleClick(s.pane(), { clientX: p.x, clientY: p.y });
  await waitFor(() => expect(screen.getByRole("button", { name: "ER diagram Archive" }).getAttribute("aria-current")).toBe("true"));
});

test("live fix: a column-port drag over a board of frames starts no text selection, and text selects again after it", async () => {
  // WebKit starts a text selection from a press even inside a `user-select: none` card, and the drag carried it over
  // the other frames' line layers: a ::selection wash over the canvas that stayed after the drop (b3-13, b3-15). It
  // asks first with `selectstart`, on the pressed port and again on whatever the drag passes over.
  const flow = lines('diagram flow "Orders"', "Order in [start]", "Check stock", "", "Order in > Check stock");
  const s = setup([FRAME("Billing"), FRAME("Shop"), flow].join("\n"), FRAMES_AT(["Billing", "Shop", "Orders"]), "three");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Billing");
  // Zoomed in, every frame's cards are drawn (fitted, the static frames are previews).
  await act(async () => void (await canvas.instance!.setViewport({ x: 0, y: 0, zoom: 0.5 })));
  await waitFor(() => expect(s.card("orders")).not.toBeNull());
  fireEvent.pointerEnter(s.card("orders")!.querySelector(".fkind-er-body")!);
  const port = await waitFor(() => {
    const p = s.row("orders", "customer_id").querySelector<HTMLElement>(".fkind-port");
    expect(p).not.toBeNull();
    return p!;
  });
  /** Whether a selection may start at `el` (false: its `selectstart` was cancelled). */
  const selects = (el: Element) => fireEvent(el, new Event("selectstart", { bubbles: true, cancelable: true }));
  const shopFrame = s.nodeEl(boardFrameId("Shop"))!;
  const a = port.getBoundingClientRect();
  fireEvent.mouseDown(port, { button: 0, clientX: a.x, clientY: a.y });
  expect(selects(port)).toBe(false);
  fireEvent.mouseMove(document, { button: 0, clientX: a.x + 400, clientY: a.y });
  expect(selects(s.pane())).toBe(false);
  expect(selects(shopFrame)).toBe(false);
  fireEvent.mouseUp(document, { button: 0, clientX: a.x + 400, clientY: a.y });
  // After the drop, text selects as anywhere else (the code pane, a field).
  expect(selects(s.pane())).toBe(true);
  expect(selects(s.container.querySelector(".cm-content")!)).toBe(true);
  // Esc mid-drag leaves nothing either.
  fireEvent.mouseDown(port, { button: 0, clientX: a.x, clientY: a.y });
  fireEvent.mouseMove(document, { button: 0, clientX: a.x + 400, clientY: a.y });
  expect(selects(s.pane())).toBe(false);
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.mouseUp(document, { button: 0, clientX: a.x + 400, clientY: a.y });
  expect(selects(s.pane())).toBe(true);
});

test("a_drop_on_another_frames_table_writes_nothing", async () => {
  const shop = FRAME("Shop");
  const archive = FRAME("Archive");
  const s = setup([shop, archive].join("\n"), FRAMES_AT(["Shop", "Archive"]), "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  // Inside the Archive frame, where its own customers and orders are drawn.
  const box = canvas.props!.nodes.find((n) => n.id === boardFrameId("Archive"))!;
  const at = { x: box.position.x + Number(box.style?.width) / 2, y: box.position.y + Number(box.style?.height) / 2 };
  act(() => canvas.props!.onConnectRelease!({ node: "orders", port: "col:customer_id" }, at));
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.otherFrame));
  act(() => canvas.props!.onConnectPorts!({ node: "orders", port: "col:customer_id" }, { node: "customers", port: "col:id" }, false, at));
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.otherFrame));
  // A table's own port too: no "Add and connect" opens over another frame.
  act(() => canvas.props!.onConnectRelease!({ node: "orders", port: "r" }, at));
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.otherFrame));
  expect(screen.queryByRole("menu", { name: "Add and connect" })).toBeNull();
  expect(s.frame(0)).toBe(shop);
  expect(s.frame(1)).toBe(archive);
});

// ---- B3 Task 7: ports at the board limit (R28, D6; decision 7)

/** Every card's editing context, as the canvas gives it, with nothing behind it. */
function noopApi(): ErCanvasApi {
  const f = () => {};
  return { readOnly: false, editTable: f, editColumn: f, addColumn: f, firstColumn: f, selectColumn: f, pickTable: f, blocked: () => null, pointColumn: f, toggleFlag: f, duplicateColumn: f, deleteColumn: f, commit: f, cancel: f };
}

function tables(n: number, columns: number) {
  const out = ['diagram er "Big"'];
  for (let t = 0; t < n; t++) {
    out.push(`t${t} {`, "  id int pk");
    for (let c = 1; c < columns; c++) out.push(`  c${c} int`);
    out.push("}");
  }
  return `${out.join("\n")}\n`;
}

/** A React Flow canvas of the cards, drawn only where visible as the board draws them (`onlyRenderVisibleElements`). */
function Board({ nodes, sole, scroll = createErScrollStore() }: { nodes: Node[]; sole: string | null; scroll?: ReturnType<typeof createErScrollStore> }) {
  const store = createErStore();
  const soles = createErSoleStore();
  soles.set(sole);
  return (
    <div style={{ width: 1280, height: 800 }}>
      <ReactFlowProvider>
        <ErCanvasContext.Provider value={{ api: noopApi(), store }}>
          <ErScrollContext.Provider value={scroll}>
            <ErSoleContext.Provider value={soles}>
              <ReactFlow nodes={nodes} nodeTypes={FLOW_NODE_TYPES} onlyRenderVisibleElements width={1280} height={800} defaultViewport={{ x: 0, y: 0, zoom: 1 }} />
            </ErSoleContext.Provider>
          </ErScrollContext.Provider>
        </ErCanvasContext.Provider>
      </ReactFlowProvider>
    </div>
  );
}

test("select_all_on_2000_tables_mounts_no_port", () => {
  const d = parseFlow(tables(2000, 20)).doc!;
  const at = Object.fromEntries(d.nodes.map((n, i) => [n.name, { x: (i % 50) * 240, y: Math.floor(i / 50) * 560 }]));
  // Each card as measured once (`handles` given): React Flow then draws only the cards in view, as on the board after
  // its first frame; unmeasured, it draws every card once to measure it.
  const nodes = buildFlowGraph(d, at, "modern").nodes.map((n) => ({ ...n, selected: true, handles: [] }));
  expect(nodes).toHaveLength(2000);
  const { container } = render(<Board nodes={nodes} sole={null} />);
  // Some cards are mounted, each with its 20 rows; none of them, all selected, has a port.
  const cards = container.querySelectorAll(".fkind-er-body");
  expect(cards.length).toBeGreaterThan(0);
  expect(container.querySelectorAll(".fkind-er-row").length).toBe(cards.length * 20);
  expect(container.querySelectorAll(".fkind-port")).toHaveLength(0);
});

test("one_hovered_card_mounts_two_ports_per_drawn_row", async () => {
  const d = parseFlow(tables(1, 300)).doc!;
  const nodes = buildFlowGraph(d, { t0: { x: 0, y: 0 } }, "modern").nodes.map((n) => ({ ...n, handles: [] }));
  const scroll = createErScrollStore();
  const { container } = render(<Board nodes={nodes} sole={null} scroll={scroll} />);
  const body = container.querySelector<HTMLElement>(".fkind-er-body")!;
  // At rest the card alone listens to its scroll; shown, its ports' measure listens too.
  expect(scroll.listeners("t0")).toBe(1);
  fireEvent.pointerEnter(body);
  await waitFor(() => expect(container.querySelectorAll(".fkind-port").length).toBeGreaterThan(0));
  const drawnRows = container.querySelectorAll(".fkind-er-row").length;
  expect(drawnRows).toBeLessThanOrEqual(22);
  expect(container.querySelectorAll(".fkind-port")).toHaveLength(drawnRows * 2);
  expect(container.querySelectorAll(".fkind-port").length).toBeLessThanOrEqual(44);
  // Let go: the ports go after their linger, and nothing of the card keeps listening.
  expect(scroll.listeners("t0")).toBe(2);
  fireEvent.pointerLeave(body);
  await waitFor(() => expect(container.querySelectorAll(".fkind-port")).toHaveLength(0));
  expect(scroll.listeners("t0")).toBe(1);
});

// ---- B3 Task 7 fix round 1: a pick started afresh, and the review's test gaps

/** Picks a line item in the Shelf's Shapes list (B2). */
async function shapesLine(label: RegExp) {
  if (!screen.queryByRole("dialog", { name: "Add to the board" })) await userEvent.click(screen.getByRole("button", { name: "More shapes" }));
  const shelf = await screen.findByRole("dialog", { name: "Add to the board" });
  await userEvent.click(within(within(shelf).getAllByRole("group")[0]).getByRole("option", { name: label }));
}

test("pressing_a_again_starts_the_pick_afresh", async () => {
  // I1: the first click before A was pressed again is not the first half of the next line.
  const s = setup(SHOP, SHOP_AT, "shop");
  await drawn(s, "orders");
  s.press("a");
  pressDrag(s, s.row("orders", "customer_id"), rowPoint(s, "orders", 1));
  await waitFor(() => expect(s.notice()).toBe("From orders.customer_id: click the column or table it refers to."));
  s.press("a");
  expect(s.pressed()).toEqual(["Relationship"]);
  pressDrag(s, s.row("customers", "id"), rowPoint(s, "customers", 0));
  await waitFor(() => expect(s.notice()).toBe("From customers.id: click the column or table it refers to."));
  expect(s.doc()).toBe(SHOP);
});

test("a_shapes_line_picked_while_a_waits_starts_afresh", async () => {
  const s = setup(SHOP, SHOP_AT, "shop");
  await drawn(s, "orders");
  s.press("a");
  pressDrag(s, s.row("orders", "customer_id"), rowPoint(s, "orders", 1));
  await waitFor(() => expect(s.notice()).toBe("From orders.customer_id: click the column or table it refers to."));
  await shapesLine(/^One to one/);
  pressDrag(s, s.row("profiles", "customer_id"), rowPoint(s, "profiles", 1));
  await waitFor(() => expect(s.notice()).toBe("From profiles.customer_id: click the column or table it refers to."));
  expect(s.doc()).toBe(SHOP);
  // The new pick goes on: its second click writes its own line, with its own arrow.
  pressDrag(s, s.row("customers", "id"), rowPoint(s, "customers", 0));
  await waitFor(() => expect(s.doc()).toBe(`${SHOP}\nprofiles.customer_id - customers.id\n`));
});

test("a_shapes_line_picked_while_another_waits_starts_afresh", async () => {
  const s = setup(SHOP, SHOP_AT, "shop");
  await drawn(s, "orders");
  await shapesLine(/^Many to one/);
  pressDrag(s, s.row("orders", "customer_id"), rowPoint(s, "orders", 1));
  await waitFor(() => expect(s.notice()).toBe("From orders.customer_id: click the column or table it refers to."));
  await shapesLine(/^One to one/);
  pressDrag(s, s.row("customers", "id"), rowPoint(s, "customers", 0));
  await waitFor(() => expect(s.notice()).toBe("From customers.id: click the column or table it refers to."));
  expect(s.doc()).toBe(SHOP);
});

test("a_frame_switch_between_the_clicks_drops_the_prompt", async () => {
  const shop = FRAME("Shop");
  const archive = FRAME("Archive");
  const s = setup([shop, archive].join("\n"), FRAMES_AT(["Shop", "Archive"]), "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  s.press("a");
  pressDrag(s, s.row("orders", "customer_id"), rowPoint(s, "orders", 1));
  await waitFor(() => expect(s.notice()).toBe("From orders.customer_id: click the column or table it refers to."));
  await pickFrame(s, "Archive");
  // The prompt named a column of the frame left: it goes, and the tool with it (B1 decision 18).
  expect(s.notice()).not.toContain("From orders.customer_id");
  expect(s.pressed()).toEqual(["Select"]);
  s.press("a");
  pressDrag(s, s.row("customers", "id"), rowPoint(s, "customers", 0));
  await waitFor(() => expect(s.notice()).toBe("From customers.id: click the column or table it refers to."));
  expect(s.frame(0)).toBe(shop);
  expect(s.frame(1)).toBe(archive);
});

test("a_click_on_a_cards_empty_body_picks_nothing", async () => {
  // The press rule: only a row or a header is a pick; the card's empty body is neither, for the click either.
  const s = setup(SHOP, SHOP_AT, "shop");
  await drawn(s, "orders");
  s.press("a");
  const prompt = s.notice();
  pressDrag(s, s.card("orders")!.querySelector(".fkind-er-body")!, rowPoint(s, "orders", 2));
  await new Promise((r) => setTimeout(r, 50));
  expect(s.notice()).toBe(prompt);
  pressDrag(s, s.card("customers")!.querySelector(".fkind-head")!, rowPoint(s, "customers", -1));
  await waitFor(() => expect(s.notice()).toBe("From customers: click the table it refers to."));
  expect(s.doc()).toBe(SHOP);
});

test("a_card_drag_is_not_a_pick", async () => {
  const s = setup(SHOP, SHOP_AT, "shop");
  await drawn(s, "profiles");
  await shapesLine(/^One to one/);
  const prompt = s.notice();
  // Pressed on a row and let go 40 px away: a drag of the card, whose closing click picks nothing.
  const from = rowPoint(s, "profiles", 1);
  pressDrag(s, s.row("profiles", "customer_id"), from, { x: from.x + 40, y: from.y + 40 });
  await new Promise((r) => setTimeout(r, 50));
  expect(s.notice()).toBe(prompt);
  expect(s.doc()).toBe(SHOP);
});

test("an_old_form_frame_says_why_on_the_first_click", async () => {
  // Review Focus 4: an old-form frame draws its last good drawing; the tool's first click already says the note.
  const s = setup(README_BILLING, null, "old");
  await waitFor(() => expect(s.container.querySelector(".flow-problems")).not.toBeNull(), { timeout: 4000 });
  const problems = s.container.querySelector(".flow-problems") as HTMLElement;
  await userEvent.click(within(problems).getAllByRole("button", { name: "Rewrite as table blocks" })[0]);
  await waitFor(() => expect(s.doc()).toContain("orders {\n"));
  await drawn(s, "orders");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(README_BILLING));
  await waitFor(() => expect(s.container.querySelector(".flow-problems")).not.toBeNull());
  s.press("a");
  pressDrag(s, s.row("orders", "customer_id"), rowPoint(s, "orders", 1));
  await waitFor(() => expect(s.notice()).toBe(ER_NOTES.oldForm));
  // No line aims there either: a drag shows no target.
  const a = s.screenAt(rowPoint(s, "orders", 1));
  const b = s.screenAt(rowPoint(s, "customers", -1));
  s.press("a");
  fireEvent.pointerDown(s.row("orders", "customer_id"), { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  await waitFor(() => expect(s.notice()).toBe(ER_NOTES.oldForm));
  expect(s.container.querySelector(".is-pick")).toBeNull();
  fireEvent.pointerUp(window, { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
  expect(s.doc()).toBe(README_BILLING);
});

// ---- B3 Task 8: the relationship's menu (R18) and its label in today's one label field (R9), restored from 5478210^

test("the relationship's menu changes the cardinality and swaps the direction of a column relationship", async () => {
  const s = setup(LINKED);
  await drawn(s);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.edge(0)!, { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Relationship actions" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Cardinality"), expect.stringContaining("Swap direction"), expect.stringContaining("Delete")]));
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Cardinality" }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Cardinality" })).getByRole("menuitemcheckbox", { name: "One to one" }));
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("invoices.customer_id > customers.id", "invoices.customer_id - customers.id")));
  fireEvent.contextMenu(s.edge(0)!, { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Relationship actions" })).getByRole("menuitem", { name: "Swap direction" }));
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("invoices.customer_id > customers.id", "customers.id - invoices.customer_id")));
});

test("double-click a relationship edits its label in place: Enter and Esc keep it, a refusal keeps the text", async () => {
  const s = setup(LINKED);
  await drawn(s);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onEdgeDoubleClick!("edge:0"));
  let box = await s.field("Relationship label");
  // Esc keeps what was typed and ends the edit (the user's decision of 25 Oct), as one undo step.
  await userEvent.type(box, "billed to{Escape}");
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("customers.id\n", "customers.id: billed to\n")));
  await oneUndo(s, LINKED);
  act(() => canvas.props!.onEdgeDoubleClick!("edge:0"));
  box = await s.field("Relationship label");
  await userEvent.type(box, "billed to{Enter}");
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("customers.id\n", "customers.id: billed to\n")));
  await oneUndo(s, LINKED);
  // The line goes from the text while the field is open: the typed text stays, with the reason.
  act(() => canvas.props!.onEdgeDoubleClick!("edge:0"));
  box = await s.field("Relationship label");
  await userEvent.type(box, "owes");
  const at = s.doc().indexOf("invoices.customer_id > customers.id");
  act(() => void s.view().dispatch({ changes: { from: at, insert: "// " }, userEvent: "input.type" }));
  await waitFor(() => expect(s.edge(0)).toBeNull());
  await userEvent.type(await s.field("Relationship label"), "{Enter}");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(LINK_NOTES.gone));
  expect((await s.field("Relationship label")).value).toBe("owes");
  expect(s.doc()).toBe(LINKED.replace("invoices.customer_id >", "// invoices.customer_id >"));
});

test("F2 on a selected relationship edits its label in place from the keyboard", async () => {
  const s = setup(LINKED);
  await drawn(s);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  s.press("F2");
  const box = await s.field("Relationship label");
  await userEvent.type(box, "owes{Enter}");
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("customers.id\n", "customers.id: owes\n")));
  await waitFor(() => expect(document.activeElement).toBe(s.canvasEl()));
});

// ---- B3 Task 9: line ends onto columns and "Add relationship to...", restored from 5478210^

/** Drags the selected line's `end` handle and lets go at flow point `p`. */
async function dragEnd(s: Setup, end: "from" | "to", p: Point) {
  const handle = await waitFor(() => {
    const e = s.container.querySelector(`.flow-line-end[data-end="${end}"]`);
    expect(e).not.toBeNull();
    return e!;
  });
  const at = s.screenAt(p);
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: at.x, clientY: at.y });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: at.x, clientY: at.y });
}

const MOVES = lines(
  'diagram er "Billing"',
  "customers {",
  "  id int pk",
  "}",
  "invoices {",
  "  id int pk",
  "  customer_id int",
  "}",
  "accounts {",
  "  code int pk",
  "  owner_id int",
  "}",
  "logs {",
  "  n int",
  "}",
  "",
  "invoices.customer_id > customers.id",
);
const MOVES_AT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 300, y: 0 }, accounts: { x: 0, y: 200 }, logs: { x: 300, y: 200 } }, style: "modern", direction: "TB" });

test("fix 1: a relationship's end dragged onto a column joins that column; onto a header, that table's key", async () => {
  const s = setup(MOVES, MOVES_AT);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await dragEnd(s, "to", { x: 60, y: 200 + 47 + 22 });
  await waitFor(() => expect(s.doc()).toBe(MOVES.replace("> customers.id", "> accounts.owner_id")));
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await dragEnd(s, "to", { x: 60, y: 12 });
  await waitFor(() => expect(s.doc()).toBe(MOVES));
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await dragEnd(s, "to", { x: 60, y: 200 + 12 });
  await waitFor(() => expect(s.doc()).toBe(MOVES.replace("> customers.id", "> accounts.code")));
});

test("fix 1: an end dragged onto a header with no key, or onto a card's body, joins the whole table and says so", async () => {
  const s = setup(MOVES, MOVES_AT);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await dragEnd(s, "to", { x: 360, y: 200 + 12 });
  await waitFor(() => expect(s.doc()).toBe(MOVES.replace("> customers.id", "> logs")));
  expect(s.notice()).toBe(RELATE_MESSAGES.wholeTable("logs", "key"));
  await oneUndo(s, MOVES);
  await waitFor(() => expect(canvas.props!.edges[0]?.target).toBe("customers"));
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  // accounts has two rows: below them is its body.
  const h = canvas.props!.nodes.find((n) => n.id === "accounts")!.initialHeight!;
  await dragEnd(s, "to", { x: 60, y: 200 + h - 2 });
  await waitFor(() => expect(s.doc()).toBe(MOVES.replace("> customers.id", "> accounts")));
  expect(s.notice()).toBe(RELATE_MESSAGES.wholeTable("accounts", "body"));
});

test("an_end_dragged_onto_a_quoted_tables_column_is_refused_with_its_note", async () => {
  // R6 for a line end (Task 6 carry): a quoted table can have no column end, so the drop writes nothing and says why.
  const text = lines('diagram er "Shop"', '"order:lines" {', "  id int pk", "}", "orders {", "  id int pk", "  line_id int", "}", "items {", "  id int pk", "}", "", "orders.line_id > items.id");
  const s = setup(text, JSON.stringify({ version: 1, nodes: { "order:lines": { x: 0, y: 200 }, orders: { x: 0, y: 0 }, items: { x: 300, y: 0 } }, style: "modern", direction: "TB" }), "shop");
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await dragEnd(s, "to", { x: 60, y: 200 + 47 });
  await waitFor(() => expect(s.notice()).toBe(ER_NOTES.quotedEnd("order:lines")));
  expect(s.doc()).toBe(text);
});

test("fix 1b and 2: Add relationship to... links the singular-plus-key column the table already has, as one undo step", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.card("invoices")!.querySelector(".fkind-head")!, { clientX: 450, clientY: 20 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices actions" })).getByRole("menuitem", { name: "Add relationship to..." }));
  fireEvent.pointerDown(s.card("customers")!.querySelector(".fkind-head")!);
  // The column is already there: the board links it and adds nothing (fix round 2, I2).
  await waitFor(() => expect(s.doc()).toBe(LINKED));
  expect(s.notice()).toBe("Linked invoices.customer_id > customers.id. Right-click the line to change it.");
  await oneUndo(s, ER);
});

test("the_live_column_and_table_menus_offer_the_relationship_items", async () => {
  // Task 8 built both items; Task 9 wires them into the live menus (decision 12's order).
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.row("invoices", "customer_id"), { clientX: 450, clientY: 60 });
  const column = await screen.findByRole("menu", { name: "invoices.customer_id actions" });
  const labels = (m: HTMLElement) => [...m.querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((i) => i.getAttribute("aria-label") ?? i.textContent);
  expect(labels(column).slice(-3)).toEqual(["Make a relationship from here", "Show in the text", "Delete column"]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.contextMenu(s.card("invoices")!.querySelector(".fkind-head")!, { clientX: 450, clientY: 20 });
  const table = await screen.findByRole("menu", { name: "invoices actions" });
  const t = labels(table);
  expect(t.indexOf("Add relationship to...")).toBe(t.indexOf("Add column") + 1);
});

// ---- B3 Task 9: a frame switch ends every ER mode (Review Focus 2)

/** Selects a frame by its tab with a click, as the user does: nothing waits for it. */
const clickTab = (title: string) => fireEvent.click(screen.getAllByRole("button", { name: `ER diagram ${title}` })[0]);
const isCurrent = (title: string) => screen.getAllByRole("button", { name: `ER diagram ${title}` })[0].getAttribute("aria-current") === "true";

test("a_frame_switch_ends_every_er_mode_and_keeps_nothing", async () => {
  const shop = FRAME("Shop", 30);
  const archive = FRAME("Archive", 30);
  const s = setup([shop, archive].join("\n"), FRAMES_AT(["Shop", "Archive"]), "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  const adds = vi.spyOn(window, "addEventListener");
  const removes = vi.spyOn(window, "removeEventListener");
  const prompts = [RELATE_MESSAGES.pick, "Click the table orders refers to. Esc cancels."];
  /** The window listeners added from the pick's menu to its aim (the pick's own among them). */
  let pickFrom = 0;
  let pickTo = 0;
  /** Switched to Archive: nothing of Shop's ER state is left, in the stores, the window or the strip. */
  const leftNothing = async () => {
    await waitFor(() => expect(isCurrent("Archive")).toBe(true));
    await waitFor(() => expect(s.card("orders")).not.toBeNull());
    expect(rel.opts!.store.size()).toBe(0);
    for (const t of ["orders", "customers"]) {
      expect(rel.opts!.scroll.get(t)).toBe(0);
      expect(sole.stores[sole.stores.length - 1].is(t)).toBe(false);
    }
    expect(s.container.querySelector(".is-pick, .fkind-er-row.is-selected, .fkind-er-row input")).toBeNull();
    expect(prompts).not.toContain(s.notice());
    expect(s.strip().querySelector(".flow-aim")).toBeNull();
    // Every window listener the pick added is gone: its focus and its keys.
    const pickListeners = adds.mock.calls.filter((c, i) => c[0] === "focusin" || (c[0] === "keydown" && i >= pickFrom && i < pickTo));
    for (const [type, fn] of pickListeners) expect(removes.mock.calls.some((c) => c[0] === type && c[1] === fn)).toBe(true);
    await pickFrame(s, "Shop");
  };
  // A field open: its one commit lands in Shop.
  fireEvent.doubleClick(s.row("orders", "customer_id").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  await userEvent.clear(name);
  await userEvent.type(name, "buyer_id");
  clickTab("Archive");
  await leftNothing();
  const renamed = shop.replace("  customer_id int", "  buyer_id int");
  expect(s.frame(0)).toBe(renamed);
  // A column selected, its card scrolled.
  fireEvent.click(s.row("orders", "id"));
  await waitFor(() => expect(s.row("orders", "id").classList.contains("is-selected")).toBe(true));
  const body = s.card("orders")!.querySelector<HTMLElement>(".fkind-er-body")!;
  body.scrollTop = 220;
  fireEvent.scroll(body);
  await waitFor(() => expect(rel.opts!.scroll.get("orders")).toBe(220));
  clickTab("Archive");
  await leftNothing();
  // "Make a relationship from here", aimed.
  pickFrom = adds.mock.calls.length;
  fireEvent.contextMenu(s.row("orders", "buyer_id"), { clientX: 450, clientY: 60 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "orders.buyer_id actions" })).getByRole("menuitem", { name: "Make a relationship from here" }));
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.pick));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
  await waitFor(() => expect(s.container.querySelector(".is-pick")).not.toBeNull());
  expect(adds.mock.calls.some((c) => c[0] === "focusin")).toBe(true);
  pickTo = adds.mock.calls.length;
  expect(adds.mock.calls.slice(pickFrom).some((c) => c[0] === "keydown" && c[2] === true)).toBe(true);
  clickTab("Archive");
  await leftNothing();
  // A column paste whose write is still with the worker: it lands in Shop, and the column it selects is Shop's to
  // forget (Task 4 carry).
  fireEvent.pointerDown(s.card("orders")!.querySelector(".fkind-head")!);
  await waitFor(() => expect(s.node("orders").classList.contains("selected")).toBe(true));
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => "customers.phone text" } });
  clickTab("Archive");
  await leftNothing();
  const pasted = renamed.replace("  c29 text\n}", "  c29 text\n  phone text\n}");
  expect(s.frame(0)).toBe(pasted);
  // "Add relationship to...": ended, a later press on a table writes nothing.
  fireEvent.contextMenu(s.card("orders")!.querySelector(".fkind-head")!, { clientX: 450, clientY: 20 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "orders actions" })).getByRole("menuitem", { name: "Add relationship to..." }));
  await waitFor(() => expect(s.notice()).toBe("Click the table orders refers to. Esc cancels."));
  clickTab("Archive");
  await leftNothing();
  clickTab("Archive");
  await waitFor(() => expect(isCurrent("Archive")).toBe(true));
  fireEvent.pointerDown(s.card("customers")!.querySelector(".fkind-head")!);
  await new Promise((r) => setTimeout(r, 50));
  expect(s.frame(0)).toBe(pasted);
  expect(s.frame(1)).toBe(archive);
});

test("a_field_the_worker_refuses_while_a_switch_waits_keeps_the_frame", async () => {
  // Task 3 carry: a refusal that comes back from the worker after the switch began holds the switch, as one made at
  // once does (Excel keeps a cell with an invalid entry): the field keeps what was typed and the strip says why.
  const shop = FRAME("Shop");
  const archive = FRAME("Archive");
  const s = setup([shop, archive].join("\n"), FRAMES_AT(["Shop", "Archive"]), "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  fireEvent.doubleClick(s.row("orders", "customer_id").querySelector(".fkind-type")!);
  const type = await s.field("Column type");
  await userEvent.clear(type);
  await userEvent.type(type, "int(");
  clickTab("Archive");
  await waitFor(() => expect(s.notice()).toBe(ER_NOTES.typeReads("int(")));
  await new Promise((r) => setTimeout(r, 50));
  expect(isCurrent("Shop")).toBe(true);
  expect((await s.field("Column type")).value).toBe("int(");
  expect(s.frame(0)).toBe(shop);
  expect(s.frame(1)).toBe(archive);
});

test("a_relationship_label_the_worker_refuses_while_a_switch_waits_says_why", async () => {
  // Task 8 carry: the label field's refusal is not dropped by the switch: it holds it and says why, as a card field.
  const shop = `${FRAME("Shop")}\norders.customer_id > customers.id\n`;
  const archive = FRAME("Archive");
  const s = setup([shop, archive].join("\n"), FRAMES_AT(["Shop", "Archive"]), "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  await waitFor(() => expect(s.edge(0)).not.toBeNull());
  act(() => canvas.props!.onEdgeDoubleClick!("edge:0"));
  await userEvent.type(await s.field("Relationship label"), "owes");
  // The line goes from the text while the field is open; then another frame's tab is clicked.
  const at = s.doc().indexOf("orders.customer_id > customers.id");
  act(() => void s.view().dispatch({ changes: { from: at, insert: "// " }, userEvent: "input.type" }));
  await waitFor(() => expect(s.edge(0)).toBeNull());
  clickTab("Archive");
  await waitFor(() => expect(s.notice()).toBe(LINK_NOTES.gone));
  await new Promise((r) => setTimeout(r, 50));
  expect(isCurrent("Shop")).toBe(true);
  expect((await s.field("Relationship label")).value).toBe("owes");
  expect(s.frame(1)).toBe(archive);
});

test("the_aim_scrolls_its_row_into_view", async () => {
  // Decision 7: the row the pick aims is scrolled into view at once, as a selected one is.
  const many = Array.from({ length: 30 }, (_, i) => `  n${i} int`);
  const text = lines('diagram er "Shop"', "customers {", "  id int pk", "}", "orders {", "  id int pk", ...many, "}");
  const s = setup(text, JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, orders: { x: 300, y: 0 } }, style: "modern", direction: "TB" }), "shop");
  await drawn(s, "orders");
  fireEvent.contextMenu(s.row("customers", "id"), { clientX: 100, clientY: 60 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "customers.id actions" })).getByRole("menuitem", { name: "Make a relationship from here" }));
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.pick));
  // Up from nothing aimed is the last place: orders' last column, out of the 20 rows shown.
  expect(within(s.card("orders")!).queryByText("n29")).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowUp" });
  const body = s.card("orders")!.querySelector<HTMLElement>(".fkind-er-body")!;
  await waitFor(() => expect(body.scrollTop).toBeGreaterThan(0));
  // The card set its body's scrollTop; jsdom fires no scroll event for it, so the test does (R28).
  fireEvent.scroll(body);
  await waitFor(() => expect(s.row("orders", "n29")?.classList.contains("is-pick")).toBe(true));
  expect(s.strip().querySelector(".flow-aim")!.textContent).toBe("Aim: orders.n29");
});

test("a_space_tap_ends_the_pick", async () => {
  // B1's Space tap is another action: it opens B2's Space box, and the pick ends with no write.
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.row("invoices", "customer_id"), { clientX: 450, clientY: 60 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices.customer_id actions" })).getByRole("menuitem", { name: "Make a relationship from here" }));
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.pick));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
  await waitFor(() => expect(s.container.querySelector(".is-pick")).not.toBeNull());
  fireEvent.pointerMove(s.pane(), { clientX: 400, clientY: 300 });
  fireEvent.keyDown(s.canvasEl(), { key: " " });
  fireEvent.keyUp(s.canvasEl(), { key: " " });
  await screen.findByRole("dialog", { name: "Add here" });
  await waitFor(() => expect(s.container.querySelector(".is-pick")).toBeNull());
  expect(s.notice()).not.toBe(RELATE_MESSAGES.pick);
  expect(s.strip().querySelector(".flow-aim")).toBeNull();
  expect(s.doc()).toBe(ER);
});

test("a_tab_drag_waits_for_a_field_the_worker_refuses_and_moves_nothing", async () => {
  // Fix round 1: a live frame dragged by its tab holds on a field the worker refuses meanwhile, as a switch does:
  // the frame stays where it was and the strip says why.
  const shop = FRAME("Shop");
  const archive = FRAME("Archive");
  const s = setup([shop, archive].join("\n"), FRAMES_AT(["Shop", "Archive"]), "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  fireEvent.doubleClick(s.row("orders", "customer_id").querySelector(".fkind-type")!);
  const type = await s.field("Column type");
  await userEvent.clear(type);
  await userEvent.type(type, "int(");
  const id = boardFrameId("Shop");
  const where = () => canvas.props!.nodes.find((n) => n.id === id)!.position;
  const before = { ...where() };
  act(() => s.props().onFrameDrag!(id, { x: before.x, y: before.y }, false));
  act(() => s.props().onFrameDrag!(id, { x: before.x + 200, y: before.y + 150 }, true));
  await waitFor(() => expect(s.notice()).toBe(ER_NOTES.typeReads("int(")));
  await new Promise((r) => setTimeout(r, 50));
  expect(where()).toEqual(before);
  expect(isCurrent("Shop")).toBe(true);
  await waitFor(() => expect(s.card("orders")).not.toBeNull());
  // Live again, the field opens with what was typed, not the column's old type (Task 3's rule, fix round 2).
  await waitFor(() => expect((screen.getByLabelText("Column type", { selector: "input" }) as HTMLInputElement).value).toBe("int("));
  expect(s.frame(0)).toBe(shop);
  expect(s.frame(1)).toBe(archive);
});

// ---- Final whole-branch review

test("a_relationship_label_the_worker_drops_without_a_note_keeps_its_text_and_the_frame", async () => {
  // I1: the worker gone (a crash, a restart) answers no note: the field stays with what was typed, says the text
  // changed, and the switch waiting for it holds, as a card field does.
  const shop = `${FRAME("Shop")}\norders.customer_id > customers.id\n`;
  const archive = FRAME("Archive");
  const s = setup([shop, archive].join("\n"), FRAMES_AT(["Shop", "Archive"]), "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  await waitFor(() => expect(s.edge(0)).not.toBeNull());
  const real = LangClient.prototype.flowEdit;
  vi.spyOn(LangClient.prototype, "flowEdit").mockImplementation(function (this: LangClient, ...a: Parameters<LangClient["flowEdit"]>) {
    return a[2].op === "setLinkLabel" ? Promise.reject(new Error("the worker restarted")) : real.apply(this, a);
  });
  const before = s.doc();
  act(() => canvas.props!.onEdgeDoubleClick!("edge:0"));
  await userEvent.type(await s.field("Relationship label"), "owes");
  clickTab("Archive");
  await waitFor(() => expect(s.notice()).toBe(EDIT_MESSAGES.changed));
  await new Promise((r) => setTimeout(r, 50));
  expect(isCurrent("Shop")).toBe(true);
  expect((await s.field("Relationship label")).value).toBe("owes");
  expect(s.doc()).toBe(before);
});

test("a_line_pick_whose_prompt_another_notice_replaced_starts_afresh", async () => {
  // Minor 1: the prompt is the pick's life (owner rule); with A still armed, the next click is a first click again.
  const s = setup(SHOP, SHOP_AT, "shop");
  await drawn(s, "orders");
  s.press("a");
  pressDrag(s, s.row("orders", "customer_id"), rowPoint(s, "orders", 1));
  await waitFor(() => expect(s.notice()).toBe("From orders.customer_id: click the column or table it refers to."));
  act(() => rel.opts!.notice("Something else happened."));
  await waitFor(() => expect(s.notice()).toBe("Something else happened."));
  expect(s.pressed()).toEqual(["Relationship"]);
  pressDrag(s, s.row("customers", "id"), rowPoint(s, "customers", 0));
  await waitFor(() => expect(s.notice()).toBe("From customers.id: click the column or table it refers to."));
  expect(s.doc()).toBe(SHOP);
});

test("a_pick_ended_or_unmounted_before_its_frame_cancels_the_focus", () => {
  // Minor 8: startPick's one animation frame is cancelled with the pick, so it never focuses a canvas that is gone.
  const asked: number[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
    asked.push(900 + asked.length);
    return asked[asked.length - 1];
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const o: ErRelateOptions = {
    doc: () => null,
    drawn: () => null,
    run: async () => null,
    frame: () => 0,
    track: () => {},
    band: () => {},
    nodes: () => [],
    frameAt: () => null,
    scroll: createErScrollStore(),
    store: createErStore(),
    stale: () => false,
    locked: () => false,
    notice: () => {},
    canvas: () => null,
  };
  const h = renderHook(() => useErRelate(o));
  act(() => h.result.current.startPick({ table: "orders", column: "customer_id" }));
  const first = asked[asked.length - 1];
  act(() => h.result.current.reset());
  expect(cancel).toHaveBeenCalledWith(first);
  act(() => h.result.current.startPick({ table: "orders", column: "customer_id" }));
  const second = asked[asked.length - 1];
  expect(second).not.toBe(first);
  h.unmount();
  expect(cancel).toHaveBeenCalledWith(second);
});
