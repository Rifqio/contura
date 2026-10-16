// SQL completion: what fits where you are typing, from the scope resolver.
// Context rules follow the Editor intelligence design: statement starts,
// tables after FROM/JOIN/UPDATE/INTO, clauses after a table, columns in a
// select list, operators after an expression.
import type { DialectKind } from "../../api/types";
import {
  analyzeSql,
  blockAt,
  isKW,
  isW,
  lc,
  type ResolvedColumn,
  schemaIndex,
  type SqlAnalysis,
  statementAt,
  type TableRef,
  type Tk,
  U,
} from "./analyze";
import { AFTER_TABLE_KW, COL_KW, EXPR_KW, FUNCTIONS, keywordSet, START_KW } from "./dialects";
import { SQL_TEMPLATES, type SqlTemplate, templatePreview } from "./templates";
import type { Token } from "./tokens";
import type { SqlSchema, SqlTable } from "./types";

export interface SqlCompletion {
  label: string;
  kind: "table" | "view" | "schema" | "column" | "keyword" | "function" | "alias" | "cte" | "join" | "template";
  detail: string;
  /** The text to insert. */
  apply: string;
  boost: number;
  info?: string;
  /** How many characters to step back after inserting, to land inside `()`. */
  back?: number;
  /** For a template: the template to expand. */
  template?: SqlTemplate;
}

export interface SqlCompletionResult {
  from: number;
  items: SqlCompletion[];
  /** Why the list is short, such as a schema that has not loaded. */
  note?: string;
}

export interface CompleteOptions {
  /** Picking a table adds a short alias, `orders o`. */
  aliasTables?: boolean;
  /** An analysis of this same text, to reuse. */
  analysis?: SqlAnalysis;
}

/** A completion before ranking: `grp` orders the groups, `match` is what a prefix matches. */
type Item = SqlCompletion & { grp: number; match?: string };

function scoreMatch(label: string, prefix: string): number {
  if (!prefix) return 1;
  const l = lc(label);
  const p = lc(prefix);
  if (l.startsWith(p)) return 3;
  const parts = l.split(/[_.\s]+/).filter(Boolean);
  if (parts.length > 1 && parts.map((x) => x[0]).join("").startsWith(p)) return 2;
  if (p.length > 1 && l.includes(p)) return 1;
  return 0;
}

