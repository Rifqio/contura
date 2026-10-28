import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AiSettings, ConnectionConfig, ToolUseRow, UiPrefs } from "../../api/types";
import { aiRecordToolResult, saveAiThread } from "../../api/client";
import { setPlatformForTests } from "../../platform";
import { callsTo } from "../../test/invoke";
import { aiView, GROQ, modelInfo, modelList, renderWithProviders, settingsRoutes } from "../../test/settingsRoutes";
import AboutSection from "./AboutSection";
import { onThreadsCleared } from "../../assistant/threadsCleared";
import { SENDS_OPEN_KEY, saveSendsOpen } from "../../assistant/sendsFold";
import AiSection, { AI_PAGE_ROWS, fetchedText } from "./AiSection";
import AppearanceSection from "./AppearanceSection";
import { FlashContext } from "./layout";
import DataFolderSection from "./DataFolderSection";
import EditorSection from "./EditorSection";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The app plugin calls Tauri from inside the package, past the core mock.
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("1.0.0") }));
const installed = vi.hoisted(() => new Set<string>());
vi.mock("../fontDetect", () => ({ isInstalled: (family: string) => installed.has(family) }));

afterEach(() => setPlatformForTests(null));

beforeEach(() => {
  installed.clear();
  const root = document.documentElement;
  root.removeAttribute("data-density");
  root.removeAttribute("data-brighter-comments");
  root.removeAttribute("data-grid-stripes");
  root.removeAttribute("style");
});

const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];
const lastPrefs = () => last(callsTo("save_ui_prefs"))?.prefs as UiPrefs;
const lastAi = () => last(callsTo("save_ai_settings"))!;

/** A model fact chip by its whole text: the window's number is set in bold apart from the words. */
const fact = (text: string) => (_: string, el: Element | null) => !!el?.classList.contains("mfact") && el.textContent === text;

/** An option's label, without the quiet hint at its right. */
const labelOf = (o: HTMLElement) => o.querySelector(".select-label")?.textContent;

async function choose(combobox: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: combobox }));
  const options = within(screen.getByRole("listbox", { name: combobox })).getAllByRole("option");
  await userEvent.click(options.find((o) => labelOf(o) === option)!);
}

const optionsOf = async (combobox: string) => {
  await userEvent.click(screen.getByRole("combobox", { name: combobox }));
  const names = within(screen.getByRole("listbox", { name: combobox })).getAllByRole("option").map(labelOf);
  await userEvent.keyboard("{Escape}");
  return names;
};

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
  production: false,
  readOnly: false,
  ...over,
});

// ---- Appearance ----

test("parity_P11_38_theme_cards_with_previews_and_follow_the_system", async () => {
  settingsRoutes();
  renderWithProviders(<AppearanceSection />);
  const group = screen.getByRole("radiogroup", { name: "Theme" });
  const radios = within(group).getAllByRole("radio");
  expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["Dark", "Light", "Follow the system"]);
  await waitFor(() => expect((within(group).getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true));

  // Each card draws real code in its own theme's tokens; Follow the system shows both.
  const card = (name: string) => within(group).getByRole("radio", { name }).closest(".theme-card") as HTMLElement;
  expect(card("Dark").querySelectorAll(".theme-dark .theme-preview-code")).toHaveLength(1);
  expect(card("Dark").querySelector(".theme-light")).toBeNull();
  expect(card("Light").querySelectorAll(".theme-light .theme-preview-code")).toHaveLength(1);
  expect(card("Follow the system").querySelectorAll(".theme-light, .theme-dark")).toHaveLength(2);
  expect(card("Dark").textContent).toContain("SELECT count(*)");
  expect(card("Dark").textContent).not.toMatch(/Dracula|Alucard/);
  expect(screen.getByText("Follow the system uses Light when the system is light and Dark when it is dark.")).toBeTruthy();

  await userEvent.click(within(group).getByRole("radio", { name: "Light" }));
  await waitFor(() => expect(lastPrefs()?.theme).toBe("light"));
  await userEvent.click(within(group).getByRole("radio", { name: "Follow the system" }));
  await waitFor(() => expect(lastPrefs()?.theme).toBe("system"));
});

test("row_height_saves_and_sets_compact_density", async () => {
  settingsRoutes();
  renderWithProviders(<AppearanceSection />);
  const group = screen.getByRole("radiogroup", { name: "Row height" });
  expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["28 px", "24 px, compact"]);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  await userEvent.click(within(group).getByRole("radio", { name: "24 px, compact" }));
  await waitFor(() => expect(lastPrefs()?.rowHeight).toBe(24));
  expect(document.documentElement.getAttribute("data-density")).toBe("compact");
  await userEvent.click(within(group).getByRole("radio", { name: "28 px" }));
  await waitFor(() => expect(lastPrefs()?.rowHeight).toBe(28));
  expect(document.documentElement.hasAttribute("data-density")).toBe(false);
});

test("stripe_every_other_row_saves_applies_and_shows_in_the_preview", async () => {
  settingsRoutes();
  const { container } = renderWithProviders(<AppearanceSection />);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  const sw = screen.getByRole("switch", { name: "Stripe every other row" });
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(container.querySelectorAll(".spv-row.alt")).toHaveLength(0);
  await userEvent.click(sw);
  await waitFor(() => expect(lastPrefs()?.stripeRows).toBe(true));
  expect(document.documentElement.hasAttribute("data-grid-stripes")).toBe(true);
  // Rows 2, 4 and 6 of the preview; row 3 is the selected one and keeps its colour.
  const rows = Array.from(container.querySelectorAll(".spv-row:not(.head)"));
  expect(rows.map((r) => r.className)).toEqual(["spv-row", "spv-row alt", "spv-row sel", "spv-row alt", "spv-row", "spv-row alt"]);
  await userEvent.click(sw);
  await waitFor(() => expect(lastPrefs()?.stripeRows).toBe(false));
  expect(document.documentElement.hasAttribute("data-grid-stripes")).toBe(false);
});

test("show_null_as_saves_and_the_preview_draws_it", async () => {
  settingsRoutes();
  const { container } = renderWithProviders(<AppearanceSection />);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  const group = screen.getByRole("radiogroup", { name: "Show NULL as" });
  expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["NULL", "\u2205", "blank"]);
  const nulls = () => Array.from(container.querySelectorAll(".spv-null")).map((n) => n.textContent);
  expect(nulls()).toEqual(["NULL", "NULL"]);
  // The sign is what shows; the screen reader hears its name, not a bare symbol it may skip.
  await userEvent.click(within(group).getByRole("radio", { name: "Empty set sign" }));
  await waitFor(() => expect(lastPrefs()?.nullAs).toBe("symbol"));
  expect(nulls()).toEqual(["\u2205", "\u2205"]);
  await userEvent.click(within(group).getByRole("radio", { name: "blank" }));
  await waitFor(() => expect(lastPrefs()?.nullAs).toBe("blank"));
  expect(nulls()).toEqual(["", ""]);
});

