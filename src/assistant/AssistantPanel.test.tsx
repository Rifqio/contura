import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { AiAccess, AiError, AiEvent, AiSettings, AiSettingsView, AiThread, AnswerRecord, AskRequest, Compaction, CompactRequest, ContextInfo, ModelList, ModelPicks, SqlBlock, Topic } from "../api/types";
import type { SqlEditorApi } from "../query/SqlEditor";
import { splitStatements, statementAt } from "../query/statements";
import { iconElement, type IconName } from "../components/Icon";
import { fakePreview } from "../test/aiPreview";
import { aiStream, delta, done, failed, line, memory, sent, sentRecord, step } from "../test/aiStream";
import { summaryOf, viewOf } from "../test/aiThreads";
import { callsTo, routeInvoke } from "../test/invoke";
import { modelInfo, modelList } from "../test/settingsRoutes";
import { useCommandKeys } from "../commands/useCommandKeys";
import AssistantPanel, { meterParts } from "./AssistantPanel";
import type { AskContext } from "./context";
import { threadsCleared } from "./threadsCleared";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

const none: AiSettings = {
  provider: null,
  preset: null,
  baseUrl: "",
  model: "",
  temperature: null,
  maxTokens: null,
  inlineAsk: true,
  errorAsk: true,
  newConnectionAccess: "schema",
  defaultThinking: "medium",
  promptCaching: true,
  shareThinking: true,
  keepExactText: false,
  pickTables: true,
  modelPrefs: {},
};
const groq: AiSettings = {
  ...none,
  provider: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.3-70b-versatile",
};
const view = (settings: AiSettings): AiSettingsView => ({
  settings,
  groupOverride: false,
  keySaved: settings.provider !== null,
  keyLast4: settings.provider ? "abcd" : null,
});

const ctx = (access: AiAccess, name = "Shop"): AskContext => ({
  kind: "sql",
  connection: { id: "c1", name, dialect: "postgres", database: "shop", access },
  sql: "SELECT * FROM orders",
  lines: [1, 1],
  tables: [{ schema: "public", name: "orders" }],
  label: "Selected SQL",
});

const schema = {
  tables: [
    {
      schema: "public",
      name: "orders",
      kind: "table" as const,
      columns: [{ name: "id", typeName: "bigint", pk: true, nullable: false }],
    },
  ],
  fks: [],
} as never;

const thread = (id: string, place: string, title: string, updatedAt: number): AiThread => ({
  id,
  place,
  title,
  updatedAt,
  messages: [{ role: "user", text: title, context: [], at: updatedAt }],
});

let threads: AiThread[] = [];
let settings: AiSettings = none;
/** The Core refuses to start the Ask with this, when set. */
let askError: AiError | null = { kind: "notConfigured" };
/** The events of each Ask the Core starts. */
let reply: (r: AskRequest, n: number) => AiEvent[] = () => [delta("Use an index."), done()];
let stream = aiStream();
/** Locks every preview item but the question, with this reason. */
let lockAll: string | null = null;
/** Adds the Core's "Literal values" item, on when the request's switch is. */
let withValues = false;
/** The Core read no rows: the merged item says no table is named. */
let noRows: string | false = false;
/** What `ai_known_models` returns; `set_ai_model_prefs` updates it as the Core does. */
let known: ModelList = modelList([]);
/** What `ai_confirm_key_host` does; throwing makes it reject. */
let confirmKeyHost: () => void = () => {};
/** What `ai_cancel_place` does. */
let cancelPlace: (a: Record<string, unknown>) => boolean = () => true;
/** `set_ai_model_prefs` rejects while this is set. */
let pickFails = false;

beforeEach(() => {
  threads = [];
  settings = none;
  askError = { kind: "notConfigured" };
  reply = () => [delta("Use an index."), done()];
  stream = aiStream((r, n) => reply(r, n));
  lockAll = null;
  withValues = false;
  noRows = false;
  known = modelList([]);
  confirmKeyHost = () => {};
  pickFails = false;
  cancelPlace = () => true;
  routeInvoke(handlersNow());
});

function handlersNow(): Record<string, (a: Record<string, unknown>) => unknown> {
  return {
    ai_confirm_key_host: () => confirmKeyHost(),
    ai_known_models: () => known,
    set_ai_model_prefs: (a) => {
      if (pickFails) throw new Error("The settings file is locked.");
      const picks = a.picks as ModelPicks;
      known = { ...known, current: a.model as string, models: known.models.map((m) => (m.id === a.model ? { ...m, picks } : m)) };
    },
    ai_settings: () => view(settings),
    ai_preview: (a) => {
      const r = a.request as AskRequest;
      const p = fakePreview(r, lockAll);
      if (noRows) {
        // A failed read or a closed Connection keeps the label; only "no named table" changes it.
        const none = noRows.startsWith("Sample rows go only");
        p.items = p.items.map((i) => (i.kind === "rows" && i.on ? { ...i, label: none ? "Sample rows · no named table" : i.label, bytes: 0, tokens: 0 } : i));
        p.rows = null;
        p.notes = [noRows];
      }
      if (withValues) p.items.push({ kind: "values", label: "Literal values", bytes: 0, tokens: 0, locked: null, on: r.switches.values });
      return p;
    },
    list_ai_threads: (a) => threads.filter((t) => t.place === a.place).map(summaryOf),
    get_ai_thread: (a) => {
      const t = threads.find((x) => x.id === a.threadId);
      return t ? viewOf(t) : null;
    },
    ai_answer_record: () => null,
    ai_search_threads: () => [],
    delete_ai_thread: (a) => {
      threads = threads.filter((t) => t.id !== a.id);
    },
    save_ai_thread: (a) => viewOf(a.thread as AiThread),
    clear_ai_threads: (a) => {
      threads = threads.filter((t) => t.place !== a.place);
    },
    ai_ask_stream: (a) => {
      if (askError) throw { kind: "ai", message: askError };
      return stream.handler(a);
    },
    ai_cancel: () => true,
    ai_cancel_place: (a) => cancelPlace(a),
    ai_record_action: (a: Record<string, unknown>) => ({ kind: a.kind, at: 5 }),
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof AssistantPanel>> = {}) {
  const onOpenSettings = vi.fn();
  const utils = render(
    <AssistantPanel
      place="ungrouped"
      groupId={null}
      context={ctx("schemaQueryRows")}
      schema={schema}
      onOpenSettings={onOpenSettings}
      {...props}
    />,
  );
  return { onOpenSettings, ...utils };
}

test("clearing_ai_history_in_settings_empties_an_open_panel", async () => {
  threads = [thread("t1", "ungrouped", "Why is it slow?", 5)];
  renderPanel();
  expect((await screen.findAllByText("Why is it slow?")).length).toBeGreaterThan(0);
  // Another place's clear leaves this one alone.
  act(() => threadsCleared("group:g1"));
  expect(screen.queryAllByText("Why is it slow?").length).toBeGreaterThan(0);
  threads = [];
  act(() => threadsCleared("ungrouped"));
  await waitFor(() => expect(screen.queryAllByText("Why is it slow?")).toHaveLength(0));

  // Clear all AI data clears every place.
  cleanup();
  threads = [thread("t2", "group:g1", "Who bought most?", 6)];
  renderPanel({ place: "group:g1", groupId: "g1" });
  expect((await screen.findAllByText("Who bought most?")).length).toBeGreaterThan(0);
  threads = [];
  act(() => threadsCleared(null));
  await waitFor(() => expect(screen.queryAllByText("Who bought most?")).toHaveLength(0));
});

const previews = () => callsTo("ai_preview").map((c) => c.request as AskRequest);
const lastPreview = () => previews()[previews().length - 1];
const askSent = () => callsTo("ai_ask_stream")[0].request as AskRequest;

/** Waits for the first preview, then opens "Show exactly". */
async function showExactly(user: ReturnType<typeof userEvent.setup>) {
  const button = (await screen.findByRole("button", { name: "Show exactly" })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await user.click(button);
}

function Harness() {
  const [open, setOpen] = useState(false);
  useCommandKeys({ "assistant.toggle": () => setOpen((o) => !o) });
  return <p>{open ? "open" : "closed"}</p>;
}

test("ctrl_alt_i_toggles_the_panel", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(screen.getByText("closed")).toBeTruthy();
  await user.keyboard("{Control>}{Alt>}i{/Alt}{/Control}");
  expect(screen.getByText("open")).toBeTruthy();
  await user.keyboard("{Control>}{Alt>}i{/Alt}{/Control}");
  expect(screen.getByText("closed")).toBeTruthy();
});

test("ctrl_alt_i_ignores_an_open_dialog", async () => {
  const user = userEvent.setup();
  render(
    <>
      <Harness />
      <div role="dialog" aria-modal="true" />
    </>,
  );
  await user.keyboard("{Control>}{Alt>}i{/Alt}{/Control}");
  expect(screen.getByText("closed")).toBeTruthy();
});

test("the_preview_is_asked_for_with_the_context", async () => {
  renderPanel();
  await waitFor(() => expect(previews().length).toBeGreaterThan(0));
  const r = lastPreview();
  expect(r.connectionId).toBe("c1");
  expect(r.database).toBe("shop");
  expect(r.focus.sql).toBe("SELECT * FROM orders");
  expect(r.focus.tables).toEqual([{ schema: "public", name: "orders" }]);
  expect(r.off).toEqual([]);
  expect(r.place).toBe("ungrouped");
});

test("sends_items_can_be_switched_off_and_stay_off_while_typing", async () => {
  const user = userEvent.setup();
  settings = groq;
  const { rerender } = renderPanel();
  const statement = async () => screen.findByRole("button", { name: /^the current statement/ });
  expect((await statement()).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "schema of 1 table" })).toBeTruthy();
  await showExactly(user);
  expect(screen.getByText(/SELECT \* FROM orders/, { selector: "pre" })).toBeTruthy();
  await user.click(await statement());
  await waitFor(() => expect(lastPreview().off).toEqual(["sql"]));
  await waitFor(() => expect(screen.queryByText(/SELECT \* FROM orders/)).toBeNull());
  expect((await statement()).getAttribute("aria-pressed")).toBe("false");

  // Typing more SQL must not switch it back on.
  const edited = { ...ctx("schemaQueryRows"), sql: "SELECT * FROM orders WHERE id = 1" };
  rerender(
    <AssistantPanel place="ungrouped" groupId={null} context={edited} schema={schema} onOpenSettings={() => {}} />,
  );
  await waitFor(() => expect(lastPreview().focus.sql).toBe("SELECT * FROM orders WHERE id = 1"));
  expect(lastPreview().off).toEqual(["sql"]);
  expect((await statement()).getAttribute("aria-pressed")).toBe("false");
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(askSent().off).toEqual(["sql"]);
  expect(askSent().question).toBe("why slow?");
});

