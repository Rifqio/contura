// ER build A, in the diagram tab: the in-place editor on the table card, adding columns, rename and keys in
// place. Every gesture writes exactly its line in the text, as one undo step (board ER interactions).
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { LangClient } from "../lang/client";
import { routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(cleanup);

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const ER = lines(
  'diagram er "Billing"',
  "customers",
  "customers.id int [pk]",
  "customers.email text [not null]",
  "invoices",
  "invoices.id int [pk]",
  "invoices.customer_id int",
  "",
  "customers 1--* invoices : bills",
);

function setup(text = ER, name = "billing") {
  routeInvoke({ read_diagram: () => ({ text, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name={name} client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const card = (table: string) => utils.container.querySelector(`.react-flow__node [aria-label="Entity ${table}"]`) as HTMLElement | null;
  const rows = (table: string) => [...card(table)!.querySelectorAll<HTMLElement>(".fkind-er-row")];
  const row = (table: string, column: string) => rows(table).find((r) => r.querySelector(".fkind-col")?.textContent === column)!;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const field = (label: string) => screen.findByLabelText(label, { selector: "input" }) as Promise<HTMLInputElement>;
  const clickAway = () => userEvent.click(utils.container.querySelector(".react-flow__pane") as HTMLElement);
  return { ...utils, view, doc, card, rows, row, press, field, clickAway };
}

async function drawn(s: ReturnType<typeof setup>, table = "customers") {
  await waitFor(() => expect(s.card(table)).not.toBeNull(), { timeout: 4000 });
}

/** One undo puts the text back exactly as it was before the gesture. */
async function oneUndo(s: ReturnType<typeof setup>, before: string) {
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(before));
}

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

test("F2 renames the selected table; Esc puts it back and a click away keeps it", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.keyDown(s.card("invoices")!.closest(".react-flow__node")!, { key: "Enter" });
  await waitFor(() => expect(s.card("invoices")!.closest(".react-flow__node")!.classList.contains("selected")).toBe(true));
  s.press("F2");
  let box = await s.field("Table name");
  await userEvent.type(box, "bills{Escape}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Table name" })).toBeNull());
  expect(s.doc()).toBe(ER);
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
  await userEvent.type(box, "Invoices{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("Invoices is already a table in this diagram.");
  expect(screen.getByRole("textbox", { name: "Table name" })).toBe(box);
  expect(s.doc()).toBe(ER);
});

test("double-click empty card space adds a column there: name, Tab, type, Enter keeps adding; Enter on an empty row closes", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-er-body")!);
  const name = await s.field("Column name");
  expect(name.value).toBe("");
  expect(name.placeholder).toBe("column_name");
  await userEvent.type(name, "phone{Tab}");
  // Tab moves to the type; nothing is written yet.
  const type = await s.field("Column type");
  expect(s.doc()).toBe(ER);
  await userEvent.type(type, "text{Enter}");
  const after = ER.replace("customers.email text [not null]\n", "customers.email text [not null]\ncustomers.phone text\n");
  await waitFor(() => expect(s.doc()).toBe(after));
  // The next new row is open, empty.
  const next = await s.field("Column name");
  expect(next.value).toBe("");
  await userEvent.type(next, "{Enter}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Column name" })).toBeNull());
  expect(s.doc()).toBe(after);
  await oneUndo(s, ER);
});

