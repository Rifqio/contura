import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import App from "../App";
import { callsTo, routeInvoke } from "../test/invoke";
import type { ConnectionConfig, ObjectKind, ObjectPath } from "../api/types";
import ObjectTree from "./ObjectTree";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const objects = [
  { kind: "table", name: "orders" },
  { kind: "table", name: "stores" },
  { kind: "view", name: "v_daily_sales" },
  { kind: "procedure", name: "close_day" },
  { kind: "trigger", name: "orders_audit" },
];

test("expanding a database lists its objects grouped by kind", async () => {
  routeInvoke({ list_databases: () => ["shop"], list_objects: () => objects });
  const onSelect = vi.fn();
  render(
    <ObjectTree connectionId="c1" dialect="mysql" defaultDatabase={null} selected={null} onSelect={onSelect} onNotOpen={() => {}} />,
  );
  const shop = await screen.findByRole("button", { name: "shop" });
  expect(callsTo("list_objects")).toHaveLength(0);
  await userEvent.click(shop);
  expect(shop.getAttribute("aria-expanded")).toBe("true");
  expect(callsTo("list_objects")).toEqual([{ id: "c1", database: "shop", schema: null }]);
  const tables = await screen.findByRole("list", { name: "Tables in shop" });
  expect(
    within(tables)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["orders", "stores"]);
  expect(within(screen.getByRole("list", { name: "Views in shop" })).getByText("v_daily_sales")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Procedures in shop" })).getByText("close_day")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Triggers in shop" })).getByText("orders_audit")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Functions in shop" })).toBeNull();
  await userEvent.click(within(tables).getByRole("button", { name: "orders" }));
  expect(onSelect).toHaveBeenCalledWith("table", { database: "shop", schema: null, name: "orders" });
});

test("reveal_expands_to_the_object_and_focuses_it", async () => {
  routeInvoke({
    list_databases: () => ["kfc", "other"],
    list_schemas: () => [
      { name: "public", isSystem: false },
      { name: "sales", isSystem: false },
    ],
    list_objects: () => objects,
  });
  const props = { connectionId: "c1", dialect: "postgres" as const, defaultDatabase: null, selected: null, onSelect: () => {}, onNotOpen: () => {} };
  const { rerender } = render(<ObjectTree {...props} reveal={null} />);
  await screen.findByRole("button", { name: "kfc" });
  const onRevealed = vi.fn();
  rerender(<ObjectTree {...props} reveal={{ database: "kfc", schema: "sales", name: "orders", seq: 1 }} onRevealed={onRevealed} />);
  const tables = await screen.findByRole("list", { name: "Tables in kfc.sales" });
  const row = within(tables).getByRole("button", { name: "orders" });
  await waitFor(() => expect(document.activeElement).toBe(row));
  // The owner clears the request, so a later remount does not move focus again.
  expect(onRevealed).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "sales" }).getAttribute("aria-expanded")).toBe("true");
});

test("refresh_reloads_the_tree_and_tells_the_owner", async () => {
  routeInvoke({ list_databases: () => ["shop"], list_objects: () => objects });
  const onRefresh = vi.fn();
  render(
    <ObjectTree connectionId="c1" dialect="mysql" defaultDatabase="shop" selected={null} onSelect={() => {}} onNotOpen={() => {}} onRefresh={onRefresh} />,
  );
  await screen.findByRole("list", { name: "Tables in shop" });
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(callsTo("list_databases")).toHaveLength(2));
  expect(callsTo("list_objects").length).toBeGreaterThanOrEqual(2);
});

