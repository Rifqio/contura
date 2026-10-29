// Plan F Task 3: far text turns to soft lines and frame titles keep their screen size (Decisions 2 to 5). The canvas
// wrapper says which text sizes are far (`data-far`); every shape, ER card body and line label carries its frame's
// text size class (`board-ts-*`), and flow-board.css draws far text as bars. Only a crossing changes anything.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { iconPath } from "../../components/Icon";
import { SOFT_CHAR_W } from "../../diagram/canvasView";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import boardCss from "../../styles/flow-board.css?raw";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import { erRowWindow, erViewH } from "../kindLayout";
import { KindNode } from "../kindNodes";
import { BoardFarContext } from "./BoardFar";
import { textSizeOf } from "../textScale";
import { TEXT_SCALE, type TextSize } from "./boardLayout";
import { boardFrameId } from "./boardScene";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

// `renders` counts the canvas's calls: one per FlowTab render.
const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null, renders: 0 }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      canvas.renders++;
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

// Every shape's shell, counted by its label: a zoom tick that crosses nothing draws no shape again.
const shells = vi.hoisted(() => ({ renders: new Map<string, number>() }));
vi.mock("../nodes/parts", async (load) => {
  const real = await load<typeof import("../nodes/parts")>();
  return {
    ...real,
    NodeShell: (p: Parameters<typeof real.NodeShell>[0]) => {
      shells.renders.set(p.label, (shells.renders.get(p.label) ?? 0) + 1);
      return real.NodeShell(p);
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
  canvas.instance = null;
  canvas.renders = 0;
  shells.renders.clear();
});

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay: card\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it: yes\n';
const COLUMNS = 30;
const SCHEMA = [
  'diagram er "Schema"',
  "orders {",
  "  id int pk",
  ...Array.from({ length: COLUMNS - 1 }, (_, i) => `  column_${i + 1} ${i % 2 ? "text" : "numeric"}`),
  "}",
  "people {",
  "  id int pk",
  "}",
  "orders.column_1 > people.id",
  "",
].join("\n");

type Frame = { text: string; key: string; nodes: Record<string, { x: number; y: number }>; textSize?: TextSize };

function setup(frames: Frame[]) {
  const text = frames.map((f) => f.text).join("\n");
  const layout = JSON.stringify({
    version: 2,
    frames: Object.fromEntries(
      frames.map((f, i) => [f.key, { at: { x: i * 800, y: 0 }, nodes: f.nodes, style: "modern", direction: "TB", ...(f.textSize ? { textSize: f.textSize } : {}) }]),
    ),
    sketches: [],
  });
  routeInvoke({ read_diagram: () => ({ text, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>,
  );
  const wrapper = () => utils.container.querySelector<HTMLElement>(".flow-canvas")!;
  const far = () => (wrapper().dataset.far ?? "").split(" ").filter(Boolean);
  /** A node's React Flow wrapper by id (ids may hold a NUL, which no CSS selector names). */
  const nodeEl = (id: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === id) ?? null;
  const zoomTo = async (zoom: number) => {
    await act(async () => {
      await canvas.instance!.setViewport({ x: 0, y: 0, zoom });
    });
  };
  const boxOf = (key: string) => {
    const n = canvas.props!.nodes.find((x) => x.id === boardFrameId(key))!;
    return { x: n.position.x, y: n.position.y, w: Number(n.style?.width), h: Number(n.style?.height) };
  };
  return { ...utils, wrapper, far, nodeEl, zoomTo, boxOf };
}
type Setup = ReturnType<typeof setup>;

async function pick(s: Setup, tab: string, first: string) {
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  fireEvent.click(await screen.findByRole("button", { name: tab }));
  await waitFor(() => expect(s.nodeEl(first)).not.toBeNull(), { timeout: 10000 });
}

const two = (sizes: [TextSize | undefined, TextSize | undefined] = [undefined, undefined]) =>
  setup([
    { text: CHECKOUT, key: "Checkout", nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 160 } }, textSize: sizes[0] },
    { text: REFUND, key: "Refund", nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 160 } }, textSize: sizes[1] },
  ]);

test("far_text_turns_to_soft_lines", async () => {
  const s = two();
  await pick(s, "Flowchart Checkout", "Cart");
  await s.zoomTo(1);
  await waitFor(() => expect(s.far()).toEqual([]));
  await s.zoomTo(0.4);
  await waitFor(() => expect(s.far()).toContain("m"));
  // The live shape carries its frame's size; its label stays in the page with its words, for a screen reader.
  const cart = s.nodeEl("Cart")!;
  expect(cart.classList.contains("board-ts-m")).toBe(true);
  expect(cart.querySelector(".fnode-name")!.textContent).toBe("Cart");
  // Back past the readable line (with the hysteresis band), the text is readable again.
  await s.zoomTo(1);
  await waitFor(() => expect(s.far()).toEqual([]));
});

test("each_size_fades_at_its_own_zoom", async () => {
  const s = two(["s", "l"]);
  await pick(s, "Flowchart Checkout", "Cart");
  await waitFor(() => expect(s.nodeEl("Cart")!.classList.contains("board-ts-s")).toBe(true));
  // The static frame's shapes carry their own frame's size.
  const ask = canvas.props!.nodes.find((n) => n.parentId === boardFrameId("Refund") && n.className?.includes("board-static"))!;
  expect(ask.className).toContain("board-ts-l");
  await s.zoomTo(0.45);
  await waitFor(() => expect(s.far()).toContain("s"));
  expect(s.far()).not.toContain("l");
});

test("edge_labels_fade", async () => {
  const s = two();
  await pick(s, "Flowchart Checkout", "Cart");
  await waitFor(() => expect([...s.container.querySelectorAll(".flow-chip")].map((c) => c.textContent)).toContain("card"));
  const chip = [...s.container.querySelectorAll(".flow-chip")].find((c) => c.textContent === "card")!;
  expect(chip.classList.contains("board-ts-m")).toBe(true);
});

test("the_size_class_reads_the_boards_text_scale", () => {
  // textScale.ts mirrors TEXT_SCALE (it is a leaf the cards import): the two agree.
  for (const size of ["s", "m", "l"] as const) expect(textSizeOf(TEXT_SCALE[size])).toBe(size);
  expect(textSizeOf(undefined)).toBe("m");
});

test("a_zoom_tick_without_a_crossing_renders_nothing", async () => {
  const s = two();
  await pick(s, "Flowchart Checkout", "Cart");
  await s.zoomTo(0.6);
  await waitFor(() => expect(s.far()).toEqual([]));
  await new Promise((r) => setTimeout(r, 50));
  const label = [...shells.renders.keys()].find((k) => k.endsWith(" Cart"))!;
  const before = shells.renders.get(label);
  expect(before).toBeGreaterThan(0);
  const tab = canvas.renders;
  // Ten ticks between 0.6 and 0.9 cross no readable line: neither FlowTab nor any shape draws again.
  for (let i = 0; i < 10; i++) await s.zoomTo(0.6 + (0.3 * (i + 1)) / 10);
  await new Promise((r) => setTimeout(r, 50));
  expect(canvas.renders).toBe(tab);
  expect(shells.renders.get(label)).toBe(before);
  // Out to 0.5 crosses small text's line (0.5245) and no other (nor BOX_BELOW): FlowTab draws once.
  await s.zoomTo(0.5);
  await waitFor(() => expect(s.far()).toEqual(["s"]));
  await new Promise((r) => setTimeout(r, 50));
  expect(canvas.renders).toBe(tab + 1);
});

const schema = () =>
  setup([
    { text: SCHEMA, key: "Schema", nodes: { orders: { x: 0, y: 0 }, people: { x: 600, y: 0 } } },
    { text: REFUND, key: "Refund", nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 160 } } },
  ]);

