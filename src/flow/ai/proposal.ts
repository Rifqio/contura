// The pure parts of reviewing a diagram proposal: each change as a .flow edit and a line, the landing plan, the
// would-break check, which changes follow which, and the texts that tell the user what happened. The Core has
// already checked every change against the outline; nothing here talks to it or to the worker.
import { plural } from "../../format/plural";
import type { DiagramOp, FlowOutline, ProposedChange, ToolOutcome } from "../../api/types";
import { type FlowEditOp, nodeText } from "../../lang/flow/edits";
import { applyFlowSteps } from "../../lang/flow/service";
import { type DiagramKind, defaultArrow, type FlowNodeKind, flowLabel, flowName } from "../../lang/flow/model";
import type { FlowParse } from "../../lang/flow/parse";
import type { TextEdit } from "../../lang/protocol";

/** The one field object of an externally tagged op, with its tag. */
function parts(op: DiagramOp): { tag: string; f: Record<string, string | null | undefined> } {
  const [tag, f] = Object.entries(op)[0];
  return { tag, f: f as Record<string, string | null | undefined> };
}

/** The kind an add with no kind gets: the diagrams that write a leading word or a date need one to write a line. */
const DEFAULT_KIND: Partial<Record<DiagramKind, FlowNodeKind>> = { sequence: "participant", class: "class", mindmap: "topic", timeline: "event" };

function addedKind(kind: string | null | undefined, diagram: DiagramKind | null): FlowNodeKind | null {
  if (kind) return kind as FlowNodeKind;
  return (diagram && DEFAULT_KIND[diagram]) || null;
}

