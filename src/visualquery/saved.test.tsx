// Saved Visual Queries (Task 10): Save and its dialog, the list rows, and the closed and removed states.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, ObjectPath, SavedQuery, SqlSchema, VisualQuery, VqPreview } from "../api/types";
import { iconElement } from "../components/Icon";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import SavedQueriesList from "../query/SavedQueriesList";
import { isUnsaved, type VisualTabDoc } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { savedVisualModel } from "./drafts";
import { emptyQuery } from "./model";
import SaveDialog from "./SaveDialog";
import VisualQueryTab, { type VisualQueryTabProps } from "./VisualQueryTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

patientFile();
beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});

const conn = (id: string, name: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id,
  name,
  dialect: "mysql",
  host: "127.0.0.1",
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
const kestrel = conn("c1", "kestrel-main");
const harrier = conn("c2", "harrier-replica");

const col = (name: string, typeName = "int", pk = false) => ({ name, typeName, pk });
const SHOP: SqlSchema = {
  searchPath: [],
  tables: [
    { schema: null, name: "orders", kind: "table", columns: [col("id", "int", true), col("store_id"), col("code", "varchar(8)")] },
    { schema: null, name: "stores", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)")] },
  ],
  fks: [{ from: { schema: null, table: "orders", columns: ["store_id"] }, to: { schema: null, table: "stores", columns: ["id"] } }],
};

const SQL = "SELECT o.id\nFROM orders AS o";
const preview = (q: VisualQuery): VqPreview =>
  q.columns.length === 0
    ? { query: null, problems: [{ target: { kind: "columns" }, message: "Tick at least one column." }] }
    : { query: { sql: SQL, parts: [], outputs: q.columns.map((c) => c.column), warnings: [] }, problems: [] };

let lang: { client: LangClient; schemas: SchemaCache };
let loads: string[] = [];
beforeEach(() => {
  loads = [];
  const client = new LangClient(() => fakeWorker());
  lang = {
    client,
    schemas: new SchemaCache(client, (_c, db) => {
      loads.push(db);
      return Promise.resolve(SHOP);
    }),
  };
  routeInvoke({
    visual_query_sql: ({ query }) => preview(query as VisualQuery),
    open_query_session: () => "s1",
    close_query_session: () => null,
    save_saved_query: ({ input }) => {
      const i = input as Record<string, unknown>;
      return { ...i, id: i.id ?? "sv1", updatedAtMs: 1, connectionId: i.connectionId ?? null };
    },
  });
});

const card = (id: string, name: string, alias: string, x = 0) => ({ id, schema: null, name, alias, x, y: 0 });
const ORDERS: Partial<VisualQuery> = {
  tables: [card("t1", "orders", "o")],
  columns: [{ table: "t1", column: "id", aggregate: null, alias: null }],
};

const docWith = (over: Partial<VisualQuery> = {}, doc: Partial<VisualTabDoc> = {}): VisualTabDoc => ({
  id: "v1",
  name: "New Visual Query",
  connectionId: "c1",
  database: "shop",
  model: { ...emptyQuery("shop", "mysql"), ...over },
  savedId: null,
  savedJson: null,
  ...doc,
});

let current: VisualTabDoc | null = null;
function Harness({ initial, connection = kestrel, ...props }: { initial: VisualTabDoc } & Partial<VisualQueryTabProps>) {
  const [doc, setDoc] = useState(initial);
  current = doc;
  return (
    <ToastProvider>
      <div style={{ width: 1200, height: 800 }}>
        <VisualQueryTab
          doc={doc}
          connection={connection}
          open
          group={null}
          visible
          lang={lang}
          rowEstimate={(_p: ObjectPath) => null}
          onChange={setDoc}
          onOpenInEditor={() => {}}
          onSaved={() => {}}
          onOpenConnection={() => {}}
          {...props}
        />
      </div>
    </ToastProvider>
  );
}

const VQ_ICON = iconElement("visualQuery").querySelector("path")!.getAttribute("d");
const toolbar = () => screen.getByRole("toolbar", { name: "Visual Query" });
const canvas = () => document.querySelector<HTMLElement>(".diagram-canvas")!;
const ctrlS = () => fireEvent.keyDown(canvas(), { key: "s", code: "KeyS", ctrlKey: true });
const cardEl = async (label: string) => (await screen.findByRole("group", { name: label })) as HTMLElement;

test("first_ctrl_s_asks_for_a_name_with_the_name_rules_then_saves_the_model", async () => {
  const onSaved = vi.fn();
  render(<Harness initial={docWith(ORDERS)} savedQueries={[storedRow({ id: "other", name: "Late Orders" })]} onSaved={onSaved} />);
  await waitFor(() => expect(callsTo("visual_query_sql").length).toBeGreaterThan(0));
  ctrlS();
  const dialog = await screen.findByRole("dialog", { name: "Save Visual Query" });
  const name = within(dialog).getByLabelText("Name");
  // An empty name.
  await userEvent.clear(name);
  await userEvent.click(within(dialog).getByRole("button", { name: /^Save/ }));
  expect(within(dialog).getByRole("alert").textContent).toBe("Give it a name.");
  // A clash, ignoring case.
  await userEvent.type(name, "late orders");
  await userEvent.click(within(dialog).getByRole("button", { name: /^Save/ }));
  expect(within(dialog).getByRole("alert").textContent).toBe('A Saved Query named "late orders" already exists. Pick another name.');
  expect(callsTo("save_saved_query")).toHaveLength(0);
  await userEvent.clear(name);
  await userEvent.type(name, "late orders by store");
  await userEvent.click(within(dialog).getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(1));
  const input = callsTo("save_saved_query")[0].input as Record<string, unknown>;
  expect(input).toMatchObject({ id: null, name: "late orders by store", sql: SQL, kind: "visual", connectionId: "c1" });
  expect(JSON.parse(input.visualJson as string)).toEqual(current!.model);
  expect(await screen.findByText("Saved. late orders by store is in Saved Queries.")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Save Visual Query" })).toBeNull();
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "sv1", kind: "visual" }));
  // The tab is the Saved Query now, and not dirty.
  await waitFor(() => expect(current).toMatchObject({ name: "late orders by store", savedId: "sv1" }));
  expect(isUnsaved({ kind: "visual", doc: current! })).toBe(false);

  // A change makes it dirty; the next Ctrl+S overwrites without asking.
  await userEvent.click(within(await cardEl("Table orders o")).getByRole("checkbox", { name: "o.code" }));
  await waitFor(() => expect(isUnsaved({ kind: "visual", doc: current! })).toBe(true));
  ctrlS();
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(2));
  expect(screen.queryByRole("dialog", { name: "Save Visual Query" })).toBeNull();
  expect(callsTo("save_saved_query")[1].input).toMatchObject({ id: "sv1", name: "late orders by store", kind: "visual" });
  await waitFor(() => expect(isUnsaved({ kind: "visual", doc: current! })).toBe(false));
});