test("interface_size_saves_and_zooms_the_window", async () => {
  settingsRoutes({ set_interface_size: () => null });
  renderWithProviders(<AppearanceSection />);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  // The Core zoomed the window to the stored 100% at start: nothing to redo.
  const sizes = () => callsTo("set_interface_size").map((a) => a.size);
  expect(sizes()).toEqual([]);
  const group = screen.getByRole("radiogroup", { name: "Interface size" });
  expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["90%", "100%", "110%", "125%"]);
  expect(within(group).getByRole("radio", { name: "100%" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.click(within(group).getByRole("radio", { name: "125%" }));
  await waitFor(() => expect(lastPrefs()?.interfaceSize).toBe(125));
  // The Core zooms the window and raises its minimum, growing the window if it is now under it.
  expect(sizes()).toEqual([125]);
  await userEvent.click(within(group).getByRole("radio", { name: "90%" }));
  await waitFor(() => expect(lastPrefs()?.interfaceSize).toBe(90));
  expect(sizes()).toEqual([125, 90]);
});

// ---- Editor ----

test("editor_font_controls_apply_at_once_and_clamp", async () => {
  settingsRoutes();
  renderWithProviders(<EditorSection />);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  const size = screen.getByRole("spinbutton", { name: "Font size" }) as HTMLInputElement;
  const line = screen.getByRole("spinbutton", { name: "Line height" }) as HTMLInputElement;
  expect(size.value).toBe("13");
  expect(line.value).toBe("20");

  await userEvent.clear(size);
  await userEvent.type(size, "15");
  // Applied while typing, without leaving the field.
  await waitFor(() => expect(lastPrefs()?.editor.size).toBe(15));
  expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("15px");

  await userEvent.clear(size);
  await userEvent.type(size, "25");
  await userEvent.tab();
  await waitFor(() => expect(lastPrefs()?.editor.size).toBe(20));
  expect(size.value).toBe("20");

  await userEvent.clear(line);
  await userEvent.type(line, "9");
  await userEvent.tab();
  await waitFor(() => expect(lastPrefs()?.editor.lineHeight).toBe(16));
  expect(line.value).toBe("16");
  expect(document.documentElement.style.getPropertyValue("--editor-line-height")).toBe("16px");

  // Ligatures: the sample and the note that copied SQL never changes.
  expect(screen.getByText("!=")).toBeTruthy();
  expect(screen.getByText("->>")).toBeTruthy();
  expect(screen.getByText("Only the drawing changes. Copied and sent SQL stays as typed.")).toBeTruthy();
  await userEvent.click(screen.getByRole("switch", { name: "Ligatures" }));
  await waitFor(() => expect(lastPrefs()?.editor.ligatures).toBe(false));
  expect(document.documentElement.style.getPropertyValue("--editor-ligatures")).toBe("none");
});

test("family_lists_installed_fonts_only", async () => {
  installed.add("Consolas");
  settingsRoutes();
  renderWithProviders(<EditorSection />);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  expect(await optionsOf("Font")).toEqual(["JetBrains Mono", "Consolas"]);
  await choose("Font", "Consolas");
  await waitFor(() => expect(lastPrefs()?.editor.family).toBe("Consolas"));
  expect(document.documentElement.style.getPropertyValue("--editor-font-family")).toContain('"Consolas"');
});

test("brighter_comments_saves_and_applies_only_in_dracula", async () => {
  settingsRoutes();
  renderWithProviders(<EditorSection />);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  const sw = screen.getByRole("switch", { name: "Brighter comments" });
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("Dracula comments are faint by design. This swaps in a brighter blue, 5.5 to 1.")).toBeTruthy();
  await userEvent.click(sw);
  await waitFor(() => expect(lastPrefs()?.brighterComments).toBe(true));
  // The attribute is always set; tokens.css swaps the colour under Dracula only (tokens.test.ts).
  expect(document.documentElement.hasAttribute("data-brighter-comments")).toBe(true);
  expect(screen.queryByText("Used in Dracula only.")).toBeNull();
});

test("brighter_comments_says_dracula_only_under_alucard", async () => {
  settingsRoutes({}, { prefs: { theme: "light" } });
  renderWithProviders(<EditorSection />);
  expect(await screen.findByText("Used in Dracula only.")).toBeTruthy();
});

// ---- AI assistant ----

test("ai_key_without_a_keyring_service_says_the_key_is_kept_until_contura_closes", async () => {
  settingsRoutes({ secret_store_kind: () => "missing" });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  const note = await screen.findByText(
    "No keyring service was found, so the API key is kept only until Contura closes. Install GNOME Keyring or KeePassXC to save it.",
  );
  expect(screen.getByLabelText("API key").getAttribute("aria-describedby")).toBe(note.id);
  expect(screen.queryByText(/never in the data folder/)).toBeNull();
  expect(screen.queryByText(/passwords/)).toBeNull();
});

test("ai_key_with_a_silent_keyring_says_it_did_not_answer", async () => {
  settingsRoutes({ secret_store_kind: () => "noAnswer" });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  expect(
    await screen.findByText(
      "The keyring did not answer, so the API key is kept only until Contura closes. Restart Contura to try the keyring again.",
    ),
  ).toBeTruthy();
});

test("ai_rows_provider_model_key_new_connections_inline", async () => {
  settingsRoutes();
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  await screen.findByRole("combobox", { name: "Provider" });
  expect(await optionsOf("Provider")).toEqual(["None", "OpenAI-compatible", "Anthropic Claude", "Groq", "DeepSeek", "Custom"]);
  expect(screen.getByLabelText("API key")).toBeTruthy();
  expect(screen.getByText("Kept in the OS keyring (the Secret Service), never in the data folder.")).toBeTruthy();
  expect(screen.getByText("Default AI access. Production Connections always start at Never send anything.")).toBeTruthy();
  expect(
    screen.getByText("Suggests the rest of a statement where you are typing. Uses the Connection's AI access."),
  ).toBeTruthy();
  // No Group open: no per-Group switch. Inline Ask and Ask on errors stay (PR25).
  expect(screen.queryByRole("switch", { name: /Use different settings/ })).toBeNull();
  expect(screen.getByRole("switch", { name: "Inline Ask" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("switch", { name: "Ask on errors" }).getAttribute("aria-checked")).toBe("true");

  // Each change is saved at once, with the saved key left alone.
  await choose("Provider", "Groq");
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(1));
  expect(lastAi().settings).toMatchObject({ provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-20b" });
  expect(lastAi().key).toEqual({ t: "keep" });
  expect(lastAi().overrideGroup).toBe(false);

  await choose("Model", "openai/gpt-oss-120b");
  await waitFor(() => expect((lastAi().settings as AiSettings).model).toBe("openai/gpt-oss-120b"));
  expect(lastAi().settings).toMatchObject({ temperature: null, maxTokens: null });

  expect(await optionsOf("New Connections")).toEqual([
    "Never send anything",
    "Schema only",
    "Schema and query text",
    "Schema, query text and sample rows",
  ]);
  await choose("New Connections", "Never send anything");
  await waitFor(() => expect((lastAi().settings as AiSettings).newConnectionAccess).toBe("never"));

  await userEvent.click(screen.getByRole("switch", { name: "Ask on errors" }));
  await waitFor(() => expect((lastAi().settings as AiSettings).errorAsk).toBe(false));

  await userEvent.click(screen.getByRole("switch", { name: "Inline suggestions" }));
  await waitFor(() => expect(lastPrefs()?.inlineSuggestions).toBe(true));
});

test("group_switch_saves_per_group", async () => {
  let overridden = false;
  settingsRoutes({
    ai_settings: (a) => (a.groupId === "g1" && overridden ? aiView({ settings: GROQ, groupOverride: true }) : aiView()),
    save_ai_settings: (a) => {
      overridden = a.overrideGroup === true;
    },
  });
  renderWithProviders(<AiSection groupId="g1" groupName="KFC" connections={[]} onConnectionSaved={() => {}} />);
  const sw = await screen.findByRole("switch", { name: "Use different settings for KFC" });
  expect(sw.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(sw);
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(1));
  expect(lastAi()).toMatchObject({ groupId: "g1", overrideGroup: true });
  await choose("Provider", "Groq");
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(2));
  expect(lastAi()).toMatchObject({ groupId: "g1", overrideGroup: true });

  // Off again: the global settings come back and are written as they were, so the Group's never reach them.
  await userEvent.click(screen.getByRole("switch", { name: "Use different settings for KFC" }));
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(3));
  expect(lastAi().overrideGroup).toBe(false);
  expect((lastAi().settings as AiSettings).provider).toBe(null);
  expect(callsTo("ai_settings").some((a) => a.groupId === null)).toBe(true);
});

test("api_key_keeps_its_own_save_and_test", async () => {
  let saved = false;
  settingsRoutes({
    ai_settings: () => (saved ? aiView({ settings: GROQ, keySaved: true, keyLast4: "wxyz" }) : aiView({ settings: GROQ })),
    save_ai_settings: (a) => {
      if ((a.key as { t: string }).t === "set") saved = true;
    },
  });
  const props = { groupName: null, connections: [], onConnectionSaved: () => {} };
  const { rerender } = renderWithProviders(<AiSection groupId={null} {...props} />);
  const key = (await screen.findByLabelText("API key")) as HTMLInputElement;
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  const testButton = screen.getByRole("button", { name: "Test" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  await userEvent.type(key, "gsk_secret_wxyz ");
  // A half-typed key is never saved or tested.
  expect(callsTo("save_ai_settings")).toHaveLength(0);
  expect(testButton.disabled).toBe(true);
  expect(key.type).toBe("password");
  await userEvent.click(screen.getByRole("button", { name: "Show the API key" }));
  expect(key.type).toBe("text");

  // Changing the open Group reloads the settings but keeps the key being typed (R23).
  rerender(<AiSection groupId="g2" {...props} />);
  await waitFor(() => expect(callsTo("ai_settings").some((a) => a.groupId === "g2")).toBe(true));
  expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("gsk_secret_wxyz ");

  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(1));
  expect(lastAi()).toMatchObject({ groupId: "g2", key: { t: "set", value: "gsk_secret_wxyz" } });
  expect(await screen.findByText("••••••••wxyz")).toBeTruthy();
  expect(document.body.innerHTML).not.toContain("gsk_secret_wxyz");

  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText(/Connected to Groq\. openai\/gpt-oss-20b replied in 412ms\. Only the test prompt was sent\./)).toBeTruthy();
  expect(callsTo("ai_test")).toEqual([{ groupId: "g2" }]);
  // Testing saves nothing.
  expect(callsTo("save_ai_settings")).toHaveLength(1);
});

test("test_failures_say_what_went_wrong", async () => {
  let failure: unknown = { kind: "ai", message: { kind: "badKey" } };
  settingsRoutes({
    ai_settings: () => aiView({ settings: GROQ, keySaved: true, keyLast4: "3f9a" }),
    ai_test: () => {
      throw failure;
    },
  });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Test" }));
  expect(await screen.findByText(/The key was rejected \(401 Unauthorized\)\./)).toBeTruthy();
  expect(screen.getByText(/Copy a new key from console\.groq\.com\/keys/)).toBeTruthy();
  failure = { kind: "ai", message: { kind: "network", host: "api.groq.com" } };
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText(/Could not reach api\.groq\.com\./)).toBeTruthy();
});

test("a_test_result_goes_with_a_group_change", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ, keySaved: true, keyLast4: "3f9a" }) });
  const props = { groupName: null, connections: [], onConnectionSaved: () => {} };
  const { rerender } = renderWithProviders(<AiSection groupId="g1" {...props} />);
  await userEvent.click(await screen.findByRole("button", { name: "Test" }));
  expect(await screen.findByText(/Connected to Groq/)).toBeTruthy();
  rerender(<AiSection groupId="g2" {...props} />);
  await waitFor(() => expect(screen.queryByText(/Connected to Groq/)).toBeNull());
});

