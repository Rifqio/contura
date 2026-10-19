// The window's tab model (PR5): Home, Settings, Schema Model and diagram tabs belong to the window and
// survive a Group change; query and table tabs belong to the place.
import type { CompareDatabase, ConnectionId, DialectKind, GroupId, ObjectKind, ObjectPath, SchemaModel, VisualQuery } from "../api/types";
import type { ImportTarget } from "../jobs/importModel";
import type { QueryTabDoc } from "../query/QueryTab";
import type { ModelDoc } from "../schema/SchemaBuilder";
import { objectKey } from "../objectPath";

/** Where the window's Connections come from: a Group, or the Ungrouped Connections. */
export type Place = { kind: "group"; groupId: GroupId } | { kind: "ungrouped" };

export type SettingsSection = "appearance" | "editor" | "keymap" | "ai" | "dataFolder" | "about";

/** A table, view, routine or trigger chosen in the object tree. */
export interface Selection {
  connectionId: ConnectionId;
  kind: ObjectKind;
  path: ObjectPath;
}

/** What a design tab designs: a table that exists, or a new one in a database (and schema). */
export type DesignTabTarget =
  | { kind: "alter"; path: ObjectPath }
  | { kind: "create"; scope: { database: string; schema: string | null }; id: string };

/**
 * A Visual Query tab as the app keeps it, and as its draft is saved. `connectionId` is null when
 * its Connection was removed (P10): the tab still opens and offers one of the model's Dialect.
 * `savedJson` is the model as last saved, for the dirty mark.
 */
export type VisualTabDoc = {
  id: string;
  name: string;
  connectionId: ConnectionId | null;
  database: string | null;
  model: VisualQuery;
  savedId: string | null;
  savedJson: string | null;
  /** Card widths dragged on the canvas, by table id (item 25); kept with the draft, not in the saved query. */
  widths?: Record<string, number>;
};

/**
 * Item 1: where a table opens. A tab already open for it is shown. Otherwise a single click (`newTab` false)
 * takes the place of the preview tab, if there is one with nothing unsaved, and is the preview itself; a double
 * click opens a tab that stays (and keeps the preview tab it was in).
 */
export function placeObject(tabs: WorkTab[], selection: Selection, key: string, newTab: boolean, dirty: ReadonlySet<string>): WorkTab[] {
  const at = tabs.findIndex((t) => t.kind === "object" && t.key === key);
  if (at >= 0) {
    const t = tabs[at];
    // A double click on the preview's own table keeps it.
    if (newTab && t.kind === "object" && t.preview) return tabs.map((x, i) => (i === at ? { ...t, preview: false } : x));
    return tabs;
  }
  const tab: WorkTab = { kind: "object", key, selection, preview: !newTab };
  if (newTab) return [...tabs, tab];
  const preview = tabs.findIndex((t) => t.kind === "object" && t.preview && !dirty.has(t.key));
  if (preview < 0) return [...tabs, tab];
  return tabs.map((t, i) => (i === preview ? tab : t));
}

/** A tab of the place; the Saved Queries list is one, since Saved Queries are listed beside the place's Connections. */
export type WorkTab =
  /** `preview`: opened with a single click; the next single-click open replaces it (item 1). */
  | { kind: "object"; key: string; selection: Selection; preview?: boolean }
  | { kind: "design"; key: string; connectionId: ConnectionId; target: DesignTabTarget }
  | { kind: "query"; doc: QueryTabDoc }
  | { kind: "visual"; doc: VisualTabDoc }
  | { kind: "savedQueries" }
  /** An Import tab; never saved in place drafts, so a restart drops it (D20). */
  | {
      kind: "import";
      key: string;
      /** Stays the same when the key changes (Choose Connection..., a SQL file), so the tab keeps its state. */
      uid?: string;
      connectionId: ConnectionId;
      target: ImportTarget;
    }
  /** A table's lineage (step 6+): read only, so never saved in place drafts. */
  | { kind: "lineage"; key: string; connectionId: ConnectionId; path: ObjectPath };

/** Where a Data Transfer starts: the source database (and schema), and a table to tick first. */
export interface TransferSeed {
  connectionId: ConnectionId;
  database: string;
  schema: string | null;
  table: string | null;
}

/**
 * Where a Schema Compare starts. A database source fills the left side (tree menus); a model
 * source comes from the Schema Builder's Apply to Connection..., with `notice` set while its
 * DBML has an error and the compare uses the last valid version.
 */
export interface CompareSeed {
  source:
    | ({ kind: "database" } & CompareDatabase)
    | { kind: "model"; model: SchemaModel; path: string | null; dialect: DialectKind; notice: string | null };
  target: CompareDatabase | null;
}

/** A tab of the window. */
export type WindowTab =
  | { kind: "home" }
  /** `seq` counts the requests, so asking for the section shown last moves there again. */
  | { kind: "settings"; section: SettingsSection; seq?: number }
  | { kind: "schema"; id: string; doc: ModelDoc }
  /** A diagram, `<name>.flow` in Contura's diagrams folder; one tab per name. */
  | { kind: "flow"; name: string }
  /**
   * A Data Transfer (step 8): a window tab, since it spans two Connections. `title` and `dirty`
   * come from the tab ("pos_live to analytics", set up but not run); never saved.
   */
  | { kind: "transfer"; id: string; seed: TransferSeed; title: string; dirty: boolean }
  /**
   * A Schema Compare (step 10): a window tab, since it spans two Connections. `title` ("freight-staging
   * to freight-prod") and `connectionId` (the target, for its PROD chip) come from the tab.
   */
  | { kind: "compare"; id: string; seed: CompareSeed; title: string; connectionId: ConnectionId | null };

export type AnyTab = WorkTab | WindowTab;

