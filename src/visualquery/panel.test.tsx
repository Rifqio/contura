import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, SqlSchema, VisualQuery, VqColumn, VqPreview, VqProblem } from "../api/types";
import { ToastProvider } from "../components/Toast";
import { LangClient } from "../lang/client";
import { SchemaCache } from "../lang/sql/schemaCache";
import type { VisualTabDoc } from "../shell/tabs";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import { patientFile } from "../test/load";
import { mockReactFlowDom } from "../test/reactFlow";
import { emptyQuery } from "./model";
import VisualQueryTab from "./VisualQueryTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

patientFile();
beforeAll(() => {
  mockReactFlowDom();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
});

const kestrel: ConnectionConfig = {
  id: "c1",
  name: "kestrel-main",
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
};

const col = (name: string, typeName = "int", pk = false) => ({ name, typeName, pk });
const SHOP: SqlSchema = {
  searchPath: [],
  tables: [
    { schema: null, name: "orders", kind: "table", columns: [col("id", "int", true), col("store_id"), col("placed_at", "datetime")] },
    { schema: null, name: "stores", kind: "table", columns: [col("id", "int", true), col("name", "varchar(80)"), col("city", "varchar(80)")] },
  ],
  fks: [{ from: { schema: null, table: "orders", columns: ["store_id"] }, to: { schema: null, table: "stores", columns: ["id"] } }],
};

let lang: { client: LangClient; schemas: SchemaCache };

/** The Core's preview, as far as the panel needs: output names and the problems it would list. */
function previewFor(q: VisualQuery): VqPreview {
  const problems: VqProblem[] = [];
  q.filters.forEach((f, index) => {
    if (!f.column) problems.push({ target: { kind: "filter", index }, message: `Pick a column for filter ${index + 1}.` });
  });
  const groups = q.columns.some((c) => c.aggregate !== null);
  q.orderBy.forEach((s, index) => {
    if (groups && s.target.kind === "column" && !q.columns.some((c) => s.target.kind === "column" && c.table === s.target.table && c.column === s.target.column)) {
      const alias = q.tables.find((t) => s.target.kind === "column" && t.id === s.target.table)?.alias;
      problems.push({
        target: { kind: "sort", index },
        message: `Sort by an output column when the query groups. ${alias}.${s.target.column} is not in the output.`,
      });
    }
  });
  if (q.columns.length === 0) problems.push({ target: { kind: "columns" }, message: "Tick at least one column." });
  if (q.groupBy.kind === "manual" && q.groupBy.columns.some((c) => !c.column))
    problems.push({ target: { kind: "query" }, message: "A GROUP BY row has no column. Pick one." });
  return {
    query: problems.length > 0 ? null : { sql: "SELECT 1", parts: [], outputs: q.columns.map((c) => c.alias ?? c.column), warnings: [] },
    problems,
  };
}

beforeEach(() => {
  const client = new LangClient(() => fakeWorker());
  lang = { client, schemas: new SchemaCache(client, () => Promise.resolve(SHOP)) };
  routeInvoke({ visual_query_sql: ({ query }) => previewFor(query as VisualQuery) });
});

const card = (id: string, name: string, alias: string, x = 0) => ({ id, schema: null, name, alias, x, y: 0 });
const out = (table: string, column: string, aggregate: VqColumn["aggregate"] = null): VqColumn => ({ table, column, alias: null, aggregate });
const BASE: Partial<VisualQuery> = {
  tables: [card("t1", "orders", "o"), card("t2", "stores", "s", 320)],
  joins: [{ id: "j1", left: "t1", right: "t2", kind: "inner", on: [{ leftColumn: "store_id", rightColumn: "id" }] }],
};

let latest: VisualQuery;
function Harness({ over }: { over: Partial<VisualQuery> }) {
  const [doc, setDoc] = useState<VisualTabDoc>({
    id: "v1",
    name: "New Visual Query",
    connectionId: "c1",
    database: "shop",
    model: { ...emptyQuery("shop", "mysql"), ...BASE, ...over },
    savedId: null,
    savedJson: null,
  });
  latest = doc.model;
  return (
    <ToastProvider>
      <VisualQueryTab
        doc={doc}
        connection={kestrel}
        open
        group={null}
        visible
        lang={lang}
        rowEstimate={() => null}
        onChange={setDoc}
        onOpenInEditor={() => {}}
        onSaved={() => {}}
        onOpenConnection={() => {}}
      />
    </ToastProvider>
  );
}

