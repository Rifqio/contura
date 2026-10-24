import { expect, test } from "vitest";
import { FuzzyScorer, foldCase, fuzzyMatch, highlightParts, isWordStart } from "./fuzzy";

test("letters_must_come_in_order", () => {
  expect(fuzzyMatch("inv", "invoices")).not.toBeNull();
  expect(fuzzyMatch("vni", "invoices")).toBeNull();
  expect(fuzzyMatch("invoicesx", "invoices")).toBeNull();
  // An empty query matches everything with no letters marked.
  expect(fuzzyMatch("", "orders")).toEqual({ score: 0, positions: [] });
});

test("matching_ignores_case", () => {
  expect(fuzzyMatch("ord", "Orders")?.positions).toEqual([0, 1, 2]);
});

test("consecutive_letters_score_above_scattered_word_starts", () => {
  const run = fuzzyMatch("abc", "abc_x")!;
  const scattered = fuzzyMatch("abc", "a_b_c")!;
  expect(run.score).toBeGreaterThan(scattered.score);
});

test("a_match_at_a_word_start_scores_above_one_inside_a_word", () => {
  expect(fuzzyMatch("inv", "open_invoices")!.score).toBeGreaterThan(fuzzyMatch("inv", "reinvest")!.score);
  // The marked letters are the run at the word start, not the first letters found.
  expect(fuzzyMatch("inv", "open_invoices")!.positions).toEqual([5, 6, 7]);
});

test("letters_in_the_name_score_above_letters_in_the_schema", () => {
  // `nameFrom` is where the name starts in "schema.name".
  const inName = fuzzyMatch("inv", "billing.invoices", 8)!;
  expect(inName.positions).toEqual([8, 9, 10]);
  const sameName = fuzzyMatch("inv", "invoices", 0)!;
  expect(inName.score).toBeCloseTo(sameName.score);
});

test("a_dotted_query_marks_the_schema_and_the_name", () => {
  const m = fuzzyMatch("billing.inv", "billing.invoices", 8)!;
  expect(m.positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("highlight_parts_join_runs_of_marked_and_plain_letters", () => {
  expect(highlightParts("invoices", 0, [0, 1, 2])).toEqual([
    { text: "inv", hit: true },
    { text: "oices", hit: false },
  ]);
  // Positions count from the start of the whole target; `offset` is where this text starts in it.
  expect(highlightParts("invoices", 8, [0, 8, 10])).toEqual([
    { text: "i", hit: true },
    { text: "n", hit: false },
    { text: "v", hit: true },
    { text: "oices", hit: false },
  ]);
  expect(highlightParts("", 0, [])).toEqual([]);
});

test("a_long_name_matches_in_time", () => {
  const name = "x".repeat(400) + "abc";
  const start = performance.now();
  for (let i = 0; i < 200; i++) fuzzyMatch("xxabc", name);
  expect(fuzzyMatch("xxabc", name)!.positions.slice(-3)).toEqual([400, 401, 402]);
  // Linear in the name per letter: well under a second for 200 runs.
  expect(performance.now() - start).toBeLessThan(1000);
});

test("letters_whose_lower_case_is_longer_keep_their_place", () => {
  // "İ" lowers to two code units; the marks must still land on the name's own letters.
  const m = fuzzyMatch("log", "İndex_log")!;
  expect(m.positions).toEqual([6, 7, 8]);
  expect(highlightParts("İndex_log", 0, m.positions).filter((p) => p.hit).map((p) => p.text)).toEqual(["log"]);
});

test("the_scorer_gives_fuzzy_matchs_score_without_positions", () => {
  const scorer = new FuzzyScorer();
  const cases: [string, string, number][] = [
    ["inv", "billing.invoices", 8],
    ["inv", "open_invoices", 0],
    ["abc", "a_b_c", 0],
    ["billing.inv", "billing.invoices", 8],
    ["ordtot", "public.order_totals", 7],
    ["xyz", "orders", 0],
    ["ordersx", "orders", 0],
  ];
  for (const [q, target, from] of cases) {
    const starts = Uint8Array.from({ length: target.length }, (_, j) => (isWordStart(target, j) ? 1 : 0));
    const want = fuzzyMatch(q, target, from);
    const got = scorer.score(q, foldCase(target), starts, 0, from);
    if (want === null) expect(got).toBeNaN();
    else expect(got).toBeCloseTo(want.score, 10);
  }
});
