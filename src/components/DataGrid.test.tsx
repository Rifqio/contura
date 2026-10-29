import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Page } from "../api/types";
import { LangClient } from "../lang/client";
import { KFC_SCHEMA } from "../lang/sql/fixtures";
import { SchemaCache } from "../lang/sql/schemaCache";
import { mockEditorDom } from "../test/editor";
import { callsTo, routeInvoke } from "../test/invoke";
import { fakeWorker } from "../test/langWorker";
import tokensCss from "../styles/tokens.css?raw";
import { useTabAsk } from "../assistant/tabAsk";
import DataGrid from "./DataGrid";
import { forgetSlowForTests } from "../grid/keyCounts";
import { clearAllSteps, RecordStepContext, stepsOf } from "../assistant/recentSteps";
import { ToastProvider } from "./Toast";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
mockEditorDom();

const table = { database: "shop", schema: null, name: "orders" };

function page(hasMore: boolean): Page {
  return {
    columns: [
      { name: "id", typeName: "int unsigned", isPrimaryKey: true },
      { name: "note", typeName: "varchar(80)", isPrimaryKey: false },
    ],
    rows: [
      [
        { t: "number", value: "1" },
        { t: "text", value: "first", truncated: false, totalBytes: 5 },
      ],
    ],
    hasMore,
  };
}

const nextButton = () => screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement;

test("requests page 0 then page 1 on next", async () => {
  routeInvoke({ fetch_page: () => page(true) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await waitFor(() => expect(nextButton().disabled).toBe(false));
  await userEvent.click(nextButton());
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  const pages = callsTo("fetch_page").map((a) => (a.request as { page: number }).page);
  expect(pages).toEqual([0, 1]);
  expect(callsTo("fetch_page")[0]).toEqual({ id: "c1", request: { table, page: 0, sort: null, filter: null } });
});

/** Item 2: builds a filter in the Add filter form: column, condition, value, then Add filter. */
async function addFilter(column: string, condition: string, value: string | null) {
  await userEvent.click(screen.getByRole("button", { name: "Add filter" }));
  const form = screen.getByRole("dialog", { name: "Add filter" });
  await userEvent.click(within(form).getByRole("combobox", { name: "Column" }));
  await userEvent.click(screen.getByRole("option", { name: new RegExp(`^${column}`) }));
  await userEvent.click(within(form).getByRole("combobox", { name: "Condition" }));
  await userEvent.click(screen.getByRole("option", { name: condition }));
  if (value !== null) {
    const box = within(form).getByRole("textbox", { name: "Value" });
    await userEvent.clear(box);
    await userEvent.type(box, value);
  }
  await userEvent.click(within(form).getByRole("button", { name: /^Add filter/ }));
}

test("item_2_a_filter_built_in_words_fetches_its_where_and_its_chip_removes_it", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" />);
  await screen.findByText("first");
  // No SQL boxes in the header.
  expect(screen.queryByRole("textbox", { name: "Order by" })).toBeNull();
  expect(document.querySelector(".grid-filter")).toBeNull();
  expect(within(screen.getByRole("toolbar", { name: "Filter and sort" })).getByText("All rows")).toBeTruthy();
  await addFilter("id", "is more than", "5");
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  expect(callsTo("fetch_page")[1]).toMatchObject({ request: { page: 0, filter: "`id` > 5" } });
  await userEvent.click(screen.getByRole("button", { name: "Remove filter: id is more than 5" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(3));
  expect(callsTo("fetch_page")[2]).toMatchObject({ request: { filter: null } });
});

test("item_2_a_value_that_does_not_fit_says_why_and_adds_nothing", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" />);
  await screen.findByText("first");
  await addFilter("id", "is at least", "five");
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Enter a number, such as 500 or 12.5.");
  expect(callsTo("fetch_page")).toHaveLength(1);
  // Escape closes the form.
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add filter" })).toBeNull());
});

test("a_filter_error_offers_clear_filters", async () => {
  routeInvoke({
    fetch_page: ({ request }) => {
      if ((request as { filter: string | null }).filter) throw { kind: "query", message: "Unknown column 'nope'" };
      return page(false);
    },
  });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" />);
  await screen.findByText("first");
  await addFilter("note", "contains", "x");
  await userEvent.click(await screen.findByRole("button", { name: "Clear filters" }));
  expect(await screen.findByText("first")).toBeTruthy();
});

test("grid_shows_read_only_lock", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  const { unmount } = render(<DataGrid connectionId="c1" table={table} onClose={() => {}} readOnly />);
  await screen.findByText("first");
  const lock = screen.getByRole("img", { name: "Read-only Connection: cells can't be edited" });
  expect(lock.getAttribute("title")).toBe("Read-only Connection: cells can't be edited");
  expect(lock.closest("th.row-number")).toBeTruthy();
  unmount();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  expect(screen.queryByRole("img", { name: /Read-only/ })).toBeNull();
});

test("next disabled when hasMore false", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  expect(nextButton().disabled).toBe(true);
});