test("a_seeded_question_uses_the_connections_current_access", async () => {
  const user = userEvent.setup();
  settings = groq;
  const live = {
    id: "c1",
    name: "Shop",
    dialect: "postgres",
    host: "h",
    port: 1,
    user: "u",
    database: null,
    ssl: { mode: "disable" },
    groupId: null,
    file: null,
    queryTimeoutSecs: null,
    aiAccess: "never",
    production: false,
    readOnly: false,
  } as never;
  renderPanel({
    context: null,
    seed: { question: "why slow?", context: ctx("schemaQuery") },
    connections: [live],
  });
  await screen.findByText("AI can't see Shop");
  await user.type(screen.getByRole("textbox", { name: "Message" }), "{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(askSent().question).toBe("why slow?");
  expect(askSent().connectionId).toBe("c1");
});

test("show_exactly_reveals_the_payload", async () => {
  const user = userEvent.setup();
  settings = groq;
  const first = renderPanel();
  await showExactly(user);
  expect(await screen.findByText(/To api\.groq\.com \(llama-3\.3-70b-versatile\)/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Hide" }));
  expect(screen.queryByText(/To api\.groq\.com/)).toBeNull();
  first.unmount();

  settings = none;
  renderPanel();
  await showExactly(user);
  expect(screen.getByText(/Nothing is sent until a provider is set\./)).toBeTruthy();
});

test("include_values_is_off_again_after_each_ask", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  withValues = true;
  renderPanel();
  const values = async () => screen.findByRole("button", { name: /^Literal values/ });
  expect((await values()).getAttribute("aria-pressed")).toBe("false");
  await user.click(await values());
  await waitFor(() => expect(lastPreview().switches.values).toBe(true));
  await waitFor(async () => expect((await values()).getAttribute("aria-pressed")).toBe("true"));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(askSent().switches.values).toBe(true);
  await screen.findByText("Use an index.");

  // The next question in the same thread starts with values off again.
  await waitFor(() => expect(lastPreview().switches.values).toBe(false));
  expect((await values()).getAttribute("aria-pressed")).toBe("false");
  await user.type(screen.getByRole("textbox", { name: "Message" }), "and now?{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  expect((callsTo("ai_ask_stream")[1].request as AskRequest).switches.values).toBe(false);
});

test("asking_without_a_provider_shows_the_setup_card", async () => {
  const user = userEvent.setup();
  const { onOpenSettings } = renderPanel();
  await user.type(await screen.findByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  expect(await screen.findByText("Connect an AI provider in Settings")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Connect a provider" }));
  expect(onOpenSettings).toHaveBeenCalled();
  expect(callsTo("save_ai_thread")).toHaveLength(0);
});

test("asking_with_a_provider_saves_the_thread", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  renderPanel();
  await waitFor(() => expect(callsTo("ai_settings")).toHaveLength(1));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  expect(await screen.findByText("Use an index.")).toBeTruthy();
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  const saved = callsTo("save_ai_thread")[0].thread as AiThread;
  // The Ask's id goes with the save, so the Core writes the AI Context it used.
  expect(callsTo("save_ai_thread")[0].requestId).toBe((callsTo("ai_ask_stream")[0].request as AskRequest).requestId);
  expect(saved.place).toBe("ungrouped");
  expect(saved.messages.map((m) => [m.role, m.text])).toEqual([
    ["user", "why slow?"],
    ["assistant", "Use an index."],
  ]);
});

/** Starts an Ask with a held stream, so the test feeds the events. */
async function askHeld(
  user: ReturnType<typeof userEvent.setup>,
  q = "why slow?",
  props: Partial<React.ComponentProps<typeof AssistantPanel>> = {},
) {
  settings = groq;
  askError = null;
  stream.hold();
  const utils = renderPanel(props);
  await waitFor(() => expect(callsTo("ai_settings")).toHaveLength(1));
  await user.type(screen.getByRole("textbox", { name: "Message" }), `${q}{Enter}`);
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  return utils;
}

const lastSaved = () => {
  const calls = callsTo("save_ai_thread");
  return calls[calls.length - 1].thread as AiThread;
};

test("deltas_render_in_order", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit({ type: "status", step: "Writing" });
  expect(screen.getByText("Writing")).toBeTruthy();
  stream.emit(delta("Add an "));
  expect(screen.getByText("Add an")).toBeTruthy();
  stream.emit(delta("index on "), delta("created_at."));
  expect(screen.getByText("Add an index on created_at.")).toBeTruthy();
  // The question shows while the answer is written, and Send turns into Stop.
  expect(screen.getByText("why slow?", { selector: ".msg-user" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(callsTo("save_ai_thread")).toHaveLength(0);
  stream.emit(done());
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  expect(lastSaved().messages.map((m) => m.text)).toEqual(["why slow?", "Add an index on created_at."]);
  expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
});

test("stop_keeps_partial_marked_stopped", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit(delta("Half an"));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  const id = (callsTo("ai_ask_stream")[0].request as AskRequest).requestId;
  await waitFor(() => expect(callsTo("ai_cancel")).toEqual([{ requestId: id }]));
  expect(await screen.findByText("Stopped")).toBeTruthy();
  expect(screen.getByText("Half an")).toBeTruthy();
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  expect(lastSaved().messages.map((m) => [m.role, m.text])).toEqual([
    ["user", "why slow?"],
    ["assistant", "Half an"],
  ]);
});

test("error_card_keeps_partial_and_retries", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  reply = () => [delta("Partly written"), failed({ kind: "network", host: "api.groq.com" }, true)];
  renderPanel();
  await waitFor(() => expect(callsTo("ai_settings")).toHaveLength(1));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  expect(await screen.findByText("Could not reach api.groq.com.")).toBeTruthy();
  expect(screen.getByText("Partly written")).toBeTruthy();
  expect(screen.queryByText("Try 2")).toBeNull();
  // Saved once, with the partial answer.
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  expect(lastSaved().messages.map((m) => m.text)).toEqual(["why slow?", "Partly written"]);

  reply = () => [failed({ kind: "network", host: "api.groq.com" })];
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  expect((callsTo("ai_ask_stream")[1].request as AskRequest).question).toBe("why slow?");
  expect(await screen.findByText("Try 2")).toBeTruthy();
  expect(screen.getByText("Could not reach api.groq.com.")).toBeTruthy();

  // A retry that works replaces the failed turn instead of repeating the question.
  reply = () => [delta("Use an index."), done()];
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Use an index.")).toBeTruthy();
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(2));
  expect(lastSaved().messages.map((m) => m.text)).toEqual(["why slow?", "Use an index."]);
  expect(screen.queryByText("Could not reach api.groq.com.")).toBeNull();
});

test("sent_line_counts_both_calls", async () => {
  const user = userEvent.setup();
  const now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 19, 11, 42, 30).getTime());
  try {
    await askHeld(user);
    const outline = { bytes: 1204, tokens: 344, hash: "aa11bb22cc33dd44", pickedAreas: 1, pickedTables: 6, dropped: 0, usage: null, exact: null, left: true };
    stream.emit(sent({ model: "llama-3.3-70b-versatile", outlineCall: true, outline }), delta("Use an index."));
    stream.emit(done());
    expect(await screen.findByText("11:42 · Sent 3,518 B to Groq, llama-3.3-70b-versatile, 1.9s")).toBeTruthy();
  } finally {
    now.mockRestore();
  }
});

test("picking_tables_status_shows", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit({ type: "status", step: "Picking tables" });
  expect(screen.getByText("Picking tables")).toBeTruthy();
});

test("done_shows_sent_line", async () => {
  const user = userEvent.setup();
  // The line reads the answer's saved time.
  const now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 19, 11, 42, 30).getTime());
  try {
    await askHeld(user);
    stream.emit(sent({ model: "llama-3.3-70b-versatile" }), delta("Use an index."));
    stream.emit(done());
    expect(await screen.findByText("11:42 · Sent 2,314 B to Groq, llama-3.3-70b-versatile, 1.9s")).toBeTruthy();
  } finally {
    now.mockRestore();
  }
});

test("length_stop_shows_mark_and_continue", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit(delta("The first half"), done({ stop: "length" }));
  // The mark in the answer says it once; the card's kicker names the cap.
  expect(await screen.findAllByText("Length limit")).toHaveLength(1);
  expect(document.querySelector(".errc-kick")?.textContent).toBe("Output limit");
  expect(screen.getByText("The answer reached its length limit.")).toBeTruthy();
  expect(screen.getByText("It stopped at 120 output tokens. Continue asks the model to carry on from the last word.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
});

test("continue_asks_with_the_continue_action", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit(delta("The first half"), done({ stop: "length" }));
  const button = await screen.findByRole("button", { name: "Continue" });
  await user.click(button);
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  const [first, second] = callsTo("ai_ask_stream").map((c) => c.request as AskRequest);
  expect(second).toMatchObject({ action: "continue", question: "Continue", threadId: lastSaved().id });
  expect(first.action).toBe("ask");
  // The user bubble says "Continue" in the muted text.
  const bubble = await screen.findByText("Continue", { selector: ".msg-user" });
  expect(bubble.className).toContain("msg-user-muted");
  stream.emit(delta(" and the second."), done());
  // Only the last turn offers Continue: the finished answer has none.
  await screen.findByText(/and the second\./);
  expect(screen.getAllByText("Continue", { selector: ".msg-user" })[0].className).toContain("msg-user-muted");
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
});

test("other_stops_are_marked", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit(delta("Not this one"), done({ stop: "refusal" }));
  expect(await screen.findByText("The model declined to answer this.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit the question" })).toBeTruthy();
  await user.type(screen.getByRole("textbox", { name: "Message" }), "again{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  stream.emit(delta("Cut"), done({ stop: "dropped" }));
  expect(await screen.findByText("The connection dropped mid answer.")).toBeTruthy();
  expect(screen.getByText("Cut off")).toBeTruthy();
  expect(screen.getByText("The part above is kept and marked. The SQL never arrived, so there is nothing to insert.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry the answer" })).toBeTruthy();
  await user.type(screen.getByRole("textbox", { name: "Message" }), "long{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(3));
  stream.emit(delta("Lots"), done({ stop: "tooLong" }));
  expect(await screen.findByText("Stopped: the answer was too long")).toBeTruthy();
});

test("a_busy_place_shows_its_card", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = { kind: "busy" };
  renderPanel();
  await waitFor(() => expect(callsTo("ai_settings")).toHaveLength(1));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  expect(await screen.findByText("An answer is still being written. Stop it first.")).toBeTruthy();
  expect(callsTo("save_ai_thread")).toHaveLength(0);
});

test("busy_stop_it_cancels_the_place", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = { kind: "busy" };
  renderPanel();
  await waitFor(() => expect(callsTo("ai_settings")).toHaveLength(1));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  const stop = await screen.findByRole("button", { name: "Stop it" });
  askError = null;
  await user.click(stop);
  await waitFor(() => expect(callsTo("ai_cancel_place")).toEqual([{ place: "ungrouped" }]));
  // The waiting question goes out once the place is free.
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  expect((callsTo("ai_ask_stream")[1].request as AskRequest).question).toBe("why slow?");
  expect(await screen.findByText("Use an index.")).toBeTruthy();
});

test("busy_stop_it_failure_is_shown", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = { kind: "busy" };
  cancelPlace = () => {
    throw new Error("The Core is not answering.");
  };
  renderPanel();
  await waitFor(() => expect(callsTo("ai_settings")).toHaveLength(1));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await user.click(await screen.findByRole("button", { name: "Stop it" }));
  expect(await screen.findByText(/The Core is not answering\./)).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(1);
});

test("enter_while_writing_asks_to_stop_first", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  await user.type(screen.getByRole("textbox", { name: "Message" }), "next one{Enter}");
  expect(screen.getByText("Stop the current answer?")).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Stop it" }));
  await waitFor(() => expect(callsTo("ai_cancel")).toHaveLength(1));
});

test("panel_close_cancels", async () => {
  const user = userEvent.setup();
  const { unmount } = await askHeld(user);
  stream.emit(delta("Half"));
  unmount();
  const id = (callsTo("ai_ask_stream")[0].request as AskRequest).requestId;
  await waitFor(() => expect(callsTo("ai_cancel")).toEqual([{ requestId: id }]));
});

test("changing_place_cancels", async () => {
  const user = userEvent.setup();
  const { rerender } = await askHeld(user);
  rerender(<AssistantPanel place="group:g2" groupId="g2" context={null} schema={null} onOpenSettings={() => {}} />);
  await waitFor(() => expect(callsTo("ai_cancel")).toHaveLength(1));
});

test("panel_says_what_it_cannot_see", async () => {
  const user = userEvent.setup();
  settings = groq;
  lockAll = "Shop prod shares nothing with AI";
  renderPanel({ context: ctx("never", "Shop prod") });
  expect(await screen.findByText("AI can't see Shop prod")).toBeTruthy();
  expect(
    screen.getByText(
      "Shop prod shares nothing with AI, so no schema, SQL or rows are sent. You can still ask general questions.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connection settings" })).toBeTruthy();
  const statement = await screen.findByRole("button", { name: /^the current statement/ });
  expect(statement.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("your question")).toBeTruthy();
  expect(screen.getAllByText("Shop prod shares nothing with AI").length).toBeGreaterThan(0);
  await showExactly(user);
  expect(screen.queryByText(/SELECT|orders/)).toBeNull();
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(askSent().question).toBe("why slow?");
});

test("rows_pill_toggles_when_allowed", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  renderPanel();
  const rows = async () => screen.findByRole("button", { name: /^Sample rows/ });
  expect((await rows()).getAttribute("aria-pressed")).toBe("false");
  expect((await rows()).textContent).toBe("Sample rows · off");
  await user.click(await rows());
  await waitFor(() => expect(lastPreview().switches.rows).toBe(true));
  await waitFor(async () => expect((await rows()).getAttribute("aria-pressed")).toBe("true"));
  expect((await rows()).textContent).toBe("Sample rows · 2 tables");
  expect(screen.getByText("643 B, about 161 tokens")).toBeTruthy();
});

test("rows_pill_locked_below_rows_level", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  lockAll = "Shop shares schema only";
  renderPanel({ context: ctx("schemaQuery") });
  const rows = await screen.findByRole("button", { name: /^Sample rows/ });
  expect(rows.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getAllByText("Shop shares schema only").length).toBeGreaterThan(0);
  const before = previews().length;
  await user.click(rows);
  expect(lastPreview().switches.rows).toBe(false);
  expect(previews()).toHaveLength(before);
});

test("rows_switch_off_after_send", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  renderPanel();
  await user.click(await screen.findByRole("button", { name: /^Sample rows/ }));
  await waitFor(() => expect(lastPreview().switches.rows).toBe(true));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "one{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(askSent().switches.rows).toBe(true);
  await screen.findByText("Use an index.");
  await waitFor(() => expect(lastPreview().switches.rows).toBe(false));
  expect((await screen.findByRole("button", { name: /^Sample rows/ })).getAttribute("aria-pressed")).toBe("false");
  await user.type(screen.getByRole("textbox", { name: "Message" }), "two{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  expect((callsTo("ai_ask_stream")[1].request as AskRequest).switches.rows).toBe(false);
});

test("rows_switch_resets_on_new_context", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  const { rerender } = renderPanel();
  await user.click(await screen.findByRole("button", { name: /^Sample rows/ }));
  await waitFor(() => expect(lastPreview().switches.rows).toBe(true));
  rerender(<AssistantPanel place="ungrouped" groupId={null} context={ctx("schemaQuery")} schema={schema} onOpenSettings={vi.fn()} />);
  await waitFor(() => expect(lastPreview().switches.rows).toBe(false));
});

test("foot_line_follows_rows", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  renderPanel();
  const foot = () => document.querySelector(".comp-sub")!.textContent;
  await screen.findByRole("button", { name: /^Sample rows/ });
  expect(foot()).toBe("No sample rows are sent");
  await user.click(screen.getByRole("button", { name: /^Sample rows/ }));
  await waitFor(() => expect(foot()).toBe("Sends 10 sample rows from 2 tables, not kept"));
});

