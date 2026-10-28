import { expect, test } from "vitest";
import { matchSlash, SLASH_COMMANDS, slashKey } from "./slash";

const names = (d: string) => matchSlash(d)?.map((c) => c.name);

test("match_rules", () => {
  expect(names("/")).toEqual(["compact", "new", "history", "model", "sends", "log", "clear"]);
  expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(names("/"));
  expect(names("/c")).toEqual(["compact", "clear"]);
  expect(names("/CO")).toEqual(["compact"]);
  expect(names("/xyz")).toEqual([]);
  expect(matchSlash("hello")).toBeNull();
  expect(matchSlash("/compact now")).toBeNull();
  expect(matchSlash(" /new")).toBeNull();
  expect(matchSlash("/new\n")).toEqual([SLASH_COMMANDS[1]]);
  expect(names("/compact ")).toEqual(["compact"]);
  expect(names("/ ")).toEqual(names("/"));
  expect(matchSlash("/compact the rest")).toBeNull();
});

test("keys_move_wrap_run_close", () => {
  expect(slashKey("ArrowDown", 6, 7)).toEqual({ active: 0 });
  expect(slashKey("ArrowUp", 0, 7)).toEqual({ active: 6 });
  expect(slashKey("Enter", 2, 7)).toBe("run");
  expect(slashKey("Escape", 2, 7)).toBe("close");
  expect(slashKey("Enter", 0, 0)).toBeNull();
  expect(slashKey("a", 0, 3)).toBeNull();
});

test("clear_reads_delete_this_chat", () => {
  // The name stays /clear; it deletes the open chat, as Delete on its history row does (P29).
  const clear = SLASH_COMMANDS.find((c) => c.name === "clear");
  expect(clear).toEqual({ name: "clear", label: "Delete this chat", hint: "Delete this chat" });
});