test("the + column row adds at the end; Esc removes the unsaved row", async () => {
  const s = setup();
  await drawn(s);
  await userEvent.click(within(s.card("invoices")!).getByRole("button", { name: "Add column" }));
  const name = await s.field("Column name");
  expect(s.rows("invoices").map((r) => r.classList.contains("is-new"))).toEqual([false, false, true]);
  // The click both selects the card and grows it in one event: the selection settles (I2, no update loop).
  await waitFor(() => expect(s.card("invoices")!.closest(".react-flow__node")!.classList.contains("selected")).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
  expect(s.card("invoices")!.closest(".react-flow__node")!.classList.contains("selected")).toBe(true);
  await userEvent.type(name, "total{Escape}");
  await waitFor(() => expect(s.rows("invoices")).toHaveLength(2));
  expect(s.doc()).toBe(ER);
});

test("a taken column name is refused in place, the field stays open", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-er-body")!);
  const name = await s.field("Column name");
  await userEvent.type(name, "EMAIL{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("EMAIL is already a column of customers.");
  expect(screen.getByRole("textbox", { name: "Column name" })).toBe(name);
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
  await waitFor(() => expect(s.doc()).toBe(ER.replace("customers.email text", "customers.mail text")));
  await oneUndo(s, ER);
  await waitFor(() => expect(s.row("customers", "id")).toBeTruthy());
  fireEvent.doubleClick(s.row("customers", "id").querySelector(".fkind-type")!);
  const type = await s.field("Column type");
  expect(type.value).toBe("int");
  await userEvent.clear(type);
  await userEvent.type(type, "bigint{Tab}");
  await waitFor(() => expect(s.doc()).toBe(ER.replace("customers.id int [pk]", "customers.id bigint [pk]")));
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
  await waitFor(() => expect(s.doc()).toBe(ER.replace("customers.email text", "customers.email varchar(255)")));
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
  await waitFor(() => expect(s.doc()).toBe(ER.replace("invoices.customer_id", "invoices.client_id")));
  // A new row with a name typed is kept on a click away too.
  await userEvent.click(within(s.card("invoices")!).getByRole("button", { name: "Add column" }));
  await userEvent.type(await s.field("Column name"), "due");
  await s.clickAway();
  await waitFor(() => expect(s.doc()).toContain("invoices.client_id int\ninvoices.due\n"));
});

test("with a column selected, K toggles the key, N not null, Ctrl+Enter duplicates below, Delete removes it", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(s.row("customers", "email"));
  await waitFor(() => expect(s.row("customers", "email").classList.contains("is-selected")).toBe(true));
  s.press("n");
  const noNull = ER.replace("customers.email text [not null]", "customers.email text");
  await waitFor(() => expect(s.doc()).toBe(noNull));
  s.press("K");
  const keyed = ER.replace("customers.email text [not null]", "customers.email text [pk]");
  await waitFor(() => expect(s.doc()).toBe(keyed));
  await oneUndo(s, noNull);
  s.press("Enter", { ctrlKey: true });
  const dup = noNull.replace("customers.email text\n", "customers.email text\ncustomers.email_copy text\n");
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
  fireEvent.click(s.row("customers", "email"));
  await waitFor(() => expect(s.row("customers", "email").classList.contains("is-selected")).toBe(true));
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
  const wrap = (t: string) => s.card(t)!.closest(".react-flow__node") as HTMLElement;
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
  // Ctrl+click toggles one table without touching the other.
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
  fireEvent.click(s.row("invoices", "customer_id"));
  await waitFor(() => expect(s.row("invoices", "customer_id").classList.contains("is-selected")).toBe(true));
  s.press("n");
  await waitFor(() => expect(s.doc()).toBe(ER.replace("invoices.customer_id int", "invoices.customer_id int [not null]")));
  s.press("n", { repeat: true });
  await new Promise((r) => setTimeout(r, 50));
  expect(s.doc()).toBe(ER.replace("invoices.customer_id int", "invoices.customer_id int [not null]"));
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
  await waitFor(() => expect(s.doc()).toBe(ER.replace("customers.email text [not null]\n", "customers.email text [not null]\ncustomers.phone\n")));
  expect((await s.field("Column type")).value).toBe("text");
});

test("duplicate and delete of a column are one undo step each (M8)", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(s.row("customers", "id"));
  await waitFor(() => expect(s.row("customers", "id").classList.contains("is-selected")).toBe(true));
  s.press("Enter", { ctrlKey: true });
  await waitFor(() => expect(s.doc()).toContain("customers.id_copy int [not null]"));
  await oneUndo(s, ER);
  await waitFor(() => expect(s.rows("customers")).toHaveLength(2));
  fireEvent.click(s.row("customers", "email"));
  await waitFor(() => expect(s.row("customers", "email").classList.contains("is-selected")).toBe(true));
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(ER.replace("customers.email text [not null]\n", "")));
  await oneUndo(s, ER);
});