test("G11: a header click cycles ascending, descending, none", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  const sortById = screen.getByRole("button", { name: "Sort by id" });
  await userEvent.click(sortById);
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await userEvent.click(screen.getByRole("button", { name: "Sort by id" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(3));
  await userEvent.click(screen.getByRole("button", { name: "Sort by id" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(4));
  await userEvent.click(screen.getByRole("button", { name: "Sort by note" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(5));
  const sorts = callsTo("fetch_page").map((a) => (a.request as { sort: unknown }).sort);
  expect(sorts).toEqual([
    null,
    { column: "id", descending: false },
    { column: "id", descending: true },
    null,
    { column: "note", descending: false },
  ]);
});

test("a failed sort offers Clear sort, which refetches unsorted", async () => {
  routeInvoke({
    fetch_page: (args) => {
      if ((args.request as { sort: unknown }).sort) throw { kind: "query", message: "could not sort" };
      return page(false);
    },
  });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  expect(screen.queryByRole("button", { name: "Clear sort" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Sort by note" }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "Clear sort" }));
  await screen.findByText("first");
  const sorts = callsTo("fetch_page").map((a) => (a.request as { sort: unknown }).sort);
  expect(sorts).toEqual([null, { column: "note", descending: false }, null]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an unsorted fetch error offers only Try again", async () => {
  routeInvoke({
    fetch_page: () => {
      throw { kind: "query", message: "boom" };
    },
  });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Clear sort" })).toBeNull();
});

const ROWS = 1000;
const VIEW_HEIGHT = 400;

function bigPage(): Page {
  return {
    columns: [
      { name: "id", typeName: "int unsigned", isPrimaryKey: true },
      { name: "note", typeName: "text", isPrimaryKey: false },
    ],
    rows: Array.from({ length: ROWS }, (_, r) => [
      { t: "number", value: String(r + 1) },
      { t: "text", value: `note ${r + 1}`, truncated: true, totalBytes: 5000 },
    ]),
    hasMore: true,
  };
}

/** jsdom has no layout: give the grid's scroll box a height. */
function stubViewport() {
  const proto = HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("grid-scroll") ? VIEW_HEIGHT : 0;
    },
  });
  onTestFinished(() => {
    if (original) Object.defineProperty(proto, "clientHeight", original);
  });
}

function scrollGrid(top: number) {
  const box = document.querySelector(".grid-scroll") as HTMLElement;
  Object.defineProperty(box, "scrollTop", { configurable: true, writable: true, value: top });
  fireEvent.scroll(box);
}

const bodyRows = () => Array.from(document.querySelectorAll("tbody tr[data-row]"));

test("a 1,000-row page renders only the rows near the viewport", async () => {
  stubViewport();
  routeInvoke({ fetch_page: () => bigPage() });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("note 1");
  expect(bodyRows().length).toBeGreaterThan(0);
  expect(bodyRows().length).toBeLessThan(100);
  expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe(String(ROWS + 1));
  expect(screen.queryByText("note 1000")).toBeNull();
});

test("scrolling to the bottom renders row 1,000 with its number", async () => {
  stubViewport();
  routeInvoke({ fetch_page: () => bigPage() });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("note 1");
  scrollGrid(ROWS * 28 - VIEW_HEIGHT);
  const last = (await screen.findByText("note 1000")).closest("tr") as HTMLElement;
  expect(last.querySelector(".row-number")?.textContent).toBe("1,000");
  expect(last.getAttribute("aria-rowindex")).toBe(String(ROWS + 1));
  expect(screen.queryByText("note 1")).toBeNull();
  expect(bodyRows().length).toBeLessThan(100);
});

test("the next page after scrolling starts at its first row", async () => {
  stubViewport();
  routeInvoke({ fetch_page: () => bigPage() });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("note 1");
  scrollGrid(ROWS * 28 - VIEW_HEIGHT);
  await screen.findByText("note 1000");
  await userEvent.click(nextButton());
  await waitFor(() => expect(document.querySelector(".table-range")!.textContent).toBe("1,001 to 2,000"));
  const top = (await screen.findByText("note 1")).closest("tr") as HTMLElement;
  expect(top.querySelector(".row-number")?.textContent).toBe("1,001");
  expect((document.querySelector(".grid-scroll") as HTMLElement).scrollTop).toBe(0);
});

test("rows_are_28_and_the_header_grows_for_the_type_line", () => {
  const css = tokensCss.replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).toMatch(/--row-h:\s*28px;/);
  expect(css).toMatch(/--grid-cell-height:\s*var\(--row-h\);/);
  // The name over its type takes two lines: 38 px (user decision 2026-10-19).
  expect(css).toMatch(/--grid-header-height:\s*calc\(var\(--row-h\) \+ 10px\);/);
});

/** jsdom has no layout: give headers, the gutter and the scroll box widths; change them through the result. */
function stubWidths(view: number) {
  // label: the .header-label box, which clips; name and hint: its parts at full width.
  const sizes = { view, gutter: 48, th: 80, label: 50, name: 50, hint: 0 };
  const proto = HTMLElement.prototype;
  const saved = ["offsetWidth", "scrollWidth", "clientWidth"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  );
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("type-hint")) return sizes.hint;
      if (this.tagName !== "TH") return 0;
      return this.classList.contains("row-number") ? sizes.gutter : sizes.th;
    },
  });
  Object.defineProperty(proto, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("header-name")) return sizes.name;
      return this.classList.contains("header-label") ? sizes.label : 0;
    },
  });
  Object.defineProperty(proto, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("grid-scroll") ? sizes.view : 0;
    },
  });
  onTestFinished(() => {
    for (const [k, d] of saved) if (d) Object.defineProperty(proto, k, d);
  });
  return sizes;
}

/** A ResizeObserver the test fires by hand. */
function stubResizeObserver() {
  const callbacks: (() => void)[] = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(cb: () => void) {
      callbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  onTestFinished(() => {
    globalThis.ResizeObserver = original;
  });
  return () => act(() => callbacks.forEach((cb) => cb()));
}

/** A `document.fonts` still loading; resolve it to finish. */
function stubFontsLoading() {
  let finish = () => {};
  const ready = new Promise<void>((r) => (finish = r));
  const fonts = { status: "loading", ready, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  onTestFinished(() => {
    delete (document as { fonts?: unknown }).fonts;
  });
  return async () => {
    fonts.status = "loaded";
    finish();
    await act(async () => {
      await ready;
    });
  };
}

const colWidths = () => Array.from(document.querySelectorAll("colgroup col"), (c) => (c as HTMLElement).style.width);

test("a_short_result_fills_the_pane", async () => {
  // 449 = the 48 px gutter, 400 px for the columns and the 1 px the collapsed border takes.
  stubWidths(449);
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "200px", "200px"]));
  expect(screen.getByRole("table").style.width).toBe("448px");
});

