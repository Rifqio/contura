import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, SchemaModel } from "../../../api/types";
import { callsTo, routeInvoke } from "../../../test/invoke";
import type { DatabaseAdd } from "../../FlowTab";
import FromDatabaseDialog, { type FromDatabaseTarget } from "./FromDatabaseDialog";
import { addedDatabaseText, type ErFromModel } from "./fromDatabase";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const kfc: ConnectionConfig = {
  id: "c1", name: "kfc", dialect: "mysql", host: "127.0.0.1", port: 3306, user: "u", database: null, ssl: { mode: "disable" },
  groupId: null, file: null, queryTimeoutSecs: null, aiAccess: "schema", production: false, readOnly: false,
};
const pg: ConnectionConfig = { ...kfc, id: "c2", name: "ledger", dialect: "postgres" };
const closed: ConnectionConfig = { ...kfc, id: "c3", name: "idle" };

const snapshot = (dialect: "mysql" | "postgres"): SchemaModel => ({
  dialect,
  tables: [{ schema: dialect === "postgres" ? "billing" : null, name: "orders", alias: null, note: null, indexes: [],
    columns: [{ name: "id", typeName: "int", pk: true, increment: false, notNull: false, unique: false, default: null, note: null }] }],
  refs: [], enums: [], skipped: [],
});

function routes(extra: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  routeInvoke({
    list_databases: () => ["shop", "mysql"],
    list_schemas: () => [{ name: "public", isSystem: false }, { name: "billing", isSystem: false }],
    list_objects: () => [{ kind: "table" }],
    schema_snapshot: (a) => snapshot(a.schema === null ? "mysql" : "postgres"),
    list_diagrams: () => [{ name: "shop", kind: "er" }],
    write_diagram: () => undefined,
    ...extra,
  });
}

function setup(target: FromDatabaseTarget, connections = [kfc, pg, closed], onClose = vi.fn()) {
  render(<FromDatabaseDialog connections={connections} openIds={new Set(["c1", "c2"])} target={target} onClose={onClose} />);
  return onClose;
}
const frameTarget = (run: DatabaseAdd["run"] = async () => null): FromDatabaseTarget => ({ kind: "frame", add: { file: "board", run } });

async function choose(name: RegExp, field = "Connection") {
  await userEvent.click(screen.getByRole("combobox", { name: field }));
  await userEvent.click(screen.getByRole("option", { name }));
}

afterEach(() => vi.clearAllMocks());

