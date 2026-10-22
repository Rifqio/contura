// The diagram assistant's Sends line (board 11.12, controller ruling 2): the Core's preview, 300 ms after the last
// change, never while an Ask runs, and no rows that belong to another text.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { aiDiagramPreview } from "../../api/client";
import type { DiagramAskRequest, Preview } from "../../api/types";
import { callsTo, routeInvoke } from "../../test/invoke";
import { GROQ } from "../../test/settingsRoutes";
import DiagramAssistant from "./DiagramAssistant";
import type { AskOptions, DiagramAsk } from "./useDiagramAsk";

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
function fakeAi(over: Partial<DiagramAsk> = {}): DiagramAsk {
  return {
    place: "diagram:checkout",
    version: 1,
    preview: async (q: string, opts: AskOptions) =>
      noOutline ? null : aiDiagramPreview({ requestId: "r", file: "checkout", text: "diagram dfd", outline: { kind: "dfd", nodes: [], links: [] } as never, question: q, scope: opts.scope, threadId: null, model: opts.model, picks: opts.picks }),
    thread: null,
    working: null,
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
    send: async () => {},
    stop: () => {},
    ...over,
  } as unknown as DiagramAsk;
}

function show(ai: DiagramAsk) {
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
  const view = show(fakeAi({ working: { q: "Add a fraud check", askedAt: 1, text: "", status: null, steps: [] } }));
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
