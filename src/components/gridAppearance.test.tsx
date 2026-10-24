// The Appearance page's grid choices (Stripe every other row, Show NULL as) as every data grid draws them.
import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Cell } from "../api/types";
import { DEFAULT_UI_PREFS } from "../api/types";
import MappingTable from "../jobs/MappingTable";
import { setNullDisplay } from "../prefs/gridDisplay";
import { applyPrefs } from "../prefs/usePrefs";
import { cellText, toCsv } from "../query/ResultTools";
import appCss from "../styles/app.css?raw";
import tokensCss from "../styles/tokens.css?raw";
import ResultGrid from "./ResultGrid";
import { single } from "../grid/selection";

afterEach(() => act(() => setNullDisplay("null")));

const columns = [
  { name: "id", typeName: "int", numeric: true },
  { name: "shipped", typeName: "date", numeric: false },
];
const rows: Cell[][] = Array.from({ length: 6 }, (_, i) => [
  { t: "number", value: String(i + 1) },
  i % 2 ? { t: "null" } : { t: "text", value: "2026-10-23", truncated: false, totalBytes: 10 },
]);

const bodyRows = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row]"));

test("every_second_row_carries_the_stripe_class_by_its_number", () => {
  const { container } = render(<ResultGrid columns={columns} rows={rows} resetKey={1} label="Result" />);
  expect(bodyRows(container).map((r) => r.classList.contains("grid-row-alt"))).toEqual([false, true, false, true, false, true]);
});

test("paging_keeps_the_stripe_on_even_row_numbers", () => {
  // Rows 51 to 56: 52, 54 and 56 are striped, as they would be on one long page.
  const { container } = render(<ResultGrid columns={columns} rows={rows} resetKey={1} label="Result" firstRow={51} />);
  expect(bodyRows(container).map((r) => r.classList.contains("grid-row-alt"))).toEqual([false, true, false, true, false, true]);
});

test("the_selected_row_and_a_row_with_its_own_state_take_no_stripe", () => {
  const { container } = render(
    <ResultGrid
      columns={columns}
      rows={rows}
      resetKey={1}
      label="Result"
      selection={single({ r: 1, c: 0 })}
      onSelection={() => {}}
      rowClass={(r) => (r === 3 ? "row-added" : r === 5 ? "row-deleted" : undefined)}
    />,
  );
  const [, selected, , added, , deleted] = bodyRows(container);
  expect(selected.className).toBe("");
  expect(added.className).toBe("row-added");
  expect(deleted.className).toBe("row-deleted");
});

test("the_stripe_shows_only_with_the_setting_and_never_beats_hover_edits_or_new_rows", () => {
  const root = document.documentElement;
  applyPrefs(root, { ...DEFAULT_UI_PREFS, stripeRows: true });
  expect(root.hasAttribute("data-grid-stripes")).toBe(true);
  applyPrefs(root, { ...DEFAULT_UI_PREFS, stripeRows: false });
  expect(root.hasAttribute("data-grid-stripes")).toBe(false);
  // As specific as `.grid td` (the setting and the row class sit in :where), after it, and before hover.
  const css = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const stripe = css.indexOf(":where(:root[data-grid-stripes]) .grid :where(tr.grid-row-alt) td {");
  expect(stripe).toBeGreaterThan(css.indexOf("\n.grid td {"));
  expect(stripe).toBeLessThan(css.indexOf("\n.grid tr:hover td {"));
  for (const later of ["\n.grid td.cell-edited {", "\n.grid tr.row-added td {", "\n.grid tr.row-deleted td {"]) {
    expect(css.indexOf(later)).toBeGreaterThan(stripe);
  }
});

/** The relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The Light, Dark and follow-the-system palette blocks of tokens.css. */
const palettes = () =>
  [":root, .theme-light {", ':root[data-theme="dark"], .theme-dark {', ':root:not([data-theme="light"]) {'].map((selector) => {
    const at = tokensCss.indexOf(selector);
    return tokensCss.slice(at, tokensCss.indexOf("\n}", at));
  });