test("a_save_during_a_group_change_never_writes_the_old_groups_settings_into_the_new_one", async () => {
  let release: (() => void) | null = null;
  settingsRoutes({
    ai_settings: (a) =>
      a.groupId === "g2"
        ? new Promise((done) => (release = () => done(aiView({ settings: GROQ, groupOverride: true }))))
        : aiView({ settings: GROQ, keySaved: true, keyLast4: "3f9a" }),
  });
  const props = { groupName: null, connections: [], onConnectionSaved: () => {} };
  const { rerender } = renderWithProviders(<AiSection groupId="g1" {...props} />);
  await screen.findByRole("combobox", { name: "Model" });
  rerender(<AiSection groupId="g2" {...props} />);
  // While g2 loads, g1's settings are not on screen to be changed and saved as g2's.
  expect(await screen.findByText("Loading AI settings...")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
  expect(callsTo("save_ai_settings")).toHaveLength(0);
  await waitFor(() => expect(release).not.toBeNull());
  release!();
  await screen.findByRole("combobox", { name: "Model" });
  await choose("Model", "openai/gpt-oss-120b");
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(1));
  expect(lastAi()).toMatchObject({ groupId: "g2", overrideGroup: true });
});

test("saved_key_is_removed_only_after_asking", async () => {
  // Mocked router only: no real Credential Manager entry is read or removed.
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ, keySaved: true, keyLast4: "3f9a" }) });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText("••••••••3f9a")).toBeTruthy();
  const trash = () => screen.getByRole("button", { name: "Remove the saved API key" });

  await userEvent.click(trash());
  let ask = screen.getByRole("dialog", { name: "Remove the API key?" });
  expect(ask.textContent).toContain("Contura forgets the key for Groq. You can paste it again later.");
  expect(document.activeElement).toBe(within(ask).getByRole("button", { name: /Cancel/ }));
  expect(callsTo("save_ai_settings")).toHaveLength(0);
  await userEvent.click(within(ask).getByRole("button", { name: /Cancel/ }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("save_ai_settings")).toHaveLength(0);

  await userEvent.click(trash());
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("save_ai_settings")).toHaveLength(0);

  await userEvent.click(trash());
  ask = screen.getByRole("dialog", { name: "Remove the API key?" });
  await userEvent.click(within(ask).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(1));
  expect(lastAi().key).toEqual({ t: "clear" });
  // The other settings go back unchanged, temperature and max tokens with them.
  expect(lastAi().settings).toEqual(GROQ);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("groq_preset_fills_base_url", async () => {
  settingsRoutes();
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  await screen.findByRole("combobox", { name: "Provider" });
  await choose("Provider", "Groq");
  await waitFor(() => expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://api.groq.com/openai/v1"));
  expect(await optionsOf("Model")).toEqual([
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b",
    "Type a name...",
  ]);
  expect(lastAi().settings).toMatchObject({ provider: "groq", model: "openai/gpt-oss-20b" });

  await choose("Provider", "OpenAI-compatible");
  await choose("Preset", "OpenRouter");
  await waitFor(() => expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://openrouter.ai/api/v1"));
  await waitFor(() => expect(lastAi().settings).toMatchObject({ provider: "openai", preset: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" }));

  await choose("Provider", "Anthropic Claude");
  await waitFor(() => expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://api.anthropic.com"));
  expect(await optionsOf("Model")).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1", "Type a name..."]);
  await waitFor(() => expect((lastAi().settings as AiSettings).model).toBe("claude-sonnet-5-5"));
});

test("models_fetched_list_replaces_builtin", async () => {
  settingsRoutes({
    ai_settings: () => aiView({ settings: GROQ, keySaved: true, keyLast4: "3f9a" }),
    ai_models: () => modelList([modelInfo(), modelInfo({ id: "moonshotai/kimi-k2-instruct", name: "Kimi K2" })], Date.now()),
  });
  renderWithProviders(<AiSection groupId="g1" groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText("2 models from api.groq.com. Fetched just now.")).toBeTruthy();
  expect(callsTo("ai_models")).toEqual([{ groupId: "g1" }]);
  expect(await optionsOf("Model")).toEqual(["openai/gpt-oss-20b", "moonshotai/kimi-k2-instruct", "Type a name..."]);
  await choose("Model", "moonshotai/kimi-k2-instruct");
  await waitFor(() => expect((lastAi().settings as AiSettings).model).toBe("moonshotai/kimi-k2-instruct"));
  expect(fetchedText(0, 2 * 60_000 + 5_000)).toBe("Fetched 2m ago");
  expect(fetchedText(0, 10_000)).toBe("Fetched just now");
});

test("refresh_shows_fetched_just_now", async () => {
  let at = Date.now() - 3 * 60_000;
  settingsRoutes({
    ai_settings: () => aiView({ settings: GROQ, keySaved: true, keyLast4: "3f9a" }),
    ai_models: () => modelList([modelInfo()], at),
  });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText("1 model from api.groq.com. Fetched 3m ago.")).toBeTruthy();
  at = Date.now();
  await userEvent.click(screen.getByRole("button", { name: "Fetch again" }));
  expect(await screen.findByText("1 model from api.groq.com. Fetched just now.")).toBeTruthy();
  expect(screen.queryByText(/Fetched 3m ago/)).toBeNull();
  expect(callsTo("ai_models")).toHaveLength(2);
});

test("model_facts_chips", async () => {
  settingsRoutes({
    ai_settings: () => aiView({ settings: GROQ, keySaved: true, keyLast4: "3f9a" }),
    ai_models: () => modelList([modelInfo({ contextWindow: 131_072 })], Date.now()),
  });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText(fact("131K token context window"))).toBeTruthy();
  expect(screen.getByText("Shares its thinking")).toBeTruthy();
  expect(screen.getByText("Prompt caching")).toBeTruthy();
  expect(screen.getByText(/Fetched just now/)).toBeTruthy();
});

test("model_facts_come_from_the_known_list_without_a_key", async () => {
  settingsRoutes({
    ai_settings: () => aiView({ settings: GROQ }),
    ai_known_models: () => modelList([modelInfo({ sharesThinking: false, caching: "none", contextWindow: 8_192 })]),
  });
  renderWithProviders(<AiSection groupId="g1" groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText(fact("8K token context window"))).toBeTruthy();
  expect(callsTo("ai_known_models")[0]).toEqual({ groupId: "g1" });
  expect(callsTo("ai_models")).toHaveLength(0);
  expect(screen.queryByText("Shares its thinking")).toBeNull();
  expect(screen.queryByText("Prompt caching")).toBeNull();
  expect(screen.queryByText(/Fetched/)).toBeNull();
  expect(screen.getByText("The built-in list. Save an API key to fetch the provider's own.")).toBeTruthy();
});

test("context_window_field_only_for_unknown", async () => {
  const props = { groupId: null, groupName: null, connections: [], onConnectionSaved: () => {} };
  let settings: AiSettings = GROQ;
  let known = [modelInfo()];
  settingsRoutes({
    ai_settings: () => aiView({ settings }),
    ai_known_models: () => modelList(known),
    save_ai_settings: (a) => {
      settings = a.settings as AiSettings;
      // The Core gives an unknown model the saved window.
      known = known.map((m) => (m.known ? m : { ...m, contextWindow: settings.contextWindow ?? 8_000 }));
    },
  });
  const first = renderWithProviders(<AiSection {...props} />);
  expect(await screen.findByText(fact("131K token context window"))).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Context window" })).toBeNull();
  first.unmount();

  // A model nothing is known about: its window is asked for.
  settings = { ...GROQ, model: "my-model" };
  known = [modelInfo({ id: "my-model", name: "my-model", known: false, contextWindow: 8_000 })];
  const second = renderWithProviders(<AiSection {...props} />);
  const field = (await screen.findByRole("textbox", { name: "Context window" })) as HTMLInputElement;
  expect(await screen.findByText(fact("8K token context window"))).toBeTruthy();
  await userEvent.type(field, "32768{Enter}");
  await waitFor(() => expect((lastAi().settings as AiSettings).contextWindow).toBe(32_768));
  expect(field.value).toBe("32,768");
  // The chip follows the saved window at once.
  expect(await screen.findByText(fact("33K token context window"))).toBeTruthy();
  expect(screen.queryByText(fact("8K token context window"))).toBeNull();
  // Enter then leaving the field saves once.
  await userEvent.click(document.body);
  expect(callsTo("save_ai_settings")).toHaveLength(1);
  second.unmount();

  // Custom always asks.
  settings = { ...GROQ, provider: "custom", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1:8b", contextWindow: 16_000 };
  known = [];
  renderWithProviders(<AiSection {...props} />);
  expect(((await screen.findByRole("textbox", { name: "Context window" })) as HTMLInputElement).value).toBe("16,000");
});

test("defaults_save_with_settings", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ }) });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  const thinking = await screen.findByRole("radiogroup", { name: "Default thinking level" });
  expect(within(thinking).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Off", "Low", "Medium", "High"]);
  expect(screen.getByText("Each model remembers the level you last picked for it.")).toBeTruthy();
  const caching = screen.getByRole("switch", { name: "Use prompt caching when the model supports it" });
  expect(caching.getAttribute("aria-checked")).toBe("true");
  const share = screen.getByRole("switch", { name: "Ask models to share their thinking when they support it" });
  expect(share.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("Shown in Show log as the provider returned it. Never sent back.")).toBeTruthy();

  await userEvent.click(within(thinking).getByRole("radio", { name: "High" }));
  await userEvent.click(caching);
  await waitFor(() => expect(lastAi().settings).toMatchObject({ defaultThinking: "high", promptCaching: false }));
  // The per-model picks and the other new fields go back as they were.
  expect(lastAi().settings).toMatchObject({ shareThinking: true, keepExactText: false, modelPrefs: GROQ.modelPrefs });
  await userEvent.click(share);
  await waitFor(() => expect(lastAi().settings).toMatchObject({ defaultThinking: "high", promptCaching: false, shareThinking: false }));
});

test("privacy_keep_exact_text", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ }) });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByRole("heading", { name: "History" })).toBeTruthy();
  const keep = screen.getByRole("switch", { name: "Keep the exact text sent with each answer" });
  expect(keep.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("The text can contain your schema and SQL. data/ is portable and not encrypted.")).toBeTruthy();
  await userEvent.click(keep);
  await waitFor(() => expect((lastAi().settings as AiSettings).keepExactText).toBe(true));
  expect(lastAi().settings).toMatchObject({ temperature: 0.5, maxTokens: 1024, modelPrefs: GROQ.modelPrefs });
});

