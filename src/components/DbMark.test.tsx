import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import DbMark from "./DbMark";
import Icon, { iconElement } from "./Icon";

test("each_dialect_has_a_named_mark", () => {
  render(
    <>
      <DbMark dialect="mysql" open />
      <DbMark dialect="postgres" open />
      <DbMark dialect="sqlite" open />
    </>,
  );
  for (const name of ["MySQL", "PostgreSQL", "SQLite"]) expect(screen.getByRole("img", { name })).toBeTruthy();
});

test("open_uses_the_brand_colour_and_closed_goes_faint", () => {
  const { rerender } = render(<DbMark dialect="postgres" open />);
  expect(screen.getByRole("img", { name: "PostgreSQL" }).getAttribute("style")).toContain("var(--db-pg)");
  rerender(<DbMark dialect="postgres" open={false} />);
  expect(screen.getByRole("img", { name: "PostgreSQL" }).getAttribute("style")).toContain("var(--c-text-faint)");
});

test("mysql_is_cropped_to_the_dolphin", () => {
  render(<DbMark dialect="mysql" open />);
  const svg = screen.getByRole("img", { name: "MySQL" });
  expect(svg.getAttribute("viewBox")).toBe("13.1 -0.3 11.2 13.05");
  expect(svg.getAttribute("stroke-width")).toBe(".5");
});

test("label_null_hides_the_mark_from_assistive_tech", () => {
  const { container } = render(<DbMark dialect="sqlite" open label={null} />);
  const svg = container.querySelector("svg")!;
  expect(svg.getAttribute("aria-hidden")).toBe("true");
  expect(svg.getAttribute("role")).toBeNull();
});

test("icon_stroke_follows_size", () => {
  const { container, rerender } = render(<Icon name="check" size={14} />);
  expect(container.querySelector("svg")!.getAttribute("stroke-width")).toBe("1.75");
  rerender(<Icon name="check" />);
  expect(container.querySelector("svg")!.getAttribute("stroke-width")).toBe("1.5");
  expect(iconElement("check", 14).getAttribute("stroke-width")).toBe("1.75");
});
