import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { connectionTarget, deleteSavedQuery, DIALECT_LABEL, errorText } from "../api/client";
import type { ConnectionConfig, ConnectionId, Group, GroupId, ObjectKind, ObjectPath, RestoreTarget, SavedQuery } from "../api/types";
import { hintFor } from "../commands/keymap";
import { useCommandKeys, useKeymap } from "../commands/useCommandKeys";
import DbMark from "../components/DbMark";
import Dialog from "../components/Dialog";
import Icon, { type IconName } from "../components/Icon";
import Kbd from "../components/Kbd";
import { MenuList, type MenuItem } from "../components/Menu";
import { guideX, STUB_WIDTH, treeGuides, type RowGuides } from "../components/treeGuides";
import SaveQueryDialog from "../query/SaveQueryDialog";
import type { Selection, TransferSeed } from "../shell/tabs";
import { connectionMenu } from "./connectionMenu";
import { flattenTree, moveFocus, SAVED_ROOT_ID, type TreeKey, type TreeNode, type TreeRow, windowRange } from "./treeModel";
import type { TreeData } from "./useTreeData";

/** The drag data type of a table or view row: JSON `{ connectionId, kind, path }` (D15). */
export const OBJECT_DRAG_TYPE = "application/x-contura-object";

/** How a Connection's last open went, when it is not plain open or closed (frames 10b, 10c). */
export type ConnectionOpenStatus = { s: "connecting" } | { s: "failed"; error: string };

export interface OneTreeProps {
  /** The place's Connections, each a top-level branch. */
  connections: ConnectionConfig[];
  groups: Group[];
  openIds: ReadonlySet<ConnectionId>;
  saved: SavedQuery[];
  /** The Saved Query open in the active tab, if any. */
  activeSavedId: string | null;
  /** The object of the active tab, if any. */
  selected: Selection | null;
  /** Load state and open nodes, from `useTreeData` (the App also reads row estimates from it). */
  tree: TreeData;
  onSelectObject(s: Selection): void;
  /** Opens a closed Connection; a returned promise keeps its row busy until it settles. */
  onOpenConnection(id: ConnectionId): void | Promise<unknown>;
  onCloseConnection(id: ConnectionId): void;
  onEditConnection(c: ConnectionConfig): void;
  onDuplicateConnection(c: ConnectionConfig): void;
  onNewQuery(id: ConnectionId): void;
  /** Opens a Visual Query tab on the Connection (from its row menu). */
  onNewVisualQuery(id: ConnectionId): void;
  /**
   * Adds a table or view to the active Visual Query: "Add to Visual Query" on its row. The App
   * passes it only while a Visual Query tab is active, with that tab's Connection.
   */
  onAddToVisualQuery?(s: Selection): void;
  /** The active Visual Query's Connection: only its rows offer Add to Visual Query. */
  visualQueryConnection?: ConnectionId | null;
  onNewSchemaModel(id: ConnectionId, database: string, schema: string | null): void;
  /** Opens a New table design tab in a database (and schema); the menus offer it only when set (D7). */
  onNewTable?(connectionId: ConnectionId, database: string, schema: string | null): void;
  /** Opens a table's design tab. */
  onDesignTable?(s: Selection): void;
  /** Opens a table's lineage tab (step 6+). */
  onShowLineage?(s: Selection): void;
  /** Starts dropping a table; the App asks first. */
  onDropTable?(connectionId: ConnectionId, path: ObjectPath): void;
  /** Opens the Export dialog on a table. */
  onExportTable?(s: Selection): void;
  /** Opens an Import tab into a table; shown on Read-only Connections too, whose tab says so (Q15). */
  onImportTable?(s: Selection): void;
  /** "Transfer data..." on a database (MySQL, SQLite), schema (PostgreSQL) or table row (step 8). */
  onTransfer?(seed: TransferSeed): void;
  /** "Back up..." on a database (MySQL, SQLite) or schema (PostgreSQL) row (step 9). */
  onBackup?(target: { connectionId: ConnectionId; database: string; schema: string | null }): void;
  /** "Restore..." on a database, schema or Connection row; `database: null` restores Into a new database. */
  onRestore?(target: RestoreTarget): void;
  onMoveConnection(id: ConnectionId, group: GroupId | null): void;
  onNewGroup(): void;
  /** Asked for after the tree's own confirmation. */
  onClearHistory(id: ConnectionId): void;
  /** Asked for after the tree's own confirmation. */
  onDeleteConnection(id: ConnectionId): void;
  /** The branch reloaded, so what depends on the schema should reload too. */
  onRefresh(id: ConnectionId): void;
  onOpenSaved(q: SavedQuery): void;
  /** Opens the Saved Queries list tab; the branch's list button shows only when this is set. */
  onOpenSavedList?(): void;
  /** The branch of the focused row while the tree has focus; null when focus leaves it or sits on no Connection. */
  onFocusBranch(connectionId: ConnectionId | null): void;
  /** A Saved Query was renamed or deleted from its row menu; reload the list. */
  onSavedChanged?(): void;
  /** False while the sidebar is hidden, so its keys (filter, refresh) stay with whoever shows. */
  keysActive?: boolean;
  /** Opens in flight and failed, wherever they started (the tree, a query tab, Home): the row says so. */
  openStatus?: ReadonlyMap<ConnectionId, ConnectionOpenStatus>;
}

