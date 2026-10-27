// Diagram build 3, round 2 (the live check in the release app and diag-78-build-rereview.md N1 to N5): the first
// topic of an empty map is its central idea; the central idea and a topic keep their words in the middle; a topic
// drag starts from a press on its label (WebKitGTK event order) and from under a box selection; N1 to N5.
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { LangClient } from "../lang/client";
import { mockEditorDom } from "../test/editor";
import { routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import canvasCss from "../styles/flow-canvas.css?raw";
import tabCss from "../styles/flow-tab.css?raw";
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

const MAP = lines(
  'diagram mindmap "Q4 plan"',
  "root Q4 plan",
  "  Diagrams",
  "    New kinds",
  "    Inline editing",
  "  Redis",
  "    Pub/Sub",
  "    Key browser",
  "  Release",
  "    Docs",
  "    Installer",
  "  Servers",
  "",
  "Installer > Servers",
);

function setup(initial: string) {
  routeInvoke({ read_diagram: () => ({ text: initial, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="d78f" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const field = (label: string) => screen.findByRole("textbox", { name: label }) as Promise<HTMLInputElement>;
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const select = (n: string) => act(() => canvas.props!.onSelect!([n]));
  const box = (n: string) => {
    const g = canvas.props!.nodes.find((x) => x.id === n)!;
    return { x: g.position.x, y: g.position.y, w: g.initialWidth ?? 0, h: g.initialHeight ?? 0 };
  };
  const row = (i: number) => (canvas.props!.edges.find((e) => e.id === `edge:${i}`)!.data as { y: number }).y;
  const mid = (n: string) => box(n).x + box(n).w / 2;
  const screenAt = (x: number, y: number) => {
    const t = (utils.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
    const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(t) ?? ["", "0", "0", "1"];
    return { clientX: Number(m[1]) + x * Number(m[3]), clientY: Number(m[2]) + y * Number(m[3]) };
  };
  const edgeEl = (i: number) => utils.container.querySelector(`.react-flow__edge[data-id="edge:${i}"]`) as HTMLElement;
  return { ...utils, view, doc, node, press, field, strip, select, box, row, mid, screenAt, edgeEl, canvasEl };
}
type Setup = ReturnType<typeof setup>;
const shown = (s: Setup, label: string) => waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });

/** A CSS rule's body, by its exact selector list. */
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

test("live 1: on an empty map R then Enter opens the central idea, written `root <name>` and sized to its words", async () => {
  const s = setup(lines('diagram mindmap "x"'));
  await waitFor(() => expect(s.container.querySelector(".flow-first-node")).not.toBeNull());
  s.press("r");
  s.press("Enter");
  const name = await s.field("Name the new central idea");
  await userEvent.clear(name);
  await userEvent.type(name, "Q4 plan{Enter}");
  await waitFor(() => expect(s.doc()).toBe(lines('diagram mindmap "x"', "root Q4 plan")));
  await shown(s, "Central idea Q4 plan");
  // Its first subtopic then goes under it, one level in.
  s.select("Q4 plan");
  s.press("Tab");
  const sub = await s.field("Name the new topic");
  await userEvent.clear(sub);
  await userEvent.type(sub, "Redis{Enter}");
  await waitFor(() => expect(s.doc()).toBe(lines('diagram mindmap "x"', "root Q4 plan", "  Redis")));
});

test("live 1: the empty map's + button opens the central idea too", async () => {
  const s = setup(lines('diagram mindmap "x"'));
  await waitFor(() => expect(s.container.querySelector(".flow-first-node")).not.toBeNull());
  fireEvent.click(s.container.querySelector(".flow-first-node")!);
  await s.field("Name the new central idea");
});

test("live 2: the central idea's and a topic's words sit in the middle of their pill", () => {
  const body = rule(canvasCss, ".fnode-root .fkind-inside,\n.fnode-topic .fkind-inside");
  expect(body).toContain("align-items: center");
  expect(body).toContain("justify-content: center");
});

test("live 3: a press on a topic's label with the button held through the moves (WebKitGTK's order) drags the topic", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  const label = s.node("Topic Redis")!.querySelector(".fnode-name") as HTMLElement;
  const b = s.box("Redis");
  const t = s.box("Release");
  const start = s.screenAt(b.x + b.w / 2, b.y + b.h / 2);
  fireEvent.pointerDown(label, { button: 0, buttons: 1, pointerId: 7, isPrimary: true, ...start });
  fireEvent(label, new Event("gotpointercapture", { bubbles: true }));
  // Slowly: a pixel or two at a time.
  for (let k = 1; k <= 4; k++) fireEvent.pointerMove(label, { buttons: 1, pointerId: 7, clientX: start.clientX + k, clientY: start.clientY + k });
  await waitFor(() => expect(s.strip().textContent).toContain("Drag onto a topic to make it the parent, or between two topics to place it there."));
  fireEvent.pointerMove(label, { buttons: 1, pointerId: 7, ...s.screenAt(t.x + t.w / 2, t.y + t.h / 2) });
  await waitFor(() => expect(s.container.querySelector(".flow-drop-tag")?.textContent).toBe("Drop: subtopic of Release"));
  expect(s.container.querySelector(".react-flow__selection")).toBeNull();
  fireEvent.pointerUp(label, { button: 0, buttons: 0, pointerId: 7, ...s.screenAt(t.x + t.w / 2, t.y + t.h / 2) });
  await waitFor(() => expect(s.doc()).toContain("  Release\n    Docs\n    Installer\n    Redis\n      Pub/Sub\n"));
});

test("live 3: on a map, sequence or timeline a box selection's frame takes no presses, so a topic under it still drags", () => {
  expect(rule(tabCss, ".flow-canvas.is-fixed .react-flow__nodesselection-rect")).toContain("pointer-events: none");
});

test("live 3: the canvas of a map is marked fixed", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  expect(s.canvasEl().classList.contains("is-fixed")).toBe(true);
});

test("N1 when the topic a ghost was added to leaves the text, the ghost stays drawn under its field", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  s.select("Redis");
  s.press("Tab");
  await s.field("Name the new topic");
  const from = s.doc().indexOf("  Redis\n");
  act(() => s.view().dispatch({ changes: { from, to: from + "  Redis\n    Pub/Sub\n    Key browser\n".length, insert: "" } }));
  await waitFor(() => expect(s.node("Topic Pub/Sub")).toBeNull());
  expect(s.container.querySelector(".flow-ghost")).not.toBeNull();
});

test("N2 Delete with the central idea and topics selected says that the central idea stays", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  act(() => canvas.props!.onSelect!(["Q4 plan", "Servers"]));
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(MAP.replace("  Servers\n", "").replace("Installer > Servers\n", "")));
  await waitFor(() => expect(s.strip().textContent).toContain("The central idea stays. F2 renames it."));
});

test("N3 Tab with several topics or a line selected still says to select one topic", async () => {
  const s = setup(MAP);
  await shown(s, "Topic Redis");
  act(() => canvas.props!.onSelect!(["Redis", "Release"]));
  expect(fireEvent.keyDown(s.canvasEl(), { key: "Tab" })).toBe(false);
  await waitFor(() => expect(s.strip().textContent).toContain("Select a topic first: Tab adds a subtopic under it."));
});
