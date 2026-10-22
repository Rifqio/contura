import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig } from "../api/types";
import { setPlatformForTests } from "../platform";
import { callsTo, routeInvoke } from "../test/invoke";
import appCss from "../styles/app.css?raw";
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
  aiAccess: "schema",
  production: false,
  readOnly: false,
};
const groups = [{ id: "g1", name: "KFC", color: "indigo" as const, hasImage: false }];

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

const dialectGroup = () => screen.getByRole("radiogroup", { name: "Database" });
const chosenDialect = () => within(dialectGroup()).getByRole("radio", { checked: true }).textContent;
const chooseDialect = (label: string) => userEvent.click(within(dialectGroup()).getByRole("radio", { name: label }));
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
  await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
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
  await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
  expect(await screen.findByText(/Access denied for user 'root'@'localhost'/)).toBeTruthy();
});

test("choosing_postgresql_sets_its_defaults", async () => {
  renderNew();
  expect(chosenDialect()).toBe("MySQL");
  expect(portInput().value).toBe("3306");
  expect(userInput().value).toBe("root");
  await chooseDialect("PostgreSQL");
  expect(portInput().value).toBe("5432");
  expect(userInput().value).toBe("postgres");
  await chooseDialect("MySQL");
  expect(portInput().value).toBe("3306");
  expect(userInput().value).toBe("root");
});

test("typed_port_survives_dialect_switch", async () => {
  renderNew();
  await userEvent.clear(portInput());
  await userEvent.type(portInput(), "3310");
  await chooseDialect("PostgreSQL");
  expect(portInput().value).toBe("3310");
  expect(userInput().value).toBe("postgres");
});

test("postgres port error names postgresql", async () => {
  renderNew();
  await chooseDialect("PostgreSQL");
  await userEvent.clear(portInput());
  await userEvent.type(portInput(), "0");
  await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
  expect(screen.getByText("Enter a port from 1 to 65535. PostgreSQL usually uses 5432.")).toBeTruthy();
});

test("postgres_test_shows_postgresql_version", async () => {
  routeInvoke({ test_connection: () => "17.0" });
  renderNew();
  await chooseDialect("PostgreSQL");
  await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
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
  await chooseDialect("PostgreSQL");
  await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
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
  await chooseDialect("SQLite");
  expect(screen.queryByLabelText("Host")).toBeNull();
  expect(screen.queryByLabelText("Port")).toBeNull();
  expect(screen.queryByLabelText("User")).toBeNull();
  expect(screen.queryByLabelText("Password")).toBeNull();
  expect(screen.queryByLabelText("SSL")).toBeNull();
  expect(screen.queryByLabelText("Database name")).toBeNull();
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
    aiAccess: "schema",
    aiSync: "automatic",
    production: false,
    readOnly: false,
  });
});

test("parity_P11_38_ssl_ca_file_placeholder_follows_the_platform", async () => {
  const caPlaceholder = async () => {
    await userEvent.click(screen.getByRole("combobox", { name: "SSL" }));
    await userEvent.click(screen.getByRole("option", { name: "Required, verify the CA" }));
    return (screen.getByLabelText("CA certificate file") as HTMLInputElement).placeholder;
  };
  try {
    setPlatformForTests("linux");
    const first = render(<ConnectionForm connection={existing} groups={groups} defaultGroupId={null} onSaved={() => {}} onCancel={() => {}} />);
    expect(await caPlaceholder()).toBe("/etc/ssl/certs/ca.pem");
    first.unmount();
    setPlatformForTests("windows");
    render(<ConnectionForm connection={existing} groups={groups} defaultGroupId={null} onSaved={() => {}} onCancel={() => {}} />);
    expect(await caPlaceholder()).toBe("C:\\certs\\ca.pem");
  } finally {
    setPlatformForTests(null);
  }
});

test("parity_P11_1_sqlite_file_placeholder_follows_the_platform", async () => {
  try {
    setPlatformForTests("linux");
    const first = render(<ConnectionForm groups={groups} defaultGroupId={null} onSaved={() => {}} onCancel={() => {}} />);
    await chooseDialect("SQLite");
    expect(fileInput().placeholder).toBe("/home/you/data/shop.db");
    first.unmount();
    setPlatformForTests("windows");
    render(<ConnectionForm groups={groups} defaultGroupId={null} onSaved={() => {}} onCancel={() => {}} />);
    await chooseDialect("SQLite");
    expect(fileInput().placeholder).toBe("C:\\data\\shop.db");
  } finally {
    setPlatformForTests(null);
  }
});

