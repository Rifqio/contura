// The ER table card, draw-only (the window, B3 decision 7): the header, then one row per column with its key gutter, name, type and
// not-null mark; a weak table's border is dashed; past 20 columns the card stops growing and its rows scroll.
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { colourEnd, EdgeMarkers, hexArrowsIn, MANY_MARKER, ONE_MARKER } from "../diagram/edges";
import { parseFlow } from "../lang/flow/parse";
import canvasCss from "../styles/flow-canvas.css?raw";
import { buildFlowGraph } from "./flowNodes";
import { ER_CARD_CHROME, ER_MAX_ROWS, KIND_ROW, kindSize } from "./kindLayout";
import { KindNode, type KindNodeData } from "./kindNodes";

afterEach(cleanup);

const ORDERS: KindNodeData = {
  name: "orders",
  kind: "erTable",
  look: "modern",
  rows: ["id int", "customer_id int", "total numeric"],
  rowFlags: [["pk"], ["not null"], []],
};

const rows = () => [...document.querySelectorAll<HTMLElement>(".fkind-er-row")];

test("a_table_card_shows_its_columns", () => {
  render(<KindNode d={ORDERS} selected={false} />);
  expect(document.querySelector(".fkind-head .fnode-name")!.textContent).toBe("orders");
  expect(document.querySelector('[aria-label="Table orders"]')).not.toBeNull();
  expect(rows().map((r) => [r.querySelector(".fkind-col")!.textContent, r.querySelector(".fkind-type")!.textContent])).toEqual([
    ["id", "int"],
    ["customer_id", "int"],
    ["total", "numeric"],
  ]);
  // The key gutter marks row 0 only.
  expect(rows().map((r) => !!r.querySelector(".fkind-gut.is-pk .fkind-key"))).toEqual([true, false, false]);
  // A key or a not-null column has the filled diamond; a nullable one the outline.
  expect(rows().map((r) => r.querySelector(".fkind-nn")!.classList.contains("is-nn"))).toEqual([true, true, false]);
  // The mark is drawing only: the row's one description (its hover hint) says it.
  expect(rows().map((r) => r.querySelector(".fkind-nn")!.getAttribute("aria-hidden"))).toEqual(["true", "true", "true"]);
  expect(rows().map((r) => r.querySelector(".fkind-nn")!.hasAttribute("aria-description"))).toEqual([false, false, false]);
  expect(rows().map((r) => r.title)).toEqual(["id int (primary key, not null)", "customer_id int (not null)", "total numeric (nullable)"]);
  expect(rows().some((r) => r.hasAttribute("aria-description"))).toBe(false);
  // The header's name is its own text: no second description.
  expect(document.querySelector(".fkind-head .fnode-name")!.hasAttribute("aria-description")).toBe(false);
  // Draw-only: nothing on the card edits.
  expect(document.querySelector("button, input, textarea")).toBeNull();
});

test("a_weak_table_is_dashed", () => {
  render(<KindNode d={{ ...ORDERS, name: "order_lines", kind: "erWeak" }} selected={false} />);
  const shell = document.querySelector('[aria-label="Weak table order_lines"]')!;
  expect(shell.classList.contains("fnode-erWeak")).toBe(true);
  const rule = /\.fnode-erWeak\s*\{([^}]*)\}/.exec(canvasCss);
  expect(rule?.[1]).toContain("border-style: dashed");
});

