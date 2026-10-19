// What each Foreign Key of a lineage does, in plain sentences (spec 6+ section 5, frame 6+.1). Every
// sentence template is in this file; the nouns come from the step 6 rules (`nounFor`).
import type { FlowTableAccess, Lineage, LineageLink, ObjectPath } from "../api/types";
import { article } from "../format/article";
import { plural } from "../format/plural";
import { nounFor } from "../visualquery/nouns";

/** The panel's tag: Blocks (the delete is stopped), Also deletes (CASCADE), Info (the key is changed). */
export type LinkTag = "blocks" | "cascade" | "info";

/** Whether `column` of `holder` has a default: null while it is not checked yet, "failed" when it could not be read. */
export type HasDefault = (holder: ObjectPath, column: string) => boolean | "failed" | null;

/**
 * What decides whether SET NULL and SET DEFAULT can run: the lineage holding the key (its holder
 * card says which key columns can be empty) and the columns' defaults. Without it, the Core's
 * `nullable` flag is used and defaults are unchecked: never taken to exist.
 */
export interface KeyContext {
  lineage?: Lineage;
  hasDefault?: HasDefault;
}

/** True when both paths name the same table. */
export function samePath(a: ObjectPath, b: ObjectPath): boolean {
  return a.database === b.database && (a.schema ?? null) === (b.schema ?? null) && a.name === b.name;
}

/** The rule in upper case with single spaces; null (the Dialect's default) is NO ACTION. */
const rule = (r: string | null) => (r ?? "NO ACTION").trim().replace(/\s+/g, " ").toUpperCase();

/** Whether each key column can be empty: from the holder card, else the Core's flag (some column can be empty). */
function emptyable(link: LineageLink, ctx: KeyContext | undefined): (column: string) => boolean {
  const card = ctx?.lineage?.tables.find((t) => samePath(t.path, link.from));
  if (!card || card.unreadable) return () => link.nullable;
  return (column) => card.columns.find((c) => c.name === column)?.nullable ?? link.nullable;
}

/**
 * The key columns a SET NULL or SET DEFAULT can't fill, so the server refuses the change: SET NULL
 * on a column that can't be empty, SET DEFAULT on one with no default (it gets NULL) that can't be
 * empty. Empty for any other rule, and for a default that is not known yet.
 */
function stuckColumns(link: LineageLink, which: string | null, ctx: KeyContext | undefined): string[] {
  const r = rule(which);
  if (r !== "SET NULL" && r !== "SET DEFAULT") return [];
  const canEmpty = emptyable(link, ctx);
  return link.fromColumns.filter((c) => !canEmpty(c) && (r === "SET NULL" || ctx?.hasDefault?.(link.from, c) === false));
}

/**
 * SET DEFAULT key columns that can't be empty and whose default is not known (not read yet, or the
 * read failed): whether the change runs depends on them, so the sentence says so.
 */
function uncheckedColumns(link: LineageLink, which: string | null, ctx: KeyContext | undefined): string[] {
  if (rule(which) !== "SET DEFAULT") return [];
  const canEmpty = emptyable(link, ctx);
  return link.fromColumns.filter((c) => {
    if (canEmpty(c)) return false;
    const has = ctx?.hasDefault?.(link.from, c) ?? null;
    return has === null || has === "failed";
  });
}

/** ", if store_id has a default" while that is unchecked. */
function ifDefault(cols: string[]): string {
  return cols.length === 0 ? "" : `, if ${and(cols)} ${cols.length > 1 ? "have defaults" : "has a default"}`;
}

/** Why the change can't run: "order_id can't be empty", "store_id has no default and can't be empty". */
function stuckReason(which: string | null, stuck: string[]): string {
  return rule(which) === "SET NULL"
    ? `${and(stuck)} can't be empty`
    : `${and(stuck)} ${stuck.length > 1 ? "have" : "has"} no default and can't be empty`;
}

/**
 * What deleting the row pointed to does to the rows holding the key: it is stopped (Blocks), they
 * go too (Also deletes), or their key is changed (Info). A SET NULL or SET DEFAULT the key's
 * columns can't take stops the delete too. A key that can be empty but is RESTRICT still stops it.
 */
export function tagOf(link: LineageLink, ctx?: KeyContext): LinkTag {
  switch (rule(link.onDelete)) {
    case "CASCADE":
      return "cascade";
    case "SET NULL":
    case "SET DEFAULT":
      return stuckColumns(link, link.onDelete, ctx).length > 0 ? "blocks" : "info";
    default:
      return "blocks";
  }
}