const tab = (name: RegExp) => screen.getByRole("tab", { name });
const columnsBody = () => screen.getByRole("tabpanel", { name: /Columns/ });
const filterBody = () => screen.getByRole("tabpanel", { name: /Filter and sort/ });
const outputRows = () => within(columnsBody()).getAllByRole("row").slice(1);
const fromOf = (row: HTMLElement) => row.querySelector(".vq-col-from")?.textContent;
async function pick(combobox: HTMLElement, option: string) {
  await userEvent.click(combobox);
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("the_tabs_count_columns_and_filters_with_sorts", async () => {
  render(
    <Harness
      over={{
        columns: [out("t1", "id"), out("t2", "name")],
        filters: [{ joiner: "and", table: "t2", column: "city", op: "eq", values: ["Oslo"] }],
        orderBy: [{ target: { kind: "output", index: 1 }, dir: "asc" }],
      }}
    />,
  );
  expect(await screen.findByRole("tab", { name: "Columns 2" })).toBeTruthy();
  expect(tab(/Filter and sort/).textContent).toBe("Filter and sort 2");
});

test("columns_reorder_by_drag_and_by_alt_arrow_down", async () => {
  render(<Harness over={{ columns: [out("t1", "id"), out("t2", "name"), out("t2", "city")] }} />);
  await waitFor(() => expect(outputRows()).toHaveLength(3));
  expect(outputRows().map(fromOf)).toEqual(["o.id", "s.name", "s.city"]);
  const grip = within(outputRows()[0]).getByRole("button", { name: "Move o.id" });
  fireEvent.dragStart(grip, { dataTransfer: { setData() {}, effectAllowed: "move" } });
  fireEvent.dragOver(outputRows()[2], { dataTransfer: { dropEffect: "move" } });
  fireEvent.drop(outputRows()[2], { dataTransfer: {} });
  await waitFor(() => expect(outputRows().map(fromOf)).toEqual(["s.name", "s.city", "o.id"]));
  const first = within(outputRows()[0]).getByRole("button", { name: "Move s.name" });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
  await waitFor(() => expect(outputRows().map(fromOf)).toEqual(["s.city", "s.name", "o.id"]));
  expect(latest.columns.map((c) => c.column)).toEqual(["city", "name", "id"]);
  // Focus stays with the moved row.
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Move s.name");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(outputRows().map(fromOf)).toEqual(["s.name", "s.city", "o.id"]));
});

test("an_output_row_has_its_name_from_and_aggregate_and_count_shows_on_the_card", async () => {
  render(<Harness over={{ columns: [out("t2", "name"), out("t1", "id")] }} />);
  await waitFor(() => expect(outputRows()).toHaveLength(2));
  const name = within(outputRows()[1]).getByRole("textbox", { name: "Output name for o.id" });
  // The Core's name is the placeholder.
  await waitFor(() => expect(name.getAttribute("placeholder")).toBe("id"));
  expect(name.className).toContain("vq-mono");
  await pick(within(outputRows()[1]).getByRole("combobox", { name: "Aggregate for o.id" }), "Count");
  await waitFor(() => expect(latest.columns[1].aggregate).toBe("count"));
  const orders = await screen.findByRole("group", { name: "Table orders o" });
  await waitFor(() => expect(within(orders).getByText("count").className).toContain("vq-card-agg"));
  // Typing a name keeps its spaces and commits on Enter.
  await userEvent.type(name, "order count{Enter}");
  await waitFor(() => expect(latest.columns[1].alias).toBe("order count"));
  // Unticking takes the column out.
  await userEvent.click(within(outputRows()[0]).getByRole("checkbox", { name: "Include s.name" }));
  await waitFor(() => expect(latest.columns.map((c) => c.column)).toEqual(["id"]));
});

test("sort_descending_reads_its_position", async () => {
  render(<Harness over={{ columns: [out("t2", "name"), out("t1", "id")] }} />);
  await waitFor(() => expect(outputRows()).toHaveLength(2));
  const sort = within(outputRows()[1]).getByRole("combobox", { name: "Sort for o.id" });
  expect(sort.textContent).toBe("None");
  await pick(sort, "Descending");
  await waitFor(() => expect(latest.orderBy).toEqual([{ target: { kind: "output", index: 1 }, dir: "desc" }]));
  await waitFor(() => expect(within(outputRows()[1]).getByRole("combobox", { name: "Sort for o.id" }).textContent).toBe("Descending, 1st"));
  await pick(within(outputRows()[0]).getByRole("combobox", { name: "Sort for s.name" }), "Ascending");
  await waitFor(() => expect(within(outputRows()[0]).getByRole("combobox", { name: "Sort for s.name" }).textContent).toBe("Ascending, 2nd"));
  await pick(within(outputRows()[1]).getByRole("combobox", { name: "Sort for o.id" }), "None");
  await waitFor(() => expect(latest.orderBy).toEqual([{ target: { kind: "output", index: 0 }, dir: "asc" }]));
});

test("group_by_is_auto_until_edited_by_hand", async () => {
  render(<Harness over={{ columns: [out("t2", "name"), out("t2", "city"), out("t1", "id", "count")] }} />);
  const auto = await within(columnsBody()).findByText("Auto");
  expect(auto.className).toContain("chip");
  expect(within(columnsBody()).getByText("s.name, s.city")).toBeTruthy();
  await userEvent.click(within(columnsBody()).getByRole("switch", { name: "Edit by hand" }));
  await waitFor(() => expect(latest.groupBy).toEqual({ kind: "manual", columns: [{ table: "t2", column: "name" }, { table: "t2", column: "city" }] }));
  expect(within(columnsBody()).queryByText("Auto")).toBeNull();
  const list = within(columnsBody()).getByRole("list", { name: "Group by" });
  expect(within(list).getAllByRole("listitem").map((li) => li.querySelector(".vq-group-name")?.textContent)).toEqual(["s.name", "s.city"]);
  await userEvent.click(within(list).getByRole("button", { name: "Remove s.city from Group by" }));
  await waitFor(() => expect(latest.groupBy).toEqual({ kind: "manual", columns: [{ table: "t2", column: "name" }] }));
  await pick(within(columnsBody()).getByRole("combobox", { name: "Add to Group by" }), "o.placed_at");
  await waitFor(() => expect(latest.groupBy).toEqual({ kind: "manual", columns: [{ table: "t2", column: "name" }, { table: "t1", column: "placed_at" }] }));
  await userEvent.click(within(columnsBody()).getByRole("switch", { name: "Edit by hand" }));
  await waitFor(() => expect(latest.groupBy).toEqual({ kind: "auto" }));
  expect(within(columnsBody()).getByText("Auto")).toBeTruthy();
});

const filterRows = () => within(filterBody()).getAllByRole("group", { name: /^Filter \d/ });

test("a_filter_without_a_column_shows_its_problem_under_it", async () => {
  render(
    <Harness
      over={{
        columns: [out("t2", "name")],
        filters: [
          { joiner: "and", table: "t2", column: "city", op: "eq", values: ["Oslo"] },
          { joiner: "and", table: "t1", column: "", op: "eq", values: [] },
        ],
      }}
    />,
  );
  await userEvent.click(tab(/Filter and sort/));
  await waitFor(() => expect(filterRows()).toHaveLength(2));
  // WHERE on the first row, AND or OR after.
  expect(within(filterRows()[0]).getByText("WHERE")).toBeTruthy();
  expect(within(filterRows()[1]).getByRole("combobox", { name: "Joiner for filter 2" }).textContent).toBe("AND");
  const second = filterRows()[1];
  const problem = await within(second).findByText("Pick a column for filter 2.");
  expect(problem.className).toContain("vq-problem");
  expect(within(second).getByRole("combobox", { name: "Column for filter 2" }).getAttribute("aria-invalid")).toBe("true");
  expect(within(filterRows()[0]).queryByText("Pick a column for filter 2.")).toBeNull();
  // Picking a column clears it.
  await pick(within(second).getByRole("combobox", { name: "Column for filter 2" }), "o.placed_at");
  await waitFor(() => expect(within(filterRows()[1]).queryByText("Pick a column for filter 2.")).toBeNull());
  expect(latest.filters[1]).toMatchObject({ table: "t1", column: "placed_at" });
  expect(within(filterBody()).getByText("Values are sent as quoted literals. For anything more, Open in editor.")).toBeTruthy();
});

test("between_takes_two_values_is_null_none_and_in_a_list", async () => {
  render(<Harness over={{ columns: [out("t2", "name")], filters: [{ joiner: "and", table: "t2", column: "city", op: "eq", values: [] }] }} />);
  await userEvent.click(tab(/Filter and sort/));
  await waitFor(() => expect(filterRows()).toHaveLength(1));
  expect(within(filterRows()[0]).getAllByRole("textbox")).toHaveLength(1);
  const op = within(filterRows()[0]).getByRole("combobox", { name: "Operator for filter 1" });
  await userEvent.click(op);
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "=",
    "<>",
    "<",
    "<=",
    ">",
    ">=",
    "LIKE",
    "NOT LIKE",
    "IN",
    "NOT IN",
    "BETWEEN",
    "IS NULL",
    "IS NOT NULL",
  ]);
  await userEvent.click(screen.getByRole("option", { name: "BETWEEN" }));
  await waitFor(() => expect(within(filterRows()[0]).getAllByRole("textbox")).toHaveLength(2));
  await userEvent.type(within(filterRows()[0]).getByRole("textbox", { name: "Second value for filter 1" }), "z");
  await waitFor(() => expect(latest.filters[0].values).toEqual(["", "z"]));
  await pick(within(filterRows()[0]).getByRole("combobox", { name: "Operator for filter 1" }), "IS NULL");
  await waitFor(() => expect(within(filterRows()[0]).queryAllByRole("textbox")).toHaveLength(0));
  await pick(within(filterRows()[0]).getByRole("combobox", { name: "Operator for filter 1" }), "IN");
  const list = await within(filterRows()[0]).findByRole("textbox", { name: "Values for filter 1" });
  expect(list.getAttribute("placeholder")).toBe("a, b, c");
});

