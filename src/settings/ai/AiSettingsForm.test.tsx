import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { AiError, AiSettings, AiSettingsView, ConnectionConfig } from "../../api/types";
import { callsTo, routeInvoke } from "../../test/invoke";
import AiSettingsForm from "./AiSettingsForm";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const empty: AiSettings = {
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
  ...empty,
  provider: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.3-70b-versatile",
};

const view = (over: Partial<AiSettingsView> = {}): AiSettingsView => ({
  settings: empty,
  groupOverride: false,
  keySaved: false,
  keyLast4: null,
  ...over,
});

const conn = (id: string, name: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name,
  dialect: "postgres",
  host: "127.0.0.1",
  port: 5432,
  user: "postgres",
  database: null,
  ssl: { mode: "disable" },
  groupId: null,
  file: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  ...over,
});

function renderForm(props: Partial<React.ComponentProps<typeof AiSettingsForm>> = {}) {
  const onConnectionSaved = vi.fn();
  render(
    <AiSettingsForm
      groupId={null}
      groupName={null}
      connections={[]}
      onConnectionSaved={onConnectionSaved}
      onCancel={() => {}}
      {...props}
    />,
  );
  return { onConnectionSaved };
}

const modelSelect = () => screen.getByLabelText("Model") as HTMLSelectElement;

test("picking_a_provider_fills_url_and_models", async () => {
  routeInvoke({ ai_settings: () => view() });
  renderForm();
  await userEvent.click(await screen.findByRole("radio", { name: /Groq/ }));

  expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://api.groq.com/openai/v1");
  expect(within(modelSelect()).getAllByRole("option")[0].textContent).toBe("llama-3.3-70b-versatile");
  expect(screen.queryByLabelText("Preset")).toBeNull();

  await userEvent.click(screen.getByRole("radio", { name: /^OpenAI-compatible/ }));
  const preset = screen.getByLabelText("Preset") as HTMLSelectElement;
  expect(
    within(preset)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["OpenAI", "OpenRouter", "Together AI"]);
  expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://api.openai.com/v1");

  await userEvent.selectOptions(preset, "OpenRouter");
  expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://openrouter.ai/api/v1");
  expect(within(modelSelect()).getAllByRole("option")[0].textContent).toBe("openrouter/auto");
  expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
});

test("type_a_name_switches_the_model_to_free_text", async () => {
  routeInvoke({
    ai_settings: () => view({ settings: groq }),
    save_ai_settings: () => undefined,
  });
  renderForm();
  await screen.findByRole("radio", { name: /Groq/ });
  await userEvent.selectOptions(modelSelect(), "Type a name…");

  const typed = screen.getByLabelText("Model") as HTMLInputElement;
  expect(typed.tagName).toBe("INPUT");
  await userEvent.clear(typed);
  await userEvent.type(typed, "my-tuned-model");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(1));
  expect((callsTo("save_ai_settings")[0].settings as AiSettings).model).toBe("my-tuned-model");
});

