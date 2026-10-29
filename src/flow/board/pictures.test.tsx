// Plan F Task 7 (Decision 7) on the board: tiny frames draw as cached pictures of themselves. At open no static shape
// mounts; a far frame is one <img>; a theme switch redraws every picture and an edit only its own (Review Focus 4); a
// faded or clash frame is pictured faded where it draws; a pictured frame's double-click and right-click only select
// (B2 C3).
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Node, NodeProps, NodeTypes, ReactFlowInstance } from "@xyflow/react";
import { type ComponentType, createElement } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import type { ExportPalette, ExportTheme } from "../../diagram/export/palette";
import { NODE_TOKENS } from "../../diagram/types";
import { LangClient } from "../../lang/client";
import { mockEditorDom } from "../../test/editor";
import { pictureShapes, pictureSvgOf } from "../../test/framePictures";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import type { SceneIcon } from "../flowScene";
import FlowTab from "../FlowTab";
import { resetIcons, setIconTheme } from "../icons";
import { boardFrameId, duplicateFrameId, FRAME_PICTURE_TYPE, inFrameId, isStaticId } from "./boardScene";
import { shownRange } from "./frameView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

// Two literal palettes (P11): jsdom has no theme stylesheet, so the canvas's palette is the theme's literal one here.
const palette = (p: string): ExportPalette => ({
  surface: `#${p}0101`,
  canvas: `#${p}0202`,
  text: `#${p}0303`,
  subtle: `#${p}0404`,
  border: `#${p}0505`,
  type: `#${p}0606`,
  keyword: `#${p}0707`,
  nodes: Object.fromEntries(Object.keys(NODE_TOKENS).map((k, i) => [k, { fill: `#${p}1${i.toString(16)}00`, stroke: `#${p}2${i.toString(16)}00` }])) as ExportPalette["nodes"],
  iconTile: `#${p}1010`,
  group: `#${p}1111`,
  groupTint: `#${p}1212`,
  strongBorder: `#${p}1313`,
  panel: `#${p}1414`,
  muted: `#${p}1515`,
  faint: `#${p}1616`,
  keyMark: `#${p}1717`,
});
const PALETTES: Record<ExportTheme, ExportPalette> = { light: palette("e1"), dark: palette("d1") };
vi.mock("../../diagram/export/palette", async (load) => {
  const real = await load<typeof import("../../diagram/export/palette")>();
  return { ...real, exportPalette: (t: ExportTheme = "light") => PALETTES[t] };
});

// The icon loader answers when the test says so.
const icons = vi.hoisted(() => ({ asked: [] as { names: string[]; resolve(m: Map<string, unknown>): void }[] }));
vi.mock("../flowScene", async (load) => {
  const real = await load<typeof import("../flowScene")>();
  return { ...real, loadSceneIcons: (names: string[]) => new Promise((resolve) => icons.asked.push({ names, resolve })) };
});

// The real canvas draws; the test keeps its props and instance, every node id it was ever handed, and each render of
// a static shape (a node type's render counter).
const canvas = vi.hoisted(() => ({
  props: null as DiagramCanvasProps | null,
  instance: null as ReactFlowInstance | null,
  ever: new Set<string>(),
  staticRenders: 0,
  wrapped: new WeakMap<object, NodeTypes>(),
  /** Called with every node list the canvas is handed. */
  watch: null as ((nodes: Node[]) => void) | null,
}));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  const counted = (types: NodeTypes): NodeTypes => {
    let w = canvas.wrapped.get(types);
    if (!w) {
      w = Object.fromEntries(
        Object.entries(types).map(([k, C]) => [
          k,
          (p: NodeProps) => {
            if (k !== "boardFrame" && k !== FRAME_PICTURE_TYPE && isStaticId(p.id)) canvas.staticRenders++;
            return createElement(C as ComponentType<NodeProps>, p);
          },
        ]),
      );
      canvas.wrapped.set(types, w);
    }
    return w;
  };
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      for (const n of p.nodes) canvas.ever.add(n.id);
      canvas.watch?.(p.nodes);
      return real.default({
        ...p,
        nodeTypes: p.nodeTypes && counted(p.nodeTypes),
        onInit: (i) => {
          canvas.instance = i;
          p.onInit?.(i);
        },
      });
    },
  };
});

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
beforeEach(() => {
  resetIcons();
  setIconTheme("light");
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  canvas.instance = null;
  canvas.ever = new Set();
  canvas.staticRenders = 0;
  canvas.watch = null;
  icons.asked.length = 0;
  resetIcons();
});