test("a_dragged_column_keeps_its_width_and_never_goes_under_its_header", async () => {
  stubWidths(449);
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "200px", "200px"]));
  const handle = document.querySelectorAll(".col-resize")[0];
  expect(handle.getAttribute("aria-hidden")).toBe("true");
  fireEvent.mouseDown(handle, { clientX: 300, button: 0 });
  fireEvent.mouseMove(window, { clientX: 260 });
  expect(colWidths()).toEqual(["48px", "160px", "240px"]);
  fireEvent.mouseMove(window, { clientX: -1000 });
  fireEvent.mouseUp(window);
  // The header label is 50 px plus 16 px of padding.
  expect(colWidths()).toEqual(["48px", "66px", "334px"]);
  fireEvent.mouseMove(window, { clientX: 600 });
  expect(colWidths()).toEqual(["48px", "66px", "334px"]);
  expect(callsTo("fetch_page")).toHaveLength(1);
});

test("a_column_is_never_fitted_narrower_than_its_whole_header", async () => {
  // The label box is clipped to 50 px, but the name needs 120 and the type hint under it 40:
  // the column takes the wider line plus the 16 px of padding, so no name is cut ("stat...").
  const sizes = stubWidths(49);
  sizes.name = 120;
  sizes.hint = 40;
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "136px", "136px"]));
});

test("widths_are_measured_again_once_the_fonts_load", async () => {
  // 49 px leaves no free space, so the columns show their measured widths.
  const sizes = stubWidths(49);
  const loaded = stubFontsLoading();
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "80px", "80px"]));
  sizes.th = 120;
  await loaded();
  await waitFor(() => expect(colWidths()).toEqual(["48px", "120px", "120px"]));
});

test("a_resized_column_keeps_its_width_after_the_fonts_load", async () => {
  const sizes = stubWidths(49);
  const loaded = stubFontsLoading();
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "80px", "80px"]));
  fireEvent.mouseDown(document.querySelectorAll(".col-resize")[0], { clientX: 100, button: 0 });
  fireEvent.mouseMove(window, { clientX: 200 });
  fireEvent.mouseUp(window);
  expect(colWidths()).toEqual(["48px", "180px", "80px"]);
  sizes.th = 120;
  await loaded();
  await waitFor(() => expect(colWidths()).toEqual(["48px", "180px", "120px"]));
});

test("a_grid_first_shown_while_hidden_measures_when_it_appears", async () => {
  const sizes = stubWidths(0);
  sizes.gutter = 0;
  sizes.th = 0;
  sizes.label = 0;
  const resize = stubResizeObserver();
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  expect(colWidths()).toEqual([]);
  expect(document.querySelector(".col-resize")).toBeNull();
  Object.assign(sizes, { view: 449, gutter: 48, th: 80, label: 50 });
  resize();
  await waitFor(() => expect(colWidths()).toEqual(["48px", "200px", "200px"]));
  expect(document.querySelector(".col-resize")).toBeTruthy();
});

test("a row rendered after scrolling opens its own full value", async () => {
  stubViewport();
  routeInvoke({
    fetch_page: () => bigPage(),
    fetch_full_value: () => ({ t: "text", value: "the whole note" }),
  });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("note 1");
  scrollGrid(ROWS * 28 - VIEW_HEIGHT);
  const last = (await screen.findByText("note 1000")).closest("tr") as HTMLElement;
  await userEvent.click(within(last).getByRole("button", { name: "Open full value" }));
  await screen.findByText("the whole note");
  expect(callsTo("fetch_full_value")[0]).toEqual({
    id: "c1",
    request: { table, column: "note", key: [{ column: "id", value: { t: "number", value: "1000" } }] },
  });
});

// ---- Task 19: table data as designed (frames j and i) ----

const pgOrders = { database: "shop", schema: "public", name: "orders" };
const header = () => document.querySelector(".table-header") as HTMLElement;
const footer = () => document.querySelector(".table-foot") as HTMLElement;
const cell = (row: number, col: number) => document.querySelector(`tr[data-row="${row}"] td[data-col="${col}"]`) as HTMLElement;

async function editFirst(value = "lost") {
  fireEvent.doubleClick(cell(0, 1));
  const box = screen.getByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value } });
  fireEvent.keyDown(box, { key: "Enter" });
}

