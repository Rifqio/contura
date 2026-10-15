import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import Dialog from "./Dialog";

test("Escape closes it, even when focus has left the dialog", async () => {
  const onClose = vi.fn();
  render(
    <Dialog title="Edit KFC" onClose={onClose}>
      <input aria-label="Name" />
    </Dialog>,
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);

  (document.activeElement as HTMLElement).blur();
  expect(document.activeElement).toBe(document.body);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("Tab and Shift+Tab wrap inside it", async () => {
  // A control outside the dialog: natural tab order would reach it, a wrap never does.
  render(
    <>
      <button type="button">Outside</button>
      <Dialog title="Edit KFC" onClose={() => {}}>
        <input aria-label="Name" />
        <button type="button">Save</button>
      </Dialog>
    </>,
  );
  const close = screen.getByRole("button", { name: "Close" });
  const name = screen.getByLabelText("Name");
  const save = screen.getByRole("button", { name: "Save" });
  expect(document.activeElement).toBe(name);
  await userEvent.tab();
  expect(document.activeElement).toBe(save);
  await userEvent.tab();
  expect(document.activeElement).toBe(close);
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(save);
});

test("Shift+Tab from the panel itself wraps to the last control", async () => {
  render(
    <Dialog title="note: full value" onClose={() => {}}>
      <p>No inputs here</p>
      <button type="button">Copy</button>
    </Dialog>,
  );
  expect(document.activeElement).toBe(screen.getByRole("dialog"));
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy" }));
});
