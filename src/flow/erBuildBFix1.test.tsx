// ER build B, fix round 1 (er-build-b-review.md): line ops never hit a line the user did not pick and say why when
// they refuse; "Add relationship to..." ends as draw.io's connect mode does; one free-name rule for ER tables;
// Shift+F10 and the Menu key open the target's menu; Fit to content is one undo step; menu words and counts.
//
// B3 Task 8 brought back the I5 column case and Task 9 the rest, on a board in block form with cards queried as
// `Table <t>` (R17). Adapted as the plan names: I3's "any other action" is arming the Relationship tool (the old W
// tool is gone, decision 9); I4 is QuickAdd's name field (A18, R16); I5's flow case runs with the canvas focused
// under B1's toolbar; M10's table add is the pane menu's "Add here > Table", which opens the new-table field (R15).
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { LangClient } from "../lang/client";
import { sqlFreeName } from "../lang/flow/model";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

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
const ER = lines('diagram er "Billing"', "customers {", "  id int pk", "}", "invoices {", "  id int pk", "}", "", "invoices.id > customers.id");
const FLOW = lines('diagram flow "Refund"', "Request in [start]", "Check", "Done [end]", "Request in > Check", "Check > Done: yes");
const STATE = lines('diagram state "Invoice"', "Draft", "Sent", "[*] > Draft", "Draft > Sent");
const LINKING = "Click the table customers refers to. Esc cancels.";

