// The follow-up card: the assistant asked one question about a vague request. It shows the
// question as text, a reply box (blank: the assistant chooses), Cancel and Continue (Ctrl+Enter in the box). The pattern is
// ChatGPT's and Claude's clarifying question: it sits in the chat under the question, and typing in the composer waits.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import Kbd from "../../components/Kbd";

/** The reply's length, as the Core takes it. */
export const REPLY_MAX = 2000;

interface Props {
  /** The model's question. Shown as text, never as HTML or markdown. */
  question: string;
  /** A reply whose Ask got no answer: put back in the box, so what the user typed is never lost. */
  reply?: string;
  /** Continue with what is in the box (blank: left to the assistant). */
  onContinue(reply: string): void;
  onCancel(): void;
}

export default function FollowUpCard({ question, reply = "", onContinue, onCancel }: Props) {
  const [text, setText] = useState(reply);
  const box = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  // The card opens with the cursor in the reply, at the end of one given back.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onContinue(text);
    }
  }

  return (
    <div className="ccard followup" role="group" aria-labelledby={id}>
      <p id={id} className="ccard-ask followup-q">
        {question}
      </p>
      <textarea
        ref={box}
        className="followup-reply"
        aria-label="Your reply"
        placeholder="Leave it blank and I'll choose something sensible"
        maxLength={REPLY_MAX}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="efoot">
        <span className="spacer" />
        <button type="button" className="btn pbtn2" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn pbtn2 pri" onClick={() => onContinue(text)}>
          Continue
          <Kbd keys="Ctrl+Enter" />
        </button>
      </div>
    </div>
  );
}