/** The live orders card, selected alone (its ports show). */
async function ordersSelected(s: Setup) {
  await pick(s, "ER diagram Schema", "orders");
  act(() => canvas.props!.onSelect!(["orders"]));
  await waitFor(() => expect(s.nodeEl("orders")!.querySelectorAll(".fkind-port").length).toBeGreaterThan(0));
}

test("er_rows_are_bars_when_far", async () => {
  const s = schema();
  await ordersSelected(s);
  await s.zoomTo(0.3);
  await waitFor(() => expect(s.far()).toContain("m"));
  const card = s.nodeEl("orders")!;
  const body = card.querySelector(".fkind-er-body")!;
  // The row bars are drawn by the body's backgrounds, one layer a bar (Plan F milestone fix 3: WebKit gives every
  // <svg> root its own memory; main's fast box had none), and no row element.
  await waitFor(() => expect(body.querySelector(".fkind-er-bars")).not.toBeNull());
  expect(card.querySelector("svg")).toBeNull();
  expect(card.querySelectorAll(".fkind-er-row, .fkind-col, .fkind-type")).toHaveLength(0);
  const bars = body.querySelector<HTMLElement>(".fkind-er-bars")!;
  expect(bars.children).toHaveLength(0);
  const w = parseFloat(bars.style.width);
  const { from, to } = erRowWindow(COLUMNS, erViewH(undefined), 0);
  const images = bars.style.backgroundImage.split(/,\s*(?=linear-gradient)/);
  const sizes = bars.style.backgroundSize.split(",").map((x) => parseFloat(x.trim()));
  expect(sizes).toHaveLength(images.length);
  // The key row's mark is a layer of its own colour; the rest are a name bar then a type bar for each row.
  expect(images.filter((i) => i.includes("--far-key"))).toHaveLength(1);
  const widths = sizes.filter((_, i) => !images[i].includes("--far-key"));
  const names = widths.filter((_, i) => i % 2 === 0);
  const types = widths.filter((_, i) => i % 2 === 1);
  expect(names).toHaveLength(to - from);
  expect(types).toHaveLength(to - from);
  // Each bar is as wide as its words at the soft character width, and never wider than its share of the card.
  const rows = ["id int", ...Array.from({ length: COLUMNS - 1 }, (_, i) => `column_${i + 1} ${i % 2 ? "text" : "numeric"}`)];
  for (let k = from; k < to; k++) {
    const [name, type] = rows[k].split(" ");
    expect(names[k - from]).toBeCloseTo(Math.min(name.length * SOFT_CHAR_W, 0.55 * w), 2);
    expect(types[k - from]).toBeCloseTo(Math.min(type.length * SOFT_CHAR_W, 0.3 * w), 2);
  }
  // The header with its name and the ports stay.
  expect(card.querySelector(".fkind-head .fnode-name")!.textContent).toBe("orders");
  expect(card.querySelectorAll(".fkind-port").length).toBe(2 * (to - from));
  // So does its icon (Decision 3), with no <svg> and no element: the header's ::before, masked by the same table icon.
  expect(card.querySelector(".fkind-head")!.classList.contains("is-far")).toBe(true);
  const icon = bodyIn(boardCss, ".fkind-head.is-far::before");
  expect(icon).toContain(`d='${iconPath("table")}'`);
  expect(icon).toMatch(/(^|[^-])mask:/);
  expect(icon).toContain("background-color: var(--fnode-stroke)");
});

