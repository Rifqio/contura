import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AiSettingsView, DataFolderInfo, UiPrefs } from "../api/types";
import { COMMANDS } from "../commands/registry";
import type { AiPage, SettingsSection } from "../shell/tabs";
import { callsTo } from "../test/invoke";
import { aiView, renderWithProviders, settingsRoutes } from "../test/settingsRoutes";
import SettingsView from "./SettingsView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./fontDetect", () => ({ isInstalled: () => false }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("1.0.0") }));

/** Rows gone to sit 300 px into the page, below its 20 px padding. */
const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const top = this.hasAttribute("data-row") ? 320 - (this.closest(".settings-scroll")?.scrollTop ?? 0) : 0;
    return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
});
const scroller = () => document.querySelector(".settings-scroll") as HTMLElement;

function Harness({ start = "appearance", onSection }: { start?: SettingsSection; onSection?: (s: SettingsSection, p?: AiPage) => void }) {
  const [at, setAt] = useState<{ section: SettingsSection; aiPage?: AiPage }>({ section: start });
  return (
    <SettingsView
      section={at.section}
      aiPage={at.aiPage}
      onSection={(section, aiPage) => {
        setAt({ section, aiPage });
        onSection?.(section, aiPage);
      }}
      groupId={null}
      groupName={null}
      connections={[]}
    />
  );
}

async function renderView(start?: SettingsSection, onSection?: (s: SettingsSection, p?: AiPage) => void) {
  settingsRoutes();
  renderWithProviders(<Harness start={start} onSection={onSection} />);
  await waitFor(() => expect(callsTo("ui_prefs")).toHaveLength(1));
}

const nav = () => screen.getByRole("navigation", { name: "Settings sections" });
const navButton = (name: string) => within(nav()).getByRole("button", { name });
const current = () => within(nav()).queryAllByRole("button", { current: "page" }).map((b) => b.textContent);
const title = () => screen.getByRole("heading", { level: 1 }).textContent;
const searchBox = () => screen.getByRole("searchbox", { name: "Search settings" });

test("nav_lists_the_sections_and_shows_one_page_in_one_column", async () => {
  await renderView();
  expect(within(nav()).getAllByRole("button").map((b) => b.textContent)).toEqual([
    "General",
    "Appearance",
    "Editor",
    `Keymap, ${COMMANDS.length}`,
    "AI assistant",
    "Data folder",
    "Updates",
    "About Contura",
  ]);
  expect(current()).toEqual(["Appearance"]);
  expect(title()).toBe("Appearance");
  expect(screen.getByText("Theme, data grids and the window.")).toBeTruthy();
  // One section only: the theme cards, not the editor font or the AI settings.
  expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Font" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  expect(document.querySelector(".settings-cols")).toBeNull();
  expect(callsTo("ai_settings")).toHaveLength(0);
});

test("a_nav_item_shows_its_section_from_the_top", async () => {
  const onSection = vi.fn();
  await renderView("appearance", onSection);
  scroller().scrollTop = 200;
  await userEvent.click(navButton("Data folder"));
  expect(onSection).toHaveBeenCalledWith("dataFolder", undefined);
  expect(current()).toEqual(["Data folder"]);
  expect(title()).toBe("Data folder");
  expect(screen.getByRole("combobox", { name: "Keep history for" })).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
  expect(scroller().scrollTop).toBe(0);

  await userEvent.click(navButton("Editor"));
  expect(title()).toBe("Editor");
  // Every change applies at once: nothing to save or cancel.
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  await userEvent.click(screen.getByRole("switch", { name: "Ligatures" }));
  await waitFor(() => expect(callsTo("save_ui_prefs")).toHaveLength(1));
  expect((callsTo("save_ui_prefs")[0].prefs as UiPrefs).editor.ligatures).toBe(false);
});

test("ai_assistant_is_four_pages_each_with_use_different_settings_for_on_top", async () => {
  const onSection = vi.fn();
  await renderView("appearance", onSection);
  expect(within(nav()).queryByRole("button", { name: "Provider" })).toBeNull();
  await userEvent.click(navButton("AI assistant"));
  expect(onSection).toHaveBeenLastCalledWith("ai", undefined);
  // The four pages show under AI assistant; Provider first.
  const subs = [...nav().querySelectorAll(".snav-sub")].map((b) => b.textContent);
  expect(subs).toEqual(["Provider", "Behaviour", "Privacy", "Tools"]);
  expect(current()).toEqual(["Provider"]);
  expect(title()).toBe("AI assistant: Provider");
  await screen.findByRole("combobox", { name: "Provider" });
  const top = () => document.querySelector(".settings-page > .scard [data-row]")?.getAttribute("data-row");
  expect(top()).toBe("group");

  const pages: [string, string, string][] = [
    ["Behaviour", "Default thinking level", "How the assistant answers and where it offers help."],
    ["Privacy", "Keep the exact text sent with each answer", "What leaves this computer, and what is kept."],
    ["Tools", "Propose diagram changes", "What the assistant may do on its own while it answers."],
  ];
  for (const [page, control, desc] of pages) {
    await userEvent.click(within(nav()).getByRole("button", { name: page }));
    expect(onSection).toHaveBeenLastCalledWith("ai", page.toLowerCase());
    expect(title()).toBe(`AI assistant: ${page}`);
    expect(screen.getByText(desc)).toBeTruthy();
    expect(screen.getByText(control)).toBeTruthy();
    expect(top()).toBe("group");
    expect(current()).toEqual([page]);
    expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  }
  // Moving between the AI pages keeps the loaded settings: they are read once.
  expect(callsTo("ai_settings")).toHaveLength(1);
});

