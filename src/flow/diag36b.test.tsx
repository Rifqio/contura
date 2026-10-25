// Diagram build 2, follow-up (diag-36-build-rereview.md N1 to N6, and the coordinator's live check): a + line's kept
// axis is used wherever the line is routed, Publish included (N1); the axes follow the text through saves, renames and
// undo (N2); the group-title band is shown and limited to the title (N3); a cancelled add takes its notice with it (N4);
// a refused date goes back to the field at fault (N5); a wrapped label opens at its full height (N6); the first-node
// hint hides under a ghost; the + tip never covers its shape; the group title field sits exactly over the title.
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { routeOrthogonal } from "../diagram/route";
import { LangClient } from "../lang/client";
import { parseFlow } from "../lang/flow/parse";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import canvasCss from "../styles/flow-canvas.css?raw";
import tabCss from "../styles/flow-tab.css?raw";
import FlowTab from "./FlowTab";
import { flowScene } from "./flowScene";
import { axisKey } from "./layout";

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

function setup(initial: string, layout: string | null = null) {
  routeInvoke({ read_diagram: () => ({ text: initial, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="d36b" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const field = (label: string) => screen.findByRole("textbox", { name: label }) as Promise<HTMLInputElement>;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const box = (n: string) => {
    const g = canvas.props!.nodes.find((x) => x.id === n)!;
    return { x: g.position.x, y: g.position.y, w: g.initialWidth ?? 0, h: g.initialHeight ?? 0 };
  };
  const edge = (from: string, to: string) => canvas.props!.edges.find((e) => e.source === from && e.target === to);
  return { ...utils, view, doc, node, press, field, strip, box, edge, canvasEl };
}
type Setup = ReturnType<typeof setup>;
const shown = (s: Setup, label: string) => waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });

/** A + click on `node`'s side `name` ("Add the next step to the right"), then Enter on the ghost's name. */
async function plusAdd(s: Setup, label: string, button: string) {
  fireEvent.pointerMove(s.node(label)!, { clientX: 10, clientY: 10 });
  fireEvent.pointerDown(await screen.findByRole("button", { name: button }), { button: 0, clientX: 1, clientY: 1, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: 1, clientY: 1, pointerId: 1 });
  fireEvent.keyDown(await screen.findByRole("textbox", { name: /^Name the new/ }), { key: "Enter" });
}

// ----- N1: every route of a + line uses its kept axis

test("N1 Publish draws a + line on its kept axis, as the canvas does", () => {
  const doc = parseFlow(lines('diagram flow "x"', "A", "B", "", "A > B")).doc!;
  const at = { A: { x: 0, y: 0 }, B: { x: 400, y: 200 } };
  const plain = flowScene(doc, at, "modern", new Map());
  const kept = flowScene(doc, at, "modern", new Map(), { [axisKey("A", "B")]: "v" });
  const a = plain.nodes.find((n) => n.id === "A")!;
  // Without the axis the line leaves A's right side; kept on "v" it leaves A's bottom.
  expect(plain.edges[0].points[0].x).toBe(a.x + a.w);
  expect(kept.edges[0].points[0]).toEqual({ x: a.x + a.w / 2, y: a.y + a.h });
});

test("N1 a line's label field opens on the route the canvas draws, its kept axis included", async () => {
  const DFD = lines('diagram dfd "x"', "A [entity]", "B [store, id: D1]", "", "A > B");
  const layout = JSON.stringify({ version: 1, nodes: { A: { x: 0, y: 0 }, B: { x: 500, y: 300 } }, sizes: { B: { w: 300, h: 120 } }, axes: { [axisKey("A", "B")]: "v" } });
  const s = setup(DFD, layout);
  await shown(s, "Data store B");
  // The kept axis puts the line's middle somewhere else than the default route's.
  expect(routeOrthogonal(s.box("A"), s.box("B"), { axis: "v" }).mid).not.toEqual(routeOrthogonal(s.box("A"), s.box("B")).mid);
  act(() => canvas.props!.onEdgeDoubleClick!("edge:0"));
  const label = await s.field("Flow label");
  const wrap = label.closest(".inline-edit-wrap") as HTMLElement;
  const mid = routeOrthogonal(s.box("A"), s.box("B"), { axis: "v" }).mid;
  expect(parseFloat(wrap.style.left) + 85).toBeCloseTo(mid.x, 0);
  expect(parseFloat(wrap.style.top)).toBeCloseTo(mid.y, 0);
});

// ----- N2: the axes follow the text

const FLOW = lines('diagram flow "Orders"', "Order in [start]", "Check stock", "Done [end]");
const FLOW_AT = JSON.stringify({ version: 1, nodes: { "Order in": { x: 100, y: 100 }, "Check stock": { x: 100, y: 300 }, Done: { x: 100, y: 380 } } });

test("N2 undo of a + add takes its axis back, redo brings it again; a new line between the same shapes takes none", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "End Done");
  await plusAdd(s, "Step Check stock", "Add the next step to the right");
  await waitFor(() => expect((s.edge("Check stock", "Step")?.data as { axis?: string })?.axis).toBe("h"));
  const added = s.doc();
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(FLOW));
  act(() => void redo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(added));
  await waitFor(() => expect((s.edge("Check stock", "Step")?.data as { axis?: string })?.axis).toBe("h"));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(FLOW));
  // The same names again, from a port drag: no axis left behind.
  s.view().dispatch({ changes: { from: s.doc().length, insert: "Step\n\nCheck stock > Step\n" } });
  await waitFor(() => expect(s.edge("Check stock", "Step")).toBeTruthy());
  expect((s.edge("Check stock", "Step")!.data as { axis?: string }).axis).toBeUndefined();
});

