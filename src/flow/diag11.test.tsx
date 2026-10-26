// Diagram step 11 (board DiagramColourLabels, ADR 0019 amendment): colour and labels on the canvas. A shape, a
// selection, a line and a group title each have Colour in their menu, with the six palette colours and Clear colour;
// a pick is one exact text edit and one undo step. A name typed or added that another shape has keeps the shape:
// it gets the next free name and `label:` with the words typed.
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

const ORDERS = lines(
  'diagram flow "Order handling"',
  "Charge card",
  "Paid? [decision]",
  "Retry",
  "Dispatch {",
  "  Ship",
  "}",
  "",
  "Charge card > Paid?",
  "Paid? > Retry: no",
  "Paid? > Ship: yes",
);
const AT = JSON.stringify({ version: 1, nodes: { "Charge card": { x: 40, y: 40 }, "Paid?": { x: 260, y: 40 }, Retry: { x: 260, y: 260 }, Ship: { x: 520, y: 60 } } });

function setup(text = ORDERS, layout: string | null = AT) {
  routeInvoke({ read_diagram: () => ({ text, layout }), write_diagram: () => null, write_diagram_layout: () => null });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="d11" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const doc = () => view().state.doc.toString();
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  const shape = (label: string) => utils.container.querySelector<HTMLElement>(`.react-flow__node [aria-label="${label}"]`);
  const edge = (i: number) => utils.container.querySelector(`.react-flow__edge[data-id="edge:${i}"]`) as HTMLElement;
  const title = (g: string) => utils.container.querySelector<HTMLElement>(`.flow-area[aria-label="Group ${g}"] .flow-area-name`);
  const canvasEl = () => utils.container.querySelector(".flow-canvas") as HTMLElement;
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(canvasEl(), { key, ...init });
  const strip = () => utils.container.querySelector(".flow-pane-draw .flow-strip") as HTMLElement;
  const field = (label: string) => screen.findByRole("textbox", { name: label }) as Promise<HTMLInputElement>;
  return { ...utils, view, doc, node, shape, edge, title, press, strip, field, canvasEl };
}
type Setup = ReturnType<typeof setup>;

async function oneUndo(s: Setup, before: string) {
  act(() => {
    undo(s.view());
  });
  await waitFor(() => expect(s.doc()).toBe(before));
}

/** A menu's rows as "label|hint" (checked ones end in " ✓"), in order. */
function rowsOf(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>(":scope > div > [role^=menuitem]")].map((m) => {
    const key = m.querySelector(".menu-shortcut")?.textContent ?? m.querySelector(".menu-hint")?.textContent ?? "";
    return `${m.getAttribute("aria-label")}${key ? `|${key}` : ""}${m.getAttribute("aria-checked") === "true" ? " ✓" : ""}`;
  });
}

async function pickColour(menu: HTMLElement, colour: string) {
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Colour" }));
  const sub = await screen.findByRole("menu", { name: "Colour" });
  await userEvent.click(within(sub).getByRole("menuitemcheckbox", { name: colour }));
}

test("a shape's menu has Colour: six swatches and Clear colour, each saying what it means and the word the file gets", async () => {
  const s = setup();
  await waitFor(() => expect(s.node("Step Retry")).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.node("Step Retry")!, { clientX: 300, clientY: 300 });
  const menu = await screen.findByRole("menu", { name: "Retry actions" });
  expect(rowsOf(menu)).toContain("Colour|none");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Colour" }));
  const sub = await screen.findByRole("menu", { name: "Colour" });
  expect(rowsOf(sub)).toEqual([
    "Accent|color: accent",
    "Info|color: info",
    "Success|color: success",
    "Warning|color: warning",
    "Danger|color: danger",
    "Muted|color: muted",
    "Clear colour ✓",
  ]);
  expect(within(sub).getByRole("menuitemcheckbox", { name: "Danger" }).textContent).toContain("Failure, error, data at risk");
  await userEvent.click(within(sub).getByRole("menuitemcheckbox", { name: "Danger" }));
  await waitFor(() => expect(s.doc()).toBe(ORDERS.replace("\nRetry\n", "\nRetry [color: danger]\n")));
  await oneUndo(s, ORDERS);
});

