// The Ask's chips and the `/` list of diagrams: the frame chip follows the selected frame, a
// frame added by hand stays, `/` lists the board's frames, Backspace in an empty box takes the last chip, a ninth chip
// is refused with a note, the selection chip counts shapes and sketches, and a board has no scope control.
import { act as reactAct, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { AiEvent, AppendTurn, DiagramAskRequest, Preview, ProposedChange } from "../../api/types";
import { textStore } from "../../assistant/answerStream";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { done, sent } from "../../test/aiStream";
import { turnViewOf } from "../../test/aiThreads";
import { mockEditorDom } from "../../test/editor";
import { callsTo, routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import { GROQ } from "../../test/settingsRoutes";
import FlowTab from "../FlowTab";
import type { FlowDocApi } from "../useFlowDoc";
import { type BoardFrame, CHIPS_FULL, frameRefs, MAX_CHIPS, useAskChips } from "./AskChips";
import DiagramAssistant from "./DiagramAssistant";
import type { BoardAsk } from "./useBoardAsk";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

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

/** The doc FlowTab last gave the board Ask: the test selects frames through it. */
const hooked = vi.hoisted(() => ({ doc: null as FlowDocApi | null }));
vi.mock("./useBoardAsk", async (load) => {
  const real = await load<typeof import("./useBoardAsk")>();
  return {
    ...real,
    useBoardAsk: (...a: Parameters<typeof real.useBoardAsk>) => {
      hooked.doc = a[1];
      return real.useBoardAsk(...a);
    },
  };
});

beforeAll(() => {
  mockReactFlowDom();
  mockEditorDom();
});

const BOARD = [
  'diagram flow "Checkout"',
  "Cart",
  "Pay",
  "Cart > Pay",
  "",
  'diagram er "Orders ERD"',
  "orders {",
  "  id int pk",
  "}",
  "",
  'diagram flow "Refund"',
  "Ask",
  "Refund it",
  "Ask > Refund it",
  "",
].join("\n");

/** The board the tab reads. */
let boardText = BOARD;
/** What the next Ask answers, when set; else a one-line text. */
let replies: AiEvent[][] = [];
const okIn = (frame: string, index: number, op: ProposedChange["op"]): ProposedChange => ({ index, op, status: { kind: "ok" }, dependsOn: [], frame });
const proposing = (changes: ProposedChange[]): AiEvent[] => [sent(), { type: "delta", text: "Here." }, { type: "proposal", proposal: { file: "board", baseHash: "b1", changes }, input: "{}" } as AiEvent, done()];

const PREVIEW: Preview = { items: [], tables: { full: [], namesOnly: [], leftOut: [], reasons: [] }, totalBytes: 0, tokens: 0, exact: "", notes: [], log: [], context: null, rows: null };

beforeEach(() => {
  localStorage.clear();
  canvas.props = null;
  hooked.doc = null;
  replies = [];
  boardText = BOARD;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  routeInvoke({
    read_diagram: () => ({ text: boardText, layout: null }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    list_ai_threads: () => [],
    get_ai_thread: () => null,
    ai_append_turn: (a) => turnViewOf(a.turn as AppendTurn, null),
    ai_known_models: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    ai_settings: () => ({ settings: { ...GROQ, diagramTool: true }, groupOverride: false, keySaved: true, keyLast4: "abcd" }),
    ai_diagram_preview: () => PREVIEW,
    ai_diagram_ask: (a) => {
      const sink = a.events as { onmessage: (e: AiEvent) => void };
      const events = replies.shift() ?? [sent(), { type: "delta", text: "Done." } as AiEvent, done()];
      setTimeout(() => events.forEach((e) => sink.onmessage(e)), 0);
      return null;
    },
    ai_cancel_place: () => true,
    ai_record_tool_result: (a) => a.outcome,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function board() {
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  return { ...utils, view };
}

async function parsed() {
  await waitFor(() => expect(hooked.doc?.parsed?.result.frames.map((f) => f.title)).toEqual(["Checkout", "Orders ERD", "Refund"]), { timeout: 4000 });
}
const select = (title: string, index: number) => reactAct(() => hooked.doc!.select({ title, index }));
const ask = () => fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
const box = () => screen.getByRole("textbox", { name: "Describe a change" }) as HTMLTextAreaElement;
const typeIn = (value: string) => fireEvent.change(box(), { target: { value } });
const chipNames = () => [...document.querySelectorAll(".ask-chip-x")].map((b) => b.getAttribute("aria-label"));
/** The chips but the automatic one of Orders ERD, which the edit tests select. */
const hand = () => chipNames().filter((n) => n !== "Remove ER diagram Orders ERD");
const asks = () => callsTo("ai_diagram_ask").map((c) => c.request as DiagramAskRequest);

test("ai_chat_on_a_frame_adds_its_chip", async () => {
  const s = board();
  await parsed();
  await select("Orders ERD", 1);
  ask();
  await waitFor(() => expect(chipNames()).toEqual(["Remove ER diagram Orders ERD"]));
  // A proposal in Refund leaves AI Chat on that frame, which is not selected.
  replies = [proposing([okIn("Refund", 0, { add_node: { name: "Wait" } })])];
  typeIn("Add a wait to the refund");
  fireEvent.keyDown(box(), { key: "Enter" });
  await screen.findByRole("toolbar", { name: "Assistant changes" });
  const frame = [...s.container.querySelectorAll<HTMLElement>(".board-frame")].find((f) => f.querySelector(".board-frame-name")?.textContent === "Refund")!;
  fireEvent.click(within(frame).getByRole("button", { name: /^AI Chat/ }));
  // The review holds the frame it asked from, so the click cannot select Refund: its chip is added by hand instead.
  await waitFor(() => expect(chipNames()).toEqual(["Remove ER diagram Orders ERD", "Remove Flowchart Refund"]));
  expect(hooked.doc!.selected).toEqual({ title: "Orders ERD", index: 1 });
  expect(screen.getByRole("tab", { name: /^Assistant/ }).getAttribute("aria-selected")).toBe("true");
  // Clicking it again adds nothing twice.
  fireEvent.click(within(frame).getByRole("button", { name: /^AI Chat/ }));
  fireEvent.click(within(frame).getByRole("button", { name: /^AI Chat/ }));
  expect(chipNames()).toHaveLength(2);
});

test("a_question_names_its_frame_chip_once_as_focus", async () => {
  board();
  await parsed();
  await select("Orders ERD", 1);
  ask();
  await waitFor(() => expect(chipNames()).toEqual(["Remove ER diagram Orders ERD"]));
  typeIn("What is in this?");
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(asks()).toHaveLength(1));
  // The chip is the one source of the focus: the title goes once.
  expect(asks()[0].board!.focus).toEqual(["Orders ERD"]);
});

test("the_auto_chip_follows_the_selected_frame_and_a_hand_chip_stays", async () => {
  board();
  await parsed();
  await select("Orders ERD", 1);
  ask();
  await waitFor(() => expect(chipNames()).toEqual(["Remove ER diagram Orders ERD"]));
  // Refund by hand through the `/` list.
  typeIn("/refund");
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(chipNames()).toEqual(["Remove ER diagram Orders ERD", "Remove Flowchart Refund"]));
  // The selection moves on: the automatic chip follows it, the hand chip stays.
  await select("Checkout", 0);
  await waitFor(() => expect(chipNames()).toEqual(["Remove Flowchart Checkout", "Remove Flowchart Refund"]));
  typeIn("Compare them");
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(asks()).toHaveLength(1));
  expect(asks()[0].board!.focus).toEqual(["Checkout", "Refund"]);
});

test("a_removed_auto_chip_stays_away_until_another_frame_is_selected", async () => {
  board();
  await parsed();
  await select("Orders ERD", 1);
  ask();
  await waitFor(() => expect(chipNames()).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Remove ER diagram Orders ERD" }));
  expect(chipNames()).toEqual([]);
  await select("Refund", 2);
  await waitFor(() => expect(chipNames()).toEqual(["Remove Flowchart Refund"]));
});

test("slash_lists_the_frames_and_enter_adds_one", async () => {
  board();
  await parsed();
  ask();
  await screen.findByRole("textbox", { name: "Describe a change" });
  typeIn("/");
  const list = await screen.findByRole("listbox", { name: "Diagrams on this board" });
  expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["CheckoutFlowchart", "Orders ERDER diagram", "RefundFlowchart"]);
  // Filtered by what follows the slash; ArrowDown moves, Enter adds and the word leaves the box.
  typeIn("Compare with /r");
  expect(within(screen.getByRole("listbox", { name: "Diagrams on this board" })).getAllByRole("option").map((o) => o.textContent)).toEqual(["RefundFlowchart", "Orders ERDER diagram"]);
  fireEvent.keyDown(box(), { key: "ArrowDown" });
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(chipNames()).toEqual(["Remove ER diagram Orders ERD"]);
  expect(box().value).toBe("Compare with ");
  expect(screen.queryByRole("listbox", { name: "Diagrams on this board" })).toBeNull();
  expect(callsTo("ai_diagram_ask")).toHaveLength(0);
  // A click adds one too, and Esc closes the list without a chip.
  typeIn("/chec");
  fireEvent.click(screen.getByRole("option", { name: /Checkout/ }));
  expect(chipNames()).toEqual(["Remove ER diagram Orders ERD", "Remove Flowchart Checkout"]);
  typeIn("/ref");
  fireEvent.keyDown(box(), { key: "Escape" });
  expect(screen.queryByRole("listbox", { name: "Diagrams on this board" })).toBeNull();
  expect(chipNames()).toHaveLength(2);
});

test("a_slash_inside_a_word_is_not_a_list", async () => {
  board();
  await parsed();
  ask();
  await screen.findByRole("textbox", { name: "Describe a change" });
  // The `/` is typed after a letter: the text stays as typed, no list opens, and Enter sends it rather than picking a frame.
  typeIn("the Orders");
  typeIn("the Orders/");
  expect(box().value).toBe("the Orders/");
  expect(screen.queryByRole("listbox", { name: "Diagrams on this board" })).toBeNull();
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(asks()).toHaveLength(1));
  expect(asks()[0].question).toBe("the Orders/");
  expect(asks()[0].board!.focus).toEqual([]);
  expect(chipNames()).toEqual([]);
});

test("backspace_in_an_empty_box_removes_the_last_chip", async () => {
  board();
  await parsed();
  await select("Orders ERD", 1);
  ask();
  await waitFor(() => expect(chipNames()).toHaveLength(1));
  typeIn("/ref");
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(chipNames()).toHaveLength(2));
  // With text in the box Backspace edits the text.
  typeIn("x");
  fireEvent.keyDown(box(), { key: "Backspace" });
  expect(chipNames()).toHaveLength(2);
  typeIn("");
  fireEvent.keyDown(box(), { key: "Backspace" });
  expect(chipNames()).toEqual(["Remove ER diagram Orders ERD"]);
  fireEvent.keyDown(box(), { key: "Backspace" });
  expect(chipNames()).toEqual([]);
  // No chip, nothing to take.
  fireEvent.keyDown(box(), { key: "Backspace" });
  expect(chipNames()).toEqual([]);
});

test("nine_chips_are_refused_with_a_note", () => {
  const { result } = renderHook(() => useAskChips(null, 0));
  for (let i = 0; i < MAX_CHIPS; i++) {
    let note: string | null = "x";
    reactAct(() => {
      note = result.current.addFrame(`Frame ${i}`, i);
    });
    expect(note).toBeNull();
  }
  expect(result.current.chips).toHaveLength(8);
  let note: string | null = null;
  reactAct(() => {
    note = result.current.addFrame("Frame 8", 8);
  });
  expect(note).toBe("A question holds at most 8 references.");
  expect(note).toBe(CHIPS_FULL);
  expect(result.current.chips).toHaveLength(8);
  // A frame already chipped is not a ninth.
  reactAct(() => {
    note = result.current.addFrame("Frame 3", 3);
  });
  expect(note).toBeNull();
  expect(result.current.chips).toHaveLength(8);
});

test("create_and_file_chips_go_with_the_ask_as_a_kind_and_a_token", () => {
  const { result } = renderHook(() => useAskChips(null, 0));
  reactAct(() => {
    result.current.addCreate("sequence");
    result.current.addFile({ name: "notes.txt", token: "tok-1" });
  });
  expect(result.current.chips).toEqual([
    { kind: "create", diagram: "sequence" },
    { kind: "file", name: "notes.txt", token: "tok-1" },
  ]);
  // One of each: a new one takes the place of the old.
  reactAct(() => {
    result.current.addFile({ name: "more.txt", token: "tok-2" });
    result.current.addCreate("er");
  });
  expect(result.current.chips).toEqual([
    { kind: "file", name: "more.txt", token: "tok-2" },
    { kind: "create", diagram: "er" },
  ]);
  // Neither is a frame: no focus.
  expect(result.current.focus()).toEqual([]);
});

test("frameRefs_filters_by_what_follows_the_slash_and_keeps_board_order", () => {
  const frames = [
    { title: "Checkout", kind: "flow" as const },
    { title: "Orders ERD", kind: "er" as const },
    { title: "Refund", kind: null },
  ];
  expect(frameRefs(frames, "").map((r) => r.label)).toEqual(["Checkout", "Orders ERD", "Refund"]);
  // Starts first, then contains.
  expect(frameRefs(frames, "r").map((r) => r.label)).toEqual(["Refund", "Orders ERD"]);
  expect(frameRefs(frames, "REF").map((r) => [r.name, r.hint])).toEqual([["2", "Diagram"]]);
  expect(frameRefs(frames, "zzz")).toEqual([]);
});

/** The assistant alone, on a fake hook, to hand it a selection of shapes and sketches. */
function standalone(props: { selected: string[]; sketches: string[]; frames?: readonly BoardFrame[]; onKeyDown?: () => void }) {
  const ai = {
    place: "diagram:board",
    version: 1,
    preview: async () => null,
    thread: null,
    working: null,
    streamed: textStore(),
    waiting: null,
    landed: null,
    failure: null,
    airing: new Set(),
    pending: 0,
    locked: false,
    ghost: null,
    lines: [],
    overlay: null,
    removal: null,
    notSaved: null,
    clearFailure: () => {},
    // Past chats: none here.
    threads: [],
    newChat: () => {},
    openThread: async () => {},
    renameThread: async () => "",
    deleteThread: async () => {},
    clearThreads: async () => {},
    chatError: null,
    send: async () => {},
    stop: () => {},
  } as unknown as BoardAsk;
  const { onKeyDown, ...rest } = props;
  return render(
    <div onKeyDown={onKeyDown}>
      <DiagramAssistant ai={ai} name="board" kind={null} mode="review" onMode={() => {}} onShowText={() => {}} onUndo={() => {}} {...rest} />
    </div>,
  );
}

test("the_selection_chip_counts_shapes_and_sketches", async () => {
  const view = standalone({ selected: ["Cart", "Pay"], sketches: ["s1"] });
  await waitFor(() => expect(chipNames()).toEqual(["Remove 3 selected"]));
  view.unmount();
  standalone({ selected: [], sketches: ["s1", "s2"] });
  await waitFor(() => expect(chipNames()).toEqual(["Remove 2 selected"]));
  cleanup();
  // Nothing selected, no chip.
  standalone({ selected: [], sketches: [] });
  expect(chipNames()).toEqual([]);
});

test("no_scope_control_on_a_board", async () => {
  standalone({ selected: ["Cart"], sketches: [] });
  await screen.findByRole("textbox", { name: "Describe a change" });
  // The selection is a chip, never a scope: no menu or button offers "Whole diagram" or the selection as a limit.
  expect(screen.queryByRole("button", { name: /scope|whole diagram|only the selection/i })).toBeNull();
  expect(screen.queryByText(/whole diagram/i)).toBeNull();
  expect(chipNames()).toEqual(["Remove 1 selected"]);
});

test("a_removed_selection_chip_stops_the_selection_being_sent_until_it_changes", async () => {
  board();
  await parsed();
  await select("Checkout", 0);
  ask();
  await screen.findByRole("textbox", { name: "Describe a change" });
  await reactAct(async () => canvas.props!.onSelect!(["Cart"]));
  await waitFor(() => expect(chipNames()).toEqual(["Remove Flowchart Checkout", "Remove 1 selected"]));
  const lastPreview = () => (callsTo("ai_diagram_preview").slice(-1)[0].request as DiagramAskRequest).board!.selected;
  await waitFor(() => expect(lastPreview().shapes).toEqual(["Cart"]));
  fireEvent.click(screen.getByRole("button", { name: "Remove 1 selected" }));
  // The Sends line is built again without the selection.
  await waitFor(() => expect(lastPreview().shapes).toEqual([]));
  typeIn("Rename it");
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(asks()).toHaveLength(1));
  // The shapes and sketches are left out; the frame stays.
  expect(asks()[0].board!.selected).toEqual({ frame: "Checkout", shapes: [], sketches: [] });
  // A different selection brings the chip, and the shapes, back.
  await reactAct(async () => canvas.props!.onSelect!(["Pay"]));
  await waitFor(() => expect(chipNames()).toEqual(["Remove Flowchart Checkout", "Remove 1 selected"]));
  await waitFor(() => expect(lastPreview().shapes).toEqual(["Pay"]));
});

test("a_hand_chip_goes_with_a_rename_or_a_delete_and_says_so", async () => {
  board();
  await parsed();
  await select("Orders ERD", 1);
  ask();
  await waitFor(() => expect(chipNames()).toEqual(["Remove ER diagram Orders ERD"]));
  typeIn("/refund");
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(hand()).toEqual(["Remove Flowchart Refund"]));
  // Renamed: the chip is dropped and the status line says why; the other chip stays.
  await reactAct(async () => void (await hooked.doc!.frameOp({ op: "renameFrame", frameIndex: 2, title: "Refunds" })));
  await waitFor(() => expect(hand()).toEqual([]));
  expect(screen.getByText("Refund is no longer on the board.").getAttribute("role")).toBe("status");
  expect(chipNames()).toEqual(["Remove ER diagram Orders ERD"]);
  // Typing clears the note.
  typeIn("x");
  expect(screen.queryByText("Refund is no longer on the board.")).toBeNull();
  // Deleted: the same, naming the frame.
  typeIn("/refunds");
  fireEvent.keyDown(box(), { key: "Enter" });
  await waitFor(() => expect(hand()).toEqual(["Remove Flowchart Refunds"]));
  await reactAct(async () => void (await hooked.doc!.frameOp({ op: "deleteFrame", frameIndex: 2 })));
  await waitFor(() => expect(hand()).toEqual([]));
  expect(screen.getByText("Refunds is no longer on the board.").getAttribute("role")).toBe("status");
});

