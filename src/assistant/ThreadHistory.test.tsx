import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionConfig, ThreadSummary, WorkTag } from "../api/types";
import { callsTo, routeInvoke } from "../test/invoke";
import ThreadHistory from "./ThreadHistory";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const NOW = new Date(2026, 9, 22, 12, 0).getTime();
const summary = (id: string, title: string, ago: number, work: WorkTag | null = null): ThreadSummary => ({
  id,
  place: "ungrouped",
  title,
  titleBy: "rule",
  updatedAt: NOW - ago,
  messages: 2,
  topics: 1,
  work,
});

const laragon: ConnectionConfig = {
  id: "c1",
  name: "Laragon MySQL",
  dialect: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  database: "hc-backend",
  ssl: { mode: "disable" },
  file: null,
  groupId: null,
  queryTimeoutSecs: null,
  aiAccess: "schema",
  production: false,
  readOnly: false,
};

let hits: ThreadSummary[] = [];

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
  const on = {
    onOpen: vi.fn(),
    onRename: vi.fn(async (id: string, title: string): Promise<ThreadSummary | string> => ({ ...summary(id, title, 0), titleBy: "user" })),
    onDelete: vi.fn(),
    onClearAll: vi.fn(),
  };
  const props = {
    place: "ungrouped",
    placeName: "Ungrouped",
    threads: [summary("a", "Older chat", 3 * 3_600_000), summary("b", "Newest chat", 5 * 60_000)],
    currentId: "b",
    busy: false,
    connections: [laragon],
    ...on,
    ...over,
  };
  const view = render(<ThreadHistory {...props} />);
  return { user, view, props, ...on };
}

const open = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Show history" }));
const chatRows = () => Array.from(document.querySelectorAll<HTMLElement>(".history-chat"));
const titleOf = (row: HTMLElement) => row.querySelector(".history-chat-title")?.textContent;
const itemOf = (title: string) => screen.getByRole("button", { name: new RegExp(title) }).closest<HTMLElement>(".history-item")!;

test("lists_chats_grouped_by_day_with_their_place", async () => {
  const work = { connectionId: "c1", database: "hc-backend", table: "invoice", tabLabel: "Query 3" };
  const { user, onOpen } = setup({
    threads: [
      summary("old", "Home question", 9 * 86_400_000),
      summary("y", "Devices by facility", 13 * 3_600_000, { ...work, table: null }),
      summary("t", "Unpaid clients", 5 * 60_000, work),
      summary("w", "Last week", 4 * 86_400_000),
    ],
    currentId: "t",
  });
  await open(user);
  const heads = Array.from(document.querySelectorAll(".history-group")).map((h) => h.textContent);
  expect(heads).toEqual(["Today", "Yesterday", "Previous 7 days", "Older"]);
  expect(chatRows().map(titleOf)).toEqual(["Unpaid clients", "Devices by facility", "Last week", "Home question"]);

  const today = chatRows()[0];
  const tag = today.querySelector<HTMLElement>(".history-tag")!;
  expect(tag.textContent).toBe("Laragon MySQL · hc-backend");
  expect(tag.querySelector(".db-mark-mysql")).toBeTruthy();
  // The table, muted, after the tag; the tab label only when there is no table.
  expect(today.querySelector(".history-chat-table")?.textContent).toBe("invoice");
  expect(chatRows()[1].querySelector(".history-chat-table")?.textContent).toBe("Query 3");
  // The time today is the clock, with the age as its tooltip. The row's tooltip is the full title and the age, since
  // the row actions take the time's place on hover.
  const time = today.querySelector<HTMLElement>(".history-chat-time")!;
  expect(time.textContent).toBe("11:55");
  expect(time.getAttribute("title")).toBe("5m ago");
  expect(today.getAttribute("title")).toBe("Unpaid clients\n5m ago");
  expect(chatRows()[3].querySelector(".history-chat-time")?.textContent).toBe("Oct 13");
  // A chat that never touched a database.
  expect(chatRows()[3].querySelector(".history-tag")).toBeNull();
  expect(chatRows()[3].querySelector(".history-chat-place")?.textContent).toBe("No database");

  await user.click(chatRows()[2]);
  expect(onOpen).toHaveBeenCalledWith("w");
});

test("board_chats_draw_no_second_line_with_empty_place_null", async () => {
  const { user } = setup({ emptyPlace: null });
  await open(user);
  expect(chatRows()[0].querySelector(".history-chat-place")).toBeNull();
});

