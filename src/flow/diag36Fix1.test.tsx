// Diagram build 2, fix round 1 (diag-36-build-review.md): the picked class member is drawn and never takes keys the
// selected class should have (I1); an open member row or date field keeps its typed text under the Assistant's lock
// (I2); a lost + drag never writes (I3); a participant's name field sits on its head (I4); and the minors.
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { LangClient } from "../lang/client";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import tabCss from "../styles/flow-tab.css?raw";
import FlowTab from "./FlowTab";
import { SEQ_HEAD } from "./kindLayout";

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

/** The Assistant's lock, held for a test. */
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

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  lock.on = false;
});

const lines = (...l: string[]) => `${l.join("\n")}\n`;

function setup(initial: string, layout: string | null = null) {
  routeInvoke({ read_diagram: () => ({ text: initial, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="fix1" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const field = (label: string) => screen.findByRole("textbox", { name: label }) as Promise<HTMLInputElement>;
  return { ...utils, view, doc, node, press, field, canvasEl };
}
type Setup = ReturnType<typeof setup>;
const shown = (s: Setup, label: string) => waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });

const CLASS = lines('diagram class "Billing"', "class Invoice", "Invoice : + total: decimal", "class LineItem", "LineItem : + qty: int");

test("I1 after adding members and closing the empty row, Delete removes the selected class, not a member nobody sees", async () => {
  const s = setup(CLASS);
  await shown(s, "Class LineItem");
  fireEvent.doubleClick(s.node("Class LineItem")!.querySelector(".fkind-inside")!);
  await userEvent.type(await s.field("Member"), "+ id: int{Enter}");
  await waitFor(() => expect(s.doc()).toContain("LineItem : + id: int\n"));
  await userEvent.type(await s.field("Member"), "{Enter}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Member" })).toBeNull());
  expect(s.node("Class LineItem")!.querySelector(".is-picked")).toBeNull();
  s.press("Delete");
  await waitFor(() => expect(s.doc()).not.toContain("class LineItem"));
});

test("I1 a member is picked by a press on its row, drawn picked; Delete removes it; a press on the header lets it go", async () => {
  const s = setup(CLASS);
  await shown(s, "Class LineItem");
  const row = () => s.node("Class LineItem")!.querySelector('[data-row="0"]') as HTMLElement;
  fireEvent.pointerDown(row());
  await waitFor(() => expect(row().classList.contains("is-picked")).toBe(true));
  expect(row().getAttribute("aria-selected")).toBe("true");
  fireEvent.pointerDown(s.node("Class LineItem")!.querySelector(".fkind-head")!);
  await waitFor(() => expect(row().classList.contains("is-picked")).toBe(false));
  fireEvent.pointerDown(row());
  await waitFor(() => expect(row().classList.contains("is-picked")).toBe(true));
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(CLASS.replace("LineItem : + qty: int\n", "")));
});

test("I2 an open member row keeps its typed text when the Assistant takes the text, and says why it waits", async () => {
  const s = setup(CLASS);
  await shown(s, "Class LineItem");
  fireEvent.doubleClick(s.node("Class LineItem")!.querySelector(".fkind-inside")!);
  const box = await s.field("Member");
  await userEvent.type(box, "+ total: money");
  lock.on = true;
  // Any render now sees the lock.
  act(() => canvas.props!.onSelect!([]));
  await new Promise((r) => setTimeout(r, 20));
  const still = await s.field("Member");
  expect(still.value).toBe("+ total: money");
  fireEvent.keyDown(still, { key: "Enter" });
  expect((await screen.findByRole("alert")).textContent).toBe("The Assistant is working on the text. Your edit is kept until it finishes.");
  expect(s.doc()).toBe(CLASS);
});

const FLOW = lines('diagram flow "Orders"', "Order in [start]", "Check stock", "Done [end]");
const FLOW_AT = JSON.stringify({ version: 1, nodes: { "Order in": { x: 100, y: 100 }, "Check stock": { x: 100, y: 300 }, Done: { x: 500, y: 300 } } });

