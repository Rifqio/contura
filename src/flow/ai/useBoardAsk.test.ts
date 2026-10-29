import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AiEvent, AppendTurn, DiagramAskRequest, FlowOutline, ProposedChange } from "../../api/types";
import { ER_NOTES } from "../../lang/flow/edits";
import { splitFrames } from "../../lang/flow/board";
import { flowOutline } from "../../lang/flow/outline";
import { parseFlow } from "../../lang/flow/parse";
import type { TextEdit } from "../../lang/protocol";
import { applyEdits } from "../../lang/flow/service";
import { done } from "../../test/aiStream";
import { turnViewOf } from "../../test/aiThreads";
import { callsTo, routeInvoke } from "../../test/invoke";
import type { BoardLayout, FrameLayout } from "../board/boardLayout";
import type { FlowDocApi, NewEntry, Parsed } from "../useFlowDoc";
import { isRefusal, NO_FIT, planBoardLanding, touchedFrames } from "./proposal";
import { boardGateFields } from "./boardInput";
import { addedLines, type BoardCanvasApi, frameSpans, ghostEdits, MAX_TABLE_LINKS, MEASURE_MS, SAVE_MS, SAVE_TIMED_OUT, touchedLines, useBoardAsk } from "./useBoardAsk";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  prepareGate = null;
  turnGate = null;
  flushGate = null;
  vi.useRealTimers();
});

const lines = (...l: string[]) => `${l.join("\n")}\n`;

test("ghost_edits_mark_only_the_changed_lines", () => {
  const before = lines("diagram flow", "A", "B", "C", "A > B", "B > C");
  const after = lines("diagram flow", "A", "B", "New", "C", "A > B", "B > New");
  const edits = ghostEdits(before, after);
  // Applied, they give the new text; each covers only its own lines.
  expect(applyEdits(before, edits)).toBe(after);
  expect(edits).toEqual([
    { from: before.indexOf("C\n"), to: before.indexOf("C\n"), insert: "New\n" },
    { from: before.indexOf("B > C"), to: before.indexOf("B > C") + "B > C\n".length, insert: "B > New\n" },
  ]);
  expect(ghostEdits(before, before)).toEqual([]);
  // A text without a last line break still works.
  expect(applyEdits("A\nB", ghostEdits("A\nB", "A\nC"))).toBe("A\nC");
});

// Final review C1: the review diffs only the touched frames, each on its own, so a big board is never one table.
const BOARD3 = lines('diagram flow "A"', "X", "Y", "", 'diagram flow "B"', "P", "", 'diagram flow "C"', "Q");
const titles3 = ["A", "B", "C"];
const addTo = (index: number, frame: string, name: string): ProposedChange => ({ index, op: { add_node: { name, frame } }, status: { kind: "ok" }, dependsOn: [], frame });

function plan3(text: string, changes: ProposedChange[]) {
  const touched = touchedFrames(text, splitFrames(text), titles3, changes);
  const plan = planBoardLanding(text, touched, changes, new Set(changes.map((c) => c.index)), { titles: titles3, shapes: 4 });
  if (isRefusal(plan)) throw new Error(plan.message);
  return { touched, plan };
}

test("the review diff by frame gives the same marks as the whole text, and new frames are added lines", () => {
  const changes = [addTo(0, "A", "New A"), addTo(1, "C", "New C"), { index: 2, op: { add_frame: { title: "D", kind: "flow" } }, status: { kind: "ok" }, dependsOn: [] } as ProposedChange];
  const { touched, plan } = plan3(BOARD3, changes);
  const spans = frameSpans(touched, plan);
  expect(spans.map((s) => s.from)).toEqual([0, BOARD3.indexOf('diagram flow "C"')]);
  const edits = ghostEdits(BOARD3, plan.text, spans);
  expect(applyEdits(BOARD3, edits)).toBe(plan.text);
  expect(edits).toEqual(ghostEdits(BOARD3, plan.text));
  expect(touchedLines(BOARD3, plan.text, spans)).toEqual(touchedLines(BOARD3, plan.text));
  expect(addedLines(BOARD3, plan.text, spans)).toEqual(addedLines(BOARD3, plan.text));
  // Frame B is not in any span and keeps no mark.
  const b = BOARD3.indexOf('diagram flow "B"');
  expect(edits.some((e) => e.from >= b && e.from < BOARD3.indexOf('diagram flow "C"'))).toBe(false);
});

test("a frame rewritten past the diff cap is marked whole, and only that frame", () => {
  const big = Array.from({ length: 1200 }, (_, i) => `N${i}`);
  const text = lines('diagram flow "A"', "X", "", 'diagram flow "B"', ...big, "", 'diagram flow "C"', "Q");
  const from = text.indexOf('diagram flow "B"');
  const to = text.indexOf('diagram flow "C"');
  const rewritten = lines('diagram flow "B"', ...big.map((n) => `${n} renamed`), "");
  const after = text.slice(0, from) + rewritten + text.slice(to);
  const spans = [{ from, to, after: rewritten }];
  const edits = ghostEdits(text, after, spans);
  expect(applyEdits(text, edits)).toBe(after);
  expect(edits).toHaveLength(1);
  expect(edits[0].from).toBe(from + 'diagram flow "B"\n'.length);
  expect(edits[0].to).toBe(from + 'diagram flow "B"\n'.length + big.map((n) => `${n}\n`).join("").length);
  // The removed lines, and the line the new ones go before (as for any replace).
  expect(touchedLines(text, after, spans)).toEqual(Array.from({ length: 1201 }, (_, i) => 5 + i));
  expect(addedLines(text, after, spans)).toEqual(Array.from({ length: 1200 }, (_, i) => 5 + i));
});