test("new_sqlite_file_is_created_then_filled", async () => {
  vi.mocked(save).mockResolvedValue("C:\\data\\shop.sqlite");
  routeInvoke({ create_sqlite_database: () => null });
  renderNew();
  await userEvent.type(screen.getByLabelText("Name"), "shop");
  await chooseDialect("SQLite");
  await userEvent.click(screen.getByRole("button", { name: "New file…" }));
  await waitFor(() => expect(fileInput().value).toBe("C:\\data\\shop.sqlite"));
  expect(vi.mocked(save)).toHaveBeenCalledWith({ filters: [SQLITE_FILTER], defaultPath: "shop.sqlite" });
  expect(callsTo("create_sqlite_database")).toEqual([{ path: "C:\\data\\shop.sqlite" }]);
});

test("new_file_success_names_the_file", async () => {
  vi.mocked(save).mockResolvedValue("C:\\data\\shop.db");
  routeInvoke({ create_sqlite_database: () => null });
  renderNew();
  await chooseDialect("SQLite");
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
  await chooseDialect("SQLite");
  await userEvent.click(screen.getByRole("button", { name: "New file…" }));
  expect(await screen.findByText("Contura never replaces an existing file. Choose a new name.")).toBeTruthy();
  expect(fileInput().value).toBe("");
});

test("cancelled_dialog_changes_nothing", async () => {
  vi.mocked(open).mockResolvedValue(null);
  vi.mocked(save).mockResolvedValue(null);
  routeInvoke({});
  renderNew();
  await chooseDialect("SQLite");
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
  await chooseDialect("SQLite");
  await userEvent.type(fileInput(), "C:\\data\\x.db");
  await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
  expect(
    (await screen.findByRole("status")).textContent,
  ).toBe("Cannot open C:\\data\\x.db: the file does not exist. Check the path, or choose the file again.");
});

test("sqlite_test_success_names_contura_sqlite_version", async () => {
  routeInvoke({ test_connection: () => "3.50.2" });
  renderNew();
  await chooseDialect("SQLite");
  await userEvent.type(fileInput(), "C:\\data\\shop.db");
  await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
  expect(await screen.findByText("Opened. Contura uses SQLite 3.50.2.")).toBeTruthy();
});

test("dialect_is_fixed_when_editing", () => {
  renderEditing({ ...existing, dialect: "postgres", port: 5432, user: "kfc_app" });
  expect(chosenDialect()).toBe("PostgreSQL");
  for (const r of within(dialectGroup()).getAllByRole("radio")) expect(r.matches(":disabled")).toBe(true);
});

test("editing a sqlite connection shows its file", () => {
  renderEditing({ ...existing, dialect: "sqlite", host: "", port: 0, user: "", file: "C:\\data\\shop.db" });
  expect(chosenDialect()).toBe("SQLite");
  expect(fileInput().value).toBe("C:\\data\\shop.db");
  expect(screen.queryByLabelText("Host")).toBeNull();
});

test("dialect_is_explained_when_fixed", () => {
  renderEditing(existing);
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  expect(screen.getByText("The Dialect can't change after saving.")).toBeTruthy();
});

test("new connection dialect has no fixed-dialect help", () => {
  renderNew();
  for (const r of within(dialectGroup()).getAllByRole("radio")) expect(r.matches(":disabled")).toBe(false);
  expect(screen.queryByText("The Dialect can't change after saving.")).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));
});

