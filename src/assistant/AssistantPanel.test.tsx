import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { AiAccess, AiError, AiSettings, AiSettingsView, AiThread } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import AssistantPanel, { useAssistantHotkey } from "./AssistantPanel";
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
  useAssistantHotkey(() => setOpen((o) => !o));
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

test("chips_show_context_and_can_be_removed", async () => {
  const user = userEvent.setup();
  settings = groq;
  const { rerender } = renderPanel();
  const chips = within(await screen.findByRole("group", { name: "Context" }));
  expect(await chips.findByText("Selected SQL · lines 1 to 1")).toBeTruthy();
  expect(chips.getByText("Schema · orders")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.getByText(/SELECT \* FROM orders/, { selector: "pre" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Remove Selected SQL · lines 1 to 1" }));
  expect(screen.queryByText("Selected SQL · lines 1 to 1")).toBeNull();
  expect(screen.queryByText(/SELECT \* FROM orders/)).toBeNull();
  expect(screen.queryByRole("button", { name: /^Query text/ })).toBeNull();

  // Typing more SQL must not bring the removed chip back.
  const edited = { ...ctx("schemaQueryRows"), sql: "SELECT * FROM orders WHERE id = 1" };
  rerender(
    <AssistantPanel place="ungrouped" groupId={null} context={edited} schema={schema} onOpenSettings={() => {}} />,
  );
  expect(screen.queryByText("Selected SQL · lines 1 to 1")).toBeNull();
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
  await screen.findByText(/Groq/);
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.getByText(/To api\.groq\.com \(llama-3\.3-70b-versatile\)/)).toBeTruthy();
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
  await screen.findByText(/Groq/);
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
  expect(screen.getByText("No context from Shop prod")).toBeTruthy();
  expect(screen.getByText("Your question only")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.queryByText(/SELECT|orders/)).toBeNull();
  await user.type(screen.getByRole("textbox", { name: "Message" }), "why slow?{Enter}");
  await waitFor(() => expect(callsTo("ai_ask")).toHaveLength(1));
  expect((callsTo("ai_ask")[0].request as { payload: string }).payload).toBe("Only your question");
});

test("rows_switch_is_per_question", async () => {
  const user = userEvent.setup();
  settings = groq;
  askError = { kind: "notAvailable", provider: "groq" };
  renderPanel();
  await screen.findByText(/Groq/);
  const rows = () => screen.getByRole("button", { name: /^Sample rows/ });
  await user.click(rows());
  expect(rows().getAttribute("aria-pressed")).toBe("false");
  await user.type(screen.getByRole("textbox", { name: "Message" }), "one{Enter}");
  await screen.findByText(/Answers from Groq/);
  await user.type(screen.getByRole("textbox", { name: "Message" }), "two{Enter}");
  await waitFor(() => expect(callsTo("ai_ask")).toHaveLength(2));
  const [a, b] = callsTo("ai_ask").map((c) => (c.request as { payload: string }).payload);
  expect(a).not.toContain("Sample rows");
  expect(b).toContain("Sample rows");
  expect(rows().getAttribute("aria-pressed")).toBe("true");
});

test("threads_follow_the_group", async () => {
  threads = [thread("a", "group:g1", "Group one chat", 1), thread("b", "group:g2", "Group two chat", 2)];
  const { rerender } = renderPanel({ place: "group:g1", groupId: "g1", context: ctx("schema", "One DB") });
  const select = await screen.findByRole("combobox", { name: "Chat" });
  await waitFor(() => expect(within(select).getByText("Group one chat")).toBeTruthy());
  expect(within(screen.getByRole("group", { name: "Context" })).getByText("Schema · orders")).toBeTruthy();
  rerender(
    <AssistantPanel place="group:g2" groupId="g2" context={null} schema={null} onOpenSettings={() => {}} />,
  );
  await waitFor(() =>
    expect(within(screen.getByRole("combobox", { name: "Chat" })).getByText("Group two chat")).toBeTruthy(),
  );
  expect(screen.queryByText("Group one chat")).toBeNull();
  expect(screen.queryByText(/Schema ·/)).toBeNull();
});

test("clear_removes_the_groups_threads", async () => {
  const user = userEvent.setup();
  threads = [thread("a", "ungrouped", "Old chat", 1)];
  renderPanel();
  await screen.findByText("Old chat", { selector: "option" });
  await user.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("clear_ai_threads")).toEqual([{ place: "ungrouped" }]));
  expect(screen.queryByText("Old chat", { selector: "option" })).toBeNull();
});
