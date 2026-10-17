import { useMemo } from "react";
import type { DialectKind } from "../api/types";
import { highlightSql } from "../lang/sql/highlightStatic";

export interface SqlMark {
  firstLine: number;
  lastLine: number;
  tag?: "writes" | "reads";
  band?: "prod" | "readOnly";
}

interface Props {
  sql: string;
  dialect: DialectKind;
  lineNumbers?: boolean;
  startLine?: number;
  marks?: SqlMark[];
  className?: string;
  ariaLabel?: string;
}

/** A read-only block of SQL in the editor's syntax colours, with optional statement tags and bands. */
export default function SqlBlock({
  sql,
  dialect,
  lineNumbers = true,
  startLine = 1,
  marks = [],
  className,
  ariaLabel,
}: Props) {
  const lines = useMemo(() => highlightSql(sql, dialect), [sql, dialect]);
  return (
    <div
      className={["sql-block", className].filter(Boolean).join(" ")}
      role="group"
      aria-label={ariaLabel}
    >
      {lines.map((spans, i) => {
        const n = startLine + i;
        const band = marks.find(
          (m) => m.band && n >= m.firstLine && n <= m.lastLine,
        )?.band;
        const tag = marks.find((m) => m.tag && m.firstLine === n)?.tag;
        return (
          <div
            key={i}
            className={
              band ? `sql-block-line sql-block-line-${band}` : "sql-block-line"
            }
          >
            {lineNumbers && (
              <span className="sql-block-gutter" aria-hidden="true">
                {n}
              </span>
            )}
            <code className="sql-block-text">
              {spans.map((s, j) =>
                s.cls ? (
                  <span key={j} className={s.cls}>
                    {s.text}
                  </span>
                ) : (
                  s.text
                ),
              )}
            </code>
            {tag && (
              <span className={`sql-block-tag sql-block-tag-${tag}`}>
                {tag}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