test("the_save_button_saves_too_and_the_tab_control_saves_for_the_close_ask", async () => {
  const controlRef: { current: { save(): Promise<boolean> } | null } = { current: null };
  const savedJson = JSON.stringify({ ...emptyQuery("shop", "mysql"), ...ORDERS });
  render(
    <Harness
      initial={docWith({ ...ORDERS, distinct: true }, { name: "late orders", savedId: "sv9", savedJson })}
      controlRef={controlRef as VisualQueryTabProps["controlRef"]}
    />,
  );
  await waitFor(() => expect(controlRef.current).not.toBeNull());
  let ok = false;
  await act(async () => {
    ok = await controlRef.current!.save();
  });
  expect(ok).toBe(true);
  expect(callsTo("save_saved_query")[0].input).toMatchObject({ id: "sv9", name: "late orders", kind: "visual" });
  await userEvent.click(within(toolbar()).getByRole("button", { name: /^Save/ }));
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(2));
});

test("save_dialog_alone_checks_names_ignoring_case", async () => {
  const onSave = vi.fn();
  render(<SaveDialog initial="Weekly" existing={["WEEKLY"]} onSave={onSave} onCancel={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
  expect(screen.getByRole("alert").textContent).toBe('A Saved Query named "Weekly" already exists. Pick another name.');
  await userEvent.type(screen.getByLabelText("Name"), " two");
  await userEvent.keyboard("{Enter}");
  expect(onSave).toHaveBeenCalledWith("Weekly two");
});

test("save_dialog_says_a_sql_querys_name_is_taken_by_a_sql_query", async () => {
  const onSave = vi.fn();
  render(<SaveDialog initial="weekly sales" existing={["Weekly Sales"]} sqlNames={["Weekly Sales"]} onSave={onSave} onCancel={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
  expect(screen.getByRole("alert").textContent).toBe("This name belongs to a SQL query. Pick another name.");
  expect(onSave).not.toHaveBeenCalled();
});

const storedRow = (over: Partial<SavedQuery> = {}): SavedQuery => ({
  id: "sv1",
  name: "late orders",
  sql: "SELECT stored",
  updatedAtMs: 1,
  connectionId: null,
  kind: "visual",
  visualJson: "{}",
  ...over,
});

test("saving_with_the_connection_removed_keeps_the_stored_sql_and_sends_no_dead_connection", async () => {
  const controlRef: { current: { save(): Promise<boolean> } | null } = { current: null };
  render(
    <Harness
      initial={docWith({ ...ORDERS, distinct: true }, { connectionId: "gone", savedId: "sv1", name: "late orders", savedJson: "{}" })}
      connection={null}
      open={false}
      savedQueries={[storedRow()]}
      controlRef={controlRef as VisualQueryTabProps["controlRef"]}
    />,
  );
  await waitFor(() => expect(controlRef.current).not.toBeNull());
  await act(async () => {
    await controlRef.current!.save();
  });
  ctrlS();
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(2));
  for (const c of callsTo("save_saved_query")) {
    expect(c.input).toMatchObject({ id: "sv1", sql: "SELECT stored", kind: "visual", connectionId: null });
  }
});

test("a_closed_connection_keeps_the_stored_sql_rather_than_untyped_sql", async () => {
  const savedJson = JSON.stringify({ ...emptyQuery("shop", "mysql"), ...ORDERS });
  render(<Harness initial={docWith(ORDERS, { savedId: "sv1", name: "late orders", savedJson })} open={false} savedQueries={[storedRow({ connectionId: "c1" })]} />);
  await waitFor(() => expect(callsTo("visual_query_sql").length).toBeGreaterThan(0));
  ctrlS();
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(1));
  expect(callsTo("save_saved_query")[0].input).toMatchObject({ sql: "SELECT stored", connectionId: "c1" });
});

test("a_second_save_while_the_first_is_on_the_way_is_ignored", async () => {
  let release: () => void = () => {};
  routeInvoke({
    visual_query_sql: ({ query }) => preview(query as VisualQuery),
    open_query_session: () => "s1",
    close_query_session: () => null,
    save_saved_query: ({ input }) =>
      new Promise((done) => {
        release = () => done({ ...(input as object), id: "sv1", updatedAtMs: 1, connectionId: "c1" });
      }),
  });
  render(<Harness initial={docWith(ORDERS)} />);
  await waitFor(() => expect(callsTo("visual_query_sql").length).toBeGreaterThan(0));
  ctrlS();
  const dialog = await screen.findByRole("dialog", { name: "Save Visual Query" });
  await userEvent.type(within(dialog).getByLabelText("Name"), "late orders{Enter}");
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(1));
  ctrlS();
  await userEvent.click(within(toolbar()).getByRole("button", { name: /^Save/ }));
  expect(screen.queryByRole("dialog", { name: "Save Visual Query" })).toBeNull();
  await act(async () => release());
  await waitFor(() => expect(current!.savedId).toBe("sv1"));
  expect(callsTo("save_saved_query")).toHaveLength(1);
});

test("the_dirty_mark_does_not_depend_on_key_order", () => {
  const model = { ...emptyQuery("shop", "mysql"), ...ORDERS };
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(model).reverse()));
  expect(isUnsaved({ kind: "visual", doc: docWith(ORDERS, { savedId: "sv1", savedJson: reordered }) })).toBe(false);
  expect(isUnsaved({ kind: "visual", doc: docWith({ ...ORDERS, distinct: true }, { savedId: "sv1", savedJson: reordered }) })).toBe(true);
});

