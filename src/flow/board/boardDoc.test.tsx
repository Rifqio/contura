// The whole .flow file is one CodeMirror document with one history, and `useFlowDoc` serves the selected
// frame's doc, layout and ops as if it were the one diagram it knows.
import { redo, undo, undoDepth } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, type Extension, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import orderHandover from "../fixtures/order-handover.flow?raw";
import { LangClient, type WorkerLike } from "../../lang/client";
import { splitFrames } from "../../lang/flow/board";
import { parseFlow } from "../../lang/flow/parse";
import type { FromWorker, ToWorker } from "../../lang/protocol";
import { mockEditorDom } from "../../test/editor";
import { routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { patientFile } from "../../test/load";
import { emptyPositions, parseFlowLayout, serializeFlowLayout } from "../layout";
import { BOARD_NOTES } from "../../lang/flow/boardEdits";
import type { FlowBoardOp } from "../../lang/flow/service";
import { type FlowDocApi, frameEffect, goneMark, type HistoryMove, marksIn, type RunResult, useFlowDoc } from "../useFlowDoc";
import { boardGateFields } from "../ai/boardInput";
import { FRAME_GAP, frameBounds, LAYOUT_SAVE_MAX } from "./boardLayout";
import { boardFrameId, createBoardScene, inFrameId } from "./boardScene";
import { canvasEdit, frameView, showFrame, shownRange } from "./frameView";
import { placeFrames } from "./shelf/place";
import { addSketch, moveSketches, removeSketches } from "./sketches";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
patientFile();
beforeAll(() => mockEditorDom());

const CHECKOUT = 'diagram flow "Checkout"\nCart\nPay\nCart > Pay\n';
const REFUND = 'diagram flow "Refund"\nAsk\nRefund it\nAsk > Refund it\n';
const SHIPPING = 'diagram flow "Shipping"\nPack\nSend\nPack > Send\n';
const BOARD = [CHECKOUT, REFUND, SHIPPING].join("\n");

/** Every frame placed and every node positioned, so nothing is placed while a test runs. */
const LAYOUT = JSON.stringify({
  version: 2,
  frames: {
    Checkout: { at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Refund: { at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    Shipping: { at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
  },
  sketches: [],
});

const disk = new Map<string, { text: string; layout: string | null }>();
const views: EditorView[] = [];
const unmounts: (() => void)[] = [];

function routeDisk() {
  routeInvoke({
    read_diagram: ({ name }) => {
      const f = disk.get(String(name));
      if (!f) throw { kind: "notFound", message: `${name}.flow` };
      return f;
    },
    write_diagram: ({ name, text, layout }) => {
      disk.set(String(name), { text: text as string, layout: layout as string });
      return null;
    },
    write_diagram_layout: ({ name, layout }) => {
      const f = disk.get(String(name))!;
      disk.set(String(name), { text: f.text, layout: layout as string });
      return null;
    },
  });
}

afterEach(() => {
  unmounts.splice(0).forEach((u) => u());
  views.splice(0).forEach((v) => v.destroy());
  document.body.innerHTML = "";
  disk.clear();
  vi.mocked(invoke).mockReset();
});

/** The in-process worker, with a switch that holds every message until it is let go. */
function pausableWorker() {
  const inner = fakeWorker();
  let held: ToWorker[] | null = null;
  /** Sees each message first; true when it took the message (it forwards it itself with `send`). */
  let tap: ((m: ToWorker, send: (m: ToWorker) => void) => boolean) | null = null;
  const outer: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(m: ToWorker) {
      if (tap?.(m, (x) => inner.postMessage(x))) return;
      if (held) held.push(m);
      else inner.postMessage(m);
    },
    terminate() {},
  };
  /** Sees each answer first; true when it took the answer (it delivers it itself with `deliver`). */
  let tapOut: ((m: FromWorker, deliver: () => void) => boolean) | null = null;
  inner.onmessage = (e) => {
    const deliver = () => outer.onmessage?.(e);
    if (tapOut?.(e.data as FromWorker, deliver)) return;
    deliver();
  };
  return {
    worker: outer,
    pause: () => {
      held = held ?? [];
    },
    resume: () => {
      const q = held ?? [];
      held = null;
      for (const m of q) inner.postMessage(m);
    },
    tap: (fn: typeof tap) => {
      tap = fn;
    },
    tapOut: (fn: typeof tapOut) => {
      tapOut = fn;
    },
  };
}

type Opened = { doc: () => FlowDocApi; view: EditorView; worker: ReturnType<typeof pausableWorker> };

async function open(text: string, layout: string | null = LAYOUT, extra: Extension[] = []): Promise<Opened> {
  disk.set("board", { text, layout });
  routeDisk();
  const worker = pausableWorker();
  const client = new LangClient(() => worker.worker);
  const hook = renderHook(() => useFlowDoc("board", client));
  unmounts.push(() => hook.unmount());
  await waitFor(() => expect(hook.result.current.initialText).not.toBeNull());
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent, state: EditorState.create({ doc: hook.result.current.initialText!, extensions: [...hook.result.current.extensions, ...extra] }) });
  views.push(view);
  act(() => hook.result.current.attach(view));
  await waitFor(() => expect(hook.result.current.parsed?.text).toBe(view.state.doc.toString()));
  return { doc: () => hook.result.current, view, worker };
}

const framesOf = (text: string) => splitFrames(text).map((f) => text.slice(f.from, f.to));
const textOf = (o: Opened) => o.view.state.doc.toString();
/** Waits for the parse of the editor's text. */
const settled = (o: Opened) => waitFor(() => expect(o.doc().parsed?.text).toBe(textOf(o)), { interval: 5 });
const entry = (o: Opened, key: string) => o.doc().board.frames.get(key);
const saved = () => JSON.parse(disk.get("board")!.layout!) as { frames: Record<string, { at: { x: number; y: number }; nodes: Record<string, { x: number; y: number }> }> };

/** Replaces the first `find` after `from` with `insert`, as typing does. */
function type(o: Opened, find: string, insert: string, from = 0) {
  const at = textOf(o).indexOf(find, from);
  expect(at).toBeGreaterThanOrEqual(0);
  act(() => {
    o.view.dispatch({ changes: { from: at, to: at + find.length, insert }, userEvent: "input.type" });
  });
}

const undoOnce = (o: Opened) => act(() => void undo(o.view));

test("run_edits_the_selected_frame", async () => {
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Refund", index: 1 }));
  await act(async () => {
    await o.doc().run({ op: "addNode", name: "Ship", kind: null });
  });
  const frames = framesOf(textOf(o));
  expect(frames[1]).toContain("Ship\n");
  // Frames 0 and 2 byte for byte unchanged.
  expect(frames[0]).toBe(framesOf(BOARD)[0]);
  expect(frames[2]).toBe(framesOf(BOARD)[2]);
});

test("hand_rename_then_two_undos_before_a_parse", async () => {
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  act(() => o.doc().move({ Cart: { x: 300, y: 40 } }));
  expect(entry(o, "Checkout")?.nodes.Cart).toEqual({ x: 300, y: 40 });
  o.worker.pause();
  type(o, '"Checkout"', '"Pay flow"');
  // The entry is re-keyed at once, before any parse.
  expect(o.doc().keys).toEqual(["Pay flow", "Refund", "Shipping"]);
  expect(entry(o, "Pay flow")?.nodes.Cart).toEqual({ x: 300, y: 40 });
  expect(entry(o, "Checkout")).toBeUndefined();
  expect(o.doc().selected).toEqual({ title: "Pay flow", index: 0 });
  undoOnce(o);
  undoOnce(o);
  expect(textOf(o)).toBe(BOARD);
  expect(o.doc().keys).toEqual(["Checkout", "Refund", "Shipping"]);
  expect(entry(o, "Checkout")?.nodes.Cart).toEqual({ x: 0, y: 0 });
  expect([...o.doc().board.frames.keys()].sort()).toEqual(["Checkout", "Refund", "Shipping"]);
  o.worker.resume();
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(Object.keys(saved().frames).sort()).toEqual(["Checkout", "Refund", "Shipping"]);
});

test("a_broken_frame_keeps_its_positions", async () => {
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  // A typo in frame 2 while frame 0 is selected: its text no longer defines Send.
  type(o, "Pack > Send", "Pack >", textOf(o).indexOf('"Shipping"'));
  type(o, "\nSend\n", "\n", textOf(o).indexOf('"Shipping"'));
  await settled(o);
  expect(o.doc().parsed?.result.frames[2].doc).toBeNull();
  expect(o.doc().parsed?.result.doc).not.toBeNull();
  // Frame 0 is drawn from its own doc; frame 2 keeps its last good one for the canvas.
  expect(o.doc().parsed?.result.frames[2].lastValid?.nodes.map((n) => n.name)).toEqual(["Pack", "Send"]);
  await act(async () => {
    await o.doc().flush();
  });
  expect(saved().frames.Shipping).toEqual({ at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" });
});

test("undo_of_a_move_lands_in_its_own_frame", async () => {
  const o = await open(BOARD);
  const moves: HistoryMove[] = [];
  unmounts.push(o.doc().onHistoryMove((m) => moves.push(m)));
  act(() => o.doc().select({ title: "Refund", index: 1 }));
  act(() => o.doc().move({ Ask: { x: 90, y: 90 } }));
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  undoOnce(o);
  expect(entry(o, "Refund")?.nodes.Ask).toEqual({ x: 0, y: 0 });
  expect(entry(o, "Checkout")?.nodes).toEqual({ Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } });
  expect(moves).toEqual([{ from: { Ask: { x: 90, y: 90 } }, to: { Ask: { x: 0, y: 0 } }, undo: true, frame: "Refund" }]);
  // The selected frame's layout is Checkout's, untouched.
  expect(o.doc().layout.nodes).toEqual({ Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } });
});

test("a_hand_edited_title_keeps_the_frame_in_place", async () => {
  const o = await open(BOARD);
  type(o, '"Refund"', '"Refunds"');
  expect(o.doc().keys).toEqual(["Checkout", "Refunds", "Shipping"]);
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(Object.keys(saved().frames).sort()).toEqual(["Checkout", "Refunds", "Shipping"]);
  expect(saved().frames.Refunds.at).toEqual({ x: 600, y: 0 });
  expect(saved().frames.Refunds.nodes).toEqual({ Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } });
});

