import type { AskRequest, ItemKind, Preview, PreviewItem } from "../api/types";

const NO_CONNECTION = "No Connection is chosen";

/**
 * A stand-in for the Core's `ai_preview`: one item per focus part, switched off by `off`,
 * and `exact` the on items' text. `locked` locks every item but the question. With no
 * Connection the Core's rule applies instead: every item but the question is locked, except
 * an untied Schema Model's DBML (R1.4).
 */
export function fakePreview(req: AskRequest, locked: string | null = null): Preview {
  const parts: [ItemKind, string, string][] = [["question", "Question", req.question]];
  const f = req.focus;
  const untied = req.connectionId === null && f.untiedModel;
  const lockFor = (kind: ItemKind) =>
    kind === "question" ? null : req.connectionId !== null ? locked : untied && kind === "dbml" ? null : NO_CONNECTION;
  if (f.tables.length > 0) {
    const label = f.tables.length === 1 ? `Schema · ${f.tables[0].name}` : `Schema · ${f.tables.length} tables`;
    parts.push(["cards", label, f.tables.map((t) => `Table ${t.name}`).join("\n")]);
  }
  if (f.dbml != null) parts.push(["dbml", untied ? "DBML · not tied to a Connection" : "DBML", f.dbml]);
  if (f.sql != null) parts.push(["sql", "Query text", f.sql]);
  if (f.filter != null) parts.push(["sql", "Filter text", f.filter]);
  if (f.error != null) parts.push(["error", "Error", f.error]);
  parts.push(["rows", "Sample rows", ""]);

  const items: PreviewItem[] = parts.map(([kind, label, text]) => {
    const lock = lockFor(kind);
    const on = !lock && (kind === "rows" ? req.switches.rows : !req.off.includes(kind));
    const bytes = on ? new TextEncoder().encode(text).length : 0;
    return { kind, label, bytes, tokens: Math.ceil(bytes / 4), locked: lock, on };
  });
  // The Core's This tab and Recent steps rows, right after the question: switched off they keep their row with
  // nothing sent, so they can be switched back on (`previewParity.json` holds the fake to the Core).
  const rows: PreviewItem[] = [];
  const offRow = (kind: ItemKind, label: string, bytes: number): PreviewItem => {
    const lock = lockFor(kind);
    const on = !lock && !req.off.includes(kind);
    return { kind, label, bytes: on ? bytes : 0, tokens: on ? Math.ceil(bytes / 4) : 0, locked: lock, on };
  };
  if (req.tab) rows.push(offRow("tab", "This tab", 120));
  const steps = req.steps?.length ?? 0;
  if (steps > 0) rows.push(offRow("steps", `Recent steps · ${steps}`, 40 * steps));
  const byPart = [...items];
  items.splice(1, 0, ...rows);
  // The Core's rows item: merged into one, with the label it gives and what it read.
  const rowsAt = items.findIndex((i) => i.kind === "rows");
  const rowsOn = rowsAt >= 0 && items[rowsAt].on;
  if (rowsOn) items[rowsAt] = { ...items[rowsAt], label: "Sample rows · 2 tables", bytes: 643, tokens: 161 };
  const exact = parts
    .filter((_, i) => byPart[i].on && parts[i][2] !== "")
    .map(([, label, text]) => `${label}:\n${text}`)
    .join("\n\n");
  const totalBytes = new TextEncoder().encode(exact).length;
  return {
    items,
    tables: { full: f.tables.map((t) => t.name), namesOnly: [], leftOut: [], reasons: [] },
    totalBytes,
    tokens: Math.ceil(totalBytes / 4),
    exact,
    notes: [],
    log: [],
    context: null,
    rows: rowsOn ? { tables: 2, rows: 10, bytes: 643 } : null,
  };
}
