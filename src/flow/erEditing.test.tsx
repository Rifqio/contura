// ER build A, in the diagram tab: the in-place editor on the table card, adding columns, rename and keys in
// place. Every gesture writes exactly its line in the text, as one undo step (board ER interactions).
//
// B3 Task 3: restored on a board (FlowTab as B1's frames.test.tsx renders it), every text in block form and every card
// queried as `Table <t>` (R17). The editing is wired into the selected ERD frame: tables are added through one field
// (decision 9, R13, R14), static frames' cards are edited through the pane's double-click (R2), and a frame switch
// commits an open field in its own frame first (decision 8, R4, R26). B3 Task 4 brings back the column keys and the column
// clipboard (decisions 10 and 11, R20, R21, R30).
import { undo, undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { LangClient } from "../lang/client";
import { splitFrames } from "../lang/flow/board";
import { ER_NOTES } from "../lang/flow/edits";
import { parseFlow } from "../lang/flow/parse";
import boardCss from "../styles/flow-board.css?raw";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { boardFrameId, inFrameId } from "./board/staticIds";
import { EDIT_MESSAGES, needsName } from "./editWords";
import { ER_MESSAGES } from "./erCanvas";
import { README_BILLING } from "./fixtures/erBilling";
import FlowTab from "./FlowTab";

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

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
/** The Assistant's lock, held by the test (B3 Task 4 round 2), as shelfAdd.test.tsx holds it. */
const lock = vi.hoisted(() => ({ on: false }));
vi.mock("./ai/useBoardAsk", async (load) => {
  const real = await load<typeof import("./ai/useBoardAsk")>();
  return {
    ...real,
    useBoardAsk: (...a: Parameters<typeof real.useBoardAsk>) => {
      const r = real.useBoardAsk(...a);
      return lock.on ? { ...r, locked: true } : r;
    },
  };
});

afterEach(() => {
  lock.on = false;
  cleanup();
  canvas.props = null;
  canvas.instance = null;
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
  "}",
  "invoices.customer_id > customers.id",
);
const ER_AT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 400, y: 0 } }, style: "modern", direction: "TB" });

type Box = { x: number; y: number; w: number; h: number };

function setup(text = ER, layout: string | null = ER_AT, name = "billing") {
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
  const inst = () => canvas.instance!;
  const nodes = () => props().nodes;
  const nodeOf = (id: string) => nodes().find((n) => n.id === id);
  /** A node on the page by its id (a static one holds a NUL, which no CSS selector can name). */
  const nodeEl = (id: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === id) ?? null;
  /** The live frame's card of `table`. */
  const card = (table: string) => nodeEl(table)?.querySelector<HTMLElement>(`[aria-label="Table ${table}"]`) ?? null;
  /** A static frame's card of `table`. */
  const staticCard = (key: string, table: string) => nodeEl(inFrameId(key, table))?.querySelector<HTMLElement>(`[aria-label="Table ${table}"]`) ?? null;
  const rows = (table: string) => [...card(table)!.querySelectorAll<HTMLElement>(".fkind-er-row")];
  const row = (table: string, column: string) => rows(table).find((r) => r.querySelector(".fkind-col")?.textContent === column)!;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const pane = () => utils.container.querySelector(".react-flow__pane") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const field = (label: string) => screen.findByLabelText(label, { selector: "input, textarea" }) as Promise<HTMLInputElement>;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const banded = () => [...utils.container.querySelectorAll(".cm-line.cm-flow-band")].map((e) => e.textContent);
  const boxOf = (key: string): Box => {
    const n = nodeOf(boardFrameId(key))!;
    return { x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) };
  };
  /** The flow boxes of the shapes inside a frame's box (live or static). */
  const shapesIn = (key: string): Box[] => {
    const f = boxOf(key);
    return nodes()
      .filter((n) => n.type !== "boardFrame")
      .map((n) => (n.parentId ? { x: f.x + n.position.x, y: f.y + n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 } : { x: n.position.x, y: n.position.y, w: n.initialWidth ?? 0, h: n.initialHeight ?? 0 }));
  };
  const screenAt = (p: { x: number; y: number }) => inst().flowToScreenPosition(p);
  /** A click on the live frame's empty space (a click away): the field's blur, and nothing else is picked. */
  const clickAway = async (key = "Billing") => {
    const at = screenAt(freePoint([boxOf(key)], shapesIn(key)));
    await userEvent.pointer({ keys: "[MouseLeft]", target: pane(), coords: { clientX: at.x, clientY: at.y } });
  };
  /** A press on the canvas at flow `from`, let go at `to` (a click when the same), as a browser sends it. */
  const drawAt = (from: { x: number; y: number }, to = from) => {
    const a = screenAt(from);
    const b = screenAt(to);
    fireEvent.pointerDown(pane(), { clientX: a.x, clientY: a.y, button: 0, pointerId: 1 });
    fireEvent.pointerMove(pane(), { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
    fireEvent.pointerUp(pane(), { clientX: b.x, clientY: b.y, button: 0, pointerId: 1 });
    fireEvent.click(pane(), { clientX: b.x, clientY: b.y });
  };
  const newTable = () => utils.container.querySelector<HTMLElement>(".fkind-new-table");
  const layoutOf = () => (saved.layout ? (JSON.parse(saved.layout) as { nodes?: Record<string, unknown>; sizes?: Record<string, unknown> }) : null);
  return { ...utils, saved, view, doc, frame, props, inst, nodes, nodeOf, nodeEl, card, staticCard, rows, row, canvasEl, pane, press, field, strip, banded, boxOf, shapesIn, screenAt, clickAway, drawAt, newTable, layoutOf };
}
type Setup = ReturnType<typeof setup>;

/** A point inside every box of `inside`, on none of `avoid`. */
function freePoint(inside: Box[], avoid: Box[]) {
  const x0 = Math.max(...inside.map((b) => b.x));
  const y0 = Math.max(...inside.map((b) => b.y));
  const x1 = Math.min(...inside.map((b) => b.x + b.w));
  const y1 = Math.min(...inside.map((b) => b.y + b.h));
  for (let y = y1 - 10; y > y0 + 8; y -= 6)
    for (let x = x0 + 10; x < x1 - 8; x += 6) if (!avoid.some((a) => x >= a.x - 4 && x <= a.x + a.w + 4 && y >= a.y - 4 && y <= a.y + a.h + 4)) return { x, y };
  throw new Error("no free point");
}

async function drawn(s: Setup, table = "customers") {
  await waitFor(() => expect(s.card(table)).not.toBeNull(), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
}

/** One undo puts the text back exactly as it was before the gesture. */
async function oneUndo(s: Setup, before: string) {
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(before));
}

/** Selects a table as the keyboard does: focus its node, press Enter. */
async function selectTable(s: Setup, table: string) {
  fireEvent.keyDown(s.nodeEl(table)!, { key: "Enter" });
  await waitFor(() => expect(s.nodeEl(table)!.classList.contains("selected")).toBe(true));
}

/** The selected frame's shapes in the Shelf that More shapes opens on Shapes. */
async function moreShapes() {
  if (!screen.queryByRole("dialog", { name: "Add to the board" })) await userEvent.click(screen.getByRole("button", { name: "More shapes" }));
  const shelf = await screen.findByRole("dialog", { name: "Add to the board" });
  return within(shelf).getAllByRole("group")[0];
}
async function moreShape(label: string) {
  await userEvent.click(within(await moreShapes()).getByRole("option", { name: label }));
}

const replaced = (from: string, to: string) => ER.replace(from, to);

// ---- Restored from 5478210^ (ER build A), in block form

test("double-click the header renames the table in place, everywhere it is named, as one undo step", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-head")!);
  const box = await s.field("Table name");
  // In place on the card, not the details panel.
  expect(s.card("customers")!.contains(box)).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect([box.value, box.selectionStart, box.selectionEnd]).toEqual(["customers", 0, 9]);
  await userEvent.clear(box);
  await userEvent.type(box, "clients{Enter}");
  await waitFor(() => expect(s.doc()).toBe(ER.replace(/customers/g, "clients")));
  await waitFor(() => expect(s.card("clients")).not.toBeNull());
  expect(screen.queryByRole("textbox", { name: "Table name" })).toBeNull();
  await oneUndo(s, ER);
});

test("F2 renames the selected table; Esc keeps the typed name (25 Oct decision) and a click away keeps it", async () => {
  const s = setup();
  await drawn(s);
  await selectTable(s, "invoices");
  s.press("F2");
  let box = await s.field("Table name");
  await userEvent.type(box, "bills{Escape}", { initialSelectionStart: 0, initialSelectionEnd: 8 });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Table name" })).toBeNull());
  await waitFor(() => expect(s.doc()).toBe(ER.replace(/invoices/g, "bills")));
  // One undo step, as Enter.
  await oneUndo(s, ER);
  await waitFor(() => expect(s.card("invoices")).not.toBeNull());
  await selectTable(s, "invoices");
  s.press("F2");
  box = await s.field("Table name");
  await userEvent.clear(box);
  await userEvent.type(box, "bills");
  await s.clickAway();
  await waitFor(() => expect(s.doc()).toBe(ER.replace(/invoices/g, "bills")));
});

test("a taken table name is refused in place and the field stays open", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-head")!);
  const box = await s.field("Table name");
  await userEvent.clear(box);
  // Taken in another case: A's note (decision 3, R7).
  await userEvent.type(box, "Invoices{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe(ER_NOTES.caseTaken("invoices"));
  expect(screen.getByRole("textbox", { name: "Table name" })).toBe(box);
  await userEvent.clear(box);
  await userEvent.type(box, "invoices{Enter}");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(ER_MESSAGES.tableTaken("invoices")));
  expect(s.doc()).toBe(ER);
});

