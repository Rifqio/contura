import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import LaunchScreen from "./LaunchScreen";

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-18T10:00:00Z") }));
afterEach(() => vi.useRealTimers());

const LINE = "Loading your Groups and Connections...";

test("nothing_before_300ms", () => {
  render(<LaunchScreen step={0} startedAt={Date.now()} />);
  act(() => void vi.advanceTimersByTime(299));
  expect(screen.queryByText(LINE)).toBeNull();
});

test("line_after_300ms", () => {
  render(<LaunchScreen step={0} startedAt={Date.now()} />);
  act(() => void vi.advanceTimersByTime(300));
  expect(screen.getByText(LINE)).toBeTruthy();
  expect(screen.getByRole("status")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("after_2s_names_the_read_and_shows_progress", () => {
  render(<LaunchScreen step={2} startedAt={Date.now()} />);
  act(() => void vi.advanceTimersByTime(1999));
  expect(screen.queryByRole("progressbar")).toBeNull();
  act(() => void vi.advanceTimersByTime(1));
  expect(screen.getByText("Reading Connections from the data folder, 2 of 3")).toBeTruthy();
  const bar = screen.getByRole("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBe("2");
  expect(bar.getAttribute("aria-valuemax")).toBe("3");
});

test("the_bare_title_bar_lets_the_window_move_and_close_while_loading", () => {
  render(<LaunchScreen step={0} startedAt={Date.now()} />);
  expect(document.querySelector(".title-bar[data-tauri-drag-region]")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy();
  expect(document.querySelector(".app-status")).not.toBeNull();
});
