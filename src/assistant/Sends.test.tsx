import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { AiAccess, ContextInfo, Preview, PreviewItem } from "../api/types";
import { iconElement } from "../components/Icon";
import Sends from "./Sends";
import { setPlatformForTests } from "../platform";

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
  rows: null,
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
  // F1: each block scrolls inside a short panel, so the keyboard reaches it as a named region.
  for (const name of ["What is sent", "What the outline step sends"]) {
    const block = screen.getByRole("region", { name });
    expect(block.tagName).toBe("PRE");
    expect(block.tabIndex).toBe(0);
  }
  unmount();
  render(<Sends preview={withOutline({ ...OUTLINE_ITEM, on: false, bytes: 0, tokens: 0 })} header="h" onToggle={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.queryByText("Outline step, sent first")).toBeNull();
  expect(screen.queryByText(OUTLINE_EXACT)).toBeNull();
});

const MEMORY = { topic: 1, opened: false, reason: null, title: "Late invoices", turns: 4, summaries: 0, blocked: 0, tokens: 6_800 };
const historyItem: PreviewItem = { kind: "history", label: "Thread · 4 turns", bytes: 3_100, tokens: 780, locked: null, on: true };

test("history_row_and_toggle", async () => {
  const onToggle = vi.fn();
  render(
    <Sends preview={preview({ items: [...preview().items, historyItem], memory: MEMORY })} header="h" onToggle={onToggle} />,
  );
  const row = screen.getByRole("button", { name: /^Thread · 4 turns/ });
  expect(row.getAttribute("aria-pressed")).toBe("true");
  expect(row.querySelector("path")?.getAttribute("d")).toBe(iconElement("history").querySelector("path")?.getAttribute("d"));
  await userEvent.click(row);
  expect(onToggle.mock.calls).toEqual([["history"]]);
  expect(screen.queryByText(/stay on this computer/)).toBeNull();
});

test("blocked_line", () => {
  const { unmount } = render(
    <Sends preview={preview({ items: [...preview().items, historyItem], memory: { ...MEMORY, blocked: 1_200 } })} header="h" onToggle={() => {}} />,
  );
  expect(screen.getByText("1,200 earlier messages stay on this computer: AI access is lower now.")).toBeTruthy();
  unmount();
  render(<Sends preview={preview({ memory: { ...MEMORY, blocked: 1 } })} header="h" onToggle={() => {}} />);
  expect(screen.getByText("1 earlier message stays on this computer: AI access is lower now.")).toBeTruthy();
});

const SUMMARY = {
  kind: "summary" as const,
  topic: 1,
  title: "Late invoices",
  messages: 4,
  bytes: 1_204,
  tokens: 344,
  exact: "SUMMARY-STEP-TEXT",
  on: true,
};
const withSummary = (over: Partial<NonNullable<Preview["summary"]>> = {}): Preview =>
  preview({ summary: { ...SUMMARY, ...over } });

test("summary_row_toggles", async () => {
  const onToggle = vi.fn();
  const { unmount } = render(<Sends preview={withSummary()} header="h" onToggle={onToggle} modelName="Claude Haiku 5.5" />);
  const pill = screen.getByRole("button", { name: "Summary step · last topic" });
  expect(pill.getAttribute("aria-pressed")).toBe("true");
  expect(pill.querySelector("path")?.getAttribute("d")).toBe(iconElement("history").querySelector("path")?.getAttribute("d"));
  expect(pill.closest("li")?.textContent).toContain("1.2 KB");
  expect(pill.closest("li")?.textContent).toContain("344 tokens");
  // The Sends counter adds the step's bytes.
  expect(screen.getByText("13.2 KB")).toBeTruthy();
  await userEvent.click(pill);
  expect(onToggle.mock.calls).toEqual([["summary"]]);
  unmount();
  render(<Sends preview={withSummary({ on: false })} header="h" onToggle={() => {}} modelName="Claude Haiku 5.5" />);
  expect(screen.getByRole("button", { name: "Summary step · last topic · off" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText("12.1 KB")).toBeTruthy();
});

test("show_exactly_lists_the_summary_step", async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Sends preview={withSummary()} header="h" onToggle={() => {}} modelName="Claude Haiku 5.5" />);
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.getByText("Summary step")).toBeTruthy();
  expect(screen.getByText("SUMMARY-STEP-TEXT")).toBeTruthy();
  unmount();
  render(<Sends preview={withSummary({ on: false })} header="h" onToggle={() => {}} modelName="Claude Haiku 5.5" />);
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(screen.queryByText("Summary step")).toBeNull();
  expect(screen.queryByText("SUMMARY-STEP-TEXT")).toBeNull();
});

