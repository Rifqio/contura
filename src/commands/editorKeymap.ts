import { type Extension, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { toCodeMirror } from "./keys";
import type { Keymap } from "./keymap";
import type { CommandId } from "./registry";

/** What an editor needs from the registry: the keys, and a way to run a command. */
export interface EditorCommands {
  map: Keymap;
  /** True when the command ran, which keeps the key from the editor's own bindings. */
  run(id: CommandId): boolean;
}

/**
 * Every command's keys, app ones too, above the editor's defaults (PR11), so a confirmed
 * override such as Ctrl+Z wins over Undo.
 */
export function editorCommandKeymap(map: Keymap, run: (id: CommandId) => boolean): Extension {
  const bindings = [...map].flatMap(([id, keys]) => keys.map((k) => ({ key: toCodeMirror(k), run: () => run(id) })));
  return Prec.high(keymap.of(bindings));
}