test("the key gutter toggles the primary key; its tip says what a click does", async () => {
  const s = setup();
  await drawn(s);
  const gut = within(s.row("invoices", "customer_id")).getByRole("button", { name: "Primary key" });
  expect(gut.getAttribute("aria-pressed")).toBe("false");
  expect(gut.title).toBe("Click to make it the primary key");
  await userEvent.click(gut);
  await waitFor(() => expect(s.doc()).toBe(ER.replace("invoices.customer_id int", "invoices.customer_id int [pk]")));
  await waitFor(() => expect(within(s.row("invoices", "customer_id")).getByRole("button", { name: "Primary key" }).title).toBe("Primary key. Click to remove"));
  // The key icon follows the text, not the row order.
  expect(s.row("invoices", "customer_id").querySelector(".fkind-key")).not.toBeNull();
});

test("the table menu and a column's menu add a column: at the end, or below the column", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.card("customers")!.querySelector(".fkind-head")!, { clientX: 300, clientY: 200 });
  let menu = await screen.findByRole("menu", { name: "customers actions" });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Add column" }));
  await s.field("Column name");
  expect(s.rows("customers").map((r) => r.classList.contains("is-new"))).toEqual([false, false, true]);
  await userEvent.type(await s.field("Column name"), "{Escape}");
  fireEvent.contextMenu(s.row("customers", "id"), { clientX: 300, clientY: 220 });
  menu = await screen.findByRole("menu", { name: "customers.id actions" });
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Insert column below" }));
  await userEvent.type(await s.field("Column name"), "code{Enter}");
  await waitFor(() => expect(s.doc()).toBe(ER.replace("customers.id int [pk]\n", "customers.id int [pk]\ncustomers.code\n")));
});

test("while the text has an error the faded drawing takes no column edits, and says why (I5)", async () => {
  const s = setup();
  await drawn(s);
  const broken = ER.replace("customers.id int [pk]\n", "customers.id int [pk]\ncustomers.code text [\n");
  act(() => {
    s.view().dispatch({ changes: { from: 0, to: s.doc().length, insert: broken } });
  });
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  // The faded card still shows id, email: a click on email's gutter must not key another line.
  await userEvent.click(within(s.row("customers", "email")).getByRole("button", { name: "Primary key" }));
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-head")!);
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-er-body")!);
  const strip = s.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  expect(await within(strip).findByText("Fix the text first: the drawing is from the last text that worked.")).toBeTruthy();
  expect(screen.queryByLabelText("Table name")).toBeNull();
  expect(screen.queryByLabelText("Column name")).toBeNull();
  expect(s.doc()).toBe(broken);
});

test("an invalid value on a click away keeps the field open with its reason; only Esc discards (I1)", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.doubleClick(s.card("customers")!.querySelector(".fkind-head")!);
  const table = await s.field("Table name");
  await userEvent.clear(table);
  await userEvent.type(table, "invoices");
  await s.clickAway();
  expect((await screen.findByRole("alert")).textContent).toBe("invoices is already a table in this diagram.");
  expect(screen.getByLabelText("Table name")).toBe(table);
  // Focus is back in the open field, so Esc works at once; a second click away tries again (fix round 2).
  await waitFor(() => expect(document.activeElement).toBe(table));
  await s.clickAway();
  await waitFor(() => expect(document.activeElement).toBe(table));
  expect(table.value).toBe("invoices");
  await userEvent.type(table, "{Escape}");
  await waitFor(() => expect(screen.queryByLabelText("Table name")).toBeNull());
  // A new row and an existing column too.
  await userEvent.click(within(s.card("invoices")!).getByRole("button", { name: "Add column" }));
  const draft = await s.field("Column name");
  await userEvent.type(draft, "two words");
  await s.clickAway();
  expect((await screen.findByRole("alert")).textContent).toBe("Use letters, digits and _ only.");
  expect(screen.getByLabelText("Column name")).toBe(draft);
  await userEvent.type(draft, "{Escape}");
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const col = await s.field("Column name");
  await userEvent.clear(col);
  await userEvent.type(col, "ID");
  await s.clickAway();
  expect((await screen.findByRole("alert")).textContent).toBe("ID is already a column of customers.");
  expect(col.value).toBe("ID");
  expect(s.doc()).toBe(ER);
});