test("double-click empty card space adds a column there: name, Tab, type, Enter keeps adding; Enter on an empty row closes", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-er-body")!);
  const name = await s.field("Column name");
  expect(name.value).toBe("");
  expect(name.placeholder).toBe("column_name");
  await userEvent.type(name, "email2{Tab}");
  // Tab moves to the type; nothing is written yet.
  const type = await s.field("Column type");
  expect(s.doc()).toBe(ER);
  await userEvent.type(type, "text{Enter}");
  const after = replaced("  email text not null\n", "  email text not null\n  email2 text\n");
  await waitFor(() => expect(s.doc()).toBe(after));
  // The new line is banded in the pane (decision 14).
  await waitFor(() => expect(s.banded()).toContain("  email2 text"));
  // The next new row is open, empty.
  const next = await s.field("Column name");
  expect(next.value).toBe("");
  await userEvent.type(next, "{Enter}");
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Column name" }) ?? screen.queryByRole("textbox", { name: "Column name" })).toBeNull());
  expect(s.doc()).toBe(after);
  await oneUndo(s, ER);
});

test("the + column row adds at the end; Esc on the untouched row removes it, Esc after typing keeps the column", async () => {
  const s = setup();
  await drawn(s);
  await userEvent.click(within(s.card("invoices")!).getByRole("button", { name: "Add column" }));
  const name = await s.field("Column name");
  expect(s.rows("invoices").map((r) => r.classList.contains("is-new"))).toEqual([false, false, true]);
  await userEvent.type(name, "{Escape}");
  await waitFor(() => expect(s.rows("invoices")).toHaveLength(2));
  expect(s.doc()).toBe(ER);
  await userEvent.click(within(s.card("invoices")!).getByRole("button", { name: "Add column" }));
  await userEvent.type(await s.field("Column name"), "total{Escape}");
  await waitFor(() => expect(s.doc()).toBe(replaced("  customer_id int\n", "  customer_id int\n  total\n")));
  await waitFor(() => expect(screen.queryByLabelText("Column name")).toBeNull());
});

test("a taken column name is refused in place, the field stays open", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-er-body")!);
  const name = await s.field("Column name");
  await userEvent.type(name, "EMAIL{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe(ER_NOTES.columnTaken("customers", "EMAIL"));
  expect(screen.getByLabelText("Column name")).toBe(name);
  expect(s.doc()).toBe(ER);
});

test("double-click a column's name or type edits it in place; Tab goes name, type, next row", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  expect(name.value).toBe("email");
  await userEvent.clear(name);
  await userEvent.type(name, "mail{Enter}");
  await waitFor(() => expect(s.doc()).toBe(replaced("  email text", "  mail text")));
  await oneUndo(s, ER);
  await waitFor(() => expect(s.row("customers", "id")).toBeTruthy());
  fireEvent.doubleClick(s.row("customers", "id").querySelector(".fkind-type")!);
  const type = await s.field("Column type");
  expect(type.value).toBe("int");
  await userEvent.clear(type);
  await userEvent.type(type, "bigint{Tab}");
  await waitFor(() => expect(s.doc()).toBe(replaced("  id int pk\n  email", "  id bigint pk\n  email")));
  // Tab went on to the next column's name.
  expect((await s.field("Column name")).value).toBe("email");
  await userEvent.type(await s.field("Column name"), "{Shift>}{Tab}{/Shift}");
  expect((await s.field("Column type")).value).toBe("bigint");
});

test("Enter on the last column's type keeps it and starts a new column", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-type")!);
  const type = await s.field("Column type");
  await userEvent.clear(type);
  await userEvent.type(type, "varchar(255){Enter}");
  await waitFor(() => expect(s.doc()).toBe(replaced("  email text", "  email varchar(255)")));
  expect((await s.field("Column name")).value).toBe("");
  expect(s.rows("customers").map((r) => r.classList.contains("is-new"))).toEqual([false, false, true]);
});

test("a click away keeps a column edit (F4)", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.row("invoices", "customer_id").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  await userEvent.clear(name);
  await userEvent.type(name, "client_id");
  await s.clickAway();
  const renamed = ER.replace("  customer_id int", "  client_id int").replace("invoices.customer_id >", "invoices.client_id >");
  await waitFor(() => expect(s.doc()).toBe(renamed));
  // A new row with a name typed is kept on a click away too.
  await userEvent.click(within(s.card("invoices")!).getByRole("button", { name: "Add column" }));
  await userEvent.type(await s.field("Column name"), "due");
  await s.clickAway();
  await waitFor(() => expect(s.doc()).toContain("  client_id int\n  due\n"));
});

test("Shift+Tab goes back a field at the edges too: never past the first, a new row goes to the row above (M3)", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.row("customers", "id").querySelector(".fkind-col")!);
  await userEvent.type(await s.field("Column name"), "{Shift>}{Tab}{/Shift}");
  expect((await s.field("Column name")).value).toBe("id");
  await userEvent.type(await s.field("Column name"), "{Escape}");
  // An empty new row: back to the type of the row above, nothing written.
  await userEvent.click(within(s.card("customers")!).getByRole("button", { name: "Add column" }));
  await userEvent.type(await s.field("Column name"), "{Shift>}{Tab}{/Shift}");
  expect((await s.field("Column type")).value).toBe("text");
  expect(s.doc()).toBe(ER);
  await userEvent.type(await s.field("Column type"), "{Escape}");
  // A named new row is kept, then back to the row above.
  await userEvent.click(within(s.card("customers")!).getByRole("button", { name: "Add column" }));
  await userEvent.type(await s.field("Column name"), "phone{Shift>}{Tab}{/Shift}");
  await waitFor(() => expect(s.doc()).toBe(replaced("  email text not null\n", "  email text not null\n  phone\n")));
  expect((await s.field("Column type")).value).toBe("text");
});

test("the key gutter toggles the primary key; its tip says what a click does", async () => {
  const s = setup();
  await drawn(s);
  const gut = within(s.row("invoices", "customer_id")).getByRole("button", { name: "Primary key" });
  expect(gut.getAttribute("aria-pressed")).toBe("false");
  expect(gut.title).toBe("Click to make it the primary key");
  await userEvent.click(gut);
  await waitFor(() => expect(s.doc()).toBe(replaced("  customer_id int\n", "  customer_id int pk\n")));
  await waitFor(() => expect(within(s.row("invoices", "customer_id")).getByRole("button", { name: "Primary key" }).title).toBe("Primary key. Click to remove"));
  // The key icon follows the text, not the row order.
  expect(s.row("invoices", "customer_id").querySelector(".fkind-key")).not.toBeNull();
});

test("while the text has an error the faded drawing takes no column edits, and says why (I5)", async () => {
  const s = setup();
  await drawn(s);
  const broken = ER.replace("  id int pk\n  email", "  id int pk\n  code text [\n  email");
  act(() => {
    s.view().dispatch({ changes: { from: 0, to: s.doc().length, insert: broken } });
  });
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  // The faded card still shows id, email: a click on email's gutter must not key another line.
  await userEvent.click(within(s.row("customers", "email")).getByRole("button", { name: "Primary key" }));
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-head")!);
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-er-body")!);
  expect(await within(s.strip()).findByText(EDIT_MESSAGES.stale)).toBeTruthy();
  expect(screen.queryByLabelText("Table name")).toBeNull();
  expect(screen.queryByLabelText("Column name")).toBeNull();
  expect(s.doc()).toBe(broken);
});

test("an invalid value on a click away keeps the field open with its reason; Esc tries once more, a second Esc discards (I1)", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-head")!);
  const table = await s.field("Table name");
  await userEvent.clear(table);
  await userEvent.type(table, "invoices");
  await s.clickAway();
  expect((await screen.findByRole("alert")).textContent).toBe(ER_MESSAGES.tableTaken("invoices"));
  expect(screen.getByLabelText("Table name")).toBe(table);
  // Focus is back in the open field, so Esc works at once; a second click away tries again.
  await waitFor(() => expect(document.activeElement).toBe(table));
  await s.clickAway();
  await waitFor(() => expect(document.activeElement).toBe(table));
  expect(table.value).toBe("invoices");
  // A refused value is never kept: the first Esc keeps the reason, the second puts the old name back.
  await userEvent.type(table, "{Escape}");
  expect(screen.getByLabelText("Table name")).toBe(table);
  await userEvent.type(table, "{Escape}");
  await waitFor(() => expect(screen.queryByLabelText("Table name")).toBeNull());
  // A new row and an existing column too.
  await userEvent.click(within(s.card("invoices")!).getByRole("button", { name: "Add column" }));
  const draft = await s.field("Column name");
  await userEvent.type(draft, "two words");
  await s.clickAway();
  expect((await screen.findByRole("alert")).textContent).toBe(ER_NOTES.columnName);
  expect(screen.getByLabelText("Column name")).toBe(draft);
  await userEvent.type(draft, "{Escape}{Escape}");
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const col = await s.field("Column name");
  await userEvent.clear(col);
  await userEvent.type(col, "ID");
  await s.clickAway();
  expect((await screen.findByRole("alert")).textContent).toBe(ER_NOTES.columnTaken("customers", "ID"));
  expect(col.value).toBe("ID");
  expect(s.doc()).toBe(ER);
});

const FLOW = lines('diagram flow "Refund"', "Request in [start]", "Done [end]", "Request in > Done");
const FLOW_AT = JSON.stringify({ version: 1, nodes: { "Request in": { x: 0, y: 0 }, Done: { x: 0, y: 160 } }, style: "modern", direction: "TB" });

