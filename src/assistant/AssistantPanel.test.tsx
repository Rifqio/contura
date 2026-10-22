import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { AiAccess, AiError, AiEvent, AiSettings, AiSettingsView, AiThread, AskRequest, ContextInfo, ModelList, ModelPicks, SqlBlock } from "../api/types";
import type { SqlEditorApi } from "../query/SqlEditor";
import { splitStatements, statementAt } from "../query/statements";
import { iconElement, type IconName } from "../components/Icon";
import { fakePreview } from "../test/aiPreview";
import { aiStream, delta, done, failed, line, sent, step } from "../test/aiStream";
import { callsTo, routeInvoke } from "../test/invoke";
import { modelInfo, modelList } from "../test/settingsRoutes";
import { useCommandKeys } from "../commands/useCommandKeys";
import AssistantPanel from "./AssistantPanel";
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
/** What `ai_known_models` returns; `set_ai_model_prefs` updates it as the Core does. */
let known: ModelList = modelList([]);
/** What `ai_confirm_key_host` does; throwing makes it reject. */
let confirmKeyHost: () => void = () => {};
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
  known = modelList([]);
  confirmKeyHost = () => {};
  pickFails = false;
  routeInvoke({
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
      if (withValues) p.items.push({ kind: "values", label: "Literal values", bytes: 0, tokens: 0, locked: null, on: r.switches.values });
      return p;
    },
    list_ai_threads: (a) => threads.filter((t) => t.place === a.place),
    save_ai_thread: () => undefined,
    clear_ai_threads: (a) => {
      threads = threads.filter((t) => t.place !== a.place);
    },
    ai_ask_stream: (a) => {
      if (askError) throw { kind: "ai", message: askError };
      return stream.handler(a);
    },
    ai_cancel: () => true,
    ai_record_action: (a) => ({ kind: a.kind, at: 5 }),
  });
});

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

test("length_stop_shows_mark_without_continue", async () => {
  const user = userEvent.setup();
  await askHeld(user);
  stream.emit(delta("The first half"), done({ stop: "length" }));
  expect(await screen.findByText("Length limit")).toBeTruthy();
  expect(screen.getByText("The answer reached its length limit.")).toBeTruthy();
  expect(screen.getByText("It stopped at 120 output tokens.")).toBeTruthy();
  // Continue waits until the Core sends the thread's history (11e).
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

test("sample_rows_is_shown_as_not_available_and_never_toggles", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = null;
  renderPanel();
  const rows = await screen.findByRole("button", { name: /^Sample rows/ });
  expect(rows.getAttribute("aria-disabled")).toBe("true");
  expect(rows.getAttribute("title")).toBe("Sample rows arrive with a later step.");
  await user.click(rows);
  expect(rows.getAttribute("aria-pressed")).toBeNull();
  await user.type(screen.getByRole("textbox", { name: "Message" }), "one{Enter}");
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect(askSent().switches.rows).toBe(false);
});

const openHistory = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: "History" }));

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
  expect(screen.getByRole("menuitem", { name: "Group two chat" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Group one chat" })).toBeNull();
});

test("header_reads_ask_with_access_chip_history_and_close", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  renderPanel({ context: ctx("schemaQuery"), onClose });
  const head = document.querySelector(".ai-panel-head") as HTMLElement;
  expect(within(head).getByText("Ask")).toBeTruthy();
  expect(within(head).getByText("Schema and query text")).toBeTruthy();
  expect(within(head).getByRole("button", { name: "History" })).toBeTruthy();
  await user.click(within(head).getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalled();
  expect(within(head).queryByRole("combobox")).toBeNull();
});

test("history_menu_lists_threads_new_chat_and_clear", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1), thread("b", "ungrouped", "Newer chat", 2)];
  renderPanel();
  await screen.findByText("Newer chat", { selector: ".msg-user" });
  await openHistory(user);
  const menu = within(screen.getByRole("menu", { name: "History" }));
  const names = menu.getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"));
  expect(names).toEqual(["Newer chat", "Old chat", "New chat", "Clear chats"]);
  await user.click(menu.getByRole("menuitem", { name: "Old chat" }));
  expect(await screen.findByText("Old chat", { selector: ".msg-user" })).toBeTruthy();
  expect(screen.queryByText("Newer chat")).toBeNull();
  await openHistory(user);
  await user.click(screen.getByRole("menuitem", { name: "New chat" }));
  expect(screen.queryByText("Old chat")).toBeNull();
});

test("clear_chats_removes_the_groups_threads", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1)];
  renderPanel();
  await screen.findByText("Old chat", { selector: ".msg-user" });
  await openHistory(user);
  await user.click(screen.getByRole("menuitem", { name: "Clear chats" }));
  await waitFor(() => expect(callsTo("clear_ai_threads")).toEqual([{ place: "ungrouped" }]));
  expect(screen.queryByText("Old chat")).toBeNull();
});

test("composer_order_sends_line_input_subline_hint_and_send", async () => {
  renderPanel({ context: ctx("schemaQuery", "kestrel-main") });
  const input = await screen.findByRole("textbox", { name: "Message" });
  expect(input.getAttribute("placeholder")).toBe("Ask about kestrel-main");
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

test("the_sample_rows_line_always_says_none_are_sent", async () => {
  renderPanel({ context: ctx("schemaQueryRows") });
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.getByText("No sample rows are sent")).toBeTruthy();
  await showExactly(userEvent.setup());
  expect(screen.queryByText(/sample rows/i, { selector: "pre" })).toBeNull();
});

test("sends_items_have_their_own_icons", async () => {
  renderPanel({ context: ctx("schemaQuery") });
  const iconOf = (el: HTMLElement) => el.querySelector("path")?.getAttribute("d");
  const d = (name: IconName) => iconElement(name).querySelector("path")?.getAttribute("d");
  expect(iconOf(await screen.findByRole("button", { name: "schema of 1 table" }))).toBe(d("table"));
  expect(iconOf(screen.getByRole("button", { name: /^the current statement/ }))).toBe(d("fileQuery"));
  expect(iconOf(screen.getByText("your question"))).toBe(d("msg"));
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
  await waitFor(() => expect(screen.getByText("18.4K / 131K")).toBeTruthy());
  expect(screen.getByTitle("18,412 of 131,072 tokens in use")).toBeTruthy();
  // Typing the next question goes back to the estimate.
  await user.type(screen.getByRole("textbox", { name: "Message" }), "and");
  await waitFor(() => expect(screen.queryByTitle("18,412 of 131,072 tokens in use")).toBeNull());
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
  expect(screen.getByText("Length limit")).toBeTruthy();
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