test("a coloured shape draws its palette tokens and keeps them selected; Clear colour drops the brackets", async () => {
  const text = ORDERS.replace("\nRetry\n", "\nRetry [step, color: danger]\n");
  const s = setup(text);
  await waitFor(() => expect(s.node("Step Retry")).not.toBeNull(), { timeout: 4000 });
  const el = s.shape("Step Retry")!;
  expect(el.style.getPropertyValue("--fnode-fill")).toBe("var(--c-danger-subtle)");
  expect(el.style.getPropertyValue("--fnode-stroke")).toBe("var(--c-danger-text)");
  expect(el.classList.contains("fnode-col")).toBe(true);
  fireEvent.contextMenu(s.node("Step Retry")!, { clientX: 300, clientY: 300 });
  const menu = await screen.findByRole("menu", { name: "Retry actions" });
  expect(rowsOf(menu)).toContain("Colour|Danger");
  await pickColour(menu, "Clear colour");
  await waitFor(() => expect(s.doc()).toBe(ORDERS.replace("\nRetry\n", "\nRetry [step]\n")));
});

test("one pick on several shapes is one edit list and one undo step", async () => {
  const s = setup();
  await waitFor(() => expect(s.node("Step Retry")).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onSelect!(["Retry", "Charge card"]));
  fireEvent.contextMenu(s.node("Step Retry")!, { clientX: 300, clientY: 300 });
  const menu = await screen.findByRole("menu", { name: "2 selected" });
  await pickColour(menu, "Warning");
  await waitFor(() => expect(s.doc()).toBe(ORDERS.replace("\nRetry\n", "\nRetry [color: warning]\n").replace("Charge card\n", "Charge card [color: warning]\n")));
  await oneUndo(s, ORDERS);
});

test("a line's menu colours the line after its label, as eraser.io writes it", async () => {
  const s = setup();
  await waitFor(() => expect(s.edge(1)).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.edge(1), { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "Line actions" });
  await pickColour(menu, "Warning");
  await waitFor(() => expect(s.doc()).toBe(ORDERS.replace("Paid? > Retry: no", "Paid? > Retry: no [color: warning]")));
  await waitFor(() => expect(s.edge(1).querySelector("path.react-flow__edge-path")?.getAttribute("style") ?? "").toContain("var(--c-warning-text)"));
  expect(s.edge(1).querySelector("path.react-flow__edge-path")?.getAttribute("marker-end")).toContain("arrow-warning");
  await oneUndo(s, ORDERS);
});

test("a group title's menu colours the group's border and title", async () => {
  const s = setup();
  await waitFor(() => expect(s.title("Dispatch")).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.title("Dispatch")!, { clientX: 520, clientY: 40 });
  const menu = await screen.findByRole("menu", { name: "Group Dispatch" });
  await pickColour(menu, "Muted");
  await waitFor(() => expect(s.doc()).toBe(ORDERS.replace("Dispatch {", "Dispatch [color: muted] {")));
  await waitFor(() => expect(s.container.querySelector<HTMLElement>('.flow-area[aria-label="Group Dispatch"]')!.style.getPropertyValue("--col-edge")).toBe("var(--c-text-subtle)"));
  expect(tabCss).toMatch(/\.flow-area\.is-col\s*\{[^}]*border-color:\s*var\(--col-edge\)/);
});

test("where a colour cannot be written, Colour is off and says why", async () => {
  const SEQ = lines('diagram sequence "Pay"', "participant App", "participant Api", "App -> Api: charge");
  const s = setup(SEQ, null);
  await waitFor(() => expect(s.node("Participant App")).not.toBeNull(), { timeout: 4000 });
  fireEvent.contextMenu(s.node("Participant App")!, { clientX: 300, clientY: 200 });
  const menu = await screen.findByRole("menu", { name: "App actions" });
  const colour = within(menu).getByRole("menuitem", { name: "Colour" });
  expect(colour.hasAttribute("disabled")).toBe(true);
  expect(colour.getAttribute("title")).toBe("Colour a participant in the code, for example participant App [color: info].");
});

test("a name typed that another shape has keeps the shape: the next free name and label:, lines unchanged", async () => {
  const s = setup();
  await waitFor(() => expect(s.node("Step Charge card")).not.toBeNull(), { timeout: 4000 });
  fireEvent.doubleClick(s.node("Step Charge card")!);
  const box = await s.field("Rename Charge card");
  await userEvent.clear(box);
  await userEvent.type(box, "Retry{Enter}");
  const after = ORDERS.replace("Charge card\n", "Retry 2 [label: Retry]\n").replace("Charge card > Paid?", "Retry 2 > Paid?");
  await waitFor(() => expect(s.doc()).toBe(after));
  // It shows the words typed; lines name it by its name.
  await waitFor(() => expect(s.node("Step Retry")).not.toBeNull());
  expect(s.strip().textContent).toContain("Retry is already a shape's name, so this one is written Retry 2 [label: Retry]");
  await oneUndo(s, ORDERS);
});