/** The access table opens from Privacy's Edit access. */
const openAccess = async () => userEvent.click(await screen.findByRole("button", { name: "Edit access..." }));

const renderAi = () =>
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);

test("pick_tables_switch_saves", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: { ...GROQ, pickTables: true } }) });
  renderAi();
  const pick = await screen.findByRole("switch", { name: "Let the assistant pick tables in large databases" });
  expect(pick.getAttribute("aria-checked")).toBe("true");
  expect(
    screen.getByText(
      "Ask, on large databases. The model names the tables it needs from an outline of table names, and Contura sends only those. One extra step per Ask.",
    ),
  ).toBeTruthy();
  await userEvent.click(pick);
  await waitFor(() => expect((lastAi().settings as AiSettings).pickTables).toBe(false));
  expect(lastAi().settings).toMatchObject({ keepExactText: false, modelPrefs: GROQ.modelPrefs });
});

test("pick_tables_in_a_groups_own_settings", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: { ...GROQ, pickTables: true }, groupOverride: true }) });
  renderWithProviders(<AiSection groupId="g1" groupName="KFC" connections={[]} onConnectionSaved={() => {}} />);
  // Ruling 13: Pick tables is a Privacy switch, the same for every Group, so a Group's own settings do not show it.
  expect(await screen.findByText("Privacy and thinking settings are the same for every Group. Change them without a Group open.")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Let the assistant pick tables in large databases" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "Keep the exact text sent with each answer" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "Show the Sends list open" })).toBeNull();
});

test("sends_open_switch_sets_the_remembered_fold", async () => {
  localStorage.removeItem(SENDS_OPEN_KEY);
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ }) });
  renderAi();
  const sw = await screen.findByRole("switch", { name: "Show the Sends list open" });
  // Off by default: the Ask panel's Sends list starts folded.
  expect(sw.getAttribute("aria-checked")).toBe("false");
  await userEvent.click(sw);
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(localStorage.getItem(SENDS_OPEN_KEY)).toBe("1");
  // The chevron in an open panel moves the same switch.
  act(() => saveSendsOpen(false));
  expect(sw.getAttribute("aria-checked")).toBe("false");
  // It is a choice on this computer, not an AI setting saved to the Core.
  expect(callsTo("save_ai_settings")).toHaveLength(0);
  localStorage.removeItem(SENDS_OPEN_KEY);
});

test("auto_compact_switch_global_only", async () => {
  const label = "Compact the thread when the context window is nearly full";
  const help =
    "At 85% of the model's window, older messages become a short summary written by the same model. Sends only text this thread already sent. The summary shows in the thread, and Undo brings the messages back.";
  settingsRoutes({ ai_settings: () => aiView({ settings: { ...GROQ, autoCompact: true } }) });
  const { unmount } = renderAi();
  const auto = await screen.findByRole("switch", { name: label });
  // It sits in Behaviour, Answers, after share thinking and prompt caching.
  const answers = screen.getByRole("region", { name: "Answers" });
  expect(within(answers).getAllByRole("switch")).toEqual([
    within(answers).getByRole("switch", { name: "Ask models to share their thinking when they support it" }),
    within(answers).getByRole("switch", { name: "Use prompt caching when the model supports it" }),
    auto,
    within(answers).getByRole("switch", { name: "Name chats with the AI" }),
  ]);
  expect(auto.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(help)).toBeTruthy();
  await userEvent.click(auto);
  await waitFor(() => expect((lastAi().settings as AiSettings).autoCompact).toBe(false));
  expect(lastAi().settings).toMatchObject({ keepExactText: false, pickTables: true, modelPrefs: GROQ.modelPrefs });
  unmount();

  // Off in the settings it saved: the switch reads off. Not stored yet: the Core's default, on.
  settingsRoutes({ ai_settings: () => aiView({ settings: { ...GROQ, autoCompact: false } }) });
  const second = renderAi();
  expect((await screen.findByRole("switch", { name: label })).getAttribute("aria-checked")).toBe("false");
  second.unmount();
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ }) });
  const third = renderAi();
  expect((await screen.findByRole("switch", { name: label })).getAttribute("aria-checked")).toBe("true");
  third.unmount();

  // A Group's own settings do not show it: the switch is the same for every Group.
  settingsRoutes({ ai_settings: () => aiView({ settings: { ...GROQ, autoCompact: true }, groupOverride: true }) });
  renderWithProviders(<AiSection groupId="g1" groupName="KFC" connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText("Privacy and thinking settings are the same for every Group. Change them without a Group open.")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: label })).toBeNull();
});

test("name_chats_switch_is_global_and_on_by_default", async () => {
  const label = "Name chats with the AI";
  const help = "After the first answer, one short call writes the chat's title. Off keeps the first question as the title.";
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ }) });
  const { unmount } = renderAi();
  const name = await screen.findByRole("switch", { name: label });
  // In Behaviour, Answers, after auto-compact; not stored yet: the Core's default, on.
  const answers = screen.getByRole("region", { name: "Answers" });
  const switches = within(answers).getAllByRole("switch");
  expect(switches[switches.length - 1]).toBe(name);
  expect(name.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(help)).toBeTruthy();
  await userEvent.click(name);
  await waitFor(() => expect((lastAi().settings as AiSettings).nameChats).toBe(false));
  expect(lastAi().settings).toMatchObject({ keepExactText: false, pickTables: true, modelPrefs: GROQ.modelPrefs });
  unmount();

  settingsRoutes({ ai_settings: () => aiView({ settings: { ...GROQ, nameChats: false } }) });
  const second = renderAi();
  expect((await screen.findByRole("switch", { name: label })).getAttribute("aria-checked")).toBe("false");
  second.unmount();

  // A Group's own settings do not show it: the switch is the same for every Group.
  settingsRoutes({ ai_settings: () => aiView({ settings: { ...GROQ, nameChats: true }, groupOverride: true }) });
  renderWithProviders(<AiSection groupId="g1" groupName="KFC" connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText("Privacy and thinking settings are the same for every Group. Change them without a Group open.")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: label })).toBeNull();
});

test("name_chats_is_found_by_settings_search", () => {
  expect(AI_PAGE_ROWS.behaviour.some((r) => r.label === "Name chats with the AI")).toBe(true);
});

test("tools_page_rows_and_the_sample_rows_note", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ }) });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} pages={["tools"]} />);
  expect(
    await screen.findByText(
      "A tool is an action a model may ask Contura to take. Contura checks and runs it, never the model, and every use shows here and in Show log.",
    ),
  ).toBeTruthy();
  const card = document.querySelector('[data-row="tools"]') as HTMLElement;
  expect([...card.querySelectorAll(".srow-label")].map((l) => l.textContent)).toEqual([
    "Propose diagram changes",
    "Let the assistant pick tables in large databases",
    "Run SQL or read rows",
  ]);
  const run = card.querySelector('[data-row="runSql"]') as HTMLElement;
  expect(run.textContent).toMatch(/No model can run anything on a database\. Answers are text: only Run in the editor touches a database\./);
  expect(within(run).getByText("Sample rows").tagName).toBe("STRONG");
  expect(run.textContent).toContain(
    "Sample rows are read by Contura, not the model: at most 5 rows of each named table, read only, only when the Sample rows switch is on for that Ask, and never kept.",
  );
  expect(within(run).getByText("Never")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Recent tool uses" })).toBeTruthy();
  // Only the Tools page: nothing from the other three.
  expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Answers" })).toBeNull();
});