type MenuState = { rowId: string; label: string; items: MenuItem[]; x: number; y: number };
type Ask =
  | { kind: "delete"; connection: ConnectionConfig }
  | { kind: "clear"; connection: ConnectionConfig }
  | { kind: "deleteSaved"; query: SavedQuery };

const FALLBACK_ROW_HEIGHT = 28;

const KIND_ICON: Record<ObjectKind, IconName> = {
  table: "table",
  view: "view",
  procedure: "routine",
  function: "routine",
  trigger: "trigger",
};

const indent = (level: number): CSSProperties => ({ paddingLeft: `calc(8px + 20px * ${level})` });

function samePath(a: ObjectPath, b: ObjectPath) {
  return a.database === b.database && a.schema === b.schema && a.name === b.name;
}

/** The Connection a row belongs to; null for Saved Queries. */
function branchOf(node: TreeNode): ConnectionId | null {
  switch (node.kind) {
    case "connection":
      return node.id;
    case "database":
    case "schema":
    case "folder":
    case "object":
      return node.connectionId;
    case "note":
      return /^note:([^:]+):/.exec(node.id)?.[1] ?? null;
    default:
      return null;
  }
}

function labelOf(node: TreeNode): string {
  switch (node.kind) {
    case "connection":
      // R30: the state, then Production and Read-only when they apply (spec R8: spoken, not "PROD").
      return [
        node.connection.name,
        node.state === "failed" ? "last connect failed" : node.state,
        ...(node.connection.production ? ["Production"] : []),
        ...(node.connection.readOnly ? ["Read-only"] : []),
      ].join(", ");
    case "database":
    case "schema":
      return node.name;
    case "folder":
      return node.label;
    case "object":
      return node.path.name;
    case "note":
      return node.text;
    case "savedRoot":
      return "Saved Queries";
    case "saved":
      return node.query.name;
  }
}

function Name({ text, match }: { text: string; match: [number, number] | null }) {
  if (!match) return <span className="tree-name">{text}</span>;
  const [a, b] = match;
  return (
    <span className="tree-name">
      {text.slice(0, a)}
      <mark className="tree-match">{text.slice(a, b)}</mark>
      {text.slice(b)}
    </span>
  );
}

function Guides({ g }: { g: RowGuides | undefined }) {
  if (!g) return null;
  const stub = g.stub;
  return (
    <>
      {g.levels.map((k) => (
        <span
          key={k}
          className={k === g.strong ? "tree-guide tree-guide-strong" : "tree-guide"}
          style={{ left: guideX(k) }}
          aria-hidden="true"
        />
      ))}
      {stub && (
        <span
          className={["tree-stub", stub.elbow && "tree-elbow", stub.strong && "tree-stub-strong"].filter(Boolean).join(" ")}
          style={{ left: guideX(stub.level), width: STUB_WIDTH }}
          aria-hidden="true"
        />
      )}
    </>
  );
}

/** A right-click or More menu at a point, kept inside the window. */
function PlacedMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.height === 0) return;
    const x = Math.max(4, Math.min(menu.x, window.innerWidth - box.width - 4));
    const y = Math.max(4, Math.min(menu.y, window.innerHeight - box.height - 4));
    if (x !== at.x || y !== at.y) setAt({ x, y });
    // Measured once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return (
    <div ref={ref} className="tree-menu" style={{ left: at.x, top: at.y }}>
      <MenuList items={menu.items} label={menu.label} onClose={onClose} />
    </div>
  );
}

