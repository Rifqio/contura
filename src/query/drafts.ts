// Query tab drafts, kept per place (a Group, or Ungrouped) so they come back after a restart.
import type { Place, VisualTabDoc } from "../shell/tabs";
import type { QueryTabDoc } from "./QueryTab";

export function placeKey(place: Place): string {
  if (place.kind === "group") return `group:${place.groupId}`;
  return place.kind;
}

/**
 * The place's drafts. Visual Query tabs go under their own `visual` key, so the file stays
 * `version: 1` and a build from before step 6 reads its query tabs and ignores the rest.
 */
export function serializeDrafts(
  docs: QueryTabDoc[],
  visual: VisualTabDoc[] = [],
  extra: {
    /** The tabs' keys in strip order, so query and Visual Query tabs come back in place. */
    order?: string[];
    /** Visual drafts this build cannot open (a newer model version), written back untouched. */
    kept?: unknown[];
  } = {},
): string {
  const order = extra.order && visual.length > 0 ? { order: extra.order } : {};
  return JSON.stringify({ version: 1, tabs: docs, visual: [...visual, ...(extra.kept ?? [])], ...order });
}

/** The strip order written with the drafts; empty when none (never throws). */
export function parseDraftOrder(json: string): string[] {
  try {
    const raw = JSON.parse(json) as { order?: unknown };
    return Array.isArray(raw?.order) ? raw.order.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

const str = (v: unknown) => typeof v === "string";
const strOrNull = (v: unknown) => v === null || typeof v === "string";

function isDoc(v: unknown): v is QueryTabDoc {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    str(d.id) &&
    str(d.name) &&
    str(d.text) &&
    strOrNull(d.connectionId) &&
    strOrNull(d.database) &&
    strOrNull(d.savedId) &&
    strOrNull(d.savedText)
  );
}

/** Never throws: anything unreadable gives no drafts. */
export function parseDrafts(json: string): QueryTabDoc[] {
  try {
    const raw = JSON.parse(json) as { version?: unknown; tabs?: unknown };
    if (raw?.version !== 1 || !Array.isArray(raw.tabs)) return [];
    return raw.tabs.filter(isDoc).map((d) => ({
      id: d.id,
      name: d.name,
      text: d.text,
      connectionId: d.connectionId,
      database: d.database,
      savedId: d.savedId,
      savedText: d.savedText,
    }));
  } catch {
    return [];
  }
}

/** "Query N", one past the highest N among the open tabs. */
export function nextQueryName(names: string[]): string {
  const used = names.map((n) => /^Query (\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number);
  return `Query ${used.length ? Math.max(...used) + 1 : 1}`;
}
