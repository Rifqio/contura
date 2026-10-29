// The code pane's cursor stays inside the shown frame (the folded-range convention of VS Code and CodeMirror): after
// a frame switch, and after an undo or redo that leaves it in hidden text, it is put back into the shown block, so the
// status line counts from 1 and typing edits only the shown frame.
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import { flowEntry } from "../flowRegistry";
import FlowTab from "../FlowTab";
import { SINGLE_TEMPLATES } from "./catalog/templates";
import { frameView, shownRange, showFrame } from "./frameView";
import type Shelf from "./shelf/Shelf";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

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
type ShelfProps = Parameters<typeof Shelf>[0];
const shelf = vi.hoisted(() => ({ props: null as ShelfProps | null }));
vi.mock("./shelf/Shelf", async (load) => {
  const real = await load<typeof import("./shelf/Shelf")>();
  return {
    ...real,
    default: (p: ShelfProps) => {
      shelf.props = p;
      return real.default(p);
    },
  };
});

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});
beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  canvas.instance = null;
  shelf.props = null;
});

// A cloud frame, a flowchart, then an ER frame, as on the board the bug was seen on.
const CLOUD = 'diagram cloud "Order API"\nApi [icon: aws-lambda]\nDb [icon: aws-rds]\nApi > Db\n';
const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const BILLING = 'diagram er "Billing"\norders {\n  id int pk\n  customer_id int\n}\ncustomers {\n  id int pk\n}\norders.customer_id > customers.id\n';
const BOARD = [CLOUD, CHECKOUT, BILLING].join("\n");
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    "Order API": { at: { x: 0, y: 0 }, nodes: { Api: { x: 0, y: 0 }, Db: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Checkout: { at: { x: 700, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Billing: { at: { x: 1400, y: 0 }, nodes: {}, style: "modern", direction: "TB" },
  },
  sketches: [],
});

function setup() {
  const saved = { text: BOARD, layout: LAYOUT as string | null };
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
    icon_index: () => [],
    icon: () => '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const visible = () => view().contentDOM.textContent ?? "";
  const isSelected = (title: string) => screen.queryAllByRole("button", { name: new RegExp(` ${title}$`) }).some((b) => b.getAttribute("aria-current") === "true");
  return { ...utils, saved, view, canvasEl, visible, isSelected };
}
type Setup = ReturnType<typeof setup>;

async function opened(s: Setup) {
  for (const t of ["Order API", "Checkout", "Billing"]) await screen.findByRole("button", { name: new RegExp(` ${t}$`) });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => expect(s.container.querySelector(".cm-editor")).not.toBeNull());
}

/** Selects a frame on the canvas (as a click on its empty space does) and waits for the pane to show it. */
async function pick(s: Setup, title: string) {
  // The whole board in view, so every frame's tab is drawn (React Flow draws no node off screen).
  act(() => void canvas.instance!.setViewport({ x: 0, y: 0, zoom: 0.25 }));
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(` ${title}$`) }));
  await waitFor(() => expect(s.isSelected(title)).toBe(true));
  await waitFor(() => expect(s.visible()).toContain(`"${title}"`));
}

/** Adds a single template from the Shelf; the new frame is selected and shown. */
async function addFromShelf(s: Setup) {
  fireEvent.click(within(screen.getByRole("toolbar", { name: "Board tools" })).getByRole("button", { name: "Add" }));
  await screen.findByRole("dialog", { name: "Add to the board" });
  const t = SINGLE_TEMPLATES.find((x) => x.kind === "sequence")!;
  act(() => shelf.props!.onAdd({ kind: "template", id: t.id }));
  await waitFor(() => expect(s.isSelected(t.name)).toBe(true));
  await waitFor(() => expect(s.visible()).toContain(`"${t.name}"`));
  return t.name;
}

/** Lets every scheduled follow-up (microtasks, the after-paint switch) run. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 50)));

/** The cursor is inside the shown frame, and the status line counts within it. */
function expectInside(s: Setup) {
  const state = s.view().state;
  const shown = shownRange(state)!;
  expect(shown).not.toBeNull();
  for (const r of state.selection.ranges) {
    expect(r.head).toBeGreaterThanOrEqual(shown.from);
    expect(r.head).toBeLessThanOrEqual(shown.to);
    expect(r.anchor).toBeGreaterThanOrEqual(shown.from);
    expect(r.anchor).toBeLessThanOrEqual(shown.to);
  }
  const lines = state.doc.lineAt(shown.to).number - shown.line + 1;
  const line = flowEntry("board")!.line;
  expect(line).toBeGreaterThanOrEqual(1);
  expect(line).toBeLessThanOrEqual(lines);
}

/** Types one character where the cursor is: only the shown frame's text changes. */
function expectTypingStaysInside(s: Setup) {
  const state = s.view().state;
  const shown = shownRange(state)!;
  const before = state.doc.toString();
  const head = state.selection.main.head;
  act(() => s.view().dispatch({ changes: { from: head, insert: "x" }, selection: EditorSelection.cursor(head + 1), userEvent: "input.type" }));
  const after = s.view().state.doc.toString();
  expect(after).not.toBe(before);
  expect(after.slice(0, shown.from)).toBe(before.slice(0, shown.from));
  expect(after.slice(shown.to + 2)).toBe(before.slice(shown.to + 1));
}

