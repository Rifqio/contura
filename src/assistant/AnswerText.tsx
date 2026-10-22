import { useMemo } from "react";
import type { AnswerActionKind, DialectKind, SqlBlock } from "../api/types";
import Icon from "../components/Icon";
import AnswerSql from "./AnswerSql";
import { type Inline, looksLikeSql, parseAnswer } from "./answerMarkdown";
import type { InsertTarget } from "./InsertDiff";

interface Props {
  text: string;
  /** The Core's checked SQL blocks; absent while streaming and for answers saved before checks. */
  blocks?: SqlBlock[] | null;
  /** Notes shown above the answer, such as the injection note (R5.4). */
  notes?: string[];
  streaming?: boolean;
  dialect: DialectKind;
  target?: InsertTarget | null;
  onOpenInNewTab?(sql: string): void;
  onCopy(sql: string): void;
  /** What the user did with a block's SQL, for the answer's record. */
  onAction?(kind: AnswerActionKind): void;
}

function Inlines({ inlines }: { inlines: Inline[] }) {
  return (
    <>
      {inlines.map((x, i) =>
        x.kind === "bold" ? <strong key={i}>{x.text}</strong> : x.kind === "code" ? <code key={i}>{x.text}</code> : x.text,
      )}
    </>
  );
}

/** An answer in the strict subset (R5.1): text is only ever text, never HTML or links; SQL blocks get their label and actions. */
export default function AnswerText({ text, blocks, notes = [], streaming = false, dialect, target, onOpenInNewTab, onCopy, onAction }: Props) {
  const parsed = useMemo(() => parseAnswer(text), [text]);
  const known = streaming ? null : (blocks ?? null);
  return (
    <>
      {notes.map((n) => (
        <p key={n} className="answer-note" role="note">
          <Icon name="warning" size={14} />
          <span>{n}</span>
        </p>
      ))}
      {parsed.map((b, i) => {
        switch (b.kind) {
          case "para":
            return (
              <p key={i} className="answer-p">
                <Inlines inlines={b.inlines} />
              </p>
            );
          case "list": {
            const items = b.items.map((it, j) => (
              <li key={j}>
                <Inlines inlines={it} />
              </li>
            ));
            return b.ordered ? (
              <ol key={i} className="answer-list">
                {items}
              </ol>
            ) : (
              <ul key={i} className="answer-list">
                {items}
              </ul>
            );
          }
          case "code": {
            const check = known?.find((c) => c.fence === b.fence) ?? null;
            const sql = known ? check !== null : looksLikeSql(b);
            if (sql && b.text.trim())
              return (
                <AnswerSql
                  key={i}
                  sql={b.text.trim()}
                  dialect={dialect}
                  check={check}
                  streaming={streaming}
                  unchecked={!streaming && !known}
                  closed={b.closed}
                  target={target}
                  onOpenInNewTab={onOpenInNewTab}
                  onCopy={onCopy}
                  onAction={onAction}
                />
              );
            return (
              <pre key={i} className="answer-code">
                <code>{b.text}</code>
              </pre>
            );
          }
        }
      })}
    </>
  );
}