test("a flowchart name taken on a click away keeps the F2 field open with its reason (I1)", async () => {
  const s = setup(FLOW, FLOW_AT, "refund-taken");
  await waitFor(() => expect(s.nodeEl("Request in")).not.toBeNull(), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  fireEvent.keyDown(s.nodeEl("Request in")!, { key: "Enter" });
  await waitFor(() => expect(s.nodeEl("Request in")!.classList.contains("selected")).toBe(true));
  s.press("F2");
  const box = await s.field("Rename Request in");
  await userEvent.clear(box);
  // Since step 11 a flowchart shape keeps a taken name as its label (labels.ts), so the refusal a click away meets in a
  // flowchart is the emptied name; the rule under test is the same: the field stays open with its reason.
  await s.clickAway("Refund");
  expect((await screen.findByRole("alert")).textContent).toBe(needsName("start", "flow"));
  expect(screen.getByLabelText("Rename Request in")).toBe(box);
  expect(s.doc()).toBe(FLOW);
});

test("after Enter or Esc the keys work at once: focus is back on the canvas with the column or table selected (I4)", async () => {
  const s = setup();
  await drawn(s);
  const canvasEl = s.canvasEl();
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  await userEvent.clear(name);
  await userEvent.type(name, "mail{Enter}");
  await waitFor(() => expect(s.doc()).toContain("  mail text not null"));
  expect(canvasEl.contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.tagName).not.toBe("INPUT");
  // The column just edited is the selected one, so its keys act on it at once.
  await waitFor(() => expect(s.row("customers", "mail").classList.contains("is-selected")).toBe(true));
  // Esc out of a field: focus back too.
  fireEvent.doubleClick(s.row("customers", "id").querySelector(".fkind-type")!);
  await userEvent.type(await s.field("Column type"), "x{Escape}");
  await waitFor(() => expect(screen.queryByLabelText("Column type")).toBeNull());
  expect(canvasEl.contains(document.activeElement)).toBe(true);
  // A table renamed with Enter: F2 at once edits it again.
  fireEvent.doubleClick(s.card("invoices")!.querySelector(".fkind-head")!);
  const table = await s.field("Table name");
  await userEvent.clear(table);
  await userEvent.type(table, "bills{Enter}");
  await waitFor(() => expect(s.card("bills")).not.toBeNull());
  expect(canvasEl.contains(document.activeElement)).toBe(true);
  await waitFor(() => expect(s.nodeEl("bills")!.classList.contains("selected")).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: "F2" });
  expect((await s.field("Table name")).value).toBe("bills");
});

test("long names end in an ellipsis with the full name as a tip; past 20 columns the card scrolls", async () => {
  const long = "customer_invoice_line_adjustments_archive";
  const cols = Array.from({ length: 25 }, (_, i) => `  c${i} int`);
  // jsdom lays nothing out: the header name is measured cut off, as a long name is.
  const sw = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("fnode-name") ? 999 : 0;
  });
  const s = setup(lines('diagram er "Wide"', `${long} {`, "  adjustment_reason_code_from_upstream_billing_system varchar(255)", ...cols, "}"), null, "wide");
  await drawn(s, long);
  await waitFor(() => expect((s.card(long)!.querySelector(".fkind-head .fnode-name") as HTMLElement).title).toBe(long));
  sw.mockRestore();
  expect(s.row(long, "adjustment_reason_code_from_upstream_billing_system").title).toBe("adjustment_reason_code_from_upstream_billing_system varchar(255) (nullable)");
  // 26 rows, drawn 20 high: 40 + 20 x 22; only the rows in view are drawn (decision 7).
  expect(parseFloat(s.nodeEl(long)!.style.height)).toBe(480);
  expect(s.rows(long).length).toBeLessThanOrEqual(22);
  // The wheel over rows that scroll scrolls them, not the canvas; a card that fits lets the canvas pan.
  expect(s.card(long)!.querySelector(".fkind-er-body")!.classList.contains("nowheel")).toBe(true);
  cleanup();
  const short = setup();
  await drawn(short);
  expect(short.card("customers")!.querySelector(".fkind-er-body")!.classList.contains("nowheel")).toBe(false);
});

test("F2 on a flowchart shape edits its label on the shape; a click away keeps it (F4), and so does Esc", async () => {
  const s = setup(FLOW, FLOW_AT, "refund");
  await waitFor(() => expect(s.nodeEl("Request in")).not.toBeNull(), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  fireEvent.keyDown(s.nodeEl("Request in")!, { key: "Enter" });
  await waitFor(() => expect(s.nodeEl("Request in")!.classList.contains("selected")).toBe(true));
  s.press("F2");
  let box = await s.field("Rename Request in");
  // On the canvas, over the shape: not in the strip above it.
  expect(box.closest(".flow-strip")).toBeNull();
  expect(box.closest(".react-flow")).not.toBeNull();
  await userEvent.type(box, "{End}x{Escape}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Rename Request in" })).toBeNull());
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace(/Request in/g, "Request inx")));
  // Focus is back on the canvas: F2 works at once.
  expect(s.canvasEl().contains(document.activeElement)).toBe(true);
  await oneUndo(s, FLOW);
  await waitFor(() => expect(s.nodeEl("Request in")).not.toBeNull());
  fireEvent.keyDown(s.nodeEl("Request in")!, { key: "Enter" });
  await waitFor(() => expect(s.nodeEl("Request in")!.classList.contains("selected")).toBe(true));
  s.press("F2");
  box = await s.field("Rename Request in");
  await userEvent.clear(box);
  await userEvent.type(box, "Claim");
  await s.clickAway("Refund");
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace(/Request in/g, "Claim")));
});

test("the details panel keeps a changed form on a press outside (F5) and closes an unchanged one", async () => {
  const DFD = lines('diagram dfd "x"', "Customer [entity]", "Orders [store, id: D1]", "Customer > Orders");
  const s = setup(DFD, null, "dfd");
  await waitFor(() => expect(s.nodeEl("Orders")).not.toBeNull(), { timeout: 4000 });
  const details = async () => {
    fireEvent.contextMenu(s.nodeEl("Orders")!, { clientX: 300, clientY: 200 });
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Details..." }));
  };
  await details();
  let panel = await screen.findByRole("dialog", { name: "Edit Orders" });
  fireEvent.pointerDown(s.pane());
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Orders" })).toBeNull());
  expect(s.doc()).toBe(DFD);
  await details();
  panel = await screen.findByRole("dialog", { name: "Edit Orders" });
  const id = within(panel).getByRole("textbox", { name: "Id" });
  await userEvent.clear(id);
  await userEvent.type(id, "D9");
  fireEvent.pointerDown(s.pane());
  await waitFor(() => expect(s.doc()).toBe(DFD.replace("id: D1", "id: D9")));
});

// ---- Restored from erRelationships.test.tsx (ER build C): a table added in place

test("double-click on the empty canvas adds a table at the pointer: its name in edit, Enter goes to its first column", async () => {
  const s = setup();
  await drawn(s);
  const at = freePoint([s.boxOf("Billing")], s.shapesIn("Billing"));
  act(() => s.props().onPaneDoubleClick!({ screen: s.screenAt(at), flow: { x: at.x + 0.6, y: at.y + 0.2 } }));
  const box = await s.field("Table name");
  expect(within(screen.getByRole("group", { name: "New table" })).getByLabelText("Table name")).toBe(box);
  expect([box.value, box.selectionStart, box.selectionEnd]).toEqual(["table_1", 0, 7]);
  // One empty column row is ready under the name.
  expect(s.newTable()!.querySelector(".fkind-er-row")).not.toBeNull();
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(s.doc()).toContain("\ntable_1\n"));
  // At the pointer, on whole pixels: the header's middle under it.
  await waitFor(() => expect(s.nodeOf("table_1")?.position).toEqual({ x: Math.round(at.x + 0.6 - 92), y: Math.round(at.y + 0.2 - 16) }));
  const col = await s.field("Column name");
  expect(s.card("table_1")!.contains(col)).toBe(true);
  await userEvent.type(col, "id{Tab}int{Enter}");
  await waitFor(() => expect(s.doc()).toContain("table_1 {\n  id int\n}\n"));
});

test("Esc on an untouched new table leaves nothing behind and no undo step", async () => {
  const s = setup();
  await drawn(s);
  const at = freePoint([s.boxOf("Billing")], s.shapesIn("Billing"));
  act(() => s.props().onPaneDoubleClick!({ screen: s.screenAt(at), flow: at }));
  const box = await s.field("Table name");
  await userEvent.type(box, "{Escape}");
  await waitFor(() => expect(s.newTable()).toBeNull());
  expect(s.doc()).toBe(ER);
  act(() => {
    expect(undo(s.view())).toBe(false);
  });
  // A taken name is refused in place and the typed name stays.
  act(() => s.props().onPaneDoubleClick!({ screen: s.screenAt(at), flow: at }));
  const again = await s.field("Table name");
  await userEvent.clear(again);
  await userEvent.type(again, "customers{Enter}");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(ER_MESSAGES.tableTaken("customers")));
  expect((await s.field("Table name")).value).toBe("customers");
  expect(s.doc()).toBe(ER);
});

// ---- New in B3 Task 3

test("a_type_with_spaces_is_written_quoted", async () => {
  const s = setup();
  await drawn(s);
  await userEvent.click(within(s.card("customers")!).getByRole("button", { name: "Add column" }));
  await userEvent.type(await s.field("Column name"), "placed_at{Tab}");
  await userEvent.type(await s.field("Column type"), "timestamp with time zone{Enter}");
  await waitFor(() => expect(s.doc()).toBe(replaced("  email text not null\n", '  email text not null\n  placed_at "timestamp with time zone"\n')));
  await waitFor(() => expect(s.row("customers", "placed_at").querySelector(".fkind-type")!.textContent).toBe("timestamp with time zone"));
});

test("an_undo_in_the_pane_under_an_open_column_field_writes_nothing_and_says_so", async () => {
  // Review Focus 1: the text changes under an open field through the history, as the Assistant's path does.
  const BARE = ER.replace("  email text not null\n", "");
  const s = setup(BARE);
  await drawn(s);
  await userEvent.click(within(s.card("customers")!).getByRole("button", { name: "Add column" }));
  await userEvent.type(await s.field("Column name"), "email{Enter}");
  await waitFor(() => expect(s.doc()).toBe(replaced("  email text not null\n", "  email\n")));
  await userEvent.type(await s.field("Column name"), "{Escape}");
  await waitFor(() => expect(s.row("customers", "email")).toBeTruthy());
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  await userEvent.clear(name);
  await userEvent.type(name, "mail");
  // The column's addition is undone under the open field.
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(BARE));
  fireEvent.keyDown(name, { key: "Enter" });
  expect((await screen.findByRole("alert")).textContent).toBe(ER_MESSAGES.columnGone("customers"));
  const still = await s.field("Column name");
  expect(still.value).toBe("mail");
  await new Promise((r) => setTimeout(r, 50));
  expect(s.doc()).toBe(BARE);
});

