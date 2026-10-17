import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import CellEditor from "./CellEditor";

function setup(initial: string, multiline = false) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(<CellEditor initial={initial} multiline={multiline} onCommit={onCommit} onCancel={onCancel} />);
  return { box: screen.getByRole("textbox", { name: "Cell value" }) as HTMLTextAreaElement, onCommit, onCancel };
}

test("enter keeps the value and moves down, tab moves right", () => {
  const { box, onCommit } = setup("paid");
  expect(document.activeElement).toBe(box);
  fireEvent.change(box, { target: { value: "cancelled" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onCommit).toHaveBeenLastCalledWith("cancelled", "down");
  fireEvent.keyDown(box, { key: "Tab" });
  expect(onCommit).toHaveBeenLastCalledWith("cancelled", "right");
});

test("a multi-line value keeps enter for new lines and commits on ctrl+enter", () => {
  const { box, onCommit } = setup("line 1\nline 2", true);
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
  expect(onCommit).toHaveBeenCalledWith("line 1\nline 2", "none");
});

test("leaving the editor keeps the value once", () => {
  const { box, onCommit } = setup("paid");
  fireEvent.change(box, { target: { value: "lost" } });
  fireEvent.blur(box);
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenCalledWith("lost", "none", true);
});

test("escape cancels", () => {
  const { box, onCommit, onCancel } = setup("paid");
  fireEvent.keyDown(box, { key: "Escape" });
  expect(onCancel).toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
});
