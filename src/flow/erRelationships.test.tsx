// ER build C, in the diagram tab (erd-ux-research 5.4, 5.7, A6): relationships drawn from a column's port onto a
// column or a header, the relationship's menu and label, renames and deletes that carry their lines, and a table
// added by a double-click on the empty canvas. Every gesture writes exactly its lines, as one undo step.
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { LangClient } from "../lang/client";
import { routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const ER = lines(
  'diagram er "Billing"',
  "customers",
  "customers.id int [pk]",
  "customers.email text [not null]",
  "invoices",
  "invoices.id int [pk]",
  "invoices.customer_id int",
  "invoices.note text",
);
const LINKED = `${ER}\ninvoices.customer_id *--1 customers.id\n`;
/** jsdom has no layout: every card measures 800 px wide on the canvas (mockReactFlowDom). */
const MEASURED_W = 800;
const LAYOUT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 400, y: 0 } } });

function setup(text = ER, layout: string | null = LAYOUT) {
  routeInvoke({ read_diagram: () => ({ text, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="rel" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const card = (table: string) => utils.container.querySelector(`.react-flow__node [aria-label="Entity ${table}"]`) as HTMLElement | null;
  const node = (table: string) => utils.container.querySelector(`.react-flow__node[data-id="${table}"]`) as HTMLElement;
  const edge = (i: number) => utils.container.querySelector(`.react-flow__edge[data-id="edge:${i}"]`) as HTMLElement | null;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const field = (label: string) => screen.findByLabelText(label, { selector: "input" }) as Promise<HTMLInputElement>;
  const type = (from: number, insert: string) => act(() => void view().dispatch({ changes: { from, insert }, userEvent: "input.type" }));
  const at = (table: string) => canvas.props!.nodes.find((n) => n.id === table)!.position;
  return { ...utils, view, doc, card, node, edge, strip, canvasEl, press, field, type, at };
}
type Setup = ReturnType<typeof setup>;

async function drawn(s: Setup, table = "invoices") {
  await waitFor(() => expect(s.card(table)).not.toBeNull(), { timeout: 4000 });
}

async function oneUndo(s: Setup, before: string) {
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(before));
}

const notice = (s: Setup) => s.strip().querySelector(".flow-notice")?.textContent ?? "";

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
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.customer_id *--1 customers.id\n`));
  expect(notice(s)).toBe("Linked invoices.customer_id *--1 customers.id. Right-click the line to change it.");
  await oneUndo(s, ER);
});

test("a drag from a key to the column that refers to it is written from the referring column", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "customers", port: "col:id" }, { node: "invoices", port: "col:customer_id" }, false));
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.customer_id *--1 customers.id\n`));
  // Two keys are one to one.
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:id" }, { node: "customers", port: "col:id" }, false));
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.customer_id *--1 customers.id\ninvoices.id 1--1 customers.id\n`));
  expect(notice(s)).toBe("Linked invoices.id 1--1 customers.id. Right-click the line to change it.");
});

test("a drop let go over a row, not on its port, joins that row's column", async () => {
  const s = setup();
  await drawn(s);
  const c = s.at("customers");
  // customers' first row (id) is 47 px down its card.
  act(() => canvas.props!.onConnectRelease!({ node: "invoices", port: "col:customer_id" }, { x: c.x + 90, y: c.y + 47 }));
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.customer_id *--1 customers.id\n`));
  // A port it snapped to elsewhere on the card yields to where it was let go.
  act(() => canvas.props!.onConnectPorts!({ node: "customers", port: "col:email" }, { node: "invoices", port: "l" }, false, { x: s.at("invoices").x + 90, y: s.at("invoices").y + 47 + 22 * 2 }));
  // No key at either end: the board's many to one, as dragged.
  await waitFor(() => expect(s.doc()).toContain("customers.email *--1 invoices.note\n"));
});