/** The index in `parse.links` of the first link between the ends; `label` given narrows it to that label. */
function findLink(parse: FlowParse, from: string, to: string, label: string | null | undefined, not?: string): number {
  let fallback = -1;
  for (let i = 0; i < parse.links.length; i++) {
    const l = parse.links[i];
    if (l.from !== from || l.to !== to) continue;
    if (label !== undefined && label !== null && l.label !== label) continue;
    if (not === undefined || l.label !== not) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}

/**
 * The edit a change asks for, made against `parse` (the parse of the text it will run on). A line is found by its
 * ends and label in that parse. Null when the change is not Ok or its line is not there.
 */
export function changeEditOp(change: ProposedChange, parse: FlowParse, kind: DiagramKind | null): FlowEditOp | null {
  if (change.status.kind !== "ok") return null;
  const { tag, f } = parts(change.op);
  switch (tag) {
    case "add_node":
      return { op: "addNode", name: f.name as string, kind: addedKind(f.kind, kind), attrs: f.id ? { id: f.id } : {}, group: f.group ?? null };
    case "remove_node":
      return { op: "deleteNode", name: f.target as string };
    case "rename_node":
      return { op: "renameNode", old: f.target as string, next: f.name as string };
    case "add_flow":
      return { op: "addLink", from: f.from as string, to: f.to as string, arrow: defaultArrow(kind), label: f.label ?? undefined };
    case "remove_flow": {
      const index = findLink(parse, f.from as string, f.to as string, f.label);
      return index < 0 ? null : { op: "deleteLink", index };
    }
    case "relabel_flow": {
      // The label given is the new one: prefer a line that does not already carry it.
      const index = findLink(parse, f.from as string, f.to as string, undefined, f.label as string);
      return index < 0 ? null : { op: "setLinkLabel", index, label: f.label as string };
    }
    case "move_to_group":
      return { op: "moveToGroup", name: f.target as string, group: f.group ?? null };
  }
  return null;
}

/** The .flow line a change writes or removes, as the review lists it. A rename, move or removal of a shape lists its name. */
export function changeLine(change: ProposedChange, kind: DiagramKind | null): string {
  const { tag, f } = parts(change.op);
  const link = (from: string, to: string, label: string | null | undefined) => `${flowName(from)} ${defaultArrow(kind)} ${flowName(to)}${label ? `: ${flowLabel(label)}` : ""}`;
  switch (tag) {
    case "add_node":
      return nodeText(f.name as string, addedKind(f.kind, kind), f.id ? { id: f.id } : {}, kind);
    case "remove_node":
    case "move_to_group":
      return flowName(f.target as string);
    case "rename_node":
      return flowName(f.name as string);
    case "add_flow":
    case "remove_flow":
    case "relabel_flow":
      return link(f.from as string, f.to as string, f.label);
  }
  return "";
}

/** `+` add, `-` remove, `~` rename, relabel or move, `!` a change that is not Ok (dropped, or still to pick). */
export function changeMark(change: ProposedChange): "+" | "-" | "~" | "!" {
  if (change.status.kind !== "ok") return "!";
  const { tag } = parts(change.op);
  if (tag.startsWith("add_")) return "+";
  if (tag.startsWith("remove_")) return "-";
  return "~";
}

/**
 * The accepted changes, in index order, as one edit on `text` and the text it gives. Each change is made against
 * the text the ones before it left, so a line found by its index is the right one. Null when nothing is accepted,
 * an accepted change is not Ok, or one does not apply (the whole set is refused).
 */
export function planLanding(
  text: string,
  parse: FlowParse,
  changes: ProposedChange[],
  accepted: ReadonlySet<number>,
  kind: DiagramKind | null,
): { edits: TextEdit[]; text: string } | null {
  const list = changes.filter((c) => accepted.has(c.index)).sort((a, b) => a.index - b.index);
  if (list.length === 0) return null;
  const r = applyFlowSteps(text, parse, list.length, (p, i) => changeEditOp(list[i], p, kind));
  return r.edits.length === 0 || r.text === undefined ? null : { edits: r.edits, text: r.text };
}

/** A message without its numbers, so a line number that moved with an insert is still the same problem. */
const sameProblem = (message: string) => message.replace(/\d+/g, "#");

/** The first error the `before` text did not have, with its line in `afterText`; null when there is none. */
export function wouldBreak(before: FlowParse, after: FlowParse, afterText: string): { line: number; lineText: string; message: string } | null {
  const had = new Map<string, number>();
  for (const p of before.problems) if (p.severity === "error") had.set(sameProblem(p.message), (had.get(sameProblem(p.message)) ?? 0) + 1);
  for (const p of after.problems) {
    if (p.severity !== "error") continue;
    const key = sameProblem(p.message);
    const n = had.get(key) ?? 0;
    if (n > 0) {
      had.set(key, n - 1);
      continue;
    }
    return { line: p.line, lineText: afterText.split(/\r?\n/)[p.line - 1] ?? "", message: p.message };
  }
  return null;
}

/** `index` and every change that needs it, directly or through others; Reject in review takes all of them. */
export function withDependents(changes: ProposedChange[], index: number): Set<number> {
  const out = new Set([index]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of changes) {
      if (!out.has(c.index) && c.dependsOn.some((d) => out.has(d))) {
        out.add(c.index);
        grew = true;
      }
    }
  }
  return out;
}

