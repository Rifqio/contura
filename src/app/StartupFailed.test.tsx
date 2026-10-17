import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import StartupFailed from "./StartupFailed";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
  }),
}));

describe("StartupFailed", () => {
  it("shows_the_message_and_try_again_calls_retry", async () => {
    const onRetry = vi.fn();
    render(<StartupFailed message="Could not read: disk" onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toContain("Could not read: disk");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