test("search_lists_matching_chats", async () => {
  hits = [
    summary("a", "Orders by month", 3 * 3_600_000, { connectionId: "c1", database: "shop", table: "orders", tabLabel: null }),
    summary("z", "Monthly totals", 40 * 86_400_000),
  ];
  const { user, onOpen } = setup();
  await open(user);
  await user.type(screen.getByRole("searchbox", { name: "Search chats" }), "month");
  // Debounced 300 ms.
  expect(callsTo("ai_search_threads")).toHaveLength(0);
  await waitFor(() => expect(callsTo("ai_search_threads")).toEqual([{ place: "ungrouped", text: "month" }]));
  const hit = await screen.findByRole("button", { name: /Orders by month/ });
  expect(hit.querySelector(".history-tag")?.textContent).toBe("Laragon MySQL · shop");
  // One flat list in relevance order: no day headers.
  expect(chatRows().map(titleOf)).toEqual(["Orders by month", "Monthly totals"]);
  expect(document.querySelector(".history-group")).toBeNull();
  expect(screen.queryByText("Newest chat")).toBeNull();
  await user.click(hit);
  expect(onOpen).toHaveBeenCalledWith("a");
});

test("a_renamed_search_hit_takes_the_row_the_core_kept", async () => {
  // Final review M5: the hit is the Core's row after a rename, titleBy included.
  hits = [summary("a", "Orders by month", 3 * 3_600_000)];
  const kept = { ...summary("a", "Monthly orders", 3 * 3_600_000), titleBy: "user" as const };
  const onRename = vi.fn(async (): Promise<ThreadSummary | string> => kept);
  const { user } = setup({ onRename });
  await open(user);
  await user.type(screen.getByRole("searchbox", { name: "Search chats" }), "month");
  const item = (await screen.findByRole("button", { name: /Orders by month/ })).closest<HTMLElement>(".history-item")!;
  await user.hover(item);
  await user.click(within(item).getByRole("button", { name: "Rename" }));
  const field = within(item).getByRole("textbox", { name: "Chat title" });
  await user.clear(field);
  await user.type(field, "monthly orders{Enter}");
  expect(onRename).toHaveBeenCalledWith("a", "monthly orders");
  await waitFor(() => expect(chatRows().map(titleOf)).toEqual(["Monthly orders"]));
});

test("no_match_text", async () => {
  const { user } = setup();
  await open(user);
  await user.type(screen.getByRole("searchbox", { name: "Search chats" }), "zzz");
  expect(await screen.findByText("No chats match")).toBeTruthy();
});