test("foot_line_after_a_failed_read_or_a_closed_connection_does_not_say_no_table_is_named", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  noRows = "Could not read sample rows from orders.";
  renderPanel();
  await user.click(await screen.findByRole("button", { name: /^Sample rows/ }));
  await waitFor(() => expect(screen.getByText("Could not read sample rows from orders.")).toBeTruthy());
  expect(document.querySelector(".comp-sub")!.textContent).toBe("No sample rows are sent");
});

test("foot_line_with_a_closed_connection", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  noRows = "Sample rows need the Connection open.";
  renderPanel();
  await user.click(await screen.findByRole("button", { name: /^Sample rows/ }));
  await waitFor(() => expect(screen.getByText("Sample rows need the Connection open.")).toBeTruthy());
  expect(document.querySelector(".comp-sub")!.textContent).toBe("No sample rows are sent");
});

test("foot_line_says_no_table_is_named", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  noRows = "Sample rows go only for tables named in the editor or the question, or open in a tab.";
  renderPanel();
  await user.click(await screen.findByRole("button", { name: /^Sample rows/ }));
  await waitFor(() => expect(document.querySelector(".comp-sub")!.textContent).toBe("No sample rows are sent: no table is named"));
  expect(screen.getByText("Sample rows go only for tables named in the editor or the question, or open in a tab.")).toBeTruthy();
});

const openHistory = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: "Show history" }));

test("threads_follow_the_group", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "group:g1", "Group one chat", 1), thread("b", "group:g2", "Group two chat", 2)];
  const { rerender } = renderPanel({ place: "group:g1", groupId: "g1", context: ctx("schema", "One DB") });
  await screen.findByText("Group one chat", { selector: ".msg-user" });
  expect(await screen.findByRole("button", { name: "schema of 1 table" })).toBeTruthy();
  rerender(
    <AssistantPanel place="group:g2" groupId="g2" context={null} schema={null} onOpenSettings={() => {}} />,
  );
  await screen.findByText("Group two chat", { selector: ".msg-user" });
  expect(screen.queryByText("Group one chat")).toBeNull();
  await waitFor(() => expect(screen.queryByRole("button", { name: /schema of/ })).toBeNull());
  await openHistory(user);
  expect(screen.getByRole("button", { name: /Group two chat/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Group one chat/ })).toBeNull();
});

test("header_has_new_chat_history_close", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  renderPanel({ context: ctx("schemaQuery"), onClose });
  const head = document.querySelector(".ai-panel-head") as HTMLElement;
  expect(within(head).getByText("Ask")).toBeTruthy();
  expect(within(head).getByText("Schema and query text")).toBeTruthy();
  const buttons = within(head).getAllByRole("button");
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["New chat", "Show history", "Close the Ask panel"]);
  expect(buttons.map((b) => b.getAttribute("title"))).toEqual(["New chat  Ctrl+Shift+N", "Show history", "Close  Ctrl+Alt+I"]);
  await user.click(within(head).getByRole("button", { name: "Close the Ask panel" }));
  expect(onClose).toHaveBeenCalled();
  expect(within(head).queryByRole("combobox")).toBeNull();
});

test("new_chat_button_and_history_rows", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1), thread("b", "ungrouped", "Newer chat", 2)];
  renderPanel();
  await screen.findByText("Newer chat", { selector: ".msg-user" });
  await openHistory(user);
  await user.click(screen.getByRole("button", { name: /Old chat/ }));
  expect(await screen.findByText("Old chat", { selector: ".msg-user" })).toBeTruthy();
  expect(screen.queryByText("Newer chat", { selector: ".msg-user" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "New chat" }));
  expect(screen.queryByText("Old chat", { selector: ".msg-user" })).toBeNull();
});

test("ctrl_shift_n_starts_a_new_chat", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1)];
  renderPanel();
  await screen.findByText("Old chat", { selector: ".msg-user" });
  await user.keyboard("{Control>}{Shift>}n{/Shift}{/Control}");
  expect(screen.queryByText("Old chat", { selector: ".msg-user" })).toBeNull();
});

test("loads_summaries_then_the_open_thread", async () => {
  threads = [thread("a", "ungrouped", "Old chat", 1), thread("b", "ungrouped", "Newer chat", 2)];
  renderPanel();
  await screen.findByText("Newer chat", { selector: ".msg-user" });
  expect(callsTo("list_ai_threads")).toEqual([{ place: "ungrouped" }]);
  // Only the open thread is fetched; the other is a summary until it is picked.
  expect(callsTo("get_ai_thread")).toEqual([{ threadId: "b" }]);
});

test("clear_this_chat_deletes_the_open_thread", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1)];
  renderPanel();
  await screen.findByText("Old chat", { selector: ".msg-user" });
  await openHistory(user);
  await user.click(screen.getByRole("button", { name: "Clear this chat" }));
  expect(callsTo("delete_ai_thread")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("delete_ai_thread")).toEqual([{ id: "a" }]));
  expect(screen.queryByText("Old chat", { selector: ".msg-user" })).toBeNull();
});

test("clear_all_chats_clears_the_place", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1)];
  renderPanel({ placeName: "Ungrouped" });
  await screen.findByText("Old chat", { selector: ".msg-user" });
  await openHistory(user);
  await user.click(screen.getByRole("button", { name: "Clear all chats in this place..." }));
  await user.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("clear_ai_threads")).toEqual([{ place: "ungrouped" }]));
  expect(screen.queryByText("Old chat", { selector: ".msg-user" })).toBeNull();
});

const fullRecord = (log: string): AnswerRecord => ({
  sent: null,
  usage: null,
  millis: 900,
  stop: "end",
  mark: null,
  error: null,
  sqlBlocks: [],
  notes: [],
  thinking: null,
  log: [{ atMs: 1, level: "info", source: "ask", fields: [["note", log]] }],
  steps: [],
  actions: [],
  context: null,
  commandError: null,
});

test("show_log_of_a_trimmed_record_fetches_it", async () => {
  const user = userEvent.setup();
  let release: (r: AnswerRecord) => void = () => {};
  const t: AiThread = {
    id: "a",
    place: "ungrouped",
    title: "Why?",
    updatedAt: 10,
    messages: [
      { role: "user", text: "Why?", context: [], at: 10 },
      { role: "assistant", text: "Because.", context: [], at: 11, record: { ...fullRecord("x"), log: [], trimmed: true } },
    ],
  };
  threads = [t];
  routeInvoke({
    ...handlersNow(),
    ai_answer_record: () => new Promise((r) => (release = r)),
  });
  renderPanel();
  await user.click(await screen.findByRole("button", { name: "Show log" }));
  expect(await screen.findByText("Loading the log...")).toBeTruthy();
  expect(callsTo("ai_answer_record")).toEqual([{ threadId: "a", messageAt: 11 }]);
  release(fullRecord("the full log line"));
  expect(await screen.findByText(/the full log line/)).toBeTruthy();
  expect(screen.queryByText("Loading the log...")).toBeNull();
});

test("a_failed_fetch_shows_its_text_in_place_of_the_log", async () => {
  const user = userEvent.setup();
  threads = [
    {
      id: "a",
      place: "ungrouped",
      title: "Why?",
      updatedAt: 10,
      messages: [
        { role: "user", text: "Why?", context: [], at: 10 },
        { role: "assistant", text: "Because.", context: [], at: 11, record: { ...fullRecord("x"), trimmed: true } },
      ],
    },
  ];
  routeInvoke({
    ...handlersNow(),
    ai_answer_record: () => {
      throw "The record is gone.";
    },
  });
  renderPanel();
  await user.click(await screen.findByRole("button", { name: "Show log" }));
  expect(await screen.findByText("The record is gone.")).toBeTruthy();
});

test("question_time_under_the_bubble", async () => {
  const at = new Date(2026, 9, 18, 11, 42).getTime();
  threads = [thread("a", "ungrouped", "Old chat", at)];
  renderPanel();
  const q = await screen.findByText("Old chat", { selector: ".msg-user" });
  const ts = q.nextElementSibling as HTMLElement;
  expect(ts.className).toBe("ts");
  expect(ts.textContent).toBe("Oct 18 11:42");
});

test("question_time_says_now_while_the_answer_is_written", async () => {
  const user = userEvent.setup();
  askError = null;
  stream.hold();
  renderPanel();
  await user.type(await screen.findByRole("textbox", { name: "Message" }), "Hello{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit(delta("Partial"));
  const q = await screen.findByText("Hello", { selector: ".msg-user" });
  await waitFor(() => expect((q.nextElementSibling as HTMLElement).textContent).toMatch(/^Today \d\d:\d\d, now$/));
});

test("save_uses_the_returned_view", async () => {
  const user = userEvent.setup();
  askError = null;
  threads = [];
  const stamped = (t: AiThread): AiThread => ({
    ...t,
    title: "Title from the Core",
    messages: t.messages.map((m) => ({ ...m, topic: 3 })),
  });
  routeInvoke({ ...handlersNow(), save_ai_thread: (a) => viewOf(stamped(a.thread as AiThread)) });
  renderPanel();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await user.type(input, "first{Enter}");
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  await user.type(input, "second{Enter}");
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(2));
  const sent = callsTo("save_ai_thread")[1].thread as AiThread;
  // The second save is built on the view the first returned: its stamp is still on the first turn.
  expect(sent.title).toBe("Title from the Core");
  expect(sent.messages.slice(0, 2).map((m) => m.topic)).toEqual([3, 3]);
  await openHistory(user);
  expect(screen.getByRole("button", { name: /Title from the Core/ })).toBeTruthy();
});

test("composer_order_sends_line_input_subline_hint_and_send", async () => {
  renderPanel({ context: ctx("schemaQuery", "kestrel-main") });
  const input = await screen.findByRole("textbox", { name: "Message" });
  expect(input.getAttribute("placeholder")).toBe("Ask about kestrel-main, or type / for commands");
  const sends = screen.getByText("Sends");
  const sub = screen.getByText("No sample rows are sent");
  const hint = screen.getByText("Enter");
  const send = screen.getByRole("button", { name: "Send" });
  const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(before(sends, input)).toBe(true);
  expect(before(input, sub)).toBe(true);
  expect(before(sub, hint)).toBe(true);
  expect(before(hint, send)).toBe(true);
  expect(hint.tagName).toBe("KBD");
});

test("sends_items_have_their_own_icons", async () => {
  renderPanel({ context: ctx("schemaQuery") });
  const iconOf = (el: HTMLElement) => el.querySelector("path")?.getAttribute("d");
  const d = (name: IconName) => iconElement(name).querySelector("path")?.getAttribute("d");
  expect(iconOf(await screen.findByRole("button", { name: "schema of 1 table" }))).toBe(d("table"));
  expect(iconOf(screen.getByRole("button", { name: /^the current statement/ }))).toBe(d("fileQuery"));
  expect(iconOf(screen.getByText("your question").closest(".send-pill") as HTMLElement)).toBe(d("msg"));
});

const FENCED = "Join them:\n```sql\nSELECT id FROM orders\n```\nThat is all.";

/** A query tab's editor holding `doc`, typing at its start. */
function fakeEditor(doc = "") {
  let text = doc;
  const api: SqlEditorApi = {
    text: () => text,
    runTarget: () => statementAt(splitStatements(text, "postgres"), 0),
    select: vi.fn(),
    insert: vi.fn(),
    replaceAll: vi.fn(),
    replaceRange: vi.fn((from: number, to: number, insert: string) => {
      text = text.slice(0, from) + insert + text.slice(to);
    }),
    focus: vi.fn(),
    band: vi.fn(),
  };
  return { api, now: () => text };
}

const answerThread = (): AiThread => ({
  id: "t",
  place: "ungrouped",
  title: "q",
  updatedAt: 1,
  messages: [
    { role: "user", text: "q", context: [], at: 1 },
    { role: "assistant", text: FENCED, context: [], at: 2 },
  ],
});

const ORDERS_BLOCK: SqlBlock = {
  fence: 0,
  label: "1 statement: 1 read",
  statements: [{ text: "SELECT id FROM orders", class: "read", flags: [] }],
};

