// The board assistant on a three-frame board: the request carries the board, its focus and the
// chat thread; a follow-up question waits with the text free, and Continue sends the reply; Cancel sends nothing; a tab
// closed mid-Ask lands nothing; a proposal across frames lands as one undo, behind the remove question and Auto-apply's
// checks, and a text changed while it waits makes it stale.
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { withTurn } from "../../api/client";
import type { AiEvent, AiThread, AppendTurn, DiagramAskRequest, Preview, ProposedChange } from "../../api/types";
import type { DiagramCanvasProps } from "../../diagram/DiagramCanvas";
import { LangClient } from "../../lang/client";
import { done, failed, sent, step } from "../../test/aiStream";
import { turnViewOf } from "../../test/aiThreads";
import { mockEditorDom } from "../../test/editor";
import { callsTo, routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import { GROQ } from "../../test/settingsRoutes";
import { boardFrameId, clashInFrameId, FRAME_TAB_H, type FrameBox, inFrameId } from "../board/boardScene";
import FlowTab from "../FlowTab";
import { flowEntry } from "../flowRegistry";
import type { FlowDocApi } from "../useFlowDoc";
import flowTabCss from "../../styles/flow-tab.css?raw";
import { AIRING_MS, BLANK_REPLY, BOARD_UNREAD, type BoardAsk, isLeftToAi, LEFT_TO_AI } from "./useBoardAsk";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

// The real canvas draws; the test keeps its latest props and its React Flow instance, to watch the view move.
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

/** The hook as FlowTab last rendered it, and the doc it was given. */
const hooked = vi.hoisted(() => ({ ai: null as BoardAsk | null, doc: null as FlowDocApi | null }));
vi.mock("./useBoardAsk", async (load) => {
  const real = await load<typeof import("./useBoardAsk")>();
  return {
    ...real,
    useBoardAsk: (...a: Parameters<typeof real.useBoardAsk>) => {
      const r = real.useBoardAsk(...a);
      hooked.ai = r;
      hooked.doc = a[1];
      return r;
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
  "  total int",
  "}",
  "",
  'diagram flow "Refund"',
  "Ask",
  "Refund it",
  "Ask > Refund it",
  "",
].join("\n");

type Sink = { onmessage: (e: AiEvent) => void };
let threads: AiThread[] = [];
let replies: AiEvent[][] = [];
let holdAsk = false;
const sinks: Sink[] = [];
/** While set, saving a turn waits for it. */
let saveGate: Promise<void> | null = null;
/** Reduced motion is on, as Windows' "Animation effects" off. */
let reduce = true;

const PREVIEW: Preview = { items: [], tables: { full: [], namesOnly: [], leftOut: [], reasons: [] }, totalBytes: 0, tokens: 0, exact: "", notes: [], log: [], context: null, rows: null };

beforeEach(() => {
  localStorage.clear();
  reduce = true;
  canvas.props = null;
  canvas.instance = null;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  threads = [];
  replies = [];
  holdAsk = false;
  saveGate = null;
  sinks.length = 0;
  hooked.ai = null;
  hooked.doc = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup() {
  return setupWith(BOARD);
}

/** The tab on a board holding `text`. */
function setupWith(text: string) {
  routeInvoke({
    read_diagram: () => ({ text, layout: null }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    list_ai_threads: (a) => threads.filter((t) => t.place === a.place).map((t) => ({ id: t.id, place: t.place, title: t.title, updatedAt: t.updatedAt, messages: t.messages.length, topics: 0 })),
    get_ai_thread: (a) => {
      const t = threads.find((x) => x.id === a.threadId);
      return t ? { thread: t, topics: [], compactions: [] } : null;
    },
    ai_append_turn: async (a) => {
      if (saveGate) await saveGate;
      const turn = a.turn as AppendTurn;
      const before = threads.find((x) => x.id === turn.threadId) ?? null;
      const v = turnViewOf(turn, before);
      const t = withTurn(before, v);
      threads = [...threads.filter((x) => x.id !== t.id), t];
      return v;
    },
    save_ai_thread: (a) => {
      const t = a.thread as AiThread;
      threads = [...threads.filter((x) => x.id !== t.id), t];
      return { thread: t, topics: [], compactions: [] };
    },
    ai_known_models: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    ai_settings: () => ({ settings: { ...GROQ, diagramTool: true }, groupOverride: false, keySaved: true, keyLast4: "abcd" }),
    ai_diagram_preview: () => PREVIEW,
    ai_diagram_ask: (a) => {
      const sink = a.events as Sink;
      sinks.push(sink);
      if (holdAsk) return null;
      const events = replies.shift() ?? [];
      setTimeout(() => events.forEach((e) => sink.onmessage(e)), 0);
      return null;
    },
    ai_cancel_place: () => true,
    ai_record_tool_result: (a) => a.outcome,
    ai_clear_attachment: () => null,
  });
  const client = new LangClient(() => fakeWorker());
  const utils = render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>,
  );
  const view = () => EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  /** Opens another diagram in the same tab. */
  const switchTo = (other: string) =>
    utils.rerender(
      <div style={{ width: 1280, height: 800 }}>
        <FlowTab name={other} client={client} />
      </div>,
    );
  return { ...utils, view, switchTo, text: () => view().state.doc.toString() };
}

/** The board is parsed into its three frames. */
async function parsed() {
  await waitFor(() => expect(hooked.doc?.parsed?.result.frames.map((f) => f.title)).toEqual(["Checkout", "Orders ERD", "Refund"]), { timeout: 4000 });
}

const asks = () => callsTo("ai_diagram_ask").map((c) => c.request as DiagramAskRequest);
const appended = () => callsTo("ai_append_turn").map((c) => c.turn as AppendTurn);
const ai = () => hooked.ai!;

/** Opens the Assistant and sends `q` with Enter; waits for the Ask to reach the Core. */
async function send(q: string) {
  const before = asks().length;
  fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
  const box = screen.getByRole("textbox", { name: "Describe a change" });
  fireEvent.change(box, { target: { value: q } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(asks().length).toBe(before + 1));
}

/** The answer has ended and nothing runs. */
async function idle() {
  await waitFor(() => expect(ai().working).toBeNull());
}

const followUp = (question: string): AiEvent[] => [sent(), { type: "followUp", question } as AiEvent, done()];
const answered = (text: string): AiEvent[] => [sent(), { type: "delta", text }, done()];

test("send_carries_the_board_focus_and_thread", async () => {
  setup();
  await parsed();
  act(() => hooked.doc!.select({ title: "Orders ERD", index: 1 }));
  replies = [answered("It has one table."), answered("It has two columns.")];
  await send("What is in this diagram?");
  await idle();
  const r = asks()[0];
  expect(r.question).toBe("What is in this diagram?");
  // The board, every frame by its slice of the text sent.
  expect(r.board!.frames.map((f) => [f.title, f.kind])).toEqual([
    ["Checkout", "flow"],
    ["Orders ERD", "er"],
    ["Refund", "flow"],
  ]);
  for (const f of r.board!.frames) expect(r.text.slice(f.from, f.to)).toContain(`"${f.title}"`);
  expect(r.board!.frames[1].outline.nodes.map((n) => n.name)).toEqual(["orders"]);
  // The selected frame is the focus and the selection; the AI still reads the whole board.
  expect(r.board!.focus).toEqual(["Orders ERD"]);
  expect(r.board!.selected).toEqual({ frame: "Orders ERD", shapes: [], sketches: [] });
  expect(r.scope).toEqual({ kind: "whole" });
  expect(r.board!.followUp).toBeNull();
  expect(r.board!.create).toBeNull();
  expect(r.board!.attachment).toBeNull();
  // The selected frame's outline, as before.
  expect(r.outline.nodes.map((n) => n.name)).toEqual(["orders"]);
  // A new chat names no thread; the next Ask names the one the first started.
  expect(r.threadId).toBeNull();
  await send("And the columns?");
  await idle();
  const id = threads.find((t) => t.place === "diagram:board")!.id;
  expect(asks()[1].threadId).toBe(id);
  // The Sends preview reads the same board and thread.
  await waitFor(() => expect(callsTo("ai_diagram_preview").some((c) => (c.request as DiagramAskRequest).threadId === id)).toBe(true));
  const p = callsTo("ai_diagram_preview").map((c) => c.request as DiagramAskRequest).find((x) => x.threadId === id)!;
  expect(p.board!.frames).toHaveLength(3);
  expect(p.board!.focus).toEqual(["Orders ERD"]);
});

test("a_follow_up_waits_with_the_text_free_and_sends_the_reply", async () => {
  const s = setup();
  await parsed();
  replies = [followUp("Which table should get the column?"), answered("Added it.")];
  await send("Add a status column");
  await waitFor(() => expect(ai().asking).not.toBeNull());
  expect(ai().asking).toMatchObject({ q: "Add a status column", question: "Which table should get the column?" });
  // The card waits with the text free to type in and nothing to review.
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  expect(ai().waiting).toBeNull();
  expect(ai().locked).toBe(false);
  // The answer turn is saved with the question as its text.
  const thread = threads.find((t) => t.place === "diagram:board")!;
  expect(thread.messages.map((m) => [m.role, m.text])).toEqual([
    ["user", "Add a status column"],
    ["assistant", "Which table should get the column?"],
  ]);
  await act(async () => {
    await ai().answer("orders");
  });
  // The original question goes again, with the reply, in the same chat.
  const r = asks()[1];
  expect(r.question).toBe("Add a status column");
  expect(r.board!.followUp).toEqual({ asked: "Which table should get the column?", reply: "orders" });
  expect(r.threadId).toBe(thread.id);
  expect(r.board!.frames).toHaveLength(3);
  await idle();
  expect(ai().asking).toBeNull();
});

test("the_follow_up_card_is_scrolled_into_view_when_it_arrives", async () => {
  // Live check L1: the card arrives at the chat's end. The chat scrolls so the card's top (its question) is at the
  // chat's top, or as near as the chat's end allows, so a card taller than the chat still shows its question; nothing
  // pulls the chat to its end past it afterwards. Only the chat scrolls, never the panes around it.
  const sets: number[] = [];
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const top = this.classList.contains("followup") ? 700 : this.getAttribute("role") === "log" ? 100 : 0;
    return { x: 0, y: top, top, left: 0, right: 0, bottom: top, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  };
  const into: Element[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    into.push(this);
  };
  try {
    setup();
    await parsed();
    fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
    const log = screen.getByRole("log", { name: "Assistant conversation" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => 900 });
    Object.defineProperty(log, "scrollTop", { configurable: true, get: () => 40, set: (v: number) => sets.push(v) });
    replies = [followUp("Which table should get the column?")];
    await send("Add a status column");
    const card = await screen.findByRole("group", { name: "Which table should get the column?" });
    expect(card.classList.contains("followup")).toBe(true);
    // 40 scrolled, plus the card's 600 px below the chat's top.
    await waitFor(() => expect(sets).toContain(640));
    await new Promise((r) => setTimeout(r, 20));
    expect(sets[sets.length - 1]).toBe(640);
    expect(into.filter((el) => card.contains(el))).toEqual([]);
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
    if (original) Element.prototype.scrollIntoView = original;
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

test("continue_saves_only_the_reply_as_a_user_turn", async () => {
  setup();
  await parsed();
  replies = [followUp("Which table?"), answered("Added status to orders.")];
  await send("Add a status column");
  await waitFor(() => expect(ai().asking).not.toBeNull());
  await act(async () => {
    await ai().answer("orders");
  });
  await idle();
  await waitFor(() => expect(appended()).toHaveLength(2));
  // The second turn holds the reply as its user turn, not the question again.
  expect(appended()[1].messages.map((m) => [m.role, m.text])).toEqual([
    ["user", "orders"],
    ["assistant", "Added status to orders."],
  ]);
  const thread = threads.find((t) => t.place === "diagram:board")!;
  expect(thread.messages.map((m) => [m.role, m.text])).toEqual([
    ["user", "Add a status column"],
    ["assistant", "Which table?"],
    ["user", "orders"],
    ["assistant", "Added status to orders."],
  ]);
  // The question is in the thread once.
  expect(thread.messages.filter((m) => m.text === "Add a status column")).toHaveLength(1);
  // Both answers keep what was sent (history saved before the board Ask reads it).
  for (const m of thread.messages.filter((x) => x.role === "assistant")) expect(m.record?.sent).toBeTruthy();
  // The hook's own copy holds the same four turns.
  expect(ai().thread!.messages.map((m) => m.text)).toEqual(["Add a status column", "Which table?", "orders", "Added status to orders."]);
});

test("cancel_on_a_follow_up_sends_nothing", async () => {
  const s = setup();
  await parsed();
  replies = [followUp("Which table?")];
  await send("Add a status column");
  await waitFor(() => expect(ai().asking).not.toBeNull());
  const turns = appended().length;
  act(() => ai().cancelAsk());
  expect(ai().asking).toBeNull();
  await new Promise((r) => setTimeout(r, 20));
  expect(asks()).toHaveLength(1);
  // Cancel saves nothing more.
  expect(appended()).toHaveLength(turns);
  expect(callsTo("save_ai_thread")).toHaveLength(0);
  expect(s.view().state.readOnly).toBe(false);
  // Continue after Cancel does nothing either.
  await act(async () => {
    await ai().answer("orders");
  });
  expect(asks()).toHaveLength(1);
});

test("closing_the_tab_mid_ask_lands_nothing", async () => {
  const s = setup();
  await parsed();
  holdAsk = true;
  await send("Add a status column");
  s.unmount();
  // The Core still answers: a proposal and a follow-up for the closed tab.
  const proposal = { type: "proposal", proposal: { file: "board", baseHash: "b1", changes: [{ index: 0, op: { add_node: { name: "Ship", kind: null, id: null } }, status: { kind: "ok" }, dependsOn: [], frame: "Checkout" }] }, input: "{}" } as AiEvent;
  act(() => [{ type: "delta", text: "Here." } as AiEvent, proposal, { type: "followUp", question: "Which?" } as AiEvent, done()].forEach((e) => sinks[0].onmessage(e)));
  await new Promise((r) => setTimeout(r, 20));
  // Nothing saved, nothing written, and the Core was told to stop.
  expect(appended()).toHaveLength(0);
  expect(callsTo("write_diagram").some((c) => String(c.text).includes("Ship"))).toBe(false);
  await waitFor(() => expect(callsTo("ai_cancel_place")).toHaveLength(1));
});

// ----- Task 10 fix round 1: a reply is never lost.

const composer = () => screen.getByRole("textbox", { name: "Describe a change" }) as HTMLTextAreaElement;
/** The follow-up card's reply box. */
const replyBox = () => screen.getByRole("textbox", { name: "Your reply" }) as HTMLTextAreaElement;

/** Asks, gets the follow-up "Which table?", and Continues with `reply`. */
async function replyWith(reply: string, then: AiEvent[][]) {
  replies = [followUp("Which table?"), ...then];
  await send("Add a status column");
  await waitFor(() => expect(ai().asking).not.toBeNull());
  await act(async () => {
    await ai().answer(reply);
  });
}

test("a_failed_reply_stays_and_retry_sends_it_as_the_reply", async () => {
  setup();
  await parsed();
  // The reply's Ask fails before any text: nothing is kept in the thread.
  await replyWith("orders", [[failed({ kind: "network", host: "api.groq.com" })], answered("Added status to orders.")]);
  expect(await screen.findByText("Could not reach api.groq.com.")).toBeTruthy();
  // The reply is back in the card's box, not the question, and the follow-up waits again with it.
  expect(replyBox().value).toBe("orders");
  expect(composer().disabled).toBe(true);
  expect(ai().asking).toMatchObject({ q: "Add a status column", question: "Which table?", reply: "orders" });
  expect(appended()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(asks()).toHaveLength(3));
  expect(asks()[2].question).toBe("Add a status column");
  expect(asks()[2].board!.followUp).toEqual({ asked: "Which table?", reply: "orders" });
  await idle();
  await waitFor(() => expect(appended()).toHaveLength(2));
  expect(appended()[1].messages.map((m) => m.text)).toEqual(["orders", "Added status to orders."]);
  expect(ai().asking).toBeNull();
});

test("a_stopped_reply_stays", async () => {
  setup();
  await parsed();
  replies = [followUp("Which table?")];
  await send("Add a status column");
  await waitFor(() => expect(ai().asking).not.toBeNull());
  holdAsk = true;
  let pending!: Promise<unknown>;
  act(() => {
    pending = ai().answer("orders");
  });
  await waitFor(() => expect(asks()).toHaveLength(2));
  await waitFor(() => expect(ai().working).not.toBeNull());
  act(() => ai().stop());
  await act(async () => {
    await pending;
  });
  expect(ai().asking).toMatchObject({ question: "Which table?", reply: "orders" });
  await waitFor(() => expect(replyBox().value).toBe("orders"));
  expect(appended()).toHaveLength(1);
  // Continue on the card sends the reply again.
  holdAsk = false;
  replies = [answered("Added it.")];
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  await waitFor(() => expect(asks()).toHaveLength(3));
  expect(asks()[2].board!.followUp).toEqual({ asked: "Which table?", reply: "orders" });
});

test("a_reply_on_a_board_that_cannot_be_read_stays", async () => {
  setup();
  await parsed();
  replies = [followUp("Which table?")];
  await send("Add a status column");
  await waitFor(() => expect(ai().asking).not.toBeNull());
  // The worker cannot give the board's outline: the canvas read fails.
  const spy = vi.spyOn(LangClient.prototype, "boardOutline").mockRejectedValue(new Error("worker gone"));
  await act(async () => {
    await ai().answer("orders");
  });
  spy.mockRestore();
  expect(asks()).toHaveLength(1);
  // The user is told why, and the reply waits in the card's box.
  expect(await screen.findByText(BOARD_UNREAD)).toBeTruthy();
  expect(replyBox().value).toBe("orders");
  expect(ai().asking).toMatchObject({ question: "Which table?", reply: "orders" });
});

test("a_blank_reply_is_marked_left_to_the_assistant", async () => {
  setup();
  await parsed();
  await replyWith("  ", [answered("I picked orders.")]);
  // The model is told the blank as is (the Core words it); the thread says what it was told and that it was not typed.
  expect(asks()[1].board!.followUp).toEqual({ asked: "Which table?", reply: "  " });
  await idle();
  await waitFor(() => expect(appended()).toHaveLength(2));
  const turn = appended()[1].messages[0];
  expect(turn).toMatchObject({ role: "user", text: BLANK_REPLY, context: [LEFT_TO_AI] });
  expect(isLeftToAi(turn)).toBe(true);
  // A typed reply carries no marker, nor does the question.
  expect(appended()[0].messages[0].context).toEqual([]);
  expect(isLeftToAi(appended()[0].messages[0])).toBe(false);
});

test("a_send_while_the_follow_up_saves_waits_for_it", async () => {
  // Task 11 fix round 1: the run stays the Ask's until its answer is placed, so no new Ask starts under it.
  setup();
  await parsed();
  let open!: () => void;
  saveGate = new Promise<void>((r) => (open = r));
  replies = [followUp("Which table?")];
  await send("Add a status column");
  // The answer has arrived and its turn is saving: the composer stays busy until it is saved.
  await waitFor(() => expect(appended()).toHaveLength(1));
  expect(ai().working).not.toBeNull();
  expect(ai().asking).toBeNull();
  // A send in that window (straight on the hook, as the composer is busy) starts nothing.
  await act(async () => {
    await ai().send("Something else", { model: null, picks: null, focus: [], create: null, attachment: null });
  });
  expect(asks()).toHaveLength(1);
  // The save ends: the follow-up waits, and the text is free.
  saveGate = null;
  await act(async () => {
    open();
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(ai().working).toBeNull();
  expect(ai().asking).toMatchObject({ question: "Which table?" });
  expect(flowEntry("board")?.isHeld?.()).toBe(false);
});

// ----- Task 11: the review across frames, the safeguards and one-undo landing on the real tab.

const okIn = (frame: string, index: number, op: ProposedChange["op"], dependsOn: number[] = []): ProposedChange => ({ index, op, status: { kind: "ok" }, dependsOn, frame });
const proposing = (changes: ProposedChange[]): AiEvent[] => [sent(), { type: "delta", text: "Here." }, { type: "proposal", proposal: { file: "board", baseHash: "b1", changes }, input: "{}" } as AiEvent, done()];
const undoOnce = (s: ReturnType<typeof setup>) => act(() => void undo(s.view()));
const redoOnce = (s: ReturnType<typeof setup>) => act(() => void redo(s.view()));

/** Turns Auto-apply on in the Assistant pane. */
function autoApply() {
  fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Auto-apply" }));
}

/** A change Auto-apply refuses: Refund gains a shape of a kind a flowchart does not have. */
const BREAKS_REFUND = [okIn("Checkout", 0, { add_node: { name: "Ship" } }), okIn("Refund", 1, { add_node: { name: "Refunded", kind: "bogus" } })];

test("accept_all_lands_both_in_one_undo", async () => {
  const s = setup();
  await parsed();
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  replies = [proposing([okIn("Checkout", 0, { add_node: { name: "Ship" } }), okIn("Refund", 1, { add_node: { name: "Refunded" } }), okIn("Refund", 2, { add_flow: { from: "Ask", to: "Refunded" } }, [1])])];
  await send("Add shipping and a refunded state");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  expect([...ai().review!.keys()]).toEqual(["Checkout", "Refund"]);
  // The selected frame's AI Chat counts its own change, not the board's three.
  await waitFor(() => expect(s.container.querySelector(".board-frame.is-selected .board-frame-pending")?.textContent).toBe("1"));
  act(() => ai().acceptAll());
  expect(ai().waiting).toBeNull();
  expect(s.text()).toContain("Ship");
  expect(s.text()).toContain("Ask > Refunded");
  // One undo takes back both frames' changes.
  undoOnce(s);
  expect(s.text()).toBe(BOARD);
});

test("auto_apply_refuses_a_change_that_breaks_another_frame", async () => {
  const s = setup();
  await parsed();
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  autoApply();
  replies = [proposing(BREAKS_REFUND)];
  await send("Add shipping and a refunded state");
  await waitFor(() => expect(ai().waiting?.step).toBe("broken"));
  // Nothing landed, and the broken card names the frame and the line within it.
  expect(s.text()).toBe(BOARD);
  expect(ai().waiting!.broke).toMatchObject({ frame: "Refund", lineText: expect.stringContaining("Refunded [bogus]") });
  const card = (await screen.findByText("Not applied: the text would have a problem")).closest(".ccard")!;
  expect(card.textContent).toMatch(/With these changes, line \d+ of Refund would read Refunded \[bogus\]/);
  // The hold is let go while the card waits.
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
});

test("auto_apply_with_a_new_frame_and_removals_asks_then_undoes_in_one", async () => {
  const s = setup();
  await parsed();
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  autoApply();
  replies = [
    proposing([
      { index: 0, op: { add_frame: { title: "Shipping", kind: "flow" } }, status: { kind: "ok" }, dependsOn: [] },
      okIn("Shipping", 1, { add_node: { name: "Ship" } }, [0]),
      okIn("Checkout", 2, { remove_node: { target: "Cart" } }),
      okIn("Checkout", 3, { remove_node: { target: "Pay" } }),
      okIn("Refund", 4, { remove_node: { target: "Ask" } }),
      okIn("Refund", 5, { remove_node: { target: "Refund it" } }),
    ]),
  ];
  await send("Move shipping into its own diagram");
  // Four removals in two frames: the question comes first, even with Auto-apply on.
  await waitFor(() => expect(ai().waiting?.step).toBe("remove"));
  expect(s.text()).toBe(BOARD);
  expect(ai().removal).toMatchObject({ shapes: ["Cart", "Pay", "Ask", "Refund it"], frames: ["Checkout", "Refund"] });
  const at = ai().proposedAt.get("Shipping");
  expect(at).toBeTruthy();
  act(() => ai().removeAll());
  const landed = s.text();
  expect(landed).toContain('diagram flow "Shipping"');
  expect(landed).not.toContain("Cart");
  expect(landed).not.toContain("Refund it");
  // The new frame is where the review showed it.
  await waitFor(() => expect(hooked.doc!.board.frames.get("Shipping")?.at).toEqual(at));
  // One undo takes back the new frame with its place and the removals; redo puts both back.
  undoOnce(s);
  expect(s.text()).toBe(BOARD);
  await waitFor(() => expect(hooked.doc!.board.frames.has("Shipping")).toBe(false));
  redoOnce(s);
  expect(s.text()).toBe(landed);
  await waitFor(() => expect(hooked.doc!.board.frames.get("Shipping")?.at).toEqual(at));
});

test("a_change_anywhere_on_the_board_makes_the_proposal_stale", async () => {
  const s = setup();
  await parsed();
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  autoApply();
  // Only Refund is touched, and it would break.
  replies = [proposing(BREAKS_REFUND.slice(1))];
  await send("Add a refunded state");
  await waitFor(() => expect(ai().waiting?.step).toBe("broken"));
  await waitFor(() => expect(s.view().state.readOnly).toBe(false));
  // The user types in the selected frame, which the proposal does not touch.
  const at = BOARD.indexOf("Cart > Pay");
  act(() => s.view().dispatch({ changes: { from: at, insert: "Wrap\n" }, userEvent: "input.type" }));
  const typed = s.text();
  await waitFor(() => expect(hooked.doc!.parsed?.text).toBe(typed));
  // Review each change, then Accept: nothing lands, and the stale card says why.
  fireEvent.click(screen.getByRole("button", { name: "Review the changes" }));
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  act(() => ai().acceptAll());
  expect(ai().waiting?.step).toBe("stale");
  expect(typed).toContain("Wrap");
  expect(s.text()).toBe(typed);
  expect(await screen.findByText("board changed while I worked")).toBeTruthy();
});

test("the_live_er_card_scrolls_to_its_first_changed_row", async () => {
  // An ERD past 20 columns, selected (live): the change to its 23rd column scrolls the card to it.
  const columns = Array.from({ length: 25 }, (_, i) => `  c${i} text`);
  const er = ['diagram er "Orders ERD"', "orders {", ...columns, "}", "", 'diagram flow "Refund"', "Ask", ""].join("\n");
  const s = setupWith(er);
  await waitFor(() => expect(hooked.doc?.parsed?.result.frames.map((f) => f.title)).toEqual(["Orders ERD", "Refund"]), { timeout: 4000 });
  act(() => hooked.doc!.select({ title: "Orders ERD", index: 0 }));
  await waitFor(() => expect(s.container.querySelector(".fkind-er-body")).toBeTruthy());
  const body = s.container.querySelector(".fkind-er-body") as HTMLElement;
  expect(body.scrollTop).toBe(0);
  replies = [proposing([okIn("Orders ERD", 0, { set_column: { table: "orders", column: "c22", type: "bigint" } })])];
  await send("Make c22 a bigint");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  // The live card marks the row and scrolls it into view.
  await waitFor(() => expect((s.container.querySelector(".fkind-er-body") as HTMLElement).scrollTop).toBeGreaterThan(0));
  // jsdom fires no scroll event on a scrollTop write: the browser's event draws the rows now in view.
  fireEvent.scroll(s.container.querySelector(".fkind-er-body")!);
  await waitFor(() => expect(s.container.querySelector(".fkind-er-body .is-ai-changed")?.textContent).toContain("c22"));
});

test("a_send_while_a_proposal_is_placed_leaves_no_hold_and_saving_goes_on", async () => {
  // Task 11 fix round 1: a send in the gap between the answer and its proposal starts nothing; the proposal is placed,
  // every hold is let go, and autosave writes again.
  const s = setup();
  await parsed();
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  let open!: () => void;
  saveGate = new Promise<void>((r) => (open = r));
  replies = [proposing([{ index: 0, op: { add_frame: { title: "Shipping", kind: "flow" } }, status: { kind: "ok" }, dependsOn: [] }, okIn("Shipping", 1, { add_node: { name: "Ship" } }, [0])])];
  await send("Add a shipping diagram");
  await waitFor(() => expect(appended()).toHaveLength(1));
  expect(ai().working).not.toBeNull();
  await act(async () => {
    await ai().send("Something else", { model: null, picks: null, focus: [], create: null, attachment: null });
  });
  expect(asks()).toHaveLength(1);
  saveGate = null;
  await act(async () => {
    open();
  });
  // A's proposal is up for review, not dropped.
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  expect(ai().working).toBeNull();
  act(() => ai().rejectAll());
  expect(flowEntry("board")?.isHeld?.()).toBe(false);
  // Autosave writes the next edit.
  const writes = callsTo("write_diagram").length;
  act(() => s.view().dispatch({ changes: { from: BOARD.indexOf("Cart > Pay"), insert: "Wrap\n" }, userEvent: "input.type" }));
  await waitFor(() => expect(callsTo("write_diagram").length).toBeGreaterThan(writes), { timeout: 4000 });
  const written = callsTo("write_diagram");
  expect(String(written[written.length - 1].text)).toContain("Wrap");
});

// ----- Task 12: the view glides to the change, landed shapes flash in every frame, and a trimmed board is said so.

/** The nodes the canvas draws now, by id. */
const drawn = () => new Map((canvas.props?.nodes ?? []).map((n: Node) => [n.id, n]));
/** Sets up the board and waits for the canvas to be ready; `fit` watches the view move. */
async function drawnBoard(text = BOARD, titles = ["Checkout", "Orders ERD", "Refund"]) {
  const s = setupWith(text);
  await waitFor(() => expect(hooked.doc?.parsed?.result.frames.map((f) => f.title)).toEqual(titles), { timeout: 4000 });
  await waitFor(() => expect(canvas.instance).not.toBeNull());
  const fit = vi.spyOn(canvas.instance!, "fitBounds").mockResolvedValue(true);
  return { s, fit };
}
type Bounds = { x: number; y: number; width: number; height: number };
const boundsOf = (fit: { mock: { calls: unknown[][] } }, call = -1): Bounds => fit.mock.calls[call < 0 ? fit.mock.calls.length + call : call][0] as Bounds;
/** Frame `key`'s box as the canvas draws it. */
const frameBoxOf = (key: string): FrameBox => (drawn().get(boardFrameId(key))?.data as { box: FrameBox }).box;
const covers = (b: Bounds, r: { x: number; y: number; w: number; h: number }) => b.x <= r.x && b.y <= r.y - FRAME_TAB_H + 0.001 && b.x + b.width >= r.x + r.w && b.y + b.height >= r.y + r.h;

test("a_proposal_glides_to_its_frames", async () => {
  reduce = false;
  const { fit } = await drawnBoard();
  // The frames as they are before the review draws its shapes in them.
  const sent = ["Checkout", "Refund"].map(frameBoxOf);
  replies = [proposing([okIn("Checkout", 0, { add_node: { name: "Ship" } }), okIn("Refund", 1, { add_node: { name: "Refunded" } })])];
  await send("Add shipping and a refunded state");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  // The view fits the two frames the changes are in, with their tabs, over the fit motion.
  await waitFor(() => expect(fit).toHaveBeenCalled());
  expect(fit).toHaveBeenCalledTimes(1);
  const b = boundsOf(fit);
  // The whole of each frame, its tab too (Task 12 parked item, closed in the final fixes).
  for (const box of sent) expect(covers(b, box)).toBe(true);
  expect(fit.mock.calls[0][1]).toMatchObject({ duration: 240 });
});

test("auto_apply_lands_flashes_every_frame_and_one_undo_takes_it_back", async () => {
  const { s, fit } = await drawnBoard();
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  autoApply();
  fit.mockClear();
  const sent = ["Checkout", "Refund"].map(frameBoxOf);
  replies = [proposing([okIn("Checkout", 0, { add_node: { name: "Ship" } }), okIn("Refund", 1, { add_node: { name: "Refunded" } })])];
  await send("Add shipping and a refunded state");
  await waitFor(() => expect(s.text()).toContain("Refunded"));
  // Two glides to the same two frames (Task 12 review: the double glide is kept): the proposal's on arrival, then
  // the landing's. Auto-apply lands in the tick the proposal arrives, so the first fits the frames as they stood.
  await waitFor(() => expect(fit).toHaveBeenCalledTimes(2));
  for (const call of [0, 1]) for (const box of sent) expect(covers(boundsOf(fit, call), box)).toBe(true);
  // Live check L2: the landing's glide waits for the landed shapes' places and fits the frames grown to hold them.
  await waitFor(() => expect(drawn().has("Ship") && drawn().has(inFrameId("Refund", "Refunded"))).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
  expect(fit).toHaveBeenCalledTimes(2);
  for (const key of ["Checkout", "Refund"]) expect(covers(boundsOf(fit, 1), frameBoxOf(key))).toBe(true);
  for (const id of ["Ship", inFrameId("Refund", "Refunded")]) expect(holds(boundsOf(fit, 1), nodeBox(id))).toBe(true);
  // Each frame flashes what landed in it, by the frame's layout key.
  expect([...ai().airing].map(([k, names]) => [k, [...names]])).toEqual([
    ["Checkout", ["Ship"]],
    ["Refund", ["Refunded"]],
  ]);
  // The live frame's shape and the static frame's shape both carry the flash.
  await waitFor(() => expect((drawn().get("Ship")?.data as { state?: string } | undefined)?.state).toBe("airing"));
  expect((drawn().get(inFrameId("Refund", "Refunded"))?.data as { state?: string } | undefined)?.state).toBe("airing");
  expect((drawn().get(inFrameId("Refund", "Ask"))?.data as { state?: string } | undefined)?.state).toBeUndefined();
  // One undo takes the landing and its flash back.
  undoOnce(s);
  expect(s.text()).toBe(BOARD);
  expect(ai().airing.size).toBe(0);
  await waitFor(() => expect(drawn().has(inFrameId("Refund", "Refunded"))).toBe(false));
});

/** Node `id`'s box on the canvas, its frame's place added (a static frame's shapes are its children). */
function nodeBox(id: string): { x: number; y: number; w: number; h: number } {
  const nodes = drawn();
  const n = nodes.get(id)!;
  let x = n.position.x;
  let y = n.position.y;
  for (let p = n.parentId ? nodes.get(n.parentId) : undefined; p; p = p.parentId ? nodes.get(p.parentId) : undefined) {
    x += p.position.x;
    y += p.position.y;
  }
  return { x, y, w: n.width ?? n.initialWidth ?? 0, h: n.height ?? n.initialHeight ?? 0 };
}
/** `covers` for a shape: no tab above it. */
const holds = (b: Bounds, r: { x: number; y: number; w: number; h: number }) => b.x <= r.x && b.y <= r.y && b.x + b.width >= r.x + r.w && b.y + b.height >= r.y + r.h;

test("the_glides_fit_the_frames_with_the_parts_placed_in_them", async () => {
  // Live check L2 (spec "never unseen"): the glides fitted the frames at their size before the canvas grew them for
  // the new parts, so a part placed at a frame's growing edge landed off screen. On arrival the glide fits the frames
  // with the review's shapes drawn in them; on landing, with the landed shapes in place. One glide each.
  reduce = false;
  const { fit } = await drawnBoard();
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  const before = ["Checkout", "Refund"].map(frameBoxOf);
  replies = [proposing([okIn("Checkout", 0, { add_node: { name: "Ship" } }), okIn("Checkout", 1, { add_flow: { from: "Pay", to: "Ship" } }, [0]), okIn("Refund", 2, { add_node: { name: "Refunded" } })])];
  await send("Add shipping and a refunded state");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  await waitFor(() => expect(fit).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50));
  expect(fit).toHaveBeenCalledTimes(1);
  const arrived = boundsOf(fit);
  // The review drew its shapes: the live frame grew to hold Ship, and the glide holds it whole.
  const grown = ["Checkout", "Refund"].map(frameBoxOf);
  expect(grown[0].h).toBeGreaterThan(before[0].h);
  for (const box of [...before, ...grown]) expect(covers(arrived, box)).toBe(true);
  for (const id of ["Ship", inFrameId("Refund", "Refunded")]) expect(holds(arrived, nodeBox(id))).toBe(true);
  expect(fit.mock.calls[0][1]).toMatchObject({ duration: 240 });
});

test("the_landing_glide_fits_the_frame_after_it_grows", async () => {
  // Live check L2: a landing in a frame that is not selected. The frame is laid out again once the landed text is
  // parsed, and grows for the new shape; the glide waits for that and fits the grown frame, with the new shape in it.
  reduce = false;
  const { fit } = await drawnBoard();
  const before = frameBoxOf("Refund");
  replies = [proposing([okIn("Refund", 0, { add_node: { name: "Refunded" } }), okIn("Refund", 1, { add_flow: { from: "Ask", to: "Refunded" } }, [0])])];
  await send("Add a refunded state");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  await waitFor(() => expect(fit).toHaveBeenCalled());
  fit.mockClear();
  act(() => ai().acceptAll());
  await waitFor(() => expect(hooked.doc?.parsed?.text).toContain("Refunded"));
  await waitFor(() => expect(fit).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50));
  // One glide for the landing, made once the shape has its place.
  expect(fit).toHaveBeenCalledTimes(1);
  const landed = boundsOf(fit);
  const after = frameBoxOf("Refund");
  expect(after.y + after.h).toBeGreaterThan(before.y + before.h);
  expect(covers(landed, after)).toBe(true);
  expect(holds(landed, nodeBox(inFrameId("Refund", "Refunded")))).toBe(true);
  expect(fit.mock.calls[0][1]).toMatchObject({ duration: 240 });
});

test("reduced_motion_jumps_to_the_change_and_rings_without_fading", async () => {
  const { fit } = await drawnBoard();
  replies = [proposing([{ index: 0, op: { add_frame: { title: "Shipping", kind: "flow" } }, status: { kind: "ok" }, dependsOn: [] }, okIn("Shipping", 1, { add_node: { name: "Ship" } }, [0]), okIn("Refund", 2, { add_node: { name: "Refunded" } })])];
  await send("Add a shipping diagram and a refunded state");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  const box = ai().waiting!.newFrames!.boxes[0];
  // The proposal's own glide already takes in the frame it adds, at its proposed place.
  await waitFor(() => expect(fit).toHaveBeenCalled());
  expect(covers(boundsOf(fit), box)).toBe(true);
  fit.mockClear();
  act(() => ai().acceptAll());
  await waitFor(() => expect(fit).toHaveBeenCalled());
  // The jump has no duration, and its bounds hold the landed frame and the touched one.
  expect(fit.mock.calls[fit.mock.calls.length - 1][1]).toMatchObject({ duration: 0 });
  const b = boundsOf(fit);
  expect(covers(b, box)).toBe(true);
  expect(b.x).toBeLessThanOrEqual(hooked.doc!.board.frames.get("Refund")!.at.x);
  // The flash is the ring alone: the shapes are keyed, and nothing animates under reduced motion.
  expect([...ai().airing.keys()].sort()).toEqual(["Refund", "Shipping"]);
  expect([...ai().airing.get("Shipping")!]).toEqual(["Ship"]);
  await waitFor(() => expect((drawn().get(inFrameId("Refund", "Refunded"))?.data as { state?: string } | undefined)?.state).toBe("airing"));
  // The ringed shape's fade is off under the system's and the app's reduced motion; the ring itself stays.
  expect(flowTabCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*?\.flow-canvas \.fnode-airing,[^}]*animation: none;/);
  expect(flowTabCss).toMatch(/:root\[data-reduced-motion\] \.flow-canvas \.fnode-airing,[^}]*animation: none;/);
  expect(flowTabCss).toMatch(/\.flow-canvas \.fnode-airing,[^{]*\{[^}]*outline: 2px solid var\(--c-accent\);[^}]*animation: ai-fade/);
});

test("a_new_proposal_clears_the_last_landings_ring", async () => {
  // Task 12 parked item: the last landing's ring does not keep fading over the next proposal's review marks.
  await drawnBoard();
  act(() => hooked.doc!.select({ title: "Checkout", index: 0 }));
  replies = [proposing([okIn("Checkout", 0, { add_node: { name: "Ship" } })])];
  await send("Add shipping");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  act(() => ai().acceptAll());
  await waitFor(() => expect(ai().airing.size).toBe(1));
  replies = [proposing([okIn("Refund", 0, { add_node: { name: "Refunded" } })])];
  await send("Add a refunded state");
  await waitFor(() => expect(ai().waiting?.step).toBe("review"));
  expect(ai().airing.size).toBe(0);
  expect((drawn().get("Ship")?.data as { state?: string } | undefined)?.state).not.toBe("airing");
});

test("airing_uses_layout_keys_for_clashing_titles", async () => {
  // Two frames called Checkout: the first is the proposal's target; the second is drawn faded and never flashes.
  const clash = ['diagram flow "Checkout"', "Cart", "", 'diagram flow "Checkout"', "Cart", "Extra", ""].join("\n");
  const { s } = await drawnBoard(clash, ["Checkout", "Checkout"]);
  expect(hooked.doc!.parsed!.keys[0]).toBe("Checkout");
  expect(hooked.doc!.parsed!.keys[1]).not.toBe("Checkout");
  autoApply();
  replies = [proposing([okIn("Checkout", 0, { add_node: { name: "Extra" } })])];
  await send("Add Extra");
  await waitFor(() => expect(s.text().split("Extra").length).toBe(3));
  expect([...ai().airing.keys()]).toEqual(["Checkout"]);
  await waitFor(() => expect((drawn().get(inFrameId("Checkout", "Extra"))?.data as { state?: string } | undefined)?.state).toBe("airing"));
  // The clashing frame has a shape of the same name, and it does not flash.
  const other = drawn().get(clashInFrameId(1, "Extra"));
  expect(other).toBeTruthy();
  expect((other!.data as { state?: string }).state).toBeUndefined();
});

test("a_trimmed_board_says_so_under_the_answer", async () => {
  setup();
  await parsed();
  replies = [[sent(), step("boardContext", "1 in full, 3 as names, 1 left out"), { type: "delta", text: "It has one table." }, done()], [sent(), step("boardContext", "3 in full, 0 as names, 0 left out"), { type: "delta", text: "Fine." }, done()], [sent(), step("boardContext", "2 in full, 0 as names, 1 left out"), { type: "delta", text: "Two." }, done()]];
  await send("What is in this diagram?");
  await idle();
  expect(await screen.findByText("3 diagrams were sent as names only and 1 was left out. Sends lists them.")).toBeTruthy();
  // A board sent whole says nothing.
  await send("And now?");
  await idle();
  await waitFor(() => expect(screen.getByText("Fine.")).toBeTruthy());
  expect(screen.getAllByText(/Sends lists them/)).toHaveLength(1);
  await send("And again?");
  await idle();
  expect(await screen.findByText("1 diagram was left out. Sends lists it.")).toBeTruthy();
});

// ----- Task 16: the follow-up card in the chat.

test("the_card_sits_under_the_question_and_the_composer_waits", async () => {
  setup();
  await parsed();
  replies = [followUp("Which table?"), answered("Added it.")];
  await send("Add a status column");
  const card = await screen.findByRole("group", { name: "Which table?" });
  // The question is in the chat once (the card shows it), the cursor is in the reply, and typing below waits.
  expect(screen.getAllByText("Which table?")).toHaveLength(1);
  expect(card.contains(replyBox())).toBe(true);
  expect(document.activeElement).toBe(replyBox());
  expect(composer().disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  // Continue sends the reply, in the same chat; the card goes and the question stays in the history, once.
  fireEvent.change(replyBox(), { target: { value: "orders" } });
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  await waitFor(() => expect(asks()).toHaveLength(2));
  expect(asks()[1].board!.followUp).toEqual({ asked: "Which table?", reply: "orders" });
  await idle();
  await waitFor(() => expect(screen.queryByRole("group", { name: "Which table?" })).toBeNull());
  expect(screen.getAllByText("Which table?")).toHaveLength(1);
  expect(within(screen.getByRole("log", { name: "Assistant conversation" })).getByText("orders")).toBeTruthy();
  expect(composer().disabled).toBe(false);
});

test("cancel_on_the_card_sends_nothing_and_frees_the_composer", async () => {
  setup();
  await parsed();
  replies = [followUp("Which table?")];
  await send("Add a status column");
  await screen.findByRole("group", { name: "Which table?" });
  const turns = appended().length;
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Which table?" })).toBeNull());
  expect(ai().asking).toBeNull();
  expect(asks()).toHaveLength(1);
  expect(appended()).toHaveLength(turns);
  expect(composer().disabled).toBe(false);
  // The question stays in the history as an answer, as text.
  expect(screen.getByText("Which table?")).toBeTruthy();
});

test("a_blank_reply_shows_as_left_to_the_assistant_in_the_history", async () => {
  setup();
  await parsed();
  replies = [followUp("Which table?"), answered("I picked orders.")];
  await send("Add a status column");
  await screen.findByRole("group", { name: "Which table?" });
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  await waitFor(() => expect(screen.getByText("I picked orders.")).toBeTruthy());
  // The saved turn says what the model was told; the chat says the user left it to the assistant.
  expect(screen.getByText(LEFT_TO_AI)).toBeTruthy();
  expect(screen.queryByText(BLANK_REPLY)).toBeNull();
});

test("cancel_with_a_failed_reply_pending_sends_nothing_and_retry_is_gone", async () => {
  setup();
  await parsed();
  await replyWith("orders", [[failed({ kind: "network", host: "api.groq.com" })], answered("Added it.")]);
  expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  expect(ai().failure).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(ai().asking).toBeNull());
  // The failure went with the follow-up: no Retry that would send a reply nobody waits for.
  expect(ai().failure).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByRole("group", { name: "Which table?" })).toBeNull();
  await new Promise((r) => setTimeout(r, 20));
  expect(asks()).toHaveLength(2);
  expect(composer().disabled).toBe(false);
});

test("a_reply_kept_with_its_error_goes_back_in_the_reply_box", async () => {
  setup();
  await parsed();
  // The Ask left (the Core's Sent record came) and then failed: the turns are kept, with the error.
  await replyWith("orders", [[sent(), failed({ kind: "network", host: "api.groq.com" })], answered("Added it.")]);
  expect(await screen.findByText("Could not reach api.groq.com.")).toBeTruthy();
  expect(ai().asking).toMatchObject({ question: "Which table?", reply: "orders" });
  expect(replyBox().value).toBe("orders");
  // The composer stays empty and shut; Retry sends the reply as the reply.
  expect(composer().value).toBe("");
  expect(composer().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(asks()).toHaveLength(3));
  expect(asks()[2].board!.followUp).toEqual({ asked: "Which table?", reply: "orders" });
});

test("the_card_works_on_a_one_file_ask_with_an_attached_file", async () => {
  setup();
  await parsed();
  replies = [followUp("Which of the two flows?"), answered("Added it.")];
  fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
  // A file chip's token rides on the first Ask (the chip itself comes with the start screen, Task 18).
  await act(async () => {
    await ai().send("Match the attached flow", { model: null, picks: null, focus: [], create: null, attachment: "tok-1" });
  });
  await screen.findByRole("group", { name: "Which of the two flows?" });
  expect(asks()[0].board!.attachment).toBe("tok-1");
  expect(composer().disabled).toBe(true);
  fireEvent.change(replyBox(), { target: { value: "the second" } });
  fireEvent.keyDown(replyBox(), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(asks()).toHaveLength(2));
  // The Core keeps the file for the reply: the reply carries the question, the reply and the same token.
  expect(asks()[1].question).toBe("Match the attached flow");
  expect(asks()[1].board!.attachment).toBe("tok-1");
  expect(asks()[1].board!.followUp).toEqual({ asked: "Which of the two flows?", reply: "the second" });
  await idle();
  expect(ai().asking).toBeNull();
  expect(screen.queryByRole("group", { name: "Which of the two flows?" })).toBeNull();
  // The chain ended well: the Core used the file up, so nothing is left to clear.
  expect(callsTo("ai_clear_attachment")).toHaveLength(0);
});

test("leaving_a_follow_up_lets_the_core_forget_its_file", async () => {
  setup();
  await parsed();
  fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
  const opts = { model: null, picks: null, focus: [], create: null, attachment: "tok-2" };
  // Cancel on the card: the file held for the reply goes from the Core's memory.
  replies = [followUp("Which flow?")];
  await act(async () => {
    await ai().send("Match the attached flow", opts);
  });
  await screen.findByRole("group", { name: "Which flow?" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(callsTo("ai_clear_attachment")).toEqual([{ token: "tok-2" }]));
  // New chat with the card open does the same.
  replies = [followUp("Which flow?")];
  await act(async () => {
    await ai().send("Match the attached flow", { ...opts, attachment: "tok-3" });
  });
  await screen.findByRole("group", { name: "Which flow?" });
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(callsTo("ai_clear_attachment")).toEqual([{ token: "tok-2" }, { token: "tok-3" }]));
  // A follow-up of an Ask with no file has nothing to clear.
  replies = [followUp("Which flow?")];
  await act(async () => {
    await ai().send("Match it", { ...opts, attachment: null });
  });
  await screen.findByRole("group", { name: "Which flow?" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await new Promise((r) => setTimeout(r, 20));
  expect(callsTo("ai_clear_attachment")).toHaveLength(2);
});

// ----- Task 18 fix round 1: a file held for a reply always has an owner.

const fileOpts = (attachment: string | null) => ({ model: null, picks: null, focus: [], create: null, attachment });
const cleared = () => callsTo("ai_clear_attachment").map((c) => c.token);

/** Asks with `token` attached and waits for the follow-up card "Which flow?". */
async function heldForReply(token: string) {
  replies = [followUp("Which flow?")];
  fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
  await act(async () => {
    await ai().send("Match the attached flow", fileOpts(token));
  });
  await screen.findByRole("group", { name: "Which flow?" });
}

/** Continues the card with a reply whose Ask the Core keeps open. */
async function replyRunning() {
  const before = asks().length;
  holdAsk = true;
  act(() => {
    void ai().answer("the second");
  });
  await waitFor(() => expect(asks()).toHaveLength(before + 1));
  expect(ai().working).not.toBeNull();
}

test("closing_the_tab_mid_reply_ends_the_hold", async () => {
  const s = setup();
  await parsed();
  await heldForReply("tok-a");
  await replyRunning();
  expect(asks()[1].board!.attachment).toBe("tok-a");
  expect(cleared()).toEqual([]);
  s.unmount();
  expect(cleared()).toContain("tok-a");
});

test("another_diagram_mid_reply_ends_the_hold", async () => {
  const s = setup();
  await parsed();
  await heldForReply("tok-b");
  await replyRunning();
  expect(cleared()).toEqual([]);
  act(() => s.switchTo("other"));
  expect(cleared()).toContain("tok-b");
});

test("a_follow_up_that_arrives_after_leaving_holds_no_file", async () => {
  const s = setup();
  await parsed();
  fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
  holdAsk = true;
  act(() => {
    void ai().send("Match the attached flow", fileOpts("tok-c"));
  });
  await waitFor(() => expect(asks()).toHaveLength(1));
  act(() => s.switchTo("other"));
  expect(cleared()).toContain("tok-c");
  // The Core ends the first Ask with a follow-up after the switch: no card waits on the other diagram, and no reply
  // will name the file.
  act(() => followUp("Which flow?").forEach((e) => sinks[0].onmessage(e)));
  await new Promise((r) => setTimeout(r, 20));
  expect(ai().asking).toBeNull();
  expect(screen.queryByRole("group", { name: "Which flow?" })).toBeNull();
  expect(asks()).toHaveLength(1);
});

test("a_reply_whose_file_is_gone_goes_on_without_it", async () => {
  setup();
  await parsed();
  await heldForReply("tok-d");
  // Another board's pick took the Core's one slot: the reply is refused before anything is sent.
  replies = [[failed({ kind: "attachmentGone" })], answered("Added it.")];
  fireEvent.change(replyBox(), { target: { value: "the second" } });
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(await screen.findByText("The attached file is no longer held. Attach it again.")).toBeTruthy();
  expect(cleared()).toEqual(["tok-d"]);
  expect(ai().asking).toMatchObject({ question: "Which flow?", reply: "the second" });
  expect(ai().asking!.opts.attachment).toBeNull();
  // Continue again goes without the file, and is answered.
  fireEvent.click(await screen.findByRole("button", { name: /Continue/ }));
  await waitFor(() => expect(asks()).toHaveLength(3));
  expect(asks()[2].board!.attachment).toBeNull();
  expect(asks()[2].board!.followUp).toEqual({ asked: "Which flow?", reply: "the second" });
  await idle();
  expect(await screen.findByText("Added it.")).toBeTruthy();
});

test("leaving_an_idle_follow_up_by_a_past_chat_a_tab_close_or_another_diagram_ends_the_hold", async () => {
  // A past chat.
  let s = setup();
  await parsed();
  replies = [answered("Fine.")];
  fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
  await act(async () => {
    await ai().send("What is here?", fileOpts(null));
  });
  await idle();
  const past = ai().thread!.id;
  act(() => ai().newChat());
  await heldForReply("tok-e");
  await act(async () => {
    await ai().openThread(past);
  });
  expect(cleared()).toEqual(["tok-e"]);
  expect(ai().asking).toBeNull();
  cleanup();
  vi.clearAllMocks();

  // The tab closes.
  s = setup();
  await parsed();
  await heldForReply("tok-f");
  s.unmount();
  expect(cleared()).toEqual(["tok-f"]);
  cleanup();
  vi.clearAllMocks();

  // Another diagram opens in the tab.
  s = setup();
  await parsed();
  await heldForReply("tok-g");
  act(() => s.switchTo("other"));
  expect(cleared()).toEqual(["tok-g"]);
});

// ----- Task 16 fix round 1: the disabled composer says why; focus never drops; a stale card sends nothing.

test("the_disabled_composer_says_why", async () => {
  setup();
  await parsed();
  replies = [followUp("Which table?")];
  await send("Add a status column");
  await screen.findByRole("group", { name: "Which table?" });
  expect(composer().disabled).toBe(true);
  expect(composer().getAttribute("aria-describedby")).toBeTruthy();
  const id = composer().getAttribute("aria-describedby")!;
  expect(document.getElementById(id)!.textContent).toBe("Answer the question above first.");
});

test("focus_returns_to_the_composer_after_continue_and_after_cancel", async () => {
  setup();
  await parsed();
  replies = [followUp("Which table?"), answered("Added it."), followUp("Which column?")];
  await send("Add a status column");
  await screen.findByRole("group", { name: "Which table?" });
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  await waitFor(() => expect(asks()).toHaveLength(2));
  await idle();
  await waitFor(() => expect(document.activeElement).toBe(composer()));
  expect(composer().getAttribute("aria-describedby")).toBeNull();
  // Cancel: the same.
  await send("Add another column");
  await screen.findByRole("group", { name: "Which column?" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(composer()));
});

test("a_new_chat_while_the_card_is_open_clears_it_and_sends_nothing", async () => {
  setup();
  await parsed();
  replies = [followUp("Which table?")];
  await send("Add a status column");
  await screen.findByRole("group", { name: "Which table?" });
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Which table?" })).toBeNull());
  expect(ai().asking).toBeNull();
  // A Continue that was already on its way finds nothing to answer.
  await act(async () => {
    await ai().answer("orders");
  });
  expect(asks()).toHaveLength(1);
  expect(composer().disabled).toBe(false);
});

// ----- Task 17: answers point at parts on the canvas.

const rowsOf = (id: string) => (drawn().get(id)?.data as { rowStates?: (string | undefined)[] } | undefined)?.rowStates;
const stateOf = (id: string) => (drawn().get(id)?.data as { state?: string } | undefined)?.state;

test("named_parts_on_screen_ring_when_the_answer_ends", async () => {
  const { s } = await drawnBoard();
  void s;
  // Cart and Pay are shapes, orders.total a column, and Missing is nothing on the board.
  replies = [answered("`Cart` feeds `Pay`; `orders.total` is the amount, and `Missing` is nothing.")];
  await send("What does the board do?");
  await idle();
  // The shape rings by its frame's layout key, and the column on its own row, never the whole card.
  // "ringed": the landing's ring, with no ", added by AI" in the name, since nothing was added.
  await waitFor(() => expect(stateOf(inFrameId("Checkout", "Cart"))).toBe("ringed"));
  expect(stateOf(inFrameId("Checkout", "Pay"))).toBe("ringed");
  expect(stateOf(inFrameId("Refund", "Ask"))).toBeUndefined();
  expect(rowsOf(inFrameId("Orders ERD", "orders"))).toEqual([undefined, "ringed"]);
  expect(stateOf(inFrameId("Orders ERD", "orders"))).toBeUndefined();
  // The ring goes after its time, and nothing edited the text.
  await waitFor(() => expect(stateOf(inFrameId("Checkout", "Cart"))).toBeUndefined(), { timeout: 4000 });
  expect(rowsOf(inFrameId("Orders ERD", "orders"))).toBeUndefined();
  expect(s.text()).toBe(BOARD);
});

test("a_part_button_selects_the_frame_glides_and_rings", async () => {
  const { s, fit } = await drawnBoard();
  replies = [answered("The amount is `Orders ERD: orders.total`, and `Refund: Ask` starts a refund.")];
  await send("Where is the amount?");
  await idle();
  const col = await screen.findByRole("button", { name: "Orders ERD: orders.total, show in Orders ERD" });
  expect(col.textContent).toBe("Orders ERD: orders.total");
  expect(col.tagName).toBe("BUTTON");
  await waitFor(() => expect(rowsOf(inFrameId("Orders ERD", "orders"))).toBeUndefined(), { timeout: 4000 });
  fit.mockClear();
  fireEvent.click(col);
  // The frame is selected, the view glides to it, and the column rings on the live card.
  await waitFor(() => expect(hooked.doc!.selection()).toMatchObject({ title: "Orders ERD", index: 1 }));
  await waitFor(() => expect(fit).toHaveBeenCalled());
  // The fit is of the Orders ERD frame (with its tab), not of the others.
  const erd = hooked.doc!.board.frames.get("Orders ERD")!.at;
  const fitted = boundsOf(fit);
  expect(fitted.x).toBeLessThanOrEqual(erd.x);
  expect(fitted.y).toBeLessThanOrEqual(erd.y - FRAME_TAB_H + 0.001);
  expect(hooked.doc!.board.frames.get("Refund")!.at.x).toBeGreaterThan(fitted.x + fitted.width);
  await waitFor(() => expect(rowsOf("orders")).toEqual([undefined, "ringed"]));
  expect(s.text()).toBe(BOARD);
  // A shape names itself: the other frame is selected and its shape rings.
  fireEvent.click(screen.getByRole("button", { name: "Refund: Ask, show in Refund" }));
  await waitFor(() => expect(hooked.doc!.selection()).toMatchObject({ title: "Refund", index: 2 }));
  await waitFor(() => expect(stateOf("Ask")).toBe("ringed"));
});

test("a_part_that_is_gone_renders_as_plain_code", async () => {
  const { s } = await drawnBoard();
  replies = [answered("Look at `Cart` and `orders`.")];
  await send("What is there?");
  await idle();
  expect(await screen.findByRole("button", { name: "Cart, show in Checkout" })).toBeTruthy();
  // Cart is deleted from the text: the older answer keeps the code but loses the button; orders stays a button.
  act(() => {
    const v = s.view();
    const at = v.state.doc.toString().indexOf("Cart\nPay\nCart > Pay\n");
    v.dispatch({ changes: { from: at, to: at + "Cart\nPay\nCart > Pay\n".length, insert: "Pay\n" } });
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cart, show in Checkout" })).toBeNull());
  const code = screen.getAllByText("Cart").find((e) => e.tagName === "CODE");
  expect(code).toBeTruthy();
  expect(code!.closest("button")).toBeNull();
  expect(screen.getByRole("button", { name: "orders, show in Orders ERD" })).toBeTruthy();
});

test("an_answer_with_markup_stays_text", async () => {
  await drawnBoard();
  replies = [answered("Try `Cart` <img src=x onerror=alert(1)> and `<b>Cart</b>`.")];
  await send("Hi");
  await idle();
  const btn = await screen.findByRole("button", { name: "Cart, show in Checkout" });
  expect(btn.querySelector("code")?.textContent).toBe("Cart");
  expect(document.querySelector("img[src='x']")).toBeNull();
  expect(screen.getAllByRole("button", { name: /, show in / })).toHaveLength(1);
});

test("named_parts_in_frames_off_screen_do_not_ring", async () => {
  await drawnBoard();
  const at = hooked.doc!.board.frames.get("Refund")!.at;
  // The view is on the Refund frame alone, a long way from the other two.
  act(() => {
    canvas.instance!.setViewport({ x: -(at.x + 5000), y: -(at.y + 5000), zoom: 1 });
  });
  replies = [answered("`Cart` feeds `Pay`; `Ask` starts a refund.")];
  await send("What does the board do?");
  await idle();
  await new Promise((r) => setTimeout(r, 50));
  expect(stateOf(inFrameId("Checkout", "Cart"))).toBeUndefined();
  expect(stateOf(inFrameId("Refund", "Ask"))).toBeUndefined();
  // Back on the Refund frame, the same answer rings its shape there and still not the far one.
  act(() => {
    canvas.instance!.setViewport({ x: -(at.x - 20), y: -(at.y - 60), zoom: 1 });
  });
  replies = [answered("`Cart` feeds `Pay`; `Ask` starts a refund.")];
  await send("Again?");
  await idle();
  await waitFor(() => expect(stateOf(inFrameId("Refund", "Ask"))).toBe("ringed"));
  expect(stateOf(inFrameId("Checkout", "Cart"))).toBeUndefined();
  // The buttons are still there to press.
  expect(screen.getAllByRole("button", { name: "Cart, show in Checkout" })).toHaveLength(2);
});

const GROUPED = ['diagram flow "Ops"', "Intake", "Dispatch {", "  Ship", "}", "", "Intake > Ship", ""].join("\n");
const groupAreaOf = (frame: string) => drawn().get(`${inFrameId(frame, "\u0000group:Dispatch")}`) ?? drawn().get("\u0000group:Dispatch");

test("a_group_an_answer_names_rings_its_area_and_the_same_code_twice_links_twice", async () => {
  setupWith(GROUPED);
  await waitFor(() => expect(hooked.doc?.parsed?.result.frames.map((f) => f.title)).toEqual(["Ops"]), { timeout: 4000 });
  replies = [answered("`Dispatch` holds `Ship`; ask `Dispatch` again.")];
  await send("What is Dispatch?");
  await idle();
  await waitFor(() => expect((groupAreaOf("Ops")?.className ?? "").includes("is-ai-airing")).toBe(true));
  expect(screen.getAllByRole("button", { name: "Dispatch, show in Ops" })).toHaveLength(2);
  // Each of the two buttons has its own target, and the ring ends with its time.
  await waitFor(() => expect((groupAreaOf("Ops")?.className ?? "").includes("is-ai-airing")).toBe(false), { timeout: 4000 });
});

test("a_failed_answer_rings_nothing", async () => {
  await drawnBoard();
  replies = [[sent(), { type: "delta", text: "The `Cart` is" }, failed({ kind: "network", host: "api.groq.com" }, true)]];
  await send("What is there?");
  await idle();
  await new Promise((r) => setTimeout(r, 50));
  expect(stateOf(inFrameId("Checkout", "Cart"))).toBeUndefined();
});

test("a_button_on_a_clashing_frame_says_so_and_only_glides", async () => {
  const clash = ['diagram flow "Checkout"', "Cart", "", 'diagram flow "Checkout"', "Cart", "Extra", ""].join("\n");
  await drawnBoard(clash, ["Checkout", "Checkout"]);
  const centre = vi.spyOn(canvas.instance!, "setCenter").mockResolvedValue(true);
  replies = [answered("Only the second has `Extra`.")];
  await send("What is extra?");
  await idle();
  const btn = await screen.findByRole("button", { name: "Extra, show in Checkout (shows the frame only)" });
  const sel = hooked.doc!.selection();
  fireEvent.click(btn);
  await waitFor(() => expect(centre).toHaveBeenCalled());
  // The frame is not selected, nothing rings, and nothing was edited.
  expect(hooked.doc!.selection()).toEqual(sel);
  expect(stateOf(clashInFrameId(1, "Extra"))).toBeUndefined();
});

test("the_ring_timer_is_cleared_when_the_tab_closes", async () => {
  const set = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  const { s } = await drawnBoard();
  replies = [answered("`Cart` is first.")];
  await send("What is first?");
  await idle();
  await waitFor(() => expect(stateOf(inFrameId("Checkout", "Cart"))).toBe("ringed"));
  const ring = set.mock.calls.map((c, i) => [c[1], set.mock.results[i].value] as const).filter(([ms]) => ms === AIRING_MS).pop();
  expect(ring).toBeTruthy();
  clear.mockClear();
  s.unmount();
  expect(clear.mock.calls.some((c) => c[0] === ring![1])).toBe(true);
  set.mockRestore();
  clear.mockRestore();
});

test("reduced_motion_rings_a_group_without_a_fade", () => {
  const block = /@media \(prefers-reduced-motion: reduce\) \{[^@]*?\.is-ai-airing > \.flow-area[^}]*animation: none;/;
  expect(flowTabCss).toMatch(block);
  expect(flowTabCss).toMatch(/\.flow-canvas \.react-flow__node\.is-ai-airing > \.flow-area\s*\{[^}]*outline: 2px solid var\(--c-accent\);[^}]*animation: ai-fade/);
});
