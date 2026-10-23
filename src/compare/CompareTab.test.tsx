import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { expect, test, vi } from "vitest";
import type { CompareResult, ConnectionConfig, JobEvent, SyncOutcome } from "../api/types";
import { JobsProvider } from "../jobs/useJobs";
import type { CompareSeed } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import CompareTab, { REPLAN_DEBOUNCE_MS } from "./CompareTab";
import { EMPTY_RESULT, ITEMS, RESULT, planFor } from "./fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const BASE: ConnectionConfig = {
  id: "stg",
  name: "freight-staging",
  dialect: "postgres",
  host: "h",
  port: 5432,
  user: "u",
  database: "freight",
  ssl: { mode: "disable" },
  file: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
  groupId: null,
};
const PROD: ConnectionConfig = { ...BASE, id: "prod", name: "freight-prod", production: true };
const PLAIN: ConnectionConfig = { ...BASE, id: "dev", name: "freight-dev" };
const MY: ConnectionConfig = { ...BASE, id: "my", name: "kestrel-pos", dialect: "mysql", port: 3306, database: "pos_live" };
const RO: ConnectionConfig = { ...BASE, id: "ro", name: "kestrel-reporting", readOnly: true };
const CONNS = [BASE, PROD, PLAIN, MY, RO];

const last = <T,>(xs: T[]): T => xs[xs.length - 1];

const side = (connectionId: string) => ({ connectionId, database: "freight", schema: "billing" });

const DDL = {
  source: "CREATE TABLE billing.invoices (\n  total numeric(12,2),\n  due_on date\n);",
  target: "CREATE TABLE billing.invoices (\n  total numeric(10,2),\n  fax text\n);",
};

type Apply = (args: Record<string, unknown>, send: (e: JobEvent) => void) => SyncOutcome | Promise<SyncOutcome>;

function routes(over: { result?: CompareResult; apply?: Apply; extra?: Record<string, (a: Record<string, unknown>) => unknown> } = {}) {
  return routeInvoke({
    open_connection: () => "17.0",
    list_databases: () => ["freight"],
    list_schemas: () => [{ name: "billing", isSystem: false }],
    compare_schemas: () => ({ ...(over.result ?? RESULT), comparedAtMs: Date.now() - 12_000 }),
    compare_ddl: () => DDL,
    plan_sync: (a) => planFor((a.selection as string[] | null) ?? null),
    confirm_sync: () => "pass-1",
    cancel_job: () => null,
    write_text_file: () => null,
    apply_sync: (a) => {
      const events = a.events as { onmessage(e: JobEvent): void };
      const send = (e: JobEvent) => events.onmessage(e);
      return over.apply ? over.apply(a, send) : { applied: 6, elapsedMs: 40, tables: [{ database: "freight", schema: "billing", name: "invoices" }] };
    },
    ...over.extra,
  });
}

function renderTab(seed: CompareSeed, props: Partial<Parameters<typeof CompareTab>[0]> = {}) {
  const onMeta = vi.fn();
  const onApplied = vi.fn();
  const onOpenInEditor = vi.fn();
  render(
    <JobsProvider>
      <CompareTab seed={seed} connections={CONNS} groups={[]} visible onMeta={onMeta} onApplied={onApplied} onOpenInEditor={onOpenInEditor} {...props} />
    </JobsProvider>,
  );
  return { onMeta, onApplied, onOpenInEditor, tab: () => document.querySelector(".compare-tab") as HTMLElement };
}

const dbSeed = (target: string | null = "prod", source = "stg"): CompareSeed => ({
  source: { kind: "database", ...side(source) },
  target: target ? side(target) : null,
});

const modelSeed = (notice: string | null = null, target: string | null = null): CompareSeed => ({
  source: { kind: "model", model: { dialect: "postgres", tables: [], refs: [], enums: [], skipped: [] }, path: "C:\\m\\orders.dbml", dialect: "postgres", notice },
  target: target ? side(target) : null,
});

const ready = () => screen.findByRole("tab", { name: "Differences 9" });