// ----- Task 4b (A25): the request names the frames drawn from a Connection and the nodes linked to tables.

const ERD = 'diagram er "shop"\norders {\n  id int pk\n}\n';
const FLOW = 'diagram flow "Checkout"\nOrders [table: shop.orders]\nShip\nOrders > Ship\n';
const SOURCE = { connectionId: "c1", database: "shop", schema: null };

const entry = (source?: FrameLayout["source"]): FrameLayout => ({ at: { x: 0, y: 0 }, nodes: {}, style: "modern", direction: "TB", ...(source ? { source } : {}) });

const frameOf = (index: number, title: string, from: number, to: number) => ({ index, kind: null, title, from, to, line: 1, doc: null, lastValid: null, docId: null, lastValidId: null });

/** A doc stand-in holding `text` as frames titled `titles`, with `board` as its layout. */
function fakeDoc(text: string, titles: string[], board: BoardLayout): FlowDocApi {
  const parsed = {
    result: { kind: null, doc: null, problems: [], lastValid: null, frames: titles.map((t, i) => frameOf(i, t, 0, text.length)), version: 3 },
    text,
    drawn: null,
    errorLine: null,
    frame: null,
    keys: titles,
  } as unknown as Parsed;
  const hold = Object.assign(() => {}, { settled: Promise.resolve() });
  return {
    docId: "d1",
    parsed,
    board,
    current: async () => parsed,
    flush: async () => true,
    hold: () => hold,
    selection: () => null,
    frameIdNow: () => 0,
    settleProposedIn: () => {},
    reload: () => {},
    land: () => true,
  } as unknown as FlowDocApi;
}

const outlineOf = (nodes: { name: string; tableValue?: string }[]): FlowOutline => ({
  kind: "flowchart",
  kinds: [],
  nodes: nodes.map((n, i) => ({ name: n.name, id: null, kind: null, group: null, line: i + 2, table: n.tableValue !== undefined, ...(n.tableValue ? { tableValue: n.tableValue } : {}) })),
  groups: [],
  links: [],
});

const EMPTY: FlowOutline = { kind: null, kinds: [], nodes: [], groups: [], links: [] };

/** A canvas stand-in: `doc`'s frames as the board, frame 0 with `outline` and the rest empty; nothing selected. */
function fakeCanvas(doc: FlowDocApi, outline: FlowOutline): BoardCanvasApi {
  return {
    input: async () => ({
      frames: doc.parsed!.result.frames.map((f, i) => ({ index: i, title: f.title, kind: null, from: f.from, to: f.to, line: f.line, outline: i === 0 ? outline : EMPTY, problems: [], box: { x: 0, y: 0, w: 100, h: 100 }, clash: false })),
      focus: [],
      selected: { frame: null, shapes: [], sketches: [] },
      sketches: [],
    }),
    centre: () => ({ x: 0, y: 0 }),
    glideTo: () => {},
    ring: () => {},
  };
}

function route(threads: { id: string; updatedAt: number }[] = []) {
  routeInvoke({
    list_ai_threads: () => threads.map((t) => ({ ...t, place: "diagram:board", title: "Earlier", messages: 2, topics: 0 })),
    get_ai_thread: (a) => ({ thread: { id: a.threadId, place: "diagram:board", title: "Earlier", messages: [], updatedAt: 1 }, topics: [], compactions: [] }),
    ai_diagram_preview: () => ({ items: [], tables: { full: [], namesOnly: [], leftOut: [], reasons: [] }, totalBytes: 0, tokens: 0, exact: "", notes: [], log: [], context: null, rows: null }),
    ai_diagram_ask: (a) => {
      const sink = a.events as { onmessage(e: AiEvent): void };
      setTimeout(() => sink.onmessage({ type: "error", error: { kind: "cancelled" }, partial: false } as AiEvent), 0);
      return null;
    },
    ai_cancel_place: () => true,
  });
}

const OPTS = { model: null, picks: null, focus: [], create: null, attachment: null };

async function requests(doc: FlowDocApi, outline: FlowOutline, threads: { id: string; updatedAt: number }[] = []): Promise<{ preview: DiagramAskRequest; ask: DiagramAskRequest }> {
  route(threads);
  const canvas = fakeCanvas(doc, outline);
  const hook = renderHook(() => useBoardAsk("board", doc, "review", canvas));
  // The newest chat of the board has loaded (none when the place has none).
  if (threads.length > 0) await waitFor(() => expect(hook.result.current.thread).not.toBeNull());
  await act(async () => {
    await hook.result.current.preview("What is here?", OPTS);
  });
  await act(async () => {
    await hook.result.current.send("What is here?", OPTS);
  });
  hook.unmount();
  return { preview: callsTo("ai_diagram_preview")[0].request as DiagramAskRequest, ask: callsTo("ai_diagram_ask")[0].request as DiagramAskRequest };
}

