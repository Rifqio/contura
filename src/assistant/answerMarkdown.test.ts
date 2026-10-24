import { expect, test } from "vitest";
import shared from "../../crates/contura-core/tests/fixtures/ai/answer_fences.json";
import { type Block, createAnswerParser, parseAnswer, parseCost, plainText } from "./answerMarkdown";

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

test("headings_one_to_three_are_their_own_blocks", () => {
  const t = (text: string) => ({ kind: "text" as const, text });
  expect(parseAnswer("To combine:\n### Example – Get **every** order\nThen this.")).toEqual([
    { kind: "para", inlines: [t("To combine:")] },
    { kind: "heading", level: 3, inlines: [t("Example – Get "), { kind: "bold", text: "every" }, t(" order")] },
    { kind: "para", inlines: [t("Then this.")] },
  ]);
  expect(parseAnswer("# One\n## Two ##\n   ### Three")).toEqual([
    { kind: "heading", level: 1, inlines: [t("One")] },
    { kind: "heading", level: 2, inlines: [t("Two")] },
    { kind: "heading", level: 3, inlines: [t("Three")] },
  ]);
  // A heading ends a list; the next line starts a new paragraph.
  expect(parseAnswer("- a\n## Next\nb")).toEqual([
    { kind: "list", ordered: false, items: [[t("a")]] },
    { kind: "heading", level: 2, inlines: [t("Next")] },
    { kind: "para", inlines: [t("b")] },
  ]);
  // Deeper levels, no space, no text, four spaces of indent and a # inside a fence stay as they are.
  expect(parseAnswer("#### deep\n#nospace\n#\n    # four")).toEqual([{ kind: "para", inlines: [t("#### deep\n#nospace\n#\n    # four")] }]);
  expect(parseAnswer("```sql\n# a MySQL comment\nSELECT 1\n```")[0]).toMatchObject({ kind: "code", text: "# a MySQL comment\nSELECT 1" });
  expect(plainText("## Why\nIt **is**.")).toBe("Why It is.");
});

test("a_heading_streamed_in_chunks", () => {
  const p = createAnswerParser();
  const t = (text: string) => ({ kind: "text", text });
  expect(p.parse("Intro\n#")).toEqual([{ kind: "para", inlines: [t("Intro\n#")] }]);
  expect(p.parse("Intro\n### Exa")).toEqual([{ kind: "para", inlines: [t("Intro")] }, { kind: "heading", level: 3, inlines: [t("Exa")] }]);
  const heading = p.parse("Intro\n### Example **one**\n")[1];
  expect(heading).toEqual({ kind: "heading", level: 3, inlines: [t("Example "), { kind: "bold", text: "one" }] });
  // Once its line ends the heading is finished: the same object while the next paragraph streams.
  const next = p.parse("Intro\n### Example **one**\nSELECT the rows");
  expect(next[1]).toBe(heading);
  expect(next[2]).toEqual({ kind: "para", inlines: [t("SELECT the rows")] });
});

const STREAMED = [
  "Add up **invoices**.total per `customer_id`.\nKeep the top 8.\n\n- first **one**\n* second\n  goes on `here`\n\n1. step one\n2. step `two`\n- switch\nafter list",
  "Try this:\n```sql\nSELECT 1;\n```\nThen\n\n````\nSELECT '```'\n```\n````\ntail **bold",
  "Hi\r\n  ```sql\r\nSELECT 1\r\n  ```\r\nok `a` b `c\nd` e **f\ng** h",
  "`x **b** y` and `unclosed **bold** done` `` ` **a*b** *",
  "para\n```\nopen fence\nstill open\n",
  "\n\n\nlead blanks\n\n\n",
  "1. one\n2) not\n3. three\n- other\n",
  "``` sql extra\nbody\n```  \n```inline``` text\n",
  // Lone CRs end lines too, and a CR at the end of a piece may turn into a CRLF.
  "Run:\r```sql\rSELECT 1; -- note\rDROP TABLE t;\r\n```\rdone **x\ry**\r\r- a\r- b\r",
  "To combine:\n### Example – Get **every** order\n```sql\nSELECT 1\n```\n## Why ##\n- a\n# Top `x`\nafter\n#### deep\n#nospace\n#   \n   ## indented\n    # four",
];