test("search_lists_settings_and_shortcuts_and_no_nav_item_is_current", async () => {
  await renderView();
  await userEvent.type(searchBox(), "format");
  expect(current()).toEqual([]);
  expect(navButton("Appearance").className).not.toContain("on");
  expect(title()).toMatch(/^\d+ match(es)? for "format"$/);
  const results = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("listitem");
  const format = results.find((r) => r.textContent?.startsWith("Format"))!;
  expect(format.textContent).toContain("Keymap");
  expect(format.textContent).toContain("Shift+Alt+F");
  // The page under the search is gone while it shows.
  expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();

  await userEvent.clear(searchBox());
  await userEvent.type(searchBox(), "zzz");
  expect(title()).toBe('Nothing matches "zzz"');
  await userEvent.clear(searchBox());
  expect(current()).toEqual(["Appearance"]);
  expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
});

test("search_finds_the_new_appearance_rows", async () => {
  await renderView("editor");
  for (const [words, label, card] of [
    ["zebra", "Stripe every other row", "Data grids"],
    ["show null", "Show NULL as", "Data grids"],
    ["zoom", "Interface size", "Window"],
  ]) {
    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), words);
    const result = screen.getByRole("button", { name: new RegExp(`^${label}`) });
    expect(result.textContent).toContain("Appearance");
    expect(result.textContent).toContain(card);
  }
});

test("picking_a_result_goes_to_its_page_and_highlights_the_row", async () => {
  const onSection = vi.fn();
  await renderView("appearance", onSection);
  await userEvent.type(searchBox(), "keep history");
  const result = screen.getByRole("button", { name: /^Keep history for/ });
  expect(result.textContent).toContain("Data folder");
  await userEvent.click(result);
  expect(onSection).toHaveBeenLastCalledWith("dataFolder", undefined);
  expect((searchBox() as HTMLInputElement).value).toBe("");
  expect(title()).toBe("Data folder");
  const row = document.querySelector('[data-row="keep"]') as HTMLElement;
  expect(row.className).toContain("srow-flash");
  await waitFor(() => expect(scroller().scrollTop).toBe(300));

  // An AI row goes to its page, with its card in the trail.
  await userEvent.type(searchBox(), "inline ask");
  const ask = screen.getByRole("button", { name: /^Inline Ask/ });
  expect(ask.textContent).toContain("AI assistant, Behaviour, Where it helps");
  await userEvent.click(ask);
  expect(onSection).toHaveBeenLastCalledWith("ai", "behaviour");
  expect(await screen.findByRole("switch", { name: "Inline Ask" })).toBeTruthy();
  await waitFor(() => expect((document.querySelector('[data-row="inlineAsk"]') as HTMLElement).className).toContain("srow-flash"));

  // A shortcut goes to its row in the Keymap.
  await userEvent.type(searchBox(), "open group 4");
  await userEvent.click(screen.getByRole("button", { name: /^Open Group 4/ }));
  expect(title()).toBe("Keymap");
  expect((document.querySelector('[data-row="group.open.4"]') as HTMLElement).className).toContain("srow-flash");
  // The next move drops the highlight.
  await userEvent.click(navButton("Editor"));
  expect(document.querySelector(".srow-flash")).toBeNull();
});

test("a_row_request_opens_its_ai_page_and_scrolls_to_it", async () => {
  settingsRoutes();
  renderWithProviders(<SettingsView section="ai" row="tools" groupId={null} groupName={null} connections={[]} onSection={() => {}} />);
  expect(title()).toBe("AI assistant: Tools");
  // The block draws once the AI settings load, and the page goes there then.
  await screen.findByRole("switch", { name: "Propose diagram changes" });
  await waitFor(() => expect(scroller().scrollTop).toBe(300));
});

test("general_shows_the_first_start_guide_again", async () => {
  settingsRoutes();
  const onShowGuide = vi.fn();
  renderWithProviders(<SettingsView section="general" onSection={() => {}} groupId={null} groupName={null} connections={[]} onShowGuide={onShowGuide} />);
  expect(title()).toBe("General");
  await userEvent.click(screen.getByRole("button", { name: "Show it again" }));
  expect(onShowGuide).toHaveBeenCalledTimes(1);
  // Search finds it by what it does.
  await userEvent.type(searchBox(), "first start");
  expect(screen.getByRole("button", { name: /^First start guide/ }).textContent).toContain("General");
});