test("the_dialect_refusal_and_no_compare", async () => {
  routes();
  renderTab({ source: { kind: "database", ...side("stg") }, target: { connectionId: "my", database: "pos_live", schema: null } });
  expect(
    await screen.findByText(
      "freight-staging is PostgreSQL and kestrel-pos is MySQL. Schema Compare needs the same Dialect; use Data Transfer to copy across Dialects.",
    ),
  ).toBeTruthy();
  expect(callsTo("compare_schemas")).toHaveLength(0);
});

test("tab_title_and_compared_ago", async () => {
  routes();
  const { onMeta } = renderTab(dbSeed());
  await ready();
  expect(onMeta).toHaveBeenLastCalledWith("freight-staging to freight-prod", "prod");
  expect(screen.getByText("Compared 12s ago")).toBeTruthy();
  expect(screen.getByText("Changes freight-prod to match freight-staging.")).toBeTruthy();
  expect(callsTo("compare_schemas")[0]).toEqual({ req: { source: { kind: "database", ...side("stg") }, target: side("prod") } });
});

test("strict_mode_compares_once_on_open", async () => {
  routes();
  render(
    <StrictMode>
      <JobsProvider>
        <CompareTab seed={dbSeed()} connections={CONNS} groups={[]} visible onMeta={vi.fn()} onApplied={vi.fn()} onOpenInEditor={vi.fn()} />
      </JobsProvider>
    </StrictMode>,
  );
  await ready();
  await waitFor(() => expect(callsTo("plan_sync").length).toBeGreaterThan(0));
  await act(async () => {});
  expect(callsTo("compare_schemas")).toHaveLength(1);
  expect(callsTo("plan_sync")).toHaveLength(1);
});

test("swap_with_ctrl_shift_s_compares_again", async () => {
  routes();
  const { onMeta, tab } = renderTab(dbSeed());
  await ready();
  fireEvent.keyDown(tab(), { key: "S", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(onMeta).toHaveBeenLastCalledWith("freight-prod to freight-staging", "stg"));
  await waitFor(() => expect(last(callsTo("compare_schemas"))).toEqual({ req: { source: { kind: "database", ...side("prod") }, target: side("stg") } }));
});

test("a_model_source_cannot_swap_and_shows_the_dbml_notice", async () => {
  routes();
  const { onMeta, tab } = renderTab(modelSeed("The DBML has an error on line 27. Compare uses the last valid version.", "prod"));
  expect(screen.getByText("The DBML has an error on line 27. Compare uses the last valid version.")).toBeTruthy();
  await ready();
  const swap = screen.getByRole("button", { name: "Swap sides" }) as HTMLButtonElement;
  expect(swap.disabled).toBe(true);
  expect(swap.title).toBe("A Schema Model can only be the source");
  fireEvent.keyDown(tab(), { key: "S", ctrlKey: true, shiftKey: true });
  expect(onMeta).toHaveBeenLastCalledWith("orders.dbml to freight-prod", "prod");
  expect((callsTo("compare_schemas")[0].req as { source: { kind: string; path: string } }).source).toMatchObject({ kind: "model", path: "C:\\m\\orders.dbml" });
});

test("apply_to_connection_offers_matching_targets_and_disables_read_only", async () => {
  routes();
  renderTab(modelSeed());
  const picker = screen.getByRole("combobox", { name: "Target Connection" });
  await waitFor(() => expect(document.activeElement).toBe(picker));
  await userEvent.click(picker);
  const list = screen.getByRole("listbox", { name: "Target Connection" });
  const names = within(list)
    .getAllByRole("option")
    .map((o) => o.querySelector(".select-label")?.textContent);
  // Only PostgreSQL Connections, the model's Dialect.
  expect(names).not.toContain("kestrel-pos");
  const ro = within(list).getByRole("option", { name: /kestrel-reporting/ });
  expect(ro.getAttribute("aria-disabled")).toBe("true");
  expect(within(ro).getByText("Read-only: cannot be a target")).toBeTruthy();
});

test("tree_filter_counts_and_not_compared_line", async () => {
  routes();
  renderTab(dbSeed());
  await ready();
  expect(screen.getByRole("tab", { name: "Sync Script 6 of 9" })).toBeTruthy();
  const show = screen.getByRole("group", { name: "Show" });
  expect(within(show).getAllByRole("button").map((b) => b.textContent)).toEqual(["All 9", "Added 3", "Removed 2", "Changed 4"]);
  expect(screen.getByText("Not compared yet: 2 views, 1 trigger, 1 check constraint. Renames show as removed plus added.")).toBeTruthy();
  await userEvent.click(within(show).getByRole("button", { name: "Removed 2" }));
  const names = screen.getAllByRole("treeitem").map((r) => r.getAttribute("aria-label"));
  expect(names).toEqual(["billing", "Tables", "invoices, changed, 4 changes inside", "fax, removed", "legacy_invoices, removed", "Not compared"]);
});

test("ddl_panes_loss_banner_and_in_the_sync_script", async () => {
  routes();
  renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("treeitem", { name: "fax, removed" }));
  // Item 44: each pane names its database and, on PostgreSQL, its schema.
  await screen.findByRole("region", { name: "Target DDL, freight-prod, freight, billing" });
  expect(screen.getByRole("region", { name: "Target DDL, freight-prod, freight, billing" }).classList.contains("prod-wash")).toBe(true);
  expect(screen.getByRole("region", { name: "Source DDL, freight-staging, freight, billing" })).toBeTruthy();
  expect(screen.getByText("1 change loses data")).toBeTruthy();
  expect(screen.getByText("Dropping fax removes its values in 18,402 rows on freight-prod. It starts unticked in the Sync Script.")).toBeTruthy();
  expect(screen.getByText("3 of 4 ticked")).toBeTruthy();
  expect(screen.getByRole("group", { name: "This table in the Sync Script" }).textContent).toContain("-- Unticked: DROP COLUMN invoices.fax");
  expect(last(callsTo("compare_ddl"))).toMatchObject({ table: "invoices" });
});

