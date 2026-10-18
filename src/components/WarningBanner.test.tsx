import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import WarningBanner from "./WarningBanner";

test("renders_an_alert_with_the_warning_icon_text_and_action", () => {
  render(
    <WarningBanner className="extra" action={<button type="button">Add WHERE</button>}>
      Careful with this.
    </WarningBanner>,
  );
  const banner = screen.getByRole("alert");
  expect(banner.className).toContain("warning-banner");
  expect(banner.className).toContain("extra");
  expect(banner.querySelector("svg")).toBeTruthy();
  expect(banner.textContent).toContain("Careful with this.");
  expect(screen.getByRole("button", { name: "Add WHERE" })).toBeTruthy();
});

test("renders_without_an_action", () => {
  render(<WarningBanner>Only text.</WarningBanner>);
  expect(screen.getByRole("alert").querySelector("button")).toBeNull();
});