/** Ten flowcharts in two rows of five, 700 apart: the fit lands where their text is far. */
const TITLES = Array.from({ length: 10 }, (_, i) => `F${i}`);
const flowFrame = (t: string) => `diagram flow "${t}"\nStart ${t}\nEnd ${t}\nStart ${t} > End ${t}\n`;
const BOARD = TITLES.map(flowFrame).join("\n");
const at = (i: number) => ({ x: (i % 5) * 700, y: Math.floor(i / 5) * 700 });
const entry = (i: number, nodes: Record<string, { x: number; y: number }>) => ({ at: at(i), nodes, style: "modern", direction: "TB" });
const LAYOUT = JSON.stringify({
  version: 2,
  frames: Object.fromEntries(TITLES.map((t, i) => [t, entry(i, { [`Start ${t}`]: { x: 0, y: 0 }, [`End ${t}`]: { x: 0, y: 140 } })])),
  sketches: [],
});

function setup(text = BOARD, layout: string | null = LAYOUT) {
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
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  const nodes = () => canvas.props?.nodes ?? [];
  const pictureOf = (frameId: string) => nodes().find((n) => n.parentId === frameId && n.type === FRAME_PICTURE_TYPE);
  const frameEl = (frameId: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === frameId) ?? null;
  const isSelected = (frameId: string) => frameEl(frameId)?.querySelector(".board-frame-title")?.getAttribute("aria-current") === "true";
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  return { ...utils, saved, nodes, pictureOf, frameEl, isSelected, view };
}