test("answer_sql_renders_with_insert_open_and_copy", async () => {
  const user = userEvent.setup();
  const ed = fakeEditor("SELECT 1;\n");
  const onOpenInNewTab = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await askHeld(user, "why slow?", { insertTarget: { editor: () => ed.api, name: "Query 1" }, onOpenInNewTab });
  stream.emit(delta(FENCED), done({ sqlBlocks: [ORDERS_BLOCK] }));
  await screen.findByText("1 statement: 1 read");
  const block = screen.getByRole("group", { name: "SQL answer" });
  expect(block.textContent).toContain("SELECT id FROM orders");
  expect(block.querySelector(".sql-block-gutter")).toBeNull();
  expect(screen.getByText("Join them:")).toBeTruthy();
  expect(screen.getByText("That is all.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  expect(screen.getByRole("region", { name: "Insert into the editor" }).textContent).toContain("Replaces line 1 of Query 1");
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(ed.now()).toBe("SELECT id FROM orders;\n");
  expect(screen.getByText("Inserted into the editor")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Copy the SQL" }));
  expect(writeText).toHaveBeenCalledWith("SELECT id FROM orders");
  await user.click(screen.getByRole("button", { name: "Open in new tab" }));
  expect(onOpenInNewTab).toHaveBeenCalledWith("SELECT id FROM orders", ctx("schemaQueryRows").connection);
});

test("without_a_query_tab_insert_is_disabled", async () => {
  threads = [answerThread()];
  renderPanel();
  const insert = await screen.findByRole("button", { name: "Insert commented out" });
  expect((insert as HTMLButtonElement).disabled).toBe(true);
});

test("a_saved_answer_without_its_record_inserts_only_commented_out", async () => {
  const user = userEvent.setup();
  const ed = fakeEditor("");
  threads = [answerThread()];
  renderPanel({ insertTarget: { editor: () => ed.api, name: "Query 1" } });
  await screen.findByRole("group", { name: "SQL answer" });
  expect(screen.queryByRole("button", { name: "Insert into the editor" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in new tab" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Insert commented out" }));
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(ed.now()).toBe("-- SELECT id FROM orders;\n");
});

test("a_stopped_answer_inserts_only_commented_out", async () => {
  const user = userEvent.setup();
  const ed = fakeEditor("");
  await askHeld(user, "why slow?", { insertTarget: { editor: () => ed.api, name: "Query 1" } });
  stream.emit(delta("Clean up:\n```sql\nDELETE FROM orders\n```\nThen"));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await screen.findByText("Stopped.");
  expect(screen.queryByRole("button", { name: "Insert into the editor" })).toBeNull();
  expect(screen.getByRole("button", { name: "Insert commented out" })).toBeTruthy();
});

const LABELLED = "Here:\n```sql\nSELECT pg_sleep(1)\n```";
const SLEEP_BLOCK: SqlBlock = {
  fence: 0,
  label: "1 statement: 1 read. Calls pg_sleep().",
  statements: [{ text: "SELECT pg_sleep(1)", class: "read", flags: [{ kind: "riskyFunction", name: "pg_sleep" }] }],
};

test("notes_show_above_answer", async () => {
  const user = userEvent.setup();
  const note = "Tables: Text from this database looks like it gives the assistant instructions. Read its SQL with care.";
  await askHeld(user);
  stream.emit(delta(LABELLED));
  // While streaming, the block has no label.
  expect(document.querySelector(".answer-sql-head")!.textContent).toBe("");
  stream.emit(done({ notes: [note], sqlBlocks: [SLEEP_BLOCK] }));
  const shown = await screen.findByText(note);
  const answer = screen.getByText("Here:");
  expect(shown.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const head = document.querySelector(".answer-sql-head")!;
  expect(head.textContent).toContain("1 statement: 1 read. Calls pg_sleep().");
  expect(head.classList.contains("warn")).toBe(true);
});

test("non_sql_fences_stay_code_without_actions", async () => {
  threads = [{ ...answerThread(), messages: [{ role: "user", text: "q", context: [], at: 1 }, { role: "assistant", text: "```json\n{}\n```", context: [], at: 2 }] }];
  renderPanel();
  await screen.findByText("{}");
  expect(screen.queryByRole("group", { name: "SQL answer" })).toBeNull();
});

const groqModels = () =>
  modelList(
    [
      modelInfo({ id: "llama-3.3-70b-versatile", name: "llama-3.3-70b-versatile", thinking: "none", caching: "none", picks: { thinking: "off", caching: false } }),
      modelInfo({ id: "openai/gpt-oss-120b", name: "openai/gpt-oss-120b", tier: "largest", picks: { thinking: "medium", caching: true } }),
    ],
    null,
    "llama-3.3-70b-versatile",
  );

test("pick_saves_and_next_ask_carries_it", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  known = groqModels();
  renderPanel();
  const pill = await screen.findByRole("button", { name: "Model: llama-3.3-70b-versatile" });
  await user.click(pill);
  const box = screen.getByRole("dialog", { name: "Model" });
  expect(within(box).getByText("Groq model")).toBeTruthy();
  await user.click(within(box).getByRole("option", { name: /openai\/gpt-oss-120b/ }));
  await waitFor(() => expect(callsTo("set_ai_model_prefs")).toHaveLength(1));
  expect(callsTo("set_ai_model_prefs")[0]).toEqual({ groupId: null, model: "openai/gpt-oss-120b", picks: { thinking: "medium", caching: true } });

  // A pick inside the menu is remembered for that model too.
  await user.click(await screen.findByRole("button", { name: "Model: openai/gpt-oss-120b" }));
  const levels = within(screen.getByRole("dialog", { name: "Model" })).getByRole("radiogroup", { name: "Thinking level" });
  await user.click(within(levels).getByRole("radio", { name: "High" }));
  await waitFor(() => expect(callsTo("set_ai_model_prefs")).toHaveLength(2));
  expect(callsTo("set_ai_model_prefs")[1]).toEqual({ groupId: null, model: "openai/gpt-oss-120b", picks: { thinking: "high", caching: true } });
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Model" })).toBeNull();

  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(askSent().model).toBe("openai/gpt-oss-120b");
  expect(askSent().picks).toEqual({ thinking: "high", caching: true });
  await waitFor(() => expect(lastPreview().model).toBe("openai/gpt-oss-120b"));
});

test("meter_uses_usage_after_answer", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  known = groqModels();
  reply = () => [delta("Use an index."), done({ usage: { input: 18_000, output: 120, cacheRead: 412, cacheWrite: 0 } })];
  renderPanel();
  const meter = await screen.findByRole("meter", { name: "Context window in use" });
  await waitFor(() => expect(previews().length).toBeGreaterThan(0));
  await waitFor(() => expect(meter.closest("[title]")?.getAttribute("title")).toMatch(/^About [\d,]+ of 131,072 tokens in use$/));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await screen.findByText("Use an index.");
  // What the answer measured: the input, the cache read and the answer's own output (P11-39).
  await waitFor(() => expect(screen.getByText("18.5K / 131K")).toBeTruthy());
  expect(screen.getByTitle("18,532 of 131,072 tokens in use")).toBeTruthy();
  // Typing the next question goes back to the estimate.
  await user.type(screen.getByRole("textbox", { name: "Message" }), "and");
  await waitFor(() => expect(screen.queryByTitle("18,532 of 131,072 tokens in use")).toBeNull());
});

/** Groq with gpt-oss-20b current and a fast 8b model. */
const fastModels = () =>
  modelList(
    [
      modelInfo({ id: "openai/gpt-oss-20b", name: "openai/gpt-oss-20b", tier: "mid" }),
      modelInfo({ id: "llama-3.1-8b-instant", name: "llama-3.1-8b-instant", tier: "fastest", picks: { thinking: "off", caching: true } }),
    ],
    null,
    "openai/gpt-oss-20b",
  );

/** Renders the panel with Groq answering through `reply`, and sends "why slow?". */
async function askWith(user: ReturnType<typeof userEvent.setup>) {
  settings = groq;
  askError = null;
  const utils = renderPanel();
  await waitFor(() => expect(callsTo("ai_settings")).toHaveLength(1));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  return utils;
}

test("rate_limit_counts_down_and_retries", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    reply = (_, n) => (n === 1 ? [failed({ kind: "rateLimited", retryAfterSecs: 20 })] : [delta("Use an index."), done()]);
    await askWith(user);
    expect(await screen.findByText("Groq is limiting requests.")).toBeTruthy();
    expect(screen.getByText(/^Retrying in 20s\./)).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/^Retrying in 19s\./)).toBeTruthy();
    expect(callsTo("ai_ask_stream")).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(19_000);
    });
    await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
    expect((callsTo("ai_ask_stream")[1].request as AskRequest).question).toBe("why slow?");
    expect(await screen.findByText("Use an index.")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test("parity_P11_24_a_sent_rate_limit_counts_down_once_then_stops_retrying", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The request left (a Sent record), so the failed turn is kept in the thread, as with a real provider.
    reply = () => [sent(), failed({ kind: "rateLimited", retryAfterSecs: 20 })];
    await askWith(user);
    expect(await screen.findByText(/^Retrying in 20s\. Contura retries on its own when the wait is over\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
    // The second 429 shows the card without a retry of its own.
    expect(await screen.findByText("Groq asks to wait 20s. Retry when the wait is over. Nothing was answered yet.")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(callsTo("ai_ask_stream")).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("parity_P11_28_a_length_stop_without_usage_names_the_max_tokens_cap", async () => {
  const user = userEvent.setup();
  // The Core reports the cap the request carried: its default when Max tokens is not set.
  const first = await askHeld(user);
  stream.emit(delta("The first half"), done({ stop: "length", usage: null, maxTokens: 4096 }));
  expect(await screen.findByText("It stopped at 4,096 output tokens. Continue asks the model to carry on from the last word.")).toBeTruthy();
  first.unmount();
  // Max tokens 1,024 in the settings, but Anthropic thinking raised the cap on the wire: the card names what was sent.
  settings = { ...groq, maxTokens: 1024 };
  askError = null;
  renderPanel();
  await waitFor(() => expect(callsTo("ai_settings").length).toBeGreaterThan(1));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  stream.emit(delta("The first half"), done({ stop: "length", usage: null, maxTokens: 28_672 }));
  expect(await screen.findByText("It stopped at 28,672 output tokens. Continue asks the model to carry on from the last word.")).toBeTruthy();
});

test("offline_sends_when_online", async () => {
  const user = userEvent.setup();
  reply = (_, n) => (n === 1 ? [failed({ kind: "offline" })] : [delta("Use an index."), done()]);
  await askWith(user);
  expect(await screen.findByText("No internet connection.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send now" })).toBeTruthy();
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  expect(await screen.findByText("Use an index.")).toBeTruthy();
  expect(screen.queryByText("No internet connection.")).toBeNull();
});

test("offline_cancel_keeps_the_question_in_the_composer", async () => {
  const user = userEvent.setup();
  reply = () => [failed({ kind: "offline" })];
  await askWith(user);
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(screen.queryByText("No internet connection.")).toBeNull();
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("why slow?");
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  expect(callsTo("ai_ask_stream")).toHaveLength(1);
});

test("confirm_key_host_then_retry", async () => {
  const user = userEvent.setup();
  let confirmed = false;
  confirmKeyHost = () => {
    confirmed = true;
  };
  reply = () => (confirmed ? [delta("Use an index."), done()] : [failed({ kind: "keyHostChanged", host: "api.example.com" })]);
  await askWith(user);
  expect(await screen.findByText("The base URL now points to api.example.com. Save the key again to send it there.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Send the saved key to api.example.com" }));
  await waitFor(() => expect(callsTo("ai_confirm_key_host")).toEqual([{ groupId: null, host: "api.example.com" }]));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  expect(await screen.findByText("Use an index.")).toBeTruthy();
});

test("confirm_key_host_that_moved_again_shows_the_new_host", async () => {
  const user = userEvent.setup();
  confirmKeyHost = () => {
    throw { kind: "ai", message: { kind: "keyHostChanged", host: "api.other.com" } };
  };
  reply = () => [failed({ kind: "keyHostChanged", host: "api.example.com" })];
  await askWith(user);
  await user.click(await screen.findByRole("button", { name: "Send the saved key to api.example.com" }));
  expect(await screen.findByText("The base URL now points to api.other.com. Save the key again to send it there.")).toBeTruthy();
  expect(screen.getByText("Try 2")).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(1);
});

test("use_faster_model_switches_and_retries", async () => {
  const user = userEvent.setup();
  known = fastModels();
  reply = (_, n) => (n === 1 ? [failed({ kind: "overloaded", provider: "groq" })] : [delta("Use an index."), done()]);
  await askWith(user);
  expect(await screen.findByText("Groq is busy right now.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Use llama-3.1-8b-instant" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  const second = callsTo("ai_ask_stream")[1].request as AskRequest;
  expect(second.model).toBe("llama-3.1-8b-instant");
  expect(second.picks).toEqual({ thinking: "off", caching: true });
  expect(callsTo("set_ai_model_prefs")[0]).toEqual({ groupId: null, model: "llama-3.1-8b-instant", picks: { thinking: "off", caching: true } });
  expect(await screen.findByRole("button", { name: "Model: llama-3.1-8b-instant" })).toBeTruthy();
  expect(await screen.findByText("Use an index.")).toBeTruthy();
});

test("pick_a_model_opens_the_menu", async () => {
  const user = userEvent.setup();
  known = fastModels();
  reply = () => [failed({ kind: "modelRetired", model: "qwen/qwen3.8-27b" })];
  await askWith(user);
  await user.click(await screen.findByRole("button", { name: "Pick a model" }));
  expect(screen.getByRole("dialog", { name: "Model" })).toBeTruthy();
});

test("bad_key_card_counts_tries", async () => {
  const user = userEvent.setup();
  reply = () => [failed({ kind: "badKey" })];
  const { onOpenSettings } = await askWith(user);
  expect(await screen.findByText("Groq refused the API key.")).toBeTruthy();
  expect(screen.queryByText("Try 2")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Try 2")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Open Settings" }));
  expect(onOpenSettings).toHaveBeenCalled();
});

test("retry_after_stopped", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit(delta("Half an"));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Stopped.")).toBeTruthy();
  expect(screen.getByText(/^You stopped the answer after \d+(\.\d)?s\. The part above is kept\.$/)).toBeTruthy();
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  expect((callsTo("ai_ask_stream")[1].request as AskRequest).question).toBe("why slow?");
  stream.emit(delta("Use an index."), done());
  expect(await screen.findByText("Use an index.")).toBeTruthy();
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(2));
  // The retry replaces the stopped turn.
  expect(lastSaved().messages.map((m) => m.text)).toEqual(["why slow?", "Use an index."]);
  expect(screen.queryByText("Stopped.")).toBeNull();
});

test("save_after_place_change", async () => {
  const user = userEvent.setup();
  const { rerender } = await askHeld(user);
  stream.emit(delta("Half an"));
  rerender(<AssistantPanel place="group:g2" groupId="g2" context={null} schema={null} onOpenSettings={() => {}} />);
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  // The stopped answer is saved to the place it was asked in, and the new place shows none of it.
  expect(lastSaved().place).toBe("ungrouped");
  expect(lastSaved().messages.map((m) => m.text)).toEqual(["why slow?", "Half an"]);
  expect(screen.queryByText("Half an")).toBeNull();
  expect(screen.queryByText("Stopped.")).toBeNull();
});

test("failed_pick_says_why_and_the_pill_goes_back", async () => {
  const user = userEvent.setup();
  settings = groq;
  known = groqModels();
  pickFails = true;
  renderPanel();
  await user.click(await screen.findByRole("button", { name: "Model: llama-3.3-70b-versatile" }));
  await user.click(within(screen.getByRole("dialog", { name: "Model" })).getByRole("option", { name: /openai\/gpt-oss-120b/ }));
  expect(await screen.findByText("Could not save the model pick. The settings file is locked.")).toBeTruthy();
  // The re-read shows the model the Core still has.
  expect(await screen.findByRole("button", { name: "Model: llama-3.3-70b-versatile" })).toBeTruthy();

  // A pick that saves clears the line.
  pickFails = false;
  await user.click(screen.getByRole("button", { name: "Model: llama-3.3-70b-versatile" }));
  await user.click(within(screen.getByRole("dialog", { name: "Model" })).getByRole("option", { name: /openai\/gpt-oss-120b/ }));
  expect(await screen.findByRole("button", { name: "Model: openai/gpt-oss-120b" })).toBeTruthy();
  expect(screen.queryByText(/Could not save the model pick/)).toBeNull();
});

test("send_the_saved_key_twice_asks_once", async () => {
  const user = userEvent.setup();
  let confirmed = false;
  confirmKeyHost = () => {
    confirmed = true;
  };
  reply = () => (confirmed ? [delta("Use an index."), done()] : [failed({ kind: "keyHostChanged", host: "api.example.com" })]);
  await askWith(user);
  const send = await screen.findByRole("button", { name: "Send the saved key to api.example.com" });
  act(() => {
    send.click();
    send.click();
  });
  expect(await screen.findByText("Use an index.")).toBeTruthy();
  expect(callsTo("ai_confirm_key_host")).toHaveLength(1);
  expect(callsTo("ai_ask_stream")).toHaveLength(2);
});

test("use_the_default_model_works_when_the_list_lacks_it", async () => {
  const user = userEvent.setup();
  known = groqModels();
  reply = (_, n) => (n === 1 ? [failed({ kind: "modelRetired", model: "llama-3.3-70b-versatile" })] : [delta("Use an index."), done()]);
  await askWith(user);
  // Groq's first built-in model is not in the loaded list.
  await user.click(await screen.findByRole("button", { name: "Use openai/gpt-oss-20b" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  const second = callsTo("ai_ask_stream")[1].request as AskRequest;
  expect(second.model).toBe("openai/gpt-oss-20b");
  expect(second.picks).toEqual({ thinking: "medium", caching: true });
  expect(callsTo("set_ai_model_prefs")[0]).toEqual({ groupId: null, model: "openai/gpt-oss-20b", picks: { thinking: "medium", caching: true } });
  expect(await screen.findByText("Use an index.")).toBeTruthy();
});

// ---- Task 11: answer records saved with the thread, the Sent line and Show log ----

/** Types `q` into the composer and sends it, then waits for its Ask. */
async function askMore(user: ReturnType<typeof userEvent.setup>, q: string, n: number) {
  await user.type(screen.getByRole("textbox", { name: "Message" }), `${q}{Enter}`);
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(n));
}

test("record_survives_reload", async () => {
  const user = userEvent.setup();
  const first = await askHeld(user, "one");
  stream.emit(sent(), step("access", "schema", { atMs: 2 }), line(0, "info", "question", ["chars", "3"]), delta("Half an"));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));

  await askMore(user, "two", 2);
  stream.emit(sent(), delta("The first half"), done({ stop: "length" }));
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(2));

  await askMore(user, "three", 3);
  stream.emit(sent(), line(1806, "error", "http", ["kind", "badKey"], ["status", "401"]), failed({ kind: "badKey" }));
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(3));
  // A failure after something was sent is saved as a turn, and the question stays out of the composer.
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("");

  const saved = lastSaved();
  const answers = saved.messages.filter((m) => m.role === "assistant");
  expect(answers.map((m) => [m.text, m.record?.mark])).toEqual([
    ["Half an", "stopped"],
    ["The first half", "length"],
    ["", "failed"],
  ]);
  expect(answers[0].record?.steps.map((s) => s.step)).toEqual(["access"]);
  expect(answers[0].record?.log.map((l) => l.source)).toEqual(["question"]);
  expect(answers[2].record?.error).toEqual({ kind: "badKey" });
  expect(answers.every((m) => m.record?.sent?.bytes === 2314)).toBe(true);

  first.unmount();
  threads = [saved];
  renderPanel();
  expect(await screen.findByText("Half an")).toBeTruthy();
  expect(screen.getByText("Stopped")).toBeTruthy();
  expect(screen.getByText("Stopped.")).toBeTruthy();
  expect(screen.getAllByText("Length limit")).toHaveLength(1);
  expect(screen.getByText("The answer reached its length limit.")).toBeTruthy();
  expect(screen.getByText("Groq refused the API key.")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /^\d\d:\d\d · Sent 2,314 B to Groq, gpt-oss-20b/ })).toHaveLength(3);
  expect(screen.getAllByRole("button", { name: "Show log" }).length).toBeGreaterThanOrEqual(3);
  // Show log opens the stored record in place of the thread.
  await user.click(screen.getAllByRole("button", { name: "Show log" })[0]);
  expect(screen.getByText("Answer log")).toBeTruthy();
  expect(screen.getByText("For: one")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "Steps" }));
  expect(screen.getByRole("button", { name: /^Access/ })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Back to the answer" }));
  expect(screen.getByText("Half an")).toBeTruthy();
});

