import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { Compaction } from "../api/types";
import CompactNote from "./CompactNote";

afterEach(cleanup);

export const compaction = (over: Partial<Compaction> = {}): Compaction => ({
  id: "k1",
  threadId: "t1",
  topic: 1,
  firstAt: 1,
  lastAt: 14,
  messages: 14,
  summary: "Late invoices: you asked for invoices past due_at grouped by customer.",
  summaryBy: { kind: "model", model: "claude-haiku-5-5" },
  connectionId: "c1",
  database: "shop",
  kinds: ["question", "cards"],
  before: 182_000,
  after: 31_000,
  at: 20,
  undone: false,
  record: {
    sent: null,
    usage: null,
    millis: null,
    stop: null,
    mark: null,
    error: null,
    sqlBlocks: [],
    notes: [],
    thinking: null,
    log: [],
    steps: [],
    actions: [],
    context: null,
    commandError: null,
  },
  ...over,
});

test("note_figures_and_links", async () => {
  render(<CompactNote compaction={compaction()} modelName="Claude Haiku 5.5" onUndo={() => {}} busy={false} />);
  expect(screen.getByText("Compacted 14 older messages into a summary")).toBeTruthy();
  expect(screen.getByText("182K → 31K")).toBeTruthy();
  expect(screen.queryByText(/Late invoices/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Show the summary" }));
  expect(screen.getByText(/Late invoices/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hide the summary" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Hide the summary" }));
  expect(screen.queryByText(/Late invoices/)).toBeNull();
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
});

test("summary_label_by_model_or_rules", async () => {
  const { unmount } = render(
    <CompactNote compaction={compaction()} modelName="Claude Haiku 5.5" tokens={1200} onUndo={() => {}} busy={false} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Show the summary" }));
  expect(screen.getByText("Summary by Claude Haiku 5.5, 1.2K tokens")).toBeTruthy();
  unmount();
  // No measured figure: the header says no count.
  const bare = render(<CompactNote compaction={compaction()} modelName="Claude Haiku 5.5" onUndo={() => {}} busy={false} />);
  await userEvent.click(screen.getByRole("button", { name: "Show the summary" }));
  expect(screen.getByText("Summary by Claude Haiku 5.5")).toBeTruthy();
  bare.unmount();
  render(<CompactNote compaction={compaction({ summaryBy: { kind: "rules" }, messages: 1 })} modelName={null} onUndo={() => {}} busy={false} />);
  expect(screen.getByText("Compacted 1 older message into a summary")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Show the summary" }));
  expect(screen.getByText(/^Summary written by Contura/)).toBeTruthy();
});

test("undo_calls_and_shows_view", async () => {
  const onUndo = vi.fn();
  const { rerender } = render(<CompactNote compaction={compaction()} modelName="Claude Haiku 5.5" onUndo={onUndo} busy={false} />);
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(onUndo).toHaveBeenCalledTimes(1);
  rerender(<CompactNote compaction={compaction()} modelName="Claude Haiku 5.5" onUndo={onUndo} busy />);
  const undoing = screen.getByRole("button", { name: "Undoing..." }) as HTMLButtonElement;
  expect(undoing.disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});