/** A table's noun for running text; a name the rules are unsure of reads as "row of {table}". */
function noun(path: ObjectPath): { one: string; many: string } {
  const n = nounFor(path.name);
  return n.one === n.many ? { one: `row of ${path.name}`, many: `rows of ${path.name}` } : n;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const list = (cols: string[]) => cols.join(", ");
const and = (cols: string[]) => (cols.length < 2 ? (cols[0] ?? "") : `${cols.slice(0, -1).join(", ")} and ${cols[cols.length - 1]}`);

/** One plain sentence for a key, read from `center`: the holder needs the other table, or what a delete does to the holder. */
export function linkSentence(link: LineageLink, center: ObjectPath, ctx?: KeyContext): string {
  const child = noun(link.from);
  const parent = noun(link.to);
  if (samePath(link.from, link.to)) {
    const through = `through ${and(link.fromColumns)}`;
    return link.nullable
      ? `${cap(article(child.one))} can point to another ${child.one} ${through}`
      : `Every ${child.one} points to another ${child.one} ${through}`;
  }
  if (samePath(link.to, center) && !samePath(link.from, center)) {
    const blocked = `${cap(article(parent.one))} with ${child.many} can't be deleted`;
    const stuck = stuckColumns(link, link.onDelete, ctx);
    if (stuck.length > 0) return `${blocked}: ${stuckReason(link.onDelete, stuck)}`;
    switch (rule(link.onDelete)) {
      case "CASCADE":
        return `${cap(child.many)} go when their ${parent.one} goes`;
      case "SET NULL":
        return `${cap(child.many)} lose their ${parent.one} when it goes`;
      case "SET DEFAULT":
        return `${cap(child.many)} get the default ${parent.one} when theirs goes${ifDefault(uncheckedColumns(link, link.onDelete, ctx))}`;
      default:
        return blocked;
    }
  }
  return link.nullable ? `${cap(article(child.one))} can have no ${parent.one}` : `Every ${child.one} needs ${article(parent.one)}`;
}

/** What changing the key of the row pointed to does to the holders; null when the change is stopped. */
export function updateSentence(link: LineageLink, ctx?: KeyContext): string | null {
  const child = noun(link.from);
  const parent = noun(link.to);
  // A change the key's columns can't take is refused, as with RESTRICT.
  if (stuckColumns(link, link.onUpdate, ctx).length > 0) return null;
  switch (rule(link.onUpdate)) {
    case "CASCADE":
      return `A changed ${parent.one} key carries over to its ${child.many}`;
    case "SET NULL":
      return `Changing ${article(parent.one)} key empties it in its ${child.many}`;
    case "SET DEFAULT":
      return `Changing ${article(parent.one)} key sets its ${child.many} to the default${ifDefault(uncheckedColumns(link, link.onUpdate, ctx))}`;
    default:
      return null;
  }
}

/**
 * The key's columns in code text: `customer_id → customers.id` for a key the center holds,
 * `order_lines.order_id` for one pointing to it. A composite key names every column on both sides.
 */
export function columnsText(link: LineageLink, center: ObjectPath): string {
  const many = link.fromColumns.length > 1 || link.toColumns.length > 1;
  const cols = (c: string[]) => (many ? `(${list(c)})` : list(c));
  const incoming = samePath(link.to, center) && !samePath(link.from, center);
  if (incoming) {
    const held = `${link.from.name}.${cols(link.fromColumns)}`;
    return many ? `${held} → ${cols(link.toColumns)}` : held;
  }
  return `${cols(link.fromColumns)} → ${link.to.name}.${cols(link.toColumns)}`;
}

/** The warning block's title: "Before you delete an order". */
export function deleteTitle(center: ObjectPath): string {
  return `Before you delete ${article(noun(center).one)}`;
}

/** The warning block's one line while its own read runs: never nothing while unchecked. */
export function deleteCheckingLine(center: ObjectPath): string {
  return `Checking what deleting ${article(noun(center).one)} does...`;
}

/** "1 table", "2 tables": a group's count. */
export const tablesCount = (n: number) => plural(n, "table", "tables");

/** The warning block's lines, and why the list may miss some (null when it is whole). */
export interface DeleteEffects {
  blocks: string[];
  cascades: string[];
  incomplete: string | null;
}

/**
 * What deleting one row of `center` does elsewhere, by the lineage's keys: rows that stop the
 * delete, and rows that go with it. Cascades are followed through every table they reach (a
 * cycle ends where it began). SET NULL and SET DEFAULT are left out unless the key's columns
 * can't take them, which stops the delete. Read it from a lineage of every table using the
 * center (depth All, Used by); `incomplete` says when that read stopped early or a table on a
 * cascade path could not be read.
 */
export function deleteEffects(lineage: Lineage, center: ObjectPath, hasDefault?: HasDefault): DeleteEffects {
  const ctx: KeyContext = { lineage, hasDefault };
  const key = (p: ObjectPath) => JSON.stringify([p.database, p.schema ?? null, p.name]);
  // Each line once per holder, kind and route; two holders with the same name are told apart by their schema.
  const found: { list: "blocks" | "cascades"; id: string; holder: ObjectPath; text: string }[] = [];
  const add = (list: "blocks" | "cascades", id: string, holder: ObjectPath, text: string) => {
    if (!found.some((f) => f.list === list && f.id === id)) found.push({ list, id, holder, text });
  };
  const seen = new Set([key(center)]);
  const queue: ObjectPath[] = [center];
  const hidden: string[] = [];
  const unchecked: string[] = [];
  const unread: string[] = [];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const atCenter = samePath(at, center);
    const here = noun(at);
    for (const l of lineage.links) {
      if (!samePath(l.to, at)) continue;
      const tag = tagOf(l, ctx);
      // A SET DEFAULT whose defaults are not known yet may stop the delete: the list says it is unchecked.
      for (const col of uncheckedColumns(l, l.onDelete, ctx)) {
        if (hasDefault?.(l.from, col) === "failed") {
          if (!unread.includes(l.from.name)) unread.push(l.from.name);
        } else if (!unchecked.includes(col)) unchecked.push(col);
      }
      if (tag === "info") continue;
      const child = noun(l.from);
      const stuck = stuckColumns(l, l.onDelete, ctx);
      const why = stuck.length > 0 ? `: ${stuckReason(l.onDelete, stuck)}` : "";
      const id = `${key(l.from)}|${key(at)}|${tag}${why}`;
      if (samePath(l.from, l.to)) {
        const through = `through ${and(l.fromColumns)}`;
        if (atCenter) {
          if (tag === "blocks") add("blocks", `${id}|self`, l.from, `Another ${child.one} that points to it ${through} stops the delete${why}.`);
          else add("cascades", `${id}|self`, l.from, `Other ${child.many} that point to it ${through} go with it.`);
        } else if (tag === "blocks") {
          add("blocks", `${id}|self`, l.from, `${cap(article(here.one))} that points to one of its ${here.many} ${through} stops the delete${why}.`);
        } else {
          add("cascades", `${id}|self`, l.from, `${cap(here.many)} that point to its ${here.many} ${through} go too.`);
        }
        continue;
      }
      if (tag === "blocks") {
        add("blocks", id, l.from, atCenter ? `${cap(article(child.one))} stops the delete${why}.` : `${cap(article(child.one))} on its ${here.many} stops the delete${why}.`);
        continue;
      }
      add("cascades", id, l.from, atCenter ? `Its ${child.many} go with it.` : `${cap(child.many)} of its ${here.many} go too.`);
      if (!seen.has(key(l.from))) {
        seen.add(key(l.from));
        queue.push(l.from);
        // The walk stops at a table it can't read, so what points to it is unknown.
        const card = lineage.tables.find((t) => samePath(t.path, l.from));
        if (card?.unreadable && !hidden.includes(l.from.name)) hidden.push(l.from.name);
      }
    }
  }
  const qualify = (f: (typeof found)[number]) => {
    const twin = found.some((g) => g !== f && g.list === f.list && g.text === f.text && !samePath(g.holder, f.holder));
    return twin ? `${f.text.slice(0, -1)} (${f.holder.schema ?? f.holder.database}.${f.holder.name}).` : f.text;
  };
  const texts = (list: "blocks" | "cascades") => found.filter((f) => f.list === list).map(qualify).filter((t, i, all) => all.indexOf(t) === i);
  const reasons: string[] = [];
  if (lineage.truncated) {
    reasons.push(lineage.tables.length >= 300 ? "Contura reads at most 300 tables" : "reading stopped at Contura's 10s limit");
  }
  if (hidden.length > 0) reasons.push(`Contura can't read ${and(hidden)}`);
  if (unchecked.length > 0) reasons.push(`Contura hasn't checked the defaults of ${and(unchecked)}`);
  if (unread.length > 0) reasons.push(`Contura couldn't read the defaults of ${and(unread)}`);
  return {
    blocks: texts("blocks"),
    cascades: texts("cascades"),
    incomplete: reasons.length > 0 ? `This list may be incomplete: ${reasons.join(", and ")}.` : null,
  };
}