test("typing_through_a_taken_title_keeps_the_entry", async () => {
  const o = await open(BOARD);
  type(o, '"Shipping"', '""');
  const at = textOf(o).lastIndexOf('""') + 1;
  const word = "Checkouts";
  for (let i = 0; i < word.length; i++) {
    act(() => {
      o.view.dispatch({ changes: { from: at + i, insert: word[i] }, userEvent: "input.type" });
    });
    const keys = o.doc().keys;
    // No two frames ever share a key, and the first "Checkout" keeps its own.
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe("Checkout");
    if (i === word.length - 2) expect(keys[2]).toBe("Checkou");
  }
  expect(o.doc().keys).toEqual(["Checkout", "Refund", "Checkouts"]);
  expect(entry(o, "Checkouts")).toEqual({ at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" });
  expect(entry(o, "Checkout")?.at).toEqual({ x: 0, y: 0 });
  expect([...o.doc().board.frames.keys()].sort()).toEqual(["Checkout", "Checkouts", "Refund"]);
});

test("a_frame_with_a_taken_title_is_laid_out_and_never_saved", async () => {
  // Review Focus 4: two frames titled "Checkout". The second has no entry, so it is laid out for drawing only.
  const text = BOARD.replace('"Shipping"', '"Checkout"');
  const o = await open(text);
  expect(o.doc().keys).toEqual(["Checkout", "Refund", "\u0000#2"]);
  await waitFor(() => expect(Object.keys(o.doc().clashLayouts.get(2)?.entry.nodes ?? {}).sort()).toEqual(["Pack", "Send"]));
  const c = o.doc().clashLayouts.get(2)!;
  expect(c.title).toBe("Checkout");
  const nodes = c.entry.nodes;
  expect(nodes.Pack).not.toEqual(nodes.Send);
  // Placed beside the other frames, overlapping none.
  const docs = o.doc().parsed!.result.frames.map((f) => f.doc!);
  const mine = frameBounds(c.entry, docs[2], "modern", true);
  for (const [i, k] of ["Checkout", "Refund"].entries()) {
    const b = frameBounds(entry(o, k)!, docs[i], "modern");
    expect(mine.x >= b.x + b.w || b.x >= mine.x + mine.w || mine.y >= b.y + b.h || b.y >= mine.y + mine.h).toBe(true);
  }
  // Never in the board's entries, never in the file.
  expect([...o.doc().board.frames.keys()].every((k) => !k.startsWith("\u0000"))).toBe(true);
  type(o, "Ask > Refund it", "Ask > Refund it: ok");
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(Object.keys(saved().frames).sort()).toEqual(["Checkout", "Refund", "Shipping"]);
  // Once the title is its own, the layout made for the clash goes.
  type(o, '"Checkout"\nPack', '"Packing"\nPack');
  await settled(o);
  await waitFor(() => expect(o.doc().clashLayouts.size).toBe(0));
});

test("a_header_insert_before_the_parse_lands_keeps_every_frame_on_its_entry", async () => {
  const o = await open(BOARD);
  const scene = createBoardScene("modern");
  const draw = () => {
    const p = o.doc().parsed!;
    return scene.build(p.result.frames, o.doc().board, p.keys, null, null, []);
  };
  const s0 = draw();
  // A new frame typed above Refund; its parse has not landed yet.
  o.worker.pause();
  type(o, 'diagram flow "Refund"', 'diagram flow "Returns"\nBack\n\ndiagram flow "Refund"');
  // The header keys already follow the new text; the parse's own keys still match the frames it drew.
  expect(o.doc().keys).toEqual(["Checkout", "Returns", "Refund", "Shipping"]);
  expect(o.doc().parsed!.keys).toEqual(["Checkout", "Refund", "Shipping"]);
  const s1 = draw();
  // Nothing moves or remounts before the parse lands: the very same objects.
  expect(s1.nodes.length).toBe(s0.nodes.length);
  s1.nodes.forEach((n, i) => expect(n).toBe(s0.nodes[i]));
  s1.edges.forEach((e, i) => expect(e).toBe(s0.edges[i]));
  o.worker.resume();
  await settled(o);
  expect(o.doc().parsed!.keys).toEqual(["Checkout", "Returns", "Refund", "Shipping"]);
  const s2 = draw();
  const ids = s2.nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  // Each frame on its own entry and id: Refund's and Shipping's shapes where their entries put them.
  for (const [key, name] of [["Refund", "Ask"], ["Shipping", "Pack"]] as const) {
    const e = entry(o, key)!;
    const box = s2.nodes.find((n) => n.id === boardFrameId(key))!;
    const child = s2.nodes.find((n) => n.id === inFrameId(key, name))!;
    expect(child.parentId).toBe(boardFrameId(key));
    expect({ x: box.position.x + child.position.x, y: box.position.y + child.position.y }).toEqual({ x: e.at.x + e.nodes[name].x, y: e.at.y + e.nodes[name].y });
  }
  expect(s2.boxes.map((b) => b.key)).toEqual(["Checkout", "Returns", "Refund", "Shipping"]);
  // A hand rename keeps its frame on its entry before its parse lands too.
  o.worker.pause();
  type(o, '"Shipping"', '"Shipment"');
  expect(o.doc().parsed!.keys[3]).toBe("Shipment");
  expect(entry(o, "Shipment")).toBeDefined();
  o.worker.resume();
  await settled(o);
});

test("a_clash_layout_keeps_only_its_frames_names", async () => {
  const o = await open(BOARD.replace('"Shipping"', '"Checkout"'));
  await waitFor(() => expect(Object.keys(o.doc().clashLayouts.get(2)?.entry.nodes ?? {}).sort()).toEqual(["Pack", "Send"]));
  // Typing a new node name letter by letter in the clash frame: the gone prefixes leave its layout.
  const at = textOf(o).lastIndexOf("Pack > Send");
  act(() => o.view.dispatch({ changes: { from: at, insert: "\n" }, userEvent: "input.type" }));
  const word = "Wrap";
  for (let i = 0; i < word.length; i++) {
    act(() => o.view.dispatch({ changes: { from: at + i, insert: word[i] }, userEvent: "input.type" }));
    await settled(o);
    await waitFor(() => expect(Object.keys(o.doc().clashLayouts.get(2)?.entry.nodes ?? {})).toContain(word.slice(0, i + 1)));
  }
  expect(Object.keys(o.doc().clashLayouts.get(2)!.entry.nodes).sort()).toEqual(["Pack", "Send", "Wrap"]);
});

test("frames_without_entries_are_placed_beside_frame_zero", async () => {
  // A version 1 file: only frame 0 has an entry.
  const v1 = serializeFlowLayout({ version: 1, nodes: Object.assign(emptyPositions(), { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }), style: "modern", direction: "TB" });
  const o = await open(BOARD, v1);
  expect(o.doc().selected).toBeNull();
  await waitFor(() => {
    for (const k of ["Refund", "Shipping"]) expect(Object.keys(entry(o, k)?.nodes ?? {})).toHaveLength(2);
  });
  const docs = o.doc().parsed!.result.frames.map((f) => f.doc!);
  const boxes = ["Checkout", "Refund", "Shipping"].map((k, i) => frameBounds(entry(o, k)!, docs[i], "modern"));
  expect(boxes[1].x).toBeGreaterThanOrEqual(boxes[0].x + boxes[0].w);
  expect(boxes[2].x).toBeGreaterThanOrEqual(boxes[1].x + boxes[1].w);
  const overlap = (a: (typeof boxes)[0], b: (typeof boxes)[0]) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  expect(overlap(boxes[0], boxes[1]) || overlap(boxes[1], boxes[2]) || overlap(boxes[0], boxes[2])).toBe(false);
  // Laid out by today's dagre call: the two nodes of a link are not stacked.
  const r = entry(o, "Refund")!.nodes;
  expect(r.Ask).not.toEqual(r["Refund it"]);
});

test("a_deleted_frame_text_keeps_its_entry_for_undo", async () => {
  const o = await open(BOARD);
  const from = textOf(o).indexOf('diagram flow "Refund"');
  const to = textOf(o).indexOf('diagram flow "Shipping"');
  act(() => {
    o.view.dispatch({ changes: { from, to }, userEvent: "delete" });
  });
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(Object.keys(saved().frames).sort()).toEqual(["Checkout", "Shipping"]);
  expect(entry(o, "Refund")?.at).toEqual({ x: 600, y: 0 });
  undoOnce(o);
  expect(textOf(o)).toBe(BOARD);
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(saved().frames.Refund).toEqual({ at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" });
});

test("a_broken_header_keeps_every_entry", async () => {
  const o = await open(BOARD);
  // Refund's text is gone, then frame 0's header stops reading: while it is broken no entry leaves the file.
  const from = textOf(o).indexOf('diagram flow "Refund"');
  act(() => {
    o.view.dispatch({ changes: { from, to: textOf(o).indexOf('diagram flow "Shipping"') } });
  });
  type(o, "diagram flow", "diagram flw");
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(Object.keys(saved().frames).sort()).toEqual(["Checkout", "Refund", "Shipping"]);
  // Fixed again: the gone frame's entry leaves the file; the others stay.
  type(o, "diagram flw", "diagram flow");
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(Object.keys(saved().frames).sort()).toEqual(["Checkout", "Shipping"]);
});

test("direction_and_look_are_undo_entries", async () => {
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Refund", index: 1 }));
  act(() => o.doc().setDirection("LR"));
  act(() => o.doc().setStyle("classic"));
  expect(o.doc().layout.direction).toBe("LR");
  expect(o.doc().layout.style).toBe("classic");
  expect(entry(o, "Checkout")?.direction).toBe("TB");
  undoOnce(o);
  expect(entry(o, "Refund")?.style).toBe("modern");
  expect(entry(o, "Refund")?.direction).toBe("LR");
  undoOnce(o);
  expect(entry(o, "Refund")?.direction).toBe("TB");
  expect(o.doc().layout.direction).toBe("TB");
  // Frame settings too, by key.
  act(() => o.doc().setFrameSetting("Shipping", { textSize: "l" }));
  expect(entry(o, "Shipping")?.textSize).toBe("l");
  undoOnce(o);
  expect(entry(o, "Shipping")?.textSize).toBeUndefined();
});

test("rename_add_delete_and_duplicate_move_layout_with_text_in_one_undo", async () => {
  const o = await open(BOARD);
  const op = async (f: () => Promise<unknown>) => {
    await settled(o);
    await act(async () => {
      await f();
    });
  };
  // Rename: the entry follows the title.
  await op(() => o.doc().frameOp({ op: "renameFrame", frameIndex: 1, title: "Returns" }));
  expect(textOf(o)).toContain('diagram flow "Returns"');
  expect(entry(o, "Returns")?.at).toEqual({ x: 600, y: 0 });
  expect(entry(o, "Refund")).toBeUndefined();
  undoOnce(o);
  expect(textOf(o)).toBe(BOARD);
  expect(entry(o, "Refund")?.at).toEqual({ x: 600, y: 0 });
  expect(entry(o, "Returns")).toBeUndefined();
  // Add, at a given place.
  let added: Added | undefined;
  await op(async () => {
    added = await o.doc().addFrames([{ text: 'diagram state "Life"\n' }], { x: 2000, y: 40 });
  });
  expect(textOf(o)).toContain('diagram state "Life"');
  // Its drawn box is centred on the given place (decision 8).
  const box = boxesOf(added!)[0];
  expect(entry(o, "Life")?.at).toEqual({ x: box.x, y: box.y });
  expect(box.x + box.w / 2).toBeCloseTo(2000, 6);
  expect(box.y + box.h / 2).toBeCloseTo(40, 6);
  undoOnce(o);
  expect(textOf(o)).toBe(BOARD);
  expect(entry(o, "Life")).toBeUndefined();
  // Delete.
  await op(() => o.doc().frameOp({ op: "deleteFrame", frameIndex: 2 }));
  expect(textOf(o)).not.toContain("Shipping");
  expect(entry(o, "Shipping")).toBeUndefined();
  undoOnce(o);
  expect(textOf(o)).toBe(BOARD);
  expect(entry(o, "Shipping")?.at).toEqual({ x: 1200, y: 0 });
  // Duplicate: a copy of the positions, placed beside the board.
  let r: Awaited<ReturnType<FlowDocApi["frameOp"]>> = null;
  await op(async () => {
    r = await o.doc().frameOp({ op: "duplicateFrame", frameIndex: 0 });
  });
  expect(r).toMatchObject({ name: "Checkout 2" });
  expect(framesOf(textOf(o))[1]).toBe(CHECKOUT.replace('"Checkout"', '"Checkout 2"'));
  const copy = entry(o, "Checkout 2")!;
  expect(copy.nodes).toEqual({ Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } });
  expect(copy.nodes).not.toBe(entry(o, "Checkout")!.nodes);
  expect(copy.at.x).toBeGreaterThan(1200);
  undoOnce(o);
  expect(textOf(o)).toBe(BOARD);
  expect(entry(o, "Checkout 2")).toBeUndefined();
});

test("a_save_past_the_budget_keeps_the_text_and_the_last_layout", async () => {
  const o = await open(BOARD);
  // Frame 0 broken keeps every position it is given; positions with long names take the file past the budget.
  type(o, "Cart > Pay", "Cart >");
  await settled(o);
  const big = emptyPositions();
  const pad = "x".repeat(1_000);
  for (let i = 0; i * 1_020 < LAYOUT_SAVE_MAX + 200_000; i++) big[`${pad}${i}`] = { x: i, y: i };
  act(() => o.doc().placeIn("Checkout", big));
  type(o, "Pay\n", "Pay\nWrap\n");
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  const want = textOf(o);
  expect(disk.get("board")!.text).toBe(want);
  // The last saved layout string, byte for byte.
  expect(disk.get("board")!.layout).toBe(LAYOUT);
  expect(o.doc().save).toEqual({ kind: "failed", message: "Layout not saved: the layout file would pass 5 MB. Remove some sketches." });
  const writes = vi.mocked(invoke).mock.calls.filter(([c]) => c === "write_diagram");
  expect(writes.length).toBeGreaterThan(0);
  for (const [, a] of writes) expect((a as { layout: string }).layout).toBe(LAYOUT);
});

test("every_canvas_dispatch_carries_canvas_edit", async () => {
  const seen: Transaction[] = [];
  const o = await open(BOARD, LAYOUT, [frameView(() => {}), EditorView.updateListener.of((u) => seen.push(...u.transactions))]);
  const f1 = splitFrames(textOf(o))[1];
  const end = textOf(o)[f1.to - 1] === "\n" ? f1.to - 1 : f1.to;
  act(() => {
    o.view.dispatch({ effects: showFrame.of({ from: f1.from, to: end, line: f1.line }), selection: EditorSelection.cursor(f1.from) });
  });
  // Frame 1 is shown; a run into frame 0 is not dropped.
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  seen.length = 0;
  await act(async () => {
    await o.doc().run({ op: "addNode", name: "Box", kind: null });
  });
  expect(framesOf(textOf(o))[0]).toContain("Box\n");
  await settled(o);
  // applyFix, land and the layout writes.
  const text = textOf(o);
  expect(o.doc().applyFix([{ from: 0, to: 0, insert: "// a\n" }], text)).toBe(true);
  await settled(o);
  expect(o.doc().land([{ from: 0, to: 0, insert: "// b\n" }], o.doc().parsed!.result.version)).toBe(true);
  act(() => o.doc().move({ Cart: { x: 5, y: 5 } }));
  act(() => o.doc().resize("Cart", { x: 5, y: 5, w: 200, h: 80 }));
  act(() => o.doc().place({ Box: { x: 1, y: 1 } }));
  act(() => o.doc().setDirection("LR"));
  act(() => o.doc().moveFrame("Shipping", { x: 1300, y: 0 }));
  // A frame added after the shown one does not join it.
  await settled(o);
  await act(async () => {
    await o.doc().frameOp({ op: "duplicateFrame", frameIndex: 1 });
  });
  expect(textOf(o)).toContain('"Refund 2"');
  const shownText = o.view.contentDOM.textContent ?? "";
  expect(shownText).toContain("Refund it");
  expect(shownText).not.toContain("Refund 2");
  // reload: the file changed on disk.
  disk.set("board", { text: `${BOARD}// c\n`, layout: LAYOUT });
  await act(async () => {
    expect(await o.doc().reload()).toBe(true);
  });
  expect(textOf(o)).toBe(`${BOARD}// c\n`);
  // Every transaction the document made: a change or an effect of its own (the frame view's gutter reconfigures are its own).
  const isReconfigure = (e: StateEffect<unknown>) => e.is(StateEffect.reconfigure) || (e.value as { compartment?: unknown } | null)?.compartment instanceof Compartment;
  const ours = seen.filter((tr) => tr.docChanged || tr.effects.some((e) => !isReconfigure(e)));
  // run, applyFix, land, move, resize, setDirection, moveFrame, reload, frameOp; place writes no transaction.
  expect(ours.length).toBeGreaterThanOrEqual(9);
  for (const tr of ours) expect(tr.annotation(canvasEdit)).toBe(true);
});

test("effects_resolve_by_index_then_key", async () => {
  const o = await open(BOARD);
  const moves: HistoryMove[] = [];
  unmounts.push(o.doc().onHistoryMove((m) => moves.push(m)));
  act(() => o.doc().select({ title: "Shipping", index: 2 }));
  act(() => o.doc().move({ Pack: { x: 70, y: 70 } }));
  // Frame 1's text goes outside the history (an edit that undo does not take back).
  const cut = (title: string, next: string | null) => {
    const t = textOf(o);
    const from = t.indexOf(`diagram flow "${title}"`);
    act(() => {
      o.view.dispatch({ changes: { from, to: next ? t.indexOf(`diagram flow "${next}"`) : t.length }, annotations: Transaction.addToHistory.of(false) });
    });
  };
  cut("Refund", "Shipping");
  expect(o.doc().keys).toEqual(["Checkout", "Shipping"]);
  undoOnce(o);
  expect(entry(o, "Shipping")?.nodes.Pack).toEqual({ x: 0, y: 0 });
  expect(moves[moves.length - 1]?.frame).toBe("Shipping");
  // Index 0 now names another frame: a move made in Shipping at index 1, with frame 0 gone, still lands in Shipping.
  act(() => o.doc().select({ title: "Shipping", index: 1 }));
  act(() => o.doc().move({ Send: { x: 9, y: 9 } }));
  cut("Checkout", "Shipping");
  expect(o.doc().keys).toEqual(["Shipping"]);
  undoOnce(o);
  expect(entry(o, "Shipping")?.nodes.Send).toEqual({ x: 0, y: 120 });
  expect(entry(o, "Checkout")?.nodes).toEqual({ Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } });
});

test("the_focused_result_carries_old_er_and_error_line", async () => {
  const OLD_ER = 'diagram er "Tables"\ncustomer\norder\ncustomer 1--* order\n';
  // Frame 0 has an error on its line 3; frame 1 is an old-form ER frame with an error of its own.
  const text = `diagram flow "Checkout"\nCart\nCart >\n\n${OLD_ER}order >\n`;
  const o = await open(text, null);
  await settled(o);
  const frame1 = o.doc().parsed!.result.frames[1];
  const errorsIn = (f: { from: number; to: number }) => o.doc().parsed!.result.problems.filter((p) => p.severity === "error" && p.from >= f.from && p.from <= f.to);
  expect(errorsIn(o.doc().parsed!.result.frames[0]).length).toBeGreaterThan(0);
  act(() => o.doc().select({ title: "Tables", index: 1 }));
  const p = o.doc().parsed!;
  expect(p.frame?.index).toBe(1);
  expect(p.result.kind).toBe("er");
  expect(p.result.oldEr).toBe(true);
  expect(p.errorLine).toBe(errorsIn(frame1)[0].line);
  expect(p.errorLine).toBeGreaterThan(4);
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  expect(o.doc().parsed!.result.oldEr).toBeUndefined();
  expect(o.doc().parsed!.errorLine).toBe(3);
});

test("nothing_selected_runs_nothing", async () => {
  const o = await open(BOARD);
  expect(o.doc().selected).toBeNull();
  const p = o.doc().parsed!;
  expect(p.frame).toBeNull();
  expect([p.result.kind, p.result.doc, p.result.lastValid, p.drawn]).toEqual([null, null, null, null]);
  let r: unknown = "unset";
  await act(async () => {
    r = await o.doc().run({ op: "addNode", name: "Lost", kind: null });
  });
  expect(r).toBeNull();
  expect(textOf(o)).toBe(BOARD);
});

test("a_one_frame_file_reads_and_saves_as_before", async () => {
  const names = parseFlow(orderHandover).doc!.nodes.map((n) => n.name);
  const nodes = emptyPositions();
  names.forEach((n, i) => {
    nodes[n] = { x: i * 10, y: i * 20 };
  });
  const v1 = serializeFlowLayout({ version: 1, nodes, style: "classic", direction: "LR" });
  const o = await open(orderHandover, v1);
  expect(o.doc().selected).toEqual({ title: "Order handover", index: 0 });
  expect(o.doc().layout).toEqual(parseFlowLayout(v1, "flow"));
  expect(o.doc().parsed!.result.doc).toEqual(parseFlow(orderHandover).doc);
  // A move writes only the layout file, version 1, as today.
  act(() => o.doc().move({ [names[0]]: { x: 500, y: 500 } }));
  await act(async () => {
    await o.doc().flush();
  });
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "write_diagram")).toEqual([]);
  expect(disk.get("board")).toEqual({ text: orderHandover, layout: serializeFlowLayout({ version: 1, nodes: { ...nodes, [names[0]]: { x: 500, y: 500 } }, style: "classic", direction: "LR" }) });
  // Moved back: the file is byte for byte what it was.
  act(() => o.doc().move({ [names[0]]: { x: 0, y: 0 } }));
  await act(async () => {
    await o.doc().flush();
  });
  expect(disk.get("board")!.layout).toBe(v1);
  // A data flow with no layout file writes LR, as today.
  const dfd = 'diagram dfd "Orders"\nCustomer [entity]\n';
  const d = await open(dfd, null);
  type(d, "Customer [entity]", "Customer [entity]\nShop [process]");
  await settled(d);
  await act(async () => {
    await d.doc().flush();
  });
  expect(JSON.parse(disk.get("board")!.layout!).direction).toBe("LR");
  expect(JSON.parse(disk.get("board")!.layout!).version).toBe(1);
});

