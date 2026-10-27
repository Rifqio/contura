// ER step 2.4 and diagram step 4 (erd-ux-research 5.6; diagram-ux-research F31, F8, F11, F12, C2, CL2): a right-click
// offers what is under the pointer first, with each item's key on the right. A column, a table, a relationship or
// line, a shape of any kind, a multi-selection and the empty canvas each have their own menu; every edit they make
// is one exact text edit and one undo step.
//
// B3 Task 8: the ER cases come back in block form with the board's arrows, every card queried as `Table <t>` (R17),
// and the menus of decision 12 (R18). "Make a relationship from here" and "Add relationship to..." come back with
// Task 9, which owns the pick; the pure menu builders are checked here with them.
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { LangClient } from "../lang/client";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import { ARROWS } from "../lang/flow/model";
import { ARROW_NAMES, columnMenuItems, lineMenuItems, shapeMenuItems } from "./canvasMenus";
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
  "customers {",
  "  id int pk",
  "  email text not null",
  "}",
  "invoices {",
  "  id int pk",
  "  customer_id int",
  "}",
  "",
  "invoices.customer_id > customers.id",
);

const FLOW = lines('diagram flow "Refund"', "Request in [start]", "Check", "Done [end]", "Request in > Check", "Check > Done: yes");

function setup(text: string, layout: string | null = null) {
  routeInvoke({ read_diagram: () => ({ text, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="menus" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const edge = (i: number) => utils.container.querySelector(`.react-flow__edge[data-id="edge:${i}"]`) as HTMLElement;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const card = (table: string) => utils.container.querySelector(`.react-flow__node [aria-label="Table ${table}"]`) as HTMLElement | null;
  const row = (table: string, column: string) => [...card(table)!.querySelectorAll<HTMLElement>(".fkind-er-row")].find((r) => r.querySelector(".fkind-col")?.textContent === column)!;
  return { ...utils, view, doc, node, edge, press, card, row };
}
type Setup = ReturnType<typeof setup>;

/** A menu's rows as "label|shortcut" (checked ones end in " ✓"), in order, separators left out. */
function rowsOf(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>(":scope > div > [role^=menuitem]")].map((m) => {
    const key = m.querySelector(".menu-shortcut")?.textContent ?? m.querySelector(".menu-hint")?.textContent ?? "";
    return `${m.getAttribute("aria-label")}${key ? `|${key}` : ""}${m.getAttribute("aria-checked") === "true" ? " ✓" : ""}`;
  });
}

async function oneUndo(s: Setup, before: string) {
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(before));
}

async function erDrawn(s: Setup) {
  await waitFor(() => expect(s.card("customers")).not.toBeNull(), { timeout: 4000 });
}

test("a column's menu is about that column, with its keys, and each item writes one line", async () => {
  const s = setup(ER);
  await erDrawn(s);
  fireEvent.contextMenu(s.row("customers", "email"), { clientX: 300, clientY: 220 });
  const menu = await screen.findByRole("menu", { name: "customers.email actions" });
  // Decision 12's order, "Make a relationship from here" wired with Task 9's pick.
  expect(rowsOf(menu)).toEqual([
    "Rename|F2",
    "Edit type",
    "Primary key|K",
    "Unique",
    "Not null|N ✓",
    "Insert column above",
    "Insert column below",
    "Duplicate|Ctrl+Enter",
    "Make a relationship from here",
    "Show in the text",
    "Delete column|Delete",
  ]);
  await userEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Unique" }));
  await waitFor(() => expect(s.doc()).toBe(ER.replace("  email text not null\n", "  email text not null unique\n")));
  await oneUndo(s, ER);
  fireEvent.contextMenu(s.row("customers", "email"), { clientX: 300, clientY: 220 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "customers.email actions" })).getByRole("menuitem", { name: "Insert column above" }));
  const box = await screen.findByLabelText("Column name", { selector: "input" });
  expect([...s.card("customers")!.querySelectorAll(".fkind-er-row")].map((r) => r.classList.contains("is-new"))).toEqual([false, true, false]);
  await userEvent.type(box, "{Escape}");
  fireEvent.contextMenu(s.row("customers", "email"), { clientX: 300, clientY: 220 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "customers.email actions" })).getByRole("menuitem", { name: "Delete column" }));
  await waitFor(() => expect(s.doc()).toBe(ER.replace("  email text not null\n", "")));
  await oneUndo(s, ER);
});