test("typing_in_the_pane_commits_the_card_field_first", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  await userEvent.clear(name);
  await userEvent.type(name, "mail");
  // A press in the pane takes focus: the field's blur commits it, once, before anything is typed there.
  await userEvent.click(s.container.querySelector(".cm-content") as HTMLElement);
  await waitFor(() => expect(s.doc()).toBe(replaced("  email text", "  mail text")));
  await waitFor(() => expect(screen.queryByLabelText("Column name")).toBeNull());
  expect(undoDepth(s.view().state)).toBe(1);
  await oneUndo(s, ER);
});

test("a_rename_that_would_read_as_a_column_is_refused_in_the_field", async () => {
  // Review Focus 5: names the card refuses before any op, with A's note, so nothing turns the frame old.
  const SALES = ER.replace("invoices {", "sales {\n  id int pk\n}\norders {\n  id int pk\n}\ninvoices {");
  const s = setup(SALES, null);
  await drawn(s, "orders");
  const run = vi.spyOn(LangClient.prototype, "flowEdit");
  fireEvent.doubleClick(s.card("orders")!.querySelector(".fkind-head")!);
  const head = await s.field("Table name");
  await userEvent.clear(head);
  await userEvent.type(head, "sales.orders{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe(ER_MESSAGES.plainName);
  await userEvent.type(head, "{Escape}{Escape}");
  await waitFor(() => expect(screen.queryByLabelText("Table name")).toBeNull());
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const col = await s.field("Column name");
  await userEvent.clear(col);
  await userEvent.type(col, "ID{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe(ER_NOTES.columnTaken("customers", "ID"));
  expect(run).not.toHaveBeenCalled();
  expect(s.doc()).toBe(SALES);
  expect(parseFlow(s.doc()).oldEr).toBe(false);
  expect(within(s.strip()).queryByText(ER_NOTES.oldForm)).toBeNull();
});

test("an_old_frame_card_refuses_until_the_rewrite_then_edits", async () => {
  // Review Focus 4. An old-form frame has errors, so its cards are its last good drawing: here the rewrite of
  // README_BILLING, undone back to the old form under the drawn cards.
  const s = setup(README_BILLING, null);
  await waitFor(() => expect(s.container.querySelector(".flow-problems")).not.toBeNull(), { timeout: 4000 });
  const rewrite = async () => {
    const problems = s.container.querySelector(".flow-problems") as HTMLElement;
    await userEvent.click(within(problems).getAllByRole("button", { name: "Rewrite as table blocks" })[0]);
    await waitFor(() => expect(s.doc()).toContain("orders {\n"));
  };
  await rewrite();
  await drawn(s, "orders");
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(README_BILLING));
  await waitFor(() => expect(s.container.querySelector(".flow-problems")).not.toBeNull());
  // Final review I3: a double-click on the empty canvas says the rewrite note too, not the stale one, though the
  // drawing it shows is the last good one.
  expect(within(s.strip()).queryByText(ER_NOTES.oldForm)).toBeNull();
  const box = s.boxOf("Billing");
  const away = { x: box.x + box.w + 200, y: box.y + 40 };
  act(() => s.props().onPaneDoubleClick!({ screen: s.screenAt(away), flow: away }));
  expect(await within(s.strip()).findByText(ER_NOTES.oldForm)).toBeTruthy();
  expect(within(s.strip()).queryByText(EDIT_MESSAGES.stale)).toBeNull();
  expect(s.newTable()).toBeNull();
  fireEvent.doubleClick(s.row("orders", "total").querySelector(".fkind-col")!);
  expect(await within(s.strip()).findByText(ER_NOTES.oldForm)).toBeTruthy();
  expect(screen.queryByLabelText("Column name")).toBeNull();
  expect(within(s.row("orders", "total")).getByRole("button", { name: "Primary key" }).title).toBe(ER_NOTES.oldForm);
  // The pane's fix applied: the same cards edit, with no reopen.
  await rewrite();
  await waitFor(() => expect(within(s.strip()).queryByText(ER_NOTES.oldForm)).toBeNull());
  fireEvent.doubleClick(s.row("orders", "total").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  expect(name.value).toBe("total");
  expect(s.card("orders")!.contains(name)).toBe(true);
});

const SHOP = lines('diagram er "Shop"', "customers {", "  id int pk", "  email text", "}");
const SALES = lines('diagram er "Sales"', "orders {", "  id int pk", "  total numeric", "}");
const TWO_AT = JSON.stringify({
  version: 2,
  frames: {
    Shop: { at: { x: 0, y: 0 }, nodes: { customers: { x: 0, y: 0 } }, style: "modern", direction: "TB" },
    Sales: { at: { x: 700, y: 0 }, nodes: { orders: { x: 0, y: 0 } }, style: "modern", direction: "TB" },
  },
  sketches: [],
});

/** Selects a frame by its tab and waits for its first table to be live. */
async function pickFrame(s: Setup, title: string, first: string) {
  fireEvent.click(await screen.findByRole("button", { name: `ER diagram ${title}` }));
  await waitFor(() => expect(s.card(first)).not.toBeNull());
}

test("an_old_form_second_frame_refuses_while_frame_0_edits", async () => {
  // Frame 1 is old form: it draws nothing (its text has errors and never worked), and every add there says the note.
  const old = README_BILLING.replace('diagram er "Billing"', 'diagram er "Old"');
  const s = setup([SHOP, old].join("\n"), null);
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop", "customers");
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  expect((await s.field("Column name")).value).toBe("email");
  await userEvent.type(await s.field("Column name"), "{Escape}");
  await waitFor(() => expect(screen.queryByLabelText("Column name")).toBeNull());
  fireEvent.click(await screen.findByRole("button", { name: "ER diagram Old" }));
  await waitFor(() => expect(s.card("customers")).toBeNull());
  // A double-click on its canvas, R plus Enter and Shapes > Table: each says the note and opens nothing.
  const box = s.boxOf("Old");
  const inside = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  act(() => s.props().onPaneDoubleClick!({ screen: s.screenAt(inside), flow: inside }));
  expect(await within(s.strip()).findByText(ER_NOTES.oldForm)).toBeTruthy();
  s.press("r");
  s.press("Enter");
  await moreShape("Table");
  expect(within(s.strip()).getByText(ER_NOTES.oldForm)).toBeTruthy();
  expect(s.newTable()).toBeNull();
  expect(screen.queryByLabelText("Table name")).toBeNull();
  expect(s.frame(1)).toBe(old);
  expect(s.frame(0)).toBe(SHOP);
});

test("the_column_tool_opens_a_draft_on_the_selected_table", async () => {
  const s = setup();
  await drawn(s);
  await selectTable(s, "invoices");
  s.press("c");
  const name = await s.field("Column name");
  expect(s.card("invoices")!.contains(name)).toBe(true);
  expect(s.doc()).toBe(ER);
  await userEvent.type(name, "total{Tab}");
  await userEvent.type(await s.field("Column type"), "numeric{Enter}");
  await waitFor(() => expect(s.doc()).toBe(replaced("  customer_id int\n", "  customer_id int\n  total numeric\n")));
  await waitFor(() => expect(s.banded()).toContain("  total numeric"));
});

test("the_column_tool_with_nothing_selected_asks_for_a_table", async () => {
  const s = setup();
  await drawn(s);
  s.press("c");
  expect(await within(s.strip()).findByText("Click the table to add a column to.")).toBeTruthy();
  act(() => s.props().onSelect!(["customers"]));
  const name = await s.field("Column name");
  expect(s.card("customers")!.contains(name)).toBe(true);
  expect(s.doc()).toBe(ER);
});

test("shapes_column_opens_the_same_draft", async () => {
  const s = setup();
  await drawn(s);
  await selectTable(s, "customers");
  await moreShape("Column");
  const name = await s.field("Column name");
  expect(s.card("customers")!.contains(name)).toBe(true);
  expect(s.rows("customers").map((r) => r.classList.contains("is-new"))).toEqual([false, false, true]);
  expect(s.doc()).toBe(ER);
});

test("r_and_shapes_table_open_the_new_table_field", async () => {
  const s = setup();
  await drawn(s);
  s.press("r");
  s.press("Enter");
  const box = await s.field("Table name");
  expect(s.newTable()!.contains(box)).toBe(true);
  expect(box.value).toBe("table_1");
  expect(s.doc()).toBe(ER);
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(s.doc()).toContain("\ntable_1\n"));
  // Enter goes on to its first column.
  const col = await s.field("Column name");
  await waitFor(() => expect(s.card("table_1")?.contains(col)).toBe(true));
  await userEvent.type(col, "{Escape}");
  await moreShape("Weak table");
  const weak = await s.field("Table name");
  expect(weak.value).toBe("weak_1");
  await userEvent.type(weak, "{Enter}");
  await waitFor(() => expect(s.doc()).toContain("\nweak_1 [weak]\n"));
});

test("esc_on_a_new_table_from_r_leaves_nothing", async () => {
  const s = setup();
  await drawn(s);
  s.press("r");
  s.press("Enter");
  const box = await s.field("Table name");
  await userEvent.type(box, "{Escape}");
  await waitFor(() => expect(s.newTable()).toBeNull());
  expect(s.doc()).toBe(ER);
  expect(undoDepth(s.view().state)).toBe(0);
});

test("every_er_table_add_opens_the_field", async () => {
  // R13: every way an ER table is added opens the one field, and nothing is written until it is kept.
  const s = setup();
  await drawn(s);
  const opens = async () => {
    const box = await s.field("Table name");
    expect(s.newTable()!.contains(box)).toBe(true);
    expect(s.doc()).toBe(ER);
    await userEvent.type(box, "{Escape}");
    await waitFor(() => expect(s.newTable()).toBeNull());
  };
  // R plus Enter.
  s.press("r");
  s.press("Enter");
  await opens();
  // R clicked into the frame.
  s.press("r");
  s.drawAt(freePoint([s.boxOf("Billing")], s.shapesIn("Billing")));
  await opens();
  // The pane menu's Add here > Table.
  const at = s.screenAt(freePoint([s.boxOf("Billing")], s.shapesIn("Billing")));
  fireEvent.contextMenu(s.pane(), { clientX: at.x, clientY: at.y });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Add here" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Table/ }));
  await opens();
  // Shapes > Table.
  await moreShape("Table");
  await opens();
  expect(undoDepth(s.view().state)).toBe(0);
  cleanup();
  // The empty diagram card's button.
  const empty = setup('diagram er "New"\n', null, "new");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await userEvent.click(await screen.findByRole("button", { name: /^Add the first node/ }));
  const box = await empty.field("Table name");
  expect(empty.newTable()!.contains(box)).toBe(true);
  expect(empty.doc()).toBe('diagram er "New"\n');
  cleanup();
  // A generic R drawn into an ERD frame of a board with no frame selected.
  const flow = lines('diagram flow "Checkout"', "Cart", "Pay", "Cart > Pay");
  const board = setup(
    [flow, SHOP].join("\n"),
    JSON.stringify({
      version: 2,
      frames: {
        Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
        Shop: { at: { x: 600, y: 0 }, nodes: { customers: { x: 0, y: 0 } }, style: "modern", direction: "TB" },
      },
      sketches: [],
    }),
    "board",
  );
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => expect(board.nodeOf(boardFrameId("Shop"))).toBeTruthy());
  board.press("r");
  const shop = board.boxOf("Shop");
  board.drawAt(freePoint([{ x: shop.x, y: shop.y + shop.h - 60, w: shop.w, h: 60 }], board.shapesIn("Shop")));
  const generic = await board.field("Table name");
  expect(board.newTable()!.contains(generic)).toBe(true);
  expect(board.frame(1)).toBe(SHOP);
});

