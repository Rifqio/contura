import { useId, useState } from "react";
import Icon, { type IconName } from "../components/Icon";
import { payloadIsCut, payloadText, type SendItem } from "./payload";

interface Props {
  /** The items to show; an empty list means only the question is sent. */
  items: SendItem[];
  /** "To <host> (<model>)", or the line saying nothing is sent yet. */
  header: string;
  onToggle(key: SendItem["key"]): void;
  /** The words for an item; the item's own label by default. */
  labelOf?(item: SendItem): string;
  /** Starts the line with "your question", which is always sent. */
  withQuestion?: boolean;
}

/** Why the sample rows item cannot be switched: no rows are fetched yet. */
export const ROWS_LATER = "Sample rows arrive with a later step.";

/** Each kind of item has its own icon. */
const ICON: Record<SendItem["key"], IconName> = {
  names: "database",
  schema: "table",
  query: "fileQuery",
  error: "error",
  dbml: "schema",
  rows: "grid",
};

/** What one question would send, as pills, with the exact text behind "Show exactly". */
export default function Sends({
  items,
  header,
  onToggle,
  labelOf,
  withQuestion = false,
}: Props) {
  const [shown, setShown] = useState(false);
  const id = useId();
  const text = payloadText(items);
  const cut = payloadIsCut(text);
  const questionOnly = items.length === 0;

  return (
    <div className="sends">
      <div className="sends-row">
        <span className="sends-label">Sends</span>
        {withQuestion && (
          <span className="send-pill">
            <Icon name="msg" size={14} />
            your question
          </span>
        )}
        {questionOnly && !withQuestion && (
          <span className="send-pill">
            <Icon name="check" size={14} />
            Your question only
          </span>
        )}
        {!questionOnly &&
          items.map((i) => (
            <button
              key={i.key}
              type="button"
              className="send-pill"
              aria-pressed={i.key === "rows" ? undefined : i.on}
              aria-disabled={i.locked || i.key === "rows" ? true : undefined}
              title={i.key === "rows" ? ROWS_LATER : (i.locked ?? undefined)}
              onClick={() => {
                if (!i.locked && i.key !== "rows") onToggle(i.key);
              }}
            >
              {i.locked ? (
                <Icon name="lock" size={14} />
              ) : (
                <Icon name={ICON[i.key]} size={14} />
              )}
              {labelOf ? labelOf(i) : i.label}
              {!i.on && !i.locked ? " · off" : ""}
            </button>
          ))}
        {cut && <span className="send-pill">Cut at 200 KB</span>}
        <button
          type="button"
          className="link-button"
          aria-expanded={shown}
          aria-controls={id}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? "Hide" : "Show exactly"}
        </button>
      </div>
      {shown && (
        <pre className="payload" id={id}>
          {`${header}\n\n${text}`}
        </pre>
      )}
    </div>
  );
}
