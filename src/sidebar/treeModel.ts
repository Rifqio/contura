import type {
  ConnectionConfig,
  ConnectionId,
  DbObject,
  ObjectKind,
  ObjectPath,
  SavedQuery,
  SchemaInfo,
} from "../api/types";

export type Load<T> = { s: "loading" } | { s: "loaded"; value: T } | { s: "failed"; message: string };

export type TreeNodeState = "closed" | "connecting" | "open" | "failed";

export type TreeNode =
  | { kind: "connection"; id: string; connection: ConnectionConfig; state: TreeNodeState }
  | { kind: "database"; id: string; connectionId: ConnectionId; name: string }
  | { kind: "schema"; id: string; connectionId: ConnectionId; database: string; name: string; system: boolean }
  | {
      kind: "folder";
      id: string;
      connectionId: ConnectionId;
      scope: string;
      /** The database and schema the folder lists, so its menu knows where a new table goes. */
      database: string;
      schema: string | null;
      objectKind: ObjectKind;
      label: string;
      count: number;
    }
  | {
      kind: "object";
      id: string;
      connectionId: ConnectionId;
      path: ObjectPath;
      objectKind: ObjectKind;
      rows: number | null;
    }
  | {
      kind: "note";
      id: string;
      text: string;
      failed: boolean;
      /** Set when a PostgreSQL database holds only system schemas: the note offers to show them. */
      showSystem?: { connectionId: ConnectionId; database: string };
    }
  | { kind: "savedRoot"; id: "saved"; count: number }
  | { kind: "saved"; id: string; query: SavedQuery; opensOn: string | null };

export interface BranchData {
  databases: Load<string[]>;
  /** Keyed by database. */
  schemas: Record<string, Load<SchemaInfo[]>>;
  /** Keyed by `scopeKey`. */
  objects: Record<string, Load<DbObject[]>>;
  /** Databases whose system schemas are shown. */
  showSystem: ReadonlySet<string>;
}

export interface TreeData {
  connections: ConnectionConfig[];
  states: Record<ConnectionId, TreeNodeState>;
  branches: Record<ConnectionId, BranchData>;
  saved: SavedQuery[];
  /** Ids of the nodes that are open. */
  expanded: ReadonlySet<string>;
  filter: string;
}

export interface TreeRow {
  node: TreeNode;
  level: number;
  expandable: boolean;
  expanded: boolean;
  /** Matched characters `[start, end)` of the node's name while filtering. */
  match: [number, number] | null;
}

export type TreeKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "ArrowRight" | "ArrowLeft";

export const SAVED_ROOT_ID = "saved";

export const FOLDERS: { kind: ObjectKind; label: string }[] = [
  { kind: "table", label: "Tables" },
  { kind: "view", label: "Views" },
  { kind: "procedure", label: "Procedures" },
  { kind: "function", label: "Functions" },
  { kind: "trigger", label: "Triggers" },
];

/** Where objects live: a database, or a schema in one. NUL cannot occur in a name. */
export function scopeKey(database: string, schema: string | null): string {
  return schema === null ? database : `${database}\u0000${schema}`;
}

// Free-text segments (names, scopes) are joined with NUL, which cannot occur in a name, so ids never collide.
export const databaseId = (connectionId: ConnectionId, database: string) => `database\u0000${connectionId}\u0000${database}`;
export const schemaId = (connectionId: ConnectionId, database: string, schema: string) =>
  `schema\u0000${connectionId}\u0000${scopeKey(database, schema)}`;
export const folderId = (connectionId: ConnectionId, scope: string, kind: ObjectKind) =>
  `folder\u0000${connectionId}\u0000${kind}\u0000${scope}`;
export const objectId = (connectionId: ConnectionId, kind: ObjectKind, scope: string, name: string) =>
  `object\u0000${connectionId}\u0000${kind}\u0000${scope}\u0000${name}`;

/** The Connection a database, schema, folder or object id belongs to; null for any other id. */
export function connectionOfNodeId(id: string): ConnectionId | null {
  const parts = id.split("\u0000");
  return parts.length >= 3 ? (parts[1] as ConnectionId) : null;
}

