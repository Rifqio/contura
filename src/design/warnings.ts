import type { ChildAction, DesignWarning, Rule } from "../api/types";

const count = (n: number) => n.toLocaleString("en-US");

/** The rule as a thing the table has: "the primary key", "the unique index email". */
function ruleName(rule: Rule, name: string): string {
  switch (rule) {
    case "primaryKey":
      return "the primary key";
    case "unique":
      return `the unique index ${name}`;
    case "foreignKey":
      return `the Foreign Key ${name}`;
    case "notNull":
      return `the NOT NULL rule on ${name}`;
  }
}

function existingRows(rule: Rule, name: string): string {
  switch (rule) {
    case "notNull":
      return `Making ${name} required fails if a row holds NULL. Nothing is lost.`;
    case "unique":
      return `A unique index on ${name} fails if two rows share a value. Nothing is lost.`;
    case "primaryKey":
      return "Adding the primary key fails if two rows share a value or a row holds NULL. Nothing is lost.";
    case "foreignKey":
      return `The Foreign Key ${name} fails if a row points at a missing row. Nothing is lost.`;
  }
}

function childRows(w: { table: string; child: string; action: ChildAction }): string {
  switch (w.action) {
    case "delete":
      return `Dropping ${w.table} also deletes the matching rows in ${w.child}.`;
    case "clear":
      return `Dropping ${w.table} also clears the key in ${w.child} on the matching rows, or fails if that key is required.`;
    case "setDefault":
      return `Dropping ${w.table} also sets the key in ${w.child} to its default on the matching rows, or fails if that default is not NULL.`;
    case "fail":
      return `Dropping ${w.table} fails while rows in ${w.child} point at it. Nothing is lost.`;
  }
}

/** One plan warning as a plain sentence for the warning banner. */
export function warningText(w: DesignWarning): string {
  switch (w.kind) {
    case "childRows":
      return childRows(w);
    case "dropColumn":
      return `Dropping ${w.column} deletes its data in every row.`;
    case "narrowType": {
      const text = `Changing ${w.column} from ${w.from} to ${w.to} can cut or round existing values.`;
      return w.note ? `${text} ${w.note}` : text;
    }
    case "existingRows":
      return existingRows(w.rule, w.name);
    case "dropRule":
      return `Dropping ${ruleName(w.rule, w.name)} removes a rule the data relies on.`;
    case "rewriteLock":
      return `PostgreSQL rewrites ${w.table} and blocks reads and writes on it until this finishes.`;
    case "rebuildCopy":
      return `SQLite copies every row of ${w.table} into a new table. A large table takes time and disk space.`;
    case "renameColumn":
      return `Views, routines and applications that use ${w.from} stop working until they use ${w.to}.`;
    case "dropTable": {
      const rows =
        w.rows === null
          ? `Dropping ${w.table} deletes it and every row in it. Contura could not count its rows.`
          : w.rows.kind === "over"
            ? `Dropping ${w.table} deletes more than ${count(w.rows.n)} rows.`
            : `Dropping ${w.table} deletes its ${count(w.rows.n)} ${w.rows.n === 1 ? "row" : "rows"}.`;
      return w.referencedBy.length > 0 ? `${rows} Foreign Keys in ${w.referencedBy.join(", ")} point at it.` : rows;
    }
  }
}