test("delete_confirms_in_the_row", async () => {
  const { user, onDelete } = setup();
  await open(user);
  const item = itemOf("Older chat");
  await user.hover(item);
  await user.click(within(item).getByRole("button", { name: "Delete" }));
  // The row itself turns into the question: the same item at the same height, never a dialog.
  const ask = within(item).getByRole("alertdialog", { name: "Delete chat" });
  expect(item.classList.contains("history-item")).toBe(true);
  expect(ask.classList.contains("history-ask")).toBe(true);
  expect(within(ask).getByText('Delete "Older chat"?')).toBeTruthy();
  expect(within(ask).getByText("This cannot be undone.")).toBeTruthy();
  expect(onDelete).not.toHaveBeenCalled();
  // Esc cancels the question, not the popover.
  await user.keyboard("{Escape}");
  expect(within(item).queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("dialog", { name: "Chat history" })).toBeTruthy();
  expect(onDelete).not.toHaveBeenCalled();
  // Cancel too.
  await user.hover(item);
  await user.click(within(item).getByRole("button", { name: "Delete" }));
  await user.click(within(item).getByRole("button", { name: "Cancel" }));
  expect(within(item).queryByRole("alertdialog")).toBeNull();
  await user.hover(item);
  await user.click(within(item).getByRole("button", { name: "Delete" }));
  await user.click(within(within(item).getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
  expect(onDelete).toHaveBeenCalledWith("a");
  expect(onDelete).toHaveBeenCalledTimes(1);
});

test("slash_clear_opens_the_current_rows_confirmation", async () => {
  const { view, props } = setup();
  view.rerender(<ThreadHistory {...props} command={{ n: 1, kind: "clear" }} />);
  const ask = await screen.findByRole("alertdialog", { name: "Delete chat" });
  expect(within(ask).getByText('Delete "Newest chat"?')).toBeTruthy();
  expect(ask.closest(".history-item")).toBeTruthy();
  // With no current chat the popover only opens.
  cleanup();
  const second = setup({ currentId: null });
  second.view.rerender(<ThreadHistory {...second.props} command={{ n: 1, kind: "clear" }} />);
  expect(await screen.findByRole("dialog", { name: "Chat history" })).toBeTruthy();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("clear_all_confirms_with_the_place_name", async () => {
  const { user, onClearAll } = setup({ placeName: "Kestrel" });
  await open(user);
  const clearAll = screen.getByRole("button", { name: "Clear all chats..." });
  // A quiet text button in the danger text colour (appCss.test.ts reads its rule).
  expect(clearAll.className).toContain("history-clear-all");
  await user.click(clearAll);
  expect(onClearAll).not.toHaveBeenCalled();
  expect(screen.getByText("Clear the AI history of Kestrel? Every thread in this place is removed.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClearAll).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Clear all chats..." }));
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(onClearAll).toHaveBeenCalledTimes(1);
});

test("rename_in_place_keeps_on_enter_and_cancels_on_esc", async () => {
  const { user, onRename } = setup();
  await open(user);
  let item = itemOf("Older chat");
  await user.hover(item);
  await user.click(within(item).getByRole("button", { name: "Rename" }));
  let field = within(item).getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
  expect(field.value).toBe("Older chat");
  expect(document.activeElement).toBe(field);
  expect(field.maxLength).toBe(120);
  // Esc cancels: no call, the popover stays.
  await user.clear(field);
  await user.type(field, "Thrown away");
  await user.keyboard("{Escape}");
  expect(onRename).not.toHaveBeenCalled();
  expect(within(item).queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("dialog", { name: "Chat history" })).toBeTruthy();
  // Enter keeps, trimmed.
  await user.hover(item);
  await user.click(within(item).getByRole("button", { name: "Rename" }));
  field = within(item).getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
  await user.clear(field);
  await user.type(field, "  Invoices due  {Enter}");
  expect(onRename).toHaveBeenCalledWith("a", "Invoices due");
  expect(onRename).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(within(item).queryByRole("textbox")).toBeNull());
  // Blur keeps too (R5).
  onRename.mockClear();
  item = itemOf("Newest chat");
  await user.hover(item);
  await user.click(within(item).getByRole("button", { name: "Rename" }));
  field = within(item).getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
  await user.clear(field);
  await user.type(field, "Kept on blur");
  act(() => field.blur());
  expect(onRename).toHaveBeenCalledWith("b", "Kept on blur");
  await waitFor(() => expect(within(item).queryByRole("textbox")).toBeNull());
  // An empty title is no title: the old one stays, with no call.
  onRename.mockClear();
  await user.hover(item);
  await user.click(within(item).getByRole("button", { name: "Rename" }));
  field = within(item).getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
  await user.clear(field);
  await user.keyboard("{Enter}");
  expect(onRename).not.toHaveBeenCalled();
  expect(within(item).queryByRole("textbox")).toBeNull();
});

test("an_outside_click_keeps_the_rename", async () => {
  const { user, onRename } = setup();
  await open(user);
  const item = itemOf("Older chat");
  await user.hover(item);
  await user.click(within(item).getByRole("button", { name: "Rename" }));
  const field = within(item).getByRole("textbox", { name: "Chat title" });
  await user.clear(field);
  await user.type(field, "Kept by the outside click");
  // A press outside closes the popover; the typed title is kept as on blur (R5).
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
  expect(onRename).toHaveBeenCalledWith("a", "Kept by the outside click");
  expect(onRename).toHaveBeenCalledTimes(1);
});

test("a_focused_row_scrolled_out_of_the_window_keeps_the_focus_in_the_list", async () => {
  const threads = Array.from({ length: 250 }, (_, i) => summary(`t${i}`, `Chat ${i}`, i * 3 * 3_600_000));
  const { user } = setup({ threads, currentId: null });
  await open(user);
  await user.keyboard("{ArrowDown}");
  expect(titleOf(document.activeElement as HTMLElement)).toBe("Chat 0");
  // The wheel scrolls the focused row out of the window: it is no longer drawn.
  const items = document.querySelector<HTMLElement>(".history-items")!;
  Object.defineProperty(items, "scrollTop", { configurable: true, writable: true, value: 6000 });
  fireEvent.scroll(items);
  await waitFor(() => expect(document.querySelector('[data-row-id="t0"]')).toBeNull());
  // The focus stays in the list, so the keys still work: Down draws the focused row again, Esc closes.
  expect(document.activeElement).toBe(items);
  await user.keyboard("{ArrowDown}");
  expect(titleOf(document.activeElement as HTMLElement)).toBe("Chat 0");
  items.focus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
});

test("scrolling_updates_the_window_once_per_frame", async () => {
  const frames: FrameRequestCallback[] = [];
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  try {
    const threads = Array.from({ length: 250 }, (_, i) => summary(`t${i}`, `Chat ${i}`, i * 3 * 3_600_000));
    const { user, view } = setup({ threads, currentId: null });
    await open(user);
    const items = document.querySelector<HTMLElement>(".history-items")!;
    for (const top of [2000, 4000, 6000]) {
      Object.defineProperty(items, "scrollTop", { configurable: true, value: top });
      fireEvent.scroll(items);
    }
    // Three scroll events ask for one frame; the window moves when it runs, to the last position.
    expect(frames).toHaveLength(1);
    expect(titleOf(chatRows()[0])).toBe("Chat 0");
    act(() => frames[0](0));
    expect(titleOf(chatRows()[0])).not.toBe("Chat 0");
    // A frame asked for and not run is cancelled when the history goes.
    fireEvent.scroll(items);
    expect(frames).toHaveLength(2);
    view.unmount();
    expect(cancel).toHaveBeenCalled();
  } finally {
    raf.mockRestore();
    cancel.mockRestore();
  }
});

test("a_refused_rename_shows_why_in_the_row", async () => {
  const { user } = setup({ onRename: vi.fn(async () => "A chat title has 1 to 120 characters.") });
  await open(user);
  const item = itemOf("Older chat");
  await user.hover(item);
  await user.click(within(item).getByRole("button", { name: "Rename" }));
  await user.type(within(item).getByRole("textbox", { name: "Chat title" }), "x{Enter}");
  expect(await within(item).findByText("A chat title has 1 to 120 characters.")).toBeTruthy();
  expect(within(item).getByRole("textbox", { name: "Chat title" })).toBeTruthy();
});

test("row_actions_show_on_focus_and_replace_the_time", async () => {
  const { user } = setup();
  await open(user);
  const [first, second] = chatRows().map((r) => r.closest<HTMLElement>(".history-item")!);
  // At rest each row shows its time and no actions.
  expect(first.querySelector(".history-chat-time")).toBeTruthy();
  expect(within(first).queryByRole("button", { name: "Rename" })).toBeNull();
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(chatRows()[0]);
  // The focused row trades its time for Rename and Delete, 28 px icon buttons with tooltips.
  expect(first.querySelector(".history-chat-time")).toBeNull();
  const rename = within(first).getByRole("button", { name: "Rename" });
  const del = within(first).getByRole("button", { name: "Delete" });
  for (const b of [rename, del]) expect(b.classList.contains("icon-button")).toBe(true);
  expect(rename.getAttribute("title")).toBe("Rename");
  expect(del.getAttribute("title")).toBe("Delete");
  expect(second.querySelector(".history-chat-time")).toBeTruthy();
  // Tab reaches them; they stay while focus is inside the row.
  await user.tab();
  expect(document.activeElement).toBe(rename);
  expect(first.querySelector(".history-chat-time")).toBeNull();
  // Hover shows them on another row too.
  await user.hover(second);
  expect(within(second).getByRole("button", { name: "Delete" })).toBeTruthy();
  await user.unhover(second);
  expect(within(second).queryByRole("button", { name: "Delete" })).toBeNull();
});

test("arrow_keys_move_and_enter_opens_and_delete_confirms", async () => {
  const { user, onOpen } = setup();
  await open(user);
  const search = screen.getByRole("searchbox", { name: "Search chats" }) as HTMLInputElement;
  expect(document.activeElement).toBe(search);
  // In the field, Delete deletes text and opens nothing.
  await user.type(search, "ab");
  await user.keyboard("{ArrowLeft}{Delete}");
  expect(search.value).toBe("a");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.clear(search);
  // Down from the field focuses the first row; Down and Up move; Up from the first row goes back to the field.
  await user.keyboard("{ArrowDown}");
  expect(titleOf(document.activeElement as HTMLElement)).toBe("Newest chat");
  await user.keyboard("{ArrowDown}");
  expect(titleOf(document.activeElement as HTMLElement)).toBe("Older chat");
  await user.keyboard("{ArrowDown}");
  expect(titleOf(document.activeElement as HTMLElement)).toBe("Older chat");
  // Roving focus: one row in the tab order.
  expect(chatRows().map((r) => r.tabIndex)).toEqual([-1, 0]);
  await user.keyboard("{ArrowUp}");
  expect(titleOf(document.activeElement as HTMLElement)).toBe("Newest chat");
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(search);
  // Delete on a row opens its question; Esc closes the question first, then the popover.
  await user.keyboard("{ArrowDown}{ArrowDown}{Delete}");
  expect(within(screen.getByRole("alertdialog")).getByText('Delete "Older chat"?')).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(titleOf(document.activeElement as HTMLElement)).toBe("Older chat");
  // Enter opens, once.
  await user.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith("a");
  expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
  // Esc on a row closes the popover.
  await open(user);
  await user.keyboard("{ArrowDown}{Escape}");
  expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show history" }));
});

test("the_current_chat_is_tinted_with_aria_current", async () => {
  const { user } = setup();
  await open(user);
  const [newest, older] = chatRows();
  expect(newest.getAttribute("aria-current")).toBe("true");
  expect(older.getAttribute("aria-current")).toBeNull();
  // No check mark or stripe: the tint is the CSS on [aria-current].
  expect(newest.querySelector("svg.icon")).toBeNull();
});

test("a_title_is_text_only", async () => {
  const { user } = setup({ threads: [summary("x", "<b>x</b><img src=x onerror=alert(1)>", 60_000)] });
  await open(user);
  const row = chatRows()[0];
  expect(titleOf(row)).toBe("<b>x</b><img src=x onerror=alert(1)>");
  expect(row.querySelector("b")).toBeNull();
  expect(row.querySelector("img")).toBeNull();
});

test("a_gone_connection_tag_shows_the_database_only", async () => {
  const { user } = setup({
    threads: [
      summary("g", "Gone place", 60_000, { connectionId: "deleted", database: "kestrel", table: "orders", tabLabel: null }),
      summary("n", "Gone and no database", 120_000, { connectionId: "deleted", database: null, table: null, tabLabel: null }),
    ],
  });
  await open(user);
  const tag = chatRows()[0].querySelector(".history-tag")!;
  expect(tag.textContent).toBe("kestrel");
  expect(tag.querySelector(".db-mark")).toBeNull();
  expect(chatRows()[0].querySelector(".history-chat-table")?.textContent).toBe("orders");
  expect(chatRows()[1].querySelector(".history-tag")).toBeNull();
  expect(chatRows()[1].querySelector(".history-chat-place")?.textContent).toBe("No database");
});

test("opening_the_history_makes_no_call", async () => {
  const { user } = setup();
  await open(user);
  expect(screen.getByRole("dialog", { name: "Chat history" })).toBeTruthy();
  expect(chatRows()).toHaveLength(2);
  expect(vi.mocked(invoke)).not.toHaveBeenCalled();
});

test("past_200_rows_only_the_visible_rows_render", async () => {
  const threads = Array.from({ length: 250 }, (_, i) => summary(`t${i}`, `Chat ${i}`, i * 3 * 3_600_000));
  const { user } = setup({ threads, currentId: null });
  await open(user);
  const drawn = chatRows();
  expect(drawn.length).toBeGreaterThan(3);
  expect(drawn.length).toBeLessThanOrEqual(20);
  expect(titleOf(drawn[0])).toBe("Chat 0");
  // The rest of the list is space: a spacer holds the height of the rows not drawn.
  const after = document.querySelector<HTMLElement>(".history-spacer-after")!;
  expect(parseInt(after.style.height, 10)).toBeGreaterThan(200 * 52);
  // Down from the last drawn row draws the next one and focuses it.
  const last = drawn[drawn.length - 1];
  const nextTitle = `Chat ${drawn.length}`;
  expect(document.querySelector(`[data-row-id="t${drawn.length}"]`)).toBeNull();
  act(() => last.focus());
  await user.keyboard("{ArrowDown}");
  expect(titleOf(document.activeElement as HTMLElement)).toBe(nextTitle);
  expect(chatRows().length).toBeLessThanOrEqual(20);
  // Many more Downs keep the window small and the focus on the right row.
  for (let i = 0; i < 30; i++) fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(titleOf(document.activeElement as HTMLElement)).toBe(`Chat ${drawn.length + 30}`);
  expect(chatRows().length).toBeLessThanOrEqual(20);
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
