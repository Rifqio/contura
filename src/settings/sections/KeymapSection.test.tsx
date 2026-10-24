import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { COMMANDS } from "../../commands/registry";
import { callsTo } from "../../test/invoke";
import { renderWithProviders, settingsRoutes } from "../../test/settingsRoutes";
import KeymapSection, { KEYMAP_GROUPS } from "./KeymapSection";
import { FlashContext } from "./layout";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

async function renderKeymap(over: Parameters<typeof settingsRoutes>[0] = {}, start: Parameters<typeof settingsRoutes>[1] = {}) {
  settingsRoutes(over, start);
  const view = renderWithProviders(<KeymapSection title="Keymap" desc="All commands." />);
  await waitFor(() => expect(callsTo("keymap")).toHaveLength(1));
  return view;
}

const group = (name: string) => screen.getByRole("region", { name });
const rowOf = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement;
const titles = () => [...document.querySelectorAll(".krow .krow-title > span:first-child")].map((t) => t.firstChild?.textContent);
const search = () => screen.getByRole("textbox", { name: "Search shortcuts" });

test("every_command_of_the_registry_is_listed_once_in_the_boards_groups", async () => {
  const ids = KEYMAP_GROUPS.flatMap((g) => g.ids).flatMap((id) => (id === "group.open" || id === "tab.goto" ? COMMANDS.filter((c) => c.id.startsWith(`${id}.`)).map((c) => c.id) : [id]));
  expect([...ids].sort()).toEqual(COMMANDS.map((c) => c.id).sort());

  await renderKeymap();
  expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(KEYMAP_GROUPS.map((g) => g.name));
  expect(within(group("Queries and the editor")).getByText("10 shortcuts")).toBeTruthy();
  const run = rowOf("query.run");
  expect(run.textContent).toContain("Run the current statement");
  expect(run.textContent).toContain("Editor");
  expect(run.textContent).toContain("Ctrl+Enter");
  expect(rowOf("editor.quickFix").textContent).toContain("Ctrl+.orAlt+Enter");
  expect(rowOf("query.explain").textContent).toContain("No shortcut");
  expect(rowOf("export.open").textContent).toContain("In a table grid or a result");
});

test("open_group_1_to_9_is_folded_until_show_9", async () => {
  await renderKeymap();
  const connections = group("Connections and schema");
  expect(within(connections).getByText("Open Group 1 to 9")).toBeTruthy();
  expect(rowOf("group.open.1")).toBeNull();
  await userEvent.click(within(connections).getByRole("button", { name: "Show 9" }));
  for (let n = 1; n <= 9; n++) expect(rowOf(`group.open.${n}`).textContent).toContain(`Ctrl+Alt+${n}`);
  expect(within(connections).queryByText("Open Group 1 to 9")).toBeNull();
});

test("go_to_tab_1_to_9_is_folded_in_tabs_and_windows_until_show_9", async () => {
  await renderKeymap();
  const tabs = group("Tabs and windows");
  expect(within(tabs).getByText("Go to tab 1 to 9")).toBeTruthy();
  expect(within(tabs).getByText("Ctrl+9 goes to the last tab")).toBeTruthy();
  expect(rowOf("tab.goto.1")).toBeNull();
  await userEvent.click(within(tabs).getByRole("button", { name: "Show 9" }));
  for (let n = 1; n <= 9; n++) expect(rowOf(`tab.goto.${n}`).textContent).toContain(`Ctrl+${n}`);
  expect(within(tabs).queryByText("Go to tab 1 to 9")).toBeNull();
  // The Groups fold stays folded.
  expect(rowOf("group.open.1")).toBeNull();
});

