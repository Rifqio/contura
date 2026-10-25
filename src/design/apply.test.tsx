import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type MutableRefObject } from "react";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig, DesignMode, DesignRequest, DesignVerdict, DesignWarning, Page, RunVerdict } from "../api/types";
import DataGrid, { type GridControl } from "../components/DataGrid";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import type { DesignTabTarget } from "../shell/tabs";
import { LOAD_TIMEOUT, patient } from "../test/load";
import { holdTimers } from "../test/timers";
import { ORDERS } from "./fixtures";
import TableDesigner from "./TableDesigner";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
mockEditorDom();

const conn = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "c1",
  name: "shop-staging",
  dialect: "mysql",
  host: "h",
  port: 3306,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
  ...over,
});

const ALTER = "ALTER TABLE `orders` MODIFY `total` int";
const ask: RunVerdict = {
  kind: "needsConfirmation",
  connection: "freight-prod",
  database: "shop",
  statements: [{ text: ALTER, class: "write" }],
  writes: 1,
};
const plan = (
  verdict: RunVerdict = { kind: "ok" },
  mode: DesignMode = { kind: "atomic" },
  warnings: DesignWarning[] = [{ kind: "narrowType", column: "total", from: "decimal(10,2)", to: "int", note: null }],
): DesignVerdict => ({
  plan: { statements: [ALTER], warnings, mode, before: 0, after: 0, checks: [], foreignKeys: null },
  verdict,
});

function setup(
  over: Partial<ConnectionConfig> = {},
  routes: Parameters<typeof routeInvoke>[0] = {},
  target: DesignTabTarget = { kind: "alter", path: ORDERS.path },
) {
  routeInvoke({
    table_design: () => ORDERS,
    plan_design: () => plan(),
    apply_design: () => ({ kind: "done", ran: 1 }),
    table_ddl: () => "CREATE TABLE `orders` (\n  `id` int NOT NULL\n)",
    ...routes,
  });
  const client = new LangClient(() => fakeWorker());
  const controlRef = createRef<GridControl | null>() as MutableRefObject<GridControl | null>;
  const onApplied = vi.fn();
  const onDirtyChange = vi.fn();
  render(
    <ToastProvider>
      <div id="app-status-slot" />
      <TableDesigner
        connection={conn(over)}
        target={target}
        group={null}
        visible
        onDirtyChange={onDirtyChange}
        controlRef={controlRef}
        onApplied={onApplied}
        lang={{ client, schemas: new SchemaCache(client) }}
      />
    </ToastProvider>,
  );
  return { onApplied, controlRef, onDirtyChange };
}

const grid = () => screen.getByRole("grid", { name: /^Columns of/ });
const row = (name: string) =>
  [...grid().querySelectorAll("tbody tr")].find((r) => r.querySelector('td[data-field="name"]')?.textContent === name) as HTMLElement;
const cell = (name: string, field: string) => row(name).querySelector(`td[data-field="${field}"]`) as HTMLElement;

/** The preview has planned the draft: Apply runs what it shows (S13 I2). */
const previewShown = () => screen.findByLabelText("SQL Apply runs", undefined, { timeout: LOAD_TIMEOUT });

