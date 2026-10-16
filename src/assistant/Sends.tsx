import { useId, useState } from "react";
import Icon from "../components/Icon";
import { payloadIsCut, payloadText, type SendItem } from "./payload";

interface Props {
  /** The items to show; an empty list means only the question is sent. */
  items: SendItem[];
  /** "To <host> (<model>)", or the line saying nothing is sent yet. */
  header: string;
  onToggle(key: SendItem["key"]): void;
}

/** What one question would send, as pills, with the exact text behind "Show exactly". */
export default function Sends({ items, header, onToggle }: Props) {
  const [shown, setShown] = useState(false);
  const id = useId();
  const text = payloadText(items);
  const cut = payloadIsCut(text);
  const questionOnly = items.length === 0;

  return (
    <div className="sends">
      <div className="sends-row">
        <span className="sends-label">Sends</span>
        {questionOnly ? (
          <span className="send-pill">
            <Icon name="check" />
            Your question only
          </span>
        ) : (
          items.map((i) => (
            <button
              key={i.key}
              type="button"
              className="send-pill"
              aria-pressed={i.on}
              aria-disabled={i.locked ? true : undefined}
              title={i.locked ?? undefined}
              onClick={() => {
                if (!i.locked) onToggle(i.key);
              }}
            >
              {i.locked ? <Icon name="lock" /> : i.on ? <Icon name="check" /> : null}
              {i.label}
              {!i.on && !i.locked ? " · off" : ""}
            </button>
          ))
        )}
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