test("a_table_drag_is_a_click_at_the_press", async () => {
  const s = setup();
  await drawn(s);
  s.press("r");
  const from = freePoint([s.boxOf("Billing")], s.shapesIn("Billing"));
  s.drawAt(from, { x: from.x + 300, y: from.y + 200 });
  const box = await s.field("Table name");
  // The field opens at the press: the header's middle under it (drawSQL and dbdiagram size tables by their columns).
  const card = s.newTable()!;
  expect([parseFloat(card.style.left), parseFloat(card.style.top)]).toEqual([Math.round(from.x - 92), Math.round(from.y - 16)]);
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(s.doc()).toContain("\ntable_1\n"));
  await waitFor(() => expect(s.layoutOf()?.nodes?.table_1).toBeTruthy());
  expect(s.layoutOf()?.sizes?.table_1).toBeUndefined();
});

test("a_double_click_on_empty_erd_canvas_opens_the_new_table_field", async () => {
  const s = setup();
  await drawn(s);
  const inside = freePoint([s.boxOf("Billing")], s.shapesIn("Billing"));
  act(() => s.props().onPaneDoubleClick!({ screen: s.screenAt(inside), flow: inside }));
  expect(await s.field("Table name")).toBeTruthy();
  expect(screen.queryByRole("menu", { name: "Add here" })).toBeNull();
  await userEvent.type(await s.field("Table name"), "{Escape}");
  await waitFor(() => expect(s.newTable()).toBeNull());
  // Outside every frame, with the ERD live: the field too (controller question 2).
  const box = s.boxOf("Billing");
  const outside = { x: box.x + box.w + 200, y: box.y + 40 };
  act(() => s.props().onPaneDoubleClick!({ screen: s.screenAt(outside), flow: outside }));
  expect(await s.field("Table name")).toBeTruthy();
  expect(screen.queryByRole("menu", { name: "Add here" })).toBeNull();
  expect(s.doc()).toBe(ER);
});

test("a_double_click_in_a_flowchart_still_opens_add_here", async () => {
  const s = setup(FLOW, FLOW_AT, "refund");
  await waitFor(() => expect(s.nodeEl("Done")).not.toBeNull(), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  const inside = freePoint([s.boxOf("Refund")], s.shapesIn("Refund"));
  act(() => s.props().onPaneDoubleClick!({ screen: s.screenAt(inside), flow: inside }));
  expect(await screen.findByRole("menu", { name: "Add here" })).toBeTruthy();
  expect(s.newTable()).toBeNull();
});

test("shapes_table_in_an_erd_opens_the_field_and_shows_no_added_toast", async () => {
  const s = setup();
  await drawn(s);
  await moreShape("Table");
  const box = await s.field("Table name");
  // R31, A9: the Shelf closes and no "Added" toast shows for a field.
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add to the board" })).toBeNull());
  expect(screen.queryByText(/^Added /)).toBeNull();
  expect(document.activeElement).toBe(box);
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(s.doc()).toContain("\ntable_1\n"));
  await waitFor(() => expect(s.banded()).toContain("table_1"));
  expect(screen.queryByText(/^Added /)).toBeNull();
});

test("an_old_form_frame_shows_er_shapes_disabled_with_the_rewrite_note", async () => {
  const s = setup(README_BILLING, null);
  await waitFor(() => expect(s.container.querySelector(".flow-problems")).not.toBeNull(), { timeout: 4000 });
  const group = await moreShapes();
  const options = within(group).getAllByRole("option");
  expect(options.length).toBeGreaterThan(0);
  for (const o of options) {
    expect(o.getAttribute("aria-disabled")).toBe("true");
    expect(o.getAttribute("aria-description")).toBe(ER_NOTES.oldForm);
  }
  // A press still says the note in the strip, and writes nothing.
  await userEvent.click(within(group).getByRole("option", { name: "Table" }));
  expect(await within(s.strip()).findByText(ER_NOTES.oldForm)).toBeTruthy();
  expect(s.newTable()).toBeNull();
  expect(s.doc()).toBe(README_BILLING);
});

test("a_double_click_on_a_column_in_another_frame_edits_it", async () => {
  // R2, R29: the dblclick goes to the pane at the flow point of frame 1's orders.total type, never to the static card.
  const s = setup([SHOP, SALES].join("\n"), TWO_AT, "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop", "customers");
  await waitFor(() => expect(s.staticCard("Sales", "orders")).not.toBeNull());
  const stat = s.staticCard("Sales", "orders")!;
  const typeEl = stat.querySelector<HTMLElement>('[data-er-row="1"] [data-er-field="type"]')!;
  expect(typeEl.textContent).toBe("numeric");
  const n = s.nodeOf(inFrameId("Sales", "orders"))!;
  const sales = s.boxOf("Sales");
  // The type's middle on the board: the second row's middle (erRowY at scroll 0), right of the card's middle.
  const flow = { x: sales.x + n.position.x + (n.initialWidth ?? 184) - 30, y: sales.y + n.position.y + 47 + 22 };
  const at = s.screenAt(flow);
  // jsdom lays nothing out: the static card's fields report where they are drawn (decision 5).
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this === typeEl) return DOMRect.fromRect({ x: at.x - 40, y: at.y - 11, width: 80, height: 22 });
    return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
  });
  fireEvent.doubleClick(s.pane(), { clientX: at.x, clientY: at.y });
  const type = await s.field("Column type");
  expect(type.value).toBe("numeric");
  expect(s.card("orders")!.contains(type)).toBe(true);
  vi.mocked(Element.prototype.getBoundingClientRect).mockRestore();
  await userEvent.clear(type);
  await userEvent.type(type, "money{Enter}");
  await waitFor(() => expect(s.frame(1)).toBe(SALES.replace("total numeric", "total money")));
  expect(s.frame(0)).toBe(SHOP);
});

test("static_frames_take_no_pointer_events", () => {
  // R29: jsdom ignores pointer-events, so the rule that sends a static card's double-click to the pane is read here.
  expect(boardCss).toMatch(/\.board-static \*[^{]*\{[^}]*pointer-events:\s*none/);
});

test("a_frame_switch_commits_an_open_field_once", async () => {
  const s = setup([SHOP, SALES].join("\n"), TWO_AT, "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop", "customers");
  const run = vi.spyOn(LangClient.prototype, "flowEdit");
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  await userEvent.clear(name);
  await userEvent.type(name, "mail");
  await pickFrame(s, "Sales", "orders");
  await waitFor(() => expect(s.frame(0)).toBe(SHOP.replace("  email text", "  mail text")));
  expect(s.frame(1)).toBe(SALES);
  expect(run).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("Column name")).toBeNull();
});

test("renaming_the_frame_keeps_er_state", async () => {
  const many = lines('diagram er "Shop"', "customers {", ...Array.from({ length: 30 }, (_, i) => `  c${i} int`), "}");
  const s = setup(many, null, "shop");
  await drawn(s);
  fireEvent.click(s.row("customers", "c1"));
  await waitFor(() => expect(s.row("customers", "c1").classList.contains("is-selected")).toBe(true));
  const body = s.card("customers")!.querySelector(".fkind-er-body") as HTMLElement;
  body.scrollTop = 220;
  fireEvent.scroll(body);
  await waitFor(() => expect(s.rows("customers")[0].querySelector(".fkind-col")!.textContent).not.toBe("c0"));
  const first = s.rows("customers")[0].querySelector(".fkind-col")!.textContent;
  // Renamed in the frame bar: the same frame (B1's identity key), so nothing resets.
  const title = within(s.container.querySelector(".frame-bar") as HTMLElement).getByRole("textbox", { name: "Frame name" });
  await userEvent.clear(title);
  await userEvent.type(title, "Store{Enter}");
  await waitFor(() => expect(s.doc()).toContain('diagram er "Store"'));
  await new Promise((r) => setTimeout(r, 50));
  expect(s.rows("customers")[0].querySelector(".fkind-col")!.textContent).toBe(first);
  // The selected column was scrolled out of view: it is still the selected one when scrolled back.
  body.scrollTop = 0;
  fireEvent.scroll(body);
  await waitFor(() => expect(s.row("customers", "c1").classList.contains("is-selected")).toBe(true));
});

test("a_column_commit_awaiting_the_worker_lands_in_its_own_frame", async () => {
  // R4: a slow worker answer and a tab click meanwhile: the column is in frame 0's text, frame 1's unchanged.
  const s = setup([SHOP, SALES].join("\n"), TWO_AT, "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop", "customers");
  await userEvent.click(within(s.card("customers")!).getByRole("button", { name: "Add column" }));
  await userEvent.type(await s.field("Column name"), "phone");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const real = LangClient.prototype.flowEdit;
  const slow = vi.spyOn(LangClient.prototype, "flowEdit").mockImplementation(function (this: LangClient, ...a: Parameters<LangClient["flowEdit"]>) {
    return gate.then(() => real.apply(this, a));
  });
  fireEvent.click(await screen.findByRole("button", { name: "ER diagram Sales" }));
  await waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
  release();
  await waitFor(() => expect(s.card("orders")).not.toBeNull());
  await waitFor(() => expect(s.frame(0)).toBe(SHOP.replace("  email text\n", "  email text\n  phone\n")));
  expect(s.frame(1)).toBe(SALES);
});