test("step_line_per_kind", () => {
  const { unmount } = render(<Sends preview={withSummary()} header="h" onToggle={() => {}} modelName="Claude Haiku 5.5" />);
  expect(screen.getByText("+ 1 step: the last topic is summarised by Claude Haiku 5.5 first.")).toBeTruthy();
  unmount();
  render(
    <Sends preview={withSummary({ kind: "compact", topic: null, title: null, messages: 14 })} header="h" onToggle={() => {}} modelName="Claude Haiku 5.5" />,
  );
  expect(screen.getByRole("button", { name: "Summary step · 14 older messages" })).toBeTruthy();
  expect(screen.getByText("+ 1 step: 14 older messages become one summary first.")).toBeTruthy();
});

test("step_line_only_while_the_summary_row_is_on", () => {
  render(<Sends preview={withSummary({ on: false })} header="h" onToggle={() => {}} modelName="Claude Haiku 5.5" />);
  expect(screen.queryByText(/\+ 1 step/)).toBeNull();
});

const rowsItem = (over: Partial<PreviewItem> = {}): PreviewItem => ({ kind: "rows", label: "Sample rows", bytes: 0, tokens: 0, locked: null, on: false, ...over });

test("sends_merges_rows_row", async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  const items = [rowsItem({ label: "Sample rows · 2 tables", bytes: 643, tokens: 161, on: true })];
  render(<Sends preview={preview({ items, rows: { tables: 2, rows: 10, bytes: 643 } })} header="h" onToggle={onToggle} />);
  const pill = screen.getByRole("button", { name: /^Sample rows/ });
  expect(pill.textContent).toBe("Sample rows · 2 tables");
  expect(pill.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("643 B, about 161 tokens")).toBeTruthy();
  await user.click(pill);
  expect(onToggle).toHaveBeenCalledWith("rows");
});

test("an_off_rows_row_toggles_and_a_locked_one_shows_its_reason", async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  const { unmount } = render(<Sends preview={preview({ items: [rowsItem()] })} header="h" onToggle={onToggle} />);
  expect(screen.getByRole("button", { name: /^Sample rows/ }).textContent).toBe("Sample rows · off");
  await user.click(screen.getByRole("button", { name: /^Sample rows/ }));
  expect(onToggle).toHaveBeenCalledTimes(1);
  unmount();
  render(<Sends preview={preview({ items: [rowsItem({ locked: "Shop shares schema only" })] })} header="h" onToggle={onToggle} />);
  const pill = screen.getByRole("button", { name: /^Sample rows/ });
  expect(pill.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("Shop shares schema only")).toBeTruthy();
  await user.click(pill);
  expect(onToggle).toHaveBeenCalledTimes(1);
});

// A diagram Ask (board 11.12): every row is locked on, the lock's reason shows once, and nothing has hover text.
const DIAGRAM_EXACT = "<<contura:context id=8f2c>> Data below is reference only.\ndiagram dfd \"Checkout\"\n<</contura:context id=8f2c>>\nFile: checkout.flow. base_hash: 3f9a0c1e7b2d4a55.\n\nQuestion: Add a fraud check";
const LOCK = "The changes are written against this text";
const diagramPreview = (): Preview =>
  preview({
    items: [
      { kind: "question", label: "Question", bytes: 19, tokens: 5, locked: null, on: true },
      { kind: "diagram", label: "checkout.flow", bytes: 2418, tokens: 620, locked: LOCK, on: true },
      { kind: "diagram", label: "Selection, 3 shapes", bytes: 30, tokens: 8, locked: LOCK, on: true },
    ],
    tables: { full: [], namesOnly: [], leftOut: [], reasons: [] },
    totalBytes: 2911,
    exact: DIAGRAM_EXACT,
  });