test("a_bad_kind_word_keeps_the_entry_in_the_file", async () => {
  const B = 'diagram flow "B"\nBee\nBoo\nBee > Boo\n';
  const layout = JSON.stringify({
    version: 2,
    frames: {
      A: { at: { x: 0, y: 0 }, nodes: { Ay: { x: 0, y: 0 } }, style: "modern", direction: "TB" },
      B: { at: { x: 700, y: 30 }, nodes: { Bee: { x: 0, y: 0 }, Boo: { x: 0, y: 120 } }, style: "modern", direction: "TB" },
    },
    sketches: [],
  });
  const o = await open(`diagram flow "A"\nAy\n\n${B}`, layout);
  type(o, 'diagram flow "B"', 'diagram flowchart "B"');
  await settled(o);
  expect(o.doc().parsed!.result.problems.some((p) => p.severity === "error" && p.message.includes("flowchart"))).toBe(true);
  await act(async () => {
    await o.doc().flush();
  });
  expect(Object.keys(saved().frames).sort()).toEqual(["A", "B"]);
  type(o, 'diagram flowchart "B"', 'diagram flow "B"');
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(saved().frames.B).toEqual({ at: { x: 700, y: 30 }, nodes: { Bee: { x: 0, y: 0 }, Boo: { x: 0, y: 120 } }, style: "modern", direction: "TB" });
});

