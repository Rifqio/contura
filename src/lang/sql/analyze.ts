// The SQL scope resolver: statements, blocks (the statement and each
// parenthesised SELECT), table references with aliases, CTEs, select-list
// output columns, and the resolved meaning of every name. Completion,
// inspections and refactors all read one analysis. It follows the Editor
// intelligence design's analyser, on the 4a tokenizer.
import type { DialectKind } from "../../api/types";
import type { TextEdit } from "../protocol";
import { functionMap, keywordSet, type SqlFunction } from "./dialects";
import { type Token, tokenize } from "./tokens";
import type { SqlSchema, SqlTable } from "./types";

export type Range = { from: number; to: number };

/** A token with what the analyser learned about it. */
export interface Tk {
  t: "s" | "q" | "n" | "w" | "p";
  v: string;
  s: number;
  e: number;
  /** A keyword in some Dialect, unless used as a name. */
  kw: boolean;
  /** A function call of this Dialect. */
  fn: boolean;
}

export interface ResolvedColumn {
  name: string;
  typeName: string;
  owner: string;
  table: SqlTable | null;
  key: "pk" | "fk" | null;
  /** Where a Foreign Key points, as `table.column`. */
  fk: string | null;
  /** Where a query's own output column is named, for go to definition. */
  def: Range | null;
}

export interface Cte {
  name: string;
  range: Range;
  block: Block | null;
}

export type JoinKind = "inner" | "left" | "right" | "full" | "cross" | "comma";

/** How a reference joins the ones before it: the keyword run, NATURAL, USING and ON. */
export interface RefJoin {
  kind: JoinKind;
  natural: boolean;
  using: string[] | null;
  /** The ON condition, without the ON keyword. */
  on: Range | null;
  /** From the first keyword of the run to the end of the ON or USING. */
  range: Range;
}

export interface SelectItem {
  /** The whole item, alias included. */
  range: Range;
  /** The expression without its alias, whitespace runs as one space. */
  text: string;
  alias: string | null;
  /** The columns the item reads, in order. */
  sources: { ref: TableRef; column: string }[];
  /** The function when the item is one call, lower case. */
  fn: string | null;
  /** The column name when the item is one column, qualified or not. */
  column: string | null;
}

export type ClauseKeyword = "WHERE" | "GROUP BY" | "HAVING" | "ORDER BY" | "LIMIT" | "FETCH";

export interface OrderItem {
  range: Range;
  /** The expression without ASC, DESC or NULLS. */
  text: string;
  desc: boolean;
  /** The SELECT item it sorts by: its alias, its own text, its column name, or its position. */
  output: number | null;
}

export interface TableRef {
  id: number;
  kind: "table" | "cte" | "subquery" | "unknown" | "noSchema";
  schema: string | null;
  name: string | null;
  alias: string | null;
  aliasRange: Range | null;
  nameRange: Range | null;
  /** Where the name (or the subquery's closing parenthesis) ends, so an alias can be removed. */
  nameEnd: number;
  columns: ResolvedColumn[] | null;
  table: SqlTable | null;
  cte: Cte | null;
  /** The table an INSERT, UPDATE or DELETE writes. */
  target: boolean;
  block: Block;
  /** From the name (or the subquery's parenthesis) to the alias. */
  range: Range;
  /** Null for the first reference of a FROM, and for UPDATE, INSERT and DELETE targets. */
  join: RefJoin | null;
  /** Every column the statement reads through this reference, schema or not. */
  used: { column: string; range: Range }[];
}

/** What resolving a name gives, before the reference has its alias and place. */
type RefBase = Omit<TableRef, "id" | "alias" | "aliasRange" | "target" | "block" | "nameEnd" | "range" | "join" | "used">;

export interface Block {
  /** Index of the opening parenthesis in the statement's tokens; -1 for the statement itself. */
  open: number;
  close: number;
  lo: number;
  hi: number;
  parent: Block | null;
  children: Block[];
  refs: TableRef[];
  columns: ResolvedColumn[];
  own: number[];
  depth: number;
  selAliases: Set<string>;
  star: Tk | null;
  starQ: { tok: Tk; from: number; qual: string }[];
  insertCols: { k: number; ref: TableRef | undefined }[];
  select: SelectItem[];
  clauses: { keyword: ClauseKeyword; range: Range }[];
  distinct: boolean;
  orderBy: OrderItem[];
}

export interface StmtScope {
  from: number;
  to: number;
  tokens: Tk[];
  blocks: Block[];
  refs: TableRef[];
  ctes: Cte[];
  uses: Set<string>;
  verb: string | null;
}

export interface SqlFix {
  title: string;
  edits: TextEdit[];
}

export interface SqlProblem {
  from: number;
  to: number;
  severity: "error" | "warning" | "hint";
  kind: "syntax" | "schema" | "query";
  message: string;
  fixes: SqlFix[];
}

export type SqlSymbol = Range &
  (
    | { kind: "table"; table: SqlTable }
    | { kind: "alias-decl"; ref: TableRef }
    | { kind: "qual"; ref: TableRef }
    | { kind: "cte-decl"; cte: Cte }
    | { kind: "cte-ref"; cte: Cte }
    | { kind: "column"; column: ResolvedColumn; ref: TableRef }
    | { kind: "function"; name: string }
  );

export interface SqlAnalysis {
  dialect: DialectKind;
  schema: SqlSchema | null;
  text: string;
  /** Meaningful tokens: no whitespace, no comments. */
  sig: Tk[];
  /** Every token, comments and strings included, for "is this inside a string". */
  raw: Token[];
  statements: StmtScope[];
  /** One per statement slot, empty ones included, for finding the statement at a position. */
  segments: { lo: number; hi: number; stmt: StmtScope | null }[];
  problems: SqlProblem[];
  symbols: SqlSymbol[];
  /** Offered fixes that are not problems, such as expanding `*`. */
  intents: (Range & SqlFix)[];
  functions: Map<string, SqlFunction>;
}

