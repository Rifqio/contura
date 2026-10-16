// SQL inspections: the analyser's problems as editor diagnostics. Checks
// against the schema (unknown and ambiguous names) wait until it has loaded;
// syntax and the query's own checks never wait.
import type { DialectKind } from "../../api/types";
import { lineColumn } from "../dbml/parse";
import type { Diagnostic } from "../protocol";
import type { SqlAnalysis } from "./analyze";

export type SchemaState = "loaded" | "loading" | "none";

export function inspectSql(analysis: SqlAnalysis, text: string, _dialect: DialectKind, schemaState: SchemaState): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const p of analysis.problems) {
    if (p.kind === "schema" && schemaState !== "loaded") continue;
    const key = `${p.from}:${p.to}:${p.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: p.from, to: p.to, ...lineColumn(text, p.from), severity: p.severity, message: p.message, fixes: p.fixes });
  }
  return out.sort((a, b) => a.from - b.from);
}
