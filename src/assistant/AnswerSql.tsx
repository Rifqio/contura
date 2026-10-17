import type { DialectKind } from "../api/types";
import Icon from "../components/Icon";
import SqlBlock from "../components/SqlBlock";

interface Props {
  sql: string;
  dialect: DialectKind;
  onInsert?(sql: string): void;
  onRun?(sql: string): void;
  onCopy(sql: string): void;
  /** How the last Run ended; the line under the block says so. */
  ran?: { ran: boolean; rows?: number; more?: boolean } | null;
}

/** A fenced SQL block of an answer: the editor's colours, no line numbers, and the way into the editor. */
export default function AnswerSql({ sql, dialect, onInsert, onRun, onCopy, ran = null }: Props) {
  return (
    <>
      <div className="answer-sql" role="group" aria-label="SQL answer">
        <SqlBlock sql={sql} dialect={dialect} lineNumbers={false} />
        <div className="answer-sql-actions">
          <button
            type="button"
            className="button button-small button-ghost"
            disabled={!onInsert}
            onClick={() => onInsert?.(sql)}
          >
            <Icon name="format" size={14} />
            Insert into the editor
          </button>
          <button type="button" className="button button-small button-ghost" disabled={!onRun} onClick={() => onRun?.(sql)}>
            <Icon name="play" size={14} />
            Run
          </button>
          <span className="spacer" />
          <button type="button" className="icon-button" aria-label="Copy" title="Copy" onClick={() => onCopy(sql)}>
            <Icon name="copy" size={14} />
          </button>
        </div>
      </div>
      {ran && (
        <p className="answer-sql-done">
          <Icon name="check" size={14} />
          {ran.ran
            ? `Inserted into the editor and run${ran.rows === undefined ? "" : `, ${rowCount(ran.rows, !!ran.more)}`}`
            : "Inserted into the editor"}
        </p>
      )}
    </>
  );
}

/** "8 rows", "1 row", or "200+ rows" when only the first page loaded (R26). */
function rowCount(rows: number, more: boolean): string {
  if (more) return `${rows.toLocaleString("en-US")}+ rows`;
  return `${rows.toLocaleString("en-US")} row${rows === 1 ? "" : "s"}`;
}