export function flattenTree(d: TreeData): TreeRow[] {
  // The filter is matched as typed; only an all-space filter counts as empty.
  const needle = d.filter.toLowerCase();
  const filtering = d.filter.trim().length > 0;
  const out: TreeRow[] = [];
  const seen = new Map<string, number>();

  const find = (name: string): [number, number] | null => {
    if (!filtering) return null;
    const at = name.toLowerCase().indexOf(needle);
    return at < 0 ? null : [at, at + needle.length];
  };
  const hit = (name: string) => find(name) !== null;

  const push = (node: TreeNode, level: number, expandable: boolean, expanded: boolean, name?: string) => {
    // Same-name overloads share an id; later ones get an ordinal so every row id is unique.
    const n = (seen.get(node.id) ?? 0) + 1;
    seen.set(node.id, n);
    if (n > 1) node = { ...node, id: `${node.id}#${n}` } as TreeNode;
    out.push({ node, level, expandable, expanded, match: name === undefined ? null : find(name) });
  };
  const note = (id: string, text: string, level: number, failed = false) =>
    push({ kind: "note", id, text, failed }, level, false, false);

  const byName = [...d.connections].sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });

  for (const c of byName) {
    const state = d.states[c.id] ?? "closed";
    const branch = state === "open" ? d.branches[c.id] : undefined;
    const start = out.length;
    const open = filtering ? true : d.expanded.has(c.id);
    // The connection row goes in first and is dropped again if a filter finds nothing under it.
    push({ kind: "connection", id: c.id, connection: c, state }, 0, true, state === "open" && open);
    if (!branch || !open) {
      if (filtering) out.length = start;
      continue;
    }
    flattenBranch(c, branch);
    if (filtering && out.length === start + 1) out.length = start;
  }

  const shownSaved = d.saved.filter((q) => !filtering || hit(q.name));
  if (!filtering || shownSaved.length > 0) {
    const open = filtering || d.expanded.has(SAVED_ROOT_ID);
    push({ kind: "savedRoot", id: SAVED_ROOT_ID, count: shownSaved.length }, 0, true, open);
    if (open) {
      const names = new Map(d.connections.map((c) => [c.id, c.name]));
      for (const q of shownSaved) {
        const opensOn = q.connectionId === null ? null : (names.get(q.connectionId) ?? null);
        push({ kind: "saved", id: q.id, query: q, opensOn }, 1, false, false, q.name);
      }
    }
  }
  return out;

  function flattenBranch(c: ConnectionConfig, b: BranchData) {
    const dbs = b.databases;
    if (dbs.s !== "loaded") {
      if (!filtering) {
        note(`note:${c.id}:databases`, dbs.s === "loading" ? "Loading databases…" : dbs.message, 1, dbs.s === "failed");
      }
      return;
    }
    const withSchemas = c.dialect === "postgres";
    for (const db of dbs.value) {
      const start = out.length;
      const id = databaseId(c.id, db);
      const open = filtering ? true : d.expanded.has(id);
      push({ kind: "database", id, connectionId: c.id, name: db }, 1, true, open, db);
      if (open) {
        if (withSchemas) flattenSchemas(c, b, db);
        else flattenScope(c, b, db, null, 2);
      }
      // A database that neither matches nor holds a match is left out while filtering.
      if (filtering && out.length === start + 1 && out[start].match === null) out.length = start;
    }
  }

  function flattenSchemas(c: ConnectionConfig, b: BranchData, db: string) {
    const load = b.schemas[db];
    if (!load || load.s !== "loaded") {
      if (!filtering) {
        const text = !load || load.s === "loading" ? "Loading schemas…" : load.message;
        note(`note:${c.id}:schemas:${db}`, text, 2, load?.s === "failed");
      }
      return;
    }
    const system = b.showSystem.has(db);
    const visible = load.value.filter((s) => system || !s.isSystem);
    if (visible.length === 0 && !filtering) {
      const id = `note:${c.id}:schemas:${db}`;
      if (load.value.length > 0) {
        push(
          { kind: "note", id, text: `${db} has no user schemas.`, failed: false, showSystem: { connectionId: c.id, database: db } },
          2,
          false,
          false,
        );
      } else note(id, `${db} has no schemas.`, 2);
      return;
    }
    for (const s of visible) {
      const start = out.length;
      const id = schemaId(c.id, db, s.name);
      const open = filtering ? true : d.expanded.has(id);
      push(
        { kind: "schema", id, connectionId: c.id, database: db, name: s.name, system: s.isSystem },
        2,
        true,
        open,
        s.name,
      );
      if (open) flattenScope(c, b, db, s.name, 3);
      if (filtering && out.length === start + 1 && out[start].match === null) out.length = start;
    }
  }

  function flattenScope(c: ConnectionConfig, b: BranchData, db: string, schema: string | null, level: number) {
    const scope = scopeKey(db, schema);
    const load = b.objects[scope];
    if (!load || load.s !== "loaded") {
      if (!filtering) {
        const text = !load || load.s === "loading" ? "Loading objects…" : load.message;
        note(`note:${c.id}:${scope}`, text, level, load?.s === "failed");
      }
      return;
    }
    if (load.value.length === 0) {
      if (!filtering) note(`note:${c.id}:${scope}`, `${schema ?? db} has no tables, views or routines.`, level);
      return;
    }
    for (const f of FOLDERS) {
      const items = load.value.filter((o) => o.kind === f.kind && (!filtering || hit(o.name)));
      if (items.length === 0) continue;
      const id = folderId(c.id, scope, f.kind);
      const open = filtering ? true : d.expanded.has(id);
      push(
        {
          kind: "folder",
          id,
          connectionId: c.id,
          scope,
          database: db,
          schema,
          objectKind: f.kind,
          label: f.label,
          count: items.length,
        },
        level,
        true,
        open,
      );
      if (!open) continue;
      for (const o of items) {
        const path: ObjectPath = { database: db, schema, name: o.name };
        push(
          {
            kind: "object",
            id: objectId(c.id, o.kind, scope, o.name),
            connectionId: c.id,
            path,
            objectKind: o.kind,
            rows: o.rows,
          },
          level + 1,
          false,
          false,
          o.name,
        );
      }
    }
  }
}