test("the_request_lists_each_table_link", async () => {
  const outline = outlineOf([{ name: "Orders", tableValue: "shop.orders" }, { name: "Ship" }]);
  // A one-frame file names no frame.
  const one = await requests(fakeDoc(FLOW, ["Checkout"], { frames: new Map(), sketches: [] }), outline);
  for (const r of [one.preview, one.ask]) expect(r.tableLinks).toEqual([{ frame: null, node: "Orders", table: "shop.orders" }]);
  vi.clearAllMocks();
  // On a board each link names the frame its outline is of.
  const board = await requests(fakeDoc(`${ERD}\n${FLOW}`, ["shop", "Checkout"], { frames: new Map(), sketches: [] }), outline);
  for (const r of [board.preview, board.ask]) expect(r.tableLinks).toEqual([{ frame: "shop", node: "Orders", table: "shop.orders" }]);
  vi.clearAllMocks();
  // No link: the field is left out, so a request reads as before.
  const none = await requests(fakeDoc(FLOW, ["Checkout"], { frames: new Map(), sketches: [] }), outlineOf([{ name: "Ship" }]));
  expect(none.preview.tableLinks).toBeUndefined();
  expect(none.preview.sources).toBeUndefined();
});

test("the_request_lists_each_sourced_frame", async () => {
  const frames = new Map<string, FrameLayout>([
    ["shop", entry(SOURCE)],
    ["Checkout", entry()],
    // An entry whose frame is gone (kept for undo) sends nothing.
    ["Gone ERD", entry({ connectionId: "c9", database: "old", schema: null })],
  ]);
  const doc = fakeDoc(`${ERD}\n${FLOW}`, ["shop", "Checkout"], { frames, sketches: [] });
  const r = await requests(doc, outlineOf([{ name: "Ship" }]));
  for (const req of [r.preview, r.ask]) expect(req.sources).toEqual([{ frame: "shop", connectionId: "c1", database: "shop", schema: null }]);
});

test("the_request_lists_at_most_500_table_links", () => {
  // The Core reads every `table:` in the text itself, so the list is only a hint: past the Core's cap it is cut, never
  // sent whole for a refusal.
  expect(MAX_TABLE_LINKS).toBe(500);
  const doc = fakeDoc(FLOW, ["Checkout"], { frames: new Map(), sketches: [] });
  const many = outlineOf(Array.from({ length: 501 }, (_, i) => ({ name: `N${i}`, tableValue: `shop.t${i}` })));
  const frame = { index: 0, title: "Checkout", kind: null, from: 0, to: FLOW.length, line: 1, outline: many, problems: [] };
  const f = boardGateFields(doc.parsed!, doc.board, [frame]);
  expect(f.tableLinks).toHaveLength(500);
  expect(f.tableLinks?.[499]).toEqual({ frame: null, node: "N499", table: "shop.t499" });
});

// ----- Task 10: the board's chat goes with each Ask (Decision 9).

test("send_passes_the_thread_id", async () => {
  const doc = fakeDoc(`${ERD}\n${FLOW}`, ["shop", "Checkout"], { frames: new Map(), sketches: [] });
  // A new chat names none.
  const fresh = await requests(doc, outlineOf([{ name: "Ship" }]));
  for (const r of [fresh.preview, fresh.ask]) expect(r.threadId).toBeNull();
  vi.clearAllMocks();
  // The board's newest chat is the one the preview and the Ask name.
  const r = await requests(doc, outlineOf([{ name: "Ship" }]), [
    { id: "t-old", updatedAt: 1 },
    { id: "t-new", updatedAt: 9 },
  ]);
  for (const req of [r.preview, r.ask]) {
    expect(req.threadId).toBe("t-new");
    expect(req.board?.frames.map((f) => f.title)).toEqual(["shop", "Checkout"]);
    expect(req.scope).toEqual({ kind: "whole" });
  }
});

// ----- Task 7 fix round 1: a refused landing says why.

/** An Ask that answers with `changes` on `doc`, then Accept all; the problem the review shows after it. */
async function acceptAllProblem(doc: FlowDocApi, outline: FlowOutline, changes: ProposedChange[]): Promise<string | null> {
  routeInvoke({
    list_ai_threads: () => [],
    ai_diagram_ask: (a) => {
      const sink = a.events as { onmessage(e: AiEvent): void };
      const proposal = { type: "proposal", proposal: { file: "board", baseHash: "b1", changes }, input: "{}" } as AiEvent;
      setTimeout(() => [proposal, done()].forEach((e) => sink.onmessage(e)), 0);
      return null;
    },
    ai_append_turn: (a) => turnViewOf(a.turn as AppendTurn, null),
    ai_record_tool_result: (a) => a.outcome,
    ai_cancel_place: () => true,
  });
  const canvas = fakeCanvas(doc, outline);
  const hook = renderHook(() => useBoardAsk("board", doc, "review", canvas));
  await act(async () => {
    await hook.result.current.send("Link them", OPTS);
  });
  expect(hook.result.current.waiting?.step).toBe("review");
  act(() => hook.result.current.acceptAll());
  const problem = hook.result.current.waiting?.problem ?? null;
  hook.unmount();
  return problem;
}

test("a_refused_landing_shows_why", async () => {
  const quoted = lines('diagram er "shop"', '"crm:people" {', "  id int", "}", "orders {", "  t_id int", "}");
  const doc = fakeDoc(quoted, ["shop"], { frames: new Map(), sketches: [] });
  const ok = (index: number, op: ProposedChange["op"]): ProposedChange => ({ index, op, status: { kind: "ok" }, dependsOn: [] });
  // The edit's own note: a quoted table takes no column end.
  expect(await acceptAllProblem(doc, outlineOf([]), [ok(0, { add_flow: { from: "orders.t_id", to: "crm:people.id" } })])).toBe(ER_NOTES.quotedEnd("crm:people"));
  vi.clearAllMocks();
  // No note (the line to remove is not there): the generic line.
  expect(await acceptAllProblem(doc, outlineOf([]), [ok(0, { remove_flow: { from: "orders", to: "crm:people" } })])).toBe(NO_FIT);
});

