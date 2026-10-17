import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { AiSettings, ConnectionConfig, UiPrefs } from "../../api/types";
import { COMMANDS } from "../../commands/registry";
import { callsTo } from "../../test/invoke";
import { aiView, GROQ, renderWithProviders, settingsRoutes } from "../../test/settingsRoutes";
import AboutSection from "./AboutSection";
import AiSection from "./AiSection";
import AppearanceSection from "./AppearanceSection";
import DataFolderSection from "./DataFolderSection";
import EditorSection from "./EditorSection";
import KeymapSection from "./KeymapSection";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The app plugin calls Tauri from inside the package, past the core mock.
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.7.0") }));
const installed = vi.hoisted(() => new Set<string>());
vi.mock("../fontDetect", () => ({ isInstalled: (family: string) => installed.has(family) }));

beforeEach(() => {
  installed.clear();
  const root = document.documentElement;
  root.removeAttribute("data-density");
  root.removeAttribute("data-brighter-comments");
  root.removeAttribute("style");
});

const last = <T,>(xs: T[]): T | undefined => xs[xs.length - 1];
const lastPrefs = () => last(callsTo("save_ui_prefs"))?.prefs as UiPrefs;
const lastAi = () => last(callsTo("save_ai_settings"))!;

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

test("theme_cards_with_previews_and_follow_windows", async () => {
  settingsRoutes();
  renderWithProviders(<AppearanceSection />);
  const group = screen.getByRole("radiogroup", { name: "Theme" });
  const radios = within(group).getAllByRole("radio");
  expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["Dracula", "Alucard", "Follow Windows"]);
  await waitFor(() => expect((within(group).getByRole("radio", { name: "Dracula" }) as HTMLInputElement).checked).toBe(true));

  // Each card draws real code in its own theme's tokens; Follow Windows shows both.
  const card = (name: string) => within(group).getByRole("radio", { name }).closest(".theme-card") as HTMLElement;
  expect(card("Dracula").querySelectorAll(".theme-dark .theme-preview-code")).toHaveLength(1);
  expect(card("Dracula").querySelector(".theme-light")).toBeNull();
  expect(card("Alucard").querySelectorAll(".theme-light .theme-preview-code")).toHaveLength(1);
  expect(card("Follow Windows").querySelectorAll(".theme-light, .theme-dark")).toHaveLength(2);
  expect(card("Dracula").textContent).toContain("SELECT count(*)");
  expect(card("Dracula").textContent).toContain("Dark");
  expect(card("Alucard").textContent).toContain("Light");
  expect(screen.getByText("Follow Windows uses Alucard in light mode and Dracula in dark mode.")).toBeTruthy();

  await userEvent.click(within(group).getByRole("radio", { name: "Alucard" }));
  await waitFor(() => expect(lastPrefs()?.theme).toBe("light"));
  await userEvent.click(within(group).getByRole("radio", { name: "Follow Windows" }));
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

// ---- Keymap ----

test("keymap_rows_and_edit_shortcuts_dialog", async () => {
  settingsRoutes();
  renderWithProviders(<KeymapSection />);
  await waitFor(() => expect(callsTo("keymap")).toHaveLength(1));
  expect(screen.getByRole("combobox", { name: "Keymap" }).textContent).toContain("VS Code");
  const rows = within(screen.getByRole("list", { name: "Main shortcuts" })).getAllByRole("listitem");
  expect(rows.map((r) => r.textContent)).toEqual([
    "Run the current statementCtrl+Enter",
    "Run allCtrl+Shift+Enter",
    "FormatShift+Alt+F",
    "SettingsCtrl+,",
  ]);

  await userEvent.click(screen.getByRole("button", { name: "Edit shortcuts..." }));
  const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  expect(dialog.className).toContain("dialog-size-wide");
  const list = () => within(within(dialog).getByRole("table", { name: "Shortcuts" })).getAllByRole("row").slice(1);
  expect(list()).toHaveLength(COMMANDS.length);
  expect(within(dialog).getByRole("row", { name: /^Run the current statement/ }).textContent).toContain("Ctrl+Enter");
  await userEvent.type(within(dialog).getByRole("searchbox", { name: "Search shortcuts" }), "format");
  expect(list().map((r) => r.querySelector("th")?.textContent)).toEqual(["Format"]);
  // Keys are searchable too.
  await userEvent.clear(within(dialog).getByRole("searchbox", { name: "Search shortcuts" }));
  await userEvent.type(within(dialog).getByRole("searchbox", { name: "Search shortcuts" }), "F12");
  expect(list().map((r) => r.querySelector("th")?.textContent)).toEqual(["Go to definition"]);
});

async function openDialog() {
  await userEvent.click(screen.getByRole("button", { name: "Edit shortcuts..." }));
  return screen.getByRole("dialog", { name: "Keyboard shortcuts" });
}

test("rebind_shows_the_clash_and_confirm_moves_it", async () => {
  settingsRoutes();
  renderWithProviders(<KeymapSection />);
  await waitFor(() => expect(callsTo("keymap")).toHaveLength(1));
  const dialog = await openDialog();
  await userEvent.click(within(dialog).getByRole("button", { name: "Edit Run the current statement" }));
  const capture = within(dialog).getByRole("textbox", { name: "Press the new keys for Run the current statement" });
  expect(document.activeElement).toBe(capture);

  // A key with no modifier is refused with the reason.
  await userEvent.keyboard("a");
  expect(within(dialog).getByRole("alert").textContent).toBe("Choose keys with Ctrl, Alt or Shift, or a function key.");

  await userEvent.keyboard("{Control>}t{/Control}");
  expect(within(dialog).getByRole("alert").textContent).toContain("Ctrl+T is used by New query.");
  expect(callsTo("save_keymap")).toHaveLength(0);
  // The dialog stays open: the press never reached the window's own keys.
  expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();

  await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(1));
  expect(callsTo("save_keymap")[0].overrides).toEqual({ "query.run": ["Ctrl+T"], "query.new": [] });
  await waitFor(() => expect(within(dialog).getByRole("row", { name: /^Run the current statement/ }).textContent).toContain("Ctrl+T"));
  expect(within(dialog).getByRole("row", { name: /^New query/ }).textContent).toContain("None");

  // Cancel keeps the keys as they were.
  await userEvent.click(within(dialog).getByRole("button", { name: "Edit Format" }));
  await userEvent.keyboard("{Control>}w{/Control}");
  expect(within(dialog).getByRole("alert").textContent).toContain("Ctrl+W is used by Close tab.");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(callsTo("save_keymap")).toHaveLength(1);
  expect(within(dialog).getByRole("row", { name: /^Format/ }).textContent).toContain("Shift+Alt+F");

  // Keys nothing else uses are saved at once.
  await userEvent.click(within(dialog).getByRole("button", { name: "Edit Format" }));
  await userEvent.keyboard("{Control>}{Alt>}l{/Alt}{/Control}");
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(2));
  expect(callsTo("save_keymap")[1].overrides).toEqual({ "query.run": ["Ctrl+T"], "query.new": [], "query.format": ["Ctrl+Alt+L"] });
});

