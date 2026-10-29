// The diagram assistant's Sends line (controller): the Core's preview, 300 ms after the last
// change, never while an Ask runs, and no rows that belong to another text.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { aiDiagramPreview } from "../../api/client";
import { textStore } from "../../assistant/answerStream";
import type { DiagramAskRequest, Preview } from "../../api/types";
import { callsTo, routeInvoke } from "../../test/invoke";
import { GROQ } from "../../test/settingsRoutes";
import DiagramAssistant from "./DiagramAssistant";
import type { AskOptions, BoardAsk } from "./useBoardAsk";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const LOCK = "The changes are written against this text";
const previewOf = (r: DiagramAskRequest): Preview => ({
  items: [
    { kind: "question", label: "Question", bytes: r.question.length, tokens: 1, locked: null, on: true },
    { kind: "diagram", label: `${r.file}.flow`, bytes: r.text.length, tokens: 10, locked: LOCK, on: true },
  ],
  tables: { full: [], namesOnly: [], leftOut: [], reasons: [] },
  totalBytes: 100,
  tokens: 25,
  exact: `File: ${r.file}.flow.\n\nQuestion: ${r.question}`,
  notes: [],
  log: [],
  context: null,
  rows: null,
});

let previewError: unknown = null;
/** The tab's text has no outline yet: the hook's preview gives null. */
let noOutline = false;