// ----- Task 11: the review across frames, Accept frame and Reject frame, the remove question and the pick.

const BOARD = lines(
  'diagram flow "Checkout"',
  "Cart",
  "Pay",
  "Cart > Pay",
  "",
  'diagram er "Orders ERD"',
  "orders {",
  "  id int pk",
  "  total int",
  "}",
  "",
  'diagram flow "Refund"',
  "Ask",
  "Pay",
  "Ask > Pay",
);

/** What a board doc stand-in was asked to do. */
type DocCalls = {
  land: TextEdit[][];
  landBoard: { edits: TextEdit[]; adds: readonly NewEntry[] }[];
  prepared: { texts: string[]; titles: readonly string[] }[];
  settled: [string, string[]][];
  /** Holds taken and let go. */
  held: number;
  released: number;
};

/** While set, `prepareFrames` waits for it. */
let prepareGate: Promise<void> | null = null;
/** While set, saving a turn waits for it. */
let turnGate: Promise<void> | null = null;
/** While set, flushing the doc waits for it. */
let flushGate: Promise<void> | null = null;

/** A doc stand-in holding `text` as its real frames, keyed `k:<title>`, with frame `selected` selected. */
function boardDoc(text: string, selected = 0): { doc: FlowDocApi; calls: DocCalls; canvas: BoardCanvasApi } {
  const slices = splitFrames(text);
  const parses = slices.map((s) => parseFlow(text.slice(s.from, s.to)));
  const frames = slices.map((s, i) => ({ index: i, kind: parses[i].kind, title: parses[i].title, from: s.from, to: s.to, line: s.line, doc: null, lastValid: null, docId: null, lastValidId: null }));
  const parsed = {
    result: { kind: null, doc: null, problems: [], lastValid: null, frames, version: 3 },
    text,
    drawn: null,
    errorLine: null,
    frame: frames[selected],
    keys: frames.map((f) => `k:${f.title}`),
  } as unknown as Parsed;
  const calls: DocCalls = { land: [], landBoard: [], prepared: [], settled: [], held: 0, released: 0 };
  const hold = () => {
    calls.held++;
    let done = false;
    return Object.assign(
      () => {
        if (!done) calls.released++;
        done = true;
      },
      { settled: Promise.resolve() },
    );
  };
  const doc = {
    docId: "d1",
    parsed,
    board: { frames: new Map(), sketches: [] },
    keys: parsed.keys,
    current: async () => parsed,
    flush: async () => {
      if (flushGate) await flushGate;
      return true;
    },
    hold,
    selection: () => ({ title: frames[selected].title, index: selected }),
    frameIdNow: () => 0,
    settleProposedIn: (key: string, names: ReadonlyMap<string, unknown>) => calls.settled.push([key, [...names.keys()]]),
    prepareFrames: async (fs: { text: string }[], titles: readonly string[]) => {
      calls.prepared.push({ texts: fs.map((f) => f.text), titles });
      if (prepareGate) await prepareGate;
      return { entries: titles.map((title, i) => ({ title, after: { ...entry(), at: { x: 1000 + 500 * i, y: 40 } } })), boxes: titles.map((_, i) => ({ x: 1010 + 500 * i, y: 50, w: 300, h: 200 })) };
    },
    land: (edits: TextEdit[]) => calls.land.push(edits) > 0,
    landBoard: (edits: TextEdit[], _v: number, adds: readonly NewEntry[]) => calls.landBoard.push({ edits, adds }) > 0,
    reload: async () => true,
  } as unknown as FlowDocApi;
  const canvas: BoardCanvasApi = {
    input: async () => ({
      frames: frames.map((f, i) => {
        const own = text.slice(f.from, f.to);
        return { index: i, title: f.title, kind: f.kind, from: f.from, to: f.to, line: f.line, outline: flowOutline(parses[i], null, own), problems: [], box: { x: 0, y: 300 * i, w: 100, h: 100 }, clash: false };
      }),
      focus: [],
      selected: { frame: frames[selected].title, shapes: [], sketches: [] },
      sketches: [],
    }),
    centre: () => ({ x: 900, y: 0 }),
    glideTo: () => {},
    ring: () => {},
  };
  return { doc, calls, canvas };
}

const inFrame = (frame: string, index: number, op: ProposedChange["op"], dependsOn: number[] = []): ProposedChange => ({ index, op, status: { kind: "ok" }, dependsOn, frame });

/** The hook on `text`, each Ask answered with `changes` (an answer with no proposal when null); `mode` is the assist mode. */
function opened(changes: ProposedChange[] | null, opts: { text?: string; mode?: "review" | "auto"; selected?: number } = {}) {
  routeInvoke({
    list_ai_threads: () => [],
    ai_diagram_ask: (a) => {
      const sink = a.events as { onmessage(e: AiEvent): void };
      const proposal = changes ? [{ type: "proposal", proposal: { file: "board", baseHash: "b1", changes }, input: "{}" } as AiEvent] : [];
      setTimeout(() => [{ type: "delta", text: "Here." } as AiEvent, ...proposal, done()].forEach((e) => sink.onmessage(e)), 0);
      return null;
    },
    ai_append_turn: async (a) => {
      if (turnGate) await turnGate;
      return turnViewOf(a.turn as AppendTurn, null);
    },
    ai_record_tool_result: (a) => a.outcome,
    ai_cancel_place: () => true,
  });
  const text = opts.text ?? BOARD;
  const { doc, calls, canvas } = boardDoc(text, opts.selected ?? 0);
  const hook = renderHook(({ name }: { name: string }) => useBoardAsk(name, doc, opts.mode ?? "review", canvas), { initialProps: { name: "board" } });
  return { hook, doc, calls, text };
}

