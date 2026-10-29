// "Run with a CROSS JOIN?": asked before the first run of a set of tables with no Join.
import Dialog from "../components/Dialog";
import Kbd from "../components/Kbd";
import { nounFor } from "./nouns";

/** "a", "a and b", "a, b and c". */
const listText = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

export interface CrossJoinDialogProps {
  /** Each table written as a CROSS JOIN, with the tree's row count. */
  tables: {
    name: string;
    rows: number | null;
    estimated: boolean;
    /** The table of a joined group whose count `rows` is (its largest), when it is not `name`. */
    counted?: string;
  }[];
  /** The FROM table every row of each pairs with. Its count is an estimate unless said otherwise. */
  root: { name: string; rows: number | null; estimated?: boolean };
  onAddJoin(): void;
  onCancel(): void;
  onRun(): void;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** A large count in words: "110 million", "2.4 thousand"; below 1,000 the number itself. */
export function aboutRows(n: number): string {
  const units: [number, string][] = [
    [1e9, "billion"],
    [1e6, "million"],
    [1e3, "thousand"],
  ];
  for (const [size, word] of units) {
    if (n < size) continue;
    const v = n / size;
    const shown = v < 10 ? String(Math.round(v * 10) / 10) : fmt(Math.round(v));
    return `${shown} ${word}`;
  }
  return fmt(Math.round(n));
}

/**
 * "menu_items has no Join. Every one of the 1,284,339 orders pairs with all 86 menu items, about 110
 * million rows before the filter." With every count exact the product is written as it is, without
 * "about"; with a count unknown the sentence ends at "pairs with every row of menu_items."
 */
export function crossJoinSentence(table: CrossJoinDialogProps["tables"][number], root: CrossJoinDialogProps["root"]): string {
  const r = nounFor(root.name);
  const t = nounFor(table.counted ?? table.name);
  const every =
    root.rows !== null ? `Every one of the ${fmt(root.rows)} ${r.many}` : r.one === r.many ? `Every row of ${root.name}` : `Every ${r.one}`;
  if (root.rows === null || table.rows === null) return `${table.name} has no Join. ${every} pairs with every row of ${table.name}.`;
  const product = root.rows * table.rows;
  const exact = !table.estimated && root.estimated === false;
  const rows = exact ? fmt(product) : `about ${aboutRows(product)}`;
  return `${table.name} has no Join. ${every} pairs with all ${fmt(table.rows)} ${t.many}, ${rows} rows before the filter.`;
}

export default function CrossJoinDialog({ tables, root, onAddJoin, onCancel, onRun }: CrossJoinDialogProps) {
  return (
    <Dialog title="Run with a CROSS JOIN?" size="confirm" onClose={onCancel}>
      <div className="dialog-body vq-cross-ask">
        {tables.map((t) => (
          <p key={t.name}>{crossJoinSentence(t, root)}</p>
        ))}
        <p className="muted">
          Asked once for this query. Draw a Join from a column of {listText(tables.map((t) => t.name))} to avoid it.
        </p>
      </div>
      <footer className="dialog-footer">
        <button type="button" className="button" onClick={onAddJoin}>
          Add a Join
        </button>
        <span className="spacer" />
        <button type="button" className="button" onClick={onCancel}>
          Cancel
          <Kbd keys="Esc" />
        </button>
        {/* Focused when the dialog opens, so Enter runs. */}
        <button type="button" className="button button-primary" data-autofocus onClick={onRun}>
          Run anyway
          <Kbd keys="Enter" />
        </button>
      </footer>
    </Dialog>
  );
}