test("typing_through_a_taken_title_keeps_the_entry_in_the_file", async () => {
  const o = await open(BOARD);
  type(o, '"Shipping"', '"Checkout"', textOf(o).indexOf('"Refund"'));
  // A title clash is an error: while it lasts no entry leaves the file.
  const from = textOf(o).indexOf('diagram flow "Refund"');
  act(() => {
    o.view.dispatch({ changes: { from, to: textOf(o).lastIndexOf('diagram flow "Checkout"') } });
  });
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(Object.keys(saved().frames).sort()).toEqual(["Checkout", "Refund", "Shipping"]);
  // Unique again: the entry is under the new title, with its place and positions.
  type(o, '"Checkout"', '"Checkouts"', textOf(o).indexOf("Cart > Pay"));
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(Object.keys(saved().frames).sort()).toEqual(["Checkout", "Checkouts"]);
  expect(saved().frames.Checkouts).toEqual({ at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" });
});

test("retyping_the_header_keeps_the_positions", async () => {
  const v1 = serializeFlowLayout({ version: 1, nodes: Object.assign(emptyPositions(), { Cart: { x: 300, y: 40 }, Pay: { x: 300, y: 400 } }), style: "modern", direction: "TB" });
  const o = await open(CHECKOUT, v1);
  const header = 'diagram flow "Checkout"\n';
  act(() => {
    o.view.dispatch({ changes: { from: 0, to: header.length, insert: "\n" }, userEvent: "delete" });
  });
  await settled(o);
  const at = (pos: number, s: string) =>
    act(() => {
      o.view.dispatch({ changes: { from: pos, insert: s }, userEvent: "input.type" });
    });
  let pos = 0;
  for (const c of "diagram flow ") at(pos++, c);
  await settled(o);
  // Quotes come as a pair, then the title letter by letter between them.
  at(pos, '""');
  pos++;
  await settled(o);
  for (const c of "Checkout") at(pos++, c);
  await settled(o);
  expect(textOf(o)).toBe(CHECKOUT);
  expect(o.doc().layout.nodes).toEqual({ Cart: { x: 300, y: 40 }, Pay: { x: 300, y: 400 } });
  await act(async () => {
    await o.doc().flush();
  });
  expect(disk.get("board")!.layout).toBe(v1);
});

test("retitle_into_a_hand_cleared_frame_then_undo_keeps_both_entries", async () => {
  const o = await open(BOARD);
  const from = textOf(o).indexOf('diagram flow "Refund"');
  act(() => {
    o.view.dispatch({ changes: { from, to: textOf(o).indexOf('diagram flow "Shipping"') }, userEvent: "delete" });
  });
  await settled(o);
  type(o, '"Shipping"', '"Refund"');
  await settled(o);
  undoOnce(o);
  undoOnce(o);
  expect(textOf(o)).toBe(BOARD);
  await settled(o);
  expect(entry(o, "Refund")).toEqual({ at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" });
  expect(entry(o, "Shipping")).toEqual({ at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" });
  await act(async () => {
    await o.doc().flush();
  });
  expect(saved()).toEqual(JSON.parse(LAYOUT));
});

test("pasting_a_new_header_over_the_only_frame_keeps_it_shown", async () => {
  const o = await open(CHECKOUT, null);
  await waitFor(() => expect(Object.keys(o.doc().layout.nodes)).toHaveLength(0));
  act(() => o.doc().place({ Cart: { x: 5, y: 6 } }));
  // A new kind and title in one paste: the parse still reads (a cloud diagram takes bare names).
  type(o, 'diagram flow "Checkout"', 'diagram cloud "Orders"');
  await settled(o);
  expect(o.doc().selected).toEqual({ title: "Orders", index: 0 });
  expect(o.doc().parsed!.result.doc).not.toBeNull();
  expect(o.doc().parsed!.drawn).not.toBeNull();
  expect(o.doc().layout.nodes.Cart).toEqual({ x: 5, y: 6 });
});

test("undoing_or_reloading_a_new_header_keeps_the_only_frame_shown", async () => {
  const o = await open(CHECKOUT, null);
  type(o, 'diagram flow "Checkout"', 'diagram dfd "Orders"');
  await settled(o);
  undoOnce(o);
  await settled(o);
  expect(o.doc().selected).toEqual({ title: "Checkout", index: 0 });
  expect(o.doc().parsed!.result.doc).not.toBeNull();
  expect(o.doc().parsed!.drawn).not.toBeNull();
  // The file's header changed outside: a reload keeps the frame shown.
  disk.set("board", { text: CHECKOUT.replace('diagram flow "Checkout"', 'diagram state "Life"'), layout: null });
  await act(async () => {
    expect(await o.doc().reload()).toBe(true);
  });
  await settled(o);
  expect(o.doc().selected).toEqual({ title: "Life", index: 0 });
  expect(o.doc().parsed!.result.doc).not.toBeNull();
  expect(o.doc().parsed!.drawn).not.toBeNull();
});

test("undoing_a_setting_keeps_positions_placed_since", async () => {
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Refund", index: 1 }));
  act(() => o.doc().setDirection("LR"));
  // Placed outside the history after the setting.
  act(() => o.doc().placeIn("Refund", { Late: { x: 40, y: 40 } }));
  undoOnce(o);
  expect(entry(o, "Refund")?.direction).toBe("TB");
  expect(entry(o, "Refund")?.nodes.Late).toEqual({ x: 40, y: 40 });
});

test("proposed_places_in_any_frame_stay_out_of_the_history_and_settle_per_frame", async () => {
  // A board review places proposed shapes in frames that are not selected; a decision drops the ones
  // the text did not take, frame by frame, and never a shape the frame already had.
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  const depth = undoDepth(o.view.state);
  act(() => o.doc().placeProposedIn("Refund", { Close: { x: 0, y: 240 }, Ask: { x: 99, y: 99 } }));
  act(() => o.doc().placeProposedIn("Shipping", { Track: { x: 0, y: 240 } }));
  expect(entry(o, "Refund")?.nodes.Close).toEqual({ x: 0, y: 240 });
  // A kept place is not replaced.
  expect(entry(o, "Refund")?.nodes.Ask).toEqual({ x: 0, y: 0 });
  expect(entry(o, "Shipping")?.nodes.Track).toEqual({ x: 0, y: 240 });
  // Nothing went into the history.
  expect(undoDepth(o.view.state)).toBe(depth);
  // Refund's change was rejected: Close goes, Ask stays; Shipping's waits.
  act(() => o.doc().settleProposedIn("Refund", new Set(["Ask", "Refund it"])));
  expect(entry(o, "Refund")?.nodes.Close).toBeUndefined();
  expect(entry(o, "Refund")?.nodes.Ask).toEqual({ x: 0, y: 0 });
  expect(entry(o, "Shipping")?.nodes.Track).toEqual({ x: 0, y: 240 });
  // Shipping's was accepted: the text has Track, so it keeps its place.
  act(() => o.doc().settleProposedIn("Shipping", new Set(["Pack", "Send", "Track"])));
  expect(entry(o, "Shipping")?.nodes.Track).toEqual({ x: 0, y: 240 });
});

test("settling_the_selected_frame_settles_every_frame_with_proposed_places", async () => {
  // Fix round 1: the single-frame settle also settles other frames' proposed places, each against its own text.
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  await settled(o);
  act(() => o.doc().placeProposed({ Extra: { x: 0, y: 240 } }));
  act(() => o.doc().placeProposedIn("Refund", { Close: { x: 0, y: 240 } }));
  act(() => o.doc().settleProposed(new Set(["Cart", "Pay"])));
  expect(entry(o, "Checkout")?.nodes.Extra).toBeUndefined();
  expect(entry(o, "Refund")?.nodes.Close).toBeUndefined();
  expect(entry(o, "Refund")?.nodes.Ask).toEqual({ x: 0, y: 0 });
  expect(o.doc().proposedSize()).toBe(0);
});

test("proposed_places_of_a_deleted_or_retitled_frame_are_dropped", async () => {
  const o = await open(BOARD);
  act(() => o.doc().placeProposedIn("Refund", { Close: { x: 0, y: 240 } }));
  act(() => o.doc().placeProposedIn("Shipping", { Track: { x: 0, y: 240 } }));
  expect(o.doc().proposedSize()).toBe(2);
  // Refund's text goes and Shipping is retitled: neither key names a frame any more.
  const from = textOf(o).indexOf('diagram flow "Refund"');
  const to = textOf(o).indexOf('diagram flow "Shipping"');
  act(() => {
    o.view.dispatch({ changes: { from, to }, userEvent: "delete" });
  });
  type(o, '"Shipping"', '"Shipped"');
  await settled(o);
  act(() => o.doc().placeProposedIn("Checkout", { Extra: { x: 0, y: 240 } }));
  expect(o.doc().proposedSize()).toBe(1);
  act(() => o.doc().settleProposedIn("Checkout", new Set(["Cart", "Pay"])));
  expect(o.doc().proposedSize()).toBe(0);
});

test("moving_a_frame_block_above_another_keeps_both_entries", async () => {
  const o = await open(BOARD);
  // Refund's block moved above Checkout in one edit: the count is the same, the frames are not.
  act(() => {
    o.view.dispatch({ changes: { from: 0, to: o.view.state.doc.length, insert: [REFUND, CHECKOUT, SHIPPING].join("\n") }, userEvent: "input.paste" });
  });
  expect(o.doc().keys).toEqual(["Refund", "Checkout", "Shipping"]);
  act(() => o.doc().select({ title: "Refund", index: 0 }));
  act(() => o.doc().move({ Ask: { x: 77, y: 77 } }));
  act(() => o.doc().select({ title: "Checkout", index: 1 }));
  act(() => o.doc().move({ Cart: { x: 55, y: 55 } }));
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  const f = saved().frames;
  expect(f.Refund.nodes).toEqual({ Ask: { x: 77, y: 77 }, "Refund it": { x: 0, y: 120 } });
  expect(f.Checkout.nodes).toEqual({ Cart: { x: 55, y: 55 }, Pay: { x: 0, y: 120 } });
  expect(f.Shipping.nodes).toEqual({ Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } });
});

test("a_held_title_never_replaces_a_kept_entry_while_the_board_has_an_error", async () => {
  const o = await open(BOARD);
  const from = textOf(o).indexOf('diagram flow "Refund"');
  act(() => {
    o.view.dispatch({ changes: { from, to: textOf(o).indexOf('diagram flow "Shipping"') }, userEvent: "delete" });
  });
  // Shipping takes the gone frame's title: it keeps its own key, and Refund's entry is kept in memory.
  type(o, '"Shipping"', '"Refund"');
  type(o, "Cart > Pay", "Cart >");
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  const f = saved().frames;
  expect(f.Refund).toEqual({ at: { x: 600, y: 0 }, nodes: { Ask: { x: 0, y: 0 }, "Refund it": { x: 0, y: 120 } }, style: "modern", direction: "TB" });
  expect(f.Shipping).toEqual({ at: { x: 1200, y: 0 }, nodes: { Pack: { x: 0, y: 0 }, Send: { x: 0, y: 120 } }, style: "modern", direction: "TB" });
});

test("a_frame_renamed_to_a_taken_title_keeps_its_entry_when_the_owner_is_deleted", async () => {
  // Found by the invariant test: Checkout renamed to Refund is held under its old key; deleting the real
  // Refund must leave it its own entry, never hand it the deleted frame's, and the file keeps it under its title.
  const o = await open(BOARD);
  type(o, '"Checkout"', '"Refund"');
  await settled(o);
  expect(o.doc().keys).toEqual(["Checkout", "Refund", "Shipping"]);
  const from = textOf(o).indexOf('diagram flow "Refund"', 10);
  act(() => {
    o.view.dispatch({ changes: { from, to: textOf(o).indexOf('diagram flow "Shipping"') }, userEvent: "delete" });
  });
  await settled(o);
  expect(o.doc().keys).toEqual(["Checkout", "Shipping"]);
  await act(async () => {
    await o.doc().flush();
  });
  const f = saved().frames;
  expect(f.Refund).toEqual({ at: { x: 0, y: 0 }, nodes: { Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } }, style: "modern", direction: "TB" });
  expect(f.Checkout).toBeUndefined();
  // Undo brings the real Refund back with its own place.
  undoOnce(o);
  await settled(o);
  expect(entry(o, "Refund")?.at).toEqual({ x: 600, y: 0 });
  expect(entry(o, "Checkout")?.nodes).toEqual({ Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } });
});

test("a_duplicate_backspaced_to_the_original_title_never_swaps_places_with_it", async () => {
  // Review finding 1: a duplicate's lines are the original's, so only its index tells them apart. The copy's title is
  // backspaced to the original's (held under its own key), then the original is renamed: each keeps its own place.
  const o = await open(BOARD);
  await settled(o);
  await act(async () => {
    await o.doc().frameOp({ op: "duplicateFrame", frameIndex: 0 });
  });
  await settled(o);
  expect(o.doc().keys).toEqual(["Checkout", "Checkout 2", "Refund", "Shipping"]);
  const copyAt = entry(o, "Checkout 2")!.at;
  expect(copyAt).not.toEqual({ x: 0, y: 0 });
  const end = textOf(o).indexOf('Checkout 2"') + "Checkout 2".length;
  act(() => o.view.dispatch({ changes: { from: end - 1, to: end }, userEvent: "delete.backward" }));
  act(() => o.view.dispatch({ changes: { from: end - 2, to: end - 1 }, userEvent: "delete.backward" }));
  await settled(o);
  expect(o.doc().keys[0]).toBe("Checkout");
  act(() => o.view.dispatch({ changes: { from: 'diagram flow "'.length, to: 'diagram flow "Checkout'.length, insert: "B" }, userEvent: "input.type" }));
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(o.doc().keys.slice(0, 2)).toEqual(["B", "Checkout"]);
  expect(entry(o, "B")?.at).toEqual({ x: 0, y: 0 });
  expect(entry(o, "Checkout")?.at).toEqual(copyAt);
  const f = saved().frames;
  expect(f.B.at).toEqual({ x: 0, y: 0 });
  expect(f.Checkout.at).toEqual(copyAt);
});

/** A small seeded PRNG (mulberry32), so the edit sequences are the same on every run. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("edit_sequences_never_cross_or_drop_entries", async () => {
  // Each frame carries a hidden mark, so the oracle tells a frame from its duplicate (same shapes, same letter).
  const frame = (title: string, a: string, b: string) => `diagram flow "${title}"\n// m:${title}\n${a}\n${b}\n${a} > ${b}\n`;
  const text = [frame("Alpha", "A1", "A2"), frame("Beta", "B1", "B2"), frame("Gamma", "G1", "G2")].join("\n");
  const own: Record<string, { at: { x: number; y: number }; nodes: Record<string, { x: number; y: number }>; style: string; direction: string }> = {
    Alpha: { at: { x: 0, y: 0 }, nodes: { A1: { x: 1, y: 2 }, A2: { x: 3, y: 4 } }, style: "modern", direction: "TB" },
    Beta: { at: { x: 600, y: 0 }, nodes: { B1: { x: 11, y: 12 }, B2: { x: 13, y: 14 } }, style: "modern", direction: "TB" },
    Gamma: { at: { x: 1200, y: 0 }, nodes: { G1: { x: 21, y: 22 }, G2: { x: 23, y: 24 } }, style: "modern", direction: "TB" },
  };
  const o = await open(text, JSON.stringify({ version: 2, frames: own, sketches: [] }));
  const TITLES = ["Alpha", "Beta", "Gamma", "Delta", "Al", ""];
  let moved = 0;
  let copies = 0;
  /** Each mark's letter, its places (every move gives a place no other mark has) and its frame's place. */
  const letterOf = new Map<string, string>([["Alpha", "A"], ["Beta", "B"], ["Gamma", "G"]]);
  const placesOf = new Map<string, Set<string>>(Object.entries(own).map(([m, e]) => [m, new Set(Object.values(e.nodes).map((p) => `${p.x},${p.y}`))]));
  const atOf = new Map<string, { x: number; y: number }>(Object.entries(own).map(([m, e]) => [m, e.at]));
  /** The one mark a block holds, or null for none or several (a merged block). */
  const markOf = (body: string) => {
    const ms = [...body.matchAll(/\n\/\/ m:(\S+)\n/g)].map((m) => m[1]);
    return ms.length === 1 ? ms[0] : null;
  };
  const rnd = prng(20261026);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const log: string[] = [];
  const dispatch = (changes: { from: number; to?: number; insert?: string }, userEvent = "input.type") =>
    act(() => {
      log.push(`${userEvent} ${JSON.stringify(changes)}`);
      o.view.dispatch({ changes, userEvent });
    });
  const headerOf = (i: number) => {
    const t = textOf(o);
    const f = splitFrames(t)[i];
    const end = t.indexOf("\n", f.from);
    return { from: f.from, to: end < 0 ? t.length : end, line: t.slice(f.from, end < 0 ? t.length : end) };
  };
  const edits: (() => void | Promise<void>)[] = [
    // Reorder: two blocks swapped in one edit.
    () => {
      const t = textOf(o);
      const parts = splitFrames(t).map((f) => t.slice(f.from, f.to)).map((s) => (s.endsWith("\n") ? s : `${s}\n`));
      if (parts.length < 2) return;
      const i = Math.floor(rnd() * parts.length);
      const j = (i + 1 + Math.floor(rnd() * (parts.length - 1))) % parts.length;
      [parts[i], parts[j]] = [parts[j], parts[i]];
      dispatch({ from: 0, to: t.length, insert: parts.join("\n") }, "input.paste");
    },
    // Rename a title, taken ones included.
    () => {
      const h = headerOf(Math.floor(rnd() * splitFrames(textOf(o)).length));
      const m = /^(diagram \w+ )"[^"]*"/.exec(h.line);
      if (m) dispatch({ from: h.from + m[1].length, to: h.from + m[0].length, insert: `"${pick(TITLES)}"` });
    },
    // Delete a header line, then type it again letter by letter.
    () => {
      const h = headerOf(Math.floor(rnd() * splitFrames(textOf(o)).length));
      dispatch({ from: h.from, to: Math.min(h.to + 1, textOf(o).length) }, "delete");
      const line = `${h.line}\n`;
      for (let k = 0; k < line.length; k++) dispatch({ from: h.from + k, insert: line[k] });
    },
    // Delete a frame's text.
    () => {
      const t = textOf(o);
      const fs = splitFrames(t);
      if (fs.length < 2) return;
      const i = Math.floor(rnd() * fs.length);
      dispatch({ from: fs[i].from, to: i + 1 < fs.length ? fs[i + 1].from : t.length }, "delete");
    },
    // Paste a header of another kind and title over one.
    () => {
      const h = headerOf(Math.floor(rnd() * splitFrames(textOf(o)).length));
      dispatch({ from: h.from, to: h.to, insert: `diagram cloud "${pick(TITLES)}"` }, "input.paste");
    },
    () => act(() => void (log.push("undo"), undo(o.view))),
    () => act(() => void (log.push("redo"), redo(o.view))),
    // Move a shape of a frame that can be live (its title is its own), to a place only that frame's shapes take.
    async () => {
      await settled(o);
      const t = textOf(o);
      const fs = splitFrames(t);
      const i = Math.floor(rnd() * fs.length);
      const body = t.slice(fs[i].from, fs[i].to);
      const title = /^diagram \w+ "([^"]*)"/.exec(body)?.[1];
      const mark = markOf(body);
      const titles = fs.map((f) => /^diagram \w+ "([^"]*)"/.exec(t.slice(f.from, f.to))?.[1]);
      if (title === undefined || mark === null || titles.filter((x) => x === title).length !== 1 || o.doc().keys[i]?.startsWith("\u0000")) return;
      act(() => o.doc().select({ title, index: i }));
      if (o.doc().selected?.index !== i) return;
      const name = `${letterOf.get(mark)}${1 + Math.floor(rnd() * 2)}`;
      const to = { x: 1000 + moved++, y: moved };
      placesOf.get(mark)!.add(`${to.x},${to.y}`);
      log.push(`move ${name} in ${i} "${title}" to ${JSON.stringify(to)}`);
      act(() => o.doc().move({ [name]: to }));
    },
    // Frame ops: duplicate, delete, add.
    async () => {
      await settled(o);
      const n = splitFrames(textOf(o)).length;
      const r = rnd();
      if (r >= 0.4 && !(r < 0.7 && n > 1)) {
        // An add goes through `addFrames`, the one way a frame is added.
        const title = pick(TITLES) || "Delta";
        log.push(`addFrames ${JSON.stringify(title)}`);
        await act(async () => {
          await o.doc().addFrames([{ text: `diagram flow "${title}"\n` }], { x: 0, y: 0 });
        });
        return;
      }
      const op: FlowBoardOp = r < 0.4 ? { op: "duplicateFrame", frameIndex: Math.floor(rnd() * n) } : { op: "deleteFrame", frameIndex: Math.floor(rnd() * n) };
      log.push(`frameOp ${JSON.stringify(op)}`);
      let made: Awaited<ReturnType<FlowDocApi["frameOp"]>> = null;
      await act(async () => {
        made = await o.doc().frameOp(op);
      });
      if (op.op !== "duplicateFrame" || !made) return;
      // The copy gets a mark of its own, with its source's places and its own frame place.
      await settled(o);
      const name = (made as { name?: string }).name;
      const t = textOf(o);
      const fs = splitFrames(t);
      const i = fs.findIndex((f) => /^diagram \w+ "([^"]*)"/.exec(t.slice(f.from, f.to))?.[1] === name);
      const from = markOf(i < 0 ? "" : t.slice(fs[i].from, fs[i].to));
      if (from === null) return;
      const mark = `${from}.${++copies}`;
      const at = t.indexOf(`\n// m:${from}\n`, fs[i].from) + "\n// m:".length;
      letterOf.set(mark, letterOf.get(from)!);
      placesOf.set(mark, new Set(placesOf.get(from)));
      atOf.set(mark, o.doc().board.frames.get(o.doc().keys[i])!.at);
      dispatch({ from: at, to: at + from.length, insert: mark });
    },
  ];
  const save = async () => {
    await settled(o);
    await act(async () => {
      await o.doc().flush();
    });
    const j = JSON.parse(disk.get("board")!.layout!) as { version: number; frames?: ReturnType<typeof saved>["frames"]; nodes?: Record<string, { x: number; y: number }> };
    // One frame left is written as version 1: its entry is the file, under the only frame's title.
    if (j.version === 2) return j.frames!;
    const only = /^diagram \w+ "([^"]*)"/.exec(textOf(o))?.[1] ?? "";
    // Version 1 folds the frame's place into its positions: taken out again, they are the entry's own.
    const at = o.doc().board.frames.get(o.doc().keys[0] ?? only)?.at ?? { x: 0, y: 0 };
    const nodes = Object.fromEntries(Object.entries(j.nodes!).map(([k, p]) => [k, { x: p.x - at.x, y: p.y - at.y }]));
    return { [only]: { at, nodes, style: "modern", direction: "TB" } } as unknown as ReturnType<typeof saved>["frames"];
  };
  /** Which marked frame each title now names (a merged block or a repeated title names none). */
  const owners = () => {
    const t = textOf(o);
    const out = new Map<string, string | null>();
    for (const [i, f] of splitFrames(t).entries()) {
      const body = t.slice(f.from, f.to);
      const title = /^diagram \w+ "([^"]*)"/.exec(body)?.[1] ?? (i === 0 ? "" : null);
      if (title === null) continue;
      out.set(title, out.has(title) ? null : markOf(body));
    }
    return out;
  };
  for (let s = 0; s < 32; s++) {
    const steps = 2 + Math.floor(rnd() * 5);
    log.length = 0;
    for (let k = 0; k < steps; k++) {
      await pick(edits)();
      if (rnd() < 0.2) await settled(o);
    }
    // The head of the history first (a random undo may have left redos), which is where redo all comes back to.
    act(() => {
      while (redo(o.view));
    });
    log.push("redo to the head");
    // There: every marked frame has an entry at its own place, holding only its own names and places.
    const before = await save();
    const ownersBefore = owners();
    for (const [name, who] of ownersBefore) {
      if (who === null) continue;
      expect(before[name], `sequence ${s}: ${name} (${who}) has no entry\n${log.join("\n")}`).toBeDefined();
      for (const [k, p] of Object.entries(before[name].nodes)) {
        expect(k[0], `sequence ${s}: ${k} under ${name}, which is ${who}\n${log.join("\n")}`).toBe(letterOf.get(who));
        expect(placesOf.get(who)!.has(`${p.x},${p.y}`), `sequence ${s}: ${k} under ${name} (${who}) at ${JSON.stringify(p)}\n${log.join("\n")}`).toBe(true);
      }
      expect(before[name].at, `sequence ${s}: ${name} (${who}) placed\n${log.join("\n")}`).toEqual(atOf.get(who));
    }
    const textBefore = textOf(o);
    act(() => {
      while (undo(o.view));
    });
    expect(textOf(o)).toBe(text);
    const back = await save();
    expect(o.doc().keys, `sequence ${s}: keys after undo\n${log.join("\n")}`).toEqual(["Alpha", "Beta", "Gamma"]);
    for (const t of Object.keys(own)) expect(back[t], `sequence ${s}: ${t} after undo\n${log.join("\n")}`).toEqual(own[t]);
    act(() => {
      while (redo(o.view));
    });
    const after = await save();
    // Redo puts back what each frame held: every marked frame has its very place and positions.
    expect(textOf(o)).toBe(textBefore);
    for (const [name, who] of owners()) {
      if (who === null) continue;
      expect(ownersBefore.get(name), `sequence ${s}: ${name} after redo`).toBe(who);
      expect(after[name]?.nodes, `sequence ${s}: ${name} (${who}) after redo\n${log.join("\n")}`).toEqual(before[name]?.nodes);
      expect(after[name]?.at, `sequence ${s}: ${name} (${who}) placed after redo\n${log.join("\n")}`).toEqual(before[name]?.at);
    }
    log.push("redo all, then undo all");
    act(() => {
      while (undo(o.view));
    });
    expect(o.doc().keys, `sequence ${s}: keys after the second undo\n${log.join("\n")}`).toEqual(["Alpha", "Beta", "Gamma"]);
    // A new edit drops what redo still holds, so the next sequence starts from this text, not from a redo of a copy
    // whose own mark is in a later history step.
    const end = textOf(o).length;
    act(() => o.view.dispatch({ changes: { from: end, insert: "\n" }, userEvent: "input.type" }));
    act(() => o.view.dispatch({ changes: { from: end, to: end + 1 }, userEvent: "delete" }));
  }
  expect(moved).toBeGreaterThan(5);
  expect(copies).toBeGreaterThan(0);
}, 10_000);