test("ticks_close_and_replan_once_after_150ms", async () => {
  routes();
  renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("tab", { name: "Sync Script 6 of 9" }));
  const before = callsTo("plan_sync").length;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    fireEvent.click(screen.getByRole("checkbox", { name: "ADD COLUMN invoices.due_on" }));
    expect((screen.getByRole("checkbox", { name: "CREATE INDEX invoices_due_on_idx" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "ALTER COLUMN invoices.total TYPE numeric(12,2)" }));
    await act(async () => {
      vi.advanceTimersByTime(REPLAN_DEBOUNCE_MS - 20);
    });
    expect(callsTo("plan_sync")).toHaveLength(before);
    await act(async () => {
      vi.advanceTimersByTime(40);
    });
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(callsTo("plan_sync")).toHaveLength(before + 1));
  const sel = last(callsTo("plan_sync"))!.selection as string[];
  expect(sel).not.toContain("column:billing.invoices.due_on:added");
  expect(sel).not.toContain("index:billing.invoices.invoices_due_on_idx:added");
  expect(sel).not.toContain("column:billing.invoices.total:changed");
  await screen.findByRole("tab", { name: "Sync Script 3 of 9" });
});

test("the_prod_dialog_says_the_enum_values_commit_first", async () => {
  const line = "1 enum value is added first, in its own transaction.";
  routes({ extra: { plan_sync: (a) => planFor((a.selection as string[] | null) ?? null, { enumValuesFirst: true, line }) } });
  renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("tab", { name: "Sync Script 6 of 9" }));
  expect(screen.getByText(line)).toBeTruthy();
  const applyProd = screen.getByRole("button", { name: /^Apply on PROD\.\.\./ }) as HTMLButtonElement;
  await waitFor(() => expect(applyProd.disabled).toBe(false));
  await userEvent.click(applyProd);
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText(
      "6 of 6 statements write. The enum values are added first and stay. The rest run in one transaction: if one fails, none of the rest is applied.",
    ),
  ).toBeTruthy();
  expect(within(dialog).queryByText(/They run in one transaction/)).toBeNull();
});