test("a_saved_model_reads_its_version_first", () => {
  const model = { ...emptyQuery("shop", "mysql"), ...ORDERS };
  expect(savedVisualModel(JSON.stringify(model))).toEqual({ kind: "model", model });
  // A newer model is refused before its shape is read, even with fields this build does not know.
  expect(savedVisualModel(JSON.stringify({ version: 2, columns: [{ aggregate: "median" }] }))).toEqual({ kind: "newer" });
  expect(savedVisualModel("not json")).toEqual({ kind: "unreadable" });
  expect(savedVisualModel(JSON.stringify({ version: 1 }))).toEqual({ kind: "unreadable" });
});

test("the_saved_queries_list_shows_a_visual_row_with_its_icon_and_connection", async () => {
  routeInvoke({ saved_query_runs: () => [] });
  const model = JSON.stringify({ ...emptyQuery("shop", "mysql"), ...ORDERS });
  const queries: SavedQuery[] = [
    { id: "s1", name: "late orders by store", sql: SQL, updatedAtMs: 1, connectionId: "c1", kind: "visual", visualJson: model },
    { id: "s2", name: "orphan", sql: SQL, updatedAtMs: 1, connectionId: null, kind: "visual", visualJson: model },
    { id: "s3", name: "plain", sql: "SELECT 1", updatedAtMs: 1, connectionId: null, kind: "sql", visualJson: null },
  ];
  render(<SavedQueriesList queries={queries} connections={[kestrel]} onOpen={() => {}} onChanged={() => {}} />);
  const rowOf = (name: string) => within(screen.getByRole("table")).getByText(name).closest("tr")!;
  const iconOf = (name: string) => rowOf(name).querySelector("td path")?.getAttribute("d");
  expect(iconOf("late orders by store")).toBe(VQ_ICON);
  expect(within(rowOf("late orders by store")).getByText("kestrel-main")).toBeTruthy();
  expect(within(rowOf("orphan")).getByText("Connection removed")).toBeTruthy();
  expect(iconOf("plain")).not.toBe(VQ_ICON);
  expect(within(rowOf("plain")).getByText("No Connection")).toBeTruthy();
});

