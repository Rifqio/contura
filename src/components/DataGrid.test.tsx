import { currentCompletions } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
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
import DataGrid from "./DataGrid";

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

const filterView = () => EditorView.findFromDOM(document.querySelector(".grid-filter .cm-editor") as HTMLElement)!;

test("filter_box_applies_on_enter_and_clears_on_escape", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" />);
  await screen.findByText("first");
  const v = filterView();
  act(() => v.dispatch({ changes: { from: 0, insert: "id > 5" }, selection: { anchor: 6 } }));
  fireEvent.keyDown(v.contentDOM, { key: "Enter" });
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  expect(callsTo("fetch_page")[1]).toMatchObject({ request: { page: 0, filter: "id > 5" } });
  fireEvent.keyDown(v.contentDOM, { key: "Escape" });
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(3));
  expect(callsTo("fetch_page")[2]).toMatchObject({ request: { filter: null } });
  expect(v.state.doc.toString()).toBe("");
});

test("a_filter_error_offers_clear_filter", async () => {
  routeInvoke({
    fetch_page: ({ request }) => {
      if ((request as { filter: string | null }).filter) throw { kind: "query", message: "Unknown column 'nope'" };
      return page(false);
    },
  });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} dialect="mysql" />);
  await screen.findByText("first");
  const v = filterView();
  act(() => v.dispatch({ changes: { from: 0, insert: "nope = 1" } }));
  fireEvent.keyDown(v.contentDOM, { key: "Enter" });
  await userEvent.click(await screen.findByRole("button", { name: "Clear filter" }));
  expect(await screen.findByText("first")).toBeTruthy();
});

test("filter_completes_the_table_columns", async () => {
  routeInvoke({ fetch_page: () => page(false), sql_schema: () => KFC_SCHEMA });
  const client = new LangClient(() => fakeWorker());
  const lang = { client, schemas: new SchemaCache(client) };
  const orders = { database: "kfc", schema: "sales", name: "orders" };
  render(<DataGrid connectionId="c1" table={orders} onClose={() => {}} dialect="postgres" lang={lang} />);
  await waitFor(() => expect(lang.schemas.state("c1", "kfc")).toBe("loaded"));
  const v = filterView();
  act(() => {
    v.dispatch({ changes: { from: 0, insert: "sta" }, selection: { anchor: 3 }, userEvent: "input.type" });
  });
  await waitFor(() => expect(currentCompletions(v.state).map((c) => c.label)).toContain("status"));
  expect(currentCompletions(v.state).map((c) => c.label)).not.toContain("code");
});

test("next disabled when hasMore false", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  expect(nextButton().disabled).toBe(true);
});

test("sort toggles asc then desc", async () => {
  routeInvoke({ fetch_page: () => page(false) });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("first");
  const sortById = screen.getByRole("button", { name: "Sort by id" });
  await userEvent.click(sortById);
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(2));
  await userEvent.click(screen.getByRole("button", { name: "Sort by id" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(3));
  await userEvent.click(screen.getByRole("button", { name: "Sort by note" }));
  await waitFor(() => expect(callsTo("fetch_page")).toHaveLength(4));
  const sorts = callsTo("fetch_page").map((a) => (a.request as { sort: unknown }).sort);
  expect(sorts).toEqual([
    null,
    { column: "id", descending: false },
    { column: "id", descending: true },
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
  scrollGrid(ROWS * 40 - VIEW_HEIGHT);
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
  scrollGrid(ROWS * 40 - VIEW_HEIGHT);
  await screen.findByText("note 1000");
  await userEvent.click(nextButton());
  await screen.findByText("Rows 1,001 to 2,000");
  const top = (await screen.findByText("note 1")).closest("tr") as HTMLElement;
  expect(top.querySelector(".row-number")?.textContent).toBe("1,001");
  expect((document.querySelector(".grid-scroll") as HTMLElement).scrollTop).toBe(0);
});

test("a row rendered after scrolling opens its own full value", async () => {
  stubViewport();
  routeInvoke({
    fetch_page: () => bigPage(),
    fetch_full_value: () => ({ t: "text", value: "the whole note" }),
  });
  render(<DataGrid connectionId="c1" table={table} onClose={() => {}} />);
  await screen.findByText("note 1");
  scrollGrid(ROWS * 40 - VIEW_HEIGHT);
  const last = (await screen.findByText("note 1000")).closest("tr") as HTMLElement;
  await userEvent.click(within(last).getByRole("button", { name: "Open full value" }));
  await screen.findByText("the whole note");
  expect(callsTo("fetch_full_value")[0]).toEqual({
    id: "c1",
    request: { table, column: "note", key: [{ column: "id", value: { t: "number", value: "1000" } }] },
  });
});