test("a_tab_drag_of_the_live_frame_commits_its_card_field", async () => {
  // R26: the live frame dragged by its tab is drawn static: its open card field is kept first, as a switch does.
  const s = setup([SHOP, SALES].join("\n"), TWO_AT, "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop", "customers");
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  await userEvent.clear(name);
  await userEvent.type(name, "mail");
  const box = s.boxOf("Shop");
  act(() => s.props().onFrameDrag!(boardFrameId("Shop"), { x: box.x, y: box.y }, false));
  await waitFor(() => expect(s.frame(0)).toBe(SHOP.replace("  email text", "  mail text")));
  act(() => s.props().onFrameDrag!(boardFrameId("Shop"), { x: box.x, y: box.y }, true));
  expect(s.frame(1)).toBe(SALES);
});

// ---- Task 3 review follow-up: a refused or lost card field keeps its text (Review Focus 1)

test("a_refused_field_keeps_its_text_and_the_frame", async () => {
  // Minor 2: a switch or a tab drag whose blur commit is refused stays in the frame, as a spreadsheet keeps a cell
  // with an invalid entry: the field keeps what was typed and the strip says why.
  const s = setup([SHOP, SALES].join("\n"), TWO_AT, "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop", "customers");
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  await userEvent.clear(name);
  await userEvent.type(name, "ID");
  const before = s.doc();
  fireEvent.click(await screen.findByRole("button", { name: "ER diagram Sales" }));
  const why = ER_NOTES.columnTaken("customers", "ID");
  expect(await within(s.strip()).findByText(why)).toBeTruthy();
  await new Promise((r) => setTimeout(r, 50));
  expect(s.card("customers")).not.toBeNull();
  expect(s.card("orders")).toBeNull();
  expect(screen.getByLabelText("Column name")).toBe(name);
  expect(name.value).toBe("ID");
  // A tab drag of the live frame is refused the same way: the field stays, nothing moves or is written.
  const box = s.boxOf("Shop");
  act(() => s.props().onFrameDrag!(boardFrameId("Shop"), { x: box.x + 40, y: box.y }, false));
  act(() => s.props().onFrameDrag!(boardFrameId("Shop"), { x: box.x + 40, y: box.y }, true));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByLabelText("Column name")).toBe(name);
  expect(name.value).toBe("ID");
  expect(s.card("customers")).not.toBeNull();
  expect(s.doc()).toBe(before);
});

test("a_refused_new_table_name_keeps_its_text_and_the_frame", async () => {
  // Task 11 carry: the new table's field refused on the switch's blur holds the switch as a card field does
  // (blurField's new-table path): the field keeps what was typed, the strip says why, nothing is written.
  const s = setup([SHOP, SALES].join("\n"), TWO_AT, "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop", "customers");
  s.press("r");
  s.press("Enter");
  const box = await s.field("Table name");
  await userEvent.clear(box);
  await userEvent.type(box, "customers");
  const before = s.doc();
  fireEvent.click(await screen.findByRole("button", { name: "ER diagram Sales" }));
  expect(await within(s.strip()).findByText(ER_MESSAGES.tableTaken("customers"))).toBeTruthy();
  await new Promise((r) => setTimeout(r, 50));
  expect(s.card("customers")).not.toBeNull();
  expect(s.card("orders")).toBeNull();
  expect(s.newTable()!.contains(box)).toBe(true);
  expect(box.value).toBe("customers");
  expect(s.doc()).toBe(before);
  // A free name then lets the switch through: the table lands in its own frame, the other frame's text unchanged.
  await userEvent.clear(box);
  await userEvent.type(box, "orders_archive");
  await pickFrame(s, "Sales", "orders");
  await waitFor(() => expect(s.frame(0)).toContain("\norders_archive\n"));
  expect(s.frame(1)).toBe(SALES);
});

test("a_lost_row_field_survives_a_scrolled_card", async () => {
  // Minor 4: the open field's row is drawn whatever the scroll, within the 22-row cap, so an undo that takes the row
  // away from under a card scrolled to its top still keeps what was typed.
  const many = lines('diagram er "Shop"', "customers {", ...Array.from({ length: 30 }, (_, i) => `  c${i} int`), "}");
  const s = setup(many, null, "shop");
  await drawn(s);
  const body = () => s.card("customers")!.querySelector(".fkind-er-body") as HTMLElement;
  const scrollTo = (y: number) => {
    body().scrollTop = y;
    fireEvent.scroll(body());
  };
  scrollTo(30 * 22);
  await waitFor(() => expect(within(s.card("customers")!).getByRole("button", { name: "Add column" })).toBeTruthy());
  await userEvent.click(within(s.card("customers")!).getByRole("button", { name: "Add column" }));
  await userEvent.type(await s.field("Column name"), "extra{Enter}");
  await waitFor(() => expect(s.doc()).toContain("  c29 int\n  extra\n}"));
  await userEvent.type(await s.field("Column name"), "{Escape}");
  scrollTo(31 * 22);
  await waitFor(() => expect(s.row("customers", "extra")).toBeTruthy());
  fireEvent.doubleClick(s.row("customers", "extra").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  await userEvent.clear(name);
  await userEvent.type(name, "kept");
  // Scrolled back to the top: the field's row is still drawn, and the card draws no more than 22 rows.
  scrollTo(0);
  await waitFor(() => expect(s.row("customers", "c0")).toBeTruthy());
  expect(screen.getByLabelText("Column name")).toBe(name);
  expect(s.rows("customers").length).toBeLessThanOrEqual(22);
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(many));
  expect(screen.getByLabelText("Column name")).toBe(name);
  expect(s.rows("customers").length).toBeLessThanOrEqual(22);
  fireEvent.keyDown(name, { key: "Enter" });
  expect((await screen.findByRole("alert")).textContent).toBe(ER_MESSAGES.columnGone("customers"));
  expect((await s.field("Column name")).value).toBe("kept");
  expect(s.doc()).toBe(many);
});

// ---- B3 Task 4: the column keys (decision 10, R21) and the column clipboard (decision 11, R20, R30), restored from
// 5478210^ in block form

/** Clicks a column's row and waits for it to be the selected column. */
async function pickColumn(s: Setup, table: string, column: string) {
  fireEvent.click(s.row(table, column));
  await waitFor(() => expect(s.row(table, column).classList.contains("is-selected")).toBe(true));
}

const armed = () =>
  within(screen.getByRole("toolbar", { name: "Board tools" }))
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.getAttribute("aria-label"));

test("with a column selected, K toggles the key, N not null, Ctrl+Enter duplicates below, Delete removes it", async () => {
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  s.press("n");
  const noNull = replaced("  email text not null\n", "  email text\n");
  await waitFor(() => expect(s.doc()).toBe(noNull));
  s.press("K");
  const keyed = replaced("  email text not null\n", "  email text pk\n");
  await waitFor(() => expect(s.doc()).toBe(keyed));
  await oneUndo(s, noNull);
  s.press("Enter", { ctrlKey: true });
  const dup = noNull.replace("  email text\n", "  email text\n  email_copy text\n");
  await waitFor(() => expect(s.doc()).toBe(dup));
  // The copy is selected: Delete takes it, not the table.
  await waitFor(() => expect(s.row("customers", "email_copy").classList.contains("is-selected")).toBe(true));
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(noNull));
  expect(s.card("customers")).not.toBeNull();
});

test("a click on the header after a column picks the table: the column lets go (M2)", async () => {
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  const head = s.card("customers")!.querySelector(".fkind-head")!;
  fireEvent.pointerDown(head);
  fireEvent.click(head);
  await waitFor(() => expect(s.row("customers", "email").classList.contains("is-selected")).toBe(false));
  s.press("k");
  await new Promise((r) => setTimeout(r, 50));
  expect(s.doc()).toBe(ER);
});

/** A mouse event as a browser sends it, with its window: React Flow's drag (d3-drag) reads `event.view`. */
function withView(e: Event): Event {
  Object.defineProperty(e, "view", { value: window });
  return e;
}

test("a press on a header keeps a multi-selection; Ctrl+click toggles one table; a plain click picks only it (N1)", async () => {
  const s = setup();
  await drawn(s);
  const wrap = (t: string) => s.nodeEl(t)!;
  const picked = () => ["customers", "invoices"].map((t) => wrap(t).classList.contains("selected"));
  s.press("a", { ctrlKey: true });
  await waitFor(() => expect(picked()).toEqual([true, true]));
  // Pressing a selected table's header (the start of a group drag) keeps every table selected.
  const head = s.card("customers")!.querySelector(".fkind-head")!;
  fireEvent.pointerDown(head);
  fireEvent(head, withView(createEvent.mouseDown(head)));
  await new Promise((r) => setTimeout(r, 50));
  expect(picked()).toEqual([true, true]);
  fireEvent(head, withView(createEvent.mouseUp(head)));
  // A Ctrl or Shift press leaves the pick to the canvas, which toggles that one table: the press itself never
  // narrows the selection (jsdom cannot run React Flow's pointer pick, so the toggle is React Flow's own).
  s.press("Escape");
  await waitFor(() => expect(picked()).toEqual([false, false]));
  fireEvent.pointerDown(head);
  await waitFor(() => expect(picked()).toEqual([true, false]));
  const inv = s.card("invoices")!.querySelector(".fkind-head")!;
  for (const mod of [{ ctrlKey: true }, { shiftKey: true }, { metaKey: true }]) {
    fireEvent.pointerDown(inv, mod);
    await new Promise((r) => setTimeout(r, 20));
    expect(picked()).toEqual([true, false]);
  }
  // A plain click on a table that is not selected picks only it.
  s.press("Escape");
  await waitFor(() => expect(picked()).toEqual([false, false]));
  fireEvent.pointerDown(inv);
  await waitFor(() => expect(picked()).toEqual([false, true]));
});