test("a column's Show in the text puts the text on that column's line", async () => {
  const s = setup(ER);
  await erDrawn(s);
  fireEvent.contextMenu(s.row("invoices", "customer_id"), { clientX: 300, clientY: 220 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices.customer_id actions" })).getByRole("menuitem", { name: "Show in the text" }));
  await waitFor(() => expect(s.view().state.doc.lineAt(s.view().state.selection.main.head).text).toBe("  customer_id int"));
});

test("a table's menu: rename, add a column, a relationship to another table, duplicate, details, fit, delete", async () => {
  const s = setup(ER);
  await erDrawn(s);
  fireEvent.contextMenu(s.card("customers")!.querySelector(".fkind-head")!, { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "customers actions" });
  // Decision 12 with A's Colour after Details...; "Add relationship to..." wired with Task 9's pick.
  expect(rowsOf(menu)).toEqual([
    "Rename|F2",
    "Add column",
    "Add relationship to...",
    "Duplicate table|Ctrl+D",
    "Cut|Ctrl+X",
    "Copy|Ctrl+C",
    "Details...",
    "Colour|none",
    "Fit to content",
    "Show in the text",
    "Delete table|Delete",
  ]);
  // Not resized: nothing to fit.
  expect((within(menu).getByRole("menuitem", { name: "Fit to content" }) as HTMLButtonElement).disabled).toBe(true);
  // A column the menu opened on before is not this menu's.
  fireEvent.contextMenu(s.row("invoices", "id"), { clientX: 300, clientY: 220 });
  await screen.findByRole("menu", { name: "invoices.id actions" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.contextMenu(s.card("invoices")!.querySelector(".fkind-head")!, { clientX: 300, clientY: 200 });
  await screen.findByRole("menu", { name: "invoices actions" });
});

test("the table menu builder keeps decision 12's order with Add relationship to... and Colour after Details...", () => {
  const off = () => {};
  const rows = shapeMenuItems({
    table: true,
    sized: false,
    connect: [],
    service: false,
    rename: off,
    details: off,
    addColumn: off,
    addRelationship: off,
    cut: off,
    copy: off,
    duplicate: off,
    addConnected: off,
    chooseIcon: off,
    group: off,
    fit: off,
    showInText: off,
    remove: off,
    colour: { current: "", why: null, pick: off },
  }).map((m) => m.label);
  expect(rows).toEqual(["Rename", "Add column", "Add relationship to...", "Duplicate table", "Cut", "Copy", "Details...", "Colour", "Fit to content", "Show in the text", "Delete table"]);
});

test("a blocked column's menu is off but for Show in the text, each item saying why", () => {
  const off = () => {};
  const items = columnMenuItems({ flags: ["pk"], blocked: "Why not", rename: off, editType: off, toggle: off, insert: off, duplicate: off, showInText: off, remove: off });
  expect(items.filter((m) => !m.disabled).map((m) => m.label)).toEqual(["Show in the text"]);
  expect(items.filter((m) => m.disabled).every((m) => m.title === "Why not")).toBe(true);
  // With a pick to make, it sits after Duplicate (decision 12).
  const all = columnMenuItems({ flags: [], blocked: null, rename: off, editType: off, toggle: off, insert: off, duplicate: off, relate: off, showInText: off, remove: off });
  expect(all.map((m) => m.label).slice(7, 9)).toEqual(["Duplicate", "Make a relationship from here"]);
});

test("a resized table's Fit to content gives it its own size back", async () => {
  const layout = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 400, y: 0 } }, sizes: { customers: { w: 400, h: 300 } } });
  const s = setup(ER, layout);
  await erDrawn(s);
  const width = () => canvas.props!.nodes.find((n) => n.id === "customers")!.initialWidth;
  await waitFor(() => expect(width()).toBe(400));
  fireEvent.contextMenu(s.card("customers")!.querySelector(".fkind-head")!, { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "customers actions" })).getByRole("menuitem", { name: "Fit to content" }));
  await waitFor(() => expect(width()).toBeLessThan(400));
  await waitFor(() => {
    const writes = callsTo("write_diagram_layout");
    expect(writes.length).toBeGreaterThan(0);
    expect(String(writes[writes.length - 1].layout)).not.toContain('"w": 400');
  });
});

