import { EditorView, showTooltip } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { AiAccess, AiSettings, AiSettingsView, AskRequest } from "../api/types";
import ResultsPanel from "../query/ResultsPanel";
import { EMPTY_RUNNER, runnerReducer } from "../query/runner";
import SqlEditor, { type AskSelection, type SqlEditorApi } from "../query/SqlEditor";
import { KFC_SCHEMA } from "../lang/sql/fixtures";
import { mockEditorDom } from "../test/editor";
import { fakePreview } from "../test/aiPreview";
import { aiStream, delta, done, failed, line, sent, step } from "../test/aiStream";
import { callsTo, routeInvoke } from "../test/invoke";
import { mockReactFlowDom } from "../test/reactFlow";
import { type AskContext, type AskKit, type AskSetup, tablesIn } from "./context";
import InlineAsk from "./InlineAsk";
import appCss from "../styles/app.css?raw";
import { queueOffline } from "./offlineQueue";
import { sha256Hex } from "./sha256";

vi.mock("./offlineQueue", async (original) => {
  const actual = await original<typeof import("./offlineQueue")>();
  return { queueOffline: vi.fn(actual.queueOffline) };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));

beforeAll(() => {
  mockEditorDom();
  mockReactFlowDom();
});

const base: AiSettings = {
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
const view = (s: AiSettings): AiSettingsView => ({ settings: s, groupOverride: false, keySaved: false, keyLast4: null });
const groq: AiSettings = { ...base, provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" };

beforeEach(() => {
  routeInvoke({
    ai_settings: () => view(base),
    ai_preview: (a) => fakePreview(a.request as AskRequest),
    ai_ask_stream: () => {
      throw { kind: "ai", message: { kind: "notConfigured" } };
    },
  });
});

/** Routes a provider that answers with `stream`. */
function streaming(stream: ReturnType<typeof aiStream>) {
  routeInvoke({
    ai_settings: () => view(groq),
    ai_preview: (a) => fakePreview(a.request as AskRequest),
    ai_ask_stream: stream.handler,
    ai_cancel: () => true,
  });
}

const conn = (access: AiAccess = "schemaQuery") => ({
  id: "c1",
  name: "KFC shop",
  dialect: "postgres" as const,
  database: "kfc",
  access,
});

const SQL = "SELECT 1;\nSELECT * FROM orders;";

const previews = () => callsTo("ai_preview").map((c) => c.request as AskRequest);
const lastPreview = () => previews()[previews().length - 1];

/** Waits for the first preview, then opens "Show exactly". */
async function showExactly() {
  const button = (await screen.findByRole("button", { name: "Show exactly" })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

function Place({ inline = true, onOpenInChat = vi.fn(), onOpenSettings = vi.fn() }: Partial<Pick<AskKit, "onOpenInChat" | "onOpenSettings">> & { inline?: boolean }) {
  const editorRef = useRef<SqlEditorApi | null>(null);
  const [sel, setSel] = useState<AskSelection | null>(null);
  return (
    <>
      <SqlEditor
        value={SQL}
        dialect="postgres"
        editorRef={editorRef}
        onChange={() => {}}
        onRun={() => {}}
        onFormat={() => {}}
        onSave={() => {}}
        onEscape={() => false}
        onAsk={setSel}
        askButton={inline}
      />
      {sel && (
        <InlineAsk
          context={{
            kind: "sql",
            connection: conn(),
            sql: sel.sql,
            lines: sel.lines,
            tables: tablesIn(sel.sql, KFC_SCHEMA),
            label: "Query 1",
          }}
          schema={KFC_SCHEMA}
          groupId={null}
          onOpenInChat={onOpenInChat}
          onOpenSettings={onOpenSettings}
          onClose={() => {
            setSel(null);
            editorRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

function editorView(container: HTMLElement) {
  return EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
}
const askTips = (v: EditorView) => v.state.facet(showTooltip).filter((t) => t !== null);

test("selecting_sql_shows_ask_and_ctrl_i_opens_it", async () => {
  const { container } = render(<Place />);
  const v = editorView(container);
  expect(container.querySelector(".ask-btn")).toBeNull();
  act(() => v.dispatch({ selection: { anchor: 3, head: 3 } }));
  expect(container.querySelector(".ask-btn")).toBeNull();

  // The button sits at the end of the selection.
  act(() => v.dispatch({ selection: { anchor: 0, head: 8 } }));
  await waitFor(() => expect(container.querySelector(".ask-btn")).not.toBeNull());
  expect(askTips(v).some((t) => t!.pos === 8)).toBe(true);
  act(() => (container.querySelector(".ask-btn") as HTMLElement).click());
  expect(screen.getByRole("dialog", { name: "Ask AI" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Question" }), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();

  // Ctrl+I with nothing selected asks about the current statement.
  const at = SQL.indexOf("orders");
  act(() => v.dispatch({ selection: { anchor: at } }));
  fireEvent.keyDown(v.contentDOM, { key: "i", ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "Ask AI" })).toBeTruthy();
  await showExactly();
  expect(lastPreview().focus.sql).toContain("SELECT * FROM orders");
  expect(document.querySelector("pre.payload")!.textContent).toContain("SELECT * FROM orders");
});

test("actions_fit_the_place", () => {
  const labels = (kind: AskContext["kind"]) => {
    const { unmount } = render(
      <InlineAsk
        context={{ kind, connection: conn(), sql: "x", tables: [], label: "x" }}
        schema={null}
        groupId={null}
        onOpenSettings={() => {}}
        onClose={() => {}}
      />,
    );
    const names = screen
      .getAllByRole("button")
      .filter((b) => b.classList.contains("act"))
      .map((b) => b.textContent);
    unmount();
    return names;
  };
  expect(labels("sql")).toEqual(["Explain", "Optimize", "Suggest indexes"]);
  expect(labels("error")).toEqual(["Fix this error", "Explain", "Optimize", "Suggest indexes"]);
  expect(labels("filter")[0]).toBe("Write a WHERE for this filter");
  expect(labels("card")).toEqual(["Suggest indexes", "Generate DBML for…", "Explain"]);
});

test("esc_closes_and_focus_returns_to_the_editor", () => {
  const { container } = render(<Place />);
  const v = editorView(container);
  act(() => v.dispatch({ selection: { anchor: 0, head: 8 } }));
  fireEvent.keyDown(v.contentDOM, { key: "i", ctrlKey: true });
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Question" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Ask AI" })).toBeNull();
  expect(document.activeElement).toBe(v.contentDOM);
});

test("an_action_asks_and_shows_the_state", async () => {
  const onOpenSettings = vi.fn();
  const user = userEvent.setup();
  render(
    <InlineAsk
      context={{ kind: "sql", connection: conn(), sql: "SELECT * FROM orders", lines: [1, 1], tables: [{ schema: "sales", name: "orders" }], label: "Q" }}
      schema={KFC_SCHEMA}
      groupId={null}
      onOpenSettings={onOpenSettings}
      onClose={() => {}}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Explain" }));
  expect(await screen.findByText("Connect an AI provider in Settings")).toBeTruthy();
  const sent = callsTo("ai_ask_stream")[0].request as AskRequest;
  expect(sent.question).toBe("Explain");
  expect(sent.action).toBe("explain");
  expect(sent.connectionId).toBe("c1");
  expect(sent.focus.sql).toBe("SELECT * FROM orders");
  expect(sent.focus.tables).toEqual([{ schema: "sales", name: "orders" }]);
  await user.click(screen.getByRole("button", { name: "Connect a provider" }));
  expect(onOpenSettings).toHaveBeenCalled();
});

test("the_preview_follows_the_context_and_an_item_switched_off", async () => {
  const user = userEvent.setup();
  render(
    <InlineAsk
      context={{ kind: "sql", connection: conn(), sql: "SELECT * FROM orders", lines: [1, 1], tables: [{ schema: "sales", name: "orders" }], label: "Q" }}
      schema={KFC_SCHEMA}
      groupId="g1"
      onOpenSettings={() => {}}
      onClose={() => {}}
    />,
  );
  await waitFor(() => expect(previews().length).toBeGreaterThan(0));
  expect(lastPreview()).toMatchObject({
    place: "group:g1",
    groupId: "g1",
    connectionId: "c1",
    focus: { sql: "SELECT * FROM orders", tables: [{ schema: "sales", name: "orders" }] },
    off: [],
  });
  await user.click(await screen.findByRole("button", { name: /^Query text/ }));
  await waitFor(() => expect(lastPreview().off).toEqual(["sql"]));
  await user.click(screen.getByRole("button", { name: "Explain" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect((callsTo("ai_ask_stream")[0].request as AskRequest).off).toEqual(["sql"]);
});

const inline = (onClose = () => {}) =>
  render(
    <InlineAsk
      context={{ kind: "sql", connection: conn(), sql: "SELECT * FROM orders", lines: [1, 1], tables: [], label: "Q" }}
      schema={null}
      groupId={null}
      onOpenSettings={() => {}}
      onClose={onClose}
    />,
  );

test("the_answer_streams_into_the_box_with_its_sent_line", async () => {
  const stream = aiStream();
  stream.hold();
  streaming(stream);
  const user = userEvent.setup();
  inline();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit(sent({ model: "llama-3.3-70b-versatile" }), delta("It reads "));
  // The text is drawn on the next animation frame.
  expect(await screen.findByText("It reads")).toBeTruthy();
  stream.emit(delta("every order."));
  expect(await screen.findByText("It reads every order.")).toBeTruthy();
  const now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 19, 11, 42).getTime());
  try {
    stream.emit(done());
    expect(await screen.findByText("11:42 · Sent 2,314 B to Groq, llama-3.3-70b-versatile, 1.9s")).toBeTruthy();
  } finally {
    now.mockRestore();
  }
});

test("esc_cancels_inline", async () => {
  const stream = aiStream();
  stream.hold();
  streaming(stream);
  const onClose = vi.fn();
  const user = userEvent.setup();
  inline(onClose);
  await user.click(screen.getByRole("button", { name: "Explain" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit(delta("Half"));
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Ask AI" }), { key: "Escape" });
  const id = (callsTo("ai_ask_stream")[0].request as AskRequest).requestId;
  await waitFor(() => expect(callsTo("ai_cancel")).toEqual([{ requestId: id }]));
  expect(await screen.findByText("Stopped")).toBeTruthy();
  expect(screen.getByText("Half")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  // With nothing running, Esc closes.
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Ask AI" }), { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

test("an_inline_failure_retries_and_counts_tries", async () => {
  streaming(aiStream(() => [failed({ kind: "timeout", phase: "first byte" })]));
  const user = userEvent.setup();
  inline();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  expect(await screen.findByText("No reply from Groq for 60s.")).toBeTruthy();
  expect(screen.getByText("The request left this computer but nothing came back. Nothing ran on KFC shop.")).toBeTruthy();
  expect(screen.queryByText("Try 2")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Try 2")).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(2);
});

test("an_inline_error_card_counts_the_sample_selects_that_ran", async () => {
  // The budget left both tables out: no rows went, but two SELECTs ran on the database.
  const rows = step("rows", "0 rows from 0 tables", {
    evidence: [
      ["orders", "name match", "left out: over the budget"],
      ["customers", "name match", "left out: over the budget"],
    ],
  });
  streaming(aiStream(() => [rows, sent(), failed({ kind: "timeout", phase: "first byte" })]));
  const user = userEvent.setup();
  inline();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  expect(
    await screen.findByText(
      "The request left this computer but nothing came back. Contura read sample rows from 2 tables, read only. Nothing else ran on KFC shop.",
    ),
  ).toBeTruthy();
});

test("open_in_chat_carries_question_and_context", async () => {
  const onOpenInChat = vi.fn();
  const user = userEvent.setup();
  const context: AskContext = { kind: "sql", connection: conn(), sql: "SELECT 1", lines: [1, 1], tables: [], label: "Q" };
  render(
    <InlineAsk context={context} schema={null} groupId={null} onOpenInChat={onOpenInChat} onOpenSettings={() => {}} onClose={() => {}} />,
  );
  expect((screen.getByRole("button", { name: "Open in chat" }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByRole("textbox", { name: "Question" }), "why is this slow");
  await user.click(screen.getByRole("button", { name: "Open in chat" }));
  expect(onOpenInChat).toHaveBeenCalledWith({ question: "why is this slow", context });
});

function failedPanel(ask?: AskSetup) {
  let s = runnerReducer(EMPTY_RUNNER, { type: "start", stmts: [{ from: 0, to: 15, text: "SELECT id FROM x" }] });
  s = runnerReducer(s, { type: "begin", now: 0 });
  s = runnerReducer(s, { type: "failed", id: s.items[0].id, error: { kind: "query", message: "relation x does not exist" }, ms: 1 });
  const noop = () => {};
  return render(
    <ResultsPanel
      state={s}
      timeoutSecs={null}
      lineAt={() => 1}
      onSelect={noop}
      onPin={noop}
      onCloseUnpinned={noop}
      onFetchMore={noop}
      onCancel={noop}
      onRunAgain={noop}
      onGoTo={noop}
      ask={ask}
    />,
  );
}

const setup = (over: Partial<AskSetup> = {}): AskSetup => ({
  groupId: null,
  inlineAsk: true,
  errorAsk: true,
  onOpenSettings: () => {},
  connection: conn(),
  schema: null,
  ...over,
});

test("inline_ask_respects_the_setting", async () => {
  // inline_ask off: no button on a selection, Ctrl+I still opens it.
  const { container, unmount } = render(<Place inline={false} />);
  const v = editorView(container);
  act(() => v.dispatch({ selection: { anchor: 0, head: 8 } }));
  expect(container.querySelector(".ask-btn")).toBeNull();
  fireEvent.keyDown(v.contentDOM, { key: "i", ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "Ask AI" })).toBeTruthy();
  unmount();

  // error_ask off: no "Ask AI" on a failed query; on: it opens the inline Ask for the error.
  const off = failedPanel(setup({ errorAsk: false }));
  expect(screen.queryByRole("button", { name: "Ask AI" })).toBeNull();
  off.unmount();
  failedPanel(setup());
  await userEvent.setup().click(screen.getByRole("button", { name: "Ask AI" }));
  expect(screen.getByRole("button", { name: "Fix this error" })).toBeTruthy();
  await showExactly();
  expect(screen.getByText(/relation x does not exist/, { selector: "pre" })).toBeTruthy();
});

test("inline_ask_carries_the_current_model_and_picks", async () => {
  const user = userEvent.setup();
  const stream = aiStream(() => [delta("Fine."), done()]);
  routeInvoke({
    ai_settings: () => view({ ...groq, modelPrefs: { "llama-3.3-70b-versatile": { thinking: "off", caching: false } } }),
    ai_preview: (a) => fakePreview(a.request as AskRequest),
    ai_ask_stream: stream.handler,
    ai_cancel: () => true,
  });
  render(
    <InlineAsk
      context={{ kind: "sql", connection: conn(), sql: "SELECT * FROM orders", lines: [1, 1], tables: [], label: "Q" }}
      schema={KFC_SCHEMA}
      groupId={null}
      onOpenSettings={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findByText(/Groq · llama-3\.3-70b-versatile/);
  await user.click(screen.getByRole("button", { name: "Explain" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  const sent = callsTo("ai_ask_stream")[0].request as AskRequest;
  expect(sent.model).toBe("llama-3.3-70b-versatile");
  expect(sent.picks).toEqual({ thinking: "off", caching: false });
});

test("inline_confirm_key_host_then_retry", async () => {
  let confirmed = false;
  const stream = aiStream(() => (confirmed ? [delta("Fine."), done()] : [failed({ kind: "keyHostChanged", host: "api.example.com" })]));
  routeInvoke({
    ai_settings: () => view(groq),
    ai_preview: (a) => fakePreview(a.request as AskRequest),
    ai_ask_stream: stream.handler,
    ai_cancel: () => true,
    ai_confirm_key_host: () => {
      confirmed = true;
    },
  });
  const user = userEvent.setup();
  inline();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  await user.click(await screen.findByRole("button", { name: "Send the saved key to api.example.com" }));
  await waitFor(() => expect(callsTo("ai_confirm_key_host")).toEqual([{ groupId: null, host: "api.example.com" }]));
  expect(await screen.findByText("Fine.")).toBeTruthy();
  expect(callsTo("ai_ask_stream")).toHaveLength(2);
});

test("offline_uses_the_queue", async () => {
  const stream = aiStream((_, n) => (n === 1 ? [failed({ kind: "offline" })] : [delta("Fine."), done()]));
  streaming(stream);
  const user = userEvent.setup();
  inline();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  expect(await screen.findByText("No internet connection.")).toBeTruthy();
  expect(vi.mocked(queueOffline)).toHaveBeenCalledWith("inline:ungrouped", expect.any(Function));
  // The queue sends it on the online event; the card does not listen itself.
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
  expect(await screen.findByText("Fine.")).toBeTruthy();
  // Cancel takes it out of the queue.
  expect(screen.queryByText("No internet connection.")).toBeNull();
});

test("offline_cancel_leaves_the_queue", async () => {
  streaming(aiStream(() => [failed({ kind: "offline" })]));
  const user = userEvent.setup();
  inline();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  act(() => {
    window.dispatchEvent(new Event("online"));
  });
  expect(callsTo("ai_ask_stream")).toHaveLength(1);
});

test("inline_busy_has_no_stop", async () => {
  streaming(aiStream(() => [failed({ kind: "busy" })]));
  const user = userEvent.setup();
  inline();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  expect(await screen.findByText("An answer is still being written. Stop it first.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Stop it" })).toBeNull();
});

test("inline_stopped_shows_its_card", async () => {
  const stream = aiStream();
  stream.hold();
  streaming(stream);
  const user = userEvent.setup();
  inline();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit(delta("Half"));
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Stopped.")).toBeTruthy();
  expect(screen.getByText("Stopped")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(2));
});

test("inline_send_the_saved_key_twice_asks_once", async () => {
  let confirmed = false;
  const stream = aiStream(() => (confirmed ? [delta("Fine."), done()] : [failed({ kind: "keyHostChanged", host: "api.example.com" })]));
  routeInvoke({
    ai_settings: () => view(groq),
    ai_preview: (a) => fakePreview(a.request as AskRequest),
    ai_ask_stream: stream.handler,
    ai_cancel: () => true,
    ai_confirm_key_host: () => {
      confirmed = true;
    },
  });
  const user = userEvent.setup();
  inline();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  const send = await screen.findByRole("button", { name: "Send the saved key to api.example.com" });
  act(() => {
    send.click();
    send.click();
  });
  expect(await screen.findByText("Fine.")).toBeTruthy();
  expect(callsTo("ai_confirm_key_host")).toHaveLength(1);
  expect(callsTo("ai_ask_stream")).toHaveLength(2);
});

test("inline_answer_inserts_into_its_own_tab_through_the_diff", async () => {
  const stream = aiStream();
  stream.hold();
  streaming(stream);
  const user = userEvent.setup();
  let text = "SELECT 1;";
  const replaceRange = vi.fn((from: number, to: number, insert: string) => {
    text = text.slice(0, from) + insert + text.slice(to);
  });
  const editor = { text: () => text, runTarget: () => ({ from: 0, to: 8, text: "SELECT 1" }), replaceRange } as unknown as SqlEditorApi;
  const onOpenInNewTab = vi.fn();
  render(
    <InlineAsk
      context={{ kind: "sql", connection: conn(), sql: "SELECT 1", lines: [1, 1], tables: [], label: "Query 1" }}
      schema={null}
      groupId={null}
      onOpenSettings={vi.fn()}
      onClose={vi.fn()}
      insertTarget={{ editor: () => editor, name: "Query 1" }}
      onOpenInNewTab={onOpenInNewTab}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Optimize" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit(delta("Use this:\n```sql\nSELECT 2\n```"));
  stream.emit(
    done({ sqlBlocks: [{ fence: 0, label: "1 statement: 1 read", statements: [{ text: "SELECT 2", class: "read", flags: [] }], bodySha256: sha256Hex("SELECT 2") }] }),
  );
  expect(await screen.findByText("1 statement: 1 read")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  expect(replaceRange).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Insert into the editor" }).textContent).toContain("Replaces line 1 of Query 1");
  await user.click(screen.getByRole("button", { name: "Insert" }));
  expect(text).toBe("SELECT 2;");
  await user.click(screen.getByRole("button", { name: "Show answer" }));
  await user.click(screen.getByRole("button", { name: "Open in new tab" }));
  expect(onOpenInNewTab).toHaveBeenCalledWith("SELECT 2", conn());
});

/** An answer with one checked SQL block, in a box that inserts into a stand-in editor. */
async function answeredWithInsert(onClose = vi.fn()) {
  const stream = aiStream();
  stream.hold();
  streaming(stream);
  const user = userEvent.setup();
  let text = "SELECT 1;";
  const replaceRange = vi.fn((from: number, to: number, insert: string) => {
    text = text.slice(0, from) + insert + text.slice(to);
  });
  const editor = { text: () => text, runTarget: () => ({ from: 0, to: 8, text: "SELECT 1" }), replaceRange } as unknown as SqlEditorApi;
  render(
    <InlineAsk
      context={{ kind: "sql", connection: conn(), sql: "SELECT 1", lines: [1, 1], tables: [], label: "Query 1" }}
      schema={null}
      groupId={null}
      onOpenSettings={vi.fn()}
      onClose={onClose}
      insertTarget={{ editor: () => editor, name: "Query 1" }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Optimize" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit(delta("Use this:\n```sql\nSELECT 2\n```\nIt reads less."));
  stream.emit(
    done({ sqlBlocks: [{ fence: 0, label: "1 statement: 1 read", statements: [{ text: "SELECT 2", class: "read", flags: [] }], bodySha256: sha256Hex("SELECT 2") }] }),
  );
  expect(await screen.findByText("1 statement: 1 read")).toBeTruthy();
  return { user, onClose };
}

test("inline_insert_folds_the_box_to_one_line", async () => {
  const { user } = await answeredWithInsert();
  const box = screen.getByRole("dialog", { name: "Ask AI" });
  expect(box.classList.contains("ask-pop-folded")).toBe(false);
  // The live region is there, empty, before the insert, so its text is announced when it comes.
  const status = within(box).getByRole("status");
  expect(status.textContent).toBe("");
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  await user.click(screen.getByRole("button", { name: "Insert" }));
  // One line: what happened, Show answer and Close; the answer, the head and the actions are hidden, not dropped.
  expect(box.classList.contains("ask-pop-folded")).toBe(true);
  expect(box.querySelector(".pop-done-text")?.textContent).toBe("Inserted into the editor");
  expect(within(box).getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Inserted into the editor");
  expect(within(box).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Show answer", "Close"]);
  expect(box.querySelector(".pop-body[hidden]")?.textContent).toContain("It reads less.");
  expect(box.querySelector(".pop-head")?.hasAttribute("hidden")).toBe(true);
  // Focus stays in the box, so Esc still reaches it; the button is described by what happened.
  const show = within(box).getByRole("button", { name: "Show answer" });
  expect(document.activeElement).toBe(show);
  expect(show.getAttribute("aria-describedby")).toBe(box.querySelector(".pop-done-text")?.id);

  await user.click(within(box).getByRole("button", { name: "Show answer" }));
  expect(box.classList.contains("ask-pop-folded")).toBe(false);
  expect(within(box).getByText("It reads less.")).toBeTruthy();
  // The answer keeps its own Inserted line, and focus goes to the answer, where the arrow keys scroll it.
  expect(within(box).getByText("Inserted into the editor")).toBeTruthy();
  expect(document.activeElement).toBe(box.querySelector(".pop-body"));
});

test("inline_folded_box_closes_with_esc_and_close", async () => {
  const { user, onClose } = await answeredWithInsert();
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  await user.click(screen.getByRole("button", { name: "Insert" }));
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  await user.click(within(screen.getByRole("dialog", { name: "Ask AI" })).getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("inline_ask_again_after_insert_unfolds", async () => {
  const { user } = await answeredWithInsert();
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  await user.click(screen.getByRole("button", { name: "Insert" }));
  await user.click(screen.getByRole("button", { name: "Show answer" }));
  await user.click(screen.getByRole("button", { name: "Ask again" }));
  const box = screen.getByRole("dialog", { name: "Ask AI" });
  expect(box.classList.contains("ask-pop-folded")).toBe(false);
  expect(within(box).getByRole("textbox", { name: "Question" })).toBeTruthy();
});

/** The body of the app.css rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const text = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = text.indexOf(`\n${selector} {`);
  if (at < 0) return "";
  const open = text.indexOf("{", at);
  return text.slice(open + 1, text.indexOf("}", open));
}

test("the_box_over_the_editor_is_capped_and_scrolls_only_its_body", () => {
  const card = ruleBody(".query-editor .ask-pop");
  // About 60% of the editor, never past it.
  expect(card).toContain("max-height: clamp(min(240px, calc(100% - 2 * var(--spacing-sm))), 60%, calc(100% - 2 * var(--spacing-sm)));");
  // Never hidden: in an editor shorter than the head and the actions, the card itself scrolls to them.
  expect(card).toContain("overflow-y: auto;");
  expect(card).not.toContain("overflow: hidden");
  expect(card).toContain("flex-direction: column;");
  const body = ruleBody(".query-editor .ask-pop > .pop-body");
  expect(body).toContain("overflow-y: auto;");
  expect(body).toContain("min-height: 0;");
  expect(appCss).toMatch(/\.query-editor \.ask-pop > \.pop-head,\n\.query-editor \.ask-pop > \.pop-foot,\n\.query-editor \.ask-pop > \.pop-done \{\n {2}flex: none;/);
  expect(ruleBody(".ask-pop > [hidden]")).toContain("display: none;");
});

test("inline_show_log_in_place", async () => {
  const stream = aiStream();
  stream.hold();
  streaming(stream);
  const user = userEvent.setup();
  inline();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  stream.emit(line(0, "info", "question", ["chars", "7"]), sent(), delta("It reads every order."), done());
  await screen.findByText(/Sent 2,314 B/);
  await user.click(screen.getByRole("button", { name: "Show log" }));
  const box = screen.getByRole("dialog", { name: "Ask AI" });
  expect(within(box).getByText("Answer log")).toBeTruthy();
  expect(box.querySelectorAll(".lrow")).toHaveLength(1);
  expect(within(box).queryByText("It reads every order.")).toBeNull();
  await user.click(within(box).getByRole("button", { name: "Back to the answer" }));
  expect(within(box).getByText("It reads every order.")).toBeTruthy();
});

test("rows_switch_off_after_send", async () => {
  const user = userEvent.setup();
  inline();
  const rows = () => screen.findByRole("button", { name: /^Sample rows/ });
  await user.click(await rows());
  await waitFor(() => expect(lastPreview().switches.rows).toBe(true));
  expect(screen.getByText("Sends 10 sample rows from 2 tables, not kept")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Explain" }));
  await waitFor(() => expect(callsTo("ai_ask_stream")).toHaveLength(1));
  expect((callsTo("ai_ask_stream")[0].request as AskRequest).switches.rows).toBe(true);
  await user.click(await screen.findByRole("button", { name: "Ask again" }));
  await waitFor(() => expect(lastPreview().switches.rows).toBe(false));
  expect((await rows()).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText("No sample rows are sent")).toBeTruthy();
});

test("inline_state_line_follows_the_switch_and_the_copy_is_clean", async () => {
  const user = userEvent.setup();
  inline();
  await screen.findByRole("button", { name: /^Sample rows/ });
  expect(screen.getByText("Sample rows are off. They start off on every Ask.")).toBeTruthy();
  const text = () => document.querySelector(".ask-pop")!.textContent ?? "";
  expect(text()).not.toMatch(/[\u2013\u2014]|cursor|caret/i);
  await user.click(screen.getByRole("button", { name: /^Sample rows/ }));
  expect(await screen.findByText("Sample rows are on for this Ask only.")).toBeTruthy();
  expect(text()).not.toMatch(/[\u2013\u2014]|cursor|caret/i);
});

test("inline_state_line_is_absent_when_rows_are_locked", async () => {
  routeInvoke({
    ai_settings: () => view(base),
    ai_preview: (a) => fakePreview(a.request as AskRequest, "Shop shares schema only"),
  });
  inline();
  await screen.findByRole("button", { name: /^Sample rows/ });
  expect(screen.queryByText(/start off on every Ask/)).toBeNull();
  expect(screen.queryByText(/for this Ask only/)).toBeNull();
});

test("inline_no_table_line_only_for_the_core_no_named_table_label", async () => {
  routeInvoke({
    ai_settings: () => view(base),
    ai_preview: (a) => {
      const p = fakePreview(a.request as AskRequest);
      p.items = p.items.map((i) => (i.kind === "rows" && i.on ? { ...i, label: "Sample rows · no named table" } : i));
      p.rows = null;
      return p;
    },
  });
  const user = userEvent.setup();
  inline();
  await user.click(await screen.findByRole("button", { name: /^Sample rows/ }));
  expect(await screen.findByText("No sample rows are sent: no table is named")).toBeTruthy();
});