test("K and N held down flip the flag once, not on every repeat (M7)", async () => {
  const s = setup();
  await drawn(s);
  await pickColumn(s, "invoices", "customer_id");
  const once = replaced("  customer_id int\n", "  customer_id int not null\n");
  s.press("n");
  // A second press while the first is still being written is not a second flip either (Task 1 review).
  s.press("n");
  await waitFor(() => expect(s.doc()).toBe(once));
  s.press("n", { repeat: true });
  await new Promise((r) => setTimeout(r, 50));
  expect(s.doc()).toBe(once);
});

test("duplicate and delete of a column are one undo step each (M8)", async () => {
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "id");
  s.press("Enter", { ctrlKey: true });
  await waitFor(() => expect(s.doc()).toContain("  id_copy int"));
  await oneUndo(s, ER);
  await waitFor(() => expect(s.rows("customers")).toHaveLength(2));
  await pickColumn(s, "customers", "email");
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(replaced("  email text not null\n", "")));
  await oneUndo(s, ER);
});

test("F25 Backspace deletes the selected column as Delete does, and leaves the table", async () => {
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  s.press("Backspace");
  await waitFor(() => expect(s.doc()).toBe(replaced("  email text not null\n", "")));
  expect(s.card("customers")).not.toBeNull();
  await oneUndo(s, ER);
});

const clipboardText = { text: "" };
function stubClipboard() {
  clipboardText.text = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (t: string) => {
        clipboardText.text = t;
      },
      readText: async () => clipboardText.text,
    },
  });
}

test("I4 Ctrl+C copies the selected column's line, Ctrl+D duplicates it below, Ctrl+X cuts only it", async () => {
  stubClipboard();
  // No line on customer_id, so the cut takes only the column (a cut column takes its lines along, ER build C).
  const text = replaced("  customer_id int\n", "  customer_id int not null\n").replace("invoices.customer_id > customers.id\n", "");
  const s = setup(text);
  await drawn(s);
  await pickColumn(s, "invoices", "customer_id");
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).toBe("customer_id int not null\n"));
  expect(s.doc()).toBe(text);
  // Ctrl+D as Ctrl+Enter: a copy below, not a copy of the table.
  s.press("d", { ctrlKey: true });
  const dup = text.replace("  customer_id int not null\n", "  customer_id int not null\n  customer_id_copy int not null\n");
  await waitFor(() => expect(s.doc()).toBe(dup));
  await oneUndo(s, text);
  await pickColumn(s, "invoices", "customer_id");
  s.press("x", { ctrlKey: true });
  await waitFor(() => expect(s.doc()).toBe(text.replace("  customer_id int not null\n", "")));
  expect(s.card("invoices")).not.toBeNull();
  expect(clipboardText.text).toBe("customer_id int not null\n");
  await oneUndo(s, text);
});

test("I4 a copied column pasted on a selected table becomes that table's column", async () => {
  stubClipboard();
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).toBe("email text not null\n"));
  await selectTable(s, "invoices");
  s.press("v", { ctrlKey: true });
  const after = replaced("  customer_id int\n", "  customer_id int\n  email text not null\n");
  await waitFor(() => expect(s.doc()).toBe(after));
  await oneUndo(s, ER);
});

test("text_with_a_dot_pastes_as_a_dotted_table_name", async () => {
  stubClipboard();
  const s = setup();
  await drawn(s);
  await selectTable(s, "invoices");
  clipboardText.text = "example.com";
  s.press("v", { ctrlKey: true });
  // Not a column of invoices (N1). A table name may hold dots, so the text pastes as today: as a table
  // named example.com, not as a refusal (5478210^'s plain note was for text that read as no ER line at all).
  await waitFor(() => expect(s.doc()).toBe(replaced("}\ninvoices.customer_id", "}\nexample.com\ninvoices.customer_id")));
  expect(s.frame(0)).toContain("invoices {\n  id int pk\n  customer_id int\n}\n");
  expect(screen.queryByText("Select a table to paste the column into.")).toBeNull();
});

test("N1 a column line of another table in the diagram pasted on a selected table becomes its column", async () => {
  stubClipboard();
  const text = lines(
    'diagram er "Billing"',
    "customers {",
    "  id int pk",
    "}",
    "orders {",
    "  id int pk",
    "  total decimal",
    "}",
  );
  const s = setup(text, JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, orders: { x: 400, y: 0 } }, style: "modern", direction: "TB" }));
  await drawn(s);
  await selectTable(s, "customers");
  clipboardText.text = "orders.total decimal";
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.doc()).toBe(text.replace("customers {\n  id int pk\n", "customers {\n  id int pk\n  total decimal\n")));
});

test("N3 a copied column pasted with no table selected says to select a table", async () => {
  stubClipboard();
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).toBe("email text not null\n"));
  s.press("Escape");
  s.press("Escape");
  await waitFor(() => expect(s.container.querySelectorAll(".react-flow__node.selected")).toHaveLength(0));
  s.press("v", { ctrlKey: true });
  expect(await within(s.strip()).findByText("Select a table to paste the column into.")).toBeTruthy();
  expect(s.doc()).toBe(ER);
});

const SPACED = lines('diagram er "Shop"', "customers {", "  id int pk", "}", "orders {", '  placed_at "timestamp with time zone" not null // when', "}");
const SPACED_AT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, orders: { x: 400, y: 0 } }, style: "modern", direction: "TB" });

test("ctrl_c_quotes_a_spaced_type", async () => {
  stubClipboard();
  const s = setup(SPACED, SPACED_AT, "shop");
  await drawn(s);
  await pickColumn(s, "orders", "placed_at");
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).toBe('placed_at "timestamp with time zone" not null\n'));
  // Pasted into the pane inside `orders {`, the line parses clean.
  const inPane = SPACED.replace("orders {\n", `orders {\n  ${clipboardText.text}`);
  const parsed = parseFlow(inPane);
  expect(parsed.problems.filter((p) => p.severity === "error")).toEqual([]);
  expect(parsed.doc!.nodes.find((n) => n.name === "orders")!.rows).toHaveLength(2);
  // Pasted on customers, it adds the same column.
  await selectTable(s, "customers");
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.doc()).toBe(SPACED.replace("  id int pk\n", '  id int pk\n  placed_at "timestamp with time zone" not null\n')));
});

test("a_copied_spaced_type_pastes_as_one_column", async () => {
  stubClipboard();
  const s = setup(SPACED, SPACED_AT, "shop");
  await drawn(s);
  await pickColumn(s, "orders", "placed_at");
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).not.toBe(""));
  // Back on its own table, after itself: one column, its name freed, its spaced type kept whole.
  await pickColumn(s, "orders", "placed_at");
  s.press("v", { ctrlKey: true });
  const after = SPACED.replace('  placed_at "timestamp with time zone" not null // when\n', '  placed_at "timestamp with time zone" not null // when\n  placed_at_copy "timestamp with time zone" not null\n');
  await waitFor(() => expect(s.doc()).toBe(after));
  await waitFor(() => expect(s.rows("orders")).toHaveLength(2));
  await waitFor(() => expect(s.row("orders", "placed_at_copy").classList.contains("is-selected")).toBe(true));
  await oneUndo(s, SPACED);
});

test("esc_goes_tool_column_table_frame_nothing", async () => {
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  s.press("a");
  await waitFor(() => expect(armed()).toEqual(["Relationship"]));
  const frameSelected = () => screen.getAllByRole("button", { name: / Billing$/ }).some((b) => b.getAttribute("aria-current") === "true");
  expect(frameSelected()).toBe(true);
  // Esc disarms the tool first, and keeps the column.
  s.press("Escape");
  await waitFor(() => expect(armed()).toEqual(["Select"]));
  expect(s.row("customers", "email").classList.contains("is-selected")).toBe(true);
  // Then the column lets go, and the table stays.
  s.press("Escape");
  await waitFor(() => expect(s.row("customers", "email").classList.contains("is-selected")).toBe(false));
  expect(s.nodeEl("customers")!.classList.contains("selected")).toBe(true);
  // Then the table, then the frame.
  s.press("Escape");
  await waitFor(() => expect(s.nodeEl("customers")!.classList.contains("selected")).toBe(false));
  expect(frameSelected()).toBe(true);
  s.press("Escape");
  await waitFor(() => expect(frameSelected()).toBe(false));
  expect(s.doc()).toBe(ER);
});

test("enter_with_a_tool_armed_places_the_tool_not_the_column", async () => {
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  s.press("r");
  s.press("Enter");
  const box = await s.field("Table name");
  expect(s.newTable()!.contains(box)).toBe(true);
  expect(screen.queryByLabelText("Column name")).toBeNull();
  expect(s.doc()).toBe(ER);
});

test("tab_steps_columns_then_leaves_the_card", async () => {
  const s = setup();
  await drawn(s);
  await selectTable(s, "customers");
  const sel = () => s.rows("customers").map((r) => r.classList.contains("is-selected"));
  expect(fireEvent.keyDown(s.canvasEl(), { key: "Tab" })).toBe(false);
  await waitFor(() => expect(sel()).toEqual([true, false]));
  expect(fireEvent.keyDown(s.canvasEl(), { key: "Tab" })).toBe(false);
  await waitFor(() => expect(sel()).toEqual([false, true]));
  expect(fireEvent.keyDown(s.canvasEl(), { key: "Tab", shiftKey: true })).toBe(false);
  await waitFor(() => expect(sel()).toEqual([true, false]));
  fireEvent.keyDown(s.canvasEl(), { key: "Tab" });
  await waitFor(() => expect(sel()).toEqual([false, true]));
  // Past the last column the key is the browser's again: focus moves on, and no column stays selected.
  expect(fireEvent.keyDown(s.canvasEl(), { key: "Tab" })).toBe(true);
  await waitFor(() => expect(sel()).toEqual([false, false]));
  expect(s.doc()).toBe(ER);
});