test("refetch_on_key_change", async () => {
  let last4 = "3f9a";
  settingsRoutes({
    ai_settings: () => aiView({ settings: GROQ, keySaved: true, keyLast4: last4 }),
    ai_models: () => modelList([modelInfo()], Date.now()),
    save_ai_settings: (a) => {
      if ((a.key as { t: string }).t === "set") last4 = "9z9z";
    },
  });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  await screen.findByText(/Fetched just now/);
  expect(callsTo("ai_models")).toHaveLength(1);
  await userEvent.type(screen.getByLabelText("API key"), "gsk_new_key_9z9z");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(callsTo("ai_models")).toHaveLength(2));
});

test("openrouter_key_is_separate", async () => {
  const OPENAI: AiSettings = { ...GROQ, provider: "openai", preset: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" };
  let saved = OPENAI;
  settingsRoutes({
    // The OpenRouter preset has its own key account, with no key in it yet.
    ai_settings: () =>
      saved.preset === "OpenRouter" ? aiView({ settings: saved }) : aiView({ settings: saved, keySaved: true, keyLast4: "aaaa" }),
    save_ai_settings: (a) => {
      saved = a.settings as AiSettings;
    },
  });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText("••••••••aaaa")).toBeTruthy();
  await choose("Preset", "OpenRouter");
  await waitFor(() => expect(screen.queryByText("••••••••aaaa")).toBeNull());
  expect(screen.queryByRole("button", { name: "Remove the saved API key" })).toBeNull();
  await choose("Preset", "OpenAI");
  expect(await screen.findByText("••••••••aaaa")).toBeTruthy();
});

test("models_fetch_failure_keeps_builtin", async () => {
  settingsRoutes({
    ai_settings: () => aiView({ settings: GROQ, keySaved: true, keyLast4: "3f9a" }),
    ai_models: () => {
      throw { kind: "ai", message: { kind: "network", host: "api.groq.com" } };
    },
  });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText("Could not fetch the model list. Showing the built-in one.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByText(/Fetched/)).toBeNull();
  expect(await optionsOf("Model")).toEqual([
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "qwen/qwen3.8-27b",
    "Type a name...",
  ]);
  // Free text still works.
  await choose("Model", "Type a name...");
  const typed = screen.getByRole("textbox", { name: "Model" });
  await userEvent.type(typed, "my-model{Enter}");
  await waitFor(() => expect((lastAi().settings as AiSettings).model).toBe("my-model"));
});

test("models_fetch_refused_for_a_new_host_says_why", async () => {
  // The Core refuses before sending: the saved key belongs to another host.
  settingsRoutes({
    ai_settings: () => aiView({ settings: { ...GROQ, baseUrl: "https://openrouter.ai/api/v1" }, keySaved: true, keyLast4: "3f9a" }),
    ai_models: () => {
      throw { kind: "ai", message: { kind: "keyHostChanged", host: "openrouter.ai" } };
    },
  });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText("The base URL now points to openrouter.ai. Save the key again to send it there.")).toBeTruthy();
  expect(screen.queryByText("Could not fetch the model list. Showing the built-in one.")).toBeNull();
  expect(callsTo("ai_models")).toHaveLength(1);
});

test("models_not_fetched_without_a_saved_key", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ }), ai_models: () => modelList([modelInfo({ id: "x" })], Date.now()) });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  await screen.findByRole("combobox", { name: "Model" });
  expect(callsTo("ai_models")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Fetch again" })).toBeNull();
});

test("test_success_text", async () => {
  settingsRoutes({
    ai_settings: () => aiView({ settings: GROQ, keySaved: true, keyLast4: "3f9a" }),
    ai_models: () => modelList([modelInfo()], Date.now()),
    ai_test: () => ({ model: "openai/gpt-oss-20b", millis: 412 }),
  });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Test" }));
  expect(
    (await screen.findByText("Connected to Groq. openai/gpt-oss-20b replied in 412ms. Only the test prompt was sent.")).textContent,
  ).toBeTruthy();
});

test("access_table_rows_use_brand_marks", async () => {
  const a = conn("c1", "KFC shop");
  const b = conn("c2", "KFC stores", { dialect: "mysql", aiAccess: "never" });
  settingsRoutes({
    set_connection_ai_access: (args) => ({ ...(args.id === "c1" ? a : b), aiAccess: args.access }),
  });
  const onConnectionSaved = vi.fn();
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[a, b]} onConnectionSaved={onConnectionSaved} />);
  await openAccess();
  const table = await screen.findByRole("table", { name: "What AI can see, per Connection" });
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows[0].querySelector(".db-mark-postgres")).not.toBeNull();
  expect(rows[1].querySelector(".db-mark-mysql")).not.toBeNull();
  // Brand marks, not the generic database icon.
  expect(table.querySelector(".cname .icon")).toBeNull();
  expect(within(table).getByText("PostgreSQL")).toBeTruthy();
  expect(table.querySelector("select")).toBeNull();
  // The table never sits in a clipping box, so its lists can open below it.
  for (let el: HTMLElement | null = table; el; el = el.parentElement) expect(el.classList.contains("share-scroll")).toBe(false);

  expect(screen.getByRole("combobox", { name: "What AI can see in KFC shop" }).textContent).toContain("Schema only");
  await choose("What AI can see in KFC shop", "Schema, query text and sample rows");
  await waitFor(() => expect(callsTo("set_connection_ai_access")).toEqual([{ id: "c1", access: "schemaQueryRows" }]));
  expect(onConnectionSaved).toHaveBeenCalled();
  expect(callsTo("save_connection")).toHaveLength(0);
});

// ---- Data folder ----

test("data_folder_shows_path_counts_and_history_size", async () => {
  settingsRoutes();
  renderWithProviders(<DataFolderSection />);
  expect(await screen.findByText("E:\\Apps\\Contura\\data")).toBeTruthy();
  expect(
    screen.getByText(
      // On Linux the folder is next to the program only for an AppImage or a writable copy: the copy points at the path.
      "Connections, Groups, Saved Queries, Query History and these settings live in this folder. Copy the folder to take everything to another computer.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("9 Connections, 3 Groups, 24 Saved Queries, 4.2 MB of Query History")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Move/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
  expect(callsTo("open_data_folder")).toHaveLength(1);
  expect(screen.getByText("Passwords stay in the OS keyring (the Secret Service) on this computer, so a copied folder asks for each one once.")).toBeTruthy();
});

test("data_folder_passwords_note_says_session_without_a_keyring", async () => {
  settingsRoutes({ secret_store_kind: () => "missing" });
  renderWithProviders(<DataFolderSection />);
  expect(
    await screen.findByText(
      "No keyring service was found, so passwords are kept only until Contura closes. Install GNOME Keyring or KeePassXC to save them.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/^Passwords stay in/)).toBeNull();
});

test("keep_history_for_saves_and_clear_asks_once", async () => {
  let bytes = 4_404_019;
  settingsRoutes({
    data_folder_info: () => ({ path: "E:\\Apps\\Contura\\data", connections: 9, groups: 3, savedQueries: 24, historyBytes: bytes }),
    clear_query_history: () => {
      bytes = 0;
    },
  });
  renderWithProviders(<DataFolderSection />);
  await screen.findByText(/4\.2 MB of Query History/);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  expect(screen.getByRole("combobox", { name: "Keep history for" }).textContent).toContain("Forever");
  expect(await optionsOf("Keep history for")).toEqual(["30 days", "90 days", "365 days", "Forever"]);
  await choose("Keep history for", "90 days");
  await userEvent.click(within(screen.getByRole("dialog", { name: "Delete Query History older than 90 days?" })).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(lastPrefs()?.historyKeepDays).toBe(90));
  await choose("Keep history for", "Forever");
  await waitFor(() => expect(lastPrefs()?.historyKeepDays).toBe(null));

  await userEvent.click(screen.getByRole("button", { name: "Clear Query History..." }));
  const ask = screen.getByRole("dialog", { name: "Clear Query History" });
  expect(ask.textContent).toContain("Clear the Query History of every Connection? Saved Queries are kept.");
  await userEvent.click(within(ask).getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("clear_query_history")).toEqual([{ id: null }]));
  // One confirm only, and the size updates.
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByText(/0 bytes of Query History/)).toBeTruthy();
});

test("shortening_keep_history_asks_first_and_lengthening_applies_at_once", async () => {
  settingsRoutes();
  renderWithProviders(<DataFolderSection />);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  await screen.findByText(/4\.2 MB of Query History/);
  // Forever to 30 days deletes history: it asks, with Cancel focused, and Cancel changes nothing.
  await choose("Keep history for", "30 days");
  const ask = screen.getByRole("dialog", { name: "Delete Query History older than 30 days?" });
  expect(ask.textContent).toContain("Query History older than 30 days is deleted now, and from then on. This can't be undone.");
  expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Cancel" }));
  expect(within(ask).getByRole("button", { name: "Delete" }).className).toContain("button-danger-fill");
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("save_ui_prefs")).toHaveLength(0);
  expect(screen.getByRole("combobox", { name: "Keep history for" }).textContent).toContain("Forever");
  // Delete saves the shorter period.
  await choose("Keep history for", "30 days");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(lastPrefs()?.historyKeepDays).toBe(30));
  // 30 to 365 days deletes nothing: no ask.
  await choose("Keep history for", "365 days");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(lastPrefs()?.historyKeepDays).toBe(365));
});

