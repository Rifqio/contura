// Diagram step 9 (board DiagramGroups, F9; rulings of 25 Oct): a group on the canvas. A click on its title selects it;
// a drag on the title moves it with everything in it (one undo step, no text), and a drop inside another group puts its
// block there; a double-click, F2 or Enter renames it on the title; Delete asks Ungroup or Delete with contents (Enter
// picks, Esc keeps everything); its own right-click menu; Ctrl+Shift+G and Ctrl+Shift+U ungroup it; arrows nudge it;
// the hover + never covers a group title. Exact text and one undo step for each.
import { redo, undo } from "@codemirror/commands";
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
import { parseFlow } from "../lang/flow/parse";
import FlowTab from "./FlowTab";

const parseFlowDoc = (t: string) => parseFlow(t).doc!;

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

const ORDERS = lines(
  'diagram flow "Order handling"',
  "Order in [start]",
  "Warehouse {",
  "  Check stock",
  "  In stock? [decision]",
  "  Dispatch {",
  "    Ship order",
  "  }",
  "}",
  "Back-order",
  "Packing {",
  "  Pack",
  "}",
  "",
  "Order in > Check stock",
  "Check stock > In stock?",
  "In stock? > Ship order: yes",
  "In stock? > Back-order: no",
);
const AT = JSON.stringify({
  version: 1,
  nodes: {
    "Order in": { x: 40, y: 40 },
    "Check stock": { x: 300, y: 200 },
    "In stock?": { x: 300, y: 340 },
    "Ship order": { x: 320, y: 520 },
    "Back-order": { x: 800, y: 340 },
    Pack: { x: 1200, y: 200 },
  },
});

function setup(initial = ORDERS, layout: string | null = AT) {
  routeInvoke({ read_diagram: () => ({ text: initial, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="d910" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const title = (g: string) => utils.container.querySelector<HTMLElement>(`.flow-area[aria-label="Group ${g}"] .flow-area-name`);
  const box = (n: string) => {
    const g = canvas.props!.nodes.find((x) => x.id === n)!;
    return { x: g.position.x, y: g.position.y, w: g.initialWidth ?? 0, h: g.initialHeight ?? 0 };
  };
  const area = (g: string) => box(`\u0000group:${g}`);
  /** A flow point on screen, through the viewport's transform (jsdom puts the pane at 0, 0). */
  const screenAt = (x: number, y: number) => {
    const t = (utils.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
    const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(t) ?? ["", "0", "0", "1"];
    return { clientX: Number(m[1]) + x * Number(m[3]), clientY: Number(m[2]) + y * Number(m[3]) };
  };
  const zoom = () => Number(/scale\(([-\d.]+)\)/.exec((utils.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform)?.[1] ?? 1);
  return { ...utils, view, doc, node, press, strip, title, box, area, screenAt, zoom, canvasEl };
}
type Setup = ReturnType<typeof setup>;
const shown = async (s: Setup) => {
  await waitFor(() => expect(s.node("Step Ship order")).not.toBeNull(), { timeout: 4000 });
  await waitFor(() => expect(s.title("Warehouse")).not.toBeNull());
};

/** A press on the group's title and a let go where it was: a click, in WebKitGTK's order. */
function clickTitle(s: Setup, g: string) {
  const a = s.area(g);
  const at = s.screenAt(a.x + 20, a.y + 14);
  fireEvent.pointerDown(s.title(g)!, { button: 0, buttons: 1, pointerId: 1, ...at });
  fireEvent.pointerUp(window, { button: 0, pointerId: 1, ...at });
}

/** Drags group `g` by its title by (dx, dy) in flow units, a few frames on the way (WebKitGTK's order). */
function dragTitle(s: Setup, g: string, dx: number, dy: number, release = true) {
  const a = s.area(g);
  const from = s.screenAt(a.x + 20, a.y + 14);
  const to = s.screenAt(a.x + 20 + dx, a.y + 14 + dy);
  fireEvent.pointerDown(s.title(g)!, { button: 0, buttons: 1, pointerId: 1, ...from });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: from.clientX + 6, clientY: from.clientY + 3 });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2 });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...to });
  if (release) fireEvent.pointerUp(window, { button: 0, pointerId: 1, ...to });
}

async function oneUndo(s: Setup, before: string) {
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(before));
}

