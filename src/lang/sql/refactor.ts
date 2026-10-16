// SQL refactors over one analysis: expand `*`, rename an alias or a CTE,
// go to definition, and the parameters of the function being typed.
import type { DialectKind } from "../../api/types";
import type { TextEdit } from "../protocol";
import { type Cte, lc, type Range, type SqlAnalysis, symbolAt, type TableRef } from "./analyze";
import { functionMap } from "./dialects";

/** The edits that replace the `*` or `o.*` at `pos` with its columns. */
export function expandStar(analysis: SqlAnalysis, _text: string, pos: number): TextEdit[] | null {
  const intent = analysis.intents.find((i) => i.from <= pos && pos <= i.to);
  return intent ? intent.edits : null;
}

const sorted = (rs: Range[]): Range[] => {
  const seen = new Set<string>();
  return rs
    .filter((r) => {
      const k = `${r.from}:${r.to}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.from - b.from);
};

/** Every occurrence of the alias or CTE at `pos`, its declaration included; null elsewhere. */
export function renameTargets(analysis: SqlAnalysis, pos: number): Range[] | null {
  const s = symbolAt(analysis, pos);
  if (!s) return null;
  const ref: TableRef | null = s.kind === "alias-decl" || s.kind === "qual" ? s.ref : null;
  if (ref?.alias && ref.aliasRange) {
    const uses = analysis.symbols.filter((x) => x.kind === "qual" && x.ref === ref);
    return sorted([ref.aliasRange, ...uses]);
  }
  const cte: Cte | null = s.kind === "cte-decl" || s.kind === "cte-ref" ? s.cte : ref?.kind === "cte" ? ref.cte : null;
  if (cte) {
    const uses = analysis.symbols.filter(
      (x) => (x.kind === "cte-ref" && x.cte === cte) || (x.kind === "qual" && x.ref.kind === "cte" && x.ref.cte === cte && !x.ref.alias),
    );
    return sorted([cte.range, ...uses]);
  }
  return null;
}

/** Why the name at `pos` cannot be renamed here, when it is a table or a column. */
export function renameBlocked(analysis: SqlAnalysis, pos: number): string | null {
  const s = symbolAt(analysis, pos);
  if (!s) return null;
  if (s.kind === "table")
    return "Renaming a table changes the database. Rename it in the Table Designer, which shows the SQL first.";
  if (s.kind === "column" && s.ref.kind === "table")
    return "Renaming a column changes the database. Rename it in the Table Designer, which shows the SQL first.";
  return null;
}

export type Definition =
  | { kind: "range"; range: Range }
  | { kind: "table"; schema: string | null; name: string; column?: string };

export function definitionAt(analysis: SqlAnalysis, pos: number): Definition | null {
  const s = symbolAt(analysis, pos);
  if (!s) return null;
  const table = (r: TableRef, column?: string): Definition | null =>
    r.table ? { kind: "table", schema: r.table.schema, name: r.table.name, ...(column ? { column } : {}) } : null;
  switch (s.kind) {
    case "table":
      return { kind: "table", schema: s.table.schema, name: s.table.name };
    case "qual":
      if (s.ref.aliasRange) return { kind: "range", range: s.ref.aliasRange };
      if (s.ref.kind === "cte" && s.ref.cte) return { kind: "range", range: s.ref.cte.range };
      return table(s.ref);
    case "alias-decl":
      if (s.ref.kind === "cte" && s.ref.cte) return { kind: "range", range: s.ref.cte.range };
      return table(s.ref);
    case "cte-ref":
      return { kind: "range", range: s.cte.range };
    case "column":
      if (s.ref.kind === "table") return table(s.ref, s.column.name);
      return s.column.def ? { kind: "range", range: s.column.def } : null;
    default:
      return null;
  }
}

export interface ParameterHints {
  name: string;
  signatures: string[][];
  /** The signature that fits the arguments typed so far. */
  active: number;
  activeParam: number;
}

/** The function whose parentheses hold `pos`, and which argument is being typed. */
export function parameterHints(analysis: SqlAnalysis, _text: string, pos: number, dialect: DialectKind): ParameterHints | null {
  const fns = functionMap(dialect);
  const sig = analysis.sig;
  let i = -1;
  for (let k = 0; k < sig.length && sig[k].e <= pos; k++) i = k;
  let depth = 0;
  let commas = 0;
  for (; i >= 0; i--) {
    const t = sig[i];
    if (t.v === ";") return null;
    if (t.v === ")") depth++;
    else if (t.v === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const f = sig[i - 1];
      const fn = f && f.t === "w" ? fns.get(lc(f.v)) : undefined;
      if (!fn) return null;
      const fits = (s: string[]) => s.length > commas || s.some((p) => p.startsWith("..."));
      const active = fn.signatures.findIndex(fits);
      return { name: fn.name, signatures: fn.signatures, active: active < 0 ? fn.signatures.length - 1 : active, activeParam: commas };
    } else if (t.v === "," && depth === 0) commas++;
  }
  return null;
}