test("a_removed_connection_shows_the_banner_and_open_here_rebinds_and_opens", async () => {
  const onOpenConnection = vi.fn();
  render(
    <Harness
      initial={docWith(ORDERS, { connectionId: null, savedId: "sv1", name: "late orders" })}
      connection={null}
      open={false}
      connections={[kestrel, harrier, conn("c3", "pg", { dialect: "postgres" })]}
      onOpenConnection={onOpenConnection}
    />,
  );
  const banner = screen.getByText("This Visual Query's Connection was removed.").closest(".vq-banner") as HTMLElement;
  // Only the model's Dialect is offered.
  await userEvent.click(within(banner).getByRole("combobox", { name: "Connection" }));
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["kestrel-main", "harrier-replica"]);
  await userEvent.click(screen.getByRole("option", { name: "harrier-replica" }));
  await userEvent.click(within(banner).getByRole("button", { name: "Open here" }));
  expect(current!.connectionId).toBe("c2");
  expect(onOpenConnection).toHaveBeenCalledWith("c2");
});

test("a_closed_connection_fades_the_cards_without_types_and_offers_to_open_it", async () => {
  const onOpenConnection = vi.fn();
  // The schema is already known from an earlier open: a closed Connection still shows no types.
  await lang.schemas.ensure("c1", "shop");
  render(<Harness initial={docWith(ORDERS, { savedId: "sv1" })} open={false} onOpenConnection={onOpenConnection} />);
  const banner = screen.getByText("kestrel-main is not open", { selector: ".vq-banner p" }).closest(".vq-banner") as HTMLElement;
  const orders = await cardEl("Table orders o");
  const rows = orders.querySelectorAll(".vq-card-row");
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.classList.contains("vq-card-row-faded")).toBe(true);
    expect(r.querySelector(".vq-card-type")?.textContent ?? "").toBe("");
  }
  expect(document.querySelector(".vq-canvas")!.classList.contains("vq-canvas-closed")).toBe(true);
  const run = within(toolbar()).getByRole("button", { name: /^Run/ }) as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  expect(run.title).toBe("kestrel-main is not open");
  // The banner alone says so: the cards carry no line of their own.
  expect(within(orders).queryByText("kestrel-main is not open")).toBeNull();
  await userEvent.click(within(banner).getByRole("button", { name: "Open kestrel-main" }));
  expect(onOpenConnection).toHaveBeenCalledTimes(1);
});