/** Strips one pair of quotes, backticks or brackets from a name part. */
const unquote = (s: string) => s.trim().replace(/^(["`[])(.*)([\]"`])$/, "$2");

/** True when a diagram's `table:` value names `path`: `orders`, `shop.orders` or `kestrel.shop.orders`, any case. */
export function flowMatches(value: string, path: ObjectPath): boolean {
  const parts = value.split(".").map(unquote);
  const eq = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();
  const name = parts[parts.length - 1];
  if (!eq(name, path.name)) return false;
  if (parts.length === 1) return true;
  if (parts.length === 2) return eq(parts[0], path.schema) || eq(parts[0], path.database);
  return parts.length === 3 && eq(parts[0], path.database) && eq(parts[1], path.schema);
}

/** A Diagrams row: "Checkout writes orders", from the diagram's name and how its lines meet the table. */
export function flowSentence(file: string, access: FlowTableAccess, table: ObjectPath): string {
  return `${cap(file)} ${accessText(access, table)}`;
}

/** "reads orders", "writes order lines", "reads and writes orders". */
function accessText(access: FlowTableAccess, table: ObjectPath): string {
  const verb = access === "writes" ? "writes" : access === "reads" ? "reads" : "reads and writes";
  const n = nounFor(table.name);
  const things = n.one === n.many ? table.name : n.many;
  return `${verb} ${things}`;
}

/** A Diagrams row naming the process that touches the table: "Ship order reads orders" (the file is the row's second line). */
export function processSentence(process: string, access: FlowTableAccess, table: ObjectPath): string {
  return `${process} ${accessText(access, table)}`;
}