test("a_saved_answer_gets_its_sql_actions_back_from_the_record", async () => {
  const user = userEvent.setup();
  const ed = fakeEditor("");
  await askHeld(user, "why slow?", { insertTarget: { editor: () => ed.api, name: "Query 1" } });
  stream.emit(sent(), delta(FENCED), done({ sqlBlocks: [ORDERS_BLOCK], notes: ["A stored note."] }));
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  const saved = lastSaved();
  cleanup();
  threads = [saved];
  renderPanel({ insertTarget: { editor: () => ed.api, name: "Query 1" } });
  expect(await screen.findByText("1 statement: 1 read")).toBeTruthy();
  expect(screen.getByText("A stored note.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Insert into the editor" })).toBeTruthy();
});

test("pre_send_failure_not_saved", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit(line(3, "error", "request", ["kind", "tooBig"], ["phase", "build"]), failed({ kind: "tooBig", needed: 300_000, window: 131_072, model: "llama-3.3-70b-versatile" }));
  await screen.findByText(/This question needs/);
  expect(callsTo("save_ai_thread")).toHaveLength(0);
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("why slow?");
  // Its log is still there from the card.
  await user.click(screen.getByRole("button", { name: "Show log" }));
  expect(screen.getByText("For: why slow?")).toBeTruthy();
  expect(document.querySelectorAll(".lrow")).toHaveLength(1);
});

test("sent_line_shows_cached", async () => {
  const user = userEvent.setup();
  const now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 19, 11, 42, 30).getTime());
  try {
    await askHeld(user);
    stream.emit(sent({ exact: null }), delta("Use an index."));
    stream.emit(done({ usage: { input: 500, output: 120, cacheRead: 1840, cacheWrite: 0 } }));
    const line = await screen.findByRole("button", { name: "11:42 · Sent 2,314 B to Groq, gpt-oss-20b, 1.9s, 1,840 cached" });
    await user.click(line);
  } finally {
    now.mockRestore();
  }
  const pop = screen.getByRole("dialog", { name: "Sent record" });
  expect(pop.textContent).toContain("about 640 tokens");
  expect(pop.textContent).toContain("api.groq.com");
  expect(pop.textContent).toContain("8f2c0a1b3d4e5f60");
  expect(pop.textContent).toContain("1,840");
  expect(pop.textContent).toContain("The exact text was not kept. Turn on Keep the exact text sent in AI settings.");
});

test("show_log_live_while_answering", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit(line(0, "info", "question", ["chars", "9"]), step("access", "schema", { atMs: 2 }));
  await user.click(screen.getByRole("button", { name: "Show log" }));
  expect(screen.getByText("Answer log")).toBeTruthy();
  expect(document.querySelectorAll(".lrow")).toHaveLength(1);
  // Lines arrive while the log is open.
  stream.emit(line(214, "info", "request", ["bytes", "2314"]));
  expect(document.querySelectorAll(".lrow")).toHaveLength(2);
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(document.querySelector(".dbox.pending")).toBeTruthy();
});

// ---- Final fix wave: what the user did with an answer's SQL ----

test("insert_and_open_are_kept_with_the_answer", async () => {
  const user = userEvent.setup();
  const ed = fakeEditor("SELECT 1;\n");
  const onOpenInNewTab = vi.fn();
  await askHeld(user, "why slow?", { insertTarget: { editor: () => ed.api, name: "Query 1" }, onOpenInNewTab });
  stream.emit(sent(), delta(FENCED), done({ sqlBlocks: [ORDERS_BLOCK] }));
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  const saved = lastSaved();
  const answer = saved.messages[1];
  await user.click(await screen.findByRole("button", { name: "Insert into the editor" }));
  await user.click(screen.getByRole("button", { name: "Insert" }));
  await waitFor(() => expect(callsTo("ai_record_action")).toHaveLength(1));
  expect(callsTo("ai_record_action")[0]).toEqual({ threadId: saved.id, messageAt: answer.at, kind: "inserted" });
  await user.click(screen.getByRole("button", { name: "Open in new tab" }));
  await waitFor(() => expect(callsTo("ai_record_action")).toHaveLength(2));
  expect(callsTo("ai_record_action")[1].kind).toBe("openedInNewTab");
  // The Diagram shows them from the record.
  await user.click(screen.getByRole("button", { name: "Show log" }));
  await user.click(screen.getByRole("tab", { name: "Diagram" }));
  expect(screen.getByText("You: Inserted into the editor")).toBeTruthy();
  expect(screen.getByText("You: Opened in a new tab")).toBeTruthy();
});

// ---- 11c: the answer's AI Context, and the 11b-2 carry-overs ----

test("context_event_is_kept_with_the_answer", async () => {
  const user = userEvent.setup();
  const builtAt = new Date(2026, 9, 20, 9, 12).getTime();
  const info: ContextInfo = {
    connectionId: "c1",
    database: "shop",
    schema: "public",
    sync: "automatic",
    builtAt,
    tableCount: 6,
    stale: false,
    check: { kind: "failed" },
  };
  const NOTICE = "Could not check the schema. Using the context from 09:12.";
  const first = await askHeld(user);
  stream.emit(step("schema", "could not check, synced 1m ago"), { type: "context", info }, sent(), delta("Use an index."));
  // Shown above the answer while it is written.
  expect(await screen.findByText(NOTICE)).toBeTruthy();
  stream.emit(done());
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  // And after it is saved, above the answer text.
  const note = screen.getByText(NOTICE).closest(".answer-note")!;
  expect(note.compareDocumentPosition(screen.getByText("Use an index.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The UI does not copy the event into the record: the Core writes AnswerRecord.context.
  const saved = lastSaved();
  expect(saved.messages[1].record?.context ?? null).toBeNull();

  // Reloaded from a record the Core wrote, the notice is back.
  first.unmount();
  saved.messages[1] = { ...saved.messages[1], record: { ...saved.messages[1].record!, context: info } };
  threads = [saved];
  renderPanel();
  expect(await screen.findByText("Use an index.")).toBeTruthy();
  expect(screen.getByText(NOTICE)).toBeTruthy();
  // A record without a context (an older one) has no notice.
  cleanup();
  const { context: _, ...older } = saved.messages[1].record!;
  threads = [{ ...saved, messages: [saved.messages[0], { ...saved.messages[1], record: older as never }] }];
  renderPanel();
  expect(await screen.findByText("Use an index.")).toBeTruthy();
  expect(screen.queryByText(NOTICE)).toBeNull();
});

test("failed_retry_show_log_is_live", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit(sent(), line(0, "info", "question", ["first", "attempt"]), failed({ kind: "network", host: "api.groq.com" }));
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  await user.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  // The retry fails before anything is sent, so the saved turn stays as it was.
  stream.emit(line(3, "error", "request", ["kind", "tooBig"]), failed({ kind: "tooBig", needed: 300_000, window: 131_072, model: "m" }));
  await screen.findByText(/This question needs/);
  expect(callsTo("save_ai_thread")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Show log" }));
  // The new attempt's log, not the saved one.
  expect(document.querySelectorAll(".lrow")).toHaveLength(1);
  expect(document.querySelector(".lrow")!.textContent).toContain("kind=tooBig");
});

test("a_saved_command_error_reloads_with_its_card", async () => {
  const user = userEvent.setup();
  const first = await askHeld(user);
  stream.emit(sent(), delta("Half"));
  // The command itself fails after the request went out (not an AiError).
  stream.emit({ type: "error", error: { kind: "internal" }, partial: true });
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  first.unmount();
  const saved = lastSaved();
  // Rewrite the turn as a non-AI command error would have saved it.
  const record = saved.messages[1].record!;
  saved.messages[1] = {
    ...saved.messages[1],
    record: { ...record, error: null, commandError: "The query failed: boom" },
  };
  threads = [saved];
  renderPanel();
  expect(await screen.findByText("Half")).toBeTruthy();
  expect(screen.getByText("The query failed: boom")).toBeTruthy();
});

test("error_cards_count_the_sample_selects_that_ran", async () => {
  // The budget left both tables out: no rows went, but two SELECTs ran on the database.
  const user = userEvent.setup();
  const first = await askHeld(user);
  const rows = step("rows", "0 rows from 0 tables", {
    evidence: [
      ["orders", "name match", "left out: over the budget"],
      ["customers", "name match", "left out: over the budget"],
    ],
  });
  stream.emit(rows, sent(), failed({ kind: "timeout", phase: "first byte" }));
  const said = /^The request left this computer but nothing came back\. Contura read sample rows from 2 tables, read only\./;
  expect(await screen.findByText(said)).toBeTruthy();
  // The saved turn's card, reloaded, says the same.
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  first.unmount();
  threads = [lastSaved()];
  renderPanel();
  expect(await screen.findByText(said)).toBeTruthy();
});

/** A saved failed turn (its user message carrying `action`), reloaded, then Retry; returns the Ask the Retry sent. */
async function retrySaved(action: string | undefined, text: string) {
  const user = userEvent.setup();
  const first = await askHeld(user, text);
  stream.emit(sent(), failed({ kind: "timeout", phase: "first byte" }));
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  first.unmount();
  const saved = lastSaved();
  if (action) saved.messages[0] = { ...saved.messages[0], action };
  threads = [saved];
  const before = callsTo("ai_ask_stream").length;
  stream = aiStream(() => [delta("Fine."), done()]);
  routeInvoke(handlersNow());
  renderPanel();
  await screen.findByText(text, { selector: ".msg-user" });
  await user.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(before + 1));
  return callsTo("ai_ask_stream")[before].request as AskRequest;
}

test("retry_of_a_saved_failed_continue_sends_continue", async () => {
  const r = await retrySaved("continue", "Continue");
  expect(r).toMatchObject({ action: "continue", question: "Continue" });
});

test("retry_of_a_saved_turn_sends_its_own_action", async () => {
  expect(await retrySaved("explain", "Explain this")).toMatchObject({ action: "explain", question: "Explain this" });
});

test("retry_of_a_saved_turn_without_an_action_asks", async () => {
  expect(await retrySaved(undefined, "why slow?")).toMatchObject({ action: "ask", question: "why slow?" });
});

test("a_failed_open_keeps_the_previous_chat_and_shows_why", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1), thread("b", "ungrouped", "Newer chat", 2)];
  routeInvoke({
    ...handlersNow(),
    get_ai_thread: (a) => {
      if (a.threadId === "a") throw "The store is locked.";
      return viewOf(threads.find((t) => t.id === a.threadId)!);
    },
  });
  renderPanel();
  await screen.findByText("Newer chat", { selector: ".msg-user" });
  await openHistory(user);
  await user.click(screen.getByRole("button", { name: /Old chat/ }));
  expect(await screen.findByText("The store is locked.")).toBeTruthy();
  expect(screen.getByText("Newer chat", { selector: ".msg-user" })).toBeTruthy();
  // The next Ask continues the chat that is still open.
  askError = null;
  await user.type(screen.getByRole("textbox", { name: "Message" }), "more{Enter}");
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  expect((callsTo("save_ai_thread")[0].thread as AiThread).id).toBe("b");
});

