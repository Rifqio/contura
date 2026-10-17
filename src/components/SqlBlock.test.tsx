import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import SqlBlock from "./SqlBlock";

const texts = (c: HTMLElement) => Array.from(c.querySelectorAll(".sql-block-text")).map((e) => e.textContent);

test("keywords_and_strings_get_syntax_classes", () => {
  const { container } = render(<SqlBlock sql="SELECT 'a'" dialect="postgres" />);
  const spans = Array.from(container.querySelectorAll(".sql-block-text span[class]"));
  const kw = spans.find((s) => s.textContent === "SELECT");
  const str = spans.find((s) => s.textContent === "'a'");
  expect(kw).toBeTruthy();
  expect(str).toBeTruthy();
  expect(kw!.className).not.toBe(str!.className);
});

test("write_lines_get_the_prod_band", () => {
  const { container } = render(
    <SqlBlock sql={"SELECT 1;\nUPDATE t\nSET a = 1;"} dialect="mysql" marks={[{ firstLine: 2, lastLine: 3, tag: "writes", band: "prod" }]} />,
  );
  const lines = Array.from(container.querySelectorAll(".sql-block-line"));
  expect(lines.map((l) => l.classList.contains("sql-block-line-prod"))).toEqual([false, true, true]);
});

test("tags_sit_on_the_first_line_of_each_statement", () => {
  const { container } = render(
    <SqlBlock
      sql={"SELECT 1\nFROM t;\nDELETE FROM t;"}
      dialect="postgres"
      marks={[
        { firstLine: 1, lastLine: 2, tag: "reads" },
        { firstLine: 3, lastLine: 3, tag: "writes" },
      ]}
    />,
  );
  const lines = Array.from(container.querySelectorAll(".sql-block-line"));
  expect(lines.map((l) => l.querySelector(".sql-block-tag")?.textContent ?? null)).toEqual(["reads", null, "writes"]);
});

test("the_text_is_the_sql_unchanged_with_blank_lines_tabs_and_markup", () => {
  const odd = "a\n\n\tb <x> & 'y'";
  const { container } = render(<SqlBlock sql={odd} dialect="mysql" />);
  expect(texts(container).join("\n")).toBe(odd);
});

test("the_text_is_the_sql_unchanged", () => {
  const { container } = render(<SqlBlock sql="a != b AND c >= 1" dialect="sqlite" />);
  expect(texts(container).join("\n")).toBe("a != b AND c >= 1");
});
