// Query tab drafts, kept per place (a Group, or Ungrouped) so they come back after a restart.
import type { Place } from "../shell/tabs";
import type { QueryTabDoc } from "./QueryTab";

export function placeKey(place: Place): string {
  if (place.kind === "group") return `group:${place.groupId}`;
  return place.kind;
}

export function serializeDrafts(docs: QueryTabDoc[]): string {
  return JSON.stringify({ version: 1, tabs: docs });
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
