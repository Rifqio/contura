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
  | "flow.delete"
  | "quickOpen.show"
  | "palette.show"
  | "grid.followKey"
  | "grid.rowsPointingHere"
  | "grid.moveColumnLeft"
  | "grid.moveColumnRight"
  | "nav.back"
  | "nav.forward";

/** Pairs that may share a key: the second runs only with focus in its region (Ctrl+N in the Ask panel). */
export const REGION_SHARED_KEYS: readonly { keys: string; ids: readonly [CommandId, CommandId] }[] = [{ keys: "Ctrl+N", ids: ["connection.new", "assistant.newChat"] }];

/** The palette's prefix for a command, "Query: New query", as VS Code's command categories. */
export type CommandCategory = "Query" | "Editor" | "AI" | "Tabs" | "View" | "Connection" | "Tree" | "Groups" | "Data" | "Visual Query" | "Diagram";

export interface Command {
  id: CommandId;
  title: string;
  category: CommandCategory;
  /** Printed form (Ctrl, Shift, Alt, then the key); the first is the hint. */
  keys: string[];
  /** App commands run anywhere; editor commands only inside an editor. */
  scope: "app" | "editor";
  /**
   * Its keys belong to it only with focus in an owner's region (a grid); anywhere else they are left to the page, so a
   * text field keeps them (Shift+Option+Left selects a word on a Mac).
   */
  regionOnly?: true;
}

const app = (category: CommandCategory, id: CommandId, title: string, keys: string[] = []): Command => ({ id, title, category, keys, scope: "app" });
const editor = (category: CommandCategory, id: CommandId, title: string, keys: string[] = []): Command => ({
  id,
  title,
  category,
  keys,
  scope: "editor",
});

export const COMMANDS: readonly Command[] = [
  editor("Query", "query.run", "Run the current statement", ["Ctrl+Enter"]),
  editor("Query", "query.runAll", "Run all", ["Ctrl+Shift+Enter"]),
  // No default key (PR12).
  app("Query", "query.explain", "Explain"),
  app("Query", "query.format", "Format", ["Shift+Alt+F"]),
  app("Query", "query.save", "Save", ["Ctrl+S"]),
  app("Query", "query.new", "New query", ["Ctrl+T"]),
  app("Tabs", "tab.close", "Close tab", ["Ctrl+W"]),
  app("Tabs", "tab.next", "Next tab", ["Ctrl+Tab", "Ctrl+PageDown"]),
  app("Tabs", "tab.previous", "Previous tab", ["Ctrl+Shift+Tab", "Ctrl+PageUp"]),
  app("Tabs", "tab.reopen", "Reopen closed tab", ["Ctrl+Shift+T"]),
  // UX step 3, ruling 5: Tab stays in a grid, so F6 moves between the panes (Windows apps).
  app("View", "pane.next", "Next pane", ["F6"]),
  app("View", "pane.previous", "Previous pane", ["Shift+F6"]),
  app("Connection", "connection.new", "New Connection", ["Ctrl+N"]),
  app("Tree", "tree.filter", "Filter", ["Ctrl+Shift+F"]),
  app("Tree", "tree.refresh", "Refresh schema", ["F5"]),
  app("View", "home.open", "Home", ["Ctrl+Shift+H"]),
  app("View", "settings.open", "Settings", ["Ctrl+,"]),
  // S4: Ctrl+1 to Ctrl+8 go to that tab and Ctrl+9 to the last, as in Edge; the Groups moved to Ctrl+Alt+1 to 9.
  ...GROUP_IDS.map((n) => app("Tabs", `tab.goto.${n}`, n === "9" ? "Go to the last tab" : `Go to tab ${n}`, [`Ctrl+${n}`])),
  ...GROUP_IDS.map((n) => app("Groups", `group.open.${n}`, `Open Group ${n}`, [`Ctrl+Alt+${n}`])),
  app("AI", "assistant.toggle", "AI assistant", ["Ctrl+Alt+I"]),
  app("AI", "assistant.newChat", "New chat in the Ask panel", ["Ctrl+Shift+N", "Ctrl+N"]),
  editor("AI", "editor.ask", "Ask AI", ["Ctrl+I"]),
  editor("Editor", "editor.quickFix", "Quick fix", ["Ctrl+.", "Alt+Enter"]),
  editor("Editor", "editor.rename", "Rename", ["F2"]),
  editor("Editor", "editor.definition", "Go to definition", ["F12"]),
  editor("Editor", "editor.parameterHints", "Parameter hints", ["Ctrl+Shift+Space"]),
  app("Query", "history.toggle", "Query History"),
  // Step 6 (D9): each Visual Query tab registers these with its region, so the focused tab wins.
  app("Visual Query", "visualQuery.openInEditor", "Open the SQL in the editor", ["Ctrl+Shift+E"]),
  app("Visual Query", "diagram.toggle", "Show or hide the diagram", ["Ctrl+Shift+D"]),
  // Step 7 (D21): each table grid and result registers export.open with its region.
  app("Data", "export.open", "Export...", ["Ctrl+E"]),
  app("Diagram", "flow.fromMermaid", "New flow from Mermaid"),
  // Step 6+: the New diagram sheet, and the open diagram's file actions.
  app("Diagram", "flow.new", "New diagram", ["Ctrl+Alt+N"]),
  app("Diagram", "flow.saveCopy", "Save a copy as..."),
  app("Diagram", "flow.rename", "Rename diagram"),
  app("Diagram", "flow.delete", "Delete diagram"),
  // UX step 6 (S1): VS Code's Quick Open and Command Palette; Ctrl+K as Edge's search key. F1 stays Help.
  app("View", "quickOpen.show", "Quick Open", ["Ctrl+P", "Ctrl+K"]),
  app("View", "palette.show", "Show all commands", ["Ctrl+Shift+P"]),
  // UX step 8 (G8): each table grid registers these with its region (DataGrip F4, Ctrl+B and Alt+F7).
  app("Data", "grid.followKey", "Go to referenced row", ["F4", "Ctrl+B"]),
  app("Data", "grid.rowsPointingHere", "Rows that point here", ["Alt+F7"]),
  // Moving a column, view only: DBeaver's Alt+Shift+Left and Right (its Result Set keys). Each grid registers them
  // with its region, so they act on the focused grid's active column.
  { ...app("Data", "grid.moveColumnLeft", "Move column left", ["Shift+Alt+ArrowLeft"]), regionOnly: true },
  { ...app("Data", "grid.moveColumnRight", "Move column right", ["Shift+Alt+ArrowRight"]), regionOnly: true },
  // Edge's Alt+Left and DataGrip's Ctrl+Alt+Left. Alt+Left acts only with focus in a grid, the tree or a tab's
  // content: a focused strip tab keeps its move and a wizard keeps its Back.
  app("View", "nav.back", "Back", ["Alt+ArrowLeft", "Ctrl+Alt+ArrowLeft"]),
  app("View", "nav.forward", "Forward", ["Alt+ArrowRight", "Ctrl+Alt+ArrowRight"]),
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function commandById(id: string): Command | undefined {
  return BY_ID.get(id as CommandId);
}
