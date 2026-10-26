// Diagram step 11 (board DiagramColourLabels, ADR 0019; eraser.io names unique, labels repeat; Mermaid id[label]):
// what an edit of the words a shape shows writes. Names stay unique; a shape whose typed words are another shape's
// name keeps them as its `label:` under the next free name. The rules:
// - Words that are free as a name become its name; a label it had goes. Lines that named it follow, in one edit list.
// - Taken words on a labelled shape change only its label; no line moves.
// - Taken words on a plain shape: the next free name (`Retry 2`) plus `label: Retry`.
// Another shape's line is never rewritten to tidy it.
import type { FlowEditOp } from "../lang/flow/edits";
import { ATTR_DIAGRAMS, type DiagramKind, type FlowNode, type FlowNodeKind, isStateMarker, shownName } from "../lang/flow/model";
import { said } from "./editWords";

/**
 * Whether a shape can show a label: the kinds whose shapes are written `Name [..]` (flowchart, data flow, state, cloud
 * and mind map topics). Notes, the central idea and `[*]` markers keep the refusal, as do participants (their head
 * shows the name), classes and timeline items.
 */
export function takesLabel(diagram: DiagramKind | null, kind: FlowNodeKind | null | undefined, name?: string): boolean {
  if (!diagram || diagram === "sequence" || !ATTR_DIAGRAMS.has(diagram)) return false;
  if (kind === "note" || kind === "root") return false;
  return !(name !== undefined && isStateMarker(name));
}

/** The next free name for `words`: `Retry 2`, `Retry 3`, as adds do; `own` (the shape's own name) counts as free. */
export function freeName(words: string, taken: ReadonlySet<string>, own?: string): string {
  for (let k = 2; ; k++) {
    const name = `${words} ${k}`;
    if (name === own || !taken.has(name)) return name;
  }
}

/** What the strip says when typed words are taken and the shape keeps them as its label. */
export function labelNotice(words: string, name: string, who: "this one" | "the new one"): string {
  return `${said(words)} is already a shape's name, so ${who} is written ${said(name)} [label: ${said(words)}]: it shows ${said(words)}, and lines name it ${said(name)}. One undo step.`;
}

export type WordsPlan = {
  /** The edit list, run as one batch (one undo step); empty when nothing changes. */
  ops: FlowEditOp[];
  /** The shape's name after it. */
  name: string;
  /** What the strip says, or null for a plain rename. */
  notice: string | null;
};

/**
 * The edits that make shape `n` show `words`, by the rules above. `taken` holds every node and group name. Null when
 * the words are another shape's name and this shape takes no label (the caller refuses with "is already used").
 */
export function planWords(diagram: DiagramKind | null, n: FlowNode, words: string, taken: ReadonlySet<string>): WordsPlan | null {
  const labelled = n.attrs.label !== undefined;
  if (words === n.name || !taken.has(words)) {
    const ops: FlowEditOp[] = [];
    if (words !== n.name) ops.push({ op: "renameNode", old: n.name, next: words });
    if (labelled) ops.push({ op: "setAttr", name: words, key: "label", value: null });
    const notice = labelled
      ? `Renamed ${said(shownName(n))} to ${said(words)}. The name is free, so the label goes and the line is plain again; lines that named ${said(n.name)} follow, in the same undo step.`
      : null;
    return { ops, name: words, notice };
  }
  if (!takesLabel(diagram, n.kind, n.name)) return null;
  if (labelled) {
    return {
      ops: [{ op: "setAttr", name: n.name, key: "label", value: words }],
      name: n.name,
      notice: `Changed the words to ${said(words)}. Its name stays ${said(n.name)}, so the lines that name it do not change. One undo step.`,
    };
  }
  const name = freeName(words, taken, n.name);
  const ops: FlowEditOp[] = name === n.name ? [] : [{ op: "renameNode", old: n.name, next: name }];
  ops.push({ op: "setAttr", name, key: "label", value: words });
  return { ops, name, notice: labelNotice(words, name, "this one") };
}