/** The hook on `text` answering one Ask with `changes`; `mode` is the assist mode. */
async function proposed(changes: ProposedChange[], opts: { text?: string; mode?: "review" | "auto"; selected?: number } = {}) {
  const { hook, doc, calls, text } = opened(changes, opts);
  await act(async () => {
    await hook.result.current.send("Change it", OPTS);
  });
  const ai = () => hook.result.current;
  /** The text the last landing wrote. */
  const landedText = () => {
    const edits = calls.landBoard.length ? calls.landBoard[calls.landBoard.length - 1].edits : calls.land[calls.land.length - 1];
    return applyEdits(text, edits);
  };
  return { hook, ai, calls, doc, landedText };
}

/** The text of frame `title` in `text`. */
function frameText(text: string, title: string): string {
  const s = splitFrames(text).find((f) => parseFlow(text.slice(f.from, f.to)).title === title)!;
  return text.slice(s.from, s.to);
}

test("a_proposal_in_two_frames_shows_on_both", async () => {
  const { ai, hook } = await proposed([inFrame("Checkout", 0, { add_node: { name: "Ship" } }), inFrame("Refund", 1, { add_node: { name: "Refunded" } }), inFrame("Refund", 2, { add_flow: { from: "Pay", to: "Refunded" } }, [1])]);
  expect(ai().waiting?.step).toBe("review");
  // Only the two frames the changes name were parsed; the ERD between them was not.
  expect(ai().waiting!.touched.map((t) => t.title)).toEqual(["Checkout", "Refund"]);
  expect(ai().waiting!.frames.map((f) => f.title)).toEqual(["Checkout", "Orders ERD", "Refund"]);
  // Each frame draws its own changes: the same name in two frames is never confused.
  const review = ai().review!;
  expect([...review.keys()]).toEqual(["Checkout", "Refund"]);
  expect([...review.get("Checkout")!.added]).toEqual(["Ship"]);
  expect([...review.get("Refund")!.added]).toEqual(["Refunded"]);
  expect(review.get("Refund")!.addedLinks.size).toBe(1);
  // Each touched frame's AI Chat tab counts its own changes, by layout key; the toolbar counts them all.
  expect([...ai().pendingByKey]).toEqual([
    ["k:Checkout", 1],
    ["k:Refund", 2],
  ]);
  expect(ai().pending).toBe(3);
  // The selected frame's review is the one drawn over its live nodes.
  expect(ai().overlay).toBe(review.get("Checkout"));
  // Toggles re-plan on the frames parsed on arrival: the same touched list, not a new parse.
  const touched = ai().waiting!.touched;
  act(() => ai().reject(0));
  expect(ai().waiting!.touched).toBe(touched);
  expect([...ai().review!.keys()]).toEqual(["Refund"]);
  hook.unmount();
});

test("accept_frame_and_reject_frame_change_only_that_frame", async () => {
  const { ai, calls, landedText, hook } = await proposed([
    inFrame("Checkout", 0, { add_node: { name: "Ship" } }),
    inFrame("Refund", 1, { add_node: { name: "Refunded" } }),
    inFrame("Refund", 2, { add_flow: { from: "Pay", to: "Refunded" } }, [1]),
  ]);
  act(() => ai().rejectFrame("Refund"));
  expect([...ai().waiting!.rejected].sort()).toEqual([1, 2]);
  expect([...ai().review!.keys()]).toEqual(["Checkout"]);
  expect([...ai().pendingByKey]).toEqual([["k:Checkout", 1]]);
  act(() => ai().acceptFrame("Refund"));
  expect(ai().waiting!.rejected.size).toBe(0);
  act(() => ai().rejectFrame("Checkout"));
  expect([...ai().waiting!.rejected]).toEqual([0]);
  // Accept all lands Refund's changes alone, as one transaction; Checkout is as it was.
  act(() => ai().acceptAll());
  expect(calls.land).toHaveLength(1);
  expect(calls.landBoard).toHaveLength(0);
  const after = landedText();
  expect(frameText(after, "Checkout")).toBe(frameText(BOARD, "Checkout"));
  expect(frameText(after, "Orders ERD")).toBe(frameText(BOARD, "Orders ERD"));
  expect(frameText(after, "Refund")).toContain("Refunded");
  expect(frameText(after, "Refund")).toContain("Pay > Refunded");
  // Each touched frame's proposed places settle against what its text defines after the landing.
  expect(calls.settled.map(([k]) => k)).toEqual(["k:Checkout", "k:Refund"]);
  expect(calls.settled[1][1]).toContain("Refunded");
  expect(calls.settled[0][1]).not.toContain("Ship");
  hook.unmount();
});