test("far_er_bars_key_and_icon_stay_in_forced_colours", () => {
  // Forced colours (Windows High Contrast, WebView2) drop background images that are not url() and force background
  // colours: the bars, the key mark and the masked header icon would vanish. They keep system colours instead.
  const forced = /@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/.exec(boardCss.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1] ?? "";
  const bars = bodyIn(forced, ".fkind-er-bars");
  expect(bars).toContain("forced-color-adjust: none");
  expect(bars).toMatch(/--far-bar:\s*GrayText/);
  expect(bars).toMatch(/--far-key:\s*CanvasText/);
  const icon = bodyIn(forced, ".fkind-head.is-far::before");
  expect(icon).toContain("forced-color-adjust: none");
  expect(icon).toMatch(/background-color:\s*CanvasText/);
});

/** The body of the rule whose selector is exactly `selector` in `css`, comments dropped; "" with none. */
function bodyIn(css: string, selector: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = text.split("}").find((r) => r.split("{")[0].trim() === selector);
  return at ? at.split("{").slice(-1)[0] : "";
}

test("er_rows_come_back_when_readable", async () => {
  const s = schema();
  await ordersSelected(s);
  await s.zoomTo(0.3);
  await waitFor(() => expect(s.nodeEl("orders")!.querySelector(".fkind-er-bars")).not.toBeNull());
  await s.zoomTo(1);
  await waitFor(() => expect(s.far()).toEqual([]));
  const card = s.nodeEl("orders")!;
  expect(card.querySelector(".fkind-er-bars")).toBeNull();
  expect(card.querySelectorAll(".fkind-er-row").length).toBeGreaterThan(0);
  expect(card.querySelector(".fkind-er-row .fkind-col")!.textContent).toBe("id");
});