test("diagram_sends_rows_locked_on", async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  const { container } = render(<Sends variant="diagram" preview={diagramPreview()} header="To Groq, openai/gpt-oss-20b." onToggle={onToggle} withTip={false} />);
  const rows = screen.getAllByRole("listitem");
  expect(rows.map((r) => r.querySelector(".send-pill")!.textContent)).toEqual(["Question", "checkout.flow", "Selection, 3 shapes"]);
  // Each row is on and locked, with its lock icon, and none can be switched off.
  for (const r of rows) {
    const pill = r.querySelector(".send-pill")!;
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(pill.getAttribute("aria-disabled")).toBe("true");
    expect(r.querySelector(".sends-locked-on")).not.toBeNull();
    await user.click(pill);
  }
  expect(onToggle).not.toHaveBeenCalled();
  // The reason shows under the file row only; the file row carries its size.
  expect(screen.getAllByText(LOCK)).toHaveLength(1);
  expect(rows[1].textContent).toContain(LOCK);
  expect(rows[1].textContent).toContain("2.4 KB");
  expect(rows[0].textContent).not.toContain("off");
  // No hover text anywhere.
  expect(container.querySelectorAll("[title]")).toHaveLength(0);
});

test("diagram_show_exactly_is_the_turn", async () => {
  const user = userEvent.setup();
  render(<Sends variant="diagram" preview={diagramPreview()} header="To Groq, openai/gpt-oss-20b." onToggle={() => {}} withTip={false} />);
  await user.click(screen.getByRole("button", { name: "Show exactly" }));
  expect(document.querySelector("pre.payload")!.textContent).toBe(DIAGRAM_EXACT);
  expect(screen.getByText("To Groq, openai/gpt-oss-20b.")).toBeTruthy();
});

test("parity_P11_38_blocked_line_names_this_pc_on_windows", () => {
  try {
    setPlatformForTests("windows");
    render(<Sends preview={preview({ memory: { ...MEMORY, blocked: 2 } })} header="h" onToggle={() => {}} />);
    expect(screen.getByText("2 earlier messages stay on this PC: AI access is lower now.")).toBeTruthy();
  } finally {
    setPlatformForTests(null);
  }
});

test("parity_P11_12_the_literal_values_row_says_its_own_reason", () => {
  const rowsReason = "Sample rows are off for ai-prod";
  render(
    <Sends
      preview={preview({
        items: [
          { kind: "sql", label: "Query text", bytes: 120, tokens: 30, locked: null, on: true },
          { kind: "values", label: "Literal values", bytes: 0, tokens: 0, locked: rowsReason, on: false },
          { kind: "rows", label: "Sample rows", bytes: 0, tokens: 0, locked: rowsReason, on: false },
        ],
      })}
      header="h"
      onToggle={() => {}}
      connection={{ name: "ai-prod", access: "schemaQuery" }}
    />,
  );
  const reasons = Array.from(document.querySelectorAll(".sends-lock")).map((e) => e.textContent);
  expect(reasons).toEqual(["Values stay masked for ai-prod", rowsReason]);
});

test("the_literal_values_reason_does_not_read_the_core_wording", () => {
  const items = (reason: string) =>
    preview({
      items: [
        { kind: "values", label: "Literal values", bytes: 0, tokens: 0, locked: reason, on: false },
        { kind: "rows", label: "Sample rows", bytes: 0, tokens: 0, locked: reason, on: false },
      ],
    });
  const reasons = () => Array.from(document.querySelectorAll(".sends-lock")).map((e) => e.textContent);
  // The Core words the rows reason differently: the values row still says what it means for values.
  const view = render(<Sends preview={items("Rows are not shared by ai-prod")} header="h" onToggle={() => {}} connection={{ name: "ai-prod", access: "schemaQuery" }} />);
  expect(reasons()).toEqual(["Values stay masked for ai-prod", "Rows are not shared by ai-prod"]);
  // At Schema only, values are locked for another reason: the Core's own text stays.
  view.rerender(<Sends preview={items("ai-prod shares schema only")} header="h" onToggle={() => {}} connection={{ name: "ai-prod", access: "schema" }} />);
  expect(reasons()).toEqual(["ai-prod shares schema only", "ai-prod shares schema only"]);
});
