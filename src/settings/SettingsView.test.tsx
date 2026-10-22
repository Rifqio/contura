import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UiPrefs } from "../api/types";
import type { SettingsSection } from "../shell/tabs";
import { callsTo } from "../test/invoke";
import { renderWithProviders, settingsRoutes } from "../test/settingsRoutes";
import SettingsView from "./SettingsView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./fontDetect", () => ({ isInstalled: () => false }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.7.0") }));

const ORDER = ["appearance", "editor", "keymap", "ai", "dataFolder", "about"];
const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  // Each section sits 100 px lower than the one before, below the page's 20 px padding.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const at = ORDER.indexOf(this.getAttribute("data-section") ?? "");
    const top = at < 0 ? 0 : 20 + at * 100 - (this.closest(".settings-scroll")?.scrollTop ?? 0);
    return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
});
const page = () => document.querySelector(".settings-scroll") as HTMLElement;

function Harness({ onSection }: { onSection?: (s: SettingsSection) => void }) {
  const [section, setSection] = useState<SettingsSection>("appearance");
  return (
    <SettingsView
      section={section}
      onSection={(s) => {
        setSection(s);
        onSection?.(s);
      }}
      groupId={null}
      groupName={null}
      connections={[]}
    />
  );
}

async function renderView(onSection?: (s: SettingsSection) => void) {
  settingsRoutes();
  renderWithProviders(<Harness onSection={onSection} />);
  // Settled once the AI settings have loaded.
  await screen.findByRole("combobox", { name: "Provider" });
}

const nav = () => screen.getByRole("navigation", { name: "Settings sections" });
const region = (name: string) => screen.queryByRole("region", { name });

test("tab_has_search_nav_and_heading", async () => {
  await renderView();
  expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeTruthy();
  expect(within(nav()).getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Appearance",
    "Editor",
    "Keymap",
    "AI assistant",
    "Data folder",
    "About Contura",
  ]);
  expect(within(nav()).getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
  expect(screen.getByText("Changes apply right away and are saved in the data folder.")).toBeTruthy();
});

test("search_filters_rows_and_hides_empty_sections", async () => {
  await renderView();
  const search = screen.getByRole("searchbox", { name: "Search settings" });
  await userEvent.type(search, "ligature");
  expect(region("Editor")).not.toBeNull();
  expect(screen.getByRole("switch", { name: "Ligatures" })).toBeTruthy();
  // Other rows of the same section go, and so do the sections with no match.
  expect(screen.queryByRole("combobox", { name: "Font" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "Brighter comments" })).toBeNull();
  for (const gone of ["Appearance", "Keymap", "AI assistant", "Data folder", "About Contura"]) expect(region(gone)).toBeNull();

  await userEvent.clear(search);
  await userEvent.type(search, "keep history");
  expect(region("Data folder")).not.toBeNull();
  expect(screen.getByRole("combobox", { name: "Keep history for" })).toBeTruthy();
  expect(region("Editor")).toBeNull();

  // A section's own name shows all of it.
  await userEvent.clear(search);
  await userEvent.type(search, "keymap");
  expect(region("Keymap")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Edit shortcuts..." })).toBeTruthy();

  await userEvent.clear(search);
  await userEvent.type(search, "zzz");
  expect(screen.getByText('No settings match "zzz".')).toBeTruthy();

  await userEvent.clear(search);
  for (const back of ["Appearance", "Editor", "Keymap", "AI assistant", "Data folder", "About Contura"]) expect(region(back)).not.toBeNull();
});

test("nav_scrolls_to_the_section", async () => {
  const onSection = vi.fn();
  await renderView(onSection);
  await userEvent.click(within(nav()).getByRole("button", { name: "Data folder" }));
  expect(onSection).toHaveBeenCalledWith("dataFolder");
  expect(within(nav()).getByRole("button", { name: "Data folder" }).getAttribute("aria-current")).toBe("page");
  await waitFor(() => expect(page().scrollTop).toBe(400));

  // A nav click clears a search that hid the section, then scrolls to it.
  await userEvent.type(screen.getByRole("searchbox", { name: "Search settings" }), "ligatures");
  expect(region("About Contura")).toBeNull();
  await userEvent.click(within(nav()).getByRole("button", { name: "About Contura" }));
  expect((screen.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement).value).toBe("");
  await waitFor(() => expect(page().scrollTop).toBe(500));

  // Back up to the top section.
  await userEvent.click(within(nav()).getByRole("button", { name: "Appearance" }));
  await waitFor(() => expect(page().scrollTop).toBe(0));
});

test("two_columns_in_the_design_order", async () => {
  await renderView();
  const columns = document.querySelectorAll(".settings-cols > .settings-col");
  expect(columns).toHaveLength(2);
  const names = (el: Element) => within(el as HTMLElement).getAllByRole("region").map((r) => r.getAttribute("aria-label") ?? r.querySelector("h2")?.textContent);
  expect(names(columns[0])).toEqual(["Appearance", "Editor", "Keymap"]);
  expect(names(columns[1])).toEqual(["AI assistant", "Data folder"]);
  // About sits below both columns.
  const about = region("About Contura")!;
  expect(about.closest(".settings-cols")).toBeNull();
  expect(columns[1].compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("changes_apply_without_save_or_cancel", async () => {
  await renderView();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  // The one Save is the API key's own (D6), and it waits for a typed key.
  const saves = screen.getAllByRole("button", { name: "Save" });
  expect(saves).toHaveLength(1);
  expect((saves[0] as HTMLButtonElement).disabled).toBe(true);

  await userEvent.click(screen.getByRole("switch", { name: "Ligatures" }));
  await waitFor(() => expect(callsTo("save_ui_prefs")).toHaveLength(1));
  expect((callsTo("save_ui_prefs")[0].prefs as UiPrefs).editor.ligatures).toBe(false);
  expect(screen.getByRole("switch", { name: "Ligatures" }).getAttribute("aria-checked")).toBe("false");
});

test("a_row_request_scrolls_to_that_block", async () => {
  // The tools table sits 250 px into the AI section (board 11.12: Open Settings from a diagram's tool-off note).
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.getAttribute("data-row") !== "tools") return rect.call(this);
    const top = 20 + 3 * 100 + 250 - (this.closest(".settings-scroll")?.scrollTop ?? 0);
    return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
  settingsRoutes();
  renderWithProviders(<SettingsView section="ai" row="tools" groupId={null} groupName={null} connections={[]} onSection={() => {}} />);
  await screen.findByRole("combobox", { name: "Provider" });
  await waitFor(() => expect(page().scrollTop).toBe(550));
});
