import { expect, test } from "vitest";
import { ICON_LOOKUP_BUDGET, parseFlow } from "./parse";
import { createFlowService } from "./service";

const CLOUD = ['diagram cloud "Order API"', "Orders [icon: aws-dynamdb]", "Assets [icon: aws-s3]", ""].join("\n");

test("the_unknown_icon_problem_runs_once_the_icon_list_is_sent", () => {
  const flow = createFlowService();
  // Before the list arrives nothing is checked, so nothing is wrongly called unknown.
  expect(flow.parse("a", CLOUD).problems).toEqual([]);
  flow.setIcons(["aws-dynamodb", "aws-s3", "users"]);
  const r = flow.parse("a", CLOUD);
  expect(r.problems.map((p) => [p.line, p.severity, p.message])).toEqual([[2, "hint", "aws-dynamdb is not an icon. Did you mean aws-dynamodb?"]]);
  expect(r.problems[0].fixes.map((f) => f.title)).toEqual(["Use aws-dynamodb"]);
  // A hint keeps the drawing.
  expect(r.doc).not.toBeNull();
});

test("only_a_cloud_diagram_checks_its_icons", () => {
  const flow = createFlowService();
  flow.setIcons(["aws-s3"]);
  expect(flow.parse("a", 'diagram dfd "x"\nA [process, icon: nope]\n').problems.filter((p) => p.message.includes("not an icon"))).toEqual([]);
});

test("a_misspelt_icon_is_compared_with_the_list_once", () => {
  const flow = createFlowService();
  const names = Array.from({ length: 4000 }, (_, i) => `aws-icon-${i}`);
  flow.setIcons([...names, "aws-dynamodb"]);
  const many = ['diagram cloud "x"', ...Array.from({ length: 2000 }, (_, i) => `N${i} [icon: aws-dynamdb]`), ""].join("\n");
  const r = flow.parse("a", many);
  expect(r.problems.length).toBeGreaterThan(0);
  expect(r.problems[0].message).toBe("aws-dynamdb is not an icon. Did you mean aws-dynamodb?");
});

/** An icon set that counts how many names the parser reads from it. */
function countingIcons(names: string[]) {
  const set = new Set(names);
  const counter = { reads: 0 };
  const icons = {
    has: (n: string) => set.has(n),
    size: set.size,
    *[Symbol.iterator]() {
      for (const n of set) {
        counter.reads++;
        yield n;
      }
    },
  } as unknown as ReadonlySet<string>;
  return { icons, counter };
}

test("unknown_icon_lookups_have_a_per_parse_budget", () => {
  const names = Array.from({ length: 4000 }, (_, i) => `aws-icon-${i}`);
  const { icons, counter } = countingIcons(names);
  // A pasted diagram with 3,000 different foreign icon names.
  const text = ['diagram cloud "x"', ...Array.from({ length: 3000 }, (_, i) => `N${i} [icon: other-${i}]`), ""].join("\n");
  const iconNear = new Map<string, string | null>();
  const first = parseFlow(text, { icons, iconNear });
  // Every unknown name is still a hint; only the "Did you mean" search is limited.
  expect(first.problems.filter((p) => p.message.includes("is not an icon")).length).toBeGreaterThan(0);
  expect(counter.reads).toBeLessThanOrEqual(ICON_LOOKUP_BUDGET + names.length);
  // The next parse looks up the next names; the ones already known cost nothing.
  counter.reads = 0;
  parseFlow(text, { icons, iconNear });
  expect(counter.reads).toBeLessThanOrEqual(ICON_LOOKUP_BUDGET + names.length);
  expect(iconNear.size).toBeGreaterThan(0);
  // Past the budget the hint has no suggestion.
  expect(first.problems.some((p) => p.message === "other-150 is not an icon.")).toBe(true);
});

test("the_misspelling_cache_drops_its_oldest_entry_not_everything", () => {
  const { icons, counter } = countingIcons(["aws-s3"]);
  const iconNear = new Map<string, string | null>();
  for (let i = 0; i < 2001; i++) iconNear.set(`old-${i}`, null);
  iconNear.delete("old-2000");
  parseFlow('diagram cloud "x"\nA [icon: nope]\n', { icons, iconNear });
  expect(iconNear.has("nope")).toBe(true);
  expect(iconNear.has("old-1")).toBe(true);
  expect(iconNear.size).toBeLessThanOrEqual(2000);
  expect(counter.reads).toBe(1);
});
