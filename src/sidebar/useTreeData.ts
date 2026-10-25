import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, isNotOpen, listDatabases, listObjects, listSchemas } from "../api/client";
import type { ConnectionConfig, ConnectionId, ObjectPath } from "../api/types";
import { objectNames } from "../palette/nameIndex";
import {
  type BranchData,
  type TreeNode,
  connectionOfNodeId,
  databaseId,
  folderId,
  objectId,
  SAVED_ROOT_ID,
  schemaId,
  scopeKey,
} from "./treeModel";

/** Expands down to an object and focuses its row; `seq` tells one request from the next. */
export interface RevealRequest {
  connectionId: ConnectionId;
  database: string;
  schema: string | null;
  name: string;
  seq: number;
}

export interface TreeData {
  /** Load state per open Connection. */
  branches: Record<ConnectionId, BranchData>;
  /** Ids of the open nodes. */
  expanded: ReadonlySet<string>;
  /** Opens a node, loading what it shows when that is not loaded yet. */
  expand(node: TreeNode): void;
  collapse(id: string): void;
  /** Reloads every loaded level of a Connection, keeping what shows until the new lists arrive. */
  refresh(connectionId: ConnectionId): void;
  /** Loads a failed level again, from its note row id. */
  retry(noteId: string): void;
  setShowSystem(connectionId: ConnectionId, database: string, on: boolean): void;
  /** The server's row estimate of a loaded table, else null; never a table tab's count. */
  estimate(connectionId: ConnectionId, path: ObjectPath): number | null;
  /** A table tab counted the table: the tree shows that count instead of the estimate, until the level reloads or a
   * later count is over 1,000, slow or not made (`null`). */
  setExact(connectionId: ConnectionId, path: ObjectPath, rows: number | null): void;
  reveal(request: RevealRequest): void;
  /** A row to focus, set when a reveal found its object; `seq` changes per request. */
  focusRequest: { id: string; seq: number } | null;
}

interface Options {
  /** Every Connection: the open ones get a branch. */
  connections: ConnectionConfig[];
  openIds: ReadonlySet<ConnectionId>;
  /** A load said the session is gone. */
  onNotOpen?: (id: ConnectionId) => void;
  /** A reveal ended, found or not; the owner clears its request. */
  onRevealed?: () => void;
}

const emptyBranch = (): BranchData => ({ databases: { s: "loading" }, schemas: {}, objects: {}, showSystem: new Set() });

/** The database a Connection opens at: SQLite's one `main`, else the one it names. */
const defaultDatabase = (c: ConnectionConfig) => (c.dialect === "sqlite" ? "main" : c.database);

/**
 * The one tree's data: per open Connection its databases, schemas (with `public` opened) and
 * objects per scope, plus which nodes are open and the reveal request.
 */