/** Every frame pictured, with no static shape on the canvas. */
async function allPictured(s: ReturnType<typeof setup>, ids: string[]) {
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  await waitFor(() => {
    for (const id of ids) expect(s.pictureOf(id), id).toBeDefined();
  });
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
const srcOf = (s: ReturnType<typeof setup>, id: string) => (s.pictureOf(id)!.data as { url: string }).url;
const frameIds = TITLES.map(boardFrameId);

test("opening_at_the_fit_mounts_no_static_shape", async () => {
  // A cloud frame with an icon: its picture comes without it, then once with it.
  const text = `${BOARD}\ndiagram cloud "Net"\nQueue [icon: aws-sqs]\n`;
  const layout = JSON.parse(LAYOUT);
  layout.frames.Net = { at: { x: 0, y: 1400 }, nodes: { Queue: { x: 0, y: 0 } }, style: "modern", direction: "TB" };
  const s = setup(text, JSON.stringify(layout));
  const ids = [...frameIds, boardFrameId("Net")];
  await allPictured(s, ids);
  await waitFor(() => expect(icons.asked.length).toBeGreaterThan(0));
  const before = srcOf(s, boardFrameId("Net"));
  expect(pictureSvgOf(s.pictureOf(boardFrameId("Net"))!)).not.toContain("<use ");
  const LOGO = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z" fill="#3f8624"/></svg>')}`;
  await act(async () => {
    for (const a of icons.asked) a.resolve(new Map<string, SceneIcon>(a.names.includes("aws-sqs") ? [["aws-sqs", { url: LOGO }]] : []) as Map<string, unknown>);
  });
  await waitFor(() => expect(srcOf(s, boardFrameId("Net"))).not.toBe(before));
  expect(pictureSvgOf(s.pictureOf(boardFrameId("Net"))!)).toContain("<use ");
  await settle();
  // Before and after the icons, no static shape was ever handed to the canvas or drawn.
  for (const id of canvas.ever) expect(id.startsWith("\u0000in:") && !id.endsWith("\u0000\u0000picture"), JSON.stringify(id)).toBe(false);
  expect(canvas.staticRenders).toBe(0);
  expect(canvas.instance!.getViewport().zoom).toBeLessThan(0.46);
});

test("a_far_frame_draws_as_one_img", async () => {
  const s = setup();
  await allPictured(s, frameIds);
  await waitFor(() => expect(s.frameEl(boardFrameId("F3"))).not.toBeNull());
  const id = s.pictureOf(boardFrameId("F3"))!.id;
  const el = [...s.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === id)!;
  expect(el).toBeTruthy();
  const imgs = el.querySelectorAll("img");
  expect(imgs).toHaveLength(1);
  expect(imgs[0].className).toBe("board-picture-img");
  expect(imgs[0].getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(imgs[0].getAttribute("alt")).toBe("");
  // The frame's own children on the canvas: its picture and nothing else; no static line is drawn.
  expect(s.nodes().filter((n) => n.parentId === boardFrameId("F3")).map((n) => n.type)).toEqual([FRAME_PICTURE_TYPE]);
  expect(canvas.props!.edges).toEqual([]);
  // Its shapes stand in the picture where the frame's layout puts them.
  const box = s.nodes().find((n) => n.id === boardFrameId("F3"))!.position;
  const shapes = pictureShapes(s.pictureOf(boardFrameId("F3"))!, box);
  expect(shapes).toHaveLength(2);
  expect(shapes[1].y - shapes[0].y).toBe(140);
});

test("a_theme_switch_redraws_every_picture", async () => {
  // Review Focus 4: Dark, then Light, with ten frames pictured: every picture redraws in Light, none stays Dark.
  setIconTheme("dark");
  const s = setup();
  await allPictured(s, frameIds);
  for (const id of frameIds) {
    const svg = pictureSvgOf(s.pictureOf(id)!);
    expect(svg, id).toMatch(/#d1/);
    expect(svg, id).not.toMatch(/#e1/);
  }
  // Controller ruling (fix round 1): no frame is ever its box alone during the switch; each Dark picture stays until its
  // Light one replaces it.
  const boxOnly = new Set<string>();
  canvas.watch = (nodes) => {
    for (const id of frameIds) if (!nodes.some((n) => n.parentId === id && n.type === FRAME_PICTURE_TYPE)) boxOnly.add(id);
  };
  act(() => setIconTheme("light"));
  await waitFor(() => {
    for (const id of frameIds) {
      const p = s.pictureOf(id);
      expect(p, id).toBeDefined();
      const svg = pictureSvgOf(p!);
      expect(svg, id).toMatch(/#e1/);
      expect(svg, id).not.toMatch(/#d1/);
    }
  });
  // And on the page: every img's src decodes to Light's colours.
  await waitFor(() => {
    const imgs = [...s.container.querySelectorAll<HTMLImageElement>("img.board-picture-img")];
    expect(imgs).toHaveLength(10);
    for (const img of imgs) {
      const url = img.getAttribute("src")!;
      const svg = new TextDecoder().decode(Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0)));
      expect(svg).toMatch(/#e1/);
      expect(svg).not.toMatch(/#d1/);
    }
  });
  expect([...boxOnly]).toEqual([]);
});

test("a_frame_that_stops_being_live_never_shows_its_old_picture", async () => {
  // boardDetail stepForms keeps a form that is already the target without asking `ready`: the live frame is always
  // `real` in the drawn forms, so a frame that was live and edited turns into its new picture only once that is built,
  // and shows its real shapes until then, never its picture from before the edit.
  const s = setup();
  await allPictured(s, frameIds);
  const f2 = boardFrameId("F2");
  const old = srcOf(s, f2);
  fireEvent.click(await screen.findByRole("button", { name: "Flowchart F2" }));
  await waitFor(() => expect(s.nodes().some((n) => n.id === "Start F2")).toBe(true));
  // Live: real shapes, no picture under the frame.
  expect(s.pictureOf(f2)).toBeUndefined();
  await waitFor(() => expect(s.container.querySelector(".cm-editor")).not.toBeNull());
  // The pane shows F2 now.
  await waitFor(() => {
    const r = shownRange(s.view().state);
    expect(r && s.view().state.sliceDoc(r.from, r.to)).toContain('diagram flow "F2"');
  });
  const text = s.view().state.doc.toString();
  const end = text.indexOf("Start F2 > End F2") + "Start F2 > End F2".length;
  act(() => s.view().dispatch({ changes: { from: end, insert: ": ok" }, userEvent: "input.type" }));
  await waitFor(() => expect(s.saved.text).toContain("Start F2 > End F2: ok"));
  // From here on, F2 is never drawn with the picture it had before the edit.
  const shown: string[] = [];
  canvas.watch = (nodes) => {
    const p = nodes.find((n) => n.parentId === f2 && n.type === FRAME_PICTURE_TYPE);
    if (p) shown.push((p.data as { url: string }).url);
  };
  fireEvent.click(await screen.findByRole("button", { name: "Flowchart F3" }));
  await waitFor(() => expect(s.nodes().some((n) => n.id === "Start F3")).toBe(true));
  await waitFor(() => expect(s.pictureOf(f2)).toBeDefined());
  await settle();
  expect(shown.length).toBeGreaterThan(0);
  expect(shown).not.toContain(old);
  expect((pictureSvgOf(s.pictureOf(f2)!).match(/data-part="chip"/g) ?? []).length).toBe(1);
});

test("an_edit_redraws_only_its_own_picture", async () => {
  // Review Focus 4: with nothing selected the code pane shows frame F0, which is pictured: an edit there redraws F0's
  // picture and leaves every other picture as it was.
  const s = setup();
  await allPictured(s, frameIds);
  await waitFor(() => expect(s.container.querySelector(".cm-editor")).not.toBeNull());
  await settle();
  const before = new Map(frameIds.map((id) => [id, s.pictureOf(id)!]));
  const label = (id: string) => (pictureSvgOf(s.pictureOf(id)!).match(/data-part="chip"/g) ?? []).length;
  expect(label(boardFrameId("F0"))).toBe(0);
  const text = s.view().state.doc.toString();
  const end = text.indexOf("Start F0 > End F0") + "Start F0 > End F0".length;
  act(() => s.view().dispatch({ changes: { from: end, insert: ": ok" }, userEvent: "input.type" }));
  await waitFor(() => expect(s.saved.text).toContain("Start F0 > End F0: ok"));
  // F0 is still a picture, drawn again with its new label.
  await waitFor(() => expect(s.pictureOf(boardFrameId("F0"))).not.toBe(before.get(boardFrameId("F0"))));
  await waitFor(() => expect(label(boardFrameId("F0"))).toBe(1));
  await settle();
  // Every other frame keeps its very picture node, and so its image.
  for (const id of frameIds.slice(1)) expect(s.pictureOf(id), id).toBe(before.get(id));
});

test("a_faded_or_clash_frame_pictures_faded_at_its_drawn_places", async () => {
  // F1 repeats F0's title: a clash frame, drawn faded with its shapes in a row (it has no layout of its own).
  const text = BOARD.replace('diagram flow "F1"', 'diagram flow "F0"');
  const s = setup(text);
  const clash = duplicateFrameId(1);
  await allPictured(s, [boardFrameId("F0"), clash, boardFrameId("F2")]);
  const pic = s.pictureOf(clash)!;
  expect(pic.className).toContain("board-faded");
  expect(s.pictureOf(boardFrameId("F2"))!.className).not.toContain("board-faded");
  // Its picture stands its shapes where its real children stand: zoomed in they are real, out again a picture.
  const boxOf = () => s.nodes().find((n) => n.id === clash)!.position;
  const realKids = () => s.nodes().filter((n) => n.parentId === clash && n.type !== FRAME_PICTURE_TYPE);
  // Zoomed in on the clash frame where it is now (its own layout may still move it when it comes back).
  await waitFor(async () => {
    const box = boxOf();
    const v = canvas.instance!.getViewport();
    if (v.zoom !== 1 || v.x !== 100 - box.x || v.y !== 100 - box.y)
      await act(async () => {
        await canvas.instance!.setViewport({ x: 100 - box.x, y: 100 - box.y, zoom: 1 });
      });
    expect(realKids()).toHaveLength(2);
  });
  await settle();
  const real = realKids().map((n) => ({ x: boxOf().x + n.position.x, y: boxOf().y + n.position.y, cls: n.className ?? "" }));
  for (const r of real) expect(r.cls).toContain("board-faded");
  await act(async () => {
    await canvas.instance!.setViewport({ x: 0, y: 0, zoom: 0.2 });
  });
  await waitFor(() => expect(realKids()).toHaveLength(0));
  await waitFor(() => expect(s.pictureOf(clash)).toBeDefined());
  const drawn = pictureShapes(s.pictureOf(clash)!, boxOf());
  expect(drawn).toHaveLength(2);
  for (const r of real) expect(drawn.some((d) => Math.abs(d.x - r.x) <= 1 && Math.abs(d.y - r.y) <= 1), JSON.stringify(r)).toBe(true);

  // A frame whose text has an error draws its last good drawing faded: pictured faded too.
  await waitFor(() => expect(s.container.querySelector(".cm-editor")).not.toBeNull());
  // With nothing selected the pane shows F0: its line to a shape it does not have is an error.
  await waitFor(() => expect(s.pictureOf(boardFrameId("F0"))).toBeDefined());
  expect(s.pictureOf(boardFrameId("F0"))!.className).not.toContain("board-faded");
  const doc = s.view().state.doc.toString();
  const from = doc.indexOf("Start F0 > End F0") + "Start F0 > ".length;
  act(() => s.view().dispatch({ changes: { from, to: from + "End F0".length, insert: "Nowhere" }, userEvent: "input.type" }));
  await waitFor(() => expect(s.pictureOf(boardFrameId("F0"))?.className).toContain("board-faded"));
  // Its last good drawing: both shapes where they were.
  expect(pictureShapes(s.pictureOf(boardFrameId("F0"))!, s.nodes().find((n) => n.id === boardFrameId("F0"))!.position)).toHaveLength(2);
});

// ----- B2 C3 on a pictured frame: its shapes are not drawn one by one, so a double-click or a right-click selects.

const SHOP = 'diagram er "Shop"\ncustomers {\n  id int pk\n  email text\n}\n';
const SALES = 'diagram er "Sales"\norders {\n  id int pk\n  total numeric\n}\n';
const ER_LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Shop: { at: { x: 0, y: 0 }, nodes: { customers: { x: 0, y: 0 } }, style: "modern", direction: "TB" },
    Sales: { at: { x: 4000, y: 0 }, nodes: { orders: { x: 0, y: 0 } }, style: "modern", direction: "TB" },
  },
  sketches: [],
});

test("a_double_click_on_a_pictured_erd_only_selects_it", async () => {
  const s = setup([SHOP, SALES].join("\n"), ER_LAYOUT);
  await allPictured(s, [boardFrameId("Shop"), boardFrameId("Sales")]);
  // Shop live (a double-click on the pane needs a live frame), Sales pictured.
  fireEvent.click((await screen.findAllByRole("button", { name: "ER diagram Shop" }))[0]);
  await waitFor(() => expect(s.nodes().some((n) => n.id === "customers")).toBe(true));
  expect(s.pictureOf(boardFrameId("Sales"))).toBeDefined();
  const box = s.nodes().find((n) => n.id === boardFrameId("Sales"))!.position;
  const [card] = pictureShapes(s.pictureOf(boardFrameId("Sales"))!, box);
  // On the card's second row, where a real card would open the column's field.
  const flow = { x: card.x + 30, y: card.y + 47 + 22 };
  const screenAt = canvas.instance!.flowToScreenPosition(flow);
  const fields = () => s.container.querySelectorAll("input, textarea").length;
  const before = fields();
  act(() => canvas.props!.onPaneDoubleClick!({ screen: screenAt, flow }));
  await waitFor(() => expect(s.isSelected(boardFrameId("Sales"))).toBe(true));
  await waitFor(() => expect(canvas.props!.selection).toEqual(["orders"]));
  await settle();
  // Selected, and no field opened on it.
  expect(fields()).toBe(before);
  expect(screen.queryByRole("textbox", { name: /^Column|^Table/ })).toBeNull();
});

test("a_right_click_on_a_pictured_frame_offers_the_frame_menu", async () => {
  // The frame's menu is its bar (the selected frame's tab and its buttons): a right-click on a pictured frame selects
  // the frame alone, with no shape selected and no shape menu.
  const s = setup();
  await allPictured(s, frameIds);
  const box = s.nodes().find((n) => n.id === boardFrameId("F6"))!.position;
  const [shape] = pictureShapes(s.pictureOf(boardFrameId("F6"))!, box);
  const p = canvas.instance!.flowToScreenPosition({ x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 });
  fireEvent.contextMenu(s.frameEl(boardFrameId("F6"))!, { clientX: p.x, clientY: p.y });
  await waitFor(() => expect(s.isSelected(boardFrameId("F6"))).toBe(true));
  await settle();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(canvas.props!.selection ?? []).toEqual([]);
});

// Every picture node carries what the scene gives it; nothing else on the canvas is a picture.
test("pictures_are_frame_children_only", async () => {
  const s = setup();
  await allPictured(s, frameIds);
  const pics = s.nodes().filter((n: Node) => n.type === FRAME_PICTURE_TYPE);
  expect(pics.map((n) => n.parentId).sort()).toEqual([...frameIds].sort());
  for (const n of pics) expect(n.id).toBe(inFrameId(n.parentId!.slice("\u0000board:".length), "\u0000picture"));
});

test("pictured_frames_draw_png_images_and_no_canvas", async () => {
  // Task 9 fixes 2 and 3: WebKit draws an <img> of an SVG as vector again at each new zoom, and makes each <canvas> on
  // the page a compositing layer of its own. Where images decode (the WebView), each picture is drawn once into a
  // bitmap kept as a PNG: once that is in, every pictured frame is an <img> of a PNG, none of an SVG, and the board
  // holds no <canvas> at all.
  const proto = HTMLImageElement.prototype;
  const kept = Object.getOwnPropertyDescriptor(proto, "decode");
  Object.defineProperty(proto, "decode", { configurable: true, value: () => Promise.resolve() });
  const natural = ["naturalWidth", "naturalHeight"].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
  for (const [k] of natural) Object.defineProperty(proto, k, { configurable: true, get: () => 400 });
  const draws: unknown[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return {
      canvas: this,
      clearRect() {},
      drawImage: (...a: unknown[]) => void draws.push(a),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    } as unknown as RenderingContext;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  try {
    const s = setup();
    await allPictured(s, frameIds);
    await waitFor(() => expect(s.container.querySelectorAll('img.board-picture-img[src^="data:image/png"]')).toHaveLength(10));
    expect(s.container.querySelectorAll('img[src^="data:image/svg"]')).toHaveLength(0);
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
    for (const id of frameIds) expect((s.pictureOf(id)!.data as { url?: string }).url, id).toBeUndefined();
    expect(draws.length).toBeGreaterThanOrEqual(10);
    // A zoom in to real shapes and back: the page holds what it held (no node, picture or canvas left behind), and
    // no picture is drawn again.
    const nodesAtFit = s.container.querySelectorAll(".react-flow__node").length;
    const drawsAtFit = draws.length;
    const fit = canvas.instance!.getViewport();
    await act(async () => {
      await canvas.instance!.setViewport({ x: 0, y: 0, zoom: 1 });
    });
    await waitFor(() => expect(s.container.querySelectorAll(".board-picture-img")).toHaveLength(0));
    await act(async () => {
      await canvas.instance!.setViewport(fit);
    });
    await waitFor(() => expect(s.container.querySelectorAll('img.board-picture-img[src^="data:image/png"]')).toHaveLength(10));
    await settle();
    expect(s.container.querySelectorAll(".react-flow__node")).toHaveLength(nodesAtFit);
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
    expect(draws).toHaveLength(drawsAtFit);
  } finally {
    if (kept) Object.defineProperty(proto, "decode", kept);
    else delete (proto as unknown as Record<string, unknown>).decode;
    for (const [k, d] of natural) if (d) Object.defineProperty(proto, k, d);
  }
});

test("in_the_webview_the_open_builds_no_svg_picture", async () => {
  // Task 9 fix 4: round 3 built every frame's SVG at open in one task (118 to 164 ms live) and showed them until their
  // bitmaps were in, as vector WebKit paints again on every repaint. Where images decode (the WebView), the open builds
  // nothing at once: each frame is its box until its PNG is in, and no SVG <img> is ever on the page.
  const proto = HTMLImageElement.prototype;
  const kept = Object.getOwnPropertyDescriptor(proto, "decode");
  Object.defineProperty(proto, "decode", { configurable: true, value: () => Promise.resolve() });
  const natural = ["naturalWidth", "naturalHeight"].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
  for (const [k] of natural) Object.defineProperty(proto, k, { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return {
      canvas: this,
      clearRect() {},
      drawImage() {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    } as unknown as RenderingContext;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  let svgShown = 0;
  const watch = new MutationObserver(() => {
    svgShown += document.querySelectorAll('img[src^="data:image/svg"]').length;
  });
  watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  try {
    const s = setup();
    // The first paint: every frame's box, no picture yet.
    await waitFor(() => expect(canvas.instance).not.toBeNull());
    await waitFor(() => expect(s.container.querySelectorAll('img.board-picture-img[src^="data:image/png"]')).toHaveLength(10));
    await settle();
    expect(svgShown).toBe(0);
    for (const id of frameIds) expect((s.pictureOf(id)!.data as { url?: string }).url, id).toBeUndefined();
  } finally {
    watch.disconnect();
    if (kept) Object.defineProperty(proto, "decode", kept);
    else delete (proto as unknown as Record<string, unknown>).decode;
    for (const [k, d] of natural) if (d) Object.defineProperty(proto, k, d);
  }
});