test("item_5_one_header_strip_names_the_table_and_holds_its_tools", async () => {
  routeInvoke({ fetch_page: () => page(true) });
  render(
    <DataGrid
      connectionId="c1"
      table={pgOrders}
      onClose={() => {}}
      dialect="postgres"
      production
      connectionName="freight-prod"
      rowEstimate={90412}
      onOpenQuery={() => {}}
      onDesign={() => {}}
    />,
  );
  await screen.findByText("first");
  expect(document.querySelectorAll(".table-header")).toHaveLength(1);
  const strip = within(header());
  expect(strip.getByText("freight-prod")).toBeTruthy();
  expect(strip.getByText("PRODUCTION").className).toContain("production-label");
  const name = strip.getByRole("heading", { level: 2 });
  expect(name.textContent).toBe("public.orders");
  // No count answered (the route is not there), so the header keeps the server's estimate, marked as one.
  // The ~ is drawn; a screen reader hears "about".
  expect(header().querySelector('[data-rows="estimate"]')!.textContent).toBe("~about 90,412 rows");
  // No SQL in the header: the filters and sort are the strip under it.
  expect(header().querySelector(".cm-editor")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Order by" })).toBeNull();
  const names = strip.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(names).toEqual(["Reload", "Add row", "Delete row", "Edit structure", "Table"]);
  expect(screen.getByRole("toolbar", { name: "Filter and sort" })).toBeTruthy();
});

test("item_2_the_sort_chip_reads_in_words_flips_and_clears", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  const bar = within(screen.getByRole("toolbar", { name: "Filter and sort" }));
  // A header click sorts, and the chip says how.
  await userEvent.click(screen.getByRole("button", { name: "Sort by note" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await userEvent.click(bar.getByRole("button", { name: "Sort by note, A to Z. Select to reverse." }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(3));
  expect(bar.getByRole("button", { name: "Sort by note, Z to A. Select to reverse." })).toBeTruthy();
  await userEvent.click(bar.getByRole("button", { name: "Remove sort" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(4));
  // The Sort form picks a column and a direction.
  await userEvent.click(bar.getByRole("button", { name: "Sort" }));
  const form = screen.getByRole("dialog", { name: "Sort" });
  await userEvent.click(within(form).getByRole("combobox", { name: "Sort column" }));
  await userEvent.click(screen.getByRole("option", { name: /^id/ }));
  await userEvent.click(within(form).getByRole("radio", { name: "largest first" }));
  await userEvent.click(within(form).getByRole("button", { name: /^Sort/ }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(5));
  const sorts = callsTo("fetch_page").map((a) => (a.request as { sort: unknown }).sort);
  expect(sorts).toEqual([null, { column: "note", descending: false }, { column: "note", descending: true }, null, { column: "id", descending: true }]);
});

test("the_header_counts_the_rows_because_the_server_figure_is_an_estimate", async () => {
  // MySQL said 0 rows (TABLE_ROWS is stale); the table holds 1.
  routeInvoke({ fetch_page: () => page(false), count_rows: () => ({ kind: "counted", rows: 1 }) });
  const onExactCount = vi.fn();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} rowEstimate={0} onExactCount={onExactCount} />);
  await screen.findByText("first");
  await waitFor(() => expect(header().querySelector('[data-rows="exact"]')!.textContent).toBe("1 row"));
  expect(onExactCount).toHaveBeenCalledWith(1);
  expect(footer().querySelector(".table-range")!.textContent).toBe("1 to 1 of 1");
  const req = callsTo("count_rows")[0].request as { filter: string | null };
  expect(req.filter).toBeNull();
});

test("an_empty_table_says_0_rows_whatever_the_estimate", async () => {
  // MySQL said 49 rows; the table is empty.
  routeInvoke({ fetch_page: () => ({ ...page(false), rows: [] }), count_rows: () => ({ kind: "counted", rows: 0 }) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} rowEstimate={49} />);
  await waitFor(() => expect(header().querySelector('[data-rows="exact"]')!.textContent).toBe("0 rows"));
});

test("a_large_table_keeps_the_estimate_marked_as_one", async () => {
  // Over 1,000 rows the Core stops counting (1,001 means more), so the header keeps the server's figure.
  routeInvoke({ fetch_page: () => page(true), count_rows: () => ({ kind: "counted", rows: 1001 }) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} rowEstimate={90412} />);
  await screen.findByText("first");
  await waitFor(() => expect(header().querySelector('[data-rows="estimate"]')!.getAttribute("title")).toContain("more than 1,000 rows"));
  expect(header().querySelector('[data-rows="estimate"]')!.textContent).toBe("~about 90,412 rows");
});

test("with_a_filter_on_the_footer_gives_no_total_from_the_unfiltered_count", async () => {
  routeInvoke({ fetch_page: () => page(false), count_rows: () => ({ kind: "counted", rows: 12 }) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" rowEstimate={10} />);
  await screen.findByText("first");
  await waitFor(() => expect(footer().querySelector(".table-range")!.textContent).toBe("1 to 1 of 12"));
  await addFilter("id", "is more than", "5");
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await waitFor(() => expect(footer().querySelector(".table-range")!.textContent).toBe("1 to 1"));
  // The header still counts the table, not the filter.
  expect(header().querySelector('[data-rows="exact"]')!.textContent).toBe("12 rows");
});

test("a_hidden_tab_counts_nothing_until_it_is_shown", async () => {
  routeInvoke({ fetch_page: () => page(false), count_rows: () => ({ kind: "counted", rows: 1 }) });
  const { rerender } = render(<DataGrid connectionId="c1" table={table} onClose={() => {}} visible={false} />);
  await screen.findByText("first");
  await new Promise((r) => setTimeout(r, 20));
  expect(callsTo("count_rows")).toHaveLength(0);
  rerender(<DataGrid connectionId="c1" table={table} onClose={() => {}} visible />);
  await waitFor(() => expect(callsTo("count_rows")).toHaveLength(1));
});

test("a_design_change_counts_once", async () => {
  routeInvoke({ fetch_page: () => page(false), count_rows: () => ({ kind: "counted", rows: 1 }) });
  const { rerender } = render(<DataGrid connectionId="c1" table={table} onClose={() => {}} version={0} />);
  await waitFor(() => expect(header().querySelector('[data-rows="exact"]')).toBeTruthy());
  expect(callsTo("count_rows")).toHaveLength(1);
  rerender(<DataGrid connectionId="c1" table={table} onClose={() => {}} version={1} />);
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await new Promise((r) => setTimeout(r, 20));
  expect(callsTo("count_rows")).toHaveLength(2);
});

test("a_count_over_1000_or_not_made_clears_the_tree_count", async () => {
  onTestFinished(() => forgetSlowForTests());
  routeInvoke({ fetch_page: () => page(true), count_rows: () => ({ kind: "counted", rows: 1001 }) });
  const onExactCount = vi.fn();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} rowEstimate={90412} onExactCount={onExactCount} />);
  await waitFor(() => expect(onExactCount).toHaveBeenCalledWith(null));
  expect(onExactCount).not.toHaveBeenCalledWith(expect.any(Number));
});

test("a_slow_count_says_so_and_does_not_claim_a_closed_connection", async () => {
  onTestFinished(() => forgetSlowForTests());
  routeInvoke({ fetch_page: () => page(false), count_rows: () => ({ kind: "timedOut" }) });
  const onExactCount = vi.fn();
  const { rerender } = render(<DataGrid connectionId="c1" table={table} onClose={() => {}} rowEstimate={49} onExactCount={onExactCount} />);
  await waitFor(() => expect(header().querySelector('[data-rows="estimate"]')!.getAttribute("title")).toContain("Counting took too long"));
  expect(onExactCount).toHaveBeenCalledWith(null);
  // Reload within the minute: the count is skipped because it was slow, and the tooltip says that.
  rerender(<DataGrid connectionId="c1" table={table} onClose={() => {}} rowEstimate={49} onExactCount={onExactCount} version={1} />);
  await waitFor(() => expect(header().querySelector('[data-rows="estimate"]')!.getAttribute("title")).toContain("took too long a moment ago"));
  expect(header().querySelector('[data-rows="estimate"]')!.getAttribute("title")).not.toContain("once the Connection is open");
});

test("the_row_count_has_an_accessible_name", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} rowEstimate={49} />);
  await screen.findByText("first");
  const est = header().querySelector('[data-rows="estimate"]') as HTMLElement;
  expect(est.querySelector('[aria-hidden="true"]')!.textContent).toBe("~");
  expect(est.querySelector(".visually-hidden")!.textContent).toBe("about ");
});

test("footer_shows_range_pager_and_context_line", async () => {
  routeInvoke({ fetch_page: () => page(true) });
  const { rerender } = render(<DataGrid connectionId="c1" table={table} onClose={() => {}} rowEstimate={1284} />);
  await screen.findByText("first");
  const foot = within(footer());
  expect(footer().querySelector(".table-range")!.textContent).toBe("1 to 1 of about 1,284");
  // The pager arrows sit after the range, on the left.
  const prev = foot.getByRole("button", { name: "Previous page" });
  const next = foot.getByRole("button", { name: "Next page" });
  expect(footer().querySelector(".table-range")!.compareDocumentPosition(prev) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  rerender(<DataGrid connectionId="c1" table={table} onClose={() => {}} rowEstimate={null} />);
  expect(footer().querySelector(".table-range")!.textContent).toBe("1 to 1");
  await editFirst();
  fireEvent.click(screen.getByRole("button", { name: "Add row" }));
  expect(footer().querySelector(".table-context")!.textContent).toBe("Saving runs the 2 statements in one transaction.");
  rerender(<DataGrid connectionId="c1" table={table} onClose={() => {}} production />);
  expect(footer().querySelector(".table-context")!.textContent).toBe(
    "Saving runs on Production and asks you to confirm the SQL first.",
  );
});

const fkPage: Page = {
  columns: [
    { name: "id", typeName: "int4", isPrimaryKey: true },
    { name: "customer_id", typeName: "int4", isPrimaryKey: false },
    { name: "status", typeName: "text", isPrimaryKey: false },
  ],
  rows: [[{ t: "number", value: "1" }, { t: "number", value: "7" }, { t: "text", value: "paid", truncated: false, totalBytes: 4 }]],
  hasMore: false,
};

test("fk_columns_show_a_link_icon", async () => {
  routeInvoke({ fetch_page: () => fkPage, sql_schema: () => KFC_SCHEMA });
  const client = new LangClient(() => fakeWorker());
  const lang = { client, schemas: new SchemaCache(client) };
  const orders = { database: "kfc", schema: "sales", name: "orders" };
  render(<DataGrid connectionId="c1" table={orders} onClose={() => {}} dialect="postgres" lang={lang} />);
  await screen.findByText("paid");
  const th = (name: string) => screen.getByRole("button", { name: `Sort by ${name}` });
  await waitFor(() => expect(th("customer_id").querySelector(".fk-icon")).not.toBeNull());
  // The link icon comes before the name; the key stays on the key column only.
  expect(th("customer_id").querySelector(".header-label")!.firstElementChild!.classList.contains("fk-icon")).toBe(true);
  expect(th("id").querySelector(".key-icon")).not.toBeNull();
  expect(th("id").querySelector(".fk-icon")).toBeNull();
  expect(th("status").querySelector(".fk-icon")).toBeNull();
});

test("production_table_pane_has_the_wash", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} production readOnly />);
  await screen.findByText("first");
  const pane = screen.getByRole("region", { name: "Data of orders" });
  expect(pane.classList.contains("prod-wash")).toBe(true);
  for (const part of [header(), footer()]) expect(pane.contains(part)).toBe(true);
});

