// Task 15: the board limit through FlowTab (Global Constraints, Decisions 13, 21 and 27): A5's 50-frame, 10,000-shape
// board with 1,000 sketches at the caps opens, takes 30 typed characters in frame 25, and holds no more than one entry
// per frame. A guard over Tasks 1 to 12 (the TDD exception); B3 reuses its pattern for ER boards.
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { board, FRAMES, LINKS, TYPED_FRAME } from "../../lang/flow/fixtures/bigBoard";
import { bigBoardLayoutFile, SKETCH_COUNT } from "../../lang/flow/fixtures/bigBoardLayout";
import { MAX_BOARD_SHAPES } from "../../lang/flow/model";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import { LAYOUT_SAVE_MAX, parseBoardLayout, utf8Length } from "./boardLayout";
import { boardFrameId, FRAME_PICTURE_TYPE, inFrameId, SKETCH_PICTURE_TYPE } from "./boardScene";
import { pictureSvgOf } from "../../test/framePictures";
import { SKETCH_LAYER_ID } from "./sketches";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The full board takes seconds to draw in jsdom; this one test gets its own limit.
vi.setConfig({ testTimeout: 180_000 });

const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
  return {
    ...real,
    default: (p: DiagramCanvasProps) => {
      canvas.props = p;
      return real.default(p);
    },
  };
});

// FlowTab's board scene, kept so the test can count what its memos hold.
const scenes = vi.hoisted(() => [] as { memoSize(): number; boxMemoSize(): number; sketchMemoSize(): number }[]);
vi.mock("./boardScene", async (load) => {
  const real = await load<typeof import("./boardScene")>();
  return {
    ...real,
    createBoardScene: (look: Parameters<typeof real.createBoardScene>[0]) => {
      const s = real.createBoardScene(look);
      scenes.push(s);
      return s;
    },
  };
});

// The shared per-node ResizeObserver: with static frames drawn as pictures at the fit, measuring one node
// at a time is quick again (34 s here, 681 MB peak for the whole run).
beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  scenes.length = 0;
});

const WAIT = { timeout: 60_000 };
const TYPED = "a full board takes these keys!";

