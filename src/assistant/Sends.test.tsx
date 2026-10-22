import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { AiAccess, ContextInfo, Preview, PreviewItem } from "../api/types";
import { iconElement } from "../components/Icon";
import Sends from "./Sends";

const EXACT = "<context>\nTable orders(id bigint pk)\n</context>\n\nwhy slow?  ";

const preview = (over: Partial<Preview> = {}): Preview => ({
  items: [
    { kind: "cards", label: "Schema · 3 tables", bytes: 2355, tokens: 589, locked: null, on: true },
    { kind: "sql", label: "Query text", bytes: 0, tokens: 0, locked: "Shop shares schema only", on: false },
  ],
  tables: { full: ["orders", "stores"], namesOnly: ["items"], leftOut: [], reasons: [] },
  totalBytes: 12_345,
  tokens: 3_087,
  exact: EXACT,
  notes: [],
  log: [],
  context: null,
  ...over,
});

test("renders_one_row_per_item_with_size_and_lock_reason", () => {
  render(<Sends preview={preview()} header="To api.groq.com (m)" onToggle={() => {}} />);
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Schema · 3 tables");
  expect(rows[0].textContent).toContain("2.3 KB");
  expect(rows[0].textContent).toContain("589 tokens");
  expect(rows[1].textContent).toContain("Query text");
  expect(rows[1].textContent).toContain("Shop shares schema only");
  expect(screen.getByRole("button", { name: /^Query text/ }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("12.1 KB")).toBeTruthy();
});

test("the_tables_line_shows_only_when_the_budget_demoted_any", () => {
  const { unmount } = render(<Sends preview={preview()} header="h" onToggle={() => {}} />);
  expect(screen.getByText("2 full, 1 names only, 0 left out")).toBeTruthy();
  unmount();
  render(<Sends preview={preview({ tables: { full: ["orders"], namesOnly: [], leftOut: [], reasons: [] } })} header="h" onToggle={() => {}} />);
  expect(screen.queryByText(/names only/)).toBeNull();
});

test("show_exactly_reveals_the_exact_text_verbatim", async () => {
  const user = userEvent.setup();
  render(<Sends preview={preview()} header="To api.groq.com (m)" onToggle={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(document.querySelector("pre.payload")!.textContent).toBe(EXACT);
  expect(screen.getByText("To api.groq.com (m)")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Hide" }));
  expect(document.querySelector("pre.payload")).toBeNull();
});

test("an_unlocked_item_toggles_by_kind_and_a_locked_one_does_not", async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  render(<Sends preview={preview()} header="h" onToggle={onToggle} />);
  await user.click(screen.getByRole("button", { name: /^Schema · 3 tables/ }));
  await user.click(screen.getByRole("button", { name: /^Query text/ }));
  expect(onToggle.mock.calls).toEqual([["cards"]]);
});

test("notes_and_a_failed_preview_are_shown", () => {
  const { unmount } = render(
    <Sends preview={preview({ notes: ["The schema could not be read, so no tables are sent."] })} header="h" onToggle={() => {}} />,
  );
  expect(screen.getByText("The schema could not be read, so no tables are sent.")).toBeTruthy();
  unmount();
  render(<Sends preview={null} error="connection not open" header="h" onToggle={() => {}} />);
  expect(screen.getByText("connection not open")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Show exactly" }) as HTMLButtonElement).disabled).toBe(true);
});

// ---- 11c: the AI Context in the Sends list ----

const NOW = new Date(2026, 9, 20, 11, 42, 0).getTime();
const ctxInfo = (over: Partial<ContextInfo> = {}): ContextInfo => ({
  connectionId: "c1",
  database: "freight",
  schema: "public",
  sync: "automatic",
  builtAt: NOW - 3 * 60_000,
  tableCount: 6,
  stale: false,
  check: { kind: "match" },
  ...over,
});
const stg = { name: "freight-stg", access: "schemaQuery" as const };
const tipOf = () => document.querySelector(".sends-tip")?.textContent ?? null;

test("context_tip_per_state", () => {
  const cases: [ContextInfo | null, { name: string; access: AiAccess }, string | null][] = [
    [ctxInfo(), stg, "Context: freight-stg, 6 tables, synced 3m ago. It re-syncs on its own when the schema changes."],
    [ctxInfo({ sync: "manual", builtAt: NOW - 2 * 86_400_000 }), stg, "Context: freight-stg, 6 tables, synced 2d ago. It re-syncs only when you press Re-sync."],
    [ctxInfo({ stale: true, check: { kind: "stale" } }), stg, "The schema changed since the last sync. Re-sync to refresh the context."],
    [null, { name: "freight-prod", access: "never" }, "AI access on freight-prod is Never: only your question is sent."],
    [ctxInfo({ builtAt: null, tableCount: 0, check: { kind: "missing" } }), stg, "Context: freight-stg, not built yet."],
  ];
  for (const [context, connection, tip] of cases) {
    const { unmount } = render(<Sends preview={preview({ context })} connection={connection} now={NOW} header="h" onToggle={() => {}} />);
    expect(tipOf()).toBe(tip);
    unmount();
  }
  // No tip without a Connection, nor in the inline box.
  const { unmount } = render(<Sends preview={preview({ context: ctxInfo() })} connection={null} now={NOW} header="h" onToggle={() => {}} />);
  expect(tipOf()).toBeNull();
  unmount();
  render(<Sends preview={preview({ context: ctxInfo() })} connection={stg} withTip={false} now={NOW} header="h" onToggle={() => {}} />);
  expect(tipOf()).toBeNull();
});

test("manual_stale_shows_context_age", () => {
  const stale = ctxInfo({ sync: "manual", stale: true, check: { kind: "stale" }, builtAt: NOW - 2 * 86_400_000 });
  const { unmount } = render(<Sends preview={preview({ context: stale })} connection={stg} now={NOW} header="h" onToggle={() => {}} />);
  expect(document.querySelector(".sends-row")!.textContent).toContain("Context from 2d ago");
  unmount();
  // The inline box shows the age too, without the tip.
  const failed = ctxInfo({ check: { kind: "failed" }, builtAt: NOW - 12 * 60_000 });
  const second = render(<Sends preview={preview({ context: failed })} withTip={false} now={NOW} header="h" onToggle={() => {}} />);
  expect(document.querySelector(".sends-row")!.textContent).toContain("Context from 12m ago");
  second.unmount();
  render(<Sends preview={preview({ context: ctxInfo() })} connection={stg} now={NOW} header="h" onToggle={() => {}} />);
  expect(screen.queryByText(/Context from/)).toBeNull();
});

test("saved_queries_pill", async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  const items: PreviewItem[] = [
    { kind: "cards", label: "Schema · 6 tables", bytes: 2355, tokens: 589, locked: null, on: true },
    { kind: "savedQueries", label: "Saved queries · 2", bytes: 300, tokens: 75, locked: null, on: true },
  ];
  const { unmount } = render(<Sends preview={preview({ items })} header="h" onToggle={onToggle} />);
  const pill = screen.getByRole("button", { name: /^Saved queries · 2/ });
  expect(pill.querySelector("path")?.getAttribute("d")).toBe(iconElement("fileQuery").querySelector("path")?.getAttribute("d"));
  await user.click(pill);
  expect(onToggle.mock.calls).toEqual([["savedQueries"]]);
  unmount();
  const off: PreviewItem[] = [{ kind: "savedQueries", label: "Saved queries · 2", bytes: 0, tokens: 0, locked: null, on: false }];
  const second = render(<Sends preview={preview({ items: off })} header="h" onToggle={onToggle} />);
  expect(screen.getByRole("button", { name: /^Saved queries · 2 · off/ }).getAttribute("aria-pressed")).toBe("false");
  second.unmount();
  const locked: PreviewItem[] = [
    { kind: "savedQueries", label: "Saved queries", bytes: 0, tokens: 0, locked: "freight-stg shares schema only", on: false },
  ];
  render(<Sends preview={preview({ items: locked })} header="h" onToggle={onToggle} />);
  expect(screen.getByText("freight-stg shares schema only")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /^Saved queries/ }));
  expect(onToggle).toHaveBeenCalledTimes(1);
});

const OUTLINE_ITEM: PreviewItem = {
  kind: "outline",
  label: "+ 1 step: the assistant picks tables from an outline of 2,000 tables",
  bytes: 7146,
  tokens: 1832,
  locked: null,
  on: true,
};
const OUTLINE_EXACT = '{"area":"subscriptions","tables":4}';
const withOutline = (item: PreviewItem = OUTLINE_ITEM): Preview =>
  preview({ items: [...preview().items, item], outline: { tables: 2000, areas: 64, level: 3, exact: OUTLINE_EXACT } });

test("outline_row_toggles", async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  render(<Sends preview={withOutline()} header="h" onToggle={onToggle} />);
  const pill = screen.getByRole("button", { name: /^\+ 1 step: the assistant picks tables/ });
  expect(pill.querySelector("path")?.getAttribute("d")).toBe(iconElement("layers").querySelector("path")?.getAttribute("d"));
  expect(pill.closest("li")?.textContent).toContain("7 KB");
  expect(pill.closest("li")?.textContent).toContain("1,832 tokens");
  expect(pill.classList.contains("send-pill-tall")).toBe(true);
  expect(screen.getByRole("button", { name: /^Schema · 3 tables/ }).classList.contains("send-pill-tall")).toBe(false);
  await user.click(pill);
  expect(onToggle.mock.calls).toEqual([["outline"]]);
});

test("show_exactly_lists_the_outline_step", async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Sends preview={withOutline()} header="h" onToggle={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.getByText("Outline step, sent first")).toBeTruthy();
  expect(screen.getByText(OUTLINE_EXACT)).toBeTruthy();
  unmount();
  render(<Sends preview={withOutline({ ...OUTLINE_ITEM, on: false, bytes: 0, tokens: 0 })} header="h" onToggle={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.queryByText("Outline step, sent first")).toBeNull();
  expect(screen.queryByText(OUTLINE_EXACT)).toBeNull();
});
