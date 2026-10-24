import { type CommandId, commandById } from "../commands/registry";

/** The Command Palette lists this many recently used commands first (VS Code keeps a short list too). */
export const RECENT_COMMANDS_LIMIT = 10;

/** Kept in localStorage, as the app's other small per-user choices (the feature bar labels, the editor split). */
const KEY = "contura.palette.recentCommands";

/** The commands run from the palette, newest first; empty when nothing is stored or storage is blocked. */
export function readRecentCommands(): CommandId[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is CommandId => typeof id === "string" && !!commandById(id)).slice(0, RECENT_COMMANDS_LIMIT);
  } catch {
    return [];
  }
}

/** Puts `id` first; the oldest falls off past the limit. */
export function rememberCommand(id: CommandId): void {
  const next = [id, ...readRecentCommands().filter((x) => x !== id)].slice(0, RECENT_COMMANDS_LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage is blocked: the palette still runs, without the order.
  }
}