// ----- select

test("a click on a group's title selects the group: the strip names it and counts its shapes", async () => {
  const s = setup();
  await shown(s);
  clickTitle(s, "Warehouse");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Warehouse"));
  expect(s.strip().textContent).toContain("3 shapes. Drag the title to move it with everything in it, double-click it to rename, Delete asks what to keep.");
  // The group is drawn selected; the shapes in it are not.
  expect(s.container.querySelector('.flow-area[aria-label="Group Warehouse"]')?.classList.contains("is-selected")).toBe(true);
  expect(canvas.props!.selection).toEqual([]);
  // A shape picked lets the group go; Esc does too.
  act(() => canvas.props!.onSelect!(["Back-order"]));
  await waitFor(() => expect(s.container.querySelector(".flow-area.is-selected")).toBeNull());
  clickTitle(s, "Packing");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Packing"));
  s.press("Escape");
  await waitFor(() => expect(s.container.querySelector(".flow-area.is-selected")).toBeNull());
});

// ----- move with contents

test("WebKitGTK order: a drag on the title moves the group with everything in it, as one undo step that writes no text", async () => {
  const s = setup();
  await shown(s);
  const before = { check: s.box("Check stock"), ship: s.box("Ship order"), back: s.box("Back-order") };
  dragTitle(s, "Warehouse", 100, 40, false);
  // While the pointer moves, the shapes and the inner group are drawn moved; nothing is written yet.
  await waitFor(() => expect(canvas.props!.livePositions?.["Check stock"]).toEqual({ x: before.check.x + 100, y: before.check.y + 40 }));
  expect(canvas.props!.livePositions?.["Ship order"]).toEqual({ x: before.ship.x + 100, y: before.ship.y + 40 });
  expect(canvas.props!.livePositions?.["\u0000group:Dispatch"]).toBeTruthy();
  expect(s.strip().textContent).toContain("Moving Warehouse with everything in it.");
  const to = s.screenAt(s.area("Warehouse").x + 120, s.area("Warehouse").y + 54);
  fireEvent.pointerUp(window, { button: 0, pointerId: 1, ...to });
  await waitFor(() => expect(s.box("Check stock")).toEqual({ ...before.check, x: before.check.x + 100, y: before.check.y + 40 }));
  expect(s.box("Ship order")).toEqual({ ...before.ship, x: before.ship.x + 100, y: before.ship.y + 40 });
  // What is outside stays, and the text is as it was.
  expect(s.box("Back-order")).toEqual(before.back);
  expect(s.doc()).toBe(ORDERS);
  expect(canvas.props!.livePositions ?? null).toBeNull();
  // One undo step puts every shape back.
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.box("Check stock")).toEqual(before.check));
  expect(s.box("Ship order")).toEqual(before.ship);
  act(() => void redo(s.view()));
  await waitFor(() => expect(s.box("Ship order").x).toBe(before.ship.x + 100));
});

test("a drag that ends inside another group puts the group's block in it: the move and the text are one undo step", async () => {
  const s = setup();
  await shown(s);
  const packing = s.area("Packing");
  const dispatch = s.area("Dispatch");
  // Dispatch's centre to Packing's centre.
  const dx = packing.x + packing.w / 2 - (dispatch.x + dispatch.w / 2);
  const dy = packing.y + packing.h / 2 - (dispatch.y + dispatch.h / 2);
  dragTitle(s, "Dispatch", dx, dy, false);
  await waitFor(() => expect(s.strip().textContent).toContain("Let go to put Dispatch in Packing."));
  const a = s.area("Dispatch");
  fireEvent.pointerUp(window, { button: 0, pointerId: 1, ...s.screenAt(a.x + 20 + dx, a.y + 14 + dy) });
  const moved = lines(
    'diagram flow "Order handling"',
    "Order in [start]",
    "Warehouse {",
    "  Check stock",
    "  In stock? [decision]",
    "}",
    "Back-order",
    "Packing {",
    "  Pack",
    "  Dispatch {",
    "    Ship order",
    "  }",
    "}",
    "",
    "Order in > Check stock",
    "Check stock > In stock?",
    "In stock? > Ship order: yes",
    "In stock? > Back-order: no",
  );
  await waitFor(() => expect(s.doc()).toBe(moved));
  const shipAt = s.box("Ship order");
  await oneUndo(s, ORDERS);
  await waitFor(() => expect(s.box("Ship order").x).not.toBe(shipAt.x));
});

