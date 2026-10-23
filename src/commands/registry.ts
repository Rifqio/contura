/** Every command the keyboard can reach, with its VS Code style default keys. */

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
  | "connection.new"
  | "tree.filter"
  | "tree.refresh"
  | "home.open"
  | "settings.open"
  | `group.open.${(typeof GROUP_IDS)[number]}`
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
  app("tab.next", "Next tab", ["Ctrl+Tab"]),
  app("tab.previous", "Previous tab", ["Ctrl+Shift+Tab"]),
  app("connection.new", "New Connection", ["Ctrl+N"]),
  app("tree.filter", "Filter", ["Ctrl+Shift+F"]),
  app("tree.refresh", "Refresh schema", ["F5"]),
  app("home.open", "Home", ["Ctrl+Shift+H"]),
  app("settings.open", "Settings", ["Ctrl+,"]),
  ...GROUP_IDS.map((n) => app(`group.open.${n}`, `Open Group ${n}`, [`Ctrl+${n}`])),
  app("assistant.toggle", "AI assistant", ["Ctrl+Alt+I"]),
  app("assistant.newChat", "New chat in the Ask panel", ["Ctrl+Shift+N"]),
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
