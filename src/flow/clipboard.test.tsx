// Diagram build 1, step 2 (diagram-ux-research F2): Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+D and Ctrl+drag on the diagram canvas
// for every kind. The clipboard holds the selection's .flow lines; a paste writes them with free names as one undo
// step, the lines between copied shapes come along, and text that is not this kind's lines is refused with a note.
import { undo } from "@codemirror/commands";
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

/** The WebView's clipboard, as Contura reads and writes it (no Tauri plugin). */
const board = vi.hoisted(() => ({ text: "" }));

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (t: string) => {
        board.text = t;
      },
      readText: async () => board.text,
    },
  });
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  board.text = "";
});

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const FLOW = lines('diagram flow "Refund"', "", "Request in [start]", "Check [decision]", "Done [end]", "", "Request in > Check", "Check > Done: yes");

function setup(initial = FLOW, name = "clip") {
  routeInvoke({ read_diagram: () => ({ text: initial, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
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
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const at = (id: string) => canvas.props!.nodes.find((n) => n.id === id)?.position;
  const pick = (...names: string[]) => act(() => canvas.props!.onSelect!(names));
  return { ...utils, view, text, node, canvasEl, press, strip, at, pick };
}

type Setup = ReturnType<typeof setup>;

async function drawn(s: Setup, label = "Decision Check") {
  await waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });
}

function oneUndo(s: Setup, before: string) {
  act(() => void undo(s.view()));
  expect(s.text()).toBe(before);
}

const PASTED = lines(
  'diagram flow "Refund"',
  "",
  "Request in [start]",
  "Check [decision]",
  "Done [end]",
  "Check 2 [decision]",
  "Done 2 [end]",
  "",
  "Request in > Check",
  "Check > Done: yes",
  "Check 2 > Done 2: yes",
);

test("Ctrl+C then Ctrl+V pastes the shapes and the line between them with free names, as one undo step", async () => {
  const s = setup();
  await drawn(s);
  s.pick("Check", "Done");
  s.press("c", { ctrlKey: true });
  // The clipboard holds the selection's .flow lines.
  await waitFor(() => expect(board.text).toBe(lines("Check [decision]", "Done [end]", "Check > Done: yes")));
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toBe(PASTED));
  // The copies are selected, next to the originals (draw.io).
  await waitFor(() => expect(within(s.strip()).getByText("2 selected")).toBeTruthy());
  await waitFor(() => expect(s.at("Check 2")).toBeDefined());
  expect(s.at("Check 2")).toEqual({ x: s.at("Check")!.x + 16, y: s.at("Check")!.y + 16 });
  // A second paste lands one step further.
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toContain("Check 3 [decision]\nDone 3 [end]\n"));
  await waitFor(() => expect(s.at("Check 3")).toEqual({ x: s.at("Check")!.x + 32, y: s.at("Check")!.y + 32 }));
  oneUndo(s, PASTED);
  oneUndo(s, FLOW);
});

test("the copy and paste events carry the .flow lines, so other apps and the text side read them", async () => {
  const s = setup();
  await drawn(s);
  s.pick("Check", "Done");
  const setData = vi.fn();
  fireEvent.copy(s.canvasEl(), { clipboardData: { setData, getData: () => "" } });
  expect(setData).toHaveBeenCalledWith("text/plain", lines("Check [decision]", "Done [end]", "Check > Done: yes"));
  // Lines copied from the text side (or another diagram) paste the same way.
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => "Pack\nShip [end]\nPack > Ship" } });
  await waitFor(() => expect(s.text()).toBe(`${FLOW.replace("Done [end]\n", "Done [end]\nPack\nShip [end]\n")}Pack > Ship\n`));
  await waitFor(() => expect(within(s.strip()).getByText("2 selected")).toBeTruthy());
});

test("pasted text that is not lines of this diagram is refused with a note and never written", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => "SELECT * FROM users WHERE id > 1" } });
  await waitFor(() => expect(within(s.strip()).getByRole("status").textContent).toBe("Line 1 names SELECT * FROM users WHERE id, which is not one of the pasted shapes, so nothing was pasted."));
  expect(s.text()).toBe(FLOW);
});