/** The sketches in the layout file on disk. */
const savedSketches = () => (JSON.parse(disk.get("board")!.layout!) as { sketches?: { id: string; x: number; y: number }[] }).sketches;

test("a_sketch_add_move_and_delete_are_each_one_undo", async () => {
  const o = await open(BOARD);
  const added = addSketch(o.doc().board.sketches, { kind: "rect", x: 2000, y: 400, w: 120, h: 80 });
  if (!("change" in added)) throw new Error(added.refused);
  act(() => o.doc().sketch([added.change]));
  expect(o.doc().board.sketches.map((s) => s.id)).toEqual(["s1"]);
  act(() => o.doc().sketch(moveSketches(o.doc().board.sketches, ["s1"], 50, 20)));
  expect(o.doc().board.sketches[0]).toMatchObject({ x: 2050, y: 420 });
  act(() => o.doc().sketch(removeSketches(o.doc().board.sketches, ["s1"])));
  expect(o.doc().board.sketches).toEqual([]);
  // The .flow text never changes: sketches live in the layout file.
  expect(textOf(o)).toBe(BOARD);
  undoOnce(o);
  expect(o.doc().board.sketches).toEqual([{ id: "s1", kind: "rect", x: 2050, y: 420, w: 120, h: 80 }]);
  undoOnce(o);
  expect(o.doc().board.sketches).toEqual([{ id: "s1", kind: "rect", x: 2000, y: 400, w: 120, h: 80 }]);
  undoOnce(o);
  expect(o.doc().board.sketches).toEqual([]);
  act(() => void redo(o.view));
  act(() => void redo(o.view));
  expect(o.doc().board.sketches).toEqual([{ id: "s1", kind: "rect", x: 2050, y: 420, w: 120, h: 80 }]);
  expect(textOf(o)).toBe(BOARD);
  // Saved to the layout file alone, through write_diagram_layout.
  await act(async () => {
    await o.doc().flush();
  });
  expect(savedSketches()).toEqual([{ id: "s1", kind: "rect", x: 2050, y: 420, w: 120, h: 80 }]);
  expect(disk.get("board")!.text).toBe(BOARD);
  const calls = vi.mocked(invoke).mock.calls.map(([c]) => c);
  expect(calls).toContain("write_diagram_layout");
  expect(calls).not.toContain("write_diagram");
});

test("moving_a_shape_and_a_sketch_together_is_one_undo", async () => {
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  const added = addSketch(o.doc().board.sketches, { kind: "note", x: -300, y: 0, w: 160, h: 120, text: "Ask the bank" });
  if (!("change" in added)) throw new Error(added.refused);
  act(() => o.doc().sketch([added.change]));
  act(() => o.doc().move({ Cart: { x: 300, y: 40 } }, undefined, moveSketches(o.doc().board.sketches, ["s1"], 300, 40)));
  expect(entry(o, "Checkout")?.nodes.Cart).toEqual({ x: 300, y: 40 });
  expect(o.doc().board.sketches[0]).toMatchObject({ x: 0, y: 40 });
  // One undo puts both back; the next takes the note away.
  undoOnce(o);
  expect(entry(o, "Checkout")?.nodes.Cart).toEqual({ x: 0, y: 0 });
  expect(o.doc().board.sketches[0]).toMatchObject({ x: -300, y: 0 });
  undoOnce(o);
  expect(o.doc().board.sketches).toEqual([]);
  expect(entry(o, "Checkout")?.nodes.Cart).toEqual({ x: 0, y: 0 });
  act(() => void redo(o.view));
  act(() => void redo(o.view));
  expect(entry(o, "Checkout")?.nodes.Cart).toEqual({ x: 300, y: 40 });
  expect(o.doc().board.sketches[0]).toMatchObject({ x: 0, y: 40 });
  // With nothing selected, sketches alone still move as one entry.
  act(() => o.doc().select(null));
  act(() => o.doc().move({}, undefined, moveSketches(o.doc().board.sketches, ["s1"], 10, 0)));
  expect(o.doc().board.sketches[0]).toMatchObject({ x: 10, y: 40 });
  undoOnce(o);
  expect(o.doc().board.sketches[0]).toMatchObject({ x: 0, y: 40 });
  expect(textOf(o)).toBe(BOARD);
});

test("text_edits_and_sketch_ops_interleave_in_one_history", async () => {
  const o = await open(BOARD);
  const at = (x: number) => [{ id: "s1", kind: "note", x, y: 0, w: 160, h: 120, text: "later" }];
  const steps: { text: string; sketches: unknown[] }[] = [];
  const now = () => ({ text: textOf(o), sketches: o.doc().board.sketches.map((s) => ({ ...s })) });
  steps.push(now());
  type(o, "Cart\n", "Cart\nWrap\n");
  steps.push(now());
  const added = addSketch(o.doc().board.sketches, { kind: "note", x: -300, y: 0, w: 160, h: 120, text: "later" });
  if (!("change" in added)) throw new Error(added.refused);
  act(() => o.doc().sketch([added.change]));
  steps.push(now());
  type(o, "Ask\n", "Ask\nCheck\n");
  steps.push(now());
  act(() => o.doc().sketch(moveSketches(o.doc().board.sketches, ["s1"], 100, 0)));
  steps.push(now());
  expect(steps[4]).toEqual({ text: BOARD.replace("Cart\n", "Cart\nWrap\n").replace("Ask\n", "Ask\nCheck\n"), sketches: at(-200) });
  expect(steps[1].sketches).toEqual([]);
  expect(steps[2].sketches).toEqual(at(-300));
  // Back one step at a time, then forward again: text and sketches together at every step.
  for (let i = 3; i >= 0; i--) {
    undoOnce(o);
    expect(now(), `undo to ${i}`).toEqual(steps[i]);
  }
  for (let i = 1; i <= 4; i++) {
    act(() => void redo(o.view));
    expect(now(), `redo to ${i}`).toEqual(steps[i]);
  }
});

// ----- Final review fixes

test("an_answer_after_a_frame_switch_writes_nothing", async () => {
  // Finding 1: a canvas action awaits the worker; another frame selected meanwhile gets nothing written.
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  o.worker.pause();
  let r: RunResult | null | undefined;
  const p = o.doc().run({ op: "addNode", name: "Ship", kind: null }).then((x) => (r = x));
  act(() => o.doc().select({ title: "Refund", index: 1 }));
  o.worker.resume();
  await act(async () => {
    await p;
  });
  expect(r).toBeNull();
  expect(textOf(o)).toBe(BOARD);
});

test("place_with_a_run_frame_writes_into_that_frame_only", async () => {
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  let r: RunResult | null = null;
  await act(async () => {
    r = await o.doc().run({ op: "addNode", name: "Ship", kind: null });
  });
  const frame = r!.frame!;
  expect(frame).toEqual({ index: 0, key: "Checkout" });
  act(() => o.doc().select({ title: "Refund", index: 1 }));
  act(() => o.doc().place({ Ship: { x: 5, y: 5 }, Ask: { x: 9, y: 9 } }, true, frame));
  expect(entry(o, "Checkout")?.nodes.Ship).toEqual({ x: 5, y: 5 });
  expect(entry(o, "Refund")?.nodes.Ask).toEqual({ x: 0, y: 0 });
  // A frame no longer on the board, or none (a frame whose title repeats): nothing is written anywhere.
  const before = o.doc().board;
  act(() => o.doc().place({ Ask: { x: 9, y: 9 } }, true, { index: 5, key: "Gone" }));
  act(() => o.doc().place({ Ask: { x: 9, y: 9 } }, true, null));
  expect(o.doc().board).toBe(before);
});

test("sketches_added_with_a_run_get_fresh_ids_when_one_was_taken_meanwhile", async () => {
  // Finding 5: a mixed paste picks its sketch ids before the worker answers; a sketch drawn meanwhile keeps its own.
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  const pasted = addSketch(o.doc().board.sketches, { kind: "rect", x: 0, y: 0, w: 10, h: 10 });
  if (!("change" in pasted)) throw new Error(pasted.refused);
  o.worker.pause();
  let r: RunResult | null | undefined;
  const p = o.doc().run({ op: "addNode", name: "Ship", kind: null }, { sketches: [pasted.change] }).then((x) => (r = x));
  const drawn = addSketch(o.doc().board.sketches, { kind: "ellipse", x: 50, y: 50, w: 20, h: 20 });
  if (!("change" in drawn)) throw new Error(drawn.refused);
  expect(drawn.change.id).toBe(pasted.change.id);
  act(() => o.doc().sketch([drawn.change]));
  o.worker.resume();
  await act(async () => {
    await p;
  });
  expect(o.doc().board.sketches.map((s) => s.kind).sort()).toEqual(["ellipse", "rect"]);
  expect(o.doc().board.sketches.find((s) => s.kind === "ellipse")?.id).toBe(drawn.change.id);
  expect(r?.sketchIds).toHaveLength(1);
  expect(r?.sketchIds?.[0]).not.toBe(drawn.change.id);
  expect(o.doc().board.sketches.find((s) => s.kind === "rect")?.id).toBe(r?.sketchIds?.[0]);
  // One undo takes the paste and its sketch back, and leaves the drawn one.
  undoOnce(o);
  expect(o.doc().board.sketches.map((s) => s.kind)).toEqual(["ellipse"]);
});

test("undoing_a_resize_or_a_setting_in_another_frame_reports_that_frame", async () => {
  // Finding 4: the canvas goes to the frame an undo changes, as it does for a move.
  const o = await open(BOARD);
  const moves: HistoryMove[] = [];
  unmounts.push(o.doc().onHistoryMove((m) => moves.push(m)));
  act(() => o.doc().select({ title: "Refund", index: 1 }));
  act(() => o.doc().resize("Ask", { x: 0, y: 0, w: 200, h: 90 }));
  act(() => o.doc().setFrameSetting("Refund", { textSize: "l" }));
  await act(async () => {
    await o.doc().run({ op: "addLink", from: "Refund it", to: "Ask", arrow: ">" }, { axes: { [JSON.stringify(["Refund it", "Ask"])]: "v" } });
  });
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  undoOnce(o);
  undoOnce(o);
  undoOnce(o);
  expect(moves.map((m) => [m.frame, m.undo, Object.keys(m.to).length])).toEqual([
    ["Refund", true, 0],
    ["Refund", true, 0],
    ["Refund", true, 0],
  ]);
  expect(entry(o, "Refund")?.textSize).toBeUndefined();
  act(() => void redo(o.view));
  expect(moves[moves.length - 1]).toMatchObject({ frame: "Refund", undo: false });
});

test("static_placement_uses_the_frames_text_size", async () => {
  // Finding 3: a Large frame's shapes placed while it is not live are spaced for their Large size.
  const spread = async (textSize: "m" | "l") => {
    const layout = JSON.parse(LAYOUT) as { frames: Record<string, { nodes: object; textSize?: string }> };
    layout.frames.Shipping.nodes = {};
    if (textSize === "l") layout.frames.Shipping.textSize = "l";
    const o = await open(BOARD, JSON.stringify(layout));
    await waitFor(() => expect(Object.keys(entry(o, "Shipping")?.nodes ?? {}).sort()).toEqual(["Pack", "Send"]));
    const n = entry(o, "Shipping")!.nodes;
    return n.Send.y - n.Pack.y;
  };
  const medium = await spread("m");
  const large = await spread("l");
  expect(large).toBeGreaterThan(medium);
});

test("a_one_frame_board_let_go_stays_let_go_while_typing", async () => {
  // Finding 2 (owner ruling): the only frame can be deselected; typing in its body does not select it again.
  const o = await open(CHECKOUT);
  expect(o.doc().selected).toEqual({ title: "Checkout", index: 0 });
  act(() => o.doc().select(null));
  type(o, "Pay\n", "Pay\nShip\n");
  await settled(o);
  expect(o.doc().selected).toBeNull();
  expect(o.doc().parsed?.frame).toBeNull();
  // A board that comes down to one frame has it selected, as before.
  const b = await open(BOARD);
  expect(b.doc().selected).toBeNull();
  const from = textOf(b).indexOf('diagram flow "Refund"');
  act(() => b.view.dispatch({ changes: { from, to: textOf(b).length }, userEvent: "delete" }));
  expect(b.doc().selected).toEqual({ title: "Checkout", index: 0 });
});

test("an_entry_of_a_deleted_frame_goes_once_the_history_lets_go", async () => {
  // Finding 8: the entry is kept for the undo that brings its frame back, then dropped from memory.
  const o = await open(BOARD);
  const at = textOf(o).indexOf('diagram flow "Refund"');
  const end = textOf(o).indexOf('diagram flow "Shipping"');
  act(() => o.view.dispatch({ changes: { from: at, to: end }, userEvent: "delete" }));
  await settled(o);
  expect(o.doc().keys).toEqual(["Checkout", "Shipping"]);
  expect([...o.doc().board.frames.keys()].sort()).toEqual(["Checkout", "Refund", "Shipping"]);
  act(() => o.doc().select({ title: "Checkout", index: 0 }));
  // Moves fill the history; while the delete is in it the entry stays.
  const step = (i: number) => act(() => o.doc().move({ Cart: { x: i, y: 0 } }));
  for (let i = 1; i <= 20; i++) step(i);
  expect(o.doc().board.frames.has("Refund")).toBe(true);
  // Past the history's depth the delete can no longer be undone: the entry goes.
  for (let i = 21; i <= 140; i++) step(i);
  expect([...o.doc().board.frames.keys()].sort()).toEqual(["Checkout", "Shipping"]);
});