/** Layout A: one tree with every Connection of the place as a branch and Saved Queries last (D13 to D16). */
export default function OneTree(props: OneTreeProps) {
  const {
    connections,
    groups,
    openIds,
    saved,
    activeSavedId,
    selected,
    tree,
    onSelectObject,
    onOpenConnection,
    onFocusBranch,
    keysActive = true,
  } = props;
  const map = useKeymap().map;
  const filterKey = hintFor(map, "tree.filter");
  const newQueryKey = hintFor(map, "query.new");
  const refreshKey = hintFor(map, "tree.refresh");
  const saveKey = hintFor(map, "query.save");

  const [filter, setFilter] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<ReadonlySet<ConnectionId>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SavedQuery | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  /** A row to focus once it is drawn. */
  const wantFocus = useRef<string | null>(null);
  /** The branch last told to the owner; undefined before the tree first had focus. */
  const told = useRef<ConnectionId | null | undefined>(undefined);
  // Another place's Connections: the owner forgot the branch, so the next focus tells it again.
  const connectionIds = connections.map((c) => c.id).join("\u0000");
  useEffect(() => {
    told.current = undefined;
  }, [connectionIds]);

  const filtering = filter.trim().length > 0;
  const states = useMemo(
    () =>
      Object.fromEntries(
        connections.map((c) => {
          const status = props.openStatus?.get(c.id);
          const state = openIds.has(c.id)
            ? "open"
            : connecting.has(c.id) || status?.s === "connecting"
              ? "connecting"
              : status?.s === "failed"
                ? "failed"
                : "closed";
          return [c.id, state] as const;
        }),
      ),
    [connections, openIds, connecting, props.openStatus],
  );

  const rows = useMemo(() => {
    const out = flattenTree({ connections, states, branches: tree.branches, saved, expanded: tree.expanded, filter });
    if (!filtering && saved.length === 0 && tree.expanded.has(SAVED_ROOT_ID)) {
      const text = saveKey ? `Press ${saveKey} in a query tab to keep the query here.` : "Save a query tab to keep it here.";
      out.push({ node: { kind: "note", id: "note:saved", text, failed: false }, level: 1, expandable: false, expanded: false, match: null });
    }
    return out;
  }, [connections, states, tree.branches, tree.expanded, saved, filter, filtering, saveKey]);

  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.node.id, i])), [rows]);

  const selectedRowId = useMemo(() => {
    if (selected) {
      const r = rows.find(
        (x) =>
          x.node.kind === "object" &&
          x.node.connectionId === selected.connectionId &&
          x.node.objectKind === selected.kind &&
          samePath(x.node.path, selected.path),
      );
      if (r) return r.node.id;
    }
    if (activeSavedId) return rows.find((x) => x.node.kind === "saved" && x.node.query.id === activeSavedId)?.node.id ?? null;
    return null;
  }, [rows, selected, activeSavedId]);

  const guides = useMemo(() => treeGuides(rows.map((r) => ({ id: r.node.id, level: r.level })), selectedRowId), [rows, selectedRowId]);

  // The roving focus: the focused row, else the selected one, else the first.
  const current = focusId !== null && indexOf.has(focusId) ? focusId : (selectedRowId ?? rows[0]?.node.id ?? null);
  const currentRow = current === null ? undefined : rows[indexOf.get(current) ?? -1];

  // ---- Only the rows on screen are drawn ----
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = parseFloat(getComputedStyle(el).getPropertyValue("--tree-row-height"));
    if (h > 0 && h !== rowHeight) setRowHeight(h);
    if (el.clientHeight !== viewport) setViewport(el.clientHeight);
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // Hidden or not laid out (a test DOM): draw a window's worth.
  const view = viewport > 0 ? viewport : window.innerHeight;
  const { start, end } = windowRange(rows.length, scrollTop, view, rowHeight);

  // The rows on screen, plus the roving-focus row wherever it is, so the tree always has one
  // tabbable row and a focused row scrolled out of view keeps its focus. Spacers hold every other row's place.
  const currentIndex = current === null ? -1 : (indexOf.get(current) ?? -1);
  const drawn: (number | { key: string; rows: number })[] = [];
  const range = (from: number, to: number) => {
    for (let i = from; i < to; i++) drawn.push(i);
  };
  if (currentIndex >= 0 && currentIndex < start) {
    drawn.push({ key: "gap-a", rows: currentIndex }, currentIndex, { key: "gap-b", rows: start - currentIndex - 1 });
  } else drawn.push({ key: "gap-a", rows: start });
  range(start, end);
  if (currentIndex >= end) {
    drawn.push({ key: "gap-c", rows: currentIndex - end }, currentIndex, { key: "gap-d", rows: rows.length - currentIndex - 1 });
  } else drawn.push({ key: "gap-d", rows: rows.length - end });

  function scrollToIndex(i: number) {
    const el = scrollRef.current;
    if (!el) return;
    const top = i * rowHeight;
    let next = el.scrollTop;
    if (top < next) next = top;
    else if (top + rowHeight > next + view) next = top + rowHeight - view;
    if (next !== el.scrollTop) el.scrollTop = next;
    setScrollTop(el.scrollTop);
  }

  function moveTo(id: string) {
    setFocusId(id);
    const i = indexOf.get(id);
    if (i !== undefined) scrollToIndex(i);
    wantFocus.current = id;
  }

  useLayoutEffect(() => {
    const id = wantFocus.current;
    if (!id) return;
    const el = rowEls.current.get(id);
    if (!el) return;
    wantFocus.current = null;
    el.focus({ preventScroll: true });
  });

  // A reveal found its row: focus it. A filter that hides the row is cleared first, so a reveal
  // always ends on a visible, focused row.
  const revealAfterClear = useRef<string | null>(null);
  useEffect(() => {
    const id = tree.focusRequest?.id;
    if (!id) return;
    if (filtering && !indexOf.has(id)) {
      revealAfterClear.current = id;
      setFilter("");
      return;
    }
    moveTo(id);
    // Once per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.focusRequest?.seq]);
  useEffect(() => {
    const id = revealAfterClear.current;
    if (!id || !indexOf.has(id)) return;
    revealAfterClear.current = null;
    moveTo(id);
    // The rows after the filter cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexOf]);

  function tell(id: ConnectionId | null) {
    if (told.current === id) return;
    told.current = id;
    onFocusBranch(id);
  }

  // ---- Actions ----
  function openConnection(c: ConnectionConfig) {
    if (openIds.has(c.id) || connecting.has(c.id)) return;
    const pending = onOpenConnection(c.id);
    if (!pending || typeof (pending as Promise<unknown>).finally !== "function") return;
    setConnecting((s) => new Set(s).add(c.id));
    void (pending as Promise<unknown>)
      .catch(() => {})
      .finally(() =>
        setConnecting((s) => {
          const next = new Set(s);
          next.delete(c.id);
          return next;
        }),
      );
  }

  function expandRow(row: TreeRow) {
    const n = row.node;
    if (n.kind === "connection" && n.state !== "open") {
      openConnection(n.connection);
      return;
    }
    tree.expand(n);
  }

  function toggle(row: TreeRow) {
    if (row.expanded) tree.collapse(row.node.id);
    else expandRow(row);
  }

  function activate(row: TreeRow) {
    const n = row.node;
    if (n.kind === "object") onSelectObject({ connectionId: n.connectionId, kind: n.objectKind, path: n.path });
    else if (n.kind === "saved") props.onOpenSaved(n.query);
    else if (n.kind === "note") {
      if (n.failed) tree.retry(n.id);
      else if (n.showSystem) tree.setShowSystem(n.showSystem.connectionId, n.showSystem.database, true);
    } else if (row.expandable) toggle(row);
  }

  function refreshBranch(id: ConnectionId) {
    if (!openIds.has(id)) return;
    tree.refresh(id);
    props.onRefresh(id);
  }

  function copyHost(c: ConnectionConfig) {
    void navigator.clipboard?.writeText(connectionTarget(c)).catch(() => {});
  }

  const isReadOnly = (id: ConnectionId) => connections.find((x) => x.id === id)?.readOnly ?? false;

  /** "New table..." for a database, schema or Tables folder; absent on Read-only Connections (D7). */
  function newTableItem(connectionId: ConnectionId, database: string, schema: string | null): MenuItem | null {
    const newTable = props.onNewTable;
    if (!newTable || isReadOnly(connectionId)) return null;
    return {
      key: "new-table",
      label: "New table...",
      icon: <Icon name="plus" />,
      onSelect: () => newTable(connectionId, database, schema),
    };
  }

  /** Back up... (where the row is what a Backup holds) and Restore..., when the App offers them. */
  function backupItems(connectionId: ConnectionId, database: string, schema: string | null, backUp: boolean): MenuItem[] {
    const items: MenuItem[] = [];
    const backup = props.onBackup;
    if (backup && backUp) {
      items.push({ key: "backup", label: "Back up...", icon: <Icon name="save" />, onSelect: () => backup({ connectionId, database, schema }) });
    }
    const restore = props.onRestore;
    if (restore) {
      items.push({ key: "restore", label: "Restore...", icon: <Icon name="history" />, onSelect: () => restore({ connectionId, database, schema }) });
    }
    return items;
  }

  function menuFor(row: TreeRow): { label: string; items: MenuItem[] } | null {
    const n = row.node;
    switch (n.kind) {
      case "connection": {
        const c = n.connection;
        const open = n.state === "open";
        return {
          label: c.name,
          items: connectionMenu(
            c,
            { open, groups, newQueryKey: newQueryKey ?? undefined, refreshKey: refreshKey ?? undefined },
            {
              toggleOpen: () => (open ? props.onCloseConnection(c.id) : openConnection(c)),
              newQuery: () => props.onNewQuery(c.id),
              newVisualQuery: () => props.onNewVisualQuery(c.id),
              newSchemaModel: () => props.onNewSchemaModel(c.id, c.dialect === "sqlite" ? "main" : (c.database ?? ""), null),
              ...(props.onRestore && { restore: () => props.onRestore?.({ connectionId: c.id, database: null, schema: null }) }),
              edit: () => props.onEditConnection(c),
              duplicate: () => props.onDuplicateConnection(c),
              copyHost: () => copyHost(c),
              refresh: () => refreshBranch(c.id),
              move: (to) => props.onMoveConnection(c.id, to),
              newGroup: props.onNewGroup,
              clearHistory: () => setAsk({ kind: "clear", connection: c }),
              remove: () => setAsk({ kind: "delete", connection: c }),
            },
          ),
        };
      }
      case "database": {
        const c = connections.find((x) => x.id === n.connectionId);
        const shown = tree.branches[n.connectionId]?.showSystem.has(n.name) ?? false;
        const items: MenuItem[] = [];
        if (c?.dialect === "postgres") {
          items.push({
            key: "system",
            label: "Show system schemas",
            checked: shown,
            onSelect: () => tree.setShowSystem(n.connectionId, n.name, !shown),
          });
        }
        // PostgreSQL tables live in a schema, so its database row offers no New table.
        const newTable = c?.dialect === "postgres" ? null : newTableItem(n.connectionId, n.name, null);
        if (newTable) items.push({ ...newTable, separatorBefore: items.length > 0 });
        items.push({
          key: "model",
          label: "Reverse-engineer into a Schema Model",
          icon: <Icon name="layers" />,
          separatorBefore: items.length > 0 && !newTable,
          onSelect: () => props.onNewSchemaModel(n.connectionId, n.name, null),
        });
        const transfer = props.onTransfer;
        // PostgreSQL copies a schema, so its database row offers no Transfer data.
        if (transfer && c?.dialect !== "postgres") {
          items.push({
            key: "transfer",
            label: "Transfer data...",
            icon: <Icon name="swap" />,
            onSelect: () => transfer({ connectionId: n.connectionId, database: n.name, schema: null, table: null }),
          });
        }
        items.push(...backupItems(n.connectionId, n.name, null, c?.dialect !== "postgres"));
        return { label: n.name, items };
      }
      case "schema": {
        const newTable = newTableItem(n.connectionId, n.database, n.name);
        return {
          label: n.name,
          items: [
            ...(newTable ? [newTable] : []),
            {
              key: "model",
              label: "Reverse-engineer into a Schema Model",
              icon: <Icon name="layers" />,
              onSelect: () => props.onNewSchemaModel(n.connectionId, n.database, n.name),
            },
            ...(props.onTransfer
              ? [
                  {
                    key: "transfer",
                    label: "Transfer data...",
                    icon: <Icon name="swap" />,
                    onSelect: () => props.onTransfer?.({ connectionId: n.connectionId, database: n.database, schema: n.name, table: null }),
                  },
                ]
              : []),
            ...backupItems(n.connectionId, n.database, n.name, true),
          ],
        };
      }
      case "folder": {
        const newTable = n.objectKind === "table" ? newTableItem(n.connectionId, n.database, n.schema) : null;
        return newTable ? { label: n.label, items: [newTable] } : null;
      }
      case "object": {
        const add = props.onAddToVisualQuery;
        const addItem: MenuItem | null =
          add && (n.objectKind === "table" || n.objectKind === "view") && (props.visualQueryConnection ?? n.connectionId) === n.connectionId
            ? {
                key: "add-visual",
                label: "Add to Visual Query",
                icon: <Icon name="visualQuery" />,
                onSelect: () => add({ connectionId: n.connectionId, kind: n.objectKind, path: n.path }),
              }
            : null;
        if (n.objectKind === "view") return addItem ? { label: n.path.name, items: [addItem] } : null;
        if (n.objectKind !== "table") return null;
        const selection: Selection = { connectionId: n.connectionId, kind: "table", path: n.path };
        const items: MenuItem[] = [
          { key: "open", label: "Open", icon: <Icon name="table" />, onSelect: () => onSelectObject(selection) },
        ];
        if (addItem) items.push(addItem);
        const design = props.onDesignTable;
        if (design) items.push({ key: "design", label: "Design table", icon: <Icon name="edit" />, onSelect: () => design(selection) });
        const lineage = props.onShowLineage;
        if (lineage) items.push({ key: "lineage", label: "Show lineage", icon: <Icon name="flow" />, onSelect: () => lineage(selection) });
        const exportTable = props.onExportTable;
        if (exportTable) {
          items.push({ key: "export", label: "Export...", icon: <Icon name="export" />, onSelect: () => exportTable(selection) });
        }
        const importTable = props.onImportTable;
        if (importTable) {
          items.push({ key: "import", label: "Import...", icon: <Icon name="import" />, onSelect: () => importTable(selection) });
        }
        const transfer = props.onTransfer;
        if (transfer) {
          items.push({
            key: "transfer",
            label: "Transfer data...",
            icon: <Icon name="swap" />,
            onSelect: () => transfer({ connectionId: n.connectionId, database: n.path.database, schema: n.path.schema, table: n.path.name }),
          });
        }
        const drop = props.onDropTable;
        if (drop && !isReadOnly(n.connectionId)) {
          items.push({
            key: "drop",
            label: "Drop table...",
            icon: <Icon name="trash" />,
            danger: true,
            separatorBefore: true,
            onSelect: () => drop(n.connectionId, n.path),
          });
        }
        return { label: n.path.name, items };
      }
      case "savedRoot": {
        const openList = props.onOpenSavedList;
        if (!openList) return null;
        return {
          label: "Saved Queries",
          items: [{ key: "list", label: "Open the list", icon: <Icon name="list" />, onSelect: openList }],
        };
      }
      case "saved":
        return {
          label: n.query.name,
          items: [
            {
              key: "open",
              label: "Open",
              icon: <Icon name={n.query.kind === "visual" ? "visualQuery" : "fileQuery"} />,
              onSelect: () => props.onOpenSaved(n.query),
            },
            { key: "rename", label: "Rename...", icon: <Icon name="edit" />, onSelect: () => setRenaming(n.query) },
            {
              key: "delete",
              label: "Delete...",
              icon: <Icon name="trash" />,
              danger: true,
              separatorBefore: true,
              onSelect: () => setAsk({ kind: "deleteSaved", query: n.query }),
            },
          ],
        };
      default:
        return null;
    }
  }

  function openMenu(row: TreeRow, x: number, y: number) {
    const m = menuFor(row);
    if (!m) return;
    setMenu({ rowId: row.node.id, ...m, x, y });
  }

  function openMenuAtRow(row: TreeRow) {
    const box = rowEls.current.get(row.node.id)?.getBoundingClientRect();
    openMenu(row, (box?.left ?? 0) + 24, box?.bottom ?? 0);
  }

  function closeMenu() {
    const id = menu?.rowId;
    setMenu(null);
    if (id) rowEls.current.get(id)?.focus({ preventScroll: true });
  }

  // ---- Keys ----
  useCommandKeys(
    keysActive
      ? {
          "tree.filter": () => {
            filterRef.current?.focus();
            filterRef.current?.select();
          },
          "tree.refresh": () => {
            const id = (currentRow ? branchOf(currentRow.node) : null) ?? selected?.connectionId ?? null;
            if (id) refreshBranch(id);
          },
        }
      : {},
    { region: rootRef },
  );

  const MOVES: Record<string, TreeKey> = {
    ArrowDown: "ArrowDown",
    ArrowUp: "ArrowUp",
    Home: "Home",
    End: "End",
    ArrowRight: "ArrowRight",
    ArrowLeft: "ArrowLeft",
  };

  function onTreeKey(e: React.KeyboardEvent) {
    const onRow = (e.target as HTMLElement).getAttribute("role") === "treeitem";
    const key = MOVES[e.key];
    if (key && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const r = moveFocus(rows, current, key, filtering);
      if (r.expand) {
        const row = rows[indexOf.get(r.expand) ?? -1];
        if (row) expandRow(row);
      }
      if (r.collapse) tree.collapse(r.collapse);
      if (r.focus) moveTo(r.focus);
      return;
    }
    if (!onRow || !currentRow) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const n = currentRow.node;
      if (n.kind === "connection" && n.state !== "open") openConnection(n.connection);
      else activate(currentRow);
    } else if (e.key === "Delete" && currentRow.node.kind === "connection") {
      e.preventDefault();
      setAsk({ kind: "delete", connection: currentRow.node.connection });
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      openMenuAtRow(currentRow);
    }
  }

  function onFilterKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (filter) setFilter("");
      else if (current) moveTo(current);
    } else if (e.key === "ArrowDown" && rows.length > 0) {
      e.preventDefault();
      moveTo(rows[0].node.id);
    }
  }

  // ---- Rows ----
  const chevron = (row: TreeRow, onClick?: () => void) =>
    row.expandable ? (
      <span
        className="tree-chevron-hit"
        aria-hidden="true"
        onClick={(e) => {
          e.stopPropagation();
          (onClick ?? (() => toggle(row)))();
        }}
      >
        <Icon name={row.expanded ? "chevronDown" : "chevronRight"} className="tree-chevron" size={14} />
      </span>
    ) : (
      <span className="tree-chevron-space" aria-hidden="true" />
    );

  const action = (label: string, title: string, icon: IconName, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, extra?: object) => (
    <button
      type="button"
      className="icon-button tree-action"
      tabIndex={-1}
      aria-label={label}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      {...extra}
    >
      <Icon name={icon} size={14} />
    </button>
  );

  const moreButton = (row: TreeRow, label: string) =>
    action(
      `More actions for ${label}`,
      "More",
      "more",
      (e) => {
        const box = e.currentTarget.getBoundingClientRect();
        openMenu(row, box.left, box.bottom);
      },
      { "aria-haspopup": "menu", "aria-expanded": menu?.rowId === row.node.id },
    );

  function content(row: TreeRow): ReactNode {
    const n = row.node;
    switch (n.kind) {
      case "connection": {
        const c = n.connection;
        const open = n.state === "open";
        const failure = props.openStatus?.get(c.id);
        return (
          <>
            {chevron(row)}
            <DbMark dialect={c.dialect} open={open} label={`${DIALECT_LABEL[c.dialect]}, ${n.state === "failed" ? "last connect failed" : n.state}`} />
            <span className="tree-name tree-connection-name">{c.name}</span>
            {c.production && (
              <span className="safety-tag safety-tag-production tree-prod">
                <span aria-hidden="true">PROD</span>
                <span className="visually-hidden">Production</span>
              </span>
            )}
            {c.readOnly && (
              <span className="tree-lock" role="img" aria-label="Read-only" title="Read-only">
                <Icon name="lock" size={14} />
              </span>
            )}
            {n.state === "connecting" && (
              <span className="tree-conn-state" aria-hidden="true">
                Connecting...
              </span>
            )}
            {n.state === "failed" && (
              <span className="tree-conn-state tree-conn-failed" aria-hidden="true" title={failure?.s === "failed" ? failure.error : undefined}>
                <Icon name="warning" size={14} />
                Failed
              </span>
            )}
            <span className="tree-row-actions">
              {open
                ? action(`Close ${c.name}`, "Close", "unplug", () => props.onCloseConnection(c.id))
                : action(`Open ${c.name}`, "Open", "plug", () => openConnection(c), { disabled: n.state === "connecting" })}
              {action(`Edit ${c.name}`, "Edit Connection", "edit", () => props.onEditConnection(c))}
              {moreButton(row, c.name)}
            </span>
          </>
        );
      }
      case "database":
        return (
          <>
            {chevron(row)}
            <Icon name="database" size={14} />
            <Name text={n.name} match={row.match} />
            <span className="tree-row-actions">{moreButton(row, n.name)}</span>
          </>
        );
      case "schema":
        return (
          <>
            {chevron(row)}
            <Icon name="layers" size={14} />
            <Name text={n.name} match={row.match} />
            <span className="tree-row-actions">{moreButton(row, n.name)}</span>
          </>
        );
      case "folder":
        return (
          <>
            {chevron(row)}
            <Icon name="folder" size={14} />
            <span className="tree-name">{n.label}</span>
            <span className="tree-count">{n.count.toLocaleString("en-US")}</span>
          </>
        );
      case "object":
        return (
          <>
            {chevron(row)}
            <Icon name={KIND_ICON[n.objectKind]} size={14} />
            <Name text={n.path.name} match={row.match} />
            {n.objectKind === "table" && n.rows != null && <span className="tree-count tree-rows">{n.rows.toLocaleString("en-US")}</span>}
          </>
        );
      case "note":
        return (
          <>
            <span className={n.failed ? "tree-note-text error-text" : "tree-note-text"} title={n.text}>
              {n.text}
            </span>
            {n.failed && (
              <button
                type="button"
                className="button button-small tree-retry"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  tree.retry(n.id);
                }}
              >
                Try again
              </button>
            )}
            {n.showSystem && (
              <button
                type="button"
                className="button button-small tree-retry"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  if (n.showSystem) tree.setShowSystem(n.showSystem.connectionId, n.showSystem.database, true);
                }}
              >
                Show system schemas
              </button>
            )}
          </>
        );
      case "savedRoot":
        return (
          <>
            {chevron(row)}
            <Icon name="bookmark" size={14} />
            <span className="tree-name tree-connection-name">Saved Queries</span>
            <span className="tree-count tree-count-quiet">{n.count}</span>
            {props.onOpenSavedList && (
              <span className="tree-row-actions">
                {action("Open the Saved Queries list", "Open the list", "list", () => props.onOpenSavedList?.())}
              </span>
            )}
          </>
        );
      case "saved": {
        const visual = n.query.kind === "visual";
        // A Visual Query always has a Connection, so none means it was removed (D2).
        const meta = n.opensOn ?? (visual ? "Connection removed" : null);
        return (
          <>
            {chevron(row)}
            <Icon name={visual ? "visualQuery" : "fileQuery"} size={14} />
            <Name text={n.query.name} match={row.match} />
            {meta && <span className="tree-meta">{meta}</span>}
          </>
        );
      }
    }
  }

  function renderRow(row: TreeRow, i: number) {
    const n = row.node;
    const isSelected = n.id === selectedRowId;
    const cls = [
      "tree-row",
      `tree-row-${n.kind}`,
      isSelected && "tree-row-selected",
      menu?.rowId === n.id && "tree-row-menu-open",
      n.kind === "connection" && n.state !== "open" && "tree-row-closed",
    ]
      .filter(Boolean)
      .join(" ");
    let title: string | undefined;
    if (n.kind === "object") title = n.path.name;
    else if (n.kind === "saved") {
      const what = n.query.kind === "visual" ? "Visual Query" : "Saved Query";
      title = n.opensOn ? `${n.query.name}, ${what} on ${n.opensOn}` : n.query.kind === "visual" ? `${n.query.name}, Connection removed` : n.query.name;
    }
    else if (n.kind === "savedRoot") title = "Saved Queries, kept for every Connection";
    const draggable = n.kind === "object" && (n.objectKind === "table" || n.objectKind === "view");
    return (
      <div
        key={n.id}
        ref={(el) => {
          if (el) rowEls.current.set(n.id, el);
          else rowEls.current.delete(n.id);
        }}
        role="treeitem"
        aria-level={row.level + 1}
        aria-expanded={row.expandable ? row.expanded : undefined}
        aria-selected={isSelected}
        aria-label={labelOf(n)}
        tabIndex={n.id === current ? 0 : -1}
        className={cls}
        style={indent(row.level)}
        data-level={row.level}
        data-index={i}
        title={title}
        // D15: tables and views drag onto a Visual Query canvas.
        draggable={draggable || undefined}
        onDragStart={
          draggable && n.kind === "object"
            ? (e) => {
                const object: Selection = { connectionId: n.connectionId, kind: n.objectKind, path: n.path };
                e.dataTransfer.setData(OBJECT_DRAG_TYPE, JSON.stringify(object));
                e.dataTransfer.effectAllowed = "copy";
              }
            : undefined
        }
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return;
          setFocusId(n.id);
          tell(branchOf(n));
        }}
        onClick={() => {
          setFocusId(n.id);
          if (n.kind === "connection") {
            if (n.state === "open") toggle(row);
          } else activate(row);
        }}
        onDoubleClick={() => {
          if (n.kind === "connection" && n.state === "closed") openConnection(n.connection);
        }}
        onContextMenu={(e) => {
          if (!menuFor(row)) return;
          e.preventDefault();
          setFocusId(n.id);
          openMenu(row, e.clientX, e.clientY);
        }}
      >
        <Guides g={guides[i]} />
        {content(row)}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="one-tree"
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) tell(null);
      }}
    >
      <div className="tree-filter">
        <Icon name="search" size={14} />
        <input
          ref={filterRef}
          type="search"
          className="tree-filter-input"
          aria-label="Filter objects"
          placeholder="Filter objects"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKey}
          spellCheck={false}
          autoComplete="off"
        />
        {filterKey && !filter && <Kbd keys={filterKey} />}
      </div>
      <div
        ref={scrollRef}
        className="tree-scroll"
        role="tree"
        aria-label="Connections"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onTreeKey}
      >
        {drawn.map((part) =>
          typeof part === "number" ? renderRow(rows[part], part) : <div key={part.key} role="presentation" style={{ height: part.rows * rowHeight }} />,
        )}
        {filtering && rows.length === 0 && <p className="tree-empty muted">Nothing matches "{filter.trim()}".</p>}
      </div>
      {menu && <PlacedMenu menu={menu} onClose={closeMenu} />}
      {ask?.kind === "delete" && (
        <Dialog title={`Delete ${ask.connection.name}?`} size="confirm" onClose={() => setAsk(null)}>
          <div className="dialog-body">
            <p>Its saved password is removed too. This cannot be undone.</p>
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" data-autofocus onClick={() => setAsk(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger-fill"
              onClick={() => {
                const id = ask.connection.id;
                setAsk(null);
                props.onDeleteConnection(id);
              }}
            >
              Delete Connection
            </button>
          </footer>
        </Dialog>
      )}
      {ask?.kind === "clear" && (
        <Dialog title="Clear Query History" size="confirm" onClose={() => setAsk(null)}>
          <div className="dialog-body">
            <p>Clear the Query History of {ask.connection.name}? Saved Queries are kept.</p>
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button type="button" className="button" data-autofocus onClick={() => setAsk(null)}>
              Keep it
            </button>
            <button
              type="button"
              className="button button-danger-fill"
              onClick={() => {
                const id = ask.connection.id;
                setAsk(null);
                props.onClearHistory(id);
              }}
            >
              Clear
            </button>
          </footer>
        </Dialog>
      )}
      {ask?.kind === "deleteSaved" && (
        <Dialog
          title="Delete Saved Query"
          size="confirm"
          onClose={() => {
            setAsk(null);
            setAskError(null);
          }}
        >
          <div className="dialog-body">
            <p>Delete the Saved Query "{ask.query.name}"?</p>
            {askError && (
              <p className="error-text" role="alert">
                {askError}
              </p>
            )}
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button
              type="button"
              className="button"
              data-autofocus
              onClick={() => {
                setAsk(null);
                setAskError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger-fill"
              onClick={() => {
                const q = ask.query;
                deleteSavedQuery(q.id)
                  .then(() => {
                    setAsk(null);
                    setAskError(null);
                    props.onSavedChanged?.();
                  })
                  .catch((e) => setAskError(errorText(e)));
              }}
            >
              Delete
            </button>
          </footer>
        </Dialog>
      )}
      {renaming && (
        <SaveQueryDialog
          sql={renaming.sql}
          existing={renaming}
          onCancel={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null);
            props.onSavedChanged?.();
          }}
        />
      )}
    </div>
  );
}
