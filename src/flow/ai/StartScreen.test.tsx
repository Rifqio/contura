// The board assistant's start screen (Plan D Task 18, Decision 15): an empty chat offers the nine kind cards (B2's
// Diagrams-tab cards and roles), Template (the board Shelf on its templates side) and File (one text file the Core
// reads from its own dialog). A kind card adds the "create" chip; the file chip carries a token; both are sent once.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { withTurn } from "../../api/client";
import type { AiEvent, AiThread, AppendTurn, DiagramAskRequest, Preview } from "../../api/types";
import { LangClient } from "../../lang/client";
import { done, failed, sent } from "../../test/aiStream";
import { turnViewOf } from "../../test/aiThreads";
import { mockEditorDom } from "../../test/editor";
import { callsTo, routeInvoke } from "../../test/invoke";
import { fakeWorker } from "../../test/langWorker";
import { mockReactFlowDom } from "../../test/reactFlow";
import { GROQ } from "../../test/settingsRoutes";
import { KIND_HEAD } from "../board/chips";
import { SHELF_KINDS } from "../board/catalog/kinds";
import FlowTab from "../FlowTab";
import type { FlowDocApi } from "../useFlowDoc";
import type { BoardAsk } from "./useBoardAsk";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

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

const BOARD = ['diagram flow "Checkout"', "Cart", "Pay", "Cart > Pay", ""].join("\n");

type Sink = { onmessage: (e: AiEvent) => void };
let threads: AiThread[] = [];
let replies: AiEvent[][] = [];
/** What the Core's dialog gives: a file, null (cancelled), or a refusal it throws. */
let picked: () => unknown = () => null;
let previewError: unknown = null;

const PREVIEW: Preview = { items: [], tables: { full: [], namesOnly: [], leftOut: [], reasons: [] }, totalBytes: 0, tokens: 0, exact: "", notes: [], log: [], context: null, rows: null };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  threads = [];
  replies = [];
  picked = () => null;
  previewError = null;
  hooked.ai = null;
  hooked.doc = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup() {
  routeInvoke({
    read_diagram: () => ({ text: BOARD, layout: null }),
    write_diagram: () => null,
    write_diagram_layout: () => null,
    list_ai_threads: (a) => threads.filter((t) => t.place === a.place).map((t) => ({ id: t.id, place: t.place, title: t.title, updatedAt: t.updatedAt, messages: t.messages.length, topics: 0 })),
    get_ai_thread: (a) => {
      const t = threads.find((x) => x.id === a.threadId);
      return t ? { thread: t, topics: [], compactions: [] } : null;
    },
    ai_append_turn: (a) => {
      const turn = a.turn as AppendTurn;
      const before = threads.find((x) => x.id === turn.threadId) ?? null;
      const v = turnViewOf(turn, before);
      const t = withTurn(before, v);
      threads = [...threads.filter((x) => x.id !== t.id), t];
      return v;
    },
    ai_known_models: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    ai_settings: () => ({ settings: { ...GROQ, diagramTool: true }, groupOverride: false, keySaved: true, keyLast4: "abcd" }),
    ai_diagram_preview: () => {
      if (previewError) throw previewError;
      return PREVIEW;
    },
    ai_diagram_ask: (a) => {
      const sink = a.events as Sink;
      const events = replies.shift() ?? [];
      setTimeout(() => events.forEach((e) => sink.onmessage(e)), 0);
      return null;
    },
    ai_pick_attachment: () => picked(),
    ai_clear_attachment: () => null,
    ai_cancel_place: () => true,
    ai_record_tool_result: (a) => a.outcome,
    icon_index: () => [],
  });
  const client = new LangClient(() => fakeWorker());
  return render(
    <div style={{ width: 1280, height: 800 }}>
      <FlowTab name="board" client={client} />
    </div>,
  );
}

async function parsed() {
  await waitFor(() => expect(hooked.doc?.parsed?.result.frames.map((f) => f.title)).toEqual(["Checkout"]), { timeout: 4000 });
}