const tokenOf = (p: string) => (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`).exec(p)?.[1] ?? "";
const BODY_TEXT = ["c-text", "c-text-muted", "c-text-subtle", "c-syn-keyword", "c-syn-number"];

test("text_on_the_stripe_keeps_4_5_to_1_in_both_palettes", () => {
  for (const p of palettes()) {
    const token = tokenOf(p);
    const stripe = token("c-grid-stripe");
    expect(stripe).toMatch(/^#/);
    for (const text of BODY_TEXT) {
      expect(contrast(token(text), stripe), `${text} on ${stripe}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

/** The body of the rule whose selector is exactly `selector`, in `text` with comments removed. */
function ruleIn(text: string, selector: string): string {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no ${selector}`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

test("a_production_grid_keeps_its_wash_on_striped_rows", () => {
  // The stripe paints the cell's own stripe, which a Production pane makes a darker wash, never the neutral one.
  expect(ruleIn(appCss, ":where(:root[data-grid-stripes]) .grid :where(tr.grid-row-alt) td")).toMatch(/background:\s*var\(--grid-cell-stripe\);/);
  expect(tokensCss).toMatch(/--grid-cell-stripe:\s*var\(--c-grid-stripe\);/);
  const wash = ruleIn(appCss, ".prod-wash");
  expect(wash).toMatch(/--grid-cell-background:\s*var\(--c-prod-wash\);/);
  expect(wash).toMatch(/--grid-cell-stripe:\s*var\(--c-prod-wash-stripe\);/);
  for (const p of palettes()) {
    const token = tokenOf(p);
    const [surface, stripe, prod, prodStripe] = ["c-bg-surface", "c-grid-stripe", "c-prod-wash", "c-prod-wash-stripe"].map(token);
    expect(prodStripe, "the Production stripe").toMatch(/^#/);
    expect(prodStripe).not.toBe(stripe);
    // As far from the wash as the neutral stripe is from the surface, so it reads as a stripe and not a new colour.
    expect(Math.abs(contrast(prodStripe, prod) - contrast(stripe, surface))).toBeLessThan(0.05);
    // Still warm: red over blue, as the wash is.
    expect(parseInt(prodStripe.slice(1, 3), 16)).toBeGreaterThan(parseInt(prodStripe.slice(5, 7), 16));
    for (const text of BODY_TEXT) {
      expect(contrast(token(text), prodStripe), `${text} on ${prodStripe}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("with_stripes_null_and_row_numbers_read_at_4_5_to_1_on_every_row", () => {
  // Faint (DN 3.1's 3:1 role) falls to 3.5:1 on the Light stripe; with stripes on the grid draws both in subtle.
  expect(ruleIn(appCss, ".grid .row-number")).toMatch(/color:\s*var\(--grid-row-number-text\);/);
  expect(tokensCss).toMatch(/--grid-row-number-text:\s*var\(--c-text-faint\);/);
  const striped = ruleIn(tokensCss, ":root[data-grid-stripes]");
  expect(striped).toMatch(/--grid-cell-null-text:\s*var\(--c-text-subtle\);/);
  expect(striped).toMatch(/--grid-row-number-text:\s*var\(--c-text-subtle\);/);
  for (const p of palettes()) {
    const token = tokenOf(p);
    for (const bg of ["c-bg-surface", "c-grid-stripe", "c-prod-wash", "c-prod-wash-stripe"]) {
      expect(contrast(token("c-text-subtle"), token(bg)), `subtle on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("a_blank_null_says_null_when_the_cell_is_hovered", () => {
  // The blank mark has no size of its own, so the cell carries the tooltip.
  act(() => setNullDisplay("blank"));
  const { container } = render(<ResultGrid columns={columns} rows={rows.slice(0, 2)} resetKey={1} label="Result" />);
  const cell = container.querySelector(".cell-null")!.closest("td")!;
  expect(cell.title).toBe("NULL");
  // A cell with a value has no such tooltip.
  expect(container.querySelector<HTMLElement>('tr[data-row="0"] td[data-col="1"]')!.title).toBe("");
});

test("null_is_drawn_three_ways_and_always_reads_null", () => {
  const { container } = render(<ResultGrid columns={columns} rows={rows.slice(0, 2)} resetKey={1} label="Result" />);
  const nullCell = () => container.querySelector<HTMLElement>(".cell-null")!;
  expect(nullCell().textContent).toBe("NULL");

  act(() => setNullDisplay("symbol"));
  expect(nullCell().querySelector("[aria-hidden=true]")?.textContent).toBe("∅");
  expect(nullCell().querySelector(".visually-hidden")?.textContent).toBe("NULL");

  act(() => setNullDisplay("blank"));
  expect(nullCell().classList.contains("cell-null-blank")).toBe(true);
  expect(nullCell().querySelector("[aria-hidden=true]")).toBeNull();
  // Nothing shows, but a screen reader and a hover still say NULL, so it never passes for an empty string.
  expect(nullCell().querySelector(".visually-hidden")?.textContent).toBe("NULL");
  expect(nullCell().closest("td")!.title).toBe("NULL");
});

test("the_import_mapping_draws_null_the_same_way", () => {
  setNullDisplay("symbol");
  render(<MappingTable header={["a"]} first={[null]} mapping={[{ fileColumn: 0, into: null, byHand: false }]} targets={[]} onChange={() => {}} />);
  expect(screen.getByText("∅").closest(".import-null")).not.toBeNull();
  expect(screen.getByText("∅").closest("td")!.title).toBe("NULL");
});

test("copy_and_export_keep_real_null_whatever_the_grid_shows", () => {
  const csv = () => toCsv(columns, rows.slice(0, 2));
  const before = csv();
  for (const as of ["symbol", "blank", "null"] as const) {
    act(() => setNullDisplay(as));
    expect(cellText({ t: "null" })).toBe("");
    expect(csv()).toBe(before);
  }
  expect(before).toBe("id,shipped\r\n1,2026-10-23\r\n2,");
});

test("applying_prefs_sets_the_null_display_and_a_bad_value_reads_null", () => {
  const { container } = render(<ResultGrid columns={columns} rows={rows.slice(0, 2)} resetKey={1} label="Result" />);
  act(() => applyPrefs(document.documentElement, { ...DEFAULT_UI_PREFS, nullAs: "symbol" }));
  expect(container.querySelector(".cell-null [aria-hidden=true]")?.textContent).toBe("∅");
  act(() => applyPrefs(document.documentElement, { ...DEFAULT_UI_PREFS, nullAs: "dash" as never }));
  expect(container.querySelector(".cell-null")?.textContent).toBe("NULL");
});
