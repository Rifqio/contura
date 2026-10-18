import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig } from "../api/types";
import StatusBar, { type StatusScreen } from "./StatusBar";

const pg: ConnectionConfig = {
  id: "c1",
  name: "freight-prod",
  dialect: "postgres",
  host: "10.0.4.20",
  port: 5432,
  user: "u",
  database: "shop",
  ssl: { mode: "disable" },
  file: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: true,
  readOnly: false,
  groupId: null,
};

function renderBar(screen: StatusScreen, theme: "system" | "light" | "dark" = "system") {
  const onTheme = vi.fn();
  render(<StatusBar screen={screen} theme={theme} onTheme={onTheme} />);
  return { onTheme, bar: screen_bar() };
}
const screen_bar = () => screen.getByRole("status");

const work = (over: Partial<Extract<StatusScreen, { kind: "workspace" }>> = {}): StatusScreen => ({
  kind: "workspace",
  connection: pg,
  open: true,
  serverVersion: "16.4",
  ...over,
});

test("home_counts_connections_and_open", () => {
  const { bar } = renderBar({ kind: "home", connections: 9, open: 2 });
  expect(bar.textContent).toContain("9 Connections");
  expect(bar.textContent).toContain("2 open");
});

test("home_without_connections_says_no_connections", () => {
  const { bar } = renderBar({ kind: "home", connections: 0, open: 0 });
  expect(bar.textContent).toContain("No Connections");
  expect(bar.textContent).not.toContain("open");
});

test("settings_shows_the_data_folder_and_version", () => {
  const { bar } = renderBar({ kind: "settings", dataFolder: "E:\\Apps\\Contura\\data", version: "0.7.0" });
  expect(bar.textContent).toContain("E:\\Apps\\Contura\\data");
  expect(bar.textContent).toContain("Contura 0.7.0");
});

test("schema_shows_model_file_applied_and_layout_note", () => {
  const { bar } = renderBar({ kind: "schema", fileName: "kestrel_orders.dbml", appliedTo: null });
  for (const t of ["Schema Model", "kestrel_orders.dbml", "Not applied to a Connection", "Layout saved beside the file"]) {
    expect(bar.textContent).toContain(t);
  }
});

test("schema_names_the_connection_it_was_applied_to", () => {
  const { bar } = renderBar({ kind: "schema", fileName: "kestrel_orders.dbml", appliedTo: "kestrel prod" });
  expect(bar.textContent).toContain("Applied to kestrel prod");
  expect(bar.textContent).not.toContain("Not applied");
});

test("production_segment_holds_label_mark_name_and_version", () => {
  const { bar } = renderBar(work());
  expect(bar.tagName).toBe("FOOTER");
  expect(bar.classList.contains("app-status")).toBe(true);
  const prod = bar.querySelector(".app-status-prod") as HTMLElement;
  expect(prod.textContent).toContain("PRODUCTION");
  expect(prod.textContent).toContain("freight-prod");
  expect(prod.textContent).toContain("PostgreSQL 16.4");
  expect(prod.querySelector("svg, img")).toBeTruthy();
  expect(bar.querySelector("#app-status-slot")).toBeTruthy();
});

test("plain_connection_has_no_production_segment", () => {
  const { bar } = renderBar(work({ connection: { ...pg, production: false }, serverVersion: null }));
  expect(screen.queryByText("PRODUCTION")).toBeNull();
  expect(bar.textContent).toContain("freight-prod");
  expect(bar.textContent).not.toContain("16.4");
});

test("read_only_shows_a_lock_and_the_word_between_name_and_version", () => {
  const { bar } = renderBar(work({ connection: { ...pg, production: false, readOnly: true } }));
  const mark = bar.querySelector(".app-status-readonly") as HTMLElement;
  expect(mark.textContent).toBe("Read-only");
  expect(mark.querySelector("svg")).toBeTruthy();
  const t = bar.textContent ?? "";
  expect(t.indexOf("freight-prod")).toBeLessThan(t.indexOf("Read-only"));
  expect(t.indexOf("Read-only")).toBeLessThan(t.indexOf("PostgreSQL 16.4"));
});

test("a_closed_connection_says_closed_in_the_version_place", () => {
  // Frames 10a to 10c: closed, connecting and failed all reach the bar as open: false.
  const { bar } = renderBar(work({ open: false }));
  const prod = bar.querySelector(".app-status-prod") as HTMLElement;
  expect(prod.textContent).toContain("freight-prod");
  expect(prod.textContent).toContain("Closed");
  expect(bar.textContent).not.toContain("16.4");
  expect(bar.textContent).not.toContain("Not connected");
  cleanup();
  const plain = renderBar(work({ connection: { ...pg, production: false }, open: false, serverVersion: null }));
  expect(plain.bar.textContent).toContain("Closed");
});

test("workspace_without_a_connection_says_no_connection_open", () => {
  const { bar } = renderBar(work({ connection: null, open: false, serverVersion: null }));
  expect(bar.textContent).toContain("No Connection open");
});

test("only_the_left_segment_is_a_live_region", () => {
  const { bar } = renderBar(work());
  const slot = bar.querySelector("#app-status-slot") as HTMLElement;
  expect(slot.getAttribute("aria-live")).toBe("off");
  expect(bar.querySelector(".app-status-prod")?.closest("[aria-live=off]")).toBeNull();
});

test("right_side_has_utf8_and_a_theme_menu_and_no_gear", async () => {
  const { bar, onTheme } = renderBar(work(), "dark");
  expect(bar.textContent).toContain("UTF-8");
  expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Theme" }));
  const labels = screen.getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"));
  expect(labels).toEqual(["Dracula", "Alucard", "Follow Windows"]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Follow Windows" }));
  expect(onTheme).toHaveBeenCalledWith("system");
});

test("the_jobs_node_renders_before_the_theme_menu", () => {
  render(<StatusBar screen={work()} theme="system" onTheme={() => {}} jobs={<button type="button">Exporting orders, 32 percent</button>} />);
  const bar = screen.getByRole("status");
  const job = screen.getByRole("button", { name: "Exporting orders, 32 percent" });
  const theme = screen.getByRole("button", { name: "Theme" });
  expect(bar.contains(job)).toBe(true);
  expect(job.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(job.closest("#app-status-slot")).toBeNull();
});