const asks = () => callsTo("ai_diagram_ask").map((c) => c.request as DiagramAskRequest);
const ai = () => hooked.ai!;
const composer = () => screen.getByRole("textbox", { name: "Describe a change" }) as HTMLTextAreaElement;
const start = () => screen.getByRole("region", { name: "What would you like to create?" });
const cards = () => within(start()).getByRole("listbox");
/** The kind card's and the file's chips (the selected frame has its own automatic chip beside them). */
const chipLabels = () => [...document.querySelectorAll(".ask-chip-create, .ask-chip-file")].map((li) => li.textContent);
const answered = (text: string, notes: string[] = []): AiEvent[] => [sent(), { type: "delta", text }, done({ notes })];

async function openAssistant() {
  await parsed();
  fireEvent.click(screen.getByRole("tab", { name: /^Assistant/ }));
  await screen.findByRole("region", { name: "What would you like to create?" });
}

/** Types `q` in the composer and sends it with Enter; waits for the answer to end. */
async function send(q: string) {
  const before = asks().length;
  fireEvent.change(composer(), { target: { value: q } });
  fireEvent.keyDown(composer(), { key: "Enter" });
  await waitFor(() => expect(asks().length).toBe(before + 1));
  await waitFor(() => expect(ai().working).toBeNull());
}

test("an_empty_chat_shows_the_start_screen", async () => {
  setup();
  await openAssistant();
  expect(within(start()).getByRole("heading", { name: "What would you like to create?" })).toBeTruthy();
  expect(within(start()).getByText("Already have something to start with?")).toBeTruthy();
  // A chat with messages does not.
  replies = [answered("It has two steps.")];
  await send("What is on this board?");
  await screen.findByText("It has two steps.");
  expect(screen.queryByRole("region", { name: "What would you like to create?" })).toBeNull();
  // A new chat is empty again.
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(await screen.findByRole("region", { name: "What would you like to create?" })).toBeTruthy();
});

test("nine_cards_in_shelf_order_with_arrow_keys", async () => {
  setup();
  await openAssistant();
  const box = cards();
  const options = within(box).getAllByRole("option");
  expect(options.map((o) => o.getAttribute("aria-label"))).toEqual(SHELF_KINDS.map((k) => KIND_HEAD[k].name));
  // The listbox is one tab stop; the active card follows the arrows (B2's cards: Up and Down in reading order, and
  // Left and Right on the grid).
  expect(box.tabIndex).toBe(0);
  box.focus();
  expect(box.getAttribute("aria-activedescendant")).toBe(options[0].id);
  fireEvent.keyDown(box, { key: "ArrowDown" });
  expect(box.getAttribute("aria-activedescendant")).toBe(options[1].id);
  fireEvent.keyDown(box, { key: "ArrowRight" });
  expect(box.getAttribute("aria-activedescendant")).toBe(options[2].id);
  fireEvent.keyDown(box, { key: "ArrowLeft" });
  fireEvent.keyDown(box, { key: "ArrowUp" });
  expect(box.getAttribute("aria-activedescendant")).toBe(options[0].id);
  fireEvent.keyDown(box, { key: "End" });
  expect(box.getAttribute("aria-activedescendant")).toBe(options[8].id);
  fireEvent.keyDown(box, { key: "Home" });
  fireEvent.keyDown(box, { key: "ArrowDown" });
  fireEvent.keyDown(box, { key: "Enter" });
  // Enter picks the active card, the second: the ER diagram's create chip.
  expect(chipLabels()).toEqual([`New ${KIND_HEAD.er.name}`]);
  // Nothing drags off the start screen.
  expect(options.every((o) => o.getAttribute("draggable") === "false")).toBe(true);
});

test("a_kind_card_adds_the_create_chip_and_placeholder", async () => {
  setup();
  await openAssistant();
  fireEvent.click(within(cards()).getByRole("option", { name: KIND_HEAD.sequence.name }));
  expect(chipLabels()).toEqual(["New Sequence"]);
  expect(composer().placeholder).toBe("Describe the sequence diagram");
  // The description goes next: the cursor is in the box (ChatGPT's and Claude's suggestion cards).
  expect(document.activeElement).toBe(composer());
  // Another card takes the chip's place; removing it gives the placeholder back.
  fireEvent.click(within(cards()).getByRole("option", { name: KIND_HEAD.er.name }));
  expect(chipLabels()).toEqual(["New ER diagram"]);
  expect(composer().placeholder).toBe("Describe the ER diagram");
  fireEvent.click(screen.getByRole("button", { name: "Remove New ER diagram" }));
  expect(chipLabels()).toEqual([]);
  expect(composer().placeholder).toBe("Describe a change");
});

