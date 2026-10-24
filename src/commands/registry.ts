/** Every command the keyboard can reach, with its VS Code style default keys. */

/** The digits 1 to 9: Ctrl+N goes to tab N (Ctrl+9 the last), Ctrl+Alt+N opens Group N. */
const GROUP_IDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export type CommandId =
  | "query.run"
  | "query.runAll"
  | "query.explain"
  | "query.format"
  | "query.save"
  | "query.new"
  | "tab.close"
  | "tab.next"
  | "tab.previous"
  | "tab.reopen"
  | "pane.next"
  | "pane.previous"
  | "connection.new"
  | "tree.filter"
  | "tree.refresh"
  | "home.open"
  | "settings.open"
  | `group.open.${(typeof GROUP_IDS)[number]}`
  | `tab.goto.${(typeof GROUP_IDS)[number]}`
  | "assistant.toggle"
  | "assistant.newChat"
  | "editor.ask"
  | "editor.quickFix"
  | "editor.rename"
  | "editor.definition"
  | "editor.parameterHints"
  | "history.toggle"
  | "visualQuery.openInEditor"
  | "diagram.toggle"
  | "export.open"
  | "flow.fromMermaid"
  | "flow.new"
  | "flow.saveCopy"
  | "flow.rename"
  | "flow.delete";

/** Pairs that may share a key: the second runs only with focus in its region (Ctrl+N in the Ask panel). */
export const REGION_SHARED_KEYS: readonly { keys: string; ids: readonly [CommandId, CommandId] }[] = [{ keys: "Ctrl+N", ids: ["connection.new", "assistant.newChat"] }];

export interface Command {
  id: CommandId;
  title: string;
  /** Printed form (Ctrl, Shift, Alt, then the key); the first is the hint. */
  keys: string[];
  /** App commands run anywhere; editor commands only inside an editor. */
  scope: "app" | "editor";
}

const app = (id: CommandId, title: string, keys: string[] = []): Command => ({ id, title, keys, scope: "app" });
const editor = (id: CommandId, title: string, keys: string[] = []): Command => ({ id, title, keys, scope: "editor" });

export const COMMANDS: readonly Command[] = [
  editor("query.run", "Run the current statement", ["Ctrl+Enter"]),
  editor("query.runAll", "Run all", ["Ctrl+Shift+Enter"]),
  // No default key (PR12).
  app("query.explain", "Explain"),
  app("query.format", "Format", ["Shift+Alt+F"]),
  app("query.save", "Save", ["Ctrl+S"]),
  app("query.new", "New query", ["Ctrl+T"]),
  app("tab.close", "Close tab", ["Ctrl+W"]),
  app("tab.next", "Next tab", ["Ctrl+Tab", "Ctrl+PageDown"]),
  app("tab.previous", "Previous tab", ["Ctrl+Shift+Tab", "Ctrl+PageUp"]),
  app("tab.reopen", "Reopen closed tab", ["Ctrl+Shift+T"]),
  // UX step 3, ruling 5: Tab stays in a grid, so F6 moves between the panes (Windows apps).
  app("pane.next", "Next pane", ["F6"]),
  app("pane.previous", "Previous pane", ["Shift+F6"]),
  app("connection.new", "New Connection", ["Ctrl+N"]),
  app("tree.filter", "Filter", ["Ctrl+Shift+F"]),
  app("tree.refresh", "Refresh schema", ["F5"]),
  app("home.open", "Home", ["Ctrl+Shift+H"]),
  app("settings.open", "Settings", ["Ctrl+,"]),
  // S4: Ctrl+1 to Ctrl+8 go to that tab and Ctrl+9 to the last, as in Edge; the Groups moved to Ctrl+Alt+1 to 9.
  ...GROUP_IDS.map((n) => app(`tab.goto.${n}`, n === "9" ? "Go to the last tab" : `Go to tab ${n}`, [`Ctrl+${n}`])),
  ...GROUP_IDS.map((n) => app(`group.open.${n}`, `Open Group ${n}`, [`Ctrl+Alt+${n}`])),
  app("assistant.toggle", "AI assistant", ["Ctrl+Alt+I"]),
  app("assistant.newChat", "New chat in the Ask panel", ["Ctrl+Shift+N", "Ctrl+N"]),
  editor("editor.ask", "Ask AI", ["Ctrl+I"]),
  editor("editor.quickFix", "Quick fix", ["Ctrl+.", "Alt+Enter"]),
  editor("editor.rename", "Rename", ["F2"]),
  editor("editor.definition", "Go to definition", ["F12"]),
  editor("editor.parameterHints", "Parameter hints", ["Ctrl+Shift+Space"]),
  app("history.toggle", "Query History"),
  // Step 6 (D9): each Visual Query tab registers these with its region, so the focused tab wins.
  app("visualQuery.openInEditor", "Open the SQL in the editor", ["Ctrl+Shift+E"]),
  app("diagram.toggle", "Show or hide the diagram", ["Ctrl+Shift+D"]),
  // Step 7 (D21): each table grid and result registers export.open with its region.
  app("export.open", "Export...", ["Ctrl+E"]),
  app("flow.fromMermaid", "New flow from Mermaid"),
  // Step 6+: the New diagram sheet, and the open diagram's file actions.
  app("flow.new", "New diagram", ["Ctrl+Alt+N"]),
  app("flow.saveCopy", "Save a copy as..."),
  app("flow.rename", "Rename diagram"),
  app("flow.delete", "Delete diagram"),
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function commandById(id: string): Command | undefined {
  return BY_ID.get(id as CommandId);
}
