// The query diagram's reading of the current statement (spec "How the diagram
// reads the current statement"): table cards, Join lines, and the Result node,
// all from the analysis the editor already has. It never asks the server.
import type { DialectKind } from "../../api/types";
import type { Port } from "../../diagram/types";
import { type Block, closest, findTable, flat, idn, isKW, isW, lc, type Range, type SqlAnalysis, statementAt, type StmtScope, type TableRef, type Tk, U } from "./analyze";
import type { SchemaState } from "./inspect";

export type ShapeColumn = { name: string; type: string | null; pk: boolean };

export type ShapeTable = {
  /** Alias and table, unique in the shape. */
  key: string;
  kind: "table" | "view" | "derived" | "unknown";
  schema: string | null;
  name: string;
  alias: string | null;
  columns: ShapeColumn[];
  /** Columns not shown as rows. */
  more: number;
  /** Where the statement names the table: the reference, its Join, and every column read through it. */
  ranges: Range[];
  /**
   * Where the rows come from. `loaded`: the schema index (or, for a derived card, the statement).
   * `loading`: the index has not arrived yet, so only the columns the statement names are shown.
   * `none`: there is no schema for this tab, so only the columns the statement names are shown, for good.
   */
  schemaState: SchemaState;
};

export type ShapeJoinKind = "inner" | "left" | "right" | "full" | "cross" | "where" | "condition";

export type ShapeJoin = {
  /** The card key the line starts at: the joined table, or the left side of a WHERE equality. */
  from: string;
  to: string;
  /** Column pairs, `from` side first; none for CROSS JOIN and condition lines. */
  ports?: { from: Port; to: Port }[];
  kind: ShapeJoinKind;
  /** "Inner join", the condition text cut to 40 characters, or "in WHERE". */
  label: string;
  range: Range;
};

export type ShapeOutput = { name: string; source: string; type: string | null; from: Port[] };

export interface QueryShape {
  tables: ShapeTable[];
  joins: ShapeJoin[];
  result: {
    columns: ShapeOutput[];
    /** Output rows past the first 30. */
    more: number;
    clauses: { keyword: string; text: string; range: Range }[];
    limit: string | null;
    /** ORDER BY items; `output` is the Result row an item sorts by, when it is one. */
    sorts: { text: string; desc: boolean; output: number | null }[];
    selectRange: Range;
  };
  /** "Shows the first of 2 parts of a UNION." */
  note: string | null;
}

export type ShapeProblem = { kind: "syntax"; line: number; message: string } | { kind: "notRead"; verb: string } | { kind: "noStatement" };

/** Rows a card or the Result shows before counting the rest as `more`. */
export const SHAPE_ROWS = 30;

const SET_OPS = new Set(["UNION", "INTERSECT", "EXCEPT"]);
/** What can follow a WITH list. VALUES and TABLE are reads, like SELECT. */
const VERBS = new Set(["SELECT", "VALUES", "TABLE", "INSERT", "UPDATE", "DELETE", "MERGE"]);
/** Statements of MySQL, PostgreSQL and SQLite that are not reads; any other first word is a typing mistake. */
export const NOT_READ = new Set(
  [
    // Writes and DDL.
    "INSERT UPDATE DELETE MERGE REPLACE CREATE ALTER DROP TRUNCATE RENAME COMMENT GRANT REVOKE REASSIGN SECURITY IMPORT LOAD COPY",
    // Sessions, transactions and prepared statements.
    "SET RESET SHOW USE BEGIN START COMMIT ROLLBACK SAVEPOINT RELEASE END ABORT XA LOCK UNLOCK PREPARE EXECUTE EXEC DEALLOCATE DECLARE FETCH CLOSE MOVE DISCARD LISTEN NOTIFY UNLISTEN",
    // Routines, diagnostics and the client.
    "CALL DO SIGNAL RESIGNAL GET HELP EXPLAIN DESCRIBE DESC DELIMITER",
    // Maintenance and the server.
    "ANALYZE VACUUM REINDEX CLUSTER REFRESH CHECKPOINT OPTIMIZE REPAIR CHECK CHECKSUM KILL FLUSH PURGE CACHE HANDLER INSTALL UNINSTALL STOP CHANGE BINLOG SHUTDOWN RESTART CLONE PRAGMA ATTACH DETACH",
  ]
    .join(" ")
    .split(" "),
);
const NUMBER_TYPE = /^(tiny|small|medium|big)?int|^integer|^numeric|^decimal|^real|^double|^float|^money|^number|^serial|^bigserial|^smallserial/i;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The Result header: "4 columns, up to 50 rows" or "4 columns, all rows". */
export function resultHeader(s: QueryShape): string {
  const n = s.result.columns.length + s.result.more;
  const rows = s.result.limit === null ? "all rows" : `up to ${s.result.limit} ${s.result.limit === "1" ? "row" : "rows"}`;
  return `${plural(n, "column")}, ${rows}`;
}