test("search_by_words_and_keys_and_the_filters", async () => {
  await renderKeymap({}, { keymap: { "query.format": ["Ctrl+Shift+I"] } });
  await waitFor(() => expect(rowOf("query.format").textContent).toContain("Changed"));
  expect(search().getAttribute("placeholder")).toBe(`Search ${COMMANDS.length} shortcuts`);

  await userEvent.type(search(), "format");
  expect(titles()).toEqual(["Format"]);
  // Keys are words too.
  await userEvent.clear(search());
  await userEvent.type(search(), "F12");
  expect(titles()).toEqual(["Go to definition"]);
  await userEvent.clear(search());
  await userEvent.type(search(), "zzz");
  expect(screen.getByText(/No shortcut matches/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Clear the search" }));
  expect((search() as HTMLInputElement).value).toBe("");

  // Search by keys reads the keys pressed, not typed letters.
  await userEvent.click(screen.getByRole("button", { name: "Search by keys" }));
  expect(screen.getByRole("button", { name: "Search by keys" }).getAttribute("aria-pressed")).toBe("true");
  expect(search().getAttribute("placeholder")).toBe("Press keys to see what uses them");
  search().focus();
  await userEvent.keyboard("{Control>}w{/Control}");
  expect((search() as HTMLInputElement).value).toBe("Ctrl+W");
  expect(titles()).toEqual(["Close tab"]);
  await userEvent.keyboard("{Backspace}");
  expect((search() as HTMLInputElement).value).toBe("");
  await userEvent.click(screen.getByRole("button", { name: "Search by keys" }));

  const show = screen.getByRole("radiogroup", { name: "Show" });
  const editorCount = COMMANDS.filter((c) => c.scope === "editor").length;
  expect(within(show).getAllByRole("radio").map((r) => r.textContent)).toEqual([
    `All, ${COMMANDS.length}`,
    `Editor, ${editorCount}`,
    `App, ${COMMANDS.length - editorCount}`,
    "Changed, 1",
  ]);
  await userEvent.click(within(show).getByRole("radio", { name: /^Editor/ }));
  expect(titles()).toHaveLength(editorCount);
  await userEvent.click(within(show).getByRole("radio", { name: /^Changed/ }));
  expect(titles()).toEqual(["Format"]);
});

test("rebind_in_the_row_with_the_clash_bar", async () => {
  await renderKeymap();
  await userEvent.click(screen.getByRole("button", { name: "Change the keys for Run the current statement" }));
  const capture = screen.getByRole("textbox", { name: "New keys for Run the current statement" });
  expect(document.activeElement).toBe(capture);
  expect(rowOf("query.run").className).toContain("cap");

  // A key with no modifier is refused with the reason.
  await userEvent.keyboard("a");
  expect(screen.getByRole("alert").textContent).toContain("Choose keys with Ctrl, Alt or Shift, or a function key.");

  await userEvent.keyboard("{Control>}t{/Control}");
  expect(screen.getByRole("alert").textContent).toContain("Ctrl+T is used by New query. Use it here, and New query has no shortcut?");
  expect(callsTo("save_keymap")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Use it here" }));
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(1));
  expect(callsTo("save_keymap")[0].overrides).toEqual({ "query.run": ["Ctrl+T"], "query.new": [] });
  await waitFor(() => expect(rowOf("query.run").textContent).toContain("Ctrl+T"));
  expect(rowOf("query.run").textContent).toContain("Changed");
  expect(rowOf("query.new").textContent).toContain("No shortcut");

  // A command with two keys keeps the other one, and says so.
  await userEvent.click(screen.getByRole("button", { name: "Change the keys for Format" }));
  await userEvent.keyboard("{Alt>}{Enter}{/Alt}");
  expect(screen.getByRole("alert").textContent).toContain("Alt+Enter is used by Quick fix. Use it here? Quick fix keeps Ctrl+.");
  // Cancel keeps the keys as they were.
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(callsTo("save_keymap")).toHaveLength(1);
  expect(rowOf("query.format").textContent).toContain("Shift+Alt+F");

  // Escape gives up; keys nothing else uses are saved at once.
  await userEvent.click(screen.getByRole("button", { name: "Change the keys for Format" }));
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "New keys for Format" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Change the keys for Format" }));
  await userEvent.keyboard("{Control>}{Alt>}l{/Alt}{/Control}");
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(2));
  expect(callsTo("save_keymap")[1].overrides).toEqual({ "query.run": ["Ctrl+T"], "query.new": [], "query.format": ["Ctrl+Alt+L"] });
});

test("reset_one_and_reset_all", async () => {
  await renderKeymap({}, { keymap: { "query.run": ["Ctrl+R"], "query.format": ["Ctrl+Shift+I"] } });
  await waitFor(() => expect(rowOf("query.run").textContent).toContain("Ctrl+R"));
  expect(screen.queryByRole("button", { name: /^Reset Run all/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Reset all (2)" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Reset Run the current statement to Ctrl+Enter" }));
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(1));
  expect(callsTo("save_keymap")[0].overrides).toEqual({ "query.format": ["Ctrl+Shift+I"] });
  await waitFor(() => expect(rowOf("query.run").textContent).toContain("Ctrl+Enter"));

  await userEvent.click(screen.getByRole("button", { name: "Reset all (1)" }));
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(2));
  expect(callsTo("save_keymap")[1].overrides).toEqual({});
  await waitFor(() => expect((screen.getByRole("button", { name: "Reset all" }) as HTMLButtonElement).disabled).toBe(true));
});