test("N2 a rename carries the axis over; a save keeps only the axes of lines in the text", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "End Done");
  await plusAdd(s, "Step Check stock", "Add the next step to the right");
  await waitFor(() => expect((s.edge("Check stock", "Step")?.data as { axis?: string })?.axis).toBe("h"));
  await waitFor(() => expect(s.node("Step Step")).not.toBeNull());
  fireEvent.doubleClick(s.node("Step Step")!);
  await userEvent.type(await s.field("Rename Step"), "Pack{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 4 });
  await waitFor(() => expect((s.edge("Check stock", "Pack")?.data as { axis?: string })?.axis).toBe("h"));
  // The line goes from the text: the next save leaves its axis out.
  const at = s.doc().indexOf("Check stock > Pack");
  act(() => s.view().dispatch({ changes: { from: at, to: at + "Check stock > Pack".length, insert: "" } }));
  await waitFor(() => {
    // The text changed, so the save writes both files together.
    const all = callsTo("write_diagram");
    const saved = all[all.length - 1]?.layout as string | undefined;
    expect(saved).toBeTruthy();
    expect(JSON.parse(saved!).axes).toBeUndefined();
  }, { timeout: 3000 });
});

// ----- N3: the group-title band

const GROUPED = lines('diagram flow "x"', "A", "Review {", "  B", "}");
const GROUPED_AT = JSON.stringify({ version: 1, nodes: { A: { x: 0, y: 0 }, B: { x: 300, y: 200 } } });

test("N3 the rename band is the title's width; past it a double-click offers Add here; over it the cursor is text", async () => {
  const s = setup(GROUPED, GROUPED_AT);
  await shown(s, "Step B");
  const area = s.box("\u0000group:Review");
  // Well right of the title "Review": Add here.
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 0, y: 0 }, flow: { x: area.x + area.w - 10, y: area.y + 14 } }));
  expect(await screen.findByRole("menu", { name: "Add here" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("menu", { name: "Add here" }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu", { name: "Add here" })).toBeNull());
  // Over the title: the text cursor shows.
  const vp = s.container.querySelector(".react-flow__viewport") as HTMLElement;
  const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(vp.style.transform)!;
  fireEvent.pointerMove(s.container.querySelector(".react-flow__pane")!, { clientX: Number(m[1]) + area.x + 30, clientY: Number(m[2]) + area.y + 14 });
  await waitFor(() => expect(s.canvasEl().classList.contains("is-on-group-title")).toBe(true));
  fireEvent.pointerMove(s.container.querySelector(".react-flow__pane")!, { clientX: Number(m[1]) + area.x + area.w - 10, clientY: Number(m[2]) + area.y + 14 });
  await waitFor(() => expect(s.canvasEl().classList.contains("is-on-group-title")).toBe(false));
});

test("live: the group title field sits exactly over the title, and the title hides while it is edited", async () => {
  const s = setup(GROUPED, GROUPED_AT);
  await shown(s, "Step B");
  const area = s.box("\u0000group:Review");
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 0, y: 0 }, flow: { x: area.x + 30, y: area.y + 14 } }));
  const box = await s.field("Group name");
  const wrap = box.closest(".inline-edit-wrap") as HTMLElement;
  // The title is at (12, 8) in its area, 16 px tall; the 24 px field is centred on it, its text over the title's.
  expect(parseFloat(wrap.style.left)).toBe(area.x + 8);
  expect(parseFloat(wrap.style.top)).toBe(area.y + 4);
  const title = s.container.querySelector('.flow-area[aria-label="Group Review"] .flow-area-name') as HTMLElement;
  await waitFor(() => expect(title.style.visibility).toBe("hidden"));
  fireEvent.keyDown(box, { key: "Escape" });
  await waitFor(() => expect(title.style.visibility).toBe(""));
});