test("mixing_and_with_or_says_how_they_bind", async () => {
  render(
    <Harness
      over={{
        columns: [out("t2", "name")],
        filters: [
          { joiner: "and", table: "t2", column: "city", op: "eq", values: ["Oslo"] },
          { joiner: "and", table: "t2", column: "name", op: "eq", values: ["A"] },
        ],
      }}
    />,
  );
  await userEvent.click(tab(/Filter and sort/));
  await waitFor(() => expect(filterRows()).toHaveLength(2));
  expect(within(filterBody()).queryByText("AND binds before OR. For other groupings, Open in editor.")).toBeNull();
  await userEvent.click(within(filterBody()).getByRole("button", { name: "Add condition" }));
  await waitFor(() => expect(filterRows()).toHaveLength(3));
  expect(latest.filters[2]).toMatchObject({ joiner: "and", table: "t1", column: "" });
  await pick(within(filterRows()[2]).getByRole("combobox", { name: "Joiner for filter 3" }), "OR");
  expect(await within(filterBody()).findByText("AND binds before OR. For other groupings, Open in editor.")).toBeTruthy();
  await userEvent.click(within(filterRows()[2]).getByRole("button", { name: "Remove filter 3" }));
  await waitFor(() => expect(within(filterBody()).queryByText("AND binds before OR. For other groupings, Open in editor.")).toBeNull());
});

