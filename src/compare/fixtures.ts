// Test data for the compare tab, modelled on the approved design (freight-staging to freight-prod).
import type { CompareResult, DiffItem, SyncItem, SyncPlan, SyncStatement } from "../api/types";

const path = (table: string | null, name: string) => ({ schema: "billing", table, name });

export const ITEMS: DiffItem[] = [
  {
    id: "column:billing.invoices.total:changed",
    kind: "changed",
    object: "column",
    path: path("invoices", "total"),
    detail: "numeric(10,2) to numeric(12,2)",
    changes: [{ kind: "type", from: "numeric(10,2)", to: "numeric(12,2)" }],
    losesData: false,
    dataLoss: null,
    source: null,
    target: null,
    needs: [],
    notScriptable: null,
  },
  {
    id: "column:billing.invoices.fax:removed",
    kind: "removed",
    object: "column",
    path: path("invoices", "fax"),
    detail: "text",
    changes: [],
    losesData: true,
    dataLoss: { rows: 18402, exact: true },
    source: null,
    target: null,
    needs: [],
    notScriptable: null,
  },
  {
    id: "column:billing.invoices.due_on:added",
    kind: "added",
    object: "column",
    path: path("invoices", "due_on"),
    detail: "date",
    changes: [],
    losesData: false,
    dataLoss: null,
    source: null,
    target: null,
    needs: [],
    notScriptable: null,
  },
  {
    id: "index:billing.invoices.invoices_due_on_idx:added",
    kind: "added",
    object: "index",
    path: path("invoices", "invoices_due_on_idx"),
    detail: "index",
    changes: [],
    losesData: false,
    dataLoss: null,
    source: null,
    target: null,
    needs: ["column:billing.invoices.due_on:added"],
    notScriptable: null,
  },
  {
    id: "column:billing.payments.method:changed",
    kind: "changed",
    object: "column",
    path: path("payments", "method"),
    detail: "default",
    changes: [{ kind: "default", from: "'transfer'", to: "'card'" }],
    losesData: false,
    dataLoss: null,
    source: null,
    target: null,
    needs: [],
    notScriptable: null,
  },
  {
    id: "table:billing.refunds:added",
    kind: "added",
    object: "table",
    path: path(null, "refunds"),
    detail: "table, 4 columns",
    changes: [],
    losesData: false,
    dataLoss: null,
    source: null,
    target: null,
    needs: [],
    notScriptable: null,
  },
  {
    id: "table:billing.legacy_invoices:removed",
    kind: "removed",
    object: "table",
    path: path(null, "legacy_invoices"),
    detail: "table",
    changes: [],
    losesData: true,
    dataLoss: { rows: 2310, exact: false },
    source: null,
    target: null,
    needs: [],
    notScriptable: null,
  },
  {
    id: "enum:billing.invoice_status:changed",
    kind: "changed",
    object: "enum",
    path: path(null, "invoice_status"),
    detail: "+ written_off",
    changes: [{ kind: "enumValues", added: ["written_off"], removed: [], reordered: false }],
    losesData: false,
    dataLoss: null,
    source: null,
    target: null,
    needs: [],
    notScriptable: null,
  },
  {
    id: "enum:billing.plan_kind:changed",
    kind: "changed",
    object: "enum",
    path: path(null, "plan_kind"),
    detail: "- trial",
    changes: [{ kind: "enumValues", added: [], removed: ["trial"], reordered: false }],
    losesData: false,
    dataLoss: null,
    source: null,
    target: null,
    needs: [],
    notScriptable: "PostgreSQL cannot remove a value from an enum. Remove trial by hand.",
  },
];

export const RESULT: CompareResult = {
  dialect: "postgres",
  items: ITEMS,
  notCompared: {
    source: [
      { kind: "view", count: 2 },
      { kind: "trigger", count: 1 },
    ],
    target: [
      { kind: "view", count: 1 },
      { kind: "check", count: 1 },
    ],
  },
  summary: { tables: 6, enums: 1, indexes: 14, foreignKeys: 5, matches: false, notComparedLine: null },
  comparedAtMs: Date.now(),
};

export const EMPTY_RESULT: CompareResult = { ...RESULT, items: [], summary: { ...RESULT.summary, matches: true } };