test("a_failed_save_shows_an_alert_and_changes_nothing", async () => {
  await renderKeymap({
    save_keymap: () => {
      throw { kind: "storage", message: "The data folder is read-only." };
    },
  });
  await userEvent.click(screen.getByRole("button", { name: "Change the keys for Format" }));
  await userEvent.keyboard("{Control>}{Alt>}l{/Alt}{/Control}");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The new keys were not saved: Error (storage): The data folder is read-only. Nothing changed.");
  expect(rowOf("query.format").textContent).toContain("Shift+Alt+F");
  expect(rowOf("query.format").textContent).not.toContain("Changed");
  expect((screen.getByRole("button", { name: "Reset all" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an override for a removed command is ignored, so Reset all has nothing to reset (item 35)", async () => {
  await renderKeymap({}, { keymap: { "visualQuery.addTable": ["Ctrl+Shift+A"] } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Reset all" }) as HTMLButtonElement).disabled).toBe(true));
  // A later save keeps only real overrides.
  await userEvent.click(screen.getByRole("button", { name: "Change the keys for Format" }));
  await userEvent.keyboard("{Control>}{Alt>}l{/Alt}{/Control}");
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(1));
  expect(callsTo("save_keymap")[0].overrides).toEqual({ "query.format": ["Ctrl+Alt+L"] });
});

test("a_highlighted_open_group_command_unfolds_the_nine", async () => {
  settingsRoutes();
  renderWithProviders(
    <FlashContext.Provider value="group.open.3">
      <KeymapSection title="Keymap" desc="All commands." />
    </FlashContext.Provider>,
  );
  expect(rowOf("group.open.3").className).toContain("srow-flash");
  expect(screen.queryByText("Open Group 1 to 9")).toBeNull();
});

const changeButton = (title: string) => screen.getByRole("button", { name: `Change the keys for ${title}` });

test("focus_returns_to_the_rows_change_button_after_escape_cancel_save_and_use_it_here", async () => {
  await renderKeymap();
  // Escape.
  await userEvent.click(changeButton("Format"));
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(changeButton("Format"));
  // Cancel in the clash bar.
  await userEvent.click(changeButton("Format"));
  await userEvent.keyboard("{Control>}w{/Control}");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(changeButton("Format"));
  // Use it here.
  await userEvent.click(changeButton("Format"));
  await userEvent.keyboard("{Control>}w{/Control}");
  await userEvent.click(screen.getByRole("button", { name: "Use it here" }));
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(1));
  await waitFor(() => expect(document.activeElement).toBe(changeButton("Format")));
  // A save with keys nothing else uses.
  await userEvent.click(changeButton("Save"));
  await userEvent.keyboard("{Control>}{Alt>}s{/Alt}{/Control}");
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(2));
  await waitFor(() => expect(document.activeElement).toBe(changeButton("Save")));
});

test("a_per_row_reset_moves_focus_to_the_change_button_and_show_9_to_the_first_group", async () => {
  await renderKeymap({}, { keymap: { "query.format": ["Ctrl+Shift+I"] } });
  await waitFor(() => expect(rowOf("query.format").textContent).toContain("Changed"));
  await userEvent.click(screen.getByRole("button", { name: "Reset Format to Shift+Alt+F" }));
  await waitFor(() => expect(rowOf("query.format").textContent).not.toContain("Changed"));
  expect(document.activeElement).toBe(changeButton("Format"));

  await userEvent.click(within(group("Connections and schema")).getByRole("button", { name: "Show 9" }));
  expect(document.activeElement).toBe(changeButton("Open Group 1"));
});

test("a_reset_whose_default_keys_another_command_took_asks_first", async () => {
  // Run the current statement lost Ctrl+Enter to Format in a confirmed clash.
  await renderKeymap({}, { keymap: { "query.run": [], "query.format": ["Ctrl+Enter"] } });
  await waitFor(() => expect(rowOf("query.format").textContent).toContain("Ctrl+Enter"));
  await userEvent.click(screen.getByRole("button", { name: "Reset Run the current statement to Ctrl+Enter" }));
  expect(screen.getByRole("alert").textContent).toContain(
    "Reset to Ctrl+Enter? Ctrl+Enter is used by Format. Use it here, and Format has no shortcut?",
  );
  expect(callsTo("save_keymap")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(callsTo("save_keymap")).toHaveLength(0);
  expect(document.activeElement).toBe(changeButton("Run the current statement"));

  await userEvent.click(screen.getByRole("button", { name: "Reset Run the current statement to Ctrl+Enter" }));
  await userEvent.click(screen.getByRole("button", { name: "Use it here" }));
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(1));
  expect(callsTo("save_keymap")[0].overrides).toEqual({ "query.format": [] });
});

test("a_failed_save_shows_by_its_row_and_dismiss_returns_focus", async () => {
  await renderKeymap({
    save_keymap: () => {
      throw { kind: "storage", message: "The data folder is read-only." };
    },
  });
  await userEvent.click(changeButton("Delete diagram"));
  await userEvent.keyboard("{Control>}{Alt>}d{/Alt}{/Control}");
  const alert = await screen.findByRole("alert");
  // Right under the row it was for, not at the top of the page.
  expect(rowOf("flow.delete").nextElementSibling).toBe(alert);
  expect(document.activeElement).toBe(changeButton("Delete diagram"));
  await userEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
  expect(document.activeElement).toBe(changeButton("Delete diagram"));
});

test("the_footnote_names_windows_only_on_windows", async () => {
  const { setPlatformForTests } = await import("../../platform");
  setPlatformForTests("windows");
  try {
    await renderKeymap();
    expect(screen.getByText("Keys Windows keeps for itself, like Alt+F4 and Win+L, cannot be used.")).toBeTruthy();
  } finally {
    setPlatformForTests(null);
  }
});

test("a_reset_that_leaves_the_changed_filter_moves_focus_to_the_next_row_then_the_search", async () => {
  await renderKeymap({}, { keymap: { "query.format": ["Ctrl+Shift+I"], "query.save": ["Ctrl+Alt+S"] } });
  await waitFor(() => expect(rowOf("query.save").textContent).toContain("Changed"));
  await userEvent.click(within(screen.getByRole("radiogroup", { name: "Show" })).getByRole("radio", { name: /^Changed/ }));
  expect(titles()).toEqual(["Format", "Save"]);
  await userEvent.click(screen.getByRole("button", { name: "Reset Format to Shift+Alt+F" }));
  await waitFor(() => expect(titles()).toEqual(["Save"]));
  expect(document.activeElement).toBe(changeButton("Save"));
  await userEvent.click(screen.getByRole("button", { name: "Reset Save to Ctrl+S" }));
  await waitFor(() => expect(titles()).toEqual([]));
  expect(document.activeElement).toBe(search());
});

test("a_save_that_finishes_after_the_user_moved_on_leaves_the_new_capture_alone", async () => {
  let finish: () => void = () => {};
  await renderKeymap({ save_keymap: () => new Promise<void>((ok) => (finish = ok)) });
  await userEvent.click(changeButton("Format"));
  await userEvent.keyboard("{Control>}{Alt>}l{/Alt}{/Control}");
  await waitFor(() => expect(callsTo("save_keymap")).toHaveLength(1));
  // While it saves, the user starts on another row.
  await userEvent.click(changeButton("Save"));
  const capture = screen.getByRole("textbox", { name: "New keys for Save" });
  expect(document.activeElement).toBe(capture);
  await act(async () => finish());
  await waitFor(() => expect(rowOf("query.format").textContent).toContain("Ctrl+Alt+L"));
  expect(screen.getByRole("textbox", { name: "New keys for Save" })).toBe(capture);
  expect(document.activeElement).toBe(capture);
});