test("apply_on_prod_opens_the_dialog_and_untick_it_refreshes_it", async () => {
  routes();
  renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("tab", { name: "Sync Script 6 of 9" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "DROP COLUMN invoices.fax" }));
  await screen.findByRole("tab", { name: "Sync Script 7 of 9" });
  expect(screen.getByText("7 of 9 changes ticked. Writes on freight-prod (Production).")).toBeTruthy();
  const applyProd = screen.getByRole("button", { name: /^Apply on PROD\.\.\./ }) as HTMLButtonElement;
  // Apply waits for the debounced plan of the new ticks.
  await waitFor(() => expect(applyProd.disabled).toBe(false));
  await userEvent.click(applyProd);
  const dialog = await screen.findByRole("dialog");
  expect(dialog.querySelector(".confirm-title")?.textContent).toBe("Apply Sync Script on freight-prod · freight");
  expect(within(dialog).getByText(/^1 statement drops data\./)).toBeTruthy();
  expect(within(dialog).getByText(/DROP COLUMN fax removes its values in 18,402 rows\./)).toBeTruthy();
  expect(within(dialog).getByText("7 of 7 statements write. They run in one transaction: if one fails, nothing changes.")).toBeTruthy();
  expect(within(dialog).getByText("drops data")).toBeTruthy();
  expect(within(dialog).getByText("Enter runs only when Apply on freight-prod has focus. Press Tab to reach it, or click it.")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Apply on freight-prod" }).className).toContain("button-danger-fill");
  await userEvent.click(within(dialog).getByRole("button", { name: "Untick it" }));
  await waitFor(() => expect(within(dialog).queryByText(/drops data\./)).toBeNull());
  expect(within(dialog).getByText("6 of 6 statements write. They run in one transaction: if one fails, nothing changes.")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Apply on freight-prod" }).className).toContain("button-primary");
  await userEvent.click(within(dialog).getByRole("button", { name: "Apply on freight-prod" }));
  await waitFor(() => expect(callsTo("apply_sync")).toHaveLength(1));
  expect(callsTo("confirm_sync")).toHaveLength(1);
  expect(callsTo("apply_sync")[0]).toMatchObject({ pass: "pass-1", expectedHash: planFor(null).hash });
});

test("progress_with_cancel_then_recompare_and_refresh", async () => {
  let finish: (o: SyncOutcome) => void = () => {};
  routes({
    apply: (_a, send) => {
      send({ kind: "progress", phase: "writing", table: null, rowsDone: 0, rowsTotal: null, bytesDone: 0, bytesTotal: null, statementsDone: 2, fileRow: null });
      return new Promise<SyncOutcome>((r) => (finish = r));
    },
  });
  const { onApplied, tab } = renderTab(dbSeed("dev"));
  await ready();
  const compares = callsTo("compare_schemas").length;
  fireEvent.keyDown(tab(), { key: "Enter", ctrlKey: true });
  expect(await screen.findByText("Statement 3 of 6")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(callsTo("cancel_job")).toHaveLength(1);
  await act(async () => finish({ applied: 6, elapsedMs: 10, tables: [{ database: "freight", schema: "billing", name: "invoices" }] }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledWith(side("dev"), [{ database: "freight", schema: "billing", name: "invoices" }], []));
  await waitFor(() => expect(callsTo("compare_schemas").length).toBe(compares + 1));
  expect(callsTo("apply_sync")[0]).toMatchObject({ pass: null });
});

test("a_changed_target_says_so_and_compares_again", async () => {
  routes({
    apply: () => {
      throw { kind: "planChanged", message: { connection: "freight-dev" } };
    },
  });
  renderTab(dbSeed("dev"));
  await ready();
  const compares = callsTo("compare_schemas").length;
  await userEvent.click(screen.getByRole("button", { name: /^Apply/ }));
  expect(await screen.findByText("freight-dev changed since you compared. Compare again to see the current Sync Script.")).toBeTruthy();
  await waitFor(() => expect(callsTo("compare_schemas").length).toBe(compares + 1));
});

test("a_failed_statement_reports_and_refreshes", async () => {
  routes({
    apply: () => {
      throw { kind: "designFailed", message: { statement: 4, ran: 4, total: 9, message: "duplicate key" } };
    },
  });
  const { onApplied } = renderTab(dbSeed("dev"));
  await ready();
  await userEvent.click(screen.getByRole("button", { name: /^Apply/ }));
  expect(await screen.findByText("4 of 9 statements were applied. Statement 5 failed: duplicate key")).toBeTruthy();
  expect(onApplied).toHaveBeenCalled();
});

test("a_cancelled_apply_says_what_stayed_applied", async () => {
  routes({
    apply: () => {
      throw { kind: "syncCancelled", message: { applied: 3, total: 9 } };
    },
  });
  const { onApplied } = renderTab(dbSeed("dev"));
  await ready();
  await userEvent.click(screen.getByRole("button", { name: /^Apply/ }));
  expect(await screen.findByText("Apply was cancelled. 3 of 9 statements were applied.")).toBeTruthy();
  expect(onApplied).toHaveBeenCalled();
});

test("the_differences_view_says_mysql_commits_one_by_one", async () => {
  const line = "MySQL runs these 6 statements one by one. If one fails, the ones before it stay applied.";
  routes({ extra: { plan_sync: (a) => planFor((a.selection as string[] | null) ?? null, { mode: { kind: "sequential" }, line }) } });
  renderTab(dbSeed("dev"));
  await ready();
  expect(await screen.findByText(line)).toBeTruthy();
  // The Sync Script view shows it under the script instead, once.
  await userEvent.click(screen.getByRole("tab", { name: "Sync Script 6 of 9" }));
  expect(screen.getAllByText(line)).toHaveLength(1);
});

test("no_differences_state", async () => {
  routes({ result: EMPTY_RESULT });
  renderTab(dbSeed());
  expect(await screen.findByText("No differences")).toBeTruthy();
  expect(screen.getByText("billing in freight-staging and freight-prod match: 6 tables, 1 enum, 14 indexes, 5 Foreign Keys.")).toBeTruthy();
  expect(screen.getByText("Not compared yet: 2 views, 1 trigger, 1 check constraint.")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /Compare again/ }).length).toBeGreaterThan(0);
  expect(screen.getByText("Nothing to apply.")).toBeTruthy();
  expect((screen.getByRole("button", { name: /^Apply on PROD/ }) as HTMLButtonElement).disabled).toBe(true);
});

test("a_read_only_target_copies_but_does_not_apply", async () => {
  routes();
  renderTab(dbSeed("ro"));
  await ready();
  expect(screen.getByText("kestrel-reporting is Read-only. The Sync Script can be copied, not applied.")).toBeTruthy();
  expect((screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Copy script" }) as HTMLButtonElement).disabled).toBe(false);
});

test("copy_save_as_and_open_in_editor", async () => {
  const dialog = await import("@tauri-apps/plugin-dialog");
  vi.mocked(dialog.save).mockResolvedValue("C:\\out\\billing-sync.sql");
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  routes();
  const { onOpenInEditor } = renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("tab", { name: "Sync Script 6 of 9" }));
  const script = writeText.mock.calls.length;
  await userEvent.click(screen.getByRole("button", { name: "Copy script" }));
  expect(writeText).toHaveBeenCalledTimes(script + 1);
  const copied = (last(writeText.mock.calls) as unknown as [string])[0];
  expect(copied.startsWith("-- 2. Change\n")).toBe(true);
  // I1: each statement ends with a separator, so the copied text runs as typed SQL.
  expect(copied).toContain("ALTER TABLE billing.payments ALTER COLUMN method SET DEFAULT 'card';\n");
  expect(copied.endsWith(";")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Save as..." }));
  await waitFor(() => expect(callsTo("write_text_file")).toEqual([{ path: "C:\\out\\billing-sync.sql", text: copied }]));
  expect(await screen.findByText("Saved billing-sync.sql")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open in editor" }));
  expect(onOpenInEditor).toHaveBeenCalledWith(side("prod"), copied);
});

test("not_scriptable_items_stay_unticked", async () => {
  routes();
  renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("tab", { name: "Sync Script 6 of 9" }));
  const box = screen.getByRole("checkbox", { name: "Remove plan_kind value 'trial'" }) as HTMLInputElement;
  expect(box.disabled).toBe(true);
  expect(ITEMS.find((i) => i.path.name === "plan_kind")?.notScriptable).toBeTruthy();
});

test("a_stale_plan_answer_never_replaces_a_newer_one", async () => {
  // The first replan answers last: its plan must not show.
  const waiting: ((v: unknown) => void)[] = [];
  routes({
    extra: {
      plan_sync: (a) => {
        const sel = (a.selection as string[] | null) ?? null;
        if (sel === null) return planFor(null);
        return new Promise((resolve) => waiting.push(() => resolve(planFor(sel))));
      },
    },
  });
  renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("tab", { name: "Sync Script 6 of 9" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "ALTER COLUMN invoices.total TYPE numeric(12,2)" }));
  await waitFor(() => expect(waiting).toHaveLength(1));
  fireEvent.click(screen.getByRole("checkbox", { name: "SET DEFAULT payments.method 'card'" }));
  await waitFor(() => expect(waiting).toHaveLength(2));
  await act(async () => waiting[1](null));
  await screen.findByRole("tab", { name: "Sync Script 4 of 9" });
  await act(async () => waiting[0](null));
  // Still the newer plan: 4 ticked, and both unticked items stay unticked.
  expect(screen.getByRole("tab", { name: "Sync Script 4 of 9" })).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "ALTER COLUMN invoices.total TYPE numeric(12,2)" }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("button", { name: /^Apply on PROD/ }) as HTMLButtonElement).disabled).toBe(false);
});

