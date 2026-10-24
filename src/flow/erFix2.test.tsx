// ER build C, fix round 2 (er-build-c-review.md and the coordinator's rulings): the board's delete notice, the
// Assistant's lock on a double-click, scroll kept through a rename, ports for one selected table only, ports and
// lines that follow scrolled rows, the drag line at the pointer, tooltips through the app's guard, and a
// relationship made from a column's menu with the keyboard alone.
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
import { installTooltipGuard } from "../components/tooltipGuard";

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

/** The Assistant's lock, held for a test (driving a real Ask is not needed to see the canvas refuse). */
const lock = vi.hoisted(() => ({ on: false }));
vi.mock("./ai/useDiagramAsk", async (load) => {
  const real = await load<typeof import("./ai/useDiagramAsk")>();
  return {
    ...real,
    useDiagramAsk: (...a: Parameters<typeof real.useDiagramAsk>) => {
      const r = real.useDiagramAsk(...a);
      return lock.on ? { ...r, locked: true } : r;
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

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  lock.on = false;
  measures.calls = [];
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
const LAYOUT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 1000, y: 30 } } });

function setup(text = ER, layout: string | null = LAYOUT) {
  routeInvoke({ read_diagram: () => ({ text, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="fix2" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const card = (table: string) => utils.container.querySelector(`.react-flow__node [aria-label="Entity ${table}"]`) as HTMLElement | null;
  const node = (table: string) => utils.container.querySelector(`.react-flow__node[data-id="${table}"]`) as HTMLElement;
  const edge = (i: number) => utils.container.querySelector(`.react-flow__edge[data-id="edge:${i}"]`) as HTMLElement | null;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const notice = () => strip().querySelector(".flow-notice")?.textContent ?? "";
  const aimText = () => strip().querySelector(".flow-aim")?.textContent ?? "";
  const row = (table: string, column: string) =>
    [...card(table)!.querySelectorAll<HTMLElement>(".fkind-er-row")].find((r) => r.querySelector(".fkind-col")?.textContent === column)!;
  return { ...utils, view, doc, card, node, edge, strip, canvasEl, notice, aimText, row };
}
type Setup = ReturnType<typeof setup>;

async function drawn(s: Setup, table = "invoices") {
  await waitFor(() => expect(s.card(table)).not.toBeNull(), { timeout: 4000 });
}

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

test("M4 a double-click on the empty canvas while the Assistant holds the text says why nothing was added", async () => {
  lock.on = true;
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 500, y: 500 }, flow: { x: 200, y: 200 } }));
  await waitFor(() => expect(s.notice()).toBe("Not changed: the Assistant is editing this diagram. Your edit can wait until it finishes."));
  expect(s.container.querySelector(".fkind-new-table")).toBeNull();
});

test("M8 a renamed table keeps its scrolled rows, and the lines to them stay put", async () => {
  const s = setup(LINKED);
  await waitFor(() => expect(s.edge(0)).not.toBeNull(), { timeout: 4000 });
  const body = () => s.card("invoices")!.querySelector<HTMLElement>(".fkind-er-body")!;
  body().scrollTop = 10;
  fireEvent.scroll(body());
  const start = () => s.edge(0)!.querySelector("path")!.getAttribute("d")!.split(" L")[0];
  await waitFor(() => expect(start()).toBe(`M 1000 ${30 + 59}`));
  fireEvent.doubleClick(s.card("invoices")!.querySelector(".fkind-head")!);
  const box = (await screen.findByLabelText("Table name", { selector: "input" })) as HTMLInputElement;
  await userEvent.clear(box);
  await userEvent.type(box, "bills{Enter}");
  await waitFor(() => expect(s.card("bills")).not.toBeNull());
  await waitFor(() => expect(s.card("bills")!.querySelector<HTMLElement>(".fkind-er-body")!.scrollTop).toBe(10));
  await waitFor(() => expect(start()).toBe(`M 1000 ${30 + 59}`));
});

