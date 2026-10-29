// B3 Task 5: relationship lines follow a card's rows while the card scrolls. One scroll store per tab
// (`erScroll`) holds how far each live card's rows are scrolled; the card's row window and the lines to its rows read
// it, a frame switch empties it, a tab drag of the live frame keeps it (R26), and static frames read none of it (R28).
//
// Restored from 5478210^ (erRelationships.test.tsx "fix 1", erFix2.test.tsx "M8"), in block form with `Table <t>`
// labels (R17). Their `invoices` table has 25 columns, not 3: a card past 20 rows is the only one whose rows scroll, and
// the store keeps no top past the card's last row (a browser would not scroll 3 rows either).
//
// jsdom measures nothing and fires no scroll event on a `scrollTop` write, so each test writes `scrollTop` and then fires
// the event itself, as the browser would (R28).
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { LangClient } from "../lang/client";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { boardFrameId, clashInFrameId, inFrameId } from "./board/staticIds";
import type { ErScrollStore } from "./erScroll";
import FlowTab from "./FlowTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

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

/** The tab's scroll store, kept as FlowTab makes it, so a test counts its entries and listeners. */
const made = vi.hoisted(() => ({ stores: [] as ErScrollStore[] }));
vi.mock("./erScroll", async (load) => {
  const real = await load<typeof import("./erScroll")>();
  return {
    ...real,
    createErScrollStore: () => {
      const s = real.createErScrollStore();
      made.stores.push(s);
      return s;
    },
  };
});
const store = () => made.stores[made.stores.length - 1];

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  canvas.instance = null;
  made.stores = [];
});

const lines = (...l: string[]) => `${l.join("\n")}\n`;
const columns = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `  c${i + from} text`);

function setup(text: string, layout: string | null, name = "rows") {
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
  const nodeEl = (id: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === id) ?? null;
  const card = (table: string) => nodeEl(table)?.querySelector<HTMLElement>(`[aria-label="Table ${table}"]`) ?? null;
  const cardOf = (id: string, table: string) => nodeEl(id)?.querySelector<HTMLElement>(`[aria-label="Table ${table}"]`) ?? null;
  const body = (table: string) => card(table)!.querySelector<HTMLElement>(".fkind-er-body")!;
  const rows = (table: string) => [...card(table)!.querySelectorAll<HTMLElement>(".fkind-er-row")];
  const row = (table: string, column: string) => rows(table).find((r) => r.querySelector(".fkind-col")?.textContent === column) ?? null;
  const firstRow = (table: string) => rows(table)[0]?.querySelector(".fkind-col")?.textContent;
  const edge = (id: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__edge")].find((e) => e.getAttribute("data-id") === id) ?? null;
  const edges = () => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__edge")];
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const scrollTo = (table: string, top: number) => {
    body(table).scrollTop = top;
    fireEvent.scroll(body(table));
  };
  return { ...utils, saved, view, doc, nodeEl, card, cardOf, body, rows, row, firstRow, edge, edges, canvasEl, scrollTo };
}

// ---- Restored from 5478210^

const LINKED = lines(
  'diagram er "Billing"',
  "customers {",
  "  id int pk",
  "  email text not null",
  "}",
  "invoices {",
  "  id int pk",
  "  customer_id int",
  ...columns(23, 2),
  "}",
  "invoices.customer_id > customers.id",
);
const LINKED_AT = JSON.stringify({ version: 1, nodes: { customers: { x: 0, y: 0 }, invoices: { x: 1000, y: 30 } } });

test("fix 1: a line to a row follows the card's rows as they scroll, and ends on the card's edge once the row is out of view", async () => {
  const s = setup(LINKED, LINKED_AT);
  await waitFor(() => expect(s.edge("edge:0")).not.toBeNull(), { timeout: 4000 });
  const start = () => s.edge("edge:0")!.querySelector("path")!.getAttribute("d")!.split(" L")[0];
  expect(start()).toBe(`M 1000 ${30 + 69}`);
  s.scrollTo("invoices", 10);
  await waitFor(() => expect(start()).toBe(`M 1000 ${30 + 59}`));
  // Scrolled past it: the line ends on the card's top edge.
  s.scrollTo("invoices", 40);
  await waitFor(() => expect(start()).toBe("M 1000 30"));
});

test("M8 a renamed table keeps its scrolled rows, and the lines to them stay put", async () => {
  const s = setup(LINKED, LINKED_AT);
  await waitFor(() => expect(s.edge("edge:0")).not.toBeNull(), { timeout: 4000 });
  s.scrollTo("invoices", 10);
  const start = () => s.edge("edge:0")!.querySelector("path")!.getAttribute("d")!.split(" L")[0];
  await waitFor(() => expect(start()).toBe(`M 1000 ${30 + 59}`));
  fireEvent.doubleClick(s.card("invoices")!.querySelector(".fkind-head")!);
  const box = (await screen.findByLabelText("Table name", { selector: "input" })) as HTMLInputElement;
  await userEvent.clear(box);
  await userEvent.type(box, "bills{Enter}");
  await waitFor(() => expect(s.card("bills")).not.toBeNull());
  await waitFor(() => expect(s.body("bills").scrollTop).toBe(10));
  await waitFor(() => expect(start()).toBe(`M 1000 ${30 + 59}`));
});

// ---- B3 Task 5

const SHOP = lines('diagram er "Shop"', "customers {", ...columns(30), "}", "orders {", "  id int pk", "  customer_id int", "}", "orders.customer_id > customers.c0");
const SALES = SHOP.replace('"Shop"', '"Sales"');
const TWO_AT = JSON.stringify({
  version: 2,
  frames: {
    Shop: { at: { x: 0, y: 0 }, nodes: { customers: { x: 0, y: 0 }, orders: { x: 300, y: 0 } }, style: "modern", direction: "TB" },
    Sales: { at: { x: 800, y: 0 }, nodes: { customers: { x: 0, y: 0 }, orders: { x: 300, y: 0 } }, style: "modern", direction: "TB" },
  },
  sketches: [],
});

/** Selects a frame by its tab and waits for its first table to be live. */
async function pickFrame(s: ReturnType<typeof setup>, title: string, first = "customers") {
  // A repeated title has a tab of its own: the first is the frame's.
  fireEvent.click((await screen.findAllByRole("button", { name: `ER diagram ${title}` }))[0]);
  // Live, not only drawn selected: its box holds no static shape any more.
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.parentId === boardFrameId(title))).toBe(false));
  await waitFor(() => expect(s.card(first)).not.toBeNull());
}

