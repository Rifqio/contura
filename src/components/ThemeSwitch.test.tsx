import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import ThemeSwitch, { shownTheme, ThemeToggle } from "./ThemeSwitch";

test("theme_switch_offers_three_choices_and_marks_the_current_one", async () => {
  const onChange = vi.fn();
  render(<ThemeSwitch value="dark" onChange={onChange} />);
  const group = screen.getByRole("radiogroup", { name: "Theme" });
  const radios = Array.from(group.querySelectorAll("[role=radio]")).map((r) => r.getAttribute("aria-label") ?? r.textContent);
  expect(radios).toEqual(["System", "Light", "Dark"]);
  expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("false");
  await userEvent.click(screen.getByRole("radio", { name: "System" }));
  expect(onChange).toHaveBeenCalledWith("system");
});

test("item_15_the_toggle_shows_a_moon_on_dark_and_a_sun_on_light", async () => {
  const onChange = vi.fn();
  const { rerender, container } = render(<ThemeToggle value="dark" onChange={onChange} />);
  await userEvent.click(screen.getByRole("button", { name: "Dark theme. Switch to Light" }));
  expect(onChange).toHaveBeenLastCalledWith("light");
  expect(container.querySelector(".theme-toggle-icon")?.getAttribute("data-icon")).toBe("moon");
  rerender(<ThemeToggle value="light" onChange={onChange} />);
  await userEvent.click(screen.getByRole("button", { name: "Light theme. Switch to Dark" }));
  expect(onChange).toHaveBeenLastCalledWith("dark");
  expect(container.querySelector(".theme-toggle-icon")?.getAttribute("data-icon")).toBe("sun");
  // No palette names anywhere.
  expect(container.textContent).not.toMatch(/Dracula|Alucard/);
});

test("following_windows_shows_what_windows_uses", () => {
  expect(shownTheme("system", true)).toBe("dark");
  expect(shownTheme("system", false)).toBe("light");
  expect(shownTheme("light", true)).toBe("light");
});

test("arrow_keys_move_the_theme_choice", async () => {
  const onChange = vi.fn();
  render(<ThemeSwitch value="light" onChange={onChange} />);
  screen.getByRole("radio", { name: "Light" }).focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenLastCalledWith("dark");
  screen.getByRole("radio", { name: "Light" }).focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(onChange).toHaveBeenLastCalledWith("system");
});
