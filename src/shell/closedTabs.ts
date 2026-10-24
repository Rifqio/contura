// Reopen closed tab (S2, Edge's Ctrl+Shift+T): what a closed tab is remembered by, and the bounded stack of them.
import type { ConnectionId, ObjectPath } from "../api/types";
import type { QueryTabDoc } from "../query/QueryTab";
import { type AnyTab, type Selection, type VisualTabDoc, tabKey } from "./tabs";

/** How many closed tabs are kept; the oldest goes first (memory is a requirement, so the stack is bounded). */
export const CLOSED_LIMIT = 20;

/** The most query text one closed tab keeps; a longer one comes back empty with a note. */
export const CLOSED_TEXT_LIMIT = 256 * 1024;
/** The most text the whole stack keeps; the oldest tabs go first. */
export const CLOSED_BUDGET = 1024 * 1024;

/** A closed tab, by the object it showed: a table is read again on reopening, a query keeps its text, a diagram its file. */
export type ClosedTab =
  | { kind: "object"; selection: Selection }
  /** `tooLarge`: its text was over the limit and is not kept, so it reopens empty (with a note). */
  | { kind: "query"; doc: QueryTabDoc; tooLarge?: true }
  | { kind: "visual"; doc: VisualTabDoc }
  | { kind: "flow"; name: string }
  | { kind: "design"; connectionId: ConnectionId; path: ObjectPath }
  | { kind: "lineage"; connectionId: ConnectionId; path: ObjectPath }
  | { kind: "savedQueries" };

/** What a closed tab is remembered by, or null for a tab with nothing to come back to (Home, Settings, a New table, jobs). */
export function closedTabOf(t: AnyTab): ClosedTab | null {
  switch (t.kind) {
    case "object":
      return { kind: "object", selection: t.selection };
    case "query": {
      const { text, savedText } = t.doc;
      return text.length > CLOSED_TEXT_LIMIT || (savedText?.length ?? 0) > CLOSED_TEXT_LIMIT
        ? { kind: "query", doc: { ...t.doc, text: "", savedText: null }, tooLarge: true }
        : { kind: "query", doc: t.doc };
    }
    case "visual":
      return { kind: "visual", doc: t.doc };
    case "flow":
      return { kind: "flow", name: t.name };
    case "design":
      return t.target.kind === "alter" ? { kind: "design", connectionId: t.connectionId, path: t.target.path } : null;
    case "lineage":
      return { kind: "lineage", connectionId: t.connectionId, path: t.path };
    case "savedQueries":
      return { kind: "savedQueries" };
    default:
      return null;
  }
}

/** The tab's own key once reopened; two closes of one object keep one entry. */
function identity(c: ClosedTab): string {
  switch (c.kind) {
    case "object":
      return `object\u0000${c.selection.connectionId}\u0000${c.selection.kind}\u0000${JSON.stringify(c.selection.path)}`;
    case "query":
    case "visual":
      return tabKey(c);
    case "flow":
      return `flow:${c.name.toLowerCase()}`;
    case "design":
    case "lineage":
      return `${c.kind}\u0000${c.connectionId}\u0000${JSON.stringify(c.path)}`;
    case "savedQueries":
      return "savedQueries";
  }
}

/** The text a closed tab holds in memory. */
function weight(c: ClosedTab): number {
  if (c.kind === "query") return c.doc.text.length + (c.doc.savedText?.length ?? 0);
  if (c.kind === "visual") return c.doc.savedJson?.length ?? 0;
  return 0;
}

/** The stack with `c` on top, the same object once, at most CLOSED_LIMIT long and CLOSED_BUDGET of text; the oldest go first. */
export function rememberClosed(stack: ClosedTab[], c: ClosedTab): ClosedTab[] {
  const id = identity(c);
  const next = [...stack.filter((x) => identity(x) !== id), c];
  let from = Math.max(0, next.length - CLOSED_LIMIT);
  let total = next.slice(from).reduce((n, x) => n + weight(x), 0);
  while (total > CLOSED_BUDGET && from < next.length - 1) total -= weight(next[from++]);
  return from > 0 ? next.slice(from) : next;
}

/**
 * Takes closed tabs from the top until one can be opened. `check` answers why a tab cannot come back (its object
 * is gone), or null when it can; each such reason is returned in `skipped` for a short note.
 */
export async function reopenFrom(
  stack: ClosedTab[],
  check: (c: ClosedTab) => Promise<string | null>,
): Promise<{ stack: ClosedTab[]; opened: ClosedTab | null; skipped: string[] }> {
  const rest = [...stack];
  const skipped: string[] = [];
  while (rest.length > 0) {
    const c = rest.pop()!;
    const why = await check(c);
    if (why === null) return { stack: rest, opened: c, skipped };
    skipped.push(why);
  }
  return { stack: rest, opened: null, skipped };
}

/** The name a closed tab had on the strip. */
export function closedLabel(c: ClosedTab): string {
  switch (c.kind) {
    case "object":
      return c.selection.path.name;
    case "query":
    case "visual":
      return c.doc.name;
    case "flow":
      return `${c.name}.flow`;
    case "design":
      return `${c.path.name} design`;
    case "lineage":
      return `${c.path.name} lineage`;
    case "savedQueries":
      return "Saved Queries";
  }
}

/** A query or Visual Query tab whose Connection was removed since it closed comes back without one (text kept), with a note. */
export function withoutGoneConnection(c: ClosedTab, connectionIds: ReadonlySet<ConnectionId>): { closed: ClosedTab; note: string | null } {
  if ((c.kind !== "query" && c.kind !== "visual") || c.doc.connectionId === null || connectionIds.has(c.doc.connectionId)) return { closed: c, note: null };
  return {
    closed: { ...c, doc: { ...c.doc, connectionId: null } } as ClosedTab,
    note: `${c.doc.name} was on a Connection that is gone, so it opens without one.`,
  };
}