test("Ctrl+D duplicates next to the originals and leaves the clipboard alone", async () => {
  const s = setup();
  await drawn(s);
  board.text = "kept";
  s.pick("Check", "Done");
  s.press("d", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toBe(PASTED));
  await waitFor(() => expect(s.at("Done 2")).toEqual({ x: s.at("Done")!.x + 16, y: s.at("Done")!.y + 16 }));
  expect(board.text).toBe("kept");
  oneUndo(s, FLOW);
});

test("Ctrl+X cuts: the shapes go as one undo step, and a paste brings them back under their own names", async () => {
  const s = setup();
  await drawn(s);
  s.pick("Done");
  s.press("x", { ctrlKey: true });
  const cut = lines('diagram flow "Refund"', "", "Request in [start]", "Check [decision]", "", "Request in > Check");
  await waitFor(() => expect(s.text()).toBe(cut));
  expect(board.text).toBe(lines("Done [end]"));
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toBe(lines('diagram flow "Refund"', "", "Request in [start]", "Check [decision]", "Done [end]", "", "Request in > Check")));
  oneUndo(s, cut);
  oneUndo(s, FLOW);
});

test("Ctrl+drag clones the dragged shapes where they are let go; the originals stay", async () => {
  const s = setup();
  await drawn(s);
  const before = s.at("Check")!;
  act(() => canvas.props!.onMove!("Check", 600, 405, true));
  await waitFor(() => expect(s.text()).toBe(FLOW.replace("Done [end]\n", "Done [end]\nCheck 2 [decision]\n")));
  await waitFor(() => expect(s.at("Check 2")).toEqual({ x: 600, y: 405 }));
  expect(s.at("Check")).toEqual(before);
  oneUndo(s, FLOW);
});

test("the shape menu has Cut, Copy and Duplicate; the canvas menu pastes where it was opened", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.node("Decision Check")!, { clientX: 320, clientY: 220 });
  const menu = await screen.findByRole("menu", { name: "Check actions" });
  expect(within(menu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual([
    "Edit text",
    "Details...",
    "Colour",
    "Duplicate",
    "Cut",
    "Copy",
    "Add connected",
    "Fit to content",
    "Show in the text",
    "Delete",
  ]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy" }));
  await waitFor(() => expect(board.text).toBe(lines("Check [decision]")));
  const pane = s.container.querySelector(".react-flow__pane") as HTMLElement;
  fireEvent.contextMenu(pane, { clientX: 300, clientY: 200 });
  const canvasMenu = await screen.findByRole("menu", { name: "Canvas actions" });
  expect(within(canvasMenu).getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual(["Add here", "Paste", "Select all", "Tidy", "Zoom to fit", "Publish image..."]);
  await userEvent.click(within(canvasMenu).getByRole("menuitem", { name: "Paste" }));
  await waitFor(() => expect(s.text()).toBe(FLOW.replace("Done [end]\n", "Done [end]\nCheck 2 [decision]\n")));
});

test("data flow: a duplicated process takes the next free id", async () => {
  const dfd = lines('diagram dfd "D"', "Customer [entity]", "Checkout [process, id: 1.0]", "", "Customer > Checkout: order");
  const s = setup(dfd, "dfd-clip");
  await drawn(s, "Process Checkout");
  s.pick("Checkout");
  s.press("d", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toBe(dfd.replace("Checkout [process, id: 1.0]\n", "Checkout [process, id: 1.0]\nCheckout 2 [process, id: 2.0]\n")));
});

test("sequence: a duplicated participant joins the others; its messages to copied participants come along", async () => {
  const seq = lines('diagram sequence "Pay"', "participant App", "participant Api", "App -> Api : charge");
  const s = setup(seq, "seq-clip");
  await drawn(s, "Participant App");
  s.pick("App", "Api");
  s.press("d", { ctrlKey: true });
  await waitFor(() =>
    expect(s.text()).toBe(lines('diagram sequence "Pay"', "participant App", "participant Api", "participant App 2", "participant Api 2", "App -> Api : charge", "App 2 -> Api 2: charge")),
  );
});

test("mind map: Ctrl+D puts the copy next to the topic; Ctrl+V pastes under the selected topic", async () => {
  const mm = lines('diagram mindmap "Plan"', "root Q4 plan", "  Diagrams", "    New kinds", "  Release");
  const s = setup(mm, "mm-clip");
  await drawn(s, "Topic Diagrams");
  s.pick("Diagrams", "New kinds");
  s.press("d", { ctrlKey: true });
  const dup = lines('diagram mindmap "Plan"', "root Q4 plan", "  Diagrams", "    New kinds", "  Diagrams 2", "    New kinds 2", "  Release");
  await waitFor(() => expect(s.text()).toBe(dup));
  s.pick("Release");
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(board.text).toBe(lines("  Release")));
  s.pick("New kinds");
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toBe(dup.replace("    New kinds\n", "    New kinds\n      Release 2\n")));
});

