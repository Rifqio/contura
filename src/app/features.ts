// What the feature bar offers (item 16, frame Main option A), from what the app can do right now. Features not built
// yet keep their place in the bar, off, saying so; the rest say why they are off when nothing is open.
import type { Feature } from "../components/FeatureBar";

/** The copy for features not built yet (View and Function). */
export const LATER = "Coming in a later step";
const OPEN_FIRST = "Open a Connection first";
/** PostgreSQL backs up one schema (as the tree offers it), and the bar's target is a whole database. */
export const PG_BACKUP = "On PostgreSQL, back up a schema from its menu in the tree";

export interface FeatureDeps {
  /** The open Connection (and database) the new things go to, or null when none is open. */
  target: { connectionId: string; database: string | null; schema: string | null } | null;
  /** The open Connection is PostgreSQL: Back up works on a schema, not on the database the bar targets. */
  postgres: boolean;
  /** The table tab on top, for Export. */
  table: boolean;
  keys: { newQuery: string | null; diagram: string | null; ask: string | null };
  /** False on a diagram tab, which has its own assistant: Ask works beside every other tab. */
  askReady: boolean;
  newQuery(): void;
  newVisualQuery(): void;
  newTable(): void;
  importInto(): void;
  exportTable(): void;
  transfer(): void;
  backup(): void;
  restore(): void;
  compare(): void;
  newModel(): void;
  newDiagram(): void;
  history(): void;
  ask(): void;
}

export function featureGroups(d: FeatureDeps): { groups: Feature[][]; end: Feature } {
  const needsOpen = d.target ? null : OPEN_FIRST;
  return {
    groups: [
      [
        { id: "query", label: "New query", tip: "New query", shortcut: d.keys.newQuery, run: d.newQuery },
        { id: "vquery", label: "Visual Query", tip: "New Visual Query", run: d.newVisualQuery, disabledWhy: needsOpen },
      ],
      [
        { id: "table", label: "Table", tip: "New table", run: d.newTable, disabledWhy: needsOpen },
        { id: "view", label: "View", tip: "New view", disabledWhy: LATER },
        { id: "function", label: "Function", tip: "New function", disabledWhy: LATER },
      ],
      [
        { id: "import", label: "Import", tip: "Import a file into a table", run: d.importInto, disabledWhy: needsOpen },
        { id: "export", label: "Export", tip: "Export rows to a file", run: d.exportTable, disabledWhy: d.table ? null : "Open a table first" },
        { id: "transfer", label: "Transfer", tip: "Copy tables to another Connection", run: d.transfer, disabledWhy: needsOpen },
      ],
      [
        {
          id: "backup",
          label: "Back up",
          tip: "Back up a database",
          run: d.backup,
          disabledWhy: needsOpen ?? (d.postgres ? PG_BACKUP : null),
        },
        { id: "restore", label: "Restore", tip: "Restore a Backup", run: d.restore, disabledWhy: needsOpen },
      ],
      [
        { id: "compare", label: "Compare", tip: "Compare two schemas", run: d.compare, disabledWhy: needsOpen },
        { id: "model", label: "Model", tip: "New Schema Model", run: d.newModel },
        { id: "diagram", label: "Diagram", tip: "New diagram", shortcut: d.keys.diagram, run: d.newDiagram },
      ],
      [{ id: "history", label: "History", tip: "Query History", run: d.history }],
    ],
    end: {
      id: "ask",
      label: "Ask",
      tip: "Ask about this database",
      shortcut: d.keys.ask,
      run: d.ask,
      disabledWhy: d.askReady ? null : "The diagram has its own assistant",
    },
  };
}