test("a_full_board_opens_and_types_without_growth", async () => {
  expect(TYPED).toHaveLength(30);
  const saved = { text: board(), layout: bigBoardLayoutFile() as string | null, writes: 0 };
  routeInvoke({
    read_diagram: () => ({ text: saved.text, layout: saved.layout }),
    write_diagram: (a) => {
      saved.text = a.text as string;
      saved.layout = a.layout as string;
      saved.writes++;
      return null;
    },
    write_diagram_layout: (a) => {
      saved.layout = a.layout as string;
      saved.writes++;
      return null;
    },
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>,
  );
  const nodes = () => canvas.props?.nodes ?? [];
  const typedFrame = boardFrameId(`Area ${TYPED_FRAME}`);

  // Open: every frame drawn static (none selected on a board of many). At the fit body text is far, so the 1,000
  // sketches draw as a few pictures, with no node of their own.
  await waitFor(() => expect(nodes().filter((n) => n.type === "boardFrame")).toHaveLength(FRAMES), WAIT);
  const tiles = () => nodes().filter((n) => n.type === SKETCH_PICTURE_TYPE);
  await waitFor(() => expect(tiles().length).toBeGreaterThan(0), WAIT);
  expect(tiles().length).toBeLessThan(10);
  expect(nodes().filter((n) => n.id === SKETCH_LAYER_ID || n.parentId === SKETCH_LAYER_ID)).toHaveLength(0);
  // At the fit (text far) each static frame in view is one picture of its 200 shapes, and no static line is drawn (Plan
  // F Decision 7). The board is too wide for the least zoom, so it opens at its start (`fitFromStart`), and only the
  // frames in view are drawn: the rest push their box node alone.
  const previewsNow = () => nodes().filter((n) => n.type === FRAME_PICTURE_TYPE);
  await waitFor(() => expect(previewsNow().length).toBeLessThan(FRAMES), WAIT);
  const previews = previewsNow();
  expect(previews.length).toBeGreaterThan(0);
  // A run from the board's start, each a whole frame.
  expect(previews.map((n) => n.parentId)).toEqual(previews.map((_, k) => boardFrameId(`Area ${k}`)));
  expect(nodes().filter((n) => n.parentId?.startsWith("\u0000board:"))).toHaveLength(previews.length);
  for (const n of previews) {
    const svg = pictureSvgOf(n);
    expect((svg.match(/<g data-(?:node|area)=/g) ?? []).length).toBe(MAX_BOARD_SHAPES / FRAMES);
    expect((svg.match(/<g data-edge=/g) ?? []).length).toBe(LINKS);
  }
  expect(canvas.props?.edges ?? []).toHaveLength(0);

  // Frame 25 shown in the pane and selected, as a search landing in it does.
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  await waitFor(() => expect(utils.container.querySelector(".cm-editor")).not.toBeNull(), WAIT);
  const end = () => view().state.doc.toString().indexOf(`diagram flow "Area ${TYPED_FRAME + 1}"`) - 2;
  act(() => view().dispatch({ selection: EditorSelection.cursor(end()), userEvent: "select.search" }));
  // Live: frame 25's shapes are drawn with bare names, and its box is the live one.
  await waitFor(() => expect(nodes().some((n) => n.id === "Step 0")).toBe(true), WAIT);
  await waitFor(() => expect(nodes().filter((n) => n.parentId === typedFrame)).toHaveLength(0), WAIT);
  // The frames in view stay pictures (frame 25 is live, not one of them), and the only lines drawn are frame 25's.
  await waitFor(() => expect(previewsNow().length).toBeGreaterThan(0), WAIT);
  expect(previewsNow().length).toBeLessThan(FRAMES);
  expect(previewsNow().some((n) => n.parentId === typedFrame)).toBe(false);
  expect(canvas.props?.edges).toHaveLength(LINKS);

  const before = new Map(nodes().map((n) => [n.id, n]));
  const edgesBefore = new Map((canvas.props?.edges ?? []).map((e) => [e.id, e]));
  /** Another frame's shape, group area or line holder, or a picture of the sketch layer. */
  const isOther = (n: Node) => n.type === SKETCH_PICTURE_TYPE || (!!n.parentId?.startsWith("\u0000board:") && n.parentId !== typedFrame);

  // 30 characters typed into frame 25's last link label, one keystroke at a time.
  for (const ch of TYPED) {
    const at = end();
    act(() => view().dispatch({ changes: { from: at, insert: ch }, selection: EditorSelection.cursor(at + 1), userEvent: "input.type" }));
  }
  await waitFor(() => expect(canvas.props?.edges.some((e) => (e.data as { label?: string } | undefined)?.label?.endsWith(TYPED))).toBe(true), WAIT);

  // Every frame but 25 (its box, shapes and lines) and every sketch keeps its very node object.
  let others = 0;
  for (const n of nodes()) {
    if (!isOther(n)) continue;
    expect(n, n.id).toBe(before.get(n.id));
    others++;
  }
  // Each other frame in view's one picture, and the sketch layer's pictures.
  expect(others).toBe(previewsNow().length + tiles().length);
  for (let k = 0; k < FRAMES; k++) {
    if (k === TYPED_FRAME) continue;
    const id = boardFrameId(`Area ${k}`);
    expect(nodes().find((n) => n.id === id)).toBe(before.get(id));
  }

  // No other frame draws a line of its own: its lines are in its picture, kept above.
  const typedIn = inFrameId(`Area ${TYPED_FRAME}`, "");
  for (const e of canvas.props?.edges ?? []) expect(e.id.startsWith("\u0000in:") && !e.id.startsWith(typedIn), e.id).toBe(false);
  for (const e of edgesBefore.values()) expect(e.id.startsWith("\u0000in:"), e.id).toBe(false);

  // One scene, one entry per frame in each memo; the client holds at most a doc per frame.
  expect(scenes).toHaveLength(1);
  expect(scenes[0].memoSize()).toBe(FRAMES);
  expect(scenes[0].boxMemoSize()).toBe(FRAMES);
  expect(scenes[0].sketchMemoSize()).toBe(SKETCH_COUNT);
  expect([...client.heldFlow.keys()]).toEqual(["flow:board"]);
  expect(client.heldFlow.get("flow:board")!.size).toBeLessThanOrEqual(FRAMES);

  // The save: the typed text, and the layout with every frame and sketch under the budget.
  await waitFor(() => expect(saved.text).toBe(board(TYPED)), WAIT);
  const layout = saved.layout!;
  expect(utf8Length(layout)).toBeLessThan(LAYOUT_SAVE_MAX);
  const reread = parseBoardLayout(layout, Array.from({ length: FRAMES }, (_, k) => ({ title: `Area ${k}`, kind: "flow" as const })));
  expect(reread.frames.size).toBe(FRAMES);
  expect(reread.sketches).toHaveLength(SKETCH_COUNT);
  expect(utils.container.textContent).not.toContain("Layout not saved");
  // The 30 keys are typed in one synchronous run, so the save delay ends once: one write.
  expect(saved.writes).toBe(1);
});