test("timeline: a duplicated item keeps its date", async () => {
  const tl = lines('diagram timeline "2026"', "2026-10-19: Docs ready", "milestone v1.0");
  const s = setup(tl, "tl-clip");
  await drawn(s, "Event Docs ready");
  s.pick("Docs ready");
  s.press("d", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toBe(lines('diagram timeline "2026"', "2026-10-19: Docs ready", "milestone v1.0", "2026-10-19: Docs ready 2")));
});

// ---- Fix round 1

/** A screen point in flow coordinates, read from the drawn viewport (the canvas sits at 0, 0 in jsdom). */
function flowAt(s: Setup, x: number, y: number) {
  const t = (s.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([\d.e]+)\)/.exec(t);
  if (!m) throw new Error(`no viewport transform in "${t}"`);
  const [tx, ty, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return { x: (x - tx) / z, y: (y - ty) / z };
}
const whole = (v: number) => Math.round(v);
const status = (s: Setup) => within(s.strip()).getByRole("status").textContent;

test("C1 a clipboard text over 1 MB is refused before it reaches the worker, with a note", async () => {
  const s = setup();
  await drawn(s);
  const ask = vi.spyOn(LangClient.prototype, "flowEdit");
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => "Step\n".repeat(220_000) } });
  await waitFor(() => expect(status(s)).toBe("The clipboard text is larger than 1 MB, so nothing was pasted."));
  expect(ask).not.toHaveBeenCalled();
  ask.mockRestore();
  expect(s.text()).toBe(FLOW);
});

test("C1 shapes pasted from outside go in a compact block at the pointer, not in one long row", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.pointerMove(s.canvasEl(), { clientX: 500, clientY: 300 });
  const nine = Array.from({ length: 9 }, (_, i) => `Item ${i}`).join("\n");
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => nine } });
  await waitFor(() => expect(s.at("Item 8")).toBeDefined());
  const spots = Array.from({ length: 9 }, (_, i) => s.at(`Item ${i}`)!);
  expect(new Set(spots.map((p) => p.x)).size).toBe(3);
  expect(new Set(spots.map((p) => p.y)).size).toBe(3);
  const p = flowAt(s, 500, 300);
  expect(s.at("Item 0")).toEqual({ x: whole(p.x), y: whole(p.y) });
});

test("M2 a refused paste says why", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => "Ship [end]\nCheck > Ship" } });
  await waitFor(() => expect(status(s)).toBe("Line 2 names Check, which is not one of the pasted shapes, so nothing was pasted."));
  expect(s.text()).toBe(FLOW);
});

test("M4 a paste that leaves out a group says so", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.paste(s.canvasEl(), { clipboardData: { getData: () => "Box {\n  Inside\n}" } });
  await waitFor(() => expect(s.text()).toContain("Inside\n"));
  await waitFor(() => expect(status(s)).toBe("Groups are not pasted yet, only the shapes in them."));
});

test("I1 Ctrl+V with no paste event reads the system clipboard first, and the last copy only when it is empty", async () => {
  const s = setup();
  await drawn(s);
  s.pick("Check");
  s.press("c", { ctrlKey: true });
  await waitFor(() => expect(board.text).toBe(lines("Check [decision]")));
  // Something else was copied since, in another app.
  board.text = "Ship [end]";
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toBe(FLOW.replace("Done [end]\n", "Done [end]\nShip [end]\n")));
  board.text = "";
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toContain("Check 2 [decision]\n"));
});

test("I5 a duplicated note gets the next note name, is placed and selected, and no other note moves", async () => {
  const text = lines('diagram flow "N"', "A", "note: first", "", "G {", "  B", "  note: in group", "}", "", "A > B");
  const s = setup(text, "notes");
  await drawn(s, "Step A");
  await waitFor(() => expect(s.at("Note 2")).toBeDefined());
  const other = s.at("Note 2");
  s.pick("Note 1");
  s.press("d", { ctrlKey: true });
  await waitFor(() => expect(s.text()).toBe(text.replace("}\n", "}\nnote: first\n")));
  await waitFor(() => expect(s.at("Note 3")).toEqual({ x: s.at("Note 1")!.x + 16, y: s.at("Note 1")!.y + 16 }));
  expect(s.at("Note 2")).toEqual(other);
  expect(canvas.props!.selection).toEqual(["Note 3"]);
});

