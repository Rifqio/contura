/** One command of the Ask composer. `name` has no slash ("compact"). */
export interface SlashCommand {
  name: string;
  label: string;
  hint: string;
}

/** The commands, in the order the list shows them (board 11.8). */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "compact", label: "Compact now", hint: "Turn older messages into a summary now" },
  { name: "new", label: "New chat", hint: "Start a new chat in this place" },
  { name: "history", label: "Show history", hint: "Show earlier chats and search them" },
  { name: "model", label: "Model", hint: "Pick the model, thinking level and caching" },
  { name: "sends", label: "Sends", hint: "What the next Ask sends" },
  { name: "log", label: "Show log", hint: "Show the answer log of the last answer" },
  { name: "clear", label: "Delete this chat", hint: "Delete this chat" },
];

/**
 * The commands a draft is asking for: null unless it starts with `/` and holds no whitespace once a trailing space is dropped (then it is a
 * question), else the commands whose name starts with the text after the slash, in table order.
 */
export function matchSlash(draft: string): SlashCommand[] | null {
  const text = draft.trimEnd();
  if (!text.startsWith("/") || /\s/.test(text)) return null;
  const typed = text.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(typed));
}

/** What a key does to the open list: move the active row (wrapping), run it, or close the list. */
export type SlashKey = { active: number } | "run" | "close" | null;

export function slashKey(key: string, active: number, count: number): SlashKey {
  if (key === "Escape") return "close";
  if (count === 0) return null;
  if (key === "ArrowDown") return { active: (active + 1) % count };
  if (key === "ArrowUp") return { active: (active - 1 + count) % count };
  if (key === "Enter") return "run";
  return null;
}