test("static_frames_subscribe_to_no_scroll", async () => {
  // R28, D7: three frames with the same tables and line, the third a repeated title drawn as a clash frame. Only the
  // live frame's two cards and its one line listen to the store: one listener each per table they draw or meet.
  const s = setup([SHOP, SALES, SHOP].join("\n"), TWO_AT, "three");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  // Fitted, the static frames are pictures with no card DOM: zoomed in, every card is drawn.
  await act(async () => void (await canvas.instance!.setViewport({ x: 0, y: 0, zoom: 0.5 })));
  await waitFor(() => expect(s.cardOf(inFrameId("Sales", "customers"), "customers")).not.toBeNull());
  await waitFor(() => expect(s.cardOf(clashInFrameId(2, "customers"), "customers")).not.toBeNull());
  // Every frame's line is drawn: the static ones too.
  await waitFor(() => expect(s.edges().length).toBe(3));
  // Live: the customers card and the line (2), the orders card and the line (2). The static frames add none.
  expect(store().listeners("customers")).toBe(2);
  expect(store().listeners("orders")).toBe(2);
  // A static line's ends are the static cards' ids: it listens to none of them either.
  for (const t of ["customers", "orders"]) for (const id of [inFrameId("Sales", t), clashInFrameId(2, t)]) expect(store().listeners(id)).toBe(0);
  expect(s.body("customers").classList.contains("is-scroll")).toBe(true);
  for (const id of [inFrameId("Sales", "customers"), clashInFrameId(2, "customers")]) {
    const b = s.cardOf(id, "customers")!.querySelector(".fkind-er-body")!;
    expect(b.classList.contains("is-scroll")).toBe(false);
  }
  // A scroll of the live card wakes the live card and line only, and moves no static card's rows.
  s.scrollTo("customers", 220);
  await waitFor(() => expect(s.firstRow("customers")).not.toBe("c0"));
  for (const id of [inFrameId("Sales", "customers"), clashInFrameId(2, "customers")]) {
    expect(s.cardOf(id, "customers")!.querySelector(".fkind-er-row .fkind-col")!.textContent).toBe("c0");
  }
});