test("every_kind_card_asks_for_the_diagram_by_its_everyday_name", async () => {
  // One form for all nine (Task 19 copy): the name people call the kind, as Mermaid's docs do; a card name that is not
  // a diagram on its own ("Sequence") takes "diagram".
  setup();
  await openAssistant();
  const want: Record<string, string> = {
    dfd: "Describe the data flow diagram",
    flow: "Describe the flowchart",
    cloud: "Describe the cloud architecture diagram",
    er: "Describe the ER diagram",
    sequence: "Describe the sequence diagram",
    state: "Describe the state diagram",
    class: "Describe the class diagram",
    mindmap: "Describe the mind map",
    timeline: "Describe the timeline",
  };
  expect(Object.keys(want).sort()).toEqual(Object.keys(KIND_HEAD).sort());
  for (const [kind, placeholder] of Object.entries(want)) {
    fireEvent.click(within(cards()).getByRole("option", { name: KIND_HEAD[kind as keyof typeof KIND_HEAD].name }));
    expect(composer().placeholder, kind).toBe(placeholder);
  }
});

test("send_with_a_create_chip_sets_create", async () => {
  setup();
  await openAssistant();
  fireEvent.click(within(cards()).getByRole("option", { name: KIND_HEAD.sequence.name }));
  replies = [answered("Here is the login sequence."), answered("Fine.")];
  await send("Login with a one-time code");
  expect(asks()[0].board!.create).toBe("sequence");
  // The chip went with that Ask: the next one creates nothing.
  await waitFor(() => expect(chipLabels()).toEqual([]));
  await send("And now?");
  expect(asks()[1].board!.create).toBeNull();
});

test("template_opens_the_shelf_on_templates", async () => {
  setup();
  await openAssistant();
  fireEvent.click(within(start()).getByRole("button", { name: "Template" }));
  const shelf = await screen.findByRole("dialog", { name: "Add to the board" });
  expect(shelf.getAttribute("data-side")).toBe("right");
  // The search drives the templates' list: Enter adds the first template.
  const search = within(shelf).getByRole("combobox");
  const templates = within(shelf).getByRole("listbox", { name: "Templates" });
  expect(search.getAttribute("aria-controls")).toBe(templates.id);
  expect(document.activeElement).toBe(search);
});

test("file_attaches_a_chip_and_sends_its_token_once", async () => {
  setup();
  await openAssistant();
  picked = () => ({ token: "tok-1", name: "plan.md", bytes: 2048 });
  fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  await waitFor(() => expect(chipLabels()).toEqual(["plan.md"]));
  expect(callsTo("ai_pick_attachment")).toHaveLength(1);
  replies = [answered("Drawn from the plan."), answered("Fine.")];
  await send("Draw the flow in this plan");
  expect(asks()[0].board!.attachment).toBe("tok-1");
  // Sent once: the chip goes, and the next Ask names no file.
  await waitFor(() => expect(chipLabels()).toEqual([]));
  await send("And now?");
  expect(asks()[1].board!.attachment).toBeNull();
});

test("removing_the_file_chip_lets_the_core_forget_the_file", async () => {
  setup();
  await openAssistant();
  picked = () => ({ token: "tok-2", name: "notes.txt", bytes: 10 });
  fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  await waitFor(() => expect(chipLabels()).toEqual(["notes.txt"]));
  fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
  expect(chipLabels()).toEqual([]);
  await waitFor(() => expect(callsTo("ai_clear_attachment")).toEqual([{ token: "tok-2" }]));
  // A cancelled dialog adds nothing.
  picked = () => null;
  fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  await waitFor(() => expect(callsTo("ai_pick_attachment")).toHaveLength(2));
  expect(chipLabels()).toEqual([]);
});

test("a_gone_attachment_clears_its_chip", async () => {
  setup();
  await openAssistant();
  picked = () => ({ token: "tok-3", name: "plan.md", bytes: 10 });
  fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  await waitFor(() => expect(chipLabels()).toEqual(["plan.md"]));
  // The Core no longer holds it (a pick on another board replaced it): the chip goes, and the Core is told.
  previewError = { kind: "ai", message: { kind: "attachmentGone" } };
  fireEvent.change(composer(), { target: { value: "Draw it" } });
  await waitFor(() => expect(chipLabels()).toEqual([]), { timeout: 2000 });
  expect(callsTo("ai_clear_attachment")).toEqual([{ token: "tok-3" }]);
});