/** The verb the statement runs, past any opening brackets: after WITH, the first verb outside the CTE bodies. */
function mainVerb(S: StmtScope, top: Block, at: number): string {
  const T = S.tokens;
  const first = U(T[at]) ?? T[at]?.v ?? "";
  if (first !== "WITH") return first;
  let depth = 0;
  for (const k of top.own) {
    if (k <= at) continue;
    const t = T[k];
    if (t.v === "(") depth++;
    else if (t.v === ")") depth--;
    else if (depth === 0 && isKW(t) && VERBS.has(U(t)!)) return U(t)!;
  }
  return first;
}

/** Splits tokens at top-level AND (and OR when asked); the AND of a BETWEEN stays inside. */
function splitTop(tokens: Tk[], withOr: boolean): Tk[][] {
  const parts: Tk[][] = [];
  let cur: Tk[] = [];
  let depth = 0;
  let between = false;
  for (const t of tokens) {
    if (t.v === "(") depth++;
    if (t.v === ")") depth--;
    const u = depth === 0 && isKW(t) ? U(t) : null;
    if (u === "BETWEEN") between = true;
    if (u === "AND" && between) between = false;
    else if (u === "AND" || (withOr && u === "OR")) {
      if (cur.length) parts.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

/** 1-based line of an offset. */
function lineOf(text: string, at: number): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < at; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** `schemaState` is the tab's, as for diagnostics: it tells a schema still loading from none at all. */
export function queryShape(a: SqlAnalysis, pos: number, schemaState: SchemaState = "none"): QueryShape | ShapeProblem {
  const S = statementAt(a, pos);
  if (!S) return { kind: "noStatement" };
  const T = S.tokens;
  const root = S.blocks[0];
  // `((SELECT 1)) UNION (SELECT 2)`: the verb and the drawn block are inside the opening brackets.
  let at = 0;
  while (T[at]?.v === "(") at++;
  const top = at ? (S.blocks.find((b) => b.open === at - 1) ?? root) : root;
  const verb = mainVerb(S, top, at);
  const syntax = a.problems.filter((p) => p.kind === "syntax" && p.from >= S.from && p.from <= S.to).sort((x, y) => x.from - y.from)[0];
  // VALUES and TABLE are reads, bare or after a WITH list; they are not in NOT_READ.
  if (NOT_READ.has(verb)) return { kind: "notRead", verb };
  if (syntax) return { kind: "syntax", line: lineOf(a.text, syntax.from), message: syntax.message };
  if (verb === "WITH") return { kind: "syntax", line: lineOf(a.text, S.from), message: "Expected SELECT after the WITH list." };
  if (verb === "VALUES" || verb === "TABLE") return otherRead(a, S, top, verb, schemaState);
  if (verb !== "SELECT") {
    const sug = closest(verb, ["SELECT"]);
    return { kind: "syntax", line: lineOf(a.text, S.from), message: `Unknown statement ${verb}.${sug ? ` Did you mean ${sug}?` : ""}` };
  }
  const state: SchemaState = a.schema ? "loaded" : schemaState === "loading" ? "loading" : "none";

  // UNION, INTERSECT, EXCEPT: only the first part is drawn.
  let end = Infinity;
  let ops = 0;
  let firstOp = "";
  {
    let depth = 0;
    // The root's own tokens, so `(SELECT ...) UNION (SELECT ...)` counts too.
    for (const k of root.own) {
      const t = T[k];
      if (t.v === "(") depth++;
      if (t.v === ")") depth--;
      if (depth === 0 && isKW(t) && SET_OPS.has(U(t)!)) {
        if (!ops) {
          end = t.s;
          firstOp = U(t)!;
        }
        ops++;
      }
    }
  }
  const before = (r: Range) => r.from < end;
  const refs = top.refs.filter((r) => before(r.range));
  const select = top.select.filter((x) => before(x.range));
  const isStar = (text: string) => text === "*" || /\.\s*\*$/.test(text);
  const starRef = (text: string): TableRef | null => {
    const q = lc(text.replace(/\s*\.\s*\*$/, "").replace(/^["`]|["`]$/g, ""));
    return refs.find((r) => r.alias && lc(r.alias) === q) ?? refs.find((r) => !r.alias && r.name && lc(r.name) === q) ?? null;
  };

  // Cards.
  const starred = new Set<TableRef>();
  for (const x of select) {
    if (x.text === "*") refs.forEach((r) => starred.add(r));
    else if (isStar(x.text)) {
      const r = starRef(x.text);
      if (r) starred.add(r);
    }
  }
  const keyOf = new Map<TableRef, string>();
  const taken = new Set<string>();
  const tables: ShapeTable[] = refs.map((r) => {
    const kind: ShapeTable["kind"] =
      r.kind === "table" ? (r.table?.kind === "table" ? "table" : "view") : r.kind === "cte" || r.kind === "subquery" ? "derived" : r.kind === "unknown" ? "unknown" : "table";
    const schema = r.kind === "table" ? (r.table?.schema ?? null) : r.kind === "unknown" || r.kind === "noSchema" ? r.schema : null;
    const name = r.kind === "subquery" ? (r.alias ?? "subquery") : (r.name ?? "");
    let key = `${r.alias ?? ""}:${schema ? schema + "." : ""}${name}`;
    for (let n = 2; taken.has(key); n++) key = `${key.replace(/#\d+$/, "")}#${n}`;
    taken.add(key);
    keyOf.set(r, key);
    const used = r.used.filter((u) => before(u.range));
    let all: ShapeColumn[];
    let shown: ShapeColumn[];
    if (r.columns) {
      all = r.columns.map((c) => ({ name: c.name, type: c.typeName === "expr" ? null : c.typeName, pk: c.key === "pk" }));
      if (kind === "derived" || starred.has(r)) shown = all;
      else {
        const names = new Set(used.map((u) => lc(u.column)));
        shown = all.filter((c) => names.has(lc(c.name)));
        shown = [...shown.filter((c) => c.pk), ...shown.filter((c) => !c.pk)];
      }
    } else {
      const seen = new Set<string>();
      shown = [];
      for (const u of used)
        if (!seen.has(lc(u.column))) {
          seen.add(lc(u.column));
          shown.push({ name: u.column, type: null, pk: false });
        }
      all = shown;
    }
    const columns = shown.slice(0, SHAPE_ROWS);
    const ranges = [r.range, ...(r.join ? [r.join.range] : []), ...used.map((u) => u.range)];
    return { key, kind, schema, name, alias: r.alias, columns, more: all.length - columns.length, ranges, schemaState: r.kind === "noSchema" ? state : "loaded" };
  });

  // Every column use by its range, and the card at each use's start: lookups stay linear in the joins.
  const useAt = new Map<string, { ref: TableRef; column: string }>();
  const refAtStart = new Map<number, TableRef>();
  for (const r of refs)
    for (const u of r.used) {
      useAt.set(`${u.range.from}:${u.range.to}`, { ref: r, column: u.column });
      if (!refAtStart.has(u.range.from)) refAtStart.set(u.range.from, r);
    }
  /** A side of a comparison that is one column read through a card. */
  const side = (toks: Tk[]): { ref: TableRef; column: string } | null => {
    if (!(toks.length === 1 || (toks.length === 3 && toks[1].v === "."))) return null;
    return useAt.get(`${toks[0].s}:${toks[toks.length - 1].e}`) ?? null;
  };
  /** `a.x = b.y` between two different cards. */
  const pairOf = (part: Tk[]) => {
    const eq = part.findIndex(
      (t, i) => t.v === "=" && !(part[i - 1]?.t === "p" && part[i - 1].e === t.s) && !(part[i + 1]?.t === "p" && part[i + 1].s === t.e),
    );
    if (eq < 0) return null;
    const l = side(part.slice(0, eq));
    const r = side(part.slice(eq + 1));
    return l && r && l.ref !== r.ref ? { l, r } : null;
  };
  /** The statement's tokens inside `r`, found by binary search. */
  const tokensIn = (r: Range) => {
    let lo = 0;
    let hi = T.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (T[mid].s < r.from) lo = mid + 1;
      else hi = mid;
    }
    let z = lo;
    while (z < T.length && T[z].e <= r.to) z++;
    return T.slice(lo, z);
  };
  const port = (x: { ref: TableRef; column: string }): Port => ({ node: keyOf.get(x.ref)!, port: x.column });
  const partRange = (part: Tk[]): Range => ({ from: part[0].s, to: part[part.length - 1].e });
  const partText = (part: Tk[]) => flat(a.text, part[0].s, part[part.length - 1].e);
  /** Cards some tokens read, in the order they read them. */
  const readIn = (toks: Tk[]) => {
    const out: TableRef[] = [];
    for (const t of toks) {
      const r = refAtStart.get(t.s);
      if (r && !out.includes(r)) out.push(r);
    }
    return out;
  };

  // Join lines.
  const joins: ShapeJoin[] = [];
  const KIND_LABEL = { inner: "Inner join", left: "Left join", right: "Right join", full: "Full join", cross: "Cross join" } as const;
  refs.forEach((r, i) => {
    if (!r.join || i === 0) return;
    const kind = r.join.kind === "comma" ? "cross" : r.join.kind;
    const pairs: { from: Port; to: Port }[] = [];
    const prev = refs[i - 1];
    let to: TableRef | null = null;
    const conditions: Tk[][] = [];
    const shared = (names: string[]) => {
      const others = refs.slice(0, i);
      for (const n of names) {
        const other = [...others].reverse().find((o) => o.columns?.some((c) => lc(c.name) === lc(n))) ?? (r.join!.using ? prev : null);
        if (!other) continue;
        to ??= other;
        const mine = r.columns?.find((c) => lc(c.name) === lc(n))?.name ?? n;
        const theirs = other.columns?.find((c) => lc(c.name) === lc(n))?.name ?? n;
        pairs.push({ from: port({ ref: r, column: mine }), to: port({ ref: other, column: theirs }) });
      }
    };
    if (r.join.using) shared(r.join.using);
    else if (r.join.natural && r.columns)
      shared(r.columns.map((c) => c.name).filter((n) => refs.slice(0, i).some((o) => o.columns?.some((c) => lc(c.name) === lc(n)))));
    else if (r.join.on)
      for (const part of splitTop(tokensIn(r.join.on), false)) {
        const p = pairOf(part);
        // A pair between two other cards does not touch this Join's line: it is a condition.
        if (!p || (p.l.ref !== r && p.r.ref !== r)) {
          conditions.push(part);
          continue;
        }
        const [mine, theirs] = p.r.ref === r ? [p.r, p.l] : [p.l, p.r];
        to ??= theirs.ref === r ? mine.ref : theirs.ref;
        pairs.push({ from: port(mine), to: port(theirs) });
      }
    const target = to ?? prev;
    const line: ShapeJoin = { from: keyOf.get(r)!, to: keyOf.get(target)!, kind, label: KIND_LABEL[kind], range: r.join.range };
    if (pairs.length && kind !== "cross") line.ports = pairs;
    joins.push(line);
    for (const part of conditions) {
      const range = partRange(part);
      const other = readIn(part).find((x) => x !== r) ?? target;
      joins.push({ from: keyOf.get(r)!, to: keyOf.get(other)!, kind: "condition", label: cut(partText(part), 40), range });
    }
  });

  // Clauses, and WHERE equalities as lines.
  const clauses: QueryShape["result"]["clauses"] = [];
  if (top.distinct) {
    const sel = top.own.find((k) => U(T[k]) === "SELECT");
    const d = sel !== undefined ? T[sel + 1] : undefined;
    if (d) clauses.push({ keyword: "DISTINCT", text: "", range: { from: d.s, to: d.e } });
  }
  let limit: string | null = null;
  for (const c of top.clauses) {
    if (!before(c.range)) continue;
    const body = tokensIn(c.range).slice(c.keyword === "GROUP BY" || c.keyword === "ORDER BY" ? 2 : 1);
    const text = body.length ? flat(a.text, body[0].s, body[body.length - 1].e) : "";
    if (c.keyword === "WHERE" || c.keyword === "HAVING") {
      const n = splitTop(body, true).length;
      let on = "";
      if (c.keyword === "WHERE") {
        const read = new Set(readIn(body));
        const names = refs.filter((r) => read.has(r)).map((r) => r.alias ?? r.name ?? "");
        on = names.length ? ` on ${names.join(", ")}` : "";
        for (const part of splitTop(body, false)) {
          const p = pairOf(part);
          if (p)
            joins.push({
              from: keyOf.get(p.l.ref)!,
              to: keyOf.get(p.r.ref)!,
              ports: [{ from: port(p.l), to: port(p.r) }],
              kind: "where",
              label: "in WHERE",
              range: partRange(part),
            });
        }
      }
      clauses.push({ keyword: c.keyword, text: `${plural(n, "condition")}${on}`, range: c.range });
      continue;
    }
    if (c.keyword === "LIMIT" && body.length) {
      const comma = body.findIndex((t) => t.v === ",");
      const n = comma >= 0 ? body[comma + 1] : body[0];
      // `LIMIT ALL` is no limit.
      limit = n && n.t === "n" ? n.v : null;
    }
    if (c.keyword === "FETCH") limit = body.find((t) => t.t === "n")?.v ?? "1";
    clauses.push({ keyword: c.keyword, text, range: c.range });
  }

  // The Result rows.
  const outputs: ShapeOutput[] = [];
  const typeOf = (x: { ref: TableRef; column: string }) => x.ref.columns?.find((c) => lc(c.name) === lc(x.column))?.typeName ?? null;
  const expand = (r: TableRef) => {
    for (const c of r.columns!)
      outputs.push({ name: c.name, source: `${r.alias ?? r.name}.${c.name}`, type: c.typeName === "expr" ? null : c.typeName, from: [port({ ref: r, column: c.name })] });
  };
  for (const x of select) {
    if (x.text === "*" && refs.length && refs.every((r) => r.columns)) {
      refs.forEach(expand);
      continue;
    }
    if (isStar(x.text) && x.text !== "*") {
      const r = starRef(x.text);
      if (r?.columns) {
        expand(r);
        continue;
      }
    }
    const sources = x.sources.filter((s) => keyOf.has(s.ref));
    let type: string | null = null;
    const arg = sources[0] ? typeOf(sources[0]) : null;
    if (x.fn === "count") type = a.dialect === "sqlite" ? "integer" : "bigint";
    else if (x.fn === "sum" || x.fn === "avg") type = arg && NUMBER_TYPE.test(arg) ? numericType(a.dialect) : null;
    else if (x.fn === "min" || x.fn === "max") type = arg;
    else if (!x.fn && x.column && sources.length === 1) type = arg;
    if (type === "expr") type = null;
    outputs.push({ name: x.alias ?? x.column ?? x.text, source: cut(x.text, 32), type, from: sources.map(port) });
  }

  const selTok = top.own.map((k) => T[k]).find((t) => U(t) === "SELECT");
  const lastItem = select[select.length - 1];
  const selectRange = selTok ? { from: selTok.s, to: lastItem ? lastItem.range.to : selTok.e } : { from: S.from, to: S.from };
  const article = firstOp === "UNION" ? "a" : "an";
  return {
    tables,
    joins,
    result: {
      columns: outputs.slice(0, SHAPE_ROWS),
      more: Math.max(0, outputs.length - SHAPE_ROWS),
      clauses,
      limit,
      sorts: top.orderBy.filter((o) => before(o.range)).map((o) => ({ text: o.text, desc: o.desc, output: o.output })),
      selectRange,
    },
    note: ops ? `Shows the first of ${ops + 1} parts of ${article} ${firstOp}.` : null,
  };
}

function numericType(d: DialectKind): string | null {
  return d === "postgres" ? "numeric" : d === "mysql" ? "decimal" : null;
}

/** `VALUES (...)` and `TABLE t`: reads the diagram draws without a SELECT list. */
function otherRead(a: SqlAnalysis, S: StmtScope, top: Block, verb: "VALUES" | "TABLE", schemaState: SchemaState): QueryShape {
  const T = S.tokens;
  const own = top.own;
  let depth = 0;
  let p = -1;
  for (let i = 0; i < own.length; i++) {
    const t = T[own[i]];
    if (t.v === "(") depth++;
    else if (t.v === ")") depth--;
    else if (depth === 0 && isKW(t) && U(t) === verb) {
      p = i;
      break;
    }
  }
  const kw = T[own[p]];
  const shape: QueryShape = {
    tables: [],
    joins: [],
    result: { columns: [], more: 0, clauses: [], limit: null, sorts: [], selectRange: { from: kw.s, to: kw.e }, },
    note: null,
  };
  if (verb === "VALUES") {
    // The first row gives the column count: column1, column2 ... (column_0 ... on MySQL).
    let i = p + 1;
    if (U(T[own[i]]) === "ROW") i++;
    const open = T[own[i]];
    if (open?.v !== "(") return shape;
    let n = 1;
    let d = 0;
    let j = i + 1;
    for (; j < own.length; j++) {
      const t = T[own[j]];
      if (t.v === "(") d++;
      else if (t.v === ")") {
        if (d === 0) break;
        d--;
      } else if (d === 0 && t.v === ",") n++;
    }
    const names = Array.from({ length: n }, (_, k) => (a.dialect === "mysql" ? `column_${k}` : `column${k + 1}`));
    shape.result.columns = names.slice(0, SHAPE_ROWS).map((name) => ({ name, source: "VALUES", type: null, from: [] }));
    shape.result.more = Math.max(0, n - SHAPE_ROWS);
    shape.result.selectRange = { from: kw.s, to: T[own[Math.min(j, own.length - 1)]].e };
    return shape;
  }
  // TABLE t is SELECT * FROM t.
  const t1 = T[own[p + 1]];
  if (!isW(t1)) return shape;
  const dotted = T[own[p + 2]]?.v === "." && isW(T[own[p + 3]]);
  const nameTok = dotted ? T[own[p + 3]] : t1;
  const sch = dotted ? idn(t1) : null;
  const name = idn(nameTok);
  const table = a.schema ? findTable(a.schema, sch, name) : null;
  const state: SchemaState = a.schema ? "loaded" : schemaState === "loading" ? "loading" : "none";
  const all = (table?.columns ?? []).map((c) => ({ name: c.name, type: c.typeName, pk: c.pk }));
  const key = `:${table?.schema ?? sch ?? ""}${table?.schema || sch ? "." : ""}${table?.name ?? name}`;
  const columns = all.slice(0, SHAPE_ROWS);
  shape.tables.push({
    key,
    kind: table ? (table.kind === "table" ? "table" : "view") : a.schema ? "unknown" : "table",
    schema: table?.schema ?? sch,
    name: table?.name ?? name,
    alias: null,
    columns,
    more: all.length - columns.length,
    ranges: [{ from: kw.s, to: nameTok.e }],
    schemaState: table || a.schema ? "loaded" : state,
  });
  shape.result.columns = columns.map((c) => ({ name: c.name, source: `${table?.name ?? name}.${c.name}`, type: c.type, from: [{ node: key, port: c.name }] }));
  shape.result.more = all.length - columns.length;
  shape.result.selectRange = { from: kw.s, to: nameTok.e };
  return shape;
}
