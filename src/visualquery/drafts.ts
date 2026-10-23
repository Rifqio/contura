// Visual Query tab drafts: the `visual` key of the place's drafts file (src/query/drafts.ts).
import type { VisualQuery } from "../api/types";
import type { VisualTabDoc } from "../shell/tabs";

const str = (v: unknown) => typeof v === "string";
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A model this build can open: version 1 with the lists and settings the Core reads. */
function isModel(v: unknown): v is VisualQuery {
  if (!isObject(v) || v.version !== 1) return false;
  const lists = [v.tables, v.joins, v.columns, v.filters, v.orderBy].every(Array.isArray);
  return lists && strOrNull(v.database) && isObject(v.groupBy) && (v.limit === null || typeof v.limit === "number") && typeof v.distinct === "boolean";
}

/** Dragged card widths or heights, when the draft has any that are numbers. */
function widthsOf(v: unknown): Record<string, number> | undefined {
  if (!isObject(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, w] of Object.entries(v)) if (typeof w === "number" && Number.isFinite(w)) out[k] = w;
  return Object.keys(out).length > 0 ? out : undefined;
}

function isDoc(v: unknown): v is VisualTabDoc {
  if (!isObject(v)) return false;
  return (
    str(v.id) &&
    str(v.name) &&
    strOrNull(v.connectionId) &&
    strOrNull(v.database) &&
    strOrNull(v.savedId) &&
    strOrNull(v.savedJson) &&
    isModel(v.model)
  );
}

/** Never throws: a file from before step 6, or an entry this build cannot read (another model version), gives none. */
export function parseVisualDrafts(json: string): VisualTabDoc[] {
  try {
    const raw = JSON.parse(json) as { version?: unknown; visual?: unknown };
    if (raw?.version !== 1 || !Array.isArray(raw.visual)) return [];
    return raw.visual.filter(isDoc).map((d) => ({
      id: d.id,
      name: d.name,
      connectionId: d.connectionId,
      database: d.database,
      model: d.model,
      savedId: d.savedId,
      savedJson: d.savedJson,
      ...(widthsOf(d.widths) ? { widths: widthsOf(d.widths) } : {}),
      ...(widthsOf(d.heights) ? { heights: widthsOf(d.heights) } : {}),
    }));
  } catch {
    return [];
  }
}

/**
 * Visual drafts this build cannot open: a model of another version (a newer Contura). They are kept
 * and written back with the next save, so a downgrade never loses them (never throws).
 */
export function keptVisualDrafts(json: string): unknown[] {
  try {
    const raw = JSON.parse(json) as { version?: unknown; visual?: unknown };
    if (raw?.version !== 1 || !Array.isArray(raw.visual)) return [];
    return raw.visual.filter(
      (v) => isObject(v) && str(v.id) && isObject(v.model) && typeof v.model.version === "number" && v.model.version !== 1,
    );
  } catch {
    return [];
  }
}

/**
 * A Saved Visual Query's model. The version is read first, so a model from a newer Contura is
 * refused before its shape is judged (its new fields would read as broken). Never throws.
 */
export function savedVisualModel(json: string): { kind: "model"; model: VisualQuery } | { kind: "newer" } | { kind: "unreadable" } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { kind: "unreadable" };
  }
  if (!isObject(raw)) return { kind: "unreadable" };
  if (typeof raw.version === "number" && raw.version > 1) return { kind: "newer" };
  return isModel(raw) ? { kind: "model", model: raw } : { kind: "unreadable" };
}

/** A new tab's name until it is saved. */
export const NEW_VISUAL_NAME = "New Visual Query";