export function useTreeData({ connections, openIds, onNotOpen, onRevealed }: Options): TreeData {
  const [branches, setBranches] = useState<Record<ConnectionId, BranchData>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([SAVED_ROOT_ID]));
  const [focusRequest, setFocusRequest] = useState<{ id: string; seq: number } | null>(null);
  const [pendingReveal, setPendingReveal] = useState<{ connectionId: ConnectionId; scope: string; name: string } | null>(
    null,
  );

  const branchesRef = useRef(branches);
  branchesRef.current = branches;
  const byId = useRef(new Map<ConnectionId, ConnectionConfig>());
  byId.current = new Map(connections.map((c) => [c.id, c]));
  const callbacks = useRef({ onNotOpen, onRevealed });
  callbacks.current = { onNotOpen, onRevealed };
  /** Bumped when a Connection's branch starts or ends, so a late answer for an older session is dropped. */
  const epochs = useRef(new Map<ConnectionId, number>());
  const revealSeq = useRef(0);
  /** Object lists being loaded, by Connection and scope: a reveal waits for them, even while a kept list shows. */
  const loadingScopes = useRef(new Map<string, number>());
  const scopeLoad = (id: ConnectionId, scope: string) => `${id}${scope}`;
  const loadEnded = (key: string) => {
    const n = (loadingScopes.current.get(key) ?? 1) - 1;
    if (n > 0) loadingScopes.current.set(key, n);
    else loadingScopes.current.delete(key);
  };

  const open = useCallback((...ids: string[]) => {
    setExpanded((s) => {
      if (ids.every((id) => s.has(id))) return s;
      const next = new Set(s);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const patch = (id: ConnectionId, epoch: number, f: (b: BranchData) => BranchData) => {
    if (epochs.current.get(id) !== epoch) return;
    setBranches((all) => (all[id] ? { ...all, [id]: f(all[id]) } : all));
  };

  const fail = (c: ConnectionConfig, e: unknown) => {
    if (isNotOpen(e)) callbacks.current.onNotOpen?.(c.id);
    return errorText(e, c.dialect);
  };

  /** `keep` leaves a loaded list on screen while it reloads. */
  function loadObjects(c: ConnectionConfig, database: string, schema: string | null, keep = false) {
    const epoch = epochs.current.get(c.id) ?? 0;
    const scope = scopeKey(database, schema);
    const before = branchesRef.current[c.id]?.objects[scope];
    const first = !before || before.s !== "loaded";
    if (!(keep && before?.s === "loaded")) patch(c.id, epoch, (b) => ({ ...b, objects: { ...b.objects, [scope]: { s: "loading" } } }));
    const loadKey = scopeLoad(c.id, scope);
    loadingScopes.current.set(loadKey, (loadingScopes.current.get(loadKey) ?? 0) + 1);
    listObjects(c.id, database, schema)
      .then((value) => {
        loadEnded(loadKey);
        // Quick Open finds these by name, even after the Connection closes (names only, capped).
        objectNames.keep(c.id, database, schema, value);
        patch(c.id, epoch, (b) => ({ ...b, objects: { ...b.objects, [scope]: { s: "loaded", value } } }));
        // A scope shows its tables at once the first time it loads.
        if (first && epochs.current.get(c.id) === epoch) open(folderId(c.id, scope, "table"));
      })
      .catch((e) => {
        loadEnded(loadKey);
        const message = fail(c, e);
        patch(c.id, epoch, (b) => ({ ...b, objects: { ...b.objects, [scope]: { s: "failed", message } } }));
      });
  }

  /** `openPublic` also opens the `public` schema when the database has one. */
  function loadSchemas(c: ConnectionConfig, database: string, openPublic = false, keep = false) {
    const epoch = epochs.current.get(c.id) ?? 0;
    const before = branchesRef.current[c.id]?.schemas[database];
    if (!(keep && before?.s === "loaded")) patch(c.id, epoch, (b) => ({ ...b, schemas: { ...b.schemas, [database]: { s: "loading" } } }));
    listSchemas(c.id, database)
      .then((value) => {
        patch(c.id, epoch, (b) => ({ ...b, schemas: { ...b.schemas, [database]: { s: "loaded", value } } }));
        if (openPublic && epochs.current.get(c.id) === epoch && value.some((s) => s.name === "public")) {
          open(schemaId(c.id, database, "public"));
          loadObjects(c, database, "public");
        }
      })
      .catch((e) => {
        const message = fail(c, e);
        patch(c.id, epoch, (b) => ({ ...b, schemas: { ...b.schemas, [database]: { s: "failed", message } } }));
      });
  }

  /** `first` opens the Connection's default database once the list arrives. */
  function loadDatabases(c: ConnectionConfig, first: boolean, keep = false) {
    const epoch = epochs.current.get(c.id) ?? 0;
    const before = branchesRef.current[c.id]?.databases;
    if (!(keep && before?.s === "loaded")) patch(c.id, epoch, (b) => ({ ...b, databases: { s: "loading" } }));
    listDatabases(c.id)
      .then((value) => {
        patch(c.id, epoch, (b) => ({ ...b, databases: { s: "loaded", value } }));
        const db = defaultDatabase(c);
        if (!first || epochs.current.get(c.id) !== epoch || !db || !value.includes(db)) return;
        open(databaseId(c.id, db));
        if (c.dialect === "postgres") loadSchemas(c, db, true);
        else loadObjects(c, db, null);
      })
      .catch((e) => {
        const message = fail(c, e);
        patch(c.id, epoch, (b) => ({ ...b, databases: { s: "failed", message } }));
      });
  }

  // An opened Connection gets a branch, expanded at once; a closed one loses it.
  const started = useRef(new Set<ConnectionId>());
  useEffect(() => {
    const begin: ConnectionConfig[] = [];
    for (const c of connections) {
      if (openIds.has(c.id) && !started.current.has(c.id)) begin.push(c);
    }
    const ended = [...started.current].filter((id) => !openIds.has(id) || !byId.current.has(id));
    if (begin.length === 0 && ended.length === 0) return;
    for (const id of ended) {
      started.current.delete(id);
      epochs.current.set(id, (epochs.current.get(id) ?? 0) + 1);
    }
    for (const c of begin) {
      started.current.add(c.id);
      epochs.current.set(c.id, (epochs.current.get(c.id) ?? 0) + 1);
    }
    const next = { ...branchesRef.current };
    for (const id of ended) delete next[id];
    for (const c of begin) next[c.id] = emptyBranch();
    branchesRef.current = next;
    setBranches(next);
    if (ended.length > 0) {
      // A closed Connection's levels close with it, so opening it again starts fresh.
      setExpanded((s) => {
        const gone = new Set(ended);
        const kept = [...s].filter((id) => {
          const owner = connectionOfNodeId(id);
          return !gone.has(id) && !(owner !== null && gone.has(owner));
        });
        return kept.length === s.size ? s : new Set(kept);
      });
    }
    if (begin.length > 0) open(...begin.map((c) => c.id));
    for (const c of begin) loadDatabases(c, true);
    // Loaders read refs; only the open set and the Connections matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, openIds]);

  function expand(node: TreeNode) {
    switch (node.kind) {
      case "database": {
        const c = byId.current.get(node.connectionId);
        const b = branchesRef.current[node.connectionId];
        if (c && b) {
          if (c.dialect === "postgres") {
            const s = b.schemas[node.name];
            if (!s || s.s === "failed") loadSchemas(c, node.name);
          } else {
            const o = b.objects[scopeKey(node.name, null)];
            if (!o || o.s === "failed") loadObjects(c, node.name, null);
          }
        }
        break;
      }
      case "schema": {
        const c = byId.current.get(node.connectionId);
        const o = branchesRef.current[node.connectionId]?.objects[scopeKey(node.database, node.name)];
        if (c && (!o || o.s === "failed")) loadObjects(c, node.database, node.name);
        break;
      }
      case "connection":
        // A closed Connection has nothing to show; the tree opens it first.
        if (!branchesRef.current[node.id]) return;
        break;
      default:
        break;
    }
    open(node.id);
  }

  function collapse(id: string) {
    setExpanded((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }

  function refresh(connectionId: ConnectionId) {
    const c = byId.current.get(connectionId);
    const b = branchesRef.current[connectionId];
    if (!c || !b) return;
    loadDatabases(c, b.databases.s === "failed", true);
    for (const db of Object.keys(b.schemas)) loadSchemas(c, db, false, true);
    for (const scope of Object.keys(b.objects)) {
      const [db, schema] = scope.split("\u0000");
      loadObjects(c, db, schema ?? null, true);
    }
  }

  function retry(noteId: string) {
    // Note ids: `note:<connection>:databases`, `note:<connection>:schemas:<db>`, `note:<connection>:<scope>`.
    const m = /^note:([^:]+):(.*)$/s.exec(noteId);
    if (!m) return;
    const c = byId.current.get(m[1]);
    if (!c || !branchesRef.current[c.id]) return;
    const rest = m[2];
    if (rest === "databases") loadDatabases(c, true);
    else if (rest.startsWith("schemas:")) loadSchemas(c, rest.slice("schemas:".length));
    else {
      const [db, schema] = rest.split("\u0000");
      loadObjects(c, db, schema ?? null);
    }
  }

  function setShowSystem(connectionId: ConnectionId, database: string, on: boolean) {
    setBranches((all) => {
      const b = all[connectionId];
      if (!b || b.showSystem.has(database) === on) return all;
      const showSystem = new Set(b.showSystem);
      if (on) showSystem.add(database);
      else showSystem.delete(database);
      return { ...all, [connectionId]: { ...b, showSystem } };
    });
  }

  function estimate(connectionId: ConnectionId, path: ObjectPath): number | null {
    const load = branchesRef.current[connectionId]?.objects[scopeKey(path.database, path.schema)];
    if (load?.s !== "loaded") return null;
    return load.value.find((o) => o.kind === "table" && o.name === path.name)?.rows ?? null;
  }

  function setExact(connectionId: ConnectionId, path: ObjectPath, rows: number | null) {
    const scope = scopeKey(path.database, path.schema);
    setBranches((all) => {
      const b = all[connectionId];
      const load = b?.objects[scope];
      if (!b || load?.s !== "loaded") return all;
      const at = load.value.findIndex((o) => o.kind === "table" && o.name === path.name);
      if (at < 0 || load.value[at].counted === (rows ?? undefined)) return all;
      const value = load.value.slice();
      const { counted: _drop, ...rest } = value[at];
      value[at] = rows === null ? rest : { ...rest, counted: rows };
      return { ...all, [connectionId]: { ...b, objects: { ...b.objects, [scope]: { s: "loaded", value } } } };
    });
  }

  function reveal({ connectionId, database, schema, name }: RevealRequest) {
    const c = byId.current.get(connectionId);
    const b = branchesRef.current[connectionId];
    if (!c || !b) {
      callbacks.current.onRevealed?.();
      return;
    }
    const pg = c.dialect === "postgres";
    const ids = [c.id, databaseId(c.id, database)];
    if (pg && schema !== null) {
      const s = b.schemas[database];
      if (!s || s.s === "failed") loadSchemas(c, database);
      ids.push(schemaId(c.id, database, schema));
    }
    open(...ids);
    const inSchema = pg ? schema : null;
    const scope = scopeKey(database, inSchema);
    const load = b.objects[scope];
    if (!load || load.s === "failed") loadObjects(c, database, inSchema);
    setPendingReveal({ connectionId, scope, name });
  }

  // A reveal finishes once its objects are loaded: open the object's folder and focus its row.
  useEffect(() => {
    if (!pendingReveal) return;
    const load = branches[pendingReveal.connectionId]?.objects[pendingReveal.scope];
    // A list reloading under a kept one (a refresh after a create) is waited for too.
    const reloading = loadingScopes.current.has(scopeLoad(pendingReveal.connectionId, pendingReveal.scope));
    if (!load || load.s === "loading" || reloading) {
      if (!branches[pendingReveal.connectionId]) {
        setPendingReveal(null);
        callbacks.current.onRevealed?.();
      }
      return;
    }
    setPendingReveal(null);
    const found = load.s === "loaded" ? load.value.find((o) => o.name === pendingReveal.name) : undefined;
    if (found) {
      open(folderId(pendingReveal.connectionId, pendingReveal.scope, found.kind));
      setFocusRequest({
        id: objectId(pendingReveal.connectionId, found.kind, pendingReveal.scope, found.name),
        seq: ++revealSeq.current,
      });
    }
    callbacks.current.onRevealed?.();
  }, [branches, pendingReveal, open]);

  return useMemo(
    () => ({ branches, expanded, expand, collapse, refresh, retry, setShowSystem, estimate, setExact, reveal, focusRequest }),
    // The functions read refs and setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [branches, expanded, focusRequest],
  );
}