test("I5 select all shows no column ports and measures no card; one selected table shows its ports", async () => {
  const many = lines('diagram er "Many"', ...Array.from({ length: 6 }, (_, i) => [`t${i}`, `t${i}.id int [pk]`, `t${i}.note text`]).flat());
  const at = JSON.stringify({ version: 1, nodes: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`t${i}`, { x: (i % 3) * 220, y: Math.floor(i / 3) * 120 }])) });
  const s = setup(many, at);
  await drawn(s, "t0");
  const names = Array.from({ length: 6 }, (_, i) => `t${i}`);
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
  body.scrollTop = 22;
  fireEvent.scroll(body);
  await waitFor(() => expect(measures.calls).toContain("invoices"));
  // React Flow snapped to customers.id's port from bounds of before; the pointer is over customers' email row.
  const c = canvas.props!.nodes.find((n) => n.id === "customers")!.position;
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:note" }, { node: "customers", port: "col:id" }, false, { x: c.x + 90, y: c.y + 47 + 22 }));
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.note *--1 customers.email\n`));
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
      const p = id.querySelector<HTMLElement>(".fkind-port");
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

/** Presses a key on whatever has focus, as the keyboard does. */
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...init });

/** Moves the open menu's focus down to `label` with the arrow keys and picks it with Enter. */
async function menuPick(menu: HTMLElement, label: string) {
  const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  const at = items.findIndex((i) => i.getAttribute("aria-label") === label || i.textContent?.startsWith(label));
  expect(at).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < 40 && document.activeElement !== items[at]; i++) key("ArrowDown");
  expect(document.activeElement).toBe(items[at]);
  // Enter on a focused menu item clicks it, as the browser does.
  await userEvent.keyboard("{Enter}");
}

test("I1 Make a relationship from here, with the keyboard alone: Tab to a column, its menu, arrows to the target, Enter", async () => {
  const s = setup();
  await drawn(s);
  // Focus the invoices card and select it with Enter, as React Flow's keyboard does; Tab then steps through its columns.
  act(() => s.node("invoices").focus());
  key("Enter");
  await waitFor(() => expect(s.node("invoices").className).toContain("selected"));
  key("Tab");
  key("Tab");
  await waitFor(() => expect(s.row("invoices", "customer_id").className).toContain("is-selected"));
  key("F10", { shiftKey: true });
  await menuPick(await screen.findByRole("menu", { name: "invoices.customer_id actions" }), "Make a relationship from here");
  await waitFor(() => expect(s.notice()).toBe("Pick the column it refers to: click, or arrows and Enter."));
  // Focus is on the canvas once the menu closes; nothing is aimed until a key is pressed (fix round 3).
  await waitFor(() => expect(document.activeElement).toBe(s.canvasEl()));
  expect(s.container.querySelector(".is-pick")).toBeNull();
  expect(s.aimText()).toBe("Esc cancels.");
  // The other tables come first: one key aims customers' header (its key), the next its id column.
  key("ArrowDown");
  await waitFor(() => expect(s.card("customers")!.querySelector(".fkind-head")!.className).toContain("is-pick"));
  expect(s.aimText()).toBe("Aim: key of customers");
  key("Tab");
  await waitFor(() => expect(s.row("customers", "id").className).toContain("is-pick"));
  expect(s.aimText()).toBe("Aim: customers.id");
  expect(s.row("customers", "id").getAttribute("aria-current")).toBe("true");
  key("Enter");
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.customer_id *--1 customers.id\n`));
  expect(s.notice()).toBe("Linked invoices.customer_id *--1 customers.id. Right-click the line to change it.");
  expect(s.container.querySelector(".is-pick")).toBeNull();
});

