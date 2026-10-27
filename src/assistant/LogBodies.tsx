import type { DialectKind, SqlBlock as Checked, StatementCheck } from "../api/types";
import Icon from "../components/Icon";
import SqlBlock from "../components/SqlBlock";
import { flagSentence } from "./AnswerSql";

/**
 * The bodies an answer log line or Steps row opens to, as a Grafana Loki or Langfuse trace opens a line: the answer,
 * the thinking and each checked statement. Read from what the log already holds; nothing new is stored.
 */

/** The whole answer as the model returned it, in a scrolling mono block with Copy. */
export function AnswerBody({ text, onCopy, hoverText = true }: { text: string; onCopy?(text: string): void; hoverText?: boolean }) {
  return (
    <section className="lbody" aria-label="The answer, as returned">
      <div className="lbody-head">
        <span className="t">Answer</span>
        <span className="spacer" />
        {onCopy && (
          <button type="button" className="icon-button" aria-label="Copy the answer" title={hoverText ? "Copy the answer" : undefined} onClick={() => onCopy(text)}>
            <Icon name="copy" size={14} />
          </button>
        )}
      </div>
      <pre className="lbody-text">{text}</pre>
    </section>
  );
}

/** The model's reasoning as the provider returned it. */
export function ThinkingBody({ text }: { text: string }) {
  return (
    <section className="lbody" aria-label="The thinking, as returned">
      <pre className="lbody-text">{text}</pre>
    </section>
  );
}

/** What the Core classed a statement as: Read or Write; a flag and its reasons follow (flagSentence, as the chat's cards word them). */
function verdict(s: StatementCheck): string {
  return s.class === "write" ? "Write" : "Read";
}

/** Each statement the Core checked, highlighted, with its verdict. */
export function ChecksBody({ blocks, dialect }: { blocks: Checked[]; dialect: DialectKind }) {
  const statements = blocks.flatMap((b) => b.statements);
  if (statements.length === 0) return <p className="lbody-note">No SQL in this answer.</p>;
  return (
    <ul className="lchecks" aria-label="Checked statements">
      {statements.map((s, i) => {
        const v = verdict(s);
        return (
          <li key={i} className="lcheck">
            <SqlBlock sql={s.text} dialect={dialect} lineNumbers={false} />
            <p className="lcheck-line">
              <span className={`lcheck-verdict ${v.toLowerCase()}`}>{v}</span>
              {s.flags.length > 0 && <span className="lcheck-verdict flag">Flag</span>}
              {s.flags.map((f, j) => (
                <span key={j} className="lcheck-reason">
                  {flagSentence(f)}
                </span>
              ))}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
