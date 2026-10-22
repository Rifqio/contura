import { expect, test } from "vitest";
import { parseAnswer } from "./answerMarkdown";

test("paragraphs_lists_bold_code", () => {
  const text = [
    "Add up **invoices**.total per `customer_id`.",
    "Keep the top 8.",
    "",
    "- first **one**",
    "* second",
    "",
    "1. step one",
    "2. step `two`",
  ].join("\n");
  expect(parseAnswer(text)).toEqual([
    {
      kind: "para",
      inlines: [
        { kind: "text", text: "Add up " },
        { kind: "bold", text: "invoices" },
        { kind: "text", text: ".total per " },
        { kind: "code", text: "customer_id" },
        { kind: "text", text: ".\nKeep the top 8." },
      ],
    },
    {
      kind: "list",
      ordered: false,
      items: [
        [
          { kind: "text", text: "first " },
          { kind: "bold", text: "one" },
        ],
        [{ kind: "text", text: "second" }],
      ],
    },
    {
      kind: "list",
      ordered: true,
      items: [
        [{ kind: "text", text: "step one" }],
        [
          { kind: "text", text: "step " },
          { kind: "code", text: "two" },
        ],
      ],
    },
  ]);
});

test("a_list_right_after_a_line_of_text_is_its_own_block", () => {
  expect(parseAnswer("Two ways:\n- a\n- b")).toEqual([
    { kind: "para", inlines: [{ kind: "text", text: "Two ways:" }] },
    { kind: "list", ordered: false, items: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]] },
  ]);
});

test("html_and_links_stay_text", () => {
  const text = "<b>x</b> and [a](https://x.io) and https://x.io ![img](https://x.io/i.png)";
  expect(parseAnswer(text)).toEqual([{ kind: "para", inlines: [{ kind: "text", text }] }]);
});

test("unclosed_bold_and_backticks_stay_text", () => {
  expect(parseAnswer("**half and `open")).toEqual([{ kind: "para", inlines: [{ kind: "text", text: "**half and `open" }] }]);
});

test("fence_indexes_match_core", () => {
  // The Core's fences_count_every_block: a dbml fence is fence 0, the four-backtick sql fence is fence 1.
  const answer = "```dbml\nTable t { id int }\n```\ntext\n````sql\nSELECT 1\n```\nSELECT 2\n````\n";
  const code = parseAnswer(answer).filter((b) => b.kind === "code");
  expect(code).toEqual([
    { kind: "code", lang: "dbml", text: "Table t { id int }", fence: 0, closed: true },
    { kind: "code", lang: "sql", text: "SELECT 1\n```\nSELECT 2", fence: 1, closed: true },
  ]);
  expect(parseAnswer(answer)[1]).toEqual({ kind: "para", inlines: [{ kind: "text", text: "text" }] });
});

test("an_unclosed_last_fence_runs_to_the_end", () => {
  expect(parseAnswer("Try\n```sql\nSELECT 1")).toEqual([
    { kind: "para", inlines: [{ kind: "text", text: "Try" }] },
    { kind: "code", lang: "sql", text: "SELECT 1", fence: 0, closed: false },
  ]);
});

test("four_backtick_fence", () => {
  const blocks = parseAnswer("````\nSELECT '```'\n```\n````");
  expect(blocks).toEqual([{ kind: "code", lang: null, text: "SELECT '```'\n```", fence: 0, closed: true }]);
});

test("a_line_with_backticks_after_the_opening_is_not_a_fence", () => {
  // The Core opens a fence only when nothing after the ticks holds another backtick.
  expect(parseAnswer("```inline``` text").every((b) => b.kind === "para")).toBe(true);
});

test("crlf_lines_and_indented_fences", () => {
  expect(parseAnswer("Hi\r\n  ```sql\r\nSELECT 1\r\n  ```\r\n")).toEqual([
    { kind: "para", inlines: [{ kind: "text", text: "Hi" }] },
    { kind: "code", lang: "sql", text: "SELECT 1", fence: 0, closed: true },
  ]);
});

test("untagged_sql_starts_match_the_core", async () => {
  const { looksLikeSql } = await import("./answerMarkdown");
  // The Core's SQL_STARTS has VALUES, TABLE and DESCRIBE; a MySQL # comment is skipped.
  for (const text of ["VALUES (1), (2)", "TABLE orders", "DESCRIBE orders", "# top orders\nSELECT 1"]) {
    expect(looksLikeSql({ lang: null, text })).toBe(true);
  }
  expect(looksLikeSql({ lang: null, text: "orders are slow" })).toBe(false);
});
