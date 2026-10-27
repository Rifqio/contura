import { isCommandError, writeDiagram } from "../api/client";
import { freeDiagramName } from "./diagramKinds";

/**
 * Writes a new diagram under `base` made free against `taken` (VS Code's Untitled-N), and returns the name it took. A
 * name taken since the list was read is answered by the Core's `diagramExists`: the next free name, once.
 */
export async function writeFreeDiagram(base: string, taken: readonly string[], text: (name: string) => string, layout: string): Promise<string> {
  let name = freeDiagramName(base, taken);
  for (let attempt = 0; ; attempt++) {
    try {
      await writeDiagram(name, text(name), layout, false);
      return name;
    } catch (e) {
      if (attempt === 0 && isCommandError(e) && e.kind === "diagramExists") {
        name = freeDiagramName(base, [...taken, name]);
        continue;
      }
      throw e;
    }
  }
}
