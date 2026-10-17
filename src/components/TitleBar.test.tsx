import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import Icon from "./Icon";
import TitleBar from "./TitleBar";

const win = vi.hoisted(() => ({
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  maximized: false,
  resized: null as null | (() => void),
  isMaximized: vi.fn(async () => win.maximized),
  onResized: vi.fn(async (h: () => void) => {
    win.resized = h;
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

test("window_buttons_minimize_maximize_and_close", async () => {
  render(
    <TitleBar>
      <span>tabs here</span>
    </TitleBar>,
  );
  const bar = screen.getByText("tabs here").closest(".title-bar") as HTMLElement;
  expect(bar.hasAttribute("data-tauri-drag-region")).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Minimize" }));
  expect(win.minimize).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Maximize" }));
  expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
  // Close asks the window to close, so the Pending Edits guard on close requests still runs.
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(win.close).toHaveBeenCalledTimes(1);
});

test("maximize_becomes_restore_while_the_window_is_maximized", async () => {
  win.maximized = true;
  render(<TitleBar>tabs</TitleBar>);
  const restore = await screen.findByRole("button", { name: "Restore" });
  expect(restore.getAttribute("title")).toBe("Restore");
  expect(screen.queryByRole("button", { name: "Maximize" })).toBeNull();
  win.maximized = false;
  await act(async () => win.resized?.());
  expect(await screen.findByRole("button", { name: "Maximize" })).toBeTruthy();
});

test("shows_the_contura_glyph", () => {
  render(<TitleBar>tabs</TitleBar>);
  const glyph = document.querySelector(".title-bar-glyph") as HTMLElement;
  expect(glyph.getAttribute("aria-hidden")).toBe("true");
  const { container } = render(<Icon name="contura" />);
  const contura = container.querySelector("path")?.getAttribute("d");
  expect(glyph.querySelector("svg.icon path")?.getAttribute("d")).toBe(contura);
});