test("selecting a routine or trigger shows its definition", async () => {
  routeInvoke({
    list_groups: () => [{ id: "g1", name: "KFC", color: "red" }],
    list_connections: () => [
      {
        id: "c1",
        name: "kfc-prod",
        dialect: "mysql",
        host: "127.0.0.1",
        port: 3306,
        user: "root",
        database: null,
        ssl: { mode: "disable" },
        file: null,
        groupId: "g1",
      },
    ],
    last_group: () => "g1",
    open_connection: () => null,
    list_databases: () => ["shop"],
    list_objects: () => objects,
    object_definition: (a) =>
      a.kind === "trigger" ? "CREATE TRIGGER orders_audit AFTER INSERT" : "CREATE PROCEDURE close_day() BEGIN END",
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Open kfc-prod" }));
  await userEvent.click(await screen.findByRole("button", { name: "shop" }));
  await userEvent.click(await screen.findByRole("button", { name: "close_day" }));
  expect(await screen.findByText("CREATE PROCEDURE close_day() BEGIN END")).toBeTruthy();
  expect(callsTo("object_definition")).toEqual([
    { id: "c1", kind: "procedure", path: { database: "shop", schema: null, name: "close_day" } },
  ]);
  await userEvent.click(screen.getByRole("button", { name: "orders_audit" }));
  expect(await screen.findByText("CREATE TRIGGER orders_audit AFTER INSERT")).toBeTruthy();
  expect(callsTo("fetch_page")).toHaveLength(0);
});

test("a connection not open error calls onNotOpen and says to open it again", async () => {
  routeInvoke({
    list_databases: () => {
      throw { kind: "notFound", message: "connection not open" };
    },
  });
  const onNotOpen = vi.fn();
  render(
    <ObjectTree connectionId="c1" dialect="mysql" defaultDatabase={null} selected={null} onSelect={() => {}} onNotOpen={onNotOpen} />,
  );
  expect(await screen.findByText("This Connection is not open. Open it again to continue.")).toBeTruthy();
  await waitFor(() => expect(onNotOpen).toHaveBeenCalledTimes(1));
});

// ---------- PostgreSQL: the schema level ----------

const pgSchemas = [
  { name: "information_schema", isSystem: true },
  { name: "pg_catalog", isSystem: true },
  { name: "public", isSystem: false },
  { name: "sales", isSystem: false },
];

const pgObjects: Record<string, { kind: ObjectKind; name: string }[]> = {
  public: [
    { kind: "table", name: "orders" },
    { kind: "table", name: "stores" },
  ],
  sales: [
    { kind: "table", name: "orders" },
    { kind: "function", name: "add(a numeric, b numeric)" },
  ],
};

function routePostgres(extra: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({
    list_databases: () => ["postgres", "shop"],
    list_schemas: () => pgSchemas,
    list_objects: (a) => pgObjects[a.schema as string] ?? [],
    ...extra,
  });
}

function renderPg(
  props: {
    defaultDatabase?: string | null;
    selected?: { path: ObjectPath; kind: ObjectKind } | null;
    onSelect?: (kind: ObjectKind, path: ObjectPath) => void;
  } = {},
) {
  render(
    <ObjectTree
      connectionId="c1"
      dialect="postgres"
      defaultDatabase={props.defaultDatabase ?? null}
      selected={props.selected ?? null}
      onSelect={props.onSelect ?? (() => {})}
      onNotOpen={() => {}}
    />,
  );
}

const names = (list: HTMLElement) =>
  within(list)
    .getAllByRole("button")
    .map((b) => b.textContent);

test("postgres_database_expands_to_user_schemas", async () => {
  routePostgres();
  renderPg();
  await userEvent.click(await screen.findByRole("button", { name: "shop" }));
  const schemas = await screen.findByRole("list", { name: "Schemas in shop" });
  expect(names(schemas)).toEqual(["public", "sales"]);
  expect(screen.queryByRole("button", { name: "pg_catalog" })).toBeNull();
  expect(callsTo("list_schemas")).toEqual([{ id: "c1", database: "shop" }]);
  expect(callsTo("list_objects")).toHaveLength(0);
});

test("show_system_schemas_reveals_them", async () => {
  routePostgres();
  renderPg();
  await userEvent.click(await screen.findByRole("button", { name: "shop" }));
  await screen.findByRole("list", { name: "Schemas in shop" });
  const toggle = screen.getByRole("checkbox", { name: "Show system schemas" }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  await userEvent.click(toggle);
  expect(names(screen.getByRole("list", { name: "Schemas in shop" }))).toEqual([
    "information_schema",
    "pg_catalog",
    "public",
    "sales",
  ]);
  // Showing them needs no reload.
  expect(callsTo("list_schemas")).toHaveLength(1);
});

test("database_without_user_schemas_says_so", async () => {
  routePostgres({ list_schemas: () => pgSchemas.filter((s) => s.isSystem) });
  renderPg();
  await userEvent.click(await screen.findByRole("button", { name: "shop" }));
  expect(
    await screen.findByText("No schemas you can use in shop. Show system schemas to see the rest."),
  ).toBeTruthy();
});

test("postgres_schema_lists_objects_with_schema", async () => {
  routePostgres();
  const onSelect = vi.fn();
  renderPg({ onSelect });
  await userEvent.click(await screen.findByRole("button", { name: "shop" }));
  const sales = await screen.findByRole("button", { name: "sales" });
  await userEvent.click(sales);
  expect(sales.getAttribute("aria-expanded")).toBe("true");
  expect(callsTo("list_objects")).toEqual([{ id: "c1", database: "shop", schema: "sales" }]);
  const tables = await screen.findByRole("list", { name: "Tables in shop.sales" });
  await userEvent.click(within(tables).getByRole("button", { name: "orders" }));
  expect(onSelect).toHaveBeenCalledWith("table", { database: "shop", schema: "sales", name: "orders" });
});

test("tables_with_one_name_in_two_schemas_are_distinct", async () => {
  routePostgres();
  renderPg({
    defaultDatabase: "shop",
    selected: { kind: "table", path: { database: "shop", schema: "sales", name: "orders" } },
  });
  await userEvent.click(await screen.findByRole("button", { name: "sales" }));
  const inSales = within(await screen.findByRole("list", { name: "Tables in shop.sales" })).getByRole("button", {
    name: "orders",
  });
  const inPublic = within(screen.getByRole("list", { name: "Tables in shop.public" })).getByRole("button", {
    name: "orders",
  });
  expect(inSales.getAttribute("aria-current")).toBe("true");
  expect(inPublic.getAttribute("aria-current")).toBeNull();
});

test("default_postgres_database_opens_public", async () => {
  routePostgres();
  renderPg({ defaultDatabase: "shop" });
  expect(await screen.findByRole("list", { name: "Tables in shop.public" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "shop" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "public" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "sales" }).getAttribute("aria-expanded")).toBe("false");
  expect(callsTo("list_objects")).toEqual([{ id: "c1", database: "shop", schema: "public" }]);
});

test("schema_load_error_offers_try_again", async () => {
  let fail = true;
  routePostgres({
    list_schemas: () => {
      if (fail) throw { kind: "auth", message: 'no pg_hba.conf entry for host "127.0.0.1"' };
      return pgSchemas;
    },
  });
  renderPg();
  await userEvent.click(await screen.findByRole("button", { name: "shop" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("or the server's access rules for this database.");
  fail = false;
  await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(names(await screen.findByRole("list", { name: "Schemas in shop" }))).toEqual(["public", "sales"]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("schema_objects_load_error_offers_try_again", async () => {
  let fail = true;
  routePostgres({
    list_objects: (a) => {
      if (fail) throw { kind: "query", message: "permission denied for schema sales" };
      return pgObjects[a.schema as string] ?? [];
    },
  });
  renderPg();
  await userEvent.click(await screen.findByRole("button", { name: "shop" }));
  await userEvent.click(await screen.findByRole("button", { name: "sales" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("permission denied for schema sales");
  fail = false;
  await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("list", { name: "Tables in shop.sales" })).toBeTruthy();
});

test("postgres_empty_schema_says_no_objects", async () => {
  routePostgres({ list_schemas: () => [{ name: "audit", isSystem: false }] });
  renderPg();
  await userEvent.click(await screen.findByRole("button", { name: "shop" }));
  await userEvent.click(await screen.findByRole("button", { name: "audit" }));
  expect(await screen.findByText("audit has no tables, views or routines.")).toBeTruthy();
});

test("system_schema_toggle_only_for_postgres", async () => {
  routeInvoke({ list_databases: () => ["shop"], list_objects: () => objects });
  render(
    <ObjectTree
      connectionId="c1"
      dialect="mysql"
      defaultDatabase={null}
      selected={null}
      onSelect={() => {}}
      onNotOpen={() => {}}
    />,
  );
  await screen.findByRole("button", { name: "shop" });
  expect(screen.queryByRole("checkbox", { name: "Show system schemas" })).toBeNull();
  cleanup();

  routePostgres();
  renderPg();
  await screen.findByRole("button", { name: "shop" });
  expect(screen.getByRole("checkbox", { name: "Show system schemas" })).toBeTruthy();
});

test("object_rows_have_full_name_title", async () => {
  routePostgres();
  renderPg();
  await userEvent.click(await screen.findByRole("button", { name: "shop" }));
  await userEvent.click(await screen.findByRole("button", { name: "sales" }));
  const fns = await screen.findByRole("list", { name: "Functions in shop.sales" });
  const row = within(fns).getByRole("button", { name: "add(a numeric, b numeric)" });
  expect(row.getAttribute("title")).toBe("add(a numeric, b numeric)");
});

// ---------- App wiring: Dialect, SQLite's main, distinct titles ----------

function appConnection(over: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: "c1",
    name: "kfc-orders",
    dialect: "postgres",
    host: "10.0.4.20",
    port: 5432,
    user: "kfc_app",
    database: "shop",
    ssl: { mode: "disable" },
    file: null,
    groupId: null,
    queryTimeoutSecs: null,
    aiAccess: "schema",
    ...over,
  };
}

const onePage = {
  columns: [{ name: "id", typeName: "int4", isPrimaryKey: true }],
  rows: [[{ t: "number", value: "7" }]],
  hasMore: false,
};

test("app_titles_postgres_objects_with_their_schema", async () => {
  routePostgres({
    list_groups: () => [],
    list_connections: () => [appConnection({})],
    last_group: () => null,
    suggested_connections: () => [],
    set_last_group: () => null,
    open_connection: () => null,
    fetch_page: () => onePage,
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Open" }));
  const tables = await screen.findByRole("list", { name: "Tables in shop.public" });
  await userEvent.click(within(tables).getByRole("button", { name: "orders" }));
  const grid = await screen.findByRole("region", { name: "Data of orders" });
  expect(within(grid).getByRole("heading", { level: 2 }).textContent).toBe("shop.public.orders");

  // The same name in another schema is another object: a fresh grid with its own request.
  await userEvent.click(screen.getByRole("button", { name: "sales" }));
  const sales = await screen.findByRole("list", { name: "Tables in shop.sales" });
  await userEvent.click(within(sales).getByRole("button", { name: "orders" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Data of orders" })).getByRole("heading", { level: 2 }).textContent,
    ).toBe("shop.sales.orders"),
  );
  await waitFor(() =>
    expect(callsTo("fetch_page").map((a) => (a.request as { table: ObjectPath }).table.schema)).toEqual([
      "public",
      "sales",
    ]),
  );
});

test("app_opens_sqlite_main_at_once", async () => {
  routeInvoke({
    list_groups: () => [],
    list_connections: () => [
      appConnection({ dialect: "sqlite", host: "", port: 0, user: "", database: null, file: "C:\\data\\shop.db" }),
    ],
    last_group: () => null,
    suggested_connections: () => [],
    set_last_group: () => null,
    open_connection: () => null,
    list_databases: () => ["main"],
    list_objects: () => [{ kind: "table", name: "orders" }],
  });
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Open" }));
  expect(await screen.findByRole("list", { name: "Tables in main" })).toBeTruthy();
  expect(callsTo("list_objects")).toEqual([{ id: "c1", database: "main", schema: null }]);
  expect(callsTo("list_schemas")).toHaveLength(0);
  expect(screen.queryByRole("checkbox", { name: "Show system schemas" })).toBeNull();
});