test("prefill_postgres_suggestion", () => {
  render(
    <ConnectionForm
      prefill={{ name: "Laragon PostgreSQL", dialect: "postgres", host: "127.0.0.1", port: 5432, user: "postgres", version: null }}
      groups={groups}
      defaultGroupId={null}
      onSaved={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(chosenDialect()).toBe("PostgreSQL");
  expect(portInput().value).toBe("5432");
  expect(userInput().value).toBe("postgres");
  for (const r of within(dialectGroup()).getAllByRole("radio")) expect(r.matches(":disabled")).toBe(false);
});

test("connection_form_saves_the_query_timeout", async () => {
  routeInvoke({ save_connection: (a) => ({ ...existing, ...(a.input as object) }) });
  const onSaved = vi.fn();
  render(
    <ConnectionForm connection={{ ...existing, queryTimeoutSecs: 30 }} groups={groups} defaultGroupId={null} onSaved={onSaved} onCancel={() => {}} />,
  );
  const timeout = screen.getByLabelText("Query timeout") as HTMLInputElement;
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
  await userEvent.clear(screen.getByLabelText("Query timeout"));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect((callsTo("save_connection")[0].input as { queryTimeoutSecs: unknown }).queryTimeoutSecs).toBeNull();
});

const aiSelect = () => screen.getByRole("combobox", { name: "AI access" }) as HTMLButtonElement;
const aiText = () => aiSelect().textContent;
async function chooseAi(label: string) {
  await userEvent.click(aiSelect());
  await userEvent.click(screen.getByRole("option", { name: label }));
}

test("connection_form_has_ai_access", async () => {
  routeInvoke({ save_connection: () => existing });
  const onSaved = renderNew();
  await userEvent.click(aiSelect());
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "Never send anything",
    "Schema only",
    "Schema and query text",
    "Schema, query text and sample rows",
  ]);
  await userEvent.keyboard("{Escape}");
  expect(aiText()).toBe("Schema only");
  await userEvent.type(screen.getByLabelText("Name"), "Laragon");
  await chooseAi("Schema and query text");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(callsTo("save_connection")[0].input).toMatchObject({ aiAccess: "schemaQuery" });
});

test("editing shows the Connection's AI access in the select", () => {
  renderEditing({ ...existing, aiAccess: "never" });
  expect(aiText()).toBe("Never send anything");
});

test("production_on_sets_ai_access_never_and_shows_note", async () => {
  renderNew();
  expect(aiText()).toBe("Schema only");
  await userEvent.click(screen.getByRole("switch", { name: "Production" }));
  expect(aiText()).toBe("Never send anything");
  expect(aiSelect().disabled).toBe(true);
  expect(
    screen.getByText("Production Connections send nothing to the assistant. You can raise this after saving."),
  ).toBeTruthy();
  expect(screen.queryByText(/the assistant will see/)).toBeNull();
});

test("production_switched_on_in_this_edit_locks_ai_access_until_saved", async () => {
  renderEditing({ ...existing, production: false, aiAccess: "schemaQuery" });
  expect(aiSelect().disabled).toBe(false);
  await userEvent.click(screen.getByRole("switch", { name: "Production" }));
  expect(aiText()).toBe("Never send anything");
  expect(aiSelect().disabled).toBe(true);
  expect(
    screen.getByText("Production Connections send nothing to the assistant. You can raise this after saving."),
  ).toBeTruthy();
  expect(screen.queryByText(/This is a Production Connection/)).toBeNull();
  await userEvent.click(screen.getByRole("switch", { name: "Production" }));
  expect(aiSelect().disabled).toBe(false);
});

test("raising_ai_access_on_saved_production_shows_warning", async () => {
  renderEditing({ ...existing, production: true, aiAccess: "never" });
  expect(aiSelect().disabled).toBe(false);
  expect(screen.getByText("Production Connections send nothing to the assistant unless you change this")).toBeTruthy();
  await chooseAi("Schema and query text");
  expect(
    screen.getByText("This is a Production Connection: the assistant will see table and column names and the text of your queries."),
  ).toBeTruthy();
  expect(screen.queryByText(/send nothing to the assistant/)).toBeNull();
});

test("read_only_overrides_production", async () => {
  renderEditing({ ...existing, production: true, aiAccess: "never" });
  const production = screen.getByRole("switch", { name: /Production/ }) as HTMLButtonElement;
  expect(production.disabled).toBe(false);
  await userEvent.click(screen.getByRole("switch", { name: "Read-only" }));
  expect(production.disabled).toBe(true);
  expect(production.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("Overridden by Read-only")).toBeTruthy();
});

test("production_off_leaves_ai_access_unchanged", async () => {
  renderNew();
  await userEvent.click(screen.getByRole("switch", { name: "Production" }));
  expect(aiText()).toBe("Never send anything");
  await userEvent.click(screen.getByRole("switch", { name: "Production" }));
  expect(aiText()).toBe("Never send anything");
});