function setup(text: string, layout: string | null = null) {
  routeInvoke({ read_diagram: () => ({ text, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="fix1" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const card = (table: string) => utils.container.querySelector(`.react-flow__node [aria-label="Table ${table}"]`) as HTMLElement | null;
  const edge = (i: number) => utils.container.querySelector(`.react-flow__edge[data-id="edge:${i}"]`) as HTMLElement;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  /** Types into the text as the user would. */
  const type = (from: number, insert: string) => act(() => void view().dispatch({ changes: { from, insert }, userEvent: "input.type" }));
  return { ...utils, view, doc, card, edge, canvasEl, press, strip, type };
}
type Setup = ReturnType<typeof setup>;

async function edges(s: Setup, n = 1) {
  await waitFor(() => expect(s.edge(n - 1)).not.toBeNull(), { timeout: 4000 });
}

test("I1 while the text has an error a line's menu changes nothing and says why", async () => {
  const s = setup(FLOW);
  await edges(s, 2);
  s.type(s.doc().length, "Broken [nope\n");
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  const before = s.doc();
  fireEvent.contextMenu(s.edge(0), { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Line actions" })).getByRole("menuitem", { name: "Reverse" }));
  await waitFor(() => expect(within(s.strip()).getByText("Fix the text first: the drawing is the last one without errors.")).toBeTruthy());
  expect(s.doc()).toBe(before);
});

test("I1 a line op finds the line meant by its ends after the text gained a line above it", async () => {
  const s = setup(FLOW);
  await edges(s, 2);
  fireEvent.contextMenu(s.edge(1), { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Line actions" });
  // The text changes under the open menu: a new line goes in above Check > Done.
  s.type(s.doc().indexOf("Request in > Check"), "Done > Check\n");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Reverse" }));
  await waitFor(() => expect(s.doc()).toContain("Done > Check: yes"));
  expect(s.doc()).toContain("Done > Check\nRequest in > Check\n");
});

test("I2 the arrow a line already has does nothing and says nothing", async () => {
  const s = setup(FLOW);
  await edges(s, 2);
  fireEvent.contextMenu(s.edge(1), { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Line actions" })).getByRole("menuitem", { name: "Arrow" }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Arrow" })).getByRole("menuitemcheckbox", { name: "One way" }));
  await new Promise((r) => setTimeout(r, 50));
  expect(s.doc()).toBe(FLOW);
  expect(s.strip().querySelector(".flow-notice")).toBeNull();
});

test("I2 a line end dropped where it cannot go is refused with the reason", async () => {
  const s = setup(STATE);
  await edges(s, 2);
  act(() => canvas.props!.onLineSelect!(["edge:1"]));
  const end = await waitFor(() => {
    const e = s.container.querySelector('.flow-line-end[data-end="to"]');
    expect(e).not.toBeNull();
    return e!;
  });
  // Onto the start marker: a line cannot end at the start.
  const start = canvas.props!.nodes.find((n) => n.id === "[*] start")!;
  const t = (s.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([\d.e]+)\)/.exec(t)!;
  const at = { clientX: (start.position.x + 5) * Number(m[3]) + Number(m[1]), clientY: (start.position.y + 5) * Number(m[3]) + Number(m[2]) };
  fireEvent.pointerDown(end, { button: 0, pointerId: 1, ...at });
  fireEvent.pointerUp(window, { pointerId: 1, ...at });
  await waitFor(() => expect(within(s.strip()).getByText("The start only begins a line and the end only ends one.")).toBeTruthy());
  expect(s.doc()).toBe(STATE);
});

/** Starts "Add relationship to..." from customers' menu. */
async function startLinking(s: Setup) {
  fireEvent.contextMenu(s.card("customers")!.querySelector(".fkind-head")!, { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "customers actions" })).getByRole("menuitem", { name: "Add relationship to..." }));
  await screen.findByText(LINKING);
}

test("I3 Add relationship to... ends on a click of empty canvas, and a later table pick writes nothing", async () => {
  const s = setup(ER);
  await waitFor(() => expect(s.card("customers")).not.toBeNull(), { timeout: 4000 });
  await startLinking(s);
  act(() => canvas.props!.onSelect!([]));
  await waitFor(() => expect(screen.queryByText(LINKING)).toBeNull());
  fireEvent.pointerDown(s.card("invoices")!.querySelector(".fkind-head")!);
  await new Promise((r) => setTimeout(r, 50));
  expect(s.doc()).toBe(ER);
});

test("I3 the mode ends with its notice (any other action) and on a pick from the text, which never makes the line", async () => {
  const s = setup(ER);
  await waitFor(() => expect(s.card("customers")).not.toBeNull(), { timeout: 4000 });
  await startLinking(s);
  // Arming a tool replaces the notice with its own prompt: the mode goes with it.
  s.press("a");
  await waitFor(() => expect(screen.queryByText(LINKING)).toBeNull());
  s.press("Escape");
  fireEvent.pointerDown(s.card("invoices")!.querySelector(".fkind-head")!);
  await new Promise((r) => setTimeout(r, 50));
  expect(s.doc()).toBe(ER);
  await startLinking(s);
  // A click in the text selects invoices there: not a canvas pick.
  act(() => void s.view().dispatch({ selection: { anchor: s.doc().indexOf("invoices {") }, userEvent: "select.pointer" }));
  await waitFor(() => expect(screen.queryByText(LINKING)).toBeNull());
  await new Promise((r) => setTimeout(r, 50));
  expect(s.doc()).toBe(ER);
});

test("I4 an ER table added by Add and connect takes a SQL-friendly name", async () => {
  const s = setup(lines('diagram er "Shop"', "table {", "  id int", "}"));
  await waitFor(() => expect(s.card("table")).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onConnectRelease!({ node: "table", port: "r" }, { x: 900, y: 900 }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Add and connect" })).getByRole("menuitem", { name: /^Table/ }));
  // B1's name field opens with the free name (A18): a plain SQL name, never one with a space.
  const box = (await screen.findByLabelText(/^Name the new/, { selector: "input" })) as HTMLInputElement;
  expect(box.value).toBe(sqlFreeName("table", ["table"], 1));
  expect(box.value).not.toMatch(/\s/);
  const kept = box.value;
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(s.doc()).toMatch(new RegExp(`^${kept}\\b`, "m")));
  expect(s.doc()).not.toContain("table 2");
});

test("I5 Shift+F10 and the Menu key open the menu of what is selected: a shape, a line, several, or the canvas", async () => {
  const s = setup(FLOW);
  await edges(s, 2);
  s.canvasEl().focus();
  s.press("F10", { shiftKey: true });
  let menu = await screen.findByRole("menu", { name: "Canvas actions" });
  expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(s.canvasEl().contains(document.activeElement)).toBe(true);
  act(() => canvas.props!.onSelect!(["Check"]));
  s.press("ContextMenu");
  menu = await screen.findByRole("menu", { name: "Check actions" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  act(() => canvas.props!.onSelect!(["Check", "Done"]));
  s.press("F10", { shiftKey: true });
  menu = await screen.findByRole("menu", { name: "2 selected" });
  // Arrow keys move through it; Enter runs one.
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  act(() => canvas.props!.onSelect!([]));
  act(() => canvas.props!.onLineSelect!(["edge:1"]));
  s.press("ContextMenu");
  await screen.findByRole("menu", { name: "Line actions" });
});

test("I5 with an ER column selected, Shift+F10 opens that column's menu", async () => {
  const s = setup(ER);
  await waitFor(() => expect(s.card("customers")).not.toBeNull(), { timeout: 4000 });
  fireEvent.click([...s.card("customers")!.querySelectorAll<HTMLElement>(".fkind-er-row")][0]);
  s.press("F10", { shiftKey: true });
  await screen.findByRole("menu", { name: "customers.id actions" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  // The Menu key does the same while the column stays selected; once a press on the header lets the column go, the
  // table's own menu opens.
  s.press("ContextMenu");
  await screen.findByRole("menu", { name: "customers.id actions" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.pointerDown(s.card("customers")!.querySelector(".fkind-head")!);
  s.press("F10", { shiftKey: true });
  await screen.findByRole("menu", { name: "customers actions" });
  expect(s.doc()).toBe(ER);
});

test("I7 Fit to content is one undo step: Ctrl+Z puts the size back", async () => {
  const layout = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 400, y: 0 } }, sizes: { customers: { w: 400, h: 300 } } });
  const s = setup(ER, layout);
  await waitFor(() => expect(s.card("customers")).not.toBeNull(), { timeout: 4000 });
  const width = () => canvas.props!.nodes.find((n) => n.id === "customers")!.initialWidth;
  await waitFor(() => expect(width()).toBe(400));
  fireEvent.contextMenu(s.card("customers")!.querySelector(".fkind-head")!, { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "customers actions" })).getByRole("menuitem", { name: "Fit to content" }));
  await waitFor(() => expect(width()).not.toBe(400));
  act(() => void undo(s.view()));
  await waitFor(() => expect(width()).toBe(400));
});

test("M5 a selection menu counts in words with grouping commas; one box-selected shape gets its own menu", async () => {
  const s = setup(FLOW);
  await edges(s, 2);
  act(() => canvas.props!.onSelect!(["Check"]));
  act(() => canvas.props!.onContextMenu!({ node: null, selection: true, screen: { x: 300, y: 200 }, flow: { x: 0, y: 0 }, fit() {} }));
  await screen.findByRole("menu", { name: "Check actions" });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  act(() => canvas.props!.onSelect!(["Check", "Done"]));
  act(() => canvas.props!.onContextMenu!({ node: null, selection: true, screen: { x: 300, y: 200 }, flow: { x: 0, y: 0 }, fit() {} }));
  expect(within(await screen.findByRole("menu", { name: "2 selected" })).getByRole("menuitem", { name: "Delete 2 items" })).toBeTruthy();
});

test("M10 a shape's menu groups Duplicate before Cut and Copy (F31); Add table here opens the new table's name", async () => {
  const s = setup(FLOW);
  await edges(s, 2);
  // A's Colour row sits after Details... (decision 12); Duplicate still comes before Cut and Copy.
  fireEvent.contextMenu(s.container.querySelector('.react-flow__node[data-id="Check"]')!, { clientX: 320, clientY: 220 });
  const menu = await screen.findByRole("menu", { name: "Check actions" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label")).slice(0, 6)).toEqual(["Edit text", "Details...", "Colour", "Duplicate", "Cut", "Copy"]);
  cleanup();
  const e = setup(ER);
  await waitFor(() => expect(e.card("customers")).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(e.container.querySelector(".react-flow__pane") as HTMLElement, { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Canvas actions" })).getByRole("menuitem", { name: "Add here" }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Add here" })).getByRole("menuitem", { name: /^Table/ }));
  // Decision 9's new-table field, at the point, with the next free table name.
  const box = (await screen.findByLabelText("Table name", { selector: "input" })) as HTMLInputElement;
  expect(box.value).toBe(sqlFreeName("table", ["customers", "invoices"], 1));
  expect(e.doc()).toBe(ER);
});

test("N2 a tab switch ends Add relationship to... and takes its prompt from the strip", async () => {
  routeInvoke({ read_diagram: () => ({ text: ER, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const tab = (active: boolean) => (
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="fix1c" client={client} active={active} />
    </div>
  );
  const r = render(tab(true));
  const card = (t: string) => r.container.querySelector(`.react-flow__node [aria-label="Table ${t}"]`) as HTMLElement | null;
  await waitFor(() => expect(card("customers")).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(card("customers")!.querySelector(".fkind-head")!, { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "customers actions" })).getByRole("menuitem", { name: "Add relationship to..." }));
  await screen.findByText(LINKING);
  r.rerender(tab(false));
  r.rerender(tab(true));
  await waitFor(() => expect(screen.queryByText(LINKING)).toBeNull());
});