test("reset_one_and_reset_all", async () => {
  settingsRoutes({}, { keymap: { "query.run": ["Ctrl+R"], "query.format": ["Ctrl+Shift+I"] } });
  renderWithProviders(<KeymapSection />);
  await waitFor(() => expect(screen.getByRole("list", { name: "Main shortcuts" }).textContent).toContain("Ctrl+R"));
  const dialog = await openDialog();
  expect((within(dialog).getByRole("button", { name: "Reset Run all" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(within(dialog).getByRole("button", { name: "Reset Run the current statement" }));
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(1));
  expect(callsTo("save_keymap")[0].overrides).toEqual({ "query.format": ["Ctrl+Shift+I"] });
  await waitFor(() => expect(within(dialog).getByRole("row", { name: /^Run the current statement/ }).textContent).toContain("Ctrl+Enter"));

  await userEvent.click(within(dialog).getByRole("button", { name: "Reset all" }));
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(2));
  expect(callsTo("save_keymap")[1].overrides).toEqual({});
  await waitFor(() => expect((within(dialog).getByRole("button", { name: "Reset all" }) as HTMLButtonElement).disabled).toBe(true));
});

// ---- AI assistant ----

test("ai_rows_provider_model_key_new_connections_inline", async () => {
  settingsRoutes();
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[]} onConnectionSaved={() => {}} />);
  await screen.findByRole("combobox", { name: "Provider" });
  expect(await optionsOf("Provider")).toEqual(["None", "OpenAI-compatible", "Anthropic Claude", "Groq", "DeepSeek", "Custom"]);
  expect(screen.getByLabelText("API key")).toBeTruthy();
  expect(screen.getByText("Kept in Windows Credential Manager, never in the data folder.")).toBeTruthy();
  expect(screen.getByText("Default AI access. Production Connections always start at Never send anything.")).toBeTruthy();
  expect(
    screen.getByText("Suggests the rest of a statement where you are typing. Uses the Connection's AI access. Arrives with step 11."),
  ).toBeTruthy();
  // No Group open: no per-Group switch. Inline Ask and Ask on errors stay (PR25).
  expect(screen.queryByRole("switch", { name: /Use different settings/ })).toBeNull();
  expect(screen.getByRole("switch", { name: "Inline Ask" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("switch", { name: "Ask on errors" }).getAttribute("aria-checked")).toBe("true");

  // Each change is saved at once, with the saved key left alone.
  await choose("Provider", "Groq");
  await waitFor(() => expect(callsTo("save_ai_settings")).toHaveLength(1));
  expect(lastAi().settings).toMatchObject({ provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" });
  expect(lastAi().key).toEqual({ t: "keep" });
  expect(lastAi().overrideGroup).toBe(false);

  await choose("Model", "llama-3.1-8b-instant");
  await waitFor(() => expect((lastAi().settings as AiSettings).model).toBe("llama-3.1-8b-instant"));
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
  expect(await screen.findByText(/Connected to Groq\. llama-3\.3-70b-versatile replied in 412ms\. Only the test prompt was sent\./)).toBeTruthy();
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
  await choose("Model", "llama-3.1-8b-instant");
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

test("access_table_rows_use_brand_marks", async () => {
  const a = conn("c1", "KFC shop");
  const b = conn("c2", "KFC stores", { dialect: "mysql", aiAccess: "never" });
  settingsRoutes({
    set_connection_ai_access: (args) => ({ ...(args.id === "c1" ? a : b), aiAccess: args.access }),
  });
  const onConnectionSaved = vi.fn();
  renderWithProviders(<AiSection groupId={null} groupName={null} connections={[a, b]} onConnectionSaved={onConnectionSaved} />);
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
      "Contura is portable. Connections, Groups, Saved Queries, Query History and these settings live in one folder next to Contura.exe. Copy the folder to take everything to another PC.",
    ),
  ).toBeTruthy();
  const counts = screen.getByRole("list", { name: "What the data folder holds" });
  expect(within(counts).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "Connections9",
    "Groups3",
    "Saved Queries24",
    "Query History4.2 MB",
  ]);
  expect(screen.queryByRole("button", { name: /Move/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
  expect(callsTo("open_data_folder")).toHaveLength(1);
  expect(screen.getByText("Passwords stay in Windows Credential Manager on this PC, so a copied folder asks for each one once.")).toBeTruthy();
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
  await screen.findByText("4.2 MB");
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
  expect(await screen.findByText("0 bytes")).toBeTruthy();
});

test("shortening_keep_history_asks_first_and_lengthening_applies_at_once", async () => {
  settingsRoutes();
  renderWithProviders(<DataFolderSection />);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
  await screen.findByText("4.2 MB");
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
  expect(await screen.findByText("Contura 0.7.0")).toBeTruthy();
  const licences = screen.getByRole("list", { name: "Licences" });
  expect(within(licences).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "JetBrains Mono, SIL Open Font License 1.1",
    "Lucide icons, ISC",
    "Simple Icons, CC0 1.0",
  ]);
  expect(screen.getByText("Everything Contura keeps is in the data folder next to Contura.exe.")).toBeTruthy();
});