test("read_only_footer_says_why", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} readOnly production />);
  await screen.findByText("first");
  expect(footer().querySelector(".table-context")!.textContent).toBe("Read-only Connection: cells cannot be edited");
});

test("editing_a_read_only_cell_shows_one_toast", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(
    <ToastProvider>
      <DataGrid connectionId="c1" table={table} onClose={() => {}} readOnly connectionName="freight-reporting" />
    </ToastProvider>,
  );
  await screen.findByText("first");
  fireEvent.doubleClick(cell(0, 1));
  fireEvent.doubleClick(cell(0, 1));
  const toasts = document.querySelectorAll(".toast");
  expect(toasts).toHaveLength(1);
  expect(toasts[0].textContent).toContain("freight-reporting is Read-only. Changes are not allowed.");
  expect(toasts[0].className).toContain("toast-readOnly");
  expect(screen.queryByRole("textbox", { name: "Cell value" })).toBeNull();
});

test("edited_cell_tooltip", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await editFirst("second");
  expect(cell(0, 1).title).toBe("Was first. Edited, not saved yet.");
  expect(cell(0, 0).title).toBe("");
});

test("item_5_edit_structure_shows_on_a_table_with_on_design_and_not_on_a_view", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  const onDesign = vi.fn();
  const { unmount } = render(<DataGrid connectionId="c1" table={table} onClose={() => {}} onDesign={onDesign} />);
  await screen.findByText("first");
  const button = within(screen.getByRole("toolbar", { name: "Table" })).getByRole("button", { name: "Edit structure" });
  expect(button.getAttribute("title")).toBe("Change columns, keys and indexes");
  expect(button.querySelector("svg.feature-icon")?.getAttribute("data-feature")).toBe("designer");
  await userEvent.click(button);
  expect(onDesign).toHaveBeenCalledTimes(1);
  unmount();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} kind="view" onDesign={onDesign} />);
  await screen.findByText("first");
  expect(screen.queryByRole("button", { name: "Edit structure" })).toBeNull();
});

