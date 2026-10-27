// ER build B, part A: the follow-ups found in the real app. Tooltips never cover "+ column", the strip speaks ER
// words, a card hugs its rows and is as wide as its longest row, Enter on a selected table edits its name, key
// columns are marked in Publish, and a card grows smoothly while a column is added.
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { LangClient } from "../lang/client";
import { parseFlow } from "../lang/flow/parse";
import { routeInvoke } from "../test/invoke";
import { mockEditorDom } from "../test/editor";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import FlowTab from "./FlowTab";
import { EASE_IN, MOTION } from "../diagram/motion";
import { installTooltipGuard } from "../components/tooltipGuard";
import { buildFlowGraph, nodeSize } from "./flowNodes";
import { flowScene } from "./flowScene";
import { sceneToSvg } from "../diagram/export/svg";
import { NODE_TOKENS } from "../diagram/types";
import type { ExportPalette } from "../diagram/export/palette";
import canvasCss from "../styles/flow-canvas.css?raw";
import tokensCss from "../styles/tokens.css?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/** The test sets it: the file runs under reduced motion unless a test turns it off. */
let reduce = true;

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  reduce = true;
  cleanup();
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

function setup(text = ER) {
  routeInvoke({ read_diagram: () => ({ text, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="billing" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const card = (table: string) => utils.container.querySelector(`.react-flow__node [aria-label="Table ${table}"]`) as HTMLElement | null;
  const rows = (table: string) => [...card(table)!.querySelectorAll<HTMLElement>(".fkind-er-row")];
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  return { ...utils, view, doc, card, rows, press };
}

async function drawn(s: ReturnType<typeof setup>, table = "customers") {
  await waitFor(() => expect(s.card(table)).not.toBeNull(), { timeout: 4000 });
}

const css = () => canvasCss;

const PALETTE_FOR_TEST: ExportPalette = {
  surface: "#010101",
  canvas: "#020202",
  text: "#030303",
  subtle: "#040404",
  border: "#050505",
  type: "#060606",
  keyword: "#070707",
  nodes: Object.fromEntries(Object.keys(NODE_TOKENS).map((k) => [k, { fill: "#100000", stroke: "#200000" }])) as ExportPalette["nodes"],
  iconTile: "#101010",
  group: "#111111",
  groupTint: "#121212",
  strongBorder: "#131313",
  panel: "#141414",
};
const rule = (sel: string) => {
  const at = css().indexOf(`${sel} {`);
  expect(at, sel).toBeGreaterThanOrEqual(0);
  return css().slice(at, css().indexOf("}", at));
};

test("A1 a card's tooltips are the app's one tooltip (the guard), never the system's title window over + column", async () => {
  // Fix round 2, live bug (b): the card's tips go through the tooltip guard, which hides them while a button is held.
  const off = installTooltipGuard();
  try {
    const s = setup();
    await drawn(s, "invoices");
    const last = s.rows("invoices")[1];
    fireEvent.pointerOver(last.querySelector(".fkind-col")!);
    // The guard holds the title while the pointer is on it, so the system never draws one.
    expect(last.hasAttribute("title")).toBe(false);
    const tip = await screen.findByRole("tooltip", {}, { timeout: 1500 });
    expect(tip.textContent).toBe("customer_id int (nullable)");
    // A press puts it away; the click on + column starts the new row.
    const add = s.card("invoices")!.closest(".react-flow__node")!.querySelector(".fkind-addcol") as HTMLElement;
    fireEvent.pointerOver(add);
    await userEvent.click(add);
    expect(screen.queryByRole("tooltip")).toBeNull();
    const box = (await screen.findByLabelText("Column name", { selector: "input" })) as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    await userEvent.type(box, "total");
    expect(box.value).toBe("total");
    expect(s.doc()).toBe(ER);
  } finally {
    off();
  }
});

test("A1 the gutter and the not-null mark say what they are in the app's tooltip, and a press hides it", async () => {
  const off = installTooltipGuard();
  try {
    const s = setup();
    await drawn(s);
    const row = s.rows("customers")[0];
    fireEvent.pointerOver(row.querySelector(".fkind-gut")!);
    expect((await screen.findByRole("tooltip", {}, { timeout: 1500 })).textContent).toBe("Primary key. Click to remove");
    fireEvent.pointerOver(row.querySelector(".fkind-nn")!);
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("Not null"), { timeout: 1500 });
    // A press hides it, as every tooltip does.
    fireEvent.pointerDown(row.querySelector(".fkind-nn")!, { button: 0 });
    expect(screen.queryByRole("tooltip")).toBeNull();
  } finally {
    off();
  }
});

test("A2 the strip names a selected ER table in ER words: table, columns, relationships", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.pointerDown(s.card("customers")!.querySelector(".fkind-head")!);
  await waitFor(() => expect(screen.getByText("Table, 2 columns, 1 relationship")).toBeTruthy());
  expect(screen.queryByText(/Outside party/)).toBeNull();
});

test("A3 and A4 a card hugs its rows (no scrollbar) and is as wide as its longest row", () => {
  // 2 px of border, the 32 px header, 3 px above and below the rows, 22 px a row.
  expect(nodeSize("erTable", "modern", "invoices", undefined, { rows: ["id int", "customer_id int"] }).h).toBe(2 + 32 + 6 + 2 * 22);
  expect(nodeSize("erTable", "modern", "t", undefined, { rows: [] }).h).toBe(2 + 32 + 6 + 22);
  expect(nodeSize("erTable", "modern", "t", undefined, { rows: Array(25).fill("c int") }).h).toBe(2 + 32 + 6 + 20 * 22);
  // The row's gutter, gaps, type padding and not-null mark take 92 px (10 px on the left, so a column's port clears
  // the key gutter, ER build C fix round 1); the name and type take 7.2 px a character.
  expect(nodeSize("erTable", "modern", "invoices", undefined, { rows: ["id int", "customer_id int"] }).w).toBe(Math.ceil(14 * 7.2 + 92));
  expect(nodeSize("erTable", "modern", "t", undefined, { rows: ["id int"] }).w).toBe(184);
  expect(nodeSize("erTable", "modern", "t", undefined, { rows: [`${"a".repeat(60)} text`] }).w).toBe(300);
  // The body scrolls only past 20 rows (or a card dragged smaller than its rows).
  expect(rule(".fkind-er-body")).toContain("overflow-y: hidden");
  expect(rule(".fkind-er-body.is-scroll")).toContain("overflow-y: auto");
});

test("A3 the card body takes the scroll class only past 20 rows", async () => {
  const many = lines('diagram er "Wide"', "events {", ...Array.from({ length: 21 }, (_, i) => `  c${i} int`), "}");
  const s = setup(lines('diagram er "Billing"', "customers {", "  id int", "  email text", "}"));
  await drawn(s);
  expect(s.card("customers")!.querySelector(".fkind-er-body")!.classList.contains("is-scroll")).toBe(false);
  cleanup();
  const t = setup(many);
  await drawn(t, "events");
  expect(t.card("events")!.querySelector(".fkind-er-body")!.classList.contains("is-scroll")).toBe(true);
});

test("A5 Enter on a selected table edits its name in its header", async () => {
  const s = setup();
  await drawn(s);
  fireEvent.pointerDown(s.card("invoices")!.querySelector(".fkind-head")!);
  await waitFor(() => expect(s.card("invoices")!.closest(".react-flow__node")!.classList.contains("selected")).toBe(true));
  s.press("Enter");
  const box = (await screen.findByLabelText("Table name", { selector: "input" })) as HTMLInputElement;
  expect(s.card("invoices")!.contains(box)).toBe(true);
  expect(box.value).toBe("invoices");
});

test("A5 Publish marks key columns as the canvas does, with the type on the right", () => {
  const d = parseFlow(ER).doc!;
  const scene = flowScene(d, { customers: { x: 0, y: 0 }, invoices: { x: 300, y: 0 } }, "modern", new Map());
  const customers = scene.nodes.find((n) => n.id === "customers")!;
  expect(customers.rows).toEqual([
    { left: "id", right: "int", mark: "pk", notNull: true },
    { left: "email", right: "text", notNull: true },
  ]);
});

test("A5 a card grows smoothly while a column is added, and not when motion is reduced", async () => {
  const d = parseFlow(ER).doc!;
  const at = { customers: { x: 0, y: 0 }, invoices: { x: 300, y: 0 } };
  const g = buildFlowGraph(d, at, "modern", { grow: { customers: 1 } });
  // The inline transition is the whole rule: no class marks it (the CSS rule it replaced is gone).
  expect(g.nodes.find((n) => n.id === "customers")!.className).toBeUndefined();
  expect(g.nodes.find((n) => n.id === "customers")!.style?.transition).toBeDefined();
  expect(g.nodes.find((n) => n.id === "invoices")!.style?.transition).toBeUndefined();
  // The inline duration is the motion table's, 0 under reduced motion (R28, D8); jsdom computes no style, so none is read.
  const growth = (reduced: boolean) => {
    reduce = reduced;
    return buildFlowGraph(d, at, "modern", { grow: { customers: 1 } }).nodes.find((n) => n.id === "customers")!.style?.transition;
  };
  expect(growth(false)).toBe(`height ${MOTION.settle}ms ${EASE_IN}`);
  expect(growth(true)).toBe(`height 0ms ${EASE_IN}`);
  // The live half: "+ column" opens its draft row and the card is one row taller, easing on that same duration.
  reduce = false;
  const s = setup();
  await drawn(s);
  const node = () => s.card("customers")!.closest(".react-flow__node") as HTMLElement;
  const before = parseFloat(node().style.height);
  await userEvent.click(node().querySelector(".fkind-addcol") as HTMLElement);
  await screen.findByLabelText("Column name", { selector: "input" });
  await waitFor(() => expect(parseFloat(node().style.height)).toBe(before + 22));
  expect(node().style.transition).toBe(`height ${MOTION.settle}ms ${EASE_IN}`);
});

test("a_growing_class_card_keeps_the_timing_of_the_css_rule_it_replaced", () => {
  // Final review Minor 7: a class card getting a member row grew on `height var(--motion-base) var(--ease-enter)`; the
  // inline rule every growing card now gets has those same values, and 0 under reduced motion.
  const token = (name: string) => tokensCss.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"))![1].trim();
  const base = parseFloat(token("--motion-base"));
  const enter = token("--ease-enter");
  const d = parseFlow(lines('diagram class "Billing"', "class Invoice", "Invoice : + total: decimal")).doc!;
  const growth = (reduced: boolean) => {
    reduce = reduced;
    return buildFlowGraph(d, { Invoice: { x: 0, y: 0 } }, "modern", { grow: { Invoice: 1 } }).nodes.find((n) => n.id === "Invoice")!.style?.transition;
  };
  expect(growth(false)).toBe(`height ${base}ms ${enter}`);
  expect(growth(true)).toBe(`height 0ms ${enter}`);
});

test("M13 each tipped part says its tip to a screen reader; a header name shows its tip only when it is cut off", async () => {
  const s = setup();
  await drawn(s);
  const row = s.rows("customers")[0];
  expect(row.getAttribute("aria-description")).toBe("id int (primary key, not null)");
  expect(row.getAttribute("title")).toBe("id int (primary key, not null)");
  expect(row.querySelector(".fkind-gut")!.getAttribute("aria-description")).toBe("Primary key. Click to remove");
  // A name that fits has no tip; jsdom measures nothing, so it fits.
  expect(s.card("customers")!.querySelector(".fkind-head .fnode-name")!.hasAttribute("title")).toBe(false);
  cleanup();
  const proto = HTMLElement.prototype;
  const sw = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
  const cw = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 120 });
  try {
    const t = setup();
    await drawn(t);
    await waitFor(() => expect(t.card("customers")!.querySelector(".fkind-head .fnode-name")!.getAttribute("title")).toBe("customers"));
  } finally {
    if (sw) Object.defineProperty(proto, "scrollWidth", sw);
    else delete (proto as unknown as Record<string, unknown>).scrollWidth;
    if (cw) Object.defineProperty(proto, "clientWidth", cw);
    else delete (proto as unknown as Record<string, unknown>).clientWidth;
  }
});

