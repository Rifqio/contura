import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import ConnectionForm from "./ConnectionForm";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const existing: ConnectionConfig = {
  id: "c1",
  name: "Local MySQL",
  dialect: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  database: null,
  ssl: { mode: "disable" },
  groupId: "g1",
  file: null,
  queryTimeoutSecs: null,
};
const groups = [{ id: "g1", name: "KFC", color: "red" as const }];

const SQLITE_FILTER = { name: "SQLite database", extensions: ["sqlite", "sqlite3", "db", "db3"] };

function renderNew() {
  const onSaved = vi.fn();
  render(<ConnectionForm groups={groups} defaultGroupId={null} onSaved={onSaved} onCancel={() => {}} />);
  return onSaved;
}

function renderEditing(connection: ConnectionConfig) {
  render(
    <ConnectionForm connection={connection} groups={groups} defaultGroupId={null} onSaved={() => {}} onCancel={() => {}} />,
  );
}

const dialectSelect = () => screen.getByLabelText("Dialect") as HTMLSelectElement;
const portInput = () => screen.getByLabelText("Port") as HTMLInputElement;
const userInput = () => screen.getByLabelText("User") as HTMLInputElement;
const fileInput = () => screen.getByLabelText("File") as HTMLInputElement;

test("editing without touching password sends keep", async () => {
  routeInvoke({ save_connection: (a) => ({ ...existing, name: (a.input as { name: string }).name }) });
  const onSaved = vi.fn();
  render(
    <ConnectionForm
      connection={existing}
      groups={groups}
      defaultGroupId={null}
      onSaved={onSaved}
      onCancel={() => {}}
    />,
  );
  const name = screen.getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "Laragon");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const input = callsTo("save_connection")[0].input as Record<string, unknown>;
  expect(input.id).toBe("c1");
  expect(input.name).toBe("Laragon");
  expect(input.password).toEqual({ t: "keep" });
  expect(input.groupId).toBe("g1");
  expect(input.dialect).toBe("mysql");
  expect(input.file).toBeNull();
});

test("test shows server version", async () => {
  routeInvoke({ test_connection: () => "8.0.30" });
  renderNew();
  await userEvent.type(screen.getByLabelText("Name"), "Laragon");
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText("Connected. The server runs MySQL 8.0.30.")).toBeTruthy();
});

test("test shows error message", async () => {
  routeInvoke({
    test_connection: () => {
      throw { kind: "auth", message: "Access denied for user 'root'@'localhost'" };
    },
  });
  renderNew();
  await userEvent.type(screen.getByLabelText("Name"), "Laragon");
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText(/Access denied for user 'root'@'localhost'/)).toBeTruthy();
});

test("choosing_postgresql_sets_its_defaults", async () => {
  renderNew();
  expect(dialectSelect().value).toBe("mysql");
  expect(portInput().value).toBe("3306");
  expect(userInput().value).toBe("root");
  await userEvent.selectOptions(dialectSelect(), "postgres");
  expect(portInput().value).toBe("5432");
  expect(userInput().value).toBe("postgres");
  await userEvent.selectOptions(dialectSelect(), "mysql");
  expect(portInput().value).toBe("3306");
  expect(userInput().value).toBe("root");
});

test("typed_port_survives_dialect_switch", async () => {
  renderNew();
  await userEvent.clear(portInput());
  await userEvent.type(portInput(), "3310");
  await userEvent.selectOptions(dialectSelect(), "postgres");
  expect(portInput().value).toBe("3310");
  expect(userInput().value).toBe("postgres");
});

test("postgres port error names postgresql", async () => {
  renderNew();
  await userEvent.selectOptions(dialectSelect(), "postgres");
  await userEvent.clear(portInput());
  await userEvent.type(portInput(), "0");
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(screen.getByText("Enter a port from 1 to 65535. PostgreSQL usually uses 5432.")).toBeTruthy();
});

test("postgres_test_shows_postgresql_version", async () => {
  routeInvoke({ test_connection: () => "17.0" });
  renderNew();
  await userEvent.selectOptions(dialectSelect(), "postgres");
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText("Connected. The server runs PostgreSQL 17.0.")).toBeTruthy();
  expect((callsTo("test_connection")[0].input as { dialect: string }).dialect).toBe("postgres");
});

