import type { AiThread, AnswerRecord, AppendTurn, Compaction, ThreadSummary, ThreadView, Topic, TurnView } from "../api/types";

/** What `list_ai_threads` returns for a thread: no messages. */
export const summaryOf = (t: AiThread): ThreadSummary => ({
  id: t.id,
  place: t.place,
  title: t.title,
  updatedAt: t.updatedAt,
  messages: t.messages.length,
  topics: 1,
});

/** A record as a list or view carries it: the heavy parts left out. */
export const trimmedOf = (r: AnswerRecord): AnswerRecord => ({ ...r, log: [], steps: [], thinking: null, trimmed: true });

/** What `get_ai_thread` and `save_ai_thread` return: every record trimmed when `trim` is set. */
export const viewOf = (t: AiThread, trim = false, topics: Topic[] = [], compactions: Compaction[] = []): ThreadView => ({
  thread: trim
    ? { ...t, messages: t.messages.map((m) => (m.record ? { ...m, record: trimmedOf(m.record) } : m)) }
    : t,
  topics,
  compactions,
});

/**
 * What `ai_append_turn` returns for `turn` on top of `stored` (the thread the Core has, if any): the new messages, the
 * stored title of a known thread, and nothing over the cap.
 */
export const turnViewOf = (turn: AppendTurn, stored: AiThread | null = null, topics: Topic[] = [], compactions: Compaction[] = []): TurnView => {
  const kept = stored ? stored.messages.filter((m) => turn.replaceFrom === undefined || m.at < turn.replaceFrom) : [];
  return {
    threadId: turn.threadId,
    place: stored?.place ?? turn.place,
    title: stored?.title ?? turn.title,
    updatedAt: turn.updatedAt,
    messages: turn.messages,
    keptFrom: kept[0]?.at ?? turn.messages[0]?.at ?? null,
    messageCount: kept.length + turn.messages.length,
    topics,
    compactions,
  };
};