test("an_undone_frame_add_keeps_its_entry_for_the_redo_until_a_new_edit", async () => {
  const o = await open(BOARD);
  type(o, "Pack > Send\n", 'Pack > Send\n\ndiagram flow "Returns"\nBox\n');
  await settled(o);
  await waitFor(() => expect(o.doc().board.frames.has("Returns")).toBe(true));
  act(() => o.doc().select({ title: "Returns", index: 3 }));
  act(() => o.doc().move({ Box: { x: 77, y: 7 } }));
  act(() => o.doc().select(null));
  undoOnce(o);
  undoOnce(o);
  await settled(o);
  expect(o.doc().keys).toEqual(["Checkout", "Refund", "Shipping"]);
  expect(o.doc().board.frames.has("Returns")).toBe(true);
  // A redo brings the frame back on its entry.
  act(() => void redo(o.view));
  await settled(o);
  expect(o.doc().keys).toContain("Returns");
  undoOnce(o);
  await settled(o);
  expect(o.doc().board.frames.has("Returns")).toBe(true);
  // A new edit clears the redo: nothing can bring it back, and its entry goes.
  type(o, "Cart\n", "Cart\nBasket\n");
  await settled(o);
  expect(o.doc().board.frames.has("Returns")).toBe(false);
});

test("marks_in_a_history_of_another_shape_prune_nothing", () => {
  // Re-review R3: an entry without an effects list means the history cannot be read: null, so nothing is pruned.
  const ev = (...marks: number[]) => ({ effects: marks.map((m) => goneMark.of(m)) });
  expect(marksIn({ done: [ev(1), ev(2, 3)], undone: [ev(4)] })).toEqual(new Set([1, 2, 3, 4]));
  expect(marksIn({ done: [ev(1), { changes: null }], undone: [] })).toBeNull();
  expect(marksIn({ done: [ev(1)], undone: [{ effect: [] }] })).toBeNull();
  expect(marksIn({ done: [] })).toBeNull();
  expect(marksIn(undefined)).toBeNull();
});

test("a_board_cut_to_one_frame_saves_its_place", async () => {
  // Shipping, off the origin, keeps a text size: the board left with it alone stays version 2, `at` and all.
  const layout = JSON.parse(LAYOUT);
  layout.frames.Shipping.at = { x: 5200, y: 300 };
  layout.frames.Shipping.textSize = "l";
  const o = await open(BOARD, JSON.stringify(layout));
  act(() => {
    o.view.dispatch({ changes: { from: 0, to: textOf(o).indexOf('diagram flow "Shipping"') }, userEvent: "delete" });
  });
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  expect(disk.get("board")!.text).toBe(SHIPPING);
  const file = JSON.parse(disk.get("board")!.layout!);
  expect(file.version).toBe(2);
  expect(Object.keys(file.frames)).toEqual(["Shipping"]);
  expect(file.frames.Shipping.at).toEqual({ x: 5200, y: 300 });
  // With no setting, the one frame folds its place into its positions.
  const plain = JSON.parse(LAYOUT);
  plain.frames.Shipping.at = { x: 5200, y: 300 };
  const p = await open(BOARD, JSON.stringify(plain));
  act(() => {
    p.view.dispatch({ changes: { from: 0, to: textOf(p).indexOf('diagram flow "Shipping"') }, userEvent: "delete" });
  });
  await settled(p);
  await act(async () => {
    await p.doc().flush();
  });
  expect(JSON.parse(disk.get("board")!.layout!)).toMatchObject({ version: 1, nodes: { Pack: { x: 5200, y: 300 }, Send: { x: 5200, y: 420 } } });
});

// ----- B2 Task 1: frames added from text with their places, in one undo (decision 8, R1, R2, R5, R17).

const SHOP = [
  'diagram er "Orders ERD"\norders {\n  id int pk\n  customer_id int\n}\ncustomers {\n  id int pk\n}\norders.customer_id > customers.id\n',
  'diagram flow "Checkout flow"\nCart\nPay\nDone\nCart > Pay > Done\n',
  'diagram sequence "Pay sequence"\nparticipant Shopper\nparticipant Shop\nparticipant Bank\nShopper -> Shop : pay\nShop -> Bank : charge\nBank -> Shop : approved\nShop -> Shopper : receipt\n',
];
const SHOP_TITLES = ["Orders ERD", "Checkout flow", "Pay sequence"];
type Added = Awaited<ReturnType<FlowDocApi["addFrames"]>>;

/** `addFrames` once the editor's text is parsed. */
async function addTexts(o: Opened, texts: readonly string[], centre = { x: 0, y: 0 }): Promise<Added> {
  await settled(o);
  let r: Added | undefined;
  await act(async () => {
    r = await o.doc().addFrames(
      texts.map((text) => ({ text })),
      centre,
    );
  });
  return r!;
}
const boxesOf = (r: Added) => {
  if (!("boxes" in r)) throw new Error(`refused: ${r.refused}`);
  return r.boxes;
};
/** The drawn doc of frame `i` in the newest parse. */
const docAt = (o: Opened, i: number) => o.doc().parsed!.result.frames[i].doc;
const near = (a: { x: number; y: number; w?: number; h?: number }, b: { x: number; y: number; w?: number; h?: number }) => {
  for (const k of ["x", "y", "w", "h"] as const) if (a[k] !== undefined || b[k] !== undefined) expect(a[k]).toBeCloseTo(b[k]!, 6);
};

test("one_undo_removes_every_added_frame_and_redo_restores_it", async () => {
  const o = await open(BOARD);
  const before = textOf(o);
  // The brief's line, in act: the hook's board is React state, rendered once act flushes the update.
  const r = await act(() => o.doc().addFrames(SHOP.map((text) => ({ text })), { x: 0, y: 0 }));
  expect("titles" in r && r.titles).toEqual(["Orders ERD", "Checkout flow", "Pay sequence"]);
  const ats = ["Orders ERD", "Checkout flow", "Pay sequence"].map((t) => o.doc().board.frames.get(t)!.at);
  undoOnce(o); expect(textOf(o)).toBe(before); expect(o.doc().board.frames.has("Orders ERD")).toBe(false);
  act(() => void redo(o.view));
  expect(["Orders ERD", "Checkout flow", "Pay sequence"].map((t) => o.doc().board.frames.get(t)!.at)).toEqual(ats);
});

test("add_frames_writes_text_and_places_in_one_undo", async () => {
  const o = await open(BOARD);
  const centre = { x: 500, y: 900 };
  const r = await addTexts(o, SHOP, centre);
  expect(textOf(o)).toBe(`${BOARD}\n${SHOP.join("\n")}`);
  const boxes = boxesOf(r);
  const slots = placeFrames(boxes, centre);
  // R1: each drawn box, not the entry origin, lands on its slot.
  boxes.forEach((b, i) => expect({ x: b.x, y: b.y }).toEqual(slots[i]));
  await settled(o);
  SHOP_TITLES.forEach((t, i) => near(frameBounds(entry(o, t)!, docAt(o, 3 + i), "modern"), boxes[i]));
  expect(Object.keys(entry(o, "Orders ERD")!.nodes).sort()).toEqual(["customers", "orders"]);
  expect(Object.keys(entry(o, "Checkout flow")!.nodes).sort()).toEqual(["Cart", "Done", "Pay"]);
  expect(Object.keys(entry(o, "Pay sequence")!.nodes)).toEqual([]);
  undoOnce(o);
  expect(textOf(o)).toBe(BOARD);
  for (const t of SHOP_TITLES) expect(entry(o, t)).toBeUndefined();
  expect(entry(o, "Refund")?.at).toEqual({ x: 600, y: 0 });
});

test("a_box_offset_is_kept_off_the_entry", async () => {
  const o = await open(BOARD);
  const centre = { x: -300, y: 50 };
  const r = await addTexts(o, [SHOP[1]], centre);
  const [slot] = placeFrames(boxesOf(r), centre);
  await settled(o);
  const e = entry(o, "Checkout flow")!;
  const off = frameBounds({ ...e, at: { x: 0, y: 0 } }, docAt(o, 3), "modern");
  expect(off.x).not.toBe(0);
  expect(e.at.x).toBeCloseTo(slot.x - off.x, 6);
  expect(e.at.y).toBeCloseTo(slot.y - off.y, 6);
  near(frameBounds(e, docAt(o, 3), "modern"), { ...slot, w: off.w, h: off.h });
});

test("fixed_kind_frames_measure_their_drawn_size_and_never_overlap", async () => {
  const o = await open(BOARD);
  const people = ["Ann", "Bo", "Cy", "Di", "Ed", "Fay"];
  const seq = `diagram sequence "Six"\n${people.map((p) => `participant ${p}`).join("\n")}\n${people
    .slice(1)
    .map((p, i) => `${people[i]} -> ${p} : step ${i}`)
    .join("\n")}\n`;
  const mind = `diagram mindmap "Twelve"\nroot Ideas\n${Array.from({ length: 12 }, (_, i) => `  Topic ${i + 1}`).join("\n")}\n`;
  const r = await addTexts(o, [seq, mind]);
  const boxes = boxesOf(r);
  await settled(o);
  near(frameBounds(entry(o, "Six")!, docAt(o, 3), "modern"), boxes[0]);
  near(frameBounds(entry(o, "Twelve")!, docAt(o, 4), "modern"), boxes[1]);
  // Measured, not the empty frame's minimum.
  expect(boxes[0].w).toBeGreaterThan(320);
  expect(boxes[1].h).toBeGreaterThan(200);
  expect(boxes[1].x).toBeGreaterThanOrEqual(boxes[0].x + boxes[0].w + FRAME_GAP);
});

test("a_template_on_a_board_with_its_titles_takes_free_titles", async () => {
  const seen: Transaction[] = [];
  const o = await open(BOARD, LAYOUT, [EditorView.updateListener.of((u) => seen.push(...u.transactions))]);
  await addTexts(o, SHOP);
  const first = SHOP_TITLES.map((t) => entry(o, t));
  seen.length = 0;
  const r = await addTexts(o, SHOP, { x: 4000, y: 4000 });
  expect("titles" in r && r.titles).toEqual(["Orders ERD 2", "Checkout flow 2", "Pay sequence 2"]);
  // The bodies unchanged; only the titles took a number.
  expect(framesOf(textOf(o)).slice(6)).toEqual(SHOP.map((t, i) => t.replace(`"${SHOP_TITLES[i]}"`, `"${SHOP_TITLES[i]} 2"`)));
  // The places under the new keys, the first ones untouched.
  const effects = seen.flatMap((tr) => tr.effects.filter((e) => e.is(frameEffect)).map((e) => e.value as { title: string; before: unknown }));
  expect(effects.map((e) => e.title)).toEqual(["Orders ERD 2", "Checkout flow 2", "Pay sequence 2"]);
  expect(effects.every((e) => e.before === null)).toBe(true);
  SHOP_TITLES.forEach((t, i) => expect(entry(o, t)).toBe(first[i]));
  for (const t of SHOP_TITLES) expect(entry(o, `${t} 2`)!.at.x).toBeGreaterThan(2000);
});

test("an_add_reusing_a_gone_title_undoes_to_its_old_entry", async () => {
  // A frame deleted in its text keeps its entry for the undo that brings it back (B1 decision 11): an add that takes
  // the title replaces that entry, and its undo puts the kept one back (R2).
  const o = await open(BOARD);
  const kept = entry(o, "Refund")!;
  const from = textOf(o).indexOf('diagram flow "Refund"');
  act(() => {
    o.view.dispatch({ changes: { from, to: textOf(o).indexOf('diagram flow "Shipping"') }, userEvent: "delete" });
  });
  await settled(o);
  const deleted = textOf(o);
  expect(o.doc().keys).toEqual(["Checkout", "Shipping"]);
  expect(entry(o, "Refund")).toEqual(kept);
  const r = await addTexts(o, ['diagram flow "Refund"\nNew start\n'], { x: 3000, y: 3000 });
  expect("titles" in r && r.titles).toEqual(["Refund"]);
  expect(entry(o, "Refund")).not.toEqual(kept);
  expect(entry(o, "Refund")!.at.x).toBeGreaterThan(2000);
  undoOnce(o);
  expect(textOf(o)).toBe(deleted);
  expect(entry(o, "Refund")).toEqual(kept);
  undoOnce(o);
  expect(textOf(o)).toBe(BOARD);
  await settled(o);
  expect(entry(o, "Refund")).toEqual(kept);
  // Deleted by the frame's menu, the entry rides in the history instead: two undos bring the frame back on it.
  const p = await open(BOARD);
  const menuKept = entry(p, "Refund")!;
  await settled(p);
  await act(async () => {
    await p.doc().frameOp({ op: "deleteFrame", frameIndex: 1 });
  });
  await addTexts(p, ['diagram flow "Refund"\nNew start\n'], { x: 3000, y: 3000 });
  expect(entry(p, "Refund")).not.toEqual(menuKept);
  undoOnce(p);
  expect(entry(p, "Refund")).toBeUndefined();
  undoOnce(p);
  expect(textOf(p)).toBe(BOARD);
  expect(entry(p, "Refund")).toEqual(menuKept);
});

test("a_template_past_the_frame_cap_adds_nothing", async () => {
  const frames = Array.from({ length: 48 }, (_, i) => `diagram flow "F${i}"\nA\n`);
  const layout = JSON.stringify({
    version: 2,
    frames: Object.fromEntries(frames.map((_, i) => [`F${i}`, { at: { x: i * 600, y: 0 }, nodes: { A: { x: 0, y: 0 } }, style: "modern", direction: "TB" }])),
    sketches: [],
  });
  const o = await open(frames.join("\n"), layout);
  const text = textOf(o);
  const keys = [...o.doc().board.frames.keys()];
  const laidOut = vi.spyOn(LangClient.prototype, "layout");
  const r = await addTexts(o, SHOP).finally(() => laidOut.mockRestore());
  expect(r).toEqual({ refused: BOARD_NOTES.full });
  // Refused before any frame was laid out.
  expect(laidOut).not.toHaveBeenCalled();
  expect(textOf(o)).toBe(text);
  expect([...o.doc().board.frames.keys()]).toEqual(keys);
});