test("item_5_the_table_menu_holds_lineage_on_a_table_only", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  const onLineage = vi.fn();
  const { unmount } = render(<DataGrid connectionId="c1" table={table} onClose={() => {}} onLineage={onLineage} />);
  await screen.findByText("first");
  await userEvent.click(screen.getByRole("button", { name: "Table" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Show lineage" }));
  expect(onLineage).toHaveBeenCalledTimes(1);
  unmount();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} kind="view" onLineage={onLineage} />);
  await screen.findByText("first");
  await userEvent.click(screen.getByRole("button", { name: "Table" }));
  expect(screen.queryByRole("menuitem", { name: "Show lineage" })).toBeNull();
});

// ---- After a design apply ----

test("a_new_version_reloads_columns_and_page_0_with_no_pending_edits", async () => {
  let wide = false;
  routeInvoke({
    fetch_page: () => {
      const p = page(true);
      if (!wide) return p;
      return {
        ...p,
        columns: [...p.columns, { name: "total", typeName: "int", isPrimaryKey: false }],
        rows: [[...p.rows[0], { t: "number", value: "7" }]],
      };
    },
  });
  const props = { connectionId: "c1", table, onClose: () => {} };
  const { rerender } = render(<DataGrid {...props} version={0} />);
  await screen.findByText("first");
  await waitFor(() => expect(nextButton().disabled).toBe(false));
  await userEvent.click(nextButton());
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  const cell = document.querySelector('tr[data-row="0"] td[data-col="1"]') as HTMLElement;
  fireEvent.doubleClick(cell);
  const box = await screen.findByRole("textbox", { name: "Cell value" });
  fireEvent.change(box, { target: { value: "edited" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByRole("region", { name: "Pending Edits" });
  wide = true;
  rerender(<DataGrid {...props} version={1} />);
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(3));
  expect((callsTo("fetch_page")[2].request as { page: number }).page).toBe(0);
  expect(await screen.findByRole("columnheader", { name: /total/ })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Pending Edits" })).toBeNull();
  // The edit is gone with the old columns; the new cell can be edited at once.
  fireEvent.doubleClick(document.querySelector('tr[data-row="0"] td[data-col="2"]') as HTMLElement);
  const next = await screen.findByRole("textbox", { name: "Cell value" });
  fireEvent.change(next, { target: { value: "9" } });
  fireEvent.keyDown(next, { key: "Enter" });
  expect(await screen.findByRole("region", { name: "Pending Edits" })).toBeTruthy();
});

test("a_grid_notice_shows_under_the_header", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} notice="orders changed. Reload to see its new columns." />);
  expect(await screen.findByText("orders changed. Reload to see its new columns.")).toBeTruthy();
});

test("item_5_the_table_menu_offers_export_and_import_and_sends_the_table_origin", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  const onExport = vi.fn();
  const onImport = vi.fn();
  const onTransfer = vi.fn();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} rowEstimate={18} onExport={onExport} onImport={onImport} onTransfer={onTransfer} onOpenQuery={() => {}} />);
  await screen.findByText("first");
  await userEvent.click(screen.getByRole("button", { name: "Table" }));
  expect(screen.getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual([
    "Open as a query",
    "Copy rows as CSV",
    "Export rows...",
    "Import into orders...",
    "Copy to another Connection...",
    "Columns",
    "Copy name",
  ]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Export rows..." }));
  expect(onExport).toHaveBeenCalledWith({
    kind: "table",
    path: table,
    columns: ["id", "note"],
    hidden: [],
    order: ["id", "note"],
    filter: null,
    sort: null,
    selected: [],
    hasPrimaryKey: true,
    rowEstimate: 18,
    estimated: true,
  });
  await userEvent.click(screen.getByRole("button", { name: "Table" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Import into orders..." }));
  expect(onImport).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Table" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Copy to another Connection..." }));
  expect(onTransfer).toHaveBeenCalledTimes(1);
});

test("ctrl_e_exports_with_the_filter_sort_and_selected_row", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  const onExport = vi.fn();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" onExport={onExport} />);
  await screen.findByText("first");
  await addFilter("id", "is more than", "0");
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await userEvent.click(screen.getByRole("button", { name: "Sort by id" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(3));
  await screen.findByText("first");
  const cell = document.querySelector('tr[data-row="0"] td[data-col="1"]') as HTMLElement;
  fireEvent.mouseDown(cell);
  fireEvent.keyDown(cell, { key: "e", code: "KeyE", ctrlKey: true });
  await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
  expect(onExport.mock.calls[0][0]).toMatchObject({
    filter: "`id` > 0",
    sort: { column: "id", descending: false },
    selected: [[{ column: "id", value: { t: "number", value: "1" } }]],
    rowEstimate: null,
    estimated: false,
  });
});

test("a_table_without_a_primary_key_says_so_in_the_origin", async () => {
  routeInvoke({
    fetch_page: () => ({ ...page(false), columns: page(false).columns.map((c) => ({ ...c, isPrimaryKey: false })) }),
  });
  const onExport = vi.fn();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} onExport={onExport} />);
  await screen.findByText("first");
  await userEvent.click(screen.getByRole("button", { name: "Table" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Export rows..." }));
  expect(onExport.mock.calls[0][0]).toMatchObject({ hasPrimaryKey: false, selected: [] });
});

test("item_10_an_empty_table_offers_the_first_row_and_ways_to_bring_rows_in", async () => {
  routeInvoke({ fetch_page: () => ({ ...page(false), rows: [] }) });
  const onImport = vi.fn();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} onImport={onImport} onTransfer={() => {}} production connectionName="freight-prod" />);
  await waitFor(() => expect(document.querySelector(".grid-empty")).not.toBeNull());
  const box = document.querySelector(".grid-empty") as HTMLElement;
  expect(within(box).getByRole("heading", { name: "orders has no rows yet" })).toBeTruthy();
  expect(box.textContent).toContain("Saving on freight-prod shows the SQL and asks you to confirm.");
  await userEvent.click(within(box).getByRole("button", { name: /Import a file/ }));
  expect(onImport).toHaveBeenCalledTimes(1);
  await userEvent.click(within(box).getByRole("button", { name: /Add row/ }));
  // The new row waits as a Pending Edit, and the empty state goes.
  expect(await screen.findByRole("region", { name: "Pending Edits" })).toBeTruthy();
  expect(document.querySelector(".grid-empty")).toBeNull();
});