test("reject_frame_takes_its_dependents", async () => {
  // A Refund change needs Checkout's new shape: rejecting Checkout's frame takes it too.
  const { ai, hook } = await proposed([
    inFrame("Checkout", 0, { add_node: { name: "Ship" } }),
    inFrame("Checkout", 1, { add_flow: { from: "Pay", to: "Ship" } }, [0]),
    inFrame("Refund", 2, { add_node: { name: "Refunded" } }, [0]),
    inFrame("Refund", 3, { add_node: { name: "Closed" } }),
  ]);
  act(() => ai().rejectFrame("Checkout"));
  expect([...ai().waiting!.rejected].sort()).toEqual([0, 1, 2]);
  expect([...ai().review!.get("Refund")!.added]).toEqual(["Closed"]);
  // Accept frame on Refund brings back what it needs from Checkout, not Checkout's other change.
  act(() => ai().acceptFrame("Refund"));
  expect([...ai().waiting!.rejected]).toEqual([1]);
  hook.unmount();
});

test("four_removals_across_frames_ask_first_in_review_too", async () => {
  const removals = [
    inFrame("Checkout", 0, { remove_node: { target: "Cart" } }),
    inFrame("Orders ERD", 1, { remove_column: { table: "orders", column: "total" } }),
    inFrame("Refund", 2, { remove_node: { target: "Ask" } }),
    inFrame("Refund", 3, { remove_node: { target: "Pay" } }),
  ];
  const { ai, calls, landedText, hook } = await proposed(removals);
  // Three shapes and a column, in three frames: more than 3, so the question comes first even in Review first.
  expect(ai().waiting?.step).toBe("remove");
  expect(ai().removal).toMatchObject({ shapes: ["Cart", "Ask", "Pay"], columns: ["orders.total"], frames: ["Checkout", "Orders ERD", "Refund"], adds: 0 });
  expect(calls.land).toHaveLength(0);
  act(() => ai().removeAll());
  expect(calls.land).toHaveLength(1);
  const after = landedText();
  expect(frameText(after, "Orders ERD")).not.toContain("total");
  expect(frameText(after, "Refund")).not.toContain("Ask");
  hook.unmount();
  vi.clearAllMocks();
  // Three removals land straight to review.
  const three = await proposed(removals.slice(0, 3));
  expect(three.ai().waiting?.step).toBe("review");
  three.hook.unmount();
});

test("an_ambiguous_word_picks_within_its_frame", async () => {
  // "pay" in Refund could be Refund's Pay, and the Core also offered Checkout's Cart: only Refund's own shapes are offered.
  const candidates = [
    { name: "Pay", id: null, line: 3, detail: "line 3" },
    { name: "Cart", id: null, line: 2, detail: "line 2" },
  ];
  const unclear: ProposedChange = { index: 0, op: { add_flow: { from: "word", to: "Ask" } }, status: { kind: "ambiguous", field: "from", word: "pay", candidates }, dependsOn: [], frame: "Refund" };
  const { ai, calls, landedText, hook } = await proposed([unclear, inFrame("Checkout", 1, { add_node: { name: "Ship" } })], { selected: 2 });
  expect(ai().waiting?.step).toBe("pick");
  expect(ai().picking?.frame).toBe("Refund");
  const offered = ai().picking!.change.status;
  expect(offered.kind === "ambiguous" && offered.candidates.map((c) => c.name)).toEqual(["Pay"]);
  // A shape of another frame is refused, by name.
  act(() => ai().pick(candidates[1]));
  expect(ai().waiting?.step).toBe("pick");
  expect(ai().waiting?.problem).toBe("Cart is not in Refund. Pick another, or cancel.");
  act(() => ai().pick(candidates[0]));
  expect(ai().waiting?.step).toBe("review");
  act(() => ai().acceptAll());
  expect(calls.land).toHaveLength(1);
  const after = landedText();
  // Refund gets the line from its own Pay; Checkout's Pay has no new line.
  expect(frameText(after, "Refund")).toContain("Pay > Ask");
  expect(frameText(after, "Checkout")).not.toContain("Pay > Ask");
  hook.unmount();
});

test("a_proposal_that_adds_a_frame_measures_it_once_and_lands_it_with_the_edits", async () => {
  const { ai, calls, hook } = await proposed([
    { index: 0, op: { add_frame: { title: "Shipping", kind: "flow" } }, status: { kind: "ok" }, dependsOn: [] },
    inFrame("Shipping", 1, { add_node: { name: "Ship" } }, [0]),
    inFrame("Checkout", 2, { add_node: { name: "Box" } }),
  ]);
  // Measured once, on arrival, with the frame's text as the whole set lands it and the title appendFrames writes.
  expect(calls.prepared).toHaveLength(1);
  expect(calls.prepared[0].titles).toEqual(["Shipping"]);
  expect(calls.prepared[0].texts[0]).toContain("Ship");
  expect(ai().waiting!.newFrames?.entries.map((e) => e.title)).toEqual(["Shipping"]);
  // The review shows it where the landing writes it.
  expect(ai().proposedAt.get("Shipping")).toEqual({ x: 1000, y: 40 });
  expect(ai().review!.get("Shipping")?.isNew).toBe(true);
  // Toggles never measure again.
  act(() => ai().reject(2));
  act(() => ai().accept(2));
  expect(calls.prepared).toHaveLength(1);
  act(() => ai().acceptAll());
  expect(calls.land).toHaveLength(0);
  expect(calls.landBoard).toHaveLength(1);
  expect(calls.landBoard[0].adds).toEqual([{ title: "Shipping", after: { ...entry(), at: { x: 1000, y: 40 } } }]);
  expect(ai().landed).not.toBeNull();
  hook.unmount();
  vi.clearAllMocks();
  // With the new frame rejected, the landing writes the text alone.
  const r = await proposed([{ index: 0, op: { add_frame: { title: "Shipping", kind: "flow" } }, status: { kind: "ok" }, dependsOn: [] }, inFrame("Checkout", 1, { add_node: { name: "Box" } })]);
  act(() => r.ai().rejectFrame("Shipping"));
  act(() => r.ai().acceptAll());
  expect(r.calls.landBoard).toHaveLength(0);
  expect(r.calls.land).toHaveLength(1);
  r.hook.unmount();
});