const GROUP: Record<string, SyncItem["group"]> = {
  "column:billing.invoices.fax:removed": "drop",
  "table:billing.legacy_invoices:removed": "drop",
  "column:billing.invoices.total:changed": "change",
  "column:billing.payments.method:changed": "change",
  "enum:billing.invoice_status:changed": "change",
  "enum:billing.plan_kind:changed": "change",
  "table:billing.refunds:added": "create",
  "column:billing.invoices.due_on:added": "create",
  "index:billing.invoices.invoices_due_on_idx:added": "create",
};

const LINE: Record<string, string> = {
  "column:billing.invoices.fax:removed": "DROP COLUMN invoices.fax",
  "table:billing.legacy_invoices:removed": "DROP TABLE legacy_invoices",
  "column:billing.invoices.total:changed": "ALTER COLUMN invoices.total TYPE numeric(12,2)",
  "column:billing.payments.method:changed": "SET DEFAULT payments.method 'card'",
  "enum:billing.invoice_status:changed": "ADD VALUE invoice_status 'written_off'",
  "enum:billing.plan_kind:changed": "Remove plan_kind value 'trial'",
  "table:billing.refunds:added": "CREATE TABLE refunds",
  "column:billing.invoices.due_on:added": "ADD COLUMN invoices.due_on",
  "index:billing.invoices.invoices_due_on_idx:added": "CREATE INDEX invoices_due_on_idx",
};

const SQL: Record<string, [string, string | null]> = {
  "column:billing.invoices.fax:removed": ["ALTER TABLE billing.invoices DROP COLUMN fax", "billing.invoices.fax"],
  "table:billing.legacy_invoices:removed": ["DROP TABLE billing.legacy_invoices", "billing.legacy_invoices"],
  "column:billing.invoices.total:changed": [
    "ALTER TABLE billing.invoices ALTER COLUMN total\n  TYPE numeric(12,2) USING total::numeric(12,2)",
    "billing.invoices.total",
  ],
  "column:billing.payments.method:changed": ["ALTER TABLE billing.payments ALTER COLUMN method SET DEFAULT 'card'", "billing.payments.method"],
  "enum:billing.invoice_status:changed": ["ALTER TYPE billing.invoice_status ADD VALUE 'written_off'", "billing.invoice_status"],
  "table:billing.refunds:added": ["CREATE TABLE billing.refunds (\n  id bigint PRIMARY KEY\n)", "billing.refunds"],
  "column:billing.invoices.due_on:added": ["ALTER TABLE billing.invoices ADD COLUMN due_on date", "billing.invoices.due_on"],
  "index:billing.invoices.invoices_due_on_idx:added": ["CREATE INDEX invoices_due_on_idx ON billing.invoices (due_on)", "billing.invoices"],
};

const ORDER: SyncItem["group"][] = ["drop", "change", "create"];

/** The plan the Core would build for `selection` (null: the default, data-loss and not-scriptable items unticked). */
export function planFor(selection: string[] | null, over: Partial<SyncPlan> = {}): SyncPlan {
  const ticked = new Set(selection ?? ITEMS.filter((i) => !i.losesData && !i.notScriptable).map((i) => i.id));
  const items: SyncItem[] = ITEMS.map((i) => ({
    id: i.id,
    group: GROUP[i.id],
    kind: i.kind,
    object: i.object,
    line: LINE[i.id],
    table: i.path.table ?? i.path.name,
    ticked: ticked.has(i.id),
    needs: i.needs,
    losesData: i.losesData,
    dataLoss: i.dataLoss,
    notScriptable: i.notScriptable,
  })).sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
  const statements: SyncStatement[] = items
    .filter((i) => i.ticked && SQL[i.id])
    .map((i) => ({ sql: SQL[i.id][0], items: [i.id], group: i.group, writes: true, dropsData: i.losesData, object: SQL[i.id][1] }));
  return {
    items,
    statements,
    warnings: [],
    mode: { kind: "transaction" },
    line: "Apply runs exactly this, in one transaction.",
    verdict: "ok",
    hash: `h:${[...ticked].sort().join(",")}`,
    enumValuesFirst: false,
    ...over,
  };
}
