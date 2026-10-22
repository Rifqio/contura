import type { AiMessage, Topic } from "../api/types";
import { dayClock } from "../format/units";

/** A run of the thread's messages in one Topic; `topic` is null for messages with no stored Topic (saved before 11e). */
export interface TopicGroup {
  topic: Topic | null;
  messages: AiMessage[];
}

/** The thread's messages in order, split into runs by the Topic each one is stamped with. */
export function groupByTopic(
  messages: AiMessage[],
  topics: Topic[],
): TopicGroup[] {
  const groups: TopicGroup[] = [];
  for (const m of messages) {
    const topic =
      (m.topic !== undefined && topics.find((t) => t.seq === m.topic)) || null;
    const last = groups[groups.length - 1];
    if (last && (last.topic?.seq ?? null) === (topic?.seq ?? null))
      last.messages.push(m);
    else groups.push({ topic, messages: [m] });
  }
  return groups;
}

const clock = (at: number) => dayClock(at, at).slice("Today ".length);

/** The start time shown on a folded Topic, and its hover title ("Today 09:38 to 09:51"). */
export function topicSpan(
  t: Topic,
  now: number,
): { start: string; title: string } {
  const from = dayClock(t.firstAt, now);
  const today = from.startsWith("Today ");
  const sameDay =
    new Date(t.firstAt).toDateString() === new Date(t.lastAt).toDateString();
  const to = sameDay ? clock(t.lastAt) : dayClock(t.lastAt, now);
  return { start: today ? clock(t.firstAt) : from, title: `${from} to ${to}` };
}