test("a_header_shows_the_name_over_its_type_and_names_both", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  const th = screen.getByRole("columnheader", { name: "note, varchar(80)" });
  const lines = th.querySelector(".header-text")!;
  expect([...lines.children].map((c) => [c.className, c.textContent])).toEqual([
    ["header-name", "note"],
    ["type-hint", "varchar(80)"],
  ]);
});

test("the grid publishes sort, filter text and row filter columns, never a cell value", async () => {
  const kestrel: Page = {
    columns: [
      { name: "id", typeName: "int unsigned", isPrimaryKey: true },
      { name: "note", typeName: "varchar(80)", isPrimaryKey: false },
    ],
    rows: [
      [
        { t: "number", value: "1" },
        { t: "text", value: "Kestrel Foods Ltd", truncated: false, totalBytes: 17 },
      ],
    ],
    hasMore: false,
  };
  routeInvoke({ fetch_page: () => kestrel });
  let entry: ReturnType<typeof useTabAsk> = null;
  function Reader() {
    entry = useTabAsk("object:orders");
    return null;
  }
  render(
    <>
      <DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" askKey="object:orders" />
      <Reader />
    </>,
  );
  await screen.findByText("Kestrel Foods Ltd");
  await userEvent.click(screen.getByRole("button", { name: "Sort by note" }));
  await addFilter("note", "contains", "Kestrel");
  await waitFor(() => expect(entry?.get()?.filter).toContain("Kestrel"));
  const fields = entry!.get()!;
  expect(fields.tab).toEqual({
    kind: "object",
    title: "orders",
    path: table,
    object: "table",
    sort: { column: "note", descending: false },
    filterColumns: ["note"],
    hidden: [],
    pendingEdits: 0,
  });
  expect(fields.tables).toEqual([{ schema: null, name: "orders" }]);
  // The filter text is the WHERE the Core masks; nothing else holds the value, and no row is published.
  const { filter, ...rest } = fields;
  expect(filter).toBe("LOCATE('Kestrel', `note`) > 0");
  expect(JSON.stringify(rest)).not.toContain("Kestrel");
  expect(JSON.stringify(fields)).not.toContain("Kestrel Foods Ltd");
  expect(JSON.stringify(fields)).not.toContain("first");
});

test("a sort and a filter are Recent steps, by column only", async () => {
  clearAllSteps();
  routeInvoke({ fetch_page: () => page(false) });
  render(
    <RecordStepContext.Provider value="ungrouped">
      <DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" />
    </RecordStepContext.Provider>,
  );
  await screen.findByText("first");
  await userEvent.click(screen.getByRole("button", { name: "Sort by id" }));
  await userEvent.click(screen.getByRole("button", { name: "Sort by id" }));
  // The newer sort of the same table replaces the older one.
  expect(stepsOf("ungrouped")).toMatchObject([
    { verb: "gridSort", tab: "object", connectionId: "c1", database: "shop", names: ["orders", "id"], descending: true },
  ]);
  await addFilter("id", "is more than", "5000");
  await waitFor(() => expect(stepsOf("ungrouped").map((s) => s.verb)).toEqual(["gridSort", "gridFilter"]));
  expect(stepsOf("ungrouped")[1].names).toEqual(["orders", "id"]);
  expect(JSON.stringify(stepsOf("ungrouped"))).not.toContain("5000");
  clearAllSteps();
});

test("G5: a dragged column width survives Reload", async () => {
  stubWidths(49);
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "80px", "80px"]));
  fireEvent.mouseDown(document.querySelectorAll(".col-resize")[0], { clientX: 100, button: 0 });
  fireEvent.mouseMove(window, { clientX: 200 });
  fireEvent.mouseUp(window);
  expect(colWidths()).toEqual(["48px", "180px", "80px"]);
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await new Promise((r) => setTimeout(r, 30));
  expect(colWidths()).toEqual(["48px", "180px", "80px"]);
});

/** jsdom has no layout: every cell's text takes `width` px, by the cell's text. */
function stubCellContent(widths: Record<string, number>) {
  const original = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      const w = widths[this.commonAncestorContainer.textContent ?? ""] ?? 0;
      return { width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0, toJSON() {} };
    },
  });
  onTestFinished(() => {
    if (original) Object.defineProperty(Range.prototype, "getBoundingClientRect", original);
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  });
}

async function openFitted(w: Record<string, number>) {
  stubWidths(49);
  stubCellContent(w);
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "80px", "80px"]));
}
const edge = (i: number) => document.querySelectorAll(".col-resize")[i];

test("G6: double-clicking a header edge fits the column to its widest visible cell", async () => {
  await openFitted({ first: 150 });
  fireEvent.doubleClick(edge(1));
  // The cell's own padding and border come on top of its 150 px of text.
  const [, other, fitted] = colWidths().map((w) => parseInt(w));
  expect(other).toBe(80);
  expect(fitted).toBeGreaterThanOrEqual(150);
  expect(fitted).toBeLessThan(170);
});