test("I1 the pick takes a header for its table's key, and Esc leaves it as Add relationship to... is left", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.row("invoices", "customer_id"), { clientX: 1100, clientY: 100 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices.customer_id actions" })).getByRole("menuitem", { name: "Make a relationship from here" }));
  await waitFor(() => expect(s.notice()).toBe("Pick the column it refers to: click, or arrows and Enter."));
  key("Escape");
  await waitFor(() => expect(s.notice()).toBe(""));
  expect(s.container.querySelector(".is-pick")).toBeNull();
  fireEvent.pointerDown(s.card("customers")!.querySelector(".fkind-head")!);
  await new Promise((r) => setTimeout(r, 50));
  expect(s.doc()).toBe(ER);
  // Again; this time a press on customers' header joins its key.
  fireEvent.contextMenu(s.row("invoices", "customer_id"), { clientX: 1100, clientY: 100 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices.customer_id actions" })).getByRole("menuitem", { name: "Make a relationship from here" }));
  fireEvent.pointerDown(s.card("customers")!.querySelector(".fkind-head")!);
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.customer_id *--1 customers.id\n`));
});

test("fix 3: a pick chosen by the pointer keeps the keyboard on the canvas: one key shows the aim ring, Enter links, keys pressed elsewhere still count", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.row("invoices", "customer_id"), { clientX: 1100, clientY: 100 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices.customer_id actions" })).getByRole("menuitem", { name: "Make a relationship from here" }));
  await waitFor(() => expect(s.notice()).toBe("Pick the column it refers to: click, or arrows and Enter."));
  await waitFor(() => expect(document.activeElement).toBe(s.canvasEl()));
  // A key that reaches the page while focus sits elsewhere (the WebView may leave it on the page) still moves the aim.
  act(() => (document.activeElement as HTMLElement | null)?.blur());
  fireEvent.keyDown(document.body, { key: "ArrowLeft" });
  await waitFor(() => expect(s.container.querySelectorAll(".is-pick")).toHaveLength(1));
  expect(document.activeElement).toBe(s.canvasEl());
  key("ArrowRight");
  key("ArrowRight");
  await waitFor(() => expect(s.row("customers", "id").className).toContain("is-pick"));
  key("Enter");
  await waitFor(() => expect(s.doc()).toBe(`${ER}\ninvoices.customer_id *--1 customers.id\n`));
});

test("fix 3: undoing a link takes its notice from the strip", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:customer_id" }, { node: "customers", port: "col:id" }, false));
  await waitFor(() => expect(s.notice()).toBe("Linked invoices.customer_id *--1 customers.id. Right-click the line to change it."));
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(ER));
  await waitFor(() => expect(s.notice()).toBe(""));
});

/** Starts "Make a relationship from here" on invoices.customer_id from its menu. */
async function startPick(s: Setup) {
  fireEvent.contextMenu(s.row("invoices", "customer_id"), { clientX: 1100, clientY: 100 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices.customer_id actions" })).getByRole("menuitem", { name: "Make a relationship from here" }));
  await waitFor(() => expect(s.notice()).toBe("Pick the column it refers to: click, or arrows and Enter."));
}

test("fix 4, N1: keys on a dialog, a tree or a select pass to them untouched; focus moving there ends the pick with no write", async () => {
  const s = setup();
  await drawn(s);
  const outside = document.createElement("div");
  outside.innerHTML = '<div role="dialog"><button type="button">Save</button></div><div role="tree"><div role="treeitem" tabindex="0">a</div></div><select><option>x</option><option>y</option></select>';
  document.body.append(outside);
  try {
    await startPick(s);
    const save = outside.querySelector("button")!;
    const item = outside.querySelector<HTMLElement>('[role="treeitem"]')!;
    const select = outside.querySelector("select")!;
    // Keys from them reach them: none is taken (fireEvent says false when a handler prevented the default).
    for (const [el, k] of [[save, "Enter"], [save, "Tab"], [save, "Escape"], [item, "ArrowDown"], [item, "Enter"], [select, "ArrowDown"]] as const) {
      expect(fireEvent.keyDown(el, { key: k })).toBe(true);
    }
    expect(s.container.querySelector(".is-pick")).toBeNull();
    expect(s.doc()).toBe(ER);
    // Focus going to the dialog ends the pick, as a menu does.
    act(() => save.focus());
    await waitFor(() => expect(s.notice()).toBe(""));
    expect(fireEvent.keyDown(save, { key: "Enter" })).toBe(true);
    expect(s.doc()).toBe(ER);
    // The same for the tree and the select.
    for (const el of [item, select]) {
      act(() => s.canvasEl().focus());
      await startPick(s);
      act(() => el.focus());
      await waitFor(() => expect(s.notice()).toBe(""));
    }
    expect(s.doc()).toBe(ER);
  } finally {
    outside.remove();
  }
});

test("fix 4, N1: Publish ends the pick", async () => {
  const s = setup();
  await drawn(s);
  await startPick(s);
  key("ArrowDown");
  await waitFor(() => expect(s.container.querySelector(".is-pick")).not.toBeNull());
  await userEvent.click(within(s.strip()).getByRole("button", { name: /Publish/ }));
  await waitFor(() => expect(s.container.querySelector(".is-pick")).toBeNull());
  expect(s.notice()).not.toBe("Pick the column it refers to: click, or arrows and Enter.");
  expect(s.doc()).toBe(ER);
});

test("fix 4, N6: Enter with nothing aimed says to aim first, and the pick stays", async () => {
  const s = setup();
  await drawn(s);
  await startPick(s);
  key("Enter");
  await waitFor(() => expect(s.aimText()).toBe("Aim first with the arrow keys."));
  expect(s.notice()).toBe("Pick the column it refers to: click, or arrows and Enter.");
  expect(s.doc()).toBe(ER);
});

test("fix 4, N2: a refusal stays when the text changes; only a notice about an undone action goes", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:note" }, { node: "invoices", port: "col:note" }, false));
  await waitFor(() => expect(s.notice()).toBe("A column cannot refer to itself. Drop on another column."));
  act(() => void s.view().dispatch({ changes: { from: s.doc().length, insert: "// x\n" }, userEvent: "input.type" }));
  await waitFor(() => expect(s.doc()).toContain("// x"));
  await new Promise((r) => setTimeout(r, 100));
  expect(s.notice()).toBe("A column cannot refer to itself. Drop on another column.");
});
