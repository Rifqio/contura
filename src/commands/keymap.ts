import type { KeymapOverrides } from "../api/types";
import { normalizeKeys, parseKeys } from "./keys";
import { COMMANDS, type CommandId, commandById } from "./registry";

export type Keymap = ReadonlyMap<CommandId, string[]>;

/** Editor keys a shortcut may take only once you confirm (PR11). */
export const EDITOR_RESERVED: readonly { keys: string; title: string }[] = [
  { keys: "Ctrl+Z", title: "Undo" },
  { keys: "Ctrl+Y", title: "Redo" },
  { keys: "Ctrl+Shift+Z", title: "Redo" },
  { keys: "Ctrl+A", title: "Select all" },
  { keys: "Ctrl+C", title: "Copy" },
  { keys: "Ctrl+X", title: "Cut" },
  { keys: "Ctrl+V", title: "Paste" },
  { keys: "Ctrl+/", title: "Toggle comment" },
  { keys: "Ctrl+]", title: "Indent" },
  { keys: "Ctrl+[", title: "Outdent" },
  { keys: "Alt+ArrowUp", title: "Move line up" },
  { keys: "Alt+ArrowDown", title: "Move line down" },
  { keys: "Shift+Alt+ArrowUp", title: "Copy line up" },
  { keys: "Shift+Alt+ArrowDown", title: "Copy line down" },
  { keys: "Ctrl+Shift+K", title: "Delete line" },
];

/** Every command's keys: its override when there is one (an empty list unbinds it), else its defaults. */
export function resolveKeymap(o: KeymapOverrides): Keymap {
  const map = new Map<CommandId, string[]>();
  for (const c of COMMANDS) {
    const over = Object.prototype.hasOwnProperty.call(o, c.id) ? o[c.id] : undefined;
    const keys = Array.isArray(over) ? over.filter((k): k is string => typeof k === "string").map(normalizeKeys) : c.keys;
    map.set(c.id, [...new Set(keys)]);
  }
  return map;
}

export function keysFor(map: Keymap, id: CommandId): string[] {
  return map.get(id) ?? [];
}

/** A tooltip or sentence part: "Save query (Ctrl+S)", or just the label when the command has no key. */
export function withHint(label: string, key: string | null): string {
  return key ? `${label} (${key})` : label;
}

/** The key shown beside a command: its first, or null when it has none. */
export function hintFor(map: Keymap, id: CommandId): string | null {
  return keysFor(map, id)[0] ?? null;
}

export type Clash = { kind: "command"; id: CommandId; title: string } | { kind: "editor"; title: string };

/** What else already uses `keys`: another command first, then an editor key. */
export function findClash(map: Keymap, id: CommandId, keys: string): Clash | null {
  const k = normalizeKeys(keys);
  for (const [other, ks] of map) {
    if (other !== id && ks.includes(k)) return { kind: "command", id: other, title: commandById(other)!.title };
  }
  const reserved = EDITOR_RESERVED.find((r) => r.keys === k);
  return reserved ? { kind: "editor", title: reserved.title } : null;
}

const NEED_MODIFIER = "Choose keys with Ctrl, Alt or Shift, or a function key.";

/** Why `keys` cannot be a shortcut, or null when it can (PR11). */
export function keyProblem(keys: string): string | null {
  const p = parseKeys(keys);
  if (!p) return NEED_MODIFIER;
  const ctrlOrAlt = p.mods.has("Ctrl") || p.mods.has("Alt");
  // Tab and Escape move focus and close things; with only Shift they still do.
  if ((p.key === "Tab" || p.key === "Escape") && !ctrlOrAlt) return "Tab and Escape cannot be shortcuts.";
  if (/^F([1-9]|1[0-2])$/.test(p.key)) return null;
  if (!ctrlOrAlt && !p.mods.has("Shift")) return NEED_MODIFIER;
  // Shift with a character is just typing it.
  if (!ctrlOrAlt && (p.key.length === 1 || p.key === "Space")) return NEED_MODIFIER;
  return null;
}

/** Binds `keys` to `id` alone, moving them off any command that had them (confirming a clash, PR11). */
export function applyRebind(o: KeymapOverrides, map: Keymap, id: CommandId, keys: string): KeymapOverrides {
  const k = normalizeKeys(keys);
  const next: KeymapOverrides = { ...o, [id]: [k] };
  for (const [other, ks] of map) {
    if (other !== id && ks.includes(k)) next[other] = ks.filter((x) => x !== k);
  }
  return next;
}

/** Back to the command's default keys. */
export function resetCommand(o: KeymapOverrides, id: CommandId): KeymapOverrides {
  const next = { ...o };
  delete next[id];
  return next;
}