test("the_cursor_stays_in_the_shown_frame_after_a_switch_and_undo", async () => {
  const s = setup();
  await opened(s);
  const added = await addFromShelf(s);
  await settle();
  // The cursor in the new frame's text, on its second line.
  const head = s.view().state.doc.toString().indexOf(`"${added}"`);
  const second = s.view().state.doc.lineAt(head).to + 3;
  act(() => s.view().dispatch({ selection: EditorSelection.cursor(second), userEvent: "select.pointer" }));
  await settle();
  expectInside(s);
  await pick(s, "Billing");
  await settle();
  expectInside(s);
  // Ctrl+Z twice: the first takes the added frame back and restores the cursor to where it was before the add, in
  // Order API. Its change is at Billing's end, so Billing stays shown and the cursor comes back into it.
  for (let i = 0; i < 2; i++) {
    fireEvent.keyDown(s.canvasEl(), { key: "z", ctrlKey: true });
    await settle();
    expect(s.visible()).toContain('"Billing"');
    expectInside(s);
  }
  expect(s.view().state.doc.toString()).toBe(BOARD);
  expectTypingStaysInside(s);
});

test("a_frame_switch_puts_the_cursor_inside_the_new_frame", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout");
  // The cursor at the end of "Pay" in Checkout, then Billing selected on the canvas.
  const at = s.view().state.doc.toString().indexOf("Pay\n") + 3;
  act(() => s.view().dispatch({ selection: EditorSelection.cursor(at), userEvent: "select.pointer" }));
  await pick(s, "Billing");
  await settle();
  expectInside(s);
  const shown = shownRange(s.view().state)!;
  expect(s.view().state.doc.lineAt(s.view().state.selection.main.head).number).toBeGreaterThanOrEqual(shown.line);
  expectTypingStaysInside(s);
});

// ---- Plan F Task 11: the clamp

/** Every transaction the view applies from now on, as the editor's update listeners see them. */
function watchTransactions(s: Setup) {
  const seen: { scrollIntoView: boolean }[] = [];
  act(() =>
    s.view().dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((u) => {
          for (const tr of u.transactions) seen.push({ scrollIntoView: tr.scrollIntoView });
        }),
      ),
    }),
  );
  seen.length = 0;
  return seen;
}

test("a_clamped_selection_scrolls_into_view", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Billing");
  await settle();
  const shown = shownRange(s.view().state)!;
  const seen = watchTransactions(s);
  // A pointer or key move out of the shown block (here, to the document's start) stops at its edge, and the edge is
  // brought into view as a cursor that moved there is.
  act(() => s.view().dispatch({ selection: EditorSelection.cursor(0), userEvent: "select.pointer" }));
  expect(s.view().state.selection.main.head).toBe(shown.from);
  expect(seen.some((t) => t.scrollIntoView)).toBe(true);
});

test("a_multi_range_selection_is_clamped_range_by_range", () => {
  // The pane allows one range today; the clamp is range by range for any state that holds several (a Select all in a
  // later editor setup, Alt+Click cursors), so this runs on a bare state with the same extension.
  const parent = document.body.appendChild(document.createElement("div"));
  const text = "diagram flow \"A\"\nA\n\ndiagram flow \"B\"\nB\nC\n\ndiagram flow \"C\"\nZ\n";
  const view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: [EditorState.allowMultipleSelections.of(true), frameView(() => {})] }) });
  const from = text.indexOf('diagram flow "B"');
  const to = text.indexOf("\n\ndiagram flow \"C\"");
  view.dispatch({ effects: showFrame.of({ from, to, line: 4 }) });
  const inside = from + 3;
  view.dispatch({
    selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(inside), EditorSelection.range(inside + 2, text.length)], 1),
    userEvent: "select.pointer",
  });
  const ranges = view.state.selection.ranges.map((r) => [r.anchor, r.head]);
  expect(ranges).toEqual([
    [from, from],
    [inside, inside],
    [inside + 2, to],
  ]);
  view.destroy();
  parent.remove();
});

test("undo_in_the_shown_frame_keeps_the_selection_inside_it", async () => {
  const s = setup();
  await opened(s);
  await pick(s, "Checkout");
  await settle();
  const shown = shownRange(s.view().state)!;
  const head = s.view().state.doc.toString().indexOf("Pay\n") + 3;
  act(() => s.view().dispatch({ changes: { from: head, insert: "x" }, selection: EditorSelection.cursor(head + 1), userEvent: "input.type" }));
  // The cursor moved on to the frame's start, then Ctrl+Z.
  act(() => s.view().dispatch({ selection: EditorSelection.cursor(shown.from), userEvent: "select.pointer" }));
  fireEvent.keyDown(s.canvasEl(), { key: "z", ctrlKey: true });
  await settle();
  expect(s.view().state.doc.toString()).toBe(BOARD);
  expect(s.visible()).toContain('"Checkout"');
  expectInside(s);
  expectTypingStaysInside(s);
});