function rank(items: Item[], prefix: string): SqlCompletion[] {
  return items
    .map((it, i) => ({ it, sc: scoreMatch(it.match ?? it.label, prefix), i }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => a.it.grp - b.it.grp || b.sc - a.sc || a.i - b.i)
    .slice(0, 80)
    .map(({ it }, i) => {
      const { grp: _g, match: _m, ...c } = it;
      return { ...c, boost: 99 - i * 2 };
    });
}

/** A short alias from the name's initials, numbered when taken: `menu_items` → `mi`. */
export function aliasFor(name: string, used: Set<string>): string {
  const a = name.split(/[_\s]+/).filter(Boolean).map((p) => p[0]).join("").toLowerCase() || "t";
  let k = a;
  let i = 2;
  while (used.has(k)) k = a + i++;
  return k;
}

interface FkLink {
  from: SqlTable;
  fc: string;
  to: SqlTable;
  tc: string;
}

/** Per-schema lookups, built once per schema object so a request only filters. */
interface CompletionIndex {
  onPath: SqlTable[];
  bySchema: Map<string, SqlTable[]>;
  links: FkLink[];
  searchPath: Set<string>;
}
const cindexes = new WeakMap<SqlSchema, CompletionIndex>();

function completionIndex(s: SqlSchema): CompletionIndex {
  let ix = cindexes.get(s);
  if (ix) return ix;
  const path = new Set(s.searchPath.map(lc));
  const bySchema = new Map<string, SqlTable[]>();
  for (const t of s.tables) {
    const k = lc(t.schema ?? "");
    bySchema.set(k, [...(bySchema.get(k) ?? []), t]);
  }
  const find = (schema: string | null, name: string) =>
    (schemaIndex(s).byName.get(lc(name)) ?? []).find((t) => lc(t.schema ?? "") === lc(schema ?? ""));
  const links: FkLink[] = [];
  for (const f of s.fks) {
    const from = find(f.from.schema, f.from.table);
    const to = find(f.to.schema, f.to.table);
    if (from && to) f.from.columns.forEach((fc, i) => links.push({ from, fc, to, tc: f.to.columns[i] ?? f.to.columns[0] }));
  }
  ix = {
    onPath: s.tables.filter((t) => t.schema === null || path.has(lc(t.schema))),
    bySchema,
    links,
    searchPath: path,
  };
  cindexes.set(s, ix);
  return ix;
}

const kindLabel = (t: SqlTable) => (t.kind === "view" ? "view" : "table");
const tableInfo = (t: SqlTable) =>
  `${t.schema ? t.schema + "." : ""}${t.name} ${kindLabel(t)} · ${t.columns.length} columns: ${t.columns.map((c) => c.name).join(", ")}`;
const colInfo = (c: ResolvedColumn, r: TableRef) => {
  if (r.kind === "cte") return `${r.name}.${c.name} ${c.typeName} · column of the CTE ${r.name}`;
  if (r.kind === "subquery") return `${r.alias ?? "subquery"}.${c.name} ${c.typeName} · column of the subquery`;
  const t = c.table;
  return `${t?.schema ? t.schema + "." : ""}${c.owner}.${c.name} ${c.typeName}${c.key === "pk" ? " · primary key" : ""}${c.fk ? ` · Foreign Key to ${c.fk}` : ""}`;
};

export function completeSql(
  text: string,
  pos: number,
  dialect: DialectKind,
  schema: SqlSchema | null,
  explicit: boolean,
  opts: CompleteOptions = {},
): SqlCompletionResult {
  const aliasTables = opts.aliasTables ?? true;
  const A = opts.analysis ?? analyzeSql(text, dialect, schema);

  // Nothing inside a string, a quoted name or a comment. One that ends here
  // still holds `pos` when it is left open, or is a line comment.
  const open = (t: Token) =>
    t.t === "comment" ? !t.v.startsWith("/*") || !t.v.endsWith("*/") || t.v.length < 4 : t.t === "string" && (t.v.length < 2 || !t.v.endsWith("'"));
  const inside = A.raw.find((t) => (t.from < pos && pos < t.to) || (t.to === pos && open(t)));
  if (inside && (inside.t === "string" || inside.t === "comment" || inside.t === "quoted")) return { from: pos, items: [] };

  let prefix = "";
  let from = pos;
  const m = /[A-Za-z_][\w$]*$/.exec(text.slice(0, pos));
  if (m) {
    prefix = m[0];
    from = pos - prefix.length;
  }
  const S = statementAt(A, from);
  const ix = schema ? completionIndex(schema) : null;
  const kws = keywordSet(dialect);
  const used = new Set(S ? S.refs.filter((r) => r.alias).map((r) => lc(r.alias!)) : []);
  let items: Item[] = [];
  let note: string | undefined;

  const kwItems = (list: string[], grp: number): Item[] =>
    list
      .filter((k) => k.split(" ").every((w) => kws.has(w)))
      .map((k) => ({ label: k, kind: "keyword", detail: "keyword", apply: k + " ", boost: 0, grp }));
  const fnItems = (grp: number): Item[] =>
    FUNCTIONS[dialect].map((f) => ({
      label: f.name,
      kind: "function",
      detail: f.returns,
      apply: f.name + "()",
      back: 1,
      boost: 0,
      grp,
      info: `${f.name}(${(f.signatures[0] ?? []).join(", ")}) → ${f.returns}. ${f.doc}`,
    }));
  /** A name as it must be typed: quoted when it has spaces, capitals on Postgres, or is a keyword. */
  const Q = (name: string) => {
    const plain = dialect === "postgres" ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Za-z_][\w$]*$/;
    if (plain.test(name) && !kws.has(name.toUpperCase())) return name;
    const mark = dialect === "mysql" ? "`" : '"';
    return mark + name.split(mark).join(mark + mark) + mark;
  };
  const tableItem = (t: SqlTable, grp: number, withAlias: boolean, qualify = false): Item => {
    const name = (qualify && t.schema ? Q(t.schema) + "." : "") + Q(t.name);
    return {
      label: t.name,
      kind: kindLabel(t),
      detail: `${t.schema ? t.schema + " · " : ""}${kindLabel(t)}`,
      apply: name + (withAlias ? " " + aliasFor(t.name, used) : ""),
      boost: 0,
      grp: grp + (t.kind === "view" ? 0.5 : 0),
      info: tableInfo(t),
    };
  };
  const tableItems = (grp: number, withAlias: boolean): Item[] => {
    const out: Item[] = [];
    if (S)
      for (const c of S.ctes)
        out.push({
          label: c.name,
          kind: "cte",
          detail: "CTE",
          apply: Q(c.name) + (withAlias ? " " + aliasFor(c.name, used) : ""),
          boost: 0,
          grp,
          info: `CTE ${c.name} with columns ${(c.block?.columns ?? []).map((x) => x.name).join(", ")}`,
        });
    if (ix) {
      for (const t of ix.onPath) out.push(tableItem(t, grp, withAlias));
      for (const [s, ts] of ix.bySchema)
        if (s)
          out.push({ label: s, kind: "schema", detail: "schema", apply: Q(s) + ".", boost: 0, grp: grp + 1, info: `Schema ${s} · ${ts.length} tables and views` });
    }
    return out;
  };
  const colItems = (refs: TableRef[], grp: number): Item[] => {
    const out: Item[] = [];
    const count = new Map<string, number>();
    for (const r of refs) for (const c of r.columns ?? []) count.set(lc(c.name), (count.get(lc(c.name)) ?? 0) + 1);
    for (const r of refs)
      for (const c of r.columns ?? []) {
        const q = r.alias ?? r.name ?? "";
        const amb = (count.get(lc(c.name)) ?? 0) > 1;
        const owner = r.kind === "cte" ? r.name : r.kind === "subquery" ? (r.alias ?? "subquery") : c.owner;
        const label = amb ? `${q}.${c.name}` : c.name;
        const apply = amb ? `${Q(q)}.${Q(c.name)}` : Q(c.name);
        out.push({ label, match: c.name, kind: "column", detail: `${c.typeName} · ${owner}`, apply, boost: 0, grp, info: colInfo(c, r) });
      }
    return out;
  };
  const aliasItems = (grp: number): Item[] =>
    S
      ? S.refs
          .filter((r) => r.alias)
          .map((r) => ({ label: r.alias!, kind: "alias", detail: `alias · ${r.name ?? "subquery"}`, apply: r.alias!, boost: 0, grp, info: `Alias ${r.alias} for ${r.name ?? "a subquery"}` }))
      : [];
  const qualName = (t: SqlTable) => (t.schema && ix && !ix.searchPath.has(lc(t.schema)) ? `${Q(t.schema)}.${Q(t.name)}` : Q(t.name));
  const fkInfo = (l: FkLink) => `From the Foreign Key ${l.from.name}.${l.fc} → ${l.to.name}.${l.tc}`;
  const joinItems = (refs: TableRef[]): Item[] => {
    if (!ix) return [];
    const out: Item[] = [];
    const inScope = new Set(refs.filter((r) => r.table).map((r) => r.table!));
    for (const r of refs) {
      if (r.kind !== "table" || !r.table) continue;
      const rq = r.alias ?? r.name;
      for (const l of ix.links) {
        if (l.to === r.table && !inScope.has(l.from)) {
          const a = aliasFor(l.from.name, used);
          const s = `${qualName(l.from)} ${a} ON ${a}.${Q(l.fc)} = ${Q(rq ?? "")}.${Q(l.tc)}`;
          out.push({ label: s, match: l.from.name, kind: "join", detail: "Foreign Key", apply: s, boost: 0, grp: -1, info: fkInfo(l) });
        }
        if (l.from === r.table && !inScope.has(l.to)) {
          const a = aliasFor(l.to.name, used);
          const s = `${qualName(l.to)} ${a} ON ${a}.${Q(l.tc)} = ${Q(rq ?? "")}.${Q(l.fc)}`;
          out.push({ label: s, match: l.to.name, kind: "join", detail: "Foreign Key", apply: s, boost: 0, grp: -1, info: fkInfo(l) });
        }
      }
    }
    return out;
  };
  const onItems = (refs: TableRef[]): Item[] => {
    if (!ix) return [];
    const out: Item[] = [];
    const tr = refs.filter((r) => r.kind === "table" && r.table);
    for (const a of tr)
      for (const b of tr)
        if (a !== b)
          for (const l of ix.links)
            if (l.from === a.table && l.to === b.table) {
              const s = `${Q(a.alias ?? a.name ?? "")}.${Q(l.fc)} = ${Q(b.alias ?? b.name ?? "")}.${Q(l.tc)}`;
              out.push({ label: s, match: a.alias ?? a.name ?? "", kind: "join", detail: "Foreign Key", apply: s, boost: 0, grp: -1, info: fkInfo(l) });
            }
    return out;
  };
  const noSchemaNote = "Tables and columns appear when the schema has loaded.";

  const qm = /([A-Za-z_][\w$]*)\.$/.exec(text.slice(0, from));
  if (qm) {
    const q = qm[1];
    let r: TableRef | null = null;
    if (S) for (let x: ReturnType<typeof blockAt> | null = blockAt(S, from); x && !r; x = x.parent)
      r = x.refs.find((r) => r.alias && lc(r.alias) === lc(q)) ?? x.refs.find((r) => !r.alias && r.name && lc(r.name) === lc(q)) ?? null;
    const inSchema = ix?.bySchema.get(lc(q));
    if (r?.columns) items = colItems([r], 0).map((it) => ({ ...it, label: it.match ?? it.label, apply: Q(it.match ?? it.label) }));
    else if (inSchema && (!r || r.kind === "unknown"))
      items = inSchema.map((t) => tableItem(t, 0, false));
    else if (r) note = schema ? `${r.name ?? q} is not a known table, so it has no columns to offer.` : `Columns of ${r.name ?? q} appear when the schema has loaded.`;
    else note = `Nothing is called ${q} in this query.`;
  } else if (!S || from <= S.from) {
    items = [
      ...SQL_TEMPLATES.map(
        (t): Item => ({ label: t.abbr, kind: "template", detail: t.desc, apply: t.abbr, boost: 0, grp: 0, template: t, info: `Live template. Expands to ${templatePreview(t)}` }),
      ),
      ...kwItems(START_KW, 0),
    ];
  } else {
    const b = blockAt(S, from);
    const refs: TableRef[] = [];
    for (let x: typeof b | null = b; x; x = x.parent) refs.push(...x.refs);
    const ownBefore = b.own.map((k) => S.tokens[k]).filter((t) => t.e <= from);
    const prev: Tk | null = ownBefore.length ? ownBefore[ownBefore.length - 1] : b.open >= 0 ? S.tokens[b.open] : null;
    const pu = isKW(prev ?? undefined) ? U(prev ?? undefined) : null;
    let clause: string | null = null;
    for (let i = ownBefore.length - 1; i >= 0; i--) {
      const u = isKW(ownBefore[i]) ? U(ownBefore[i]) : null;
      if (u && ["SELECT", "FROM", "JOIN", "ON", "WHERE", "GROUP", "ORDER", "HAVING", "SET", "INTO", "VALUES", "UPDATE", "LIMIT"].includes(u)) {
        clause = u;
        break;
      }
    }
    if (["FROM", "JOIN", "UPDATE", "INTO", "TABLE"].includes(pu ?? "") || (prev?.v === "," && clause === "FROM")) {
      const withAlias = aliasTables && (pu === "FROM" || pu === "JOIN" || prev?.v === ",");
      items = [...(pu === "JOIN" ? joinItems(refs) : []), ...tableItems(0, withAlias), ...kwItems(pu === "FROM" || pu === "JOIN" ? ["LATERAL"] : [], 3)];
      if (!schema) note = noSchemaNote;
    } else if ((clause === "FROM" || clause === "JOIN" || clause === "UPDATE") && prev && ((isW(prev) && !isKW(prev)) || prev.v === ")")) {
      items = clause === "UPDATE" ? kwItems(["SET"], 0) : kwItems(AFTER_TABLE_KW, 0);
    } else if (pu === "ON" || (clause === "ON" && pu === "AND")) {
      items = [...onItems(refs), ...colItems(refs, 0), ...aliasItems(1), ...fnItems(2)];
    } else if (pu === "INSERT") items = kwItems(["INTO"], 0);
    else if (pu === "DELETE") items = kwItems(["FROM"], 0);
    else if (pu === "GROUP" || pu === "ORDER") items = kwItems(["BY"], 0);
    else if (
      prev &&
      ((isW(prev) && !isKW(prev) && !prev.fn) || prev.t === "n" || prev.t === "s" || prev.v === ")" || ["NULL", "TRUE", "FALSE", "ASC", "DESC"].includes(pu ?? "")) &&
      clause !== "SET"
    ) {
      items = [...kwItems(EXPR_KW.filter((k) => !(k === "FROM" && clause !== "SELECT")), 0), ...(explicit || prefix ? colItems(refs, 1) : [])];
    } else {
      items = [...colItems(refs, 0), ...aliasItems(1), ...fnItems(2), ...kwItems(COL_KW, 3), ...(prev?.v === "(" ? kwItems(["SELECT"], 3) : [])];
      if (!schema && refs.some((r) => !r.columns && r.kind !== "subquery")) note = "Showing keywords, functions and this query's aliases until the schema has loaded.";
    }
  }
  return { from, items: rank(items, prefix), ...(note ? { note } : {}) };
}