test("postgres_auth_hint_mentions_access_rules", async () => {
  routeInvoke({
    test_connection: () => {
      throw { kind: "auth", message: "the server requires a password, and none is saved for this Connection" };
    },
  });
  renderNew();
  await userEvent.selectOptions(dialectSelect(), "postgres");
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(
    await screen.findByText(
      "Sign-in failed: the server requires a password, and none is saved for this Connection. Check the user name and password, or the server's access rules for this database.",
    ),
  ).toBeTruthy();
});

test("sqlite_hides_server_fields_and_saves_the_file", async () => {
  vi.mocked(open).mockResolvedValue("C:\\data\\shop.db");
  routeInvoke({ save_connection: (a) => ({ ...existing, ...(a.input as object), id: "c9" }) });
  const onSaved = renderNew();
  await userEvent.type(screen.getByLabelText("Name"), "Shop file");
  await userEvent.selectOptions(dialectSelect(), "sqlite");
  expect(screen.queryByLabelText("Host")).toBeNull();
  expect(screen.queryByLabelText("Port")).toBeNull();
  expect(screen.queryByLabelText("User")).toBeNull();
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(screen.queryByLabelText("SSL")).toBeNull();
  expect(screen.queryByLabelText("Default database")).toBeNull();
  expect(screen.getByLabelText("Group")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Browse…" }));
  await waitFor(() => expect(fileInput().value).toBe("C:\\data\\shop.db"));
  expect(vi.mocked(open)).toHaveBeenCalledWith({
    multiple: false,
    directory: false,
    filters: [SQLITE_FILTER, { name: "All files", extensions: ["*"] }],
  });

  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(callsTo("save_connection")[0].input).toEqual({
    id: null,
    name: "Shop file",
    dialect: "sqlite",
    file: "C:\\data\\shop.db",
    host: "",
    port: 0,
    user: "",
    database: null,
    ssl: { mode: "disable" },
    password: { t: "clear" },
    groupId: null,
    queryTimeoutSecs: null,
  });
});

test("new_sqlite_file_is_created_then_filled", async () => {
  vi.mocked(save).mockResolvedValue("C:\\data\\shop.sqlite");
  routeInvoke({ create_sqlite_database: () => null });
  renderNew();
  await userEvent.type(screen.getByLabelText("Name"), "shop");
  await userEvent.selectOptions(dialectSelect(), "sqlite");
  await userEvent.click(screen.getByRole("button", { name: "New file…" }));
  await waitFor(() => expect(fileInput().value).toBe("C:\\data\\shop.sqlite"));
  expect(vi.mocked(save)).toHaveBeenCalledWith({ filters: [SQLITE_FILTER], defaultPath: "shop.sqlite" });
  expect(callsTo("create_sqlite_database")).toEqual([{ path: "C:\\data\\shop.sqlite" }]);
});

test("new_file_success_names_the_file", async () => {
  vi.mocked(save).mockResolvedValue("C:\\data\\shop.db");
  routeInvoke({ create_sqlite_database: () => null });
  renderNew();
  await userEvent.selectOptions(dialectSelect(), "sqlite");
  await userEvent.click(screen.getByRole("button", { name: "New file…" }));
  expect(await screen.findByText("Created shop.db.")).toBeTruthy();
  expect(vi.mocked(save)).toHaveBeenCalledWith({ filters: [SQLITE_FILTER], defaultPath: "database.sqlite" });
  expect(fileInput().value).toBe("C:\\data\\shop.db");
});

test("new_file_over_existing_says_never_replaces", async () => {
  vi.mocked(save).mockResolvedValue("C:\\data\\shop.sqlite");
  routeInvoke({
    create_sqlite_database: () => {
      throw { kind: "invalidInput", message: "a file already exists at C:\\data\\shop.sqlite. Pick a new file name" };
    },
  });
  renderNew();
  await userEvent.selectOptions(dialectSelect(), "sqlite");
  await userEvent.click(screen.getByRole("button", { name: "New file…" }));
  expect(await screen.findByText("DB View never replaces an existing file. Choose a new name.")).toBeTruthy();
  expect(fileInput().value).toBe("");
});

test("cancelled_dialog_changes_nothing", async () => {
  vi.mocked(open).mockResolvedValue(null);
  vi.mocked(save).mockResolvedValue(null);
  routeInvoke({});
  renderNew();
  await userEvent.selectOptions(dialectSelect(), "sqlite");
  await userEvent.type(fileInput(), "C:\\data\\keep.db");
  await userEvent.click(screen.getByRole("button", { name: "Browse…" }));
  await waitFor(() => expect(vi.mocked(open)).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "New file…" }));
  await waitFor(() => expect(vi.mocked(save)).toHaveBeenCalled());
  expect(fileInput().value).toBe("C:\\data\\keep.db");
  expect(callsTo("create_sqlite_database")).toEqual([]);
  expect(screen.queryByRole("status")).toBeNull();
});