test("saved_key_shows_last_four_only", async () => {
  routeInvoke({
    ai_settings: () => view({ settings: groq, keySaved: true, keyLast4: "3f9a" }),
    save_ai_settings: () => undefined,
  });
  renderForm();
  expect(await screen.findByText("••••••••3f9a")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  expect(document.querySelector("input[type=password]")).toBeNull();

  // Saving without touching the key keeps it.
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(1));
  expect(callsTo("save_ai_settings")[0].key).toEqual({ t: "keep" });

  await userEvent.click(screen.getByRole("button", { name: "Remove" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(2));
  expect(callsTo("save_ai_settings")[1].key).toEqual({ t: "clear" });
});

test("a typed key is sent once and not kept after saving", async () => {
  let saved = false;
  routeInvoke({
    ai_settings: () => (saved ? view({ settings: groq, keySaved: true, keyLast4: "wxyz" }) : view({ settings: groq })),
    save_ai_settings: () => {
      saved = true;
    },
  });
  renderForm();
  const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
  await userEvent.type(key, "gsk_secret_wxyz");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("••••••••wxyz")).toBeTruthy();
  expect(callsTo("save_ai_settings")[0].key).toEqual({
    t: "set",
    value: "gsk_secret_wxyz",
  });
  expect(document.body.innerHTML).not.toContain("gsk_secret_wxyz");
});

test("test_shows_each_state", async () => {
  let failure: AiError | null = null;
  routeInvoke({
    ai_settings: () => view({ settings: groq, keySaved: true, keyLast4: "3f9a" }),
    save_ai_settings: () => undefined,
    ai_test: () => {
      if (failure) throw { kind: "ai", message: failure };
      return { model: "llama-3.3-70b-versatile", millis: 412 };
    },
  });
  renderForm();
  await screen.findByRole("radio", { name: /Groq/ });
  const test_ = () => userEvent.click(screen.getByRole("button", { name: "Test" }));

  await test_();
  expect(
    await screen.findByText(
      /Connected to Groq\. llama-3\.3-70b-versatile replied in 412 ms\. Only the test prompt was sent\./,
    ),
  ).toBeTruthy();

  failure = { kind: "badKey" };
  await test_();
  expect(await screen.findByText(/The key was rejected \(401 Unauthorized\)\./)).toBeTruthy();
  expect(screen.getByText(/Copy a new key from console\.groq\.com\/keys/)).toBeTruthy();

  failure = { kind: "rateLimited", retryAfterSecs: 24 };
  await test_();
  expect(await screen.findByText(/Rate limited \(429\)\./)).toBeTruthy();

  failure = { kind: "network", host: "api.groq.com" };
  await test_();
  expect(await screen.findByText(/Could not reach api\.groq\.com\./)).toBeTruthy();

  failure = { kind: "notAvailable", provider: "groq" };
  await test_();
  expect(await screen.findByText("Testing Groq arrives in a later DB View version. Nothing was sent.")).toBeTruthy();
  expect(callsTo("save_ai_settings").length).toBeGreaterThan(0);
});

test("group_override_checkbox_saves_per_group", async () => {
  const openai: AiSettings = {
    ...empty,
    provider: "openai",
    preset: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
  };
  let overridden = true;
  routeInvoke({
    ai_settings: (a) =>
      a.groupId === "g1" && overridden ? view({ settings: groq, groupOverride: true }) : view({ settings: openai }),
    save_ai_settings: (a) => {
      overridden = a.overrideGroup === true;
    },
  });
  renderForm({ groupId: "g1", groupName: "KFC" });
  const box = (await screen.findByLabelText("Use different settings for KFC")) as HTMLInputElement;
  expect(box.checked).toBe(true);
  expect((screen.getByRole("radio", { name: /Groq/ }) as HTMLInputElement).checked).toBe(true);

  // Unchecking loads the global settings, so Save never writes the Group's values to global.
  await userEvent.click(box);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("radio", {
          name: /^OpenAI-compatible/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true),
  );
  expect(callsTo("ai_settings").some((a) => a.groupId === null)).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(1));
  let call = callsTo("save_ai_settings")[0];
  expect(call.groupId).toBe("g1");
  expect(call.overrideGroup).toBe(false);
  expect((call.settings as AiSettings).provider).toBe("openai");

  await userEvent.click(box);
  await userEvent.click(screen.getByRole("radio", { name: /Groq/ }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(2));
  call = callsTo("save_ai_settings")[1];
  expect(call.overrideGroup).toBe(true);
  expect((call.settings as AiSettings).provider).toBe("groq");
});

test("no group checkbox without a Group", async () => {
  routeInvoke({ ai_settings: () => view() });
  renderForm();
  await screen.findByRole("radio", { name: /Groq/ });
  expect(screen.queryByLabelText(/Use different settings/)).toBeNull();
});

test("access_per_connection_table_saves_each_connection", async () => {
  const a = conn("c1", "KFC shop");
  const b = conn("c2", "KFC stores", {
    dialect: "mysql",
    aiAccess: "never",
    host: "h",
    user: "u",
  });
  routeInvoke({
    ai_settings: () => view(),
    set_connection_ai_access: (args) => ({
      ...(args.id === "c1" ? a : b),
      aiAccess: args.access as ConnectionConfig["aiAccess"],
    }),
  });
  const { onConnectionSaved } = renderForm({ connections: [a, b] });
  const select = (await screen.findByLabelText("What AI can see in KFC shop")) as HTMLSelectElement;
  expect(
    within(select)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["Never send anything", "Schema only", "Schema and query text", "Schema, query text and sample rows"]);
  expect(select.value).toBe("schema");
  expect(screen.getByText("PostgreSQL")).toBeTruthy();
  expect(screen.getByText("MySQL")).toBeTruthy();

  await userEvent.selectOptions(select, "Schema, query text and sample rows");
  await waitFor(() => expect(callsTo("set_connection_ai_access")).toHaveLength(1));
  expect(callsTo("set_connection_ai_access")[0]).toEqual({ id: "c1", access: "schemaQueryRows" });
  expect(onConnectionSaved).toHaveBeenCalled();

  await userEvent.selectOptions(screen.getByLabelText("What AI can see in KFC stores"), "Schema only");
  await waitFor(() => expect(callsTo("set_connection_ai_access")).toHaveLength(2));
  expect(callsTo("set_connection_ai_access")[1]).toEqual({ id: "c2", access: "schema" });
  // The narrow command never goes through save_connection, which would close the Connection's sessions.
  expect(callsTo("save_connection")).toHaveLength(0);
});

test("the form says saving sends nothing and has Cancel", async () => {
  routeInvoke({ ai_settings: () => view() });
  const onCancel = vi.fn();
  renderForm({ onCancel });
  expect(await screen.findByText("Saving sends nothing.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalled();
});