test("a_limit_that_is_not_whole_is_marked_and_not_sent", async () => {
  render(<Harness over={{ columns: [out("t2", "name")] }} />);
  await userEvent.click(tab(/Filter and sort/));
  const limit = await within(filterBody()).findByRole("textbox", { name: "LIMIT" });
  expect(limit.getAttribute("placeholder")).toBe("No limit");
  await userEvent.type(limit, "5.5");
  expect(await within(filterBody()).findByText("LIMIT is a whole number.")).toBeTruthy();
  expect(limit.getAttribute("aria-invalid")).toBe("true");
  expect(latest.limit).toBeNull();
  // The request after the edit omits the limit: 5 is sent, then 5.5 sends none.
  await userEvent.clear(limit);
  await userEvent.type(limit, "5");
  await waitFor(() => expect((callsTo("visual_query_sql").slice(-1)[0].query as VisualQuery).limit).toBe(5));
  const before = callsTo("visual_query_sql").length;
  await userEvent.type(limit, ".5");
  await waitFor(() => expect(callsTo("visual_query_sql").length).toBeGreaterThan(before));
  expect((callsTo("visual_query_sql").slice(-1)[0].query as VisualQuery).limit).toBeNull();
  // The text as typed, with its problem, survives a visit to another tab.
  await userEvent.click(tab(/^Columns/));
  await userEvent.click(tab(/Filter and sort/));
  const again = within(filterBody()).getByRole("textbox", { name: "LIMIT" });
  expect((again as HTMLInputElement).value).toBe("5.5");
  expect(within(filterBody()).getByText("LIMIT is a whole number.")).toBeTruthy();
  await userEvent.clear(again);
  await userEvent.type(again, "5");
  await waitFor(() => expect(latest.limit).toBe(5));
  expect(within(filterBody()).queryByText("LIMIT is a whole number.")).toBeNull();
  await userEvent.click(within(filterBody()).getByRole("switch", { name: "Distinct" }));
  await waitFor(() => expect(latest.distinct).toBe(true));
});

