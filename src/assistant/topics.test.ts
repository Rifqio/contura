import { expect, test } from "vitest";
import type { AiMessage, Topic } from "../api/types";
import { groupByTopic, topicSpan } from "./topics";

export const topic = (seq: number, over: Partial<Topic> = {}): Topic => ({
  threadId: "t1",
  seq,
  title: `Topic ${seq}`,
  summary: "Summary",
  summaryBy: { kind: "rules" },
  tables: [],
  connectionId: "c1",
  database: "shop",
  kinds: [],
  firstAt: 0,
  lastAt: 0,
  messages: 2,
  closed: false,
  ...over,
});

const msg = (at: number, over: Partial<AiMessage> = {}): AiMessage => ({ role: "user", text: `m${at}`, context: [], at, ...over });

test("groups_by_topic_and_unstamped", () => {
  const messages = [msg(1), msg(2), msg(3, { topic: 1 }), msg(4, { topic: 1 }), msg(5, { topic: 2 }), msg(6, { topic: 2 })];
  const groups = groupByTopic(messages, [topic(1, { closed: true }), topic(2)]);
  expect(groups.map((g) => [g.topic?.seq ?? null, g.messages.map((m) => m.at)])).toEqual([
    [null, [1, 2]],
    [1, [3, 4]],
    [2, [5, 6]],
  ]);
  // A stamp whose Topic is not stored yet joins the unstamped group.
  expect(groupByTopic([msg(1, { topic: 3 })], []).map((g) => g.topic)).toEqual([null]);
  expect(groupByTopic([], [])).toEqual([]);
});

test("span_text", () => {
  const at = (h: number, m: number) => new Date(2026, 9, 22, h, m).getTime();
  const now = new Date(2026, 9, 22, 15, 0).getTime();
  expect(topicSpan(topic(1, { firstAt: at(9, 38), lastAt: at(9, 51) }), now)).toEqual({ start: "09:38", title: "Today 09:38 to 09:51" });
  const old = new Date(2026, 9, 18, 11, 42).getTime();
  const span = topicSpan(topic(1, { firstAt: old, lastAt: old + 60_000 }), now);
  expect(span.start).toBe("Oct 18 11:42");
  expect(span.title).toBe("Oct 18 11:42 to 11:43");
});
