import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { AiAccess, AiError, AiSettings, AiSettingsView, AiThread } from "../api/types";
import { iconElement, type IconName } from "../components/Icon";
import { callsTo, routeInvoke } from "../test/invoke";
import { useCommandKeys } from "../commands/useCommandKeys";
import AssistantPanel from "./AssistantPanel";
import type { AskContext } from "./context";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
let askError: AiError = { kind: "notConfigured" };

beforeEach(() => {
  threads = [];
  settings = none;
  askError = { kind: "notConfigured" };
  routeInvoke({
    ai_settings: () => view(settings),
    list_ai_threads: (a) => threads.filter((t) => t.place === a.place),
    save_ai_thread: () => undefined,
    clear_ai_threads: (a) => {
      threads = threads.filter((t) => t.place !== a.place);
    },
    ai_ask: () => {
      throw { kind: "ai", message: askError };
    },
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

test("sends_items_can_be_switched_off_and_stay_off_while_typing", async () => {
  const user = userEvent.setup();
  settings = groq;
  const { rerender } = renderPanel();
  const statement = async () => screen.findByRole("button", { name: /^the current statement/ });
  expect((await statement()).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "schema of 1 table" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.getByText(/SELECT \* FROM orders/, { selector: "pre" })).toBeTruthy();
  await user.click(await statement());
  expect(screen.queryByText(/SELECT \* FROM orders/)).toBeNull();
  expect((await statement()).getAttribute("aria-pressed")).toBe("false");

  // Typing more SQL must not switch it back on.
  const edited = { ...ctx("schemaQueryRows"), sql: "SELECT * FROM orders WHERE id = 1" };
  rerender(
    <AssistantPanel place="ungrouped" groupId={null} context={edited} schema={schema} onOpenSettings={() => {}} />,
  );
  expect((await statement()).getAttribute("aria-pressed")).toBe("false");
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await waitFor(() => expect(callsTo("ai_ask")).toHaveLength(1));
  const payload = (callsTo("ai_ask")[0].request as { payload: string }).payload;
  expect(payload).not.toContain("SELECT");
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
  await waitFor(() => expect(callsTo("ai_ask")).toHaveLength(1));
  expect((callsTo("ai_ask")[0].request as { payload: string }).payload).toBe("Only your question");
});

test("show_exactly_reveals_the_payload", async () => {
  const user = userEvent.setup();
  settings = groq;
  const first = renderPanel();
  await user.click(await screen.findByRole("button", { name: "Show exactly" }));
  expect(await screen.findByText(/To api\.groq\.com \(llama-3\.3-70b-versatile\)/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Hide" }));
  expect(screen.queryByText(/To api\.groq\.com/)).toBeNull();
  first.unmount();

  settings = none;
  renderPanel();
  await user.click(await screen.findByRole("button", { name: "Show exactly" }));
  expect(screen.getByText(/Nothing is sent until a provider is set\./)).toBeTruthy();
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
  askError = { kind: "notAvailable", provider: "groq" };
  renderPanel();
  await waitFor(() => expect(callsTo("ai_settings")).toHaveLength(1));
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  const note = "Answers from Groq arrive in a later Contura version. Nothing was sent.";
  expect(await screen.findByText(note)).toBeTruthy();
  await waitFor(() => expect(callsTo("save_ai_thread").length).toBeGreaterThan(0));
  const calls = callsTo("save_ai_thread");
  const saved = calls[calls.length - 1].thread as AiThread;
  expect(saved.place).toBe("ungrouped");
  expect(saved.messages.map((m) => [m.role, m.text])).toEqual([
    ["user", "why slow?"],
    ["notice", note],
  ]);
});

test("panel_says_what_it_cannot_see", async () => {
  const user = userEvent.setup();
  settings = groq;
  renderPanel({ context: ctx("never", "Shop prod") });
  expect(await screen.findByText("AI can't see Shop prod")).toBeTruthy();
  expect(
    screen.getByText(
      "Shop prod shares nothing with AI, so no schema, SQL or rows are sent. You can still ask general questions.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connection settings" })).toBeTruthy();
  expect(screen.getByText("your question")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /current statement|schema of/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.queryByText(/SELECT|orders/)).toBeNull();
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await waitFor(() => expect(callsTo("ai_ask")).toHaveLength(1));
  expect((callsTo("ai_ask")[0].request as { payload: string }).payload).toBe("Only your question");
});

test("sample_rows_is_shown_as_not_available_and_never_toggles", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = { kind: "notAvailable", provider: "groq" };
  renderPanel();
  const rows = await screen.findByRole("button", { name: /^Sample rows/ });
  expect(rows.getAttribute("aria-disabled")).toBe("true");
  expect(rows.getAttribute("title")).toBe("Sample rows arrive with a later step.");
  await user.click(rows);
  expect(rows.getAttribute("aria-pressed")).toBeNull();
  await user.type(screen.getByRole("textbox", { name: "Message" }), "one{Enter}");
  await waitFor(() => expect(callsTo("ai_ask")).toHaveLength(1));
  expect((callsTo("ai_ask")[0].request as { payload: string }).payload).not.toMatch(/sample rows/i);
});

const openHistory = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: "History" }));

test("threads_follow_the_group", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "group:g1", "Group one chat", 1), thread("b", "group:g2", "Group two chat", 2)];
  const { rerender } = renderPanel({ place: "group:g1", groupId: "g1", context: ctx("schema", "One DB") });
  await screen.findByText("Group one chat", { selector: ".msg-user" });
  expect(screen.getByRole("button", { name: "schema of 1 table" })).toBeTruthy();
  rerender(
    <AssistantPanel place="group:g2" groupId="g2" context={null} schema={null} onOpenSettings={() => {}} />,
  );
  await screen.findByText("Group two chat", { selector: ".msg-user" });
  expect(screen.queryByText("Group one chat")).toBeNull();
  expect(screen.queryByRole("button", { name: /schema of/ })).toBeNull();
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
  await userEvent.setup().click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.queryByText(/sample rows \(/i)).toBeNull();
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

