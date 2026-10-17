import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import ThemeSwitch, { ThemeMenu } from "./ThemeSwitch";

test("theme_switch_offers_three_choices_and_marks_the_current_one", async () => {
  const onChange = vi.fn();
  render(<ThemeSwitch value="dark" onChange={onChange} />);
  const group = screen.getByRole("radiogroup", { name: "Theme" });
  const radios = Array.from(group.querySelectorAll("[role=radio]")).map((r) => r.getAttribute("aria-label") ?? r.textContent);
  expect(radios).toEqual(["System", "Alucard", "Dracula"]);
  expect(screen.getByRole("radio", { name: "Dracula" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("false");
  await userEvent.click(screen.getByRole("radio", { name: "System" }));
  expect(onChange).toHaveBeenCalledWith("system");
});

test("theme_menu_lists_the_three_themes_and_marks_the_current_one", async () => {
  const onChange = vi.fn();
  render(<ThemeMenu value="light" onChange={onChange} />);
  await userEvent.click(screen.getByRole("button", { name: "Theme" }));
  expect(screen.getAllByRole("menuitem").map((m) => m.getAttribute("aria-label"))).toEqual(["Dracula", "Alucard", "Follow Windows"]);
  expect(screen.getByRole("menuitem", { name: "Alucard" }).getAttribute("aria-current")).toBe("true");
  await userEvent.click(screen.getByRole("menuitem", { name: "Dracula" }));
  expect(onChange).toHaveBeenCalledWith("dark");
});

test("arrow_keys_move_the_theme_choice", async () => {
  const onChange = vi.fn();
  render(<ThemeSwitch value="light" onChange={onChange} />);
  screen.getByRole("radio", { name: "Alucard" }).focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenLastCalledWith("dark");
  screen.getByRole("radio", { name: "Alucard" }).focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(onChange).toHaveBeenLastCalledWith("system");
});