test("an_edited_model_saved_while_closed_takes_the_last_preview_not_the_stored_sql", async () => {
  const savedJson = JSON.stringify({ ...emptyQuery("shop", "mysql"), ...ORDERS });
  render(
    <Harness
      initial={docWith({ ...ORDERS, distinct: true }, { savedId: "sv1", name: "late orders", savedJson })}
      open={false}
      savedQueries={[storedRow({ connectionId: "c1" })]}
    />,
  );
  await screen.findByRole("group", { name: "Generated SQL" });
  ctrlS();
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(1));
  // The stored SQL belongs to the model before the edit.
  expect(callsTo("save_saved_query")[0].input).toMatchObject({ sql: SQL });
});

test("more_rename_on_a_saved_visual_query_saves_the_new_name_and_keeps_the_saved_model", async () => {
  const onSaved = vi.fn();
  const savedJson = JSON.stringify({ ...emptyQuery("shop", "mysql"), ...ORDERS });
  render(
    <Harness
      initial={docWith({ ...ORDERS, distinct: true }, { savedId: "sv1", name: "late orders", savedJson })}
      savedQueries={[storedRow({ connectionId: "c1", visualJson: savedJson }), storedRow({ id: "other", name: "Busy stores" })]}
      onSaved={onSaved}
    />,
  );
  await userEvent.click(within(toolbar()).getByRole("button", { name: "More" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Rename..." }));
  const field = await screen.findByRole("textbox", { name: "Name" });
  // Another Saved Query's name is refused, ignoring case.
  await userEvent.clear(field);
  await userEvent.type(field, "busy stores{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe('A Saved Query named "busy stores" already exists. Pick another name.');
  expect(callsTo("save_saved_query")).toHaveLength(0);
  await userEvent.clear(field);
  await userEvent.type(field, "late orders by store{Enter}");
  await waitFor(() => expect(callsTo("save_saved_query")).toHaveLength(1));
  // Only the name changes: the unsaved edit stays unsaved.
  expect(callsTo("save_saved_query")[0].input).toMatchObject({
    id: "sv1",
    name: "late orders by store",
    sql: "SELECT stored",
    kind: "visual",
    visualJson: savedJson,
    connectionId: "c1",
  });
  await waitFor(() => expect(current!.name).toBe("late orders by store"));
  expect(current!.savedJson).toBe(savedJson);
  expect(onSaved).toHaveBeenCalledTimes(1);
});

test("open_here_takes_the_picked_connections_database_when_it_does_not_reach_the_old_one", async () => {
  const crm = conn("c2", "harrier-crm", { database: "crm" });
  const client = new LangClient(() => fakeWorker());
  lang = { client, schemas: new SchemaCache(client, (_c, db) => Promise.resolve(db === "shop" ? SHOP : { searchPath: [], tables: [], fks: [] })) };
  const { rerender } = render(
    <Harness initial={docWith(ORDERS, { connectionId: null, savedId: "sv1", name: "late orders" })} connection={null} open={false} connections={[crm]} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open here" }));
  expect(current!.connectionId).toBe("c2");
  rerender(<Harness initial={current!} connection={crm} open databases={["crm", "archive"]} />);
  await waitFor(() => expect(current!.database).toBe("crm"));
  expect(current!.model.database).toBe("crm");
  // The cards say where they were looked for.
  expect((await cardEl("Table orders o")).textContent).toContain("Not found in crm");
});

test("open_here_keeps_the_database_when_the_picked_connection_reaches_it", async () => {
  const replica = conn("c2", "harrier-replica");
  const { rerender } = render(
    <Harness initial={docWith(ORDERS, { connectionId: null, savedId: "sv1", name: "late orders" })} connection={null} open={false} connections={[replica]} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open here" }));
  rerender(<Harness initial={current!} connection={replica} open databases={["shop", "crm"]} />);
  await cardEl("Table orders o");
  await new Promise((r) => setTimeout(r, 20));
  expect(current!.database).toBe("shop");
  expect(current!.model.database).toBe("shop");
});