/** "a", "a and b", "a, b and c". */
function joined(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Up to three shape names, then "and <n> more shapes". */
function shapeNames(names: string[]): string {
  if (names.length <= 3) return joined(names);
  return `${names.slice(0, 3).join(", ")} and ${plural(names.length - 3, "more shape", "more shapes")}`;
}

/** What the assistant says after the accepted changes landed. */
export function landedSummary(changes: ProposedChange[], accepted: ReadonlySet<number>): string {
  const added: string[] = [];
  const removed: string[] = [];
  let addedLines = 0;
  let removedLines = 0;
  let renamed = 0;
  let moved = 0;
  let relabelled = 0;
  for (const c of changes) {
    if (!accepted.has(c.index) || c.status.kind !== "ok") continue;
    const { tag, f } = parts(c.op);
    if (tag === "add_node") added.push(f.name as string);
    else if (tag === "remove_node") removed.push(f.target as string);
    else if (tag === "add_flow") addedLines++;
    else if (tag === "remove_flow") removedLines++;
    else if (tag === "rename_node") renamed++;
    else if (tag === "move_to_group") moved++;
    else if (tag === "relabel_flow") relabelled++;
  }
  const side = (names: string[], lines: number) => {
    const items: string[] = [];
    if (names.length) items.push(shapeNames(names));
    if (lines) items.push(plural(lines, "line", "lines"));
    return items.join(" and ");
  };
  const clauses: string[] = [];
  if (added.length || addedLines) clauses.push(`added ${side(added, addedLines)}`);
  if (removed.length || removedLines) clauses.push(`removed ${side(removed, removedLines)}`);
  if (renamed) clauses.push(`renamed ${plural(renamed, "shape", "shapes")}`);
  if (moved) clauses.push(`moved ${plural(moved, "shape", "shapes")}`);
  if (relabelled) clauses.push(`relabelled ${plural(relabelled, "line", "lines")}`);
  if (clauses.length === 0) return "Done. Nothing changed.";
  const marked = clauses.some((c) => !c.startsWith("removed"));
  return `Done. I ${joined(clauses)}, as one undo step.${marked ? " The new parts are ringed on the canvas for a moment." : ""}`;
}

/**
 * What the accepted changes remove, for the confirm: the shapes, the lines (removed directly and those attached to
 * a removed shape, each once) and the removed shapes that have a table.
 */
export function removalCount(changes: ProposedChange[], accepted: ReadonlySet<number>, outline: FlowOutline): { shapes: string[]; lines: number; tables: string[] } {
  const shapes: string[] = [];
  const hit = new Set<number>();
  let unmatched = 0;
  for (const c of changes) {
    if (!accepted.has(c.index) || c.status.kind !== "ok") continue;
    const { tag, f } = parts(c.op);
    if (tag === "remove_node") shapes.push(f.target as string);
    else if (tag === "remove_flow") {
      const i = outline.links.findIndex((l, k) => !hit.has(k) && l.from === f.from && l.to === f.to && (f.label == null || l.label === f.label));
      if (i < 0) unmatched++;
      else hit.add(i);
    }
  }
  const gone = new Set(shapes);
  outline.links.forEach((l, k) => {
    if (gone.has(l.from) || gone.has(l.to)) hit.add(k);
  });
  const tables = shapes.filter((s) => outline.nodes.some((n) => n.name === s && n.table));
  return { shapes, lines: hit.size + unmatched, tables };
}

/** What a saved outcome says under a reloaded card: the landed summary of an Auto-apply, else "Accepted <k> of <n>." */
/**
 * An earlier proposal in one line: what became of it (applied, rejected, partly applied) or that it was not reviewed,
 * with its changes counted as the card's title counts them.
 */
export function foldedOutcome(changes: ProposedChange[], outcome: ToolOutcome | null): string {
  const ok = changes.filter((c) => c.status.kind === "ok").length;
  const title = ok === changes.length ? plural(changes.length, "change", "changes") : `${ok.toLocaleString("en-US")} of ${plural(changes.length, "change", "changes")}`;
  if (!outcome) return `Not reviewed: ${title}.`;
  if (outcome.accepted === 0) return `Rejected: ${title}.`;
  const decided = outcome.accepted + outcome.rejected;
  if (outcome.accepted >= decided) return `Applied: ${title}.`;
  return `Partly applied: ${outcome.accepted.toLocaleString("en-US")} of ${plural(decided, "change", "changes")}.`;
}

export function outcomeText(changes: ProposedChange[], outcome: ToolOutcome): string {
  if (outcome.auto && outcome.accepted > 0) return landedSummary(changes, new Set(changes.filter((c) => c.status.kind === "ok").map((c) => c.index)));
  return `Accepted ${outcome.accepted.toLocaleString("en-US")} of ${(outcome.accepted + outcome.rejected).toLocaleString("en-US")}.`;
}