// ---- About ----

test("about_has_version_licences_and_note", async () => {
  settingsRoutes();
  renderWithProviders(<AboutSection />);
  expect(await screen.findByText("Contura 1.0.0")).toBeTruthy();
  // The licences fold open under their row.
  expect(screen.queryByRole("list", { name: "Licences" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(screen.getByRole("button", { name: "Hide" }).getAttribute("aria-expanded")).toBe("true");
  const licences = screen.getByRole("list", { name: "Licences" });
  expect(within(licences).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "JetBrains Mono, SIL Open Font License 1.1",
    "Lucide icons, ISC",
    "Simple Icons, CC0 1.0",
  ]);
  expect(screen.getByText("Everything Contura keeps is in one data folder. The Data folder page shows where it is.")).toBeTruthy();
  expect(screen.queryByText(/next to the Contura program/)).toBeNull();
});


test("a_group_override_does_not_offer_the_privacy_switches", async () => {
  // F2: Keep the exact text and Share thinking are global, so a Group's own settings leave them out.
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ, groupOverride: true }) });
  renderWithProviders(<AiSection groupId="g1" groupName="KFC" connections={[]} onConnectionSaved={() => {}} />);
  await screen.findByRole("switch", { name: "Use different settings for KFC" });
  expect(screen.queryByRole("switch", { name: "Keep the exact text sent with each answer" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "Ask models to share their thinking when they support it" })).toBeNull();
  expect(screen.getByText("Privacy and thinking settings are the same for every Group. Change them without a Group open.")).toBeTruthy();
});

// ---- AI Context (step 11c) ----

const ctxRow = (connectionId: string, agoMs: number, stale: boolean) => ({
  connectionId,
  database: "shop",
  schema: "",
  builtAt: Date.now() - agoMs,
  checkedAt: Date.now() - agoMs,
  stale,
  tableCount: 6,
  bytes: 4096,
});

test("access_table_sync_and_context_columns", async () => {
  const a = conn("c1", "freight-stg", { aiAccess: "schemaQuery", aiSync: "automatic" });
  const b = conn("c2", "notes", { dialect: "sqlite", aiAccess: "schemaQueryRows", aiSync: "manual" });
  const c = conn("c3", "freight-prod", { aiAccess: "never", production: true });
  settingsRoutes({ ai_context_status: () => [ctxRow("c1", 180_000, false), ctxRow("c2", 2 * 86_400_000 + 60_000, true)] });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[a, b, c]} onConnectionSaved={() => {}} />);
  await openAccess();
  const table = await screen.findByRole("table", { name: "What AI can see, per Connection" });
  expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
    "Connection",
    "Dialect",
    "AI can see",
    "Sync",
    "Context",
  ]);
  expect(await within(table).findByText("Synced 3m ago")).toBeTruthy();
  const stale = within(table).getByText("Stale, synced 2d ago");
  expect(stale.classList.contains("warn-text")).toBe(true);
  expect(screen.getByRole("combobox", { name: "Keep the AI context of freight-stg in sync" }).textContent).toContain("Automatically");
  expect(screen.getByRole("combobox", { name: "Keep the AI context of notes in sync" }).textContent).toContain("Manual");
  expect(screen.queryByRole("combobox", { name: "Keep the AI context of freight-prod in sync" })).toBeNull();
  const prodRow = within(table).getAllByRole("row")[3];
  expect(within(prodRow).getByText("Off").classList.contains("muted")).toBe(true);
  expect(within(prodRow).getByText("Not built").classList.contains("muted")).toBe(true);
  expect(callsTo("ai_context_status")).toEqual([{ connectionId: null }]);
});

test("sync_select_saves", async () => {
  const a = conn("c1", "freight-stg", { aiSync: "automatic" });
  settingsRoutes({ set_ai_sync_mode: (args) => ({ ...a, aiSync: args.mode }) });
  const onConnectionSaved = vi.fn();
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[a]} onConnectionSaved={onConnectionSaved} />);
  await openAccess();
  await screen.findByRole("table", { name: "What AI can see, per Connection" });
  await choose("Keep the AI context of freight-stg in sync", "Manual");
  await waitFor(() => expect(callsTo("set_ai_sync_mode")).toEqual([{ connectionId: "c1", mode: "manual" }]));
  await waitFor(() => expect(onConnectionSaved).toHaveBeenCalledWith({ ...a, aiSync: "manual" }));
  expect(callsTo("save_connection")).toHaveLength(0);
});

test("sync_select_follows_a_change_made_elsewhere_after_a_save", async () => {
  const a = conn("c1", "freight-stg", { aiSync: "automatic" });
  settingsRoutes({ set_ai_sync_mode: (args) => ({ ...a, aiSync: args.mode }) });
  const { rerender } = renderWithProviders(<AiSection groupId={null} groupName={null} connections={[a]} onConnectionSaved={() => {}} />);
  await openAccess();
  await screen.findByRole("table", { name: "What AI can see, per Connection" });
  await choose("Keep the AI context of freight-stg in sync", "Manual");
  await waitFor(() => expect(callsTo("set_ai_sync_mode")).toHaveLength(1));
  rerender(<AiSection groupId={null} groupName={null} connections={[{ ...a, aiSync: "manual" }]} onConnectionSaved={() => {}} />);
  // The Connection form sets it back to Automatically; the table shows the stored value.
  rerender(<AiSection groupId={null} groupName={null} connections={[{ ...a, aiSync: "automatic" }]} onConnectionSaved={() => {}} />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Keep the AI context of freight-stg in sync" }).textContent).toContain("Automatically"));
});

test("clear_ai_history_names_the_place_and_confirms", async () => {
  // A Group's own settings are open: the clear buttons stay, since they are not settings.
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ, groupOverride: true }), clear_ai_threads: () => undefined });
  renderWithProviders(<AiSection groupId="g1" groupName="KFC" connections={[]} onConnectionSaved={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Clear AI history..." }));
  expect(screen.getByText("Clear the AI history of KFC? Every thread in this place is removed.")).toBeTruthy();
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Cancel/ }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("clear_ai_threads")).toHaveLength(0);

  const cleared: (string | null)[] = [];
  const off = onThreadsCleared((place) => cleared.push(place));
  await userEvent.click(screen.getByRole("button", { name: "Clear AI history..." }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("clear_ai_threads")).toEqual([{ place: "group:g1" }]));
  expect(screen.queryByRole("dialog")).toBeNull();
  // An open Assistant panel of that place drops its threads.
  await waitFor(() => expect(cleared).toEqual(["group:g1"]));
  off();
});

test("clear_ai_history_without_a_group_names_ungrouped", async () => {
  settingsRoutes({ clear_ai_threads: () => undefined });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "Clear AI history..." }));
  expect(screen.getByText("Clear the AI history of Ungrouped? Every thread in this place is removed.")).toBeTruthy();
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("clear_ai_threads")).toEqual([{ place: "ungrouped" }]));
});

test("clear_all_ai_data_confirms", async () => {
  settingsRoutes({ ai_clear_all: () => undefined });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  const button = await screen.findByRole("button", { name: "Clear all AI data..." });
  expect(button.classList.contains("button-danger-text")).toBe(true);
  await userEvent.click(button);
  expect(screen.getByText("Clear all AI data? Every thread and every AI Context is removed. Connections and settings stay.")).toBeTruthy();
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Cancel/ }));
  expect(callsTo("ai_clear_all")).toHaveLength(0);
  const cleared: (string | null)[] = [];
  const off = onThreadsCleared((place) => cleared.push(place));
  await userEvent.click(screen.getByRole("button", { name: "Clear all AI data..." }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(callsTo("ai_clear_all")).toHaveLength(1));
  await waitFor(() => expect(cleared).toEqual([null]));
  off();
});

test("plus_sample_rows_help", async () => {
  settingsRoutes();
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[conn("c1", "freight-stg")]} onConnectionSaved={() => {}} />);
  await openAccess();
  await screen.findByRole("table", { name: "What AI can see, per Connection" });
  expect(
    screen.getByText(
      "Plus sample rows: Contura reads at most 5 rows of each named table, read only, only when the Sample rows switch is on for that Ask, and never keeps them.",
    ),
  ).toBeTruthy();
});

test("production_help_line", async () => {
  settingsRoutes();
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[conn("c1", "freight-stg")]} onConnectionSaved={() => {}} />);
  await openAccess();
  await screen.findByRole("table", { name: "What AI can see, per Connection" });
  expect(screen.getByText("Production Connections stay at Never: turning Production on also clears their AI Context.")).toBeTruthy();
});