// ----- Task 11 fix round 1: the hold race, Remove under Auto-apply, stable keys.

const NEW_FRAME: ProposedChange[] = [{ index: 0, op: { add_frame: { title: "Shipping", kind: "flow" } }, status: { kind: "ok" }, dependsOn: [] }, inFrame("Shipping", 1, { add_node: { name: "Ship" } }, [0])];

/** A gate and the function that opens it. */
function gate(): [Promise<void>, () => void] {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return [p, open];
}

test("every_hold_is_released_when_a_send_comes_while_new_frames_are_measured", async () => {
  const [p, open] = gate();
  prepareGate = p;
  const { hook, calls } = opened(NEW_FRAME);
  const ai = () => hook.result.current;
  let a!: Promise<unknown>;
  act(() => {
    a = ai().send("Add a shipping diagram", OPTS);
  });
  await waitFor(() => expect(calls.prepared).toHaveLength(1));
  // The answer is being placed: the composer is still busy and the text still held.
  expect(ai().working).not.toBeNull();
  expect(ai().locked).toBe(true);
  await act(async () => {
    await ai().send("Something else", OPTS);
  });
  expect(callsTo("ai_diagram_ask")).toHaveLength(1);
  prepareGate = null;
  await act(async () => {
    open();
    await a;
  });
  expect(ai().working).toBeNull();
  act(() => ai().rejectAll());
  // One hold, one release: saving is never left held.
  expect(calls.held).toBe(1);
  expect(calls.released).toBe(1);
  hook.unmount();
});

test("an_answer_with_no_proposal_never_releases_a_newer_asks_hold", async () => {
  const [p, open] = gate();
  turnGate = p;
  const { hook, calls } = opened(null);
  const ai = () => hook.result.current;
  let a!: Promise<unknown>;
  act(() => {
    a = ai().send("What is here?", OPTS);
  });
  await waitFor(() => expect(callsTo("ai_append_turn")).toHaveLength(1));
  expect(ai().working).not.toBeNull();
  // A send while the answer saves starts nothing, so no second hold is taken for the first answer to let go.
  await act(async () => {
    await ai().send("Something else", OPTS);
  });
  expect(callsTo("ai_diagram_ask")).toHaveLength(1);
  expect(calls.held).toBe(1);
  turnGate = null;
  await act(async () => {
    open();
    await a;
  });
  expect(ai().working).toBeNull();
  expect(calls.released).toBe(calls.held);
  // The next Ask takes its own hold and lets it go.
  await act(async () => {
    await ai().send("Something else", OPTS);
  });
  expect(callsTo("ai_diagram_ask")).toHaveLength(2);
  expect(calls.held).toBe(2);
  expect(calls.released).toBe(2);
  hook.unmount();
});

test("a_proposal_is_not_dropped_when_a_send_comes_in_the_gap", async () => {
  const [p, open] = gate();
  prepareGate = p;
  const { hook, calls } = opened(NEW_FRAME);
  const ai = () => hook.result.current;
  let a!: Promise<unknown>;
  act(() => {
    a = ai().send("Add a shipping diagram", OPTS);
  });
  await waitFor(() => expect(calls.prepared).toHaveLength(1));
  await act(async () => {
    await ai().send("Something else", OPTS);
  });
  prepareGate = null;
  await act(async () => {
    open();
    await a;
  });
  // The first answer's proposal waits for review, with its new frame measured; the second send went nowhere.
  expect(ai().waiting?.step).toBe("review");
  expect(ai().waiting?.newFrames?.entries.map((e) => e.title)).toEqual(["Shipping"]);
  expect(callsTo("ai_diagram_ask")).toHaveLength(1);
  act(() => ai().acceptAll());
  expect(calls.landBoard).toHaveLength(1);
  hook.unmount();
});

test("remove_under_auto_apply_refuses_a_set_that_breaks_a_frame", async () => {
  const { ai, calls, hook } = await proposed(
    [
      inFrame("Checkout", 0, { remove_node: { target: "Cart" } }),
      inFrame("Checkout", 1, { remove_node: { target: "Pay" } }),
      inFrame("Orders ERD", 2, { remove_column: { table: "orders", column: "total" } }),
      inFrame("Refund", 3, { remove_node: { target: "Ask" } }),
      inFrame("Refund", 4, { add_node: { name: "Refunded", kind: "bogus" } }),
    ],
    { mode: "auto" },
  );
  expect(ai().waiting?.step).toBe("remove");
  act(() => ai().removeAll());
  // Remove goes through Auto-apply's check: nothing lands, and the broken card names the frame.
  expect(calls.land).toHaveLength(0);
  expect(calls.landBoard).toHaveLength(0);
  expect(ai().waiting?.step).toBe("broken");
  expect(ai().waiting?.broke).toMatchObject({ frame: "Refund", lineText: expect.stringContaining("Refunded [bogus]") });
  expect(calls.released).toBe(calls.held);
  hook.unmount();
});