test("G6: a fit never goes under the header, and never past the cap", async () => {
  await openFitted({ "1": 10, first: 5000 });
  fireEvent.doubleClick(edge(0));
  // The header is 50 px of label and 16 px of padding.
  expect(colWidths()).toEqual(["48px", "66px", "80px"]);
  fireEvent.doubleClick(edge(1));
  expect(colWidths()).toEqual(["48px", "66px", "500px"]);
});

test("G6: dragged and fitted widths stay through a new page and a sort", async () => {
  stubWidths(49);
  routeInvoke({ fetch_page: () => page(true) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "80px", "80px"]));
  fireEvent.mouseDown(edge(0), { clientX: 100, button: 0 });
  fireEvent.mouseMove(window, { clientX: 200 });
  fireEvent.mouseUp(window);
  expect(colWidths()).toEqual(["48px", "180px", "80px"]);
  await waitFor(() => expect(nextButton().disabled).toBe(false));
  await userEvent.click(nextButton());
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await new Promise((r) => setTimeout(r, 30));
  expect(colWidths()).toEqual(["48px", "180px", "80px"]);
  await userEvent.click(screen.getByRole("button", { name: "Sort by note" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(3));
  await new Promise((r) => setTimeout(r, 30));
  expect(colWidths()).toEqual(["48px", "180px", "80px"]);
});

test("G15: sorting and filtering tell the tab it was worked in", async () => {
  stubWidths(49);
  routeInvoke({ fetch_page: () => page(false) });
  const worked = vi.fn();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} onWorked={worked} />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "80px", "80px"]));
  expect(worked).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Sort by note" }));
  expect(worked).toHaveBeenCalledTimes(1);
  await addFilter("note", "contains", "first");
  expect(worked.mock.calls.length).toBeGreaterThan(1);
});

test("G15: a column drag or fit tells the tab", async () => {
  stubWidths(49);
  routeInvoke({ fetch_page: () => page(false) });
  const worked = vi.fn();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} onWorked={worked} />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "80px", "80px"]));
  fireEvent.mouseDown(edge(0), { clientX: 100, button: 0 });
  expect(worked).not.toHaveBeenCalled();
  fireEvent.mouseMove(window, { clientX: 150 });
  fireEvent.mouseMove(window, { clientX: 200 });
  expect(worked).not.toHaveBeenCalled();
  fireEvent.mouseUp(window);
  expect(worked).toHaveBeenCalledTimes(1);
  fireEvent.doubleClick(edge(1));
  expect(worked).toHaveBeenCalledTimes(2);
});

test("G5: confirming a filter unchanged does not start the next Reload over at the top", async () => {
  stubViewport();
  routeInvoke({ fetch_page: () => bigPage() });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" />);
  await screen.findByText("note 1");
  await addFilter("note", "contains", "note");
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  scrollGrid(28 * 115);
  await screen.findByText("note 116");
  const cell = () => document.querySelector('tr[data-row="115"] td[data-col="1"]') as HTMLElement;
  fireEvent.mouseDown(cell());
  await userEvent.click(screen.getByRole("button", { name: /^Edit filter:/ }));
  await userEvent.click(screen.getByRole("button", { name: /^Keep filter/ }));
  expect(callsTo("fetch_page")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(3));
  await new Promise((r) => setTimeout(r, 30));
  expect((document.querySelector(".grid-scroll") as HTMLElement).scrollTop).toBe(28 * 115);
  expect(cell().className).toContain("cell-selected");
});

test("G6: dragged widths stay through a filter", async () => {
  stubWidths(49);
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" />);
  await screen.findByText("first");
  await waitFor(() => expect(colWidths()).toEqual(["48px", "80px", "80px"]));
  fireEvent.mouseDown(edge(0), { clientX: 100, button: 0 });
  fireEvent.mouseMove(window, { clientX: 200 });
  fireEvent.mouseUp(window);
  await addFilter("note", "contains", "first");
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await new Promise((r) => setTimeout(r, 30));
  expect(colWidths()).toEqual(["48px", "180px", "80px"]);
});

test("G15: hiding a column in the Columns menu tells the tab", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  const worked = vi.fn();
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} onWorked={worked} />);
  await screen.findByText("first");
  await userEvent.click(screen.getByRole("button", { name: "Table" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Columns" }));
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "note" }));
  expect(worked).toHaveBeenCalledTimes(1);
});

// Polish A4: the resize zone straddles the column edge (Excel, DataGrip): the 4 px left of it belong to the column
// before, the 4 px right of it (the next header's left side) resize that same column.
const lead = (i: number) => document.querySelectorAll(".col-resize-lead")[i];

test("polish A4: the right side of a column edge drags and fits the column on its left", async () => {
  await openFitted({ first: 150 });
  // Two data columns: only the second has a column on its left to resize.
  expect(document.querySelectorAll(".col-resize-lead")).toHaveLength(1);
  expect(lead(0).getAttribute("aria-hidden")).toBe("true");
  fireEvent.mouseDown(lead(0), { clientX: 200, button: 0 });
  fireEvent.mouseMove(window, { clientX: 260 });
  fireEvent.mouseUp(window);
  expect(colWidths()).toEqual(["48px", "140px", "80px"]);
  fireEvent.doubleClick(lead(0));
  const [, first] = colWidths().map((w) => parseInt(w));
  expect(first).toBe(66);
});

test("polish A4: the edge zones sit beside the sort button, so a header click still sorts and a drag does not", async () => {
  await openFitted({});
  expect(lead(0).closest(".header-button")).toBeNull();
  fireEvent.mouseDown(lead(0), { clientX: 200, button: 0 });
  fireEvent.mouseMove(window, { clientX: 230 });
  fireEvent.mouseUp(window);
  expect(callsTo("fetch_page")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Sort by id" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
});
