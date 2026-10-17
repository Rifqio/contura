import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { DEFAULT_UI_PREFS, type AiSettings, type AiSettingsView, type DataFolderInfo, type KeymapOverrides, type UiPrefs } from "../api/types";
import { KeymapProvider } from "../commands/useCommandKeys";
import { PrefsProvider } from "../prefs/usePrefs";
import { routeInvoke } from "./invoke";

export const NO_AI: AiSettings = {
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

export const GROQ: AiSettings = {
  ...NO_AI,
  provider: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.3-70b-versatile",
  // Set, so a save that dropped them would show.
  temperature: 0.5,
  maxTokens: 1024,
};

export const aiView = (over: Partial<AiSettingsView> = {}): AiSettingsView => ({
  settings: NO_AI,
  groupOverride: false,
  keySaved: false,
  keyLast4: null,
  ...over,
});

export const FOLDER: DataFolderInfo = {
  path: "E:\\Apps\\Contura\\data",
  connections: 9,
  groups: 3,
  savedQueries: 24,
  // 4.2 MB in the 1024 steps Windows Explorer uses.
  historyBytes: 4_404_019,
};

type Handler = (args: Record<string, unknown>) => unknown;

/** Every command the Settings screen calls, with a stored copy of the prefs and the keymap. */
export function settingsRoutes(
  over: Record<string, Handler> = {},
  start: { prefs?: Partial<UiPrefs>; keymap?: KeymapOverrides } = {},
) {
  const store = { prefs: { ...DEFAULT_UI_PREFS, ...start.prefs } as UiPrefs, keymap: { ...start.keymap } as KeymapOverrides };
  routeInvoke({
    ui_prefs: () => store.prefs,
    save_ui_prefs: (a) => {
      store.prefs = a.prefs as UiPrefs;
    },
    keymap: () => store.keymap,
    save_keymap: (a) => {
      store.keymap = a.overrides as KeymapOverrides;
    },
    ai_settings: () => aiView(),
    save_ai_settings: () => undefined,
    ai_test: () => ({ model: "llama-3.3-70b-versatile", millis: 412 }),
    data_folder_info: () => FOLDER,
    open_data_folder: () => undefined,
    clear_query_history: () => undefined,
    "plugin:app|version": () => "0.7.0",
    ...over,
  });
  return store;
}

/** The prefs and keymap holders the Settings sections read from. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <PrefsProvider>
      <KeymapProvider>{children}</KeymapProvider>
    </PrefsProvider>
  );
}

export function renderWithProviders(ui: ReactNode) {
  return render(ui, { wrapper: Providers });
}
