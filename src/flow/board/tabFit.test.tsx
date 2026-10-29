// Frame tab strips fit their room on screen (coordinator ruling on F1, 28 Oct): a strip never runs into the next
// frame's tab in its row. The title ends in an ellipsis first (Figma's frame label); AI Chat, then Code Editor, hide
// only when even they do not fit.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import boardCss from "../../styles/flow-board.css?raw";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { mockReactFlowDom } from "../../test/reactFlow";
import FlowTab from "../FlowTab";
import { boardFrameId } from "./boardScene";
import { roomCss, stripFit, stripParts } from "./tabRoom";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();

const canvas = vi.hoisted(() => ({ props: null as DiagramCanvasProps | null, instance: null as ReactFlowInstance | null }));
vi.mock("../../diagram/DiagramCanvas", async (load) => {
  const real = await load<typeof import("../../diagram/DiagramCanvas")>();
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

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  canvas.instance = null;
});

const BOARD = ['diagram flow "Checkout"\nCart\nPay\nCart > Pay\n', 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n'].join("\n");

/** Two frames in one row, Refund's tab `gap` board units to the right of Checkout's. */
function setup(gap: number) {
  const saved = {
    text: BOARD,
    layout: JSON.stringify({
      version: 2,
      frames: {
        Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
        Refund: { at: { x: gap, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
      },
      sketches: [],
    }),
  };
  routeInvoke({ read_diagram: () => saved, write_diagram: () => null, write_diagram_layout: () => null });
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={new LangClient(() => fakeWorker())} />
    </div>,
  );
  const frameEl = (key: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === boardFrameId(key))!;
  const strip = (key: string) => frameEl(key).querySelector<HTMLElement>(".board-frame-tab")!;
  const box = (key: string) => {
    const n = canvas.props!.nodes.find((x) => x.id === boardFrameId(key))!;
    return { x: n.position.x, w: Number(n.style?.width) };
  };
  const zoomTo = (zoom: number) => act(() => void canvas.instance!.setViewport({ x: 0, y: 200, zoom }));
  return { ...utils, frameEl, strip, box, zoomTo };
}
type Setup = ReturnType<typeof setup>;

/** Checkout selected and live, its strip on the page. */
async function checkout(s: Setup) {
  fireEvent.click(await screen.findByRole("button", { name: "Flowchart Checkout" }));
  await waitFor(() => expect(canvas.props!.nodes.some((n) => n.id === "Cart")).toBe(true));
  await waitFor(() => expect(within(s.strip("Checkout")).queryByRole("button", { name: "Flowchart Checkout" })).not.toBeNull());
}

const panes = (s: Setup) => within(s.strip("Checkout")).queryAllByRole("button", { name: /^(AI Chat|Code Editor)/ }).map((b) => b.textContent?.replace(/\d+$/, ""));

test("the_strip_room_rule_is_in_the_stylesheet", () => {
  // The strip's CSS room is its room in board units times min(zoom, 1): below 100 percent CSS px are screen px.
  // Only a strip with a tab in its way has a room (Task 9 fix 2): a max-width that follows the zoom lays the strip out
  // again on every zoom frame, so a strip with room to spare has none.
  expect(boardCss).toMatch(/\.board-frame-tab\.has-room \{\s*max-width: calc\(var\(--board-tab-room\) \* min\(var\(--rz-zoom, 1\), 1\) \* 1px\);/);
  const plain = boardCss.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]*\{[^}]*max-width[^}]*\}/g) ?? [];
  for (const rule of plain) if (rule.includes("board-frame-tab")) expect(rule.trim()).toMatch(/^\.board-frame-tab\.has-room \{/);
  // The kind word gives way first, then the name (F5: a frame label shows the frame's name).
  expect(boardCss).toMatch(/\.board-frame-kind \{[^}]*flex: 0 1000 auto;\s*min-width: 0;/);
  expect(boardCss).toMatch(/\.board-frame-name \{[^}]*flex: 0 1 auto;\s*min-width: 0;/);
});

test("a_cut_title_leaves_no_gap_and_keeps_one_character", () => {
  // jsdom lays nothing out, so this pins the rules: the title's spacing rides on its parts (no flex gap), the name's gap
  // is a spacer inside the name, and the kind word, which gives way first, keeps the icon's gap as its margin and
  // takes it when it goes.
  expect(boardCss).toMatch(/\.board-frame-title \{[^}]*overflow: hidden;\s*gap: 0;/);
  expect(boardCss).toMatch(/\.board-frame-name::before \{\s*content: "";\s*display: inline-block;\s*width: 6px;\s*\}/);
  expect(boardCss).toMatch(/\.board-frame-kind \{[^}]*margin-left: 6px;/);
  // The cut title's budget holds the icon, the name's gap and "C…" (two characters): no kind word (F5).
  const p = stripParts({ kind: "flow", title: "Checkout", problems: 0 }, 0);
  expect(p.titleMin).toBe(8 + 14 + 6 + 2 * 7 + 8);
});

