// I1: what a script handed to the user (the clipboard, a file, an editor) starts and ends with. The Core sends the
// frame with each plan (`ddl::script_frame`): on MySQL the sql_mode Backup sets, so the script runs as Contura wrote it
// whatever the session it runs in; empty elsewhere. This lays it out as the Core's `framed_script` does.
import type { ScriptFrame } from "./types";

export function framedScript(frame: ScriptFrame | null | undefined, body: string): string {
  if (!body || !frame || (frame.header.length === 0 && frame.footer.length === 0)) return body;
  return `${frame.header.join("\n")}\n\n${body.trimEnd()}\n\n${frame.footer.join("\n")}\n`;
}