test("I3 a + drag that is cancelled, or ended with Esc, writes nothing on a later release", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "End Done");
  fireEvent.pointerMove(s.node("Start Order in")!, { clientX: 10, clientY: 10 });
  const plus = await screen.findByRole("button", { name: "Add the next start or end below" });
  // Over Done, in screen coordinates (the test canvas: translate, scale 1).
  const vp = s.container.querySelector(".react-flow__viewport") as HTMLElement;
  const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(vp.style.transform)!;
  const onDone = { x: Number(m[1]) + 536, y: Number(m[2]) + 318 };
  fireEvent.pointerDown(plus, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerCancel(window, { pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: onDone.x, clientY: onDone.y, pointerId: 1 });
  await new Promise((r) => setTimeout(r, 30));
  expect(s.doc()).toBe(FLOW);
  expect(s.container.querySelector(".flow-pending")).toBeNull();
  fireEvent.pointerMove(s.node("Start Order in")!, { clientX: 10, clientY: 10 });
  const again = await screen.findByRole("button", { name: "Add the next start or end below" });
  fireEvent.pointerDown(again, { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
  fireEvent.pointerMove(window, { clientX: 100, clientY: 100, pointerId: 2 });
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(window, { clientX: onDone.x, clientY: onDone.y, pointerId: 2 });
  await new Promise((r) => setTimeout(r, 30));
  expect(s.doc()).toBe(FLOW);
  expect(screen.queryByRole("textbox", { name: /Name the new/ })).toBeNull();
});

test("I4 a participant's name field opens on its head, not mid-lifeline", async () => {
  const SEQ = lines('diagram sequence "Pay"', "participant App", "participant Api", ...Array.from({ length: 10 }, (_, i) => `App -> Api: m${i}`));
  const s = setup(SEQ);
  await shown(s, "Participant App");
  fireEvent.doubleClick(s.node("Participant App")!);
  const box = await s.field("Rename App");
  const top = parseFloat((box.closest(".inline-edit-wrap") as HTMLElement).style.top);
  const app = canvas.props!.nodes.find((n) => n.id === "App")!;
  expect(top).toBe(app.position.y + SEQ_HEAD / 2);
});

test("M1 a new field replacing an open one starts with its own name, selected", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  s.press("n");
  const note = await s.field("Note text");
  await userEvent.clear(note);
  await userEvent.type(note, "{Enter}");
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "More shapes" }));
  await userEvent.click(within(within(await screen.findByRole("dialog", { name: "Add to the board" })).getAllByRole("group")[0]).getByRole("option", { name: "Database" }));
  const db = await s.field("Name the new database");
  expect([db.value, db.selectionStart, db.selectionEnd]).toEqual(["Database", 0, 8]);
});

test("M3 a focused + works from the keyboard", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  fireEvent.pointerMove(s.node("Step Check stock")!, { clientX: 10, clientY: 10 });
  const plus = await screen.findByRole("button", { name: "Add the next step below" });
  plus.focus();
  await userEvent.keyboard("{Enter}");
  expect(await s.field("Name the new step")).toBeTruthy();
});

test("M5 a refused end date keeps focus on Until", async () => {
  const TL = lines('diagram timeline "Launch"', "2026-10-05 to 2026-10-20: Build");
  const s = setup(TL);
  await shown(s, "Period Build");
  fireEvent.doubleClick(s.node("Period Build")!.querySelector('[data-part="date"]')!);
  await screen.findByLabelText("From");
  const until = screen.getByLabelText("Until") as HTMLInputElement;
  fireEvent.change(until, { target: { value: "2026-10-01" } });
  until.focus();
  fireEvent.keyDown(until, { key: "Enter" });
  await screen.findByRole("alert");
  await waitFor(() => expect(document.activeElement).toBe(until));
});

// ----- the spec gaps (the approved board is the spec)