test("the_streaming_parser_matches_parse_answer_at_every_step", () => {
  for (const text of STREAMED) {
    for (const size of [1, 2, 3, 5, 7, 16, 1000]) {
      const p = createAnswerParser();
      for (let end = 0; end <= text.length; end = end === text.length ? end + 1 : Math.min(text.length, end + size)) {
        const now = text.slice(0, end);
        expect(p.parse(now), `${JSON.stringify(now)} in steps of ${size}`).toEqual(parseAnswer(now));
      }
    }
  }
});

test("the_streaming_parser_starts_over_on_a_text_that_does_not_extend_the_last", () => {
  const p = createAnswerParser();
  p.parse("first **answer**\n\nmore");
  expect(p.parse("another `one`")).toEqual(parseAnswer("another `one`"));
  expect(p.parse("")).toEqual([]);
});

test("the_streaming_parser_keeps_finished_blocks_as_the_same_objects", () => {
  const p = createAnswerParser();
  const first = p.parse("one **para**\n\nsecond");
  const next = p.parse("one **para**\n\nsecond and more");
  expect(next[0]).toBe(first[0]);
});

test("a_64_kb_answer_streamed_in_657_deltas_reads_far_less_than_reparsing_it", () => {
  // The audit's probe: one 64 KB paragraph in 657 deltas parsed the whole answer each time, 21.6 M characters.
  const words = "lorem ipsum dolor sit amet consectetur **adipiscing** elit `x` ";
  const answer = words.repeat(Math.ceil(65536 / words.length)).slice(0, 65536);
  const chunk = Math.ceil(65536 / 657);
  const p = createAnswerParser();
  const before = parseCost.chars;
  let last: Block[] = [];
  for (let i = chunk; i < answer.length + chunk; i += chunk) last = p.parse(answer.slice(0, i));
  const streamed = parseCost.chars - before;
  expect(last).toEqual(parseAnswer(answer));
  // Each delta reads about what it added: well under three times the answer, against 21.6 M before.
  expect(streamed).toBeLessThan(3 * 65536);
});

test("a lone CR is a line end, as in the editor and the Core's fences", () => {
  // Matches the Core's `a_lone_cr_is_a_line_end_as_in_the_editor`: the same fences, the same bodies.
  const code = parseAnswer("```sql\rSELECT 1\r```\r```sql\nSELECT 2\n```").filter((b) => b.kind === "code");
  expect(code.map((b) => (b.kind === "code" ? [b.fence, b.text] : null))).toEqual([
    [0, "SELECT 1"],
    [1, "SELECT 2"],
  ]);
  const [block] = parseAnswer("```sql\nSELECT 1; -- note\rDROP TABLE orders;\r\n```").filter((b) => b.kind === "code");
  expect(block.kind === "code" && block.text).toBe("SELECT 1; -- note\nDROP TABLE orders;");
});

test("fences match the Core's on the shared fixtures, parsed whole and streamed", () => {
  // crates/contura-core/tests/fixtures/ai/answer_fences.json, read by the Core's `fences_match_the_shared_fixtures`.
  for (const c of shared.fences) {
    const want = c.fences.map(([lang, text, closed]) => [lang, text, closed]);
    const got = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "code" ? [[b.lang, b.text, b.closed]] : []));
    expect(got(parseAnswer(c.answer)), c.name).toEqual(want);
    for (const size of [1, 3, 1000]) {
      const p = createAnswerParser();
      let last: Block[] = [];
      for (let end = 0; end <= c.answer.length; end = end === c.answer.length ? end + 1 : Math.min(c.answer.length, end + size)) last = p.parse(c.answer.slice(0, end));
      expect(got(last), `${c.name} in steps of ${size}`).toEqual(want);
    }
  }
});
