/** Key text: modifiers in the order Ctrl, Shift, Alt, then the key (PR10), such as `Ctrl+Shift+Enter`. */

const MODIFIERS = ["Ctrl", "Shift", "Alt"] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_NAMES: Record<string, Modifier> = { ctrl: "Ctrl", control: "Ctrl", shift: "Shift", alt: "Alt" };

const NAMED = [
  "Enter",
  "Tab",
  "Escape",
  "Space",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];
const NAMED_BY_LOWER = new Map(NAMED.map((n) => [n.toLowerCase(), n]));
NAMED_BY_LOWER.set("esc", "Escape");
NAMED_BY_LOWER.set(" ", "Space");

/** The printed name of one key: letters upper case, named keys in their usual case. */
function keyName(k: string): string {
  const named = NAMED_BY_LOWER.get(k.toLowerCase());
  if (named) return named;
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase();
  if (k.length === 1) return k.toUpperCase();
  return k.charAt(0).toUpperCase() + k.slice(1);
}

export interface ParsedKeys {
  mods: ReadonlySet<Modifier>;
  key: string;
}

/** Splits key text into its modifiers and key; `+` itself may be the key (`Ctrl++`). */
export function parseKeys(s: string): ParsedKeys | null {
  const text = s.trim();
  if (!text) return null;
  const parts = text.endsWith("++") ? [...text.slice(0, -2).split("+"), "+"] : text.split("+");
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) return null;
    const mod = MODIFIER_NAMES[p.toLowerCase()];
    if (mod) mods.add(mod);
    else if (key === null) key = keyName(p);
    else return null;
  }
  if (key === null) return null;
  return { mods, key };
}

function print(mods: ReadonlySet<Modifier>, key: string): string {
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");
}

/** Key text in the printed form: `"shift+ctrl+enter"` gives `"Ctrl+Shift+Enter"`. */
export function normalizeKeys(s: string): string {
  const p = parseKeys(s);
  return p ? print(p.mods, p.key) : s.trim();
}

/**
 * The keys of a key press, or null for a lone modifier. Letters and digits come from the
 * physical key (`e.code`), so Shift and Alt never change which letter it is.
 */
export function keysFromEvent(e: KeyboardEvent): string | null {
  if (e.metaKey) return null;
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"].includes(e.key)) return null;
  const physical = /^Key([A-Z])$/.exec(e.code ?? "") ?? /^Digit(\d)$/.exec(e.code ?? "");
  const raw = physical ? physical[1] : e.key;
  if (!raw || raw === "Unidentified" || raw === "Dead") return null;
  const mods = new Set<Modifier>();
  if (e.ctrlKey) mods.add("Ctrl");
  if (e.shiftKey) mods.add("Shift");
  if (e.altKey) mods.add("Alt");
  return print(mods, keyName(raw));
}

/** CodeMirror's form: `"Ctrl+Shift+Enter"` gives `"Ctrl-Shift-Enter"`, letters lower case (`"Shift-Alt-f"`). */
export function toCodeMirror(keys: string): string {
  const p = parseKeys(keys);
  if (!p) return keys;
  const key = /^[A-Z]$/.test(p.key) ? p.key.toLowerCase() : p.key;
  return [...MODIFIERS.filter((m) => p.mods.has(m)), key].join("-");
}