test("answer_sql_renders_with_insert_run_and_copy", async () => {
  const user = userEvent.setup();
  const onInsert = vi.fn();
  const onRun = vi.fn().mockResolvedValue({ ran: true, rows: 8 });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  threads = [
    {
      id: "t",
      place: "ungrouped",
      title: "q",
      updatedAt: 1,
      messages: [
        { role: "user", text: "q", context: [], at: 1 },
        { role: "assistant", text: FENCED, context: [], at: 2 },
      ],
    },
  ];
  renderPanel({ onInsert, onRun });
  const block = await screen.findByRole("group", { name: "SQL answer" });
  expect(block.textContent).toContain("SELECT id FROM orders");
  expect(block.querySelector(".sql-block-gutter")).toBeNull();
  expect(screen.getByText("Join them:")).toBeTruthy();
  expect(screen.getByText("That is all.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Insert into the editor" }));
  expect(onInsert).toHaveBeenCalledWith("SELECT id FROM orders");
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith("SELECT id FROM orders");
  expect(screen.queryByText(/Inserted into the editor and run/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(onRun).toHaveBeenCalledWith("SELECT id FROM orders");
  expect(await screen.findByText("Inserted into the editor and run, 8 rows")).toBeTruthy();
});

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

test("a_run_that_did_not_happen_says_only_that_it_was_inserted", async () => {
  threads = [answerThread()];
  renderPanel({ onInsert: vi.fn(), onRun: vi.fn().mockResolvedValue({ ran: false }) });
  await userEvent.setup().click(await screen.findByRole("button", { name: "Run" }));
  expect(await screen.findByText("Inserted into the editor")).toBeTruthy();
  expect(screen.queryByText(/and run/)).toBeNull();
});

test("one_row_is_singular", async () => {
  threads = [answerThread()];
  renderPanel({ onInsert: vi.fn(), onRun: vi.fn().mockResolvedValue({ ran: true, rows: 1 }) });
  await userEvent.setup().click(await screen.findByRole("button", { name: "Run" }));
  expect(await screen.findByText("Inserted into the editor and run, 1 row")).toBeTruthy();
});

test("a_run_with_more_rows_than_the_first_page_says_plus", async () => {
  threads = [answerThread()];
  renderPanel({ onInsert: vi.fn(), onRun: vi.fn().mockResolvedValue({ ran: true, rows: 200, more: true }) });
  await userEvent.setup().click(await screen.findByRole("button", { name: "Run" }));
  expect(await screen.findByText("Inserted into the editor and run, 200+ rows")).toBeTruthy();
});

test("without_a_query_tab_insert_and_run_are_disabled", async () => {
  threads = [answerThread()];
  renderPanel();
  const insert = await screen.findByRole("button", { name: "Insert into the editor" });
  expect((insert as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
});