test("fix 1: a column dropped on a table's header joins that table's key, as one undo step", async () => {
  const s = setup();
  await drawn(s);
  const c = s.at("customers");
  act(() => canvas.props!.onConnectRelease!({ node: "invoices", port: "col:customer_id" }, { x: c.x + 60, y: c.y + 12 }));
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.customer_id *--1 customers.id\n`));
  expect(notice(s)).toBe("Linked invoices.customer_id *--1 customers.id. Right-click the line to change it.");
  await oneUndo(s, ER);
  // A header with no key refuses, as the board does.
  const keyless = `${ER}logs\nlogs.msg text\n`;
  s.view().dispatch({ changes: { from: 0, to: s.doc().length, insert: keyless } });
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === "logs")).toBe(true));
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:note" }, { node: "logs", port: "l" }, false, { x: s.at("logs").x + 60, y: s.at("logs").y + 12 }));
  await waitFor(() => expect(notice(s)).toBe("logs has no primary key. Drop on one of its columns instead."));
  expect(s.doc()).toBe(keyless);
});

test("fix 1: a drag from a table's own port adds the singular table plus its key to the source table, as one undo step", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "r" }, { node: "customers", port: "l" }, false, { x: 10, y: 10 }));
  // invoices already has customer_id: the board links it and adds nothing (fix round 2, I2).
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.customer_id *--1 customers.id\n`));
  expect(notice(s)).toBe("Linked invoices.customer_id *--1 customers.id. Right-click the line to change it.");
  await oneUndo(s, ER);
  act(() => canvas.props!.onConnectPorts!({ node: "customers", port: "r" }, { node: "invoices", port: "l" }, false));
  const after = `${ER.replace("customers.email text [not null]\n", "customers.email text [not null]\ncustomers.invoice_id int [not null]\n")}\ncustomers.invoice_id *--1 invoices.id\n`;
  await waitFor(() => expect(s.doc()).toBe(after));
  expect(notice(s)).toBe("Added customers.invoice_id and linked it to invoices.id, in one undo step.");
  await oneUndo(s, ER);
});

test("a drop on the same column, an incompatible column or nowhere refuses with the reason", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:note" }, { node: "invoices", port: "col:note" }, false));
  await waitFor(() => expect(notice(s)).toBe("A column cannot refer to itself. Drop on another column."));
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:note" }, { node: "customers", port: "col:id" }, false));
  await waitFor(() => expect(notice(s)).toBe("No line made: invoices.note is text and customers.id is int. A relationship joins columns of one type."));
  act(() => canvas.props!.onConnectRelease!({ node: "invoices", port: "col:note" }, { x: -500, y: -500 }));
  await waitFor(() => expect(notice(s)).toBe("No line made: drop on a column of another table."));
  expect(s.doc()).toBe(ER);
});

test("a relationship between two columns of one table is drawn as a loop on its right", async () => {
  const text = lines('diagram er "Staff"', "staff", "staff.id int [pk]", "staff.manager_id int");
  const s = setup(text, JSON.stringify({ version: 1, nodes: { staff: { x: 100, y: 50 } } }));
  await drawn(s, "staff");
  act(() => canvas.props!.onConnectPorts!({ node: "staff", port: "col:manager_id" }, { node: "staff", port: "col:id" }, false));
  await waitFor(() => expect(s.doc()).toBe(`${text}\nstaff.manager_id *--1 staff.id\n`));
  await waitFor(() => expect(s.edge(0)).not.toBeNull());
  const d = s.edge(0)!.querySelector("path")!.getAttribute("d")!;
  // Out of manager_id's row (69 px down), round on the right, into id's row (47 px down).
  expect(d.startsWith(`M ${100 + MEASURED_W} ${50 + 69} L ${100 + MEASURED_W + 16}`)).toBe(true);
  expect(d.endsWith(`L ${100 + MEASURED_W} ${50 + 47}`)).toBe(true);
});

test("a relationship between columns meets each card at its column's row", async () => {
  const s = setup(LINKED, JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 1000, y: 30 } } }));
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  const d = s.edge(0)!.querySelector("path")!.getAttribute("d")!;
  // From invoices' left side at customer_id (its second row, 69 px down), to customers' right side at id (47 px down).
  expect(d.startsWith(`M 1000 ${30 + 69}`)).toBe(true);
  expect(d.endsWith(`L ${MEASURED_W} 47`)).toBe(true);
});

test("A6 renaming a column on the card rewrites its relationships, as one undo step", async () => {
  const s = setup(LINKED);
  await drawn(s);
  const row = [...s.card("invoices")!.querySelectorAll<HTMLElement>(".fkind-er-row")].find((r) => r.querySelector(".fkind-col")?.textContent === "customer_id")!;
  fireEvent.doubleClick(row.querySelector(".fkind-col")!);
  const box = await s.field("Column name");
  await userEvent.clear(box);
  await userEvent.type(box, "client_id{Enter}");
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("invoices.customer_id int", "invoices.client_id int").replace("invoices.customer_id *--1", "invoices.client_id *--1")));
  await oneUndo(s, LINKED);
});

test("deleting a column a relationship uses deletes the relationship too, says so, as one undo step", async () => {
  const s = setup(LINKED);
  await drawn(s);
  const row = [...s.card("invoices")!.querySelectorAll<HTMLElement>(".fkind-er-row")].find((r) => r.querySelector(".fkind-col")?.textContent === "customer_id")!;
  fireEvent.click(row);
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(ER.replace("invoices.customer_id int\n", "") + "\n"));
  expect(notice(s)).toBe("Deleted invoices.customer_id and its line. Ctrl+Z brings them back.");
  await oneUndo(s, LINKED);
});