test("opening_a_chat_that_is_gone_drops_its_row", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1), thread("b", "ungrouped", "Newer chat", 2)];
  routeInvoke({ ...handlersNow(), get_ai_thread: (a) => (a.threadId === "a" ? null : viewOf(threads.find((t) => t.id === a.threadId)!)) });
  renderPanel();
  await screen.findByText("Newer chat", { selector: ".msg-user" });
  await openHistory(user);
  await user.click(screen.getByRole("button", { name: /Old chat/ }));
  expect(await screen.findByText("That chat is no longer stored.")).toBeTruthy();
  expect(screen.getByText("Newer chat", { selector: ".msg-user" })).toBeTruthy();
  await openHistory(user);
  expect(screen.queryByRole("button", { name: /Old chat/ })).toBeNull();
});

test("a_failed_clear_keeps_the_row_and_shows_why", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1)];
  routeInvoke({
    ...handlersNow(),
    delete_ai_thread: () => {
      throw "The store is locked.";
    },
  });
  renderPanel();
  await screen.findByText("Old chat", { selector: ".msg-user" });
  await openHistory(user);
  await user.click(screen.getByRole("button", { name: "Clear this chat" }));
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(await screen.findByText("The store is locked.")).toBeTruthy();
  expect(screen.getByText("Old chat", { selector: ".msg-user" })).toBeTruthy();
  await openHistory(user);
  expect(screen.getByRole("button", { name: /Old chat/ })).toBeTruthy();
});

test("a_failed_clear_all_keeps_the_list_and_shows_why", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1)];
  routeInvoke({
    ...handlersNow(),
    clear_ai_threads: () => {
      throw "The store is locked.";
    },
  });
  renderPanel({ placeName: "Ungrouped" });
  await screen.findByText("Old chat", { selector: ".msg-user" });
  await openHistory(user);
  await user.click(screen.getByRole("button", { name: "Clear all chats in this place..." }));
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(await screen.findByText("The store is locked.")).toBeTruthy();
  // The chats are still on disk, so they stay listed.
  expect(screen.getByText("Old chat", { selector: ".msg-user" })).toBeTruthy();
  await openHistory(user);
  expect(screen.getByRole("button", { name: /Old chat/ })).toBeTruthy();
});

test("nothing_to_continue_offers_new_chat_and_ask_again", async () => {
  const user = userEvent.setup();
  await askHeld(user, "List the late orders");
  stream.emit(delta("SELECT id FROM"), done({ stop: "length" }));
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  // The Core refuses it: the cut answer is not in what the Ask would send.
  stream.emit(failed({ kind: "nothingToContinue" }));
  expect(await screen.findByText("Nothing to continue.")).toBeTruthy();
  expect(screen.queryByText("Something went wrong before the question was sent.")).toBeNull();
  const card = screen.getByText("Nothing to continue.").closest(".errc")!;
  expect(Array.from(card.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["New chat", "Ask again", "Show log"]);
  await user.click(screen.getByRole("button", { name: "Ask again" }));
  // The question whose answer was cut goes back into the box; nothing is sent.
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("List the late orders");
  expect(screen.queryByText("Nothing to continue.")).toBeNull();
  expect(callsTo("ai_ask_stream")).toHaveLength(2);
});

test("new_chat_after_nothing_to_continue_gives_back_the_cut_question", async () => {
  const user = userEvent.setup();
  await askHeld(user, "List the late orders");
  stream.emit(delta("SELECT id FROM"), done({ stop: "length" }));
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  stream.emit(failed({ kind: "nothingToContinue" }));
  const card = (await screen.findByText("Nothing to continue.")).closest(".errc")!;
  await user.click(within(card as HTMLElement).getByRole("button", { name: "New chat" }));
  // "Continue" means nothing in a new chat: the box holds the question whose answer was cut.
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("List the late orders");
  expect(callsTo("ai_ask_stream")).toHaveLength(2);
});

const at = (h: number, m: number) => new Date(2026, 9, 22, h, m).getTime();

const topicOf = (seq: number, over: Partial<Topic> = {}): Topic => ({
  threadId: "t",
  seq,
  title: `Topic ${seq}`,
  summary: "Summary.",
  summaryBy: { kind: "rules" },
  tables: [],
  connectionId: "c1",
  database: "shop",
  kinds: [],
  firstAt: at(9, 38),
  lastAt: at(9, 51),
  messages: 4,
  closed: false,
  ...over,
});

/** A thread of two Topics: the first closed (4 messages), the second open (2). */
const topicThread = (): { t: AiThread; topics: Topic[] } => {
  const stamp = (n: number) => ({ topic: n, connectionId: "c1", database: "shop" });
  const m = (role: "user" | "assistant", text: string, when: number, n: number) => ({ role, text, context: [], at: when, ...stamp(n) });
  return {
    t: {
      id: "t",
      place: "ungrouped",
      title: "Late invoices",
      updatedAt: 9,
      messages: [
        m("user", "first q", 1, 1),
        m("assistant", "first a", 2, 1),
        m("user", "second q", 3, 1),
        m("assistant", "second a", 4, 1),
        m("user", "third q", 5, 2),
        m("assistant", "third a", 6, 2),
      ],
    },
    topics: [
      topicOf(1, { title: "Late invoices", summary: "Invoices past due_at, grouped by customer", closed: true }),
      topicOf(2, { title: "Biggest customers", messages: 1 }),
    ],
  };
};

const withTopics = (t: AiThread, topics: Topic[]) => {
  threads = [t];
  routeInvoke({ ...handlersNow(), get_ai_thread: () => viewOf(t, false, topics) });
};

test("closed_topics_fold_and_unfold", async () => {
  const user = userEvent.setup();
  const { t, topics } = topicThread();
  withTopics(t, topics);
  renderPanel();
  const fold = await screen.findByRole("button", { name: /Late invoices/ });
  expect(fold.textContent).toContain("second a. 4 messages.");
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("first q")).toBeNull();
  // The open Topic is shown.
  expect(screen.getByText("third q")).toBeTruthy();
  await user.click(fold);
  expect(screen.getByText("first q")).toBeTruthy();
  expect(screen.getByText("second a")).toBeTruthy();
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  await user.click(fold);
  expect(screen.queryByText("first q")).toBeNull();
});

test("divider_for_the_open_topic", async () => {
  const { t, topics } = topicThread();
  withTopics(t, topics);
  const first = renderPanel();
  await screen.findByRole("button", { name: /Late invoices/ });
  const div = document.querySelector(".tdiv") as HTMLElement;
  expect(div.textContent).toBe("New topicBiggest customers");
  first.unmount();
  cleanup();
  // One Topic: no divider.
  withTopics({ ...t, messages: t.messages.slice(0, 2) }, [{ ...topics[0], closed: false }]);
  renderPanel();
  await screen.findByText("first q");
  expect(document.querySelector(".tdiv")).toBeNull();
  expect(screen.queryByRole("button", { name: /Late invoices/ })).toBeNull();
});

