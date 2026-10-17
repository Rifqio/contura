import { expect, test } from "vitest";
import { guideX, treeGuides, type TreeLine } from "./treeGuides";

const lines: TreeLine[] = [
  { id: "db", level: 0 },
  { id: "tables", level: 1 },
  { id: "orders", level: 2 },
  { id: "stores", level: 2 },
  { id: "views", level: 1 },
  { id: "v", level: 2 },
];

const strong = (selected: string | null, rows = lines) => treeGuides(rows, selected).map((g) => g.strong);

test("guideX_sits_seven_pixels_into_each_level", () => {
  expect(guideX(0)).toBe(15);
  expect(guideX(2)).toBe(55);
});

test("a_row_draws_one_guide_per_ancestor_level", () => {
  const g = treeGuides(lines, null);
  expect(g[2].levels).toEqual([0, 1]);
  expect(g[0].levels).toEqual([]);
});

test("first_child_selected_strengthens_its_parents_block", () => {
  expect(strong("orders")).toEqual([null, null, 1, 1, null, null]);
});

test("last_child_selected_strengthens_the_same_block", () => {
  expect(strong("stores")).toEqual([null, null, 1, 1, null, null]);
});

test("a_nested_selection_strengthens_only_rows_under_its_parent", () => {
  const nested: TreeLine[] = [
    { id: "db", level: 0 },
    { id: "tables", level: 1 },
    { id: "orders", level: 2 },
    { id: "id", level: 3 },
    { id: "total", level: 3 },
    { id: "stores", level: 2 },
  ];
  expect(strong("total", nested)).toEqual([null, null, null, 2, 2, null]);
});

// db
// ├ tables
// │ ├ orders
// │ └ stores
// └ views
//   └ v
test("a_middle_child_keeps_its_parents_guide_going_and_draws_a_stub", () => {
  const orders = treeGuides(lines, null)[2];
  expect(orders.levels).toEqual([0, 1]);
  expect(orders.stub).toEqual({ level: 1, elbow: false, strong: false });
  expect(treeGuides(lines, null)[1].stub).toEqual({ level: 0, elbow: false, strong: false });
});

test("the_last_child_draws_an_elbow_and_no_guide_below_it", () => {
  const g = treeGuides(lines, null);
  const stores = g[3];
  expect(stores.stub).toEqual({ level: 1, elbow: true, strong: false });
  expect(stores.levels).toEqual([0]); // column 1 ends at the elbow
  expect(g[4].stub).toEqual({ level: 0, elbow: true, strong: false }); // views, the last child of db
  expect(g[0].stub).toBeNull();
});

test("a_row_under_a_last_child_has_no_line_in_that_ancestors_column", () => {
  const v = treeGuides(lines, null)[5];
  expect(v.levels).toEqual([]); // views was db's last child: column 0 is empty here
  expect(v.stub).toEqual({ level: 1, elbow: true, strong: false });
});

test("the_selected_block_stays_strong_and_the_selected_row_and_its_last_sibling_connect_strong", () => {
  const g = treeGuides(lines, "orders");
  expect(g.map((r) => r.strong)).toEqual([null, null, 1, 1, null, null]);
  expect(g[2].stub).toEqual({ level: 1, elbow: false, strong: true }); // the selected row's stub
  expect(g[3].stub).toEqual({ level: 1, elbow: true, strong: true }); // the block's last sibling: its elbow ends the strong guide
  expect(g[4].stub?.strong).toBe(false);
});

test("a_selection_that_is_not_listed_strengthens_nothing", () => {
  expect(strong("hidden")).toEqual([null, null, null, null, null, null]);
  expect(strong(null)).toEqual([null, null, null, null, null, null]);
});