// ---- Tools: Propose diagram changes and Recent tool uses (step 11h, board 11.4) ----

const EMPTY_RECORD = {
  sent: null,
  usage: null,
  millis: 1900,
  stop: "end",
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

const useRow = (over: Partial<ToolUseRow>): ToolUseRow => ({
  threadId: "t1",
  messageAt: 1,
  at: Date.now(),
  tool: "proposeDiagramChanges",
  target: "fulfilment.flow",
  connectionId: null,
  result: "4 proposed, 3 accepted",
  ...over,
});

test("diagram_tool_row_and_switch", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: { ...GROQ, diagramTool: true } }) });
  renderAi();
  const sw = await screen.findByRole("switch", { name: "Propose diagram changes" });
  const row = sw.closest(".srow") as HTMLElement;
  expect(
    within(row).getByText("On diagram tabs. Suggests edits to the open .flow file as a list you can review. It cannot read or write a database."),
  ).toBeTruthy();
  expect(sw.getAttribute("aria-checked")).toBe("true");
  // It is the first row of the Tools card, under the line about tools.
  expect(row.parentElement?.querySelector(".srow")).toBe(row);
  await userEvent.click(sw);
  await waitFor(() => expect((lastAi().settings as AiSettings).diagramTool).toBe(false));
  expect(lastAi().settings).toMatchObject({ pickTables: true, modelPrefs: GROQ.modelPrefs });
  expect(sw.getAttribute("aria-checked")).toBe("false");
});

test("diagram_tool_is_global_only", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ, groupOverride: true }) });
  renderWithProviders(<AiSection groupId="g1" groupName="KFC" connections={[]} onConnectionSaved={() => {}} />);
  expect(await screen.findByText("Same for every Group")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Propose diagram changes" })).toBeNull();
  // A Group-level change saves without the global switch.
  await userEvent.click(screen.getByRole("switch", { name: "Inline Ask" }));
  await waitFor(() => expect(callsTo("save_ai_settings").length).toBeGreaterThan(0));
  for (const call of callsTo("save_ai_settings")) expect(call.settings).not.toHaveProperty("diagramTool");
});

test("failed_tool_use_list_says_so", async () => {
  settingsRoutes({
    ai_recent_tool_uses: () => {
      throw "The store is locked.";
    },
  });
  renderAi();
  expect(await screen.findByText(/Could not load tool uses\./)).toBeTruthy();
  expect(screen.queryByText("No tool uses yet.")).toBeNull();
});

test("tool_use_time_older_days_and_deleted_connection", async () => {
  const old = new Date();
  old.setDate(old.getDate() - 5);
  old.setHours(9, 5);
  settingsRoutes({
    ai_recent_tool_uses: () => [useRow({ at: old.getTime(), tool: "pickTables", target: "", connectionId: "gone", result: "1 of 2 tables" })],
  });
  renderAi();
  await waitFor(() => expect(document.querySelectorAll(".urow")).toHaveLength(1));
  const cells = Array.from(document.querySelector(".urow")!.children).map((c) => c.textContent);
  expect(cells[0]).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  expect(cells[2]).toBe("Ask on a Connection");
});

test("failed_open_shows_the_error", async () => {
  settingsRoutes({
    ai_recent_tool_uses: () => [useRow({})],
    ai_answer_record: () => {
      throw "The record could not be read.";
    },
  });
  renderAi();
  await userEvent.click(await screen.findByRole("button", { name: /^Open Propose diagram changes/ }));
  const dialog = await screen.findByRole("dialog");
  expect((await within(dialog).findByRole("alert")).textContent).toContain("The record could not be read.");
});

test("recent_tool_uses_rows", async () => {
  const noon = new Date();
  noon.setHours(10, 42, 0, 0);
  const earlier = new Date(noon);
  earlier.setHours(10, 31);
  const yesterday = new Date(noon);
  yesterday.setDate(yesterday.getDate() - 1);
  settingsRoutes({
    ai_recent_tool_uses: () => [
      useRow({ at: noon.getTime() }),
      useRow({ messageAt: 2, at: earlier.getTime(), tool: "pickTables", target: "", connectionId: "c1", result: "2 of 6 tables" }),
      useRow({ messageAt: 3, at: yesterday.getTime(), target: "refund.flow", result: "Checker dropped 1 of 3" }),
    ],
  });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[conn("c1", "freight-stg")]} onConnectionSaved={() => {}} />);
  expect(await screen.findByRole("heading", { name: "Recent tool uses" })).toBeTruthy();
  const rows = await waitFor(() => {
    const list = document.querySelectorAll(".urow");
    expect(list).toHaveLength(3);
    return Array.from(list).map((r) => Array.from(r.children).map((c) => c.textContent));
  });
  expect(rows).toEqual([
    ["10:42", "Propose diagram changes", "fulfilment.flow", "4 proposed, 3 accepted", "Open"],
    ["10:31", "Pick tables", "Ask on freight-stg", "2 of 6 tables", "Open"],
    ["Yesterday", "Propose diagram changes", "refund.flow", "Checker dropped 1 of 3", "Open"],
  ]);
  expect(document.querySelector(".urow .mono-small")?.textContent).toBe("fulfilment.flow");
  expect(screen.getByText("Open shows the exact input the model sent and what Contura did with it.")).toBeTruthy();
});

test("open_shows_the_log_with_the_input", async () => {
  const input = '{"changes":[{"op":"add_shape","name":"Refund"}]}';
  const record = {
    ...EMPTY_RECORD,
    steps: [
      { step: "answer", value: "Written", rule: "", evidence: [], byModel: true, atMs: 10 },
      { step: "toolCheck", value: "1 of 1 passed", rule: "Contura checked each change.", evidence: [], byModel: false, atMs: 20 },
    ],
    toolUse: { tool: "propose_diagram_changes", file: "fulfilment.flow", input, proposal: { changes: [] }, outcome: null },
  };
  settingsRoutes({
    ai_recent_tool_uses: () => [useRow({})],
    ai_answer_record: () => record,
  });
  renderAi();
  await userEvent.click(await screen.findByRole("button", { name: /^Open Propose diagram changes/ }));
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByRole("tab", { name: "Steps" })).toBeTruthy();
  expect(within(dialog).getByRole("tab", { name: "Steps" }).getAttribute("aria-selected")).toBe("true");
  expect(await within(dialog).findByLabelText("Input the model sent")).toBeTruthy();
  // Laid out as the board's stored tool input.
  expect(within(dialog).getByLabelText("Input the model sent").textContent).toBe(JSON.stringify(JSON.parse(input), null, 2));
  expect(callsTo("ai_answer_record")[0]).toEqual({ threadId: "t1", messageAt: 1 });
  expect(within(dialog).queryByRole("button", { name: "Back to the answer" })).toBeNull();
  // The Diagram tab draws the one tool; the question is not known here, so its box gives no count.
  await userEvent.click(within(dialog).getByRole("tab", { name: "Diagram" }));
  const question = [...dialog.querySelectorAll(".dbox")].find((b) => b.querySelector(".dlab")?.textContent === "Your question")!;
  expect(question.textContent).toBe("Your question");
  expect(within(dialog).queryByText(/0 chars/)).toBeNull();
  expect(within(dialog).getByText("One tool: it can only suggest edits to fulfilment.")).toBeTruthy();
});

test("empty_recent_text", async () => {
  settingsRoutes({ ai_recent_tool_uses: () => [] });
  renderAi();
  expect(await screen.findByText("No tool uses yet.")).toBeTruthy();
  expect(document.querySelector(".urow")).toBeNull();
});

// ---- Parity with the step 11 boards (P11) ----

test("parity_P11_38_windows_keeps_its_wording", async () => {
  setPlatformForTests("windows");
  settingsRoutes();
  const about = renderWithProviders(<AboutSection />);
  expect(await screen.findByText("Everything Contura keeps is in the data folder next to Contura.exe.")).toBeTruthy();
  about.unmount();
  const folder = renderWithProviders(<DataFolderSection />);
  expect(await screen.findByText("E:\\Apps\\Contura\\data")).toBeTruthy();
  expect(
    screen.getByText(
      "Contura is portable. Connections, Groups, Saved Queries, Query History and these settings live in one folder next to Contura.exe. Copy the folder to take everything to another PC.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Passwords stay in the OS keyring (Windows Credential Manager) on this PC, so a copied folder asks for each one once.")).toBeTruthy();
  folder.unmount();
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ }) });
  renderAi();
  expect(await screen.findByText("Kept in the OS keyring (Windows Credential Manager), never in the data folder.")).toBeTruthy();
  expect(screen.getByText(String.raw`The text can contain your schema and SQL. data\ is portable and not encrypted.`)).toBeTruthy();
  // One word for the machine on the whole page: "this PC", as the Passwords row says.
  await openAccess();
  expect(screen.getByText("Each Connection decides what may leave this PC. The same choice is on each Connection's form.")).toBeTruthy();
});

