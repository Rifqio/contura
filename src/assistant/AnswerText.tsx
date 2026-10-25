import { Fragment, memo, useMemo, useRef } from "react";
import type { AnswerActionKind, DialectKind, SqlBlock } from "../api/types";
import Icon from "../components/Icon";
import AnswerSql from "./AnswerSql";
import { sha256Hex } from "./sha256";
import { type AnswerParser, type Block, createAnswerParser, type Inline, looksLikeSql, parseAnswer } from "./answerMarkdown";
import type { InsertTarget } from "./insertPlan";

interface Props {
  text: string;
  /** The Core's checked SQL blocks; absent while streaming and for answers saved before checks. */
  blocks?: SqlBlock[] | null;
  /** Notes shown above the answer, such as the injection note (R5.4). */
  notes?: string[];
  streaming?: boolean;
  dialect: DialectKind;
  target?: InsertTarget | null;
  /** The tab has no editor: SQL blocks offer Open in new query tab, never Insert (spec 8). */
  noEditor?: boolean;
  onOpenInNewTab?(sql: string): void;
  onCopy(sql: string): void;
  /** What the user did with a block's SQL, for the answer's record. */
  onAction?(kind: AnswerActionKind): void;
  /** False shows every code block as plain code, never as SQL with its actions (a diagram answer). */
  sqlBlocks?: boolean;
  /** The fence the inline box shows in the editor itself: that block shows no actions of its own. */
  bareFence?: number | null;
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
  noEditor: boolean;
  onOpenInNewTab?(sql: string): void;
  onCopy(sql: string): void;
  onAction?(kind: AnswerActionKind): void;
  sqlBlocks: boolean;
  bare: boolean;
}

/** One block; a finished block of a streaming answer keeps its object, so a new delta does not draw it again. */
const AnswerBlock = memo(function AnswerBlock({ block: b, known, streaming, dialect, target, noEditor, onOpenInNewTab, onCopy, onAction, sqlBlocks, bare }: BlockProps) {
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
      // The Core's check of this fence number, used only when it was made on this very text: a check made on another
      // block (the two parsers numbering apart) or saved without its hash leaves the block unchecked, so it goes in
      // or opens only commented out.
      const numbered = known?.find((c) => c.fence === b.fence) ?? null;
      const check = numbered && numbered.bodySha256 === sha256Hex(b.text) ? numbered : null;
      const sql = sqlBlocks && (known ? numbered !== null : looksLikeSql(b));
      if (sql && b.text.trim())
        return (
          <AnswerSql
            sql={b.text.trim()}
            dialect={dialect}
            check={check}
            streaming={streaming}
            unchecked={!streaming && check === null}
            closed={b.closed}
            target={target}
            noEditor={noEditor}
            onOpenInNewTab={onOpenInNewTab}
            onCopy={onCopy}
            onAction={onAction}
            bare={bare}
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

/** The first SQL block of a finished answer as its block would show it, with the Core's check when it fits. */
export interface FirstSql {
  fence: number;
  sql: string;
  check: SqlBlock | null;
  /** Without its check, or holding a CR: it goes in only commented out. */
  unchecked: boolean;
}

/** The answer's first closed SQL block, read as `AnswerBlock` reads it; null when it has none. */
export function firstSql(text: string, blocks: SqlBlock[] | null | undefined): FirstSql | null {
  const known = blocks ?? null;
  for (const b of parseAnswer(text)) {
    if (b.kind !== "code" || !b.closed || !b.text.trim()) continue;
    const numbered = known?.find((c) => c.fence === b.fence) ?? null;
    if (!(known ? numbered !== null : looksLikeSql(b))) continue;
    const check = numbered && numbered.bodySha256 === sha256Hex(b.text) ? numbered : null;
    const sql = b.text.trim();
    return { fence: b.fence, sql, check, unchecked: check === null || /\r/.test(sql) };
  }
  return null;
}

/** An answer in the strict subset (R5.1): text is only ever text, never HTML or links; SQL blocks get their label and actions. */
export default function AnswerText({
  text,
  blocks,
  notes = [],
  streaming = false,
  dialect,
  target,
  noEditor = false,
  onOpenInNewTab,
  onCopy,
  onAction,
  sqlBlocks = true,
  bareFence = null,
}: Props) {
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
          noEditor={noEditor}
          onOpenInNewTab={onOpenInNewTab}
          onCopy={onCopy}
          onAction={onAction}
          sqlBlocks={sqlBlocks}
          bare={b.kind === "code" && b.fence === bareFence}
        />
      ))}
    </>
  );
}