// ----- N4, N5, N6

test("N4 Esc on an untouched timeline ghost takes its date notice with it", async () => {
  const TL = lines('diagram timeline "Launch"', "2026-10-01: Kickoff", "2026-10-20: Ship");
  const s = setup(TL);
  await shown(s, "Event Ship");
  const ship = s.box("Ship");
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 900, y: 300 }, flow: { x: ship.x + 400, y: 100 } }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /Event/ }));
  await waitFor(() => expect(s.strip().textContent).toContain("The axis has no date there"));
  fireEvent.keyDown(await s.field("Name the new event"), { key: "Escape" });
  await waitFor(() => expect(s.strip().textContent).not.toContain("The axis has no date there"));
});

test("N5 a refused start date goes back to From, even from Until", async () => {
  const TL = lines('diagram timeline "Launch"', "2026-10-05 to 2026-10-20: Build");
  const s = setup(TL);
  await shown(s, "Period Build");
  fireEvent.doubleClick(s.node("Period Build")!.querySelector('[data-part="date"]')!);
  const from = (await screen.findByLabelText("From")) as HTMLInputElement;
  const until = screen.getByLabelText("Until") as HTMLInputElement;
  fireEvent.change(from, { target: { value: "" } });
  until.focus();
  fireEvent.keyDown(until, { key: "Enter" });
  expect((await screen.findByRole("alert")).textContent).toBe("Pick a date, for example 2026-10-19.");
  await waitFor(() => expect(document.activeElement).toBe(from));
});

test("N6 a long label that wraps opens at its full height", async () => {
  const proto = HTMLTextAreaElement.prototype;
  const was = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 64 });
  try {
    const s = setup(FLOW, FLOW_AT);
    await shown(s, "Step Check stock");
    fireEvent.doubleClick(s.node("Step Check stock")!);
    const box = await s.field("Rename Check stock");
    expect(box.style.height).toBe("64px");
  } finally {
    if (was) Object.defineProperty(proto, "scrollHeight", was);
    else delete (proto as unknown as { scrollHeight?: number }).scrollHeight;
  }
});

// ----- the coordinator's live check

test("live: the first-node hint hides while the first shape's ghost is shown", async () => {
  const s = setup('diagram flow "New"\n');
  expect(await screen.findByText("Add the first node")).toBeTruthy();
  s.press("s");
  await s.field("Name the new step");
  expect(screen.queryByText("Add the first node")).toBeNull();
  expect(s.container.querySelector(".flow-first-node-line")).toBeNull();
  fireEvent.keyDown(await s.field("Name the new step"), { key: "Escape" });
  expect(await screen.findByText("Add the first node")).toBeTruthy();
});

test("live: a +'s tip shows after a moment beside the +, never over the shape it adds next to", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  fireEvent.pointerMove(s.node("Step Check stock")!, { clientX: 10, clientY: 10 });
  const plus = await screen.findByRole("button", { name: "Add the next step below" });
  expect(plus.getAttribute("title")).toBeNull();
  fireEvent.pointerEnter(plus);
  expect(s.container.querySelector(".flow-plus-tip")).toBeNull();
  const tip = (await waitFor(() => {
    const t = s.container.querySelector(".flow-plus-tip");
    expect(t).not.toBeNull();
    return t;
  }, { timeout: 2000 })) as HTMLElement;
  expect(tip.textContent).toBe("Click: add the next step here, connected. Drag: draw a line.");
  const src = s.box("Check stock");
  // Out past the + below, clear of the shape above it (round 2 places every side; see N-A).
  expect(parseFloat(tip.style.top)).toBeGreaterThanOrEqual(src.y + src.h);
  fireEvent.pointerLeave(plus);
  await waitFor(() => expect(s.container.querySelector(".flow-plus-tip")).toBeNull());
});