test("the_data_folder_contents_load_fail_and_try_again", async () => {
  const replies: { ok: (v: DataFolderInfo) => void; fail: (e: unknown) => void }[] = [];
  settingsRoutes({ data_folder_info: () => new Promise((ok, fail) => replies.push({ ok, fail })) });
  renderWithProviders(<SettingsView section="dataFolder" onSection={() => {}} groupId={null} groupName={null} connections={[]} />);
  expect(await screen.findByText("Counting...")).toBeTruthy();
  await waitFor(() => expect(replies).toHaveLength(1));
  replies[0].fail({ kind: "io", message: "permission denied" });
  const error = await screen.findByText(/^Could not read the data folder: .*permission denied/);
  expect(error.closest("[role=alert]")).not.toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Counting...")).toBeTruthy();
  await waitFor(() => expect(replies).toHaveLength(2));
  replies[1].ok({ path: "/data", connections: 2, groups: 1, savedQueries: 0, historyBytes: 0 });
  expect(await screen.findByText(/^2 Connections, 1 Group, 0 Saved Queries/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("a_picked_result_takes_focus_so_it_never_falls_to_the_body", async () => {
  await renderView();
  await userEvent.type(searchBox(), "keep history");
  await userEvent.click(screen.getByRole("button", { name: /^Keep history for/ }));
  // The first control of the row gone to.
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Keep history for" }));

  await userEvent.type(searchBox(), "format");
  await userEvent.click(screen.getByRole("button", { name: /^Format/ }));
  expect(document.activeElement?.closest('[data-row="query.format"]')).not.toBeNull();
  expect(document.activeElement).not.toBe(document.body);
});

test("a_picked_row_the_page_does_not_draw_says_so_and_stops_looking", async () => {
  // Preset shows only for the OpenAI provider; with none set it is not drawn.
  await renderView();
  await userEvent.type(searchBox(), "preset");
  await userEvent.click(screen.getByRole("button", { name: /^Preset/ }));
  expect(title()).toBe("AI assistant: Provider");
  expect(
    await screen.findByText("That setting is not shown now: it depends on the provider, the open Group, or a new version being found.", undefined, {
      timeout: 4000,
    }),
  ).toBeTruthy();
  // Focus lands on the page title instead.
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  // The next move clears the note.
  await userEvent.click(navButton("Editor"));
  expect(screen.queryByText(/That setting is not shown now/)).toBeNull();
});

/** AI settings that answer only when the test says so. */
function slowAi() {
  const replies: ((v: AiSettingsView) => void)[] = [];
  settingsRoutes({ ai_settings: () => new Promise<AiSettingsView>((ok) => replies.push(ok)) });
  return { answer: () => replies.forEach((ok) => ok(aiView())) };
}

test("a_row_drawn_after_the_wait_still_gets_the_jump_and_the_note_goes", async () => {
  const ai = slowAi();
  renderWithProviders(<Harness />);
  await userEvent.type(searchBox(), "prompt caching");
  await userEvent.click(screen.getByRole("button", { name: /^Use prompt caching/ }));
  expect(title()).toBe("AI assistant: Behaviour");
  const note = "That setting is not shown now: it depends on the provider, the open Group, or a new version being found.";
  expect(await screen.findByText(note, undefined, { timeout: 4000 })).toBeTruthy();
  // The settings load late: the row draws, the note goes and the page goes there.
  ai.answer();
  const row = await screen.findByRole("switch", { name: "Use prompt caching when the model supports it" });
  await waitFor(() => expect(screen.queryByText(note)).toBeNull());
  expect(row.closest(".srow")!.className).toContain("srow-flash");
  await waitFor(() => expect(scroller().scrollTop).toBe(300));
});

test("moving_before_a_jump_lands_drops_its_focus", async () => {
  const ai = slowAi();
  renderWithProviders(<Harness />);
  await userEvent.type(searchBox(), "prompt caching");
  await userEvent.click(screen.getByRole("button", { name: /^Use prompt caching/ }));
  // The user goes on to Behaviour's neighbour before the settings load.
  await userEvent.click(within(nav()).getByRole("button", { name: "Privacy" }));
  expect(document.activeElement).toBe(within(nav()).getByRole("button", { name: "Privacy" }));
  ai.answer();
  await screen.findByRole("switch", { name: "Keep the exact text sent with each answer" });
  await new Promise((r) => setTimeout(r, 50));
  expect(document.activeElement).toBe(within(nav()).getByRole("button", { name: "Privacy" }));
  // Back on Behaviour, nothing jumps to the old pick.
  await userEvent.click(within(nav()).getByRole("button", { name: "Behaviour" }));
  expect(document.activeElement).toBe(within(nav()).getByRole("button", { name: "Behaviour" }));
});

test("a_late_row_does_not_take_focus_from_where_the_user_went", async () => {
  const ai = slowAi();
  renderWithProviders(<Harness />);
  await userEvent.type(searchBox(), "prompt caching");
  await userEvent.click(screen.getByRole("button", { name: /^Use prompt caching/ }));
  await userEvent.click(searchBox());
  ai.answer();
  await screen.findByRole("switch", { name: "Use prompt caching when the model supports it" });
  await waitFor(() => expect(scroller().scrollTop).toBe(300));
  expect(document.activeElement).toBe(searchBox());
});