test("a flowchart name taken on a click away keeps the F2 field open with its reason (I1)", async () => {
  const FLOW = lines('diagram flow "Refund"', "Request in [start]", "Done [end]", "Request in > Done");
  const s = setup(FLOW, "refund-taken");
  await waitFor(() => expect(s.container.querySelector('.react-flow__node [aria-label="Start Request in"]')).not.toBeNull(), { timeout: 4000 });
  const node = s.container.querySelector('.react-flow__node [aria-label="Start Request in"]')!.closest(".react-flow__node") as HTMLElement;
  fireEvent.keyDown(node, { key: "Enter" });
  await waitFor(() => expect(node.classList.contains("selected")).toBe(true));
  s.press("F2");
  const box = await s.field("Rename Request in");
  await userEvent.clear(box);
  await userEvent.type(box, "Done");
  await s.clickAway();
  expect((await screen.findByRole("alert")).textContent).toBe("Done is already used.");
  expect(screen.getByLabelText("Rename Request in")).toBe(box);
  expect(s.doc()).toBe(FLOW);
});

test("after Enter or Esc the keys work at once: focus is back on the canvas with the column or table selected (I4)", async () => {
  const s = setup();
  await drawn(s);
  const canvas = s.container.querySelector(".flow-canvas") as HTMLElement;
  fireEvent.doubleClick(s.row("customers", "email").querySelector(".fkind-col")!);
  const name = await s.field("Column name");
  await userEvent.clear(name);
  await userEvent.type(name, "mail{Enter}");
  await waitFor(() => expect(s.doc()).toContain("customers.mail text [not null]"));
  expect(canvas.contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.tagName).not.toBe("INPUT");
  // K on the canvas keys the column just edited.
  fireEvent.keyDown(document.activeElement!, { key: "k" });
  await waitFor(() => expect(s.doc()).toContain("customers.mail text [pk, not null]"));
  // Esc out of a field: focus back too.
  fireEvent.doubleClick(s.row("customers", "id").querySelector(".fkind-type")!);
  await userEvent.type(await s.field("Column type"), "x{Escape}");
  await waitFor(() => expect(screen.queryByLabelText("Column type")).toBeNull());
  expect(canvas.contains(document.activeElement)).toBe(true);
  // A table renamed with Enter: F2 at once edits it again.
  fireEvent.doubleClick(s.card("invoices")!.querySelector(".fkind-head")!);
  const table = await s.field("Table name");
  await userEvent.clear(table);
  await userEvent.type(table, "bills{Enter}");
  await waitFor(() => expect(s.card("bills")).not.toBeNull());
  expect(canvas.contains(document.activeElement)).toBe(true);
  await waitFor(() => expect(s.card("bills")!.closest(".react-flow__node")!.classList.contains("selected")).toBe(true));
  fireEvent.keyDown(document.activeElement!, { key: "F2" });
  expect((await s.field("Table name")).value).toBe("bills");
});