test("live_memory_event_shows_divider", async () => {
  const user = userEvent.setup();
  const { t, topics } = topicThread();
  withTopics(t, topics);
  settings = groq;
  askError = null;
  stream.hold();
  renderPanel();
  await screen.findByText("third q");
  expect(document.querySelectorAll(".tdiv")).toHaveLength(1);
  await user.type(screen.getByRole("textbox", { name: "Message" }), "who owes most?{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(document.querySelectorAll(".tdiv")).toHaveLength(1);
  stream.emit(memory({ topic: 3, opened: true, reason: "subject", title: "Refunds" }));
  const dividers = document.querySelectorAll(".tdiv");
  expect(dividers).toHaveLength(2);
  expect(dividers[1].textContent).toBe("New topicRefunds");
  expect(dividers[1].nextElementSibling?.textContent).toBe("who owes most?");
});

test("persist_stamps_both_messages", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  reply = () => [memory({ topic: 2, tables: ["orders"], kinds: ["question", "cards"], action: "ask" }), delta("Use an index."), done()];
  renderPanel();
  await user.type(await screen.findByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await screen.findByText("Use an index.");
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  const saved = callsTo("save_ai_thread")[0].thread as AiThread;
  expect(saved.messages).toHaveLength(2);
  for (const m of saved.messages) {
    expect(m).toMatchObject({ topic: 2, connectionId: "c1", database: "shop", kinds: ["question", "cards"], tables: ["orders"], action: "ask" });
  }
});

test("meter_has_a_thread_part", () => {
  const p = fakePreview({ ...({} as AskRequest), focus: { tables: [], dbml: null, sql: "select 1", filter: null, error: null, selection: null, untiedModel: false }, connectionId: "c1", off: [], switches: { rows: false, values: false }, question: "q" } as AskRequest);
  p.items = [
    { kind: "cards", label: "Schema", bytes: 1, tokens: 9_100, locked: null, on: true },
    { kind: "history", label: "Thread · 4 turns", bytes: 1, tokens: 700, locked: null, on: true },
    { kind: "sql", label: "Query text", bytes: 1, tokens: 2_400, locked: null, on: true },
  ];
  p.memory = { topic: 1, opened: false, reason: null, title: "T", turns: 4, summaries: 0, blocked: 0, tokens: 6_800 };
  expect(meterParts(p, ctx("schemaQuery"))).toEqual([
    { label: "schema", tokens: 9_100 },
    { label: "thread", tokens: 6_800 },
    { label: "current statement", tokens: 2_400 },
  ]);
});

test("folded_summary_never_doubles_its_period", async () => {
  const { t, topics } = topicThread();
  // The fold previews its last answer (P11-20); one that ends in a period gets no second one.
  t.messages[3] = { ...t.messages[3], text: "Asked: late invoices. Tables: invoices." };
  withTopics(t, topics);
  renderPanel();
  const fold = await screen.findByRole("button", { name: /Late invoices/ });
  expect(fold.textContent).toContain("Tables: invoices. 4 messages.");
  expect(fold.textContent).not.toContain("..");
});

// Compaction (step 11e, task 9).

const RECORD: AnswerRecord = {
  sent: null,
  usage: null,
  millis: null,
  stop: null,
  mark: null,
  error: null,
  sqlBlocks: [],
  notes: [],
  thinking: null,
  log: [],
  steps: [],
  actions: [],
  context: null,
  commandError: null,
};

const compactionOf = (over: Partial<Compaction> = {}): Compaction => ({
  id: "k1",
  threadId: "t",
  topic: 1,
  firstAt: 1,
  lastAt: 4,
  messages: 4,
  summary: "Late invoices: billing.invoices joined to billing.customers.",
  summaryBy: { kind: "model", model: "llama-3.3-70b-versatile" },
  connectionId: "c1",
  database: "shop",
  kinds: ["question", "cards"],
  before: 182_000,
  after: 31_000,
  at: 5,
  undone: false,
  record: RECORD,
  ...over,
});

/** One open Topic of three turns, to compact. */
const longThread = (): { t: AiThread; topics: Topic[] } => {
  const stamp = { topic: 1, connectionId: "c1", database: "shop" };
  const m = (role: "user" | "assistant", text: string, when: number) => ({ role, text, context: [], at: when, ...stamp });
  return {
    t: {
      id: "t",
      place: "ungrouped",
      title: "Late invoices",
      updatedAt: 9,
      messages: [m("user", "first q", 1), m("assistant", "first a", 2), m("user", "second q", 3), m("assistant", "second a", 4), m("user", "third q", 5), m("assistant", "third a", 6)],
    },
    topics: [topicOf(1, { title: "Late invoices", messages: 6 })],
  };
};

const FULL: AiError = { kind: "contextFull", used: 192_000, window: 131_072, model: "llama-3.3-70b-versatile", messages: 4 };

test("compacted_event_drops_the_meter", async () => {
  const user = userEvent.setup();
  known = groqModels();
  const { t, topics } = longThread();
  threads = [t];
  routeInvoke({ ...handlersNow(), get_ai_thread: () => viewOf(t, false, topics) });
  await askHeld(user);
  expect(screen.getByText("first q")).toBeTruthy();
  stream.emit({ type: "status", step: "Compacting the thread" });
  expect(screen.getByText("Compacting the thread")).toBeTruthy();
  stream.emit({ type: "compacted", compaction: compactionOf() });
  // The note shows in the thread at once, and the meter reads the figure after.
  expect(screen.getByText("Compacted 4 older messages into a summary")).toBeTruthy();
  expect(screen.queryByText("first q")).toBeNull();
  expect(screen.getByText("182K → 31K")).toBeTruthy();
  expect(screen.getByText("31K / 131K")).toBeTruthy();
  // The Ask is still running: its compaction cannot be undone yet.
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  stream.emit({ type: "status", step: "Summarising the last topic" });
  expect(screen.queryByText("Compacting the thread")).toBeNull();
});

test("hidden_messages_replaced_by_note", async () => {
  const user = userEvent.setup();
  known = groqModels();
  const { t, topics } = longThread();
  threads = [t];
  let undone = 0;
  routeInvoke({
    ...handlersNow(),
    get_ai_thread: () => viewOf(t, false, topics, [compactionOf()]),
    ai_undo_compact: (a) => {
      undone++;
      expect(a).toEqual({ threadId: "t", compactionId: "k1" });
      return viewOf(t, false, topics, [compactionOf({ undone: true })]);
    },
  });
  settings = groq;
  renderPanel();
  expect(await screen.findByText("Compacted 4 older messages into a summary")).toBeTruthy();
  expect(screen.queryByText("first q")).toBeNull();
  expect(screen.queryByText("second a")).toBeNull();
  expect(screen.getByText("third q")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show the summary" }));
  // Nothing measured is kept for this one, so no token count is printed.
  expect(screen.getByText("Summary by llama-3.3-70b-versatile")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByText("first q")).toBeTruthy();
  expect(undone).toBe(1);
  expect(screen.getByText("second a")).toBeTruthy();
  expect(screen.queryByText("Compacted 4 older messages into a summary")).toBeNull();
});

test("a_failed_undo_says_why", async () => {
  const user = userEvent.setup();
  const { t, topics } = longThread();
  threads = [t];
  routeInvoke({
    ...handlersNow(),
    get_ai_thread: () => viewOf(t, false, topics, [compactionOf()]),
    ai_undo_compact: () => {
      throw new Error("The store is locked.");
    },
  });
  settings = groq;
  renderPanel();
  await user.click(await screen.findByRole("button", { name: "Undo" }));
  expect((await screen.findByRole("alert")).textContent).toContain("The store is locked.");
  expect(screen.queryByText("first q")).toBeNull();
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
});

/** A full thread whose Ask fails with the ContextFull card; `compact` is what `ai_compact` does. */
async function fullThread(compact: (a: Record<string, unknown>) => unknown, extra: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  const user = userEvent.setup();
  known = groqModels();
  settings = groq;
  askError = null;
  const { t, topics } = longThread();
  threads = [t];
  let n = 0;
  reply = () => (++n === 1 ? [failed(FULL)] : [delta("Use an index."), done()]);
  routeInvoke({ ...handlersNow(), get_ai_thread: () => viewOf(t, false, topics), ai_compact: compact, ...extra });
  renderPanel();
  await screen.findByText("third q");
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await screen.findByText("This thread fills 146% of llama-3.3-70b-versatile's 131K window.");
  return user;
}

test("compact_now_then_asks_again", async () => {
  const user = await fullThread((a) => {
    const events = a.events as { onmessage: (e: AiEvent) => void };
    events.onmessage({ type: "status", step: "Compacting the thread" });
    return compactionOf();
  });
  expect(screen.getByText(/Auto-compact is off, so nothing was sent\. Compact now turns the 4 older messages/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Compact now" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  const [compact] = callsTo("ai_compact");
  const request = compact.request as CompactRequest;
  expect(request).toMatchObject({ place: "ungrouped", groupId: null, threadId: "t", model: "llama-3.3-70b-versatile" });
  expect(typeof request.requestId).toBe("string");
  // The same Ask again, once.
  expect((callsTo("ai_ask_stream")[1].request as AskRequest).question).toBe("why slow?");
  expect(await screen.findByText("Use an index.")).toBeTruthy();
  expect(screen.queryByText(/This thread fills/)).toBeNull();
  // The compaction replaces its messages with the note.
  expect(screen.getByText("Compacted 4 older messages into a summary")).toBeTruthy();
  expect(screen.queryByText("first q")).toBeNull();
});

test("a_failed_compact_now_shows_its_error_card", async () => {
  const user = await fullThread(() => {
    throw { kind: "ai", message: { kind: "rateLimited", retryAfterSecs: null } };
  });
  await user.click(screen.getByRole("button", { name: "Compact now" }));
  expect(await screen.findByText("Groq is limiting requests.")).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(1);
  expect(screen.queryByText(/This thread fills/)).toBeNull();
});

test("turn_on_auto_compact_then_asks_again", async () => {
  const user = await fullThread(
    () => {
      throw new Error("not called");
    },
    {
      ai_settings: (a) => {
        // The switch is global: the settings are read without the Group.
        expect(a.groupId).toBeNull();
        return view({ ...groq, autoCompact: false });
      },
      save_ai_settings: () => undefined,
    },
  );
  await user.click(screen.getByRole("button", { name: "Turn on auto-compact" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  const [save] = callsTo("save_ai_settings");
  expect(save).toMatchObject({ groupId: null, overrideGroup: false, key: { t: "keep" } });
  expect((save.settings as AiSettings).autoCompact).toBe(true);
  expect((save.settings as AiSettings).model).toBe("llama-3.3-70b-versatile");
  expect(callsTo("ai_compact")).toHaveLength(0);
  expect(await screen.findByText("Use an index.")).toBeTruthy();
});

test("turn_on_auto_compact_failure_keeps_the_card_and_says_why", async () => {
  const user = await fullThread(
    () => undefined,
    {
      save_ai_settings: () => {
        throw new Error("The settings file is locked.");
      },
    },
  );
  await user.click(screen.getByRole("button", { name: "Turn on auto-compact" }));
  expect(await screen.findByText(/The settings file is locked\./)).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(1);
});

test("sent_line_counts_every_call", async () => {
  const user = userEvent.setup();
  const now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 19, 11, 42, 30).getTime());
  try {
    await askHeld(user);
    const outline = { bytes: 1204, tokens: 344, hash: "aa11bb22cc33dd44", pickedAreas: 1, pickedTables: 6, dropped: 0, usage: null, exact: null, left: true };
    const summary = { kind: "compact" as const, topic: null, messages: 14, model: "llama-3.3-70b-versatile", bytes: 500, tokens: 125, hash: "bb11cc22dd33ee44", millis: 800, usage: null, exact: null };
    stream.emit(sent({ model: "llama-3.3-70b-versatile", outlineCall: true, outline, summaryCall: true, summary }), delta("Use an index."));
    stream.emit(done());
    expect(await screen.findByText("11:42 · Sent 4,018 B to Groq, llama-3.3-70b-versatile, 1.9s")).toBeTruthy();
  } finally {
    now.mockRestore();
  }
});

test("note_shows_the_tokens_the_ask_measured", async () => {
  const user = userEvent.setup();
  const { t, topics } = longThread();
  const summary = { kind: "compact" as const, topic: null, messages: 4, model: "llama-3.3-70b-versatile", bytes: 4800, tokens: 1200, hash: "bb11cc22dd33ee44", millis: 800, usage: null, exact: null };
  // The answer after the compacted span carries the Ask's own Sent record.
  const messages = t.messages.map((m) => (m.at === 6 ? { ...m, record: { ...RECORD, sent: { ...sentRecord(), summaryCall: true, summary } } } : m));
  const made = { ...t, messages };
  threads = [made];
  routeInvoke({ ...handlersNow(), get_ai_thread: () => viewOf(made, true, topics, [compactionOf()]) });
  settings = groq;
  renderPanel();
  await user.click(await screen.findByRole("button", { name: "Show the summary" }));
  expect(screen.getByText("Summary by llama-3.3-70b-versatile, 1.2K tokens")).toBeTruthy();
});

test("an_undone_compaction_stays_undone_after_reopening_the_chat", async () => {
  const user = userEvent.setup();
  const { t, topics } = longThread();
  const other = thread("o", "ungrouped", "Old chat", 1);
  threads = [t, other];
  let stored: Compaction[] = [];
  routeInvoke({
    ...handlersNow(),
    get_ai_thread: (a) => (a.threadId === "o" ? viewOf(other) : viewOf(t, false, topics, stored)),
    save_ai_thread: (a) => {
      stored = [compactionOf()];
      return viewOf(a.thread as AiThread, false, topics, stored);
    },
    ai_undo_compact: () => {
      stored = [compactionOf({ undone: true })];
      return viewOf(t, false, topics, stored);
    },
  });
  settings = groq;
  askError = null;
  reply = () => [{ type: "compacted", compaction: compactionOf() }, delta("Use an index."), done()];
  renderPanel();
  await screen.findByText("first q");
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await screen.findByText("Use an index.");
  expect(screen.queryByText("first q")).toBeNull();
  await user.click(await screen.findByRole("button", { name: "Undo" }));
  expect(await screen.findByText("first q")).toBeTruthy();
  // Away and back: the Core's copy says undone, and the finished Ask's live copy must not hide the messages again.
  await openHistory(user);
  await user.click(screen.getByRole("button", { name: /Old chat/ }));
  await screen.findByText("Old chat", { selector: ".msg-user" });
  await openHistory(user);
  await user.click(screen.getByRole("button", { name: /Late invoices/ }));
  expect(await screen.findByText("first q")).toBeTruthy();
  expect(screen.queryByText("Compacted 4 older messages into a summary")).toBeNull();
});

// ---- Task 11 (11e): slash commands in the Ask composer ----

/** A panel with one answered chat, a model list and a key, for the commands that act on them. */
async function slashPanel(extra: Record<string, (a: Record<string, unknown>) => unknown> = {}, saved: AiThread | null = null) {
  const user = userEvent.setup();
  known = groqModels();
  settings = groq;
  askError = null;
  const t: AiThread = saved ?? {
    id: "a",
    place: "ungrouped",
    title: "Why?",
    updatedAt: 10,
    messages: [
      { role: "user", text: "Why?", context: [], at: 10 },
      { role: "assistant", text: "Because.", context: [], at: 11, record: fullRecord("the full log line") },
    ],
  };
  threads = [t];
  routeInvoke({ ...handlersNow(), ...extra });
  renderPanel();
  await screen.findByText(t.messages[0].text, { selector: ".msg-user" });
  return user;
}
const composer = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

test("slash_opens_list_and_narrows", async () => {
  const user = await slashPanel();
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  await user.type(composer(), "/");
  expect(screen.getAllByRole("option").map((o) => o.querySelector(".slash-name")?.textContent)).toEqual([
    "/compact", "/new", "/history", "/model", "/sends", "/log", "/clear",
  ]);
  expect(composer().getAttribute("aria-controls")).toBe(screen.getByRole("listbox", { name: "Commands" }).id);
  expect(composer().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0].id);
  await user.type(composer(), "c");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  await user.type(composer(), "x");
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(screen.getByText("No command matches /cx. Delete the / to ask a question.")).toBeTruthy();
  await user.clear(composer());
  await user.type(composer(), "why /c");
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
});

test("escape_closes_the_list_and_keeps_the_draft", async () => {
  const user = await slashPanel();
  await user.type(composer(), "/m");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  expect(composer().value).toBe("/m");
  // Typing again brings it back.
  await user.type(composer(), "o");
  expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
});

test("arrows_move_and_enter_runs_the_active_command", async () => {
  const user = await slashPanel();
  await user.type(composer(), "/");
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(await screen.findByRole("dialog", { name: "Chat history" })).toBeTruthy();
  expect(composer().value).toBe("");
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
});

test("each_command_runs_its_control", async () => {
  // /compact calls ai_compact for the open thread.
  let user = await slashPanel({ ai_compact: () => compactionOf({ threadId: "t" }) }, longThread().t);
  await user.type(composer(), "/compact{Enter}");
  await waitFor(() => expect(callsTo("ai_compact")).toHaveLength(1));
  expect(callsTo("ai_compact")[0].request).toMatchObject({ place: "ungrouped", threadId: "t" });
  expect(await screen.findByText("Compacted 4 older messages into a summary")).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(0);
  cleanup();

  // /new starts a new chat.
  user = await slashPanel();
  await user.type(composer(), "/new{Enter}");
  await waitFor(() => expect(screen.queryByText("Why?", { selector: ".msg-user" })).toBeNull());
  cleanup();

  // /history opens the history popover.
  user = await slashPanel();
  await user.type(composer(), "/history{Enter}");
  expect(await screen.findByRole("dialog", { name: "Chat history" })).toBeTruthy();
  cleanup();

  // /model opens the model menu.
  user = await slashPanel();
  await user.type(composer(), "/model{Enter}");
  expect(await screen.findByRole("dialog", { name: "Model" })).toBeTruthy();
  cleanup();

  // /sends opens the Sends list in full.
  user = await slashPanel();
  await user.type(composer(), "/sends{Enter}");
  expect(await screen.findByRole("button", { name: "Hide" })).toBeTruthy();
  cleanup();

  // /log opens the last answer's log.
  user = await slashPanel();
  await user.type(composer(), "/log{Enter}");
  expect(await screen.findByText(/the full log line/)).toBeTruthy();
  cleanup();

  // /clear asks first, then deletes the open chat.
  user = await slashPanel();
  await user.type(composer(), "/clear{Enter}");
  expect(await screen.findByText(/Clear this chat\? Its messages are removed/)).toBeTruthy();
  expect(callsTo("delete_ai_thread")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("delete_ai_thread")).toEqual([{ id: "a" }]));
});

test("clear_confirmation_can_be_cancelled", async () => {
  const user = await slashPanel();
  await user.type(composer(), "/clear{Enter}");
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(callsTo("delete_ai_thread")).toHaveLength(0);
  expect(screen.getByText("Why?", { selector: ".msg-user" })).toBeTruthy();
});

test("a_click_on_a_row_runs_it", async () => {
  const user = await slashPanel();
  await user.type(composer(), "/");
  await user.click(screen.getByRole("option", { name: /\/history/ }));
  expect(await screen.findByRole("dialog", { name: "Chat history" })).toBeTruthy();
});

test("unavailable_commands_say_why_and_do_nothing", async () => {
  // No chat open: nothing to compact, no answer to log, nothing to clear.
  const user = userEvent.setup();
  known = groqModels();
  settings = groq;
  renderPanel();
  await screen.findByRole("textbox", { name: "Message" });
  await user.type(composer(), "/");
  expect(screen.getByRole("option", { name: /\/compact/ }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("Nothing to compact yet")).toBeTruthy();
  expect(screen.getByText("No answer yet")).toBeTruthy();
  await user.keyboard("{Enter}");
  expect(callsTo("ai_compact")).toHaveLength(0);
  expect(composer().value).toBe("/");
  await user.type(composer(), "log{Enter}");
  expect(composer().value).toBe("/log");
});

test("a_failed_compact_says_why", async () => {
  const user = await slashPanel(
    {
      ai_compact: () => {
        throw { kind: "ai", message: { kind: "rateLimited", retryAfterSecs: null } };
      },
    },
    longThread().t,
  );
  await user.type(composer(), "/compact{Enter}");
  expect((await screen.findByRole("alert")).textContent).toMatch(/Could not compact the chat\./);
});

test("slash_draft_never_sent", async () => {
  const user = await slashPanel();
  await user.type(composer(), "/compact");
  // Send with exactly one match runs the command; nothing goes to a model.
  routeInvoke({ ...handlersNow(), ai_compact: () => compactionOf({ threadId: "a" }) });
  await user.type(composer(), "{Enter}");
  await waitFor(() => expect(callsTo("ai_compact")).toHaveLength(1));
  await screen.findByText("Compacted 2 older messages into a summary").catch(() => {});
  expect(callsTo("ai_ask_stream")).toHaveLength(0);
  await user.type(composer(), "/xyz{Enter}");
  expect(callsTo("ai_ask_stream")).toHaveLength(0);
  expect(composer().value).toBe("/xyz");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(callsTo("ai_ask_stream")).toHaveLength(0);
  // After Esc, Enter on a lone "/" still sends nothing.
  await user.clear(composer());
  await user.type(composer(), "/{Escape}{Enter}");
  expect(callsTo("ai_ask_stream")).toHaveLength(0);
});

test("send_button_runs_a_single_match", async () => {
  const user = await slashPanel();
  await user.type(composer(), "/hist");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("dialog", { name: "Chat history" })).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(0);
});

test("slash_with_space_is_a_question", async () => {
  const user = await slashPanel();
  await user.type(composer(), "/compact the rest{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(askSent().question).toBe("/compact the rest");
  expect(callsTo("ai_compact")).toHaveLength(0);
});

test("no_dashes_or_cursor_words", async () => {
  const { SLASH_COMMANDS } = await import("./slash");
  const seen: string[] = SLASH_COMMANDS.flatMap((c) => [c.name, c.label, c.hint]);
  const read = (...els: HTMLElement[]) => els.forEach((e) => seen.push(e.textContent ?? ""));

  // No chat open: the notes and the empty list, read from the DOM.
  let user = userEvent.setup();
  known = groqModels();
  settings = groq;
  renderPanel();
  await screen.findByRole("textbox", { name: "Message" });
  seen.push(composer().placeholder);
  await user.type(composer(), "/");
  read(screen.getByRole("listbox", { name: "Commands" }));
  await user.type(composer(), "xyz");
  read(screen.getByText(/No command matches/));
  cleanup();

  // A failed compaction, and the clear confirmation.
  user = await slashPanel(
    {
      ai_compact: () => {
        throw { kind: "ai", message: { kind: "rateLimited", retryAfterSecs: null } };
      },
    },
    longThread().t,
  );
  await user.type(composer(), "/compact{Enter}");
  read(await screen.findByRole("alert"));
  await user.type(composer(), "/clear{Enter}");
  read(await screen.findByText(/Clear this chat\? Its messages are removed/));

  const text = seen.join("\n");
  expect(text).toMatch(/Nothing to compact yet/);
  expect(text).toMatch(/Could not compact the chat\./);
  expect(text).not.toMatch(/[\u2013\u2014]/);
  expect(text).not.toMatch(/cursor|caret/i);
});

// An open request takes effect once: the composer unmounts under the log view and mounts again.
test("sends_stays_collapsed_after_the_log_view", async () => {
  const user = await slashPanel();
  await user.type(composer(), "/sends{Enter}");
  const hide = (await screen.findByRole("button", { name: "Hide" })) as HTMLButtonElement;
  await waitFor(() => expect(hide.disabled).toBe(false));
  await user.click(hide);
  expect(await screen.findByRole("button", { name: "Show exactly" })).toBeTruthy();
  await user.type(composer(), "/log{Enter}");
  await user.click(await screen.findByRole("button", { name: "Back to the answer" }));
  expect(await screen.findByRole("button", { name: "Show exactly" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
});

test("history_and_model_stay_closed_after_the_log_view", async () => {
  const user = await slashPanel();
  await user.type(composer(), "/history{Enter}");
  await screen.findByRole("dialog", { name: "Chat history" });
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("textbox", { name: "Message" }));
  await user.type(composer(), "/model{Enter}");
  await screen.findByRole("dialog", { name: "Model" });
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("textbox", { name: "Message" }));
  await user.type(composer(), "/log{Enter}");
  await user.click(await screen.findByRole("button", { name: "Back to the answer" }));
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Model" })).toBeNull();
});

test("a_trailing_space_still_runs_the_command", async () => {
  const user = await slashPanel();
  await user.type(composer(), "/history {Enter}");
  expect(await screen.findByRole("dialog", { name: "Chat history" })).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(0);
});

test("escape_in_the_list_does_not_reach_outer_handlers", async () => {
  const user = await slashPanel();
  const outer = vi.fn();
  document.addEventListener("keydown", outer);
  await user.type(composer(), "/m{Escape}");
  document.removeEventListener("keydown", outer);
  expect(composer().value).toBe("/m");
  expect(outer.mock.calls.filter(([e]) => (e as KeyboardEvent).key === "Escape")).toHaveLength(0);
});

// ---- P11 part 2 ----

test("parity_P11_11_the_schema_row_counts_the_tables_the_core_sends", async () => {
  // A statement that names no table: the Core still sends the schema it picked.
  const open: AskContext = { ...ctx("schemaQuery"), sql: "SELECT 1", tables: [] };
  routeInvoke({
    ...handlersNow(),
    ai_preview: (a) => {
      const p = fakePreview(a.request as AskRequest);
      p.items.splice(1, 0, { kind: "cards", label: "Schema · 4 tables", bytes: 900, tokens: 225, locked: null, on: true });
      p.tables = { full: ["orders", "customers", "invoices"], namesOnly: ["payments"], leftOut: ["audit"], reasons: [] };
      return p;
    },
  });
  renderPanel({ context: open });
  expect(await screen.findByRole("button", { name: "schema of 4 tables" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /schema of 0 tables/ })).toBeNull();
});

test("parity_P11_15_the_thread_scrolls_to_the_new_turn_unless_scrolled_up", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  const thread = document.querySelector(".thread") as HTMLElement;
  let top = 0;
  Object.defineProperty(thread, "scrollHeight", { configurable: true, get: () => 2000 });
  Object.defineProperty(thread, "clientHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(thread, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
  stream.emit(delta("Add an index."));
  await waitFor(() => expect(top).toBe(2000));
  // The user scrolls up while it streams: the thread stays where they put it.
  top = 300;
  act(() => {
    thread.dispatchEvent(new Event("scroll"));
  });
  stream.emit(delta(" On created_at."));
  await screen.findByText("Add an index. On created_at.");
  expect(top).toBe(300);
  stream.emit(done());
  await waitFor(() => expect(callsTo("save_ai_thread")).toHaveLength(1));
  expect(top).toBe(300);
});

test("parity_P11_15_an_error_card_after_send_comes_into_view", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  const thread = document.querySelector(".thread") as HTMLElement;
  let top = 0;
  Object.defineProperty(thread, "scrollHeight", { configurable: true, get: () => 1500 });
  Object.defineProperty(thread, "clientHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(thread, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
  stream.emit(failed({ kind: "provider", status: 500, message: "Internal error." } as AiError));
  expect(await screen.findByRole("alert")).toBeTruthy();
  await waitFor(() => expect(top).toBe(1500));
});

test("parity_P11_20_a_closed_topic_previews_its_own_last_answer_as_plain_text", async () => {
  const { t, topics } = topicThread();
  const fenced = "Count them per carrier:\n```sql\nSELECT carrier, count(*) FROM shipments GROUP BY carrier\n```";
  t.messages[3] = { ...t.messages[3], text: fenced };
  // The Core's summary names another Topic's answer.
  withTopics(t, [{ ...topics[0], title: "count shipments by carrier", summary: "Set the carrier on that one parcel." }, topics[1]]);
  renderPanel();
  const fold = await screen.findByRole("button", { name: /count shipments by carrier/ });
  const sum = fold.querySelector(".topic-sum")!.textContent!;
  expect(sum).toBe("Count them per carrier: SELECT carrier, count(*) FROM shipments GROUP BY carrier. 4 messages.");
  expect(sum).not.toContain("```");
  expect(sum).not.toContain("Set the carrier");
});

test("parity_P11_29_esc_in_the_composer_stops_a_running_answer", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit(delta("Half an"));
  // The Stop button names its key.
  expect(screen.getByRole("button", { name: "Stop" }).closest(".comp-foot")!.querySelector("kbd")!.textContent).toBe("Esc");
  await user.type(screen.getByRole("textbox", { name: "Message" }), "{Escape}");
  const id = (callsTo("ai_ask_stream")[0].request as AskRequest).requestId;
  await waitFor(() => expect(callsTo("ai_cancel")).toEqual([{ requestId: id }]));
  expect(await screen.findByText("Stopped.")).toBeTruthy();
});

test("parity_P11_29_a_stop_with_nothing_received_shows_stopped_and_keeps_the_question", async () => {
  const user = userEvent.setup();
  await askHeld(user, "count shipments by carrier");
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Stopped.")).toBeTruthy();
  expect(screen.getByText(/^You stopped the answer after \d+(\.\d)?s, before anything arrived\.$/)).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("count shipments by carrier");
  expect(callsTo("save_ai_thread")).toHaveLength(0);
  // Retry asks the same question again, and the card goes.
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  expect((callsTo("ai_ask_stream")[1].request as AskRequest).question).toBe("count shipments by carrier");
  expect(screen.queryByText("Stopped.")).toBeNull();
});

test("parity_P11_39_the_meter_counts_the_summary_step_of_the_next_send", async () => {
  settings = groq;
  known = groqModels();
  routeInvoke({
    ...handlersNow(),
    ai_preview: (a) => {
      const p = fakePreview(a.request as AskRequest);
      p.tokens = 884;
      p.summary = { kind: "compact", topic: null, title: null, messages: 14, bytes: 75_432, tokens: 18_858, exact: "", on: true };
      return p;
    },
  });
  renderPanel();
  expect(await screen.findByTitle("About 19,742 of 131,072 tokens in use")).toBeTruthy();
});