test("I6 Ctrl+V lands at the pointer while it is over the canvas, beside the originals once it has left", async () => {
  const s = setup();
  await drawn(s);
  s.pick("Check", "Done");
  s.press("c", { ctrlKey: true });
  fireEvent.pointerMove(s.canvasEl(), { clientX: 640, clientY: 420 });
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.at("Check 2")).toBeDefined());
  const p = flowAt(s, 640, 420);
  // The block's top left goes to the pointer, and the copies keep their arrangement.
  const left = Math.min(s.at("Check")!.x, s.at("Done")!.x);
  const top = Math.min(s.at("Check")!.y, s.at("Done")!.y);
  expect(s.at("Check 2")).toEqual({ x: whole(p.x) + s.at("Check")!.x - left, y: whole(p.y) + s.at("Check")!.y - top });
  expect(s.at("Done 2")).toEqual({ x: whole(p.x) + s.at("Done")!.x - left, y: whole(p.y) + s.at("Done")!.y - top });
  fireEvent.pointerLeave(s.canvasEl());
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.at("Check 3")).toBeDefined());
  expect(s.at("Check 3")).toEqual({ x: s.at("Check")!.x + 16, y: s.at("Check")!.y + 16 });
});

test("I6 a copy from another diagram of the same kind keeps its arrangement, at the pointer", async () => {
  const a = setup(FLOW, "from");
  await drawn(a);
  a.pick("Check", "Done");
  a.press("c", { ctrlKey: true });
  await waitFor(() => expect(board.text).not.toBe(""));
  const gap = { x: a.at("Done")!.x - a.at("Check")!.x, y: a.at("Done")!.y - a.at("Check")!.y };
  cleanup();
  const other = lines('diagram flow "Other"', "Gate [decision]");
  const b = setup(other, "to");
  await drawn(b, "Decision Gate");
  fireEvent.pointerMove(b.canvasEl(), { clientX: 400, clientY: 250 });
  b.press("v", { ctrlKey: true });
  await waitFor(() => expect(b.at("Done")).toBeDefined());
  expect({ x: b.at("Done")!.x - b.at("Check")!.x, y: b.at("Done")!.y - b.at("Check")!.y }).toEqual(gap);
  const p = flowAt(b, 400, 250);
  expect(Math.min(b.at("Check")!.x, b.at("Done")!.x)).toBe(whole(p.x));
});

test("I6 M8 a paste after a cut lands where the shapes were; after the cut is undone it lands beside them", async () => {
  const s = setup();
  await drawn(s);
  const was = s.at("Done")!;
  s.pick("Done");
  s.press("x", { ctrlKey: true });
  await waitFor(() => expect(s.text()).not.toContain("Done"));
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.at("Done")).toEqual(was));
  // Undo the paste and the cut: the original is back, so a paste goes beside it.
  act(() => void undo(s.view()));
  act(() => void undo(s.view()));
  expect(s.text()).toBe(FLOW);
  s.pick("Done");
  s.press("x", { ctrlKey: true });
  await waitFor(() => expect(s.text()).not.toContain("Done"));
  act(() => void undo(s.view()));
  expect(s.text()).toBe(FLOW);
  s.press("v", { ctrlKey: true });
  await waitFor(() => expect(s.at("Done 2")).toBeDefined());
  expect(s.at("Done 2")).toEqual({ x: was.x + 16, y: was.y + 16 });
});

test("I6 the canvas menu's Paste lands where the menu was opened", async () => {
  const s = setup();
  await drawn(s);
  board.text = "Ship [end]";
  fireEvent.contextMenu(s.container.querySelector(".react-flow__pane") as HTMLElement, { clientX: 700, clientY: 450 });
  const menu = await screen.findByRole("menu", { name: "Canvas actions" });
  const p = flowAt(s, 700, 450);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Paste" }));
  await waitFor(() => expect(s.at("Ship")).toBeDefined());
  expect(s.at("Ship")).toEqual({ x: whole(p.x), y: whole(p.y) });
});