/** The tab strip's scale as flow-board.css draws it, at the zoom the canvas sets on itself. */
function tabScale(s: Setup): string | null {
  const rule = /\.board-frame-tab\s*\{([^}]*)\}/.exec(boardCss.replace(/\/\*[\s\S]*?\*\//g, ""))![1];
  const scale = /(?:^|;|\s)scale:\s*([^;]+);/.exec(rule)?.[1].trim() ?? null;
  if (scale === null) return null;
  // The one form the rule takes: 1 over the zoom, never past 1.
  expect(scale).toBe("max(1, calc(1 / var(--rz-zoom, 1)))");
  // Given to the tab itself, never to the whole canvas (Task 9 fix 2).
  expect(s.container.querySelector<HTMLElement>(".react-flow")!.style.getPropertyValue("--rz-zoom")).toBe("");
  const zoom = Number(s.container.querySelector<HTMLElement>(".board-frame-tab")!.style.getPropertyValue("--rz-zoom"));
  const k = Math.max(1, 1 / zoom);
  return k === 1 ? null : String(k);
}

test("frame_titles_keep_their_screen_size", async () => {
  const s = two();
  await pick(s, "Flowchart Checkout", "Cart");
  await s.zoomTo(0.25);
  expect(tabScale(s)).toBe("4");
  // It grows from its bottom left, where it meets the frame.
  expect(/\.board-frame-tab\s*\{([^}]*)\}/.exec(boardCss)![1]).toMatch(/transform-origin:\s*left bottom/);
  // The title is never far text: no text size class on it or around it.
  const tab = await screen.findByRole("button", { name: "Flowchart Refund" });
  expect(tab.closest('[class*="board-ts-"]')).toBeNull();
  await s.zoomTo(1.5);
  expect(tabScale(s)).toBeNull();
});

test("a_click_on_a_screen_size_tab_picks_its_frame", async () => {
  const s = two();
  await pick(s, "Flowchart Checkout", "Cart");
  await s.zoomTo(0.25);
  const b = s.boxOf("Refund");
  // 100 board units above the box: inside the 120 unit strip at 25 percent, over the title.
  const p = canvas.instance!.flowToScreenPosition({ x: b.x + 10, y: b.y - 100 });
  fireEvent.click(s.container.querySelector(".react-flow__pane")!, { clientX: p.x, clientY: p.y });
  await waitFor(() => expect(s.nodeEl("Ask")).not.toBeNull());
  expect(screen.getByRole("button", { name: "Flowchart Refund" }).getAttribute("aria-current")).toBe("true");
});

test("an_er_card_of_no_width_keeps_its_rows", () => {
  // No size and no natural size: a picture 0 wide would draw nothing, so the rows stay (fix round 1).
  const d = { name: "orders", kind: "erTable" as const, look: "modern" as const, rows: ["id int"], rowFlags: [["pk" as const]] };
  render(
    <BoardFarContext.Provider value={new Set<TextSize>(["m"])}>
      <KindNode d={d} selected={false} />
    </BoardFarContext.Provider>,
  );
  expect(document.querySelector(".fkind-er-bars")).toBeNull();
  expect(document.querySelectorAll(".fkind-er-row")).toHaveLength(1);
  cleanup();
  render(
    <BoardFarContext.Provider value={new Set<TextSize>(["m"])}>
      <KindNode d={{ ...d, naturalW: 240 }} selected={false} />
    </BoardFarContext.Provider>,
  );
  expect(document.querySelector<HTMLElement>(".fkind-er-bars")!.style.width).toBe("240px");
});
