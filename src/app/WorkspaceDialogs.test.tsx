import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { expect, test, vi } from "vitest";
import { FormDialogs, StartModelDialog } from "./WorkspaceDialogs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function formProps(over: Partial<ComponentProps<typeof FormDialogs>> = {}): ComponentProps<typeof FormDialogs> {
  return {
    form: { kind: "none" },
    group: undefined,
    groups: [],
    connections: [],
    openIds: new Set(),
    workspaceGroupId: null,
    onCloseForm: vi.fn(),
    reload: vi.fn(async () => {}),
    confirmGroupLeave: vi.fn(async () => true),
    onGroupDeleted: vi.fn(),
    onConnectionSaved: vi.fn(),
    ...over,
  };
}

test("renders_nothing_without_a_form", () => {
  const { container } = render(
    <>
      <FormDialogs {...formProps()} />
      <StartModelDialog modelStart={null} connections={[]} openIds={new Set()} onStartModel={vi.fn()} onCancelModel={vi.fn()} />
    </>,
  );
  expect(container.innerHTML).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("new_group_cancel_closes_the_form", async () => {
  const props = formProps({ form: { kind: "newGroup" } });
  render(<FormDialogs {...props} />);
  await userEvent.click(screen.getByRole("button", { name: /^Cancel/ }));
  expect(props.onCloseForm).toHaveBeenCalledTimes(1);
  expect(props.reload).not.toHaveBeenCalled();
});
