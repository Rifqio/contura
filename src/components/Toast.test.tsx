import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ToastProvider, useToast } from "./Toast";

type Show = ReturnType<typeof useToast>["show"];
let show: Show;

function Grab() {
  show = useToast().show;
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  render(
    <ToastProvider>
      <Grab />
    </ToastProvider>,
  );
});
afterEach(() => vi.useRealTimers());

test("info_stays_4s_success_3s_error_until_closed", () => {
  act(() => show({ kind: "info", text: "Info" }));
  act(() => void vi.advanceTimersByTime(3999));
  expect(screen.queryByText("Info")).not.toBeNull();
  act(() => void vi.advanceTimersByTime(1));
  expect(screen.queryByText("Info")).toBeNull();

  act(() => show({ kind: "success", text: "Done" }));
  act(() => void vi.advanceTimersByTime(2999));
  expect(screen.queryByText("Done")).not.toBeNull();
  act(() => void vi.advanceTimersByTime(1));
  expect(screen.queryByText("Done")).toBeNull();

  act(() => show({ kind: "readOnly", text: "Locked" }));
  act(() => void vi.advanceTimersByTime(4000));
  expect(screen.queryByText("Locked")).toBeNull();

  act(() => show({ kind: "error", text: "Broken" }));
  act(() => void vi.advanceTimersByTime(60000));
  expect(screen.queryByText("Broken")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText("Broken")).toBeNull();
});

test("a_new_toast_replaces_the_old", () => {
  act(() => show({ kind: "info", text: "First" }));
  act(() => show({ kind: "success", text: "Second" }));
  expect(screen.queryByText("First")).toBeNull();
  expect(screen.queryByText("Second")).not.toBeNull();
  expect(screen.getAllByRole("status")).toHaveLength(1);
});

test("action_runs_and_closes", () => {
  const run = vi.fn();
  act(() => show({ kind: "info", text: "Moved", action: { label: "Undo", run } }));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(run).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Moved")).toBeNull();
});

test("an_action_that_shows_a_toast_keeps_it", () => {
  const run = () => show({ kind: "success", text: "Undone" });
  act(() => show({ kind: "info", text: "Moved", action: { label: "Undo", run } }));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.queryByText("Undone")).not.toBeNull();
});

test("a_replacing_toast_gets_its_own_full_time", () => {
  act(() => show({ kind: "info", text: "First" }));
  act(() => void vi.advanceTimersByTime(3000));
  act(() => show({ kind: "success", text: "Second" }));
  act(() => void vi.advanceTimersByTime(2000));
  expect(screen.queryByText("Second")).not.toBeNull();
});

test("close_button_has_a_name", () => {
  act(() => show({ kind: "info", text: "Hello" }));
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
});

test("error_is_an_alert", () => {
  act(() => show({ kind: "error", text: "Nope" }));
  expect(screen.getByRole("alert").textContent).toContain("Nope");
  expect(screen.queryByRole("status")).toBeNull();
});