test("a_hand_chip_is_found_again_by_its_title_when_frames_move", () => {
  const f = (...titles: string[]) => titles.map((title) => ({ title, kind: "flow" as const }));
  const { result, rerender } = renderHook(({ frames }) => useAskChips(null, 0, frames), { initialProps: { frames: f("A", "B", "C") } });
  reactAct(() => void result.current.addFrame("C", 2));
  expect(result.current.chips).toEqual([{ kind: "frame", title: "C", index: 2, auto: false }]);
  // A frame is removed above it: the chip follows the title to its new place.
  rerender({ frames: f("A", "C") });
  expect(result.current.chips).toEqual([{ kind: "frame", title: "C", index: 1, auto: false }]);
  expect(result.current.note).toBeNull();
  // Its title goes: dropped, with the note.
  rerender({ frames: f("A", "D") });
  expect(result.current.chips).toEqual([]);
  expect(result.current.note).toBe("C is no longer on the board.");
  expect(result.current.focus()).toEqual([]);
});

test("frames_that_share_a_title_are_listed_but_never_added", async () => {
  boardText = BOARD.replace('diagram flow "Refund"', 'diagram flow "Checkout"');
  board();
  await waitFor(() => expect(hooked.doc?.parsed?.result.frames.map((f) => f.title)).toEqual(["Checkout", "Orders ERD", "Checkout"]), { timeout: 4000 });
  ask();
  await screen.findByRole("textbox", { name: "Describe a change" });
  typeIn("/checkout");
  const rows = () => within(screen.getByRole("listbox", { name: "Diagrams on this board" })).getAllByRole("option");
  // Two rows that do not read alike; the later one says why it is off.
  expect(rows().map((r) => r.textContent)).toEqual(["CheckoutFlowchart", "Checkout, frame 3Two frames share this title. Rename one to refer to it."]);
  expect(rows()[1].getAttribute("aria-disabled")).toBe("true");
  fireEvent.keyDown(box(), { key: "ArrowDown" });
  fireEvent.keyDown(box(), { key: "Enter" });
  fireEvent.click(rows()[1]);
  expect(chipNames()).toEqual([]);
  expect(box().value).toBe("/checkout");
  fireEvent.click(rows()[0]);
  expect(chipNames()).toEqual(["Remove Flowchart Checkout"]);
});