test("a_refused_file_shows_its_note", async () => {
  setup();
  await openAssistant();
  picked = () => {
    throw { kind: "invalidInput", message: "This file is larger than 64 KB." };
  };
  fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  expect(await within(start()).findByText("This file is larger than 64 KB.")).toBeTruthy();
  expect(chipLabels()).toEqual([]);
  // The next pick that works clears the note.
  picked = () => ({ token: "tok-4", name: "plan.md", bytes: 10 });
  fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  await waitFor(() => expect(chipLabels()).toEqual(["plan.md"]));
  expect(within(start()).queryByText("This file is larger than 64 KB.")).toBeNull();
});

test("a_cut_attachment_says_so_in_the_chat", async () => {
  setup();
  await openAssistant();
  picked = () => ({ token: "tok-5", name: "long.md", bytes: 60000 });
  fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  await waitFor(() => expect(chipLabels()).toEqual(["long.md"]));
  // The Core cut the file to its share of the budget and noted it on the answer.
  replies = [answered("Drawn from the first part.", ["Sent the first 24 KB of long.md."])];
  await send("Draw the flow in this file");
  const log = screen.getByRole("log", { name: "Assistant conversation" });
  expect(await within(log).findByText("Sent the first 24 KB of long.md.")).toBeTruthy();
});

test("no_git_repo_choice", async () => {
  setup();
  await openAssistant();
  // Spec answer 6: the start screen offers a template or a file, never a Git repository.
  const buttons = within(start()).getAllByRole("button").map((b) => b.textContent?.trim());
  expect(buttons).toEqual(["Template", "File"]);
  expect(within(start()).queryByText(/git|repo/i)).toBeNull();
});

test("a_new_pick_replaces_the_file_chip", async () => {
  setup();
  await openAssistant();
  picked = () => ({ token: "tok-6", name: "one.md", bytes: 10 });
  fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  await waitFor(() => expect(chipLabels()).toEqual(["one.md"]));
  picked = () => ({ token: "tok-7", name: "two.md", bytes: 10 });
  await act(async () => {
    fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  });
  await waitFor(() => expect(chipLabels()).toEqual(["two.md"]));
});

test("a_failed_ask_whose_file_is_gone_drops_that_chip", async () => {
  setup();
  await openAssistant();
  picked = () => ({ token: "tok-8", name: "plan.md", bytes: 10 });
  fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  await waitFor(() => expect(chipLabels()).toEqual(["plan.md"]));
  replies = [[failed({ kind: "attachmentGone" })]];
  await send("Draw the flow in this plan");
  expect(await screen.findByText("The attached file is no longer held. Attach it again.")).toBeTruthy();
  await waitFor(() => expect(chipLabels()).toEqual([]));
  expect(callsTo("ai_clear_attachment")).toEqual([{ token: "tok-8" }]);
});

test("a_failed_ask_keeps_its_chips_for_retry", async () => {
  setup();
  await openAssistant();
  fireEvent.click(within(cards()).getByRole("option", { name: KIND_HEAD.sequence.name }));
  picked = () => ({ token: "tok-9", name: "plan.md", bytes: 10 });
  fireEvent.click(within(start()).getByRole("button", { name: "File" }));
  await waitFor(() => expect(chipLabels()).toEqual(["New Sequence", "plan.md"]));
  replies = [[failed({ kind: "network", host: "api.groq.com" })], answered("Here it is.")];
  await send("Login with a one-time code");
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(chipLabels()).toEqual(["New Sequence", "plan.md"]);
  fireEvent.click(retry);
  // The chips stayed for Retry, which sends them again; the answer then uses them up.
  await waitFor(() => expect(asks()).toHaveLength(2));
  expect(asks()[1].board!.create).toBe("sequence");
  expect(asks()[1].board!.attachment).toBe("tok-9");
  await screen.findByText("Here it is.");
  await waitFor(() => expect(chipLabels()).toEqual([]));
  expect(callsTo("ai_clear_attachment")).toEqual([]);
});