test("past_twenty_columns_the_card_scrolls", () => {
  const many = Array.from({ length: 25 }, (_, i) => `c${i} int`);
  expect(kindSize("erTable", { name: "wide", rows: many })!.h).toBe(ER_CARD_CHROME + ER_MAX_ROWS * KIND_ROW);
  expect(kindSize("erTable", { name: "small", rows: ORDERS.rows })!.h).toBe(ER_CARD_CHROME + 3 * KIND_ROW);
  render(<KindNode d={{ ...ORDERS, name: "wide", rows: many, rowFlags: undefined }} selected={false} />);
  // The body scrolls them and takes the wheel; B3 decision 7: it draws only the rows in view and one past them,
  // with a spacer for the rest.
  // At scroll 0 the body's 446 px meet 21 rows (the last in part), and one more is drawn below.
  expect(rows()).toHaveLength(ER_MAX_ROWS + 2);
  expect(document.querySelector<HTMLElement>(".fkind-er-spacer")!.style.height).toBe(`${(25 - ER_MAX_ROWS - 2) * KIND_ROW}px`);
  const body = document.querySelector(".fkind-er-body")!;
  expect(body.classList.contains("is-scroll")).toBe(true);
  expect(body.classList.contains("nowheel")).toBe(true);
  cleanup();
  render(<KindNode d={ORDERS} selected={false} />);
  expect(document.querySelector(".fkind-er-body")!.classList.contains("is-scroll")).toBe(false);
});

test("rows_under_review_are_marked", () => {
  // The waiting proposal's marks on the rows, in the class and the row's hint; an unmarked row has none.
  render(<KindNode d={{ ...ORDERS, rowStates: ["changed", undefined, "removed"] }} selected={false} />);
  expect(rows().map((r) => ["is-ai-changed", "is-ai-removed", "is-ai-suggested"].filter((c) => r.classList.contains(c)))).toEqual([["is-ai-changed"], [], ["is-ai-removed"]]);
  expect(rows().map((r) => r.title)).toEqual(["id int (primary key, not null), changed by AI", "customer_id int (not null)", "total numeric (nullable), removal suggested by AI"]);
});

test("a_labelled_table_shows_its_label", () => {
  render(<KindNode d={{ ...ORDERS, shows: "Orders" }} selected={false} />);
  expect(document.querySelector(".fkind-head .fnode-name")!.textContent).toBe("Orders");
});

const LINKED = (colour: string) =>
  parseFlow(['diagram er "x"', "customers {", "  id int pk", "}", "orders {", "  id int pk", "  customer_id int", "}", `orders.customer_id > customers.id [color: ${colour}]`, "orders - customers"].join("\n")).doc!;

test("a_coloured_er_line_draws_its_crows_feet_in_its_colour", () => {
  const at = { customers: { x: 0, y: 0 }, orders: { x: 400, y: 0 } };
  const preset = buildFlowGraph(LINKED("danger"), at, "modern").edges;
  expect([preset[0].markerStart, preset[0].markerEnd]).toEqual([colourEnd(MANY_MARKER, "danger"), colourEnd(ONE_MARKER, "danger")]);
  // An uncoloured line keeps the plain ends.
  expect([preset[1].markerStart, preset[1].markerEnd]).toEqual([ONE_MARKER, ONE_MARKER]);
  const hex = buildFlowGraph(LINKED("#cc2200"), at, "modern").edges;
  expect([hex[0].markerStart, hex[0].markerEnd]).toEqual([colourEnd(MANY_MARKER, "#cc2200"), colourEnd(ONE_MARKER, "#cc2200")]);
  // The marker set defines each end it is asked for, in that colour.
  const hexes = hexArrowsIn(hex);
  expect(hexes).toEqual(["#cc2200"]);
  const { container } = render(<EdgeMarkers hexes={hexes} />);
  for (const id of [colourEnd(MANY_MARKER, "danger"), colourEnd(ONE_MARKER, "danger"), colourEnd(MANY_MARKER, "#cc2200"), colourEnd(ONE_MARKER, "#cc2200")]) {
    expect(container.querySelector(`marker[id="${id}"] path`), id).not.toBeNull();
  }
  expect(container.querySelector<SVGPathElement>(`marker[id="${colourEnd(MANY_MARKER, "#cc2200")}"] path`)!.style.stroke).toBe("rgb(204, 34, 0)");
});