test("the relationship's menu changes the cardinality and swaps the direction of a column relationship", async () => {
  const s = setup(LINKED);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.edge(0)!, { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Relationship actions" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Change cardinality"), expect.stringContaining("Swap direction"), expect.stringContaining("Delete")]));
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Change cardinality" }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Change cardinality" })).getByRole("menuitemcheckbox", { name: "One to one" }));
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("*--1", "1--1")));
  fireEvent.contextMenu(s.edge(0)!, { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Relationship actions" })).getByRole("menuitem", { name: "Swap direction" }));
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("invoices.customer_id *--1 customers.id", "customers.id 1--1 invoices.customer_id")));
});

test("double-click a relationship edits its label in place: Enter keeps it, Esc leaves it, a refusal keeps the text", async () => {
  const s = setup(LINKED);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onEdgeDoubleClick!("edge:0"));
  let box = await s.field("Relationship label");
  await userEvent.type(box, "billed to{Escape}");
  expect(s.doc()).toBe(LINKED);
  act(() => canvas.props!.onEdgeDoubleClick!("edge:0"));
  box = await s.field("Relationship label");
  await userEvent.type(box, "billed to{Enter}");
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("customers.id\n", "customers.id: billed to\n")));
  await oneUndo(s, LINKED);
  // The line goes from the text while the field is open: the typed text stays, with the reason.
  act(() => canvas.props!.onEdgeDoubleClick!("edge:0"));
  box = await s.field("Relationship label");
  await userEvent.type(box, "owes");
  s.type(s.doc().indexOf("invoices.customer_id *--1"), "// ");
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("That line is no longer in the text, so nothing was changed."));
  expect((await s.field("Relationship label")).value).toBe("owes");
});

test("double-click on the empty canvas adds a table at the pointer: its name in edit, Enter goes to its first column", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 500, y: 500 }, flow: { x: 200.6, y: 200.2 } }));
  const box = await s.field("Table name");
  expect([box.value, box.selectionStart, box.selectionEnd]).toEqual(["table_1", 0, 7]);
  // One empty column row is ready under the name.
  expect(s.container.querySelector(".fkind-new-table .fkind-er-row")).not.toBeNull();
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(s.doc()).toBe(`${ER.replace("invoices.note text\n", "invoices.note text\ntable_1\n")}`));
  // At the pointer, on whole pixels: the header's middle under it.
  await waitFor(() => expect(s.at("table_1")).toEqual({ x: 109, y: 184 }));
  const col = await s.field("Column name");
  await userEvent.type(col, "id{Tab}int{Enter}");
  await waitFor(() => expect(s.doc()).toContain("table_1\ntable_1.id int\n"));
});

test("Esc on an untouched new table leaves nothing behind and no undo step", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 500, y: 500 }, flow: { x: 300, y: 400 } }));
  const box = await s.field("Table name");
  await userEvent.type(box, "{Escape}");
  await waitFor(() => expect(s.container.querySelector(".fkind-new-table")).toBeNull());
  expect(s.doc()).toBe(ER);
  act(() => {
    expect(undo(s.view())).toBe(false);
  });
  // A taken name is refused in place and the typed name stays.
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 500, y: 500 }, flow: { x: 300, y: 400 } }));
  const again = await s.field("Table name");
  await userEvent.clear(again);
  await userEvent.type(again, "customers{Enter}");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("customers is already a table in this diagram."));
  expect((await s.field("Table name")).value).toBe("customers");
  expect(s.doc()).toBe(ER);
});

test("Publish draws a relationship between columns at its rows, as the canvas does", async () => {
  const { parseFlow } = await import("../lang/flow/parse");
  const { flowScene } = await import("./flowScene");
  const scene = flowScene(parseFlow(LINKED).doc!, { customers: { x: 0, y: 0 }, invoices: { x: 400, y: 30 } }, "modern", new Map());
  const pts = scene.edges[0].points;
  const cus = scene.nodes.find((n) => n.id === "customers")!;
  // From invoices' left side at customer_id (69 px down its card) to customers' right side at id (47 px down).
  expect(pts[0]).toEqual({ x: 400, y: 30 + 69 });
  expect(pts[pts.length - 1]).toEqual({ x: cus.w, y: 47 });
});

test("F2 on a selected relationship edits its label in place from the keyboard", async () => {
  const s = setup(LINKED);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  s.press("F2");
  const box = await s.field("Relationship label");
  await userEvent.type(box, "owes{Enter}");
  await waitFor(() => expect(s.doc()).toBe(LINKED.replace("customers.id\n", "customers.id: owes\n")));
  await waitFor(() => expect(document.activeElement).toBe(s.canvasEl()));
});