test("the_d8_sort_problem_shows_under_its_row", async () => {
  render(
    <Harness
      over={{
        columns: [out("t2", "name"), out("t1", "id", "count")],
        orderBy: [{ target: { kind: "column", table: "t1", column: "placed_at" }, dir: "asc" }],
      }}
    />,
  );
  await userEvent.click(tab(/Filter and sort/));
  const sorts = await within(filterBody()).findAllByRole("group", { name: /^Sort \d/ });
  expect(within(sorts[0]).getByRole("combobox", { name: "Sort column 1" }).textContent).toBe("o.placed_at");
  expect(await within(sorts[0]).findByText("Sort by an output column when the query groups. o.placed_at is not in the output.")).toBeTruthy();
  expect(within(sorts[0]).getByRole("combobox", { name: "Sort column 1" }).getAttribute("aria-invalid")).toBe("true");
  // Sorting by an output instead clears it.
  await pick(within(sorts[0]).getByRole("combobox", { name: "Sort column 1" }), "name");
  await waitFor(() => expect(latest.orderBy).toEqual([{ target: { kind: "output", index: 0 }, dir: "asc" }]));
  await waitFor(() => expect(within(filterBody()).queryByText(/Sort by an output column/)).toBeNull());
  await pick(within(filterBody()).getByRole("combobox", { name: "Direction for sort 1" }), "Descending");
  await waitFor(() => expect(latest.orderBy[0].dir).toBe("desc"));
  await userEvent.click(within(filterBody()).getByRole("button", { name: "Add sort" }));
  await waitFor(() => expect(latest.orderBy).toHaveLength(2));
  await userEvent.click(within(filterBody()).getByRole("button", { name: "Remove sort 2" }));
  await waitFor(() => expect(latest.orderBy).toHaveLength(1));
});

test("every_picker_is_a_themed_select", async () => {
  render(
    <Harness
      over={{
        columns: [out("t2", "name"), out("t1", "id")],
        filters: [{ joiner: "and", table: "t2", column: "city", op: "eq", values: ["Oslo"] }],
        orderBy: [{ target: { kind: "output", index: 0 }, dir: "asc" }],
        groupBy: { kind: "manual", columns: [{ table: "t2", column: "name" }] },
      }}
    />,
  );
  await waitFor(() => expect(outputRows()).toHaveLength(2));
  expect(within(columnsBody()).getAllByRole("combobox").length).toBeGreaterThan(0);
  expect(columnsBody().querySelector("select")).toBeNull();
  await userEvent.click(tab(/Filter and sort/));
  await waitFor(() => expect(filterRows()).toHaveLength(1));
  expect(within(filterBody()).getAllByRole("combobox").length).toBeGreaterThanOrEqual(4);
  expect(filterBody().querySelector("select")).toBeNull();
});

test("a_columns_problem_shows_under_the_columns", async () => {
  render(<Harness over={{}} />);
  const problem = await within(columnsBody()).findByText("Tick at least one column.");
  expect(problem.className).toContain("vq-problem");
});

test("a_group_by_row_with_no_column_shows_its_problem_under_that_row", async () => {
  render(
    <Harness
      over={{
        columns: [out("t2", "name"), out("t1", "id", "count")],
        groupBy: { kind: "manual", columns: [{ table: "t2", column: "name" }, { table: "t2", column: "" }] },
      }}
    />,
  );
  const list = await within(columnsBody()).findByRole("list", { name: "Group by" });
  const [named, empty] = within(list).getAllByRole("listitem");
  expect(await within(empty).findByText("A GROUP BY row has no column. Pick one.")).toBeTruthy();
  expect(within(named).queryByText(/has no column/)).toBeNull();
  // Said once, at its row, not again under the section.
  expect(within(columnsBody()).getAllByText("A GROUP BY row has no column. Pick one.")).toHaveLength(1);
});