test("a_frame_switch_empties_the_scroll_store", async () => {
  const s = setup([SHOP, SALES].join("\n"), TWO_AT, "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  s.scrollTo("customers", 220);
  await waitFor(() => expect(s.firstRow("customers")).not.toBe("c0"));
  expect(store().get("customers")).toBe(220);
  await pickFrame(s, "Sales");
  expect(store().get("customers")).toBe(0);
  // Sales has a customers table of its own: it starts at its top, and so does Shop's when it is live again.
  expect(s.body("customers").scrollTop).toBe(0);
  expect(s.firstRow("customers")).toBe("c0");
  await pickFrame(s, "Shop");
  expect(s.body("customers").scrollTop).toBe(0);
  expect(s.firstRow("customers")).toBe("c0");
});

test("a_tab_drag_keeps_the_scroll_store", async () => {
  // R26: the live frame dragged by its tab is drawn static while it moves; its cards read their scroll again once live.
  const s = setup([SHOP, SALES].join("\n"), TWO_AT, "two");
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await pickFrame(s, "Shop");
  s.scrollTo("customers", 220);
  await waitFor(() => expect(s.firstRow("customers")).not.toBe("c0"));
  const first = s.firstRow("customers");
  act(() => canvas.props!.onFrameDrag!(boardFrameId("Shop"), { x: 0, y: 0 }, false));
  await waitFor(() => expect(s.card("customers")).toBeNull());
  expect(store().get("customers")).toBe(220);
  act(() => canvas.props!.onFrameDrag!(boardFrameId("Shop"), { x: 0, y: 0 }, true));
  await waitFor(() => expect(s.card("customers")).not.toBeNull());
  expect(store().get("customers")).toBe(220);
  await waitFor(() => expect(s.body("customers").scrollTop).toBe(220));
  expect(s.firstRow("customers")).toBe(first);
});

test("a_selected_column_out_of_view_is_scrolled_in", async () => {
  // Decision 7 (WAI-ARIA listbox and grid): a row the keyboard selects is scrolled into view at once, no smooth scroll.
  const s = setup(lines('diagram er "Shop"', "customers {", ...columns(30), "}"), null, "shop");
  await waitFor(() => expect(s.card("customers")).not.toBeNull(), { timeout: 4000 });
  fireEvent.click(s.row("customers", "c0")!);
  await waitFor(() => expect(s.row("customers", "c0")!.classList.contains("is-selected")).toBe(true));
  for (let i = 0; i < 25; i++) fireEvent.keyDown(s.canvasEl(), { key: "Tab" });
  // The card set its body's scrollTop; jsdom fires no scroll event for it, so the test does (R28).
  fireEvent.scroll(s.body("customers"));
  const top = s.body("customers").scrollTop;
  // Row 25 is inside the 20 rows shown: its top at or below the view's top, its bottom at or above the view's bottom.
  expect(3 + 25 * 22).toBeGreaterThanOrEqual(top);
  expect(3 + 26 * 22).toBeLessThanOrEqual(top + 20 * 22 + 6);
  await waitFor(() => expect(s.row("customers", "c25")?.classList.contains("is-selected")).toBe(true));
  expect(within(s.card("customers")!).queryByText("c0")).toBeNull();
});

// ---- Task 5 fix round 1: no entry outlives its table (the memory ruling)

test("a_deleted_table_leaves_no_scroll_entry", async () => {
  const s = setup(LINKED, LINKED_AT);
  await waitFor(() => expect(s.card("invoices")).not.toBeNull(), { timeout: 4000 });
  s.scrollTo("invoices", 40);
  await waitFor(() => expect(store().get("invoices")).toBe(40));
  // The table and its line deleted in the pane: the parse after it drops the entry.
  const without = LINKED.replace(/invoices \{[^}]*\}\n/, "").replace("invoices.customer_id > customers.id\n", "");
  act(() => void s.view().dispatch({ changes: { from: 0, to: s.doc().length, insert: without }, userEvent: "input.type" }));
  await waitFor(() => expect(s.card("invoices")).toBeNull());
  await waitFor(() => expect(store().get("invoices")).toBe(0));
  // Typed back: it opens at its top.
  act(() => void s.view().dispatch({ changes: { from: 0, to: s.doc().length, insert: LINKED }, userEvent: "input.type" }));
  await waitFor(() => expect(s.card("invoices")).not.toBeNull());
  expect(s.body("invoices").scrollTop).toBe(0);
  expect(s.firstRow("invoices")).toBe("id");
});