export function tabKey(t: AnyTab): string {
  switch (t.kind) {
    case "home":
      return "home";
    case "settings":
      return "settings";
    case "schema":
      return `schema:${t.id}`;
    case "flow":
      return `flow:${t.name}`;
    case "transfer":
      return `transfer:${t.id}`;
    case "compare":
      return `compare:${t.id}`;
    case "query":
      return `query:${t.doc.id}`;
    case "visual":
      return `visual:${t.doc.id}`;
    case "savedQueries":
      return "savedQueries";
    case "object":
    case "design":
    case "import":
    case "lineage":
      return t.key;
  }
}

/** The key of a table's design tab; never the same as the table tab's `objectKey`. */
export function designKey(connectionId: ConnectionId, path: ObjectPath): string {
  return `design\u0000${objectKey(connectionId, "table", path)}`;
}

/** The key of an Import tab, from where it was opened; a later target change keeps it. */
export function importKey(connectionId: ConnectionId, target: ImportTarget): string {
  return target.kind === "table"
    ? `import\u0000${objectKey(connectionId, "table", target.path)}`
    : `import\u0000${connectionId}\u0000database\u0000${target.database}`;
}

/** The key of a table's lineage tab. */
export function lineageKey(connectionId: ConnectionId, path: ObjectPath): string {
  return `lineage\u0000${objectKey(connectionId, "table", path)}`;
}

/** The key of a New table tab. */
export function newDesignKey(id: string): string {
  return `design\u0000new\u0000${id}`;
}

/**
 * A tab tied to one object of a Connection: a table, view, routine or trigger tab, or a design tab.
 * These close with their Connection and are asked about before they lose Pending Edits.
 */
export function objectTabOf(t: AnyTab): { key: string; connectionId: ConnectionId; path: ObjectPath | null } | null {
  if (t.kind === "object") return { key: t.key, connectionId: t.selection.connectionId, path: t.selection.path };
  if (t.kind === "design") return { key: t.key, connectionId: t.connectionId, path: t.target.kind === "alter" ? t.target.path : null };
  return null;
}

/** The Connection a tab works on, for its mark, chips and Group hue; null for window tabs and tabs without one. */
export function tabConnectionId(t: AnyTab): ConnectionId | null {
  switch (t.kind) {
    case "query":
    case "visual":
      return t.doc.connectionId;
    case "object":
      return t.selection.connectionId;
    case "design":
    case "import":
    case "lineage":
    case "compare":
      return t.connectionId;
    default:
      return null;
  }
}

/** JSON with every object's keys sorted, so two equal values always give the same text. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The canonical text of recent saved models, so the dirty check does not parse on every render. */
const savedCanonical = new Map<string, string | null>();

function canonicalSaved(savedJson: string): string | null {
  const hit = savedCanonical.get(savedJson);
  if (hit !== undefined) return hit;
  let text: string | null;
  try {
    text = canonicalJson(JSON.parse(savedJson));
  } catch {
    text = null;
  }
  if (savedCanonical.size >= 64) {
    const oldest = savedCanonical.keys().next().value;
    if (oldest !== undefined) savedCanonical.delete(oldest);
  }
  savedCanonical.set(savedJson, text);
  return text;
}

/** True when `model` is the model saved as `savedJson`, whatever order its keys were written in. */
export function sameModel(model: VisualQuery, savedJson: string | null): boolean {
  if (savedJson === null) return false;
  const saved = canonicalSaved(savedJson);
  return saved !== null && canonicalJson(model) === saved;
}

/** A Saved Query or Visual Query tab whose text or model differs from what was saved. */
export function isUnsaved(t: AnyTab): boolean {
  if (t.kind === "query") return t.doc.savedId !== null && t.doc.text !== t.doc.savedText;
  if (t.kind === "visual") return t.doc.savedId !== null && !sameModel(t.doc.model, t.doc.savedJson);
  if (t.kind === "transfer") return t.dirty;
  return false;
}

/** Home, then the place's tabs, then the other window tabs in the order they were opened. */
export function stripOrder(windowTabs: WindowTab[], placeTabs: WorkTab[]): AnyTab[] {
  const home = windowTabs.filter((t) => t.kind === "home");
  const rest = windowTabs.filter((t) => t.kind !== "home");
  return [...home, ...placeTabs, ...rest];
}

/**
 * Item 7: moves the tab `from` to where `to` is, in one list: dragged right it lands after `to`, dragged left
 * before it. Unknown keys leave the list as it is.
 */
export function moveTab<T extends AnyTab>(list: T[], from: string, to: string): T[] {
  const a = list.findIndex((t) => tabKey(t) === from);
  const b = list.findIndex((t) => tabKey(t) === to);
  if (a < 0 || b < 0 || a === b) return list;
  const next = [...list];
  const [moved] = next.splice(a, 1);
  next.splice(b, 0, moved);
  return next;
}

/** Which part of the strip a tab is in; a tab moves only inside its own (Home stays first). */
/** Every window tab kind but Home; a Record so a new window kind fails to compile until it is listed here. */
const WINDOW_KINDS: Record<Exclude<WindowTab["kind"], "home">, true> = { settings: true, schema: true, flow: true, transfer: true, compare: true };

export function stripSegment(t: AnyTab): "home" | "place" | "window" {
  if (t.kind === "home") return "home";
  return Object.prototype.hasOwnProperty.call(WINDOW_KINDS, t.kind) ? "window" : "place";
}

/** The tab active once `closing` goes: the same one if another closes, else its right neighbour, else its left. */
export function afterClose(order: string[], active: string | null, closing: string): string | null {
  if (active !== closing) return active;
  const i = order.indexOf(closing);
  if (i < 0) return null;
  return order[i + 1] ?? order[i - 1] ?? null;
}