// ----- round 2 (diag-36b-review.md)

/** The tip's box at its widest (260 px, two lines: 42 px), from its anchor and the shift its style gives it. */
function tipBox(tip: HTMLElement) {
  const W = 260;
  const H = 42;
  const m = /translate\(([-\d.]+)%, ([-\d.]+)%\)/.exec(tip.style.transform) ?? ["", "0", "0"];
  return { x: parseFloat(tip.style.left) + (Number(m[1]) / 100) * W, y: parseFloat(tip.style.top) + (Number(m[2]) / 100) * H, w: W, h: H };
}
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

test("N-A on every side the + tip covers neither the shape nor its +", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  const src = s.box("Check stock");
  for (const side of ["above", "to the right", "below", "to the left"]) {
    fireEvent.pointerMove(s.node("Step Check stock")!, { clientX: 10, clientY: 10 });
    const plus = await screen.findByRole("button", { name: `Add the next step ${side}` });
    fireEvent.pointerEnter(plus);
    const tip = (await waitFor(() => {
      const t = s.container.querySelector(".flow-plus-tip");
      expect(t).not.toBeNull();
      return t;
    }, { timeout: 2000 })) as HTMLElement;
    const box = tipBox(tip);
    const p = { x: parseFloat(plus.style.left) - 10, y: parseFloat(plus.style.top) - 10, w: 20, h: 20 };
    expect(overlaps(box, src), side).toBe(false);
    expect(overlaps(box, p), side).toBe(false);
    fireEvent.pointerLeave(plus);
    await waitFor(() => expect(s.container.querySelector(".flow-plus-tip")).toBeNull());
  }
});

test("N-H a + that goes while hovered leaves no tip waiting: the next hover waits again", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "Step Check stock");
  fireEvent.pointerMove(s.node("Step Check stock")!, { clientX: 10, clientY: 10 });
  fireEvent.pointerEnter(await screen.findByRole("button", { name: "Add the next step below" }));
  await waitFor(() => expect(s.container.querySelector(".flow-plus-tip")).not.toBeNull(), { timeout: 2000 });
  // A field opens: the + goes with no pointerleave.
  fireEvent.doubleClick(s.node("Step Check stock")!);
  fireEvent.keyDown(await s.field("Rename Check stock"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Rename Check stock" })).toBeNull());
  fireEvent.pointerMove(s.node("Step Check stock")!, { clientX: 10, clientY: 10 });
  fireEvent.pointerEnter(await screen.findByRole("button", { name: "Add the next step below" }));
  expect(s.container.querySelector(".flow-plus-tip")).toBeNull();
});

test("N-E the group field's text starts where the title's text did, in the title's font", async () => {
  const s = setup(GROUPED, GROUPED_AT);
  await shown(s, "Step B");
  const area = s.box("\u0000group:Review");
  act(() => canvas.props!.onPaneDoubleClick!({ screen: { x: 0, y: 0 }, flow: { x: area.x + 30, y: area.y + 14 } }));
  const box = await s.field("Group name");
  const wrap = box.closest(".inline-edit-wrap") as HTMLElement;
  expect(wrap.classList.contains("flow-group-title-edit")).toBe(true);
  // jsdom applies no stylesheet: the rules are read from the CSS itself.
  const rule = (css: string, sel: string) => {
    const at = css.indexOf(`${sel} {`);
    expect(at, sel).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };
  const field = rule(canvasCss, ".flow-group-title-edit .inline-edit");
  const title = rule(tabCss, ".flow-area-name");
  const pad = Number(/padding-left: (\d+)px/.exec(field)![1]);
  // The title's name starts after its 12 px inset, its 16 px icon and its 6 px gap; the field has a 1 px border.
  expect(parseFloat(wrap.style.left) + 1 + pad).toBe(area.x + 12 + 16 + 6);
  expect(/left: 12px/.test(title) && /gap: 6px/.test(title)).toBe(true);
  for (const decl of ["font: var(--font-small);", "font-weight: 600;"]) {
    expect(title).toContain(decl);
    expect(field).toContain(decl);
  }
});

