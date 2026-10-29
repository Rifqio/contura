import type { Topic } from "../api/types";
import Icon from "../components/Icon";
import { topicSpan } from "./topics";

interface Props {
  topic: Topic;
  /** The Topic's own last answer as plain text; the Core's summary when it has none. */
  preview?: string;
  open: boolean;
  onToggle(): void;
  now?: number;
}

/** A closed Topic folded to its title and summary; clicking opens its messages. */
export default function TopicFold({
  topic,
  preview,
  open,
  onToggle,
  now = Date.now(),
}: Props) {
  const span = topicSpan(topic, now);
  const n = topic.messages;
  return (
    <button
      type="button"
      className="topic"
      aria-expanded={open}
      onClick={onToggle}
    >
      <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      <span className="topic-text">
        <span className="topic-title">{topic.title}</span>
        {/* The count keeps its room: a long answer is cut, never "N messages". */}
        <span className="topic-sum">
          <span className="topic-preview">{(preview || topic.summary).replace(/\.$/, "")}.</span>{" "}
          <span className="topic-count">
            {n.toLocaleString("en-US")} {n === 1 ? "message" : "messages"}.
          </span>
        </span>
      </span>
      <span className="topic-time" title={span.title}>
        {span.start}
      </span>
    </button>
  );
}

/** The divider before the open Topic when it is not the first. */
export function TopicDivider({ title }: { title: string }) {
  return (
    <div className="tdiv">
      <b>New topic</b>
      <span>{title}</span>
    </div>
  );
}
