// Diagram step 10: whether a text starts a Mermaid diagram Contura reads, and which. Small on purpose: the text editor
// and the canvas ask it on every paste, while the converters themselves run in the language worker.
import type { DiagramKind } from "../lang/flow/model";

const unquote = (s: string) => {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};

/** ER diagrams are the Schema Builder's (user decision, 25 Oct): DBML is Contura's only ERD. */
export const ER_REFUSED = "ER diagrams live in the Schema Builder. Open the Schema Builder to model tables.";

/** The first word of each Mermaid kind that comes in, and the Contura kind it becomes. */
export const MERMAID_KINDS: Record<string, DiagramKind> = {
  flowchart: "flow",
  "flowchart-elk": "flow",
  graph: "flow",
  sequenceDiagram: "sequence",
  stateDiagram: "state",
  "stateDiagram-v2": "state",
  classDiagram: "class",
  "classDiagram-v2": "class",
  mindmap: "mindmap",
  timeline: "timeline",
};


/** The first line that is neither blank nor a comment, after any front matter, and its number. */
export function headOf(lines: string[]): { at: number; head: string; title: string | null } {
  let at = 0;
  let title: string | null = null;
  const skip = () => {
    while (at < lines.length) {
      const t = lines[at].trim();
      // A %%{ }%% directive may run over several lines (fix round 1, M2).
      if (t.startsWith("%%{") && !t.includes("}%%")) {
        while (at < lines.length && !lines[at].includes("}%%")) at++;
        at++;
        continue;
      }
      if (t && !t.startsWith("%%")) return;
      at++;
    }
  };
  skip();
  if (lines[at]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > at && l.trim() === "---");
    if (close > 0) {
      for (const l of lines.slice(at + 1, close)) {
        const t = /^\s*title:\s*(.*)$/.exec(l);
        if (t && unquote(t[1])) title = unquote(t[1]);
      }
      at = close + 1;
      skip();
    }
  }
  return { at, head: lines[at]?.trim() ?? "", title };
}

/** The Mermaid kind word a header line starts with, when Contura reads it (or refuses it by name: erDiagram). */
export function kindWord(head: string): string | null {
  const w = /^([A-Za-z]+(?:-v2|-elk)?)\b/.exec(head)?.[1] ?? "";
  if (w === "erDiagram") return w;
  if (!(w in MERMAID_KINDS)) return null;
  // `graph` and `flowchart` take a direction or nothing after them; any other word is plain text.
  if ((w === "graph" || w === "flowchart") && !/^(graph|flowchart)(-elk)?(\s+(TD|TB|LR|RL|BT)\b.*|\s*;.*|\s*)$/i.test(head)) return null;
  if (w !== "graph" && w !== "flowchart" && w !== "flowchart-elk" && head !== w && !/^\S+\s*$/.test(head)) return null;
  return w;
}

/** True when `text` starts a Mermaid diagram (step 10: a paste of it is translated); erDiagram counts, to be refused. */
export function isMermaid(text: string): boolean {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/, 400);
  const { at, head } = headOf(lines);
  if (kindWord(head) === null) return false;
  // A kind word alone is a word, not a diagram (fix round 1, M1): a body line, or a statement after `graph TD;`.
  if (/;\s*\S/.test(head)) return true;
  return lines.slice(at + 1).some((l) => l.trim() !== "" && !l.trim().startsWith("%%"));
}

