// Diagram step 7 (board DiagramMindMap, rulings of 25 Oct): the mind map on the canvas. Tab adds a subtopic and
// Shift+Tab the next topic, each a ghost with its name ready (M1); Enter, F2 and a double-click edit. Ctrl or Alt+Up
// and Down move a topic among its siblings, a drag re-parents it with a drop target (M4); the branch dot and Ctrl+/
// fold (M3); Ctrl+Shift+L draws a relationship with no label prompt and a branch takes no label (M2); Delete takes
// a topic with its subtopics. Each write is one undo step and its exact text is checked.
import { redo, undo } from "@codemirror/commands";
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

function setup(initial = MAP) {
  routeInvoke({ read_diagram: () => ({ text: initial, layout: null }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="d78m" client={client} />
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
  /** A flow point on screen, through the viewport's transform (jsdom puts the pane at 0, 0). */
  const screenAt = (x: number, y: number) => {
    const t = (utils.container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
    const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(t) ?? ["", "0", "0", "1"];
    return { clientX: Number(m[1]) + x * Number(m[3]), clientY: Number(m[2]) + y * Number(m[3]) };
  };
  return { ...utils, view, doc, node, press, field, strip, select, box, screenAt, canvasEl };
}
type Setup = ReturnType<typeof setup>;
const shown = (s: Setup, label: string) => waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });
const settle = () => new Promise((r) => setTimeout(r, 30));

/** Drags topic `from` (by its middle) to flow point `to`, a few frames on the way. */
function dragTopic(s: Setup, from: string, to: { x: number; y: number }, release = true) {
  const b = s.box(from);
  const start = s.screenAt(b.x + b.w / 2, b.y + b.h / 2);
  fireEvent.pointerDown(s.node(`Topic ${from}`)!, { button: 0, pointerId: 1, ...start });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: start.clientX + 10, clientY: start.clientY + 10 });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(to.x, to.y) });
  if (release) fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(to.x, to.y) });
}

// ----- M1: Tab, Shift+Tab, Enter

test("M1 Tab opens a new subtopic with its name ready; Enter writes it after the last subtopic, one undo step", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  s.select("Redis");
  s.press("Tab");
  const name = await s.field("Name the new topic");
  expect(name.value).toBe("Topic");
  expect(name.selectionStart).toBe(0);
  expect(name.selectionEnd).toBe(5);
  // The ghost is drawn in the map's layout, beside Redis's other subtopics, and its field sits on it.
  const ghost = canvas.props!.nodes.find((n) => n.id === "\u0000ghost")!;
  expect(ghost).toBeTruthy();
  expect(ghost.position.x).toBe(s.box("Key browser").x);
  expect(ghost.position.y).toBeGreaterThan(s.box("Key browser").y);
  await userEvent.clear(name);
  await userEvent.type(name, "Search{Enter}");
  await waitFor(() => expect(s.doc()).toBe(MAP.replace("    Key browser\n", "    Key browser\n    Search\n")));
  await shown(s, "Topic Search");
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(MAP));
});

test("M1 Shift+Tab opens the next topic below, after the selected topic's branch; Esc keeps a typed name", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  s.select("Redis");
  s.press("Tab", { shiftKey: true });
  const name = await s.field("Name the new topic");
  await userEvent.clear(name);
  await userEvent.type(name, "Valkey{Escape}");
  await waitFor(() => expect(s.doc()).toBe(MAP.replace("    Key browser\n", "    Key browser\n  Valkey\n")));
  // The central idea has no siblings.
  s.select("Q4 plan");
  s.press("Tab", { shiftKey: true });
  await waitFor(() => expect(s.strip().textContent).toContain("The central idea has no siblings. Tab adds a topic to it."));
  expect(screen.queryByRole("textbox", { name: "Name the new topic" })).toBeNull();
});

test("M1 Esc on an untouched new topic adds nothing; Enter on a topic edits it rather than adding one", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  s.select("Redis");
  s.press("Tab");
  fireEvent.keyDown(await s.field("Name the new topic"), { key: "Escape" });
  await settle();
  expect(s.doc()).toBe(MAP);
  s.select("Redis");
  s.press("Enter");
  const rename = await s.field("Rename Redis");
  await userEvent.clear(rename);
  await userEvent.type(rename, "Valkey{Enter}");
  await waitFor(() => expect(s.doc()).toBe(MAP.replace("  Redis\n", "  Valkey\n")));
});