test("a_failed_replan_puts_the_ticks_back_to_the_plan_shown", async () => {
  routes({
    extra: {
      plan_sync: (a) => {
        if (a.selection === null) return planFor(null);
        throw { kind: "connect", message: "server gone" };
      },
    },
  });
  renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("tab", { name: "Sync Script 6 of 9" }));
  const total = screen.getByRole("checkbox", { name: "ALTER COLUMN invoices.total TYPE numeric(12,2)" }) as HTMLInputElement;
  fireEvent.click(total);
  expect(total.checked).toBe(false);
  expect(await screen.findByText(/Could not connect: server gone/)).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "ALTER COLUMN invoices.total TYPE numeric(12,2)" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("tab", { name: "Sync Script 6 of 9" })).toBeTruthy();
});

test("another_target_clears_the_old_result_and_apply_waits", async () => {
  let release: (v: CompareResult) => void = () => {};
  routes({
    extra: {
      compare_schemas: (a) => {
        const t = (a.req as { target: { connectionId: string } }).target.connectionId;
        if (t === "prod") return { ...RESULT, comparedAtMs: Date.now() };
        return new Promise<CompareResult>((r) => (release = r));
      },
    },
  });
  renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("combobox", { name: "Target Connection" }));
  await userEvent.click(screen.getByRole("option", { name: /freight-dev/ }));
  // The old pair's differences are gone at once, and nothing can be applied while the new pair is read.
  await waitFor(() => expect(screen.queryByRole("treeitem")).toBeNull());
  expect(screen.getByText("Reading both sides...")).toBeTruthy();
  expect((screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => release({ ...RESULT, comparedAtMs: Date.now() }));
  await ready();
});