test("past_the_shape_cap_adds_nothing", async () => {
  const names = Array.from({ length: 9_999 }, (_, i) => `N${i}`);
  const layout = JSON.stringify({
    version: 2,
    frames: { Many: { at: { x: 0, y: 0 }, nodes: Object.fromEntries(names.map((n, i) => [n, { x: i, y: 0 }])), style: "modern", direction: "TB" } },
    sketches: [],
  });
  const o = await open(`diagram flow "Many"\n${names.join("\n")}\n`, layout);
  const text = textOf(o);
  const laidOut = vi.spyOn(LangClient.prototype, "layout");
  const r = await addTexts(o, SHOP).finally(() => laidOut.mockRestore());
  expect(r).toEqual({ refused: BOARD_NOTES.shapes });
  expect(laidOut).not.toHaveBeenCalled();
  expect(textOf(o)).toBe(text);
  expect([...o.doc().board.frames.keys()]).toEqual(["Many"]);
});

test("a_stale_parse_retries_and_lands_once", async () => {
  const seen: Transaction[] = [];
  const o = await open(BOARD, LAYOUT, [EditorView.updateListener.of((u) => seen.push(...u.transactions))]);
  await settled(o);
  let asks = 0;
  const answers: boolean[] = [];
  // The add's plan (after the caps check and the layout) reaches the worker after the text changed: the worker
  // answers stale, and the add plans again on the new text.
  o.worker.tap((m, send) => {
    if (m.type !== "flowEdit" || m.edit.op !== "appendFrames" || ++asks !== 2) return false;
    setTimeout(() => {
      type(o, "Cart\n", "Cart\nBasket\n");
      send(m);
    }, 0);
    return true;
  });
  o.worker.tapOut((m) => {
    if (m.type === "flowEdit") answers.push(m.result.stale);
    return false;
  });
  const r = await addTexts(o, SHOP);
  expect(answers).toEqual([false, true, false]);
  expect(r && "titles" in r && r.titles).toEqual(SHOP_TITLES);
  const typed = BOARD.replace("Cart\n", "Cart\nBasket\n");
  expect(textOf(o)).toBe(`${typed}\n${SHOP.join("\n")}`);
  expect(seen.filter((tr) => tr.effects.some((e) => e.is(frameEffect)))).toHaveLength(1);
  undoOnce(o);
  expect(textOf(o)).toBe(typed);
  for (const t of SHOP_TITLES) expect(entry(o, t)).toBeUndefined();
});

test("a_text_change_between_the_answer_and_the_dispatch_plans_again", async () => {
  const seen: Transaction[] = [];
  const o = await open(BOARD, LAYOUT, [EditorView.updateListener.of((u) => seen.push(...u.transactions))]);
  await settled(o);
  let answers = 0;
  // The worker's answer to the add's plan is good for the text it saw; the text changes before the add takes it.
  o.worker.tapOut((m, deliver) => {
    if (m.type !== "flowEdit" || m.result.stale || ++answers !== 2) return false;
    type(o, "Ask\n", "Ask\nCheck\n");
    deliver();
    return true;
  });
  const r = await addTexts(o, SHOP);
  expect(answers).toBeGreaterThanOrEqual(3);
  expect(r && "titles" in r && r.titles).toEqual(SHOP_TITLES);
  const typed = BOARD.replace("Ask\n", "Ask\nCheck\n");
  // Planned again on the new text: every frame whole, the typed line kept, nothing written at stale positions.
  expect(textOf(o)).toBe(`${typed}\n${SHOP.join("\n")}`);
  expect(seen.filter((tr) => tr.effects.some((e) => e.is(frameEffect)))).toHaveLength(1);
  undoOnce(o);
  expect(textOf(o)).toBe(typed);
});

test("duplicate_onto_a_gone_frames_title_gets_a_fresh_entry_and_undo_restores_the_old", async () => {
  const o = await open(BOARD);
  // A frame "Checkout 2" is placed, then deleted in its text: its entry is kept for the undo that brings it back.
  type(o, "Pack > Send\n", 'Pack > Send\n\ndiagram flow "Checkout 2"\nZed\n');
  await settled(o);
  await waitFor(() => expect(entry(o, "Checkout 2")?.nodes.Zed).toBeDefined());
  const kept = entry(o, "Checkout 2")!;
  act(() => {
    o.view.dispatch({ changes: { from: textOf(o).indexOf('\n\ndiagram flow "Checkout 2"'), to: textOf(o).length }, userEvent: "delete" });
  });
  await settled(o);
  expect(textOf(o)).toBe(BOARD.replace(/\n$/, ""));
  expect(entry(o, "Checkout 2")).toEqual(kept);
  const before = textOf(o);
  let r: RunResult | null = null;
  await act(async () => {
    r = await o.doc().frameOp({ op: "duplicateFrame", frameIndex: 0 });
  });
  expect(r).toMatchObject({ name: "Checkout 2" });
  // A fresh entry: a copy of Checkout's, not the gone frame's kept one.
  expect(entry(o, "Checkout 2")!.nodes).toEqual({ Cart: { x: 0, y: 0 }, Pay: { x: 0, y: 120 } });
  undoOnce(o);
  expect(textOf(o)).toBe(before);
  expect(entry(o, "Checkout 2")).toEqual(kept);
});

test("an_append_after_the_shown_frame_keeps_the_shown_block", async () => {
  for (const shownIndex of [0, 2]) {
    const o = await open(BOARD, LAYOUT, [frameView(() => {})]);
    const f = splitFrames(textOf(o))[shownIndex];
    const end = textOf(o)[f.to - 1] === "\n" ? f.to - 1 : f.to;
    act(() => {
      o.view.dispatch({ effects: showFrame.of({ from: f.from, to: end, line: f.line }), selection: EditorSelection.cursor(f.from) });
    });
    const before = shownRange(o.view.state);
    expect(before).not.toBeNull();
    await addTexts(o, SHOP);
    expect(textOf(o)).toContain('"Pay sequence"');
    expect(shownRange(o.view.state)).toEqual(before);
  }
});

test("added_frames_are_not_relaid_out_on_the_next_parse", async () => {
  const o = await open(BOARD);
  const layout = vi.spyOn(LangClient.prototype, "layout");
  try {
    await addTexts(o, SHOP);
    // The hook's own layoutNodes laid out the ERD and the flowchart; the sequence draws itself.
    expect(layout).toHaveBeenCalledTimes(2);
    layout.mockClear();
    await settled(o);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(layout).not.toHaveBeenCalled();
    expect(Object.keys(entry(o, "Checkout flow")!.nodes).sort()).toEqual(["Cart", "Done", "Pay"]);
  } finally {
    layout.mockRestore();
  }
});

test("add_frames_returns_titles_and_boxes_and_selects_nothing", async () => {
  const o = await open(BOARD);
  act(() => o.doc().select({ title: "Refund", index: 1 }));
  const r = await addTexts(o, SHOP);
  expect("titles" in r && r.titles).toEqual(SHOP_TITLES);
  expect(boxesOf(r)).toHaveLength(3);
  for (const b of boxesOf(r)) expect(b.w > 0 && b.h > 0).toBe(true);
  expect(o.doc().selected).toEqual({ title: "Refund", index: 1 });
  // Nothing selected stays nothing selected.
  const p = await open(BOARD);
  await addTexts(p, [SHOP[1]]);
  expect(p.doc().selected).toBeNull();
});

test("a_template_past_the_layout_budget_still_adds", async () => {
  const o = await open(BOARD);
  // As in a_save_past_the_budget_keeps_the_text_and_the_last_layout: frame 0 broken keeps positions with long names.
  type(o, "Cart > Pay", "Cart >");
  await settled(o);
  const big = emptyPositions();
  const pad = "x".repeat(1_000);
  for (let i = 0; i * 1_020 < LAYOUT_SAVE_MAX + 200_000; i++) big[`${pad}${i}`] = { x: i, y: i };
  act(() => o.doc().placeIn("Checkout", big));
  const r = await addTexts(o, SHOP);
  expect("titles" in r && r.titles).toEqual(SHOP_TITLES);
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  // R17: the text is written; the layout keeps the last one saved and the budget note shows.
  expect(disk.get("board")!.text).toBe(textOf(o));
  expect(disk.get("board")!.text).toContain('diagram sequence "Pay sequence"');
  expect(disk.get("board")!.layout).toBe(LAYOUT);
  expect(o.doc().save).toEqual({ kind: "failed", message: "Layout not saved: the layout file would pass 5 MB. Remove some sketches." });
});

/** An ER frame titled `title` with one table per name; `broken` leaves a line that does not read. */
const erFrame = (title: string, tables: string[], broken = false) =>
  `diagram er "${title}"\n${tables.map((t) => `${t} {\n  id int pk\n}\n`).join("")}${broken ? "oops [\n" : ""}`;
/** The table or node names the selected frame draws; null when it draws nothing. */
const drawnNames = (o: Opened) => o.doc().parsed!.drawn?.nodes.map((n) => n.name) ?? null;

test("a_frame_with_errors_never_takes_a_same_titled_frame_of_another_kind", async () => {
  const o = await open(`${erFrame("Billing", ["invoices"])}\ndiagram flow "Billing"\nPay [\n`, null);
  act(() => o.doc().select({ title: "Billing", index: 1 }));
  expect(o.doc().parsed!.result.kind).toBe("flow");
  expect(drawnNames(o)).toBeNull();
  // Each edit of the ER frame leaves the flow frame with errors drawing nothing.
  type(o, "invoices {", "payments {\n  id int pk\n}\ninvoices {");
  await settled(o);
  expect(o.doc().parsed!.result.frames[0].doc?.nodes.map((n) => n.name)).toEqual(["payments", "invoices"]);
  expect(o.doc().parsed!.result.lastValid).toBeNull();
  expect(drawnNames(o)).toBeNull();
  type(o, "payments {", "refunds {");
  await settled(o);
  expect(drawnNames(o)).toBeNull();
});

test("two_same_kind_frames_with_one_title_keep_their_own_last_good", async () => {
  // The second frame never read: it has no drawing of its own, and never takes the first's.
  const o = await open(`${erFrame("Billing", ["invoices"])}\n${erFrame("Billing", ["ledger"], true)}`, null);
  act(() => o.doc().select({ title: "Billing", index: 1 }));
  type(o, "invoices {", "payments {");
  await settled(o);
  expect(drawnNames(o)).toBeNull();
  // Once it reads, a later error keeps its own tables.
  type(o, "oops [\n", "", textOf(o).lastIndexOf("diagram"));
  await settled(o);
  expect(drawnNames(o)).toEqual(["ledger"]);
  type(o, "ledger {\n  id int pk\n}\n", "ledger {\n  id int pk\n}\noops [\n");
  await settled(o);
  expect(o.doc().parsed!.result.frames[1].doc).toBeNull();
  expect(drawnNames(o)).toEqual(["ledger"]);
});

test("a_renamed_frame_with_errors_keeps_its_own_drawing", async () => {
  const pay = 'diagram flow "Pay"\nCard\n';
  const o = await open(`${pay}\n${erFrame("Billing", ["invoices"])}`, null);
  act(() => o.doc().select({ title: "Billing", index: 1 }));
  // Renamed to the flow frame's title and broken in one edit.
  type(o, erFrame("Billing", ["invoices"]), erFrame("Pay", ["invoices"], true));
  await settled(o);
  act(() => o.doc().select({ title: "Pay", index: 1 }));
  expect(o.doc().parsed!.result.kind).toBe("er");
  expect(drawnNames(o)).toEqual(["invoices"]);
});

test("a_moved_frame_keeps_its_own_drawing", async () => {
  const flow = (broken: boolean) => `diagram flow "Billing"\nCard\n${broken ? "Pay [\n" : ""}`;
  const o = await open(`${flow(false)}\n${erFrame("Billing", ["invoices"])}`, null);
  // The ER frame moved above the flow frame, and both broken, in one edit.
  act(() => {
    o.view.dispatch({ changes: { from: 0, to: o.view.state.doc.length, insert: `${erFrame("Billing", ["invoices"], true)}\n${flow(true)}` }, userEvent: "input.paste" });
  });
  await settled(o);
  act(() => o.doc().select({ title: "Billing", index: 0 }));
  expect(o.doc().parsed!.result.kind).toBe("er");
  expect(drawnNames(o)).toEqual(["invoices"]);
  act(() => o.doc().select({ title: "Billing", index: 1 }));
  expect(o.doc().parsed!.result.kind).toBe("flow");
  expect(drawnNames(o)).toEqual(["Card"]);
});

/** Each frame's drawing as the canvas has it, frame by frame through the selection. */
function canvasDrawns(o: Opened) {
  const frames = o.doc().parsed!.result.frames;
  return frames.map((f, i) => {
    act(() => o.doc().select({ title: f.title, index: i }));
    return o.doc().parsed!.drawn;
  });
}
/** The canvas draws exactly what the worker sends for every frame: its doc, else its last good one. */
function agrees(o: Opened) {
  const frames = o.doc().parsed!.result.frames;
  const drawns = canvasDrawns(o);
  frames.forEach((f, i) => expect(drawns[i]).toBe(f.doc ?? f.lastValid));
}
/** Replaces the whole text in one edit, as a paste does. */
function setText(o: Opened, text: string) {
  act(() => {
    o.view.dispatch({ changes: { from: 0, to: o.view.state.doc.length, insert: text }, userEvent: "input.paste" });
  });
}

test("deleting_the_first_of_two_same_titled_frames_never_hands_its_drawing_on", async () => {
  const o = await open(`${erFrame("Billing", ["invoices"])}\n${erFrame("Billing", ["ledger"])}`, null);
  setText(o, `${erFrame("Billing", ["invoices"])}\n${erFrame("Billing", ["ledger"], true)}`);
  await settled(o);
  expect(canvasDrawns(o)[1]?.nodes.map((n) => n.name)).toEqual(["ledger"]);
  setText(o, erFrame("Billing", ["ledger"], true));
  await settled(o);
  expect(o.doc().keys).toEqual(["Billing"]);
  expect(drawnNames(o)).toBeNull();
  agrees(o);
});

test("deleting_a_frame_by_its_op_with_a_clash_raises_nothing", async () => {
  const o = await open(`${erFrame("Billing", ["invoices"])}\n${erFrame("Billing", ["ledger"])}\n${CHECKOUT}`, null);
  await settled(o);
  await act(async () => {
    await o.doc().frameOp({ op: "deleteFrame", frameIndex: 0 });
  });
  await settled(o);
  await act(async () => {
    await o.doc().frameOp({ op: "deleteFrame", frameIndex: 1 });
  });
  await settled(o);
  expect(o.doc().parsed!.result.frames.map((f) => f.title)).toEqual(["Billing"]);
  agrees(o);
});