test("M1 Tab on a folded topic unfolds it first", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  s.select("Redis");
  s.press("/", { ctrlKey: true });
  await waitFor(() => expect(s.node("Topic Pub/Sub")).toBeNull());
  s.press("Tab");
  await s.field("Name the new topic");
  await shown(s, "Topic Pub/Sub");
});

// ----- M4: among siblings, and the drag

test("M4 Ctrl+Up and Alt+Down move a topic among its siblings with its subtopics, one undo step each", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  s.select("Redis");
  s.press("ArrowUp", { ctrlKey: true });
  const up = lines('diagram mindmap "Q4 plan"', "root Q4 plan", "  Redis", "    Pub/Sub", "    Key browser", "  Diagrams", "    New kinds", "    Inline editing", "  Release", "    Docs", "    Installer", "  Servers", "", "Installer > Servers");
  await waitFor(() => expect(s.doc()).toBe(up));
  s.press("ArrowDown", { altKey: true });
  await waitFor(() => expect(s.doc()).toBe(MAP));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(up));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(MAP));
  s.select("Diagrams");
  s.press("ArrowUp", { altKey: true });
  await waitFor(() => expect(s.strip().textContent).toContain("Diagrams is already the first under Q4 plan."));
  expect(s.doc()).toBe(MAP);
});

test("M4 the arrow keys select the next topic: down a column, out to a subtopic, back to the parent", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  s.select("Diagrams");
  s.press("ArrowDown");
  await waitFor(() => expect(s.strip().textContent).toContain("Redis"));
  s.press("ArrowRight");
  await waitFor(() => expect(s.strip().textContent).toContain("Pub/Sub"));
  s.press("ArrowLeft");
  await waitFor(() => expect(s.strip().textContent).toContain("Redis"));
  expect(s.doc()).toBe(MAP);
});

test("M4 a topic dragged onto another becomes its subtopic, with its subtopics, in one undo step", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  const target = s.box("Release");
  dragTopic(s, "Redis", { x: target.x + target.w / 2, y: target.y + target.h / 2 }, false);
  // While dragging: the target is outlined and the tag says where it goes; the dragged branch is faded.
  await waitFor(() => expect(s.container.querySelector(".flow-drop-tag")?.textContent).toBe("Drop: subtopic of Release"));
  expect(s.container.querySelector(".flow-drop-target")).not.toBeNull();
  expect(s.node("Topic Pub/Sub")!.classList.contains("is-drag-source")).toBe(true);
  expect(s.container.querySelector(".flow-drag-chip")?.textContent).toBe("Redis");
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(target.x + target.w / 2, target.y + target.h / 2) });
  const moved = lines('diagram mindmap "Q4 plan"', "root Q4 plan", "  Diagrams", "    New kinds", "    Inline editing", "  Release", "    Docs", "    Installer", "    Redis", "      Pub/Sub", "      Key browser", "  Servers", "", "Installer > Servers");
  await waitFor(() => expect(s.doc()).toBe(moved));
  expect(s.container.querySelector(".flow-drop-tag")).toBeNull();
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(MAP));
  act(() => void redo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(moved));
});

test("M4 a topic dragged just above a sibling goes before it", async () => {
  const s = setup();
  await shown(s, "Topic Docs");
  const docs = s.box("Docs");
  dragTopic(s, "Installer", { x: docs.x + docs.w / 2, y: docs.y - 6 }, false);
  await waitFor(() => expect(s.container.querySelector(".flow-drop-tag")?.textContent).toBe("Drop: before Docs"));
  expect(s.container.querySelector(".flow-drop-line")).not.toBeNull();
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(docs.x + docs.w / 2, docs.y - 6) });
  await waitFor(() => expect(s.doc()).toBe(MAP.replace("    Docs\n    Installer\n", "    Installer\n    Docs\n")));
});