test("Esc during the drag puts everything back and writes nothing", async () => {
  const s = setup();
  await shown(s);
  const before = s.box("Check stock");
  dragTitle(s, "Warehouse", 80, 0, false);
  await waitFor(() => expect(canvas.props!.livePositions?.["Check stock"]).toBeTruthy());
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(canvas.props!.livePositions ?? null).toBeNull());
  fireEvent.pointerUp(window, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  expect(s.box("Check stock")).toEqual(before);
  expect(s.doc()).toBe(ORDERS);
});

test("arrow keys nudge a selected group 1 px, Shift 16 px; the burst is one undo step", async () => {
  const s = setup();
  await shown(s);
  const before = s.box("Ship order");
  clickTitle(s, "Warehouse");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Warehouse"));
  s.press("ArrowRight");
  s.press("ArrowRight", { repeat: true });
  s.press("ArrowDown", { shiftKey: true, repeat: true });
  fireEvent.keyUp(s.canvasEl(), { key: "ArrowDown" });
  await waitFor(() => expect(s.box("Ship order")).toEqual({ ...before, x: before.x + 2, y: before.y + 16 }));
  expect(s.box("Back-order").x).toBe(800);
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.box("Ship order")).toEqual(before));
});

// ----- rename

test("a double-click on the title renames the group there; F2 and Enter on a selected group do too", async () => {
  const s = setup();
  await shown(s);
  fireEvent.doubleClick(s.title("Packing")!);
  const box = (await screen.findByRole("textbox", { name: "Group name" })) as HTMLInputElement;
  expect([box.value, box.selectionStart, box.selectionEnd]).toEqual(["Packing", 0, 7]);
  fireEvent.change(box, { target: { value: "Boxing" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(s.doc()).toBe(ORDERS.replace("Packing {", "Boxing {")));
  await oneUndo(s, ORDERS);
  await waitFor(() => expect(s.title("Packing")).not.toBeNull());
  clickTitle(s, "Packing");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Packing"));
  s.press("F2");
  const again = (await screen.findByRole("textbox", { name: "Group name" })) as HTMLInputElement;
  // Esc keeps the typed text (ruling of 25 Oct).
  fireEvent.change(again, { target: { value: "Crates" } });
  fireEvent.keyDown(again, { key: "Escape" });
  await waitFor(() => expect(s.doc()).toBe(ORDERS.replace("Packing {", "Crates {")));
});

// ----- Delete asks

test("Delete on a group asks: Ungroup keeps the shapes, Enter picks it, one undo step", async () => {
  const s = setup();
  await shown(s);
  clickTitle(s, "Warehouse");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Warehouse"));
  s.press("Delete");
  const ask = await screen.findByRole("dialog", { name: "Delete group Warehouse?" });
  const rows = within(ask).getAllByRole("button").map((b) => b.textContent);
  expect(rows).toEqual([
    "UngroupKeep the 3 shapes and 1 group inside where they areCtrl+Shift+G",
    "Delete with contentsRemove 3 shapes and 4 lines",
    "CancelKeep everythingEsc",
  ]);
  const ungroup = within(ask).getByRole("button", { name: /^Ungroup/ });
  await waitFor(() => expect(document.activeElement).toBe(ungroup));
  fireEvent.keyDown(ungroup, { key: "Enter" });
  const out = lines(
    'diagram flow "Order handling"',
    "Order in [start]",
    "Check stock",
    "In stock? [decision]",
    "Dispatch {",
    "  Ship order",
    "}",
    "Back-order",
    "Packing {",
    "  Pack",
    "}",
    "",
    "Order in > Check stock",
    "Check stock > In stock?",
    "In stock? > Ship order: yes",
    "In stock? > Back-order: no",
  );
  await waitFor(() => expect(s.doc()).toBe(out));
  expect(screen.queryByRole("dialog", { name: "Delete group Warehouse?" })).toBeNull();
  await oneUndo(s, ORDERS);
});

test("Delete with contents removes the block and every line to it, one undo step; arrows move in the question", async () => {
  const s = setup();
  await shown(s);
  clickTitle(s, "Warehouse");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Warehouse"));
  s.press("Backspace");
  const ask = await screen.findByRole("dialog", { name: "Delete group Warehouse?" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  const del = within(ask).getByRole("button", { name: /^Delete with contents/ });
  await waitFor(() => expect(document.activeElement).toBe(del));
  fireEvent.keyDown(del, { key: "Enter" });
  await waitFor(() => expect(s.doc()).toBe(lines('diagram flow "Order handling"', "Order in [start]", "Back-order", "Packing {", "  Pack", "}", "")));
  expect(s.strip().textContent).toContain("Deleted Warehouse with 3 shapes, 1 group inside and 4 lines. Ctrl+Z brings it all back in one step.");
  await oneUndo(s, ORDERS);
});

test("Esc in the question keeps everything, as does Cancel", async () => {
  const s = setup();
  await shown(s);
  clickTitle(s, "Packing");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Packing"));
  s.press("Delete");
  const ask = await screen.findByRole("dialog", { name: "Delete group Packing?" });
  expect(within(ask).getByRole("button", { name: /^Ungroup/ }).textContent).toContain("Keep the 1 shape where they are");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(s.doc()).toBe(ORDERS);
  expect(s.strip().textContent).toContain("Kept Packing as it was.");
  s.press("Delete");
  await userEvent.click(within(await screen.findByRole("dialog", { name: "Delete group Packing?" })).getByRole("button", { name: /^Cancel/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(s.doc()).toBe(ORDERS);
});

// ----- the group's own menu and keys

test("a right-click on the title opens the group's own menu: Rename, Select its shapes, Ungroup, Delete with contents", async () => {
  const s = setup();
  await shown(s);
  fireEvent.contextMenu(s.title("Warehouse")!, { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Group Warehouse" });
  const rows = [...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")].map((m) => `${m.getAttribute("aria-label")}|${m.querySelector(".menu-shortcut, .menu-hint")?.textContent ?? ""}`);
  // Step 11: Colour sets its border and title.
  expect(rows).toEqual(["Rename|F2", "Colour|none", "Select its shapes|", "Ungroup|Ctrl+Shift+G", "Delete with contents|3 shapes"]);
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Select its shapes" }));
  await waitFor(() => expect([...canvas.props!.selection!].sort()).toEqual(["Check stock", "In stock?", "Ship order"]));
  fireEvent.contextMenu(s.title("Dispatch")!, { clientX: 300, clientY: 400 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Group Dispatch" })).getByRole("menuitem", { name: "Ungroup" }));
  await waitFor(() => expect(s.doc()).toBe(ORDERS.replace("  Dispatch {\n    Ship order\n  }\n", "  Ship order\n")));
  await oneUndo(s, ORDERS);
  fireEvent.contextMenu(s.title("Packing")!, { clientX: 900, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Group Packing" })).getByRole("menuitem", { name: "Delete with contents" }));
  await waitFor(() => expect(s.doc()).toBe(ORDERS.replace("Packing {\n  Pack\n}\n", "")));
  fireEvent.contextMenu(s.title("Warehouse")!, { clientX: 300, clientY: 200 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "Group Warehouse" })).getByRole("menuitem", { name: "Rename" }));
  expect(((await screen.findByRole("textbox", { name: "Group name" })) as HTMLInputElement).value).toBe("Warehouse");
});

test("Ctrl+Shift+G and Ctrl+Shift+U ungroup the selected group itself, at once", async () => {
  const s = setup();
  await shown(s);
  clickTitle(s, "Dispatch");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Dispatch"));
  s.press("G", { ctrlKey: true, shiftKey: true });
  const out = ORDERS.replace("  Dispatch {\n    Ship order\n  }\n", "  Ship order\n");
  await waitFor(() => expect(s.doc()).toBe(out));
  await oneUndo(s, ORDERS);
  clickTitle(s, "Warehouse");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Warehouse"));
  s.press("U", { ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(s.doc()).toContain("Order in [start]\nCheck stock\nIn stock? [decision]\nDispatch {\n  Ship order\n}\n"));
});

// ----- the hover + and the title

test("the hover + never covers a group title", async () => {
  // Pack sits right under its group's title, so its top + would land on the title.
  const s = setup();
  await shown(s);
  const t = s.area("Packing");
  const band = { x: t.x, y: t.y, w: 12 + 22 + Math.ceil("Packing".length * 7.2) + 12, h: 30 };
  fireEvent.pointerMove(s.node("Step Pack")!, { clientX: 10, clientY: 10 });
  await waitFor(() => expect(screen.getAllByRole("button", { name: /^Add the next step/ }).length).toBeGreaterThan(0));
  const plusses = screen.getAllByRole("button", { name: /^Add the next step/ });
  for (const p of plusses) {
    const wrap = p as HTMLElement;
    const x = parseFloat(wrap.style.left);
    const y = parseFloat(wrap.style.top);
    const overlaps = x + 12 > band.x && x - 12 < band.x + band.w && y + 12 > band.y && y - 12 < band.y + band.h;
    expect(overlaps, wrap.getAttribute("aria-label") ?? "").toBe(false);
  }
  // The + above is left out; the other three sides keep theirs.
  expect(plusses.map((p) => p.getAttribute("aria-label"))).not.toContain("Add the next step above");
  expect(plusses).toHaveLength(3);
});

test("Ctrl+G on a selected group puts it in a new group, its name in edit; Enter writes both as one undo step", async () => {
  const s = setup();
  await shown(s);
  clickTitle(s, "Packing");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Packing"));
  s.press("g", { ctrlKey: true });
  const box = (await screen.findByRole("textbox", { name: "Group name" })) as HTMLInputElement;
  expect(box.value).toBe("Group");
  fireEvent.change(box, { target: { value: "Shipping" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(s.doc()).toBe(ORDERS.replace("Packing {\n  Pack\n}\n", "Shipping {\n  Packing {\n    Pack\n  }\n}\n")));
  await oneUndo(s, ORDERS);
});

// ----- fix round 1, I5: an empty group is drawn where it was, and works as any group

const EMPTY = lines('diagram flow "Boxes"', "A", "Spare {", "}", "Tray {", "  B", "}");
const EMPTY_AT = JSON.stringify({ version: 1, nodes: { A: { x: 0, y: 0 }, B: { x: 400, y: 0 }, Spare: { x: 0, y: 300 } } });

test("I5 an empty group is drawn at its kept place, at the board's size, and its title selects, renames and asks", async () => {
  const s = setup(EMPTY, EMPTY_AT);
  await waitFor(() => expect(s.title("Spare")).not.toBeNull(), { timeout: 4000 });
  expect(s.area("Spare")).toEqual({ x: 0, y: 300, w: 240, h: 120 });
  clickTitle(s, "Spare");
  await waitFor(() => expect(s.strip().textContent).toContain("Group Spare"));
  expect(s.strip().textContent).toContain("0 shapes.");
  s.press("Delete");
  const ask = await screen.findByRole("dialog", { name: "Delete group Spare?" });
  fireEvent.keyDown(within(ask).getByRole("button", { name: /^Ungroup/ }), { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  await waitFor(() => expect(s.doc()).toBe(EMPTY.replace("Spare {\n}\n", "")));
});

test("I5 a group whose last shape is dragged out stays drawn where it was, and a shape dropped on it joins it", async () => {
  const s = setup(EMPTY, EMPTY_AT);
  await waitFor(() => expect(s.title("Tray")).not.toBeNull(), { timeout: 4000 });
  const tray = s.area("Tray");
  // B out of Tray, onto empty canvas far below.
  act(() => {
    canvas.props!.onDrag!("B", 400, 900);
    canvas.props!.onMove!("B", 400, 900);
  });
  await waitFor(() => expect(s.doc()).toBe(lines('diagram flow "Boxes"', "A", "B", "Spare {", "}", "Tray {", "}")));
  await waitFor(() => expect(s.title("Tray")).not.toBeNull());
  expect({ x: s.area("Tray").x, y: s.area("Tray").y }).toEqual({ x: tray.x, y: tray.y });
  // A dropped into the empty Spare joins it.
  const spare = s.area("Spare");
  act(() => {
    canvas.props!.onDrag!("A", spare.x + 60, spare.y + 50);
    canvas.props!.onMove!("A", spare.x + 60, spare.y + 50);
  });
  await waitFor(() => expect(s.doc()).toBe(lines('diagram flow "Boxes"', "B", "Spare {", "  A", "}", "Tray {", "}")));
});

test("I5 an empty group's title drag moves it, one undo step", async () => {
  const s = setup(EMPTY, EMPTY_AT);
  await waitFor(() => expect(s.title("Spare")).not.toBeNull(), { timeout: 4000 });
  dragTitle(s, "Spare", 100, 20);
  await waitFor(() => expect({ x: s.area("Spare").x, y: s.area("Spare").y }).toEqual({ x: 100, y: 320 }));
  act(() => void undo(s.view()));
  await waitFor(() => expect({ x: s.area("Spare").x, y: s.area("Spare").y }).toEqual({ x: 0, y: 300 }));
});

// ----- fix round 1: M7, M9, M10, M13

test("M7 a press soon after a finished drag starts another drag, not a rename", async () => {
  const s = setup();
  await shown(s);
  dragTitle(s, "Packing", 60, 0);
  await waitFor(() => expect(s.strip().textContent).toContain("Moved Packing"));
  clickTitle(s, "Packing");
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByRole("textbox", { name: "Group name" })).toBeNull();
});

test("M9 the selected ring does not move the area: it is drawn outside the border, not by a wider border", () => {
  const at = tabCss.indexOf(".flow-area.is-selected {");
  const rule = tabCss.slice(at, tabCss.indexOf("}", at));
  expect(rule).not.toMatch(/border(-width)?:/);
  expect(rule).toMatch(/outline|box-shadow/);
});

test("M10 the + keeps clear of a title as wide as it is drawn, not as its letters are guessed", async () => {
  // A to the left widens the area, so B's top + is past the guessed band but inside the drawn title.
  const WIDE = lines('diagram flow "x"', "WWWWWWWWWW {", "  A", "  B", "}");
  const s = setup(WIDE, JSON.stringify({ version: 1, nodes: { A: { x: 0, y: 200 }, B: { x: 150, y: 200 } } }));
  await waitFor(() => expect(s.title("WWWWWWWWWW")).not.toBeNull(), { timeout: 4000 });
  // Drawn, the bold Ws are 260 px wide: wider than the 7.2 px a letter the band guessed.
  const title = s.title("WWWWWWWWWW")!;
  title.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 260 * s.zoom(), bottom: 16, width: 260 * s.zoom(), height: 16, toJSON() {} }) as DOMRect;
  fireEvent.pointerMove(s.node("Step B")!, { clientX: 10, clientY: 10 });
  await waitFor(() => expect(screen.getAllByRole("button", { name: /^Add the next step/ }).length).toBeGreaterThan(0));
  expect(screen.getAllByRole("button", { name: /^Add the next step/ }).map((p) => p.getAttribute("aria-label"))).not.toContain("Add the next step above");
});

test("M13 a press on the canvas beside a title selects nothing and moves nothing, so a box select can start there", async () => {
  const s = setup();
  await shown(s);
  const a = s.area("Warehouse");
  const pane = s.container.querySelector(".react-flow__pane") as HTMLElement;
  fireEvent.pointerDown(pane, { button: 0, buttons: 1, pointerId: 1, ...s.screenAt(a.x + a.w - 10, a.y + 14) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(a.x + a.w + 60, a.y + 60) });
  fireEvent.pointerUp(window, { button: 0, pointerId: 1, ...s.screenAt(a.x + a.w + 60, a.y + 60) });
  expect(s.container.querySelector(".flow-area.is-selected")).toBeNull();
  expect(canvas.props!.livePositions ?? null).toBeNull();
  expect(s.doc()).toBe(ORDERS);
});

test("M13 an inner group dragged out of its group goes to the top, its block with it, one undo step", async () => {
  const s = setup();
  await shown(s);
  const outer = s.area("Warehouse");
  const d = s.area("Dispatch");
  // Its centre well below Warehouse, on empty canvas.
  const dy = outer.y + outer.h + 300 - (d.y + d.h / 2);
  dragTitle(s, "Dispatch", 0, dy, false);
  await waitFor(() => expect(s.strip().textContent).toContain("Let go to take Dispatch out of Warehouse."));
  fireEvent.pointerUp(window, { button: 0, pointerId: 1, ...s.screenAt(d.x + 20, d.y + 14 + dy) });
  await waitFor(() =>
    expect(s.doc()).toBe(ORDERS.replace("  Dispatch {\n    Ship order\n  }\n", "").replace("Packing {\n  Pack\n}\n", "Packing {\n  Pack\n}\nDispatch {\n  Ship order\n}\n")),
  );
  await oneUndo(s, ORDERS);
});

// ----- fix round 2

test("N2 Ctrl+G over a whole group and one shape outside leaves no empty group behind, one undo step", async () => {
  const P = lines('diagram flow "P"', "X", "P {", "  A", "  B", "}");
  const s = setup(P, JSON.stringify({ version: 1, nodes: { X: { x: 0, y: 0 }, A: { x: 300, y: 0 }, B: { x: 300, y: 150 } } }));
  await waitFor(() => expect(s.node("Step A")).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onSelect!(["A", "B", "X"]));
  s.press("g", { ctrlKey: true });
  const box = (await screen.findByRole("textbox", { name: "Group name" })) as HTMLInputElement;
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(s.doc()).toContain("Group {"));
  expect(s.doc()).not.toContain("P {");
  expect(parseFlowDoc(s.doc()).groups.map((g) => [g.name, [...g.nodes].sort()])).toEqual([["Group", ["A", "B", "X"]]]);
  await oneUndo(s, P);
});

test("N3 a composite's own start and end are not counted as its shapes", async () => {
  const S = lines('diagram state "S"', "Active {", "  Off", "  On", "  [*] > Off", "  On > [*]", "}");
  const s = setup(S, null);
  await waitFor(() => expect(s.title("Active")).not.toBeNull(), { timeout: 4000 });
  clickTitle(s, "Active");
  await waitFor(() => expect(s.strip().textContent).toContain("Composite Active"));
  expect(s.strip().textContent).toContain("2 shapes.");
  s.press("Delete");
  const ask = await screen.findByRole("dialog", { name: "Delete composite Active?" });
  expect(within(ask).getByRole("button", { name: /^Ungroup/ }).textContent).toContain("Keep the 2 shapes where they are");
  expect(within(ask).getByRole("button", { name: /^Delete with contents/ }).textContent).toContain("Remove 2 shapes and 2 lines");
});

test("N2 Ctrl+G inside a group keeps that group: the new group goes in it", async () => {
  const Q = lines('diagram flow "Q"', "Q {", "  A", "}");
  const s = setup(Q, JSON.stringify({ version: 1, nodes: { A: { x: 300, y: 0 } } }));
  await waitFor(() => expect(s.node("Step A")).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onSelect!(["A"]));
  s.press("g", { ctrlKey: true });
  fireEvent.keyDown(await screen.findByRole("textbox", { name: "Group name" }), { key: "Enter" });
  await waitFor(() => expect(s.doc()).toBe(lines('diagram flow "Q"', "Q {", "  Group {", "    A", "  }", "}")));
});

test("N7 deleting a group's last shape keeps the group drawn where it was, as dragging it out does; one undo step", async () => {
  const G = lines('diagram flow "G"', "B", "G {", "  A", "}");
  const s = setup(G, JSON.stringify({ version: 1, nodes: { B: { x: 0, y: 0 }, A: { x: 300, y: 200 } } }));
  await waitFor(() => expect(s.title("G")).not.toBeNull(), { timeout: 4000 });
  const before = s.area("G");
  act(() => canvas.props!.onSelect!(["A"]));
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(lines('diagram flow "G"', "B", "G {", "}")));
  await waitFor(() => expect(s.title("G")).not.toBeNull());
  expect({ x: s.area("G").x, y: s.area("G").y }).toEqual({ x: before.x, y: before.y });
  await oneUndo(s, G);
});

test("N8 ungrouping a composite says its own start and end become the diagram's", async () => {
  const S = lines('diagram state "S"', "Active {", "  Off", "  [*] > Off", "}");
  const s = setup(S, null);
  await waitFor(() => expect(s.title("Active")).not.toBeNull(), { timeout: 4000 });
  clickTitle(s, "Active");
  await waitFor(() => expect(s.strip().textContent).toContain("Composite Active"));
  s.press("G", { ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(s.doc()).toBe(lines('diagram state "S"', "Off", "[*] > Off")));
  expect(s.strip().textContent).toContain("Ungrouped Active: its own start and end are now the diagram's start and end.");
});