test("c_with_a_column_selected_is_still_the_column_tool", async () => {
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  s.press("c");
  const name = await s.field("Column name");
  expect(s.card("customers")!.contains(name)).toBe(true);
  expect(s.rows("customers").map((r) => r.classList.contains("is-new"))).toEqual([false, false, true]);
  expect(s.doc()).toBe(ER);
});

test("n_with_a_column_selected_sets_not_null", async () => {
  const s = setup();
  await drawn(s);
  await pickColumn(s, "invoices", "customer_id");
  const sketches = () => s.container.querySelectorAll(".flow-sketch").length;
  const before = sketches();
  s.press("n");
  await waitFor(() => expect(s.doc()).toBe(replaced("  customer_id int\n", "  customer_id int not null\n")));
  // Not the note sketch: no tool is armed and no note is added.
  expect(armed()).toEqual(["Select"]);
  expect(sketches()).toBe(before);
});

test("space_with_a_column_selected_still_opens_the_space_box", async () => {
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  fireEvent.pointerMove(s.canvasEl(), { clientX: 300, clientY: 200 });
  s.press(" ");
  fireEvent.keyUp(s.canvasEl(), { key: " " });
  expect(await screen.findByRole("dialog", { name: "Add here" })).toBeTruthy();
  expect(s.doc()).toBe(ER);
});

test("a_word_pasted_on_a_selected_table_pastes_as_a_table", async () => {
  stubClipboard();
  const s = setup();
  await drawn(s);
  await selectTable(s, "customers");
  clipboardText.text = "invoices";
  s.press("v", { ctrlKey: true });
  // A shape paste: a table with a free name, never a column of customers.
  await waitFor(() => expect(s.doc()).not.toBe(ER));
  expect(s.frame(0)).toContain("customers {\n  id int pk\n  email text not null\n}\n");
  expect(parseFlow(s.doc()).doc!.nodes.filter((n) => n.kind === "entity").map((n) => n.name)).toEqual(["customers", "invoices", "invoices_2"]);
});

test("a_pasted_column_is_selected", async () => {
  stubClipboard();
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).toBe("email text not null\n"));
  await selectTable(s, "invoices");
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.doc()).toBe(replaced("  customer_id int\n", "  customer_id int\n  email text not null\n")));
  // The new row is the selected column (draw.io, Figma), so its keys act on it at once.
  await waitFor(() => expect(s.row("invoices", "email").classList.contains("is-selected")).toBe(true));
  expect(s.row("customers", "email").classList.contains("is-selected")).toBe(false);
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(ER));
});

test("menu_paste_of_a_column_matches_ctrl_v", async () => {
  stubClipboard();
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).toBe("email text not null\n"));
  await selectTable(s, "invoices");
  const after = replaced("  customer_id int\n", "  customer_id int\n  email text not null\n");
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.doc()).toBe(after));
  const keysDepth = undoDepth(s.view().state);
  await oneUndo(s, ER);
  // The undo took the pasted row; invoices stays selected, and the menu's Paste writes the same text as one undo step.
  await waitFor(() => expect(s.nodeEl("invoices")!.classList.contains("selected")).toBe(true));
  const at = s.screenAt(freePoint([s.boxOf("Billing")], s.shapesIn("Billing")));
  fireEvent.contextMenu(s.pane(), { clientX: at.x, clientY: at.y });
  const menu = await screen.findByRole("menu", { name: "Canvas actions" });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Paste" }));
  await waitFor(() => expect(s.doc()).toBe(after));
  expect(undoDepth(s.view().state)).toBe(keysDepth);
  await waitFor(() => expect(s.row("invoices", "email").classList.contains("is-selected")).toBe(true));
  await oneUndo(s, ER);
});

test("a_column_paste_in_an_old_frame_says_the_old_form_note", async () => {
  // Review Focus 4: an old-form frame (README_BILLING's rewrite undone under its drawn cards) takes no column paste,
  // whether or not a table is selected, and says why.
  stubClipboard();
  const s = setup(README_BILLING, null);
  await waitFor(() => expect(s.container.querySelector(".flow-problems")).not.toBeNull(), { timeout: 4000 });
  await userEvent.click(within(s.container.querySelector(".flow-problems") as HTMLElement).getAllByRole("button", { name: "Rewrite as table blocks" })[0]);
  await waitFor(() => expect(s.doc()).toContain("orders {\n"));
  await drawn(s, "orders");
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(README_BILLING));
  await waitFor(() => expect(s.container.querySelector(".flow-problems")).not.toBeNull());
  clipboardText.text = "orders.note text";
  expect(within(s.strip()).queryByText(ER_NOTES.oldForm)).toBeNull();
  s.press("v", { ctrlKey: true });
  expect(await within(s.strip()).findByText(ER_NOTES.oldForm)).toBeTruthy();
  expect(within(s.strip()).queryByText("Select a table to paste the column into.")).toBeNull();
  act(() => s.props().onSelect!(["orders"]));
  await waitFor(() => expect(s.nodeEl("orders")!.classList.contains("selected")).toBe(true));
  s.press("v", { ctrlKey: true });
  await new Promise((r) => setTimeout(r, 80));
  expect(within(s.strip()).getByText(ER_NOTES.oldForm)).toBeTruthy();
  expect(s.doc()).toBe(README_BILLING);
});

test("a_column_paste_under_the_lock_says_why", async () => {
  stubClipboard();
  // The lock is on from the first render, so every render of the tab reads it (no later re-render is relied on), and
  // the canvas shows it before the paste: its cards take no edits.
  lock.on = true;
  const s = setup();
  await drawn(s);
  await waitFor(() => expect(s.props().readOnly).toBe(true));
  act(() => s.props().onSelect!(["invoices"]));
  await waitFor(() => expect(s.nodeEl("invoices")!.classList.contains("selected")).toBe(true));
  // Ctrl+V itself is held under the lock; the paste event the WebView sends still comes, and says why.
  const data = { getData: () => "customers.phone text" };
  fireEvent.paste(s.canvasEl(), { clipboardData: data });
  expect(await within(s.strip()).findByText(EDIT_MESSAGES.locked)).toBeTruthy();
  expect(s.doc()).toBe(ER);
});

test("a_column_paste_under_a_text_error_says_why_and_writes_nothing", async () => {
  // Final review I2: the drawing is the last good one, so the copied column line is no shape paste either.
  stubClipboard();
  const s = setup();
  await drawn(s);
  await pickColumn(s, "customers", "email");
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).toBe("email text not null\n"));
  await selectTable(s, "invoices");
  const broken = ER.replace("  id int pk\n  email", "  id int pk\n  code text [\n  email");
  act(() => {
    s.view().dispatch({ changes: { from: 0, to: s.doc().length, insert: broken } });
  });
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  s.press("v", { ctrlKey: true });
  expect(await within(s.strip()).findByText(EDIT_MESSAGES.stale)).toBeTruthy();
  await new Promise((r) => setTimeout(r, 80));
  expect(s.doc()).toBe(broken);
});

test("the_new_tables_placeholder_row_is_hidden_from_a_screen_reader", async () => {
  // Final review Minor 5: "column_name" and "type" are a picture of the row to come, as the card's spacers are.
  const s = setup();
  await drawn(s);
  const inside = freePoint([s.boxOf("Billing")], s.shapesIn("Billing"));
  act(() => s.props().onPaneDoubleClick!({ screen: s.screenAt(inside), flow: inside }));
  await s.field("Table name");
  const row = s.newTable()!.querySelector(".fkind-er-row.is-new")!;
  expect(row.getAttribute("aria-hidden")).toBe("true");
});

test("two_er_tabs_each_offer_their_own_types", async () => {
  // Final review Minor 2: every tab stays mounted, so each one's type field names its own tab's list.
  routeInvoke({ read_diagram: () => ({ text: ER, layout: ER_AT }), write_diagram: () => null, write_diagram_layout: () => null });
  const u = render(
    <div>
      <div className="tab-one" style={{ width: 1280, height: 800 }}>
        <FlowTab name="one" client={new LangClient(() => fakeWorker())} />
      </div>
      <div className="tab-two" style={{ width: 1280, height: 800 }}>
        <FlowTab name="two" client={new LangClient(() => fakeWorker())} />
      </div>
    </div>,
  );
  const ids: string[] = [];
  for (const cls of ["tab-one", "tab-two"]) {
    const tab = u.container.querySelector<HTMLElement>(`.${cls}`)!;
    const card = await waitFor(
      () => {
        const c = tab.querySelector<HTMLElement>('[aria-label="Table customers"]');
        expect(c).not.toBeNull();
        return c!;
      },
      { timeout: 4000 },
    );
    const lists = tab.querySelectorAll("datalist");
    expect(lists).toHaveLength(1);
    const row = [...card.querySelectorAll<HTMLElement>(".fkind-er-row")].find((r) => r.querySelector(".fkind-col")?.textContent === "email")!;
    fireEvent.doubleClick(row.querySelector(".fkind-type")!);
    const type = (await within(tab).findByLabelText("Column type", { selector: "input" })) as HTMLInputElement;
    expect(type.getAttribute("list")).toBe(lists[0].id);
    ids.push(lists[0].id);
  }
  expect(new Set(ids).size).toBe(2);
});

// B3 Task 8: the table's and the column's menus open the same new column row as the card's own + column.
test("the_table_menu_and_a_columns_menu_add_a_column_at_the_end_or_below_the_column", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.card("customers")!.querySelector(".fkind-head")!, { clientX: 300, clientY: 200 });
  let menu = await screen.findByRole("menu", { name: "customers actions" });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Add column" }));
  await s.field("Column name");
  expect(s.rows("customers").map((r) => r.classList.contains("is-new"))).toEqual([false, false, true]);
  await userEvent.type(await s.field("Column name"), "{Escape}");
  await waitFor(() => expect(s.rows("customers").some((r) => r.classList.contains("is-new"))).toBe(false));
  fireEvent.contextMenu(s.row("customers", "id"), { clientX: 300, clientY: 220 });
  menu = await screen.findByRole("menu", { name: "customers.id actions" });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Insert column below" }));
  await userEvent.type(await s.field("Column name"), "code{Enter}");
  await waitFor(() => expect(s.doc()).toBe(ER.replace("  id int pk\n  email", "  id int pk\n  code\n  email")));
});
