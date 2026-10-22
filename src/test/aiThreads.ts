import type { AiThread, AnswerRecord, Compaction, ThreadSummary, ThreadView, Topic } from "../api/types";

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