test("fix 1: a line to a row follows the card's rows as they scroll, and ends on the card's edge once the row is out of view", async () => {
  const s = setup(LINKED, JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 1000, y: 30 } } }));
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  const start = () => s.edge(0)!.querySelector("path")!.getAttribute("d")!.split(" L")[0];
  expect(start()).toBe(`M 1000 ${30 + 69}`);
  const body = s.card("invoices")!.querySelector<HTMLElement>(".fkind-er-body")!;
  body.scrollTop = 10;
  fireEvent.scroll(body);
  await waitFor(() => expect(start()).toBe(`M 1000 ${30 + 59}`));
  // Scrolled past it: the line ends on the card's top edge.
  body.scrollTop = 40;
  fireEvent.scroll(body);
  await waitFor(() => expect(start()).toBe("M 1000 30"));
});

/** Drags the selected line's `end` handle and lets go at flow point `p`. */
async function dragEnd(s: Setup, end: "from" | "to", p: { x: number; y: number }) {
  const handle = await waitFor(() => {
    const e = s.container.querySelector(`.flow-line-end[data-end="${end}"]`);
    expect(e).not.toBeNull();
    return e!;
  });
  const t = (s.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([\d.e]+)\)/.exec(t)!;
  const at = { clientX: p.x * Number(m[3]) + Number(m[1]), clientY: p.y * Number(m[3]) + Number(m[2]) };
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, ...at });
  fireEvent.pointerUp(window, { pointerId: 1, ...at });
}

const MOVES = lines(
  'diagram er "Billing"',
  "customers",
  "customers.id int [pk]",
  "invoices",
  "invoices.id int [pk]",
  "invoices.customer_id int",
  "accounts",
  "accounts.code int [pk]",
  "accounts.owner_id int",
  "logs",
  "logs.n int",
  "",
  "invoices.customer_id *--1 customers.id",
);
const MOVES_AT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 300, y: 0 }, accounts: { x: 0, y: 200 }, logs: { x: 300, y: 200 } } });

test("fix 1: a relationship's end dragged onto a column joins that column; onto a header, that table's key", async () => {
  const s = setup(MOVES, MOVES_AT);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await dragEnd(s, "to", { x: 60, y: 200 + 47 + 22 });
  await waitFor(() => expect(s.doc()).toBe(MOVES.replace("*--1 customers.id", "*--1 accounts.owner_id")));
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await dragEnd(s, "to", { x: 60, y: 12 });
  await waitFor(() => expect(s.doc()).toBe(MOVES));
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await dragEnd(s, "to", { x: 60, y: 200 + 12 });
  await waitFor(() => expect(s.doc()).toBe(MOVES.replace("*--1 customers.id", "*--1 accounts.code")));
});

test("fix 1: an end dragged onto a header with no key, or onto a card's body, joins the whole table and says so", async () => {
  const s = setup(MOVES, MOVES_AT);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  await dragEnd(s, "to", { x: 360, y: 200 + 12 });
  await waitFor(() => expect(s.doc()).toBe(MOVES.replace("*--1 customers.id", "*--1 logs")));
  expect(notice(s)).toBe("Dropped on logs. It has no key, so the line joins the table.");
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(MOVES));
  await waitFor(() => expect(canvas.props!.edges[0]?.target).toBe("customers"));
  act(() => canvas.props!.onLineSelect!(["edge:0"]));
  // accounts has two rows (36 + 44 px): below them is its body.
  const h = canvas.props!.nodes.find((n) => n.id === "accounts")!.initialHeight!;
  await dragEnd(s, "to", { x: 60, y: 200 + h - 2 });
  await waitFor(() => expect(s.doc()).toBe(MOVES.replace("*--1 customers.id", "*--1 accounts")));
  expect(notice(s)).toBe("Dropped on accounts, not on a column, so the line joins the table.");
});

test("fix 1b and 2: Add relationship to... links the singular-plus-key column the table already has, as one undo step", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.card("invoices")!.querySelector(".fkind-head")!, { clientX: 450, clientY: 20 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices actions" })).getByRole("menuitem", { name: "Add relationship to..." }));
  fireEvent.pointerDown(s.card("customers")!.querySelector(".fkind-head")!);
  // The column is already there: the board links it and adds nothing (fix round 2, I2).
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.customer_id *--1 customers.id\n`));
  expect(notice(s)).toBe("Linked invoices.customer_id *--1 customers.id. Right-click the line to change it.");
  await oneUndo(s, ER);
});