test("plan_changed_on_production_reopens_the_dialog_with_the_new_sql", async () => {
  let first = true;
  routes({
    apply: () => {
      if (first) {
        first = false;
        throw { kind: "planChanged", message: { connection: "freight-prod" } };
      }
      return { applied: 6, elapsedMs: 1, tables: [] };
    },
  });
  renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("button", { name: /^Apply on PROD/ }));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Apply on freight-prod" }));
  expect(await screen.findByText("freight-prod changed since you compared. Compare again to see the current Sync Script.")).toBeTruthy();
  // Compared again, and the dialog is back with the plan just built.
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("6 of 6 statements write. They run in one transaction: if one fails, nothing changes.")).toBeTruthy();
  expect(callsTo("compare_schemas").length).toBeGreaterThanOrEqual(2);
});

test("a_dropped_table_is_reported_for_its_tabs_to_close", async () => {
  routes({ apply: () => ({ applied: 7, elapsedMs: 1, tables: [{ database: "freight", schema: "billing", name: "legacy_invoices" }, { database: "freight", schema: "billing", name: "invoices" }] }) });
  const { onApplied } = renderTab(dbSeed("dev"));
  await ready();
  await userEvent.click(screen.getByRole("tab", { name: "Sync Script 6 of 9" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "DROP TABLE legacy_invoices" }));
  const apply = screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;
  await waitFor(() => expect(apply.disabled).toBe(false));
  await userEvent.click(apply);
  await waitFor(() =>
    expect(onApplied).toHaveBeenCalledWith(side("dev"), [{ database: "freight", schema: "billing", name: "invoices" }], [{ database: "freight", schema: "billing", name: "legacy_invoices" }]),
  );
});