test("N-B a + line deleted, then drawn again, starts with no kept axis", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "End Done");
  await plusAdd(s, "Step Check stock", "Add the next step to the right");
  await waitFor(() => expect((s.edge("Check stock", "Step")?.data as { axis?: string })?.axis).toBe("h"));
  const line = s.edge("Check stock", "Step")!.id;
  // Only the line: the new shape, selected when it was kept, is let go first.
  act(() => canvas.props!.onSelect!([]));
  act(() => canvas.props!.onLineSelect!([line]));
  s.press("Delete");
  await waitFor(() => expect(s.doc()).not.toContain("Check stock > Step"));
  // Undo brings the line back with its axis: the delete and the axis are one step.
  const deleted = s.doc();
  act(() => void undo(s.view()));
  await waitFor(() => expect((s.edge("Check stock", "Step")?.data as { axis?: string })?.axis).toBe("h"));
  act(() => void redo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(deleted));
  act(() => canvas.props!.onConnectPorts!({ node: "Check stock", port: "r" }, { node: "Step", port: "l" }, false));
  await waitFor(() => expect(s.edge("Check stock", "Step")).toBeTruthy());
  expect((s.edge("Check stock", "Step")!.data as { axis?: string }).axis).toBeUndefined();
});

test("N-B a + line typed away from the text loses its axis too", async () => {
  const s = setup(FLOW, FLOW_AT);
  await shown(s, "End Done");
  await plusAdd(s, "Step Check stock", "Add the next step to the right");
  await waitFor(() => expect((s.edge("Check stock", "Step")?.data as { axis?: string })?.axis).toBe("h"));
  const at = s.doc().indexOf("Check stock > Step");
  act(() => s.view().dispatch({ changes: { from: at, to: at + "Check stock > Step".length, insert: "" } }));
  await waitFor(() => expect(s.edge("Check stock", "Step")).toBeUndefined());
  const end = s.doc().length;
  act(() => s.view().dispatch({ changes: { from: end, insert: "Check stock > Step\n" } }));
  await waitFor(() => expect(s.edge("Check stock", "Step")).toBeTruthy());
  expect((s.edge("Check stock", "Step")!.data as { axis?: string }).axis).toBeUndefined();
});

test("N-C a layout with a bad axis key opens, ignores it, and renames still work", async () => {
  const layout = JSON.stringify({ version: 1, nodes: { "Order in": { x: 100, y: 100 }, "Check stock": { x: 100, y: 300 }, Done: { x: 100, y: 380 } }, axes: { foo: "v", "[1,2]": "h", [axisKey("Check stock", "Done")]: "v" } });
  const s = setup(`${FLOW}\nCheck stock > Done\n`, layout);
  await shown(s, "End Done");
  await waitFor(() => expect((s.edge("Check stock", "Done")?.data as { axis?: string })?.axis).toBe("v"));
  fireEvent.doubleClick(s.node("Step Check stock")!);
  await userEvent.type(await s.field("Rename Check stock"), "Check{Enter}", { initialSelectionStart: 0, initialSelectionEnd: 11 });
  await waitFor(() => expect(s.doc()).toContain("Check > Done"));
  await waitFor(() => expect((s.edge("Check", "Done")?.data as { axis?: string })?.axis).toBe("v"));
});

test("N-F a later refusal of a date does not send focus back to an older field", async () => {
  const TL = lines('diagram timeline "Launch"', "2026-10-05 to 2026-10-20: Build");
  const s = setup(TL);
  await shown(s, "Period Build");
  fireEvent.doubleClick(s.node("Period Build")!.querySelector('[data-part="date"]')!);
  const from = (await screen.findByLabelText("From")) as HTMLInputElement;
  const until = screen.getByLabelText("Until") as HTMLInputElement;
  fireEvent.change(until, { target: { value: "2026-10-01" } });
  until.focus();
  fireEvent.keyDown(until, { key: "Enter" });
  await screen.findByRole("alert");
  // Fixed, then the text changes under the field: the write is refused, and focus stays where the user is.
  fireEvent.change(until, { target: { value: "2026-10-30" } });
  from.focus();
  // A line with an error: the drawing stays, the field stays, and the write is refused.
  act(() => s.view().dispatch({ changes: { from: s.doc().length, insert: "not a date: x\n" } }));
  await waitFor(() => expect(s.container.querySelector(".flow-canvas.is-stale")).not.toBeNull());
  fireEvent.keyDown(from, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("alert").textContent).not.toBe("The end is before the start: pick a later end date."));
  await waitFor(() => expect(document.activeElement).toBe(from));
});