const ADDED = lines('diagram flow "Orders"', "Order in [start]", "Check stock", "Done [end]");

test("letter keys and toolbar buttons open the new shape with its name ready, as N and the Shapes list do", async () => {
  const s = setup(ADDED, FLOW_AT);
  await shown(s, "Step Check stock");
  s.press("r");
  s.press("Enter");
  const box = await s.field("Name the new step");
  expect(s.doc()).toBe(ADDED);
  await userEvent.type(box, "Pack{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 4 });
  await waitFor(() => expect(s.doc()).toBe(ADDED.replace("Done [end]\n", "Done [end]\nPack [step]\n")));
  await userEvent.click(screen.getByRole("button", { name: "Decision" }));
  s.press("Enter");
  const d = await s.field("Name the new decision");
  fireEvent.keyDown(d, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name the new decision" })).toBeNull());
  expect(s.doc()).toBe(ADDED.replace("Done [end]\n", "Done [end]\nPack [step]\n"));
});

test("a cloud service from its key is written with the board's default icon", async () => {
  const CLOUD = lines('diagram cloud "App"', "Users [icon: users]");
  const s = setup(CLOUD);
  await shown(s, "Service Users");
  s.press("r");
  s.press("Enter");
  const box = await s.field("Name the new service");
  await userEvent.type(box, "Api{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 7 });
  await waitFor(() => expect(s.doc()).toBe(`${CLOUD}Api [icon: aws-lambda]\n`));
});

test("the + ghost lined up with its source shows the alignment guide", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  fireEvent.pointerMove(s.node("Step Check stock")!, { clientX: 10, clientY: 10 });
  fireEvent.pointerDown(await screen.findByRole("button", { name: "Add the next step below" }), { button: 0, clientX: 1, clientY: 1, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 1, clientY: 1, pointerId: 1 });
  await s.field("Name the new step");
  const guide = s.container.querySelector(".flow-ghost-guide") as SVGLineElement | null;
  expect(guide).not.toBeNull();
  const src = canvas.props!.nodes.find((n) => n.id === "Check stock")!;
  expect(Number(guide!.getAttribute("x1"))).toBe(src.position.x + (src.initialWidth ?? 0) / 2);
});

test("a + that slid keeps its side: the kept line is drawn on the + axis, and the layout keeps it", async () => {
  const at = JSON.stringify({ version: 1, nodes: { "Order in": { x: 100, y: 100 }, "Check stock": { x: 100, y: 300 }, Done: { x: 100, y: 380 } } });
  const s = setup(ADDED, at);
  await shown(s, "End Done");
  fireEvent.pointerMove(s.node("Step Check stock")!, { clientX: 10, clientY: 10 });
  fireEvent.pointerDown(await screen.findByRole("button", { name: "Add the next step to the right" }), { button: 0, clientX: 1, clientY: 1, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 1, clientY: 1, pointerId: 1 });
  await userEvent.type(await s.field("Name the new step"), "{Enter}");
  await waitFor(() => expect(s.doc()).toContain("Check stock > Step\n"));
  await waitFor(() => expect((canvas.props!.edges.find((e) => e.source === "Check stock" && e.target === "Step")?.data as { axis?: string } | undefined)?.axis).toBe("h"));
});

test("a new flow's label field is kept off the shapes", async () => {
  const DFD = lines('diagram dfd "x"', "A [entity]", "B [entity]", "C [entity]");
  const at = JSON.stringify({ version: 1, nodes: { A: { x: 0, y: 100 }, B: { x: 600, y: 100 }, C: { x: 300, y: 90 } } });
  const s = setup(DFD, at);
  await shown(s, "Outside party C");
  act(() => canvas.props!.onConnectPorts!({ node: "A", port: "r" }, { node: "B", port: "l" }, false));
  const label = await s.field("Flow label");
  const wrap = label.closest(".inline-edit-wrap") as HTMLElement;
  const f = { x: parseFloat(wrap.style.left), y: parseFloat(wrap.style.top) - 12, w: 170, h: 24 };
  const c = canvas.props!.nodes.find((n) => n.id === "C")!;
  const cb = { x: c.position.x, y: c.position.y, w: c.initialWidth ?? 0, h: c.initialHeight ?? 0 };
  expect(f.x >= cb.x + cb.w || f.x + f.w <= cb.x || f.y >= cb.y + cb.h || f.y + f.h <= cb.y).toBe(true);
});

test("Add and connect from a port dragged to empty canvas opens the new shape centred there, written only when named", async () => {
  const DFD = lines('diagram dfd "x"', "Customer [entity]");
  const s = setup(DFD, JSON.stringify({ version: 1, nodes: { Customer: { x: 0, y: 0 } } }));
  await shown(s, "Outside party Customer");
  act(() => canvas.props!.onConnectRelease!({ node: "Customer", port: "r" }, { x: 500, y: 300 }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Add and connect" })).getByRole("menuitem", { name: /Process/ }));
  const box = await s.field("Name the new process");
  expect(s.doc()).toBe(DFD);
  const ghost = s.container.querySelector(".flow-ghost") as HTMLElement;
  expect(parseFloat(ghost.style.left) + parseFloat(ghost.style.width) / 2).toBeCloseTo(500, 0);
  expect(parseFloat(ghost.style.top) + parseFloat(ghost.style.height) / 2).toBeCloseTo(300, 0);
  await userEvent.type(box, "{Enter}");
  await waitFor(() => expect(s.doc()).toContain("Customer > Process\n"));
});

test("Shapes > Activation uses the selected participant", async () => {
  const SEQ = lines('diagram sequence "Pay"', "participant App", "participant Api", "", "App -> Api: charge");
  const s = setup(SEQ);
  await shown(s, "Participant Api");
  act(() => canvas.props!.onSelect!(["Api"]));
  await userEvent.click(screen.getByRole("button", { name: "More shapes" }));
  await userEvent.click(within(within(await screen.findByRole("dialog", { name: "Add to the board" })).getAllByRole("group")[0]).getByRole("option", { name: "Activation" }));
  await waitFor(() => expect(s.doc()).toBe(`${SEQ}activate Api\n`));
});

test("mind map Topic adds a sibling of the selected topic; Subtopic a child", async () => {
  const MIND = lines('diagram mindmap "Plan"', "root Launch", "  Docs", "    Guide", "  Build");
  const s = setup(MIND);
  await shown(s, "Topic Docs");
  act(() => canvas.props!.onSelect!(["Docs"]));
  s.press("r");
  s.press("Enter");
  await userEvent.type(await s.field("Name the new topic"), "Ops{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 5 });
  await waitFor(() => expect(s.doc()).toBe(`${MIND}  Ops\n`));
});

test("a state's start marker is placed clear of the lines too", async () => {
  const STATE = lines('diagram state "Invoice"', "Sent", "Draft", "", "Sent > Draft");
  const at = JSON.stringify({ version: 1, nodes: { Sent: { x: 100, y: 100 }, Draft: { x: 300, y: 100 } } });
  const s = setup(STATE, at);
  await shown(s, "State Draft");
  act(() => canvas.props!.onSelect!(["Draft"]));
  await userEvent.click(screen.getByRole("button", { name: "More shapes" }));
  await userEvent.click(within(within(await screen.findByRole("dialog", { name: "Add to the board" })).getAllByRole("group")[0]).getByRole("option", { name: "Start" }));
  await waitFor(() => expect(canvas.props!.nodes.find((n) => n.id === "[*] start")).toBeTruthy());
  const m = canvas.props!.nodes.find((n) => n.id === "[*] start")!;
  const sent = canvas.props!.nodes.find((n) => n.id === "Sent")!;
  // The line Sent > Draft runs along the middle of the two states, from Sent's right side to Draft's left.
  const y = sent.position.y + (sent.initialHeight ?? 0) / 2;
  const x0 = sent.position.x + (sent.initialWidth ?? 0);
  const onLine = m.position.y - 6 < y && m.position.y + 22 + 6 > y && m.position.x + 22 + 6 > x0 && m.position.x - 6 < 300;
  expect(onLine).toBe(false);
});

test("the loop's label field opens on the loop, at its message's row", async () => {
  const SEQ = lines('diagram sequence "Pay"', "participant App", "participant Api", "", "App -> Api: charge", "Api --> App: ok");
  const s = setup(SEQ);
  await shown(s, "Participant App");
  await userEvent.click(screen.getByRole("button", { name: "More shapes" }));
  await userEvent.click(within(within(await screen.findByRole("dialog", { name: "Add to the board" })).getAllByRole("group")[0]).getByRole("option", { name: "Loop" }));
  const label = await s.field("Loop label");
  const top = parseFloat((label.closest(".inline-edit-wrap") as HTMLElement).style.top);
  const app = canvas.props!.nodes.find((n) => n.id === "App")!;
  const row = app.position.y + SEQ_HEAD + 1.5 * 44;
  expect(Math.abs(top - row)).toBeLessThanOrEqual(30);
});

test("timeline Add here past the last item says which date it took; a milestone lands where it was double-clicked", async () => {
  const TL = lines('diagram timeline "Launch"', "2026-10-01: Kickoff", "2026-10-20: Ship");
  const s = setup(TL);
  await shown(s, "Event Ship");
  const ship = canvas.props!.nodes.find((n) => n.id === "Ship")!;
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 900, y: 300 }, flow: { x: ship.position.x + 400, y: 100 } }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Add here" })).getByRole("menuitem", { name: /Event/ }));
  await waitFor(() => expect(s.container.querySelector(".flow-pane-draw .flow-strip")!.textContent).toContain("the new item takes 2026-10-20, the date of Ship"));
  fireEvent.keyDown(await s.field("Name the new event"), { key: "Escape" });
  const kick = canvas.props!.nodes.find((n) => n.id === "Kickoff")!;
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 500, y: 300 }, flow: { x: (kick.position.x + ship.position.x) / 2 + 76, y: 100 } }));
  await userEvent.click(within(await screen.findByRole("menu", { name: "Add here" })).getByRole("menuitem", { name: /Milestone/ }));
  await userEvent.type(await s.field("Name the new milestone"), "Beta{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 9 });
  await waitFor(() => expect(s.doc()).toBe(lines('diagram timeline "Launch"', "2026-10-01: Kickoff", "milestone Beta", "2026-10-20: Ship")));
});