test("M11 Publish draws the not-null mark as the canvas does", () => {
  const d = parseFlow(ER).doc!;
  const scene = flowScene(d, { customers: { x: 0, y: 0 }, invoices: { x: 300, y: 0 } }, "modern", new Map());
  expect(scene.nodes.find((n) => n.id === "customers")!.rows).toEqual([
    { left: "id", right: "int", mark: "pk", notNull: true },
    { left: "email", right: "text", notNull: true },
  ]);
  const svg = sceneToSvg(scene, PALETTE_FOR_TEST, { padding: 0, background: "theme", mark: false });
  expect(svg.match(/data-marker="not-null"/g)).toHaveLength(3);
});

test("M8 a column's Show in the text skips a stray column line written above its table", async () => {
  const s = setup(lines('diagram er "B"', "invoices {", "  id int pk", "}"));
  await drawn(s, "invoices");
  // A stray column line typed above the table: an error, not a row.
  act(() => void s.view().dispatch({ changes: { from: s.doc().indexOf("invoices {"), insert: "invoices.note text\n" }, userEvent: "input.type" }));
  fireEvent.contextMenu(s.rows("invoices")[0], { clientX: 300, clientY: 220 });
  await userEvent.click(within(await screen.findByRole("menu", { name: "invoices.id actions" })).getByRole("menuitem", { name: "Show in the text" }));
  await waitFor(() => expect(s.view().state.doc.lineAt(s.view().state.selection.main.head).text).toBe("  id int pk"));
});