/** The rows to render for a scroll position, with `overscan` extra rows on each side. */
export function windowRange(
  count: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  overscan = 8,
): { start: number; end: number } {
  if (!(rowHeight > 0)) return { start: 0, end: Math.max(0, Math.min(count, overscan)) };
  const first = Math.floor(scrollTop / rowHeight);
  const last = Math.ceil((scrollTop + viewport) / rowHeight);
  return { start: Math.max(0, Math.min(first - overscan, count)), end: Math.max(0, Math.min(last + overscan, count)) };
}

/**
 * The next focus for a key. On an empty list there is nothing to focus: the result keeps the given
 * focus (or "") and expands or collapses nothing. An unknown focused id goes to the first row.
 * While filtering, every row is open, so Left only moves to the parent: pass `filtering`.
 */
export function moveFocus(
  rows: readonly TreeRow[],
  focusedId: string | null,
  key: TreeKey,
  filtering = false,
): { focus: string; expand?: string; collapse?: string } {
  if (rows.length === 0) return { focus: focusedId ?? "" };
  const i = rows.findIndex((r) => r.node.id === focusedId);
  if (i < 0) return { focus: rows[0].node.id };
  const row = rows[i];
  const at = (n: number) => rows[Math.max(0, Math.min(n, rows.length - 1))].node.id;
  switch (key) {
    case "ArrowDown":
      return { focus: at(i + 1) };
    case "ArrowUp":
      return { focus: at(i - 1) };
    case "Home":
      return { focus: at(0) };
    case "End":
      return { focus: at(rows.length - 1) };
    case "ArrowRight": {
      if (row.expandable && !row.expanded) return { focus: row.node.id, expand: row.node.id };
      const next = rows[i + 1];
      if (row.expanded && next && next.level > row.level) return { focus: next.node.id };
      return { focus: row.node.id };
    }
    case "ArrowLeft": {
      if (!filtering && row.expandable && row.expanded) return { focus: row.node.id, collapse: row.node.id };
      for (let j = i - 1; j >= 0; j--) if (rows[j].level < row.level) return { focus: rows[j].node.id };
      return { focus: row.node.id };
    }
  }
}
