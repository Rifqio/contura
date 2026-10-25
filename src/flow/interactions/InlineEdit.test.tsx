// The shared in-place editor: Enter, Tab and Shift+Tab keep the text and say how; a click away keeps it (F4, F5);
// each way out is one commit, never two. Escape keeps the typed text and ends the edit (the user's decision of 25
// Oct, as draw.io, Miro and Figma): a new item still untouched or empty is dropped; a refused value stays open with
// its reason on the first Escape and is put back on the second, so typed text is never dropped silently.
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

test("escape keeps the typed text and ends the edit, and the blur after it is no second commit", async () => {
  const s = setup();
  await userEvent.type(s.field, "contact{Escape}", { initialSelectionStart: 0, initialSelectionEnd: 5 });
  expect(s.onCommit).toHaveBeenCalledTimes(1);
  expect(s.onCommit).toHaveBeenCalledWith("contact", "escape");
  fireEvent.blur(s.field);
  expect(s.onCommit).toHaveBeenCalledTimes(1);
  expect(s.onCancel).not.toHaveBeenCalled();
  expect(s.onParentKey).not.toHaveBeenCalled();
});

test("escape on a new item still untouched, or emptied, drops it", async () => {
  const s = setup({ fresh: true });
  await userEvent.type(s.field, "{Escape}");
  expect(s.onCancel).toHaveBeenCalledTimes(1);
  expect(s.onCommit).not.toHaveBeenCalled();
  cleanup();
  const t = setup({ fresh: true });
  await userEvent.clear(t.field);
  await userEvent.type(t.field, "{Escape}");
  expect(t.onCancel).toHaveBeenCalledTimes(1);
  cleanup();
  // Typed into, a new item is kept.
  const u = setup({ fresh: true });
  await userEvent.type(u.field, "Ship{Escape}", { initialSelectionStart: 0, initialSelectionEnd: 5 });
  expect(u.onCommit).toHaveBeenCalledWith("Ship", "escape");
  expect(u.onCancel).not.toHaveBeenCalled();
});

test("a refused value: the first escape keeps the field open with its reason, the second puts the old value back", async () => {
  const s = setup();
  await userEvent.type(s.field, "x{Escape}");
  expect(s.onCommit).toHaveBeenCalledWith("emailx", "escape");
  // The caller refuses it: the reason shows and the field stays.
  s.rerender(
    <div onKeyDown={s.onParentKey}>
      <InlineEdit value="email" label="Column name" onCommit={s.onCommit} onCancel={s.onCancel} error="emailx is already used." errorKey={1} />
    </div>,
  );
  expect(screen.getByRole("alert").textContent).toBe("emailx is already used.");
  expect(s.onCancel).not.toHaveBeenCalled();
  await userEvent.type(s.field, "{Escape}");
  expect(s.onCancel).toHaveBeenCalledTimes(1);
  expect(s.onCommit).toHaveBeenCalledTimes(1);
});

test("typing after a refusal makes the next escape a fresh try", async () => {
  const s = setup({ error: "email is already used.", errorKey: 1 });
  await userEvent.type(s.field, "2{Escape}");
  expect(s.onCommit).toHaveBeenCalledWith("email2", "escape");
  expect(s.onCancel).not.toHaveBeenCalled();
});

test("multi-line: Shift+Enter starts a new line, Enter keeps both lines", async () => {
  const s = render(<InlineEdit value="Check" label="Name" multiline onCommit={vi.fn()} onCancel={vi.fn()} />);
  const commit = vi.fn();
  s.rerender(<InlineEdit value="Check" label="Name" multiline onCommit={commit} onCancel={vi.fn()} />);
  const field = screen.getByRole("textbox", { name: "Name" }) as HTMLTextAreaElement;
  expect(field.tagName).toBe("TEXTAREA");
  await userEvent.type(field, "{End}{Shift>}{Enter}{/Shift}stock{Enter}");
  expect(commit).toHaveBeenCalledWith("Check\nstock", "enter");
});

test("single line: Shift+Enter keeps one line and says why", async () => {
  const commit = vi.fn();
  render(<InlineEdit value="App" label="Name" oneLine="A sequence name stays on one line." onCommit={commit} onCancel={vi.fn()} />);
  const field = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
  await userEvent.type(field, "{End}{Shift>}{Enter}{/Shift}");
  expect(commit).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toBe("A sequence name stays on one line.");
  expect(field.value).toBe("App");
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