test("a_renamed_table_moves_its_scroll_and_frees_the_old_name", async () => {
  const s = setup(LINKED, LINKED_AT);
  await waitFor(() => expect(s.card("invoices")).not.toBeNull(), { timeout: 4000 });
  s.scrollTo("invoices", 40);
  fireEvent.doubleClick(s.card("invoices")!.querySelector(".fkind-head")!);
  const box = (await screen.findByLabelText("Table name", { selector: "input" })) as HTMLInputElement;
  await userEvent.clear(box);
  await userEvent.type(box, "bills{Enter}");
  await waitFor(() => expect(s.card("bills")).not.toBeNull());
  expect(store().get("bills")).toBe(40);
  expect(store().get("invoices")).toBe(0);
  // A new table under the old name opens at its top.
  const added = `${s.doc()}invoices {\n${columns(25).join("\n")}\n}\n`;
  act(() => void s.view().dispatch({ changes: { from: 0, to: s.doc().length, insert: added }, userEvent: "input.type" }));
  await waitFor(() => expect(s.card("invoices")).not.toBeNull());
  expect(s.body("invoices").scrollTop).toBe(0);
  expect(s.firstRow("invoices")).toBe("c0");
  expect(s.body("bills").scrollTop).toBe(40);
});

test("move_and_prune_leave_no_old_entry", async () => {
  const { createErScrollStore } = await vi.importActual<typeof import("./erScroll")>("./erScroll");
  const st = createErScrollStore();
  const woke: string[] = [];
  for (const t of ["a", "b", "c"]) st.subscribe(t, () => woke.push(t));
  st.set("a", 30);
  st.set("b", 50);
  woke.length = 0;
  st.move("a", "c");
  expect([st.get("a"), st.get("c")]).toEqual([0, 30]);
  expect(woke.sort()).toEqual(["a", "c"]);
  woke.length = 0;
  // Only the tables dropped are woken.
  st.prune(new Set(["c"]));
  expect([st.get("b"), st.get("c")]).toEqual([0, 30]);
  expect(woke).toEqual(["b"]);
});

test("a_pinch_over_a_scrolling_card_zooms_the_board_and_leaves_its_rows", async () => {
  // Ctrl+wheel on the real 25-row card zooms the canvas around the pointer; the card's
  // own scroll (native, no JS wheel handler) is cancelled by preventDefault, so its store entry stays.
  const s = setup(LINKED, LINKED_AT);
  await waitFor(() => expect(s.card("invoices")).not.toBeNull(), { timeout: 4000 });
  await act(async () => void (await canvas.instance!.setViewport({ x: -700, y: 0, zoom: 1 })));
  await waitFor(() => expect(s.card("invoices")).not.toBeNull());
  s.scrollTo("invoices", 40);
  await waitFor(() => expect(store().get("invoices")).toBe(40));
  const root = s.container.querySelector(".diagram-canvas") as HTMLElement;
  const rect = root.getBoundingClientRect();
  const ev = new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, clientX: rect.left + 300, clientY: rect.top + 200, bubbles: true, cancelable: true });
  await act(async () => void s.body("invoices").dispatchEvent(ev));
  const vp = canvas.instance!.getViewport();
  expect(vp.zoom).toBeCloseTo(0.8187, 4);
  // The flow point under the pointer (1,000 from the view at -700) stays under it.
  expect((300 - vp.x) / vp.zoom).toBeCloseTo(1000, 2);
  expect((200 - vp.y) / vp.zoom).toBeCloseTo(200, 2);
  expect(ev.defaultPrevented).toBe(true);
  expect(store().get("invoices")).toBe(40);
});