/** Changes total's type through the cell editor, and waits for the preview to show it. */
async function changeType(to = "int", planned = true) {
  await screen.findByRole("tab", { name: "Columns 5" });
  fireEvent.doubleClick(cell("total", "type"));
  const box = screen.getByRole("combobox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: to } });
  fireEvent.keyDown(box, { key: "Enter" });
  if (planned) await previewShown();
}

const applyButton = () => screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;

test("plain_connection_applies_without_a_pass_reloads_and_toasts", async () => {
  const { onApplied } = setup();
  await changeType();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await userEvent.click(applyButton());
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
  const sent = callsTo("apply_design")[0];
  expect(sent.pass).toBeNull();
  expect((sent.request as DesignRequest).target).toEqual({ kind: "alter", base: ORDERS });
  expect(await screen.findByText("Applied 1 change to orders.")).toBeTruthy();
  expect(onApplied).toHaveBeenCalledWith(ORDERS.path, "altered");
  await waitFor(() => expect(callsTo("table_design")).toHaveLength(2));
});

test("production_confirms_then_applies_with_the_pass", async () => {
  setup(
    { name: "freight-prod", production: true },
    { plan_design: () => plan(ask), confirm_design: () => "pass-1", apply_design: () => ({ kind: "done", ran: 1 }) },
  );
  await changeType();
  const button = screen.getByText("Apply on PROD").closest("button") as HTMLButtonElement;
  expect(button.className).toContain("button-prod");
  await waitFor(() => expect(button.disabled).toBe(false));
  await userEvent.click(button);
  const dialog = await screen.findByRole("dialog");
  expect(dialog.querySelector("h2")!.textContent).toBe("Apply on freight-prod · shop");
  expect(within(dialog).getByRole("alert").textContent).toContain(
    "Changing total from decimal(10,2) to int can cut or round existing values.",
  );
  expect(callsTo("apply_design")).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole("button", { name: "Apply on freight-prod" }));
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
  expect(callsTo("confirm_design")).toHaveLength(1);
  expect(callsTo("apply_design")[0].pass).toBe("pass-1");
  const order = vi
    .mocked((await import("@tauri-apps/api/core")).invoke)
    .mock.calls.map(([c]) => c)
    .filter((c) => c === "confirm_design" || c === "apply_design");
  expect(order).toEqual(["confirm_design", "apply_design"]);
});