test("the_canvas_and_the_worker_agree_on_every_frames_drawing", async () => {
  const flow = (broken: boolean) => `diagram flow "Billing"\nCard\n${broken ? "Pay [\n" : ""}`;
  const a = erFrame("Billing", ["invoices"]);
  const b = erFrame("Billing", ["ledger"]);
  const o = await open(`${a}\n${b}\n${flow(false)}`, null);
  // Each broken, then a delete, a duplicate, an append and a reorder.
  const steps = [
    `${erFrame("Billing", ["invoices"], true)}\n${erFrame("Billing", ["ledger"], true)}\n${flow(true)}`,
    `${erFrame("Billing", ["ledger"], true)}\n${flow(true)}`,
    `${erFrame("Billing", ["ledger"], true)}\n${erFrame("Billing", ["ledger"], true)}\n${flow(true)}`,
    `${erFrame("Billing", ["ledger"], true)}\n${erFrame("Billing", ["ledger"], true)}\n${flow(true)}\n${CHECKOUT}`,
    `${flow(true)}\n${CHECKOUT}\n${erFrame("Billing", ["ledger"], true)}\n${erFrame("Billing", ["ledger"], true)}`,
  ];
  for (const t of steps) {
    setText(o, t);
    await settled(o);
    agrees(o);
  }
});

test("retyping_the_kind_word_keeps_the_frames_own_drawing_on_the_canvas", async () => {
  for (const broken of [false, true]) {
    for (const first of [true, false]) {
      const er = erFrame("Billing", ["invoices"]);
      const o = await open(first ? `${er}\n${CHECKOUT}` : `${CHECKOUT}\n${er}`, null);
      const at = first ? 0 : 1;
      if (broken) {
        type(o, "invoices {\n  id int pk\n}\n", "invoices {\n  id int pk\n}\noops [\n");
        await settled(o);
      }
      act(() => o.doc().select({ title: "Billing", index: at }));
      expect(drawnNames(o)).toEqual(["invoices"]);
      type(o, "diagram er", "diagram e");
      await settled(o);
      // The first frame stays a frame with no kind and keeps its drawing; a later one joins the frame above.
      if (first) {
        expect(o.doc().parsed!.result.kind).toBeNull();
        expect(drawnNames(o)).toEqual(["invoices"]);
      } else expect(o.doc().parsed!.result.frames).toHaveLength(1);
      agrees(o);
      type(o, "diagram e", "diagram er");
      await settled(o);
      act(() => o.doc().select({ title: "Billing", index: at }));
      expect(drawnNames(o)).toEqual(["invoices"]);
      agrees(o);
    }
  }
});

// ----- Task 4b: a frame From my database drew keeps its source in its entry, by title.

const FROM_DB = { connectionId: "c1", database: "shop", schema: null };

test("an_added_frame_keeps_its_source_and_a_rename_moves_it", async () => {
  const o = await open(BOARD);
  await settled(o);
  let r: Added | undefined;
  await act(async () => {
    r = await o.doc().addFrames([{ text: SHOP[0], source: FROM_DB }, { text: SHOP[1] }], { x: 0, y: 0 });
  });
  expect(r && "titles" in r && r.titles).toEqual(["Orders ERD", "Checkout flow"]);
  // The text is the frame's own; the source is in the entry only.
  expect(textOf(o)).toBe(`${BOARD}\n${SHOP[0]}\n${SHOP[1]}`);
  expect(entry(o, "Orders ERD")?.source).toEqual(FROM_DB);
  expect(entry(o, "Checkout flow")?.source).toBeUndefined();
  await settled(o);
  await waitFor(() => expect(JSON.parse(disk.get("board")!.layout!).frames["Orders ERD"].source).toEqual(FROM_DB));
  // A rename from the menu moves it with the entry.
  await act(async () => {
    await o.doc().frameOp({ op: "renameFrame", frameIndex: 3, title: "Shop ERD" });
  });
  expect(entry(o, "Shop ERD")?.source).toEqual(FROM_DB);
  expect(entry(o, "Orders ERD")).toBeUndefined();
  // So does a title typed by hand.
  await settled(o);
  type(o, '"Shop ERD"', '"Shop tables"');
  await settled(o);
  await waitFor(() => expect(entry(o, "Shop tables")?.source).toEqual(FROM_DB));
  await waitFor(() => expect(JSON.parse(disk.get("board")!.layout!).frames["Shop tables"]?.source).toEqual(FROM_DB));
  // Undo of the add takes the entry, source and all.
  undoOnce(o);
  undoOnce(o);
  undoOnce(o);
  expect(textOf(o)).toBe(BOARD);
  for (const t of ["Orders ERD", "Shop ERD", "Shop tables"]) expect(entry(o, t)).toBeUndefined();
});

test("a_duplicate_keeps_the_source", async () => {
  const o = await open(BOARD);
  await settled(o);
  await act(async () => {
    await o.doc().addFrames([{ text: SHOP[0], source: FROM_DB }], { x: 0, y: 0 });
  });
  await settled(o);
  let r: Awaited<ReturnType<FlowDocApi["frameOp"]>> = null;
  await act(async () => {
    r = await o.doc().frameOp({ op: "duplicateFrame", frameIndex: 3 });
  });
  expect(r).toMatchObject({ name: "Orders ERD 2" });
  // The copy holds the same Connection's names, so it is gated the same way.
  expect(entry(o, "Orders ERD 2")?.source).toEqual(FROM_DB);
  expect(entry(o, "Orders ERD")?.source).toEqual(FROM_DB);
});

test("a_sourced_frame_titled_like_another_keeps_the_ask_held_after_a_reopen", async () => {
  // Review minor 1: the From my database frame is retitled by hand to a title another frame has. The rename is
  // refused for the entry (the title is taken), so the save keeps it under the old title; on reopen no frame owns that
  // title. The source must still hold the Ask, never be dropped.
  const o = await open(BOARD);
  await settled(o);
  await act(async () => {
    await o.doc().addFrames([{ text: SHOP[0], source: FROM_DB }], { x: 0, y: 0 });
  });
  await settled(o);
  type(o, '"Orders ERD"', '"Checkout"');
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  const onDisk = disk.get("board")!;
  expect(onDisk.text).toContain('diagram er "Checkout"');
  unmounts.splice(0).forEach((u) => u());
  const again = await open(onDisk.text, onDisk.layout);
  await settled(again);
  const fields = boardGateFields(again.doc().parsed!, again.doc().board, []);
  expect(fields.sources?.map((s) => s.connectionId)).toContain("c1");
  // And the next save keeps it.
  type(again, "Ask\n", "Ask them\n");
  await settled(again);
  await act(async () => {
    await again.doc().flush();
  });
  expect(disk.get("board")!.text).toContain("Ask them");
  const saved = JSON.parse(disk.get("board")!.layout!) as { frames: Record<string, { source?: unknown }> };
  expect(Object.values(saved.frames).some((e) => (e.source as { connectionId?: string } | undefined)?.connectionId === "c1")).toBe(true);
});

test("every_stray_source_stays_held_across_two_reopens", async () => {
  // Two sourced frames, each retitled onto another frame's title: neither source may be dropped by a save.
  const o = await open(BOARD);
  await settled(o);
  await act(async () => {
    await o.doc().addFrames([{ text: SHOP[0], source: FROM_DB }], { x: 0, y: 0 });
  });
  await settled(o);
  const other = 'diagram er "Ledger ERD"\nentries {\n  id int pk\n}\n';
  await act(async () => {
    await o.doc().addFrames([{ text: other, source: { connectionId: "c2", database: "ledger", schema: "public" } }], { x: 0, y: 0 });
  });
  await settled(o);
  type(o, '"Orders ERD"', '"Checkout"');
  await settled(o);
  type(o, '"Ledger ERD"', '"Refund"');
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  const heldIds = (x: Opened) => (boardGateFields(x.doc().parsed!, x.doc().board, []).sources ?? []).map((s) => s.connectionId).sort();
  unmounts.splice(0).forEach((u) => u());
  let f = disk.get("board")!;
  const first = await open(f.text, f.layout);
  await settled(first);
  expect(heldIds(first)).toEqual(expect.arrayContaining(["c1", "c2"]));
  // A save, then a reopen: both are still held.
  type(first, "Ask\n", "Ask them\n");
  await settled(first);
  await act(async () => {
    await first.doc().flush();
  });
  unmounts.splice(0).forEach((u) => u());
  f = disk.get("board")!;
  const second = await open(f.text, f.layout);
  await settled(second);
  expect(heldIds(second)).toEqual(expect.arrayContaining(["c1", "c2"]));
});

test("deleting_a_sourced_frame_lets_the_ask_go_and_undo_holds_it_again", async () => {
  // A frame deleted in the app takes its source with it: nothing is left in `held`, so the board's Ask is not blocked
  // with no way out. Undo brings the frame and its source back.
  const ids = (x: Opened) => (boardGateFields(x.doc().parsed!, x.doc().board, []).sources ?? []).map((s) => s.connectionId);
  const o = await open(BOARD);
  await settled(o);
  await act(async () => {
    await o.doc().addFrames([{ text: SHOP[0], source: FROM_DB }], { x: 0, y: 0 });
  });
  await settled(o);
  expect(ids(o)).toEqual(["c1"]);
  await act(async () => {
    await o.doc().frameOp({ op: "deleteFrame", frameIndex: 3 });
  });
  await settled(o);
  expect(textOf(o)).toBe(BOARD);
  expect(ids(o)).toEqual([]);
  undoOnce(o);
  await settled(o);
  expect(ids(o)).toEqual(["c1"]);
  // Deleted again and saved: the reopened board's Ask goes, and nothing is kept as held.
  await act(async () => {
    await o.doc().frameOp({ op: "deleteFrame", frameIndex: 3 });
  });
  await settled(o);
  await act(async () => {
    await o.doc().flush();
  });
  unmounts.splice(0).forEach((u) => u());
  const f = disk.get("board")!;
  expect(f.layout).not.toContain("c1");
  const again = await open(f.text, f.layout);
  await settled(again);
  expect(ids(again)).toEqual([]);
  expect(again.doc().board.held ?? []).toEqual([]);
});

// A landing that adds frames is one undo entry, at the place the review previewed.
const LANDED_TITLE = "Checkout flow";
const LANDED_TEXT = SHOP[1];

/** An edit appending `LANDED_TEXT` the way appendFrames writes it. */
const appendEdit = (o: Opened) => ({ from: textOf(o).length, to: textOf(o).length, insert: `\n${LANDED_TEXT}` });

test("land_board_is_one_undo_with_its_frames", async () => {
  const layout = vi.spyOn(LangClient.prototype, "layout");
  const o = await open(BOARD);
  await settled(o);
  const before = textOf(o);
  const prepared = await act(() => o.doc().prepareFrames([{ text: LANDED_TEXT }], [LANDED_TITLE], { x: 400, y: 700 }));
  const laidOut = layout.mock.calls.length;
  let ok = false;
  act(() => {
    ok = o.doc().landBoard([{ from: 0, to: 0, insert: "// a\n" }, appendEdit(o)], o.doc().parsed!.result.version, prepared.entries);
  });
  expect(ok).toBe(true);
  const previewed = prepared.entries[0].after;
  const landed = () => o.doc().board.frames.get(LANDED_TITLE)!;
  expect(landed().at).toEqual(previewed.at);
  expect(landed().nodes).toEqual(previewed.nodes);
  expect(landed().direction).toBe(previewed.direction);
  const after = textOf(o);
  expect(after).toBe(`// a\n${before}\n${LANDED_TEXT}`);
  const depth = undoDepth(o.view.state);
  undoOnce(o);
  expect(textOf(o)).toBe(before);
  expect(o.doc().board.frames.has(LANDED_TITLE)).toBe(false);
  expect(undoDepth(o.view.state)).toBe(depth - 1);
  act(() => void redo(o.view));
  expect(textOf(o)).toBe(after);
  expect(landed().at).toEqual(previewed.at);
  expect(landed().direction).toBe(previewed.direction);
  expect(Object.keys(previewed.nodes).length).toBeGreaterThan(0);
  expect(landed().nodes).toEqual(previewed.nodes);
  // No layout pass from the landing, the undo or the redo.
  expect(layout.mock.calls.length).toBe(laidOut);
  layout.mockRestore();
});

test("a_moved_version_lands_nothing", async () => {
  const o = await open(BOARD);
  await settled(o);
  const version = o.doc().parsed!.result.version;
  const prepared = await act(() => o.doc().prepareFrames([{ text: LANDED_TEXT }], [LANDED_TITLE], { x: 0, y: 0 }));
  type(o, "Cart", "Basket");
  const typed = textOf(o);
  const depth = undoDepth(o.view.state);
  expect(o.doc().landBoard([appendEdit(o)], version, prepared.entries)).toBe(false);
  await settled(o);
  expect(o.doc().landBoard([appendEdit(o)], version, prepared.entries)).toBe(false);
  expect(textOf(o)).toBe(typed);
  expect(o.doc().board.frames.has(LANDED_TITLE)).toBe(false);
  expect(undoDepth(o.view.state)).toBe(depth);
});

test("prepare_frames_writes_nothing", async () => {
  const o = await open(BOARD);
  await settled(o);
  const text = textOf(o);
  const frames = new Map(o.doc().board.frames);
  const depth = undoDepth(o.view.state);
  const prepared = await act(() => o.doc().prepareFrames(SHOP.map((t) => ({ text: t })), SHOP_TITLES, { x: 0, y: 0 }));
  expect(prepared.entries.map((e) => e.title)).toEqual(SHOP_TITLES);
  expect(prepared.boxes).toHaveLength(3);
  expect(textOf(o)).toBe(text);
  expect(o.doc().board.frames).toEqual(frames);
  expect(undoDepth(o.view.state)).toBe(depth);
});

test("prepare_frames_rejects_a_title_short_of_its_frames", async () => {
  const o = await open(BOARD);
  await settled(o);
  await expect(o.doc().prepareFrames(SHOP.map((t) => ({ text: t })), SHOP_TITLES.slice(0, 2), { x: 0, y: 0 })).rejects.toThrow(/titles/);
});

test("a_frame_lands_where_it_was_previewed", async () => {
  const o = await open(BOARD);
  await settled(o);
  const prepared = await act(() => o.doc().prepareFrames(SHOP.map((t) => ({ text: t })), SHOP_TITLES, { x: 500, y: 900 }));
  const edits = [{ from: textOf(o).length, to: textOf(o).length, insert: `\n${SHOP.join("\n")}` }];
  act(() => void o.doc().landBoard(edits, o.doc().parsed!.result.version, prepared.entries));
  await settled(o);
  SHOP_TITLES.forEach((t, i) => {
    const e = entry(o, t)!;
    expect(e.at).toEqual(prepared.entries[i].after.at);
    expect(e.nodes).toEqual(prepared.entries[i].after.nodes);
    expect(e.direction).toBe(prepared.entries[i].after.direction);
    near(frameBounds(e, docAt(o, 3 + i), "modern"), prepared.boxes[i]);
  });
});