test("reads_the_chosen_schema_into_a_frame", async () => {
  routes();
  const run = vi.fn(async (_f: ErFromModel) => null);
  const onClose = setup(frameTarget(run));
  expect(screen.getByText("Reads one schema's tables into an ERD frame. Nothing in the database changes.")).toBeTruthy();
  await choose(/ledger/);
  await screen.findByRole("combobox", { name: "Schema" });
  await choose(/billing/, "Schema");
  await screen.findByText("1 table");
  await userEvent.click(screen.getByRole("button", { name: /Read the database/ }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(callsTo("schema_snapshot")).toEqual([{ id: "c2", database: "shop", schema: "billing" }]);
  const frame = run.mock.calls[0][0];
  expect(frame).toMatchObject({ title: "billing", tables: 1 });
  expect(frame.text).toContain("orders {");
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test("mysql_reads_with_a_null_schema", async () => {
  routes();
  setup(frameTarget());
  await choose(/kfc/);
  await screen.findByText("1 table");
  expect(screen.queryByRole("combobox", { name: "Schema" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Read the database/ }));
  await waitFor(() => expect(callsTo("schema_snapshot")).toEqual([{ id: "c1", database: "shop", schema: null }]));
});

test("only_open_connections_can_be_read", async () => {
  routes();
  setup(frameTarget());
  await userEvent.click(screen.getByRole("combobox", { name: "Connection" }));
  expect(screen.getByRole("option", { name: /idle/ }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("option", { name: /kfc/ }).getAttribute("aria-disabled")).not.toBe("true");
});

test("a_refusal_shows_in_the_dialog", async () => {
  routes();
  const onClose = setup(frameTarget(async () => "The board is full."));
  await choose(/kfc/);
  await screen.findByText("1 table");
  await userEvent.click(screen.getByRole("button", { name: /Read the database/ }));
  expect((await screen.findByRole("alert")).textContent).toBe("The board is full.");
  expect(onClose).not.toHaveBeenCalled();
});

test("a_read_that_fails_shows_in_the_dialog", async () => {
  routes({ schema_snapshot: () => { throw { kind: "other", message: "no route to host" }; } });
  setup(frameTarget());
  await choose(/kfc/);
  await screen.findByText("1 table");
  await userEvent.click(screen.getByRole("button", { name: /Read the database/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("no route to host");
});

test("left_out_relationships_are_counted_in_the_toast", () => {
  expect(addedDatabaseText({ title: "shop", tables: 1, leftOut: 0 })).toBe("Added shop: 1 table.");
  // Missing columns are left out too, so the copy names no cause (final review, Minor 3).
  expect(addedDatabaseText({ title: "shop", tables: 3, leftOut: 1 })).toBe("Added shop: 3 tables. 1 relationship could not be drawn and was left out.");
  expect(addedDatabaseText({ title: "shop", tables: 3, leftOut: 2 })).toBe("Added shop: 3 tables. 2 relationships could not be drawn and were left out.");
  expect(addedDatabaseText({ title: "shop", tables: 1234, leftOut: 1234 })).toBe(
    "Added shop: 1,234 tables. 1,234 relationships could not be drawn and were left out.",
  );
});

test("file_mode_writes_a_new_diagram_named_after_the_database", async () => {
  routes();
  const onCreated = vi.fn();
  setup({ kind: "file", onCreated });
  await choose(/kfc/);
  await screen.findByText("1 table");
  await userEvent.click(screen.getByRole("button", { name: /Read the database/ }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("shop 2"));
  const [w] = callsTo("write_diagram");
  expect(w).toMatchObject({ name: "shop 2", overwrite: false });
  expect(String(w.text)).toContain("orders {");
});

test("escape_closes_only_the_dialog", async () => {
  routes();
  const run = vi.fn(async () => null);
  const onClose = setup(frameTarget(run));
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
});

test("the_table_count_has_grouping_commas", async () => {
  routes({ list_objects: () => Array.from({ length: 1234 }, () => ({ kind: "table" })) });
  setup(frameTarget());
  await choose(/kfc/);
  await screen.findByText("1,234 tables");
});

test("a_failed_schema_list_shows_and_changing_the_connection_clears_it", async () => {
  let fail = true;
  routes({ list_schemas: () => { if (fail) throw { kind: "other", message: "schemas unreadable" }; return [{ name: "public", isSystem: false }]; } });
  setup(frameTarget());
  await choose(/ledger/);
  expect((await screen.findByRole("alert")).textContent).toContain("schemas unreadable");
  fail = false;
  await choose(/kfc/);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("escape_and_cancel_close_without_a_discard_prompt", async () => {
  routes();
  const onClose = setup(frameTarget());
  await choose(/kfc/);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/discard/i)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Cancel/ }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

// ----- B2 final review: one read per press (Important 1)

test("read_pressed_twice_in_one_go_reads_and_adds_once", async () => {
  routes();
  const run = vi.fn(async (_f: ErFromModel) => null);
  setup(frameTarget(run));
  await choose(/kfc/);
  await screen.findByText("1 table");
  const button = screen.getByRole("button", { name: /Read the database/ });
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  await waitFor(() => expect(run).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50));
  expect(callsTo("schema_snapshot")).toHaveLength(1);
  expect(run).toHaveBeenCalledTimes(1);
});

// ----- B2 final review: Cancel cancels (Important 2)

/** The dialog as App shows it: `onClose` unmounts it. */
function Hosted({ target }: { target: FromDatabaseTarget }) {
  const [open, setOpen] = useState(true);
  return open ? <FromDatabaseDialog connections={[kfc, pg, closed]} openIds={new Set(["c1", "c2"])} target={target} onClose={() => setOpen(false)} /> : null;
}

/** A schema read that waits until `release` is called. */
function slowSnapshot() {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  routes({
    schema_snapshot: async (a) => {
      await gate;
      return snapshot(a.schema === null ? "mysql" : "postgres");
    },
  });
  return () => release();
}

for (const how of ["Cancel", "Escape"] as const) {
  test(`${how.toLowerCase()}_while_reading_adds_no_frame`, async () => {
    const release = slowSnapshot();
    const run = vi.fn(async (_f: ErFromModel) => null);
    render(<Hosted target={frameTarget(run)} />);
    await choose(/kfc/);
    await screen.findByText("1 table");
    await userEvent.click(screen.getByRole("button", { name: /Read the database/ }));
    await screen.findByText("Reading...");
    if (how === "Cancel") await userEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    else await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "From my database" })).toBeNull();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(run).not.toHaveBeenCalled();
  });

  test(`${how.toLowerCase()}_while_reading_writes_no_file`, async () => {
    const release = slowSnapshot();
    const onCreated = vi.fn();
    render(<Hosted target={{ kind: "file", onCreated }} />);
    await choose(/kfc/);
    await screen.findByText("1 table");
    await userEvent.click(screen.getByRole("button", { name: /Read the database/ }));
    await screen.findByText("Reading...");
    if (how === "Cancel") await userEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    else await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "From my database" })).toBeNull();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(callsTo("write_diagram")).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled();
  });
}

// ----- B2 final review: Minors 8 and 9

test("a_new_file_says_so_in_the_subtitle", () => {
  routes();
  setup({ kind: "file", onCreated: vi.fn() });
  expect(screen.getByText("Reads one schema's tables into a new diagram. Nothing in the database changes.")).toBeTruthy();
  expect(screen.queryByText(/into an ERD frame/)).toBeNull();
});

test("a_name_taken_since_the_list_was_read_takes_the_next_free_one_once", async () => {
  routes({
    write_diagram: (a) => {
      if (a.name === "shop 2") throw { kind: "diagramExists", message: { name: "shop 2" } };
      return undefined;
    },
  });
  const onCreated = vi.fn();
  setup({ kind: "file", onCreated });
  await choose(/kfc/);
  await screen.findByText("1 table");
  await userEvent.click(screen.getByRole("button", { name: /Read the database/ }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith("shop 3"));
  expect(callsTo("write_diagram").map((w) => w.name)).toEqual(["shop 2", "shop 3"]);
  expect(screen.queryByRole("alert")).toBeNull();
});
