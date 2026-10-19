// Lineage's Views source: views whose definition names the table. This is a name match on catalog
// text (each view's definition), not a read of the database's own dependency records, and the UI
// says so ("names", not "reads"). Never rows.
import { listObjects, listSchemas, objectDefinition } from "../api/client";
import type { ConnectionId, ObjectPath } from "../api/types";

/** At most this many view definitions are read for one lineage. */
export const MAX_VIEWS = 200;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const same = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** The identifier just before a trailing `.`: `shop` in `FROM shop.`, `shop` in `"kestrel"."shop".`. */
const QUALIFIER = /(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w$]+))\s*\.\s*$/;

/**
 * True when `sql`, the definition of a view in `viewSchema`, names `table`: bare or quoted, and
 * qualified by the table's schema (or database) or, from a view in the same schema, not qualified.
 * A name qualified by another schema is another table.
 */
export function namesTable(sql: string, table: ObjectPath, viewSchema: string | null): boolean {
  const name = escape(table.name);
  const re = new RegExp(`(?<![\\w$])(?:"${name}"|\`${name}\`|\\[${name}\\]|${name})(?![\\w$])`, "gi");
  const scope = table.schema ?? table.database;
  for (const m of sql.matchAll(re)) {
    const before = sql.slice(0, m.index);
    if (/\.\s*$/.test(before)) {
      const q = QUALIFIER.exec(before);
      const qualifier = q ? (q[1] ?? q[2] ?? q[3] ?? q[4]) : null;
      if (same(qualifier, scope) || same(qualifier, table.database)) return true;
    } else if (table.schema === null || same(viewSchema, table.schema)) {
      return true;
    }
  }
  return false;
}

export interface ViewScan {
  views: ObjectPath[];
  /** More views than `MAX_VIEWS` exist; only the first were read. */
  capped: boolean;
  /** Definitions that could not be read, so those views were not checked. */
  unreadable: number;
}

/**
 * The views that name `table`: its own schema's first, then the database's other schemas (not the
 * system ones), up to `MAX_VIEWS` definitions. Stops early once `alive` turns false.
 */
export async function viewsUsing(id: ConnectionId, table: ObjectPath, alive: () => boolean): Promise<ViewScan> {
  const schemas: (string | null)[] = [table.schema];
  if (table.schema !== null) {
    for (const s of await listSchemas(id, table.database)) if (!s.isSystem && s.name !== table.schema) schemas.push(s.name);
  }
  const all: ObjectPath[] = [];
  for (const schema of schemas) {
    if (!alive() || all.length > MAX_VIEWS) break;
    for (const o of await listObjects(id, table.database, schema)) {
      if (o.kind === "view") all.push({ database: table.database, schema, name: o.name });
    }
  }
  const out: ViewScan = { views: [], capped: all.length > MAX_VIEWS, unreadable: 0 };
  for (const path of all.slice(0, MAX_VIEWS)) {
    if (!alive()) break;
    let sql: string;
    try {
      sql = await objectDefinition(id, "view", path);
    } catch {
      out.unreadable++;
      continue;
    }
    if (namesTable(sql, table, path.schema)) out.views.push(path);
  }
  return out;
}
