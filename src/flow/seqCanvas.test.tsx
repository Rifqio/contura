// Plan E Task 5: participants and lifelines on the canvas. Each participant is filled in its colour at the top and
// at the bottom, shows its icon and its label in both boxes; the lifelines and activation bars are one node under
// the messages, in each participant's colour; blocks sit under the lanes. Colours are read from inline custom
// properties and from flow-seq.css as text, never as computed colours (jsdom does not resolve them).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { DiagramCanvasProps } from "../diagram/DiagramCanvas";
import { DetailContext } from "../diagram/detail";
import { LangClient } from "../lang/client";
import { mixHex } from "../lang/flow/colours";
import { parseFlow } from "../lang/flow/parse";
import flowCanvasCss from "../styles/flow-canvas.css?raw";
import flowSeqCss from "../styles/flow-seq.css?raw";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { mockReactFlowDom } from "../test/reactFlow";
import { ConnectionMode, type Edge, type Node, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { createFlowService } from "../lang/flow/service";
import { reviewOverlay } from "./ai/reviewOverlay";
import type { BoardLayout, FrameLayout } from "./board/boardLayout";
import { boardFrameId, createBoardScene, inFrameId, LIVE_ANCHOR_ID, staticZ } from "./board/boardScene";
import { emptyPositions } from "./layout";
import { buildFlowGraph, FLOW_EDGE_TYPES, FLOW_NODE_TYPES } from "./flowNodes";
import FlowTab from "./FlowTab";
import { resetIcons, setIconTheme } from "./icons";
import { SEQ_HEAD } from "./kindLayout";
import type { KindNodeData } from "./kindNodes";
import { SEQ_SURFACE, seqColours } from "./seqColour";
import { ACT_W, messagePath, type SeqBlock, TAB_W } from "./seqGeometry";
import { type SeqEdgeData, SeqParticipant, seqThemePalette } from "./seqNodes";

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
beforeEach(() => {
  resetIcons();
  setIconTheme("light");
});
afterEach(() => {
  cleanup();
  canvas.props = null;
  setIconTheme("light");
});

const INDEX = [
  { name: "aws-lambda", set: "aws", title: "Lambda", licence: null },
  // A steel blue and a dark yellow that sink into the info and warning tints in Dark (under 1.5:1), not the muted one.
  { name: "brand-steel", set: "simple", title: "Steel", licence: null, aliasOf: null, hex: "#4682a0" },
  { name: "brand-mustard", set: "simple", title: "Mustard", licence: null, aliasOf: null, hex: "#8a8a1e" },
];
const svg = (name: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><title>${name}</title></svg>`;

const seq = (...l: string[]) => `${['diagram sequence "Pay"', ...l].join("\n")}\n`;

function setup(text: string, layout: string | null = null) {
  routeInvoke({
    read_diagram: () => ({ text, layout }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    icon_index: () => INDEX,
    icon: ({ name }) => {
      if (!INDEX.some((e) => e.name === name)) throw { kind: "notFound", message: `${name as string} is not an icon` };
      return svg(name as string);
    },
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="seqc" client={client} />
    </div>,
  );
  const node = (label: string) => utils.container.querySelector(`.react-flow__node [aria-label="${label}"]`)?.closest<HTMLElement>(".react-flow__node") ?? null;
  /** The React Flow node element with id `id`. */
  const el = (id: string) => [...utils.container.querySelectorAll<HTMLElement>(".react-flow__node")].find((e) => e.getAttribute("data-id") === id) ?? null;
  /** The node as given to the canvas. */
  const rf = (id: string) => canvas.props!.nodes.find((n) => n.id === id);
  return { ...utils, node, el, rf };
}
type Setup = ReturnType<typeof setup>;
const shown = (s: Setup, label: string) => waitFor(() => expect(s.node(label)).not.toBeNull(), { timeout: 4000 });
const LANES = "\u0000lanes";
/** The nodes `buildFlowGraph` gives for `text`, before a board puts them in its z bands. */
const graph = (text: string) => buildFlowGraph(parseFlow(text).doc!, {}, "modern").nodes;
const styleVar = (e: Element, name: string) => (e as HTMLElement | SVGElement).style.getPropertyValue(name);

test("participants_are_filled_top_and_bottom", async () => {
  const s = setup(seq("participant A", "actor B", "A -> B: hi"));
  await shown(s, "Participant A");
  for (const label of ["Participant A", "Actor B"]) {
    const heads = s.node(label)!.querySelectorAll(".fkind-lifehead");
    expect(heads.length, label).toBe(2);
    expect(heads[0].getAttribute("aria-hidden")).toBeNull();
    expect(heads[1].getAttribute("aria-hidden")).toBe("true");
  }
});

test("the_boxes_show_the_label_not_the_name", async () => {
  const s = setup(seq('participant App [label: "Mobile app"]', "participant Server", "App -> Server: hi"));
  await shown(s, "Participant Mobile app");
  const app = [...s.node("Participant Mobile app")!.querySelectorAll(".fkind-lifehead")].map((h) => h.textContent);
  expect(app).toEqual(["Mobile app", "Mobile app"]);
  expect(s.container.querySelector('[aria-label="Participant App"]')).toBeNull();
  const server = [...s.node("Participant Server")!.querySelectorAll(".fkind-lifehead")].map((h) => h.textContent);
  expect(server).toEqual(["Server", "Server"]);
});

test("the_icon_shows_in_both_boxes", async () => {
  const s = setup(seq("participant Fn [icon: aws-lambda]", "participant Gone [icon: aws-nope]", "Fn -> Gone: call"));
  await shown(s, "Participant Fn");
  await waitFor(() => expect(s.node("Participant Fn")!.querySelectorAll("img").length).toBe(2));
  const [a, b] = [...s.node("Participant Fn")!.querySelectorAll("img")];
  expect(a.getAttribute("src")!.startsWith("data:image/svg+xml")).toBe(true);
  expect(b.getAttribute("src")).toBe(a.getAttribute("src"));
  // One the pack lacks: a dashed cube tile in each box, no image.
  await waitFor(() => expect(s.node("Participant Gone")!.querySelectorAll(".fkind-seq-icon.is-unknown").length).toBe(2));
  expect(s.node("Participant Gone")!.querySelector("img")).toBeNull();
  for (const t of s.node("Participant Gone")!.querySelectorAll(".fkind-seq-icon.is-unknown")) expect(t.querySelector("svg")).not.toBeNull();
});

test("the_icon_is_not_loaded_below_full_detail", async () => {
  routeInvoke({ icon_index: () => INDEX, icon: ({ name }) => svg(name as string) });
  const d: KindNodeData = { name: "Fn", kind: "participant", look: "modern", iconName: "aws-lambda", seq: true };
  const r = render(
    <DetailContext.Provider value={{ detail: "box", fast: false }}>
      <SeqParticipant d={d} />
    </DetailContext.Provider>,
  );
  await act(() => new Promise((res) => setTimeout(res, 30)));
  expect(r.container.querySelector("img")).toBeNull();
  expect(callsTo("icon")).toHaveLength(0);
  // Its 18 px slot stays empty while it waits, so the words do not move when it arrives.
  expect(r.container.querySelectorAll(".fkind-seq-icon").length).toBe(0);
  expect([...r.container.querySelectorAll(".fkind-lifehead")].map((h) => h.textContent)).toEqual(["Fn", "Fn"]);
});

test("lanes_are_one_node_under_the_messages", async () => {
  const s = setup(seq("participant A", "participant B", "participant C", "A -> B: one", "B -> C: two"));
  await shown(s, "Participant C");
  const lanes = canvas.props!.nodes.filter((n) => n.type === "seqLanes");
  expect(lanes.map((n) => n.id)).toEqual([LANES]);
  const n = lanes[0];
  // Over the blocks, under the messages and the participants: -1 in the diagram's own z band.
  expect(graph(seq("participant A", "participant B", "A -> B: one")).find((x) => x.id === LANES)!.zIndex).toBe(-1);
  expect(n.zIndex!).toBeLessThan(s.rf("A")!.zIndex!);
  expect([n.selectable, n.draggable, n.focusable, n.connectable]).toEqual([false, false, false, false]);
  const el = s.el(LANES)!;
  expect(el.querySelectorAll('[data-part="lifeline"]').length).toBe(3);
  expect(el.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  // No lifeline inside a participant node any more.
  for (const name of ["A", "B", "C"]) {
    expect(s.node(`Participant ${name}`)!.querySelector('[data-part="lifeline"], .fkind-lifeline')).toBeNull();
    expect(s.node(`Participant ${name}`)!.querySelector(".fkind-activation")).toBeNull();
  }
  // Each lane runs from under the head to the top of the foot box, down the participant's centre (Task 4: the
  // participant node includes the foot area), so no line runs through the foot.
  const paths = [...el.querySelectorAll('[data-part="lifeline"]')];
  ["A", "B", "C"].forEach((name, i) => {
    const p = s.rf(name)!;
    const m = /^M([-\d.]+) ([-\d.]+) ?V([-\d.]+)$/.exec(paths[i].getAttribute("d")!)!;
    expect(Number(m[1]) + n.position.x).toBeCloseTo(p.position.x + p.initialWidth! / 2);
    expect(Number(m[2]) + n.position.y).toBeCloseTo(p.position.y + SEQ_HEAD);
    expect(Number(m[3]) + n.position.y).toBeCloseTo(p.position.y + p.initialHeight! - SEQ_HEAD);
  });
  // The superseded rules are gone; the lanes take no presses.
  expect(flowCanvasCss).not.toMatch(/\.fkind-lifeline|\.fkind-activation/);
  expect(n.style?.pointerEvents).toBe("none");
  expect(el.style.pointerEvents).toBe("none");
});

test("colour_flows_to_lane_and_bars", async () => {
  const s = setup(seq("participant A [color: info]", "participant B", "activate A", "A -> B: hi", "B --> A: ok", "deactivate A"));
  await shown(s, "Participant A");
  const el = s.el(LANES)!;
  const lane = el.querySelectorAll('[data-part="lifeline"]')[0];
  const bar = el.querySelector('[data-part="activation"]')!;
  expect(styleVar(lane, "--seq-col")).toBe("var(--c-info-text)");
  expect(styleVar(bar, "--seq-col")).toBe("var(--c-info-text)");
  expect(lane.classList.contains("fkind-seq")).toBe(true);
  expect(bar.classList.contains("fkind-seq")).toBe(true);
  // The other lane keeps its kind's own line.
  expect(styleVar(el.querySelectorAll('[data-part="lifeline"]')[1], "--seq-col")).toBe("var(--c-node-table-stroke)");
  // Task 4: SeqBar.x is the bar's left edge, so the bar is centred on the lane.
  const m = /^M([-\d.]+) /.exec(lane.getAttribute("d")!)!;
  expect(Number(bar.getAttribute("x")) + ACT_W / 2).toBeCloseTo(Number(m[1]));
  expect(Number(bar.getAttribute("width"))).toBe(ACT_W);
  expect(flowSeqCss).toMatch(/\[data-part="lifeline"\][^{]*\{[^}]*stroke:\s*var\(--seq-col\)[^}]*stroke-width:\s*1\.5/);
  expect(flowSeqCss).toMatch(/\[data-part="activation"\][^{]*\{[^}]*fill:\s*color-mix\(in srgb, var\(--seq-col\) var\(--seq-amt\), var\(--c-bg-surface\)\)/);
});

test("a_preset_colour_is_not_replaced_by_the_fallback", async () => {
  // flow-seq.css sets --seq-col on every .fkind-seq (to --c-text-subtle when no custom value is there), so the class
  // goes on the very element that carries the inline colour: the React Flow node, and nothing inside it.
  const s = setup(seq("participant A [color: info]", "participant B", "A -> B: hi"));
  await shown(s, "Participant A");
  const wrap = s.node("Participant A")!;
  expect(wrap.classList.contains("fkind-seq")).toBe(true);
  expect(styleVar(wrap, "--seq-col")).toBe("var(--c-info-text)");
  expect(wrap.querySelector(".fkind-seq")).toBeNull();
  expect(s.rf("A")!.className).toContain("fkind-seq");
});

test("a_muted_participant_names_in_text_colour", async () => {
  const s = setup(seq("participant A [color: muted]", "participant B", "A -> B: hi"));
  await shown(s, "Participant A");
  const wrap = s.node("Participant A")!;
  expect(styleVar(wrap, "--seq-col")).toBe("var(--c-text-subtle)");
  const shell = wrap.querySelector<HTMLElement>(".fnode")!;
  expect(shell.style.color).toBe("");
  expect(shell.style.getPropertyValue("--fnode-fill")).not.toBe("var(--c-bg-active)");
  const rule = /\.fkind-lifehead\s*\{([^}]*)\}/.exec(flowSeqCss)![1];
  expect(rule).toMatch(/(^|[^-])color:\s*var\(--c-text\)/);
  expect(rule).toMatch(/color-mix\(in srgb, var\(--seq-col\) var\(--seq-amt\), var\(--c-bg-surface\)\)/);
});

test("a_custom_colour_sets_both_themes", async () => {
  const s = setup(seq("participant A [color: white]", "participant B", "A -> B: hi"));
  await shown(s, "Participant A");
  const wrap = s.node("Participant A")!;
  for (const t of ["light", "dark"] as const) {
    const want = seqColours(seqThemePalette(t), "#ffffff", "participant");
    expect(styleVar(wrap, `--seq-col-${t}`)).toBe(want.line);
    const amt = parseFloat(styleVar(wrap, `--seq-amt-${t}`)) / 100;
    expect(mixHex(want.line, SEQ_SURFACE[t], amt)).toBe(want.fill);
  }
  expect(flowSeqCss).toMatch(/\.theme-light \.fkind-seq[^{]*\{[^}]*--seq-col:\s*var\(--seq-col-light/);
  for (const sel of [':root\\[data-theme="dark"\\] \\.fkind-seq', "\\.theme-dark \\.fkind-seq", ':root:not\\(\\[data-theme="light"\\]\\) \\.fkind-seq'])
    expect(flowSeqCss).toMatch(new RegExp(`${sel}[^{]*\\{[^}]*--seq-col:\\s*var\\(--seq-col-dark`));
});

test("blocks_sit_under_the_lanes", async () => {
  const s = setup(seq("participant A", "participant B", "opt card saved {", "  loop retry {", "    A -> B: pay", "  }", "}", "B --> A: ok"));
  await shown(s, "Participant A");
  // The outer block (depth 0) under the inner one, both under the lanes.
  const block = (nodes: { id: string; data: unknown; zIndex?: number }[], depth: number) => nodes.find((x) => x.id.startsWith("\u0000frame:") && (x.data as { depth: number }).depth === depth)!.zIndex!;
  const ns = canvas.props!.nodes;
  expect(block(ns, 0)).toBeLessThan(block(ns, 1));
  expect(block(ns, 1)).toBeLessThan(s.rf(LANES)!.zIndex!);
  const g = graph(seq("participant A", "participant B", "opt card saved {", "  loop retry {", "    A -> B: pay", "  }", "}", "B --> A: ok"));
  expect([block(g, 0), block(g, 1), g.find((x) => x.id === LANES)!.zIndex]).toEqual([-3, -2, -1]);
});

test("an_empty_block_and_a_late_bar_stay_above_the_foot", async () => {
  // Task 4's follow-up: an empty block has its own band, and a bar after the last message ends above the foot boxes.
  const s = setup(seq("participant A", "participant B", "A -> B: one", "opt nothing yet {", "}", "activate B"));
  await shown(s, "Participant A");
  const a = s.rf("A")!;
  const footTop = a.position.y + a.initialHeight! - SEQ_HEAD;
  const block = s.rf("\u0000frame:0")!;
  expect(block.position.y + block.initialHeight!).toBeLessThanOrEqual(footTop);
  const lanes = s.rf(LANES)!;
  const bar = s.el(LANES)!.querySelector('[data-part="activation"]')!;
  expect(Number(bar.getAttribute("y")) + Number(bar.getAttribute("height")) + lanes.position.y).toBeLessThanOrEqual(footTop);
  expect(Number(bar.getAttribute("y")) + lanes.position.y).toBeGreaterThanOrEqual(a.position.y + SEQ_HEAD);
});

test("a_logo_on_its_participant_gets_the_hairline", async () => {
  // In Dark, a steel blue logo on the info fill and a dark yellow on the warning fill are under 1.5:1 (Task 3's case).
  setIconTheme("dark");
  const s = setup(seq("participant S [icon: brand-steel, color: info]", "participant Y [icon: brand-mustard, color: warning]", "participant P [icon: brand-steel, color: muted]", "S -> Y: hi", "Y -> P: hi"));
  await shown(s, "Participant S");
  for (const label of ["Participant S", "Participant Y", "Participant P"]) await waitFor(() => expect(s.node(label)!.querySelectorAll("img").length, label).toBe(2));
  for (const img of s.node("Participant S")!.querySelectorAll("img")) expect(img.classList.contains("icon-hairline")).toBe(true);
  for (const img of s.node("Participant Y")!.querySelectorAll("img")) expect(img.classList.contains("icon-hairline")).toBe(true);
  for (const img of s.node("Participant P")!.querySelectorAll("img")) expect(img.classList.contains("icon-hairline")).toBe(false);
});

test("the_participant_rules_use_theme_tokens_only", () => {
  // Apart from Task 3's pinned values, flow-seq.css has no colour literal.
  expect(flowSeqCss).toContain(".fkind-lifehead");
  expect(flowCanvasCss).toContain(".fnode-participant");
  expect(flowSeqCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});

// ----- Task 6: messages and blocks on the canvas.

/** The canvas's message edge `i` as given to it, and its drawn element. */
const edgeData = (i: number, prefix = "") => canvas.props!.edges.find((e) => e.id === `${prefix}edge:${i}`)!.data as SeqEdgeData;
const edgeEl = (s: Setup, id: string) => s.container.querySelector<SVGGElement>(`.react-flow__edge[data-id="${id}"]`);
const pathOf = (s: Setup, id: string) => edgeEl(s, id)?.querySelector(".react-flow__edge-path")?.getAttribute("d") ?? null;
/** A live node's place on the board: its frame-local place plus the live anchor's (Plan F Decision 11). */
function absOf(id: string) {
  const n = canvas.props!.nodes.find((x) => x.id === id)!;
  const a = n.parentId === LIVE_ANCHOR_ID ? canvas.props!.nodes.find((x) => x.id === LIVE_ANCHOR_ID)!.position : { x: 0, y: 0 };
  return { x: a.x + n.position.x, y: a.y + n.position.y };
}
const chipOf = (s: Setup, text: string) => [...s.container.querySelectorAll<HTMLElement>(".fkind-seq-chip")].find((e) => e.textContent === text) ?? null;

test("a_label_sits_on_its_chip_on_a_broken_line", async () => {
  const s = setup(seq("participant A", "participant B", "participant C", "A -> B: authorize", "opt saved {", "  B -> C: store", "}"));
  await shown(s, "Participant C");
  await waitFor(() => expect(chipOf(s, "store")).not.toBeNull());
  for (const i of [0, 1]) {
    const d = edgeData(i);
    const abs = absOf(d.m.from);
    const dx = abs.x - d.at.x;
    const dy = abs.y - d.at.y;
    // The drawing's path, moved to where the sender stands; a labelled line is two runs with a gap at the label.
    expect(pathOf(s, `edge:${i}`)).toBe(messagePath(d.m, dx, dy));
    expect(d.m.d.match(/M/g)!.length).toBe(2);
    const c = d.m.label!.chip;
    const chip = chipOf(s, d.m.label!.text)!;
    expect(chip.style.transform).toBe(`translate(${c.x + dx}px, ${c.y + dy}px)`);
    expect([chip.style.width, chip.style.height]).toEqual([`${c.w}px`, `${c.h}px`]);
  }
  // On the canvas outside a block; on the block's wash inside one, in the block's own colour variables.
  expect(styleVar(chipOf(s, "authorize")!, "--seq-chip")).toBe("var(--c-bg-canvas)");
  const inside = chipOf(s, "store")!;
  expect(styleVar(inside, "--seq-chip")).toBe("var(--seq-wash)");
  expect(styleVar(inside, "--seq-col")).toBe("var(--c-text-subtle)");
  expect(inside.classList.contains("fkind-seq")).toBe(true);
  expect(flowSeqCss).toMatch(/\.fkind-seq-chip\s*\{[^}]*background:\s*var\(--seq-chip\)/);
  expect(flowSeqCss).toMatch(/--seq-wash:\s*color-mix\(in srgb, var\(--seq-col\) 7%, var\(--c-bg-canvas\)\)/);
});

test("far_text_fades_numbers_words_and_captions_and_keeps_the_chip", async () => {
  // Plan F's far text (Decisions 2 and 4): the words go and bars stand in, at the frame's text size. The chip keeps its
  // own background under the bar, so a lifeline still never shows through a message's label.
  const s = setup(seq("autonumber", "participant A", "participant B", "loop again {", "  A -> B: pay", "}"));
  await shown(s, "Participant B");
  await waitFor(() => expect(chipOf(s, "pay")).not.toBeNull());
  s.container.querySelector<HTMLElement>(".flow-canvas")!.setAttribute("data-far", "m");
  const chip = chipOf(s, "pay")!;
  for (const c of ["fkind-msg", "fkind-seq-chip", "board-ts-m"]) expect(chip.classList.contains(c), c).toBe(true);
  expect(edgeEl(s, "edge:0")!.querySelector('[data-part="number"]')!.classList.contains("board-ts-m")).toBe(true);
  expect(s.el("\u0000frame:0")!.className).toContain("board-ts-m");
  expect(s.el("\u0000frameTab:0")!.className).toContain("board-ts-m");
  for (const t of ["s", "m", "l"]) {
    expect(flowSeqCss).toContain(`[data-far~="${t}"] .board-ts-${t} :is(.fkind-seq-word, .fkind-seq-caption-text)`);
    expect(flowSeqCss).toContain(`[data-far~="${t}"] .board-ts-${t}.fkind-seq-num text`);
    expect(flowSeqCss).toMatch(new RegExp(`\\[data-far~="${t}"\\] \\.board-ts-${t}\\.fkind-msg\\.fkind-seq-chip[^{]*\\{[^}]*background:[^;}]*linear-gradient[^;}]*var\\(--seq-chip\\)`));
  }
});

test("numbers_show_in_circles_on_the_sender", async () => {
  const s = setup(seq("participant A [color: info]", "participant B", "A -> B: first", "autonumber 10", "A -> B: pay", "B --> A: ok", "A -> B"));
  await shown(s, "Participant B");
  await waitFor(() => expect(s.container.querySelectorAll('[data-part="number"]').length).toBe(3));
  expect([...s.container.querySelectorAll('[data-part="number"]')].map((n) => n.textContent)).toEqual(["10", "11", "12"]);
  // None before the directive.
  expect(edgeEl(s, "edge:0")!.querySelector('[data-part="number"]')).toBeNull();
  // Outlined in the sender's colour: A's info, B's own kind line.
  const num = (i: number) => edgeEl(s, `edge:${i}`)!.querySelector<SVGGElement>('[data-part="number"]')!;
  expect(styleVar(num(1), "--seq-col")).toBe("var(--c-info-text)");
  expect(styleVar(num(2), "--seq-col")).toBe("var(--c-node-table-stroke)");
  expect(num(1).classList.contains("fkind-seq")).toBe(true);
  // On the sender's lifeline at its row, on the board.
  for (const [i, who] of [[1, "A"], [2, "B"]] as const) {
    const r = num(i).querySelector("rect")!;
    const p = absOf(who);
    expect(Number(r.getAttribute("x")) + Number(r.getAttribute("width")) / 2).toBeCloseTo(p.x + s.rf(who)!.initialWidth! / 2);
    expect(Number(r.getAttribute("y")) + Number(r.getAttribute("height")) / 2).toBeCloseTo(p.y + edgeData(i).y);
    expect(num(i).querySelector("text")!.getAttribute("x")).toBe(String(Number(r.getAttribute("x")) + Number(r.getAttribute("width")) / 2));
  }
  expect(flowSeqCss).toMatch(/\.fkind-seq-num rect\s*\{[^}]*fill:\s*var\(--c-bg-surface\)[^}]*stroke:\s*var\(--seq-col\)/);
  // Decision 15's names.
  expect(["edge:0", "edge:1", "edge:2", "edge:3"].map((id) => edgeEl(s, id)!.getAttribute("aria-label"))).toEqual(["Message, first", "Message 10, pay", "Message 11, ok", "Message 12, A to B"]);
});

test("a_self_message_is_a_square_loop", async () => {
  const s = setup(seq("participant A", "participant B", "A -> A: check", "A -> A", "A -> B"));
  await shown(s, "Participant B");
  for (const i of [0, 1]) {
    const d = pathOf(s, `edge:${i}`)!;
    // Straight runs only, no curves; it runs out right, down, and back left to the lifeline.
    expect(d).not.toMatch(/[CcQqSsTtAaLl]/);
    expect(d).toMatch(/V/);
    const pts = edgeData(i).m.points;
    const [last, before] = [pts[pts.length - 1], pts[pts.length - 2]];
    expect(last.y).toBe(before.y);
    expect(last.x).toBeLessThan(before.x);
    // The head is drawn at the path's end, so it points left.
    const ends = [...d.matchAll(/H([-\d.]+)/g)].map((m) => Number(m[1]));
    expect(ends[ends.length - 1]).toBeLessThan(Math.max(...ends));
    expect(edgeEl(s, `edge:${i}`)!.querySelector(".react-flow__edge-path")!.getAttribute("marker-end")).toBeTruthy();
  }
  // The labelled loop breaks its right side around the label.
  expect(edgeData(0).m.d.match(/M/g)!.length).toBe(2);
  expect(edgeData(1).m.d.match(/M/g)!.length).toBe(1);
});

test("a_block_has_its_side_tab_and_caption", async () => {
  const s = setup(seq("participant A", "participant B", "opt card saved [color: warning] {", "  A -> B: pay", "  B --> A: ok", "  A -> B: again", "}", "loop {", "  A -> B: more", "}"));
  await shown(s, "Participant B");
  await waitFor(() => expect(s.el("\u0000frameTab:0")).not.toBeNull());
  const opt = s.el("\u0000frame:0")!;
  expect(opt.classList.contains("fkind-seq")).toBe(true);
  expect(styleVar(opt, "--seq-col")).toBe("var(--c-warning-text)");
  const group = opt.querySelector('[aria-label="Sequence frame opt card saved"]')!;
  expect(group.getAttribute("role")).toBe("group");
  const block = s.rf("\u0000frame:0")!.data.block as SeqBlock;
  expect(block.word).toBe(true);
  const tab = opt.querySelector<HTMLElement>(".fkind-seq-tab")!;
  expect(tab.getAttribute("aria-hidden")).toBe("true");
  expect(tab.querySelector('[data-icon="branch"]')).not.toBeNull();
  expect(tab.querySelector(".fkind-seq-word")!.textContent).toBe("opt");
  expect(tab.style.width).toBe(`${TAB_W}px`);
  // The caption is its own node, the press target, at the caption box, in the block's colour.
  const cap = s.rf("\u0000frameTab:0")!;
  expect(cap.position).toEqual({ x: block.captionBox!.x, y: block.captionBox!.y });
  expect([cap.initialWidth, cap.initialHeight]).toEqual([block.captionBox!.w, block.captionBox!.h]);
  expect(s.el("\u0000frameTab:0")!.textContent).toBe("card saved");
  expect(styleVar(s.el("\u0000frameTab:0")!, "--seq-col")).toBe("var(--c-warning-text)");
  // A block with no colour is muted; with no caption, its tab node is the side tab's top 22 px.
  const loop = s.el("\u0000frame:1")!;
  expect(styleVar(loop, "--seq-col")).toBe("var(--c-text-subtle)");
  expect(loop.querySelector('[aria-label="Sequence frame loop"]')).not.toBeNull();
  expect(loop.querySelector('.fkind-seq-tab [data-icon="repeat"]')).not.toBeNull();
  const box = (s.rf("\u0000frame:1")!.data.block as SeqBlock).box;
  expect(s.rf("\u0000frameTab:1")).toMatchObject({ position: { x: box.x, y: box.y }, initialWidth: TAB_W, initialHeight: 22 });
  expect(s.el("\u0000frameTab:1")!.textContent).toBe("");
  expect(flowSeqCss).toMatch(/\.fkind-seq-block\s*\{[^}]*border:\s*1\.5px solid var\(--seq-col\)[^}]*background:\s*var\(--seq-wash\)/);
  expect(flowSeqCss).toMatch(/\.fkind-seq-tab\s*\{[^}]*background:\s*var\(--seq-tab\)[^}]*color:\s*var\(--seq-ink\)/);
  expect(flowSeqCss).toMatch(/\.fkind-seq-caption\s*\{[^}]*background:\s*var\(--seq-wash\)[^}]*color:\s*var\(--c-text-subtle\)/);
});

test("a_short_block_leaves_its_word_out_and_each_kind_has_its_glyph", async () => {
  const s = setup(seq("participant A", "participant B", "critical x {", "  A -> B", "}", "alt y {", "  A -> B", "}", "par z {", "  A -> B", "}"));
  await shown(s, "Participant B");
  await waitFor(() => expect(s.el("\u0000frame:2")).not.toBeNull());
  const glyphs = [0, 1, 2].map((i) => s.el(`\u0000frame:${i}`)!.querySelector(".fkind-seq-tab [data-icon]")!.getAttribute("data-icon"));
  expect(glyphs).toEqual(["warning", "split", "columns"]);
  for (const i of [0, 1, 2]) {
    const b = s.rf(`\u0000frame:${i}`)!.data.block as SeqBlock;
    expect(!!s.el(`\u0000frame:${i}`)!.querySelector(".fkind-seq-word")).toBe(b.word);
  }
});

const LOGIN = 'diagram sequence "Login"\nparticipant App\nparticipant Api\nparticipant Bank\nApp -> Api: hi\nApi -> Bank: check\n';
const TALK = 'diagram sequence "Talk"\nparticipant A\nparticipant B\nB -> A: hello\n';
const AWAY = JSON.stringify({
  version: 2,
  frames: {
    Login: { at: { x: 700, y: 120 }, nodes: {}, style: "modern", direction: "TB" },
    Talk: { at: { x: -500, y: 900 }, nodes: {}, style: "modern", direction: "TB" },
  },
  sketches: [],
});

test("a_live_frame_off_the_origin_draws_its_messages_from_the_lifelines", async () => {
  // Plan F: live shapes hang from the anchor at the frame's `at`, in board units; the path is moved by the sender's
  // place, so it must start on the sender's lifeline wherever the frame stands.
  const s = setup(`${LOGIN}\n${TALK}`, AWAY);
  fireEvent.click(await screen.findByRole("button", { name: / Login$/ }));
  await shown(s, "Participant Bank");
  expect(canvas.props!.nodes.find((n) => n.id === LIVE_ANCHOR_ID)!.position).toEqual({ x: 700, y: 120 });
  for (const [i, from] of [[0, "App"], [1, "Api"]] as const) {
    await waitFor(() => expect(pathOf(s, `edge:${i}`)).not.toBeNull());
    const m = /^M([-\d.]+) ([-\d.]+)/.exec(pathOf(s, `edge:${i}`)!)!;
    const p = absOf(from);
    expect(Number(m[1])).toBeCloseTo(p.x + s.rf(from)!.initialWidth! / 2);
    expect(Number(m[2])).toBeCloseTo(p.y + edgeData(i).y);
    expect(p.x).toBeGreaterThanOrEqual(700);
  }
  // A static frame far off draws as Plan F's picture at open; its real lines are checked on the board scene below.
  expect(canvas.props!.nodes.some((n) => n.id === inFrameId("Talk", "\u0000picture"))).toBe(true);
});

// Review Focus 5: B1's board harness with a static sequence frame and a frame titled "0", then a Plan D review.
const BEFORE = ['diagram sequence "Talk"', "autonumber", "participant A", "participant B", "participant Gone", "loop again {", "  A -> B: hi", "}", "B --> A: ok", "A -> Gone: bye", ""].join("\n");
const AFTER = ['diagram sequence "Talk"', "autonumber", "participant A", "participant B", "participant New", "loop again {", "  A -> B: hi", "}", "B --> A: ok", "B -> New: tell", ""].join("\n");
const entry = (at: { x: number; y: number }, nodes: Record<string, { x: number; y: number }> = {}): FrameLayout => ({ at, nodes: Object.assign(emptyPositions(), nodes), style: "modern", direction: "TB" });

function drawGraph(g: { nodes: Node[]; edges: Edge[] }) {
  return render(
    <div style={{ width: 1280, height: 800 }}>
      <ReactFlowProvider>
        {/* As the board's canvas draws them: lines join any side's handle (DiagramCanvas's loose connection mode). */}
        <ReactFlow nodes={g.nodes} edges={g.edges} nodeTypes={FLOW_NODE_TYPES} edgeTypes={FLOW_EDGE_TYPES} connectionMode={ConnectionMode.Loose} />
      </ReactFlowProvider>
    </div>,
  );
}

test("static_frames_and_review_marks_draw_the_new_look", async () => {
  const svc = createFlowService();
  const r = svc.parse("board", `${BEFORE}\ndiagram flow "0"\nX\n`);
  const b: BoardLayout = { frames: new Map([["Talk", entry({ x: 300, y: 200 })], ["0", entry({ x: 1400, y: 0 }, { X: { x: 0, y: 0 } })]]), sketches: [] };
  const scene = createBoardScene("modern");
  const s = scene.build(r.frames, b, ["Talk", "0"], null, null, []);
  const id = (x: string) => inFrameId("Talk", x);
  const node = (x: string) => s.nodes.find((n) => n.id === x);
  // Prefixed ids for the edges, the lanes and the block; the board frame "0" is its own id.
  for (const x of ["\u0000lanes", "\u0000frame:0", "\u0000frameTab:0", "A"]) expect(node(id(x)), x).toBeTruthy();
  expect(node(boardFrameId("0"))).toBeTruthy();
  expect(node("\u0000frame:0")).toBeUndefined();
  const edges = s.edges.filter((e) => e.id.startsWith(id("edge:")));
  expect(edges.map((e) => e.id)).toEqual([0, 1, 2].map((i) => id(`edge:${i}`)));
  // The lanes node in its band, under the edges; the block under the lanes.
  const lanes = node(id("\u0000lanes"))!;
  expect(lanes.zIndex).toBe(staticZ(0, -1));
  for (const e of edges) expect(e.zIndex!).toBeGreaterThan(lanes.zIndex!);
  expect(node(id("\u0000frame:0"))!.zIndex!).toBeLessThan(lanes.zIndex!);
  // The new look on a static frame: numbers, names, and the block's own data.
  expect(edges.map((e) => (e.data as SeqEdgeData).m.number?.n)).toEqual([1, 2, 3]);
  expect(edges.map((e) => e.ariaLabel)).toEqual(["Message 1, hi", "Message 2, ok", "Message 3, bye"]);
  expect((node(id("\u0000frame:0"))!.data.block as SeqBlock).kind).toBe("loop");
  // Drawn, each static message starts on its sender's lifeline in board units: the frame box's place plus the child's.
  const st = drawGraph(s);
  await waitFor(() => expect(st.container.querySelectorAll(".react-flow__edge").length).toBe(3));
  for (const [i, from] of [[0, "A"], [1, "B"], [2, "A"]] as const) {
    const sender = node(id(from))!;
    const box = node(sender.parentId!)!;
    expect(box.id).toBe(boardFrameId("Talk"));
    const el = [...st.container.querySelectorAll(".react-flow__edge")].find((e) => e.getAttribute("data-id") === id(`edge:${i}`))!;
    const d = el.querySelector(".react-flow__edge-path")!.getAttribute("d")!;
    const m = /^M([-\d.]+) ([-\d.]+)/.exec(d)!;
    const data = edges[i].data as SeqEdgeData;
    const inset = data.m.number!.w / 2;
    expect(Math.abs(Number(m[1]) - (box.position.x + sender.position.x + sender.initialWidth! / 2))).toBeCloseTo(inset);
    expect(Number(m[2])).toBeCloseTo(box.position.y + sender.position.y + data.y);
    // Off the origin, so a path that ignored the frame box would miss.
    expect(box.position.x).toBeGreaterThan(200);
  }
  st.unmount();

  // The review: New and "tell" added, Gone and "bye" removed. Removed messages come after the proposed ones.
  const doc = (t: string) => svc.parse("board", t).frames[0].doc!;
  const o = reviewOverlay(doc(BEFORE), doc(AFTER));
  expect(o.draw.links.map((l) => l.label)).toEqual(["hi", "ok", "tell", "bye"]);
  expect([[...o.addedLinks], [...o.removedLinks]]).toEqual([[2], [3]]);
  // Numbering stops before the removed tail, so the layout gives a removed message no number and no inset.
  expect(o.draw.autonumber).toEqual([{ from: 0 }, { from: 3, off: true }]);

  // On a static frame: each line keeps its mark in its class and in its data (its chip and circle are drawn apart).
  const s2 = scene.build(r.frames, b, ["Talk", "0"], null, null, [], undefined, null, undefined, null, new Map([["Talk", { ...o, count: 4, isNew: false }]]));
  const e2 = (i: number) => s2.edges.find((e) => e.id === id(`edge:${i}`))!;
  expect(e2(2).className).toContain("is-ai-add");
  expect(e2(3).className).toContain("is-ai-del");
  expect([(e2(2).data as SeqEdgeData).mark, (e2(3).data as SeqEdgeData).mark, (e2(0).data as SeqEdgeData).mark]).toEqual(["add", "del", undefined]);
  expect([e2(2).ariaLabel, e2(3).ariaLabel]).toEqual(["Message 3, tell, suggested by AI", "Message, bye, removal suggested by AI"]);
  // The removed line starts on its sender's lifeline, not half a circle off it.
  // A's lifeline is where its numbered "hi" has its circle.
  const laneA = (e2(0).data as SeqEdgeData).m.number!.x;
  const bye = (e2(3).data as SeqEdgeData).m;
  expect(bye.number).toBeUndefined();
  expect(bye.points[0].x).toBe(laneA);
  expect(bye.d.startsWith(`M${laneA} `)).toBe(true);

  // On the selected frame: the graph FlowTab builds, with the review's marks and shape states, drawn.
  const marks = new Map<number, "add" | "del" | "changed">([...[...o.addedLinks].map((i) => [i, "add"] as const), ...[...o.removedLinks].map((i) => [i, "del"] as const)]);
  const states = new Map([...[...o.added].map((n) => [n, "suggested"] as const), ...[...o.removed].map((n) => [n, "removed"] as const)]);
  const live = buildFlowGraph(o.draw, emptyPositions(), "modern", { marks, states });
  const v = drawGraph(live);
  await waitFor(() => expect(v.container.querySelectorAll(".react-flow__edge").length).toBe(4));
  const liveEdge = (i: number) => v.container.querySelector<SVGGElement>(`.react-flow__edge[data-id="edge:${i}"]`)!;
  // The removed message fades with no circle; the added one is numbered as it will be once accepted.
  expect(liveEdge(3).classList.contains("is-ai-del")).toBe(true);
  expect(liveEdge(3).querySelector('[data-part="number"]')).toBeNull();
  const liveA = live.nodes.find((n) => n.id === "A")!;
  const liveBye = (live.edges.find((e) => e.id === "edge:3")!.data as SeqEdgeData).m;
  expect(liveBye.points[0].x).toBe(liveA.position.x + liveA.initialWidth! / 2);
  expect(liveEdge(2).classList.contains("is-ai-add")).toBe(true);
  expect(liveEdge(2).querySelector('[data-part="number"]')!.textContent).toBe("3");
  expect([0, 1, 2].map((i) => liveEdge(i).querySelector('[data-part="number"]')!.textContent)).toEqual(["1", "2", "3"]);
  expect(liveEdge(2).getAttribute("aria-label")).toBe("Message 3, tell, suggested by AI");
  expect(liveEdge(3).getAttribute("aria-label")).toBe("Message, bye, removal suggested by AI");
  // Their chips take the mark too.
  const chip = (t: string) => [...v.container.querySelectorAll<HTMLElement>(".fkind-seq-chip")].find((e) => e.textContent === t)!;
  await waitFor(() => expect(chip("bye")).toBeTruthy());
  expect(chip("bye").classList.contains("is-ai-del")).toBe(true);
  expect(chip("tell").classList.contains("is-ai-add")).toBe(true);
  expect(flowSeqCss).toMatch(/\.fkind-seq-chip\.is-ai-add\s*\{[^}]*var\(--c-success-solid\)/);
  // The removed chip stays opaque, so no lifeline shows through it; only its words fade.
  const delChip = /\.fkind-seq-chip\.is-ai-del\s*\{([^}]*)\}/.exec(flowSeqCss)![1];
  expect(delChip).toMatch(/outline:\s*1px dashed var\(--c-danger-solid\)/);
  expect(delChip).toMatch(/color:\s*color-mix\(in srgb, var\(--c-text\) 85%, transparent\)/);
  expect(delChip).not.toMatch(/opacity|background/);
  // The participants under review: the added one suggested, the removed one ghosted, their boxes marked.
  const part = (label: string) => v.container.querySelector(`[aria-label="${label}"]`);
  expect(part("Participant New, suggested by AI")!.classList.contains("fnode-suggested")).toBe(true);
  expect(part("Participant Gone, removal suggested by AI")!.classList.contains("fnode-removed")).toBe(true);
  expect(flowSeqCss).toMatch(/\.fnode-suggested \.fkind-lifehead\s*\{[^}]*border-style:\s*dashed[^}]*var\(--c-success-solid\)/);
  expect(flowSeqCss).toMatch(/\.fnode-removed \.fkind-lifehead\s*\{[^}]*border-style:\s*dashed[^}]*var\(--c-danger-solid\)/);
  // The lane-high node keeps no fill of D's: it would cover the lanes and the lines under it.
  expect(flowSeqCss).toMatch(/\.flow-canvas \.fnode-participant:is\(\.fnode-suggested, \.fnode-removed, \.fnode-changed\)[^{]*\{[^}]*background:\s*none/);
  v.unmount();

  // After Accept the text is the proposal, and the numbers run 1 to n over it.
  const accepted = buildFlowGraph(parseFlow(AFTER).doc!, emptyPositions(), "modern");
  expect(accepted.edges.map((e) => (e.data as SeqEdgeData).m.number?.n)).toEqual([1, 2, 3]);
  expect(accepted.edges.map((e) => e.ariaLabel)).toEqual(["Message 1, hi", "Message 2, ok", "Message 3, tell"]);
});
