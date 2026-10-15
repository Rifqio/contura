import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { callsTo, routeInvoke } from "../test/invoke";
import GroupForm from "./GroupForm";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

test("delete confirmation states how many connections move to ungrouped", async () => {
  routeInvoke({ delete_group: () => null });
  const onDeleted = vi.fn();
  render(
    <GroupForm
      group={{ id: "g1", name: "KFC", color: "red" }}
      connectionCount={3}
      onSaved={() => {}}
      onDeleted={onDeleted}
      onCancel={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Delete Group" }));
  expect(screen.getByText(/3 Connections will move to Ungrouped/)).toBeTruthy();
  expect(callsTo("delete_group")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Delete KFC" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(callsTo("delete_group")).toEqual([{ id: "g1" }]);
});
