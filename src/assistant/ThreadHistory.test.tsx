import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ThreadHit, ThreadSummary } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import ThreadHistory from "./ThreadHistory";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const NOW = new Date(2026, 9, 22, 12, 0).getTime();
const summary = (id: string, title: string, ago: number): ThreadSummary => ({
  id,
  place: "ungrouped",
  title,
  updatedAt: NOW - ago,
  messages: 2,
  topics: 1,
});

let hits: ThreadHit[] = [];

beforeEach(() => {
  hits = [];
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  routeInvoke({ ai_search_threads: () => hits });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(over: Partial<React.ComponentProps<typeof ThreadHistory>> = {}) {
  const user = userEvent.setup();
  const on = { onOpen: vi.fn(), onNewChat: vi.fn(), onClearThread: vi.fn(), onClearAll: vi.fn() };
  render(
    <ThreadHistory
      place="ungrouped"
      placeName="Ungrouped"
      threads={[summary("a", "Older chat", 3 * 3_600_000), summary("b", "Newest chat", 5 * 60_000)]}
      currentId="b"
      busy={false}
      {...on}
      {...over}
    />,
  );
  return { user, ...on };
}

const open = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Show history" }));

test("lists_chats_newest_first", async () => {
  const { user, onOpen } = setup();
  await open(user);
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".history-chat"));
  expect(rows.map((r) => r.querySelector(".menu-label-line")?.textContent)).toEqual(["Newest chat", "Older chat"]);
  expect(within(rows[0]).getByText("5m ago")).toBeTruthy();
  expect(within(rows[1]).getByText("3h ago")).toBeTruthy();
  // The current one has the check.
  expect(rows[0].getAttribute("aria-current")).toBe("true");
  expect(rows[1].getAttribute("aria-current")).toBeNull();
  await user.click(rows[1]);
  expect(onOpen).toHaveBeenCalledWith("a");
});

test("search_shows_topic_hits", async () => {
  hits = [{ threadId: "a", title: "Older chat", topic: 2, topicTitle: "Orders by month", snippet: "Grouped orders by month", at: NOW }];
  const { user, onOpen } = setup();
  await open(user);
  await user.type(screen.getByRole("searchbox", { name: "Search chats" }), "month");
  // Debounced 300 ms.
  expect(callsTo("ai_search_threads")).toHaveLength(0);
  await waitFor(() => expect(callsTo("ai_search_threads")).toEqual([{ place: "ungrouped", text: "month" }]));
  const hit = await screen.findByRole("button", { name: /Orders by month/ });
  expect(within(hit).getByText("Older chat")).toBeTruthy();
  expect(within(hit).getByText("Orders by month")).toBeTruthy();
  expect(within(hit).getByText("Grouped orders by month")).toBeTruthy();
  expect(screen.queryByText("Newest chat")).toBeNull();
  await user.click(hit);
  expect(onOpen).toHaveBeenCalledWith("a");
});

test("no_match_text", async () => {
  const { user } = setup();
  await open(user);
  await user.type(screen.getByRole("searchbox", { name: "Search chats" }), "zzz");
  expect(await screen.findByText("No chats match")).toBeTruthy();
});

test("clear_this_chat", async () => {
  const { user, onClearThread } = setup();
  await open(user);
  await user.click(screen.getByRole("button", { name: "Clear this chat" }));
  // It asks first.
  expect(onClearThread).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClearThread).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Clear this chat" }));
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(onClearThread).toHaveBeenCalledTimes(1);
});

test("clear_this_chat_is_off_with_no_current_chat", async () => {
  const { user } = setup({ currentId: null });
  await open(user);
  expect((screen.getByRole("button", { name: "Clear this chat" }) as HTMLButtonElement).disabled).toBe(true);
});

test("clear_all_confirms_with_the_place_name", async () => {
  const { user, onClearAll } = setup({ placeName: "Kestrel" });
  await open(user);
  const clearAll = screen.getByRole("button", { name: "Clear all chats in this place..." });
  expect(clearAll.className).toContain("menu-item-danger");
  await user.click(clearAll);
  expect(onClearAll).not.toHaveBeenCalled();
  expect(screen.getByText("Clear the AI history of Kestrel? Every thread in this place is removed.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClearAll).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Clear all chats in this place..." }));
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(onClearAll).toHaveBeenCalledTimes(1);
});

test("parity_P11_40_a_chat_row_has_one_line_and_no_query_history_grid", async () => {
  const { user } = setup({ threads: [summary("b", "Only chat", 5 * 60_000)] });
  await open(user);
  const row = screen.getByRole("button", { name: /Only chat/ });
  // The query History row's class gives a second 16px grid row: an empty line under the chat.
  expect(row.classList.contains("history-row")).toBe(false);
  expect(row.classList.contains("history-chat")).toBe(true);
});

test("parity_P11_40_the_history_tooltip_never_covers_the_search_field", async () => {
  const { user } = setup();
  const button = screen.getByRole("button", { name: "Show history" });
  expect(button.getAttribute("title")).toBe("Show history");
  await open(user);
  expect(screen.getByRole("searchbox", { name: "Search chats" })).toBeTruthy();
  // While the popover is open the button has no hover text to draw over the field.
  expect(button.hasAttribute("title")).toBe(false);
  await user.keyboard("{Escape}");
  expect(button.getAttribute("title")).toBe("Show history");
});
