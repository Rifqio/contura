// ER build C, fix round 2 (er-build-c-review.md and the coordinator's rulings): the Assistant's lock on a
// double-click, and a relationship made from a column's menu with the keyboard alone.
//
// B3 Task 9: restored on a board in block form with the board's arrows (`>` many to one), every card queried as
// `Table <t>` (R17). The pick lives in `useErRelate` (`startPick`, `pick`, the window listener while it is on). The
// rest of the old file came back earlier: M3, I5, I6 and live bug (b) in erRelationships.test.tsx (Task 7), M8 in
// erScroll.test.tsx (Task 5).
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
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { ER_MESSAGES } from "./erCanvas";
import { RELATE_MESSAGES } from "./erRelate";
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

/** The Assistant's lock, held for a test (driving a real Ask is not needed to see the canvas refuse). */
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
const ER = lines(
  'diagram er "Billing"',
  "customers {",
  "  id int pk",
  "  email text not null",
  "}",
  "invoices {",
  "  id int pk",
  "  customer_id int",
  "  note text",
  "}",
);
const LINKED = `${ER}\ninvoices.customer_id > customers.id\n`;
const LAYOUT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 1000, y: 30 } } });
const MADE = "Linked invoices.customer_id > customers.id. Right-click the line to change it.";

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
  const card = (table: string) => utils.container.querySelector(`.react-flow__node [aria-label="Table ${table}"]`) as HTMLElement | null;
  const node = (table: string) => utils.container.querySelector(`.react-flow__node[data-id="${table}"]`) as HTMLElement;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const notice = () => strip().querySelector(".flow-notice")?.textContent ?? "";
  const aimText = () => strip().querySelector(".flow-aim")?.textContent ?? "";
  const row = (table: string, column: string) =>
    [...card(table)!.querySelectorAll<HTMLElement>(".fkind-er-row")].find((r) => r.querySelector(".fkind-col")?.textContent === column)!;
  return { ...utils, view, doc, card, node, strip, canvasEl, notice, aimText, row };
}
type Setup = ReturnType<typeof setup>;

async function drawn(s: Setup, table = "invoices") {
  await waitFor(() => expect(s.card(table)).not.toBeNull(), { timeout: 4000 });
}

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

test("M4 a double-click on the empty canvas while the Assistant holds the text says why nothing was added", async () => {
  lock.on = true;
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 500, y: 500 }, flow: { x: 200, y: 200 } }));
  // A12: B3's own add refuses as `add` does, with the lock's words for an add.
  await waitFor(() => expect(s.notice()).toBe(ER_MESSAGES.lockedAdd));
  expect(s.container.querySelector(".fkind-new-table")).toBeNull();
});

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
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.pick));
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
  await waitFor(() => expect(s.doc()).toBe(LINKED));
  expect(s.notice()).toBe(MADE);
  expect(s.container.querySelector(".is-pick")).toBeNull();
});

test("I1 the pick takes a header for its table's key, and Esc leaves it as Add relationship to... is left", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.row("invoices", "customer_id"), { clientX: 1100, clientY: 100 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices.customer_id actions" })).getByRole("menuitem", { name: "Make a relationship from here" }));
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.pick));
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
  await waitFor(() => expect(s.doc()).toBe(LINKED));
});

test("fix 3: a pick chosen by the pointer keeps the keyboard on the canvas: one key shows the aim ring, Enter links, keys pressed elsewhere still count", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.contextMenu(s.row("invoices", "customer_id"), { clientX: 1100, clientY: 100 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices.customer_id actions" })).getByRole("menuitem", { name: "Make a relationship from here" }));
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.pick));
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
  await waitFor(() => expect(s.doc()).toBe(LINKED));
});

test("fix 3: undoing a link takes its notice from the strip", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:customer_id" }, { node: "customers", port: "col:id" }, false));
  await waitFor(() => expect(s.notice()).toBe(MADE));
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
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.pick));
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
  expect(s.notice()).not.toBe(RELATE_MESSAGES.pick);
  expect(s.doc()).toBe(ER);
});

test("fix 4, N6: Enter with nothing aimed says to aim first, and the pick stays", async () => {
  const s = setup();
  await drawn(s);
  await startPick(s);
  key("Enter");
  await waitFor(() => expect(s.aimText()).toBe("Aim first with the arrow keys."));
  expect(s.notice()).toBe(RELATE_MESSAGES.pick);
  expect(s.doc()).toBe(ER);
});

test("fix 4, N2: a refusal stays when the text changes; only a notice about an undone action goes", async () => {
  const s = setup();
  await drawn(s);
  act(() => canvas.props!.onConnectPorts!({ node: "invoices", port: "col:note" }, { node: "invoices", port: "col:note" }, false));
  await waitFor(() => expect(s.notice()).toBe(RELATE_MESSAGES.itself));
  act(() => void s.view().dispatch({ changes: { from: s.doc().length, insert: "// x\n" }, userEvent: "input.type" }));
  await waitFor(() => expect(s.doc()).toContain("// x"));
  await new Promise((r) => setTimeout(r, 100));
  expect(s.notice()).toBe(RELATE_MESSAGES.itself);
});

// ---- Task 9 fix round 1: the pick keeps what it aims by name, never by place in its list

/** ER with accounts typed above customers as its own undo step, so an undo takes it away again. */
async function withAccounts(s: Setup) {
  const at = s.doc().indexOf("customers {");
  act(() => void s.view().dispatch({ changes: { from: at, insert: "accounts {\n  id int pk\n}\n" }, userEvent: "input.type" }));
  await drawn(s, "accounts");
}

test("an_undo_under_an_aimed_pick_links_what_the_ring_shows", async () => {
  const s = setup();
  await drawn(s);
  await withAccounts(s);
  await startPick(s);
  // accounts' header, its id, then customers' header: aimed.
  for (let i = 0; i < 3; i++) key("ArrowDown");
  await waitFor(() => expect(s.aimText()).toBe("Aim: key of customers"));
  // The table above the aim goes: the list is rebuilt, the aim stays on customers' key.
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.card("accounts")).toBeNull());
  await waitFor(() => expect(s.card("customers")!.querySelector(".fkind-head")!.className).toContain("is-pick"));
  expect(s.container.querySelectorAll(".is-pick")).toHaveLength(1);
  expect(s.aimText()).toBe("Aim: key of customers");
  act(() => s.canvasEl().focus());
  key("Enter");
  await waitFor(() => expect(s.doc()).toBe(LINKED));
});

test("an_undo_that_takes_the_aimed_table_leaves_nothing_aimed", async () => {
  const s = setup();
  await drawn(s);
  await withAccounts(s);
  await startPick(s);
  key("ArrowDown");
  await waitFor(() => expect(s.aimText()).toBe("Aim: key of accounts"));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.card("accounts")).toBeNull());
  await waitFor(() => expect(s.aimText()).toBe("Esc cancels."));
  expect(s.container.querySelector(".is-pick")).toBeNull();
  act(() => s.canvasEl().focus());
  key("Enter");
  await waitFor(() => expect(s.aimText()).toBe("Aim first with the arrow keys."));
  expect(s.notice()).toBe(RELATE_MESSAGES.pick);
  expect(s.doc()).toBe(ER);
});