export const lc = (s: string) => s.toLowerCase();
export const isW = (t: Tk | undefined): t is Tk => !!t && (t.t === "w" || t.t === "q");
export const isKW = (t: Tk | undefined) => !!t && t.t === "w" && t.kw;
export const U = (t: Tk | undefined) => (t && t.t === "w" ? t.v.toUpperCase() : null);
/** A name without its quotes. */
export const idn = (t: Tk) => {
  if (t.t !== "q") return t.v;
  const q = t.v[0];
  const inner = t.v.slice(1, t.v.length - (/["`\]]$/.test(t.v) ? 1 : 0));
  // A doubled quote inside a quoted name is one quote character.
  return q === '"' || q === "`" ? inner.split(q + q).join(q) : inner;
};

const NOT_TABLE = new Set(["FROM", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT", "RETURNING", "JOIN", "LEFT", "RIGHT", "INNER", "FULL", "CROSS", "OUTER", "ON", "USING", "SELECT", "LATERAL", "SET", "AS", "WITH", "VALUES"]);
const CLAUSE = new Set(["FROM", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT", "RETURNING"]);
const JOIN_RUN = new Set(["INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL"]);
/** Where an ON condition or a clause ends, at the top level. */
const CLAUSE_END = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "FETCH", "FOR", "RETURNING", "JOIN", ...JOIN_RUN]);
/** Where an ON condition ends: a clause, the next Join, or what follows a FROM in UPDATE, INSERT ... ON CONFLICT and ON DUPLICATE KEY. */
const ON_END = new Set([...CLAUSE_END, "SET", "ON", "DO", "UPDATE", "VALUES", "SELECT"]);
/** Keywords that end a SELECT's FROM list, so a later comma is not another table. */
const FROM_END = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "UNION", "INTERSECT", "EXCEPT", "WINDOW", "FETCH", "RETURNING", "SET", "DO", "VALUES"]);
const CLAUSE_START: Record<string, ClauseKeyword> = { WHERE: "WHERE", GROUP: "GROUP BY", HAVING: "HAVING", ORDER: "ORDER BY", LIMIT: "LIMIT", FETCH: "FETCH" };
const COMPARISON = /^[<>=!]+$/;

/** Text from `from` to `to` with whitespace runs as one space. */
export const flat = (text: string, from: number, to: number) => text.slice(from, to).replace(/\s+/g, " ").trim();

/** Levenshtein distance, ignoring case. */
function lev(a: string, b: string): number {
  a = lc(a);
  b = lc(b);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The nearest name, for "Did you mean". */
export function closest(name: string, list: string[]): string | null {
  let best: string | null = null;
  let bd = 99;
  for (const x of list) {
    const d = lev(name, x);
    if (d < bd) {
      bd = d;
      best = x;
    }
  }
  if (bd <= Math.max(1, Math.floor(name.length / 3)) && name.length > 2) return best;
  const parts = lc(name).split("_").filter(Boolean);
  if (parts.length > 1) {
    const hit = list.find((x) => lc(x).startsWith(parts[0]) && lc(x).endsWith(parts[parts.length - 1]));
    if (hit) return hit;
  }
  return list.find((x) => name.length > 3 && (lc(x).startsWith(lc(name)) || lc(name).startsWith(lc(x)))) ?? null;
}

/** Indexes over a schema, built once per schema object. */
interface SchemaIndex {
  schemas: Set<string>;
  byName: Map<string, SqlTable[]>;
  fkFrom: Map<SqlTable, { column: string; to: string }[]>;
}

const indexes = new WeakMap<SqlSchema, SchemaIndex>();

export function schemaIndex(s: SqlSchema): SchemaIndex {
  let ix = indexes.get(s);
  if (ix) return ix;
  const byName = new Map<string, SqlTable[]>();
  const schemas = new Set<string>();
  for (const t of s.tables) {
    const k = lc(t.name);
    byName.set(k, [...(byName.get(k) ?? []), t]);
    if (t.schema) schemas.add(lc(t.schema));
  }
  const find = (schema: string | null, name: string) =>
    (byName.get(lc(name)) ?? []).find((t) => lc(t.schema ?? "") === lc(schema ?? ""));
  const fkFrom = new Map<SqlTable, { column: string; to: string }[]>();
  for (const f of s.fks) {
    const from = find(f.from.schema, f.from.table);
    if (!from) continue;
    f.from.columns.forEach((c, i) =>
      fkFrom.set(from, [...(fkFrom.get(from) ?? []), { column: c, to: `${f.to.table}.${f.to.columns[i] ?? f.to.columns[0]}` }]),
    );
  }
  ix = { schemas, byName, fkFrom };
  indexes.set(s, ix);
  return ix;
}

/** A table by optional schema and name; unqualified names follow the search path in order. */
export function findTable(s: SqlSchema, schema: string | null, name: string): SqlTable | null {
  const cands = schemaIndex(s).byName.get(lc(name)) ?? [];
  if (schema) return cands.find((t) => lc(t.schema ?? "") === lc(schema)) ?? null;
  for (const p of s.searchPath) {
    const t = cands.find((c) => lc(c.schema ?? "") === lc(p));
    if (t) return t;
  }
  return cands.find((t) => t.schema === null) ?? null;
}

export function tableColumns(s: SqlSchema, t: SqlTable): ResolvedColumn[] {
  const fks = schemaIndex(s).fkFrom.get(t) ?? [];
  return t.columns.map((c) => {
    const fk = fks.find((f) => lc(f.column) === lc(c.name));
    return { name: c.name, typeName: c.typeName, owner: t.name, table: t, key: c.pk ? "pk" : fk ? "fk" : null, fk: fk?.to ?? null, def: null };
  });
}

/** Meaningful tokens, with `::` joined and keywords and function calls marked. */
function prepare(raw: Token[], kws: Set<string>, fns: Map<string, SqlFunction>): Tk[] {
  const out: Tk[] = [];
  for (const t of raw) {
    if (t.t === "ws" || t.t === "comment") continue;
    const kind = t.t === "string" ? "s" : t.t === "quoted" ? "q" : t.t === "number" ? "n" : t.t === "word" ? "w" : "p";
    const prev = out[out.length - 1];
    if (kind === "p" && t.v === ":" && prev?.t === "p" && prev.v === ":" && prev.e === t.from) {
      prev.v = "::";
      prev.e = t.to;
      continue;
    }
    // A name after a dot is never a keyword: `s.key`, `o.order`.
    const kw = kind === "w" && kws.has(t.v.toUpperCase()) && !(prev?.t === "p" && prev.v === ".");
    out.push({ t: kind, v: t.v, s: t.from, e: t.to, kw, fn: false });
  }
  for (let i = 0; i < out.length - 1; i++)
    if (out[i].t === "w" && out[i + 1].v === "(" && fns.has(lc(out[i].v))) {
      out[i].fn = true;
      out[i].kw = false;
    }
  // NF5: a typed literal (`TIMESTAMP '2026-10-01'`, `DATE '...'`, `TIME '...'`, `INTERVAL '7 days'`,
  // `TIMESTAMP WITH TIME ZONE '...'`) is a keyword and its string, never a column name.
  for (let i = 0; i < out.length - 1; i++) {
    const u = out[i].t === "w" && !(out[i - 1]?.t === "p" && out[i - 1].v === ".") ? out[i].v.toUpperCase() : "";
    if (!TYPED_LITERAL.has(u)) continue;
    const zone = (u === "TIMESTAMP" || u === "TIME") && /^WITH(OUT)?$/i.test(out[i + 1].v) && /^TIME$/i.test(out[i + 2]?.v ?? "") && /^ZONE$/i.test(out[i + 3]?.v ?? "");
    const lit = out[i + (zone ? 4 : 1)];
    if (lit?.t !== "s") continue;
    for (let j = i; j < i + (zone ? 4 : 1); j++) out[j].kw = true;
  }
  return out;
}

const TYPED_LITERAL = new Set(["DATE", "TIME", "TIMESTAMP", "TIMESTAMPTZ", "TIMETZ", "INTERVAL"]);

let nextRefId = 0;

export function analyzeSql(text: string, dialect: DialectKind, schema: SqlSchema | null): SqlAnalysis {
  const raw = tokenize(text, dialect);
  const functions = functionMap(dialect);
  const sig = prepare(raw, keywordSet(dialect), functions);
  const A: SqlAnalysis = { dialect, schema, text, sig, raw, statements: [], segments: [], problems: [], symbols: [], intents: [], functions };
  let lo = 0;
  let st = 0;
  for (let i = 0; i <= sig.length; i++) {
    if (i === sig.length || sig[i].v === ";") {
      const hi = i < sig.length ? sig[i].s : text.length;
      const tk = sig.slice(st, i);
      const stmt = tk.length ? analyzeStmt(tk, A, hi) : null;
      A.segments.push({ lo, hi, stmt });
      if (stmt) A.statements.push(stmt);
      if (i < sig.length) lo = sig[i].e;
      st = i + 1;
    }
  }
  return A;
}

function analyzeStmt(T: Tk[], A: SqlAnalysis, hi: number): StmtScope {
  const n = T.length;
  const schema = A.schema;
  const S: StmtScope = { from: T[0].s, to: hi, tokens: T, blocks: [], refs: [], ctes: [], uses: new Set(), verb: null };
  const skip = new Set<number>();
  const prob = (p: SqlProblem) => A.problems.push(p);
  const fix = (title: string, from: number, to: number, insert: string): SqlFix => ({ title, edits: [{ from, to, insert }] });

  // Parentheses.
  const match = new Array<number>(n).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (T[i].v === "(") stack.push(i);
    else if (T[i].v === ")") {
      const o = stack.pop();
      if (o !== undefined) {
        match[o] = i;
        match[i] = o;
      } else
        prob({ from: T[i].s, to: T[i].e, severity: "error", kind: "syntax", message: "There is no ( for this ).", fixes: [fix("Remove the parenthesis", T[i].s, T[i].e, "")] });
    }
  }
  for (const o of stack)
    prob({ from: T[o].s, to: T[o].e, severity: "error", kind: "syntax", message: "This ( is never closed.", fixes: [fix("Add the closing parenthesis", T[n - 1].e, T[n - 1].e, ")")] });

  // Blocks: the statement, plus one per parenthesised SELECT or WITH.
  const newBlock = (lo: number, hiIdx: number, open: number, close: number): Block => ({
    open, close, lo, hi: hiIdx, parent: null, children: [], refs: [], columns: [], own: [], depth: 0, selAliases: new Set(), star: null, starQ: [], insertCols: [],
    select: [], clauses: [], distinct: false, orderBy: [],
  });
  const root = newBlock(0, n - 1, -1, -1);
  const blocks = [root];
  for (let i = 0; i < n; i++)
    if (T[i].v === "(" && (U(T[i + 1]) === "SELECT" || U(T[i + 1]) === "WITH"))
      blocks.push(newBlock(i + 1, match[i] > 0 ? match[i] - 1 : n - 1, i, match[i]));
  for (const b of blocks) {
    if (b === root) continue;
    let p = root;
    for (const c of blocks) if (c !== b && c !== root && c.lo <= b.open && b.open <= c.hi && (p === root || c.hi - c.lo < p.hi - p.lo)) p = c;
    b.parent = p;
    p.children.push(b);
  }
  const depthOf = (b: Block): number => (b.parent ? depthOf(b.parent) + 1 : 0);
  for (const b of blocks) b.depth = depthOf(b);
  const owner = new Array<Block>(n).fill(root);
  [...blocks].sort((a, b) => a.depth - b.depth).forEach((b) => {
    for (let k = b.lo; k <= b.hi; k++) owner[k] = b;
  });
  for (let k = 0; k < n; k++) owner[k].own.push(k);
  S.blocks = blocks;

  // CTEs.
  {
    const own = root.own;
    const W = (p: number) => T[own[p]];
    if (U(W(0)) === "WITH") {
      let p = 1;
      if (U(W(p)) === "RECURSIVE") p++;
      while (p < own.length) {
        const nt = W(p);
        if (!isW(nt) || isKW(nt)) break;
        skip.add(own[p]);
        p++;
        if (U(W(p)) === "AS") {
          skip.add(own[p]);
          p++;
        }
        if (!W(p) || W(p).v !== "(") break;
        const body = blocks.find((b) => b.open === own[p]) ?? null;
        const cte: Cte = { name: idn(nt), range: { from: nt.s, to: nt.e }, block: body };
        S.ctes.push(cte);
        A.symbols.push({ from: nt.s, to: nt.e, kind: "cte-decl", cte });
        const cl = match[own[p]];
        if (cl < 0) break;
        p = own.indexOf(cl) + 1;
        if (W(p) && W(p).v === ",") {
          p++;
          continue;
        }
        break;
      }
    }
  }

  const findRef = (b: Block | null, q: string): TableRef | null => {
    q = lc(q);
    for (let x = b; x; x = x.parent) {
      const r = x.refs.find((r) => r.alias && lc(r.alias) === q) ?? x.refs.find((r) => !r.alias && r.name && lc(r.name) === q);
      if (r) return r;
    }
    return null;
  };
  const chainRefs = (b: Block): TableRef[] => {
    let out: TableRef[] = [];
    for (let x: Block | null = b; x; x = x.parent) out = out.concat(x.refs);
    return out;
  };
  const refLabel = (r: TableRef) =>
    r.kind === "table" && r.table ? `${r.table.schema ? r.table.schema + "." : ""}${r.table.name}` : r.kind === "cte" ? (r.name ?? "") : (r.alias ?? r.name ?? "the subquery");

  function resolveTable(schemaTok: Tk | null, nameTok: Tk): RefBase {
    const name = idn(nameTok);
    const sch = schemaTok ? idn(schemaTok) : null;
    const nameRange = { from: nameTok.s, to: nameTok.e };
    if (!sch) {
      const c = S.ctes.find((c) => lc(c.name) === lc(name));
      if (c) {
        A.symbols.push({ from: nameTok.s, to: nameTok.e, kind: "cte-ref", cte: c });
        return { kind: "cte", schema: null, name: c.name, nameRange, cte: c, table: null, columns: (c.block?.columns ?? []).map((x) => ({ ...x, owner: c.name })) };
      }
    }
    if (!schema) return { kind: "noSchema", schema: sch, name, nameRange, cte: null, table: null, columns: null };
    const t = findTable(schema, sch, name);
    if (t) {
      A.symbols.push({ from: nameTok.s, to: nameTok.e, kind: "table", table: t });
      return { kind: "table", schema: t.schema, name: t.name, nameRange, cte: null, table: t, columns: tableColumns(schema, t) };
    }
    const all = schema.tables.map((x) => x.name).concat(S.ctes.map((c) => c.name));
    const sug = closest(name, all);
    const fixes: SqlFix[] = sug ? [fix(`Change to ${sug}`, nameTok.s, nameTok.e, sug)] : [];
    // Only in a schema the search path does not reach: offer to qualify it.
    if (!sch) {
      const elsewhere = (schemaIndex(schema).byName.get(lc(name)) ?? []).find((x) => x.schema);
      if (elsewhere?.schema) fixes.push(fix(`Qualify as ${elsewhere.schema}.${elsewhere.name}`, nameTok.s, nameTok.s, `${elsewhere.schema}.`));
    }
    prob({
      from: nameTok.s,
      to: nameTok.e,
      severity: "error",
      kind: "schema",
      message: `Unknown table ${name}${sch ? ` in schema ${sch}` : ""}.${sug ? ` Did you mean ${sug}?` : ""}`,
      fixes,
    });
    return { kind: "unknown", schema: sch, name, nameRange, cte: null, table: null, columns: null };
  }

  function parseRefs(b: Block) {
    const own = b.own;
    const W = (p: number) => T[own[p]];
    function ref(q: number, target = false, join: { kind: JoinKind; natural: boolean; from: number } | null = null): number {
      const t = W(q);
      if (!t) return q;
      let base: RefBase;
      let nameEnd: number;
      if (t.v === "(") {
        const child = blocks.find((c) => c.open === own[q]);
        if (!child) return q + 1;
        base = { kind: "subquery", schema: null, name: null, nameRange: null, cte: null, table: null, columns: child.columns };
        const ci = child.close >= 0 ? own.indexOf(child.close) : -1;
        nameEnd = child.close >= 0 ? T[child.close].e : T[n - 1].e;
        q = ci < 0 ? own.length : ci + 1;
      } else if (isW(t) && (!isKW(t) || !NOT_TABLE.has(U(t) ?? "") || ((U(t) === "ORDER" || U(t) === "GROUP") && U(W(q + 1)) !== "BY"))) {
        // `FROM order` is a mistyped table, not ORDER BY.
        t.kw = false;
        let schemaTok: Tk | null = null;
        let nameTok = t;
        const dot = W(q + 1);
        const after = W(q + 2);
        if (dot && dot.v === "." && isW(after)) {
          schemaTok = t;
          nameTok = after;
          after.kw = false;
          skip.add(own[q]);
          skip.add(own[q + 2]);
          q += 3;
        } else {
          skip.add(own[q]);
          q += 1;
        }
        base = resolveTable(schemaTok, nameTok);
        nameEnd = nameTok.e;
      } else return q;
      const r: TableRef = { ...base, id: ++nextRefId, alias: null, aliasRange: null, target, block: b, nameEnd, range: { from: t.s, to: nameEnd }, join: null, used: [] };
      if (U(W(q)) === "AS") {
        skip.add(own[q]);
        q++;
      }
      const at = W(q);
      if (at && isW(at) && !isKW(at) && !at.fn) {
        r.alias = idn(at);
        r.aliasRange = { from: at.s, to: at.e };
        skip.add(own[q]);
        q++;
        A.symbols.push({ from: at.s, to: at.e, kind: "alias-decl", ref: r });
      }
      r.range.to = r.aliasRange?.to ?? nameEnd;
      if (join) {
        let using: string[] | null = null;
        let on: Range | null = null;
        let end = r.range.to;
        if (U(W(q)) === "USING" && W(q + 1)?.v === "(" && match[own[q + 1]] > 0) {
          const close = match[own[q + 1]];
          using = [];
          for (let k = own[q + 1] + 1; k < close; k++) if (isW(T[k])) using.push(idn(T[k]));
          end = T[close].e;
        } else if (U(W(q)) === "ON" && isKW(W(q))) {
          let depth = 0;
          let last: Tk | null = null;
          for (let x = q + 1; x < own.length; x++) {
            const c = W(x);
            if (depth === 0 && (c.v === "," || c.v === ")" || (isKW(c) && ON_END.has(U(c)!)))) break;
            if (c.v === "(") depth++;
            if (c.v === ")") depth--;
            last = c;
          }
          if (last) {
            on = { from: W(q + 1).s, to: last.e };
            end = last.e;
          }
        }
        r.join = { kind: join.kind, natural: join.natural, using, on, range: { from: join.from, to: end } };
      }
      b.refs.push(r);
      S.refs.push(r);
      return q;
    }
    let p = 0;
    /** Inside a SELECT's FROM list, where a comma after a Join's condition adds a table. */
    let inFrom = false;
    while (p < own.length) {
      const u = U(W(p));
      if (u && isKW(W(p)) && FROM_END.has(u)) inFrom = false;
      if (u === "FROM") {
        inFrom = own.slice(0, p).some((k) => U(T[k]) === "SELECT");
        p = ref(p + 1, U(W(0)) === "DELETE");
        while (W(p) && W(p).v === ",") p = ref(p + 1, false, { kind: "comma", natural: false, from: W(p).s });
        continue;
      }
      if (u === "JOIN") {
        // The keyword run before JOIN: NATURAL, INNER, LEFT, RIGHT, FULL, OUTER, CROSS.
        let st = p;
        while (st > 0 && isKW(W(st - 1)) && JOIN_RUN.has(U(W(st - 1))!)) st--;
        const run = new Set(Array.from({ length: p - st }, (_, i) => U(W(st + i))!));
        const kind: JoinKind = run.has("CROSS") ? "cross" : run.has("LEFT") ? "left" : run.has("RIGHT") ? "right" : run.has("FULL") ? "full" : "inner";
        const r0 = b.refs.length;
        p = ref(p + 1, false, { kind, natural: run.has("NATURAL"), from: W(st).s });
        // `JOIN b ON ..., c`: a comma after the condition adds another FROM item.
        const end = b.refs[r0]?.join?.range.to ?? -1;
        while (W(p) && W(p).s < end) p++;
        if (inFrom) while (W(p) && W(p).v === ",") p = ref(p + 1, false, { kind: "comma", natural: false, from: W(p).s });
        continue;
      }
      if (u === "UPDATE" && p === 0) {
        p = ref(p + 1, true);
        continue;
      }
      if (u === "INTO") {
        const r0 = b.refs.length;
        p = ref(p + 1, true);
        const r = b.refs[r0];
        if (W(p) && W(p).v === "(" && match[own[p]] > 0) {
          const close = match[own[p]];
          for (let k = own[p] + 1; k < close; k++)
            if (isW(T[k])) {
              skip.add(k);
              b.insertCols.push({ k, ref: r });
            }
          p = own.indexOf(close) + 1;
        }
        continue;
      }
      if (u === "VIEW" && U(W(0)) === "CREATE") {
        let q = p + 1;
        if (isW(W(q))) {
          skip.add(own[q]);
          if (W(q + 1) && W(q + 1).v === "." && isW(W(q + 2))) {
            skip.add(own[q + 2]);
            q += 3;
          } else q++;
        }
        p = q;
        continue;
      }
      p++;
    }
  }

  function lookupCol(b: Block, qual: string | null, name: string): ResolvedColumn | null {
    const refs = qual ? [findRef(b, qual)].filter((r): r is TableRef => !!r) : chainRefs(b);
    for (const r of refs) if (r.columns) {
      const c = r.columns.find((c) => lc(c.name) === lc(name));
      if (c) return c;
    }
    return null;
  }

  function selectCols(b: Block) {
    const own = b.own;
    const W = (p: number) => T[own[p]];
    let p = own.findIndex((k) => U(T[k]) === "SELECT");
    b.columns = [];
    if (p < 0) return;
    p++;
    if (U(W(p)) === "DISTINCT") {
      b.distinct = true;
      p++;
    }
    const items: number[][] = [];
    let cur: number[] = [];
    let depth = 0;
    for (; p < own.length; p++) {
      const t = W(p);
      const u = U(t);
      if (depth === 0 && ["FROM", "WHERE", "GROUP", "ORDER", "LIMIT", "HAVING", "UNION", "INTERSECT", "EXCEPT"].includes(u ?? "")) break;
      if (t.v === "(") depth++;
      if (t.v === ")") depth--;
      if (depth === 0 && t.v === ",") {
        items.push(cur);
        cur = [];
        continue;
      }
      cur.push(p);
    }
    if (cur.length) items.push(cur);
    for (const it of items) {
      const tk = it.map((q) => W(q));
      const L = tk.length;
      if (!L) continue;
      const item: SelectItem = { range: { from: tk[0].s, to: tk[L - 1].e }, text: flat(A.text, tk[0].s, tk[L - 1].e), alias: null, sources: [], fn: null, column: null };
      b.select.push(item);
      if (L === 1 && tk[0].v === "*") {
        b.star = tk[0];
        for (const r of b.refs) if (r.columns) b.columns.push(...r.columns);
        continue;
      }
      if (L === 3 && tk[1].v === "." && tk[2].v === "*") {
        b.starQ.push({ tok: tk[2], from: tk[0].s, qual: idn(tk[0]) });
        const r = findRef(b, idn(tk[0]));
        if (r?.columns) b.columns.push(...r.columns);
        continue;
      }
      let name: string | null = null;
      let nameTok: Tk | null = null;
      let exprEnd = L;
      if (L >= 3 && U(tk[L - 2]) === "AS" && isW(tk[L - 1])) {
        nameTok = tk[L - 1];
        name = idn(nameTok);
        exprEnd = L - 2;
        skip.add(own[it[L - 1]]);
        skip.add(own[it[L - 2]]);
        b.selAliases.add(lc(name));
      } else if (
        L >= 2 &&
        isW(tk[L - 1]) &&
        !isKW(tk[L - 1]) &&
        tk[L - 2].v !== "." &&
        tk[L - 2].v !== "::" &&
        (tk[L - 2].v === ")" || tk[L - 2].t === "n" || tk[L - 2].t === "s")
      ) {
        nameTok = tk[L - 1];
        name = idn(nameTok);
        exprEnd = L - 1;
        skip.add(own[it[L - 1]]);
        b.selAliases.add(lc(name));
      }
      const ex = tk.slice(0, exprEnd);
      if (exprEnd < L) item.alias = name;
      if (ex.length) item.text = flat(A.text, ex[0].s, ex[ex.length - 1].e);
      if (ex.length > 1 && ex[0].fn && ex[1].v === "(" && match[own[it[1]]] === own[it[exprEnd - 1]]) item.fn = lc(ex[0].v);
      let typeName = "expr";
      let col: ResolvedColumn | null = null;
      if (ex.length === 1 && isW(ex[0]) && !isKW(ex[0])) {
        item.column = idn(ex[0]);
        col = lookupCol(b, null, idn(ex[0]));
        if (!name) {
          name = idn(ex[0]);
          nameTok = ex[0];
        }
      } else if (ex.length === 3 && ex[1].v === "." && isW(ex[2])) {
        item.column = idn(ex[2]);
        col = lookupCol(b, idn(ex[0]), idn(ex[2]));
        if (!name) {
          name = idn(ex[2]);
          nameTok = ex[2];
        }
      } else if (ex[0]?.fn) {
        typeName = A.functions.get(lc(ex[0].v))?.returns ?? "expr";
        if (!name) name = lc(ex[0].v);
      }
      const ci = ex.findIndex((t) => t.v === "::");
      if (ci >= 0 && ex[ci + 1]) typeName = lc(ex[ci + 1].v);
      else if (col) typeName = col.typeName;
      if (name)
        b.columns.push({
          name,
          typeName,
          owner: "",
          table: null,
          key: null,
          fk: null,
          def: nameTok ? { from: nameTok.s, to: nameTok.e } : null,
        });
    }
  }

  /** WHERE, GROUP BY, HAVING, ORDER BY and LIMIT at the block's top level, and the ORDER BY items. */
  function clauses(b: Block) {
    const own = b.own;
    const W = (p: number) => T[own[p]];
    let depth = 0;
    let open: { keyword: ClauseKeyword; at: number; body: number } | null = null;
    const close = (end: number) => {
      if (!open || end <= open.at) return;
      b.clauses.push({ keyword: open.keyword, range: { from: W(open.at).s, to: W(end - 1).e } });
      if (open.keyword === "ORDER BY") orderItems(b, open.body, end);
      open = null;
    };
    for (let p = 0; p < own.length; p++) {
      const t = W(p);
      if (t.v === "(") depth++;
      else if (t.v === ")") depth--;
      if (depth !== 0 || !isKW(t)) continue;
      const u = U(t)!;
      if (!CLAUSE_END.has(u) || JOIN_RUN.has(u) || u === "JOIN") continue;
      if (u === "OFFSET" && open?.keyword === "LIMIT") continue;
      if ((u === "GROUP" || u === "ORDER") && U(W(p + 1)) !== "BY") continue;
      close(p);
      const kw = CLAUSE_START[u];
      if (kw) open = { keyword: kw, at: p, body: kw === "GROUP BY" || kw === "ORDER BY" ? p + 2 : p + 1 };
    }
    close(own.length);
  }

  function orderItems(b: Block, from: number, to: number) {
    const W = (p: number) => T[b.own[p]];
    const parts: [number, number][] = [];
    let st = from;
    let depth = 0;
    for (let p = from; p <= to; p++) {
      const t = W(p);
      if (p === to || (depth === 0 && t.v === ",")) {
        if (p > st) parts.push([st, p]);
        st = p + 1;
        continue;
      }
      if (t.v === "(") depth++;
      if (t.v === ")") depth--;
    }
    for (const [a, z] of parts) {
      let end = z;
      let desc = false;
      if (end - 2 > a && U(W(end - 2)) === "NULLS") end -= 2;
      const dir = U(W(end - 1));
      if ((dir === "ASC" || dir === "DESC") && end - 1 > a) {
        desc = dir === "DESC";
        end--;
      }
      const text = flat(A.text, W(a).s, W(end - 1).e);
      const key = lc(text);
      let output = b.select.findIndex((s) => s.alias !== null && lc(s.alias) === key);
      if (output < 0) output = b.select.findIndex((s) => s.alias === null && lc(s.text) === key);
      if (output < 0 && end - a === 1 && isW(W(a)))
        output = b.select.findIndex((s) => s.alias === null && s.column !== null && lc(s.column) === lc(idn(W(a))));
      if (output < 0 && /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= b.select.length) output = Number(text) - 1;
      b.orderBy.push({ range: { from: W(a).s, to: W(z - 1).e }, text, desc, output: output < 0 ? null : output });
    }
  }

  const proc = (b: Block) => {
    b.children.sort((x, y) => x.lo - y.lo).forEach(proc);
    parseRefs(b);
    selectCols(b);
    clauses(b);
  };
  proc(root);

  const schemas = schema ? schemaIndex(schema).schemas : new Set<string>();

  /** A column read through `ref`: on the reference, and on the SELECT item that holds it. */
  const use = (b: Block, from: number, to: number, ref: TableRef, column: string) => {
    ref.used.push({ column, range: { from, to } });
    const item = b.select.find((x) => x.range.from <= from && to <= x.range.to);
    if (item) item.sources.push({ ref, column });
  };

  function resolve(b: Block) {
    const own = b.own;
    const W = (p: number) => T[own[p]];
    const refs = chainRefs(b);
    const aliasesAll = new Set<string>();
    for (let x: Block | null = b; x; x = x.parent) x.selAliases.forEach((a) => aliasesAll.add(a));
    for (let p = 0; p < own.length; p++) {
      const k = own[p];
      const t = T[k];
      if (skip.has(k) || !isW(t) || isKW(t)) continue;
      if (t.fn) {
        A.symbols.push({ from: t.s, to: t.e, kind: "function", name: lc(t.v) });
        continue;
      }
      const prev = W(p - 1);
      const next = W(p + 1);
      if (prev && (prev.v === "." || prev.v === "::")) continue;
      if (next && next.v === ".") {
        const ct = W(p + 2);
        S.uses.add(lc(idn(t)));
        const r = findRef(b, idn(t));
        if (r) A.symbols.push({ from: t.s, to: t.e, kind: "qual", ref: r });
        else if (schema && !schemas.has(lc(idn(t)))) {
          const names = refs.map((r) => r.alias ?? r.name).filter((x): x is string => !!x);
          const sug = closest(idn(t), names);
          prob({ from: t.s, to: t.e, severity: "error", kind: "schema", message: `Unknown table or alias ${idn(t)}.${sug ? ` Did you mean ${sug}?` : ""}`, fixes: sug ? [fix(`Change to ${sug}`, t.s, t.e, sug)] : [] });
        }
        if (ct && isW(ct) && !isKW(ct)) {
          skip.add(own[p + 2]);
          if (r?.columns) {
            const c = r.columns.find((c) => lc(c.name) === lc(idn(ct)));
            if (c) {
              A.symbols.push({ from: ct.s, to: ct.e, kind: "column", column: c, ref: r });
              use(b, t.s, ct.e, r, c.name);
            } else {
              const sug = closest(idn(ct), r.columns.map((c) => c.name));
              prob({
                from: ct.s,
                to: ct.e,
                severity: "error",
                kind: r.kind === "table" ? "schema" : "query",
                message: `Unknown column ${idn(ct)} in ${refLabel(r)}.${sug ? ` Did you mean ${sug}?` : ""}`,
                fixes: sug ? [fix(`Change to ${sug}`, ct.s, ct.e, sug)] : [],
              });
            }
          } else if (r) use(b, t.s, ct.e, r, idn(ct));
        } else if (!ct || ct.v !== "*") {
          prob({ from: next.s, to: next.e, severity: "error", kind: "syntax", message: `Expected a column name after ${t.v}.`, fixes: [] });
        }
        p += 1;
        continue;
      }
      const nm = lc(idn(t));
      if (aliasesAll.has(nm)) continue;
      if (S.ctes.some((c) => lc(c.name) === nm) || refs.some((r) => r.alias && lc(r.alias) === nm)) continue;
      const cands = refs.filter((r) => r.columns?.some((c) => lc(c.name) === nm));
      const inner = cands.filter((r) => b.refs.includes(r));
      const list = inner.length ? inner : cands;
      if (list.length === 1) {
        const c = list[0].columns!.find((c) => lc(c.name) === nm)!;
        A.symbols.push({ from: t.s, to: t.e, kind: "column", column: c, ref: list[0] });
        use(b, t.s, t.e, list[0], c.name);
        continue;
      }
      if (list.length > 1) {
        prob({
          from: t.s,
          to: t.e,
          severity: "error",
          kind: "schema",
          message: `Column ${nm} is ambiguous. It is in ${list.map(refLabel).join(" and ")}.`,
          fixes: list.map((r) => {
            const q = r.alias ?? r.name ?? "";
            return fix(`Qualify as ${q}.${t.v}`, t.s, t.s, `${q}.`);
          }),
        });
        continue;
      }
      if (refs.length && refs.every((r) => r.columns)) {
        const all = [...new Set(refs.flatMap((r) => r.columns!.map((c) => c.name)))];
        const sug = closest(nm, all);
        prob({
          from: t.s,
          to: t.e,
          severity: "error",
          kind: refs.some((r) => r.kind === "table") ? "schema" : "query",
          message: `Unknown column ${idn(t)}.${sug ? ` Did you mean ${sug}?` : ""}`,
          fixes: sug ? [fix(`Change to ${sug}`, t.s, t.e, sug)] : [],
        });
      }
    }
    for (const ic of b.insertCols) {
      const r = ic.ref;
      const t = T[ic.k];
      if (!r?.columns) continue;
      const c = r.columns.find((c) => lc(c.name) === lc(idn(t)));
      if (c) A.symbols.push({ from: t.s, to: t.e, kind: "column", column: c, ref: r });
      else {
        const sug = closest(idn(t), r.columns.map((c) => c.name));
        prob({ from: t.s, to: t.e, severity: "error", kind: "schema", message: `Unknown column ${idn(t)} in ${refLabel(r)}.${sug ? ` Did you mean ${sug}?` : ""}`, fixes: sug ? [fix(`Change to ${sug}`, t.s, t.e, sug)] : [] });
      }
    }
  }
  blocks.forEach(resolve);

  // Unused aliases; a subquery needs its alias.
  for (const r of S.refs)
    if (r.aliasRange && r.alias && r.kind !== "subquery" && !S.uses.has(lc(r.alias)))
      prob({ from: r.aliasRange.from, to: r.aliasRange.to, severity: "hint", kind: "query", message: `Alias ${r.alias} is never used.`, fixes: [fix("Remove alias", r.nameEnd, r.aliasRange.to, "")] });

  // Syntax.
  for (let i = 0; i < n; i++) {
    const t = T[i];
    const u = U(t);
    const nx = T[i + 1];
    const nu = isKW(nx) ? U(nx) : null;
    if (t.v === "," && (!nx || CLAUSE.has(nu ?? "") || nx.v === ")")) {
      const at = nx ?? t;
      prob({ from: at.s, to: at.e, severity: "error", kind: "syntax", message: nx ? `Expected a column after the comma, found ${nx.v}.` : "Expected a column after the comma.", fixes: [fix("Remove the comma", t.s, t.e, "")] });
    }
    if ((u === "FROM" || u === "JOIN") && t.kw && (!nx || CLAUSE.has(nu ?? "") || nu === "JOIN" || nu === "ON"))
      prob({ from: t.s, to: t.e, severity: "error", kind: "syntax", message: `Expected a table name after ${u}.`, fixes: [] });
    if (u === "SELECT" && nu === "FROM" && nx) prob({ from: nx.s, to: nx.e, severity: "error", kind: "syntax", message: "Expected a column list after SELECT.", fixes: [] });
    if (["WHERE", "ON", "AND", "OR"].includes(u ?? "") && t.kw && (!nx || CLAUSE.has(nu ?? "")))
      prob({ from: t.s, to: t.e, severity: "error", kind: "syntax", message: `Expected a condition after ${u}.`, fixes: [] });
    // P15: a comparison with nothing on its right.
    // Not `ORDER BY x USING >` or `OPERATOR(pg_catalog.=)`.
    const opName = U(T[i - 1]) === "USING" || T[i - 1]?.v === ".";
    if (!opName && t.t === "p" && COMPARISON.test(t.v) && !(T[i - 1]?.t === "p" && COMPARISON.test(T[i - 1].v) && T[i - 1].e === t.s)) {
      let j = i;
      while (T[j + 1]?.t === "p" && COMPARISON.test(T[j + 1].v) && T[j + 1].s === T[j].e) j++;
      const after = T[j + 1];
      const au = isKW(after) ? U(after) : null;
      if (!after || after.v === ")" || after.v === "," || CLAUSE.has(au ?? "") || au === "AND" || au === "OR" || au === "THEN")
        prob({ from: t.s, to: T[j].e, severity: "error", kind: "syntax", message: `A value is missing after ${A.text.slice(t.s, T[j].e)}.`, fixes: [] });
    }
  }

  // UPDATE or DELETE without WHERE.
  const first = U(T[0]);
  S.verb = first;
  if ((first === "UPDATE" || first === "DELETE") && !root.own.some((k) => U(T[k]) === "WHERE")) {
    const r = root.refs.find((r) => r.target) ?? root.refs[0];
    const target = r?.name ?? "the table";
    prob({
      from: T[0].s,
      to: r?.nameRange ? r.nameRange.to : T[0].e,
      severity: "warning",
      kind: "query",
      message: `${first} without WHERE changes every row in ${target}.`,
      fixes: [fix("Add WHERE", T[n - 1].e, T[n - 1].e, "\nWHERE ")],
    });
  }

  // Intention: expand * into the column list.
  for (const b of blocks) {
    if (b.star && b.refs.length && b.refs.every((r) => r.columns)) {
      const one = b.refs.length === 1 && !b.refs[0].alias;
      const list = one
        ? b.refs[0].columns!.map((c) => c.name).join(", ")
        : b.refs.map((r) => r.columns!.map((c) => `${r.alias ?? r.name}.${c.name}`).join(", ")).join(",\n       ");
      A.intents.push({ from: b.star.s, to: b.star.e, title: "Expand column list", edits: [{ from: b.star.s, to: b.star.e, insert: list }] });
    }
    for (const sq of b.starQ) {
      const r = findRef(b, sq.qual);
      if (r?.columns)
        A.intents.push({ from: sq.from, to: sq.tok.e, title: `Expand ${sq.qual}.* into columns`, edits: [{ from: sq.from, to: sq.tok.e, insert: r.columns.map((c) => `${sq.qual}.${c.name}`).join(", ") }] });
    }
  }
  return S;
}

/** The statement whose text holds `pos`. */
export function statementAt(A: SqlAnalysis, pos: number): StmtScope | null {
  return A.segments.find((s) => s.lo <= pos && pos <= s.hi)?.stmt ?? null;
}

/** The innermost block holding `pos`. */
export function blockAt(S: StmtScope, pos: number): Block {
  let best = S.blocks[0];
  for (const b of S.blocks) {
    if (b.open < 0) continue;
    const lo = S.tokens[b.open].e;
    const hi = b.close >= 0 ? S.tokens[b.close].s : S.to;
    if (lo <= pos && pos <= hi && b.depth >= best.depth) best = b;
  }
  return best;
}

/** The table reference `qual` names, as seen from `pos`. */
export function refAt(A: SqlAnalysis, pos: number, qual: string): TableRef | null {
  const S = statementAt(A, pos);
  if (!S) return null;
  const q = lc(qual);
  for (let x: Block | null = blockAt(S, pos); x; x = x.parent) {
    const r = x.refs.find((r) => r.alias && lc(r.alias) === q) ?? x.refs.find((r) => !r.alias && r.name && lc(r.name) === q);
    if (r) return r;
  }
  return null;
}

export function symbolAt(A: SqlAnalysis, pos: number): SqlSymbol | null {
  return A.symbols.find((s) => s.from <= pos && pos <= s.to) ?? null;
}