test("a_frame_added_above_while_the_card_waits_settles_the_right_frame", async () => {
  const { ai, calls, doc, hook } = await proposed([inFrame("Refund", 0, { add_node: { name: "Refunded", kind: "bogus" } })], { mode: "auto" });
  expect(ai().waiting?.step).toBe("broken");
  // The text is free: the user adds a frame above the others, so every frame's index moves on.
  const parsed = doc.parsed!;
  (doc as { parsed: Parsed }).parsed = { ...parsed, keys: ["k:New", ...parsed.keys] };
  act(() => ai().rejectAll());
  // Refund's places settle under Refund's key, not under the key now at its old index.
  expect(calls.settled.map(([k]) => k)).toEqual(["k:Refund"]);
  hook.unmount();
});

// ----- Task 11 fix round 2: placing an answer is bounded, a diagram switch frees the run, a stopped Ask stays quiet.

/** Lets fake time pass inside act, so timers and the promises they settle run. */
const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

test("new_frames_that_are_never_measured_land_as_text_after_the_bound", async () => {
  vi.useFakeTimers();
  prepareGate = new Promise<void>(() => {});
  const { hook, calls } = opened(NEW_FRAME);
  const ai = () => hook.result.current;
  act(() => void ai().send("Add a shipping diagram", OPTS));
  await pass(10);
  expect(calls.prepared).toHaveLength(1);
  expect(ai().working).not.toBeNull();
  await pass(MEASURE_MS - 100);
  expect(ai().working).not.toBeNull();
  await pass(200);
  // Past the bound the proposal is up for review without measured frames, and Send works again.
  expect(ai().working).toBeNull();
  expect(ai().waiting?.step).toBe("review");
  expect(ai().waiting?.newFrames).toBeNull();
  act(() => ai().acceptAll());
  expect(calls.landBoard).toHaveLength(0);
  expect(calls.land).toHaveLength(1);
  act(() => void ai().send("Something else", OPTS));
  await pass(10);
  expect(callsTo("ai_diagram_ask")).toHaveLength(2);
  hook.unmount();
});

test("a_turn_that_is_never_saved_shows_as_not_saved_after_the_bound", async () => {
  vi.useFakeTimers();
  turnGate = new Promise<void>(() => {});
  const { hook, calls } = opened([inFrame("Checkout", 0, { add_node: { name: "Ship" } })]);
  const ai = () => hook.result.current;
  act(() => void ai().send("Add Ship", OPTS));
  await pass(10);
  expect(callsTo("ai_append_turn")).toHaveLength(1);
  expect(ai().working).not.toBeNull();
  await pass(SAVE_MS);
  // A failed save: said with the usual copy; the proposal still waits, and Send works again once it is decided.
  expect(ai().notSaved).toBe(`Not saved: ${SAVE_TIMED_OUT}`);
  expect(ai().working).toBeNull();
  expect(ai().waiting?.step).toBe("review");
  act(() => ai().rejectAll());
  expect(calls.released).toBe(calls.held);
  act(() => void ai().send("Something else", OPTS));
  await pass(10);
  expect(callsTo("ai_diagram_ask")).toHaveLength(2);
  hook.unmount();
});

test("switching_diagram_mid_placement_frees_send_on_the_new_one", async () => {
  const [p, open] = gate();
  prepareGate = p;
  const { hook, calls } = opened(NEW_FRAME);
  const ai = () => hook.result.current;
  act(() => void ai().send("Add a shipping diagram", OPTS));
  await waitFor(() => expect(calls.prepared).toHaveLength(1));
  // The tab opens another diagram while the answer is placed: its hold goes, and Send on the new one works.
  hook.rerender({ name: "other" });
  expect(calls.released).toBe(calls.held);
  expect(ai().working).toBeNull();
  prepareGate = null;
  let b!: Promise<unknown>;
  act(() => {
    b = ai().send("What is here?", OPTS);
  });
  await waitFor(() => expect(callsTo("ai_diagram_ask")).toHaveLength(2));
  expect((callsTo("ai_diagram_ask")[1].request as DiagramAskRequest).question).toBe("What is here?");
  // The old Ask ends meanwhile and changes nothing of the new one's.
  await act(async () => {
    open();
    await b;
  });
  expect(ai().waiting?.step).toBe("review");
  expect(ai().waiting?.q).toBe("What is here?");
  act(() => ai().rejectAll());
  expect(calls.released).toBe(calls.held);
  hook.unmount();
});

test("a_stopped_ask_leaves_a_newer_one_alone", async () => {
  const [p, open] = gate();
  flushGate = p;
  const { hook, calls } = opened([inFrame("Checkout", 0, { add_node: { name: "Ship" } })]);
  const ai = () => hook.result.current;
  let a!: Promise<unknown>;
  let b!: Promise<unknown>;
  act(() => {
    a = ai().send("First", OPTS);
  });
  // Stopped while the text is saved, then a new question is sent.
  act(() => ai().stop());
  act(() => {
    b = ai().send("Second", OPTS);
  });
  await act(async () => {
    open();
    await a;
  });
  // The first Ask's exit neither ended the second's run nor said anything over it.
  expect(ai().working?.q).toBe("Second");
  expect(ai().failure).toBeNull();
  await act(async () => {
    await b;
  });
  expect(callsTo("ai_diagram_ask")).toHaveLength(1);
  expect((callsTo("ai_diagram_ask")[0].request as DiagramAskRequest).question).toBe("Second");
  expect(ai().waiting?.step).toBe("review");
  act(() => ai().rejectAll());
  expect(calls.released).toBe(calls.held);
  hook.unmount();
});
