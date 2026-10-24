import { afterEach, expect, test, vi } from "vitest";
import { RECENT_COMMANDS_LIMIT, readRecentCommands, rememberCommand } from "./recentCommands";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test("the_last_run_command_comes_first_once", () => {
  rememberCommand("query.new");
  rememberCommand("tab.close");
  rememberCommand("query.new");
  expect(readRecentCommands()).toEqual(["query.new", "tab.close"]);
});

test("the_list_is_bounded_and_survives_a_restart", () => {
  const ids = ["query.new", "tab.close", "tab.next", "tab.previous", "tab.reopen", "pane.next", "pane.previous", "home.open", "settings.open", "tree.filter", "tree.refresh", "flow.new"] as const;
  for (const id of ids) rememberCommand(id);
  expect(RECENT_COMMANDS_LIMIT).toBe(10);
  const kept = readRecentCommands();
  expect(kept).toHaveLength(10);
  expect(kept[0]).toBe("flow.new");
});

test("unknown_or_unreadable_entries_are_dropped", () => {
  localStorage.setItem("contura.palette.recentCommands", JSON.stringify(["query.new", "gone.command", 5]));
  expect(readRecentCommands()).toEqual(["query.new"]);
  localStorage.setItem("contura.palette.recentCommands", "{not json");
  expect(readRecentCommands()).toEqual([]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(readRecentCommands()).toEqual([]);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => rememberCommand("query.new")).not.toThrow();
});