test("M6 a double-click on a group's title renames it, while the title leaves presses to the canvas (box select)", async () => {
  const GROUPED = lines('diagram flow "x"', "A", "Review {", "  B", "}");
  const at = JSON.stringify({ version: 1, nodes: { A: { x: 0, y: 0 }, B: { x: 300, y: 200 } } });
  const s = setup(GROUPED, at);
  await shown(s, "Step B");
  const area = canvas.props!.nodes.find((n) => n.id === "\u0000group:Review")!;
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 0, y: 0 }, flow: { x: area.position.x + 30, y: area.position.y + 14 } }));
  const box = await s.field("Group name");
  expect(box.value).toBe("Review");
  expect(screen.queryByRole("menu", { name: "Add here" })).toBeNull();
  // Step 9 (F9) replaces M6: the title is the group's handle now (a click selects, a drag moves), so it takes presses.
  const titleAt = tabCss.indexOf(".flow-area-name {");
  expect(tabCss.slice(titleAt, tabCss.indexOf("}", titleAt))).toContain("pointer-events: auto");
});

test("M7 a multi-line field grows with wrapped text, not only with line breaks", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  fireEvent.doubleClick(s.node("Step Check stock")!);
  const box = (await s.field("Rename Check stock")) as unknown as HTMLTextAreaElement;
  Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => 58 });
  await userEvent.type(box, "{End} and a long tail that wraps");
  expect(box.style.height).toBe("58px");
});
