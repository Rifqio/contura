import { Fragment, memo, useMemo, useRef } from "react";
import type { AnswerActionKind, DialectKind, SqlBlock } from "../api/types";
import Icon from "../components/Icon";
import AnswerSql from "./AnswerSql";
import { type AnswerParser, type Block, createAnswerParser, type Inline, looksLikeSql, parseAnswer } from "./answerMarkdown";
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
  /** False shows every code block as plain code, never as SQL with its actions (a diagram answer). */
  sqlBlocks?: boolean;
}

/** The longest text node a paragraph gets, so a long answer is laid out and updated in bounded pieces. */
export const TEXT_NODE_MAX = 2048;

/**
 * `text` in pieces of at most `TEXT_NODE_MAX`, cut after a space where there is one. A piece depends only on the text
 * from its start, so as an answer grows only its last piece changes.
 */
export function textPieces(text: string): string[] {
  if (text.length <= TEXT_NODE_MAX) return [text];
  const out: string[] = [];
  let at = 0;
  while (text.length - at > TEXT_NODE_MAX) {
    const window = text.slice(at, at + TEXT_NODE_MAX);
    const space = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
    const end = space > 0 ? at + space + 1 : at + TEXT_NODE_MAX;
    out.push(text.slice(at, end));
    at = end;
  }
  out.push(text.slice(at));
  return out;
}

function Inlines({ inlines }: { inlines: Inline[] }) {
  return (
    <>
      {inlines.map((x, i) =>
        x.kind === "bold" ? (
          <strong key={i}>{x.text}</strong>
        ) : x.kind === "code" ? (
          <code key={i}>{x.text}</code>
        ) : x.text.length > TEXT_NODE_MAX ? (
          <Fragment key={i}>{textPieces(x.text)}</Fragment>
        ) : (
          x.text
        ),
      )}
    </>
  );
}

interface BlockProps {
  block: Block;
  known: SqlBlock[] | null;
  streaming: boolean;
  dialect: DialectKind;
  target?: InsertTarget | null;
  onOpenInNewTab?(sql: string): void;
  onCopy(sql: string): void;
  onAction?(kind: AnswerActionKind): void;
  sqlBlocks: boolean;
}

/** One block; a finished block of a streaming answer keeps its object, so a new delta does not draw it again. */
const AnswerBlock = memo(function AnswerBlock({ block: b, known, streaming, dialect, target, onOpenInNewTab, onCopy, onAction, sqlBlocks }: BlockProps) {
  switch (b.kind) {
    case "para":
      return (
        <p className="answer-p">
          <Inlines inlines={b.inlines} />
        </p>
      );
    case "heading":
      // A bold line, not large type; levels 4 to 6 keep it under the panel's own headings.
      return (
        <p className={`answer-h answer-h${b.level}`} role="heading" aria-level={b.level + 3}>
          <Inlines inlines={b.inlines} />
        </p>
      );
    case "list": {
      const items = b.items.map((it, j) => (
        <li key={j}>
          <Inlines inlines={it} />
        </li>
      ));
      return b.ordered ? <ol className="answer-list">{items}</ol> : <ul className="answer-list">{items}</ul>;
    }
    case "code": {
      const check = known?.find((c) => c.fence === b.fence) ?? null;
      const sql = sqlBlocks && (known ? check !== null : looksLikeSql(b));
      if (sql && b.text.trim())
        return (
          <AnswerSql
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
        <pre className="answer-code">
          <code>{b.text}</code>
        </pre>
      );
    }
  }
});

/** An answer in the strict subset (R5.1): text is only ever text, never HTML or links; SQL blocks get their label and actions. */
export default function AnswerText({ text, blocks, notes = [], streaming = false, dialect, target, onOpenInNewTab, onCopy, onAction, sqlBlocks = true }: Props) {
  // A streaming answer is read as it grows: finished blocks are parsed once and kept (see `createAnswerParser`).
  const parser = useRef<AnswerParser | null>(null);
  const parsed = useMemo(() => {
    if (!streaming) return parseAnswer(text);
    parser.current ??= createAnswerParser();
    return parser.current.parse(text);
  }, [text, streaming]);
  const known = streaming ? null : (blocks ?? null);
  return (
    <>
      {notes.map((n) => (
        <p key={n} className="answer-note" role="note">
          <Icon name="warning" size={14} />
          <span>{n}</span>
        </p>
      ))}
      {parsed.map((b, i) => (
        <AnswerBlock
          key={i}
          block={b}
          known={known}
          streaming={streaming}
          dialect={dialect}
          target={target}
          onOpenInNewTab={onOpenInNewTab}
          onCopy={onCopy}
          onAction={onAction}
          sqlBlocks={sqlBlocks}
        />
      ))}
    </>
  );
}