test("long names end in an ellipsis with the full name as a tip; past 20 columns the card scrolls", async () => {
  const long = "customer_invoice_line_adjustments_archive";
  const cols = Array.from({ length: 25 }, (_, i) => `${long}.c${i} int`);
  const s = setup(lines('diagram er "Wide"', long, `${long}.adjustment_reason_code_from_upstream_billing_system varchar(255)`, ...cols), "wide");
  await drawn(s, long);
  expect((s.card(long)!.querySelector(".fkind-head .fnode-name") as HTMLElement).getAttribute("aria-description")).toBe(long);
  expect(s.row(long, "adjustment_reason_code_from_upstream_billing_system").title).toBe(
    "adjustment_reason_code_from_upstream_billing_system varchar(255) (nullable)",
  );
  // 26 rows, drawn 20 high: 40 + 20 x 22.
  const wrap = s.card(long)!.closest(".react-flow__node") as HTMLElement;
  expect(parseFloat(wrap.style.height)).toBe(480);
  expect(s.rows(long)).toHaveLength(26);
  // The wheel over rows that scroll scrolls them, not the canvas (I3); a card that fits lets the canvas pan.
  expect(s.card(long)!.querySelector(".fkind-er-body")!.classList.contains("nowheel")).toBe(true);
  cleanup();
  const short = setup();
  await drawn(short);
  expect(short.card("customers")!.querySelector(".fkind-er-body")!.classList.contains("nowheel")).toBe(false);
});

test("F2 on a flowchart shape edits its label on the shape; a click away keeps it (F4), Esc puts it back", async () => {
  const FLOW = lines('diagram flow "Refund"', "Request in [start]", "Done [end]", "Request in > Done");
  const s = setup(FLOW, "refund");
  await waitFor(() => expect(s.container.querySelector('.react-flow__node [aria-label="Start Request in"]')).not.toBeNull(), { timeout: 4000 });
  const node = s.container.querySelector('.react-flow__node [aria-label="Start Request in"]')!.closest(".react-flow__node") as HTMLElement;
  fireEvent.keyDown(node, { key: "Enter" });
  await waitFor(() => expect(node.classList.contains("selected")).toBe(true));
  s.press("F2");
  let box = await s.field("Rename Request in");
  // On the canvas, over the shape: not in the strip above it.
  expect(box.closest(".flow-strip")).toBeNull();
  expect(box.closest(".react-flow")).not.toBeNull();
  await userEvent.type(box, "x{Escape}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Rename Request in" })).toBeNull());
  expect(s.doc()).toBe(FLOW);
  // Focus is back on the canvas: F2 works at once (I4).
  expect((s.container.querySelector(".flow-canvas") as HTMLElement).contains(document.activeElement)).toBe(true);
  s.press("F2");
  box = await s.field("Rename Request in");
  await userEvent.clear(box);
  await userEvent.type(box, "Claim");
  await s.clickAway();
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace(/Request in/g, "Claim")));
});

test("the details panel keeps a changed form on a press outside (F5) and closes an unchanged one", async () => {
  const DFD = lines('diagram dfd "x"', "Customer [entity]", "Orders [store, id: D1]", "Customer > Orders");
  const s = setup(DFD, "dfd");
  await waitFor(() => expect(s.container.querySelector('.react-flow__node [aria-label="Data store Orders"]')).not.toBeNull(), { timeout: 4000 });
  const node = () => s.container.querySelector('.react-flow__node [aria-label="Data store Orders"]')!.closest(".react-flow__node") as HTMLElement;
  fireEvent.doubleClick(node());
  let panel = await screen.findByRole("dialog", { name: "Edit Orders" });
  fireEvent.pointerDown(s.container.querySelector(".react-flow__pane")!);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Orders" })).toBeNull());
  expect(s.doc()).toBe(DFD);
  fireEvent.doubleClick(node());
  panel = await screen.findByRole("dialog", { name: "Edit Orders" });
  const id = within(panel).getByRole("textbox", { name: "Id" });
  await userEvent.clear(id);
  await userEvent.type(id, "D9");
  fireEvent.pointerDown(s.container.querySelector(".react-flow__pane")!);
  await waitFor(() => expect(s.doc()).toBe(DFD.replace("id: D1", "id: D9")));
});

test("F25 Backspace deletes the selected column as Delete does, and leaves the table", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.click(s.row("customers", "email"));
  await waitFor(() => expect(s.row("customers", "email").classList.contains("is-selected")).toBe(true));
  s.press("Backspace");
  await waitFor(() => expect(s.doc()).toBe(ER.replace("customers.email text [not null]\n", "")));
  expect(s.card("customers")).not.toBeNull();
  await oneUndo(s, ER);
});