test("backspace_while_composing_does_not_take_a_chip", async () => {
  board();
  await parsed();
  await select("Orders ERD", 1);
  ask();
  await waitFor(() => expect(chipNames()).toHaveLength(1));
  fireEvent.keyDown(box(), { key: "Backspace", isComposing: true });
  fireEvent.keyDown(box(), { key: "Backspace", keyCode: 229 });
  expect(chipNames()).toHaveLength(1);
  fireEvent.keyDown(box(), { key: "Backspace" });
  expect(chipNames()).toEqual([]);
});

/** The assistant alone with nine frames, inside a parent that watches keys. */
function nine(onKeyDown: () => void = () => {}) {
  const frames = Array.from({ length: 9 }, (_, i) => ({ title: `F${i + 1}`, kind: "flow" as const }));
  const view = standalone({ selected: [], sketches: [], frames, onKeyDown });
  return view;
}

test("the_cap_note_shows_as_a_status_and_clears_on_typing", async () => {
  nine();
  await screen.findByRole("textbox", { name: "Describe a change" });
  for (let i = 1; i <= 9; i++) {
    typeIn(`/F${i}`);
    fireEvent.keyDown(box(), { key: "Enter" });
  }
  expect(chipNames()).toHaveLength(8);
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("A question holds at most 8 references.");
  typeIn("a");
  expect(screen.queryByRole("status")).toBeNull();
});

test("escape_closes_the_slash_list_and_stops_there", async () => {
  const outer = vi.fn();
  nine(outer);
  await screen.findByRole("textbox", { name: "Describe a change" });
  typeIn("/F");
  fireEvent.keyDown(box(), { key: "Escape" });
  expect(screen.queryByRole("listbox", { name: "Diagrams on this board" })).toBeNull();
  expect(outer).not.toHaveBeenCalled();
  // With no list open Escape goes on to the pane as before.
  fireEvent.keyDown(box(), { key: "Escape" });
  expect(outer).toHaveBeenCalledTimes(1);
});
