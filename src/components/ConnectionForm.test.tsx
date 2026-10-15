import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { ConnectionConfig } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import ConnectionForm from "./ConnectionForm";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
};
const groups = [{ id: "g1", name: "KFC", color: "red" as const }];

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
});

test("test shows server version", async () => {
  routeInvoke({ test_connection: () => "8.0.30" });
  render(<ConnectionForm groups={groups} defaultGroupId={null} onSaved={() => {}} onCancel={() => {}} />);
  await userEvent.type(screen.getByLabelText("Name"), "Laragon");
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText(/8\.0\.30/)).toBeTruthy();
});

test("test shows error message", async () => {
  routeInvoke({
    test_connection: () => {
      throw { kind: "auth", message: "Access denied for user 'root'@'localhost'" };
    },
  });
  render(<ConnectionForm groups={groups} defaultGroupId={null} onSaved={() => {}} onCancel={() => {}} />);
  await userEvent.type(screen.getByLabelText("Name"), "Laragon");
  await userEvent.click(screen.getByRole("button", { name: "Test" }));
  expect(await screen.findByText(/Access denied for user 'root'@'localhost'/)).toBeTruthy();
});