test("editing a labelled shape: free words become its name and the label goes; taken words change only the label", async () => {
  const text = lines('diagram flow "F"', "Retry", "Retry 2 [label: Retry]", "Charge", "", "Charge > Retry 2");
  const s = setup(text, null);
  await waitFor(() => expect(s.container.querySelector('.react-flow__node[data-id="Retry 2"]')).not.toBeNull(), { timeout: 4000 });
  const two = () => s.container.querySelector<HTMLElement>('.react-flow__node[data-id="Retry 2"], .react-flow__node[data-id="Try again"]')!;
  fireEvent.doubleClick(two());
  let box = await s.field("Rename Retry 2");
  expect(box.value).toBe("Retry");
  await userEvent.clear(box);
  await userEvent.type(box, "Charge{Enter}");
  const relabelled = text.replace("Retry 2 [label: Retry]", "Retry 2 [label: Charge]");
  await waitFor(() => expect(s.doc()).toBe(relabelled));
  fireEvent.doubleClick(two());
  box = await s.field("Rename Retry 2");
  await userEvent.clear(box);
  await userEvent.type(box, "Try again{Enter}");
  await waitFor(() => expect(s.doc()).toBe(lines('diagram flow "F"', "Retry", "Try again", "Charge", "", "Charge > Try again")));
  await oneUndo(s, relabelled);
});

test("a taken name in a sequence is still refused: participants take no label", async () => {
  const SEQ = lines('diagram sequence "Pay"', "participant App", "participant Api", "App -> Api: charge");
  const s = setup(SEQ, null);
  await waitFor(() => expect(s.node("Participant App")).not.toBeNull(), { timeout: 4000 });
  fireEvent.doubleClick(s.node("Participant App")!);
  const box = await s.field("Rename App");
  await userEvent.clear(box);
  await userEvent.type(box, "Api{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("Api is already used.");
  expect(s.doc()).toBe(SEQ);
});

test("a shape added with a taken name is written with a free name and label:, placed clear of group frames", async () => {
  const text = lines('diagram flow "F"', "Retry", "Dispatch {", "  Ship", "  Pack", "}");
  // The middle of the view falls inside Dispatch's frame (board note: a third Retry landed on it).
  const layout = JSON.stringify({ version: 1, nodes: { Retry: { x: 0, y: 0 }, Ship: { x: 300, y: 300 }, Pack: { x: 900, y: 700 } } });
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  try {
    const s = setup(text, layout);
    await waitFor(() => expect(s.title("Dispatch")).not.toBeNull(), { timeout: 4000 });
    s.press("s");
    const box = await s.field("Name the new step");
    await userEvent.clear(box);
    await userEvent.type(box, "Retry{Enter}");
    await waitFor(() => expect(s.doc()).toContain("Retry 2 [step, label: Retry]"));
    await waitFor(() => expect(canvas.props!.nodes.find((n) => n.id === "Retry 2")).toBeTruthy());
    const area = canvas.props!.nodes.find((n) => n.id === "\u0000group:Dispatch")!;
    const placed = canvas.props!.nodes.find((n) => n.id === "Retry 2")!;
    const a = { x: area.position.x, y: area.position.y, w: area.initialWidth ?? 0, h: area.initialHeight ?? 0 };
    const p = { x: placed.position.x, y: placed.position.y, w: placed.initialWidth ?? 0, h: placed.initialHeight ?? 0 };
    const overlaps = p.x < a.x + a.w && p.x + p.w > a.x && p.y < a.y + a.h && p.y + p.h > a.y;
    expect(overlaps).toBe(false);
  } finally {
    rect.mockRestore();
  }
});

test("a selected labelled shape's strip shows its words and the name lines use", async () => {
  const text = lines('diagram flow "F"', "Retry", "Retry 2 [label: Retry]");
  const s = setup(text, null);
  await waitFor(() => expect(s.container.querySelector('.react-flow__node[data-id="Retry 2"]')).not.toBeNull(), { timeout: 4000 });
  act(() => canvas.props!.onSelect!(["Retry 2"]));
  await waitFor(() => expect(s.strip().textContent).toContain("Retry, named Retry 2"));
});
