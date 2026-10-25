import type { ConnectionConfig, ConnectionId } from "../api/types";
import type { StatusScreen } from "../components/StatusBar";
import { fileName } from "../home/recent";
import { type WindowTab, type WorkTab, tabConnectionId } from "../shell/tabs";

export interface StatusInput {
  activeWindow: WindowTab | undefined;
  current: WorkTab | undefined;
  treeBranch: ConnectionId | null;
  activeId: ConnectionId | null;
  connections: ConnectionConfig[];
  openIds: ReadonlySet<ConnectionId>;
  versions: ReadonlyMap<ConnectionId, string>;
  dataFolder: string;
  version: string;
}

/** What the left of the status bar says for the screen shown. */
export function statusScreenFor(s: StatusInput): StatusScreen {
  const { activeWindow, current, treeBranch, activeId, connections, openIds, versions, dataFolder, version } = s;
  // D16: while the tree has focus the status bar follows its branch, else the active tab.
  const statusConnectionId =
    treeBranch !== null && !activeWindow
      ? treeBranch
      : current && current.kind !== "savedQueries"
        ? tabConnectionId(current)
        : activeId;
  const statusConnection =
    activeWindow?.kind === "home" ? null : (connections.find((c) => c.id === statusConnectionId) ?? null);
  return activeWindow?.kind === "home"
    ? { kind: "home", connections: connections.length, open: connections.filter((c) => openIds.has(c.id)).length }
    : activeWindow?.kind === "settings"
      ? { kind: "settings", dataFolder, version }
      : activeWindow?.kind === "flow"
        ? { kind: "flow", name: activeWindow.name, fileName: activeWindow.name }
        : activeWindow?.kind === "schema"
          ? {
              kind: "schema",
              // E2: a model with no file yet (a converted ER diagram keeps its name) says it is not saved.
              fileName: activeWindow.doc.path ? fileName(activeWindow.doc.path) : (activeWindow.doc.name ?? "Untitled.dbml"),
              appliedTo: null,
              saved: activeWindow.doc.path !== null,
            }
          : {
              kind: "workspace",
              connection: statusConnection,
              open: !!statusConnection && openIds.has(statusConnection.id),
              serverVersion: statusConnection ? (versions.get(statusConnection.id) ?? null) : null,
            };
}