test("cancel_keeps_the_draft", async () => {
  const { controlRef } = setup({ name: "freight-prod", production: true }, { plan_design: () => plan(ask) });
  await changeType();
  await waitFor(() => expect((screen.getByText("Apply on PROD").closest("button") as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByText("Apply on PROD"));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(callsTo("apply_design")).toHaveLength(0);
  expect(cell("total", "type").textContent).toBe("int");
  expect(controlRef.current?.pendingCount()).toBe(1);
});

test("partial_failure_reloads_the_designer", async () => {
  setup(
    {},
    {
      apply_design: () => {
        throw { kind: "designFailed", message: { statement: 1, ran: 1, total: 2, message: "Duplicate key name 'i'" } };
      },
    },
  );
  await changeType();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await userEvent.click(applyButton());
  expect(await screen.findByText("1 of 2 statements were applied. Statement 2 failed: Duplicate key name 'i'")).toBeTruthy();
  await waitFor(() => expect(callsTo("table_design")).toHaveLength(2));
});

test("a_failure_that_changed_nothing_keeps_the_draft_and_offers_reload", async () => {
  const { controlRef } = setup(
    {},
    {
      apply_design: () => {
        throw { kind: "designFailed", message: { statement: 0, ran: 0, total: 1, message: "Unknown column 'total'" } };
      },
    },
  );
  await changeType();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await userEvent.click(applyButton());
  expect(await screen.findByText("Nothing was changed. Statement 1 failed: Unknown column 'total'")).toBeTruthy();
  expect(callsTo("table_design")).toHaveLength(1);
  expect(controlRef.current?.pendingCount()).toBe(1);
  await userEvent.click(screen.getByRole("button", { name: "Reload" }));
  // The draft has changes, so Reload asks first.
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(callsTo("table_design")).toHaveLength(2));
  await waitFor(() => expect(controlRef.current?.pendingCount()).toBe(0));
});

test("copy_only_disables_apply", async () => {
  setup({}, { plan_design: () => plan({ kind: "ok" }, { kind: "copyOnly", reason: "it has a CHECK constraint" }) });
  await changeType();
  expect(
    await screen.findByText("Contura cannot rebuild this table safely: it has a CHECK constraint. Copy this SQL to run it yourself."),
  ).toBeTruthy();
  await waitFor(() => expect(applyButton().disabled).toBe(true));
});

test("ctrl_s_in_the_designer_applies", async () => {
  setup();
  await changeType();
  fireEvent.keyDown(screen.getByRole("tab", { name: /^Columns/ }), { key: "s", ctrlKey: true });
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
});

/** Plans what the request asks: total's new type is in the SQL, so a later edit plans other SQL. */
const echoPlan = (a: Record<string, unknown>): DesignVerdict => {
  const edit = (a.request as DesignRequest).edits.find((e) => e.op === "changeColumn");
  const type = edit?.op === "changeColumn" ? edit.column.typeSql : "?";
  return { ...plan(), plan: { ...plan().plan, statements: [`ALTER TABLE \`orders\` MODIFY \`total\` ${type}`] } };
};
const previewSql = () => screen.getByLabelText("SQL Apply runs").textContent;

test("ctrl_s_while_a_cell_is_being_edited_keeps_the_edit_and_shows_its_plan_before_applying", async () => {
  setup({}, { plan_design: echoPlan });
  await changeType("int");
  expect(previewSql()).toContain("MODIFY `total` int");
  fireEvent.doubleClick(cell("total", "type"));
  const box = screen.getByRole("combobox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "bigint" } });
  expect(fireEvent.keyDown(box, { key: "s", ctrlKey: true })).toBe(false);
  // The edit is kept, and Apply shows its SQL instead of running SQL the preview never showed (S13 I2).
  expect(await screen.findByText("The preview changed. Check it and Apply again.")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Cell value" })).toBeNull();
  await waitFor(() => expect(previewSql()).toContain("MODIFY `total` bigint"));
  expect(callsTo("apply_design")).toHaveLength(0);
  fireEvent.keyDown(screen.getByRole("tab", { name: /^Columns/ }), { key: "s", ctrlKey: true });
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
  const sent = callsTo("apply_design")[0].request as DesignRequest;
  expect(sent.edits).toEqual([expect.objectContaining({ op: "changeColumn", name: "total", column: expect.objectContaining({ typeSql: "bigint" }) })]);
});

test("an_apply_click_within_the_preview_wait_shows_the_plan_and_runs_nothing", async () => {
  setup({}, { plan_design: echoPlan });
  await screen.findByRole("tab", { name: "Columns 5" });
  // The preview's 200ms wait ends only once Apply's plan is on screen. On a busy machine it could end while
  // Apply's plan was still on its way, and then both plan, which this test is not about.
  const previewWait = holdTimers(200);
  fireEvent.doubleClick(cell("total", "type"));
  const box = screen.getByRole("combobox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "int" } });
  fireEvent.keyDown(box, { key: "Enter" });
  // Clicked before the preview has planned the change.
  fireEvent.click(applyButton());
  expect(await screen.findByText("The preview changed. Check it and Apply again.")).toBeTruthy();
  await waitFor(() => expect(previewSql()).toContain("MODIFY `total` int"));
  expect(callsTo("apply_design")).toHaveLength(0);
  expect(previewWait.count()).toBeGreaterThan(0);
  act(() => previewWait.release());
  // The preview's own wait does not plan again what Apply already showed.
  expect(callsTo("plan_design")).toHaveLength(1);
  await userEvent.click(applyButton());
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
});

test("a_spent_draft_applies_and_counts_nothing_while_the_table_reloads", async () => {
  let loads = 0;
  const { controlRef, onDirtyChange } = setup(
    {},
    // The reload after Apply never answers in this test.
    { table_design: () => (loads++ === 0 ? ORDERS : new Promise(() => {})) },
  );
  await changeType();
  expect(controlRef.current?.pendingCount()).toBe(1);
  await userEvent.click(applyButton());
  await screen.findByText("Applied 1 change to orders.");
  await waitFor(() => expect(callsTo("table_design")).toHaveLength(2));
  const planned = callsTo("plan_design").length;
  // Ctrl+S, the toolbar's Apply and the leave ask have nothing to apply until the reload lands (S13 I1).
  fireEvent.keyDown(screen.getByRole("tab", { name: /^Columns/ }), { key: "s", ctrlKey: true });
  expect(await controlRef.current!.save()).toBe(true);
  expect(controlRef.current!.flush()).toBe(false);
  expect(controlRef.current!.pendingCount()).toBe(0);
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  await new Promise((r) => setTimeout(r, 50));
  expect(callsTo("apply_design")).toHaveLength(1);
  expect(callsTo("plan_design").length).toBe(planned);
});

test("a_partial_failure_spends_the_draft_until_the_reload_lands", async () => {
  let loads = 0;
  const { controlRef } = setup(
    {},
    {
      table_design: () => (loads++ === 0 ? ORDERS : new Promise(() => {})),
      apply_design: () => {
        throw { kind: "designFailed", message: { statement: 1, ran: 1, total: 2, message: "Duplicate key name 'i'" } };
      },
    },
  );
  await changeType();
  await userEvent.click(applyButton());
  await screen.findByText("1 of 2 statements were applied. Statement 2 failed: Duplicate key name 'i'");
  expect(controlRef.current!.flush()).toBe(false);
  expect(controlRef.current!.pendingCount()).toBe(0);
  expect(await controlRef.current!.save()).toBe(true);
  expect(callsTo("apply_design")).toHaveLength(1);
});

test("ctrl_s_in_the_designer_does_not_save_the_grid", async () => {
  const page: Page = {
    columns: [
      { name: "id", typeName: "int", isPrimaryKey: true },
      { name: "status", typeName: "varchar", isPrimaryKey: false },
    ],
    rows: [[{ t: "number", value: "1" }, { t: "text", value: "paid", truncated: false, totalBytes: 4 }]],
    hasMore: false,
  };
  routeInvoke({
    table_design: () => ORDERS,
    plan_design: () => plan(),
    apply_design: () => ({ kind: "done", ran: 1 }),
    fetch_page: () => page,
    plan_edits: () => ({ statements: ["UPDATE orders SET status = 'x' WHERE id = 1"], verdict: { kind: "ok" } }),
    apply_edits: () => ({ updated: 1, inserted: 0, deleted: 0 }),
  });
  const client = new LangClient(() => fakeWorker());
  const controlRef = createRef<GridControl | null>() as MutableRefObject<GridControl | null>;
  render(
    <ToastProvider>
      <DataGrid connectionId="c1" table={ORDERS.path} onClose={() => {}} />
      <TableDesigner
        connection={conn()}
        target={{ kind: "alter", path: ORDERS.path }}
        group={null}
        visible={false}
        onDirtyChange={() => {}}
        controlRef={controlRef}
        onApplied={() => {}}
        lang={{ client, schemas: new SchemaCache(client) }}
      />
    </ToastProvider>,
  );
  // A dirty grid: status 'paid' becomes 'x'.
  await screen.findByText("paid");
  const gridView = screen.getByRole("region", { name: "Data of orders" });
  const dataScroll = gridView.querySelector(".grid-scroll") as HTMLElement;
  const td = gridView.querySelector('tr[data-row="0"] td[data-col="1"]') as HTMLElement;
  fireEvent.doubleClick(td);
  const box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "x" } });
  fireEvent.keyDown(box, { key: "Enter" });
  // A dirty design.
  await changeType();

  fireEvent.keyDown(screen.getByRole("tab", { name: /^Columns/ }), { key: "s", ctrlKey: true });
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
  expect(callsTo("plan_edits")).toHaveLength(0);

  const designCalls = callsTo("plan_design").length;
  fireEvent.keyDown(dataScroll, { key: "s", ctrlKey: true });
  await waitFor(() => expect(callsTo("plan_edits")).toHaveLength(1));
  expect(callsTo("plan_design")).toHaveLength(designCalls);
});

test("production_panes_have_the_wash", async () => {
  setup({ production: true });
  await screen.findByRole("tab", { name: "Columns 5" });
  const view = screen.getByRole("region", { name: "Design of orders" });
  expect(view.className).toContain("prod-wash");
  expect(screen.getByRole("region", { name: "SQL preview" }).className).toContain("prod-wash");
});

test("plain_panes_have_no_wash", async () => {
  setup();
  await screen.findByRole("tab", { name: "Columns 5" });
  expect(document.querySelector(".prod-wash")).toBeNull();
});

test("read_only_shows_the_design_and_its_ddl_and_plans_nothing", async () => {
  setup({ name: "shop-replica", readOnly: true });
  await screen.findByRole("tab", { name: "Columns 5" });
  expect(screen.getByText("View only")).toBeTruthy();
  expect(screen.getByText("shop-replica is Read-only. You can look at this design but not change it.")).toBeTruthy();
  expect(applyButton().disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Add column" }) as HTMLButtonElement).disabled).toBe(true);
  const ddl = screen.getByRole("region", { name: "DDL" });
  expect(ddl.textContent).toContain("What this table looks like in MySQL");
  await waitFor(() => expect(ddl.querySelector(".sql-block")?.textContent).toContain("CREATE TABLE `orders`"));
  expect(callsTo("table_ddl")).toEqual([{ id: "c1", path: ORDERS.path }]);
  fireEvent.keyDown(screen.getByRole("tab", { name: /^Columns/ }), { key: "s", ctrlKey: true });
  expect(await screen.findByText("shop-replica is Read-only. Changes are not allowed.")).toBeTruthy();
  expect(callsTo("plan_design")).toHaveLength(0);
});

test("a_bad_type_shows_the_core_message", async () => {
  setup(
    {},
    {
      plan_design: () => {
        throw { kind: "invalidInput", message: "The type of total is not one SQL expression." };
      },
    },
  );
  await changeType("int; drop table x", false);
  expect(await screen.findByText("The type of total is not one SQL expression.")).toBeTruthy();
});

test("a_blank_column_blocks_apply_before_planning", async () => {
  setup();
  await screen.findByRole("tab", { name: "Columns 5" });
  await userEvent.click(screen.getByRole("button", { name: "Add column" }));
  expect(await screen.findByText("Fill in the new column's name and type, or remove it.")).toBeTruthy();
  expect(applyButton().disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("tab", { name: /^Columns/ }), { key: "s", ctrlKey: true });
  await new Promise((r) => setTimeout(r, 300));
  expect(callsTo("plan_design")).toHaveLength(0);
  expect(callsTo("apply_design")).toHaveLength(0);
});

test("status_slot_counts_columns_and_changes", async () => {
  setup();
  await changeType();
  fireEvent.doubleClick(cell("email", "type"));
  const box = screen.getByRole("combobox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "varchar(120)" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(document.getElementById("app-status-slot")!.textContent).toBe("5 columns, 2 changes"));
});

test("header_strip_names_the_connection_and_table", async () => {
  setup({ production: true, name: "freight-prod" });
  await screen.findByRole("tab", { name: "Columns 5" });
  const strip = screen.getByRole("toolbar", { name: "Design header" });
  expect(strip.className).toContain("table-header");
  expect(strip.querySelector(".table-header-connection")!.textContent).toContain("freight-prod");
  expect(strip.querySelector(".production-label")!.textContent).toBe("PRODUCTION");
  expect(strip.querySelector(".table-header-name")!.textContent).toBe("shop.orders");
  expect(strip.querySelector(".kbd")!.textContent).toBe("Ctrl+S");
  await changeType();
  expect(strip.querySelector(".chip.chip-warning")!.textContent).toBe("1 change");
});

/**
 * A plan_design that the test releases by hand once `hold` is set; earlier calls answer at once.
 * The preview plans too, and on a busy machine its call can land after `hold`, so every held
 * call is kept and released together (one kept call let Apply wait forever).
 */
function heldPlan(answer: () => DesignVerdict) {
  const held: (() => void)[] = [];
  const gate = { hold: false, release: () => held.splice(0).forEach((go) => go()) };
  const handler = () => {
    if (!gate.hold) return answer();
    return new Promise<DesignVerdict>((resolve) => held.push(() => resolve(answer())));
  };
  return { gate, handler };
}

test(
  "the_draft_is_locked_while_apply_runs",
  patient(async () => {
    const { gate, handler } = heldPlan(() => plan());
    const { controlRef } = setup({}, { plan_design: handler });
    await changeType();
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    gate.hold = true;
    await userEvent.click(applyButton());
    await waitFor(() => expect(applyButton().textContent).toContain("Applying"));
    // Cell edits, toggles, the toolbar, Discard and the leave ask's discard are all refused.
    fireEvent.doubleClick(cell("email", "type"));
    expect(screen.queryByRole("combobox", { name: "Cell value" })).toBeNull();
    expect((screen.getByRole("button", { name: "Add column" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("tab", { name: "Columns 5" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement).disabled).toBe(true);
    // The leave ask's discard is refused, and says so, so the App keeps the tab.
    expect(controlRef.current?.discard()).toBe(false);
    expect(controlRef.current?.pendingCount()).toBe(1);
    // The Indexes tab is locked too.
    await userEvent.click(screen.getByRole("tab", { name: /^Indexes/ }));
    expect((screen.getByRole("button", { name: "Add index" }) as HTMLButtonElement).disabled).toBe(true);
    // A second Apply joins the running one.
    fireEvent.keyDown(screen.getByRole("tab", { name: /^Indexes/ }), { key: "s", ctrlKey: true });
    gate.release();
    await waitFor(() => expect(callsTo("apply_design")).toHaveLength(1));
    const sent = callsTo("apply_design")[0].request as DesignRequest;
    expect(sent.edits).toEqual([expect.objectContaining({ op: "changeColumn", name: "total" })]);
    await waitFor(() => expect((screen.getByRole("button", { name: "Add index" }) as HTMLButtonElement).disabled).toBe(false));
    expect(callsTo("apply_design")).toHaveLength(1);
  }),
  LOAD_TIMEOUT,
);

test(
  "reload_in_the_ask_waits_while_apply_runs",
  patient(async () => {
    let fail = true;
    const { gate, handler } = heldPlan(() => plan());
    const { controlRef } = setup(
      {},
      {
        plan_design: handler,
        apply_design: () => {
          if (fail) throw { kind: "designFailed", message: { statement: 0, ran: 0, total: 1, message: "Unknown column 'total'" } };
          return { kind: "done", ran: 1 };
        },
      },
    );
    await changeType();
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    await userEvent.click(applyButton());
    await screen.findByText("Nothing was changed. Statement 1 failed: Unknown column 'total'");
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    const dialog = await screen.findByRole("dialog");
    // Ctrl+S from the ask starts an Apply; Reload must not replace the draft while it runs.
    fail = false;
    gate.hold = true;
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Reload" }), { key: "s", ctrlKey: true });
    await waitFor(() => expect(applyButton().textContent).toContain("Applying"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Reload" }));
    expect(callsTo("table_design")).toHaveLength(1);
    expect(controlRef.current?.pendingCount()).toBe(1);
    gate.release();
    await waitFor(() => expect(callsTo("apply_design")).toHaveLength(2));
  }),
  LOAD_TIMEOUT,
);

test("a_create_names_the_table_from_the_sent_request", async () => {
  const { onApplied } = setup({}, {}, { kind: "create", scope: { database: "shop", schema: null }, id: "n1" });
  await screen.findByRole("tab", { name: "Columns 1" });
  fireEvent.doubleClick(cell("", "name"));
  let box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "id" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.doubleClick(cell("id", "type"));
  box = screen.getByRole("combobox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "int" } });
  fireEvent.keyDown(box, { key: "Enter" });
  // A new table needs its name before Apply.
  expect(applyButton().disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Table name" }), { target: { value: " orders " } });
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await previewShown();
  await userEvent.click(applyButton());
  await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  const sent = callsTo("apply_design")[0].request as DesignRequest;
  expect(sent.target.kind).toBe("create");
  const sentPath = sent.target.kind === "create" ? sent.target.path : null;
  // The very path object that was sent, not one read from the draft afterwards.
  expect(onApplied.mock.calls[0][0]).toBe(sentPath);
  expect(onApplied.mock.calls[0][1]).toBe("created");
  expect(sentPath?.name).toBe("orders");
  expect(await screen.findByText("Created orders.")).toBeTruthy();
});

test("restore_failure_after_the_change_reloads", async () => {
  setup(
    {},
    {
      apply_design: () => {
        throw { kind: "designRestoreFailed", message: { applied: true, sql: "PRAGMA foreign_keys = ON", message: "disk I/O error" } };
      },
    },
  );
  await changeType();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await userEvent.click(applyButton());
  expect(await screen.findByText(/^The change was applied, but restoring the connection/)).toBeTruthy();
  await waitFor(() => expect(callsTo("table_design")).toHaveLength(2));
});

test("restore_failure_before_the_change_keeps_the_draft", async () => {
  const { controlRef } = setup(
    {},
    {
      apply_design: () => {
        throw { kind: "designRestoreFailed", message: { applied: false, sql: "PRAGMA foreign_keys = ON", message: "disk I/O error" } };
      },
    },
  );
  await changeType();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await userEvent.click(applyButton());
  expect(await screen.findByText(/^The change was not applied, and restoring/)).toBeTruthy();
  expect(callsTo("table_design")).toHaveLength(1);
  expect(controlRef.current?.pendingCount()).toBe(1);
});

test("an_expired_pass_asks_again_with_a_fresh_plan", async () => {
  let applies = 0;
  setup(
    { name: "freight-prod", production: true },
    {
      plan_design: () => plan(ask),
      confirm_design: () => `pass-${callsTo("confirm_design").length}`,
      apply_design: () => {
        applies += 1;
        if (applies === 1) throw { kind: "needsConfirmation", message: null };
        return { kind: "done", ran: 1 };
      },
    },
  );
  await changeType();
  await waitFor(() => expect((screen.getByText("Apply on PROD").closest("button") as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByText("Apply on PROD"));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Apply on freight-prod" }));
  const planned = callsTo("plan_design").length;
  // The expired pass plans again and opens the dialog again.
  await waitFor(() => expect(callsTo("plan_design").length).toBeGreaterThan(planned - 1));
  const again = await screen.findByRole("dialog");
  await userEvent.click(within(again).getByRole("button", { name: "Apply on freight-prod" }));
  await waitFor(() => expect(callsTo("apply_design")).toHaveLength(2));
  expect(callsTo("apply_design").map((a) => a.pass)).toEqual(["pass-1", "pass-2"]);
  expect(await screen.findByText("Applied 1 change to orders.")).toBeTruthy();
});

test("a_second_needs_confirmation_after_a_replan_is_shown_not_looped", async () => {
  setup(
    {},
    {
      apply_design: () => {
        throw { kind: "needsConfirmation", message: null };
      },
    },
  );
  await changeType();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await userEvent.click(applyButton());
  expect(await screen.findByText("Confirm this write on a Production Connection")).toBeTruthy();
  expect(callsTo("apply_design")).toHaveLength(2);
});

test("a_server_read_only_refusal_shows_the_read_only_toast", async () => {
  setup(
    {},
    {
      apply_design: () => {
        throw { kind: "readOnlyRefused", message: null };
      },
    },
  );
  await changeType();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await userEvent.click(applyButton());
  expect(await screen.findByText("shop-staging is Read-only. Changes are not allowed.")).toBeTruthy();
});

test("a_sequential_plan_says_its_risk_in_the_confirm", async () => {
  setup({ name: "freight-prod", production: true }, { plan_design: () => plan(ask, { kind: "sequential" }, []) });
  await changeType();
  await waitFor(() => expect((screen.getByText("Apply on PROD").closest("button") as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByText("Apply on PROD"));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("alert").textContent).toBe(
    "MySQL runs this 1 statement. If it fails, nothing is applied.",
  );
  // Nothing is applying while the dialog asks.
  expect(screen.getByText("Apply on PROD")).toBeTruthy();
});

test("an_edit_clears_a_stale_apply_error", async () => {
  setup(
    {},
    {
      apply_design: () => {
        throw { kind: "designFailed", message: { statement: 0, ran: 0, total: 1, message: "Unknown column 'total'" } };
      },
    },
  );
  await changeType();
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await userEvent.click(applyButton());
  expect(await screen.findByText("Nothing was changed. Statement 1 failed: Unknown column 'total'")).toBeTruthy();
  fireEvent.doubleClick(cell("email", "type"));
  const box = screen.getByRole("combobox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "varchar(120)" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(screen.queryByText("Nothing was changed. Statement 1 failed: Unknown column 'total'")).toBeNull();
});

/** Fills a New table draft: column id int, table name orders. */
async function fillNewTable() {
  await screen.findByRole("tab", { name: "Columns 1" });
  fireEvent.doubleClick(cell("", "name"));
  let box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "id" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.doubleClick(cell("id", "type"));
  box = screen.getByRole("combobox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "int" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.change(screen.getByRole("textbox", { name: "Table name" }), { target: { value: "orders" } });
  await waitFor(() => expect(applyButton().disabled).toBe(false));
  await previewShown();
}

test("no_second_create_before_the_tab_turns_into_an_alter", async () => {
  const { onApplied } = setup({}, {}, { kind: "create", scope: { database: "shop", schema: null }, id: "n1" });
  await fillNewTable();
  await userEvent.click(applyButton());
  await waitFor(() => expect(onApplied).toHaveBeenCalledWith(expect.anything(), "created"));
  // The App has not swapped the tab yet: Apply and Ctrl+S must not send a second CREATE.
  fireEvent.click(applyButton());
  fireEvent.keyDown(screen.getByRole("tab", { name: /^Columns/ }), { key: "s", ctrlKey: true });
  await new Promise((r) => setTimeout(r, 50));
  expect(callsTo("apply_design")).toHaveLength(1);
});

test("no_second_create_after_a_partial_create", async () => {
  const { onApplied } = setup(
    {},
    {
      apply_design: () => {
        throw { kind: "designFailed", message: { statement: 1, ran: 1, total: 2, message: "Duplicate key name 'i'" } };
      },
    },
    { kind: "create", scope: { database: "shop", schema: null }, id: "n1" },
  );
  await fillNewTable();
  await userEvent.click(applyButton());
  await waitFor(() => expect(onApplied).toHaveBeenCalledWith(expect.anything(), "created"));
  fireEvent.click(applyButton());
  await new Promise((r) => setTimeout(r, 50));
  expect(callsTo("apply_design")).toHaveLength(1);
});

test("an_apply_ends_the_undo_history_and_ctrl_z_does_nothing_while_the_table_reloads", async () => {
  let loads = 0;
  let land: (d: typeof ORDERS) => void = () => {};
  setup({}, { table_design: () => (loads++ === 0 ? ORDERS : new Promise((r) => (land = r))) });
  await changeType();
  const undo = () => screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
  expect(undo().disabled).toBe(false);
  await userEvent.click(applyButton());
  await screen.findByText("Applied 1 change to orders.");
  await waitFor(() => expect(callsTo("table_design")).toHaveLength(2));
  // Spent: the applied change is on the server, so Ctrl+Z must not take it back in the draft.
  const view = document.querySelector(".design-view") as HTMLElement;
  expect(undo().disabled).toBe(true);
  fireEvent.keyDown(view, { key: "z", ctrlKey: true });
  await act(async () => land({ ...ORDERS, columns: ORDERS.columns.map((c) => (c.name === "total" ? { ...c, typeSql: "int" } : c)) }));
  await screen.findByRole("tab", { name: "Columns 5" });
  await waitFor(() => expect(cell("total", "type").textContent).toBe("int"));
  // The reloaded design starts a new history.
  expect(undo().disabled).toBe(true);
  fireEvent.keyDown(grid(), { key: "z", ctrlKey: true });
  expect(cell("total", "type").textContent).toBe("int");
  expect(cell("total", "type").className).not.toContain("cell-edited");
});