// ---- Fix round 1, I4: with a column selected, the clipboard keys act on the column (draw.io's table rows).

const clipboardText = { text: "" };
function stubClipboard() {
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
  const s = setup();
  await drawn(s);
  fireEvent.click(s.row("customers", "email"));
  await waitFor(() => expect(s.row("customers", "email").classList.contains("is-selected")).toBe(true));
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).toBe("customers.email text [not null]\n"));
  expect(s.doc()).toBe(ER);
  // Ctrl+D as Ctrl+Enter: a copy below, not a copy of the table.
  s.press("d", { ctrlKey: true });
  const dup = ER.replace("customers.email text [not null]\n", "customers.email text [not null]\ncustomers.email_copy text [not null]\n");
  await waitFor(() => expect(s.doc()).toBe(dup));
  await oneUndo(s, ER);
  fireEvent.click(s.row("customers", "email"));
  await waitFor(() => expect(s.row("customers", "email").classList.contains("is-selected")).toBe(true));
  s.press("x", { ctrlKey: true });
  await waitFor(() => expect(s.doc()).toBe(ER.replace("customers.email text [not null]\n", "")));
  expect(s.card("customers")).not.toBeNull();
  expect(clipboardText.text).toBe("customers.email text [not null]\n");
  await oneUndo(s, ER);
});

test("I4 a copied column pasted on a selected table becomes that table's column", async () => {
  stubClipboard();
  const s = setup();
  await drawn(s);
  fireEvent.click(s.row("customers", "email"));
  await waitFor(() => expect(s.row("customers", "email").classList.contains("is-selected")).toBe(true));
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).toBe("customers.email text [not null]\n"));
  fireEvent.click(s.card("invoices")!.querySelector(".fkind-head")!);
  await waitFor(() => expect(s.card("invoices")!.closest(".react-flow__node")!.classList.contains("selected")).toBe(true));
  s.press("v", { ctrlKey: true });
  const after = ER.replace("invoices.customer_id int\n", "invoices.customer_id int\ninvoices.email text [not null]\n");
  await waitFor(() => expect(s.doc()).toBe(after));
  await oneUndo(s, ER);
});

// ---- Fix round 2

test("N1 text that only has a dot is not a column: example.com on a selected table is refused with the plain note", async () => {
  stubClipboard();
  const s = setup();
  await drawn(s);
  fireEvent.click(s.card("invoices")!.querySelector(".fkind-head")!);
  await waitFor(() => expect(s.card("invoices")!.closest(".react-flow__node")!.classList.contains("selected")).toBe(true));
  clipboardText.text = "example.com";
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.container.querySelector(".flow-notice")?.textContent).toMatch(/^The clipboard does not hold entity relationship lines \(line 1: .+\), so nothing was pasted\.$/));
  expect(s.doc()).toBe(ER);
});

test("N1 a column line of another table in the diagram pasted on a selected table becomes its column", async () => {
  stubClipboard();
  const s = setup();
  await drawn(s);
  fireEvent.click(s.card("invoices")!.querySelector(".fkind-head")!);
  await waitFor(() => expect(s.card("invoices")!.closest(".react-flow__node")!.classList.contains("selected")).toBe(true));
  clipboardText.text = "customers.phone text";
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.doc()).toBe(ER.replace("invoices.customer_id int\n", "invoices.customer_id int\ninvoices.phone text\n")));
});

test("N3 a copied column pasted with no table selected says to select a table", async () => {
  stubClipboard();
  const s = setup();
  await drawn(s);
  fireEvent.click(s.row("customers", "email"));
  await waitFor(() => expect(s.row("customers", "email").classList.contains("is-selected")).toBe(true));
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(clipboardText.text).toBe("customers.email text [not null]\n"));
  s.press("Escape");
  s.press("Escape");
  await waitFor(() => expect(s.container.querySelectorAll(".react-flow__node.selected")).toHaveLength(0));
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.container.querySelector(".flow-notice")?.textContent).toBe("Select a table to paste the column into."));
  expect(s.doc()).toBe(ER);
});
