import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import Switch from "./Switch";

test("switch_toggles_with_space_and_click", async () => {
  const onChange = vi.fn();
  render(<Switch checked={false} onChange={onChange} label="Read-only" hint="Blocks every write" />);
  const sw = screen.getByRole("switch", { name: "Read-only" });
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(sw.getAttribute("aria-describedby")).toBeTruthy();
  await userEvent.click(sw);
  expect(onChange).toHaveBeenLastCalledWith(true);
  sw.focus();
  await userEvent.keyboard(" ");
  expect(onChange).toHaveBeenCalledTimes(2);
  await userEvent.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledTimes(3);
});

test("a disabled switch does not toggle and shows its note", async () => {
  const onChange = vi.fn();
  render(<Switch checked label="Production" disabled note="Overridden by Read-only" onChange={onChange} />);
  const sw = screen.getByRole("switch", { name: /Production/ }) as HTMLButtonElement;
  expect(sw.disabled).toBe(true);
  await userEvent.click(sw);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByText("Overridden by Read-only")).toBeTruthy();
});
