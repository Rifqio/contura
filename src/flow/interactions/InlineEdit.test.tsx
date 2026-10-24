// The shared in-place editor: Enter, Tab and Shift+Tab keep the text and say how; Escape puts it back; a click
// away keeps it (F4, F5); each way out is one commit, never two.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import InlineEdit from "./InlineEdit";

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof InlineEdit>[0]> = {}) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const onParentKey = vi.fn();
  const utils = render(
    <div onKeyDown={onParentKey}>
      <InlineEdit value="email" label="Column name" onCommit={onCommit} onCancel={onCancel} {...props} />
      <button type="button">elsewhere</button>
    </div>,
  );
  const field = screen.getByRole("textbox", { name: "Column name" }) as HTMLInputElement;
  return { ...utils, field, onCommit, onCancel, onParentKey };
}

test("opens focused on the shape with its text selected", () => {
  const s = setup();
  expect(document.activeElement).toBe(s.field);
  expect([s.field.selectionStart, s.field.selectionEnd]).toEqual([0, 5]);
});

test("enter, tab and shift tab keep the trimmed text and say how, once", async () => {
  for (const [key, how] of [
    ["{Enter}", "enter"],
    ["{Tab}", "tab"],
    ["{Shift>}{Tab}{/Shift}", "shifttab"],
  ] as const) {
    const s = setup();
    await userEvent.type(s.field, ` mail ${key}`, { initialSelectionStart: 0, initialSelectionEnd: 5 });
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    expect(s.onCommit).toHaveBeenCalledWith("mail", how);
    // The field going away (or focus moving) is not a second commit.
    fireEvent.blur(s.field);
    expect(s.onCommit).toHaveBeenCalledTimes(1);
    // The canvas never sees the keys typed into the field.
    expect(s.onParentKey).not.toHaveBeenCalled();
    cleanup();
  }
});

test("a click away keeps what was typed (F4)", async () => {
  const s = setup();
  await userEvent.clear(s.field);
  await userEvent.type(s.field, "contact");
  await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));
  expect(s.onCommit).toHaveBeenCalledWith("contact", "blur");
  expect(s.onCancel).not.toHaveBeenCalled();
});

test("escape puts it back and the blur after it keeps nothing", async () => {
  const s = setup();
  await userEvent.type(s.field, "contact{Escape}");
  expect(s.onCancel).toHaveBeenCalledTimes(1);
  fireEvent.blur(s.field);
  expect(s.onCommit).not.toHaveBeenCalled();
});

test("a refused commit shows its reason under the field, which stays live", async () => {
  const s = setup({ error: "email is already a column of customers." });
  expect(screen.getByRole("alert").textContent).toBe("email is already a column of customers.");
  expect(s.field.getAttribute("aria-invalid")).toBe("true");
  await userEvent.type(s.field, "{Enter}");
  expect(s.onCommit).toHaveBeenCalledTimes(1);
  s.rerender(
    <div>
      <InlineEdit value="email" label="Column name" onCommit={s.onCommit} onCancel={s.onCancel} error="Use letters, digits and _ only." />
    </div>,
  );
  await userEvent.type(s.field, "x{Enter}");
  expect(s.onCommit).toHaveBeenCalledTimes(2);
});

test("Enter again on a field still showing the same reason commits again (I1)", async () => {
  const s = setup({ error: "Done is already used." });
  await userEvent.type(s.field, "{Enter}");
  await userEvent.type(s.field, "{Enter}");
  expect(s.onCommit).toHaveBeenCalledTimes(2);
});

test("keys that confirm or cancel an IME candidate never leave the field, WebKit's keyCode 229 included (M1)", () => {
  const s = setup();
  fireEvent.keyDown(s.field, { key: "Enter", isComposing: true });
  fireEvent.keyDown(s.field, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(s.field, { key: "Tab", keyCode: 229 });
  fireEvent.keyDown(s.field, { key: "Escape", isComposing: true });
  fireEvent.keyDown(s.field, { key: "Escape", keyCode: 229 });
  expect(s.onCommit).not.toHaveBeenCalled();
  expect(s.onCancel).not.toHaveBeenCalled();
  fireEvent.keyDown(s.field, { key: "Enter" });
  expect(s.onCommit).toHaveBeenCalledWith("email", "enter");
});