beforeEach(() => {
  previewError = null;
  noOutline = false;
  routeInvoke({
    ai_known_models: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    ai_settings: () => ({ settings: { ...GROQ, diagramTool: true }, groupOverride: false, keySaved: true, keyLast4: "abcd" }),
    ai_diagram_preview: (a) => {
      if (previewError) throw previewError;
      return previewOf(a.request as DiagramAskRequest);
    },
  });
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A hook stand-in: the preview goes to the Core as the real one does, on a fixed text. */
function fakeAi(over: Partial<BoardAsk> = {}): BoardAsk {
  return {
    place: "diagram:checkout",
    version: 1,
    preview: async (q: string, opts: AskOptions) =>
      noOutline ? null : aiDiagramPreview({ requestId: "r", file: "checkout", text: "diagram dfd", outline: { kind: "dfd", nodes: [], links: [] } as never, question: q, scope: { kind: "whole" }, threadId: null, model: opts.model, picks: opts.picks }),
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
    ...over,
  } as unknown as BoardAsk;
}

function show(ai: BoardAsk) {
  return render(<DiagramAssistant ai={ai} name="checkout" kind="dfd" selected={[]} mode="review" onMode={() => {}} onShowText={() => {}} onUndo={() => {}} />);
}

const box = () => screen.getByRole("textbox", { name: "Describe a change" }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const previews = () => callsTo("ai_diagram_preview").map((c) => (c.request as DiagramAskRequest).question);
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const rows = () => [...document.querySelectorAll(".sends-item .send-pill")].map((p) => p.textContent);

test("sends_refresh_is_debounced_300ms", async () => {
  show(fakeAi());
  await advance(300);
  expect(previews()).toEqual([""]);
  type("Add a");
  await advance(150);
  type("Add a fraud check");
  await advance(299);
  // Two changes within 300 ms, and nothing before the last one settles.
  expect(previews()).toEqual([""]);
  await advance(1);
  expect(previews()).toEqual(["", "Add a fraud check"]);
  expect(rows()).toEqual(["Question", "checkout.flow"]);
});

test("sends_refresh_when_only_the_sketch_selection_changes", async () => {
  const props = { name: "checkout", kind: "dfd" as const, selected: [], mode: "review" as const, onMode: () => {}, onShowText: () => {}, onUndo: () => {} };
  const ai = fakeAi();
  const view = render(<DiagramAssistant ai={ai} {...props} sketches={[]} />);
  await advance(300);
  expect(previews()).toEqual([""]);
  // A sketch is selected: shapes did not change, the Sends line is built again, and the chip counts it.
  view.rerender(<DiagramAssistant ai={ai} {...props} sketches={["s1"]} />);
  expect(document.querySelector(".ask-chip-selection")?.textContent).toBe("1 selected");
  await advance(299);
  expect(previews()).toEqual([""]);
  await advance(1);
  expect(previews()).toEqual(["", ""]);
  // A different sketch of the same count is another selection.
  view.rerender(<DiagramAssistant ai={ai} {...props} sketches={["s2"]} />);
  await advance(300);
  expect(previews()).toEqual(["", "", ""]);
});

test("unmounting_with_a_pending_preview_sends_nothing", async () => {
  const view = show(fakeAi());
  await advance(300);
  type("Add a fraud check");
  await advance(200);
  view.unmount();
  await advance(500);
  expect(previews()).toEqual([""]);
});

test("no_preview_while_an_ask_runs", async () => {
  const view = show(fakeAi({ working: { q: "Add a fraud check", askedAt: 1, status: null, steps: [] } }));
  await advance(1000);
  expect(previews()).toEqual([]);
  // The Ask ends: the Sends line is built again.
  view.rerender(<DiagramAssistant ai={fakeAi()} name="checkout" kind="dfd" selected={[]} mode="review" onMode={() => {}} onShowText={() => {}} onUndo={() => {}} />);
  await advance(300);
  expect(previews()).toEqual([""]);
});

test("a_failed_preview_shows_why_and_drops_the_rows", async () => {
  show(fakeAi());
  await advance(300);
  expect(rows()).toEqual(["Question", "checkout.flow"]);
  previewError = { kind: "ai", message: { kind: "tooLarge" } };
  type("Add a fraud check");
  await advance(300);
  expect(rows()).toEqual([]);
  expect(screen.getByText("This Ask is over the size this model accepts, even after trimming.")).toBeTruthy();
});

test("no_outline_drops_the_rows", async () => {
  show(fakeAi());
  await advance(300);
  expect(rows()).toEqual(["Question", "checkout.flow"]);
  noOutline = true;
  type("Add a fraud check");
  await advance(300);
  expect(rows()).toEqual([]);
});

test("unreadable_settings_say_so", async () => {
  routeInvoke({
    ai_known_models: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    ai_settings: () => {
      throw { kind: "io", message: "the store is locked" };
    },
    ai_diagram_preview: (a) => previewOf(a.request as DiagramAskRequest),
  });
  show(fakeAi());
  await advance(0);
  expect(screen.getAllByRole("alert").filter((a) => a.textContent!.startsWith("Could not read the AI settings. "))).toHaveLength(1);
});

test("a_board_sends_one_row_per_frame_with_its_fit", async () => {
  const frame = (label: string, bytes: number, fit: string) => ({ kind: "diagram" as const, label, bytes, tokens: 1, locked: LOCK, on: true, fit });
  routeInvoke({
    ai_known_models: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
    ai_settings: () => ({ settings: { ...GROQ, diagramTool: true }, groupOverride: false, keySaved: true, keyLast4: "abcd" }),
    ai_diagram_preview: (a) => {
      const p = previewOf(a.request as DiagramAskRequest);
      return {
        ...p,
        items: [
          p.items[0],
          { kind: "diagram", label: "Board", bytes: 300, tokens: 90, locked: LOCK, on: true },
          frame('"Checkout" (flow)', 120, "in full"),
          frame('"Orders" (er)', 40, "names only: over the budget"),
          frame('"Archive" (flow)', 0, "left out: over the budget"),
        ],
      };
    },
  });
  show(fakeAi());
  await advance(300);
  expect(rows()).toEqual(["Question", "Board", '"Checkout" (flow)', '"Orders" (er)', '"Archive" (flow)']);
  const fits = [...document.querySelectorAll(".sends-item")].map((li) => li.querySelector(".sends-fit")?.textContent ?? null);
  expect(fits).toEqual([null, null, "in full", "names only: over the budget", "left out: over the budget"]);
  // The Board row's size is what the board sends: every diagram row together.
  const board = document.querySelectorAll(".sends-item")[1];
  expect(board.querySelector(".sends-size:not(.sends-fit)")?.textContent).toBe("460 B");
});

test("a_held_source_shows_its_sentence_in_sends", async () => {
  // The Core refuses the preview of a board with a frame drawn from a Never Connection. Sends says why, and
  // shows no rows, so nothing of the held frame's schema is listed.
  const message = 'The frame "Orders ERD" was drawn from prod, whose AI access is Never, so this Ask was not sent. Remove the frame or change that Connection\'s AI access.';
  show(fakeAi());
  await advance(300);
  expect(rows()).toEqual(["Question", "checkout.flow"]);
  previewError = { kind: "ai", message: { kind: "diagramHeld", message } };
  type("What does Orders hold?");
  await advance(300);
  expect(rows()).toEqual([]);
  expect(screen.getByText(message)).toBeTruthy();
});
