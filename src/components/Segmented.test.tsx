import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import Segmented from "./Segmented";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

test("arrows_move_and_choose", async () => {
  const onChange = vi.fn();
  render(<Segmented value="a" options={OPTIONS} onChange={onChange} label="Letter" />);
  screen.getByRole("radio", { name: "Alpha" }).focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onChange).toHaveBeenLastCalledWith("b");
  await userEvent.keyboard("{ArrowLeft}");
  expect(onChange).toHaveBeenLastCalledWith("c");
});

test("radiogroup_names_the_options", () => {
  render(<Segmented value="b" options={OPTIONS} onChange={() => {}} label="Letter" />);
  const group = screen.getByRole("radiogroup", { name: "Letter" });
  expect(group).toBeTruthy();
  expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
});

test("an_option_title_is_on_its_radio", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta", disabled: true, title: "Select a beta first." },
  ];
  render(<Segmented value="a" options={options} onChange={() => {}} label="Letter" />);
  expect(screen.getByRole("radio", { name: "Beta" }).getAttribute("title")).toBe("Select a beta first.");
  expect(screen.getByRole("radio", { name: "Alpha" }).hasAttribute("title")).toBe(false);
});
