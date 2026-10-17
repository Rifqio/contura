// The window's tab model (PR5): Home, Settings and Schema Model tabs belong to the window and
// survive a Group change; query and table tabs belong to the place.
import type { ConnectionId, GroupId, ObjectKind, ObjectPath } from "../api/types";
import type { QueryTabDoc } from "../query/QueryTab";
import type { ModelDoc } from "../schema/SchemaBuilder";

/** Where the window's Connections come from: a Group, or the Ungrouped Connections. */
export type Place = { kind: "group"; groupId: GroupId } | { kind: "ungrouped" };

export type SettingsSection = "appearance" | "editor" | "keymap" | "ai" | "dataFolder" | "about";

/** A table, view, routine or trigger chosen in the object tree. */
export interface Selection {
  connectionId: ConnectionId;
  kind: ObjectKind;
  path: ObjectPath;
}

/** A tab of the place; the Saved Queries list is one, since Saved Queries are listed beside the place's Connections. */
export type WorkTab =
  | { kind: "object"; key: string; selection: Selection }
  | { kind: "query"; doc: QueryTabDoc }
  | { kind: "savedQueries" };

/** A tab of the window. */
export type WindowTab =
  | { kind: "home" }
  /** `seq` counts the requests, so asking for the section shown last moves there again. */
  | { kind: "settings"; section: SettingsSection; seq?: number }
  | { kind: "schema"; id: string; doc: ModelDoc };

export type AnyTab = WorkTab | WindowTab;

export function tabKey(t: AnyTab): string {
  switch (t.kind) {
    case "home":
      return "home";
    case "settings":
      return "settings";
    case "schema":
      return `schema:${t.id}`;
    case "query":
      return `query:${t.doc.id}`;
    case "savedQueries":
      return "savedQueries";
    case "object":
      return t.key;
  }
}

/** Home, then the place's tabs, then the other window tabs in the order they were opened. */
export function stripOrder(windowTabs: WindowTab[], placeTabs: WorkTab[]): AnyTab[] {
  const home = windowTabs.filter((t) => t.kind === "home");
  const rest = windowTabs.filter((t) => t.kind !== "home");
  return [...home, ...placeTabs, ...rest];
}

/** The tab active once `closing` goes: the same one if another closes, else its right neighbour, else its left. */
export function afterClose(order: string[], active: string | null, closing: string): string | null {
  if (active !== closing) return active;
  const i = order.indexOf(closing);
  if (i < 0) return null;
  return order[i + 1] ?? order[i - 1] ?? null;
}