test("a relationship's menu: label, cardinality, swap, show, delete; each one undo step", async () => {
  const s = setup(ER);
  await erDrawn(s);
  await waitFor(() => expect(s.edge(0)).not.toBeNull());
  fireEvent.contextMenu(s.edge(0), { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Relationship actions" });
  // R18: A's Colour stays where A put it.
  expect(rowsOf(menu)).toEqual(["Edit label|F2", "Cardinality", "Colour|none", "Swap direction", "Show in the text", "Delete|Delete"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Cardinality" }));
  const sub = await screen.findByRole("menu", { name: "Cardinality" });
  // The board's arrows in ARROWS.er order, named as the line bar names them (R19).
  expect(rowsOf(sub)).toEqual(["Many to one|> ✓", "One to many|<", "One to one|-", "Many to many|<>"]);
  await userEvent.click(within(sub).getByRole("menuitemcheckbox", { name: "Many to many" }));
  await waitFor(() => expect(s.doc()).toBe(ER.replace("invoices.customer_id > customers.id", "invoices.customer_id <> customers.id")));
  await oneUndo(s, ER);
  fireEvent.contextMenu(s.edge(0), { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Relationship actions" })).getByRole("menuitem", { name: "Swap direction" }));
  await waitFor(() => expect(s.doc()).toBe(ER.replace("invoices.customer_id > customers.id", "customers.id < invoices.customer_id")));
  await oneUndo(s, ER);
});

test("the line menu's cardinalities are ARROW_NAMES.er in ARROWS.er order; elsewhere Reverse keeps its name", () => {
  const off = () => {};
  const er = lineMenuItems({ kind: "er", arrow: ">", branch: null, editLabel: off, setArrow: off, reverse: off, showInText: off, remove: off });
  const card = er.find((m) => m.key === "arrow")!;
  expect(card.label).toBe("Cardinality");
  expect(card.submenu!.map((m) => [m.label, m.hint])).toEqual(ARROWS.er.map((a) => [ARROW_NAMES.er[a], a]));
  expect(er.find((m) => m.key === "reverse")!.label).toBe("Swap direction");
  const flow = lineMenuItems({ kind: "flow", arrow: ">", branch: null, editLabel: off, setArrow: off, reverse: off, showInText: off, remove: off });
  expect(flow.find((m) => m.key === "reverse")!.label).toBe("Reverse");
});

test("F2 or Enter on a selected line edits its label; Edit label in its menu does too", async () => {
  const s = setup(FLOW);
  await waitFor(() => expect(s.node("Step Check")).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onLineSelect!(["edge:1"]));
  s.press("F2");
  const box = (await screen.findByRole("textbox", { name: "Flow label" })) as HTMLInputElement;
  expect(box.value).toBe("yes");
  await userEvent.clear(box);
  await userEvent.type(box, "approved{Enter}");
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace("Check > Done: yes", "Check > Done: approved")));
});

test("a flowchart line's menu: Arrow with the kind's arrows, Reverse, and Show in the text", async () => {
  const s = setup(FLOW);
  await waitFor(() => expect(s.node("Step Check")).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.edge(1), { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Line actions" });
  expect(rowsOf(menu)).toEqual(["Edit label|F2", "Arrow", "Colour|none", "Reverse", "Show in the text", "Delete|Delete"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Arrow" }));
  const sub = await screen.findByRole("menu", { name: "Arrow" });
  expect(rowsOf(sub)).toEqual(["One way|> ✓", "Both ways|<>", "Dashed|-->", "No arrow|-", "Dotted|--"]);
  await userEvent.click(within(sub).getByRole("menuitemcheckbox", { name: "Dashed" }));
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace("Check > Done: yes", "Check --> Done: yes")));
  fireEvent.contextMenu(s.edge(1), { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Line actions" })).getByRole("menuitem", { name: "Reverse" }));
  await waitFor(() => expect(s.doc()).toBe(FLOW.replace("Check > Done: yes", "Done --> Check: yes")));
  fireEvent.contextMenu(s.edge(1), { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Line actions" })).getByRole("menuitem", { name: "Show in the text" }));
  await waitFor(() => expect(s.view().state.doc.lineAt(s.view().state.selection.main.head).text).toBe("Done --> Check: yes"));
});

test("a dotted line shows Dotted checked in its Arrow menu, and choosing Dotted writes --", async () => {
  const dotted = FLOW.replace("Check > Done: yes", "Check -- Done: yes");
  const s = setup(dotted);
  await waitFor(() => expect(s.node("Step Check")).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.edge(1), { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Line actions" })).getByRole("menuitem", { name: "Arrow" }));
  const sub = await screen.findByRole("menu", { name: "Arrow" });
  expect(rowsOf(sub)).toEqual(["One way|>", "Both ways|<>", "Dashed|-->", "No arrow|-", "Dotted|-- ✓"]);
  await userEvent.click(within(sub).getByRole("menuitemcheckbox", { name: "One way" }));
  await waitFor(() => expect(s.doc()).toBe(FLOW));
  fireEvent.contextMenu(s.edge(1), { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Line actions" })).getByRole("menuitem", { name: "Arrow" }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Arrow" })).getByRole("menuitemcheckbox", { name: "Dotted" }));
  await waitFor(() => expect(s.doc()).toBe(dotted));
});

test("a class line's menu names the relationship kinds (CL2)", async () => {
  const cls = lines('diagram class "Types"', "class Animal", "class Dog", "Animal <|-- Dog");
  const s = setup(cls);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.edge(0), { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Line actions" })).getByRole("menuitem", { name: "Relationship" }));
  const sub = await screen.findByRole("menu", { name: "Relationship" });
  expect(rowsOf(sub)).toEqual(["Inheritance|<|-- ✓", "Composition|*--", "Dependency|..>", "Association|-->", "Link|--", "No arrow|-"]);
  await userEvent.click(within(sub).getByRole("menuitemcheckbox", { name: "Composition" }));
  await waitFor(() => expect(s.doc()).toBe(cls.replace("<|--", "*--")));
});

test("a shape's menu (F31): edit text, details, clipboard, add connected, show, delete", async () => {
  const s = setup(FLOW);
  await waitFor(() => expect(s.node("Step Check")).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.node("Step Check")!, { clientX: 320, clientY: 220 });
  const menu = await screen.findByRole("menu", { name: "Check actions" });
  expect(rowsOf(menu)).toEqual([
    "Edit text|F2",
    "Details...",
    "Colour|none",
    "Duplicate|Ctrl+D",
    "Cut|Ctrl+X",
    "Copy|Ctrl+C",
    "Add connected",
    "Fit to content",
    "Show in the text",
    "Delete|Delete",
  ]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Add connected" }));
  const sub = await screen.findByRole("menu", { name: "Add connected" });
  expect(rowsOf(sub)).toEqual(["Step", "Decision", "Input or output", "Start or end"]);
  await userEvent.click(within(sub).getByRole("menuitem", { name: "Decision" }));
  // Its name opens first, written when kept (diagram step 6).
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Name the new decision" }), { key: "Enter" });
  await waitFor(() => expect(s.doc()).toContain("Decision [decision]\n"));
  expect(s.doc()).toContain("Check > Decision\n");
});

test("a cloud service's menu also changes its icon and groups (C2)", async () => {
  const cloud = lines('diagram cloud "Stack"', "Api [icon: aws-lambda]", "Db [icon: aws-rds]", "Api > Db");
  const s = setup(cloud);
  await waitFor(() => expect(s.container.querySelector('.react-flow__node[data-id="Api"]')).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.container.querySelector('.react-flow__node[data-id="Api"]')!, { clientX: 320, clientY: 220 });
  const menu = await screen.findByRole("menu", { name: "Api actions" });
  expect(rowsOf(menu)).toContain("Choose icon...");
  expect(rowsOf(menu)).toContain("Group|Ctrl+G");
});

test("several selected (F11): Align and Distribute, the clipboard and Delete n items, from a shape or the selection box", async () => {
  const layout = JSON.stringify({ version: 1, nodes: { "Request in": { x: 0, y: 0 }, Check: { x: 300, y: 37 }, Done: { x: 610, y: 81 } } });
  const s = setup(FLOW, layout);
  await waitFor(() => expect(s.node("Step Check")).not.toBeNull(), { timeout: 4000 });
  s.press("a", { ctrlKey: true });
  act(() => canvas.props!.onContextMenu!({ node: null, selection: true, screen: { x: 300, y: 200 }, flow: { x: 0, y: 0 }, fit() {} }));
  const menu = await screen.findByRole("menu", { name: "3 selected" });
  expect(rowsOf(menu)).toEqual(["Align", "Distribute", "Colour|none", "Cut|Ctrl+X", "Copy|Ctrl+C", "Duplicate|Ctrl+D", "Tidy selection", "Delete 3 items|Delete"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Align" }));
  const align = await screen.findByRole("menu", { name: "Align" });
  expect(rowsOf(align)).toEqual(["Left", "Centre", "Right", "Top", "Middle", "Bottom"]);
  await userEvent.click(within(align).getByRole("menuitem", { name: "Top" }));
  const at = (id: string) => canvas.props!.nodes.find((n) => n.id === id)!.position;
  await waitFor(() => expect([at("Request in").y, at("Check").y, at("Done").y]).toEqual([0, 0, 0]));
  // One undo step puts all three back.
  act(() => void undo(s.view()));
  await waitFor(() => expect([at("Request in").y, at("Check").y, at("Done").y]).toEqual([0, 37, 81]));
  // A right-click on one of the selected shapes opens the same menu.
  fireEvent.contextMenu(s.node("Step Check")!, { clientX: 320, clientY: 220 });
  const again = await screen.findByRole("menu", { name: "3 selected" });
  await userEvent.click(within(again).getByRole("menuitem", { name: "Distribute" }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Distribute" })).getByRole("menuitem", { name: "Horizontally" }));
  // The first and last stay; the gaps between the boxes become equal.
  const w = (id: string) => canvas.props!.nodes.find((n) => n.id === id)!.initialWidth!;
  await waitFor(() => {
    const gapA = at("Check").x - (at("Request in").x + w("Request in"));
    const gapB = at("Done").x - (at("Check").x + w("Check"));
    expect(Math.abs(gapA - gapB)).toBeLessThanOrEqual(1);
  });
  expect([at("Request in").x, at("Done").x]).toEqual([0, 610]);
});

test("the canvas menu (F31): Add here with the kind's shapes, then Paste, Select all, Tidy, Zoom to fit and Publish", async () => {
  const s = setup(FLOW);
  await waitFor(() => expect(s.node("Step Check")).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.container.querySelector(".react-flow__pane") as HTMLElement, { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Canvas actions" });
  expect(rowsOf(menu)).toEqual(["Add here", "Paste|Ctrl+V", "Select all|Ctrl+A", "Tidy", "Zoom to fit|Shift+1", "Publish image...|Ctrl+Shift+E"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Add here" }));
  const sub = await screen.findByRole("menu", { name: "Add here" });
  expect(rowsOf(sub)).toEqual(["Step|R", "Decision|D", "Input or output|P", "Start or end|O"]);
  await userEvent.click(within(sub).getByRole("menuitem", { name: "Decision" }));
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Name the new decision" }), { key: "Enter" });
  await waitFor(() => expect(s.doc()).toContain("Decision [decision]\n"));
});

test("a double-click on a selected shape's edge fits it to its content (erd-ux-research 5.5)", async () => {
  const layout = JSON.stringify({ version: 1, nodes: { "Request in": { x: 0, y: 0 }, Check: { x: 0, y: 200 }, Done: { x: 0, y: 400 } }, sizes: { Check: { w: 400, h: 300 } } });
  const s = setup(FLOW, layout);
  await waitFor(() => expect(s.node("Step Check")).not.toBeNull(), { timeout: 4000 });
  const width = () => canvas.props!.nodes.find((n) => n.id === "Check")!.initialWidth;
  await waitFor(() => expect(width()).toBe(400));
  act(() => canvas.props!.onSelect!(["Check"]));
  const wrap = s.node("Step Check")!;
  const zone = await waitFor(() => {
    const z = wrap.querySelector<HTMLElement>('.rz-zone[data-dir="e"]');
    expect(z).not.toBeNull();
    return z!;
  });
  fireEvent.doubleClick(zone);
  await waitFor(() => expect(width()).toBeLessThan(400));
});

test("a resized shape's Fit to content gives it its own size back", async () => {
  const layout = JSON.stringify({ version: 1, nodes: { "Request in": { x: 0, y: 0 }, Check: { x: 0, y: 200 }, Done: { x: 0, y: 400 } }, sizes: { Check: { w: 400, h: 300 } } });
  const s = setup(FLOW, layout);
  await waitFor(() => expect(s.node("Step Check")).not.toBeNull(), { timeout: 4000 });
  const width = () => canvas.props!.nodes.find((n) => n.id === "Check")!.initialWidth;
  await waitFor(() => expect(width()).toBe(400));
  fireEvent.contextMenu(s.node("Step Check")!, { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Check actions" })).getByRole("menuitem", { name: "Fit to content" }));
  await waitFor(() => expect(width()).toBeLessThan(400));
  await waitFor(() => {
    const writes = callsTo("write_diagram_layout");
    expect(writes.length).toBeGreaterThan(0);
    expect(String(writes[writes.length - 1].layout)).not.toContain('"w": 400');
  });
});