test("apply_reports_its_job_for_the_close_guard", async () => {
  let finish: (o: SyncOutcome) => void = () => {};
  routes({ apply: () => new Promise<SyncOutcome>((r) => (finish = r)) });
  const onJob = vi.fn();
  renderTab(dbSeed("dev"), { onJob });
  await ready();
  await userEvent.click(screen.getByRole("button", { name: /^Apply/ }));
  await waitFor(() => expect(onJob).toHaveBeenCalledWith(expect.any(String)));
  await act(async () => finish({ applied: 6, elapsedMs: 1, tables: [] }));
  await waitFor(() => expect(onJob).toHaveBeenLastCalledWith(null));
});

test("item_43_filter_chips_and_legend_take_the_status_colours", async () => {
  routes();
  renderTab(dbSeed());
  await ready();
  const show = screen.getByRole("group", { name: "Show" });
  const chip = (name: string) => within(show).getByRole("button", { name });
  // Each chip carries its status class and a colour dot; All has none.
  expect(chip("All 9").classList.contains("compare-chip-all")).toBe(true);
  expect(chip("All 9").querySelector(".compare-chip-dot")).toBeNull();
  for (const [name, k] of [["Added 3", "added"], ["Removed 2", "removed"], ["Changed 4", "changed"]] as const) {
    expect(chip(name).classList.contains(`compare-chip-${k}`)).toBe(true);
    expect(chip(name).querySelector(".compare-chip-dot")).not.toBeNull();
    expect(chip(name).querySelector(".compare-chip-n")!.classList.contains(`diff-${k}`)).toBe(true);
  }
  expect(chip("All 9").getAttribute("aria-pressed")).toBe("true");
  expect(chip("All 9").classList.contains("compare-chip-on")).toBe(true);
  await userEvent.click(chip("Added 3"));
  expect(chip("Added 3").getAttribute("aria-pressed")).toBe("true");
  expect(chip("Added 3").classList.contains("compare-chip-on")).toBe(true);
  expect(chip("All 9").classList.contains("compare-chip-on")).toBe(false);
  // Only added rows (and the tables that hold them) stay.
  const marks = screen.getAllByRole("treeitem").flatMap((r) => [...r.querySelectorAll(".compare-trow-badge:not(.compare-trow-count)")].map((b) => b.textContent));
  expect(new Set(marks)).toEqual(new Set(["A"]));
  // The legend names each colour in that colour.
  const legend = screen.getByLabelText("Legend");
  expect(within(legend).getByText("in source only").closest("span")!.classList.contains("diff-added")).toBe(true);
  expect(within(legend).getByText("in target only").closest("span")!.classList.contains("diff-removed")).toBe(true);
  expect(within(legend).getByText("differs").closest("span")!.classList.contains("diff-changed")).toBe(true);
});

test("item_43_the_selected_table_shows_its_status_word_in_its_colour", async () => {
  routes();
  renderTab(dbSeed());
  await ready();
  await userEvent.click(screen.getByRole("treeitem", { name: "refunds, added" }));
  const statusWord = () => document.querySelector<HTMLElement>(".compare-status-word")!;
  await waitFor(() => expect(statusWord().textContent).toBe("Added"));
  const word = statusWord();
  expect(word.classList.contains("diff-added")).toBe(true);
  await userEvent.click(screen.getByRole("treeitem", { name: "invoices, changed, 4 changes inside" }));
  expect(statusWord().textContent).toBe("Changed, 4 changes");
  expect(statusWord().classList.contains("diff-changed")).toBe(true);
});