test("editing_production_with_raised_ai_access_shows_warning_on_open", () => {
  renderEditing({ ...existing, production: true, aiAccess: "schema" });
  expect(aiText()).toBe("Schema only");
  expect(screen.getByText(/This is a Production Connection: the assistant will see/)).toBeTruthy();
});

test("read_only_on_then_off_keeps_production_enabled_and_checked", async () => {
  renderEditing({ ...existing, production: true, aiAccess: "never" });
  const production = screen.getByRole("switch", { name: /Production/ }) as HTMLButtonElement;
  await userEvent.click(screen.getByRole("switch", { name: "Read-only" }));
  await userEvent.click(screen.getByRole("switch", { name: "Read-only" }));
  expect(production.disabled).toBe(false);
  expect(production.getAttribute("aria-checked")).toBe("true");
});

test("save_sends_production_and_read_only", async () => {
  routeInvoke({ save_connection: () => existing });
  const onSaved = renderNew();
  await userEvent.type(screen.getByLabelText("Name"), "Orders");
  await userEvent.click(screen.getByRole("switch", { name: "Production" }));
  await userEvent.click(screen.getByRole("switch", { name: "Read-only" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  const input = callsTo("save_connection")[0].input as Record<string, unknown>;
  expect(input.production).toBe(true);
  expect(input.readOnly).toBe(true);
  expect(input.aiAccess).toBe("never");
});

const labelsInOrder = () => Array.from(document.querySelectorAll(".dialog .fl")).map((n) => n.textContent);

test("database_is_a_segmented_control_with_marks", () => {
  renderNew();
  const radios = within(dialectGroup()).getAllByRole("radio");
  expect(radios.map((r) => r.textContent)).toEqual(["MySQL", "PostgreSQL", "SQLite"]);
  for (const r of radios) expect(r.querySelector("svg.db-mark")).not.toBeNull();
});

test("fields_follow_the_design_order", () => {
  renderNew();
  expect(labelsInOrder()).toEqual([
    "Database",
    "Name",
    "Group",
    "Host",
    "Port",
    "User",
    "Password",
    "Database name",
    "SSL",
    "Query timeout",
    "AI access",
    "Keep context in sync",
    "Safety",
  ]);
});

test("password_has_an_eye_button", async () => {
  renderNew();
  const password = screen.getByLabelText("Password") as HTMLInputElement;
  expect(password.type).toBe("password");
  await userEvent.click(screen.getByRole("button", { name: "Show password" }));
  expect(password.type).toBe("text");
  await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
  expect(password.type).toBe("password");
});

test("query_timeout_has_a_seconds_suffix", () => {
  renderNew();
  const suffix = screen.getByText("seconds");
  expect(suffix.className).toContain("input-suffix");
  expect(suffix.parentElement?.contains(screen.getByLabelText("Query timeout"))).toBe(true);
});

test("ai_access_defaults_to_the_new_connections_setting", async () => {
  routeInvoke({ ai_settings: () => ({ settings: { newConnectionAccess: "schemaQuery" }, groupOverride: false, keySaved: false, keyLast4: null }) });
  renderNew();
  await waitFor(() => expect(aiText()).toBe("Schema and query text"));
  expect(callsTo("ai_settings")).toHaveLength(1);
});

test("ai_access_is_described_by_its_help_line", () => {
  renderNew();
  const help = document.getElementById(aiSelect().getAttribute("aria-describedby")!);
  expect(help?.textContent).toBe("What the AI assistant may send to your provider from this Connection.");
});

test("plus_sample_rows_help", async () => {
  renderNew();
  expect(screen.queryByText(/Contura reads at most 5 rows/)).toBeNull();
  await chooseAi("Schema, query text and sample rows");
  expect(
    screen.getByText(
      "Sample rows: Contura reads at most 5 rows of each named table, read only, only when the Sample rows switch is on for that Ask, and never keeps them. Cells are cut at 200 characters and binary values go as <binary>.",
    ),
  ).toBeTruthy();
});

test("plus_sample_rows_help_is_announced_with_the_ai_access_select", async () => {
  renderNew();
  const described = () => (aiSelect().getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  expect(described()).toHaveLength(1);
  await chooseAi("Schema, query text and sample rows");
  const said = described().map((id) => document.getElementById(id)?.textContent);
  expect(said).toEqual([
    "What the AI assistant may send to your provider from this Connection.",
    "Sample rows: Contura reads at most 5 rows of each named table, read only, only when the Sample rows switch is on for that Ask, and never keeps them. Cells are cut at 200 characters and binary values go as <binary>.",
  ]);
});

test("a_chosen_ai_access_is_not_replaced_by_the_default", async () => {
  let release: (v: unknown) => void = () => {};
  const late = new Promise((r) => (release = r));
  const fetched = vi.fn();
  routeInvoke({ ai_settings: () => (fetched(), late) });
  renderNew();
  await chooseAi("Schema only");
  await userEvent.click(screen.getByRole("switch", { name: "Production" }));
  release({ settings: { newConnectionAccess: "schemaQuery" }, groupOverride: false, keySaved: false, keyLast4: null });
  await waitFor(() => expect(fetched).toHaveBeenCalled());
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  expect(aiText()).toBe("Never send anything");
});

test("production_on_locks_ai_access_to_never", async () => {
  renderNew();
  await userEvent.click(screen.getByRole("switch", { name: "Production" }));
  expect(aiText()).toBe("Never send anything");
  expect(aiSelect().disabled).toBe(true);
});

test("host_port_user_and_database_are_mono", () => {
  renderNew();
  for (const label of ["Host", "Port", "User", "Database name"]) {
    expect({ label, mono: screen.getByLabelText(label).classList.contains("input-mono") }).toEqual({ label, mono: true });
  }
});

test("group_and_ssl_use_the_themed_select_and_the_group_square", async () => {
  renderNew();
  expect(document.querySelector(".dialog select")).toBeNull();
  await userEvent.click(screen.getByRole("combobox", { name: "Group" }));
  const kfc = screen.getByRole("option", { name: "KFC" });
  expect(kfc.querySelector(".group-badge")).not.toBeNull();
  expect(screen.getByRole("option", { name: "Ungrouped" }).querySelector(".group-badge")).not.toBeNull();
  await userEvent.click(kfc);
  await userEvent.click(screen.getByRole("combobox", { name: "SSL" }));
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "Off",
    "Required",
    "Required, verify the CA",
    "Required, verify the CA and host",
  ]);
});

async function saveVerifyFull(caFile: string) {
  routeInvoke({ save_connection: (a) => ({ ...existing, ...(a.input as object) }) });
  const onSaved = vi.fn();
  render(<ConnectionForm connection={existing} groups={groups} defaultGroupId={null} onSaved={onSaved} onCancel={() => {}} />);
  await userEvent.click(screen.getByRole("combobox", { name: "SSL" }));
  await userEvent.click(screen.getByRole("option", { name: "Required, verify the CA and host" }));
  const ca = screen.getByLabelText("CA certificate file") as HTMLInputElement;
  expect(ca.placeholder).toBe("Empty to trust the public CAs");
  if (caFile !== "") await userEvent.type(ca, caFile);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  return (callsTo("save_connection")[0].input as { ssl: unknown }).ssl;
}

test("verify_full_without_a_ca_file_saves_null", async () => {
  expect(await saveVerifyFull("")).toEqual({ mode: "verifyFull", caPath: null });
});

test("verify_full_saves_the_ca_file", async () => {
  expect(await saveVerifyFull("/etc/ssl/db-ca.pem")).toEqual({ mode: "verifyFull", caPath: "/etc/ssl/db-ca.pem" });
});

test("editing_a_verify_full_connection_keeps_its_ca_file", () => {
  render(
    <ConnectionForm
      connection={{ ...existing, ssl: { mode: "verifyFull", caPath: "/etc/ssl/db-ca.pem" } }}
      groups={groups}
      defaultGroupId={null}
      onSaved={() => {}}
      onCancel={() => {}}
    />,
  );
  expect((screen.getByLabelText("CA certificate file") as HTMLInputElement).value).toBe("/etc/ssl/db-ca.pem");
});

test("safety_heading_and_short_lines", async () => {
  renderNew();
  expect(screen.getByText("Safety")).toBeTruthy();
  expect(screen.getByText("Asks before every write")).toBeTruthy();
  expect(screen.getByText("Blocks every write")).toBeTruthy();
  await userEvent.click(screen.getByRole("switch", { name: "Production" }));
  await userEvent.click(screen.getByRole("switch", { name: "Read-only" }));
  expect(screen.getByText("Read-only is on, so every write is blocked and Production never needs to ask.")).toBeTruthy();
  expect(screen.queryByText("Asks before every write")).toBeNull();
});

test("header_has_plug_icon_title_and_subtle_name", () => {
  renderEditing({ ...existing, name: "freight-prod" });
  const dialog = screen.getByRole("dialog");
  expect(dialog.querySelector(".dialog-header .dialog-icon")).not.toBeNull();
  expect(screen.getByRole("heading", { name: "Edit Connection" })).toBeTruthy();
  expect(dialog.querySelector(".dialog-subtitle")?.textContent).toBe("freight-prod");
});

test("a_new_connection_header_has_no_subtitle", () => {
  renderNew();
  expect(screen.getByRole("heading", { name: "New Connection" })).toBeTruthy();
  expect(document.querySelector(".dialog-subtitle")).toBeNull();
});

test("footer_test_connection_with_plug_and_save_with_ctrl_s", async () => {
  routeInvoke({ save_connection: () => existing });
  const onSaved = renderNew();
  const test = screen.getByRole("button", { name: "Test connection" });
  expect(test.querySelector("svg")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Save" }).querySelector("kbd")?.textContent).toBe("Ctrl+S");
  await userEvent.type(screen.getByLabelText("Name"), "Orders");
  await userEvent.keyboard("{Control>}s{/Control}");
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(callsTo("save_connection")).toHaveLength(1);
});

/** The declarations of the app.css rule whose selector is exactly `selector`. */
const cssRule = (selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\}|\\*/)\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(appCss)?.[1] ?? "";
};

test("the_body_scrolls_inside_the_dialog_so_the_footer_stays_in_view", () => {
  renderEditing(existing);
  const dialog = screen.getByRole("dialog");
  expect(dialog.classList.contains("connection-dialog")).toBe(true);
  // At most the window height less the scrim padding, so a short window keeps the footer.
  expect(cssRule(".dialog.connection-dialog")).toMatch(/max-height:\s*calc\(100vh/);
  // The body scrolls (overflow visible let it push the footer out of the dialog).
  expect(cssRule(".connection-form .form-grid")).toMatch(/overflow:\s*auto/);
  expect(cssRule(".dialog-body")).toMatch(/min-height:\s*0/);
  expect(dialog.querySelector(".dialog-body")).not.toBeNull();
  expect(dialog.querySelector("footer.dialog-footer")).not.toBeNull();
});

test("safety_is_a_bare_heading_without_a_box", () => {
  renderNew();
  const safety = screen.getByRole("group", { name: "Safety" });
  expect(within(safety).getByText("Safety")).toBeTruthy();
  const rule = cssRule(".safety");
  expect(rule).not.toMatch(/(^|[^-])border:/);
  expect(rule).not.toMatch(/border-radius/);
});

test("saving_asks_before_save_first_and_a_no_keeps_the_form_q43", async () => {
  routeInvoke({ save_connection: () => existing });
  const onSaved = vi.fn();
  let answer = false;
  const beforeSave = vi.fn(async () => answer);
  render(
    <ConnectionForm connection={existing} groups={groups} defaultGroupId={null} onSaved={onSaved} onCancel={() => {}} beforeSave={beforeSave} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(beforeSave).toHaveBeenCalledTimes(1));
  expect(callsTo("save_connection")).toHaveLength(0);
  expect(onSaved).not.toHaveBeenCalled();
  answer = true;
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(callsTo("save_connection")).toHaveLength(1);
});

// ---- AI Context (step 11c) ----

const syncSelect = () => screen.queryByRole("combobox", { name: "Keep context in sync" }) as HTMLButtonElement | null;

function renderSaved(connection: ConnectionConfig, isOpen = true) {
  const onSaved = vi.fn();
  render(
    <ConnectionForm connection={connection} isOpen={isOpen} groups={groups} defaultGroupId={null} onSaved={onSaved} onCancel={() => {}} />,
  );
  return onSaved;
}

const info = (over: Record<string, unknown> = {}) => ({
  connectionId: "c1",
  database: "shop",
  schema: "",
  sync: "automatic",
  builtAt: Date.now(),
  tableCount: 42,
  stale: false,
  check: { kind: "rebuilt", reason: "asked" },
  ...over,
});

test("sync_select_saved_with_the_form", async () => {
  routeInvoke({ ai_context_status: () => [], save_connection: () => existing });
  const onSaved = renderSaved({ ...existing, aiSync: "manual" });
  expect(syncSelect()!.textContent).toContain("Manual");
  await userEvent.click(syncSelect()!);
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Automatically", "Manual"]);
  await userEvent.click(screen.getByRole("option", { name: "Automatically" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(callsTo("save_connection")[0].input).toMatchObject({ aiSync: "automatic" });
  expect(callsTo("set_ai_sync_mode")).toHaveLength(0);
});

test("a_new_connection_shows_only_the_sync_select", async () => {
  routeInvoke({ save_connection: () => existing });
  const onSaved = renderNew();
  expect(syncSelect()!.textContent).toContain("Automatically");
  expect(screen.queryByRole("button", { name: "Re-sync now" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Clear AI context" })).toBeNull();
  await userEvent.type(screen.getByLabelText("Name"), "Laragon");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(callsTo("save_connection")[0].input).toMatchObject({ aiSync: "automatic" });
});

test("resync_now_shows_synced", async () => {
  let release: () => void = () => {};
  routeInvoke({
    ai_context_status: () => [],
    ai_resync: () => new Promise((resolve) => (release = () => resolve(info()))),
  });
  renderSaved({ ...existing, database: "shop" });
  expect(await screen.findByText("Not built")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Re-sync now" }));
  expect(await screen.findByText("Re-syncing...")).toBeTruthy();
  release();
  expect(await screen.findByText("Synced just now, 42 tables")).toBeTruthy();
  expect(callsTo("ai_resync")).toEqual([{ connectionId: "c1", database: "shop", schema: null }]);
});

test("resync_now_shows_the_error_under_the_row", async () => {
  routeInvoke({
    ai_context_status: () => [],
    ai_resync: () => {
      throw { kind: "invalidInput", message: "AI access is Never for this Connection." };
    },
  });
  renderSaved(existing);
  await userEvent.click(await screen.findByRole("button", { name: "Re-sync now" }));
  expect((await screen.findByRole("alert")).textContent).toContain("AI access is Never for this Connection.");
});

test("resync_on_a_closed_connection_asks_to_open_it", async () => {
  routeInvoke({ ai_context_status: () => [], ai_resync: () => info({ builtAt: null, tableCount: 0, check: { kind: "missing" } }) });
  renderSaved(existing, false);
  await userEvent.click(await screen.findByRole("button", { name: "Re-sync now" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Open the Connection to re-sync.");
});

test("clear_ai_context_shows_not_built", async () => {
  routeInvoke({
    ai_context_status: () => [
      { connectionId: "c1", database: "shop", schema: "", builtAt: Date.now() - 180_000, checkedAt: Date.now(), stale: false, tableCount: 6, bytes: 900 },
    ],
    ai_clear_context: () => undefined,
  });
  renderSaved(existing);
  expect(await screen.findByText("Synced 3m ago")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Clear AI context" }));
  expect(screen.getByText("Clear the AI context of Local MySQL? Its stored table summaries are removed. They are built again when you open the assistant or Ask.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
  expect(callsTo("ai_clear_context")).toHaveLength(0);
  expect(screen.getByText("Synced 3m ago")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Clear AI context" }));
  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(await screen.findByText("Not built")).toBeTruthy();
  expect(callsTo("ai_clear_context")).toEqual([{ connectionId: "c1" }]);
});

test("never_hides_sync_controls", async () => {
  routeInvoke({ ai_context_status: () => [] });
  renderSaved({ ...existing, aiAccess: "never" });
  expect(syncSelect()).toBeNull();
  expect(screen.queryByRole("button", { name: "Re-sync now" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Clear AI context" })).toBeNull();
  await chooseAi("Schema only");
  expect(syncSelect()).not.toBeNull();
  await chooseAi("Never send anything");
  expect(syncSelect()).toBeNull();
});