test("sqlite_missing_file_error_has_one_hint", async () => {
  routeInvoke({
    test_connection: () => {
      throw { kind: "connect", message: "cannot open C:\\data\\x.db: the file does not exist" };
    },
  });
  renderNew();
  await userEvent.selectOptions(dialectSelect(), "sqlite");
  await userEvent.type(fileInput(), "C:\\data\\x.db");
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(
    (await screen.findByRole("status")).textContent,
  ).toBe("Cannot open C:\\data\\x.db: the file does not exist. Check the path, or choose the file again.");
});

test("sqlite_test_success_names_db_view_sqlite_version", async () => {
  routeInvoke({ test_connection: () => "3.50.2" });
  renderNew();
  await userEvent.selectOptions(dialectSelect(), "sqlite");
  await userEvent.type(fileInput(), "C:\\data\\shop.db");
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText("Opened. DB View uses SQLite 3.50.2.")).toBeTruthy();
});

test("dialect_is_fixed_when_editing", () => {
  renderEditing({ ...existing, dialect: "postgres", port: 5432, user: "kfc_app" });
  expect(dialectSelect().value).toBe("postgres");
  expect(dialectSelect().disabled).toBe(true);
});

test("editing a sqlite connection shows its file", () => {
  renderEditing({ ...existing, dialect: "sqlite", host: "", port: 0, user: "", file: "C:\\data\\shop.db" });
  expect(dialectSelect().value).toBe("sqlite");
  expect(fileInput().value).toBe("C:\\data\\shop.db");
  expect(screen.queryByLabelText("Host")).toBeNull();
});

test("dialect_field_follows_name_and_explains_when_fixed", () => {
  renderEditing(existing);
  const name = screen.getByLabelText("Name");
  const dialect = dialectSelect();
  expect(name.compareDocumentPosition(dialect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.activeElement).toBe(name);
  const describedBy = dialect.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  expect(document.getElementById(describedBy!)?.textContent).toBe("The Dialect can't change after saving.");
});

test("new connection dialect has no fixed-dialect help", () => {
  renderNew();
  expect(dialectSelect().disabled).toBe(false);
  expect(screen.queryByText("The Dialect can't change after saving.")).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));
});

test("prefill_postgres_suggestion", () => {
  render(
    <ConnectionForm
      prefill={{ name: "Laragon PostgreSQL", dialect: "postgres", host: "127.0.0.1", port: 5432, user: "postgres" }}
      groups={groups}
      defaultGroupId={null}
      onSaved={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(dialectSelect().value).toBe("postgres");
  expect(portInput().value).toBe("5432");
  expect(userInput().value).toBe("postgres");
  expect(dialectSelect().disabled).toBe(false);
});

test("connection_form_saves_the_query_timeout", async () => {
  routeInvoke({ save_connection: (a) => ({ ...existing, ...(a.input as object) }) });
  const onSaved = vi.fn();
  render(
    <ConnectionForm connection={{ ...existing, queryTimeoutSecs: 30 }} groups={groups} defaultGroupId={null} onSaved={onSaved} onCancel={() => {}} />,
  );
  const timeout = screen.getByLabelText("Query timeout (seconds)") as HTMLInputElement;
  expect(timeout.value).toBe("30");
  await userEvent.clear(timeout);
  await userEvent.type(timeout, "0");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByText("Enter a whole number of seconds, or leave it empty.")).toBeTruthy();
  expect(callsTo("save_connection")).toHaveLength(0);
  await userEvent.clear(timeout);
  await userEvent.type(timeout, "45");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect((callsTo("save_connection")[0].input as { queryTimeoutSecs: unknown }).queryTimeoutSecs).toBe(45);
});

test("an_empty_query_timeout_saves_as_no_limit", async () => {
  routeInvoke({ save_connection: (a) => ({ ...existing, ...(a.input as object) }) });
  const onSaved = vi.fn();
  render(
    <ConnectionForm connection={{ ...existing, queryTimeoutSecs: 30 }} groups={groups} defaultGroupId={null} onSaved={onSaved} onCancel={() => {}} />,
  );
  await userEvent.clear(screen.getByLabelText("Query timeout (seconds)"));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect((callsTo("save_connection")[0].input as { queryTimeoutSecs: unknown }).queryTimeoutSecs).toBeNull();
});