test("M4 its own subtopic refuses it, Esc cancels, empty canvas moves nothing, the central idea stays", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  const own = s.box("Pub/Sub");
  dragTopic(s, "Redis", { x: own.x + own.w / 2, y: own.y + own.h / 2 }, false);
  await waitFor(() => expect(s.container.querySelector(".flow-drop-tag")?.textContent).toBe("A topic cannot go under its own subtopic."));
  expect(s.canvasEl().classList.contains("is-drop-refused")).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(own.x, own.y) });
  await settle();
  expect(s.doc()).toBe(MAP);
  expect(s.container.querySelector(".flow-drop-tag")).toBeNull();
  // Let go over its own subtopic: refused, nothing moves.
  dragTopic(s, "Redis", { x: own.x + own.w / 2, y: own.y + own.h / 2 });
  await settle();
  expect(s.doc()).toBe(MAP);
  dragTopic(s, "Redis", { x: -5000, y: -5000 });
  await settle();
  expect(s.doc()).toBe(MAP);
  await waitFor(() => expect(s.strip().textContent).toContain("Dropped on empty canvas: nothing moved."));
  const root = s.box("Q4 plan");
  const release = s.box("Release");
  fireEvent.pointerDown(s.node("Central idea Q4 plan")!, { button: 0, pointerId: 1, ...s.screenAt(root.x + 10, root.y + 10) });
  fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, ...s.screenAt(release.x, release.y) });
  fireEvent.pointerUp(window, { pointerId: 1, ...s.screenAt(release.x, release.y) });
  await waitFor(() => expect(s.strip().textContent).toContain("The central idea stays in the middle."));
  expect(s.doc()).toBe(MAP);
});

// ----- M3: fold

test("M3 the branch dot and Ctrl+/ fold a topic's subtopics: the dot counts them, the text keeps them", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  s.select("Redis");
  fireEvent.click(await screen.findByRole("button", { name: "Fold Redis" }));
  await waitFor(() => expect(s.node("Topic Pub/Sub")).toBeNull());
  expect(s.node("Topic Key browser")).toBeNull();
  const dot = await screen.findByRole("button", { name: "Unfold Redis: 2 subtopics hidden" });
  expect(dot.textContent).toBe("2");
  expect(s.doc()).toBe(MAP);
  // Folding is not an undo step: the text's history has nothing new.
  act(() => void undo(s.view()));
  await settle();
  expect(s.doc()).toBe(MAP);
  s.select("Redis");
  s.press("/", { ctrlKey: true });
  await shown(s, "Topic Pub/Sub");
  s.select("Servers");
  s.press("/", { ctrlKey: true });
  await waitFor(() => expect(s.strip().textContent).toContain("Servers has no subtopics to fold."));
});

// ----- M2: relationships and branches

test("M2 Ctrl+Shift+L, then a click on another topic, writes a relationship with no label prompt", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  s.select("Docs");
  s.press("L", { ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(s.strip().textContent).toContain("Relationship from Docs: click the topic it goes to."));
  s.select("Pub/Sub");
  await waitFor(() => expect(s.doc()).toBe(`${MAP}Docs > Pub/Sub\n`));
  await settle();
  expect(screen.queryByRole("textbox", { name: "Flow label" })).toBeNull();
});

test("M2 a branch takes no label: a double-click on it says so and writes nothing", async () => {
  const s = setup();
  await shown(s, "Topic Redis");
  const branch = canvas.props!.edges.find((e) => e.source === "Q4 plan" && e.target === "Redis")!;
  act(() => canvas.props!.onEdgeDoubleClick!(branch.id));
  await waitFor(() => expect(s.strip().textContent).toContain("Branches carry no label: a branch is Redis's place under Q4 plan."));
  expect(screen.queryByRole("textbox", { name: "Flow label" })).toBeNull();
  expect(s.doc()).toBe(MAP);
});

// ----- Delete

test("Delete takes a topic, its subtopics and the relationships that touch them, in one undo step", async () => {
  const s = setup();
  await shown(s, "Topic Release");
  s.select("Release");
  s.press("Delete");
  await waitFor(() => expect(s.doc()).toBe(lines('diagram mindmap "Q4 plan"', "root Q4 plan", "  Diagrams", "    New kinds", "    Inline editing", "  Redis", "    Pub/Sub", "    Key browser", "  Servers", "")));
  act(() => void undo(s.view()));
  await waitFor(() => expect(s.doc()).toBe(MAP));
});