test("parity_P11_38_the_system_theme_is_named_by_platform", async () => {
  // The board's "Follow Windows" on Windows; elsewhere it never names Windows.
  setPlatformForTests("windows");
  settingsRoutes();
  const win = renderWithProviders(<AppearanceSection />);
  const group = screen.getByRole("radiogroup", { name: "Theme" });
  expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["Dark", "Light", "Follow Windows"]);
  expect(screen.getByText("Follow Windows uses Light when Windows is light and Dark when it is dark.")).toBeTruthy();
  win.unmount();
  setPlatformForTests("linux");
  renderWithProviders(<AppearanceSection />);
  expect(screen.getByRole("radio", { name: "Follow the system" })).toBeTruthy();
  expect(screen.queryByText(/Windows/)).toBeNull();
});

test("the_system_cards_now_line_follows_the_system_while_another_theme_is_chosen", async () => {
  let dark = false;
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  const realMatch = window.matchMedia;
  window.matchMedia = ((q: string) => ({
    matches: dark,
    media: q,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.splice(listeners.indexOf(fn), 1),
  })) as unknown as typeof window.matchMedia;
  try {
    settingsRoutes({}, { prefs: { theme: "dark" } });
    const view = renderWithProviders(<AppearanceSection />);
    expect(await screen.findByText("Now light")).toBeTruthy();
    dark = true;
    act(() => listeners.forEach((fn) => fn({ matches: true })));
    expect(await screen.findByText("Now dark")).toBeTruthy();
    view.unmount();
    expect(listeners).toHaveLength(0);
  } finally {
    window.matchMedia = realMatch;
  }
});

test("a_licence_search_hit_unfolds_the_list", async () => {
  settingsRoutes();
  renderWithProviders(
    <FlashContext.Provider value="licences">
      <AboutSection />
    </FlashContext.Provider>,
  );
  expect(await screen.findByRole("list", { name: "Licences" })).toBeTruthy();
  const hide = screen.getByRole("button", { name: "Hide" });
  // The button says what it shows and hides through the row label.
  expect(document.getElementById(hide.getAttribute("aria-describedby")!)?.textContent).toBe("Open source licences");
});

test("the_thinking_level_is_described_by_its_hint", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ }) });
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} pages={["behaviour"]} />);
  const group = await screen.findByRole("radiogroup", { name: "Default thinking level" });
  expect(document.getElementById(group.getAttribute("aria-describedby")!)?.textContent).toBe("Each model remembers the level you last picked for it.");
});

test("parity_P11_38_linux_wording_never_names_windows", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ }) });
  const { container } = renderWithProviders(
    <>
      <AppearanceSection />
      <AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />
      <DataFolderSection />
      <AboutSection />
    </>,
  );
  await screen.findByText("Kept in the OS keyring (the Secret Service), never in the data folder.");
  await screen.findByText("Contura 1.0.0");
  expect(container.textContent).not.toMatch(/Windows|Contura\.exe|this PC|data\\/);
});

test("parity_P11_4_inline_suggestions_help_has_no_development_note", async () => {
  settingsRoutes();
  renderAi();
  expect(await screen.findByText("Suggests the rest of a statement where you are typing. Uses the Connection's AI access.")).toBeTruthy();
  expect(screen.queryByText(/Arrives with step/)).toBeNull();
});

test("parity_P11_3_access_table_keeps_its_columns_and_fits_its_column", async () => {
  const a = conn("c1", "freight-stg", { aiAccess: "schemaQuery", aiSync: "automatic" });
  settingsRoutes();
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[a]} onConnectionSaved={() => {}} />);
  await openAccess();
  const table = await screen.findByRole("table", { name: "What AI can see, per Connection" });
  // The built columns stay (P11-2: keep as built), Dialect included.
  expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Connection", "Dialect", "AI can see", "Sync", "Context"]);
  // Fixed layout with set column widths: the table never grows past the 512px column.
  expect(table.classList.contains("share-table-fit")).toBe(true);
  expect(Array.from(table.querySelectorAll("col")).map((c) => c.className)).toEqual([
    "share-col-conn",
    "share-col-dialect",
    "share-col-access",
    "share-col-sync",
    "share-col-ctx",
  ]);
  // No hover text: the dialect has its own column.
  expect(table.querySelector("[title]")).toBeNull();
});

test("parity_P11_5_recent_tool_uses_refresh_when_a_use_is_recorded", async () => {
  let rows: ToolUseRow[] = [];
  settingsRoutes({ ai_recent_tool_uses: () => rows, save_ai_thread: (a) => ({ thread: a.thread }), ai_record_tool_result: () => null });
  renderAi();
  expect(await screen.findByText("No tool uses yet.")).toBeTruthy();
  // A diagram Ask saves its turn with the tool use while Settings stays open.
  rows = [useRow({})];
  await saveAiThread({ id: "t1", place: "flow:fulfilment", title: "add a check", messages: [], updatedAt: 1 });
  await waitFor(() => expect(document.querySelectorAll(".urow")).toHaveLength(1));
  expect(screen.queryByText("No tool uses yet.")).toBeNull();
  // Accepting it records the outcome: the list is read again.
  rows = [useRow({ result: "Accepted 1 of 1" })];
  await aiRecordToolResult("t1", 1, { accepted: 1, rejected: 0, auto: false, at: 2 });
  expect(await screen.findByText("Accepted 1 of 1")).toBeTruthy();
});

test("parity_P11_9_data_folder_counts_follow_the_connections", async () => {
  let connections = 1;
  settingsRoutes({ data_folder_info: () => ({ path: "/home/you/contura/data", connections, groups: 0, savedQueries: 0, historyBytes: 0 }) });
  const one = [conn("c1", "ai-prod")];
  const { rerender } = renderWithProviders(<DataFolderSection connections={one} />);
  expect(await screen.findByText(/^1 Connection, 0 Groups/)).toBeTruthy();
  connections = 4;
  rerender(<DataFolderSection connections={[...one, conn("c2", "ai-readonly"), conn("c3", "ai-shop"), conn("c4", "ai-wide")]} />);
  expect(await screen.findByText(/^4 Connections, 0 Groups/)).toBeTruthy();
  expect(callsTo("data_folder_info")).toHaveLength(2);
});

test("parity_P11_17_custom_lists_its_models_without_a_key", async () => {
  const custom: AiSettings = { ...GROQ, provider: "custom", preset: null, baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1:8b" };
  settingsRoutes({
    ai_settings: () => aiView({ settings: custom, keySaved: false }),
    ai_models: () => modelList([modelInfo({ id: "llama3.1:8b", name: "llama3.1:8b" }), modelInfo({ id: "qwen3:14b", name: "qwen3:14b" })], Date.now()),
  });
  renderWithProviders(<AiSection groupId="g1" groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  // A keyless local server still lists its models, so the Ask picker can offer them.
  await waitFor(() => expect(callsTo("ai_models")).toEqual([{ groupId: "g1" }]));
  expect(await screen.findByText("2 models from 127.0.0.1:11434. Fetched just now.")).toBeTruthy();
});

test("security_L3_plain_http_off_this_computer_says_why", async () => {
  // Revised L3: keyless is allowed over http to another machine, and the hint says it is plain text.
  const lan: AiSettings = { ...GROQ, provider: "custom", preset: null, baseUrl: "http://192.168.1.20:11434/v1", model: "llama3.1:8b" };
  settingsRoutes({ ai_settings: () => aiView({ settings: lan, keySaved: false }) });
  const shown = renderWithProviders(<AiSection groupId="g1" groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  const field = (await screen.findByLabelText("Base URL")) as HTMLInputElement;
  const plain = "This address is not encrypted. What you send travels as plain text.";
  const refused = "This address is not encrypted. Use https or a local address on this computer, or remove the saved key.";
  await waitFor(() => expect(field.value).toBe("http://192.168.1.20:11434/v1"));
  const hint = () => document.getElementById(field.getAttribute("aria-describedby")!)?.textContent;
  expect(hint()).toBe(plain);
  // On this computer, http is fine and the usual hint is back.
  await userEvent.clear(field);
  await userEvent.type(field, "http://127.0.0.1:11434/v1");
  expect(screen.queryByText(plain)).toBeNull();
  expect(screen.getByText("Ollama uses port 11434, LM Studio uses 1234.")).toBeTruthy();
  shown.unmount();

  // With a key saved, the key would go in plain text, so the address is refused and the hint says why.
  settingsRoutes({ ai_settings: () => aiView({ settings: lan, keySaved: true, keyLast4: "abcd" }) });
  renderWithProviders(<AiSection groupId="g1" groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  const keyed = (await screen.findByLabelText("Base URL")) as HTMLInputElement;
  await waitFor(() => expect(keyed.value).toBe("http://192.168.1.20:11434/v1"));
  expect(document.getElementById(keyed.getAttribute("aria-describedby")!)?.textContent).toBe(refused);
});

test("parity_P11_17_a_keyless_hosted_provider_still_waits_for_a_key", async () => {
  settingsRoutes({ ai_settings: () => aiView({ settings: GROQ, keySaved: false }) });
  renderWithProviders(<AiSection groupId="g1" groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  await screen.findByRole("radiogroup", { name: "Default thinking level" });
  expect(callsTo("ai_models")).toHaveLength(0);
});