test("two_tabs_that_would_overlap_at_33_percent_no_longer_overlap", async () => {
  const s = setup(400);
  await checkout(s);
  s.zoomTo(0.33);
  const a = s.box("Checkout");
  const b = s.box("Refund");
  expect(a.w).toBeLessThan(b.x - a.x);
  // Checkout's strip ends where Refund's tab starts: its room is the gap between the two tabs.
  await waitFor(() => expect(s.frameEl("Checkout").querySelector<HTMLElement>(".board-frame")!.style.getPropertyValue("--board-tab-room")).toBe(String(b.x - a.x)));
  const room = roomCss(b.x - a.x, 0.33);
  // Drawn whole, the strip would run over Refund's tab by this much.
  const p = stripParts({ kind: "flow", title: "Checkout", problems: 0 }, 0);
  expect(p.title + p.assistant + p.editor).toBeGreaterThan(room);
  // Refund's tab has nothing to its right: no room is set, it draws whole.
  expect(s.frameEl("Refund").querySelector<HTMLElement>(".board-frame")!.style.getPropertyValue("--board-tab-room")).toBe("");
});

test("at_33_to_40_percent_the_title_is_cut_and_the_buttons_stay", async () => {
  const s = setup(1000);
  await checkout(s);
  for (const zoom of [0.34, 0.36]) {
    s.zoomTo(zoom);
    await waitFor(() => expect(s.strip("Checkout").getAttribute("data-fit")).toBe("title"));
    expect(panes(s)).toEqual(["AI Chat", "Code Editor"]);
  }
});

test("in_a_tiny_room_the_buttons_hide_code_editor_last", async () => {
  const s = setup(400);
  await checkout(s);
  // At 50 percent the room fits the cut title and Code Editor, not AI Chat.
  s.zoomTo(0.5);
  await waitFor(() => expect(s.strip("Checkout").getAttribute("data-fit")).toBe("editor"));
  expect(panes(s)).toEqual(["Code Editor"]);
  // At 33 percent only the cut title fits.
  s.zoomTo(0.33);
  await waitFor(() => expect(s.strip("Checkout").getAttribute("data-fit")).toBe("none"));
  expect(panes(s)).toEqual([]);
  expect(within(s.strip("Checkout")).getByRole("button", { name: "Flowchart Checkout" })).toBeTruthy();
  // At 100 percent and above the strip scales with the board: the whole room fits everything again.
  s.zoomTo(1);
  await waitFor(() => expect(s.strip("Checkout").getAttribute("data-fit")).toBe("all"));
  expect(panes(s)).toEqual(["AI Chat", "Code Editor"]);
});

// ----- F5 (live check, 28 Oct): a short tab keeps the frame's name and drops the kind word first.

const kindWord = (s: Setup, key: string) => s.strip(key).querySelector(".board-frame-kind")?.textContent ?? null;
const nameOf = (s: Setup, key: string) => s.strip(key).querySelector(".board-frame-name")?.textContent ?? null;

test("a_short_strip_keeps_the_name_and_drops_the_kind_word", async () => {
  const s = setup(1000);
  await checkout(s);
  // Room for everything: the kind word and the name.
  s.zoomTo(1);
  await waitFor(() => expect(s.strip("Checkout").getAttribute("data-fit")).toBe("all"));
  expect(kindWord(s, "Checkout")).toBe("Flowchart");
  expect(nameOf(s, "Checkout")).toBe("Checkout");
  // Short of room: the kind word goes, the name stays; the full name is still the tab's name and tooltip.
  s.zoomTo(0.34);
  await waitFor(() => expect(s.strip("Checkout").getAttribute("data-fit")).toBe("title"));
  expect(kindWord(s, "Checkout")).toBeNull();
  expect(nameOf(s, "Checkout")).toBe("Checkout");
  const title = within(s.strip("Checkout")).getByRole("button", { name: "Flowchart Checkout" });
  expect(title.getAttribute("title")).toMatch(/^Flowchart Checkout\./);
  expect(title.querySelector("svg")).not.toBeNull();
});

test("at_the_least_room_the_tab_shows_its_icon_and_one_character_of_the_name", async () => {
  // Budget: the icon, the name's gap and "R…", with no kind word ahead of it.
  const p = stripParts({ kind: "flow", title: "Refund", problems: 0 }, 0);
  expect(p.titleMin).toBe(8 + 14 + 6 + 2 * 7 + 8);
  // A frame not selected, its room just that: the title is cut, never dropped, and the name is what is left.
  expect(stripFit(p.titleMin, p, false)).toBe("title");
  const s = setup(400);
  await checkout(s);
  s.zoomTo(0.33);
  await waitFor(() => expect(s.strip("Checkout").getAttribute("data-fit")).toBe("none"));
  expect(kindWord(s, "Checkout")).toBeNull();
  expect(nameOf(s, "Checkout")).toBe("Checkout");
});

test("at_173_px_the_live_tab_keeps_code_editor_and_cuts_its_name", async () => {
  // The 48 percent reading: 173 px of room went to the kind word and hid Code Editor.
  const p = stripParts({ kind: "flow", title: "Checkout", problems: 0 }, 0);
  expect(stripFit(173, p, true)).toBe("editor");
  // The name is cut: the whole title does not fit beside Code Editor.
  expect(173 - p.editor).toBeLessThan(8 + 14 + 6 + "Checkout".length * 7 + 8);
  const s = setup(400);
  await checkout(s);
  // 400 board units at 43.3 percent: 173.2 px.
  s.zoomTo(0.433);
  await waitFor(() => expect(s.strip("Checkout").getAttribute("data-fit")).toBe("editor"));
  expect(panes(s)).toEqual(["Code Editor"]);
  expect(kindWord(s, "Checkout")).toBeNull();
  expect(nameOf(s, "Checkout")).toBe("Checkout");
});
